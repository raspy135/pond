// Cron & interval job scheduler + autonomous background task runner.
import { CONFIG, isKeyConfigured } from './config.js';
import { readJson, updateJson, appendToActiveSession, logActivity } from './storage.js';
import { runAgentTurn, buildSystemPrompt, buildLiveContext } from './llm.js';
import { broadcast, pushNotification } from './notifications.js';

// ---------- Pure-JS 5-field Cron Matcher ----------
const CRON_ALIASES = {
  '@hourly': '0 * * * *',
  '@daily': '0 9 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 9 * * 1',
  '@monthly': '0 9 1 * *',
};

function matchCronField(field, value, min, max) {
  const f = String(field).trim();
  if (f === '*') return true;
  for (const part of f.split(',')) {
    const [rangeStr, stepStr] = part.trim().split('/');
    const step = stepStr ? Math.max(1, Number(stepStr)) : 1;
    if (rangeStr === '*') {
      if ((value - min) % step === 0) return true;
      continue;
    }
    if (rangeStr.includes('-')) {
      const [aStr, bStr] = rangeStr.split('-');
      const a = Number(aStr);
      const b = Number(bStr);
      if (Number.isFinite(a) && Number.isFinite(b) && value >= a && value <= b && (value - a) % step === 0) {
        return true;
      }
      continue;
    }
    const exact = Number(rangeStr);
    if (Number.isFinite(exact) && value === exact) return true;
  }
  return false;
}

export function matchesCron(expr, date = new Date()) {
  if (!expr) return false;
  const normalized = CRON_ALIASES[String(expr).trim().toLowerCase()] || String(expr).trim();
  const fields = normalized.split(/\s+/);
  if (fields.length !== 5) return false;
  const [minF, hourF, domF, monF, dowF] = fields;
  return (
    matchCronField(minF, date.getMinutes(), 0, 59) &&
    matchCronField(hourF, date.getHours(), 0, 23) &&
    matchCronField(domF, date.getDate(), 1, 31) &&
    matchCronField(monF, date.getMonth() + 1, 1, 12) &&
    (matchCronField(dowF, date.getDay(), 0, 6) || (date.getDay() === 0 && matchCronField(dowF, 7, 0, 7)))
  );
}

const runningJobs = new Set();

export async function executeJob(job, { manual = false } = {}) {
  if (!isKeyConfigured()) return { ok: false, error: 'API key not configured' };
  if (runningJobs.has(job.id)) return { ok: false, error: 'Job already running' };
  runningJobs.add(job.id);
  const startedAt = new Date().toISOString();
  const minuteKey = startedAt.slice(0, 16);

  try {
    await logActivity({ kind: 'job', title: `Running job: ${job.name}`, detail: manual ? 'Manual trigger' : (job.cron || `every ${job.intervalMin}m`) });
    broadcast({ type: 'proactive_status', running: true, phase: `Running job: ${job.name}` });

    const [sys, liveCtx] = await Promise.all([buildSystemPrompt(), buildLiveContext()]);
    const res = await runAgentTurn({
      systemPrompt: sys,
      userPrompt: `${liveCtx}\n\n[Scheduled Recurring Routine: "${job.name}"]\nUse your tools freely to gather fresh data and complete the instruction below thoroughly. Produce a crisp, high-signal result for the user:\n\n${job.prompt}`,
      maxRounds: 80,
      source: 'job',
    });

    const output = res.content || '(Job completed with no text output.)';

    await updateJson('jobs.json', [], (jobs) =>
      (Array.isArray(jobs) ? jobs : []).map((j) =>
        j.id === job.id
          ? { ...j, lastRunAt: startedAt, lastRunMinuteKey: minuteKey, lastStatus: 'ok', lastOutput: output.slice(0, 1500) }
          : j
      )
    );

    const chatText = `**⚡ Scheduled Job — ${job.name}**\n\n${output}`;
    const session = await appendToActiveSession({ role: 'assistant', content: chatText, proactive: true, tag: 'Scheduled job' });
    broadcast({ type: 'proactive', text: chatText, tag: `Job · ${job.name}`, sessionId: session?.id });

    if (job.notify !== false) {
      await pushNotification({
        title: `⚡ ${job.name}`,
        body: output.replace(/[#*_`]/g, '').slice(0, 240),
        urgency: 'high',
        category: 'job',
        sessionId: session?.id,
        tag: `job-${job.id}`,
      });
    }

    await logActivity({ kind: 'job', title: `Completed job: ${job.name}`, detail: output.slice(0, 300) });
    return { ok: true, output, toolsUsed: res.toolTrace.map((t) => t.name) };
  } catch (err) {
    const msg = String(err?.message || err);
    await updateJson('jobs.json', [], (jobs) =>
      (Array.isArray(jobs) ? jobs : []).map((j) =>
        j.id === job.id
          ? { ...j, lastRunAt: startedAt, lastRunMinuteKey: minuteKey, lastStatus: 'error', lastOutput: msg }
          : j
      )
    );
    await logActivity({ kind: 'job', level: 'error', title: `Job failed: ${job.name}`, detail: msg });
    return { ok: false, error: msg };
  } finally {
    runningJobs.delete(job.id);
    broadcast({ type: 'proactive_status', running: false, phase: 'idle' });
  }
}

export async function runDueJobs() {
  if (!isKeyConfigured()) return;
  const jobs = await readJson('jobs.json', []);
  const now = new Date();
  const minuteKey = now.toISOString().slice(0, 16);

  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job.enabled || runningJobs.has(job.id)) continue;
    let due = false;
    if (job.cron) {
      if (job.lastRunMinuteKey !== minuteKey && matchesCron(job.cron, now)) due = true;
    } else if (job.intervalMin) {
      const last = job.lastRunAt ? new Date(job.lastRunAt).getTime() : 0;
      if (Date.now() - last >= Math.max(1, job.intervalMin) * 60_000) due = true;
    }
    if (due) {
      await executeJob(job, { manual: false });
    }
  }
}

// ---------- Autonomous Background Task Runner ----------
// Picks up open tasks with autoExecute !== false and actively advances them using tools!
let taskWorkerBusy = false;

export async function advanceBackgroundTasks({ force = false } = {}) {
  if (taskWorkerBusy || !isKeyConfigured() || !CONFIG.proactive.autoExecuteTasks) return null;
  taskWorkerBusy = true;
  try {
    const tasks = await readJson('tasks.json', []);
    const now = Date.now();
    const minCooldownMs = force ? 0 : (CONFIG.proactive.aggressiveness === 'aggressive' ? 4 : 10) * 60_000;
    const candidate = (Array.isArray(tasks) ? tasks : []).find((t) => {
      if (t.status === 'done' || t.autoExecute === false) return false;
      const lastWork = t.lastAutoWorkedAt ? new Date(t.lastAutoWorkedAt).getTime() : 0;
      return now - lastWork >= minCooldownMs;
    });
    if (!candidate) return null;

    broadcast({ type: 'proactive_status', running: true, phase: `Working on task: ${candidate.title}` });
    await logActivity({ kind: 'task', title: `Autonomously advancing: ${candidate.title}`, detail: 'Background worker executing next step' });

    await updateJson('tasks.json', [], (list) =>
      (Array.isArray(list) ? list : []).map((t) =>
        t.id === candidate.id ? { ...t, lastAutoWorkedAt: new Date().toISOString() } : t
      )
    );

    const [sys, liveCtx] = await Promise.all([buildSystemPrompt(), buildLiveContext()]);
    const prevProgress = (candidate.progress || []).map((p) => `- ${p.ts}: ${p.note}`).join('\n') || '(none yet)';
    const res = await runAgentTurn({
      systemPrompt: sys,
      userPrompt: `${liveCtx}\n\n[Autonomous Background Task Worker]\nAdvance this open task while the user is away. Use tools to make real concrete progress, call update_task() or complete_task(), then write a short status update (under 90 words).\n\nTask: ${candidate.title}\nPlan:\n${candidate.plan || '(create a concrete step and execute it)'}\nPrevious progress:\n${prevProgress}`,
      maxRounds: 60,
      source: 'task',
    });

    if (res.content) {
      const msg = `**🛠️ Task Update — ${candidate.title}**\n\n${res.content}`;
      const session = await appendToActiveSession({ role: 'assistant', content: msg, proactive: true, tag: 'Task milestone' });
      broadcast({ type: 'proactive', text: msg, tag: `Task · ${candidate.title}`, sessionId: session?.id });
      await pushNotification({
        title: `🛠️ ${candidate.title}`,
        body: res.content.replace(/[#*_`]/g, '').slice(0, 220),
        urgency: 'normal',
        category: 'task',
        sessionId: session?.id,
        tag: `task-${candidate.id}`,
      });
    }
    return { taskId: candidate.id, output: res.content };
  } catch (err) {
    await logActivity({ kind: 'task', level: 'error', title: 'Background task worker error', detail: String(err?.message || err) });
    return null;
  } finally {
    taskWorkerBusy = false;
    broadcast({ type: 'proactive_status', running: false, phase: 'idle' });
  }
}

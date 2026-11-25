// Sub-agents: each runs in its own chat (sessions list, nested under the chat that started it) so you can watch it
// work. In a chat they run in the background — the main reply keeps going — and their reports are posted back to
// that chat as they come in (ones that finish close together arrive as one message, and a report waits while the
// chat is replying), so one slow or stuck sub-agent never holds up the others. Pond picks the task up from there.
// Routines and other background runs (no chat) still wait for their sub-agents and get the report as the result.
import { createSession, updateSessionInfo, uid, logActivity } from './storage.js';
import { startTurn, pushTurnEvent, endTurn, registerTurnAbort, getRunningTurn } from './turns.js';
import { broadcast } from './notifications.js';

let runner = null;           // runAgentTurn (llm.js)
let systemPrompt = async () => '';
let deliver = null;          // posts finished reports into the parent chat (server.js)
export function registerSubagentRunner(fn, systemPromptFn = null) { runner = fn; if (systemPromptFn) systemPrompt = systemPromptFn; }
export function onSubagentReports(fn) { deliver = fn; }

const groups = new Map(); // parent key -> { limit, active, queue: [fn], children: Map<sessionId, role>, reports: [] }
const live = new Map();   // child sessionId -> { ctrl, cancelled } (Stop / chat deleted)
const group = (key, limit) => {
  let g = groups.get(key);
  if (!g) { g = { limit, active: 0, queue: [], children: new Map(), reports: [], timer: null }; groups.set(key, g); }
  g.limit = Math.max(1, limit || g.limit || 1);
  return g;
};
const pump = (g) => { while (g.active < g.limit && g.queue.length) { g.active++; g.queue.shift()(); } };

// Start a sub-agent. Returns { sessionId, done } where done resolves to { status, report, toolsUsed }.
export async function startSubagent({ role, task, parentSessionId = null, parentTitle = '', profileKey = null, effort, limit = 1 }) {
  if (!runner) throw new Error('Sub-agent runner not initialized');
  const key = parentSessionId || `bg-${uid()}`;
  const g = group(key, limit);
  const child = await createSession(`↳ ${role}`.slice(0, 80), { activate: false });
  const info = (status, extra = {}) => ({ subagent: { parentId: parentSessionId, parentTitle: String(parentTitle || '').slice(0, 80), role, status, ...extra } });
  await updateSessionInfo(child.id, { patch: info('queued'), append: [{ role: 'user', content: task, fromAgent: 'task' }] });
  g.children.set(child.id, role);
  const handle = { ctrl: new AbortController(), cancelled: false };
  live.set(child.id, handle);
  broadcast({ type: 'sessions' });
  await logActivity({ kind: 'subagent', title: `Sub-agent started: ${role}`, detail: task.slice(0, 300) });

  const done = new Promise((resolve) => {
    g.queue.push(async () => {
      const requestId = `sub-${uid()}`;
      const ctrl = handle.ctrl;
      if (handle.cancelled) { // stopped (or its chat deleted) while waiting for a slot
        g.active--; g.children.delete(child.id); live.delete(child.id); pump(g);
        g.reports.push({ role, sessionId: child.id, status: 'stopped', report: 'Stopped before it started.', toolsUsed: [] });
        if (parentSessionId) scheduleDelivery(key);
        resolve({ status: 'stopped', report: 'Stopped before it started.', toolsUsed: [] });
        return;
      }
      await updateSessionInfo(child.id, { patch: info('running', { startedAt: new Date().toISOString() }) });
      const turn = startTurn({ sessionId: child.id, requestId });
      registerTurnAbort(requestId, ctrl);
      let out;
      try {
        const res = await runner({
          systemPrompt: `${await systemPrompt()}\n\nYou are a sub-agent started by the main assistant, acting as: ${role}. You are not talking to the user: do the delegated task thoroughly with your tools, then reply with a crisp, high-signal report for the main assistant (findings, links/sources, files or pages you made with their links, anything left undone).`,
          userPrompt: task,
          maxRounds: 60,
          source: 'subagent',
          isSubagent: true,
          excludeTools: ['spawn_subagent'],
          profileKey,
          effort,
          signal: ctrl.signal,
          onEvent: (ev) => pushTurnEvent(turn, ev),
        });
        await updateSessionInfo(child.id, { patch: info('done', { finishedAt: new Date().toISOString() }), append: res.entries || [] });
        out = { status: 'done', report: res.content, toolsUsed: res.toolTrace.map((t) => t.name) };
      } catch (err) {
        const stopped = ctrl.signal.aborted;
        const msg = stopped ? 'Stopped.' : `Failed: ${String(err?.message || err)}`;
        pushTurnEvent(turn, { type: 'error', message: msg });
        await updateSessionInfo(child.id, { patch: info(stopped ? 'stopped' : 'failed', { finishedAt: new Date().toISOString() }), append: [{ role: 'assistant', content: `_${msg}_` }] });
        out = { status: stopped ? 'stopped' : 'failed', report: msg, toolsUsed: [] };
      } finally {
        endTurn(turn, ctrl.signal.aborted ? 'stopped' : 'done');
        g.active--;
        g.children.delete(child.id);
        live.delete(child.id);
        broadcast({ type: 'sessions' });
        pump(g);
      }
      await logActivity({ kind: 'subagent', title: `Sub-agent ${out.status}: ${role}`, detail: String(out.report || '').slice(0, 300) });
      g.reports.push({ role, sessionId: child.id, ...out });
      if (parentSessionId) scheduleDelivery(key);
      resolve(out);
    });
    pump(g);
  });
  return { sessionId: child.id, done };
}

// Stop a sub-agent (its Stop button, or its chat was deleted). Returns true if it was running or waiting.
export function stopSubagent(sessionId) {
  const h = live.get(sessionId);
  if (!h) return false;
  h.cancelled = true;
  h.ctrl.abort();
  return true;
}

// Hand a chat the reports that are in, once it isn't replying. Reports that land within a few seconds of each
// other go together; sub-agents still working are named so Pond knows more is coming.
function scheduleDelivery(key, delay = 3000) {
  const g = groups.get(key);
  if (!g || g.timer) return;
  g.timer = setTimeout(() => { g.timer = null; deliverNow(key); }, delay);
  g.timer.unref?.();
}
function deliverNow(key) {
  const g = groups.get(key);
  if (!g || !g.reports.length) return;
  if (getRunningTurn(key)) { scheduleDelivery(key, 2000); return; }
  const reports = g.reports.splice(0);
  const pending = [...g.children.values()];
  if (!g.children.size && !g.queue.length) groups.delete(key);
  if (deliver) deliver(key, reports, pending).catch((err) => logActivity({ kind: 'subagent', title: 'Could not post sub-agent reports', detail: String(err?.message || err), level: 'error' }).catch(() => {}));
}

export function formatReports(reports, pending = []) {
  const esc = (s) => String(s).replace(/"/g, "'");
  const body = reports.map((r) => `<report role="${esc(r.role)}" status="${r.status}" chat="${r.sessionId}">\n${String(r.report || '').trim() || '(no report)'}\n</report>`).join('\n');
  const n = reports.length;
  const tail = pending.length
    ? `${n > 1 ? 'These sub-agents' : 'This sub-agent'} finished; still working: ${pending.join(', ')} — ${pending.length > 1 ? 'their reports' : 'its report'} will come in another message. Use what is here: tell the user briefly, or wait for the rest if nothing useful can be said yet.`
    : `The sub-agent${n > 1 ? 's' : ''} you started finished. Continue the task with ${n > 1 ? 'these reports' : 'this report'} and give the user the result.`;
  return `<subagent_reports>\n${body}\n</subagent_reports>\n${tail}`;
}

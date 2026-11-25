// Sub-agents: each runs in its own chat (sessions list, nested under the chat that started it) so you can watch it
// work. In a chat they run in the background — the main reply keeps going — and when all of a chat's sub-agents
// are done, their reports are posted back to that chat as one message and Pond picks the task up from there.
// Routines and other background runs (no chat) still wait for their sub-agents and get the report as the result.
import { createSession, updateSessionInfo, uid, logActivity } from './storage.js';
import { startTurn, pushTurnEvent, endTurn, registerTurnAbort, getRunningTurn } from './turns.js';
import { broadcast } from './notifications.js';

let runner = null;           // runAgentTurn (llm.js)
let systemPrompt = async () => '';
let deliver = null;          // posts finished reports into the parent chat (server.js)
export function registerSubagentRunner(fn, systemPromptFn = null) { runner = fn; if (systemPromptFn) systemPrompt = systemPromptFn; }
export function onSubagentReports(fn) { deliver = fn; }

const groups = new Map(); // parent key -> { limit, active, queue: [fn], children: Set<sessionId>, reports: [] }
const group = (key, limit) => {
  let g = groups.get(key);
  if (!g) { g = { limit, active: 0, queue: [], children: new Set(), reports: [] }; groups.set(key, g); }
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
  g.children.add(child.id);
  broadcast({ type: 'sessions' });
  await logActivity({ kind: 'subagent', title: `Sub-agent started: ${role}`, detail: task.slice(0, 300) });

  const done = new Promise((resolve) => {
    g.queue.push(async () => {
      const requestId = `sub-${uid()}`;
      const ctrl = new AbortController();
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
        broadcast({ type: 'sessions' });
        pump(g);
      }
      await logActivity({ kind: 'subagent', title: `Sub-agent ${out.status}: ${role}`, detail: String(out.report || '').slice(0, 300) });
      g.reports.push({ role, sessionId: child.id, ...out });
      if (parentSessionId) maybeDeliver(key);
      resolve(out);
    });
    pump(g);
  });
  return { sessionId: child.id, done };
}

// When none of a chat's sub-agents is left running and that chat isn't replying, hand it their reports.
function maybeDeliver(key) {
  const g = groups.get(key);
  if (!g || g.children.size || g.queue.length || !g.reports.length) return;
  if (getRunningTurn(key)) { setTimeout(() => maybeDeliver(key), 2000).unref?.(); return; }
  const reports = g.reports.splice(0);
  groups.delete(key);
  if (deliver) deliver(key, reports).catch((err) => logActivity({ kind: 'subagent', title: 'Could not post sub-agent reports', detail: String(err?.message || err), level: 'error' }).catch(() => {}));
}

export function formatReports(reports) {
  const esc = (s) => String(s).replace(/"/g, "'");
  const body = reports.map((r) => `<report role="${esc(r.role)}" status="${r.status}" chat="${r.sessionId}">\n${String(r.report || '').trim() || '(no report)'}\n</report>`).join('\n');
  return `<subagent_reports>\n${body}\n</subagent_reports>\nThe sub-agent${reports.length > 1 ? 's' : ''} you started finished. Continue the task with ${reports.length > 1 ? 'these reports' : 'this report'} and give the user the result.`;
}

// Running chat turns, owned by their *session* — not by the browser tab that started them.
// Every streamed event is buffered, so any view (after switching chats, reopening the window, or on
// another device) can attach to a running turn, replay its progress so far, and follow it live.
import { broadcast } from './notifications.js';

const turns = new Map();     // requestId -> turn
const bySession = new Map(); // sessionId -> requestId (at most one running turn per chat)
const MAX_EVENTS = 5000;

export function getRunningTurn(sessionId) {
  const id = bySession.get(sessionId);
  const t = id && turns.get(id);
  return t && !t.done ? { requestId: t.requestId, startedAt: t.startedAt, clientId: t.clientId } : null;
}

// Chats with a reply running right now (the sidebar marks them).
export function getRunningSessionIds() {
  return [...bySession.entries()].filter(([, id]) => turns.get(id) && !turns.get(id).done).map(([sid]) => sid);
}

export function startTurn({ sessionId, requestId, clientId = null }) {
  const t = { sessionId, requestId, clientId, startedAt: Date.now(), events: [], subs: new Set(), done: false };
  turns.set(requestId, t);
  if (sessionId) bySession.set(sessionId, requestId);
  broadcast({ type: 'turn_started', sessionId, requestId, clientId });
  return t;
}

export function pushTurnEvent(t, ev) {
  if (!t || t.done || !ev || ev.type === 'record') return;
  const last = t.events[t.events.length - 1];
  // Coalesce text deltas so the replay buffer stays small (viewers rebuild from the buffer anyway).
  if (last && (ev.type === 'token' || ev.type === 'reasoning') && last.type === ev.type) last.text += ev.text;
  else if (t.events.length < MAX_EVENTS) t.events.push({ ...ev });
  for (const fn of t.subs) { try { fn(ev); } catch { /* viewer gone */ } }
}

export function endTurn(t, status = 'done') {
  if (!t || t.done) return;
  t.done = true;
  t.status = status;
  for (const fn of t.subs) { try { fn({ type: 'done', status }); } catch { /* ignore */ } }
  t.subs.clear();
  if (bySession.get(t.sessionId) === t.requestId) bySession.delete(t.sessionId);
  broadcast({ type: 'turn_finished', sessionId: t.sessionId, requestId: t.requestId, status });
  setTimeout(() => turns.delete(t.requestId), 60_000).unref?.(); // late attachers just reload the saved chat
}

// Attach a viewer: returns the buffered events so far + live updates via onEvent. null if unknown/finished.
export function attachTurn(requestId, onEvent) {
  const t = turns.get(requestId);
  if (!t) return null;
  if (t.done) return { replay: [], done: true, unsubscribe() {} };
  t.subs.add(onEvent);
  return { replay: t.events.map((e) => ({ ...e })), done: false, sessionId: t.sessionId, unsubscribe: () => t.subs.delete(onEvent) };
}

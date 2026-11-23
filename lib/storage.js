// Atomic JSON persistence with per-file write locks + session & activity storage.
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initHtmlCache, cacheHtmlFromMessage } from './htmlcache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const PUBLIC = path.join(ROOT, 'public');
export const DATA = process.env.OPEN_DOTS_DATA_DIR ? path.resolve(process.env.OPEN_DOTS_DATA_DIR) : path.join(ROOT, 'data');
initHtmlCache(DATA);

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Per-file async mutex so concurrent background loops never corrupt JSON files.
const fileLocks = new Map();
export function withFileLock(key, fn) {
  const prev = fileLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  const cleanup = next.finally(() => {
    if (fileLocks.get(key) === cleanup) fileLocks.delete(key);
  });
  fileLocks.set(key, cleanup);
  return next;
}

export async function writeFileAtomic(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  await writeFile(tmp, contents, 'utf8');
  try {
    await rename(tmp, file);
  } catch (err) {
    // Windows occasional EPERM/EBUSY on rapid rename — retry briefly
    await new Promise((r) => setTimeout(r, 40));
    try {
      await rename(tmp, file);
    } catch {
      await writeFile(file, contents, 'utf8');
      await rm(tmp, { force: true }).catch(() => {});
    }
  }
}

export async function readJsonWithRetry(file, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 40));
    }
  }
}

export async function readJson(file, fallback = []) {
  try {
    return await readJsonWithRetry(path.join(DATA, file));
  } catch {
    return structuredClone(fallback);
  }
}

export async function writeJson(file, value) {
  const full = path.join(DATA, file);
  return withFileLock(full, () => writeFileAtomic(full, JSON.stringify(value, null, 2)));
}

export async function updateJson(file, fallback, updater) {
  const full = path.join(DATA, file);
  return withFileLock(full, async () => {
    let current;
    try {
      current = await readJsonWithRetry(full);
    } catch {
      current = structuredClone(fallback);
    }
    const next = await updater(current);
    const toSave = next === undefined ? current : next;
    await writeFileAtomic(full, JSON.stringify(toSave, null, 2));
    return toSave;
  });
}

const DEFAULT_FILES = {
  'memory.json': [],
  'notes.json': [],
  'reminders.json': [],
  'events.json': [],
  'tasks.json': [],
  'conversation.json': [],
  'jobs.json': [],
  'watches.json': [],
  'emails.json': { lastUid: 0, seenIds: [], items: [] },
  'notifications.json': [],
  'approvals.json': [],
  'activity.json': [],
  'mcp.json': [],
  'settings.json': {},
  'proactive-state.json': { lastProactiveAt: 0, lastBriefingKey: '', alertedKeys: {} },
};

export async function ensureData() {
  await mkdir(DATA, { recursive: true });
  await mkdir(path.join(DATA, 'sessions'), { recursive: true });
  await mkdir(path.join(DATA, 'artifacts'), { recursive: true });
  for (const [f, initial] of Object.entries(DEFAULT_FILES)) {
    const p = path.join(DATA, f);
    if (!existsSync(p)) {
      await writeFile(p, JSON.stringify(initial, null, 2), 'utf8');
    }
  }
}

// ---------- sessions (persistent, shared across clients) ----------
const SESSIONS_INDEX = 'sessions.json';
export const sessionsDir = () => path.join(DATA, 'sessions');
export const sessionFile = (id) => path.join(sessionsDir(), `${id}.json`);

export async function loadSessionsIndex() {
  try {
    const idx = await readJsonWithRetry(path.join(DATA, SESSIONS_INDEX));
    if (idx && Array.isArray(idx.sessions)) return idx;
  } catch { /* fall through */ }
  return { activeId: null, sessions: [] };
}

export async function saveSessionsIndex(idx) {
  const full = path.join(DATA, SESSIONS_INDEX);
  return withFileLock(full, () => writeFileAtomic(full, JSON.stringify(idx, null, 2)));
}

export async function loadSession(id) {
  try { return await readJsonWithRetry(sessionFile(id)); } catch { return null; }
}

export async function saveSession(s) {
  await mkdir(sessionsDir(), { recursive: true });
  const full = sessionFile(s.id);
  return withFileLock(full, () => writeFileAtomic(full, JSON.stringify(s, null, 2)));
}

export async function createSession(title = 'New chat', { activate = true } = {}) {
  const idx = await loadSessionsIndex();
  const now = new Date().toISOString();
  const s = { id: uid(), title, createdAt: now, updatedAt: now, messages: [] };
  await saveSession(s);
  idx.sessions.unshift({ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt });
  if (activate) idx.activeId = s.id;
  await saveSessionsIndex(idx);
  return s;
}

// The chat a window shows is chosen by that window. The server only remembers the chat used last (sent to, opened
// or created) — where a new window starts and where check-ins are posted.
export async function getChatSession(id) {
  if (id && /^[A-Za-z0-9_-]+$/.test(String(id))) {
    const s = await loadSession(id);
    if (s) return s;
  }
  return null;
}

// A chat's own model choice ({ profile, effort }), under the same lock as message appends.
export async function setSessionLlm(id, llm) {
  return withFileLock('active-session-append', async () => {
    const session = await loadSession(id);
    if (!session) return null;
    session.llm = llm;
    await saveSession(session);
    return session;
  });
}

export async function markSessionUsed(id) {
  return withFileLock('active-session-append', async () => {
    const idx = await loadSessionsIndex();
    if (idx.activeId === id || !idx.sessions.some((x) => x.id === id)) return;
    idx.activeId = id;
    await saveSessionsIndex(idx);
  });
}

export async function getActiveSession() {
  const idx = await loadSessionsIndex();
  if (idx.activeId) {
    const s = await loadSession(idx.activeId);
    if (s) return { idx, session: s };
  }
  for (const meta of idx.sessions) {
    if (meta.id === idx.activeId) continue;
    const s = await loadSession(meta.id);
    if (s) {
      idx.activeId = s.id;
      await saveSessionsIndex(idx);
      return { idx, session: s };
    }
  }
  const s = await createSession('New chat');
  return { idx: await loadSessionsIndex(), session: s };
}

export async function appendToActiveSession(entry) {
  return withFileLock('active-session-append', async () => {
    const { idx, session } = await getActiveSession();
    session.messages.push({ ...entry, ts: new Date().toISOString() });
    if (!session.title || session.title === 'New chat') {
      if (entry.role === 'user') session.title = String(entry.content).slice(0, 60);
    }
    session.updatedAt = new Date().toISOString();
    await saveSession(session);
    cacheHtmlFromMessage(entry, session.id); // auto-save ```html / ```threejs blocks for reuse
    let meta = idx.sessions.find((x) => x.id === session.id);
    if (meta) {
      meta.title = session.title;
      meta.updatedAt = session.updatedAt;
      idx.sessions = [meta, ...idx.sessions.filter((x) => x.id !== session.id)];
    } else {
      idx.sessions.unshift({ id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt });
    }
    idx.activeId = session.id;
    await saveSessionsIndex(idx);
    return session;
  });
}

// Append to a specific session WITHOUT changing which session is active. Used for chat replies:
// if another device switches chats while a reply is streaming, the reply still lands in the chat
// it belongs to (appendToActiveSession would put it in whatever chat is active at the end).
export async function appendToSession(sessionId, entry) {
  if (!sessionId) return appendToActiveSession(entry);
  return withFileLock('active-session-append', async () => {
    const session = await loadSession(sessionId);
    if (!session) return null; // chat was deleted mid-reply
    session.messages = Array.isArray(session.messages) ? session.messages : [];
    session.messages.push({ ...entry, ts: new Date().toISOString() });
    if (!session.title || session.title === 'New chat') {
      if (entry.role === 'user') session.title = String(entry.content).slice(0, 60);
    }
    session.updatedAt = new Date().toISOString();
    await saveSession(session);
    cacheHtmlFromMessage(entry, session.id); // auto-save ```html / ```threejs blocks for reuse
    const idx = await loadSessionsIndex();
    let meta = idx.sessions.find((x) => x.id === session.id);
    if (meta) {
      meta.title = session.title;
      meta.updatedAt = session.updatedAt;
      idx.sessions = [meta, ...idx.sessions.filter((x) => x.id !== session.id)];
    } else {
      idx.sessions.unshift({ id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt });
    }
    await saveSessionsIndex(idx);
    return session;
  });
}

// A turn the user stopped: its message (and anything after it) stays visible but is never sent to the model again.
export async function markTurnCancelled(sessionId, userTs) {
  return withFileLock('active-session-append', async () => {
    const session = await loadSession(sessionId);
    if (!session?.messages) return null;
    const i = session.messages.findIndex((m) => m.role === 'user' && m.ts === userTs);
    if (i === -1) return null;
    for (let k = i; k < session.messages.length; k++) session.messages[k].cancelled = true;
    session.updatedAt = new Date().toISOString();
    await saveSession(session);
    return session;
  });
}

// Refresh a session's title/updatedAt in the index under the same lock as appends (avoids lost updates).
export async function touchSessionMeta(session) {
  return withFileLock('active-session-append', async () => {
    const idx = await loadSessionsIndex();
    const meta = idx.sessions.find((x) => x.id === session.id);
    if (!meta) return;
    meta.title = session.title;
    meta.updatedAt = session.updatedAt;
    idx.sessions = [meta, ...idx.sessions.filter((x) => x.id !== session.id)];
    await saveSessionsIndex(idx);
  });
}

// Rename a chat (the user's title sticks: auto-titling only replaces "New chat").
export async function renameSession(id, title) {
  return withFileLock('active-session-append', async () => {
    const session = await loadSession(id);
    if (!session) return null;
    session.title = title;
    await saveSession(session);
    const idx = await loadSessionsIndex();
    const meta = idx.sessions.find((x) => x.id === id);
    if (meta) { meta.title = title; await saveSessionsIndex(idx); }
    return session;
  });
}

// Pinned chats, in the user's order. They stay at the top of the list and don't move when they get new messages;
// every other chat is listed by recent activity.
export async function setPinnedSessions(ids) {
  return withFileLock('active-session-append', async () => {
    const idx = await loadSessionsIndex();
    const known = new Set(idx.sessions.map((x) => x.id));
    idx.pinned = [...new Set((ids || []).map(String))].filter((id) => known.has(id));
    await saveSessionsIndex(idx);
    return idx.pinned;
  });
}

export async function migrateLegacyConversation() {
  try {
    const idx = await loadSessionsIndex();
    if (idx.sessions.length > 0) return;
    const legacy = await readJson('conversation.json', []);
    if (!Array.isArray(legacy) || legacy.length === 0) return;
    const s = await createSession('Imported conversation');
    s.messages = legacy;
    s.updatedAt = new Date().toISOString();
    await saveSession(s);
  } catch { /* best effort */ }
}

// ---------- activity audit log ----------
let activityListener = null;
export function onActivity(fn) { activityListener = fn; }

export async function logActivity({ kind = 'system', title = '', detail = '', level = 'info', meta = null }) {
  const entry = {
    id: uid(),
    ts: new Date().toISOString(),
    kind,
    title,
    detail: String(detail || '').slice(0, 600),
    level,
    ...(meta ? { meta } : {}),
  };
  await updateJson('activity.json', [], (list) => {
    const arr = Array.isArray(list) ? list : [];
    arr.unshift(entry);
    return arr.slice(0, 200);
  });
  if (activityListener) {
    try { activityListener(entry); } catch { /* ignore */ }
  }
  return entry;
}

// Persistent Notification Center + SSE event bus with reconnect replay.
import { readJson, updateJson, uid } from './storage.js';
import { CONFIG, isInQuietHours } from './config.js';
import { pushToAllDevices } from './push.js';
import { emitEvent } from './plugins.js';

export const sseClients = new Set();
let seqCounter = Date.now();

// Monotonic "something chat-related changed" revision. Every client compares the rev it last saw
// against the rev carried by heartbeats; a mismatch means it missed an event and must resync.
// The boot id makes revs from a restarted server never collide with old ones.
const SYNC_BOOT = Date.now().toString(36);
let syncCounter = 0;
const SYNC_EVENT_TYPES = new Set(['message', 'sessions', 'proactive', 'session_compacted']);
export function getSyncRev() { return `${SYNC_BOOT}.${syncCounter}`; }

export function broadcast(obj) {
  if (obj && SYNC_EVENT_TYPES.has(obj.type)) {
    syncCounter += 1;
    obj = { ...obj, rev: getSyncRev() };
  }
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(line);
    } catch {
      sseClients.delete(client);
    }
  }
}

// Heartbeat as a real data event (SSE comments are invisible to EventSource), so clients can
// (1) detect a silently dead connection after sleep / network switch and reconnect, and
// (2) compare `rev` to notice missed chat events and resync.
setInterval(() => {
  const line = `data: ${JSON.stringify({ type: 'ping', rev: getSyncRev(), t: Date.now() })}\n\n`;
  for (const client of sseClients) {
    try { client.write(line); } catch { sseClients.delete(client); }
  }
}, 15_000).unref();

export async function listNotifications({ since = 0, unreadOnly = false, limit = 80 } = {}) {
  const all = await readJson('notifications.json', []);
  let list = Array.isArray(all) ? all : [];
  if (since > 0) list = list.filter((n) => (n.seq || 0) > since);
  if (unreadOnly) list = list.filter((n) => !n.read);
  return list.slice(0, limit);
}

export async function getUnreadCount() {
  const all = await readJson('notifications.json', []);
  return (Array.isArray(all) ? all : []).filter((n) => !n.read).length;
}

export async function pushNotification({
  title,
  body,
  urgency = 'normal', // low | normal | high | critical
  category = 'proactive', // proactive | email | reminder | task | job | watch | approval | webhook | system
  sessionId = null,
  tag = null,
  meta = null,
  silent = false,
} = {}) {
  const quiet = isInQuietHours() && urgency !== 'critical';
  const entry = {
    id: uid(),
    seq: ++seqCounter,
    ts: new Date().toISOString(),
    title: String(title || CONFIG.assistantName),
    body: String(body || '').slice(0, 600),
    urgency,
    category,
    sessionId,
    tag: tag || `${category}-${Date.now()}`,
    read: false,
    silent: Boolean(silent || quiet),
    ...(meta ? { meta } : {}),
  };

  await updateJson('notifications.json', [], (list) => {
    const arr = Array.isArray(list) ? list : [];
    arr.unshift(entry);
    return arr.slice(0, 150);
  });

  broadcast({ type: 'notification', notification: entry });
  // Web Push so closed apps / locked phones still get it. Silent (quiet hours) alerts stay in-app only.
  if (!entry.silent) pushToAllDevices(entry).catch(() => {});
  if (category !== 'plugin') emitEvent('notification', { ...entry }); // (plugin-sent ones excluded to avoid loops)
  return entry;
}

export async function markNotificationRead(id) {
  await updateJson('notifications.json', [], (list) => {
    const arr = Array.isArray(list) ? list : [];
    for (const n of arr) {
      if (n.id === id) n.read = true;
    }
    return arr;
  });
  broadcast({ type: 'notifications_updated' });
}

export async function markAllNotificationsRead() {
  await updateJson('notifications.json', [], (list) => {
    const arr = Array.isArray(list) ? list : [];
    for (const n of arr) n.read = true;
    return arr;
  });
  broadcast({ type: 'notifications_updated' });
}

export async function dismissNotification(id) {
  await updateJson('notifications.json', [], (list) =>
    (Array.isArray(list) ? list : []).filter((n) => n.id !== id)
  );
  broadcast({ type: 'notifications_updated' });
}

export async function clearNotifications() {
  await updateJson('notifications.json', [], () => []);
  broadcast({ type: 'notifications_updated' });
}

// One search box for everything Pond keeps: chats (titles and messages), stored emails and notifications.
// Plain substring search: every word must appear (case and full-/half-width ignored), so Japanese works without
// word splitting. Chat text is cached per chat and refreshed when the chat changes.
import { loadSessionsIndex, loadSession } from './storage.js';
import { getEmailStore } from './email.js';
import { listNotifications } from './notifications.js';

const norm = (s) => String(s || '').normalize('NFKC').toLowerCase();
const chatCache = new Map(); // sessionId -> { updatedAt, messages: [{ ts, role, text, n }] }

async function chatDocs(meta) {
  const hit = chatCache.get(meta.id);
  if (hit && hit.updatedAt === meta.updatedAt) return hit.messages;
  const s = await loadSession(meta.id);
  const messages = [];
  for (const m of s?.messages || []) {
    if ((m.role !== 'user' && m.role !== 'assistant') || m.toolImage) continue;
    const text = String(m.content || '').trim();
    if (text) messages.push({ ts: m.ts || '', role: m.role, text, n: norm(text) });
  }
  chatCache.set(meta.id, { updatedAt: meta.updatedAt, messages });
  return messages;
}

// ~90 characters around the first matching word, on one line.
function snippet(text, n, terms, width = 90) {
  let at = -1;
  for (const t of terms) { const i = n.indexOf(t); if (i !== -1 && (at === -1 || i < at)) at = i; }
  const src = text.length === n.length ? text : n; // NFKC changed the length: show the normalized text
  const flat = (x) => x.replace(/\s+/g, ' ').trim();
  if (at === -1) return flat(src.slice(0, width));
  const start = Math.max(0, at - 30);
  return `${start ? '…' : ''}${flat(src.slice(start, start + width))}${start + width < src.length ? '…' : ''}`;
}

export async function searchAll(query, { limit = 20 } = {}) {
  const terms = norm(query).split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return { terms: [], chats: [], emails: [], notifications: [] };
  const all = (n) => terms.every((t) => n.includes(t));

  // chats, most recently active first
  const idx = await loadSessionsIndex();
  const chats = [];
  for (const meta of [...(idx.sessions || [])].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))) {
    if (chats.length >= limit) break;
    const titleHit = all(norm(meta.title));
    const msgs = await chatDocs(meta);
    const hits = [];
    for (let i = msgs.length - 1; i >= 0 && hits.length < 3; i--) { // newest matches first
      if (all(msgs[i].n)) hits.push({ ts: msgs[i].ts, role: msgs[i].role, snippet: snippet(msgs[i].text, msgs[i].n, terms) });
    }
    if (titleHit || hits.length) chats.push({ sessionId: meta.id, title: meta.title || 'Chat', updatedAt: meta.updatedAt, matches: hits });
  }

  // emails (everything stored locally, dismissed ones too)
  const store = await getEmailStore();
  const emails = [];
  for (const m of [...(store.items || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)))) {
    if (emails.length >= limit) break;
    const body = `${m.importance?.summary || ''}\n${m.body || m.snippet || ''}`;
    const n = norm(`${m.subject}\n${m.from}\n${body}`);
    if (!all(n)) continue;
    const nb = norm(body);
    emails.push({
      id: m.id, subject: m.subject || '(no subject)', from: m.from || '', date: m.date, account: m.account || '',
      snippet: all(norm(`${m.subject} ${m.from}`)) && !terms.some((t) => nb.includes(t)) ? snippet(body, nb, []) : snippet(body, nb, terms),
    });
  }

  // notifications
  const notifications = [];
  for (const x of await listNotifications({ limit: 1000 })) {
    if (notifications.length >= limit) break;
    const n = norm(`${x.title}\n${x.body}`);
    if (!all(n)) continue;
    notifications.push({
      id: x.id, title: x.title, ts: x.ts, category: x.category, read: !!x.read, sessionId: x.sessionId || null,
      emailId: x.meta?.emailId || null, messageTs: x.messageTs || null, snippet: snippet(x.body || '', norm(x.body || ''), terms),
    });
  }
  return { terms, chats, emails, notifications };
}

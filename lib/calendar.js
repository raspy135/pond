// Personal Calendar & Agenda: local events + zero-dependency iCalendar (.ics) URL sync (Google/Apple/Outlook).
import { CONFIG } from './config.js';
import { readJson, updateJson, uid, logActivity } from './storage.js';

function parseIcsDate(val) {
  if (!val) return null;
  const clean = String(val).trim();
  // YYYYMMDDTHHMMSSZ or YYYYMMDDTHHMMSS
  const dt = clean.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (dt) {
    const iso = `${dt[1]}-${dt[2]}-${dt[3]}T${dt[4]}:${dt[5]}:${dt[6]}${dt[7] || ''}`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // All-day YYYYMMDD
  const day = clean.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (day) {
    const d = new Date(`${day[1]}-${day[2]}-${day[3]}T09:00:00`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const fallback = new Date(clean);
  return Number.isNaN(fallback.getTime()) ? null : fallback.toISOString();
}

export function parseIcsText(icsText) {
  // Unfold RFC 5545 folded lines
  const unfolded = String(icsText || '').replace(/\r?\n[ \t]/g, '');
  const blocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  const events = [];
  for (const block of blocks) {
    const get = (prop) => {
      const m = block.match(new RegExp(`^${prop}(?:;[^:]*)?:(.*)$`, 'im'));
      return m ? m[1].trim().replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';') : '';
    };
    const startAt = parseIcsDate(get('DTSTART'));
    if (!startAt) continue;
    const endAt = parseIcsDate(get('DTEND'));
    const title = get('SUMMARY') || '(Untitled event)';
    const location = get('LOCATION') || '';
    const notes = get('DESCRIPTION').slice(0, 500);
    const extId = get('UID') || `${title}-${startAt}`;
    events.push({
      id: `ics-${extId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)}`,
      title,
      startAt,
      endAt,
      location,
      notes,
      category: 'calendar',
      source: 'ics',
    });
  }
  return events;
}

export async function listEvents({ upcomingOnly = false, days = 14 } = {}) {
  const all = await readJson('events.json', []);
  let list = Array.isArray(all) ? all : [];
  if (upcomingOnly) {
    const now = Date.now() - 60 * 60_000; // include events started within the past hour
    const cutoff = Date.now() + Math.max(1, days) * 24 * 60 * 60_000;
    list = list.filter((e) => {
      const t = new Date(e.startAt).getTime();
      return !Number.isNaN(t) && t >= now && t <= cutoff;
    });
  }
  return list.sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
}

export async function addEvent({ title, startAt, endAt = null, location = '', notes = '', category = 'personal', source = 'pond' }) {
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) throw new Error('Invalid start_at date/time (use ISO 8601, e.g. 2026-11-20T18:30:00)');
  const end = endAt ? new Date(endAt) : null;
  const ev = {
    id: uid(),
    title: String(title || 'Untitled event').slice(0, 120),
    startAt: start.toISOString(),
    endAt: end && !Number.isNaN(end.getTime()) ? end.toISOString() : null,
    location: String(location || '').slice(0, 160),
    notes: String(notes || '').slice(0, 500),
    category: String(category || 'personal'),
    source,
    createdAt: new Date().toISOString(),
  };
  await updateJson('events.json', [], (list) => [...(Array.isArray(list) ? list : []), ev]);
  await logActivity({ kind: 'calendar', title: `Event added: ${ev.title}`, detail: `${ev.startAt}${ev.location ? ' @ ' + ev.location : ''}` });
  return ev;
}

export async function deleteEvent(idOrQuery) {
  const q = String(idOrQuery || '').toLowerCase();
  let removed = 0;
  await updateJson('events.json', [], (list) => {
    const arr = Array.isArray(list) ? list : [];
    const next = arr.filter((e) => !(e.id === idOrQuery || e.title.toLowerCase().includes(q)));
    removed = arr.length - next.length;
    return next;
  });
  return { ok: true, deleted: removed };
}

export async function syncIcsCalendar() {
  const url = String(CONFIG.calendar?.icsUrl || '').trim();
  if (!url) return { ok: false, configured: false, synced: 0 };
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    const parsed = parseIcsText(text);
    const now = Date.now() - 24 * 60 * 60_000;
    const horizon = Date.now() + 60 * 24 * 60 * 60_000;
    const relevant = parsed.filter((e) => {
      const t = new Date(e.startAt).getTime();
      return t >= now && t <= horizon;
    });

    await updateJson('events.json', [], (list) => {
      const localOnly = (Array.isArray(list) ? list : []).filter((e) => e.source !== 'ics');
      return [...localOnly, ...relevant];
    });
    await logActivity({ kind: 'calendar', title: `Synced ${relevant.length} calendar event(s)`, detail: 'iCal (.ics) feed refreshed' });
    return { ok: true, configured: true, synced: relevant.length };
  } catch (err) {
    const msg = String(err?.message || err);
    await logActivity({ kind: 'calendar', level: 'error', title: 'Calendar sync failed', detail: msg });
    return { ok: false, configured: true, error: msg, synced: 0 };
  }
}

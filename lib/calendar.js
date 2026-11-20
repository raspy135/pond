// Personal Calendar & Agenda: local events + zero-dependency iCalendar (.ics) URL sync (Google/Apple/Outlook),
// including repeating events and time zones.
import { CONFIG } from './config.js';
import { readJson, updateJson, uid, logActivity } from './storage.js';

// ---------- iCalendar parsing (RFC 5545 subset, zero dependencies) ----------
// Handles TZID times (incl. common Windows zone names), all-day events, DURATION, and repeating events:
// RRULE (DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY incl. 2TU/-1FR, BYMONTHDAY, BYMONTH,
// BYSETPOS, WKST), RDATE, EXDATE, and moved/cancelled single occurrences (RECURRENCE-ID).

const WINDOWS_TZ = {
  'Pacific Standard Time': 'America/Los_Angeles', 'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix', 'Central Standard Time': 'America/Chicago',
  'Eastern Standard Time': 'America/New_York', 'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'Atlantic Standard Time': 'America/Halifax',
  'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest', 'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Kiev',
  'Tokyo Standard Time': 'Asia/Tokyo', 'Korea Standard Time': 'Asia/Seoul', 'China Standard Time': 'Asia/Shanghai',
  'Taipei Standard Time': 'Asia/Taipei', 'Singapore Standard Time': 'Asia/Singapore', 'India Standard Time': 'Asia/Kolkata',
  'AUS Eastern Standard Time': 'Australia/Sydney', 'New Zealand Standard Time': 'Pacific/Auckland',
  UTC: 'UTC', 'Coordinated Universal Time': 'UTC',
};
const dtfCache = new Map();
function zoneFormatter(tz) {
  if (dtfCache.has(tz)) return dtfCache.get(tz);
  let f = null;
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch { f = null; }
  dtfCache.set(tz, f);
  return f;
}
function resolveTz(tzid) {
  if (!tzid) return null;
  const clean = String(tzid).replace(/^"|"$/g, '').replace(/^\/[^/]+\/[^/]+\//, ''); // strip "/mozilla.org/20070129_1/" prefixes
  if (zoneFormatter(clean)) return clean;
  const win = WINDOWS_TZ[clean];
  return win && zoneFormatter(win) ? win : null; // unknown → treat as the PC's local time
}
function zoneOffsetMs(tz, utcMs) {
  const p = Object.fromEntries(zoneFormatter(tz).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}
// Wall-clock time in a zone → UTC ms. tz 'UTC' = absolute; null = floating (the PC's local time).
function wallToUtc(w, tz) {
  const guess = Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s);
  if (tz === 'UTC') return guess;
  if (!tz) return new Date(w.y, w.mo, w.d, w.h, w.mi, w.s).getTime();
  const off = zoneOffsetMs(tz, guess);
  let t = guess - off;
  const off2 = zoneOffsetMs(tz, t);
  if (off2 !== off) t = guess - off2; // DST edge
  return t;
}

// One content line → { name, params, value }. Values may contain ':' and params may be quoted.
function parseContentLine(line) {
  let inQ = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ':' && !inQ) { colon = i; break; }
  }
  if (colon === -1) return null;
  const [name, ...rawParams] = line.slice(0, colon).split(';');
  const params = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}
const unescapeText = (v) => String(v || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim();

// "20261120T190000Z" / "20261120T100000" (+TZID) / "20261120" (all-day) → { wall, tz, allDay, utc }
function parseIcsDateValue(value, params = {}) {
  const v = String(value || '').trim();
  const dt = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (dt) {
    const wall = { y: +dt[1], mo: +dt[2] - 1, d: +dt[3], h: +dt[4], mi: +dt[5], s: +dt[6] };
    const tz = dt[7] ? 'UTC' : resolveTz(params.TZID);
    return { wall, tz, allDay: false, utc: wallToUtc(wall, tz) };
  }
  const day = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (day) {
    // All-day: shown at 9:00 local so it lands on the right day everywhere in the UI.
    const wall = { y: +day[1], mo: +day[2] - 1, d: +day[3], h: 9, mi: 0, s: 0 };
    return { wall, tz: null, allDay: true, utc: wallToUtc(wall, null) };
  }
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : { wall: null, tz: 'UTC', allDay: false, utc: t };
}
function parseDurationMs(v) {
  const m = String(v || '').match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 * 86400 + (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const DAY_MS = 86_400_000;
const dayNum = (y, mo, d) => Math.floor(Date.UTC(y, mo, d) / DAY_MS);
const fromDayNum = (n) => { const x = new Date(n * DAY_MS); return { y: x.getUTCFullYear(), mo: x.getUTCMonth(), d: x.getUTCDate(), wd: x.getUTCDay() }; };
const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();

function parseRrule(text) {
  const r = {};
  for (const part of String(text || '').split(';')) {
    const [k, v] = part.split('=');
    if (k && v !== undefined) r[k.toUpperCase()] = v;
  }
  const list = (k) => (r[k] ? r[k].split(',').map((x) => x.trim()).filter(Boolean) : null);
  return {
    freq: (r.FREQ || '').toUpperCase(),
    interval: Math.max(1, parseInt(r.INTERVAL, 10) || 1),
    count: r.COUNT ? parseInt(r.COUNT, 10) : null,
    until: r.UNTIL || null,
    byDay: list('BYDAY')?.map((x) => { const m = x.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/i); return m ? { n: m[1] ? parseInt(m[1], 10) : 0, wd: WD[m[2].toUpperCase()] } : null; }).filter(Boolean) || null,
    byMonthDay: list('BYMONTHDAY')?.map(Number).filter((n) => n && Math.abs(n) <= 31) || null,
    byMonth: list('BYMONTH')?.map(Number).filter((n) => n >= 1 && n <= 12) || null,
    bySetPos: list('BYSETPOS')?.map(Number).filter(Boolean) || null,
    wkst: WD[(r.WKST || 'MO').toUpperCase()] ?? 1,
  };
}

// Does this calendar day belong to the rule (ignoring COUNT/UNTIL)? `s` is the series start day.
function dayMatches(rule, s, c, { skipSetPos = false } = {}) {
  const { freq, interval, byDay, byMonthDay, byMonth } = rule;
  const n = dayNum(c.y, c.mo, c.d);
  if (freq === 'DAILY') { if ((n - s.n) % interval) return false; }
  else if (freq === 'WEEKLY') {
    const wkStart = (x, wd) => x - ((wd - rule.wkst + 7) % 7);
    if (((wkStart(n, c.wd) - wkStart(s.n, s.wd)) / 7) % interval) return false;
  } else if (freq === 'MONTHLY') { if (((c.y - s.y) * 12 + (c.mo - s.mo)) % interval) return false; }
  else if (freq === 'YEARLY') { if ((c.y - s.y) % interval) return false; }
  else return false;

  if (byMonth) { if (!byMonth.includes(c.mo + 1)) return false; }
  else if (freq === 'YEARLY' && !byDay && !byMonthDay && c.mo !== s.mo) return false;

  const dim = daysInMonth(c.y, c.mo);
  if (byMonthDay) { if (!byMonthDay.includes(c.d) && !byMonthDay.includes(c.d - dim - 1)) return false; }
  else if ((freq === 'MONTHLY' || freq === 'YEARLY') && !byDay && c.d !== s.d) return false;

  if (byDay) {
    const ok = byDay.some((b) => {
      if (b.wd !== c.wd) return false;
      if (!b.n || freq === 'DAILY' || freq === 'WEEKLY') return true;
      return b.n > 0 ? Math.ceil(c.d / 7) === b.n : Math.ceil((dim - c.d + 1) / 7) === -b.n;
    });
    if (!ok) return false;
  } else if (freq === 'WEEKLY' && c.wd !== s.wd) return false;

  if (rule.bySetPos && !skipSetPos && (freq === 'MONTHLY' || freq === 'YEARLY')) {
    const days = [];
    for (let d = 1; d <= dim; d++) {
      const x = fromDayNum(dayNum(c.y, c.mo, d));
      if (dayMatches(rule, s, x, { skipSetPos: true })) days.push(d);
    }
    return rule.bySetPos.some((p) => days[p > 0 ? p - 1 : days.length + p] === c.d);
  }
  return true;
}

const occKey = (p) => (p.allDay ? `D${p.wall.y}-${p.wall.mo}-${p.wall.d}` : `T${p.utc}`);
function hashId(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// opts.from / opts.to (ms): the window repeating events are expanded into (one-off events are always returned).
export function parseIcsText(icsText, { from = Date.now() - 31 * DAY_MS, to = Date.now() + 366 * DAY_MS } = {}) {
  const unfolded = String(icsText || '').replace(/\r?\n[ \t]/g, '');
  const blocks = unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) || [];
  const parsed = [];
  for (const raw of blocks) {
    const block = raw.replace(/BEGIN:VALARM[\s\S]*?END:VALARM/g, '');
    const props = {};
    for (const line of block.split(/\r?\n/)) {
      const cl = parseContentLine(line);
      if (cl) (props[cl.name] ||= []).push(cl);
    }
    const one = (k) => props[k]?.[0];
    const start = one('DTSTART') && parseIcsDateValue(one('DTSTART').value, one('DTSTART').params);
    if (!start) continue;
    const end = one('DTEND') && parseIcsDateValue(one('DTEND').value, one('DTEND').params);
    let durationMs = end ? end.utc - start.utc : parseDurationMs(one('DURATION')?.value);
    if (durationMs === null || durationMs < 0) durationMs = start.allDay ? 0 : null;
    const dates = (k) => (props[k] || []).flatMap((p) => String(p.value).split(',').map((v) => parseIcsDateValue(v, p.params)).filter(Boolean));
    parsed.push({
      uid: unescapeText(one('UID')?.value),
      title: unescapeText(one('SUMMARY')?.value) || '(Untitled event)',
      location: unescapeText(one('LOCATION')?.value),
      notes: unescapeText(one('DESCRIPTION')?.value).slice(0, 500),
      status: String(one('STATUS')?.value || '').toUpperCase(),
      start, durationMs,
      rrule: one('RRULE') ? parseRrule(one('RRULE').value) : null,
      exdates: dates('EXDATE'), rdates: dates('RDATE'),
      recurrenceId: one('RECURRENCE-ID') ? parseIcsDateValue(one('RECURRENCE-ID').value, one('RECURRENCE-ID').params) : null,
    });
  }

  const toEvent = (ev, startUtc, idSuffix = '', extra = {}) => ({
    id: `ics-${(ev.uid || `${ev.title}-${ev.start.utc}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)}${idSuffix}`,
    title: ev.title,
    startAt: new Date(startUtc).toISOString(),
    endAt: ev.durationMs !== null && !(ev.start.allDay && !ev.durationMs) ? new Date(startUtc + ev.durationMs).toISOString() : null,
    location: ev.location,
    notes: ev.notes,
    category: 'calendar',
    source: 'ics',
    ...(ev.start.allDay ? { allDay: true } : {}),
    ...extra,
  });

  // Moved or cancelled single occurrences, keyed by series UID + original time.
  const overridden = new Map();
  for (const ev of parsed) if (ev.recurrenceId && ev.uid) {
    if (!overridden.has(ev.uid)) overridden.set(ev.uid, new Set());
    overridden.get(ev.uid).add(occKey(ev.recurrenceId));
  }

  const events = [];
  for (const ev of parsed) {
    if (ev.status === 'CANCELLED') continue;
    if (ev.recurrenceId) { // a moved occurrence: its own event
      events.push(toEvent(ev, ev.start.utc, `-${hashId(occKey(ev.recurrenceId))}`, { recurring: true }));
      continue;
    }
    if (!ev.rrule && !ev.rdates.length) { events.push(toEvent(ev, ev.start.utc)); continue; }

    const skip = new Set([...ev.exdates.map(occKey), ...(overridden.get(ev.uid) || [])]);
    const span = Math.max(0, ev.durationMs || 0);
    const emit = (p) => {
      if (skip.has(occKey(p))) return;
      if (p.utc + span < from || p.utc > to) return;
      events.push(toEvent(ev, p.utc, `-${hashId(occKey(p))}`, { recurring: true }));
    };
    const s0 = ev.start;
    const seen = new Set([occKey(s0)]);
    emit(s0); // DTSTART is always the first occurrence
    for (const r of ev.rdates) {
      if (!seen.has(occKey(r))) { seen.add(occKey(r)); emit(r); }
    }
    const rule = ev.rrule;
    if (!rule || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq) || !s0.wall) continue;
    const until = rule.until ? parseIcsDateValue(rule.until, s0.tz && s0.tz !== 'UTC' ? { TZID: s0.tz } : {}) : null;
    const untilUtc = until ? (until.allDay ? until.utc + DAY_MS : until.utc) : Infinity;
    const s = { y: s0.wall.y, mo: s0.wall.mo, d: s0.wall.d, n: dayNum(s0.wall.y, s0.wall.mo, s0.wall.d) };
    s.wd = fromDayNum(s.n).wd;
    const lastDay = Math.min(Math.floor(Math.min(to, untilUtc) / DAY_MS) + 2, s.n + 366 * 50);
    let count = 1;
    for (let n = s.n + 1; n <= lastDay; n++) {
      if (rule.count && count >= rule.count) break;
      const c = fromDayNum(n);
      if (!dayMatches(rule, s, c)) continue;
      // Well before the window: only COUNT matters, so skip the (slow) time-zone math.
      if ((n + 2) * DAY_MS < from && (n + 2) * DAY_MS < untilUtc) { count++; continue; }
      const wall = { y: c.y, mo: c.mo, d: c.d, h: s0.wall.h, mi: s0.wall.mi, s: s0.wall.s };
      const p = { wall, tz: s0.tz, allDay: s0.allDay, utc: wallToUtc(wall, s0.tz) };
      if (p.utc > untilUtc) break;
      count++;
      if (seen.has(occKey(p))) continue;
      emit(p);
    }
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
    const now = Date.now() - 24 * 60 * 60_000;
    const horizon = Date.now() + 60 * 24 * 60 * 60_000;
    const parsed = parseIcsText(text, { from: now, to: horizon });
    const relevant = parsed.filter((e) => {
      const t = new Date(e.startAt).getTime();
      const endT = e.endAt ? new Date(e.endAt).getTime() : t;
      return endT >= now && t <= horizon; // includes multi-day events already under way
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

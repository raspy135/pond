// Repeating events in iCal feeds (parseIcsText). Run: node test/ics-recurrence.test.mjs
// Time-zone independent: run it under any TZ (e.g. TZ=Asia/Tokyo) to check.
import os from 'node:os';
import path from 'node:path';
process.env.OPEN_DOTS_DATA_DIR ||= path.join(os.tmpdir(), 'pond-ics-test'); // never touch real data
const { parseIcsText } = await import('../lib/calendar.js');
let fails = 0; const ok = (c, m, extra = '') => { console.log(c ? 'ok  ' : 'FAIL', m, c ? '' : extra); if (!c) fails++; };
const cal = (...evs) => ['BEGIN:VCALENDAR', ...evs.flatMap((e) => ['BEGIN:VEVENT', ...e, 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');
const W = { from: Date.parse('2026-10-01T00:00:00Z'), to: Date.parse('2027-03-01T00:00:00Z') };
const la = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const titles = (evs, t) => evs.filter((e) => e.title === t).map((e) => la(e.startAt));

// 1. Weekly Mon+Wed 10:00 LA, across the Nov 1 DST change; one EXDATE; one occurrence moved; one cancelled.
let ev = parseIcsText(cal(
  ['UID:standup@g', 'SUMMARY:Standup', 'DTSTART;TZID=America/Los_Angeles:20261005T100000', 'DTEND;TZID=America/Los_Angeles:20261005T103000',
   'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261112T000000Z', 'EXDATE;TZID=America/Los_Angeles:20261014T100000',
   'BEGIN:VALARM', 'DESCRIPTION:alarm', 'END:VALARM'],
  ['UID:standup@g', 'SUMMARY:Standup (moved)', 'RECURRENCE-ID;TZID=America/Los_Angeles:20261019T100000', 'DTSTART;TZID=America/Los_Angeles:20261020T150000', 'DTEND;TZID=America/Los_Angeles:20261020T153000'],
  ['UID:standup@g', 'SUMMARY:Standup', 'RECURRENCE-ID;TZID=America/Los_Angeles:20261026T100000', 'DTSTART;TZID=America/Los_Angeles:20261026T100000', 'STATUS:CANCELLED'],
), W);
const su = titles(ev, 'Standup');
ok(su.length === 9 && su.every((s) => s.endsWith('10:00 AM')), 'weekly MO,WE stays 10:00 across DST, EXDATE/cancel/move removed', JSON.stringify(su));
ok(!su.some((s) => /Oct 14|Oct 19|Oct 26/.test(s)) && su.includes('Mon, Nov 2, 10:00 AM') && su.includes('Wed, Nov 11, 10:00 AM') && !su.some((s) => /Nov 16/.test(s)), 'right dates, UNTIL respected', JSON.stringify(su));
ok(titles(ev, 'Standup (moved)')[0] === 'Tue, Oct 20, 3:00 PM', 'moved occurrence shows at its new time');
const one = ev.find((e) => e.title === 'Standup');
ok(new Date(one.endAt) - new Date(one.startAt) === 30 * 60_000 && new Set(ev.map((e) => e.id)).size === ev.length, 'durations kept, ids unique');

// 2. Monthly 2nd Tuesday, last Friday, last weekday (BYSETPOS), COUNT, every-other-day, yearly all-day birthday, Windows TZ.
ev = parseIcsText(cal(
  ['UID:a', 'SUMMARY:2nd Tue', 'DTSTART;TZID=America/Los_Angeles:20260908T190000', 'RRULE:FREQ=MONTHLY;BYDAY=2TU'],
  ['UID:b', 'SUMMARY:Last Fri', 'DTSTART:20260925T170000Z', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=4'],
  ['UID:c', 'SUMMARY:Last weekday', 'DTSTART;TZID=America/Los_Angeles:20260930T090000', 'RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'],
  ['UID:d', 'SUMMARY:Every 2 days', 'DTSTART;TZID=America/Los_Angeles:20261001T070000', 'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=5'],
  ['UID:e', 'SUMMARY:Birthday', 'DTSTART;VALUE=DATE:19900115', 'DTEND;VALUE=DATE:19900116', 'RRULE:FREQ=YEARLY'],
  ['UID:f', 'SUMMARY:Tokyo call', 'DTSTART;TZID="Tokyo Standard Time":20261104T090000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3'],
  ['UID:g', 'SUMMARY:One-off', 'DTSTART:20201120T190000Z', 'DTEND:20201120T200000Z'],
), W);
ok(JSON.stringify(titles(ev, '2nd Tue').slice(0, 5)) === JSON.stringify(['Tue, Oct 13, 7:00 PM', 'Tue, Nov 10, 7:00 PM', 'Tue, Dec 8, 7:00 PM', 'Tue, Jan 12, 7:00 PM', 'Tue, Feb 9, 7:00 PM']), 'monthly 2nd Tuesday', JSON.stringify(titles(ev, '2nd Tue')));
ok(JSON.stringify(titles(ev, 'Last Fri')) === JSON.stringify(['Fri, Oct 30, 10:00 AM', 'Fri, Nov 27, 9:00 AM', 'Fri, Dec 25, 9:00 AM']), 'last Friday, COUNT=4 (1st was Sep, before window); UTC time shifts with DST', JSON.stringify(titles(ev, 'Last Fri')));
ok(JSON.stringify(titles(ev, 'Last weekday').slice(0, 4)) === JSON.stringify(['Fri, Oct 30, 9:00 AM', 'Mon, Nov 30, 9:00 AM', 'Thu, Dec 31, 9:00 AM', 'Fri, Jan 29, 9:00 AM']), 'BYSETPOS=-1 last weekday', JSON.stringify(titles(ev, 'Last weekday')));
ok(JSON.stringify(titles(ev, 'Every 2 days')) === JSON.stringify(['Thu, Oct 1, 7:00 AM', 'Sat, Oct 3, 7:00 AM', 'Mon, Oct 5, 7:00 AM', 'Wed, Oct 7, 7:00 AM', 'Fri, Oct 9, 7:00 AM']), 'daily interval 2, COUNT', JSON.stringify(titles(ev, 'Every 2 days')));
const bd = ev.filter((e) => e.title === 'Birthday');
ok(bd.length === 1 && bd[0].allDay && new Date(bd[0].startAt).getDate() === 15 && new Date(bd[0].startAt).getMonth() === 0, 'yearly all-day from 1990 lands on Jan 15, 2027', JSON.stringify(bd));
ok(JSON.stringify(titles(ev, 'Tokyo call')) === JSON.stringify(['Tue, Nov 3, 4:00 PM', 'Tue, Nov 17, 4:00 PM', 'Tue, Dec 1, 4:00 PM']), 'Windows zone name + biweekly + DURATION', JSON.stringify(titles(ev, 'Tokyo call')));
ok(ev.some((e) => e.title === 'One-off'), 'one-off events are always returned (sync filters them)');

// 3. Old test shape still works; speed with a big daily-since-2010 series.
ev = parseIcsText(cal(['UID:ev-101@example.com', 'DTSTART:20261120T190000Z', 'DTEND:20261120T210000Z', 'SUMMARY:Dinner at Nopa', 'LOCATION:560 Divisadero St']));
ok(ev.length === 1 && ev[0].location === '560 Divisadero St' && ev[0].id === 'ics-ev-101examplecom', 'plain event unchanged');
const t0 = Date.now();
ev = parseIcsText(cal(...Array.from({ length: 50 }, (_, i) => [`UID:d${i}`, 'SUMMARY:Daily', 'DTSTART;TZID=America/Los_Angeles:20100101T080000', 'RRULE:FREQ=DAILY'])), W);
ok(ev.length === 50 * 151 && Date.now() - t0 < 4000, `50 daily series since 2010 in ${Date.now() - t0} ms`);
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);

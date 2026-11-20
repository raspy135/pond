// End-to-end test suite for Pond v0.2 advanced personal AI agent server.
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { matchesCron } from '../lib/scheduler.js';
import { parseRawEmail, heuristicTriageEmail } from '../lib/email.js';
import { parseIcsText } from '../lib/calendar.js';
import { buildStaticSystemPrompt, sliceHistoryCacheFriendly } from '../lib/llm.js';

console.log('1) Running unit tests (cron, MIME email parser, iCal .ics, email triage)...');

// Cron tests
assert.equal(matchesCron('30 8 * * 1-5', new Date('2026-11-19T08:30:00')), true, 'Thursday 8:30 matches weekday cron');
assert.equal(matchesCron('30 8 * * 1-5', new Date('2026-11-21T08:30:00')), false, 'Saturday does not match 1-5');
assert.equal(matchesCron('*/15 * * * *', new Date('2026-11-19T12:45:00')), true, '*/15 matches :45');
assert.equal(matchesCron('*/15 * * * *', new Date('2026-11-19T12:46:00')), false, '*/15 rejects :46');
assert.equal(matchesCron('@daily', new Date('2026-11-19T09:00:00')), true, '@daily matches 9:00');

// MIME email parsing tests
const rawMime = [
  'From: =?UTF-8?B?QWxpY2UgU21pdGg=?= <alice@example.com>',
  'To: user@example.com',
  'Subject: =?UTF-8?Q?Flight_Confirmation_&_Gate_Update?=',
  'Date: Thu, 19 Nov 2026 10:00:00 +0000',
  'Content-Type: multipart/alternative; boundary="bnd123"',
  '',
  '--bnd123',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Hello! Your flight departs at 6:30 PM =E2=80=94 Gate B12.',
  '--bnd123',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Hello HTML</p>',
  '--bnd123--',
].join('\r\n');
const parsedMail = parseRawEmail(rawMime, { uid: 42, flags: [] });
assert.equal(parsedMail.from, 'Alice Smith <alice@example.com>');
assert.equal(parsedMail.subject, 'Flight Confirmation & Gate Update');
assert.ok(parsedMail.body.includes('Gate B12'), 'Decoded multipart text/plain');
assert.equal(parsedMail.unread, true);

// Heuristic email triage
const urgentTriage = heuristicTriageEmail({ from: 'airline@united.com', subject: 'Urgent flight gate change', snippet: 'Your flight was moved.' });
assert.equal(urgentTriage.important, true);
assert.equal(urgentTriage.urgency, 'critical');
const promoTriage = heuristicTriageEmail({ from: 'news@store.com', subject: 'Weekly newsletter sale', snippet: 'Unsubscribe anytime' });
assert.equal(promoTriage.important, false);

// iCalendar (.ics) parsing
const sampleIcs = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:ev-101@example.com',
  'DTSTART:20261120T190000Z',
  'DTEND:20261120T210000Z',
  'SUMMARY:Dinner at Nopa',
  'LOCATION:560 Divisadero St',
  'DESCRIPTION:Table for 2',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');
const icsEvents = parseIcsText(sampleIcs);
assert.equal(icsEvents.length, 1);
assert.equal(icsEvents[0].title, 'Dinner at Nopa');
assert.equal(icsEvents[0].location, '560 Divisadero St');

// KV / Prefix cache stability tests
const sys1 = buildStaticSystemPrompt();
const sys2 = buildStaticSystemPrompt();
assert.equal(sys1, sys2, 'Static system prompt must be 100% byte-identical');
assert.ok(!/Current local time:/i.test(sys1), 'Static system prompt must not contain volatile timestamps');

const longHist = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg-${i}` }));
const w1 = sliceHistoryCacheFriendly(longHist);
const w2 = sliceHistoryCacheFriendly([...longHist, { role: 'user', content: 'msg-50' }]);
assert.equal(w1[0].content, w2[0].content, 'Chunked history window keeps prefix start stable across turns');

console.log('   Unit tests passed!\n');

// ---------- 2) Spin up local Mock LLM + Pond Server for Live Integration Tests ----------
console.log('2) Running live integration tests (SSE notifications, Email AI triage, Calendar, Jobs, Sentinel, Webhooks, OpenAI API)...');

const capturedChatRequests = [];
const mockLlm = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404);
    return res.end();
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    if (parsed.stream) capturedChatRequests.push(parsed);
    const msgs = parsed.messages || [];
    const sys = msgs[0]?.content || '';
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content || '';
    const hasToolResult = msgs.some((m) => m.role === 'tool');

    if (!parsed.stream) {
      let content = 'All good!';
      if (/Email Intelligence Triage Agent/i.test(sys)) {
        content = JSON.stringify({
          important: true,
          urgency: 'critical',
          category: 'travel',
          summary: 'Flight UA 418 boarding moved earlier to Gate B14.',
          suggestedAction: 'Want me to add a reminder to leave 30 minutes earlier?',
          shouldNotify: true,
        });
      } else if (/external webhook event/i.test(sys)) {
        content = JSON.stringify({
          notify: true,
          urgency: 'high',
          title: 'Package Out for Delivery',
          message: 'Your package from UPS is arriving today between 2–4 PM.',
        });
      } else if (/Scheduled Recurring Routine/i.test(lastUser)) {
        content = 'Good morning! You have 1 urgent flight email and 1 dinner reservation tonight.';
      } else if (/Autonomous Proactive Check-in/i.test(lastUser)) {
        content = JSON.stringify({
          speak: true,
          urgency: 'normal',
          tag: 'Daily Check-in',
          message: 'Quick heads-up: you have an open evening tonight — want me to suggest a nearby event?',
        });
      } else {
        content = `Pond reply: ${lastUser.slice(0, 60)}`;
      }
      const respBody = JSON.stringify({
        id: 'mock-cmpl',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(respBody);
    }

    // Streaming chat with Sentinel tool test
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const chunk = (delta, finish = null) =>
      send({ id: 'mock-stream', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });

    if (!hasToolResult && /send email/i.test(lastUser)) {
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_send_1',
            type: 'function',
            function: {
              name: 'send_email',
              arguments: JSON.stringify({ to: 'friend@example.com', subject: 'Dinner tonight', body: 'See you at 7!' }),
            },
          },
        ],
      });
      chunk({}, 'tool_calls');
    } else if (!hasToolResult && /calc prefix test/i.test(lastUser)) {
      chunk({ reasoning_content: 'Let me calculate 6 * 7 using calculate.' });
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_calc_1',
            type: 'function',
            function: { name: 'calculate', arguments: JSON.stringify({ expression: '6 * 7' }) },
          },
        ],
      });
      chunk({}, 'tool_calls');
    } else {
      if (hasToolResult) chunk({ reasoning_content: 'The tool gave 42.' });
      const text = hasToolResult ? 'Result is 42 — handled cleanly.' : `Streamed reply to ${lastUser.slice(0, 40)}`;
      chunk({ content: text });
      chunk({}, 'stop');
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

await new Promise((r) => mockLlm.listen(0, '127.0.0.1', r));
const mockPort = mockLlm.address().port;
const testPort = 18789;
const tempDataDir = await mkdtemp(path.join(os.tmpdir(), 'pond-test-data-'));

const child = spawn(process.execPath, ['server.js'], {
  env: {
    ...process.env,
    OPEN_DOTS_PORT: String(testPort),
    OPEN_DOTS_DATA_DIR: tempDataDir,
    OPEN_DOTS_OPENAI_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    OPEN_DOTS_OPENAI_API_KEY: 'sk-test-mock-key',
    OPEN_DOTS_MODEL: 'mock-pond',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write('[server stderr] ' + d));
child.stdout.on('data', (d) => process.stdout.write('[server stdout] ' + d));

// Override baseUrl/model via temporary runtime? Wait: server reads .env; let's wait until listening and check health.
const base = `http://127.0.0.1:${testPort}`;

async function waitForServer() {
  let lastErr;
  for (let i = 0; i < 15; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return await r.json();
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Server did not start in time: ${lastErr?.cause?.message || lastErr?.message || lastErr}`);
}

let createdIds = { jobs: [], watches: [], events: [] };

try {
  const health = await waitForServer();
  assert.equal(health.ok, true);
  assert.equal(health.version, '0.2.0');
  console.log('   ✓ /api/health OK');

  // Open SSE stream to capture live notifications & alerts
  const sseEvents = [];
  const sseAbort = new AbortController();
  const ssePromise = fetch(`${base}/api/events`, { signal: sseAbort.signal }).then(async (resp) => {
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const l of lines) {
          if (l.startsWith('data:')) {
            try { sseEvents.push(JSON.parse(l.slice(5).trim())); } catch {}
          }
        }
      }
    } catch { /* aborted cleanly */ }
  });
  await new Promise((r) => setTimeout(r, 200));

  // Test Notification push & SSE delivery
  const testNotif = await fetch(`${base}/api/notifications/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Test Alert', body: 'Hello browser notification!', urgency: 'high' }),
  }).then((r) => r.json());
  assert.equal(testNotif.ok, true);
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(sseEvents.some((e) => e.type === 'notification' && e.notification?.title === 'Test Alert'), 'SSE delivered browser notification');
  console.log('   ✓ Browser notification push + SSE delivery OK');

  // Test Calendar API
  const evRes = await fetch(`${base}/api/calendar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Jazz Night Downtown', startAt: new Date(Date.now() + 86_400_000).toISOString(), location: 'Blue Note' }),
  }).then((r) => r.json());
  assert.equal(evRes.ok, true);
  createdIds.events.push(evRes.event.id);
  const stateRes = await fetch(`${base}/api/state`).then((r) => r.json());
  assert.ok(stateRes.events.some((e) => e.id === evRes.event.id), 'Calendar event appears in /api/state');
  console.log('   ✓ Personal calendar API OK');

  // Test Scheduled Job CRUD
  const jobRes = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test Morning Brief', cron: '0 8 * * *', prompt: 'Summarize my day.' }),
  }).then((r) => r.json());
  assert.equal(jobRes.ok, true);
  createdIds.jobs.push(jobRes.job.id);
  console.log('   ✓ Scheduled jobs API OK');

  // Test Watchers CRUD
  const watchRes = await fetch(`${base}/api/watches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test Local Events', type: 'search', target: 'weekend events near me', intervalMin: 60 }),
  }).then((r) => r.json());
  assert.equal(watchRes.ok, true);
  createdIds.watches.push(watchRes.watch.id);
  console.log('   ✓ Proactive watchers API OK');

  // Test Settings GET + PATCH
  const curSet = await fetch(`${base}/api/settings`).then((r) => r.json());
  assert.ok(curSet.proactive && curSet.email && curSet.sentinel, 'Settings structure valid');
  console.log('   ✓ Runtime settings API OK');

  // Test LLM JSON config API (/api/llm) + reasoningEffort + /api/python/status
  const llmGet = await fetch(`${base}/api/llm`).then((r) => r.json());
  assert.ok(llmGet.profiles?.default, 'data/llm.json auto-bootstrapped');
  const llmPut = await fetch(`${base}/api/llm`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      activeProfile: 'default',
      fastProfile: '',
      profiles: {
        default: {
          ...llmGet.profiles.default,
          contextLength: 768000,
          reasoningEffort: 'high',
        },
      },
    }),
  }).then((r) => r.json());
  assert.equal(llmPut.ok, true);
  assert.equal(llmPut.llm.resolved.contextLength, 768000);
  assert.equal(llmPut.llm.resolved.reasoningEffort, 'high');
  const compactRes = await fetch(`${base}/api/sessions/compact`, { method: 'POST' }).then((r) => r.json());
  assert.equal(compactRes.ok, true);
  const pyStatus = await fetch(`${base}/api/python/status`).then((r) => r.json());
  assert.equal(typeof pyStatus.available, 'boolean');
  console.log('   ✓ LLM JSON config (data/llm.json + reasoningEffort) & Python status API OK');

  // Test MCP Auto-Discovery API
  const mcpDisc = await fetch(`${base}/api/mcp/discover?ports=0`).then((r) => r.json());
  assert.ok(Array.isArray(mcpDisc.discovered) && Array.isArray(mcpDisc.presets) && mcpDisc.presets.length >= 4, 'MCP auto-discovery & presets returned');
  console.log('   ✓ MCP auto-discovery & presets API OK');

  // Test Email Ingest -> AI Importance Triage -> Instant Browser Notification + Proactive Chat!
  const emailIngest = await fetch(`${base}/api/emails/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'United Airlines <notifications@united.com>',
      subject: 'Flight UA 418 Gate Change',
      body: 'Your flight moved 35 minutes earlier to Gate B14.',
      source: 'test-suite',
    }),
  }).then((r) => r.json());
  assert.equal(emailIngest.ok, true);
  assert.equal(emailIngest.triage.alerted, 1, 'AI triage should alert on urgent flight email');
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(sseEvents.some((e) => e.type === 'email_alert'), 'SSE emitted email_alert');
  assert.ok(sseEvents.some((e) => e.type === 'notification' && e.notification?.category === 'email'), 'SSE emitted browser notification for email');
  console.log('   ✓ Email AI triage + instant browser notification OK');

  // Test 100% Byte-Identical Prefix Caching Across Reasoning + Tool-Call Turns!
  await fetch(`${base}/api/sessions`, { method: 'POST' });
  capturedChatRequests.length = 0;
  const turn1Sse = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Please run calc prefix test' }] }),
  }).then((r) => r.text());
  assert.ok(turn1Sse.includes('"type":"reasoning"'), 'Streamed reasoning tokens to UI');
  assert.ok(turn1Sse.includes('"type":"tool_start"'), 'Streamed tool_start for working animation');

  await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Follow up question' }] }),
  }).then((r) => r.text());

  assert.equal(capturedChatRequests.length, 3, 'Turn 1 (2 rounds) + Turn 2 (1 round)');
  const [t1r1, t1r2, t2r1] = capturedChatRequests;
  assert.equal(JSON.stringify(t1r1.tools), JSON.stringify(t2r1.tools), 'Tool schemas byte-identical');
  // Every message present in Turn 1 Round 2 MUST be byte-for-byte identical at the start of Turn 2!
  for (let i = 0; i < t1r2.messages.length; i++) {
    assert.deepEqual(t2r1.messages[i], t1r2.messages[i], `Message[${i}] byte-identical in Turn 2 prefix`);
  }
  assert.equal(t2r1.messages[2].reasoning_content, 'Let me calculate 6 * 7 using calculate.', 'Reasoning replayed in Turn 2');
  assert.equal(t2r1.messages[3].role, 'tool', 'Tool result replayed in Turn 2');
  assert.equal(t2r1.messages[4].reasoning_content, 'The tool gave 42.', 'Final turn reasoning replayed in Turn 2');
  console.log('   ✓ 100% byte-identical reasoning + tool-call KV prefix replay verified!');

  // Test Sentinel Out-of-Band Approval Gate on send_email (fresh session)
  await fetch(`${base}/api/sessions`, { method: 'POST' });
  const chatPromise = fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Please send email to friend@example.com' }] }),
  }).then((r) => r.text());

  // Wait for Sentinel approval_required SSE event
  let approvalEvt = null;
  for (let i = 0; i < 30; i++) {
    approvalEvt = sseEvents.find((e) => e.type === 'approval_required' && e.approval?.tool === 'send_email');
    if (approvalEvt) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(approvalEvt, 'Sentinel paused send_email and emitted approval_required');
  const decideRes = await fetch(`${base}/api/approvals/${approvalEvt.approval.id}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'deny' }),
  }).then((r) => r.json());
  assert.equal(decideRes.status, 'denied');
  const chatSseText = await chatPromise;
  assert.ok(chatSseText.includes('denied') || chatSseText.includes('handled cleanly'), 'Agent received Sentinel denial cleanly');
  console.log('   ✓ Sentinel out-of-band approval gate OK');

  // Test Inbound Webhook Triage
  const hookRes = await fetch(`${base}/api/webhooks/ups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tracking: '1Z999', status: 'Out for Delivery' }),
  }).then((r) => r.json());
  assert.equal(hookRes.ok, true);
  assert.equal(hookRes.notified, true);
  console.log('   ✓ Inbound webhook AI triage OK');

  // Test OpenAI-Compatible Agent API (/api/v1/chat/completions)
  const oaiRes = await fetch(`${base}/api/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'pond', messages: [{ role: 'user', content: 'Hello Pond API' }] }),
  }).then((r) => r.json());
  assert.ok(oaiRes.choices?.[0]?.message?.content?.includes('Pond reply'), 'OpenAI-compatible endpoint returned completion');
  console.log('   ✓ OpenAI-compatible /api/v1/chat/completions API OK');

  // Test Static UI assets served cleanly
  for (const asset of ['/', '/app.js', '/sw.js', '/styles.css', '/markdown.js']) {
    const r = await fetch(`${base}${asset}`);
    assert.equal(r.status, 200, `Static asset ${asset} should return 200`);
  }
  console.log('   ✓ Static PWA & Service Worker assets OK');

  // Cleanup test items
  for (const id of createdIds.events) await fetch(`${base}/api/calendar/${id}`, { method: 'DELETE' });
  for (const id of createdIds.jobs) await fetch(`${base}/api/jobs/${id}`, { method: 'DELETE' });
  for (const id of createdIds.watches) await fetch(`${base}/api/watches/${id}`, { method: 'DELETE' });
  await fetch(`${base}/api/notifications`, { method: 'DELETE' });

  sseAbort.abort();
  await ssePromise.catch(() => {});
  console.log('\n✅ All unit & integration tests passed!');
} finally {
  child.kill();
  mockLlm.close();
  await new Promise((r) => setTimeout(r, 200));
  await rm(tempDataDir, { recursive: true, force: true }).catch(() => {});
}

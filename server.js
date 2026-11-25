// Pond — Advanced, zero-dependency, always-on autonomous personal AI agent server (Muse / Dots / OpenClaw style).
import http from 'node:http';
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { markTurnCancelled,
  PUBLIC,
  DATA,
  uid,
  ensureData,
  readJson,
  writeJson,
  updateJson,
  loadSessionsIndex,
  saveSessionsIndex,
  loadSession,
  saveSession,
  createSession,
  getActiveSession,
  appendToActiveSession,
  appendToSession,
  setSessionUsage,
  touchSessionMeta,
  renameSession,
  getChatSession,
  markSessionUsed,
  setSessionLlm,
  setPinnedSessions,
  migrateLegacyConversation,
  sessionFile,
  onActivity,
} from './lib/storage.js';
import {
  CONFIG,
  isKeyConfigured,
  isEmailConfigured,
  loadRuntimeSettings,
  saveRuntimeSettings,
  getPublicSettings,
} from './lib/config.js';
import {
  sseClients,
  broadcast,
  getSyncRev,
  listNotifications,
  getUnreadCount,
  pushNotification,
  markNotificationRead,
  markAllNotificationsRead,
  dismissNotification,
  clearNotifications,
} from './lib/notifications.js';
import { listApprovals, listPendingApprovals, decideApproval } from './lib/sentinel.js';
import { listMemoryDocs, readMemoryDoc, deleteMemoryDoc } from './lib/memory-docs.js';
import { runDream, undoLastDream, getDreamStatus } from './lib/dream.js';
import { searchAll } from './lib/search.js';
import { getEmailStore, ingestEmail, dismissEmail, dismissAllEmails } from './lib/email.js';
import { getPublicMs365Status, startMs365DeviceLogin, disconnectMs365, syncMs365Emails } from './lib/ms365.js';
import { listEvents, addEvent, updateEvent, deleteEvent, syncIcsCalendar } from './lib/calendar.js';
import { listWatches, createWatch, deleteWatch, checkSingleWatch } from './lib/watchers.js';
import {
  initMcpServers,
  addMcpServer,
  smartAddMcp,
  discoverAllMcp,
  removeMcpServer,
  connectMcpServer,
  listMcpConfigs,
  getAllMcpStatuses,
  shutdownMcpServers,
} from './lib/mcp.js';
import { listArtifacts, getArtifact, deleteArtifact, registerSettingsReloadHook } from './lib/tools.js';
import { playwrightEntry, EXTENSION_TOKEN_ENV } from './lib/browser-setup.js';
import { handleAppRoute } from './lib/apps.js';
import { synthesizeGoogle, listGoogleVoices, googleTtsConfigured } from './lib/tts.js';
import { webSearch, activeSearchBackend } from './lib/web.js';
import { detectPython, resolveRunFile } from './lib/python.js';
import { ensureLlmConfig, getPublicLlmConfig, saveLlmConfig, resolveProfile, testLlmProfile, setActiveLlm, defaultChatLlm, normEffort } from './lib/llm-config.js';
import { listSkills, getSkill, deleteSkill } from './lib/skills.js';
import { readHtml } from './lib/htmlcache.js';
import { serveShare, ensureShareDir, preparePage, isEmbed } from './lib/share.js';
import { startTurn, pushTurnEvent, endTurn, getRunningTurn, attachTurn, getRunningSessionIds, abortTurn, queueInjection } from './lib/turns.js';
import { onSubagentReports, formatReports, stopSubagent } from './lib/subagents.js';
import { loadPlugins, listPlugins, setPluginEnabled, savePluginSettings, reloadPlugins, handlePluginRoute, getPluginUiState, takeFooters, emitEvent } from './lib/plugins.js';
import { getVapid, saveSubscription, removeSubscription, listSubscriptions, pushToAllDevices } from './lib/push.js';
import { resolveSessionProfile, buildSystemPrompt, buildChatMessages, prepareSessionChatTurn, saveChatImages, compactSession, estimateSessionTokens, buildLiveContext, streamChat, runAgentTurn } from './lib/llm.js';
import { executeJob, getRunningJobIds, getRunningJobs } from './lib/scheduler.js';
import {
  proactiveTick,
  runEmailMonitor,
  handleWebhookEvent,
  startProactiveLoops,
  stopProactiveLoops,
} from './lib/proactive.js';

// Forward live activity entries to connected UI clients
onActivity((entry) => broadcast({ type: 'activity', entry }));
registerSettingsReloadHook(() => startProactiveLoops());

// Active streaming chat AbortControllers keyed by requestId (for explicit Stop button)
const activeChatControllers = new Map();

// A reply Pond starts by itself in a chat (no one typed): e.g. its sub-agents finished and their reports came back.
// Runs like a normal reply — any open view of the chat attaches to it — and is saved to the chat.
async function runBackgroundChatTurn(sessionId, text, extra = null) {
  const session = await loadSession(sessionId);
  if (!session) return;
  if (!session.llm) session.llm = await defaultChatLlm();
  const llm = await resolveSessionProfile(session);
  if (!llm.keyConfigured) return;
  const requestId = uid();
  const messages = await prepareSessionChatTurn(session, text, { profile: llm, extra });
  const userTs = session.messages[session.messages.length - 1]?.ts || null;
  await touchSessionMeta(session);
  broadcast({ type: 'message', sessionId, role: 'user', content: text, ...(extra || {}) });
  broadcast({ type: 'sessions' });
  const turn = startTurn({ sessionId, requestId, acceptsInjections: true });
  const ctrl = new AbortController();
  activeChatControllers.set(requestId, ctrl);
  let recorded = [];
  let measuredUsage = null;
  let reply = '';
  try {
    for await (const ev of streamChat(messages, { source: 'chat', signal: ctrl.signal, requestId, profile: llm, sessionId })) {
      if (ev.type === 'record') { recorded = ev.entries || []; measuredUsage = ev.measured || null; continue; }
      if (ev.type === 'token') reply += ev.text;
      pushTurnEvent(turn, ev);
    }
    await new Promise((r) => setImmediate(r));
    const pluginFooters = takeFooters(requestId);
    if (pluginFooters) {
      const lastAssistant = [...recorded].reverse().find((e) => e.role === 'assistant' && String(e.content || '').trim());
      if (lastAssistant) lastAssistant.pluginFooters = pluginFooters;
    }
    for (const entry of recorded) await appendToSession(sessionId, entry);
    if (measuredUsage) await setSessionUsage(sessionId, measuredUsage);
    if (reply.trim()) broadcast({ type: 'message', sessionId, role: 'assistant', content: reply.trim() });
  } catch (err) {
    pushTurnEvent(turn, { type: 'error', message: String(err?.message || err) });
  } finally {
    activeChatControllers.delete(requestId);
    if (ctrl.signal.aborted && userTs) { await markTurnCancelled(sessionId, userTs).catch(() => {}); broadcast({ type: 'sessions_updated', sessionId }); }
    endTurn(turn, ctrl.signal.aborted ? 'stopped' : 'done');
  }
}
onSubagentReports((parentId, reports, pending) => runBackgroundChatTurn(parentId, formatReports(reports, pending), {
  fromAgent: 'reports',
  reports: reports.map((r) => ({ role: r.role, status: r.status, chat: r.sessionId })),
  ...(pending.length ? { pending } : {}),
}));

// ---------- HTTP helpers ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limit = 2_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.ics': 'text/calendar; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.zip': 'application/zip',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  // The app lives at /app/ (its install scope), so pages Pond makes (/artifacts, /share, /apps) open in the browser.
  if (rel === '/') { const q = (req.url || '').indexOf('?'); res.writeHead(302, { Location: `/app/${q >= 0 ? req.url.slice(q) : ''}` }); return res.end(); }
  if (rel === '/app') { res.writeHead(301, { Location: '/app/' }); return res.end(); }
  if (rel === '/app/') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC, rel));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': rel.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache',
      // Sandboxed 3D viewports (opaque origin) import /vendor/* as ES modules -> need CORS.
      ...(rel.startsWith('/vendor/') ? { 'Access-Control-Allow-Origin': '*' } : {}),
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // CORS for API integrations / OpenAI-compatible clients
  if (pathname.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Webhook-Secret');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
  }

  try {
    // Health
    if (req.method === 'GET' && pathname === '/api/health') {
      const llm = await resolveProfile();
      return sendJson(res, 200, {
        ok: true,
        version: '0.2.0',
        model: llm.model,
        baseUrl: llm.baseUrl,
        llmProfile: llm.profileKey,
        contextLength: llm.contextLength,
        reasoningEffort: llm.reasoningEffort || 'default',
        keyConfigured: llm.keyConfigured,
        emailConfigured: isEmailConfigured(),
        assistantName: CONFIG.assistantName,
        aggressiveness: CONFIG.proactive.aggressiveness,
      });
    }

    // Live SSE Events (supports ?since=<seq> replay for missed notifications!)
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2500\n\n');
      res.write(`data: ${JSON.stringify({ type: 'hello', rev: getSyncRev(), assistantName: CONFIG.assistantName, aggressiveness: CONFIG.proactive.aggressiveness })}\n\n`);

      const since = Number(url.searchParams.get('since') || 0);
      if (since > 0) {
        const missed = await listNotifications({ since, limit: 20 });
        for (const n of missed.reverse()) {
          res.write(`data: ${JSON.stringify({ type: 'notification', notification: n, replay: true })}\n\n`);
        }
      }

      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // Each window shows its own chat and names it (?session=…); without one, the chat used last.
    const chatFor = async (id) => (await getChatSession(id)) || (await getActiveSession()).session;

    // Search box: chats, emails, notifications
    if (req.method === 'GET' && pathname === '/api/search') {
      return sendJson(res, 200, await searchAll(url.searchParams.get('q') || '', { limit: 20 }));
    }

    // Main UI State snapshot
    if (req.method === 'GET' && pathname === '/api/state') {
      const [llm, activeSessWrap, memory, notes, reminders, events, tasks, jobs, watches, emailStore, ms365, pendingApprovals, unreadNotifications, artifacts] =
        await Promise.all([
          resolveProfile(),
          chatFor(url.searchParams.get('session')).then((session) => ({ session })),
          readJson('memory.json', []),
          readJson('notes.json', []),
          readJson('reminders.json', []),
          listEvents({ upcomingOnly: true, days: 14 }),
          readJson('tasks.json', []),
          readJson('jobs.json', []),
          listWatches(),
          getEmailStore(),
          getPublicMs365Status(),
          listPendingApprovals(),
          getUnreadCount(),
          listArtifacts(),
        ]);

      const activeEmails = (emailStore.items || []).filter((e) => !e.dismissed);
      const importantEmails = activeEmails.filter((e) => e.importance?.important).slice(0, 15);
      // the model shown is the one THIS chat uses (its own pick, else the default)
      const chatLlm = activeSessWrap.session?.llm ? await resolveSessionProfile(activeSessWrap.session) : llm;
      const sessionTokens = estimateSessionTokens(activeSessWrap.session, { profileKey: chatLlm.profileKey });
      return sendJson(res, 200, {
        assistantName: CONFIG.assistantName,
        ui: CONFIG.ui,
        model: chatLlm.model,
        inputTypes: chatLlm.inputTypes,
        llmProfile: chatLlm.profileKey,
        chatLlm: { profile: chatLlm.profileKey, effort: chatLlm.reasoningEffort || '' },
        llmLabel: chatLlm.label,
        contextLength: chatLlm.contextLength,
        sessionTokens,
        reasoningEffort: chatLlm.reasoningEffort || 'default',
        keyConfigured: chatLlm.keyConfigured,
        emailConfigured: isEmailConfigured() || ms365.connected,
        ms365Connected: ms365.connected,
        ms365Account: ms365.accountEmail || '',
        userLocation: CONFIG.userLocation,
        proactive: { ...CONFIG.proactive },
        memory: Array.isArray(memory) ? memory : [],
        memoryDocs: await listMemoryDocs(),
        dream: await getDreamStatus(),
        notes: Array.isArray(notes) ? notes : [],
        reminders: (Array.isArray(reminders) ? reminders : []).filter((r) => !r.done),
        events,
        nextEvent: events.length ? null : (await listEvents({ upcomingOnly: true, days: 366 }))[0] || null,
        tasks: (Array.isArray(tasks) ? tasks : []).filter((t) => t.status !== 'done'),
        jobs: Array.isArray(jobs) ? jobs : [],
        runningJobs: getRunningJobIds(),
        runningJobsInfo: getRunningJobs(),
        watches,
        importantEmails,
        emailCount: activeEmails.length,
        importantUnreadCount: importantEmails.filter((e) => e.unread).length,
        pendingApprovals,
        unreadNotifications,
        artifactsCount: artifacts.length,
      });
    }

    // LLM Engine JSON config (data/llm.json)
    if (req.method === 'GET' && pathname === '/api/llm') {
      return sendJson(res, 200, await getPublicLlmConfig());
    }
    if (req.method === 'POST' && pathname === '/api/llm/active') {
      const body = await readJsonBody(req);
      try {
        const llm = await setActiveLlm({ profile: body.profile, effort: body.effort });
        broadcast({ type: 'settings_updated' }); // every device's chip follows
        return sendJson(res, 200, { ok: true, llm });
      } catch (err) { return sendJson(res, 400, { error: String(err.message || err) }); }
    }
    if (req.method === 'POST' && pathname === '/api/llm/test') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await testLlmProfile(body));
    }
    if ((req.method === 'PUT' || req.method === 'POST' || req.method === 'PATCH') && pathname === '/api/llm') {
      const body = await readJsonBody(req);
      const updated = await saveLlmConfig(body);
      broadcast({ type: 'settings_updated' });
      return sendJson(res, 200, { ok: true, llm: updated });
    }

    // Runtime Settings
    if (req.method === 'POST' && pathname === '/api/search/test') {
      const started = Date.now();
      try {
        const r = await webSearch('weather today', 3);
        return sendJson(res, 200, { ok: !r.fallbackFrom, backend: r.backend, fallbackFrom: r.fallbackFrom || null, note: r.note || null, count: r.results.length, ms: Date.now() - started, sample: r.results[0]?.title || null });
      } catch (err) { return sendJson(res, 200, { ok: false, backend: activeSearchBackend(), error: String(err.message || err) }); }
    }
    if (req.method === 'GET' && pathname === '/api/settings') {
      return sendJson(res, 200, getPublicSettings());
    }
    if ((req.method === 'PATCH' || req.method === 'POST') && pathname === '/api/settings') {
      const patch = await readJsonBody(req);
      let updated;
      try { updated = await saveRuntimeSettings(patch); } catch (err) { return sendJson(res, 400, { error: String(err.message || err) }); }
      startProactiveLoops();
      broadcast({ type: 'settings_updated', settings: updated });
      return sendJson(res, 200, { ok: true, settings: updated });
    }

    // Notifications Center API
    if (req.method === 'GET' && pathname === '/api/notifications') {
      const since = Number(url.searchParams.get('since') || 0);
      const unreadOnly = url.searchParams.get('unread') === '1';
      const items = await listNotifications({ since, unreadOnly });
      return sendJson(res, 200, { notifications: items, unreadCount: items.filter((n) => !n.read).length });
    }
    // ---------- Web Push ----------
    if (req.method === 'GET' && pathname === '/api/push/config') {
      const { publicKey } = await getVapid();
      const subs = await listSubscriptions();
      return sendJson(res, 200, {
        publicKey,
        devices: subs.map((s) => ({ label: s.label, origin: s.origin || null, host: new URL(s.endpoint).host, muted: s.muted, lastOkAt: s.lastOkAt || null, lastError: s.lastError || null })),
      });
    }
    if (req.method === 'POST' && pathname === '/api/push/subscribe') {
      const body = await readJsonBody(req);
      try {
        if (body.oldEndpoint && body.oldEndpoint !== body.subscription?.endpoint) await removeSubscription(body.oldEndpoint);
        const origin = req.headers.origin || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host || ''}`;
        await saveSubscription({ subscription: body.subscription, muted: body.muted, label: body.label, origin });
      } catch (err) {
        return sendJson(res, 400, { error: String(err?.message || err) });
      }
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/push/unsubscribe') {
      const body = await readJsonBody(req);
      if (body.endpoint) await removeSubscription(body.endpoint);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/push/test') {
      const results = await pushToAllDevices({
        id: uid(),
        title: `${CONFIG.assistantName} — Push test`,
        body: 'Push notifications work. You will get alerts even when Pond is closed.',
        urgency: 'high',
        category: 'system',
        tag: 'pond-push-test',
        ts: new Date().toISOString(),
      });
      return sendJson(res, 200, { ok: results.some((r) => r.ok), results });
    }

    if (req.method === 'POST' && pathname === '/api/notifications/test') {
      const body = await readJsonBody(req);
      const n = await pushNotification({
        title: body.title || `${CONFIG.assistantName} — Test Notification`,
        body: body.body || 'Browser notifications are live! Pond will alert you here for important emails, reminders, and autonomous updates.',
        urgency: body.urgency || 'high',
        category: body.category || 'system',
      });
      return sendJson(res, 200, { ok: true, notification: n });
    }
    if (req.method === 'POST' && pathname === '/api/notifications/read') {
      const body = await readJsonBody(req);
      if (body.all) await markAllNotificationsRead();
      else if (body.id) await markNotificationRead(body.id);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'DELETE' && pathname === '/api/notifications') {
      await clearNotifications();
      return sendJson(res, 200, { ok: true });
    }
    const notifDelMatch = pathname.match(/^\/api\/notifications\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'DELETE' && notifDelMatch) {
      await dismissNotification(notifDelMatch[1]);
      return sendJson(res, 200, { ok: true });
    }

    // Sentinel Approvals API
    if (req.method === 'GET' && pathname === '/api/approvals') {
      return sendJson(res, 200, { approvals: await listApprovals() });
    }
    const approvalMatch = pathname.match(/^\/api\/approvals\/([A-Za-z0-9_-]+)\/decide$/);
    if (req.method === 'POST' && approvalMatch) {
      const body = await readJsonBody(req);
      const decision = body.decision || (body.approved ? 'approve_once' : 'deny');
      return sendJson(res, 200, await decideApproval(approvalMatch[1], decision));
    }

    // Microsoft 365 / Outlook 365 Hosted Email (Graph API + OAuth2 Device Code Flow)
    if (req.method === 'GET' && pathname === '/api/ms365') {
      return sendJson(res, 200, await getPublicMs365Status());
    }
    if (req.method === 'POST' && pathname === '/api/ms365/login') {
      const body = await readJsonBody(req);
      const result = await startMs365DeviceLogin({
        clientId: body.clientId,
        tenantId: body.tenantId || 'organizations',
        allowSend: body.allowSend !== false,
        onConnected: () => runEmailMonitor({ sync: true }),
      });
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && pathname === '/api/ms365/sync') {
      const syncRes = await syncMs365Emails({ limit: 15 });
      const triageRes = await runEmailMonitor({ sync: false });
      return sendJson(res, 200, { ...syncRes, ...triageRes });
    }
    if (req.method === 'POST' && pathname === '/api/ms365/disconnect') {
      return sendJson(res, 200, { ok: true, status: await disconnectMs365() });
    }

    // Emails API (IMAP sync, triage list, detail, dismiss, inbound ingest / simulation)
    if (req.method === 'GET' && pathname === '/api/emails') {
      const store = await getEmailStore();
      const showAll = url.searchParams.get('all') === '1';
      const items = (store.items || []).filter((m) => showAll || !m.dismissed);
      return sendJson(res, 200, {
        configured: isEmailConfigured(),
        lastSyncAt: store.lastSyncAt,
        lastError: store.lastError,
        emails: items.map(({ body, ...rest }) => rest),
        drafts: store.drafts || [],
      });
    }
    // One email in full (the search box opens it)
    const emailOneMatch = pathname.match(/^\/api\/emails\/([^/]+)$/);
    if (req.method === 'GET' && emailOneMatch) {
      const id = decodeURIComponent(emailOneMatch[1]);
      const m = ((await getEmailStore()).items || []).find((x) => x.id === id);
      return m ? sendJson(res, 200, { email: m }) : sendJson(res, 404, { error: 'Email not found (it may have been pruned)' });
    }
    if (req.method === 'POST' && pathname === '/api/emails/dismiss-all') {
      await dismissAllEmails();
      broadcast({ type: 'emails_updated' });
      return sendJson(res, 200, { ok: true });
    }
    const emailDismissMatch = pathname.match(/^\/api\/emails\/([A-Za-z0-9_-]+)\/dismiss$/);
    if (req.method === 'POST' && emailDismissMatch) {
      await dismissEmail(emailDismissMatch[1]);
      broadcast({ type: 'emails_updated' });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/emails/sync') {
      const resSync = await runEmailMonitor({ sync: true });
      const store = await getEmailStore();
      return sendJson(res, 200, { ok: !store.lastError, ...resSync, lastError: store.lastError, lastSyncAt: store.lastSyncAt });
    }
    if (req.method === 'POST' && pathname === '/api/emails/ingest') {
      const body = await readJsonBody(req);
      const item = await ingestEmail({
        from: body.from || 'alerts@example.com',
        to: body.to || '',
        subject: body.subject || 'Incoming email',
        body: body.body || body.text || '',
        date: body.date || null,
        source: body.source || 'ingest',
      });
      // Immediately run AI triage + proactive alert!
      const triageRes = await runEmailMonitor({ sync: false });
      return sendJson(res, 200, { ok: true, email: item, triage: triageRes });
    }
    const emailReadMatch = pathname.match(/^\/api\/emails\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'GET' && emailReadMatch) {
      const store = await getEmailStore();
      const m = (store.items || []).find((x) => x.id === emailReadMatch[1]);
      if (!m) return sendJson(res, 404, { error: 'Email not found' });
      return sendJson(res, 200, { email: m });
    }

    // Calendar / Events API
    if (req.method === 'GET' && pathname === '/api/calendar') {
      return sendJson(res, 200, {
        events: await listEvents({ upcomingOnly: false }),
        linked: Boolean(String(CONFIG.calendar?.icsUrl || '').trim()),
      });
    }
    if (req.method === 'POST' && pathname === '/api/calendar') {
      const body = await readJsonBody(req);
      const ev = await addEvent({
        title: body.title,
        startAt: body.startAt || body.start_at,
        endAt: body.endAt || body.end_at,
        location: body.location,
        notes: body.notes,
        category: body.category,
        allDay: Boolean(body.allDay),
      });
      broadcast({ type: 'calendar_updated' });
      return sendJson(res, 200, { ok: true, event: ev });
    }
    if (req.method === 'POST' && pathname === '/api/calendar/sync') {
      const r = await syncIcsCalendar();
      broadcast({ type: 'calendar_updated' });
      return sendJson(res, 200, r);
    }
    const calDelMatch = pathname.match(/^\/api\/calendar\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'DELETE' && calDelMatch) {
      const r = await deleteEvent(calDelMatch[1], { exact: true });
      broadcast({ type: 'calendar_updated' });
      return sendJson(res, 200, r);
    }
    if (req.method === 'PATCH' && calDelMatch) {
      try {
        const ev = await updateEvent(calDelMatch[1], await readJsonBody(req));
        broadcast({ type: 'calendar_updated' });
        return sendJson(res, 200, { ok: true, event: ev });
      } catch (err) {
        return sendJson(res, 400, { error: String(err.message || err) });
      }
    }

    // Scheduled Jobs API
    if (req.method === 'GET' && pathname === '/api/jobs') {
      return sendJson(res, 200, { jobs: await readJson('jobs.json', []) });
    }
    if (req.method === 'POST' && pathname === '/api/jobs') {
      const body = await readJsonBody(req);
      if (!body.name || !body.prompt) return sendJson(res, 400, { error: 'name and prompt are required' });
      const job = {
        id: uid(),
        name: String(body.name).slice(0, 80),
        prompt: String(body.prompt),
        cron: body.cron ? String(body.cron).trim() : null,
        intervalMin: body.intervalMin ? Math.max(1, Number(body.intervalMin)) : null,
        notify: body.notify !== false,
        enabled: body.enabled !== false,
        lastRunAt: null,
        lastStatus: null,
        lastOutput: '',
        createdAt: new Date().toISOString(),
      };
      if (!job.cron && !job.intervalMin) return sendJson(res, 400, { error: 'cron or intervalMin is required' });
      await updateJson('jobs.json', [], (list) => [job, ...(Array.isArray(list) ? list : [])]);
      return sendJson(res, 200, { ok: true, job });
    }
    const jobRunMatch = pathname.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)\/run$/);
    if (req.method === 'POST' && jobRunMatch) {
      const jobs = await readJson('jobs.json', []);
      const job = jobs.find((j) => j.id === jobRunMatch[1]);
      if (!job) return sendJson(res, 404, { error: 'Job not found' });
      executeJob(job, { manual: true }).catch(() => {});
      return sendJson(res, 200, { ok: true, started: true });
    }
    const jobMatch = pathname.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'PATCH' && jobMatch) {
      const body = await readJsonBody(req);
      let found = null;
      await updateJson('jobs.json', [], (list) =>
        (Array.isArray(list) ? list : []).map((j) => {
          if (j.id !== jobMatch[1]) return j;
          found = { ...j, ...body, id: j.id };
          return found;
        })
      );
      if (!found) return sendJson(res, 404, { error: 'Job not found' });
      return sendJson(res, 200, { ok: true, job: found });
    }
    if (req.method === 'DELETE' && jobMatch) {
      await updateJson('jobs.json', [], (list) => (Array.isArray(list) ? list : []).filter((j) => j.id !== jobMatch[1]));
      return sendJson(res, 200, { ok: true });
    }

    // Watchers API
    if (req.method === 'GET' && pathname === '/api/watches') {
      return sendJson(res, 200, { watches: await listWatches() });
    }
    if (req.method === 'POST' && pathname === '/api/watches') {
      const body = await readJsonBody(req);
      const watch = await createWatch({
        name: body.name,
        type: body.type,
        target: body.target,
        intervalMin: body.intervalMin,
        criteria: body.criteria,
      });
      return sendJson(res, 200, { ok: true, watch });
    }
    const watchCheckMatch = pathname.match(/^\/api\/watches\/([A-Za-z0-9_-]+)\/check$/);
    if (req.method === 'POST' && watchCheckMatch) {
      const watches = await listWatches();
      const w = watches.find((x) => x.id === watchCheckMatch[1]);
      if (!w) return sendJson(res, 404, { error: 'Watch not found' });
      return sendJson(res, 200, await checkSingleWatch(w));
    }
    const watchMatch = pathname.match(/^\/api\/watches\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'DELETE' && watchMatch) {
      return sendJson(res, 200, await deleteWatch(watchMatch[1]));
    }

    // MCP Servers API (auto-discovery + single-input smart connect + management)
    if (req.method === 'GET' && pathname === '/api/mcp') {
      return sendJson(res, 200, { servers: await getAllMcpStatuses() });
    }
    if (req.method === 'GET' && pathname === '/api/mcp/discover') {
      const scanPorts = url.searchParams.get('ports') !== '0';
      return sendJson(res, 200, await discoverAllMcp({ scanPorts }));
    }
    if (req.method === 'POST' && pathname === '/api/mcp/quick') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, await smartAddMcp(body.input, { nameOverride: body.name || '', envVars: body.env || {} }));
    }
    if (req.method === 'POST' && pathname === '/api/mcp/import-all') {
      const { discovered } = await discoverAllMcp({ scanPorts: true });
      const added = [];
      for (const item of discovered) {
        if (item.alreadyAdded) continue;
        await addMcpServer(item);
        added.push(item.name);
      }
      return sendJson(res, 200, { ok: true, added, servers: await getAllMcpStatuses() });
    }
    if (req.method === 'POST' && pathname === '/api/mcp') {
      const body = await readJsonBody(req);
      const servers = await addMcpServer(body);
      return sendJson(res, 200, { ok: true, servers });
    }
    // Which browser the AI drives: Pond's own window, or your Chrome through the Playwright MCP Bridge extension.
    if (req.method === 'POST' && pathname === '/api/browser/mode') {
      const body = await readJsonBody(req);
      const mode = body.mode === 'chrome' ? 'chrome' : 'own';
      const prev = (await listMcpConfigs()).find((c) => c.name === 'browser');
      const token = body.token !== undefined ? String(body.token || '') : (prev?.env?.[EXTENSION_TOKEN_ENV] || '');
      const servers = await addMcpServer(playwrightEntry({ enabled: prev ? prev.enabled !== false : true, mode, token }));
      return sendJson(res, 200, { ok: true, mode, servers });
    }
    const mcpReconnectMatch = pathname.match(/^\/api\/mcp\/([A-Za-z0-9_-]+)\/reconnect$/);
    if (req.method === 'POST' && mcpReconnectMatch) {
      const configs = await listMcpConfigs();
      const cfg = configs.find((c) => c.name === mcpReconnectMatch[1]);
      if (!cfg) return sendJson(res, 404, { error: 'MCP server not found' });
      const status = await connectMcpServer(cfg);
      return sendJson(res, 200, { ok: true, server: status });
    }
    const mcpMatch = pathname.match(/^\/api\/mcp\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'DELETE' && mcpMatch) {
      return sendJson(res, 200, { ok: true, servers: await removeMcpServer(mcpMatch[1]) });
    }

    // Python status & generated run files (/files/:runId/:filename)
    if (req.method === 'GET' && pathname === '/api/python/status') {
      const py = await detectPython({ force: url.searchParams.get('refresh') === '1' });
      return sendJson(res, 200, {
        enabled: CONFIG.python.enabled,
        available: Boolean(py),
        version: py?.version || null,
        bin: py?.bin || null,
      });
    }
    const pyFileMatch = pathname.match(/^\/files\/([A-Za-z0-9_-]+)\/([^/]+)$/);
    if (req.method === 'GET' && pyFileMatch) {
      const info = resolveRunFile(pyFileMatch[1], pyFileMatch[2]);
      if (!info) { res.writeHead(404); return res.end('File not found'); }
      try {
        const data = await readFile(info.full);
        res.writeHead(200, {
          'Content-Type': MIME[info.ext] || 'application/octet-stream',
          'Cache-Control': 'private, max-age=3600',
          ...(info.ext === '.html' ? { 'Content-Security-Policy': 'sandbox allow-scripts' } : {}),
        });
        return res.end(data);
      } catch {
        res.writeHead(404);
        return res.end('File not found');
      }
    }

    // Appearance: user-uploaded avatar image (replaces the mascot)
    const AVATAR_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' };
    const avatarDir = path.join(DATA, 'appearance');
    if (req.method === 'POST' && pathname === '/api/appearance/avatar') {
      const body = await readJsonBody(req, 4_000_000);
      const m = String(body.dataUrl || '').match(/^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));base64,([A-Za-z0-9+/=]+)$/);
      if (!m) return sendJson(res, 400, { error: 'Upload a PNG, JPG, WebP, GIF or SVG image.' });
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length || buf.length > 2 * 1024 * 1024) return sendJson(res, 400, { error: 'Image must be under 2 MB.' });
      const ext = AVATAR_TYPES[m[1]];
      await mkdir(avatarDir, { recursive: true });
      for (const e of Object.values(AVATAR_TYPES)) if (e !== ext) await rm(path.join(avatarDir, `avatar.${e}`), { force: true }).catch(() => {});
      await writeFile(path.join(avatarDir, `avatar.${ext}`), buf);
      const settings = await saveRuntimeSettings({ ui: { avatarMode: 'image', avatarExt: ext, avatarVersion: Date.now(), ...(body.circle !== undefined ? { avatarCircle: Boolean(body.circle) } : {}) } });
      broadcast({ type: 'settings_updated' });
      return sendJson(res, 200, { ok: true, ui: settings.ui });
    }
    if (req.method === 'DELETE' && pathname === '/api/appearance/avatar') {
      for (const e of Object.values(AVATAR_TYPES)) await rm(path.join(avatarDir, `avatar.${e}`), { force: true }).catch(() => {});
      const settings = await saveRuntimeSettings({ ui: { avatarMode: 'mascot', avatarExt: '' } });
      broadcast({ type: 'settings_updated' });
      return sendJson(res, 200, { ok: true, ui: settings.ui });
    }
    if (req.method === 'GET' && pathname === '/appearance/avatar') {
      const ext = CONFIG.ui.avatarExt;
      const mime = Object.keys(AVATAR_TYPES).find((k) => AVATAR_TYPES[k] === ext);
      if (!mime) { res.writeHead(404); return res.end('No custom avatar'); }
      try {
        const data = await readFile(path.join(avatarDir, `avatar.${ext}`));
        // Sandbox + nosniff: an uploaded SVG opened directly can't run scripts against Pond's origin.
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
        return res.end(data);
      } catch { res.writeHead(404); return res.end('No custom avatar'); }
    }

    // Plugins API
    if (req.method === 'GET' && pathname === '/api/plugins') {
      return sendJson(res, 200, { plugins: listPlugins(), ui: getPluginUiState() });
    }
    if (req.method === 'GET' && pathname === '/api/plugins/ui') {
      return sendJson(res, 200, getPluginUiState());
    }
    if (req.method === 'POST' && pathname === '/api/plugins/reload') {
      return sendJson(res, 200, { plugins: await reloadPlugins() });
    }
    const pluginApiMatch = pathname.match(/^\/api\/plugins\/([a-z0-9_-]+)\/(enable|settings)$/);
    if (req.method === 'POST' && pluginApiMatch) {
      const body = await readJsonBody(req);
      try {
        const p = pluginApiMatch[2] === 'enable'
          ? await setPluginEnabled(pluginApiMatch[1], Boolean(body.enabled))
          : await savePluginSettings(pluginApiMatch[1], body.values || {});
        return sendJson(res, 200, { ok: true, plugin: p });
      } catch (err) {
        return sendJson(res, 404, { error: String(err?.message || err) });
      }
    }
    // Routes registered by plugins: /plugins/<id>/...
    if (pathname.startsWith('/plugins/')) {
      const handled = await handlePluginRoute(req, res, url, async (r) => {
        const raw = await readBody(r);
        try { return JSON.parse(raw); } catch { return raw; }
      });
      if (handled) return;
      return sendJson(res, 404, { error: 'No such plugin route (is the plugin enabled?)' });
    }

    // Skills API
    if (req.method === 'GET' && pathname === '/api/skills') {
      return sendJson(res, 200, { skills: await listSkills() });
    }
    const skillMatch = pathname.match(/^\/api\/skills\/([a-z0-9-]+)$/);
    if (skillMatch && req.method === 'GET') {
      const sk = await getSkill(skillMatch[1]);
      return sk ? sendJson(res, 200, sk) : sendJson(res, 404, { error: 'Skill not found' });
    }
    if (skillMatch && req.method === 'DELETE') {
      const r = await deleteSkill(skillMatch[1]); // user-initiated from the UI, no Sentinel prompt
      if (r.ok) broadcast({ type: 'skills_updated' });
      return sendJson(res, r.ok ? 200 : 404, r);
    }

    // Artifacts API & Live Viewer
    if (req.method === 'GET' && pathname === '/api/artifacts') {
      return sendJson(res, 200, { artifacts: await listArtifacts() });
    }
    const artifactApiMatch = pathname.match(/^\/api\/artifacts\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'DELETE' && artifactApiMatch) {
      return sendJson(res, 200, await deleteArtifact(artifactApiMatch[1]));
    }
    // Pond Share: files the AI made, reachable from every device
    if (req.method === 'GET' && (pathname === '/share' || pathname.startsWith('/share/'))) {
      if (pathname === '/share') { res.writeHead(301, { Location: '/share/' }); return res.end(); }
      return serveShare(req, res, pathname.slice('/share/'.length), MIME);
    }
    // Auto-saved chat HTML, full page (sandboxed: opaque origin, cannot call Pond's API)
    const htmlViewMatch = pathname.match(/^\/html\/(h[0-9a-f]{8})$/);
    if (req.method === 'GET' && htmlViewMatch) {
      const h = await readHtml(htmlViewMatch[1]);
      if (!h) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found (it may have been pruned from the temp cache)'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': 'sandbox allow-scripts allow-forms', 'Cache-Control': 'no-store' });
      if (h.kind === 'threejs') {
        // A 3D scene: the same stage the chat uses (public/markdown.js builds it), as a page of its own.
        const code = JSON.stringify(h.content).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
        return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${String(h.title || '3D scene').replace(/[<&]/g, '')}</title></head><body><script src="/markdown.js"></script><script>document.open();document.write(window.pondThreeSrcdoc(${code}));document.close();</script></body></html>`);
      }
      return res.end(preparePage(h.content, { embed: isEmbed(req) }));
    }
    // A Pond page as an app of its own (installable from the browser): /apps/<key>/
    if (req.method === 'GET' && pathname.startsWith('/apps/') && await handleAppRoute(req, res, pathname)) return;
    const artifactViewMatch = pathname.match(/^\/artifacts\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'GET' && artifactViewMatch) {
      const a = await getArtifact(artifactViewMatch[1]);
      if (!a) { res.writeHead(404); return res.end('Artifact not found'); }
      const ct =
        a.type === 'html' ? 'text/html; charset=utf-8'
          : a.type === 'svg' ? 'image/svg+xml'
          : 'text/plain; charset=utf-8';
      res.writeHead(200, { 'Content-Type': ct, 'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-popups allow-downloads', 'Cache-Control': 'no-cache' });
      return res.end(a.type === 'html' ? preparePage(a.content, { embed: isEmbed(req) }) : a.content);
    }

    // Activity Log
    if (req.method === 'GET' && pathname === '/api/activity') {
      const list = await readJson('activity.json', []);
      return sendJson(res, 200, { activity: Array.isArray(list) ? list.slice(0, 100) : [] });
    }

    // Inbound Webhooks (external apps -> Pond triage -> browser notification!)
    const webhookMatch = pathname.match(/^\/api\/webhooks\/([A-Za-z0-9_.-]+)$/);
    if (req.method === 'POST' && webhookMatch) {
      if (CONFIG.webhookSecret) {
        const provided = req.headers['x-webhook-secret'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (provided !== CONFIG.webhookSecret) return sendJson(res, 401, { error: 'Invalid webhook secret' });
      }
      const payload = await readJsonBody(req);
      const resHook = await handleWebhookEvent(webhookMatch[1], payload);
      return sendJson(res, 200, { ok: true, ...resHook });
    }

    // OpenAI-Compatible Agent API (expose Pond itself as an advanced agent server!)
    if (req.method === 'POST' && pathname === '/api/v1/chat/completions') {
      if (!isKeyConfigured()) return sendJson(res, 400, { error: { message: 'Backend API key not configured' } });
      const body = await readJsonBody(req);
      const userMsgs = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...userMsgs].reverse().find((m) => m.role === 'user')?.content || '';
      const sys = await buildSystemPrompt();

      if (body.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        const id = `chatcmpl-${uid()}`;
        const msgs = await buildChatMessages(userMsgs.filter((m) => m.role !== 'system'));
        for await (const ev of streamChat(msgs, { source: 'api' })) {
          if (ev.type === 'token') {
            res.write(
              `data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: `pond/${CONFIG.model}`,
                choices: [{ index: 0, delta: { content: ev.text }, finish_reason: null }],
              })}\n\n`
            );
          }
        }
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: `pond/${CONFIG.model}`, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      } else {
        const liveCtx = await buildLiveContext();
        const result = await runAgentTurn({
          systemPrompt: sys,
          userPrompt: `${liveCtx}\n\n${lastUser}`,
          maxRounds: 80,
          source: 'api',
        });
        return sendJson(res, 200, {
          id: `chatcmpl-${uid()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: `pond/${CONFIG.model}`,
          choices: [{ index: 0, message: { role: 'assistant', content: result.content }, finish_reason: 'stop' }],
        });
      }
    }

    // Lightweight sync probe: clients poll this and only fetch the full conversation / chat list
    // when a key changed (cheap on mobile data).
    if (req.method === 'GET' && pathname === '/api/sync') {
      const session = await chatFor(url.searchParams.get('session'));
      const idx = await loadSessionsIndex();
      return sendJson(res, 200, {
        rev: getSyncRev(),
        conversationKey: `${session.id || ''}|${session.updatedAt || ''}|${(session.messages || []).length}`,
        sessionsKey: `${getRunningSessionIds().join(',')}|${(idx.pinned || []).join(',')}|${(idx.sessions || []).map((x) => `${x.id}:${x.updatedAt || ''}:${x.title || ''}`).join(',')}`,
      });
    }

    // Sessions & Conversation
    // Attach to a running turn: replays progress so far, then streams live until it finishes.
    const turnStreamMatch = pathname.match(/^\/api\/turns\/([A-Za-z0-9_-]+)\/stream$/);
    if (req.method === 'GET' && turnStreamMatch) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      const write = (obj) => { if (!res.writableEnded && !res.destroyed) { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* gone */ } } };
      let ka = null;
      const att = attachTurn(turnStreamMatch[1], (ev) => { write(ev); if (ev.type === 'done') { clearInterval(ka); res.end(); } });
      if (!att || att.done) { write({ type: 'done', status: 'finished' }); return res.end(); }
      for (const ev of att.replay) write(ev);
      ka = setInterval(() => { if (!res.writableEnded) { try { res.write(': ka\n\n'); } catch { /* ignore */ } } }, 15_000);
      req.on('close', () => { clearInterval(ka); att.unsubscribe(); });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/conversation') {
      const wanted = url.searchParams.get('session');
      const own = wanted ? await getChatSession(wanted) : null;
      if (wanted && !own) return sendJson(res, 404, { error: 'Chat not found (deleted?)', missing: wanted });
      const session = own || (await getActiveSession()).session;
      return sendJson(res, 200, {
        activeTurn: getRunningTurn(session.id),
        sessionId: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        messageCount: (session.messages || []).length,
        messages: session.messages,
        ...(session.subagent ? { subagent: session.subagent } : {}),
      });
    }
    if (req.method === 'GET' && pathname === '/api/sessions') {
      return sendJson(res, 200, { ...(await loadSessionsIndex()), running: getRunningSessionIds() });
    }
    if (req.method === 'POST' && pathname === '/api/sessions') {
      const body = await readJsonBody(req).catch(() => ({}));
      let s = await createSession(String(body?.title || '').trim().slice(0, 80) || 'New chat');
      // "Continue in a new chat" from a proactive message: the new chat opens with that message, and the model
      // gets it as context on its first user turn (a chat may not start with an assistant message in the API).
      const carry = body?.carry && typeof body.carry.content === 'string' ? body.carry : null;
      if (carry) {
        const text = carry.content.slice(0, 8000);
        s = await loadSession(s.id);
        s.carried = `<carried_over from="${String(carry.tag || 'check-in').replace(/[<>"]/g, '').slice(0, 40)}"${carry.at ? ` at="${String(carry.at).slice(0, 30)}"` : ''}>\nYou (Pond) sent the user this message earlier; they opened this chat to talk about it:\n${text}\n</carried_over>`;
        s.messages.push({ role: 'assistant', content: text, proactive: true, tag: String(carry.tag || '').slice(0, 60), ts: new Date().toISOString() });
        await saveSession(s);
      }
      broadcast({ type: 'sessions' }); // the new chat opens in the window that made it, nowhere else
      return sendJson(res, 200, { session: { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt } });
    }
    if (req.method === 'POST' && pathname === '/api/sessions/compact') {
      const body = await readJsonBody(req).catch(() => ({}));
      const session = await chatFor(body?.sessionId);
      if (getRunningTurn(session.id)) return sendJson(res, 409, { error: 'Pond is replying in this chat — compact when it is done.' });
      const result = await compactSession(session, { keepRecent: 10, reason: 'manual' });
      return sendJson(res, 200, { ok: true, ...result });
    }
    if (req.method === 'POST' && pathname === '/api/sessions/activate') {
      const body = await readJsonBody(req);
      const idx = await loadSessionsIndex();
      const target = idx.sessions.find((x) => x.id === body.id);
      if (!target) return sendJson(res, 404, { error: 'Session not found' });
      await markSessionUsed(target.id); // remembered as "used last" only — other windows stay where they are
      return sendJson(res, 200, { ok: true, activeId: target.id });
    }
    if (req.method === 'POST' && pathname === '/api/sessions/pins') {
      const body = await readJsonBody(req).catch(() => ({}));
      if (!Array.isArray(body?.ids)) return sendJson(res, 400, { error: 'ids must be an array' });
      const pinned = await setPinnedSessions(body.ids.slice(0, 200));
      broadcast({ type: 'sessions' });
      return sendJson(res, 200, { ok: true, pinned });
    }
    // A chat's model / reasoning effort. Also becomes the default for new chats.
    const sessLlmMatch = pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)\/llm$/);
    if (req.method === 'POST' && sessLlmMatch) {
      const body = await readJsonBody(req).catch(() => ({}));
      const session = await getChatSession(sessLlmMatch[1]);
      if (!session) return sendJson(res, 404, { error: 'Chat not found' });
      try {
        const next = { ...(session.llm || (await defaultChatLlm())) };
        if (body.profile !== undefined) {
          const cfg = await getPublicLlmConfig();
          if (!cfg.profiles?.[body.profile]) throw new Error(`No model profile "${body.profile}"`);
          next.profile = body.profile;
          if (body.effort === undefined) next.effort = String(cfg.profiles[body.profile].reasoningEffort || '');
        }
        if (body.effort !== undefined) next.effort = normEffort(body.effort);
        await setSessionLlm(session.id, next);
        await setActiveLlm({ profile: next.profile, effort: next.effort }); // new chats start with the last pick
        broadcast({ type: 'chat_llm', sessionId: session.id });
        return sendJson(res, 200, { ok: true, llm: next });
      } catch (err) { return sendJson(res, 400, { error: String(err.message || err) }); }
    }
    const sessionMatch = pathname.match(/^\/api\/sessions\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'PATCH' && sessionMatch) {
      const body = await readJsonBody(req).catch(() => ({}));
      const title = String(body?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!title) return sendJson(res, 400, { error: 'title is required' });
      const s = await renameSession(sessionMatch[1], title);
      if (!s) return sendJson(res, 404, { error: 'Session not found' });
      broadcast({ type: 'sessions' });
      return sendJson(res, 200, { ok: true, title });
    }
    if (req.method === 'DELETE' && sessionMatch) {
      const id = sessionMatch[1];
      const idx = await loadSessionsIndex();
      if (!idx.sessions.find((x) => x.id === id)) return sendJson(res, 404, { error: 'Session not found' });
      stopSubagent(id); // a sub-agent's chat: stop it too, so its main chat isn't left waiting
      idx.sessions = idx.sessions.filter((x) => x.id !== id);
      if (Array.isArray(idx.pinned)) idx.pinned = idx.pinned.filter((x) => x !== id);
      try { await rm(sessionFile(id), { force: true }); } catch { /* ignore */ }
      if (idx.activeId === id) {
        if (idx.sessions.length) {
          idx.activeId = idx.sessions[0].id;
        } else {
          const now = new Date().toISOString();
          const s = { id: uid(), title: 'New chat', createdAt: now, updatedAt: now, messages: [] };
          await saveSession(s);
          idx.sessions = [{ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt }];
          idx.activeId = s.id;
        }
      }
      await saveSessionsIndex(idx);
      broadcast({ type: 'sessions', deleted: id }); // windows showing it move to another chat themselves
      return sendJson(res, 200, { ok: true, activeId: idx.activeId });
    }

    // Proactive manual trigger
    if (req.method === 'POST' && pathname === '/api/proactive/check') {
      proactiveTick({ force: true }).catch(() => {});
      return sendJson(res, 200, { ok: true });
    }

    // Reminders / Tasks / Memory quick actions
    if (req.method === 'POST' && pathname === '/api/reminders/complete') {
      const body = await readJsonBody(req);
      await updateJson('reminders.json', [], (reminders) =>
        (Array.isArray(reminders) ? reminders : []).map((r) => (r.id === body.id ? { ...r, done: true } : r))
      );
      return sendJson(res, 200, { ok: true });
    }
    const taskCompleteMatch = pathname.match(/^\/api\/tasks\/([A-Za-z0-9_-]+)\/complete$/);
    if (req.method === 'POST' && taskCompleteMatch) {
      await updateJson('tasks.json', [], (tasks) =>
        (Array.isArray(tasks) ? tasks : []).map((t) =>
          t.id === taskCompleteMatch[1] ? { ...t, status: 'done', completedAt: new Date().toISOString() } : t
        )
      );
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && pathname === '/api/memory') {
      const [core, docs, dream] = await Promise.all([readJson('memory.json', []), listMemoryDocs(), getDreamStatus()]);
      return sendJson(res, 200, { core, docs, dream });
    }
    const memDocMatch = pathname.match(/^\/api\/memory\/docs\/([^/]+)$/);
    if (memDocMatch && req.method === 'GET') {
      const doc = await readMemoryDoc(decodeURIComponent(memDocMatch[1]));
      return doc ? sendJson(res, 200, doc) : sendJson(res, 404, { error: 'No such memory doc' });
    }
    if (memDocMatch && req.method === 'DELETE') {
      const ok = await deleteMemoryDoc(decodeURIComponent(memDocMatch[1]));
      broadcast({ type: 'memory_updated' });
      return sendJson(res, ok ? 200 : 404, { ok });
    }
    if (req.method === 'POST' && pathname === '/api/memory/dream') {
      runDream({ reason: 'manual' }).catch(() => {});
      return sendJson(res, 202, { ok: true, started: true });
    }
    if (req.method === 'POST' && pathname === '/api/memory/dream/undo') {
      try { return sendJson(res, 200, await undoLastDream()); } catch (err) { return sendJson(res, 409, { error: String(err.message || err) }); }
    }
    if (req.method === 'DELETE' && pathname === '/api/memory') {
      await writeJson('memory.json', []);
      return sendJson(res, 200, { ok: true });
    }
    const memDelMatch = pathname.match(/^\/api\/memory\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'DELETE' && memDelMatch) {
      await updateJson('memory.json', [], (mem) => (Array.isArray(mem) ? mem : []).filter((m) => m.id !== memDelMatch[1]));
      return sendJson(res, 200, { ok: true });
    }

    // Reading aloud with Google Cloud Text-to-Speech (the key stays here; the app gets MP3).
    if (req.method === 'GET' && pathname === '/api/tts/status') return sendJson(res, 200, { google: googleTtsConfigured() });
    if (req.method === 'GET' && pathname === '/api/tts/voices') {
      try { return sendJson(res, 200, await listGoogleVoices()); } catch (err) { return sendJson(res, 502, { error: String(err?.message || err) }); }
    }
    if (req.method === 'POST' && pathname === '/api/tts') {
      const body = await readJsonBody(req);
      try {
        const audio = await synthesizeGoogle(body.text, { lang: body.lang });
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length, 'Cache-Control': 'no-store' });
        return res.end(audio);
      } catch (err) { return sendJson(res, 502, { error: String(err?.message || err) }); }
    }

    // Add a message to a reply that is still running: it reads it at its next step instead of being stopped.
    if (req.method === 'POST' && pathname === '/api/chat/inject') {
      const body = await readJsonBody(req);
      const text = String(body.text || '').trim().slice(0, 20000);
      if (!text) return sendJson(res, 400, { error: 'Nothing to send' });
      const requestId = typeof body.sessionId === 'string' ? queueInjection(body.sessionId, text) : null;
      if (!requestId) return sendJson(res, 409, { error: 'No reply is running in this chat', notRunning: true });
      return sendJson(res, 200, { ok: true, requestId });
    }

    // Explicit Stop endpoint so clicking Stop aborts immediately, while passive iPhone lock/disconnect lets Pond finish & save!
    if (req.method === 'POST' && pathname === '/api/chat/stop') {
      const body = await readJsonBody(req);
      const id = String(body.requestId || '');
      if (id && activeChatControllers.has(id)) {
        activeChatControllers.get(id).abort();
        activeChatControllers.delete(id);
        return sendJson(res, 200, { ok: true, stopped: true });
      }
      if (id && abortTurn(id)) return sendJson(res, 200, { ok: true, stopped: true }); // a sub-agent's run
      return sendJson(res, 200, { ok: true, stopped: false });
    }

    // Main Streaming Chat Endpoint
    if (req.method === 'POST' && pathname === '/api/chat') {
      const body = await readJsonBody(req, 40_000_000); // allows image attachments
      const clientId = typeof body.clientId === 'string' ? body.clientId : null;
      const requestId = typeof body.requestId === 'string' ? body.requestId : uid();
      const history = Array.isArray(body.messages) ? body.messages : [];
      const lastUser = [...history].reverse().find((m) => m && m.role === 'user' && typeof m.content === 'string');

      // Target the chat the user is looking at (not whatever is "active" server-wide), one running turn per chat.
      let targetSession = null;
      if (lastUser) {
        if (typeof body.sessionId === 'string' && /^[A-Za-z0-9_-]+$/.test(body.sessionId)) targetSession = await loadSession(body.sessionId);
        if (!targetSession) targetSession = (await getActiveSession()).session;
        const running = getRunningTurn(targetSession.id);
        if (running) return sendJson(res, 409, { error: 'Pond is still replying in this chat — wait for it or press stop.', activeTurn: running });
        if (targetSession.subagent) return sendJson(res, 400, { error: "This is a sub-agent's chat: it works on its own. Reply in the chat that started it." });
        // A chat keeps its own model from its first message on; later picks in other chats don't move it.
        if (!targetSession.llm) targetSession.llm = await defaultChatLlm();
      }
      const llm = targetSession ? await resolveSessionProfile(targetSession) : await resolveProfile();
      if (!llm.keyConfigured) {
        return sendJson(res, 400, {
          error: 'No API key configured. Set OPENAI_API_KEY in .env or configure a profile in data/llm.json (Agent Hub → LLM Engine).',
        });
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const send = (obj) => {
        if (!res.writableEnded && !res.destroyed) {
          try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* mobile client disconnected; keep finishing! */ }
        }
      };

      let sessionId = null;
      let userTs = null; // identifies this turn's message, so Stop can retire it
      let messages;
      if (lastUser) {
        const session = targetSession;
        const images = await saveChatImages(body.images);
        messages = await prepareSessionChatTurn(session, lastUser.content, { images, profile: llm });
        sessionId = session.id;
        await markSessionUsed(session.id); // check-ins go to the chat you're using
        userTs = session.messages[session.messages.length - 1]?.ts || null;
        // Keep session index metadata fresh
        await touchSessionMeta(session);
        broadcast({ type: 'message', sessionId, role: 'user', content: lastUser.content, images: images.map((i) => i.url), clientId });
        emitEvent('chat_message', { sessionId, role: 'user', content: lastUser.content, requestId, source: 'chat' });
        broadcast({ type: 'sessions' });
      } else {
        messages = await buildChatMessages(history);
      }
      let assistantText = '';
      let recordedEntries = [];
      let measuredUsage = null;
      const turn = sessionId ? startTurn({ sessionId, requestId, clientId, acceptsInjections: true }) : null; // lives on even if this tab goes away
      // Keepalive bytes so the client can tell a slow tool call from a dead connection.
      const streamKeepalive = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) { try { res.write(': ka\n\n'); } catch { /* ignore */ } }
      }, 15_000);
      const chatAbort = new AbortController();
      activeChatControllers.set(requestId, chatAbort);
      try {
        for await (const event of streamChat(messages, { source: 'chat', signal: chatAbort.signal, requestId, profile: llm, sessionId })) {
          if (event.type === 'record') {
            recordedEntries = event.entries || [];
            measuredUsage = event.measured || null;
            continue;
          }
          if (event.type === 'token') assistantText += event.text;
          pushTurnEvent(turn, event);
          send(event);
        }
        send({ type: 'done' });
        // Plugin message footers (e.g. tok/s) produced during this turn are saved with the reply.
        await new Promise((r) => setImmediate(r));
        const pluginFooters = takeFooters(requestId);
        if (pluginFooters) {
          const lastAssistant = [...recordedEntries].reverse().find((e) => e.role === 'assistant' && String(e.content || '').trim());
          if (lastAssistant) lastAssistant.pluginFooters = pluginFooters;
        }
        if (assistantText.trim()) emitEvent('chat_message', { sessionId, role: 'assistant', content: assistantText.trim(), requestId, source: 'chat' });
        if (recordedEntries.length) {
          let lastSession = null;
          for (const entry of recordedEntries) {
            lastSession = await appendToSession(sessionId, entry);
          }
          sessionId = lastSession?.id || sessionId;
          if (measuredUsage && sessionId) await setSessionUsage(sessionId, measuredUsage);
          if (assistantText.trim()) {
            broadcast({ type: 'message', sessionId, role: 'assistant', content: assistantText.trim(), clientId });
          }
        } else if (assistantText.trim()) {
          const text = assistantText.trim();
          const s = await appendToSession(sessionId, { role: 'assistant', content: text, ...(pluginFooters ? { pluginFooters } : {}) });
          sessionId = s?.id || sessionId;
          broadcast({ type: 'message', sessionId, role: 'assistant', content: text, clientId });
        }
      } catch (err) {
        pushTurnEvent(turn, { type: 'error', message: String(err?.message || err) });
        send({ type: 'error', message: String(err?.message || err) });
      } finally {
        clearInterval(streamKeepalive);
        activeChatControllers.delete(requestId);
        if (chatAbort.signal.aborted && sessionId && userTs) {
          // Stopped: keep it on screen, but never send it to the model again (else the next message re-runs it).
          await markTurnCancelled(sessionId, userTs).catch(() => {});
          broadcast({ type: 'sessions_updated', sessionId });
        }
        endTurn(turn, chatAbort.signal.aborted ? 'stopped' : 'done'); // after the reply is saved, so viewers reload the final chat
      }
      if (!res.writableEnded) res.end();
      return;
    }

    if (req.method === 'GET') return serveStatic(req, res, pathname);
    res.writeHead(405);
    res.end('Method not allowed');
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: String(err?.message || err) });
    else res.end();
  }
});

// ---------- Boot ----------
await ensureData();
await loadRuntimeSettings();
await ensureLlmConfig();
await migrateLegacyConversation();
// A misbehaving plugin (or library) must never crash the server with an unhandled rejection.
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err?.stack || err));
await loadPlugins().catch((err) => console.error('[plugins] load failed:', err?.message || err));
await initMcpServers();

const bootLlm = await resolveProfile();
server.listen(CONFIG.port, () => {
  console.log(`\n  ● ${CONFIG.assistantName} (Pond v0.2 — Advanced Autonomous Agent Server)`);
  console.log(`    UI:        http://localhost:${CONFIG.port}`);
  console.log(`    OpenAI API:http://localhost:${CONFIG.port}/api/v1/chat/completions`);
  console.log(`    Model:     ${bootLlm.model} @ ${bootLlm.baseUrl} (profile: ${bootLlm.profileKey}, ctx: ${Math.round(bootLlm.contextLength / 1000)}k, effort: ${bootLlm.reasoningEffort || 'default'})`);
  console.log(`    LLM JSON:  data/llm.json`);
  console.log(`    Key:       ${bootLlm.keyConfigured ? 'configured' : 'NOT SET — copy .env.example to .env or edit data/llm.json'}`);
  console.log(`    Proactive: ${CONFIG.proactive.enabled ? `${CONFIG.proactive.aggressiveness.toUpperCase()} (every ${CONFIG.proactive.intervalMin}m, min gap ${CONFIG.proactive.minGapMin}m)` : 'off'}`);
  console.log(`    Email:     ${isEmailConfigured() ? `IMAP ${CONFIG.email.imapUser}@${CONFIG.email.imapHost} (every ${CONFIG.email.pollIntervalMin}m)` : 'not configured (set in UI Settings or .env; webhook ingest ready)'}`);
  console.log(`    Sentinel:  ${CONFIG.sentinel.enabled ? 'active (out-of-band approval gate)' : 'off'}`);
  console.log(`    File root: ${CONFIG.fsRoot}`);
  console.log(`    Pond Share: ${CONFIG.shareDir}  →  /share/\n`);
  ensureShareDir();
});

startProactiveLoops();

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return process.exit(0);
  shuttingDown = true;
  stopProactiveLoops();
  shutdownMcpServers();
  for (const client of sseClients) {
    try { client.end(); } catch { /* ignore */ }
  }
  sseClients.clear();
  server.closeAllConnections?.();
  const forceExit = setTimeout(() => process.exit(0), 500);
  forceExit.unref();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

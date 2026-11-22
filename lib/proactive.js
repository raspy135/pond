// Aggressive Muse-style Proactive Engine: Email Triage Monitor, Watchers, Fast Reminders, Proactive Tool-Using Heartbeat, Webhook Triage.
import { CONFIG, isKeyConfigured, isEmailConfigured, isInQuietHours } from './config.js';
import { readJson, updateJson, getActiveSession, appendToActiveSession, logActivity } from './storage.js';
import { runAgentTurn, completeJson, buildSystemPrompt } from './llm.js';
import { getEmailStore, syncImapEmails, markEmailTriaged, heuristicTriageEmail } from './email.js';
import { syncMs365Emails, isMs365Connected } from './ms365.js';
import { listEvents, syncIcsCalendar } from './calendar.js';
import { checkDueWatches } from './watchers.js';
import { runDueJobs, advanceBackgroundTasks } from './scheduler.js';
import { broadcast, pushNotification } from './notifications.js';
import { emitEvent } from './plugins.js';
import { dreamTick } from './dream.js';

const notifiedReminderIds = new Set();
const headsupReminderIds = new Set();
const notifiedEventIds = new Set();

let proactiveRunning = false;
let emailMonitorRunning = false;
let watcherRunning = false;

// ---------- 1) Fast Reminder & Upcoming Heads-Up Engine (15s cadence) ----------
export async function checkDueReminders() {
  const reminders = await readJson('reminders.json', []);
  const now = Date.now();
  const headsUpMs = Math.max(0, CONFIG.proactive.upcomingReminderHeadsUpMin || 0) * 60_000;

  for (const r of Array.isArray(reminders) ? reminders : []) {
    if (r.done) continue;
    const dueMs = new Date(r.dueAt).getTime();
    if (Number.isNaN(dueMs)) continue;

    // Due or overdue now
    if (dueMs <= now && !notifiedReminderIds.has(r.id)) {
      notifiedReminderIds.add(r.id);
      broadcast({ type: 'reminder', reminder: r });
      const text = `⏰ **Reminder due:** ${r.text}`;
      const session = await appendToActiveSession({ role: 'assistant', content: text, proactive: true, tag: 'Reminder' });
      broadcast({ type: 'proactive', text, tag: 'Reminder', sessionId: session?.id });
      await pushNotification({
        title: `⏰ Reminder — ${CONFIG.assistantName}`,
        body: r.text,
        urgency: 'high',
        category: 'reminder',
        sessionId: session?.id,
        tag: `reminder-${r.id}`,
      });
      await logActivity({ kind: 'reminder', title: 'Reminder fired', detail: r.text });
    } else if (headsUpMs > 0 && dueMs > now && dueMs - now <= headsUpMs && !headsupReminderIds.has(r.id)) {
      headsupReminderIds.add(r.id);
      const mins = Math.max(1, Math.round((dueMs - now) / 60_000));
      await pushNotification({
        title: `⏳ Coming up in ${mins}m`,
        body: r.text,
        urgency: 'normal',
        category: 'reminder',
        tag: `reminder-headsup-${r.id}`,
      });
    }
  }

  // Also check upcoming calendar events and fire a timely heads-up before they start!
  const leadMs = Math.max(0, CONFIG.calendar?.reminderLeadMin ?? 30) * 60_000;
  if (leadMs > 0) {
    const events = await listEvents({ upcomingOnly: true, days: 2 });
    for (const ev of events) {
      if (notifiedEventIds.has(ev.id)) continue;
      const startMs = new Date(ev.startAt).getTime();
      if (startMs >= now && startMs - now <= leadMs) {
        notifiedEventIds.add(ev.id);
        const mins = Math.max(1, Math.round((startMs - now) / 60_000));
        const loc = ev.location ? ` @ ${ev.location}` : '';
        const text = `📅 **Coming up in ${mins}m:** ${ev.title}${loc}`;
        const session = await appendToActiveSession({ role: 'assistant', content: text, proactive: true, tag: 'Upcoming event' });
        broadcast({ type: 'proactive', text, tag: 'Upcoming event', sessionId: session?.id });
        await pushNotification({
          title: `📅 In ${mins}m: ${ev.title}`,
          body: ev.location ? `Location: ${ev.location}` : new Date(ev.startAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          urgency: 'high',
          category: 'calendar',
          sessionId: session?.id,
          tag: `event-${ev.id}`,
        });
        await logActivity({ kind: 'calendar', title: `Upcoming event alert: ${ev.title}`, detail: `Starts in ${mins}m${loc}` });
      }
    }
  }
}

// ---------- 2) Proactive Email Monitor + AI Importance Triage ----------
async function triageOneEmail(email, memory, openTasks) {
  const heuristic = heuristicTriageEmail(email);
  if (!isKeyConfigured() || !CONFIG.email.autoTriage) {
    return heuristic;
  }

  const aggr = CONFIG.proactive.aggressiveness || 'high';
  const thresholdNote =
    aggr === 'aggressive'
      ? 'Be AGGRESSIVE and proactive: flag anything potentially useful, actionable, time-sensitive, human-written, financial, travel, career, security, delivery, calendar, or connected to the user memory/tasks. Only skip obvious spam/mass marketing.'
      : aggr === 'high'
      ? 'Be proactive and alert: flag action-required messages, human emails, VIPs, invoices/payments, security codes/alerts, travel/bookings, deadlines, meetings, and anything relevant to the user memory or tasks. Ignore newsletters/promos.'
      : 'Flag only clearly important or urgent emails (VIPs, deadlines, security, finance, direct requests).';

  try {
    const res = await completeJson({
      system: `You are ${CONFIG.assistantName}'s Email Intelligence Triage Agent (Muse-style). Analyze an incoming email and decide whether to immediately notify the user.
${thresholdNote}
IMPORTANT: Promotional / marketing emails (loan offers, credit card promos, "you're eligible to apply", Black Friday / holiday sales, bonus miles promos, newsletters, store deals — even from PayPal, banks, Apple Store, Delta, Amazon, AliExpress) are ALWAYS category="promo", important=false, shouldNotify=false.
Return ONLY valid JSON:
{
  "important": true | false,
  "urgency": "critical" | "high" | "normal" | "low",
  "category": "action_required" | "security" | "finance" | "meeting" | "travel" | "vip" | "personal" | "work" | "newsletter" | "promo",
  "summary": "1-2 crisp sentences explaining what this email is and why it matters to the user",
  "suggestedAction": "concrete next step you can take for them (e.g. 'Want me to draft a reply confirming Tuesday 3pm?' or 'Review receipt')",
  "shouldNotify": true | false
}`,
      user: [
        `User long-term memory: ${memory.map((m) => m.fact).join('; ') || 'none'}`,
        `User open tasks: ${openTasks.map((t) => t.title).join('; ') || 'none'}`,
        `VIP senders configured: ${(CONFIG.email.vipSenders || []).join(', ') || 'none'}`,
        `--- EMAIL ---`,
        `From: ${email.from}`,
        `Subject: ${email.subject}`,
        `Date: ${email.date}`,
        `Body:\n${String(email.body || email.snippet || '').slice(0, 2500)}`,
      ].join('\n'),
      maxTokens: 360,
      temperature: 0.2,
    });
    if (res && typeof res.important === 'boolean') {
      return {
        important: Boolean(res.important || heuristic.category === 'vip'),
        urgency: ['critical', 'high', 'normal', 'low'].includes(res.urgency) ? res.urgency : heuristic.urgency,
        category: String(res.category || heuristic.category),
        summary: String(res.summary || heuristic.summary),
        suggestedAction: String(res.suggestedAction || ''),
        shouldNotify: Boolean(res.shouldNotify ?? res.important),
      };
    }
  } catch (err) {
    console.error('email LLM triage fallback:', err?.message || err);
  }
  return { ...heuristic, shouldNotify: heuristic.important };
}

export async function runEmailMonitor({ sync = true } = {}) {
  if (emailMonitorRunning) return { skipped: true };
  emailMonitorRunning = true;
  try {
    if (sync) {
      const hasImap = CONFIG.email.enabled && isEmailConfigured();
      const hasMs365 = await isMs365Connected();
      if (hasImap || hasMs365) {
        broadcast({ type: 'proactive_status', running: true, phase: 'Checking email…' });
        if (hasImap) await syncImapEmails({ limit: 15 });
        if (hasMs365) await syncMs365Emails({ limit: 15 });
      }
    }

    const store = await getEmailStore();
    const untriaged = (store.items || []).filter((m) => !m.triaged).slice(0, 8);
    if (!untriaged.length) return { checked: 0, alerted: 0 };

    const [memory, tasks] = await Promise.all([readJson('memory.json', []), readJson('tasks.json', [])]);
    const openTasks = (Array.isArray(tasks) ? tasks : []).filter((t) => t.status !== 'done');

    let alerted = 0;
    for (const email of untriaged) {
      const triage = await triageOneEmail(email, memory, openTasks);
      const shouldAlert = Boolean(triage.important && (triage.shouldNotify !== false));

      await markEmailTriaged(email.id, { ...triage, notified: shouldAlert, triagedAt: new Date().toISOString() });

      if (shouldAlert) {
        alerted++;
        const badge = triage.urgency === 'critical' ? '🚨 URGENT EMAIL' : triage.urgency === 'high' ? '📧 IMPORTANT EMAIL' : '📩 EMAIL HEADS-UP';
        const chatMsg = [
          `**${badge}** — **${email.subject}**`,
          `*From:* ${email.from}`,
          ``,
          `${triage.summary}`,
          triage.suggestedAction ? `\n> **Suggested next step:** ${triage.suggestedAction}` : '',
        ]
          .filter(Boolean)
          .join('\n');

        const session = await appendToActiveSession({
          role: 'assistant',
          content: chatMsg,
          proactive: true,
          tag: `Email · ${triage.urgency}`,
        });

        broadcast({ type: 'proactive', text: chatMsg, tag: `Email · ${triage.urgency}`, sessionId: session?.id });
        broadcast({ type: 'email_alert', email: { ...email, importance: triage } });

        await pushNotification({
          title: `${badge}: ${email.subject}`,
          body: `${email.from} — ${triage.summary}`,
          urgency: triage.urgency === 'critical' ? 'critical' : 'high',
          category: 'email',
          sessionId: session?.id,
          tag: `email-${email.id}`,
          meta: { emailId: email.id, from: email.from, subject: email.subject },
        });

        await logActivity({
          kind: 'email',
          level: triage.urgency === 'critical' ? 'warn' : 'info',
          title: `Alerted user on ${triage.urgency} email`,
          detail: `${email.from} — ${email.subject}: ${triage.summary}`,
        });
      }
    }

    if (untriaged.length) broadcast({ type: 'emails_updated' });
    return { checked: untriaged.length, alerted };
  } finally {
    emailMonitorRunning = false;
    broadcast({ type: 'proactive_status', running: false, phase: 'idle' });
  }
}

// ---------- 3) Proactive Watchers Tick ----------
export async function runWatcherTick() {
  if (watcherRunning) return;
  watcherRunning = true;
  try {
    const updates = await checkDueWatches();
    if (!updates.length) return;
    for (const u of updates) {
      let alertMsg = `**👁️ Watch Update — ${u.watch.name}**\n\n${u.diffSummary}`;
      let shouldNotify = true;

      if (isKeyConfigured()) {
        const evalRes = await completeJson({
          system: `You are ${CONFIG.assistantName}. A web/RSS/topic watcher detected a change. Decide if this change is worth alerting the user about based on their criteria. Respond ONLY with JSON: {"notify": true|false, "urgency": "normal"|"high", "message": "concise summary with links under 70 words"}.`,
          user: `Watch: ${u.watch.name} (${u.watch.type}: ${u.watch.target})\nCriteria: ${u.watch.criteria || 'Any meaningful new item or change'}\nDetected diff:\n${u.diffSummary}`,
        }).catch(() => null);
        if (evalRes) {
          shouldNotify = Boolean(evalRes.notify);
          if (evalRes.message) alertMsg = `**👁️ Watch Alert — ${u.watch.name}**\n\n${evalRes.message}`;
        }
      }

      if (shouldNotify) {
        const session = await appendToActiveSession({ role: 'assistant', content: alertMsg, proactive: true, tag: `Watch · ${u.watch.name}` });
        broadcast({ type: 'proactive', text: alertMsg, tag: `Watch · ${u.watch.name}`, sessionId: session?.id });
        await pushNotification({
          title: `👁️ ${u.watch.name}`,
          body: alertMsg.replace(/[#*_`]/g, '').slice(0, 220),
          urgency: 'high',
          category: 'watch',
          sessionId: session?.id,
          tag: `watch-${u.watch.id}`,
        });
        await logActivity({ kind: 'watch', title: `Watch alert: ${u.watch.name}`, detail: alertMsg.slice(0, 300) });
      }
    }
  } finally {
    watcherRunning = false;
  }
}

// ---------- 4) Inbound Webhook Event Triage ----------
export async function handleWebhookEvent(sourceName, payload) {
  await logActivity({
    kind: 'webhook',
    title: `Webhook received: ${sourceName}`,
    detail: JSON.stringify(payload).slice(0, 350),
  });

  if (!isKeyConfigured()) {
    await pushNotification({
      title: `🔗 Webhook: ${sourceName}`,
      body: JSON.stringify(payload).slice(0, 220),
      urgency: 'normal',
      category: 'webhook',
    });
    return { notified: true, summary: 'Forwarded raw webhook (LLM key not set)' };
  }

  const memory = await readJson('memory.json', []);
  const res = await completeJson({
    system: `You are ${CONFIG.assistantName}. An external webhook event just arrived from "${sourceName}". Decide if the user should be notified right away. Return ONLY JSON: {"notify": true|false, "urgency": "normal"|"high"|"critical", "title": "short alert title", "message": "concise summary & recommended action under 70 words"}.`,
    user: `User memory: ${memory.map((m) => m.fact).join('; ') || 'none'}\nWebhook payload:\n${JSON.stringify(payload, null, 2).slice(0, 3500)}`,
  });

  if (res?.notify) {
    const chatText = `**🔗 ${res.title || `Event from ${sourceName}`}**\n\n${res.message}`;
    const session = await appendToActiveSession({ role: 'assistant', content: chatText, proactive: true, tag: `Webhook · ${sourceName}` });
    broadcast({ type: 'proactive', text: chatText, tag: `Webhook · ${sourceName}`, sessionId: session?.id });
    await pushNotification({
      title: `🔗 ${res.title || sourceName}`,
      body: res.message || '',
      urgency: res.urgency || 'high',
      category: 'webhook',
      sessionId: session?.id,
    });
    return { notified: true, ...res };
  }
  return { notified: false, ...res };
}

// ---------- 5) Aggressive Muse-Style Proactive Heartbeat ----------
function getEffectiveMinGapMs() {
  const baseMin = Math.max(1, CONFIG.proactive.minGapMin || 5);
  const aggr = CONFIG.proactive.aggressiveness || 'high';
  if (aggr === 'aggressive') return Math.min(baseMin, 3) * 60_000;
  if (aggr === 'high') return baseMin * 60_000;
  if (aggr === 'medium') return Math.max(baseMin, 15) * 60_000;
  return Math.max(baseMin, 30) * 60_000;
}

function getBriefingSlot(now = new Date()) {
  const h = now.getHours();
  const day = now.toISOString().slice(0, 10);
  if (h >= 7 && h < 11) return `${day}-morning`;
  if (h >= 12 && h < 15) return `${day}-midday`;
  if (h >= 17 && h < 21) return `${day}-evening`;
  return '';
}

export async function proactiveTick({ force = false } = {}) {
  if (proactiveRunning) return { skipped: true, reason: 'already_running' };
  proactiveRunning = true;
  broadcast({ type: 'proactive_status', running: true, phase: force ? 'Running proactive check-in…' : 'Proactive scan…' });
  emitEvent('proactive_tick', { force, at: Date.now() });

  try {
    // Always process time-critical reminders, watchers & due jobs; only sync email here on forced check-in (dedicated email loop handles scheduled polling).
    await checkDueReminders();
    if (force) await runEmailMonitor({ sync: true }).catch(() => {});
    await runWatcherTick().catch(() => {});
    await runDueJobs().catch(() => {});

    if (!CONFIG.proactive.enabled || !isKeyConfigured()) return { spoke: false, reason: 'disabled_or_no_key' };
    if (!force && isInQuietHours()) return { spoke: false, reason: 'quiet_hours' };

    // Also advance any autonomous background tasks
    const taskAdvance = await advanceBackgroundTasks({ force });
    if (taskAdvance?.output && !force) {
      return { spoke: true, reason: 'task_advanced' };
    }

    const state = await readJson('proactive-state.json', { lastProactiveAt: 0, lastBriefingKey: '' });
    const now = Date.now();
    const minGapMs = getEffectiveMinGapMs();
    if (!force && now - (state.lastProactiveAt || 0) < minGapMs) {
      return { spoke: false, reason: 'cooldown' };
    }

    const [{ session }, memory, reminders, tasks, emailStore, jobs, watches, upcomingEvents] = await Promise.all([
      getActiveSession(),
      readJson('memory.json', []),
      readJson('reminders.json', []),
      readJson('tasks.json', []),
      getEmailStore(),
      readJson('jobs.json', []),
      readJson('watches.json', []),
      listEvents({ upcomingOnly: true, days: 5 }),
    ]);

    const openTasks = (Array.isArray(tasks) ? tasks : []).filter((t) => t.status !== 'done');
    const pendingReminders = (Array.isArray(reminders) ? reminders : []).filter((r) => !r.done);
    const importantEmails = (emailStore.items || []).filter((e) => e.unread && e.importance?.important).slice(0, 5);
    const recentMsgs = (session.messages || []).slice(-8);
    const lastMsg = recentMsgs[recentMsgs.length - 1];
    const lastWasProactive = Boolean(lastMsg?.proactive);
    const minutesSinceLastMsg = lastMsg?.ts ? Math.round((now - new Date(lastMsg.ts).getTime()) / 60_000) : 999;

    const aggr = CONFIG.proactive.aggressiveness || 'high';
    const briefingSlot = CONFIG.proactive.proactiveBriefings ? getBriefingSlot() : '';
    const briefingDue = Boolean(briefingSlot && briefingSlot !== state.lastBriefingKey);

    // What's NEW since the last check-in, decided in code (not by the model): important emails the email alert
    // didn't already announce, and events starting within 3 hours. Things already told are never re-raised here.
    const told = new Set(Array.isArray(state.toldKeys) ? state.toldKeys : []);
    const signals = [];
    for (const e of (emailStore.items || [])) {
      if (!e.unread || !e.importance?.important || e.dismissed) continue;
      const key = `email:${e.id}`;
      if (e.notified || e.importance?.notified) told.add(key); // the email alert already told the user
      else if (!told.has(key)) signals.push({ key, text: `New important email: ${e.from}: "${e.subject}"` });
    }
    for (const ev of upcomingEvents) {
      const t = new Date(ev.startAt).getTime();
      const key = `event:${ev.id}:${ev.startAt}`;
      if (t > now && t - now <= 3 * 3_600_000 && !told.has(key)) {
        signals.push({ key, text: `Starting soon: ${ev.title} at ${new Date(ev.startAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${ev.location ? ` @ ${ev.location}` : ''}` });
      }
    }
    const recentSaid = (Array.isArray(state.recentSaid) ? state.recentSaid : []).filter((r) => now - r.at < 24 * 3_600_000);
    const hoursSinceSpoke = state.lastProactiveAt ? (now - state.lastProactiveAt) / 3_600_000 : Infinity;
    const quietHoursSetting = Number(CONFIG.proactive.dndHours ?? 4);
    // Nothing new, no briefing due: don't even ask the model. Only "aggressive" mode, or "high" after a long quiet
    // stretch, gets an open-ended look (ideas / follow-ups) — and the model may still say nothing.
    const openLookAllowed = aggr === 'aggressive' || (aggr === 'high' && hoursSinceSpoke >= Math.max(1, quietHoursSetting || 4));
    if (!force && !briefingDue && !signals.length && !openLookAllowed) {
      return { spoke: false, reason: 'nothing_new' };
    }

    // Don't-disturb window: recently checked in -> only interrupt for something actionable.
    const dndHours = Number(CONFIG.proactive.dndHours ?? 4);
    const minsSinceLastCheckin = state.lastProactiveAt ? Math.round((now - state.lastProactiveAt) / 60_000) : null;
    const dndActive = !force && !briefingDue && dndHours > 0 && minsSinceLastCheckin !== null && minsSinceLastCheckin < dndHours * 60;
    if (dndActive && !signals.length) return { spoke: false, reason: 'dnd_nothing_new' };
    const dndRule = dndActive
      ? `DO-NOT-DISTURB RULE (overrides the mode above): your last proactive check-in was ${minsSinceLastCheckin} min ago (< ${dndHours}h). Stay silent (speak=false) UNLESS you have something ACTIONABLE or genuinely NEW since then — e.g. a new important email needing a reply, an event/reminder starting soon, a deadline today, a finished task result, or a time-sensitive opportunity. Never send status-only, "all clear", "nothing new", "just checking in", or restated messages. If you do speak, set "actionable": true and the message must name the specific action item.`
      : `Set "actionable": true only if the message contains a concrete thing the user should do or newly-arrived important info; otherwise false. Never send status-only "nothing new / all clear" messages.`;

    const modeGuidance =
      aggr === 'aggressive'
        ? `MODE: AGGRESSIVE PERSONAL CHIEF-OF-STAFF (Meta Muse style). Be boldly proactive about the user's daily life!
- Use your tools (check_emails, list_events, web_search, list_tasks, list_notes) to bring back something genuinely useful right now:
  • Surface important emails, bills, deliveries, invitations, or replies waiting on them.
  • Highlight upcoming calendar events, errands, or things to do today/tomorrow.
  • Proactively SUGGEST fun/timely local events, concerts, restaurants, weekend ideas, or seasonal plans tailored to their location (${CONFIG.userLocation || 'check memory'}) and interests!
  • Follow up on unresolved plans or threads from recent chat, or offer to put something on their calendar / set a reminder.
- Speak when you can add concrete daily-life value, but never repeat what you already told the user.`
        : aggr === 'high'
        ? `MODE: HIGH PROACTIVITY (Meta Muse personal assistant). Actively look out for the user's day:
- You may call tools (check_emails, list_events, web_search) to check inbox, agenda, or find relevant local events/ideas before deciding.
- Speak up for briefings and for the NEW items listed below. Event/activity ideas belong in briefings, not separate pings.
- Never repeat what you already told the user (see "Already told the user").`
        : aggr === 'medium'
        ? `MODE: BALANCED. Speak up for daily briefings, pending reminders/events/to-dos, important unread emails, or a timely follow-up. Otherwise stay silent.`
        : `MODE: LOW. Speak ONLY for urgent reminders, imminent events, or critical emails.`;

    const context = [
      `Current local time: ${new Date().toString()}`,
      `NEW since your last check-in (${signals.length}): ${signals.map((x) => x.text).join('; ') || 'nothing'}`,
      `Already told the user in the last 24h — do NOT bring these up again unless something about them changed:\n${recentSaid.map((r) => `- ${new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}: ${r.text}`).join('\n') || '(nothing)'}`,
      `User location: ${CONFIG.userLocation || '(unknown — check memory if stored)'}`,
      `Briefing slot due: ${briefingDue ? briefingSlot : 'no'}`,
      `Minutes since last chat message: ${minutesSinceLastMsg} (last message was proactive: ${lastWasProactive})`,
      `Force check-in clicked by user: ${force}`,
      `Upcoming calendar events (${upcomingEvents.length}): ${upcomingEvents.slice(0, 6).map((e) => `${e.title} (${new Date(e.startAt).toLocaleString()}${e.location ? ' @ ' + e.location : ''})`).join('; ') || 'none'}`,
      `Pending reminders (${pendingReminders.length}): ${pendingReminders.map((r) => `${r.text} (due ${r.dueAt})`).join('; ') || 'none'}`,
      `Open to-dos / tasks (${openTasks.length}): ${openTasks.map((t) => `${t.title}${t.progress?.length ? ` [${t.progress[t.progress.length - 1].note}]` : ''}`).join('; ') || 'none'}`,
      `Important unread emails (${importantEmails.length}): ${importantEmails.map((e) => `[${e.importance.urgency}] ${e.from}: "${e.subject}"${e.notified || e.importance?.notified ? ' (already alerted — don\'t re-raise)' : ''}`).join('; ') || 'none'}`,
      `Active routines: ${jobs.filter((j) => j.enabled).length} | Active watches: ${watches.filter((w) => w.enabled).length}`,
      `Known facts about user:\n${memory.map((m) => `- ${m.fact}`).join('\n') || '(none)'}`,
      `Recent conversation:\n${recentMsgs.map((m) => `${m.role}${m.proactive ? ' (proactive)' : ''}: ${String(m.content).slice(0, 260)}`).join('\n') || '(none)'}`,
    ].join('\n');

    // Run a tool-capable proactive turn reusing the exact same static system prompt prefix for KV cache hits!
    const sys = await buildSystemPrompt();
    const res = await runAgentTurn({
      systemPrompt: sys,
      userPrompt: `[Autonomous Proactive Check-in]
${modeGuidance}

IMPORTANT OUTPUT FORMAT:
After optionally using any read-only or planning tools you need (like web_search, check_emails, read_note, list_tasks), your FINAL response MUST be ONLY a JSON object with this exact shape:
{"speak": true|false, "actionable": true|false, "urgency": "normal"|"high", "tag": "short label like Briefing, Follow-up, Heads-up, Discovery", "message": "your crisp, warm, actionable message (under 90 words, Markdown allowed)"}
Saying nothing is a normal, good outcome: {"speak": false} is the right answer whenever you have nothing new and useful. Every message pings the user's phone — only send one you'd be glad to receive.
${dndRule}
If force=true, ALWAYS set speak=true and give a genuinely helpful check-in (summarize inbox/tasks/reminders or proactively offer something useful based on memory & time of day).

${context}`,
      maxRounds: aggr === 'aggressive' || aggr === 'high' || force ? 4 : 1,
      source: 'proactive',
      temperature: 0.45,
    });

    // The model chose silence for these items: don't ask it about the same ones again on every tick.
    const markConsidered = () => updateJson('proactive-state.json', {}, (s) => ({
      ...s, toldKeys: [...new Set([...(s.toldKeys || []), ...told, ...signals.map((x) => x.key)])].slice(-300),
    })).catch(() => {});
    const match = (res.content || '').match(/\{[\s\S]*\}/);
    if (!match) return { spoke: false, reason: 'no_json' };
    let parsed;
    try { parsed = JSON.parse(match[0]); } catch { return { spoke: false, reason: 'bad_json' }; }

    // Hard gate in code, in case the model ignores the rule (or a status-only message slips through).
    if (parsed.speak && parsed.message && dndActive && parsed.actionable !== true) {
      await logActivity({
        kind: 'proactive',
        title: 'Check-in suppressed (do-not-disturb: nothing actionable)',
        detail: String(parsed.message).slice(0, 300),
      });
      await markConsidered();
      return { spoke: false, reason: 'dnd_nothing_actionable' };
    }

    if (parsed.speak && parsed.message) {
      const text = String(parsed.message).trim();
      const tag = String(parsed.tag || 'Check-in');
      const urgency = parsed.urgency === 'high' ? 'high' : 'normal';

      await updateJson('proactive-state.json', {}, (s) => ({
        ...s,
        lastProactiveAt: Date.now(),
        ...(briefingDue ? { lastBriefingKey: briefingSlot } : {}),
        toldKeys: [...new Set([...told, ...signals.map((x) => x.key)])].slice(-300),
        recentSaid: [...recentSaid, { at: Date.now(), text: text.replace(/\s+/g, ' ').slice(0, 220) }].slice(-12),
      }));

      const activeSess = await appendToActiveSession({ role: 'assistant', content: text, proactive: true, tag });
      broadcast({ type: 'proactive', text, tag, sessionId: activeSess?.id });

      await pushNotification({
        title: `${CONFIG.assistantName} · ${tag}`,
        body: text.replace(/[#*_`]/g, '').slice(0, 240),
        urgency,
        category: 'proactive',
        sessionId: activeSess?.id,
        tag: `proactive-${Date.now()}`,
      });

      await logActivity({
        kind: 'proactive',
        title: `Proactive check-in (${tag})`,
        detail: text.slice(0, 300),
      });

      return { spoke: true, text, tag };
    }

    await markConsidered();
    return { spoke: false, reason: 'agent_stayed_silent' };
  } catch (err) {
    console.error('proactive tick error:', err?.message || err);
    await logActivity({ kind: 'proactive', level: 'error', title: 'Proactive tick error', detail: String(err?.message || err) });
    return { spoke: false, error: String(err?.message || err) };
  } finally {
    proactiveRunning = false;
    broadcast({ type: 'proactive_status', running: false, phase: 'idle' });
  }
}

// ---------- 6) Lifecycle Timers ----------
let timers = [];

export function startProactiveLoops() {
  stopProactiveLoops();

  // Fast 15s reminder check (time-critical!)
  timers.push(setInterval(() => checkDueReminders().catch(() => {}), 15_000));

  // 30s cron / scheduled job tick
  timers.push(setInterval(() => runDueJobs().catch(() => {}), 30_000));

  // Dedicated Email Monitor loop (default every 10m)
  const emailMs = Math.max(1, CONFIG.email.pollIntervalMin || 10) * 60_000;
  timers.push(setInterval(() => runEmailMonitor({ sync: true }).catch(() => {}), emailMs));

  // Proactive Watcher loop (every 2m, checks watches whose individual intervals elapsed)
  timers.push(setInterval(() => runWatcherTick().catch(() => {}), 2 * 60_000));

  // iCal (.ics) calendar sync (every 15m if configured)
  timers.push(setInterval(() => syncIcsCalendar().catch(() => {}), 15 * 60_000));

  // Nightly memory dream (checks every 10m; runs once in the window after CONFIG.memory.dreamHour)
  timers.push(setInterval(() => dreamTick().catch((err) => console.error('dream:', err?.message || err)), 10 * 60_000));

  // Main Proactive Heartbeat (default every 3m)
  const proactiveMs = Math.max(1, CONFIG.proactive.intervalMin || 3) * 60_000;
  timers.push(setInterval(() => proactiveTick().catch(() => {}), proactiveMs));

  // Initial warm boot scan after 8 seconds
  timers.push(
    setTimeout(() => {
      syncIcsCalendar().catch(() => {});
      checkDueReminders().catch(() => {});
      runEmailMonitor({ sync: true }).catch(() => {});
      proactiveTick().catch(() => {});
    }, 8_000)
  );
}

export function stopProactiveLoops() {
  for (const t of timers) {
    clearInterval(t);
    clearTimeout(t);
  }
  timers = [];
}

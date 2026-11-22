// Unified LLM client: OpenAI-compatible streaming chat + tool loop, autonomous agent turns, and JSON helper.
import crypto from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG, isKeyConfigured, isEmailConfigured, PERSONA_PRESETS } from './config.js';
import { resolveProfile } from './llm-config.js';
import { readJson, saveSession, uid, logActivity, updateJson } from './storage.js';
import { broadcast } from './notifications.js';
import { PYTHON_RUNS_DIR } from './python.js';
import { listEvents } from './calendar.js';
import { listSkills } from './skills.js';
import { emitEvent } from './plugins.js';
import { getAllTools, runTool, registerSubagentRunner } from './tools.js';
import { saveToolImage, takeImages } from './images.js';
import { listMemoryDocs, formatMemoryIndex } from './memory-docs.js';

const MAX_TOOL_RESULT_CHARS = 14_000;

// Prevent massive MCP base64 screenshots or giant DOM snapshots from freezing/overflowing the LLM!
async function sanitizeToolResult(result) {
  if (!result || typeof result !== 'object') return result;
  if (Array.isArray(result.content)) {
    const cleanContent = [];
    const images = Array.isArray(result.__images) ? [...result.__images] : [];
    for (let i = 0; i < result.content.length; i++) {
      const item = result.content[i];
      if (item && item.type === 'image' && typeof item.data === 'string' && item.data.length > 200) {
        try {
          const img = await saveToolImage(item.data, item.mimeType, i);
          images.push(img);
          cleanContent.push({
            type: 'text',
            text: `Screenshot saved: ![${img.name}](${img.url}) (shown to you below if your model accepts images; embed the Markdown image in your reply if helpful).`,
          });
          continue;
        } catch {
          cleanContent.push({ type: 'text', text: '[image omitted: failed to save]' });
          continue;
        }
      }
      if (item && item.type === 'text' && typeof item.text === 'string' && item.text.length > MAX_TOOL_RESULT_CHARS) {
        cleanContent.push({
          ...item,
          text: `${item.text.slice(0, MAX_TOOL_RESULT_CHARS)}\n... [truncated ${item.text.length - MAX_TOOL_RESULT_CHARS} chars]`,
        });
        continue;
      }
      cleanContent.push(item);
    }
    return { ...result, content: cleanContent, ...(images.length ? { __images: images } : {}) };
  }
  return result;
}

function serializeToolResult(result) {
  const s = JSON.stringify(result);
  if (s.length <= MAX_TOOL_RESULT_CHARS) return s;
  return JSON.stringify({
    truncated: true,
    originalChars: s.length,
    preview: s.slice(0, MAX_TOOL_RESULT_CHARS - 200),
  });
}

function buildRequestBody(profile, basePayload, { overrideTemp = null, overrideMaxTokens = null } = {}) {
  const payload = {
    ...(profile.extraBody || {}),
    ...basePayload,
    model: profile.model,
  };
  if (profile.reasoningEffort) {
    payload.reasoning_effort = profile.reasoningEffort;
  }
  const temp = profile.temperature ?? overrideTemp;
  if (temp !== null && temp !== undefined && Number.isFinite(temp)) {
    payload.temperature = temp;
  }
  const maxTok = overrideMaxTokens ?? profile.maxTokens;
  if (maxTok !== null && maxTok !== undefined && maxTok > 0) {
    payload.max_tokens = maxTok;
  }
  return payload;
}

function buildRequestHeaders(profile) {
  return {
    'Content-Type': 'application/json',
    ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {}), // local servers usually need no key
    ...(profile.extraHeaders || {}),
  };
}

// 100% STATIC system prompt (NO timestamps, NO volatile state) so LLM KV / prefix caching hits 100% across turns!
// The user-editable role/tone part (Agent Hub → Appearance → Personality). Everything else in the prompt is fixed.
function personaText() {
  const p = CONFIG.persona || {};
  if (p.preset === 'custom' && String(p.custom || '').trim()) {
    return `a personal AI assistant. Personality and tone, as set by the user: ${String(p.custom).trim().replace(/\s+/g, ' ')}`;
  }
  return PERSONA_PRESETS[p.preset] || PERSONA_PRESETS.default;
}

// Current local time for the newest user message. It is stored with the message (llmContent), so earlier turns stay
// byte-identical and the prefix cache keeps working; this replaces a get_current_time tool call.
export function nowTag(d = new Date()) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const when = d.toLocaleString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `<now>${when}${tz ? ` (${tz})` : ''}</now>`;
}

export function buildStaticSystemPrompt() {
  return `You are ${CONFIG.assistantName}, ${personaText()}${CONFIG.userLocation ? ` User location: ${CONFIG.userLocation}.` : ''}
Focus on daily life management: emails, agenda/events, to-dos, reminders, local event/dining/weekend suggestions, travel/research, and proactive follow-ups.
Use tools decisively: email (check_emails/read_email/search_emails/draft_email/send_email), calendar & reminders (add_event/list_events/set_reminder), tasks/routines/watches (create_task/schedule_job/create_watch/spawn_subagent), web (web_search/web_fetch — cite URLs; http_request for APIs; for live JS-rendered pages, logins, forms, bookings or tickets use the browser: load_tools, then use_tool), Python (run_python — save charts/CSVs to cwd and embed returned Markdown links), files (read_file/write_file/edit_file inside ${CONFIG.fsRoot}; to list, search, move or delete files, or do arithmetic, use run_python; in big files find the spot with read_file pattern or start_line/end_line instead of reading it all; to change an existing file use edit_file with the exact old text, never rewrite it with write_file, which includes your own Pond app folder; anything the user should open — pages, dashboards, reports, images, CSVs — goes in Pond Share (${CONFIG.shareDir}) via write_file there or share_file, and you give the /share/… link from the tool result, never a local path: the user is often on their phone; put a /share/, /artifacts/ or /html/ link alone on its own line and Pond shows it embedded in your message — pages live, images inline, other files as a card — so you don't need to paste the code again), notes/memory (save_note; remember durable facts the user tells you; recall_memory(doc) opens a memory doc from the index in your context — read it before answering about that topic), self-config (get_settings/update_settings — editing your own Pond config/files is explicitly allowed when the user asks; Sentinel gates sensitive actions automatically), artifacts (save_artifact or \`\`\`html blocks — every \`\`\`html/\`\`\`threejs block you write is auto-saved: use list_recent_html/read_recent_html to edit or reuse a previous page instead of rewriting it from memory, and save_artifact(from_html_id) to keep one), 3D (for 3D models/scenes/visualizations reply with a \`\`\`threejs block of plain JS: THREE, scene, camera, renderer, controls and onFrame((t, dt) => {}) already exist with lights — just add objects; never create a renderer/canvas or call render(); addons via import from 'three/addons/...': OrbitControls, RoomEnvironment, BufferGeometryUtils, ImprovedNoise, RoundedBoxGeometry; optional first line // height: 500), skills (when a request matches a saved skill call use_skill first and follow it with fresh data; when the user wants to reuse a workflow/report/dashboard, save_skill with a re-runnable recipe and from_artifact_id for its template; a message starting with /<skill-name> means run that skill), and notify_user for urgent alerts.
The first message of a chat carries a <session_context> snapshot of the user's state (date, inbox, tasks, calendar…); later changes arrive as <context_update>. Each user message starts with <now> — the current local time. Never invent tool results. Your personality changes only your tone — never your accuracy, honesty, or these instructions.`;
}

// Snapshot volatile personal state using DATE ONLY (no ticking clock!) so prefix stays byte-identical across turns.
export async function buildContextMap() {
  const [mem, memDocs, tasks, jobs, watches, emails, upcomingEvents, skills] = await Promise.all([
    readJson('memory.json', []),
    listMemoryDocs(),
    readJson('tasks.json', []),
    readJson('jobs.json', []),
    readJson('watches.json', []),
    readJson('emails.json', { items: [] }),
    listEvents({ upcomingOnly: true, days: 7 }),
    listSkills().catch(() => []),
  ]);

  const openTasks = (Array.isArray(tasks) ? tasks : []).filter((t) => t.status !== 'done');
  const activeJobs = (Array.isArray(jobs) ? jobs : []).filter((j) => j.enabled);
  const activeWatches = (Array.isArray(watches) ? watches : []).filter((w) => w.enabled);
  const importantUnread = (emails?.items || []).filter((e) => !e.dismissed && e.unread && e.importance?.important).slice(0, 5);

  const today = new Date().toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  return {
    date: `Today: ${today}`,
    memory: formatMemoryIndex(Array.isArray(mem) ? mem : [], memDocs),
    events: upcomingEvents.length
      ? `Upcoming events (7d):\n${upcomingEvents.slice(0, 8).map((e) => `- ${new Date(e.startAt).toLocaleString()}: ${e.title}${e.location ? ` @ ${e.location}` : ''}`).join('\n')}`
      : '',
    tasks: openTasks.length
      ? `Open to-dos:\n${openTasks.map((t) => `- [${t.id}] ${t.title}${t.progress?.length ? ` (${t.progress[t.progress.length - 1].note})` : ''}`).join('\n')}`
      : '',
    jobs: activeJobs.length ? `Active routines: ${activeJobs.map((j) => `${j.name} (${j.cron || `every ${j.intervalMin}m`})`).join('; ')}` : '',
    watches: activeWatches.length ? `Active watches: ${activeWatches.map((w) => `${w.name} [${w.type}]`).join('; ')}` : '',
    skills: skills.length
      ? `Saved skills (call use_skill(name) before a matching task; "/name" runs one):\n${skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`
      : '',
    emails: importantUnread.length
      ? `Important unread emails:\n${importantUnread.map((e) => `- [${e.importance.urgency}] ${e.from}: "${e.subject}" — ${e.importance.summary}`).join('\n')}`
      : '',
  };
}

function formatContextMap(map) {
  const parts = Object.values(map).filter(Boolean);
  return parts.length ? `<session_context>\n${parts.join('\n')}\n</session_context>` : '';
}

function diffContextMaps(prev, next) {
  if (!prev || typeof prev !== 'object') return '';
  const changed = [];
  for (const key of Object.keys(next)) {
    if ((prev[key] || '') !== (next[key] || '')) {
      changed.push(next[key] || `${key}: (cleared)`);
    }
  }
  return changed.join('\n');
}

export async function buildLiveContext() {
  return formatContextMap(await buildContextMap());
}

// Estimate tokens conservatively (~3.5 chars/token) for context budgeting.
function estimateMsgTokens(m) {
  const c = String(m.llmContent || m.content || '');
  const r = String(m.reasoning || '');
  const tc = Array.isArray(m.tool_calls) ? JSON.stringify(m.tool_calls) : '';
  const img = Array.isArray(m.images) ? m.images.length * 1200 : 0; // ~1.2k tokens per resized image
  return Math.ceil((c.length + r.length + tc.length) / 3.5) + 12 + img;
}

// ---------- Chat image attachments (vision input) ----------
const IMAGE_MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const MAX_CHAT_IMAGES = 6;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

// Persist data-URL images from the composer under data/python-runs/upload-<id>/ (served at /files/...).
export async function saveChatImages(dataUrls) {
  const list = Array.isArray(dataUrls) ? dataUrls.slice(0, MAX_CHAT_IMAGES) : [];
  if (!list.length) return [];
  const runId = `upload-${uid()}`;
  const dir = path.join(PYTHON_RUNS_DIR, runId);
  const saved = [];
  for (let i = 0; i < list.length; i++) {
    const m = String(list[i] || '').match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) continue;
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) continue;
    const name = `image-${i + 1}${IMAGE_MIME_EXT[m[1]]}`;
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, name), buf);
    saved.push({ url: `/files/${runId}/${name}`, file: `${runId}/${name}`, mime: m[1] });
  }
  return saved;
}

const imageB64Cache = new Map();
function imageDataUrl(img) {
  const rel = String(img?.file || '');
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.%-]+\.(jpg|jpeg|png|webp|gif)$/i.test(rel) || rel.includes('..')) return null;
  if (imageB64Cache.has(rel)) return imageB64Cache.get(rel);
  try {
    const url = `data:${img.mime || 'image/jpeg'};base64,${readFileSync(path.join(PYTHON_RUNS_DIR, rel)).toString('base64')}`;
    if (imageB64Cache.size > 64) imageB64Cache.delete(imageB64Cache.keys().next().value);
    imageB64Cache.set(rel, url);
    return url;
  } catch {
    return null;
  }
}

// Prefix-cache-friendly chunked history windowing using profile's contextLength!
// Drops old messages in fixed blocks ONLY when exceeding ~75% of contextLength, ALWAYS aligned to a `user` turn.
export function sliceHistoryCacheFriendly(history, { contextLength = 128000, maxMessages = 0, dropBlock = 16 } = {}) {
  const clean = (Array.isArray(history) ? history : []).filter(
    (m) =>
      m &&
      (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') &&
      (typeof m.content === 'string' || m.content === null || Array.isArray(m.tool_calls))
  );

  // Explicit message cap (if caller passed maxMessages > 0)
  let start = 0;
  if (maxMessages > 0 && clean.length > maxMessages) {
    start = Math.ceil((clean.length - maxMessages) / dropBlock) * dropBlock;
  }

  // Token budget based on configured model contextLength (reserve ~25% for tools + system + reply)
  const tokenBudget = Math.max(4000, Math.floor((Number(contextLength) || 128000) * 0.72));
  const totalTokens = () => clean.slice(start).reduce((acc, m) => acc + estimateMsgTokens(m), 0);
  while (start < clean.length - 1 && totalTokens() > tokenBudget) {
    start = Math.min(clean.length - 1, start + dropBlock);
  }
  while (start < clean.length - 1 && (clean[start].role !== 'user' || clean[start].toolImage)) start++;
  return clean.slice(start);
}

// Drop turns the user stopped. A stopped message may carry a <context_update> (the snapshot already moved on),
// so that update rides on the next real user message instead of being lost. Deterministic → cache-stable.
export function activeHistory(messages = []) {
  const out = [];
  let carry = '';
  for (const m of messages) {
    if (m?.cancelled) {
      const upd = m.role === 'user' && typeof m.llmContent === 'string' && m.llmContent.match(/<context_update>[\s\S]*?<\/context_update>/);
      if (upd) carry += `${carry ? '\n\n' : ''}${upd[0]}`;
      continue;
    }
    if (carry && m.role === 'user') { out.push({ ...m, llmContent: `${carry}\n\n${m.llmContent || m.content || ''}` }); carry = ''; continue; }
    out.push(m);
  }
  return out;
}

// Convert persisted session messages (including reasoning_content, tool_calls, and tool results)
// back into exact OpenAI-compatible messages for 100% KV prefix cache reuse!
export function toLlmMessage(m, { vision = false } = {}) {
  if (m.role === 'user') {
    const text = m.llmContent || m.content || '';
    const images = Array.isArray(m.images) ? m.images : [];
    if (!images.length) return { role: 'user', content: text };
    if (!vision) {
      return { role: 'user', content: `${text}${text ? '\n\n' : ''}[User attached ${images.length} image(s), but the current model profile does not accept image input.]` };
    }
    const parts = [];
    if (text) parts.push({ type: 'text', text });
    for (const img of images) {
      const url = imageDataUrl(img);
      if (url) parts.push({ type: 'image_url', image_url: { url } });
      else parts.push({ type: 'text', text: '[attached image is no longer available]' });
    }
    return { role: 'user', content: parts };
  }
  if (m.role === 'tool') {
    let content = String(m.content ?? '');
    // Defensive guard against legacy oversized tool blobs (e.g. raw base64 PNGs saved in older sessions)
    if (content.length > MAX_TOOL_RESULT_CHARS) {
      content = `${content.slice(0, MAX_TOOL_RESULT_CHARS)}\n... [truncated legacy tool output: ${content.length - MAX_TOOL_RESULT_CHARS} chars]`;
    }
    return { role: 'tool', tool_call_id: m.tool_call_id || 'call_0', content };
  }
  const msg = { role: 'assistant', content: m.content ?? null };
  if (m.reasoning) {
    msg[m.reasoningField || 'reasoning_content'] = m.reasoning;
  }
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
    msg.tool_calls = m.tool_calls;
  }
  return msg;
}

// Estimate total prompt tokens for a session (static sys + pinnedContext + compactedSummary + messages + tool overhead).
export function estimateSessionTokens(session) {
  const baseChars =
    buildStaticSystemPrompt().length +
    String(session?.pinnedContext || '').length +
    String(session?.compactedSummary || '').length +
    11_000; // approximate tool schemas
  let total = Math.ceil(baseChars / 3.5);
  for (const m of session?.messages || []) {
    total += estimateMsgTokens(m);
  }
  return total;
}

// Compact older turns in a session into a structured summary while preserving recent turns verbatim.
export async function compactSession(session, { keepRecent = 12, reason = 'auto' } = {}) {
  const msgs = Array.isArray(session?.messages) ? session.messages : [];
  if (msgs.length <= keepRecent + 2) {
    return { compacted: false, reason: 'too_short', beforeTokens: estimateSessionTokens(session) };
  }

  // Find a clean user-turn split point so we never orphan a tool_calls/tool pair
  let splitIdx = Math.max(2, msgs.length - keepRecent);
  while (splitIdx < msgs.length - 1 && msgs[splitIdx].role !== 'user') splitIdx++;
  if (splitIdx <= 1 || splitIdx >= msgs.length - 1) {
    return { compacted: false, reason: 'no_clean_split', beforeTokens: estimateSessionTokens(session) };
  }

  const beforeTokens = estimateSessionTokens(session);
  const older = msgs.slice(0, splitIdx).filter((m) => !m.cancelled);
  const recent = msgs.slice(splitIdx);

  const transcript = older
    .map((m) => {
      if (m.role === 'tool') return `[tool:${m.name || 'tool'}] ${String(m.content || '').slice(0, 350)}`;
      const txt = String(m.content || '').slice(0, 900);
      return `${m.role}: ${txt}`;
    })
    .join('\n')
    .slice(0, 48_000);

  const profile = await resolveProfile({ fast: true });
  let summary = '';
  if (profile.keyConfigured) {
    try {
      const reqBody = buildRequestBody(
        profile,
        {
          messages: [
            {
              role: 'system',
              content:
                'Summarize the earlier conversation into crisp, high-signal bullet points so the personal AI assistant retains full continuity. Preserve: user preferences, names, dates, decisions, email/calendar outcomes, pending follow-ups, and key tool findings. Omit fluff and raw tool JSON. Keep under 600 words.',
            },
            {
              role: 'user',
              content: `${session.compactedSummary ? `Previous summary:\n${session.compactedSummary}\n\n` : ''}Newer turns to fold in:\n${transcript}`,
            },
          ],
          stream: false,
        },
        { overrideTemp: 0.2, overrideMaxTokens: 900 }
      );
      const resp = await fetch(`${profile.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: buildRequestHeaders(profile),
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(45_000),
      });
      if (resp.ok) {
        const data = await resp.json();
        summary = String(data.choices?.[0]?.message?.content || '').trim();
      }
    } catch (err) {
      console.error('auto-compaction LLM error:', err?.message || err);
    }
  }

  // Fallback extractive summary if LLM summary call fails
  if (!summary) {
    summary = older
      .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
      .slice(-10)
      .map((m) => `- ${m.role}: ${String(m.content).replace(/\s+/g, ' ').slice(0, 140)}`)
      .join('\n');
    if (session.compactedSummary) summary = `${session.compactedSummary}\n${summary}`.slice(-3000);
  }

  session.compactedSummary = summary;
  session.compactedCount = (session.compactedCount || 0) + older.length;
  session.messages = recent;
  session.updatedAt = new Date().toISOString();
  await saveSession(session);

  const afterTokens = estimateSessionTokens(session);
  await logActivity({
    kind: 'system',
    title: `Compacted chat (${reason})`,
    detail: `Folded ${older.length} older message(s): ~${Math.round(beforeTokens / 1000)}k → ~${Math.round(afterTokens / 1000)}k tokens`,
  });
  broadcast({ type: 'session_compacted', sessionId: session.id, folded: older.length, beforeTokens, afterTokens, reason });
  return { compacted: true, folded: older.length, beforeTokens, afterTokens };
}

export async function compactSessionIfNeeded(session, profile) {
  const ctxLen = Number(profile?.contextLength) || 128000;
  const threshold = Math.floor(ctxLen * 0.75);
  const est = estimateSessionTokens(session);
  if (est < threshold) return null;
  return await compactSession(session, { keepRecent: 14, reason: 'auto' });
}

// 100% Append-Only Session Message Builder + Auto-Compaction at 75% of profile.contextLength:
// - Pins session context ONCE onto messages[0] at session start (NEVER mutated on later turns!)
// - Auto-compacts older turns into session.compactedSummary ONLY when exceeding 75% of contextLength
// - Replays exact persisted reasoning + tool_calls + tool results for 100.0% KV prefix match across turns!
export async function prepareSessionChatTurn(session, newUserText, { images = [] } = {}) {
  const profile = await resolveProfile();
  await compactSessionIfNeeded(session, profile);

  const currentMap = await buildContextMap();
  let delta = '';
  if (!session.pinnedContext) {
    session.pinnedContext = formatContextMap(currentMap);
    session.lastContextMap = currentMap;
  } else {
    delta = diffContextMaps(session.lastContextMap, currentMap);
    if (delta) session.lastContextMap = currentMap;
  }

  const llmContent = `${nowTag()}\n${delta ? `<context_update>\n${delta}\n</context_update>\n\n` : ''}${newUserText}`;
  session.messages.push({
    role: 'user',
    content: newUserText,
    llmContent,
    ...(images.length ? { images } : {}),
    ts: new Date().toISOString(),
  });
  if (!session.title || session.title === 'New chat') {
    session.title = String(newUserText || (images.length ? 'Image' : '')).slice(0, 60) || 'New chat';
  }
  session.updatedAt = new Date().toISOString();
  await saveSession(session);

  const windowed = sliceHistoryCacheFriendly(activeHistory(session.messages), { contextLength: profile.contextLength });
  const msgs = windowed.map((m) => toLlmMessage(m, { vision: profile.vision }));
  // The system message is byte-identical in every chat, so the instructions AND the tool list (which many chat
  // templates render after the system text) are prefix-cached across chats. Per-chat state — the context snapshot
  // and any compacted summary — rides on the first user message of the window instead.
  const head = [session.pinnedContext, session.carried || '', session.compactedSummary ? `<compacted_history>\n${session.compactedSummary}\n</compacted_history>` : '']
    .filter(Boolean).join('\n\n');
  if (head) {
    const i = msgs.findIndex((m) => m.role === 'user');
    if (i === -1) msgs.unshift({ role: 'user', content: head });
    else if (Array.isArray(msgs[i].content)) msgs[i] = { ...msgs[i], content: [{ type: 'text', text: head }, ...msgs[i].content] };
    else msgs[i] = { ...msgs[i], content: `${head}\n\n${msgs[i].content}` };
  }
  return [{ role: 'system', content: buildStaticSystemPrompt() }, ...msgs];
}

// Stateless helper (used by /api/v1/chat/completions)
export async function buildChatMessages(history) {
  const profile = await resolveProfile();
  const windowed = sliceHistoryCacheFriendly(history.filter((m) => !m?.cancelled), { contextLength: profile.contextLength });
  // Static system first (shared, cached); the live snapshot rides on the first user message.
  const msgs = windowed.map((m) => ({ role: m.role, content: m.content }));
  const live = await buildLiveContext();
  const i = msgs.findIndex((m) => m.role === 'user');
  if (live && i !== -1 && typeof msgs[i].content === 'string') msgs[i] = { ...msgs[i], content: `${live}\n\n${msgs[i].content}` };
  else if (live) msgs.unshift({ role: 'user', content: live });
  return [{ role: 'system', content: buildStaticSystemPrompt() }, ...msgs];
}

export async function buildSystemPrompt() {
  return buildStaticSystemPrompt();
}

// One streaming completion round (supports abort signal, stalled-stream watchdog & TTFT/cache logging).
// Normalized per-call metrics for plugins (event: llm_response).
function emitLlmMetrics({ profile, source, requestId, usage, ttftMs, totalMs, approxChars = 0, cacheKey = '' }) {
  const completionTokens = usage?.completion_tokens ?? Math.round(approxChars / 3.5);
  emitEvent('llm_response', {
    source,
    requestId: requestId || null,
    profile: profile.profileKey,
    model: profile.model,
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_tokens ?? null,
    tokensEstimated: !usage?.completion_tokens,
    ttftMs,
    totalMs,
    genMs: ttftMs == null ? null : Math.max(1, totalMs - ttftMs), // null for non-streaming calls
    prefixHash: cacheKey,
    at: Date.now(),
  });
  // Keep the last 500 calls in data/llm-metrics.json so cache misses can be diagnosed after the fact.
  const prompt = usage?.prompt_tokens ?? null;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_tokens ?? null;
  const row = { at: new Date().toISOString(), source, requestId: requestId || null, model: profile.model, prompt, cached, uncached: prompt != null && cached != null ? prompt - cached : null, completion: usage?.completion_tokens ?? null, ttftMs, totalMs, prefix: cacheKey };
  updateJson('llm-metrics.json', [], (list) => [...(Array.isArray(list) ? list : []), row].slice(-500)).catch(() => {});
}

export async function* streamCompletion(convo, { withTools, tools = null, model = null, signal = null, source = 'chat', requestId = null } = {}) {
  const profile = await resolveProfile({ overrideModel: model });
  const activeTools = tools || getAllTools();
  const body = buildRequestBody(profile, {
    messages: convo,
    ...(withTools && activeTools.length ? { tools: activeTools, tool_choice: 'auto' } : { tool_choice: 'none' }),
    stream: true,
  });
  // Ask for token usage on the final stream chunk (OpenAI, vLLM, SGLang, llama.cpp, Ollama support it).
  // A profile can opt out with extraBody: { "stream_options": null }.
  if (!('stream_options' in (profile.extraBody || {}))) body.stream_options = { include_usage: true };
  else if (body.stream_options == null) delete body.stream_options;
  const startedAt = Date.now();
  let firstTokenAt = 0;
  let usage = null;
  const sysPrefixHash = crypto
    .createHash('sha1')
    .update(JSON.stringify({ tools: body.tools || null, sys: convo[0]?.content || '' }))
    .digest('hex')
    .slice(0, 8);

  const ac = new AbortController();
  let stallReason = '';
  const onParentAbort = () => { stallReason = 'Stopped by user'; ac.abort(); };
  if (signal) {
    if (signal.aborted) { stallReason = 'Stopped by user'; ac.abort(); }
    else signal.addEventListener('abort', onParentAbort, { once: true });
  }
  // Idle watchdog: 120s max wait for first chunk, then 90s max silence between chunks
  let idleTimer = setTimeout(() => { stallReason = 'LLM response timed out (120s with no output)'; ac.abort(); }, 120_000);
  const bumpWatchdog = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { stallReason = 'LLM stream stalled (90s with no new tokens)'; ac.abort(); }, 90_000);
  };

  let resp;
  try {
    resp = await fetch(`${profile.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildRequestHeaders(profile),
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onParentAbort);
    throw new Error(stallReason || String(err?.message || err));
  }
  if (!resp.ok || !resp.body) {
    clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onParentAbort);
    const text = await resp.text().catch(() => '');
    throw new Error(`LLM request failed (${resp.status}): ${text.slice(0, 500)}`);
  }

  let content = '';
  let reasoning = '';
  let reasoningField = 'reasoning_content';
  const toolCalls = [];
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of resp.body) {
      bumpWatchdog();
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let json;
        try { json = JSON.parse(data); } catch { continue; }
        if (json.usage) usage = json.usage;
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          if (!firstTokenAt) firstTokenAt = Date.now();
          reasoningField = 'reasoning_content';
          reasoning += delta.reasoning_content;
          yield { type: 'reasoning', text: delta.reasoning_content };
        } else if (typeof delta.reasoning === 'string' && delta.reasoning) {
          if (!firstTokenAt) firstTokenAt = Date.now();
          reasoningField = 'reasoning';
          reasoning += delta.reasoning;
          yield { type: 'reasoning', text: delta.reasoning };
        }
        if (delta.content) {
          if (!firstTokenAt) firstTokenAt = Date.now();
          content += delta.content;
          yield { type: 'token', text: delta.content };
        }
        if (delta.tool_calls) {
          if (!firstTokenAt) firstTokenAt = Date.now();
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            toolCalls[i] = toolCalls[i] || { id: '', name: '', arguments: '' };
            if (tc.id) toolCalls[i].id += tc.id;
            if (tc.function?.name) toolCalls[i].name += tc.function.name;
            if (tc.function?.arguments) toolCalls[i].arguments += tc.function.arguments;
          }
        }
      }
    }
  } catch (err) {
    if (stallReason) throw new Error(stallReason);
    throw err;
  } finally {
    clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onParentAbort);
  }
  const totalMs = Date.now() - startedAt;
  const ttftMs = firstTokenAt ? firstTokenAt - startedAt : totalMs;
  const cachedTok = usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_tokens ?? null;
  const ctxK = Math.round((profile.contextLength || 128000) / 1000);
  const usageStr = usage
    ? ` prompt_tok=${usage.prompt_tokens ?? '?'}/${ctxK}k${cachedTok != null ? ` cached=${cachedTok}` : ''}`
    : ` ctx=${ctxK}k`;
  console.log(`[LLM] ${profile.model} ttft=${ttftMs}ms total=${totalMs}ms msgs=${convo.length} sys_prefix=${sysPrefixHash}${usageStr}`);
  emitLlmMetrics({
    profile, source, requestId, usage, ttftMs, totalMs, cacheKey: sysPrefixHash,
    approxChars: content.length + reasoning.length + JSON.stringify(toolCalls || []).length,
  });
  return { content, reasoning, reasoningField, toolCalls };
}

export async function* streamChat(messages, { source = 'chat', maxRounds = CONFIG.maxToolRounds || 100, signal = null, requestId = null } = {}) {
  const convo = [...messages];
  const seenCalls = new Map();
  const recordedEntries = [];
  const visionOn = Boolean((await resolveProfile()).vision);

  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) throw new Error('Stopped by user');
    const { content, reasoning, reasoningField, toolCalls } = yield* streamCompletion(convo, { withTools: true, signal, source, requestId });
    if (toolCalls.length === 0) {
      if (content.trim() || reasoning.trim()) {
        recordedEntries.push({
          role: 'assistant',
          content: content.trim(),
          ...(reasoning ? { reasoning, reasoningField } : {}),
        });
      }
      yield { type: 'record', entries: recordedEntries };
      return;
    }

    const formattedCalls = toolCalls.map((t, i) => ({
      id: t.id || `call_${round}_${i}`,
      type: 'function',
      function: { name: t.name, arguments: t.arguments || '{}' },
    }));

    const assistantMsg = {
      role: 'assistant',
      content: content || null,
      ...(reasoning ? { [reasoningField]: reasoning } : {}),
      tool_calls: formattedCalls,
    };
    convo.push(assistantMsg);
    recordedEntries.push({
      role: 'assistant',
      content: content || null,
      ...(reasoning ? { reasoning, reasoningField } : {}),
      tool_calls: formattedCalls,
    });

    const roundImages = [];
    for (let i = 0; i < toolCalls.length; i++) {
      if (signal?.aborted) throw new Error('Stopped by user');
      const t = toolCalls[i];
      const callId = formattedCalls[i].id;
      let args = {};
      try { args = JSON.parse(t.arguments || '{}'); } catch { args = {}; }
      const key = `${t.name}:${JSON.stringify(args)}`;
      const seen = (seenCalls.get(key) || 0) + 1;
      seenCalls.set(key, seen);
      yield { type: 'tool_start', name: t.name, args };
      let result;
      if (seen >= 3) {
        result = { error: 'You already called this tool with these exact arguments. Answer the user with what you have.' };
      } else {
        try {
          result = await sanitizeToolResult(await runTool(t.name, args, { source }));
        } catch (err) {
          result = { error: String(err?.message || err) };
        }
      }
      const taken = takeImages(result);
      result = taken.result;
      if (taken.images.length && !visionOn && result && typeof result === 'object') result.note = 'The current model profile does not accept images, so you cannot see this image. Say so, or turn on image input for the model in Agent Hub → LLM Engine.';
      for (const img of taken.images) roundImages.push({ ...img, tool: t.name === 'use_tool' && args.tool ? `${args.group || ''} ${args.tool}`.trim() : t.name });
      const serialized = serializeToolResult(result);
      yield { type: 'tool', name: t.name, args, result };
      convo.push({ role: 'tool', tool_call_id: callId, content: serialized });
      recordedEntries.push({ role: 'tool', tool_call_id: callId, name: t.name, args, content: serialized });
    }
    // Images from this round's tools go in one message after all the tool results (the API wants tool results
    // right after the call). Stored like a user image, so the history replays byte-identically (prefix cache).
    if (roundImages.length && visionOn) {
      const entry = { role: 'user', content: `[Image${roundImages.length > 1 ? 's' : ''} from ${[...new Set(roundImages.map((x) => x.tool))].join(', ')}: ${roundImages.map((x) => x.name).join(', ')}]`, images: roundImages.map(({ url, file, mime }) => ({ url, file, mime })), toolImage: true };
      convo.push(toLlmMessage(entry, { vision: true }));
      recordedEntries.push(entry);
    }
  }
  convo.push({ role: 'user', content: 'You reached the tool-call limit. Give your best final answer now.' });
  const finalRound = yield* streamCompletion(convo, { withTools: false, signal, source, requestId });
  if (finalRound.content?.trim() || finalRound.reasoning?.trim()) {
    recordedEntries.push({
      role: 'assistant',
      content: finalRound.content.trim(),
      ...(finalRound.reasoning ? { reasoning: finalRound.reasoning, reasoningField: finalRound.reasoningField } : {}),
    });
  }
  yield { type: 'record', entries: recordedEntries };
}

// Non-streaming full tool-calling agent turn (used by proactive engine, cron jobs, background tasks, sub-agents, webhooks).
export async function runAgentTurn({
  systemPrompt,
  userPrompt,
  maxRounds = 60,
  source = 'proactive',
  isSubagent = false,
  excludeTools = [],
  model = null,
  temperature = 0.4,
}) {
  const agentImages = [];
  const profile = await resolveProfile({ overrideModel: model });
  if (!profile.keyConfigured) throw new Error('API key not configured');
  const convo = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: /<now>|Current local time/i.test(userPrompt) ? userPrompt : `${nowTag()}\n${userPrompt}` },
  ];
  const toolTrace = [];
  const seenCalls = new Map();

  const tools = getAllTools({ exclude: excludeTools });
  for (let round = 0; round < maxRounds; round++) {
    const reqBody = buildRequestBody(
      profile,
      {
        messages: convo,
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
        stream: false,
      },
      { overrideTemp: temperature }
    );
    const callStarted = Date.now();
    const resp = await fetch(`${profile.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildRequestHeaders(profile),
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(600_000), // background steps on local models with big tool results can take minutes
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`LLM failed (${resp.status}): ${txt.slice(0, 300)}`);
    }
    const data = await resp.json();
    const msg = data.choices?.[0]?.message || {};
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    {
      const totalMs = Date.now() - callStarted;
      emitLlmMetrics({ profile, source, requestId: null, usage: data.usage, ttftMs: null, totalMs, approxChars: String(msg.content || '').length + JSON.stringify(toolCalls).length });
    }

    if (toolCalls.length === 0) {
      return { content: String(msg.content || '').trim(), toolTrace };
    }

    convo.push({
      role: 'assistant',
      content: msg.content || null,
      tool_calls: toolCalls,
    });

    for (const tc of toolCalls) {
      const name = tc.function?.name;
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
      const key = `${name}:${JSON.stringify(args)}`;
      const seen = (seenCalls.get(key) || 0) + 1;
      seenCalls.set(key, seen);
      let result;
      if (seen >= 3) {
        result = { error: 'Already called with identical arguments; finish your response now.' };
      } else {
        try {
          result = await runTool(name, args, { source, isSubagent });
        } catch (err) {
          result = { error: String(err?.message || err) };
        }
      }
      const taken = takeImages(await sanitizeToolResult(result));
      result = taken.result;
      for (const img of taken.images) agentImages.push(img);
      toolTrace.push({ name, args, result });
      convo.push({
        role: 'tool',
        tool_call_id: tc.id || `call_${toolTrace.length}`,
        content: serializeToolResult(result),
      });
    }
    if (agentImages.length && profile.vision) convo.push(toLlmMessage({ role: 'user', content: '[Images from the tools above]', images: agentImages.splice(0) }, { vision: true }));
    agentImages.length = 0;
  }

  // Final wrap-up without tools
  convo.push({ role: 'user', content: 'Wrap up and produce your final concise output now.' });
  const wrapBody = buildRequestBody(profile, { messages: convo, stream: false }, { overrideTemp: temperature });
  const resp = await fetch(`${profile.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: buildRequestHeaders(profile),
    body: JSON.stringify(wrapBody),
    signal: AbortSignal.timeout(45_000),
  });
  if (!resp.ok) return { content: '', toolTrace };
  const data = await resp.json();
  return { content: String(data.choices?.[0]?.message?.content || '').trim(), toolTrace };
}

// Fast single-shot JSON helper (uses fastProfile/fastModel if set, else active profile).
// One non-streaming completion; returns the raw text (reasoning blocks stripped). Background jobs use this.
export async function completeText({ system, user, maxTokens = 450, temperature = 0.25, fast = true, timeoutMs = 35_000 }) {
  const profile = await resolveProfile({ fast });
  if (!profile.keyConfigured) return null;
  const reqBody = buildRequestBody(
    profile,
    {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: false,
    },
    { overrideTemp: temperature, overrideMaxTokens: maxTokens }
  );
  const resp = await fetch(`${profile.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: buildRequestHeaders(profile),
    body: JSON.stringify(reqBody),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`LLM call failed (${resp.status})`);
  const data = await resp.json();
  return String(data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// Parse the JSON object in a model reply: a ```json block, else the outermost {...}.
export function parseJsonReply(raw) {
  const text = String(raw || '');
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const outer = text.match(/\{[\s\S]*\}/);
  for (const cand of [...fenced.reverse(), outer?.[0]]) {
    if (!cand) continue;
    try { return JSON.parse(cand); } catch { /* try the next */ }
  }
  return null;
}

export async function completeJson({ system, user, maxTokens = 450, temperature = 0.25, fast = true, timeoutMs = 35_000 }) {
  const raw = await completeText({ system, user, maxTokens, temperature, fast, timeoutMs });
  return raw == null ? null : parseJsonReply(raw);
}

// Wire sub-agent runner into tools.js cleanly without circular import issues.
registerSubagentRunner(runAgentTurn);

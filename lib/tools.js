// Central tool registry + execution with Sentinel approval gating, sandboxed FS, email, jobs, watchers, sub-agents, artifacts & MCP.
import { readFile, writeFile, mkdir, readdir, stat, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { CONFIG, isEmailConfigured, isSmtpConfigured, getPublicSettings, saveRuntimeSettings } from './config.js';
import { getPublicLlmConfig, getLlmConfig, saveLlmConfig } from './llm-config.js';
import { DATA, readJson, writeJson, updateJson, uid, logActivity } from './storage.js';
import { webSearch, webFetch, httpRequest } from './web.js';
import { getEmailStore, syncImapEmails, saveDraft, sendSmtpMail, searchImapMailbox, archiveEmails, findEmail, compactEmailText } from './email.js';
import { syncMs365Emails, sendMs365Mail, isMs365Connected, getPublicMs365Status, searchMs365Mail } from './ms365.js';
import { createWatch, listWatches, deleteWatch } from './watchers.js';
import { addEvent, listEvents, deleteEvent, syncIcsCalendar } from './calendar.js';
import { runPythonCode } from './python.js';
import { getDynamicMcpToolDefs, executeMcpTool, discoverAllMcp, smartAddMcp, getOnDemandServers, getCompactToolDefs, isOnDemandServer, resolveToolGroup } from './mcp.js';
import { requestApproval } from './sentinel.js';
import { listSkills, getSkill, readSkillFile, saveSkill, deleteSkill } from './skills.js';
import { getPluginToolDefs, runPluginTool } from './plugins.js';
import { listHtml, readHtml } from './htmlcache.js';
import { shareUrlFor, shareExistingFile, ensureShareDir } from './share.js';
import { pushNotification, broadcast } from './notifications.js';

let subagentRunner = null;
export function registerSubagentRunner(fn) { subagentRunner = fn; }
let onSettingsChanged = null;
export function registerSettingsReloadHook(fn) { onSettingsChanged = fn; }

// ---------- sandboxed filesystem ----------
function resolveInRoot(p) {
  const root = CONFIG.fsRoot;
  const resolved = path.resolve(root, String(p ?? '.'));
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes the file root (${root})`);
  }
  return resolved;
}
const MAX_READ_BYTES = 200_000;
const MAX_READ_CHARS = 20_000;

async function fsList(dirPath) {
  const dir = resolveInRoot(dirPath || '.');
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries.slice(0, 300)) {
    let size;
    if (e.isFile()) { try { size = (await stat(path.join(dir, e.name))).size; } catch { /* skip */ } }
    out.push({ name: e.name, type: e.isDirectory() ? 'dir' : 'file', ...(size !== undefined ? { size } : {}) });
  }
  return { root: CONFIG.fsRoot, path: dir, entries: out, truncated: entries.length > 300 };
}

async function fsRead(filePath) {
  const file = resolveInRoot(filePath);
  const st = await stat(file);
  if (st.isDirectory()) throw new Error('That is a directory — use list_directory.');
  if (st.size > MAX_READ_BYTES) throw new Error(`File too large (${st.size} bytes, limit ${MAX_READ_BYTES})`);
  const text = await readFile(file, 'utf8');
  return { path: file, truncated: text.length > MAX_READ_CHARS, content: text.slice(0, MAX_READ_CHARS) };
}

async function fsWrite(filePath, content) {
  const file = resolveInRoot(filePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, String(content ?? ''), 'utf8');
  const url = shareUrlFor(file);
  return { ok: true, path: file, bytes: Buffer.byteLength(String(content ?? '')), ...(url ? { url, note: 'Give the user this link (works on phone and desktop), not the local path.' } : {}) };
}

async function fsSearch(query, dirPath) {
  const root = resolveInRoot(dirPath || '.');
  const q = String(query || '').toLowerCase();
  if (!q) throw new Error('query is required');
  const results = [];
  const SKIP = new Set(['node_modules', '.git', '.cache', 'AppData']);
  async function walk(dir, depth) {
    if (depth > 6 || results.length >= 100) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= 100) return;
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else if (e.name.toLowerCase().includes(q)) results.push(path.relative(CONFIG.fsRoot, full));
    }
  }
  await walk(root, 0);
  return { root: CONFIG.fsRoot, query, matches: results, truncated: results.length >= 100 };
}

async function fsDelete(filePath) {
  const file = resolveInRoot(filePath);
  const st = await stat(file);
  if (st.isDirectory()) throw new Error('Refusing to delete a directory.');
  await rm(file);
  return { ok: true, deleted: file };
}

function safeCalculate(expr) {
  const cleaned = String(expr).replace(/\^/g, '**');
  if (!/^[\d+\-*/().\s*%]+$/.test(cleaned)) throw new Error('Only numbers and + - * / % ^ ( ) are allowed.');
  // eslint-disable-next-line no-new-func
  const result = Function(`"use strict"; return (${cleaned});`)();
  if (typeof result !== 'number' || !Number.isFinite(result)) throw new Error('Could not evaluate expression.');
  return result;
}

function runShellCommand(command, cwdRel = '.', timeoutSec = 20) {
  if (!CONFIG.allowShell) throw new Error('Shell command execution is disabled in settings.');
  const cwd = resolveInRoot(cwdRel || '.');
  const isWin = process.platform === 'win32';
  const bin = isWin ? 'powershell.exe' : '/bin/sh';
  const args = isWin ? ['-NoProfile', '-NonInteractive', '-Command', String(command)] : ['-c', String(command)];
  const timeout = Math.min(60, Math.max(2, Number(timeoutSec) || 20)) * 1000;
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, timeout, maxBuffer: 512_000 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        exitCode: err ? (err.code ?? 1) : 0,
        cwd,
        stdout: String(stdout || '').slice(0, 8000),
        stderr: String(stderr || '').slice(0, 4000),
        ...(err?.killed ? { timedOut: true } : {}),
      });
    });
  });
}

// ---------- Artifacts library ----------
const ARTIFACTS_DIR = path.join(DATA, 'artifacts');

export async function listArtifacts() {
  try {
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    const files = await readdir(ARTIFACTS_DIR);
    const items = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const a = JSON.parse(await readFile(path.join(ARTIFACTS_DIR, f), 'utf8'));
        items.push({ id: a.id, title: a.title, type: a.type, createdAt: a.createdAt, updatedAt: a.updatedAt, url: `/artifacts/${a.id}` });
      } catch { /* skip */ }
    }
    return items.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  } catch {
    return [];
  }
}

export async function getArtifact(id) {
  const clean = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clean) return null;
  try {
    return JSON.parse(await readFile(path.join(ARTIFACTS_DIR, `${clean}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export async function deleteArtifact(id) {
  const clean = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clean) return { ok: false };
  await rm(path.join(ARTIFACTS_DIR, `${clean}.json`), { force: true });
  return { ok: true };
}

async function saveArtifact({ title, type = 'html', content }) {
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  const id = uid();
  const now = new Date().toISOString();
  const artifact = {
    id,
    title: String(title || 'Untitled artifact').slice(0, 100),
    type: ['html', 'markdown', 'svg', 'text'].includes(type) ? type : 'html',
    content: String(content || ''),
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(path.join(ARTIFACTS_DIR, `${id}.json`), JSON.stringify(artifact, null, 2), 'utf8');
  return { ok: true, id, title: artifact.title, type: artifact.type, url: `/artifacts/${id}` };
}

// ---------- Core Tool Definitions (compact for fast KV prefix caching) ----------
const fnTool = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

export const BASE_TOOLS = [
  fnTool('get_current_time', 'Get current local date/time.'),
  fnTool('calculate', 'Evaluate arithmetic (+ - * / % ^ ()).', { expression: { type: 'string' } }, ['expression']),
  fnTool('remember', 'Save durable fact about user to long-term memory.', { fact: { type: 'string' } }, ['fact']),
  fnTool('recall_memory', 'List all long-term memories.'),
  fnTool('forget_memory', 'Delete memory matching id or text.', { query: { type: 'string' } }, ['query']),
  fnTool('save_note', 'Create or overwrite a note.', { title: { type: 'string' }, content: { type: 'string' } }, ['title', 'content']),
  fnTool('list_notes', 'List note titles.'),
  fnTool('read_note', 'Read a note by title.', { title: { type: 'string' } }, ['title']),
  fnTool('delete_note', 'Delete a note by title.', { title: { type: 'string' } }, ['title']),
  // Email
  fnTool('check_emails', 'Sync & list recent emails with AI triage.', {
    unread_only: { type: 'boolean' },
    important_only: { type: 'boolean' },
    sync_now: { type: 'boolean' },
    limit: { type: 'number' },
  }),
  fnTool('read_email', 'Read an email by id. Long tracking links are shortened to [link:domain] (unsubscribe/manage links stay whole); pass full_links to get every URL. Very long bodies are cut — use offset to read on.', {
    id: { type: 'string' }, full_links: { type: 'boolean' }, offset: { type: 'number', description: 'character offset to continue a long body' },
  }, ['id']),
  fnTool('search_emails', 'Search the WHOLE mailbox history (Gmail incl. archived mail + Microsoft 365), not just the recent inbox. query uses Gmail/Outlook syntax: OR, "exact phrase", from:, subject:. since/before are YYYY-MM-DD. Set body_chars (e.g. 600) to get body text to extract amounts, due dates, order numbers. For bills/receipts/subscriptions search e.g. invoice OR bill OR statement OR receipt OR "payment due" OR subscription OR 請求 OR 領収 over the period asked, then read_email only where the excerpt is not enough.', {
    query: { type: 'string', description: 'keywords; OR between alternatives' },
    from: { type: 'string', description: 'sender name, address or domain' },
    since: { type: 'string', description: 'YYYY-MM-DD (inclusive)' },
    before: { type: 'string', description: 'YYYY-MM-DD (exclusive)' },
    limit: { type: 'number', description: 'max results, default 20, max 50' },
    body_chars: { type: 'number', description: 'include the first N chars of each body (0-2000, default 0)' },
    recent_only: { type: 'boolean', description: 'only search the locally synced recent inbox (fast, offline)' },
  }),
  fnTool('draft_email', 'Save an email draft for review.', {
    to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, reply_to_id: { type: 'string' },
  }, ['to', 'subject', 'body']),
  fnTool('send_email', 'Send email via SMTP or Microsoft 365 Graph (Sentinel gated).', {
    to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, in_reply_to: { type: 'string' },
    provider: { type: 'string', enum: ['auto', 'smtp', 'microsoft365'] },
  }, ['to', 'subject', 'body']),
  // Web & HTTP
  fnTool('web_search', 'Search the web; returns titles, URLs, snippets.', { query: { type: 'string' }, max_results: { type: 'number' } }, ['query']),
  fnTool('web_fetch', 'Fetch readable text from a URL.', { url: { type: 'string' } }, ['url']),
  fnTool('http_request', 'HTTP request (writes require Sentinel approval).', {
    url: { type: 'string' },
    method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
    headers: { type: 'object' },
    body: {},
  }, ['url']),
  // Files & Python
  fnTool('list_directory', 'List files inside sandboxed file root.', { path: { type: 'string' } }, ['path']),
  fnTool('read_file', 'Read text file inside file root.', { path: { type: 'string' } }, ['path']),
  fnTool('write_file', 'Write text file inside file root.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  fnTool('search_files', 'Search filenames under file root.', { query: { type: 'string' }, path: { type: 'string' } }, ['query']),
  fnTool('delete_file', 'Delete file inside file root (Sentinel gated).', { path: { type: 'string' } }, ['path']),
  fnTool('run_python', 'Run Python 3 script for math/CSV/charts (output files in cwd auto-served; Sentinel gated).', {
    code: { type: 'string' }, timeout_sec: { type: 'number' }, cwd: { type: 'string' },
  }, ['code']),
  fnTool('run_command', 'Run shell command in file root (Sentinel gated).', {
    command: { type: 'string' }, cwd: { type: 'string' }, timeout_sec: { type: 'number' },
  }, ['command']),
  // Reminders & Calendar
  fnTool('set_reminder', 'Set reminder via due_in_minutes or ISO due_at.', {
    text: { type: 'string' }, due_in_minutes: { type: 'number' }, due_at: { type: 'string' },
  }, ['text']),
  fnTool('list_reminders', 'List pending reminders.'),
  fnTool('complete_reminder', 'Complete a reminder by id or text.', { query: { type: 'string' } }, ['query']),
  fnTool('delete_reminder', 'Delete a reminder by id or text.', { query: { type: 'string' } }, ['query']),
  fnTool('add_event', 'Add event/reservation/flight to calendar.', {
    title: { type: 'string' }, start_at: { type: 'string' }, end_at: { type: 'string' },
    location: { type: 'string' }, notes: { type: 'string' }, category: { type: 'string' },
  }, ['title', 'start_at']),
  fnTool('list_events', 'List upcoming calendar events.', { days: { type: 'number' }, include_past: { type: 'boolean' } }),
  fnTool('delete_event', 'Delete calendar event by id or title.', { query: { type: 'string' } }, ['query']),
  fnTool('sync_calendar', 'Refresh external iCal (.ics) calendar feed.'),
  // Tasks, Jobs, Watches, Sub-agent, Artifacts, MCP, Notify
  fnTool('create_task', 'Create autonomous background to-do/research task.', {
    title: { type: 'string' }, plan: { type: 'string' }, auto_execute: { type: 'boolean' },
  }, ['title']),
  fnTool('update_task', 'Log progress on an open task.', { title: { type: 'string' }, progress: { type: 'string' }, plan: { type: 'string' } }, ['title', 'progress']),
  fnTool('list_tasks', 'List background tasks.'),
  fnTool('complete_task', 'Complete a task with outcome summary.', { title: { type: 'string' }, outcome: { type: 'string' } }, ['title', 'outcome']),
  fnTool('schedule_job', 'Schedule recurring routine via 5-field cron or interval_minutes.', {
    name: { type: 'string' }, prompt: { type: 'string' }, cron: { type: 'string' }, interval_minutes: { type: 'number' }, notify: { type: 'boolean' },
  }, ['name', 'prompt']),
  fnTool('list_jobs', 'List recurring scheduled jobs.'),
  fnTool('delete_job', 'Delete scheduled job by id or name.', { query: { type: 'string' } }, ['query']),
  fnTool('create_watch', 'Monitor URL, RSS feed, or search topic for changes.', {
    name: { type: 'string' }, type: { type: 'string', enum: ['url', 'rss', 'search'] },
    target: { type: 'string' }, interval_minutes: { type: 'number' }, criteria: { type: 'string' },
  }, ['name', 'type', 'target']),
  fnTool('list_watches', 'List active watchers.'),
  fnTool('delete_watch', 'Delete watcher by id or name.', { query: { type: 'string' } }, ['query']),
  fnTool('spawn_subagent', 'Delegate deep research/planning to an isolated specialist sub-agent.', {
    role: { type: 'string' }, task: { type: 'string' },
  }, ['role', 'task']),
  fnTool('save_artifact', 'Save standalone HTML/SVG/Markdown artifact and get URL. To keep an HTML page you already wrote, pass from_html_id instead of content.', {
    title: { type: 'string' }, type: { type: 'string', enum: ['html', 'markdown', 'svg', 'text'] }, content: { type: 'string' },
    from_html_id: { type: 'string', description: 'id from list_recent_html (e.g. h1a2b3c4d)' },
  }, ['title']),
  fnTool('list_recent_html', 'List HTML pages / three.js scenes you previously wrote in chat (auto-saved). Use before rebuilding something similar.', {
    query: { type: 'string', description: 'filter by title or id' }, limit: { type: 'number' }, kind: { type: 'string', enum: ['html', 'threejs'] },
  }),
  fnTool('read_recent_html', 'Read the full code of an auto-saved HTML page / three.js scene so you can edit or reuse it.', { id: { type: 'string' } }, ['id']),
  fnTool('share_file', 'Put a file into Pond Share so the user can open it on any device (phone too) and get its /share/ link. Use for an existing file (path inside the file root), or an auto-saved chat page (from_html_id). Local paths like C:\\… only open on the computer itself.', {
    path: { type: 'string', description: 'existing file inside the file root' },
    from_html_id: { type: 'string', description: 'auto-saved chat HTML id (e.g. h1a2b3c4d) to publish as a page' },
    name: { type: 'string', description: 'file name in Pond Share, e.g. sales-dashboard.html (optional)' },
  }),
  fnTool('list_artifacts', 'List saved artifacts.'),
  fnTool('list_skills', 'List saved skills (reusable procedures) with descriptions.'),
  fnTool('use_skill', 'Load a saved skill\'s instructions. Call BEFORE doing a task that matches a skill, then follow it step by step (re-fetch fresh data; never reuse stale numbers).', { name: { type: 'string' } }, ['name']),
  fnTool('read_skill_file', 'Read a resource file bundled with a skill (e.g. template.html).', { name: { type: 'string' }, file: { type: 'string' } }, ['name', 'file']),
  fnTool('save_skill', 'Create/update a reusable skill when the user wants to reuse a workflow, report or dashboard. Write instructions as a re-runnable recipe: goal, data sources & exact tools to call, steps, output format, and where the template is. Use from_artifact_id to bundle an existing artifact as a template file instead of re-typing it (Sentinel approval).', {
    name: { type: 'string', description: 'short kebab-case English id, e.g. mission-control-dashboard' },
    description: { type: 'string', description: 'one line: what it does and when to use it' },
    instructions: { type: 'string', description: 'Markdown recipe' },
    files: { type: 'object', description: 'optional { "filename.ext": "content" } resources' },
    from_artifact_id: { type: 'string', description: 'optional artifact id (or auto-saved html id like h1a2b3c4d) to save as a template file' },
    artifact_file: { type: 'string', description: 'file name for the artifact template (default template.html)' },
  }, ['name', 'description', 'instructions']),
  fnTool('delete_skill', 'Delete a saved skill (Sentinel approval).', { name: { type: 'string' } }, ['name']),
  fnTool('read_artifact', 'Read saved artifact by id.', { id: { type: 'string' } }, ['id']),
  fnTool('discover_mcp', 'Auto-discover local MCP servers and presets.'),
  fnTool('connect_mcp', 'Auto-connect MCP from URL/command/package/JSON (Sentinel gated).', { input: { type: 'string' }, name: { type: 'string' } }, ['input']),
  fnTool('get_settings', 'Read current Pond settings, email/Microsoft 365 status, and LLM profiles (secrets masked).'),
  fnTool('update_settings', 'Update Pond own settings live (proactive mode/intervals, userLocation, email VIPs/keywords/pollIntervalMin, calendar iCal URL, Sentinel policies, or LLM activeProfile/reasoningEffort).', {
    userLocation: { type: 'string' },
    proactive: { type: 'object' },
    email: { type: 'object' },
    calendar: { type: 'object' },
    sentinel: { type: 'object' },
    persona: { type: 'object', description: 'Your personality/tone: { preset: default|casual|concise|playful|custom, custom: "free text" } — only when the user asks' },
    assistantName: { type: 'string' },
    llm: { type: 'object', description: 'Optional { activeProfile, fastProfile, reasoningEffort, model }' },
  }),
  fnTool('notify_user', 'Send immediate desktop/browser notification.', {
    title: { type: 'string' }, message: { type: 'string' }, urgency: { type: 'string', enum: ['normal', 'high', 'critical'] },
  }, ['title', 'message']),
];

const BROWSERISH = /chrome|browser|playwright|puppeteer/i;
// Two fixed entries stand in for every on-demand tool set (e.g. Chrome DevTools' 33 tools ≈ 8.8k tokens).
// Their text depends only on configuration, never on what a chat has loaded or on connection status, so the
// tool list — which chat templates put at the very top of the prompt — is identical on every request.
function onDemandToolDefs(servers) {
  const list = servers.map((s) => `${s}${BROWSERISH.test(s) ? ' (browser automation: live/JS-rendered pages, logins, forms, bookings, screenshots)' : ''}`).join('; ');
  return [
    fnTool('load_tools', `Get the tools of a tool set: ${list}. Returns their names and parameters; then call them with use_tool. Call once per chat (again only if they are no longer in the conversation).`, {
      group: { type: 'string', enum: servers },
    }, ['group']),
    fnTool('use_tool', 'Call a tool from a set you loaded with load_tools.', {
      group: { type: 'string', enum: servers },
      tool: { type: 'string', description: 'tool name from load_tools' },
      arguments: { type: 'object', description: 'parameters as listed by load_tools' },
    }, ['group', 'tool']),
  ];
}

export function getAllTools({ exclude = [] } = {}) {
  const mcpDefs = getDynamicMcpToolDefs()
    .filter((d) => !isOnDemandServer(d._mcp.serverName)) // only servers set to loadMode "always"
    .map(({ _mcp, ...def }) => def)
    .sort((a, b) => a.function.name.localeCompare(b.function.name));
  const servers = getOnDemandServers();
  const all = [...BASE_TOOLS, ...(servers.length ? onDemandToolDefs(servers) : []), ...mcpDefs, ...getPluginToolDefs()]; // plugin tools last, sorted: core prefix stays stable
  const ex = new Set(exclude);
  if (!CONFIG.allowShell) ex.add('run_command');
  if (CONFIG.python?.enabled === false) ex.add('run_python');
  if (!ex.size) return all;
  return all.filter((t) => !ex.has(t.function.name));
}

export async function runTool(name, args = {}, context = {}) {
  // Sentinel permission gate (Muse-style out-of-band approval for side-effecting tools)
  const gate = await requestApproval(name, args, context);
  if (!gate.allowed) {
    return { error: gate.reason || 'Action denied by Sentinel.' };
  }

  if (name === 'load_tools') {
    const g = resolveToolGroup(args.group);
    if (!g) return { error: `Unknown tool set "${args.group}". Available: ${getOnDemandServers().join(', ') || 'none'}` };
    const tools = getCompactToolDefs(g);
    if (tools.error) return tools;
    return { group: g, how: `Call with use_tool({ group: "${g}", tool: "<name>", arguments: {…} }). Params: type, "?" = optional.`, tools };
  }
  if (name === 'use_tool') {
    const g = resolveToolGroup(args.group);
    if (!g) return { error: `Unknown tool set "${args.group}". Available: ${getOnDemandServers().join(', ') || 'none'}` };
    const short = String(args.tool || '').replace(new RegExp(`^mcp_${g}_`), '');
    const fn = `mcp_${g}_${short.toLowerCase().replace(/[^a-z0-9_]+/g, '_')}`;
    if (!getDynamicMcpToolDefs().some((d) => d.function.name === fn)) return { error: `No tool "${args.tool}" in ${g}. Call load_tools({ group: "${g}" }) to see the list.` };
    let a = args.arguments; if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = {}; } }
    return runTool(fn, a && typeof a === 'object' ? a : {}, context); // Sentinel checks the real tool name
  }

  // Plugin tools (fault-isolated)
  if (name.startsWith('plugin_')) {
    return await runPluginTool(name, args, context);
  }

  // Dynamic MCP tools
  if (name.startsWith('mcp_')) {
    return await executeMcpTool(name, args);
  }

  switch (name) {
    case 'web_search':
      return await webSearch(String(args.query || ''), args.max_results);
    case 'web_fetch':
      return await webFetch(String(args.url || ''));
    case 'http_request':
      return await httpRequest({
        url: args.url,
        method: args.method || 'GET',
        headers: args.headers || {},
        body: args.body,
      });
    case 'list_directory':
      return await fsList(args.path);
    case 'read_file':
      return await fsRead(args.path);
    case 'write_file':
      return await fsWrite(args.path, args.content);
    case 'search_files':
      return await fsSearch(args.query, args.path);
    case 'delete_file':
      return await fsDelete(args.path);
    case 'run_python':
      return await runPythonCode({ code: args.code, timeoutSec: args.timeout_sec, cwd: args.cwd });
    case 'run_command':
      return await runShellCommand(args.command, args.cwd, args.timeout_sec);
    case 'get_current_time':
      return {
        now: new Date().toString(),
        iso: new Date().toISOString(),
        dayOfWeek: new Date().toLocaleDateString('en-US', { weekday: 'long' }),
      };
    case 'calculate':
      return { expression: args.expression, result: safeCalculate(args.expression) };

    // Memory
    case 'remember': {
      const fact = String(args.fact || '').trim();
      if (!fact) return { error: 'fact is required' };
      await updateJson('memory.json', [], (mem) => {
        const arr = Array.isArray(mem) ? mem : [];
        if (arr.some((m) => m.fact.toLowerCase() === fact.toLowerCase())) return arr;
        arr.push({ id: uid(), fact, createdAt: new Date().toISOString() });
        return arr;
      });
      return { ok: true, stored: fact };
    }
    case 'recall_memory': {
      const mem = await readJson('memory.json', []);
      return { memories: mem };
    }
    case 'forget_memory': {
      const q = String(args.query || '').toLowerCase();
      let removed = 0;
      await updateJson('memory.json', [], (mem) => {
        const arr = Array.isArray(mem) ? mem : [];
        const next = arr.filter((m) => !(m.id === args.query || m.fact.toLowerCase().includes(q)));
        removed = arr.length - next.length;
        return next;
      });
      return { ok: true, removed };
    }

    // Notes
    case 'save_note': {
      const title = String(args.title || '').trim();
      await updateJson('notes.json', [], (notes) => {
        const arr = Array.isArray(notes) ? notes : [];
        const i = arr.findIndex((n) => n.title.toLowerCase() === title.toLowerCase());
        const note = { id: i >= 0 ? arr[i].id : uid(), title, content: String(args.content || ''), updatedAt: new Date().toISOString() };
        if (i >= 0) arr[i] = note; else arr.push(note);
        return arr;
      });
      return { ok: true, title };
    }
    case 'list_notes': {
      const notes = await readJson('notes.json', []);
      return { notes: notes.map((n) => ({ title: n.title, updatedAt: n.updatedAt })) };
    }
    case 'read_note': {
      const notes = await readJson('notes.json', []);
      const n = notes.find((x) => x.title.toLowerCase() === String(args.title || '').toLowerCase());
      return n ? { title: n.title, content: n.content } : { error: 'Note not found' };
    }
    case 'delete_note': {
      let deleted = 0;
      await updateJson('notes.json', [], (notes) => {
        const arr = Array.isArray(notes) ? notes : [];
        const next = arr.filter((x) => x.title.toLowerCase() !== String(args.title || '').toLowerCase());
        deleted = arr.length - next.length;
        return next;
      });
      return { ok: true, deleted };
    }

    // Emails
    case 'check_emails': {
      if (args.sync_now !== false) {
        if (isEmailConfigured()) await syncImapEmails({ limit: 15 });
        if (await isMs365Connected()) await syncMs365Emails({ limit: 15 });
      }
      const store = await getEmailStore();
      let items = (store.items || []).filter((m) => !m.dismissed);
      if (args.unread_only) items = items.filter((m) => m.unread);
      if (args.important_only) items = items.filter((m) => m.importance?.important);
      const limit = Math.max(1, Math.min(30, Number(args.limit) || 10));
      const ms = await getPublicMs365Status();
      return {
        imapConfigured: isEmailConfigured(),
        microsoft365Connected: ms.connected,
        microsoft365Account: ms.accountEmail || null,
        lastSyncAt: store.lastSyncAt,
        lastError: store.lastError || ms.lastError,
        total: items.length,
        emails: items.slice(0, limit).map((m) => ({
          id: m.id,
          account: m.account || m.source || 'imap',
          from: m.from,
          subject: m.subject,
          date: m.date,
          unread: m.unread,
          snippet: compactEmailText(m.snippet).slice(0, 200),
          importance: m.importance || null,
        })),
      };
    }
    case 'read_email': {
      const m = await findEmail(args.id);
      if (!m) return { error: `Email "${args.id}" not found` };
      const full = compactEmailText(m.body, { fullLinks: Boolean(args.full_links) });
      const start = Math.max(0, Math.min(full.length, Number(args.offset) || 0));
      const MAX = 6000;
      const body = full.slice(start, start + MAX);
      return {
        id: m.id,
        from: m.from,
        to: m.to,
        subject: m.subject,
        date: m.date,
        messageId: m.messageId,
        body,
        ...(start + MAX < full.length ? { truncated: true, nextOffset: start + MAX, totalChars: full.length } : {}),
        importance: m.importance || null,
      };
    }
    case 'search_emails': {
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
      const bodyChars = Math.max(0, Math.min(2000, Number(args.body_chars) || 0));
      const opts = { query: String(args.query || ''), from: String(args.from || ''), since: args.since || '', before: args.before || '', limit };
      // recent inbox (local): any OR-term must match, plus sender/date filters
      const terms = opts.query.split(/\s+OR\s+/i).map((x) => x.replace(/^(from|subject|to):/i, '').replace(/^["(](.*)[")]$/, '$1').trim().toLowerCase()).filter(Boolean);
      const sinceT = args.since ? Date.parse(args.since) : NaN; const beforeT = args.before ? Date.parse(args.before) : NaN;
      const store = await getEmailStore();
      const local = (store.items || []).filter((m) => {
        const hay = `${m.from} ${m.subject} ${m.body}`.toLowerCase(); const t = Date.parse(m.date);
        return (!terms.length || terms.some((q) => hay.includes(q)))
          && (!opts.from || String(m.from).toLowerCase().includes(opts.from.toLowerCase()))
          && (Number.isNaN(sinceT) || t >= sinceT) && (Number.isNaN(beforeT) || t < beforeT);
      });
      const found = []; const errors = []; const searched = ['recent inbox'];
      if (!args.recent_only) {
        const jobs = [];
        if (isEmailConfigured()) {
          searched.push(`mailbox ${CONFIG.email.imapUser}`);
          jobs.push(searchImapMailbox(opts).then((r) => found.push(...(r.emails || []))).catch((e) => errors.push(`IMAP: ${e.message || e}`)));
        }
        if (await isMs365Connected()) {
          searched.push('Microsoft 365 mailbox');
          jobs.push(searchMs365Mail(opts).then((r) => found.push(...(r.emails || []))).catch((e) => errors.push(`Microsoft 365: ${e.message || e}`)));
        }
        await Promise.all(jobs);
        await archiveEmails(found).catch(() => {});
      }
      // merge (same message can be in the recent inbox and the mailbox search), newest first
      const seen = new Set(); const all = [];
      for (const m of [...found, ...local]) {
        const k = m.messageId || m.id;
        if (seen.has(k) || seen.has(m.id)) continue;
        seen.add(k); seen.add(m.id); all.push(m);
      }
      all.sort((x, y) => String(y.date).localeCompare(String(x.date)));
      let budget = 45_000; // keep the tool result small enough for the model's context
      const page = all.slice(0, limit);
      const multiAccount = new Set(page.map((m) => m.source || 'imap')).size > 1;
      const emails = page.map((m) => {
        // compact rows: date only, account only when results mix accounts, short preview
        const o = { id: m.id, date: String(m.date || '').slice(0, 10), from: String(m.from || '').replace(/^"(.*)"(\s*<)/, '$1$2'), subject: m.subject, snippet: compactEmailText(m.snippet).slice(0, 160) };
        if (multiAccount) o.acct = m.source === 'microsoft365' ? 'ms365' : 'gmail';
        if (m.hasAttachments) o.hasAttachments = true;
        if (bodyChars && budget > 0) { const body = compactEmailText(m.body).slice(0, Math.min(bodyChars, budget)); o.body = body; budget -= body.length; }
        return o;
      });
      return { query: opts.query, from: opts.from || undefined, since: opts.since || undefined, before: opts.before || undefined, searched, count: emails.length, totalFound: all.length, emails, ...(errors.length ? { errors } : {}), ...(all.length > limit ? { note: `More matches exist — narrow the date range or raise limit (max 50).` } : {}) };
    }
    case 'draft_email': {
      const draft = await saveDraft({
        to: args.to,
        subject: args.subject,
        body: args.body,
        replyToId: args.reply_to_id || null,
      });
      return { ok: true, draft };
    }
    case 'send_email': {
      const pref = String(args.provider || 'auto').toLowerCase();
      const msReady = await isMs365Connected();
      if (pref === 'microsoft365' || (pref === 'auto' && !isSmtpConfigured() && msReady)) {
        return await sendMs365Mail({ to: args.to, subject: args.subject, body: args.body });
      }
      return await sendSmtpMail({
        to: args.to,
        subject: args.subject,
        body: args.body,
        inReplyTo: args.in_reply_to || '',
      });
    }

    // Reminders
    case 'set_reminder': {
      let dueAt;
      if (args.due_at) dueAt = new Date(args.due_at);
      else if (typeof args.due_in_minutes === 'number') dueAt = new Date(Date.now() + args.due_in_minutes * 60_000);
      else dueAt = new Date(Date.now() + 60 * 60_000);
      if (Number.isNaN(dueAt.getTime())) throw new Error('Invalid due date');
      const reminder = { id: uid(), text: String(args.text), dueAt: dueAt.toISOString(), done: false, createdAt: new Date().toISOString() };
      await updateJson('reminders.json', [], (r) => [...(Array.isArray(r) ? r : []), reminder]);
      return { ok: true, reminder };
    }
    case 'list_reminders': {
      const reminders = await readJson('reminders.json', []);
      return { reminders: reminders.filter((r) => !r.done) };
    }
    case 'complete_reminder': {
      const q = String(args.query || '').toLowerCase();
      let completed = null;
      await updateJson('reminders.json', [], (reminders) => {
        const arr = Array.isArray(reminders) ? reminders : [];
        const r = arr.find((x) => !x.done && (x.id === args.query || x.text.toLowerCase().includes(q)));
        if (r) { r.done = true; completed = r.text; }
        return arr;
      });
      return completed ? { ok: true, completed } : { error: `No pending reminder matching "${args.query}"` };
    }
    case 'delete_reminder': {
      const q = String(args.query || '').toLowerCase();
      let deleted = [];
      await updateJson('reminders.json', [], (reminders) => {
        const arr = Array.isArray(reminders) ? reminders : [];
        const match = (x) => x.id === args.query || x.text.toLowerCase().includes(q);
        deleted = arr.filter(match).map((r) => r.text);
        return arr.filter((x) => !match(x));
      });
      return deleted.length ? { ok: true, deleted } : { error: `No reminder matching "${args.query}"` };
    }

    // Calendar & Events
    case 'add_event':
      return {
        ok: true,
        event: await addEvent({
          title: args.title,
          startAt: args.start_at,
          endAt: args.end_at,
          location: args.location,
          notes: args.notes,
          category: args.category,
        }),
      };
    case 'list_events':
      return {
        events: await listEvents({
          upcomingOnly: !args.include_past,
          days: Number(args.days) || 14,
        }),
      };
    case 'delete_event':
      return await deleteEvent(args.query);
    case 'sync_calendar':
      return await syncIcsCalendar();

    // Background Tasks
    case 'create_task': {
      const task = {
        id: uid(),
        title: String(args.title),
        plan: String(args.plan || ''),
        status: 'in_progress',
        autoExecute: args.auto_execute !== false,
        progress: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await updateJson('tasks.json', [], (tasks) => [...(Array.isArray(tasks) ? tasks : []), task]);
      await logActivity({ kind: 'task', title: `Task created: ${task.title}`, detail: task.plan });
      return { ok: true, task };
    }
    case 'update_task': {
      const q = String(args.title || '').toLowerCase();
      let updated = null;
      await updateJson('tasks.json', [], (tasks) => {
        const arr = Array.isArray(tasks) ? tasks : [];
        const t = arr.find((x) => x.status !== 'done' && (x.id === args.title || x.title.toLowerCase().includes(q)));
        if (t) {
          t.progress = Array.isArray(t.progress) ? t.progress : [];
          t.progress.push({ ts: new Date().toISOString(), note: String(args.progress || '') });
          if (args.plan) t.plan = String(args.plan);
          t.updatedAt = new Date().toISOString();
          updated = t;
        }
        return arr;
      });
      return updated ? { ok: true, task: updated } : { error: 'No matching open task found' };
    }
    case 'list_tasks': {
      const tasks = await readJson('tasks.json', []);
      return { tasks };
    }
    case 'complete_task': {
      const q = String(args.title || '').toLowerCase();
      let doneTask = null;
      await updateJson('tasks.json', [], (tasks) => {
        const arr = Array.isArray(tasks) ? tasks : [];
        const t = arr.find((x) => x.status !== 'done' && (x.id === args.title || x.title.toLowerCase().includes(q)));
        if (t) {
          t.status = 'done';
          t.outcome = String(args.outcome || '');
          t.completedAt = new Date().toISOString();
          t.updatedAt = t.completedAt;
          doneTask = t;
        }
        return arr;
      });
      if (!doneTask) return { error: 'No matching open task found' };
      await logActivity({ kind: 'task', title: `Task completed: ${doneTask.title}`, detail: doneTask.outcome });
      return { ok: true, task: doneTask };
    }

    // Scheduled Jobs
    case 'schedule_job': {
      if (!args.cron && !args.interval_minutes) {
        return { error: 'Provide either a 5-field cron expression or interval_minutes.' };
      }
      const job = {
        id: uid(),
        name: String(args.name || 'Scheduled job').slice(0, 80),
        prompt: String(args.prompt || ''),
        cron: args.cron ? String(args.cron).trim() : null,
        intervalMin: args.interval_minutes ? Math.max(1, Number(args.interval_minutes)) : null,
        notify: args.notify !== false,
        enabled: true,
        lastRunAt: null,
        lastStatus: null,
        lastOutput: '',
        createdAt: new Date().toISOString(),
      };
      await updateJson('jobs.json', [], (jobs) => [job, ...(Array.isArray(jobs) ? jobs : [])]);
      await logActivity({ kind: 'job', title: `Scheduled job: ${job.name}`, detail: job.cron || `every ${job.intervalMin}m` });
      return { ok: true, job };
    }
    case 'list_jobs': {
      const jobs = await readJson('jobs.json', []);
      return { jobs };
    }
    case 'delete_job': {
      const q = String(args.query || '').toLowerCase();
      let removed = 0;
      await updateJson('jobs.json', [], (jobs) => {
        const arr = Array.isArray(jobs) ? jobs : [];
        const next = arr.filter((j) => !(j.id === args.query || j.name.toLowerCase().includes(q)));
        removed = arr.length - next.length;
        return next;
      });
      return { ok: true, deleted: removed };
    }

    // Watchers
    case 'create_watch':
      return {
        ok: true,
        watch: await createWatch({
          name: args.name,
          type: args.type,
          target: args.target,
          intervalMin: args.interval_minutes,
          criteria: args.criteria,
        }),
      };
    case 'list_watches':
      return { watches: await listWatches() };
    case 'delete_watch':
      return await deleteWatch(args.query);

    // Sub-Agent Delegation
    case 'spawn_subagent': {
      if (context.isSubagent) {
        return { error: 'Sub-agents cannot spawn nested sub-agents.' };
      }
      if (!subagentRunner) return { error: 'Sub-agent runner not initialized' };
      const role = String(args.role || 'Specialist Agent').slice(0, 60);
      const task = String(args.task || '');
      await logActivity({ kind: 'subagent', title: `Sub-agent launched: ${role}`, detail: task.slice(0, 300) });
      const res = await subagentRunner({
        systemPrompt: `You are a focused specialist sub-agent acting as: ${role}. Complete the delegated task thoroughly using your tools, and return a crisp, high-signal report with sources/evidence.`,
        userPrompt: task,
        maxRounds: 60,
        source: 'subagent',
        isSubagent: true,
        excludeTools: ['spawn_subagent', 'notify_user'],
      });
      await logActivity({ kind: 'subagent', title: `Sub-agent finished: ${role}`, detail: (res.content || '').slice(0, 300) });
      return { ok: true, role, toolsUsed: res.toolTrace.map((t) => t.name), report: res.content };
    }

    // Artifacts
    case 'save_artifact': {
      let content = args.content;
      if (!content && args.from_html_id) {
        const h = await readHtml(args.from_html_id);
        if (!h) return { error: `No saved HTML with id ${args.from_html_id}` };
        if (h.kind !== 'html') return { error: 'three.js scenes cannot be saved as artifacts yet; save the HTML version instead' };
        content = h.content;
      }
      if (!content) return { error: 'content or from_html_id is required' };
      return await saveArtifact({ title: args.title, type: args.from_html_id ? 'html' : args.type, content });
    }
    case 'share_file': {
      if (args.from_html_id) {
        const h = await readHtml(args.from_html_id);
        if (!h || h.kind !== 'html') return { error: `No saved HTML page with id ${args.from_html_id}` };
        const base = String(args.name || h.title || h.id).replace(/[^A-Za-z0-9 ._-]+/g, '-').replace(/^[-. ]+|[-. ]+$/g, '').slice(0, 80) || h.id;
        const file = resolveInRoot(path.join(path.relative(CONFIG.fsRoot, CONFIG.shareDir), /\.html?$/i.test(base) ? base : `${base}.html`));
        await ensureShareDir();
        await writeFile(file, h.content, 'utf8');
        return { ok: true, path: file, url: shareUrlFor(file) };
      }
      if (!args.path) return { error: 'path or from_html_id is required' };
      const src = resolveInRoot(args.path);
      if ((await stat(src)).isDirectory()) return { error: 'share_file shares single files (put a folder\'s files in Pond Share instead)' };
      const dest = await shareExistingFile(src, args.name);
      return { ok: true, path: dest, url: shareUrlFor(dest), note: 'Copied; relative assets (css/js/images) next to the original must be shared too.' };
    }
    case 'list_recent_html':
      return { items: await listHtml(args) };
    case 'read_recent_html': {
      const h = await readHtml(args.id);
      return h ? { id: h.id, kind: h.kind, title: h.title, createdAt: h.createdAt, content: h.content, url: h.kind === 'html' ? `/html/${h.id}` : null } : { error: `No saved HTML with id ${args.id}` };
    }
    case 'list_artifacts':
      return { artifacts: await listArtifacts() };

    // Skills (reusable procedures)
    case 'list_skills':
      return { skills: (await listSkills()).map(({ name, description, files }) => ({ name, description, files })) };
    case 'use_skill': {
      const sk = await getSkill(args.name);
      if (!sk) return { error: `Skill "${args.name}" not found`, available: (await listSkills()).map((s) => s.name) };
      await logActivity({ kind: 'skill', title: `Using skill: ${sk.name}`, detail: sk.description });
      return { name: sk.name, description: sk.description, files: sk.files, instructions: sk.instructions, note: sk.files.length ? 'Use read_skill_file(name, file) to load bundled files.' : undefined };
    }
    case 'read_skill_file':
      return await readSkillFile(args.name, args.file);
    case 'save_skill': {
      const files = { ...(args.files && typeof args.files === 'object' ? args.files : {}) };
      if (args.from_artifact_id) {
        const h = /^h[0-9a-f]{8}$/.test(args.from_artifact_id) ? await readHtml(args.from_artifact_id) : null; // auto-saved chat HTML works too
        const a = h ? { type: h.kind === 'html' ? 'html' : 'text', content: h.content } : await getArtifact(args.from_artifact_id);
        if (!a) return { error: `Artifact ${args.from_artifact_id} not found` };
        const ext = a.type === 'markdown' ? '.md' : a.type === 'svg' ? '.svg' : a.type === 'text' ? '.txt' : '.html';
        files[args.artifact_file || `template${ext}`] = a.content;
      }
      const r = await saveSkill({ name: args.name, description: args.description, instructions: args.instructions, files });
      if (r.ok) {
        await logActivity({ kind: 'skill', title: `Skill saved: ${r.name}`, detail: String(args.description || '').slice(0, 200) });
        broadcast({ type: 'skills_updated' });
      }
      return r;
    }
    case 'delete_skill': {
      const r = await deleteSkill(args.name);
      if (r.ok) broadcast({ type: 'skills_updated' });
      return r;
    }
    case 'read_artifact': {
      const a = await getArtifact(args.id);
      return a || { error: 'Artifact not found' };
    }

    // MCP auto-discovery & connect
    case 'discover_mcp':
      return await discoverAllMcp({ scanPorts: true });
    case 'connect_mcp':
      return await smartAddMcp(args.input, { nameOverride: args.name || '' });

    // Self-configuration (get / update Pond settings & LLM profile live)
    case 'get_settings': {
      const [settings, llm, ms365] = await Promise.all([
        Promise.resolve(getPublicSettings()),
        getPublicLlmConfig(),
        getPublicMs365Status(),
      ]);
      return { settings, llm, microsoft365: ms365 };
    }
    case 'update_settings': {
      const patch = {};
      if (args.userLocation !== undefined) patch.userLocation = args.userLocation;
      if (args.proactive && typeof args.proactive === 'object') patch.proactive = args.proactive;
      if (args.email && typeof args.email === 'object') patch.email = args.email;
      if (args.calendar && typeof args.calendar === 'object') patch.calendar = args.calendar;
      if (args.sentinel && typeof args.sentinel === 'object') patch.sentinel = args.sentinel;
      if (args.persona && typeof args.persona === 'object') patch.persona = args.persona;
      if (args.assistantName !== undefined) patch.assistantName = args.assistantName;
      let updatedSettings = getPublicSettings();
      if (Object.keys(patch).length) {
        updatedSettings = await saveRuntimeSettings(patch);
        if (onSettingsChanged) onSettingsChanged();
      }
      let updatedLlm = null;
      if (args.llm && typeof args.llm === 'object') {
        const curLlm = await getLlmConfig();
        const nextLlm = structuredClone(curLlm);
        if (args.llm.activeProfile && nextLlm.profiles?.[args.llm.activeProfile]) {
          nextLlm.activeProfile = args.llm.activeProfile;
        }
        if (args.llm.fastProfile !== undefined) nextLlm.fastProfile = args.llm.fastProfile;
        const activeKey = nextLlm.activeProfile || Object.keys(nextLlm.profiles || {})[0];
        if (activeKey && nextLlm.profiles?.[activeKey]) {
          if (args.llm.reasoningEffort !== undefined) nextLlm.profiles[activeKey].reasoningEffort = String(args.llm.reasoningEffort);
          if (args.llm.model) nextLlm.profiles[activeKey].model = String(args.llm.model);
          if (args.llm.contextLength !== undefined) nextLlm.profiles[activeKey].contextLength = Number(args.llm.contextLength) || 128000;
        }
        updatedLlm = await saveLlmConfig(nextLlm);
      }
      broadcast({ type: 'settings_updated', settings: updatedSettings });
      await logActivity({ kind: 'system', title: 'Pond updated its own settings', detail: JSON.stringify(args).slice(0, 260) });
      return { ok: true, settings: updatedSettings, ...(updatedLlm ? { llm: updatedLlm } : {}) };
    }

    // Direct Browser Notification
    case 'notify_user': {
      const n = await pushNotification({
        title: String(args.title || CONFIG.assistantName),
        body: String(args.message || ''),
        urgency: ['normal', 'high', 'critical'].includes(args.urgency) ? args.urgency : 'high',
        category: context.source === 'email' ? 'email' : 'proactive',
      });
      return { ok: true, notificationId: n.id };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

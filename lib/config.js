// Configuration loader: .env + OPEN_DOTS_* overrides + persisted runtime settings.json.
import { existsSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, readJson, writeJson } from './storage.js';

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  const env = {};
  if (existsSync(envPath)) {
    for (const raw of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i === -1) continue;
      const key = line.slice(0, i).trim();
      let val = line.slice(i + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
  }
  return {
    ...env,
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('OPEN_DOTS_'))),
  };
}

export const env = loadEnvFile();

const parseList = (v) =>
  Array.isArray(v)
    ? v.map((s) => String(s).trim()).filter(Boolean)
    : String(v || '')
        .split(/[,;\n]/)
        .map((s) => s.trim())
        .filter(Boolean);

const parseBool = (v, def) => {
  if (v === undefined || v === null || v === '') return def;
  if (typeof v === 'boolean') return v;
  return String(v).toLowerCase() !== 'false' && String(v) !== '0';
};

export const DEFAULT_SENTINEL_POLICIES = {
  send_email: 'ask',
  run_python: 'ask',
  delete_file: 'ask',
  run_command: 'ask',
  http_request_write: 'ask',
  mcp_tool: 'ask',
  write_file: 'allow',
  update_persona: 'ask', // a new personality persists into every future chat — confirm when the AI changes it
  save_skill: 'ask',   // skills are persistent instructions — guard against injected ones
  delete_skill: 'ask',
};

// Personality presets for the assistant's role/tone. Only this part of the system prompt is user-editable;
// tool usage and safety instructions stay fixed (see buildStaticSystemPrompt in llm.js).
export const PERSONA_PRESETS = {
  default: 'a warm, proactive personal AI assistant & daily chief-of-staff (Muse / Dots style). Be warm, crisp, and practical.',
  casual: 'a laid-back, friendly personal assistant — like a close friend who happens to be great at getting things done. Talk casually: contractions, short messages, light humor, the occasional emoji. Still be accurate and genuinely useful.',
  concise: 'a concise, professional personal assistant. Lead with the answer, keep it short, use bullet points for lists, skip small talk and emoji.',
  playful: 'an upbeat, playful personal assistant with a sense of humor and a bit of personality. Keep things fun and energetic (emoji welcome), but always accurate and practical.',
};

export const CONFIG = {
  apiKey: env.OPEN_DOTS_OPENAI_API_KEY || env.OPENAI_API_KEY || '',
  baseUrl: (env.OPEN_DOTS_OPENAI_BASE_URL || env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  model: env.OPEN_DOTS_MODEL || env.MODEL || 'gpt-4o-mini',
  fastModel: env.FAST_MODEL || '',
  port: Number(env.OPEN_DOTS_PORT || env.PORT || 8787),
  maxToolRounds: Math.max(1, Number(env.MAX_TOOL_ROUNDS || env.OPEN_DOTS_MAX_TOOL_ROUNDS || 100)),
  assistantName: env.ASSISTANT_NAME || 'Pond',
  persona: {
    preset: String(env.PERSONA || 'default'), // default | casual | concise | playful | custom
    custom: String(env.PERSONA_CUSTOM || ''), // used when preset = custom
  },
  fsRoot: path.resolve(env.POND_FS_ROOT || path.join(os.homedir(), 'Documents')),
  // Served at /share/… so files open on every device. Defaults to a folder inside the file root.
  shareDir: path.resolve(env.POND_SHARE_DIR || path.join(path.resolve(env.POND_FS_ROOT || path.join(os.homedir(), 'Documents')), 'Pond Share')),
  allowShell: parseBool(env.ALLOW_SHELL_TOOL, false),
  python: {
    enabled: parseBool(env.PYTHON_ENABLED, true),
    bin: String(env.PYTHON_BIN || ''),
    timeoutSec: Math.max(5, Math.min(120, Number(env.PYTHON_TIMEOUT_SEC || 30))),
  },
  userLocation: String(env.USER_LOCATION || ''),
  ui: {
    mascotPalette: String(env.MASCOT_PALETTE || 'cyan'), // cyan | teal | mint | violet | pink | coral | ink | custom
    mascotColor: String(env.MASCOT_COLOR || ''),          // body hex when palette = custom
    avatarMode: 'mascot',   // mascot | image (user-uploaded, data/appearance/avatar.<ext>)
    avatarExt: '',
    avatarVersion: 0,       // cache-buster, bumped on each upload
    avatarCircle: true,     // crop uploaded image to a circle
  },
  calendar: {
    icsUrl: String(env.CALENDAR_ICS_URL || ''),
    reminderLeadMin: Math.max(0, Number(env.EVENT_REMINDER_MINUTES ?? 30)),
  },
  webhookSecret: env.WEBHOOK_SECRET || '',
  search: {
    backend: String(env.SEARCH_BACKEND || 'auto').toLowerCase(),
    deepseekApiKey: env.DEEPSEEK_API_KEY || env.DEEPSEEK_SEARCH_API_KEY || '',
    deepseekBaseUrl: (env.DEEPSEEK_SEARCH_BASE_URL || 'https://api.deepseek.com/anthropic/v1').replace(/\/+$/, ''),
    deepseekModel: env.DEEPSEEK_SEARCH_MODEL || 'deepseek-v4-flash',
    tavilyApiKey: env.TAVILY_API_KEY || '',
    tavilyDepth: ['basic', 'advanced', 'fast', 'ultra-fast'].includes(String(env.TAVILY_SEARCH_DEPTH || '').toLowerCase()) ? String(env.TAVILY_SEARCH_DEPTH).toLowerCase() : 'basic',
  },
  proactive: {
    enabled: parseBool(env.PROACTIVE_ENABLED, true),
    // low | medium | high | aggressive
    aggressiveness: String(env.PROACTIVE_AGGRESSIVENESS || 'high').toLowerCase(),
    intervalMin: Math.max(1, Number(env.PROACTIVE_INTERVAL_MINUTES || 3)),
    minGapMin: Math.max(1, Number(env.PROACTIVE_MIN_GAP_MINUTES || 5)),
    quietHours: String(env.PROACTIVE_QUIET_HOURS || ''), // e.g. "23:00-07:00"
    autoExecuteTasks: parseBool(env.PROACTIVE_AUTO_TASKS, true),
    followUpQuietChat: parseBool(env.PROACTIVE_FOLLOW_UP, true),
    proactiveBriefings: parseBool(env.PROACTIVE_BRIEFINGS, true),
    upcomingReminderHeadsUpMin: Number(env.REMINDER_HEADSUP_MINUTES ?? 15),
    // Don't-disturb window: within this many hours of the last proactive check-in, only speak if
    // there is something actionable / genuinely new. 0 disables.
    dndHours: Math.max(0, Number(env.PROACTIVE_DND_HOURS ?? 4)),
  },
  email: {
    enabled: parseBool(env.EMAIL_ENABLED, Boolean(env.IMAP_HOST && env.IMAP_USER)),
    imapHost: env.IMAP_HOST || '',
    imapPort: Number(env.IMAP_PORT || 993),
    imapUser: env.IMAP_USER || '',
    imapPass: env.IMAP_PASS || '',
    imapTls: parseBool(env.IMAP_TLS, true),
    imapMailbox: env.IMAP_MAILBOX || 'INBOX',
    smtpHost: env.SMTP_HOST || '',
    smtpPort: Number(env.SMTP_PORT || 465),
    smtpUser: env.SMTP_USER || env.IMAP_USER || '',
    smtpPass: env.SMTP_PASS || env.IMAP_PASS || '',
    smtpSecure: parseBool(env.SMTP_SECURE, Number(env.SMTP_PORT || 465) === 465),
    fromAddress: env.EMAIL_FROM || env.IMAP_USER || '',
    pollIntervalMin: Math.max(1, Number(env.EMAIL_POLL_INTERVAL_MINUTES || 10)),
    vipSenders: parseList(env.EMAIL_VIP_SENDERS),
    importantKeywords: parseList(
      env.EMAIL_IMPORTANT_KEYWORDS ||
        'urgent,asap,invoice,payment,security,verify,flight,booking,interview,offer,deadline,action required,receipt,bank,alert'
    ),
    autoTriage: parseBool(env.EMAIL_AUTO_TRIAGE, true),
  },
  sentinel: {
    enabled: parseBool(env.SENTINEL_ENABLED, true),
    approvalTimeoutSec: Math.max(30, Number(env.SENTINEL_TIMEOUT_SEC || 300)),
    policies: { ...DEFAULT_SENTINEL_POLICIES },
  },
};

// Cloud APIs need a key; local servers (Ollama, LM Studio, vLLM, SGLang, llama.cpp…) usually don't.
const CLOUD_KEY_HOSTS = /(^|\.)(openai\.com|openrouter\.ai|deepseek\.com|anthropic\.com|googleapis\.com|groq\.com|together\.(ai|xyz)|mistral\.ai|fireworks\.ai|x\.ai|perplexity\.ai|cohere\.(ai|com)|azure\.com|cerebras\.ai)$/i;
export function apiKeyNeeded(baseUrl) {
  try { return CLOUD_KEY_HOSTS.test(new URL(String(baseUrl)).hostname); } catch { return false; }
}
export function keyLooksConfigured(apiKey, baseUrl) {
  const k = String(apiKey || '').trim();
  if (k && !k.startsWith('sk-your')) return true; // "sk-your-…" is the .env.example placeholder = no key
  return Boolean(baseUrl) && !apiKeyNeeded(baseUrl);
}

// Is a usable model set up? The active profile from Agent Hub → LLM Engine counts (registered by llm-config.js),
// not just OPENAI_API_KEY in .env — otherwise background features stay off for people who only use the app.
let activeProfileReady = null;
export function registerActiveProfileReady(fn) { activeProfileReady = fn; }
export function isKeyConfigured() {
  try { const r = activeProfileReady?.(); if (r !== undefined && r !== null) return Boolean(r); } catch { /* fall back */ }
  return keyLooksConfigured(CONFIG.apiKey, CONFIG.baseUrl);
}

export function isEmailConfigured() {
  return Boolean(CONFIG.email.imapHost && CONFIG.email.imapUser && CONFIG.email.imapPass);
}

export function isSmtpConfigured() {
  return Boolean(CONFIG.email.smtpHost && CONFIG.email.smtpUser && CONFIG.email.smtpPass);
}

export function isInQuietHours(now = new Date()) {
  const spec = String(CONFIG.proactive.quietHours || '').trim();
  const m = spec.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start <= end) return cur >= start && cur < end;
  return cur >= start || cur < end; // wraps midnight
}

function mergeDeep(target, patch) {
  if (!patch || typeof patch !== 'object') return;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      mergeDeep(target[k], v);
    } else {
      target[k] = v;
    }
  }
}

// ---------- File root (folder the AI's file tools may use) ----------
const isInside = (dir, root) => { const rel = path.relative(root, dir); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
export function resolveFolderInput(input) {
  let p = String(input || '').trim().replace(/^["']|["']$/g, '');
  if (!p) throw new Error('Enter a folder path');
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
  if (!path.isAbsolute(p)) throw new Error('Use a full path, e.g. C:\\Users\\you\\Documents');
  p = path.resolve(p);
  let st; try { st = statSync(p); } catch { throw new Error(`Folder not found: ${p}`); }
  if (!st.isDirectory()) throw new Error(`Not a folder: ${p}`);
  return p;
}
// Pond Share stays where it is while it is still inside the new root (existing /share links keep working);
// otherwise it moves to <root>/Pond Share. POND_SHARE_DIR in .env always wins.
export function shareDirFor(root, currentShare = CONFIG.shareDir) {
  if (env.POND_SHARE_DIR) return path.resolve(env.POND_SHARE_DIR);
  return currentShare && isInside(currentShare, root) ? currentShare : path.join(root, 'Pond Share');
}

export async function loadRuntimeSettings() {
  const saved = await readJson('settings.json', {});
  if (saved && typeof saved === 'object') {
    if (saved.assistantName) CONFIG.assistantName = String(saved.assistantName);
    if (saved.persona) mergeDeep(CONFIG.persona, saved.persona);
    if (saved.model) CONFIG.model = String(saved.model);
    if (saved.fastModel !== undefined) CONFIG.fastModel = String(saved.fastModel);
    if (saved.proactive) mergeDeep(CONFIG.proactive, saved.proactive);
    if (saved.email) {
      const ep = { ...saved.email };
      // Don't clobber env password with empty mask
      if (ep.imapPass === '••••••••' || ep.imapPass === '') delete ep.imapPass;
      if (ep.smtpPass === '••••••••' || ep.smtpPass === '') delete ep.smtpPass;
      if (ep.vipSenders !== undefined) ep.vipSenders = parseList(ep.vipSenders);
      if (ep.importantKeywords !== undefined) ep.importantKeywords = parseList(ep.importantKeywords);
      mergeDeep(CONFIG.email, ep);
    }
    if (saved.sentinel) mergeDeep(CONFIG.sentinel, saved.sentinel);
    if (saved.calendar) mergeDeep(CONFIG.calendar, saved.calendar);
    if (saved.python) mergeDeep(CONFIG.python, saved.python);
    if (saved.userLocation !== undefined) CONFIG.userLocation = String(saved.userLocation);
    if (saved.ui) mergeDeep(CONFIG.ui, saved.ui);
    if (saved.allowShell !== undefined) CONFIG.allowShell = Boolean(saved.allowShell);
    if (saved.fsRoot) {
      try {
        CONFIG.fsRoot = resolveFolderInput(saved.fsRoot);
        CONFIG.shareDir = shareDirFor(CONFIG.fsRoot, saved.shareDir ? path.resolve(saved.shareDir) : CONFIG.shareDir);
      } catch { /* folder gone — keep the .env / default root */ }
    }
    if (saved.search) {
      const sp = { ...saved.search };
      for (const k of ['tavilyApiKey', 'deepseekApiKey']) if (sp[k] === '••••••••' || sp[k] === '') delete sp[k]; // empty = use .env
      mergeDeep(CONFIG.search, sp);
    }
  }
}

export const SEARCH_BACKENDS = ['auto', 'tavily', 'deepseek', 'bing'];
export async function saveRuntimeSettings(patch) {
  const existing = await readJson('settings.json', {});
  const cleanPatch = structuredClone(patch || {});
  // Preserve secrets if masked placeholder is sent from UI
  if (cleanPatch.email) {
    if (cleanPatch.email.imapPass === '••••••••') delete cleanPatch.email.imapPass;
    if (cleanPatch.email.smtpPass === '••••••••') delete cleanPatch.email.smtpPass;
    // Google App Passwords are often pasted with spaces ("abcd efgh ijkl mnop") — strip them cleanly for Gmail
    const hostHint = String(cleanPatch.email.imapHost || CONFIG.email.imapHost || '');
    if (/gmail\.com/i.test(hostHint)) {
      if (typeof cleanPatch.email.imapPass === 'string') cleanPatch.email.imapPass = cleanPatch.email.imapPass.replace(/\s+/g, '');
      if (typeof cleanPatch.email.smtpPass === 'string') cleanPatch.email.smtpPass = cleanPatch.email.smtpPass.replace(/\s+/g, '');
    }
    if (cleanPatch.email.vipSenders !== undefined) cleanPatch.email.vipSenders = parseList(cleanPatch.email.vipSenders);
    if (cleanPatch.email.importantKeywords !== undefined) cleanPatch.email.importantKeywords = parseList(cleanPatch.email.importantKeywords);
    if (cleanPatch.email.imapPort !== undefined) cleanPatch.email.imapPort = Number(cleanPatch.email.imapPort) || 993;
    if (cleanPatch.email.smtpPort !== undefined) cleanPatch.email.smtpPort = Number(cleanPatch.email.smtpPort) || 465;
    if (cleanPatch.email.pollIntervalMin !== undefined) cleanPatch.email.pollIntervalMin = Math.max(1, Number(cleanPatch.email.pollIntervalMin) || 10);
  }
  if (cleanPatch.assistantName !== undefined) cleanPatch.assistantName = String(cleanPatch.assistantName || '').replace(/[\r\n]/g, ' ').trim().slice(0, 40) || 'Pond';
  if (cleanPatch.persona) {
    if (cleanPatch.persona.preset !== undefined && !['default', 'casual', 'concise', 'playful', 'custom'].includes(cleanPatch.persona.preset)) cleanPatch.persona.preset = 'default';
    if (cleanPatch.persona.custom !== undefined) cleanPatch.persona.custom = String(cleanPatch.persona.custom || '').slice(0, 2000);
  }
  if (cleanPatch.ui) {
    const allowed = ['cyan', 'teal', 'mint', 'violet', 'pink', 'coral', 'ink', 'custom'];
    if (cleanPatch.ui.mascotPalette !== undefined && !allowed.includes(cleanPatch.ui.mascotPalette)) cleanPatch.ui.mascotPalette = 'cyan';
    if (cleanPatch.ui.mascotColor !== undefined && !/^#[0-9a-f]{6}$/i.test(cleanPatch.ui.mascotColor)) cleanPatch.ui.mascotColor = '';
    if (cleanPatch.ui.avatarMode !== undefined && !['mascot', 'image'].includes(cleanPatch.ui.avatarMode)) cleanPatch.ui.avatarMode = 'mascot';
    if (cleanPatch.ui.avatarExt !== undefined && !['', 'png', 'jpg', 'webp', 'gif', 'svg'].includes(cleanPatch.ui.avatarExt)) delete cleanPatch.ui.avatarExt;
    if (cleanPatch.ui.avatarVersion !== undefined) cleanPatch.ui.avatarVersion = Number(cleanPatch.ui.avatarVersion) || 0;
    if (cleanPatch.ui.avatarCircle !== undefined) cleanPatch.ui.avatarCircle = Boolean(cleanPatch.ui.avatarCircle);
  }
  if (cleanPatch.proactive) {
    if (cleanPatch.proactive.intervalMin !== undefined) cleanPatch.proactive.intervalMin = Math.max(1, Number(cleanPatch.proactive.intervalMin) || 3);
    if (cleanPatch.proactive.minGapMin !== undefined) cleanPatch.proactive.minGapMin = Math.max(1, Number(cleanPatch.proactive.minGapMin) || 5);
    if (cleanPatch.proactive.dndHours !== undefined) cleanPatch.proactive.dndHours = Math.max(0, Math.min(24, Number(cleanPatch.proactive.dndHours) || 0));
    if (cleanPatch.proactive.upcomingReminderHeadsUpMin !== undefined) {
      cleanPatch.proactive.upcomingReminderHeadsUpMin = Math.max(0, Number(cleanPatch.proactive.upcomingReminderHeadsUpMin) || 0);
    }
  }
  if (cleanPatch.fsRoot !== undefined) {
    const root = resolveFolderInput(cleanPatch.fsRoot); // throws with a readable message
    cleanPatch.fsRoot = root;
    cleanPatch.shareDir = shareDirFor(root);
    try { mkdirSync(cleanPatch.shareDir, { recursive: true }); } catch { /* best effort */ }
  }
  if (patch?.shareDir !== undefined && patch?.fsRoot === undefined) delete cleanPatch.shareDir; // only set via fsRoot
  if (cleanPatch.search) {
    const sp = cleanPatch.search;
    if (sp.backend !== undefined && !SEARCH_BACKENDS.includes(String(sp.backend))) sp.backend = 'auto';
    for (const k of ['tavilyApiKey', 'deepseekApiKey']) {
      if (sp[k] === '••••••••') delete sp[k]; // unchanged secret
      else if (typeof sp[k] === 'string') sp[k] = sp[k].trim();
    }
  }
  mergeDeep(existing, cleanPatch);
  await writeJson('settings.json', existing);
  await loadRuntimeSettings();
  return getPublicSettings();
}

export function getPublicSettings() {
  return {
    assistantName: CONFIG.assistantName,
    persona: { ...CONFIG.persona, presets: PERSONA_PRESETS },
    model: CONFIG.model,
    fastModel: CONFIG.fastModel,
    baseUrl: CONFIG.baseUrl,
    keyConfigured: isKeyConfigured(),
    fsRoot: CONFIG.fsRoot,
    shareDir: CONFIG.shareDir,
    allowShell: CONFIG.allowShell,
    shellName: process.platform === 'win32' ? 'PowerShell' : 'shell',
    python: { ...CONFIG.python },
    userLocation: CONFIG.userLocation,
    ui: { ...CONFIG.ui },
    calendar: { ...CONFIG.calendar },
    search: {
      backend: CONFIG.search.backend,
      tavilyApiKey: CONFIG.search.tavilyApiKey ? '••••••••' : '',
      deepseekApiKey: CONFIG.search.deepseekApiKey ? '••••••••' : '',
    },
    proactive: { ...CONFIG.proactive },
    email: {
      enabled: CONFIG.email.enabled,
      configured: isEmailConfigured(),
      smtpConfigured: isSmtpConfigured(),
      imapHost: CONFIG.email.imapHost,
      imapPort: CONFIG.email.imapPort,
      imapUser: CONFIG.email.imapUser,
      imapPass: CONFIG.email.imapPass ? '••••••••' : '',
      imapTls: CONFIG.email.imapTls,
      imapMailbox: CONFIG.email.imapMailbox,
      smtpHost: CONFIG.email.smtpHost,
      smtpPort: CONFIG.email.smtpPort,
      smtpUser: CONFIG.email.smtpUser,
      smtpPass: CONFIG.email.smtpPass ? '••••••••' : '',
      smtpSecure: CONFIG.email.smtpSecure,
      fromAddress: CONFIG.email.fromAddress,
      pollIntervalMin: CONFIG.email.pollIntervalMin,
      vipSenders: CONFIG.email.vipSenders,
      importantKeywords: CONFIG.email.importantKeywords,
      autoTriage: CONFIG.email.autoTriage,
    },
    sentinel: {
      enabled: CONFIG.sentinel.enabled,
      approvalTimeoutSec: CONFIG.sentinel.approvalTimeoutSec,
      policies: { ...CONFIG.sentinel.policies },
    },
  };
}

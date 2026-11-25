// JSON-configurable LLM engine (data/llm.json): named profiles, reasoningEffort, temperature, maxTokens, extraHeaders, extraBody.
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { DATA, readJson, writeJson } from './storage.js';
import { CONFIG, env, keyLooksConfigured, registerActiveProfileReady } from './config.js';

const LLM_FILE = 'llm.json';
const MASK = '••••••••';

let cached = null;
let cachedMtime = 0;

// Which input modalities a profile's model accepts. "text" is always on; add "image" for vision models.
export const INPUT_TYPES = ['text', 'image'];
export function normInputTypes(v) {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : [];
  const set = new Set(['text', ...arr.map((x) => String(x).trim().toLowerCase()).filter((x) => INPUT_TYPES.includes(x))]);
  return INPUT_TYPES.filter((t) => set.has(t));
}

function defaultConfigFromEnv() {
  return {
    activeProfile: 'default',
    fastProfile: '',
    profiles: {
      default: {
        label: 'Default',
        baseUrl: CONFIG.baseUrl,
        apiKey: '', // empty = use OPENAI_API_KEY from .env (if any); no env-var syntax shown to new users
        model: CONFIG.model,
        contextLength: env.LLM_CONTEXT_LENGTH ? Number(env.LLM_CONTEXT_LENGTH) : 128000,
        reasoningEffort: String(env.REASONING_EFFORT || ''),
        temperature: env.LLM_TEMPERATURE ? Number(env.LLM_TEMPERATURE) : null,
        maxTokens: env.LLM_MAX_TOKENS ? Number(env.LLM_MAX_TOKENS) : null,
        inputTypes: normInputTypes(env.LLM_INPUT_TYPES || 'text,image'), // most current models accept images
        extraHeaders: {},
        extraBody: {},
      },
    },
  };
}

function resolveSecret(val) {
  const s = String(val || '').trim();
  if (!s) return CONFIG.apiKey;
  if (s.startsWith('$')) {
    const varName = s.slice(1);
    return env[varName] || process.env[varName] || CONFIG.apiKey;
  }
  return s;
}

export async function ensureLlmConfig() {
  const full = path.join(DATA, LLM_FILE);
  if (!existsSync(full)) {
    const initial = defaultConfigFromEnv();
    await writeJson(LLM_FILE, initial);
    cached = initial;
    return initial;
  }
  return getLlmConfig();
}

// Automatically picks up manual edits to data/llm.json without restarting the server!
export async function getLlmConfig() {
  const full = path.join(DATA, LLM_FILE);
  try {
    const st = await stat(full);
    if (cached && st.mtimeMs === cachedMtime) return cached;
    const raw = await readJson(LLM_FILE, null);
    if (raw && typeof raw === 'object' && raw.profiles && typeof raw.profiles === 'object') {
      cached = raw;
      cachedMtime = st.mtimeMs;
      return cached;
    }
  } catch { /* fallback */ }
  cached = defaultConfigFromEnv();
  return cached;
}

// profile / effort: a chat's own choice (session.llm). Falls back to the default (activeProfile) when the chat
// has none or its profile was deleted.
// How many sessions this model may run at once for one reply: the chat itself plus its sub-agents.
// 1 = no sub-agents (default); 4 = the chat + up to 3 sub-agents working in parallel.
export const MAX_SESSIONS_CAP = 8;
export function normMaxSessions(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_SESSIONS_CAP, n) : 1;
}

export async function resolveProfile({ fast = false, overrideModel = null, profile = null, effort = undefined } = {}) {
  const cfg = await getLlmConfig();
  const profiles = cfg.profiles || {};
  const profileKey =
    (fast && cfg.fastProfile && profiles[cfg.fastProfile] ? cfg.fastProfile : null) ||
    (!fast && profile && profiles[profile] ? profile : null) ||
    (cfg.activeProfile && profiles[cfg.activeProfile] ? cfg.activeProfile : null) ||
    Object.keys(profiles)[0] ||
    'default';

  const p = profiles[profileKey] || defaultConfigFromEnv().profiles.default;
  const baseUrl = String(p.baseUrl || CONFIG.baseUrl).replace(/\/+$/, '');
  const apiKey = resolveSecret(p.apiKey);
  const model = overrideModel || (fast && !cfg.fastProfile && CONFIG.fastModel) || p.model || CONFIG.model;
  const contextLength = typeof p.contextLength === 'number' && Number.isFinite(p.contextLength) && p.contextLength > 0 ? p.contextLength : 128000;
  const reasoningEffort = String((effort !== undefined && effort !== null && !fast ? effort : p.reasoningEffort) || '').trim();
  const temperature = typeof p.temperature === 'number' && Number.isFinite(p.temperature) ? p.temperature : null;
  const maxTokens = typeof p.maxTokens === 'number' && Number.isFinite(p.maxTokens) && p.maxTokens > 0 ? p.maxTokens : null;
  const extraHeaders = p.extraHeaders && typeof p.extraHeaders === 'object' ? p.extraHeaders : {};
  const extraBody = p.extraBody && typeof p.extraBody === 'object' ? p.extraBody : {};
  const inputTypes = normInputTypes(p.inputTypes);
  const maxSessions = normMaxSessions(p.maxSessions);

  return {
    profileKey,
    label: p.label || profileKey,
    baseUrl,
    apiKey,
    keyConfigured: keyLooksConfigured(apiKey, baseUrl),
    model,
    contextLength,
    reasoningEffort,
    temperature,
    maxTokens,
    inputTypes,
    maxSessions,
    vision: inputTypes.includes('image'),
    extraHeaders,
    extraBody,
  };
}

export async function getPublicLlmConfig() {
  const cfg = await getLlmConfig();
  const maskedProfiles = {};
  for (const [k, p] of Object.entries(cfg.profiles || {})) {
    const rawKey = String(p.apiKey || '');
    maskedProfiles[k] = {
      label: p.label || k,
      baseUrl: p.baseUrl || CONFIG.baseUrl,
      apiKey: rawKey.startsWith('$') ? rawKey : rawKey ? MASK : '',
      model: p.model || CONFIG.model,
      contextLength: p.contextLength ?? 128000,
      reasoningEffort: p.reasoningEffort || '',
      temperature: p.temperature ?? null,
      maxTokens: p.maxTokens ?? null,
      inputTypes: normInputTypes(p.inputTypes),
      maxSessions: normMaxSessions(p.maxSessions),
      extraHeaders: p.extraHeaders || {},
      extraBody: p.extraBody || {},
    };
  }
  const active = await resolveProfile();
  return {
    configPath: path.join(DATA, LLM_FILE),
    activeProfile: cfg.activeProfile || 'default',
    fastProfile: cfg.fastProfile || '',
    profiles: maskedProfiles,
    resolved: {
      profileKey: active.profileKey,
      model: active.model,
      baseUrl: active.baseUrl,
      contextLength: active.contextLength,
      reasoningEffort: active.reasoningEffort || 'default',
      inputTypes: active.inputTypes,
      keyConfigured: active.keyConfigured,
    },
  };
}

const EFFORTS = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
// Quick switch from the model chip: change the active profile and/or its reasoning effort. Nothing else is touched.
export const EFFORT_VALUES = EFFORTS;
export async function defaultChatLlm() {
  const cfg = await getLlmConfig();
  const key = cfg.activeProfile && cfg.profiles?.[cfg.activeProfile] ? cfg.activeProfile : Object.keys(cfg.profiles || {})[0] || 'default';
  return { profile: key, effort: String(cfg.profiles?.[key]?.reasoningEffort || '') };
}
export function normEffort(effort) {
  const e = String(effort || '').trim().toLowerCase().replace(/^default$/, '');
  if (!EFFORTS.includes(e)) throw new Error(`Unknown reasoning effort "${effort}"`);
  return e;
}

export async function setActiveLlm({ profile, effort } = {}) {
  const cfg = structuredClone(await getLlmConfig());
  if (profile !== undefined) {
    if (!cfg.profiles?.[profile]) throw new Error(`No model profile "${profile}"`);
    cfg.activeProfile = profile;
  }
  if (effort !== undefined) {
    const e = String(effort || '').trim().toLowerCase().replace(/^default$/, '');
    if (!EFFORTS.includes(e)) throw new Error(`Unknown reasoning effort "${effort}"`);
    cfg.profiles[cfg.activeProfile].reasoningEffort = e;
  }
  await writeJson(LLM_FILE, cfg);
  cached = null; cachedMtime = 0;
  return getPublicLlmConfig();
}

export async function saveLlmConfig(incoming) {
  if (!incoming || typeof incoming !== 'object' || !incoming.profiles || typeof incoming.profiles !== 'object') {
    throw new Error('Invalid LLM config JSON: must contain a "profiles" object.');
  }
  const existing = await getLlmConfig();
  const nextProfiles = {};
  for (const [key, p] of Object.entries(incoming.profiles)) {
    const cleanKey = String(key).trim();
    if (!cleanKey || !p || typeof p !== 'object') continue;
    const prev = existing.profiles?.[cleanKey] || {};
    const apiKey = p.apiKey === MASK ? (prev.apiKey || '') : String(p.apiKey ?? '');
    nextProfiles[cleanKey] = {
      label: String(p.label || cleanKey),
      baseUrl: String(p.baseUrl || CONFIG.baseUrl).replace(/\/+$/, ''),
      apiKey,
      model: String(p.model || CONFIG.model),
      contextLength: p.contextLength === '' || p.contextLength === null || p.contextLength === undefined ? 128000 : Math.max(2048, Number(p.contextLength) || 128000),
      reasoningEffort: String(p.reasoningEffort || '').trim(),
      temperature: p.temperature === '' || p.temperature === null || p.temperature === undefined ? null : Number(p.temperature),
      maxTokens: p.maxTokens === '' || p.maxTokens === null || p.maxTokens === undefined ? null : Number(p.maxTokens),
      inputTypes: normInputTypes(p.inputTypes),
      maxSessions: normMaxSessions(p.maxSessions),
      extraHeaders: p.extraHeaders && typeof p.extraHeaders === 'object' ? p.extraHeaders : {},
      extraBody: p.extraBody && typeof p.extraBody === 'object' ? p.extraBody : {},
    };
  }
  if (!Object.keys(nextProfiles).length) {
    throw new Error('At least one LLM profile is required.');
  }
  const activeProfile = nextProfiles[incoming.activeProfile] ? incoming.activeProfile : Object.keys(nextProfiles)[0];
  const fastProfile = incoming.fastProfile && nextProfiles[incoming.fastProfile] ? incoming.fastProfile : '';
  const toSave = { activeProfile, fastProfile, profiles: nextProfiles };

  await writeJson(LLM_FILE, toSave);
  cached = toSave;
  try { cachedMtime = (await stat(path.join(DATA, LLM_FILE))).mtimeMs; } catch { /* ignore */ }

  // Keep CONFIG summary fields synced for legacy health/state reads
  const active = await resolveProfile();
  CONFIG.model = active.model;
  CONFIG.baseUrl = active.baseUrl;
  if (active.apiKey) CONFIG.apiKey = active.apiKey;

  return getPublicLlmConfig();
}

export async function testLlmProfile({ profileKey = null, baseUrl = '', apiKey = '', model = '' } = {}) {
  const existing = profileKey ? await resolveProfile() : null;
  const cfg = await getLlmConfig();
  const stored = profileKey && cfg.profiles?.[profileKey] ? cfg.profiles[profileKey] : null;
  const rawKey = apiKey === MASK ? (stored?.apiKey || '') : (apiKey || stored?.apiKey || '');
  const resolvedKey = resolveSecret(rawKey);
  const resolvedUrl = String(baseUrl || stored?.baseUrl || existing?.baseUrl || CONFIG.baseUrl).replace(/\/+$/, '');
  const resolvedModel = String(model || stored?.model || existing?.model || CONFIG.model);

  const started = Date.now();
  try {
    const resp = await fetch(`${resolvedUrl}/models`, {
      headers: resolvedKey ? { Authorization: `Bearer ${resolvedKey}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      const models = Array.isArray(data.data) ? data.data.map((m) => m.id).slice(0, 10) : [];
      return {
        ok: true,
        latencyMs: Date.now() - started,
        baseUrl: resolvedUrl,
        model: resolvedModel,
        modelsCount: Array.isArray(data.data) ? data.data.length : null,
        sampleModels: models,
      };
    }
    const errText = (await resp.text().catch(() => '')).slice(0, 200);
    return { ok: false, status: resp.status, latencyMs: Date.now() - started, error: `HTTP ${resp.status}: ${errText}` };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: String(err?.cause?.message || err?.message || err) };
  }
}

// Sync readiness check for background features (email triage, check-ins, jobs): uses the cached llm.json.
registerActiveProfileReady(() => {
  const cfg = cached;
  const key = cfg?.activeProfile;
  const p = key && cfg?.profiles?.[key];
  if (!p) return null; // not loaded yet → config.js falls back to .env
  return keyLooksConfigured(resolveSecret(p.apiKey), p.baseUrl);
});

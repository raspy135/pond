// Pond plugin runtime (plugin API v1).
//
// A plugin is a folder:  plugins/<id>/plugin.json  +  plugins/<id>/index.mjs (exports activate(api)).
// Plugins ONLY talk to the versioned `api` object below — never to lib/* internals — so core can
// evolve without breaking plugins, and a broken plugin can't take Pond down:
//   • every plugin call runs behind try/catch + timeout
//   • a plugin that keeps failing is auto-disabled (and the user is notified)
//   • plugin tools are namespaced plugin_<id>_<name> and pass through Sentinel
// NOTE: plugins run in-process. This protects against *breakage*, not malicious code — only
// install plugins you trust (use MCP servers for untrusted, out-of-process tools).
import { readFile, readdir, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, DATA, readJson, writeJson, logActivity } from './storage.js';
import { broadcast, pushNotification } from './notifications.js';

export const PLUGIN_API_VERSION = 1;
export const PLUGINS_DIR = process.env.POND_PLUGINS_DIR ? path.resolve(process.env.POND_PLUGINS_DIR) : path.join(ROOT, 'plugins');
const STATE_FILE = 'plugins.json'; // { enabled: { [id]: bool } }
const HOOK_TIMEOUT_MS = 10_000;
const MAX_ERRORS = 5;               // within ERROR_WINDOW_MS -> auto-disable
const ERROR_WINDOW_MS = 10 * 60_000;
const EVENTS = new Set(['llm_response', 'chat_message', 'notification', 'proactive_tick', 'startup']);

const plugins = new Map();       // id -> record
const handlers = new Map();      // event -> [{ pluginId, fn }]
const tools = new Map();         // full tool name -> { pluginId, def, run, sideEffects }
const routes = new Map();        // `${METHOD} /plugins/<id>/<sub>` -> { pluginId, fn }
const statusItems = new Map();   // `${pluginId}:${key}` -> { pluginId, key, text }
const footers = new Map();       // requestId -> { [pluginId]: text }

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
  ]);
}

async function recordError(rec, where, err) {
  const now = Date.now();
  rec.errors = (rec.errors || []).filter((t) => now - t < ERROR_WINDOW_MS);
  rec.errors.push(now);
  rec.lastError = `${where}: ${String(err?.message || err).slice(0, 300)}`;
  console.warn(`[plugin:${rec.id}] ${rec.lastError}`);
  if (rec.errors.length >= MAX_ERRORS && rec.active) {
    await deactivatePlugin(rec.id, { reason: `auto-disabled after ${rec.errors.length} errors (${rec.lastError})` });
    rec.autoDisabled = true;
    pushNotification({ title: `Plugin "${rec.manifest.name}" disabled`, body: rec.lastError, urgency: 'normal', category: 'system' }).catch(() => {});
  }
  broadcast({ type: 'plugins_updated' });
}

// Run plugin code safely: never throws into core.
async function guarded(rec, where, fn, { timeout = HOOK_TIMEOUT_MS } = {}) {
  if (!rec?.active) return undefined;
  try {
    return await withTimeout(fn(), timeout, where);
  } catch (err) {
    await recordError(rec, where, err).catch(() => {});
    return undefined;
  }
}

// ---------- The plugin API (v1) ----------
function createApi(rec) {
  const id = rec.id;
  const dataDir = path.join(DATA, 'plugins', id);
  const own = (fn) => { if (!rec.active) throw new Error('plugin is not active'); return fn(); };
  return Object.freeze({
    version: PLUGIN_API_VERSION,
    plugin: Object.freeze({ id, name: rec.manifest.name, dir: rec.dir, dataDir }),

    on(event, fn) {
      if (!EVENTS.has(event)) throw new Error(`Unknown event "${event}". Available: ${[...EVENTS].join(', ')}`);
      if (typeof fn !== 'function') throw new Error('handler must be a function');
      own(() => { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push({ pluginId: id, fn }); });
    },

    registerTool({ name, description, parameters = { type: 'object', properties: {} }, sideEffects = false, run }) {
      if (!name || typeof run !== 'function') throw new Error('registerTool needs { name, description, run }');
      const full = `plugin_${slug(id).replace(/-/g, '_')}_${slug(name).replace(/-/g, '_')}`;
      own(() => tools.set(full, {
        pluginId: id,
        sideEffects: Boolean(sideEffects),
        run,
        def: { type: 'function', function: { name: full, description: `[plugin:${id}] ${String(description || '').slice(0, 400)}`, parameters } },
      }));
      return full;
    },

    registerRoute(method, subpath, fn) {
      const sub = `/${String(subpath || '').replace(/^\/+/, '')}`;
      own(() => routes.set(`${String(method || 'GET').toUpperCase()} /plugins/${id}${sub === '/' ? '' : sub}`, { pluginId: id, fn }));
      return `/plugins/${id}${sub === '/' ? '' : sub}`;
    },

    ui: Object.freeze({
      // Small text item in the sidebar "Agent Status" area. text=null removes it.
      statusItem(key, text) {
        const k = `${id}:${slug(key) || 'main'}`;
        if (text == null || text === '') statusItems.delete(k);
        else statusItems.set(k, { pluginId: id, key: slug(key) || 'main', text: String(text).slice(0, 120) });
        broadcast({ type: 'plugin_ui', slot: 'status', items: [...statusItems.values()] });
      },
      // One-line label under the assistant reply of a chat turn (requestId from llm_response).
      messageFooter(requestId, text) {
        if (!requestId) return;
        const cur = footers.get(requestId) || {};
        cur[id] = String(text || '').slice(0, 160);
        footers.set(requestId, cur);
        if (footers.size > 200) footers.delete(footers.keys().next().value);
        broadcast({ type: 'plugin_ui', slot: 'footer', requestId, pluginId: id, text: cur[id] });
      },
      // Markdown panel shown under this plugin in Agent Hub → Plugins.
      setPanel(markdown) {
        rec.panel = String(markdown || '').slice(0, 20_000);
        broadcast({ type: 'plugins_updated' });
      },
    }),

    storage: Object.freeze({
      async get(key, fallback = null) {
        const s = await readJson(path.join('plugins', id, 'store.json'), {});
        return Object.prototype.hasOwnProperty.call(s, key) ? s[key] : fallback;
      },
      async set(key, value) {
        await mkdir(dataDir, { recursive: true });
        const s = await readJson(path.join('plugins', id, 'store.json'), {});
        s[key] = value;
        await writeJson(path.join('plugins', id, 'store.json'), s);
      },
    }),

    settings: Object.freeze({
      get(key) {
        const def = (rec.manifest.settings || []).find((s) => s.key === key);
        return rec.settings?.[key] ?? def?.default ?? null;
      },
      all() {
        const out = {};
        for (const s of rec.manifest.settings || []) out[s.key] = rec.settings?.[s.key] ?? s.default ?? null;
        return out;
      },
    }),

    notify({ title, body = '', urgency = 'normal' } = {}) {
      return pushNotification({ title: String(title || rec.manifest.name), body, urgency, category: 'plugin', tag: `plugin-${id}-${Date.now()}` });
    },

    async askAgent(prompt, { maxRounds = 8 } = {}) {
      const { runAgentTurn, buildSystemPrompt } = await import('./llm.js'); // lazy: avoids import cycle
      const res = await runAgentTurn({ systemPrompt: await buildSystemPrompt(), userPrompt: String(prompt || ''), maxRounds, source: `plugin:${id}` });
      return res.content;
    },

    log(...args) {
      console.log(`[plugin:${id}]`, ...args);
    },
  });
}

// ---------- Loading / lifecycle ----------
async function readManifest(dir) {
  const manifest = JSON.parse(await readFile(path.join(dir, 'plugin.json'), 'utf8'));
  const id = slug(manifest.id || path.basename(dir));
  if (!id) throw new Error('plugin.json needs an "id"');
  return { ...manifest, id, name: String(manifest.name || id), main: manifest.main || 'index.mjs' };
}

async function loadState() {
  const s = await readJson(STATE_FILE, {});
  return { enabled: s.enabled && typeof s.enabled === 'object' ? s.enabled : {}, settings: s.settings && typeof s.settings === 'object' ? s.settings : {} };
}

export async function scanPlugins() {
  const state = await loadState();
  let entries = [];
  try { entries = await readdir(PLUGINS_DIR, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const dir = path.join(PLUGINS_DIR, e.name);
    let manifest;
    try { manifest = await readManifest(dir); } catch (err) {
      found.push({ id: slug(e.name), dir, manifest: { id: slug(e.name), name: e.name }, loadError: `Bad plugin.json: ${err.message}` });
      continue;
    }
    const existing = plugins.get(manifest.id);
    const rec = existing || { id: manifest.id, active: false, errors: [] };
    Object.assign(rec, { dir, manifest, settings: state.settings[manifest.id] || {} });
    rec.enabled = state.enabled[manifest.id] ?? Boolean(manifest.enabledByDefault);
    rec.loadError = null;
    const apiVer = Number(manifest.pondApi || 1);
    if (apiVer > PLUGIN_API_VERSION) rec.loadError = `Needs plugin API v${apiVer}, Pond provides v${PLUGIN_API_VERSION}`;
    plugins.set(manifest.id, rec);
    found.push(rec);
  }
  return found;
}

export async function activatePlugin(id) {
  const rec = plugins.get(id);
  if (!rec || rec.active || rec.loadError) return rec;
  try {
    const mainPath = path.join(rec.dir, rec.manifest.main);
    if (!mainPath.startsWith(rec.dir)) throw new Error('invalid "main"');
    const st = await stat(mainPath);
    const mod = await import(`${pathToFileURL(mainPath).href}?v=${st.mtimeMs}`); // cache-bust so edits reload without restart
    if (typeof mod.activate !== 'function') throw new Error(`${rec.manifest.main} must export activate(api)`);
    rec.module = mod;
    rec.active = true;
    rec.autoDisabled = false;
    rec.errors = [];
    rec.lastError = null;
    rec.api = createApi(rec);
    await withTimeout(mod.activate(rec.api), HOOK_TIMEOUT_MS, 'activate');
    logActivity({ kind: 'plugin', title: `Plugin activated: ${rec.manifest.name}`, detail: rec.manifest.description || '' }).catch(() => {});
  } catch (err) {
    rec.lastError = `activate: ${String(err?.message || err).slice(0, 300)}`;
    console.warn(`[plugin:${id}] ${rec.lastError}`);
    await deactivatePlugin(id, { reason: rec.lastError, callHook: false });
  }
  broadcast({ type: 'plugins_updated' });
  return rec;
}

export async function deactivatePlugin(id, { reason = '', callHook = true } = {}) {
  const rec = plugins.get(id);
  if (!rec) return;
  if (callHook && rec.active && typeof rec.module?.deactivate === 'function') {
    try { await withTimeout(rec.module.deactivate(), 5_000, 'deactivate'); } catch { /* ignore */ }
  }
  rec.active = false;
  for (const [ev, list] of handlers) handlers.set(ev, list.filter((h) => h.pluginId !== id));
  for (const [k, t] of tools) if (t.pluginId === id) tools.delete(k);
  for (const [k, r] of routes) if (r.pluginId === id) routes.delete(k);
  let uiChanged = false;
  for (const [k, s] of statusItems) if (s.pluginId === id) { statusItems.delete(k); uiChanged = true; }
  if (uiChanged) broadcast({ type: 'plugin_ui', slot: 'status', items: [...statusItems.values()] });
  if (reason) rec.lastError = reason;
}

export async function loadPlugins() {
  await mkdir(PLUGINS_DIR, { recursive: true }).catch(() => {});
  const found = await scanPlugins();
  for (const rec of found) if (rec.enabled && !rec.loadError && !rec.active) await activatePlugin(rec.id);
  emitEvent('startup', { pluginCount: found.length });
  return listPlugins();
}

export async function setPluginEnabled(id, enabled) {
  const rec = plugins.get(id);
  if (!rec) throw new Error('Plugin not found');
  const state = await loadState();
  state.enabled[id] = Boolean(enabled);
  await writeJson(STATE_FILE, state);
  rec.enabled = Boolean(enabled);
  if (enabled) await activatePlugin(id);
  else await deactivatePlugin(id, { reason: '' });
  broadcast({ type: 'plugins_updated' });
  return describe(rec);
}

export async function savePluginSettings(id, values = {}) {
  const rec = plugins.get(id);
  if (!rec) throw new Error('Plugin not found');
  const schema = rec.manifest.settings || [];
  const clean = {};
  for (const s of schema) {
    if (!(s.key in values)) continue;
    const v = values[s.key];
    clean[s.key] = s.type === 'number' ? Number(v) : s.type === 'boolean' ? Boolean(v) : String(v ?? '');
  }
  const state = await loadState();
  state.settings[id] = { ...(state.settings[id] || {}), ...clean };
  await writeJson(STATE_FILE, state);
  rec.settings = state.settings[id];
  if (rec.active) { await deactivatePlugin(id); await activatePlugin(id); } // re-activate with new settings
  return describe(rec);
}

export async function reloadPlugins() {
  for (const id of [...plugins.keys()]) await deactivatePlugin(id);
  return loadPlugins();
}

function describe(rec) {
  const m = rec.manifest || {};
  const maskSettings = {};
  for (const s of m.settings || []) {
    const v = rec.settings?.[s.key] ?? s.default ?? '';
    maskSettings[s.key] = s.type === 'password' && v ? '••••••••' : v;
  }
  return {
    id: rec.id,
    name: m.name || rec.id,
    version: m.version || '',
    description: m.description || '',
    author: m.author || '',
    enabled: Boolean(rec.enabled),
    active: Boolean(rec.active),
    autoDisabled: Boolean(rec.autoDisabled),
    error: rec.loadError || rec.lastError || null,
    tools: [...tools.values()].filter((t) => t.pluginId === rec.id).map((t) => t.def.function.name),
    routes: [...routes.entries()].filter(([, r]) => r.pluginId === rec.id).map(([k]) => k),
    settingsSchema: m.settings || [],
    settings: maskSettings,
    panel: rec.panel || '',
  };
}

export function listPlugins() {
  return [...plugins.values()].sort((a, b) => a.id.localeCompare(b.id)).map(describe);
}

// ---------- Hooks used by core ----------
export function emitEvent(event, payload) {
  const list = handlers.get(event);
  if (!list?.length) return;
  for (const { pluginId, fn } of [...list]) {
    const rec = plugins.get(pluginId);
    guarded(rec, `on(${event})`, () => fn(payload)); // fire-and-forget; never blocks core
  }
}

// Stable order (sorted by name) so adding a plugin never reshuffles the cached prompt prefix.
export function getPluginToolDefs() {
  return [...tools.keys()].sort().map((k) => tools.get(k).def);
}

export function pluginToolHasSideEffects(name) {
  return Boolean(tools.get(name)?.sideEffects);
}

export async function runPluginTool(name, args, context) {
  const t = tools.get(name);
  if (!t) return { error: `Plugin tool ${name} is not available (plugin disabled?)` };
  const rec = plugins.get(t.pluginId);
  let failed = null;
  const out = await guarded(rec, `tool ${name}`, async () => {
    try { return await t.run(args || {}, { source: context?.source || 'chat' }); } catch (err) { failed = err; throw err; }
  }, { timeout: 120_000 });
  if (failed) return { error: `Plugin tool failed: ${String(failed.message || failed)}` };
  return out === undefined ? { ok: true } : out;
}

export async function handlePluginRoute(req, res, url, readBody) {
  const key = `${req.method} ${url.pathname.replace(/\/+$/, '')}`;
  const r = routes.get(key);
  if (!r) return false;
  const rec = plugins.get(r.pluginId);
  const send = (status, obj, headers = {}) => {
    if (res.headersSent) return;
    const isStr = typeof obj === 'string';
    res.writeHead(status, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(isStr ? obj : JSON.stringify(obj));
  };
  await guarded(rec, `route ${key}`, async () => {
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : null;
    const out = await r.fn({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
    if (out && typeof out === 'object' && 'status' in out) send(out.status, out.body ?? '', out.headers || {});
    else send(200, out ?? { ok: true });
  });
  if (!res.headersSent) send(500, { error: 'Plugin route failed' });
  return true;
}

export function getPluginUiState() {
  return { status: [...statusItems.values()] };
}

// Footers produced during a chat turn — persisted onto the final assistant message.
export function takeFooters(requestId) {
  const f = footers.get(requestId);
  footers.delete(requestId);
  return f && Object.keys(f).length ? f : null;
}

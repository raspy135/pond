#!/usr/bin/env node
// Pond first-run setup: creates .env and points Pond at a model server.
//   node scripts/setup.mjs                 interactive (auto-detects local servers)
//   node scripts/setup.mjs --yes           non-interactive: just make sure .env exists
//   node scripts/setup.mjs --base-url http://localhost:11434/v1 --model llama3.1 [--api-key KEY] [--location "Tokyo"]
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { migrateBrowserServers, isPlaywrightEntry, playwrightEntry, playwrightBrowser, installBrowserCommand, PLAYWRIGHT_PKG } from '../lib/browser-setup.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV = path.join(ROOT, '.env');
const EXAMPLE = path.join(ROOT, '.env.example');
const C = { c: (s) => `\x1b[36m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` };

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) { args[key] = next; i++; } else args[key] = true;
}

// ---------- .env helpers (keep comments and order, replace or append keys) ----------
if (!existsSync(ENV)) {
  if (existsSync(EXAMPLE)) copyFileSync(EXAMPLE, ENV);
  else writeFileSync(ENV, 'OPENAI_API_KEY=\nOPENAI_BASE_URL=https://api.openai.com/v1\nMODEL=gpt-4o-mini\nPORT=8787\n');
  console.log(C.g('✓ Created .env'));
}
let envText = readFileSync(ENV, 'utf8');
const getEnv = (k) => envText.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.replace(/\s+#.*$/, '').trim() ?? '';
const setEnv = (k, v) => {
  const line = `${k}=${v}`;
  envText = new RegExp(`^#?\\s*${k}=.*$`, 'm').test(envText) ? envText.replace(new RegExp(`^#?\\s*${k}=.*$`, 'm'), line) : `${envText.replace(/\n*$/, '\n')}${line}\n`;
};
const save = () => writeFileSync(ENV, envText);

// ---------- model server probing ----------
async function listModels(baseUrl, apiKey) {
  try {
    const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(2500) });
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json().catch(() => ({}));
    return { ok: true, models: (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean) };
  } catch (err) {
    return { ok: false, error: String(err?.cause?.code || err?.message || err) };
  }
}
const LOCAL = [
  ['Ollama', 'http://localhost:11434/v1'],
  ['LM Studio', 'http://localhost:1234/v1'],
  ['vLLM / SGLang', 'http://localhost:8000/v1'],
  ['llama.cpp server', 'http://localhost:8080/v1'],
];

function applyConfig({ baseUrl, apiKey, model, location }) {
  if (baseUrl) setEnv('OPENAI_BASE_URL', baseUrl.replace(/\/+$/, ''));
  if (apiKey !== undefined) setEnv('OPENAI_API_KEY', apiKey || ''); // empty is fine for local servers
  if (model) setEnv('MODEL', model);
  if (location) setEnv('USER_LOCATION', location);
  save();
}

// ---------- non-interactive ----------
const interactive = !args.yes && (process.stdin.isTTY || args.interactive);
if (args['base-url'] || args.model || args['api-key'] || args.location) {
  applyConfig({ baseUrl: args['base-url'], apiKey: args['api-key'] ?? (args['base-url'] ? '' : undefined), model: args.model, location: args.location });
  console.log(C.g('✓ Saved model settings to .env'));
}
// ---------- Python (required): Pond's own environment in .venv with a data toolkit ----------
const PY_KIT = ['pandas', 'matplotlib', 'openpyxl', 'pypdf'];
const VENV = path.join(ROOT, '.venv');
const VENV_PY = process.platform === 'win32' ? path.join(VENV, 'Scripts', 'python.exe') : path.join(VENV, 'bin', 'python');
function runPy(bin, args, opts = {}) {
  try { return spawnSync(bin, args, { encoding: 'utf8', timeout: 15000, windowsHide: true, ...opts }); } catch { return { status: -1 }; }
}
function findPython() {
  const cands = process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];
  for (const [bin, pre] of cands) {
    const r = runPy(bin, [...pre, '--version']);
    const m = `${r.stdout || ''}${r.stderr || ''}`.match(/Python (3\.(\d+)(?:\.\d+)?)/);
    if (r.status === 0 && m && Number(m[2]) >= 9) return { bin, pre, version: m[1] }; // the Windows Store "python" stub fails this
  }
  return null;
}
async function ensurePython() {
  const py = findPython();
  if (!py) {
    console.log(`\n${C.y('Python 3.9+ was not found.')} Pond needs it to analyze data, read spreadsheets and PDFs, and run scripts.`);
    console.log(C.d(process.platform === 'win32' ? '  Install it with: winget install -e --id Python.Python.3.12   then run setup again.'
      : process.platform === 'darwin' ? '  Install it with: brew install python   then run setup again.'
      : '  Install it with your package manager, e.g.: sudo apt install python3 python3-venv   then run setup again.'));
    return false;
  }
  if (!existsSync(VENV_PY)) {
    process.stdout.write(C.d(`Creating Pond's Python environment (.venv) with Python ${py.version}… `));
    const r = runPy(py.bin, [...py.pre, '-m', 'venv', VENV], { timeout: 180000 });
    if (r.status !== 0 || !existsSync(VENV_PY)) {
      console.log(C.y('failed'));
      console.log(C.d(`  ${String(r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' ')}`));
      if (process.platform === 'linux') console.log(C.d('  On Debian/Ubuntu: sudo apt install python3-venv   then run setup again.'));
      console.log(C.d(`  Pond will use the system Python (${py.version}) for now.`));
      return true;
    }
    console.log(C.g('done'));
  }
  const missing = PY_KIT.filter((m) => runPy(VENV_PY, ['-c', `import ${m}`]).status !== 0);
  if (missing.length) {
    console.log(C.d(`Installing Python packages for Pond: ${missing.join(', ')} (one-time, ~1–2 min)…`));
    const r = spawnSync(VENV_PY, ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', ...missing], { stdio: 'inherit', windowsHide: true });
    if (r.status !== 0) { console.log(C.y(`Couldn't install ${missing.join(', ')} — Pond still works; retry by running setup again.`)); return true; }
  }
  console.log(`${C.g('✓')} Python ready — ${PY_KIT.join(', ')} (in ${path.relative(process.cwd(), VENV) || '.venv'})`);
  return true;
}

// ---------- Browser automation (optional): Playwright MCP, loaded on demand ----------
const DATA_DIR = process.env.OPEN_DOTS_DATA_DIR ? path.resolve(process.env.OPEN_DOTS_DATA_DIR) : path.join(ROOT, 'data');
const MCP_FILE = path.join(DATA_DIR, 'mcp.json');
function readMcp() { try { const j = JSON.parse(readFileSync(MCP_FILE, 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; } }
function saveMcp(list) { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(MCP_FILE, JSON.stringify(list, null, 2)); }
const npx = (args, opts = {}) => spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, { windowsHide: true, shell: process.platform === 'win32', ...opts });
async function ensureBrowser({ canAsk }) {
  let list = readMcp();
  const migrated = migrateBrowserServers(list);
  if (migrated) { list = migrated; saveMcp(list); console.log(C.d('Switched browser tools from Chrome DevTools to Playwright.')); }
  if (!list.some(isPlaywrightEntry)) {
    if (!canAsk) { console.log(C.d('Browser automation is off. Turn it on later: Agent Hub → MCP & API → Browser (Playwright).')); return; }
    console.log(`\nPond can use a real browser for web tasks: unsubscribe from mail, fill forms, read sites that need JavaScript or a login.`);
    if ((await ask('Turn on browser automation (Playwright)? (Y/n)', 'Y')).toLowerCase() === 'n') {
      console.log(C.d('  Skipped. Turn it on later: Agent Hub → MCP & API → Browser (Playwright).'));
      return;
    }
    list.push(playwrightEntry());
    saveMcp(list);
  }
  const browser = playwrightBrowser();
  process.stdout.write(C.d('Downloading the browser tools (one-time)… '));
  const warm = npx(['-y', PLAYWRIGHT_PKG, '--version'], { encoding: 'utf8', timeout: 180000 });
  console.log(warm.status === 0 ? C.g('done') : C.y('skipped (Pond will fetch them when first needed)'));
  if (browser.needsDownload) {
    console.log(C.d(`No Chrome found — downloading ${browser.label} for Pond (one-time, ~150 MB)…`));
    const [cmd, cargs] = installBrowserCommand();
    const r = npx(cargs, { stdio: 'inherit', timeout: 600000 });
    if (r.status !== 0) console.log(C.y(`  Couldn't download it now. Retry later: ${[cmd, ...cargs].join(' ')}`));
  }
  console.log(`${C.g('✓')} Browser automation on (${browser.label}) — Pond loads it only when a task needs a browser.`);
}

if (!interactive) {
  if (!args['base-url']) console.log(C.d('Skipping interactive setup (no terminal). Edit .env or use Agent Hub → LLM Engine later.'));
  await ensurePython();
  await ensureBrowser({ canAsk: false });
  process.exit(0);
}

// ---------- interactive ----------
// One short-lived readline per question, so hidden input can take over stdin cleanly in between.
async function ask(q, def = '') {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return ((await rl.question(def ? `${q} ${C.d(`[${def}]`)} ` : `${q} `)).trim() || def); } finally { rl.close(); }
}
// Hidden input (API keys): raw mode, prints * per character. Falls back to a normal prompt without a terminal.
function askSecret(q) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') return ask(q);
  return new Promise((resolve) => {
    process.stdout.write(`${q} `);
    const stdin = process.stdin;
    let value = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const done = (v) => { stdin.removeListener('data', onData); stdin.setRawMode(false); stdin.pause(); process.stdout.write('\n'); resolve(v.trim()); };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(value);
        if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }        // Ctrl+C
        if (ch === '\u007f' || ch === '\b') { if (value) { value = value.slice(0, -1); process.stdout.write('\b \b'); } continue; }
        if (ch === '\u0015') { process.stdout.write('\b \b'.repeat(value.length)); value = ''; continue; } // Ctrl+U
        if (ch < ' ') continue;
        value += ch; process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

console.log(`\n${C.c('◉ Pond setup')} — connect a model (any OpenAI-compatible endpoint works)\n`);
const curBase = getEnv('OPENAI_BASE_URL');
const curKey = getEnv('OPENAI_API_KEY');
const curModel = getEnv('MODEL');
const CLOUD = /(^|\.)(openai\.com|openrouter\.ai|deepseek\.com|anthropic\.com|googleapis\.com|groq\.com|together\.(ai|xyz)|mistral\.ai|fireworks\.ai|x\.ai|cerebras\.ai)$/i;
const isCloud = (u) => { try { return CLOUD.test(new URL(u).hostname); } catch { return false; } };
const hasKey = curKey && !curKey.startsWith('sk-your');
if (curBase && curModel && (hasKey || !isCloud(curBase))) {
  const keep = (await ask(`Current: ${C.c(curModel)} at ${C.c(curBase)}. Keep it? (Y/n)`, 'Y')).toLowerCase();
  if (keep !== 'n') { console.log(C.g('✓ Keeping current model settings')); await ensurePython(); await ensureBrowser({ canAsk: true }); process.exit(0); }
}

process.stdout.write(C.d('Looking for local model servers… '));
const found = [];
await Promise.all(LOCAL.map(async ([name, url]) => {
  const r = await listModels(url);
  if (r.ok) found.push({ name, url, models: r.models });
  else if (r.status === 401 || r.status === 403) found.push({ name, url, locked: true }); // running, but wants a key
}));
console.log(found.length ? C.g(`found ${found.map((f) => f.name).join(', ')}`) : 'none running');

const choices = [
  ...found.map((f) => ({ label: `${f.name} at ${f.url} ${f.locked ? C.y('(needs API key)') : `(${f.models.length} model${f.models.length === 1 ? '' : 's'})`}`, baseUrl: f.url, local: true, locked: f.locked, models: f.models })),
  { label: 'OpenAI (api.openai.com)', baseUrl: 'https://api.openai.com/v1', needsKey: true },
  { label: 'Another server or cloud API (a GPU box on your network, OpenRouter, DeepSeek…)', custom: true },
  { label: 'Skip for now (configure later in Agent Hub → LLM Engine)', skip: true },
];
choices.forEach((c, i) => console.log(`  ${C.c(String(i + 1))}) ${c.label}`));
const pick = choices[Math.max(0, Math.min(choices.length - 1, Number(await ask('Choose', '1')) - 1))];
if (pick.skip) { console.log(C.y('Skipped. Pond will start, but needs a model before it can chat.')); await ensurePython(); await ensureBrowser({ canAsk: true }); process.exit(0); }

let baseUrl = pick.baseUrl;
if (pick.custom) {
  while (!baseUrl) baseUrl = (await ask('Server URL (e.g. http://192.168.1.50:8000/v1 or https://openrouter.ai/api/v1):', '')).replace(/\/+$/, '');
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) baseUrl = `http://${baseUrl}`;
  if (baseUrl && !/\/v\d+$/.test(baseUrl)) { const r = await listModels(`${baseUrl}/v1`); if (r.ok || r.status === 401 || r.status === 403) baseUrl = `${baseUrl}/v1`; }
}

// API key: always asked. Required when the server says so (401/403) or it's a cloud API; optional otherwise.
let apiKey = '';
let models = pick.models;
const probe = pick.locked ? { ok: false, status: 401 } : (models ? { ok: true, models } : await listModels(baseUrl));
const keyRequired = pick.locked || pick.needsKey || isCloud(baseUrl) || probe.status === 401 || probe.status === 403;
if (probe.ok) models = probe.models;
for (let attempt = 0; attempt < 3; attempt++) {
  apiKey = await askSecret(keyRequired ? 'API key (this server needs one):' : 'API key (press Enter if your server doesn\'t use one):');
  if (!apiKey) {
    if (keyRequired) console.log(C.y('  No key — Pond won\'t be able to use this server until you add one (Agent Hub → LLM Engine).'));
    break;
  }
  const r = await listModels(baseUrl, apiKey);
  if (r.ok) { models = r.models; console.log(C.g(`  ✓ Key works${r.models.length ? ` — ${r.models.length} model${r.models.length === 1 ? '' : 's'} available` : ''}`)); break; }
  if (r.status === 401 || r.status === 403) { console.log(C.y(`  That key was rejected (HTTP ${r.status}). Try again, or press Enter to skip.`)); continue; }
  console.log(C.y(`  Couldn't check the key (${r.status ? `HTTP ${r.status}` : r.error}) — keeping it.`));
  break;
}
if (!models && !probe.ok && !keyRequired) console.log(C.y(`Couldn't list models (${probe.status || probe.error}). You can type the model name.`));
let model = '';
if (models?.length) {
  const shown = models.slice(0, 15);
  shown.forEach((m, i) => console.log(`  ${C.c(String(i + 1))}) ${m}`));
  if (models.length > shown.length) console.log(C.d(`  …and ${models.length - shown.length} more (type the name)`));
  const ans = await ask('Model (number or name):', '1');
  model = /^\d+$/.test(ans) ? shown[Number(ans) - 1] || shown[0] : ans;
} else {
  model = await ask('Model name:', pick.needsKey ? 'gpt-5-mini' : '');
}
const location = await ask('Your city, for local suggestions (Enter to skip):', '');

applyConfig({ baseUrl, apiKey, model, location });
console.log(`\n${C.g('✓ Saved to .env')}: ${C.c(model)} at ${C.c(baseUrl)}${location ? ` · ${location}` : ''}`);
await ensurePython();
await ensureBrowser({ canAsk: true });

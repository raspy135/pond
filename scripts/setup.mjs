#!/usr/bin/env node
// Pond first-run setup: creates .env and points Pond at a model server.
//   node scripts/setup.mjs                 interactive (auto-detects local servers)
//   node scripts/setup.mjs --yes           non-interactive: just make sure .env exists
//   node scripts/setup.mjs --base-url http://localhost:11434/v1 --model llama3.1 [--api-key KEY] [--location "Tokyo"]
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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
// ---------- Python (optional, but Pond's most powerful tool) ----------
function findPython() {
  const cands = process.platform === 'win32'
    ? [['py', ['-3', '--version']], ['python', ['--version']], ['python3', ['--version']]]
    : [['python3', ['--version']], ['python', ['--version']]];
  for (const [bin, a] of cands) {
    try {
      const r = spawnSync(bin, a, { encoding: 'utf8', timeout: 8000, windowsHide: true });
      const m = `${r.stdout || ''}${r.stderr || ''}`.match(/Python (3\.\d+(?:\.\d+)?)/);
      if (r.status === 0 && m) return { bin, version: m[1] }; // the Windows Store "python" stub fails this
    } catch { /* not installed */ }
  }
  return null;
}
const hasCmd = (c) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [c], { encoding: 'utf8', windowsHide: true }).status === 0;
async function checkPython({ interactive: canAsk }) {
  const py = findPython();
  if (py) { console.log(`${C.g('✓')} Python ${py.version} found — Pond can use it to analyze data, read spreadsheets and PDFs, and more.`); return; }
  console.log(`\n${C.y('Python not found.')} It's optional, but it lets Pond analyze data, read spreadsheets and PDFs, and run small scripts for you.`);
  let cmd = null;
  if (process.platform === 'win32' && hasCmd('winget')) cmd = ['winget', ['install', '-e', '--id', 'Python.Python.3.12', '--accept-source-agreements', '--accept-package-agreements']];
  else if (process.platform === 'darwin' && hasCmd('brew')) cmd = ['brew', ['install', 'python']];
  if (cmd && canAsk) {
    const yes = (await ask(`Install Python now with ${cmd[0]}? (Y/n)`, 'Y')).toLowerCase() !== 'n';
    if (yes) {
      const r = spawnSync(cmd[0], cmd[1], { stdio: 'inherit' });
      console.log(r.status === 0 ? C.g('✓ Python installed — Pond will find it automatically.') : C.y(`Install didn't finish. You can run it later: ${[cmd[0], ...cmd[1]].join(' ')}`));
      return;
    }
  }
  const hint = cmd ? [cmd[0], ...cmd[1]].join(' ')
    : process.platform === 'linux' ? "sudo apt install python3   (or your distro's package manager)"
    : 'https://www.python.org/downloads/';
  console.log(C.d(`  To add it later: ${hint}`));
}

if (!interactive) {
  if (!args['base-url']) console.log(C.d('Skipping interactive setup (no terminal). Edit .env or use Agent Hub → LLM Engine later.'));
  await checkPython({ interactive: false });
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
  if (keep !== 'n') { console.log(C.g('✓ Keeping current model settings')); await checkPython({ interactive: true }); process.exit(0); }
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
if (pick.skip) { console.log(C.y('Skipped. Pond will start, but needs a model before it can chat.')); await checkPython({ interactive: true }); process.exit(0); }

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
await checkPython({ interactive: true });

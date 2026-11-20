#!/usr/bin/env node
// Pond first-run setup: creates .env and points Pond at a model server.
//   node scripts/setup.mjs                 interactive (auto-detects local servers)
//   node scripts/setup.mjs --yes           non-interactive: just make sure .env exists
//   node scripts/setup.mjs --base-url http://localhost:11434/v1 --model llama3.1 [--api-key KEY] [--location "Tokyo"]
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

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
  if (apiKey !== undefined) setEnv('OPENAI_API_KEY', apiKey || 'local-no-key'); // local servers ignore it, Pond just needs one
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
if (!interactive) {
  if (!args['base-url']) console.log(C.d('Skipping interactive setup (no terminal). Edit .env or use Agent Hub → LLM Engine later.'));
  process.exit(0);
}

// ---------- interactive ----------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, def = '') => ((await rl.question(def ? `${q} ${C.d(`[${def}]`)} ` : `${q} `)).trim() || def);
async function askSecret(q) {
  if (!process.stdin.isTTY) return ask(q);
  process.stdout.write(`${q} `);
  const muted = rl._writeToOutput;
  rl._writeToOutput = (s) => { if (s.includes('\n') || s.includes('\r')) muted.call(rl, '\n'); else muted.call(rl, '*'.repeat(s.length)); };
  const v = await rl.question('');
  rl._writeToOutput = muted;
  return v.trim();
}

console.log(`\n${C.c('◉ Pond setup')} — connect a model (any OpenAI-compatible endpoint works)\n`);
const curBase = getEnv('OPENAI_BASE_URL');
const curKey = getEnv('OPENAI_API_KEY');
const curModel = getEnv('MODEL');
if (curKey && !curKey.startsWith('sk-your')) {
  const keep = (await ask(`Current: ${C.c(curModel)} at ${C.c(curBase)}. Keep it? (Y/n)`, 'Y')).toLowerCase();
  if (keep !== 'n') { rl.close(); console.log(C.g('✓ Keeping current model settings')); process.exit(0); }
}

process.stdout.write(C.d('Looking for local model servers… '));
const found = [];
await Promise.all(LOCAL.map(async ([name, url]) => { const r = await listModels(url); if (r.ok) found.push({ name, url, models: r.models }); }));
console.log(found.length ? C.g(`found ${found.map((f) => f.name).join(', ')}`) : 'none running');

const choices = [
  ...found.map((f) => ({ label: `${f.name} at ${f.url} (${f.models.length} model${f.models.length === 1 ? '' : 's'})`, baseUrl: f.url, local: true, models: f.models })),
  { label: 'OpenAI (api.openai.com)', baseUrl: 'https://api.openai.com/v1', needsKey: true },
  { label: 'Other OpenAI-compatible endpoint (OpenRouter, DeepSeek, your own server…)', custom: true },
  { label: 'Skip for now (configure later in Agent Hub → LLM Engine)', skip: true },
];
choices.forEach((c, i) => console.log(`  ${C.c(String(i + 1))}) ${c.label}`));
const pick = choices[Math.max(0, Math.min(choices.length - 1, Number(await ask('Choose', '1')) - 1))];
if (pick.skip) { rl.close(); console.log(C.y('Skipped. Pond will start, but needs a model before it can chat.')); process.exit(0); }

let baseUrl = pick.baseUrl;
let apiKey = '';
if (pick.custom) {
  baseUrl = await ask('Base URL (ends in /v1):', 'https://openrouter.ai/api/v1');
  apiKey = await askSecret('API key (blank if none):');
} else if (pick.needsKey) {
  apiKey = await askSecret('OpenAI API key:');
}

let models = pick.models;
if (!models) {
  const r = await listModels(baseUrl, apiKey);
  if (r.ok) models = r.models;
  else console.log(C.y(`Couldn't list models (${r.status || r.error}). You can type the model name.`));
}
let model = '';
if (models?.length) {
  const shown = models.slice(0, 15);
  shown.forEach((m, i) => console.log(`  ${C.c(String(i + 1))}) ${m}`));
  if (models.length > shown.length) console.log(C.d(`  …and ${models.length - shown.length} more (type the name)`));
  const ans = await ask('Model (number or name):', '1');
  model = /^\d+$/.test(ans) ? shown[Number(ans) - 1] || shown[0] : ans;
} else {
  model = await ask('Model name:', pick.needsKey ? 'gpt-4o-mini' : '');
}
const location = await ask('Your city, for local suggestions (Enter to skip):', '');
rl.close();

applyConfig({ baseUrl, apiKey, model, location });
console.log(`\n${C.g('✓ Saved to .env')}: ${C.c(model)} at ${C.c(baseUrl)}${location ? ` · ${location}` : ''}`);

// Auto-saves HTML / three.js blocks that the assistant writes in chat, so it can find, read and reuse
// them later (after compaction or the history window has dropped the original message).
//   data/html-cache/<id>.html | <id>.three.js   +   index.json (newest first)
// IDs are content hashes (FNV-1a), computed identically in public/markdown.js for the "Open ↗" link.
// It's a temp folder: oldest entries beyond MAX_ENTRIES / MAX_AGE_DAYS are pruned automatically.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const MAX_ENTRIES = 300;
const MAX_AGE_DAYS = 60;
let dataDir = null;
const dir = () => path.join(dataDir, 'html-cache'); // resolved lazily (storage.js imports this module)

export function initHtmlCache(DATA) { dataDir = DATA; }

export function htmlId(code) {
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) { h ^= code.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return 'h' + (h >>> 0).toString(16).padStart(8, '0');
}

const FENCE = /^```(html|threejs|three)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gim;
export function extractBlocks(text) {
  const out = [];
  for (const m of String(text || '').matchAll(FENCE)) {
    const kind = m[1].toLowerCase() === 'html' ? 'html' : 'threejs';
    const code = m[2].replace(/\r/g, ''); // normalize so ids match public/markdown.js
    if (code.trim().length >= 20) out.push({ kind, code });
  }
  return out;
}

function titleOf(kind, code) {
  const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (kind === 'html') {
    const t = code.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || code.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || code.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1];
    return (t && strip(t).slice(0, 100)) || 'Untitled HTML';
  }
  const c = code.match(/^\s*\/\/\s*(?:title:\s*)?(?!height:)(.+)$/m)?.[1];
  return (c && c.trim().slice(0, 100)) || '3D scene';
}

async function loadIndex() {
  try { const a = JSON.parse(await readFile(path.join(dir(), 'index.json'), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
}
async function saveIndex(list) {
  await writeFile(path.join(dir(), 'index.json'), JSON.stringify(list, null, 2), 'utf8');
}
const fileOf = (e) => `${e.id}${e.kind === 'html' ? '.html' : '.three.js'}`;

let chain = Promise.resolve(); // serialize index writes

function pruneAndSave(index) {
  return (async () => {
    const cutoff = Date.now() - MAX_AGE_DAYS * 86400_000;
    const keep = [], drop = [];
    index.sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
    for (const e of index) ((keep.length < MAX_ENTRIES && Date.parse(e.lastSeenAt) >= cutoff) ? keep : drop).push(e);
    for (const e of drop) await rm(path.join(dir(), fileOf(e)), { force: true }).catch(() => {});
    await saveIndex(keep);
  })();
}

async function addEntry(index, { kind, code, title, sessionId = null, parentId = null }, now) {
  code = String(code).replace(/\r/g, '');
  const id = htmlId(code);
  const existing = index.find((e) => e.id === id);
  if (existing) { existing.lastSeenAt = now; return existing; }
  const e = { id, kind, title: title || titleOf(kind, code), sessionId, ...(parentId ? { parentId } : {}), createdAt: now, lastSeenAt: now, bytes: Buffer.byteLength(code) };
  await writeFile(path.join(dir(), fileOf(e)), code, 'utf8');
  index.unshift(e);
  return e;
}

export function cacheHtmlFromMessage(entry, sessionId = null) {
  if (!dataDir || entry?.role !== 'assistant' || typeof entry.content !== 'string' || !entry.content.includes('```')) return Promise.resolve([]);
  const blocks = extractBlocks(entry.content);
  if (!blocks.length) return Promise.resolve([]);
  chain = chain.then(async () => {
    await mkdir(dir(), { recursive: true });
    const index = await loadIndex();
    const now = new Date().toISOString();
    const saved = [];
    for (const b of blocks) saved.push((await addEntry(index, { ...b, sessionId }, now)).id);
    await pruneAndSave(index);
    return saved;
  }).catch((err) => { console.warn('[html-cache]', err?.message || err); return []; });
  return chain;
}

// Save an edited version (edit_artifact): ids are content hashes, so an edit is a new entry that remembers its parent.
export function saveHtmlVersion({ kind, code, title, sessionId = null, parentId = null }) {
  if (!dataDir) return Promise.resolve(null);
  chain = chain.then(async () => {
    await mkdir(dir(), { recursive: true });
    const index = await loadIndex();
    const e = await addEntry(index, { kind, code, title, sessionId, parentId }, new Date().toISOString());
    await pruneAndSave(index);
    return e;
  }).catch((err) => { console.warn('[html-cache]', err?.message || err); return null; });
  return chain;
}

export async function listHtml({ query = '', limit = 20, kind = '' } = {}) {
  if (!dataDir) return [];
  const q = String(query).toLowerCase();
  return (await loadIndex())
    .filter((e) => (!kind || e.kind === kind) && (!q || e.title.toLowerCase().includes(q) || e.id.includes(q)))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
    .map(({ id, kind: k, title, createdAt, lastSeenAt, bytes }) => ({ id, kind: k, title, createdAt, lastSeenAt, bytes }));
}

export async function readHtml(id) {
  if (!dataDir || !/^h[0-9a-f]{8}$/.test(String(id))) return null;
  const e = (await loadIndex()).find((x) => x.id === id);
  if (!e) return null;
  try { return { ...e, content: await readFile(path.join(dir(), fileOf(e)), 'utf8') }; } catch { return null; }
}

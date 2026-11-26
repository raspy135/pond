// Memory documents: topic files that hold the detail behind Pond's short core memory.
//
// memory.json        — the core: a few dozen facts loaded into every chat.
// data/memory/*.md   — one doc per topic (a person, a project, a place, preferences…), opened on demand with
//                      recall_memory(doc). Docs link to each other with [[name]].
//
// File format (plain Markdown, readable and editable by hand):
//   # Title
//   > one-line description — shown in the index every chat sees
//
//   body…
import path from 'node:path';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { DATA, writeFileAtomic, withFileLock } from './storage.js';

export const memoryDocsDir = () => path.join(DATA, 'memory');
export const MAX_DOC_CHARS = 12_000;

export function slugifyDoc(name) {
  return String(name || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[\s_/\\:]+/g, '-')
    // keep letters/digits in any script (Japanese titles stay readable), drop punctuation
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

const docPath = (name) => path.join(memoryDocsDir(), `${name}.md`);

export function parseDoc(name, text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let title = name;
  let description = '';
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (/^#\s+/.test(lines[i] || '')) { title = lines[i].replace(/^#\s+/, '').trim(); i++; }
  while (i < lines.length && !lines[i].trim()) i++;
  if (/^>\s?/.test(lines[i] || '')) { description = lines[i].replace(/^>\s?/, '').trim(); i++; }
  const content = lines.slice(i).join('\n').trim();
  return { name, title, description, content };
}

export function formatDoc({ title, description, content }) {
  return `# ${String(title || '').trim()}\n> ${String(description || '').replace(/\s+/g, ' ').trim()}\n\n${String(content || '').trim()}\n`;
}

export async function listMemoryDocs() {
  let files = [];
  try { files = await readdir(memoryDocsDir()); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.md') || f.startsWith('.')) continue;
    const name = f.slice(0, -3);
    try {
      const [text, st] = await Promise.all([readFile(docPath(name), 'utf8'), stat(docPath(name))]);
      const d = parseDoc(name, text);
      out.push({ name, title: d.title, description: d.description, chars: d.content.length, updatedAt: st.mtime.toISOString() });
    } catch { /* unreadable: skip */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readMemoryDoc(name) {
  const slug = slugifyDoc(name);
  if (!slug) return null;
  try {
    return parseDoc(slug, await readFile(docPath(slug), 'utf8'));
  } catch {
    // fall back to a title match ("Tide LM" → tidelm)
    const all = await listMemoryDocs();
    const hit = all.find((d) => d.title.toLowerCase() === String(name).toLowerCase() || slugifyDoc(d.title) === slug);
    if (!hit) return null;
    return parseDoc(hit.name, await readFile(docPath(hit.name), 'utf8'));
  }
}

export async function writeMemoryDoc({ name, title, description, content }) {
  const slug = slugifyDoc(name || title);
  if (!slug) throw new Error('doc name is required');
  await mkdir(memoryDocsDir(), { recursive: true });
  const docTitle = String(title || slug).trim();
  let body = String(content || '').replace(/\r\n/g, '\n').trim();
  // models often repeat the title as a heading at the top of the body: it's already the doc's own heading
  const head = body.match(/^#\s+(.+)(\n|$)/);
  if (head && head[1].trim().toLowerCase() === docTitle.toLowerCase()) body = body.slice(head[0].length).trim();
  body = body.slice(0, MAX_DOC_CHARS);
  const full = docPath(slug);
  await withFileLock(full, () => writeFileAtomic(full, formatDoc({ title: docTitle, description, content: body })));
  return slug;
}

export async function deleteMemoryDoc(name) {
  const slug = slugifyDoc(name);
  if (!slug) return false;
  try { await rm(docPath(slug)); return true; } catch { return false; }
}

// Lines in any doc (and its title/description) that contain the query — for recall_memory(query).
export async function searchMemoryDocs(query, { limit = 40 } = {}) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const hits = [];
  for (const d of await listMemoryDocs()) {
    const doc = await readMemoryDoc(d.name);
    if (!doc) continue;
    const lines = [doc.title, doc.description, ...doc.content.split('\n')];
    for (const line of lines) {
      const l = line.toLowerCase();
      if (line.trim() && terms.every((t) => l.includes(t))) {
        hits.push({ doc: d.name, line: line.trim().slice(0, 300) });
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
}

// forget_memory also removes matching lines from docs (never the title/description line).
export async function forgetInMemoryDocs(query) {
  const q = String(query || '').toLowerCase().trim();
  if (q.length < 3) return 0;
  let removed = 0;
  for (const d of await listMemoryDocs()) {
    const doc = await readMemoryDoc(d.name);
    if (!doc) continue;
    const lines = doc.content.split('\n');
    const kept = lines.filter((l) => !(l.trim() && !/^#/.test(l.trim()) && l.toLowerCase().includes(q)));
    if (kept.length !== lines.length) {
      removed += lines.length - kept.length;
      await writeMemoryDoc({ ...doc, content: kept.join('\n') });
    }
  }
  return removed;
}

// The index every chat sees: core facts, then one line per doc.
export function formatMemoryIndex(core, docs) {
  const parts = [];
  if (core.length) parts.push(`User memory:\n${core.map((m) => `- ${m.fact}`).join('\n')}`);
  if (docs.length) {
    parts.push(
      `Memory docs (details — open with recall_memory(doc="name") before answering about these):\n${docs
        .slice(0, 60)
        .map((d) => `- ${d.name}: ${d.description || d.title}`)
        .join('\n')}`
    );
  }
  return parts.join('\n');
}

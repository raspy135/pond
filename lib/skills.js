// Skills: reusable, named procedures the agent can save and re-run (e.g. "rebuild my mission-control dashboard").
// Layout matches Claude / Hermes / OpenClaw skills, so they stay portable:
//   data/skills/<name>/SKILL.md      — frontmatter (name, description) + step-by-step instructions
//   data/skills/<name>/<files>       — optional resources, e.g. template.html
import { readFile, writeFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { DATA, ROOT, uid } from './storage.js';

export const SKILLS_DIR = path.join(DATA, 'skills');          // user skills (private, editable)
export const SYSTEM_SKILLS_DIR = path.join(ROOT, 'skills');   // built-in skills shipped with Pond (read-only)
const SAFE_EXTS = new Set(['.md', '.txt', '.html', '.css', '.js', '.json', '.csv', '.py', '.svg', '.yaml', '.yml']);
const MAX_FILE_CHARS = 400_000;

export function skillSlug(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function skillDir(name, base = SKILLS_DIR) {
  const slug = skillSlug(name);
  if (!slug) return null;
  const dir = path.join(base, slug);
  return dir.startsWith(base + path.sep) ? dir : null;
}
// User skill wins over a built-in one with the same name (lets users customize a built-in).
async function findSkill(name) {
  for (const [base, builtin] of [[SKILLS_DIR, false], [SYSTEM_SKILLS_DIR, true]]) {
    const dir = skillDir(name, base);
    if (!dir) continue;
    try { await stat(path.join(dir, 'SKILL.md')); return { dir, builtin }; } catch { /* next */ }
  }
  return null;
}

function safeFileName(file) {
  const base = path.basename(String(file || '').trim());
  if (!base || base === 'SKILL.md' || base.startsWith('.')) return null;
  return SAFE_EXTS.has(path.extname(base).toLowerCase()) ? base : null;
}

function parseSkillMd(md) {
  const m = String(md || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
      if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  return { meta, body: (m ? m[2] : String(md || '')).trim() };
}

const oneLine = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

async function scanDir(base, builtin) {
  let entries = [];
  try { entries = await readdir(base, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(base, e.name);
    try {
      const md = await readFile(path.join(dir, 'SKILL.md'), 'utf8');
      const { meta } = parseSkillMd(md);
      const files = (await readdir(dir)).filter((f) => f !== 'SKILL.md' && !f.startsWith('.'));
      const st = await stat(path.join(dir, 'SKILL.md'));
      out.push({ name: e.name, title: meta.name || e.name, description: meta.description || '', files, updatedAt: st.mtime.toISOString(), builtin });
    } catch { /* not a skill folder */ }
  }
  return out;
}

export async function listSkills() {
  const [system, user] = await Promise.all([scanDir(SYSTEM_SKILLS_DIR, true), scanDir(SKILLS_DIR, false)]);
  const byName = new Map(system.map((s) => [s.name, s]));
  for (const s of user) byName.set(s.name, byName.has(s.name) ? { ...s, overridesBuiltin: true } : s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSkill(name) {
  const found = await findSkill(name);
  if (!found) return null;
  const { dir, builtin } = found;
  try {
    const md = await readFile(path.join(dir, 'SKILL.md'), 'utf8');
    const { meta, body } = parseSkillMd(md);
    const files = (await readdir(dir)).filter((f) => f !== 'SKILL.md' && !f.startsWith('.'));
    return { name: path.basename(dir), title: meta.name || path.basename(dir), description: meta.description || '', instructions: body, files, markdown: md, builtin };
  } catch {
    return null;
  }
}

export async function readSkillFile(name, file) {
  const dir = (await findSkill(name))?.dir;
  const base = safeFileName(file);
  if (!dir || !base) return { error: 'Invalid skill or file name' };
  try {
    const content = await readFile(path.join(dir, base), 'utf8');
    return { name: path.basename(dir), file: base, content };
  } catch {
    return { error: `File "${base}" not found in skill "${skillSlug(name)}"` };
  }
}

export async function saveSkill({ name, description = '', instructions = '', files = {} } = {}) {
  const slug = skillSlug(name) || `skill-${uid()}`;
  const dir = path.join(SKILLS_DIR, slug);
  const body = String(instructions || '').trim();
  if (!body) return { error: 'instructions are required' };
  await mkdir(dir, { recursive: true });
  const md = `---\nname: ${slug}\ndescription: ${oneLine(description, 300)}\nupdated: ${new Date().toISOString()}\n---\n\n${body}\n`;
  await writeFile(path.join(dir, 'SKILL.md'), md, 'utf8');
  const written = [];
  for (const [fname, content] of Object.entries(files && typeof files === 'object' ? files : {})) {
    const base = safeFileName(fname);
    if (!base || typeof content !== 'string') continue;
    await writeFile(path.join(dir, base), content.slice(0, MAX_FILE_CHARS), 'utf8');
    written.push(base);
  }
  return { ok: true, name: slug, files: written, path: `data/skills/${slug}/SKILL.md` };
}

export async function deleteSkill(name) {
  const dir = skillDir(name);
  if (!dir) return { error: 'Invalid skill name' };
  try { await stat(path.join(dir, 'SKILL.md')); } catch {
    return (await findSkill(name))?.builtin ? { error: 'Built-in skills cannot be deleted (save a skill with the same name to customize it).' } : { error: 'Skill not found' };
  }
  await rm(dir, { recursive: true, force: true });
  return { ok: true, deleted: path.basename(dir) };
}

// Nightly "dream": Pond re-reads the day's chats and reorganizes its long-term memory while you sleep.
//
//   1. Extract  — for each chat that changed since the last dream, pull out what's worth keeping (user-stated
//                 facts only), one small model call per chat.
//   2. Consolidate — one call that sees the core list, the topic docs and the new facts, and returns a new
//                 short core plus new/changed docs: duplicates merged, conflicts resolved toward the newer fact,
//                 detail moved out of the core into docs that link to each other with [[name]].
//   3. Commit   — the old memory is backed up first (data/memory/.dreams/<time>/); "Undo last dream" restores it.
//
// Runs once a night in a window starting at CONFIG.memory.dreamHour (default 2 am, local time), and on demand.
import path from 'node:path';
import { mkdir, readdir, readFile, rm, copyFile } from 'node:fs/promises';
import { CONFIG } from './config.js';
import { DATA, uid, readJson, writeJson, updateJson, loadSessionsIndex, loadSession, logActivity } from './storage.js';
import { completeText, parseJsonReply } from './llm.js';
import { resolveProfile } from './llm-config.js';
import {
  listMemoryDocs, readMemoryDoc, writeMemoryDoc, deleteMemoryDoc, memoryDocsDir, slugifyDoc, MAX_DOC_CHARS,
} from './memory-docs.js';
import { broadcast } from './notifications.js';

const STATE_FILE = 'dream-state.json';
const CORE_MAX = 30;          // hard cap on the always-loaded list
const CORE_TIDY_AT = 20;      // a core bigger than this gets tidied even on a night with nothing new
const MAX_CHATS = 12;         // chats read per dream (most recently active first)
const CHAT_CHARS = 12_000;    // transcript budget per chat (most recent part)
const KEEP_BACKUPS = 10;
const WINDOW_HOURS = 4;       // the dream may start any time in [dreamHour, dreamHour + 4h)
const MAX_TRIES_PER_NIGHT = 8;
const RETRY_GAP_MS = 30 * 60_000; // a model server that's down at 2:00 often isn't at 2:30 — spread tries over the window
const FIRST_LOOKBACK_DAYS = 7;   // the very first dream reads the last week of chats

let running = null;

const dreamsDir = () => path.join(memoryDocsDir(), '.dreams');
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export async function getDreamStatus() {
  const st = await readJson(STATE_FILE, {});
  return {
    enabled: CONFIG.memory?.dream !== false,
    hour: Number(CONFIG.memory?.dreamHour ?? 2),
    running: Boolean(running),
    lastRun: st.lastRun || null,
    canUndo: Boolean(st.lastChange?.backup && !st.lastChange?.undone),
  };
}

// ---------- 1. what happened since the last dream ----------
async function gatherChats(sinceMs) {
  const idx = await loadSessionsIndex();
  const metas = (idx.sessions || [])
    .filter((m) => Date.parse(m.updatedAt || 0) > sinceMs && !String(m.title || '').startsWith('⚡')) // routine chats: output, not you
    .slice(0, MAX_CHATS);
  const chats = [];
  for (const meta of metas) {
    const s = await loadSession(meta.id);
    if (!s?.messages) continue;
    const msgs = s.messages.filter((m) => !m.cancelled && !m.toolImage && Date.parse(m.ts || 0) > sinceMs);
    if (!msgs.some((m) => m.role === 'user' && String(m.content || '').trim())) continue;
    const lines = [];
    for (const m of msgs) {
      const text = String(m.content || '').replace(/\s+\n/g, '\n').trim();
      if (!text) continue;
      if (m.role === 'user') lines.push(`user: ${text.slice(0, 1500)}`);
      else if (m.role === 'assistant') lines.push(`pond${m.proactive ? ' (check-in)' : ''}: ${text.slice(0, 700)}`);
    }
    let transcript = lines.join('\n');
    if (transcript.length > CHAT_CHARS) transcript = `…\n${transcript.slice(-CHAT_CHARS)}`;
    chats.push({ id: s.id, title: s.title || 'Chat', date: localDay(new Date(Date.parse(meta.updatedAt) || Date.now())), transcript });
  }
  return chats;
}

const FACT_KINDS = ['profile', 'preference', 'person', 'project', 'plan', 'temporary'];

const EXTRACT_SYSTEM = `You read a conversation between a user and their personal assistant, Pond, and pick out what is worth remembering about the user long-term: what would still be true and useful a month from now, in a conversation about something else.

Keep:
- who they are, their work and what they build; the people in their life and how they relate
- ongoing projects: what they are, decisions made, constraints, slow-changing status
- stable preferences: how they like things done and how Pond should behave. When the user corrects Pond, keep the correction.
- places, routines, and dated commitments that are not already on their calendar

Do NOT keep:
- what Pond read rather than what the user said: emails, calendar entries, web pages, files, search results. Those can be looked up again. Keep it only when the user said something about it ("promo mail from X is never urgent", "I won't join that").
- Pond's suggestions, research or plans, unless the user clearly adopted them; then keep the decision, not the details
- one-off tasks finished in the chat, today's errands, the state of a draft or a file ("the banner is done", "fixed the bug"), small talk
- guesses. A question is not a fact about the user: asking about a word, a phrase, a person or a product does not mean they are learning it, know them or own it. When unsure what the user meant, leave it out.
- passwords, card or account numbers, government IDs

Write each fact as one self-contained sentence in the language the user used. Never write "today", "now" or "this week": the chat's date is given, so write the date when timing matters.
"kind" is one of: profile (identity, work, skills), preference, person, project, plan (a commitment or intention with a date), temporary (useful for days, not months: a pending decision, an open question).
Most chats have 0-3 facts worth keeping; many have none.
Reply with ONLY JSON: {"facts":[{"fact":"...","topic":"short topic, e.g. a project or person name","kind":"..."}]}, or {"facts":[]}.`;

async function extractFacts(chat) {
  const raw = await completeText({
    system: EXTRACT_SYSTEM,
    user: `Chat "${chat.title}" (${chat.date}):\n${chat.transcript}`,
    maxTokens: 1500,
    temperature: 0.2,
    fast: true,
    timeoutMs: (CONFIG.timeouts?.backgroundSec || 600) * 1000,
    source: 'dream',
  });
  const parsed = parseJsonReply(raw);
  const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
  return facts
    .map((f) => (typeof f === 'string' ? { fact: f, topic: '', kind: '' } : { fact: String(f?.fact || ''), topic: String(f?.topic || ''), kind: String(f?.kind || '') }))
    .map((f) => ({
      fact: f.fact.replace(/\s+/g, ' ').trim().slice(0, 400),
      topic: f.topic.trim().slice(0, 60),
      kind: FACT_KINDS.includes(f.kind.trim().toLowerCase()) ? f.kind.trim().toLowerCase() : '',
      date: chat.date,
    }))
    .filter((f) => f.fact.length > 3)
    .slice(0, 30);
}

// ---------- 2. consolidate ----------
const consolidateSystem = () => `You maintain the long-term memory of Pond, a personal assistant, during its nightly "dream".
Memory has two layers:
1. CORE: at most ${CORE_MAX} short facts loaded into every chat. Who the user is, how they want Pond to behave, the people and projects that come up all the time, and what they are focused on now.
2. DOCS: one Markdown document per topic (a person, a project, a place, an interest, preferences for one area...). Each has a name (lowercase-hyphen slug), a title, a one-line description and content. The description is shown in an index every chat sees, so it must say what is inside (names, projects, places). Docs hold the details; link related docs with [[name]].

Each core fact shows the date it was added, and "saved in chat" when Pond saved it during a conversation. Each new fact shows its kind, topic and the date of its chat. Today's date is in the input.

Tonight, fold the NEW facts into memory and tidy it.

Core is precious: it is read in every chat.
- A fact belongs in CORE only if it would matter in most chats a month from now. Everything else goes into a doc.
- Keep each core fact short (one sentence, under 200 characters). Detail lives in the doc; core keeps the gist and points at it, e.g. "Building Pond, a self-hosted AI assistant (see [[pond]])".
- Don't say the same thing in core and in a doc; core points, the doc explains.
- Content Pond read rather than the user said (emails, alerts, accounts that send mail, calendar entries) does not belong in core.

Let things expire:
- "temporary" facts never go into core. Drop them once they are more than 14 days old.
- Drop plans and appointments whose date has passed, unless they recur.
- Drop status that a newer fact replaced ("the banner is finished", "working on X this week").
- Otherwise drop only what is clearly stale or one-off. Never drop a durable fact without moving it somewhere. Never invent facts.

Keep memory consistent:
- Merge duplicates. When facts conflict, keep the newer one; note the old value only if the history matters ("lives in X (moved from Y)").
- Look for facts that cannot both be true, or that look like a misreading of the user (e.g. "is a native speaker of X" next to "is learning X"). Keep the better-supported one, drop the other, and say so in the summary.
- "saved in chat" facts: reword, merge or move them into a doc freely, but drop one only when it is a duplicate, outdated, or contradicted as above.
- After your edits, every doc's description must still match its content.

Docs:
- Group related facts into one doc rather than many tiny ones; a doc needs at least a few facts or a clear future use.
- "content" is the body only. Don't start it with the title as a heading: the title is stored separately.
- Keep each fact in the language it was written in.
- Never store passwords, card or account numbers, or government IDs.

Reply with ONLY one JSON object:
{
  "core": ["fact", "..."],
  "docs": [{"name": "slug", "title": "Title", "description": "what is inside", "content": "full Markdown body"}],
  "append": [{"name": "slug", "lines": ["- fact"]}],
  "delete": ["slug"],
  "summary": "at most two short sentences (under 300 characters): what changed, and anything you dropped as stale or contradictory"
}
"core" is the complete new core list. "docs" lists only docs you create or rewrite, each with its full content. Docs marked (content not shown) must not be rewritten: add to them with "append". "delete" removes docs whose facts you merged elsewhere.`;

function buildConsolidateInput({ core, docsFull, docsBrief, newFacts, sinceMs }) {
  const coreLines = core.map((m) => {
    const t = Date.parse(m.createdAt || 0);
    const tags = [t ? `added ${localDay(new Date(t))}` : '', m.source !== 'dream' ? 'saved in chat' : '', t > sinceMs ? 'new' : ''].filter(Boolean);
    return `- ${m.fact}${tags.length ? `   (${tags.join(', ')})` : ''}`;
  });
  const docBlocks = [
    ...docsFull.map((d) => `### ${d.name} — ${d.title}\n> ${d.description}\n${d.content || '(empty)'}`),
    ...docsBrief.map((d) => `### ${d.name} — ${d.title}\n> ${d.description}\n(content not shown — use "append" to add to it)`),
  ];
  const facts = newFacts.map((f) => `- [${[f.kind || 'fact', f.topic, f.date].filter(Boolean).join(' · ')}] ${f.fact}`);
  return [
    `Today: ${localDay()} (${new Date().toDateString()})`,
    `CURRENT CORE (${core.length}):\n${coreLines.join('\n') || '(empty)'}`,
    `CURRENT DOCS (${docBlocks.length}):\n${docBlocks.join('\n\n') || '(none yet)'}`,
    `NEW FACTS from chats since the last dream (${facts.length}):\n${facts.join('\n') || '(none — just tidy)'}`,
  ].join('\n\n');
}

// Shorten at the last sentence end (or space) before the limit, so a long summary doesn't stop mid-word.
function clipText(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。'));
  if (sentence > max * 0.5) return cut.slice(0, sentence + 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function validatePlan(plan, { core, docNames, hidden }) {
  if (!plan || typeof plan !== 'object') throw new Error('the model did not return a memory plan');
  const newCore = [...new Set((Array.isArray(plan.core) ? plan.core : [])
    .map((f) => String(typeof f === 'string' ? f : f?.fact || '').replace(/\s+/g, ' ').trim())
    .filter((f) => f.length > 2)
    .map((f) => f.slice(0, 400)))].slice(0, CORE_MAX);
  const docs = (Array.isArray(plan.docs) ? plan.docs : [])
    .map((d) => ({
      name: slugifyDoc(d?.name || d?.title),
      title: String(d?.title || d?.name || '').trim().slice(0, 100),
      description: String(d?.description || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      content: String(d?.content || '').trim().slice(0, MAX_DOC_CHARS),
    }))
    .filter((d) => d.name && d.content);
  const append = (Array.isArray(plan.append) ? plan.append : [])
    .map((a) => ({ name: slugifyDoc(a?.name), lines: (Array.isArray(a?.lines) ? a.lines : [a?.lines]).map((l) => String(l || '').trim()).filter(Boolean) }))
    .filter((a) => a.name && a.lines.length);
  // a doc the model only saw as a one-liner can't be safely rewritten: add its text instead
  for (const d of docs.filter((x) => hidden.has(x.name))) append.push({ name: d.name, lines: d.content.split('\n').filter((l) => l.trim()) });
  const rewrites = docs.filter((d) => !hidden.has(d.name));
  const del = [...new Set((Array.isArray(plan.delete) ? plan.delete : []).map(slugifyDoc))]
    .filter((n) => n && docNames.has(n) && !rewrites.some((d) => d.name === n));

  // Guards against a bad night (truncated output, a confused small model): refuse rather than lose memory.
  if (core.length >= 3 && !newCore.length) throw new Error('the plan had an empty core');
  if (docNames.size >= 4 && del.length > docNames.size / 2) throw new Error(`the plan deleted ${del.length} of ${docNames.size} docs`);
  const before = core.length;
  if (before >= 8 && newCore.length < before / 4 && !rewrites.length) throw new Error('the plan dropped most of the core without moving it into docs');
  return { core: newCore, docs: rewrites, append, delete: del, summary: clipText(String(plan.summary || '').replace(/\s+/g, ' ').trim(), 500) };
}

// ---------- 3. backup / commit / undo ----------
async function backupMemory() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(dreamsDir(), stamp);
  await mkdir(dir, { recursive: true });
  await writeJson(path.relative(DATA, path.join(dir, 'memory.json')), await readJson('memory.json', []));
  for (const d of await listMemoryDocs()) await copyFile(path.join(memoryDocsDir(), `${d.name}.md`), path.join(dir, `${d.name}.md`));
  // prune old backups
  try {
    const all = (await readdir(dreamsDir())).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) await rm(path.join(dreamsDir(), old), { recursive: true, force: true });
  } catch { /* ignore */ }
  return stamp;
}

async function commitPlan(plan, { startedAt }) {
  for (const d of plan.docs) await writeMemoryDoc(d);
  for (const a of plan.append) {
    const doc = await readMemoryDoc(a.name);
    const base = doc || { title: a.name, description: '', content: '' };
    await writeMemoryDoc({ ...base, name: a.name, content: `${base.content}\n${a.lines.join('\n')}`.trim() });
  }
  for (const n of plan.delete) await deleteMemoryDoc(n);
  await updateJson('memory.json', [], (mem) => {
    const prev = Array.isArray(mem) ? mem : [];
    const byText = new Map(prev.map((m) => [String(m.fact).toLowerCase(), m]));
    const now = new Date().toISOString();
    const next = plan.core.map((fact) => {
      const old = byText.get(fact.toLowerCase());
      return old ? { ...old, fact } : { id: uid(), fact, createdAt: now, source: 'dream' };
    });
    // anything remembered while the dream was running stays
    for (const m of prev) if (Date.parse(m.createdAt || 0) > startedAt && !next.some((x) => x.id === m.id)) next.push(m);
    return next;
  });
}

export async function undoLastDream() {
  if (running) throw new Error('a dream is running — try again when it finishes');
  const st = await readJson(STATE_FILE, {});
  const run = st.lastChange;
  if (!run?.backup || run.undone) throw new Error('there is no dream to undo');
  const dir = path.join(dreamsDir(), run.backup);
  let files;
  try { files = await readdir(dir); } catch { throw new Error('the backup for that dream is gone'); }
  const saved = await readJson(path.relative(DATA, path.join(dir, 'memory.json')), []);
  const current = await readJson('memory.json', []);
  for (const d of await listMemoryDocs()) await deleteMemoryDoc(d.name);
  await mkdir(memoryDocsDir(), { recursive: true });
  for (const f of files) if (f.endsWith('.md')) await copyFile(path.join(dir, f), path.join(memoryDocsDir(), f));
  const runAt = Date.parse(run.at || 0);
  const keepNew = (Array.isArray(current) ? current : []).filter((m) => Date.parse(m.createdAt || 0) > runAt && m.source !== 'dream');
  await writeJson('memory.json', [...saved, ...keepNew.filter((m) => !saved.some((s) => s.id === m.id))]);
  // the chats that dream read count as unread again, so the next dream looks at them
  const undone = { ...run, undone: true };
  await writeJson(STATE_FILE, { ...st, lastDreamAt: run.since || null, lastChange: undone, ...(st.lastRun?.at === run.at ? { lastRun: undone } : {}) });
  await logActivity({ kind: 'memory', title: 'Undid last dream', detail: run.summary || '' });
  broadcast({ type: 'memory_updated' });
  return { ok: true };
}

// ---------- run ----------
export function runDream({ reason = 'manual' } = {}) {
  if (running) return running;
  running = (async () => {
    const startedAt = Date.now();
    const st = await readJson(STATE_FILE, {});
    // (Date.parse(0) is a date in the year 2000, not NaN — so test for a missing value explicitly)
    const sinceMs = (st.lastDreamAt && Date.parse(st.lastDreamAt)) || startedAt - FIRST_LOOKBACK_DAYS * 86_400_000;
    broadcast({ type: 'memory_updated', running: true });
    const record = async (lastRun) => {
      const full = { ...lastRun, since: new Date(sinceMs).toISOString() };
      // lastChange = the last dream that actually rewrote memory (what "Undo" restores); a quiet night doesn't replace it
      await updateJson(STATE_FILE, {}, (s) => ({ ...s, lastRun: full, ...(full.backup ? { lastChange: full } : {}), ...(full.ok ? { lastDreamAt: full.at } : {}) }));
      broadcast({ type: 'memory_updated' });
      return lastRun;
    };
    let modelUrl = '';
    try {
      const profile = await resolveProfile();
      modelUrl = profile.baseUrl || '';
      if (!profile.keyConfigured) throw new Error('no model is configured');
      const core = (await readJson('memory.json', [])).filter((m) => m && m.fact);
      const chats = await gatherChats(sinceMs);
      const newFacts = [];
      for (const chat of chats) {
        try { newFacts.push(...(await extractFacts(chat))); } catch (err) { console.error('dream extract:', chat.title, err?.message || err); }
      }
      const newCore = core.filter((m) => Date.parse(m.createdAt || 0) > sinceMs);
      if (!newFacts.length && !newCore.length && core.length <= CORE_TIDY_AT) {
        const summary = chats.length ? `Read ${chats.length} chat(s); nothing new worth keeping.` : 'No new chats since the last dream.';
        return await record({ at: new Date().toISOString(), ok: true, reason, summary, stats: { chats: chats.length, facts: 0 }, skipped: true });
      }

      // Docs go in with full content while they fit; past that, as one-liners the model can only append to.
      const budget = Math.min(140_000, Math.floor(profile.contextLength * 3.2 * 0.5));
      const docs = [];
      for (const d of await listMemoryDocs()) { const full = await readMemoryDoc(d.name); if (full) docs.push(full); }
      let used = JSON.stringify(core).length + JSON.stringify(newFacts).length;
      const docsFull = [];
      const docsBrief = [];
      for (const d of docs) {
        if (used + d.content.length < budget) { docsFull.push(d); used += d.content.length; } else docsBrief.push(d);
      }
      const raw = await completeText({
        system: consolidateSystem(),
        user: buildConsolidateInput({ core, docsFull, docsBrief, newFacts, sinceMs }),
        maxTokens: Math.min(16_000, Math.max(4000, Math.floor(profile.contextLength / 4))),
        temperature: 0.2,
        fast: false,
        timeoutMs: (CONFIG.timeouts?.agentStepSec || 3600) * 1000,
        source: 'dream',
      });
      const plan = validatePlan(parseJsonReply(raw), {
        core,
        docNames: new Set(docs.map((d) => d.name)),
        hidden: new Set(docsBrief.map((d) => d.name)),
      });
      const backup = await backupMemory();
      await commitPlan(plan, { startedAt });
      const stats = {
        chats: chats.length,
        facts: newFacts.length,
        coreBefore: core.length,
        coreAfter: plan.core.length,
        docsWritten: plan.docs.length + plan.append.length,
        docsDeleted: plan.delete.length,
        seconds: Math.round((Date.now() - startedAt) / 1000),
      };
      const summary = plan.summary || `Core ${core.length} → ${plan.core.length} facts; ${stats.docsWritten} doc(s) updated.`;
      await logActivity({ kind: 'memory', title: 'Dreamed: memory reorganized', detail: `${summary} (${stats.chats} chats, ${stats.facts} new facts, ${stats.seconds}s)` });
      return await record({ at: new Date().toISOString(), ok: true, reason, summary, stats, backup, changed: [...plan.docs.map((d) => d.name), ...plan.append.map((a) => a.name)] });
    } catch (err) {
      let msg = String(err?.message || err);
      if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH/i.test(msg)) msg = `the model server${modelUrl ? ` (${modelUrl})` : ''} didn't answer — is it running?`;
      await logActivity({ kind: 'memory', level: 'error', title: 'Dream failed — memory left unchanged', detail: msg });
      return await record({ at: new Date().toISOString(), ok: false, reason, error: msg, summary: `Dream failed: ${msg}` });
    }
  })().finally(() => { running = null; });
  return running;
}

// Called every few minutes: dream once per night, in the window after CONFIG.memory.dreamHour.
export async function dreamTick(now = new Date()) {
  if (running || CONFIG.memory?.dream === false) return null;
  const hour = Math.max(0, Math.min(23, Number(CONFIG.memory?.dreamHour ?? 2)));
  const since = (now.getHours() - hour + 24) % 24;
  if (since >= WINDOW_HOURS) return null;
  const night = localDay(new Date(now.getTime() - since * 3_600_000)); // the calendar day the window started
  const st = await readJson(STATE_FILE, {});
  if (st.night?.key === night && (st.night.done || st.night.tries >= MAX_TRIES_PER_NIGHT)) return null;
  if (st.night?.key === night && st.night.lastTryAt && now.getTime() - Date.parse(st.night.lastTryAt) < RETRY_GAP_MS) return null;
  const tries = st.night?.key === night ? st.night.tries + 1 : 1;
  const lastTryAt = now.toISOString();
  await updateJson(STATE_FILE, {}, (s) => ({ ...s, night: { key: night, tries, done: false, lastTryAt } }));
  const run = await runDream({ reason: 'nightly' });
  await updateJson(STATE_FILE, {}, (s) => ({ ...s, night: { key: night, tries, done: Boolean(run?.ok), lastTryAt } }));
  return run;
}

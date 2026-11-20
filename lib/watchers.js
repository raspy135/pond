// Proactive Watchers: monitor URLs, RSS/Atom feeds, or web search topics for meaningful changes.
import crypto from 'node:crypto';
import { readJson, updateJson, uid, logActivity } from './storage.js';
import { webFetch, webSearch, parseFeed } from './web.js';

const sha = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex').slice(0, 16);

export async function listWatches() {
  const list = await readJson('watches.json', []);
  return Array.isArray(list) ? list : [];
}

export async function createWatch({ name, type = 'url', target, intervalMin = 30, criteria = '' }) {
  const watch = {
    id: uid(),
    name: String(name || target).slice(0, 80),
    type: ['url', 'rss', 'search'].includes(type) ? type : 'url',
    target: String(target || '').trim(),
    intervalMin: Math.max(2, Number(intervalMin) || 30),
    criteria: String(criteria || '').trim(),
    enabled: true,
    lastCheckedAt: null,
    lastHash: null,
    lastSeenIds: [],
    lastSnapshot: '',
    lastError: null,
    createdAt: new Date().toISOString(),
  };
  if (!watch.target) throw new Error('target (URL, feed URL, or search query) is required');
  await updateJson('watches.json', [], (list) => [watch, ...(Array.isArray(list) ? list : [])]);
  await logActivity({ kind: 'watch', title: `Created ${watch.type} watch: ${watch.name}`, detail: watch.target });
  return watch;
}

export async function deleteWatch(idOrQuery) {
  const q = String(idOrQuery || '').toLowerCase();
  let removed = 0;
  await updateJson('watches.json', [], (list) => {
    const arr = Array.isArray(list) ? list : [];
    const next = arr.filter((w) => !(w.id === idOrQuery || w.name.toLowerCase().includes(q)));
    removed = arr.length - next.length;
    return next;
  });
  return { ok: true, deleted: removed };
}

export async function checkSingleWatch(watch) {
  const nowIso = new Date().toISOString();
  try {
    let changed = false;
    let diffSummary = '';
    let newHash = watch.lastHash;
    let newSeenIds = watch.lastSeenIds || [];
    let newSnapshot = watch.lastSnapshot || '';

    if (watch.type === 'rss') {
      const resp = await fetch(watch.target, { signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const xml = await resp.text();
      const items = parseFeed(xml);
      const prevSet = new Set(watch.lastSeenIds || []);
      const fresh = items.filter((it) => !prevSet.has(it.id));
      newSeenIds = items.map((it) => it.id).slice(0, 80);
      newSnapshot = items.slice(0, 5).map((i) => `${i.title} (${i.link})`).join('\n');
      if (watch.lastCheckedAt && fresh.length > 0) {
        changed = true;
        diffSummary = fresh
          .slice(0, 5)
          .map((i) => `• ${i.title}${i.link ? ` — ${i.link}` : ''}${i.summary ? `\n  ${i.summary.slice(0, 160)}` : ''}`)
          .join('\n');
      }
    } else if (watch.type === 'search') {
      const res = await webSearch(watch.target, 6);
      const results = res.results || [];
      const prevSet = new Set(watch.lastSeenIds || []);
      const fresh = results.filter((r) => !prevSet.has(r.url));
      newSeenIds = results.map((r) => r.url).slice(0, 50);
      newSnapshot = results.map((r) => `${r.title}: ${r.url}`).join('\n');
      if (watch.lastCheckedAt && fresh.length > 0) {
        changed = true;
        diffSummary = fresh
          .slice(0, 4)
          .map((r) => `• ${r.title} — ${r.url}${r.snippet ? `\n  ${r.snippet.slice(0, 160)}` : ''}`)
          .join('\n');
      }
    } else {
      const page = await webFetch(watch.target, 5000);
      const normalized = page.text.replace(/\s+/g, ' ').trim();
      newHash = sha(normalized);
      newSnapshot = normalized.slice(0, 1200);
      if (watch.lastHash && watch.lastHash !== newHash) {
        changed = true;
        diffSummary = `Content changed on ${page.url} (${page.title || watch.name}). New excerpt:\n${normalized.slice(0, 700)}`;
      }
    }

    await updateJson('watches.json', [], (list) =>
      (Array.isArray(list) ? list : []).map((w) =>
        w.id === watch.id
          ? {
              ...w,
              lastCheckedAt: nowIso,
              lastHash: newHash,
              lastSeenIds: newSeenIds,
              lastSnapshot: newSnapshot,
              lastError: null,
            }
          : w
      )
    );

    return { ok: true, watch, changed, diffSummary };
  } catch (err) {
    const msg = String(err?.message || err);
    await updateJson('watches.json', [], (list) =>
      (Array.isArray(list) ? list : []).map((w) =>
        w.id === watch.id ? { ...w, lastCheckedAt: nowIso, lastError: msg } : w
      )
    );
    return { ok: false, watch, changed: false, error: msg };
  }
}

export async function checkDueWatches() {
  const watches = await listWatches();
  const now = Date.now();
  const updates = [];
  for (const w of watches) {
    if (!w.enabled) continue;
    const last = w.lastCheckedAt ? new Date(w.lastCheckedAt).getTime() : 0;
    if (now - last < (w.intervalMin || 30) * 60_000) continue;
    const res = await checkSingleWatch(w);
    if (res.changed) updates.push(res);
  }
  return updates;
}

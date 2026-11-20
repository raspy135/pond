// "Pond Share": a folder Pond serves at /share/… so files the AI makes open on every device (phone included),
// not just on the machine whose disk they're on. It lives inside the file root, so write_file / run_python reach it.
import { readFile, readdir, stat, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG } from './config.js';

export function shareDir() { return CONFIG.shareDir; }
export async function ensureShareDir() { await mkdir(CONFIG.shareDir, { recursive: true }).catch(() => {}); }

const encodePath = (rel) => rel.split(/[\\/]+/).filter(Boolean).map(encodeURIComponent).join('/');

// Absolute path -> "/share/…" URL, or null when the file isn't in the share folder.
export function shareUrlFor(absPath) {
  const rel = path.relative(CONFIG.shareDir, path.resolve(absPath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return `/share/${encodePath(rel)}`;
}

// Copy an existing file from the file root into the share folder (same name unless `name` is given).
export async function shareExistingFile(absSrc, name) {
  const base = path.basename(String(name || absSrc)).replace(/[<>:"|?*\u0000-\u001f]/g, '_');
  if (!base || base.startsWith('.')) throw new Error('Invalid file name');
  await ensureShareDir();
  const dest = path.join(CONFIG.shareDir, base);
  if (path.resolve(absSrc) !== path.resolve(dest)) await copyFile(absSrc, dest);
  return dest;
}

function resolveShare(urlRest) {
  let parts;
  try { parts = String(urlRest || '').split('/').filter(Boolean).map((s) => decodeURIComponent(s)); } catch { return null; }
  if (parts.some((s) => s === '..' || s.startsWith('.') || /[\\/\u0000]/.test(s))) return null; // no traversal, no dotfiles
  const full = path.resolve(CONFIG.shareDir, ...parts);
  const rel = path.relative(CONFIG.shareDir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return { full, rel };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const IMPORT_MAP = '<script type="importmap">{"imports":{"three":"/vendor/three/three.module.js","three/addons/":"/vendor/three/addons/"}}</script>';
// When a page is embedded in a chat message (?embed=1&theme=…): follow Pond's light/dark theme and report its
// height so the frame fits its content — same contract as the inline ```html previews.
const EMBED_PRELUDE = `<script>(function(){var q=new URLSearchParams(location.search),t=q.get('theme');if(t)document.documentElement.setAttribute('data-theme',t);`
  + `addEventListener('message',function(e){if(e.data&&e.data.pondTheme)document.documentElement.setAttribute('data-theme',e.data.pondTheme)});`
  + `var last=0;function post(){var d=document.documentElement,h=Math.ceil(d.getBoundingClientRect().height)||d.scrollHeight;if(Math.abs(h-last)>4){last=h;parent.postMessage({pondFrameHeight:h},'*');}}`
  + `addEventListener('load',function(){post();if(window.ResizeObserver)new ResizeObserver(post).observe(document.body);setTimeout(post,1500);});})();<\/script>`;

// Add Pond's three.js import map (and, for embeds, the prelude) right after <head> (or at the top).
export function preparePage(html, { embed = false } = {}) {
  const add = IMPORT_MAP + (embed ? EMBED_PRELUDE : '');
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + add);
  if (/<!doctype[^>]*>/i.test(html)) return html.replace(/<!doctype[^>]*>/i, (m) => m + add);
  return add + html;
}
const isEmbed = (req) => /[?&]embed=1(&|$)/.test(req.url || '');

export { isEmbed };
export async function serveShare(req, res, urlRest, MIME) {
  const r = resolveShare(urlRest);
  if (!r) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  let st;
  try { st = await stat(r.full); } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  if (st.isDirectory()) {
    if (!String(urlRest).endsWith('/') && urlRest) { res.writeHead(301, { Location: `/share/${encodePath(r.rel)}/` }); return res.end(); }
    const entries = (await readdir(r.full, { withFileTypes: true })).filter((e) => !e.name.startsWith('.'));
    const rows = await Promise.all(entries.map(async (e) => {
      let mtime = 0; try { mtime = (await stat(path.join(r.full, e.name))).mtimeMs; } catch { /* ignore */ }
      return { name: e.name + (e.isDirectory() ? '/' : ''), mtime };
    }));
    rows.sort((a, b) => b.mtime - a.mtime);
    const title = r.rel ? `Pond Share / ${r.rel}` : 'Pond Share';
    const list = rows.length
      ? rows.map((x) => `<a href="${encodeURIComponent(x.name.replace(/\/$/, ''))}${x.name.endsWith('/') ? '/' : ''}"><span>${esc(x.name)}</span><time>${x.mtime ? new Date(x.mtime).toLocaleString() : ''}</time></a>`).join('')
      : '<p class="empty">Nothing shared yet. Ask Pond to save or share a file here.</p>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark;--fg:#0f172a;--mut:#64748b;--bd:#e2e8f0;--bg:#fff;--ac:#06b6d4}@media(prefers-color-scheme:dark){:root{--fg:#e2e8f0;--mut:#94a3b8;--bd:#1e293b;--bg:#0b1120}}
body{margin:0;font:15px/1.4 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg)}main{max-width:720px;margin:0 auto;padding:24px 16px}h1{font-size:20px;margin:0 0 16px}
a{display:flex;justify-content:space-between;gap:12px;padding:12px 4px;border-bottom:1px solid var(--bd);color:inherit;text-decoration:none}a:hover span{color:var(--ac)}time{color:var(--mut);font-size:13px;white-space:nowrap}.empty{color:var(--mut)}</style></head>
<body><main><h1>${esc(title)}</h1>${r.rel ? '<a href="../"><span>..</span><time></time></a>' : ''}${list}</main></body></html>`);
  }
  const ext = path.extname(r.full).toLowerCase();
  let data = await readFile(r.full);
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*', // sandboxed pages have an opaque origin; lets them fetch their own data.json / modules
  };
  if (ext === '.html' || ext === '.htm' || ext === '.svg') {
    headers['Content-Security-Policy'] = 'sandbox allow-scripts allow-forms allow-popups allow-downloads'; // can't touch Pond's API
    if (ext !== '.svg') {
      data = Buffer.from(preparePage(data.toString('utf8'), { embed: isEmbed(req) }), 'utf8');
      headers['Content-Type'] = 'text/html; charset=utf-8';
    }
  }
  res.writeHead(200, headers);
  return res.end(data);
}

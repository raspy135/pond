// Pond pages as apps of their own. /apps/<key>/ shows a saved artifact (a-<id>) or a Pond Share page
// (s-<base64url path>) full screen, with its own web-app manifest, so the browser offers "Install" and it gets its
// own icon and window. The page itself still runs in the sandboxed frame (opaque origin, no access to Pond's API);
// only this small fixed wrapper runs on Pond's origin.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG } from './config.js';
import { getArtifact } from './tools.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const b64u = { enc: (s) => Buffer.from(s, 'utf8').toString('base64url'), dec: (s) => Buffer.from(s, 'base64url').toString('utf8') };

// The app key for a Pond page URL (/artifacts/<id> or /share/<path>.html), or null.
export function appKeyFor(url) {
  const u = String(url || '').split(/[?#]/)[0];
  let m = u.match(/^\/artifacts\/([A-Za-z0-9_-]+)$/);
  if (m) return `a-${m[1]}`;
  m = u.match(/^\/share\/(.+\.html?)$/i);
  if (m) { try { return `s-${b64u.enc(decodeURIComponent(m[1]))}`; } catch { return null; } }
  return null;
}

async function resolveApp(key) {
  let m = key.match(/^a-([A-Za-z0-9_-]+)$/);
  if (m) {
    const a = await getArtifact(m[1]);
    if (!a || a.type !== 'html') return null;
    return { title: a.title || 'Pond page', src: `/artifacts/${m[1]}` };
  }
  m = key.match(/^s-([A-Za-z0-9_-]+)$/);
  if (m) {
    let rel;
    try { rel = b64u.dec(m[1]); } catch { return null; }
    const parts = rel.split('/').filter(Boolean);
    if (!parts.length || parts.some((p) => p === '..' || p.startsWith('.')) || !/\.html?$/i.test(rel)) return null;
    const full = path.resolve(CONFIG.shareDir, ...parts);
    if (path.relative(CONFIG.shareDir, full).startsWith('..')) return null;
    let html;
    try { html = await readFile(full, 'utf8'); } catch { return null; }
    const t = html.match(/<title[^>]*>([^<]{1,120})<\/title>/i)?.[1]?.trim();
    return { title: t || parts[parts.length - 1].replace(/\.html?$/i, ''), src: `/share/${parts.map(encodeURIComponent).join('/')}` };
  }
  return null;
}

// A simple icon: the first letter of the title on a colour picked from the title.
function iconSvg(title) {
  let h = 0;
  for (const ch of String(title)) h = (h * 31 + ch.codePointAt(0)) % 360;
  const letter = esc((String(title).trim()[0] || 'P').toUpperCase());
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="hsl(${h} 45% 38%)"/><text x="256" y="336" font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="260" font-weight="600" text-anchor="middle" fill="#fff">${letter}</text></svg>`;
}

// Handles GET /apps/<key>/, /apps/<key>/manifest.webmanifest, /apps/<key>/icon.svg, /apps/<key>/sw.js.
export async function handleAppRoute(req, res, pathname) {
  const m = pathname.match(/^\/apps\/([A-Za-z0-9_-]{3,400})(\/.*)?$/);
  if (!m) return false;
  const [, key, rest = ''] = m;
  if (rest === '') { res.writeHead(301, { Location: `/apps/${key}/` }); res.end(); return true; }
  const app = await resolveApp(key);
  if (!app) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('This page no longer exists.'); return true; }
  const base = `/apps/${key}/`;
  if (rest === '/manifest.webmanifest') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({
      id: base, name: app.title, short_name: app.title.slice(0, 24), start_url: base, scope: base,
      display: 'standalone', background_color: '#ffffff', theme_color: '#34373a',
      icons: [
        { src: `${base}icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      ],
    }));
    return true;
  }
  if (rest === '/icon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    res.end(iconSvg(app.title));
    return true;
  }
  if (rest === '/sw.js') { // installable everywhere; always fetches fresh (the page is live, not offline)
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',(e)=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',()=>{});");
    return true;
  }
  if (rest !== '/') { res.writeHead(404); res.end(); return true; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(app.title)}</title>
<link rel="manifest" href="${base}manifest.webmanifest">
<link rel="icon" href="${base}icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${esc(app.title.slice(0, 24))}">
<meta name="theme-color" content="#34373a">
<style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;display:block;width:100%;height:100dvh}</style>
</head><body>
<iframe src="${esc(app.src)}" title="${esc(app.title)}" sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-modals"></iframe>
<script>if('serviceWorker' in navigator)navigator.serviceWorker.register('${base}sw.js',{scope:'${base}'}).catch(function(){});</script>
</body></html>`);
  return true;
}

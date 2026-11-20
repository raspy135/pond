// Minimal, safe Markdown renderer for Pond.
// - Escapes all raw HTML, then applies markdown transforms.
// - ```html fenced blocks become sandboxed iframes (srcdoc) — Muse-style artifacts.
// - ```threejs fenced blocks become sandboxed 3D viewports (vendored three.js, orbit controls).
// - Images and links restricted to http(s)/data:image URLs.
(function () {
  // ---------- ```threejs → sandboxed WebGL viewport ----------
  // The model writes only scene content; this harness provides THREE, scene, camera, renderer,
  // controls (OrbitControls), lights and onFrame((t, dt) => {}). Runs in an opaque-origin sandbox.
  function rewriteImports(code) {
    // Static imports are illegal inside the async wrapper -> turn them into await import()/THREE aliases.
    return code.replace(/^[ \t]*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm, (m, clause, spec) => {
      clause = clause.trim();
      if (spec === 'three') {
        if (/^\*\s+as\s+THREE$/.test(clause)) return '';
        if (/^\*\s+as\s+(\w+)$/.test(clause)) return `const ${clause.split(/\s+/).pop()} = THREE;`;
        if (clause.startsWith('{')) return `const ${clause.replace(/\s+as\s+/g, ': ')} = THREE;`;
        return '';
      }
      if (/^\*\s+as\s+(\w+)$/.test(clause)) return `const ${clause.split(/\s+/).pop()} = await import('${spec}');`;
      if (clause.startsWith('{')) return `const ${clause.replace(/\s+as\s+/g, ': ')} = await import('${spec}');`;
      return `const { default: ${clause} } = await import('${spec}');`;
    }).replace(/^[ \t]*import\s+['"][^'"]+['"];?[ \t]*$/gm, '');
  }
  function threeSrcdoc(code) {
    const origin = location.origin;
    const user = rewriteImports(code).replace(/<\/script/gi, '<\\/script');
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#0f1117}canvas{display:block;width:100%;height:100%;touch-action:none}
#err{position:absolute;left:8px;top:8px;right:8px;color:#ff9b9b;font:12px ui-monospace,monospace;white-space:pre-wrap;pointer-events:none}</style>
<script type="importmap">{"imports":{"three":"${origin}/vendor/three/three.module.js","three/addons/":"${origin}/vendor/three/addons/"}}<\/script>
</head><body><script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
const showErr = (e) => { let d = document.getElementById('err'); if (!d) { d = document.createElement('div'); d.id = 'err'; document.body.appendChild(d); } d.textContent = '3D error: ' + (e && e.message || e); };
addEventListener('error', (e) => showErr(e.error || e.message));
addEventListener('unhandledrejection', (e) => showErr(e.reason));
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1117);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
camera.position.set(4, 3, 6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4250, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(5, 10, 7); scene.add(sun);
const frameFns = []; const onFrame = (fn) => { frameFns.push(fn); };
const resize = () => { const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
addEventListener('resize', resize); resize();
const timer = new THREE.Timer();
renderer.setAnimationLoop(() => {
  timer.update(); const dt = timer.getDelta(), t = timer.getElapsed();
  for (const f of frameFns) { try { f(t, dt); } catch (e) { showErr(e); frameFns.length = 0; } }
  controls.update();
  renderer.render(scene, camera);
});
try {
  await (async () => {
${user}
  })();
} catch (e) { showErr(e); }
<\/script></body></html>`;
  }

  // Same FNV-1a id as lib/htmlcache.js — links a rendered block to its auto-saved copy (/html/<id>).
  function htmlId(code) {
    code = code.replace(/\r/g, '');
    let h = 0x811c9dc5;
    for (let i = 0; i < code.length; i++) { h ^= code.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return 'h' + (h >>> 0).toString(16).padStart(8, '0');
  }

  // Prelude injected into ```html previews: follow Pond's light/dark theme (live) and resolve `import 'three'`
  // to Pond's vendored three.js. The saved copy (/html/<id>) keeps the model's original code.
  function htmlPrelude() {
    const theme = document.documentElement.getAttribute('data-theme') || 'light';
    const o = location.origin;
    return `<script>document.documentElement.setAttribute('data-theme','${theme}');addEventListener('message',function(e){if(e.data&&e.data.pondTheme)document.documentElement.setAttribute('data-theme',e.data.pondTheme)});`
      + `(function(){var last=0;function post(){var d=document.documentElement,h=Math.ceil(d.getBoundingClientRect().height)||d.scrollHeight;if(Math.abs(h-last)>4){last=h;parent.postMessage({pondFrameHeight:h},'*');}}addEventListener('load',function(){post();if(window.ResizeObserver)new ResizeObserver(post).observe(document.body);setTimeout(post,1500);});})();<\/script>`
      + `<script type="importmap">{"imports":{"three":"${o}/vendor/three/three.module.js","three/addons/":"${o}/vendor/three/addons/"}}<\/script>`;
  }
  function withPrelude(code) {
    const pre = htmlPrelude();
    if (/<head[^>]*>/i.test(code)) return code.replace(/<head[^>]*>/i, (m) => m + pre);
    if (/<!doctype[^>]*>/i.test(code)) return code.replace(/<!doctype[^>]*>/i, (m) => m + pre);
    return pre + code;
  }

  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const safeUrl = (url, { allowDataImage = false } = {}) => {
    const u = String(url).trim();
    if (/^https?:\/\//i.test(u)) return u;
    if (allowDataImage && /^data:image\/(png|gif|jpe?g|webp|svg\+xml);/i.test(u)) return u;
    if (u.startsWith('/') || u.startsWith('#') || u.startsWith('./') || u.startsWith('../')) return u;
    return null;
  };

  function inline(text) {
    let s = esc(text);
    // inline code
    s = s.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`);
    // images
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => {
      const u = safeUrl(url, { allowDataImage: true });
      return u ? `<img alt="${esc(alt)}" src="${esc(u)}" loading="lazy">` : esc(alt);
    });
    // links
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
      const u = safeUrl(url);
      return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
    });
    // bare Pond Share paths (/share/…) become links too
    s = s.replace(/(^|[\s(])(\/share\/[^\s<)]*[^\s<).,;:!?])/g, (_, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
    // bold / italic / strikethrough
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return s;
  }

  function renderTable(lines) {
    const rows = lines.map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
    const header = rows[0];
    const body = rows.slice(2); // skip separator row
    let html = '<table><thead><tr>' + header.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
    for (const r of body) html += '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
    return html + '</tbody></table>';
  }

  // A link to a Pond-served file, alone on its own line, is shown in place:
  //   /share/report.html   ![Sales](/share/sales.html)   [Q3 deck](/artifacts/abc)   /html/h1a2b3c4d   /share/chart.png
  // Pages → live (sandboxed) preview, images → image, audio/video → player, anything else → file card.
  const POND_PATH = /^\/(?:share\/[^\s()<>"]+|artifacts\/[A-Za-z0-9_-]+|html\/h[0-9a-f]{8}|files\/[A-Za-z0-9_-]+\/[^\s()<>"\/]+)$/;
  const EMBED_LINE = /^\s*(?:!?\[([^\]]*)\]\(([^)\s]+)\)|<?([^\s<>]+?)>?)\s*$/;
  function embedFor(line) {
    const mm = line.match(EMBED_LINE);
    if (!mm) return null;
    const url = mm[2] || mm[3];
    if (!url || !POND_PATH.test(url)) return null;
    let name = url.split('/').pop();
    try { name = decodeURIComponent(name); } catch { /* keep raw */ }
    const title = (mm[1] || '').trim() || name;
    const ext = (/\.([a-z0-9]+)$/i.exec(url.split('?')[0]) || [])[1]?.toLowerCase() || '';
    const u = esc(url);
    const open = `<a class="artifact-btn" href="${u}" target="_blank" rel="noopener" title="Open full page">Open ↗</a>`;
    if (/^(png|jpe?g|gif|webp|svg|avif)$/.test(ext)) {
      return `<figure class="embed-img"><a href="${u}" target="_blank" rel="noopener"><img src="${u}" alt="${esc(title)}" loading="lazy"></a>${mm[1] ? `<figcaption>${esc(title)}</figcaption>` : ''}</figure>`;
    }
    if (/^(mp4|webm|mov)$/.test(ext)) return `<video class="embed-media" src="${u}" controls preload="metadata" playsinline></video>`;
    if (/^(mp3|wav|m4a|ogg)$/.test(ext)) return `<audio class="embed-media" src="${u}" controls preload="metadata"></audio>`;
    const isPage = /^(html?)$/.test(ext) || /^\/(artifacts|html)\//.test(url);
    if (isPage) {
      const theme = (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme')) || 'light';
      const src = `${url}${url.includes('?') ? '&' : '?'}embed=1&theme=${theme}`;
      return `<div class="artifact artifact-embed"><div class="artifact-bar"><span class="artifact-title">${esc(title)}</span><span class="artifact-actions">${open}</span></div><iframe sandbox="allow-scripts allow-forms allow-popups" loading="lazy" src="${esc(src)}"></iframe></div>`;
    }
    const kind = ext ? ext.toUpperCase() : 'FILE';
    return `<a class="embed-file" href="${u}" target="_blank" rel="noopener"><span class="embed-file-kind">${esc(kind)}</span><span class="embed-file-name">${esc(title)}</span><span class="embed-file-open">Open ↗</span></a>`;
  }

  function renderMarkdown(src) {
    const lines = String(src).split('\n');
    const out = [];
    let i = 0;
    let para = [];
    const flushPara = () => {
      if (para.length) {
        out.push('<p>' + inline(para.join(' ')) + '</p>');
        para = [];
      }
    };

    while (i < lines.length) {
      const line = lines[i];

      // fenced code block
      const fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        flushPara();
        const lang = (fence[1] || '').toLowerCase();
        const buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // skip closing fence
        const code = buf.join('\n');
        if (lang === 'threejs' || lang === 'three') {
          const hm = code.match(/^\s*\/\/\s*height:\s*(\d{2,4})/);
          const h = Math.max(200, Math.min(900, hm ? Number(hm[1]) : 380));
          out.push(`<div class="artifact artifact-3d"><div class="artifact-bar"><span>3D · three.js · <span class="artifact-id">${htmlId(code)}</span></span><span class="artifact-actions"><button type="button" class="artifact-btn" data-act="expand" title="Expand">⤢</button><button type="button" class="artifact-btn" data-act="code" title="Show code">&lt;/&gt;</button></span></div><iframe sandbox="allow-scripts" loading="lazy" style="height:${h}px" srcdoc="${esc(threeSrcdoc(code))}"></iframe><pre class="artifact-code" hidden><code class="lang-js">${esc(code)}</code></pre></div>`);
        } else if (lang === 'html') {
          const hid = htmlId(code);
          const hm = code.match(/^\s*<!--\s*height:\s*(\d{2,4})\s*-->/i);
          const hstyle = hm ? ` style="height:${Math.max(200, Math.min(1400, Number(hm[1])))}px"` : '';
          out.push(`<div class="artifact"><div class="artifact-bar"><span>html · <span class="artifact-id" title="Auto-saved id — ask Pond to reuse or edit it">${hid}</span></span><span class="artifact-actions"><a class="artifact-btn" href="/html/${hid}" target="_blank" rel="noopener" title="Open full page">Open ↗</a></span></div><iframe sandbox="allow-scripts" loading="lazy"${hstyle} srcdoc="${esc(withPrelude(code))}"></iframe></div>`);
        } else {
          out.push(`<pre><code class="lang-${esc(lang)}">${esc(code)}</code></pre>`);
        }
        continue;
      }

      // blank line
      if (/^\s*$/.test(line)) { flushPara(); i++; continue; }

      // heading
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { flushPara(); const level = h[1].length; out.push(`<h${level}>${inline(h[2])}</h${level}>`); i++; continue; }

      // horizontal rule
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); out.push('<hr>'); i++; continue; }

      // blockquote
      if (/^>\s?/.test(line)) {
        flushPara();
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
        out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
        continue;
      }

      // table: header | sep | rows
      if (line.includes('|') && i + 1 < lines.length && /^\|?[\s:|-]+\|?$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        flushPara();
        const tbl = [line];
        i++;
        while (i < lines.length && lines[i].includes('|')) { tbl.push(lines[i]); i++; }
        out.push(renderTable(tbl));
        continue;
      }

      // unordered list
      if (/^\s*[-*+]\s+/.test(line)) {
        flushPara();
        out.push('<ul>');
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { out.push(`<li>${inline(lines[i].replace(/^\s*[-*+]\s+/, ''))}</li>`); i++; }
        out.push('</ul>');
        continue;
      }

      // ordered list
      if (/^\s*\d+[.)]\s+/.test(line)) {
        flushPara();
        out.push('<ol>');
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { out.push(`<li>${inline(lines[i].replace(/^\s*\d+[.)]\s+/, ''))}</li>`); i++; }
        out.push('</ol>');
        continue;
      }

      // a Pond file link alone on its line → embedded preview
      const embed = embedFor(line);
      if (embed) { flushPara(); out.push(embed); i++; continue; }

      para.push(line);
      i++;
    }
    flushPara();
    return out.join('\n');
  }

  window.renderMarkdown = renderMarkdown;
})();

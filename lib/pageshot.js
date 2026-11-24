// Screenshots of pages for the model to look at (read_artifact screenshot). Headless Chrome / Edge / Chromium driven
// over its DevTools pipe (--remote-debugging-pipe): no npm packages, no visible window, no port. Returns JPEGs plus
// the JavaScript errors the page hit, so "it renders blank" comes with a reason.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findChrome } from './browser-setup.js';
import { DATA } from './storage.js';

const VIEWS = {
  desktop: { width: 1280, height: 800, mobile: false, maxHeight: 3200 },
  mobile: { width: 390, height: 844, mobile: true, maxHeight: 2600 },
};
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// Chrome, else Edge (always on Windows), else a Chromium Playwright downloaded.
export function findShotBrowser() {
  const chrome = findChrome();
  if (chrome) return chrome.path;
  const cands = [];
  if (process.platform === 'win32') {
    for (const r of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean)) cands.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  } else if (process.platform === 'darwin') {
    cands.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    cands.push('/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable');
  }
  const found = cands.find((f) => existsSync(f));
  if (found) return found;
  const pw = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || '', 'ms-playwright') : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright') : path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    for (const d of readdirSync(pw).filter((x) => /^chromium/.test(x)).sort().reverse()) {
      for (const rel of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe', 'chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        if (existsSync(path.join(pw, d, rel))) return path.join(pw, d, rel);
      }
    }
  } catch { /* none */ }
  return null;
}

// Minimal DevTools-protocol client over Chrome's pipe: write fd 3, read fd 4, messages end with \0.
class Cdp {
  constructor(proc) {
    this.out = proc.stdio[3];
    this.seq = 0;
    this.pending = new Map();
    this.handlers = [];
    let buf = '';
    proc.stdio[4].setEncoding('utf8');
    proc.stdio[4].on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\0')) !== -1) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || 'DevTools error')); else resolve(msg.result || {});
        } else if (msg.method) {
          for (const h of this.handlers) { try { h(msg); } catch { /* ignore */ } }
        }
      }
    });
    proc.on('exit', () => { for (const { reject } of this.pending.values()) reject(new Error('The browser closed')); this.pending.clear(); });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }
  on(fn) { this.handlers.push(fn); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what} timed out`); })]);

let chain = Promise.resolve(); // one screenshot run at a time (they share a browser profile)

export function screenshotPage(url, opts = {}) {
  const run = chain.then(() => shoot(url, opts));
  chain = run.catch(() => {});
  return run;
}

async function shoot(url, { views = ['desktop'], fullPage = true, dark = false } = {}) {
  const exe = findShotBrowser();
  if (!exe) throw new Error('No Chrome, Edge or Chromium found on this computer for screenshots.');
  const profile = path.join(DATA, 'browser', 'shot-profile');
  await mkdir(profile, { recursive: true });
  const proc = spawn(exe, [
    '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--hide-scrollbars', '--mute-audio', '--enable-unsafe-swiftshader', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
  proc.stderr.on('data', () => {}); // keep the pipe drained
  const spawnError = new Promise((_, reject) => proc.on('error', (e) => reject(new Error(`Could not start the browser: ${e.message}`))));
  const cdp = new Cdp(proc);
  const shots = [];
  const errors = [];
  try {
    await Promise.race([withTimeout(cdp.send('Browser.getVersion'), 15_000, 'Starting the browser'), spawnError]);
    for (const view of views) {
      const vp = VIEWS[view] || VIEWS.desktop;
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const S = (m, p) => cdp.send(m, p, sessionId);
      const seen = new Set();
      const addErr = (t) => { const s = String(t || '').trim().slice(0, 300); if (/favicon\.ico/.test(s)) return; if (s && !seen.has(s) && errors.length < 12) { seen.add(s); errors.push(views.length > 1 ? `[${view}] ${s}` : s); } };
      let loadFired = null;
      const loaded = new Promise((r) => { loadFired = r; });
      cdp.on((msg) => {
        if (msg.sessionId !== sessionId) return;
        const p = msg.params || {};
        if (msg.method === 'Page.loadEventFired') loadFired();
        else if (msg.method === 'Runtime.exceptionThrown') addErr(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text);
        else if (msg.method === 'Runtime.consoleAPICalled' && p.type === 'error') addErr((p.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
        else if (msg.method === 'Log.entryAdded' && p.entry?.level === 'error') addErr(`${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ''}`);
      });
      await S('Page.enable');
      await S('Runtime.enable');
      await S('Log.enable');
      await S('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile });
      if (vp.mobile) {
        await S('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA });
        await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      }
      if (dark) await S('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      const nav = await S('Page.navigate', { url });
      if (nav.errorText) throw new Error(`Could not open ${url}: ${nav.errorText}`);
      let note = '';
      try { await withTimeout(loaded, 15_000, 'Loading'); } catch { note = 'The page had not finished loading after 15 s; this is how it looked then.'; }
      await sleep(1200); // scripts, fonts, charts and 3D scenes settle
      const info = (await S('Runtime.evaluate', {
        expression: '({ title: document.title, height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), width: document.documentElement.scrollWidth, text: (document.body && document.body.innerText || "").trim().length, visual: document.querySelectorAll("canvas,svg,img,video,iframe").length })',
        returnByValue: true,
      })).result?.value || {};
      const pageHeight = Math.max(vp.height, Number(info.height) || vp.height);
      const h = fullPage ? Math.min(pageHeight, vp.maxHeight) : vp.height;
      const shot = await S('Page.captureScreenshot', {
        format: 'jpeg', quality: 82, captureBeyondViewport: fullPage,
        ...(fullPage ? { clip: { x: 0, y: 0, width: vp.width, height: h, scale: 1 } } : {}),
      });
      shots.push({
        view, data: shot.data, width: vp.width, height: h, pageHeight, title: info.title || '', emptyText: !info.text && !info.visual,
        ...(Number(info.width) > vp.width + 4 ? { overflow: `Content is ${info.width}px wide on a ${vp.width}px screen — part of it is cut off / scrolls sideways.` } : {}),
        ...(fullPage && pageHeight > h ? { cut: `The page is ${pageHeight}px tall; the screenshot shows the top ${h}px.` } : {}),
        ...(note ? { note } : {}),
      });
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    }
    return { shots, errors };
  } finally {
    cdp.send('Browser.close').catch(() => {});
    setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, 3000).unref?.();
  }
}

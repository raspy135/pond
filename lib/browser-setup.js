// Browser automation for Pond = Microsoft's Playwright MCP server (loaded on demand, only when a task needs a browser).
// Shared by the server (startup migration) and scripts/setup.mjs. No Pond imports here, so setup can use it directly.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.OPEN_DOTS_DATA_DIR ? path.resolve(process.env.OPEN_DOTS_DATA_DIR) : path.join(ROOT, 'data');
// Page snapshots and screenshots the browser saves as files go here (not into the Pond folder itself).
export const BROWSER_OUTPUT_DIR = path.join(DATA, 'browser');

export const PLAYWRIGHT_PKG = '@playwright/mcp@latest';

const which = (c) => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [c], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? String(r.stdout).split(/\r?\n/)[0].trim() : '';
};

// Google Chrome (or a Linux Chromium) already on this computer, if any.
export function findChrome() {
  if (process.platform === 'win32') {
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
    const p = roots.map((r) => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')).find((f) => existsSync(f));
    return p ? { path: p, chromium: false } : null;
  }
  if (process.platform === 'darwin') {
    const p = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', path.join(process.env.HOME || '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')].find((f) => existsSync(f));
    return p ? { path: p, chromium: false } : null;
  }
  for (const c of ['google-chrome-stable', 'google-chrome']) { const p = which(c); if (p) return { path: p, chromium: false }; }
  for (const c of ['chromium', 'chromium-browser']) { const p = which(c); if (p) return { path: p, chromium: true }; }
  return null;
}

// Which browser Playwright drives: Chrome if installed; Edge on Windows (always there); otherwise Playwright's own
// Chromium build, which needs a one-time download (installBrowserCommand).
export function playwrightBrowser() {
  const chrome = findChrome();
  if (chrome && !chrome.chromium) return { args: [], label: 'Google Chrome', needsDownload: false };
  if (chrome?.chromium) return { args: ['--browser', 'chromium', '--executable-path', chrome.path], label: 'Chromium', needsDownload: false };
  if (process.platform === 'win32') return { args: ['--browser', 'msedge'], label: 'Microsoft Edge', needsDownload: false };
  return { args: ['--browser', 'chromium'], label: "Playwright's Chromium", needsDownload: true };
}
export const installBrowserCommand = () => ['npx', ['-y', PLAYWRIGHT_PKG, 'install-browser', 'chrome-for-testing']];

export function playwrightEntry({ enabled = true } = {}) {
  return {
    name: 'browser',
    transport: 'stdio',
    url: '',
    command: 'npx',
    args: ['-y', PLAYWRIGHT_PKG, ...playwrightBrowser().args, '--output-dir', BROWSER_OUTPUT_DIR],
    env: {},
    headers: {},
    enabled,
    createdAt: new Date().toISOString(),
  };
}

export const isChromeDevtoolsEntry = (x) => (x?.args || []).some((a) => String(a).includes('chrome-devtools-mcp'));
export const isPlaywrightEntry = (x) => (x?.args || []).some((a) => String(a).includes('@playwright/mcp'));

// Pond used to set up Chrome DevTools MCP; Playwright MCP replaces it. Returns the new list, or null if nothing changed.
export function migrateBrowserServers(list) {
  const arr = Array.isArray(list) ? list : [];
  if (!arr.some(isChromeDevtoolsEntry)) return null;
  const out = [];
  let havePw = arr.some(isPlaywrightEntry);
  for (const x of arr) {
    if (!isChromeDevtoolsEntry(x)) { out.push(x); continue; }
    if (!havePw) { out.push(playwrightEntry({ enabled: x.enabled !== false })); havePw = true; }
  }
  return out;
}

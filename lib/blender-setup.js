// Blender for Pond = the official Blender Lab MCP server (projects.blender.org/lab/blender_mcp), loaded on demand.
// Data flow: Pond ⇐ MCP/stdio ⇒ blender-mcp ⇐ TCP ⇒ the "MCP Server" add-on inside a running Blender (5.1+).
// The server is installed into Pond's own .venv; the add-on is installed once by the user inside Blender.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const BLENDER_ADDON_PAGE = 'https://www.blender.org/lab/mcp-server/';
// pip sources, tried in order: the release archive (no git needed), then git.
export const BLENDER_MCP_SOURCES = process.env.POND_BLENDER_MCP_SRC
  ? [process.env.POND_BLENDER_MCP_SRC]
  : [
    'https://projects.blender.org/lab/blender_mcp/archive/main.zip#subdirectory=mcp',
    'git+https://projects.blender.org/lab/blender_mcp.git#subdirectory=mcp',
  ];

const ver = (s) => (String(s).match(/(\d+)\.(\d+)/) || []).slice(1).map(Number);
const newer = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);

// The newest Blender installed here: { path, version: [major, minor] } or null.
export function findBlender() {
  const found = [];
  if (process.env.POND_BLENDER_EXE) found.push({ path: process.env.POND_BLENDER_EXE, version: [] }); // tests / unusual installs
  if (process.platform === 'win32') {
    for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
      const base = path.join(root, 'Blender Foundation');
      let dirs = [];
      try { dirs = readdirSync(base); } catch { /* none */ }
      for (const d of dirs) {
        const exe = path.join(base, d, 'blender.exe');
        if (existsSync(exe)) found.push({ path: exe, version: ver(d) });
      }
    }
    const steam = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam', 'steamapps', 'common', 'Blender', 'blender.exe');
    if (existsSync(steam)) found.push({ path: steam, version: [] });
  } else if (process.platform === 'darwin') {
    const p = '/Applications/Blender.app/Contents/MacOS/Blender';
    if (existsSync(p)) found.push({ path: p, version: [] });
  } else {
    const r = spawnSync('which', ['blender'], { encoding: 'utf8' });
    if (r.status === 0) found.push({ path: String(r.stdout).trim(), version: [] });
  }
  for (const f of found) if (!f.version.length) {
    const r = spawnSync(f.path, ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    f.version = ver(String(r.stdout || '').match(/Blender\s+([\d.]+)/)?.[1] || '');
  }
  return found.sort((a, b) => newer(b.version.length ? b.version : [0, 0], a.version.length ? a.version : [0, 0]))[0] || null;
}
export const blenderSupported = (b) => Boolean(b?.version?.length) && newer(b.version, [5, 1]) >= 0;

export const blenderMcpBin = (venvDir) => (process.platform === 'win32'
  ? path.join(venvDir, 'Scripts', 'blender-mcp.exe')
  : path.join(venvDir, 'bin', 'blender-mcp'));

export const isBlenderEntry = (x) => x?.name === 'blender' || String(x?.command || '').includes('blender-mcp');

export function blenderEntry(bin) {
  return { name: 'blender', transport: 'stdio', url: '', command: bin, args: [], env: {}, headers: {}, enabled: true, createdAt: new Date().toISOString() };
}

// pip install the server into the venv, showing pip's own progress (downloads can take a while).
// Never let git ask for a password (that would wait forever on a hidden prompt). → { ok, source, error }
export function installBlenderMcp(venvPython, { show = true } = {}) {
  let lastErr = '';
  for (const source of BLENDER_MCP_SOURCES) {
    const r = spawnSync(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', source], {
      stdio: show ? ['ignore', 'inherit', 'pipe'] : 'pipe',
      encoding: 'utf8',
      timeout: 600000,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', PIP_NO_INPUT: '1' },
    });
    if (r.status === 0) return { ok: true, source };
    lastErr = r.error?.code === 'ETIMEDOUT' ? 'timed out after 10 minutes' : String(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ');
    if (show) console.log(`  (that source didn't work: ${lastErr.slice(0, 300)})`);
  }
  return { ok: false, error: lastErr };
}

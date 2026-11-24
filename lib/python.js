// Python execution engine for Pond (data analysis, spreadsheets, charts, date/finance math, document helpers).
import { execFile } from 'node:child_process';
import { mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync as readdirSyncFs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG } from './config.js';
import { PYTHON_MAX_SEC } from './config.js';
import { DATA, ROOT, uid, logActivity } from './storage.js';

export const PYTHON_RUNS_DIR = path.join(DATA, 'python-runs');

let cachedPython = null; // { bin, prefixArgs, version }

function probeCommand(bin, args = ['--version']) {
  return new Promise((resolve) => {
    try {
      execFile(bin, args, { timeout: 4000, windowsHide: true }, (err, stdout, stderr) => {
        const out = `${stdout || ''} ${stderr || ''}`.trim();
        if (!err && /Python\s+3\.\d+/i.test(out)) {
          resolve(out.match(/Python\s+[\d.]+/i)?.[0] || out);
        } else {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

async function discoverWindowsCandidates() {
  const candidates = [];
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const roots = [
    path.join(localAppData, 'Programs', 'Python'),
    programFiles,
    'C:\\',
    path.join(home, 'miniconda3'),
    path.join(home, 'anaconda3'),
    path.join(home, 'scoop', 'apps', 'python', 'current'),
  ];

  for (const r of roots) {
    if (!existsSync(r)) continue;
    const direct = path.join(r, 'python.exe');
    if (existsSync(direct)) candidates.push({ bin: direct, prefixArgs: [] });
    try {
      const entries = await readdir(r, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && /^Python3\d+$/i.test(e.name)) {
          const exe = path.join(r, e.name, 'python.exe');
          if (existsSync(exe)) candidates.push({ bin: exe, prefixArgs: [] });
        }
      }
    } catch { /* skip */ }
  }
  return candidates;
}

// On Windows a venv's python.exe is a small unsigned launcher that starts the real interpreter. Windows security
// (e.g. ransomware protection) can refuse to let that launcher's process write files where the real, signed
// python.exe may. So on Windows Pond runs the real interpreter itself and gives it the venv's packages.
export function venvBaseInterpreter(venvDir) {
  try {
    const cfg = readFileSync(path.join(venvDir, 'pyvenv.cfg'), 'utf8');
    const get = (k) => cfg.match(new RegExp(`^\\s*${k}\\s*=\\s*(.+?)\\s*$`, 'mi'))?.[1] || '';
    const candidates = [get('executable'), get('home') && path.join(get('home'), process.platform === 'win32' ? 'python.exe' : 'python3')];
    const bin = candidates.find((c) => c && existsSync(c));
    const site = process.platform === 'win32'
      ? path.join(venvDir, 'Lib', 'site-packages')
      : (() => { try { const lib = path.join(venvDir, 'lib'); const d = readdirSyncSafe(lib).find((x) => /^python3/.test(x)); return d ? path.join(lib, d, 'site-packages') : ''; } catch { return ''; } })();
    return bin && site && existsSync(site) ? { bin, site } : null;
  } catch {
    return null;
  }
}
function readdirSyncSafe(dir) { try { return readdirSyncFs(dir); } catch { return []; } }

export async function detectPython({ force = false } = {}) {
  if (cachedPython && !force) return cachedPython;

  const customBin = String(CONFIG.python?.bin || '').trim();
  const candidates = [];
  if (customBin) candidates.push({ bin: customBin, prefixArgs: [] });
  // Pond's own environment from setup (pandas, matplotlib, openpyxl, pypdf)
  const venvPy = process.platform === 'win32' ? path.join(ROOT, '.venv', 'Scripts', 'python.exe') : path.join(ROOT, '.venv', 'bin', 'python');
  if (existsSync(venvPy)) {
    const base = process.platform === 'win32' ? venvBaseInterpreter(path.join(ROOT, '.venv')) : null;
    if (base) candidates.push({ bin: base.bin, prefixArgs: [], site: base.site, venv: venvPy });
    candidates.push({ bin: venvPy, prefixArgs: [] });
  }

  if (process.platform === 'win32') {
    candidates.push(
      { bin: 'py', prefixArgs: ['-3'] },
      { bin: 'python', prefixArgs: [] },
      { bin: 'python3', prefixArgs: [] },
      ...(await discoverWindowsCandidates())
    );
  } else {
    candidates.push(
      { bin: 'python3', prefixArgs: [] },
      { bin: 'python', prefixArgs: [] }
    );
  }

  for (const c of candidates) {
    const version = await probeCommand(c.bin, [...c.prefixArgs, '--version']);
    if (version) {
      cachedPython = { ...c, version };
      return cachedPython;
    }
  }
  return null;
}

// Runs the script like `python script.py` would, after adding the venv's site-packages (with .pth processing).
const VENV_BOOTSTRAP = [
  'import os, runpy, site, sys',
  'site.addsitedir(sys.argv[1])',
  'script = sys.argv[2]',
  'sys.argv = [script]',
  'sys.path.insert(0, os.path.dirname(os.path.abspath(script)))',
  "runpy.run_path(script, run_name='__main__')",
].join('; ');

const SAFE_SERVE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.html', '.csv', '.txt', '.json', '.pdf', '.ics']);

export async function runPythonCode({ code, timeoutSec = 30, cwd = null } = {}) {
  if (CONFIG.python?.enabled === false) {
    throw new Error('Python tool is disabled in Settings.');
  }
  const source = String(code || '').trim();
  if (!source) throw new Error('code is required');

  const py = await detectPython();
  if (!py) {
    return {
      ok: false,
      error: 'Python 3 was not found on this machine. Install Python 3 (python.org or `winget install Python.Python.3.12`) or set PYTHON_BIN in .env / Agent Hub.',
    };
  }

  const runId = uid();
  const runDir = path.join(PYTHON_RUNS_DIR, runId);
  await mkdir(runDir, { recursive: true });

  const scriptPath = path.join(runDir, '_pond_script.py');
  await writeFile(scriptPath, source, 'utf8');

  // Default working directory is the isolated runDir so generated charts/CSVs are auto-captured.
  let execCwd = runDir;
  if (cwd) {
    const resolved = path.resolve(CONFIG.fsRoot, String(cwd));
    const rel = path.relative(CONFIG.fsRoot, resolved);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) execCwd = resolved;
  }

  const timeoutMs = Math.min(PYTHON_MAX_SEC, Math.max(2, Number(timeoutSec) || CONFIG.python?.timeoutSec || 300)) * 1000;
  const started = Date.now();

  const result = await new Promise((resolve) => {
    execFile(
      py.bin,
      [...py.prefixArgs, '-u', ...(py.site ? ['-c', VENV_BOOTSTRAP, py.site] : []), scriptPath],
      {
        cwd: execCwd,
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          MPLBACKEND: 'Agg',
          POND_OUT_DIR: runDir,
          POND_FS_ROOT: CONFIG.fsRoot,
          ...(py.site ? { PYTHONPATH: [py.site, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) } : {}), // child processes see the packages too
        },
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          timedOut: Boolean(err?.killed),
          durationMs: Date.now() - started,
          stdout: String(stdout || '').slice(0, 14_000),
          stderr: String(stderr || '').slice(0, 6_000),
        });
      }
    );
  });

  // Auto-discover any generated files (charts, CSVs, HTML, ICS, PDFs) in runDir
  const files = [];
  try {
    const entries = await readdir(runDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || e.name === '_pond_script.py') continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!SAFE_SERVE_EXTS.has(ext)) continue;
      const st = await stat(path.join(runDir, e.name));
      const url = `/files/${runId}/${encodeURIComponent(e.name)}`;
      const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext);
      files.push({
        name: e.name,
        bytes: st.size,
        url,
        ...(isImage ? { markdown: `![${e.name}](${url})` } : { markdown: `[${e.name}](${url})` }),
      });
    }
  } catch { /* ignore */ }

  await logActivity({
    kind: 'python',
    level: result.ok ? 'info' : 'warn',
    title: result.ok ? `Ran Python (${result.durationMs}ms)` : `Python failed (exit ${result.exitCode})`,
    detail: (result.stdout || result.stderr || source).slice(0, 260),
  });

  // Pond does not sandbox Python: it runs as the user. A PermissionError comes from the OS (file locked by another
  // program, read-only file, folder permissions, or Windows "Controlled folder access" blocking python.exe).
  const denied = /PermissionError|Permission denied|Access is denied/i.test(`${result.stdout}\n${result.stderr}`);
  return {
    ...result,
    ...(denied ? { hint: 'The OS denied a file access (Pond itself does not restrict Python). Likely causes: the file is open/locked by another program or read-only, or Windows security is blocking that folder. Tell the user that, rather than calling it a sandbox. write_file / edit_file may still work for that path.' } : {}),
    pythonVersion: py.version,
    runId,
    ...(files.length ? { files } : {}),
  };
}

export function resolveRunFile(runId, filename) {
  const cleanId = String(runId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const cleanName = path.basename(decodeURIComponent(String(filename || '')));
  if (!cleanId || !cleanName || cleanName === '_pond_script.py') return null;
  const ext = path.extname(cleanName).toLowerCase();
  if (!SAFE_SERVE_EXTS.has(ext)) return null;
  const full = path.resolve(PYTHON_RUNS_DIR, cleanId, cleanName);
  if (!full.startsWith(PYTHON_RUNS_DIR)) return null;
  return { full, ext, name: cleanName };
}

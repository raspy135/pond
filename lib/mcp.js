// Zero-dependency Model Context Protocol (MCP) Client + Automatic Discovery (stdio & Streamable HTTP, JSON-RPC 2.0).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT, readJson, updateJson, logActivity } from './storage.js';
import { migrateBrowserServers, PLAYWRIGHT_PKG } from './browser-setup.js';

const connections = new Map();

function sanitizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

// Curated daily-life MCP presets for 1-click setup
export const MCP_PRESETS = [
  {
    id: 'notion',
    name: 'notion',
    label: 'Notion (Notes, Tasks & Docs)',
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    description: 'Official Notion hosted MCP server for pages, tasks, and databases.',
    envHints: [],
  },
  {
    id: 'google-calendar',
    name: 'google_calendar',
    label: 'Google Calendar',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@cocal/google-calendar-mcp'],
    description: 'Read, create, and update Google Calendar events.',
    envHints: ['GOOGLE_OAUTH_CREDENTIALS'],
  },
  {
    id: 'todoist',
    name: 'todoist',
    label: 'Todoist (Things To Do)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@abhiz123/todoist-mcp-server'],
    description: 'Manage your Todoist tasks, projects, and due dates.',
    envHints: ['TODOIST_API_TOKEN'],
  },
  {
    id: 'fetch',
    name: 'fetch',
    label: 'Web Fetch (Official MCP)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    description: 'Clean web page fetching & markdown conversion.',
    envHints: [],
  },
  {
    id: 'playwright',
    name: 'browser',
    label: 'Browser (Playwright, Microsoft)',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', PLAYWRIGHT_PKG],
    description: 'Use a real browser: click through sites, fill forms, read pages that need JavaScript or a login.',
    envHints: [],
  },
  {
    id: 'memory',
    name: 'knowledge_graph',
    label: 'Knowledge Graph Memory',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    description: 'Structured entity & relationship memory graph for people, places, and plans.',
    envHints: [],
  },
];

// ---------- Transports ----------
class StdioMcpConnection {
  constructor(cfg) {
    this.config = cfg;
    this.proc = null;
    this.reqId = 0;
    this.pending = new Map();
    this.buf = '';
    this.tools = [];
    this.serverInfo = null;
    this.status = 'disconnected';
    this.error = null;
  }

  async connect() {
    this.close();
    this.status = 'connecting';
    this.error = null;
    const args = Array.isArray(this.config.args) ? this.config.args : [];
    const env = { ...process.env, ...(this.config.env || {}) };
    const isWin = process.platform === 'win32';
    const needsCmd = isWin && /^(npx|npm|uvx|pnpm)$/i.test(this.config.command);
    const spawnBin = needsCmd ? 'cmd.exe' : this.config.command;
    const spawnArgs = needsCmd ? ['/c', this.config.command, ...args] : args;
    this.proc = spawn(spawnBin, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });

    this.stderrBuf = '';
    this.proc.stderr.on('data', (chunk) => {
      this.stderrBuf = (this.stderrBuf + chunk.toString('utf8')).slice(-1000);
    });
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk.toString('utf8');
      const lines = this.buf.split('\n');
      this.buf = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
      }
    });

    this.proc.on('error', (err) => {
      this.status = 'error';
      this.error = String(err.message || err);
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(`MCP process failed to start: ${this.error}`)); } // fail fast (e.g. command not found)
      this.pending.clear();
    });
    this.proc.on('exit', (code) => {
      this.status = 'disconnected';
      if (code && !this.error) {
        const hint = (this.stderrBuf || '').trim().split(/\r?\n/).slice(-2).join(' | ');
        this.error = `Exited with code ${code}${hint ? `: ${hint}` : ''}`;
      }
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('MCP process exited'));
      }
      this.pending.clear();
    });

    const init = await this.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'pond', version: '0.2.0' },
      },
      60_000
    );
    this.serverInfo = init?.serverInfo || null;
    this.notify('notifications/initialized', {});
    const list = await this.request('tools/list', {});
    this.tools = Array.isArray(list?.tools) ? list.tools : [];
    this.status = 'connected';
    return this.tools;
  }

  notify(method, params) {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  request(method, params, timeoutMs = 20_000) {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin?.writable) return reject(new Error('MCP stdio transport not connected'));
      const id = ++this.reqId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async callTool(toolName, args) {
    return this.request('tools/call', { name: toolName, arguments: args || {} }, 30_000);
  }

  close() {
    if (this.proc) {
      try { this.proc.kill(); } catch { /* ignore */ }
      this.proc = null;
    }
    this.status = 'disconnected';
  }
}

class HttpMcpConnection {
  constructor(cfg) {
    this.config = cfg;
    this.reqId = 0;
    this.sessionId = null;
    this.tools = [];
    this.serverInfo = null;
    this.status = 'disconnected';
    this.error = null;
  }

  async rpc(method, params, isNotification = false, timeoutMs = 20_000) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.config.headers || {}),
      ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
    };
    const body = isNotification
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id: ++this.reqId, method, params };
    const resp = await fetch(this.config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = resp.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (isNotification) return null;
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`MCP HTTP ${resp.status}: ${t.slice(0, 250)}`);
    }
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('text/event-stream')) {
      const text = await resp.text();
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const msg = JSON.parse(line.slice(5).trim());
          if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
          if (msg.result !== undefined) return msg.result;
        } catch (err) {
          if (err instanceof SyntaxError) continue;
          throw err;
        }
      }
      throw new Error('Empty SSE response from MCP server');
    }
    const json = await resp.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  }

  async connect() {
    this.status = 'connecting';
    this.error = null;
    const init = await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'pond', version: '0.2.0' },
    });
    this.serverInfo = init?.serverInfo || null;
    await this.rpc('notifications/initialized', {}, true).catch(() => {});
    const list = await this.rpc('tools/list', {});
    this.tools = Array.isArray(list?.tools) ? list.tools : [];
    this.status = 'connected';
    return this.tools;
  }

  async callTool(toolName, args) {
    return this.rpc('tools/call', { name: toolName, arguments: args || {} }, false, 30_000);
  }

  close() {
    this.status = 'disconnected';
  }
}

// ---------- Automatic Discovery ----------
function getStandardMcpConfigPaths() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const candidates = [
    { source: 'Workspace (.mcp.json)', file: path.join(ROOT, '.mcp.json') },
    { source: 'Claude Desktop', file: path.join(appData, 'Claude', 'claude_desktop_config.json') },
    { source: 'Claude Desktop (macOS)', file: path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') },
    { source: 'Claude Code', file: path.join(home, '.claude.json') },
    { source: 'Cursor', file: path.join(home, '.cursor', 'mcp.json') },
    { source: 'Windsurf', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json') },
    { source: 'Antigravity', file: path.join(home, '.gemini', 'antigravity', 'mcp_config.json') },
    { source: 'Gemini CLI', file: path.join(home, '.gemini', 'settings.json') },
    { source: 'VS Code', file: path.join(appData, 'Code', 'User', 'mcp.json') },
  ];
  return candidates;
}

function normalizeServerEntry(rawName, rawCfg, source) {
  if (!rawCfg || typeof rawCfg !== 'object') return null;
  const name = sanitizeName(rawName);
  if (!name) return null;
  const url = rawCfg.url || rawCfg.serverUrl || rawCfg.endpoint || '';
  const command = rawCfg.command || '';
  if (!url && !command) return null;
  const transport = url && !command ? 'http' : 'stdio';
  return {
    name,
    transport,
    url: transport === 'http' ? String(url) : '',
    command: transport === 'stdio' ? String(command) : '',
    args: Array.isArray(rawCfg.args) ? rawCfg.args.map(String) : [],
    env: rawCfg.env && typeof rawCfg.env === 'object' ? rawCfg.env : {},
    headers: rawCfg.headers && typeof rawCfg.headers === 'object' ? rawCfg.headers : {},
    source,
  };
}

export async function discoverLocalMcpConfigs() {
  const found = [];
  const seen = new Set();
  for (const { source, file } of getStandardMcpConfigPaths()) {
    if (!existsSync(file)) continue;
    try {
      const json = JSON.parse(await readFile(file, 'utf8'));
      const map = json?.mcpServers || json?.servers || (json?.mcp?.servers) || null;
      if (!map || typeof map !== 'object') continue;
      for (const [k, v] of Object.entries(map)) {
        const norm = normalizeServerEntry(k, v, source);
        if (!norm) continue;
        const dedupeKey = `${norm.name}:${norm.url || norm.command}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        found.push(norm);
      }
    } catch { /* ignore unreadable config */ }
  }
  return found;
}

async function probeHttpMcp(url, timeoutMs = 650) {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'pond-discover', version: '0.2.0' } },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    const ct = resp.headers.get('content-type') || '';
    let result = null;
    if (ct.includes('application/json')) {
      const j = await resp.json().catch(() => null);
      result = j?.result || null;
    } else if (ct.includes('text/event-stream')) {
      const txt = await resp.text();
      for (const line of txt.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const j = JSON.parse(line.slice(5).trim());
          if (j?.result) { result = j.result; break; }
        } catch { /* continue */ }
      }
    }
    if (!result || (!result.protocolVersion && !result.serverInfo && !result.capabilities)) return null;
    const rawName = result.serverInfo?.name || `local_${new URL(url).port}`;
    return {
      name: sanitizeName(rawName),
      label: result.serverInfo?.name || url,
      transport: 'http',
      url,
      source: 'Live localhost scan',
    };
  } catch {
    return null;
  }
}

export async function discoverRunningHttpMcp() {
  const ports = [3000, 3001, 3333, 4000, 5000, 8000, 8080, 8888, 8931, 9000];
  const urls = ports.map((p) => `http://127.0.0.1:${p}/mcp`);
  const results = await Promise.all(urls.map((u) => probeHttpMcp(u)));
  return results.filter(Boolean);
}

export async function discoverAllMcp({ scanPorts = true } = {}) {
  const existing = await listMcpConfigs();
  const existingNames = new Set(existing.map((c) => c.name));
  const [fromConfigs, fromPorts] = await Promise.all([
    discoverLocalMcpConfigs(),
    scanPorts ? discoverRunningHttpMcp() : Promise.resolve([]),
  ]);
  const discovered = [...fromPorts, ...fromConfigs].map((item) => ({
    ...item,
    alreadyAdded: existingNames.has(item.name),
  }));
  return {
    discovered,
    presets: MCP_PRESETS.map((p) => ({ ...p, alreadyAdded: existingNames.has(p.name) })),
  };
}

// Single-box smart auto-detector: accepts URL, shell command, npm package, or pasted mcpServers JSON!
export async function smartAddMcp(input, { nameOverride = '', envVars = {} } = {}) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Paste an MCP URL, npx command, package name, or mcpServers JSON.');

  // 1) Pasted JSON config ({ mcpServers: { ... } } or single server object)
  if (raw.startsWith('{')) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { throw new Error(`Invalid JSON: ${e.message}`); }
    const map = parsed.mcpServers || parsed.servers;
    if (map && typeof map === 'object') {
      const added = [];
      for (const [k, v] of Object.entries(map)) {
        const norm = normalizeServerEntry(k, v, 'pasted-json');
        if (norm) {
          await addMcpServer(norm);
          added.push(norm.name);
        }
      }
      if (!added.length) throw new Error('No valid MCP server entries found in JSON.');
      return { ok: true, added, servers: await getAllMcpStatuses() };
    }
    const single = normalizeServerEntry(nameOverride || parsed.name || 'custom_mcp', parsed, 'pasted-json');
    if (!single) throw new Error('JSON must contain either "url" or "command".');
    await addMcpServer(single);
    return { ok: true, added: [single.name], servers: await getAllMcpStatuses() };
  }

  // 2) HTTP / Streamable HTTP URL -> probe to auto-discover server name!
  if (/^https?:\/\//i.test(raw)) {
    const probed = await probeHttpMcp(raw, 2500);
    const parsedUrl = new URL(raw);
    const derivedName = sanitizeName(nameOverride || probed?.name || parsedUrl.hostname.replace(/^www\./, '').split('.')[0] || 'mcp_http');
    await addMcpServer({
      name: derivedName,
      transport: 'http',
      url: raw,
    });
    return { ok: true, added: [derivedName], servers: await getAllMcpStatuses() };
  }

  // 3) Single npm package (e.g. "@modelcontextprotocol/server-fetch" or "@playwright/mcp")
  if (!raw.includes(' ') && /^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(@[a-z0-9_.-]+)?$/i.test(raw)) {
    const cleanPkg = raw.replace(/^@[^/]+\//, '').replace(/^server-/, '').replace(/-mcp.*$/i, '').replace(/@.*$/, '');
    const derivedName = sanitizeName(nameOverride || cleanPkg || 'mcp_pkg');
    await addMcpServer({
      name: derivedName,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', raw],
      env: envVars,
    });
    return { ok: true, added: [derivedName], servers: await getAllMcpStatuses() };
  }

  // 4) Shell command (e.g. "npx -y @modelcontextprotocol/server-memory" or "uvx mcp-server-time")
  const tokens = raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const unquote = (t) => t.replace(/^["']|["']$/g, '');
  const command = unquote(tokens[0] || '');
  const args = tokens.slice(1).map(unquote);
  if (!command) throw new Error('Could not parse MCP command.');
  const pkgHint = args.find((a) => !a.startsWith('-')) || command;
  const derivedName = sanitizeName(
    nameOverride || pkgHint.replace(/^@[^/]+\//, '').replace(/^server-/, '').replace(/-mcp.*$/i, '').replace(/@.*$/, '')
  );
  await addMcpServer({
    name: derivedName || 'mcp_stdio',
    transport: 'stdio',
    command,
    args,
    env: envVars,
  });
  return { ok: true, added: [derivedName || 'mcp_stdio'], servers: await getAllMcpStatuses() };
}

// ---------- Lifecycle & Registry ----------
export async function listMcpConfigs() {
  const list = await readJson('mcp.json', []);
  return Array.isArray(list) ? list : [];
}

export async function connectMcpServer(cfg) {
  const key = sanitizeName(cfg.name);
  if (!key) throw new Error('MCP server name is required');
  if (connections.has(key)) connections.get(key).close();

  const conn =
    cfg.transport === 'stdio' ? new StdioMcpConnection({ ...cfg, name: key }) : new HttpMcpConnection({ ...cfg, name: key });
  connections.set(key, conn);

  try {
    await conn.connect();
    await logActivity({
      kind: 'mcp',
      title: `Connected MCP "${key}"`,
      detail: `Discovered ${conn.tools.length} tool(s)`,
    });
  } catch (err) {
    conn.status = 'error';
    conn.error = String(err?.message || err);
    await logActivity({
      kind: 'mcp',
      level: 'error',
      title: `MCP "${key}" failed to connect`,
      detail: conn.error,
    });
  }
  return getMcpStatus(key);
}

export async function initMcpServers() {
  // One-time switch from the old default browser server (Chrome DevTools MCP) to Playwright MCP.
  let migrated = false;
  await updateJson('mcp.json', [], (list) => { const next = migrateBrowserServers(list); if (next) { migrated = true; return next; } return list; }).catch(() => {});
  if (migrated) await logActivity({ kind: 'mcp', title: 'Browser tools switched to Playwright', detail: 'Chrome DevTools MCP replaced by Playwright MCP (loads on demand).' }).catch(() => {});
  const configs = await listMcpConfigs();
  for (const cfg of configs) {
    if (cfg.enabled !== false) {
      connectMcpServer(cfg).catch(() => {});
    }
  }
}

export async function addMcpServer(cfg) {
  const name = sanitizeName(cfg.name);
  if (!name) throw new Error('Server name is required');
  const entry = {
    name,
    transport: cfg.transport === 'stdio' ? 'stdio' : 'http',
    url: cfg.url || '',
    command: cfg.command || '',
    args: Array.isArray(cfg.args) ? cfg.args : String(cfg.args || '').split(/\s+/).filter(Boolean),
    env: cfg.env && typeof cfg.env === 'object' ? cfg.env : {},
    headers: cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {},
    enabled: cfg.enabled !== false,
    createdAt: new Date().toISOString(),
  };
  await updateJson('mcp.json', [], (list) => {
    const arr = (Array.isArray(list) ? list : []).filter((x) => x.name !== name);
    arr.push(entry);
    return arr;
  });
  if (entry.enabled) await connectMcpServer(entry);
  return getAllMcpStatuses();
}

export async function removeMcpServer(name) {
  const key = sanitizeName(name);
  if (connections.has(key)) {
    connections.get(key).close();
    connections.delete(key);
  }
  await updateJson('mcp.json', [], (list) => (Array.isArray(list) ? list : []).filter((x) => x.name !== key));
  return getAllMcpStatuses();
}

export function getMcpStatus(name) {
  const conn = connections.get(name);
  if (!conn) return { name, status: 'disconnected', tools: [] };
  return {
    name,
    transport: conn.config.transport,
    url: conn.config.url,
    command: conn.config.command,
    status: conn.status,
    error: conn.error,
    tools: conn.tools.map((t) => ({ name: t.name, description: t.description || '' })),
  };
}

export async function getAllMcpStatuses() {
  const configs = await listMcpConfigs();
  return configs.map((cfg) => {
    const live = connections.get(cfg.name);
    return {
      ...cfg,
      status: live?.status || 'disconnected',
      error: live?.error || null,
      tools: (live?.tools || []).map((t) => ({ name: t.name, description: t.description || '' })),
    };
  });
}

export function getDynamicMcpToolDefs() {
  const defs = [];
  for (const [serverName, conn] of connections.entries()) {
    if (conn.status !== 'connected') continue;
    for (const tool of conn.tools) {
      const fnName = `mcp_${serverName}_${sanitizeName(tool.name)}`;
      defs.push({
        type: 'function',
        function: {
          name: fnName,
          description: `[MCP:${serverName}] ${tool.description || tool.name}`,
          parameters: tool.inputSchema && typeof tool.inputSchema === 'object'
            ? tool.inputSchema
            : { type: 'object', properties: {} },
        },
        _mcp: { serverName, toolName: tool.name },
      });
    }
  }
  return defs;
}

// ---- On-demand tool sets: a connected MCP server's tools are only sent to the model after load_tools ----
// (or after the model calls one of them directly). mcp.json "loadMode": "always" keeps a server always loaded.
export function isOnDemandServer(serverName) {
  const conn = connections.get(serverName);
  return String(conn?.config?.loadMode || 'on_demand') !== 'always';
}

// Configured on-demand servers (independent of connection status, so the tool list stays byte-identical
// across reconnects — that keeps the model's prompt-prefix cache valid).
export function getOnDemandServers() {
  return [...connections.entries()]
    .filter(([name, conn]) => conn?.config?.enabled !== false && isOnDemandServer(name))
    .map(([name]) => name)
    .sort();
}

// Compact definitions of one server's tools, returned *as a tool result* by load_tools (appended at the end of
// the conversation, so nothing earlier has to be re-read).
export function getCompactToolDefs(serverName) {
  const conn = connections.get(serverName);
  if (!conn) return { error: `No tool set named ${serverName}` };
  if (conn.status !== 'connected') return { error: `${serverName} is not connected right now (${conn.status}). Try again in a moment.` };
  const short = (txt, n) => { const t = String(txt || '').replace(/\s+/g, ' ').trim(); const first = t.split(/(?<=[.!?])\s/)[0] || t; return first.length > n ? first.slice(0, n - 1) + '…' : first; };
  const params = (schema) => {
    const props = schema?.properties || {}; const req = new Set(schema?.required || []);
    const out = {};
    for (const [k, v] of Object.entries(props)) {
      let type = v.type || (v.enum ? 'enum' : v.anyOf ? 'any' : 'any');
      if (Array.isArray(type)) type = type.join('|');
      const enumPart = v.enum ? `(${v.enum.slice(0, 12).join('|')})` : '';
      const d = short(v.description, 90);
      out[k] = `${type}${enumPart}${req.has(k) ? '' : '?'}${d ? ` — ${d}` : ''}`;
    }
    return out;
  };
  return conn.tools.map((t) => ({ name: sanitizeName(t.name), description: short(t.description, 220), params: params(t.inputSchema) }));
}


// "chrome", "browser", "Chrome DevTools" → "chrome_devtools"
export function resolveToolGroup(name) {
  const q = sanitizeName(name);
  if (!q) return null;
  const groups = [...connections.keys()].filter((s) => connections.get(s)?.config?.enabled !== false);
  const exact = groups.find((s) => sanitizeName(s) === q);
  if (exact) return exact;
  const partial = groups.find((s) => sanitizeName(s).includes(q) || q.includes(sanitizeName(s)));
  if (partial) return partial;
  if (/browser|web_?page|chrome|devtools|playwright|puppeteer/.test(q)) return groups.find((s) => /chrome|browser|playwright|puppeteer/i.test(s)) || null;
  return null;
}

export async function executeMcpTool(fnName, args) {
  for (const [serverName, conn] of connections.entries()) {
    if (conn.status !== 'connected') continue;
    for (const tool of conn.tools) {
      if (`mcp_${serverName}_${sanitizeName(tool.name)}` === fnName) {
        return await conn.callTool(tool.name, args);
      }
    }
  }
  throw new Error(`MCP tool "${fnName}" is not currently available`);
}

export function shutdownMcpServers() {
  for (const conn of connections.values()) conn.close();
  connections.clear();
}

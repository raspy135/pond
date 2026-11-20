// Zero-dependency IMAP4rev1 + SMTP TLS/STARTTLS client, MIME parser, local inbox store & AI Email Triage.
import tls from 'node:tls';
import net from 'node:net';
import { CONFIG, isEmailConfigured, isSmtpConfigured } from './config.js';
import { readJson, updateJson, uid, logActivity } from './storage.js';
import { stripTags } from './web.js';

// ---------- MIME & RFC 2047 decoding ----------
function decodeRfc2047(str) {
  if (!str) return '';
  return String(str).replace(/=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g, (_, charset, enc, text) => {
    try {
      let buf;
      if (enc.toUpperCase() === 'B') {
        buf = Buffer.from(text, 'base64');
      } else {
        const qp = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, h) => String.fromCharCode(parseInt(h, 16)));
        buf = Buffer.from(qp, 'latin1');
      }
      const norm = charset.toLowerCase();
      if (norm === 'utf-8' || norm === 'utf8') return buf.toString('utf8');
      try { return new TextDecoder(charset).decode(buf); } catch { return buf.toString('utf8'); }
    } catch {
      return text;
    }
  });
}

function decodeQuotedPrintable(str) {
  const unfolded = String(str).replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < unfolded.length; i++) {
    if (unfolded[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(unfolded.slice(i + 1, i + 3))) {
      bytes.push(parseInt(unfolded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(unfolded.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function parseHeaders(rawHeader) {
  const unfolded = rawHeader.replace(/\r?\n[ \t]+/g, ' ');
  const headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = decodeRfc2047(line.slice(idx + 1).trim());
    if (!headers[key]) headers[key] = val;
  }
  return headers;
}

function decodePartBody(body, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  if (enc === 'base64') {
    try { return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { return body; }
  }
  if (enc === 'quoted-printable') {
    try { return decodeQuotedPrintable(body); } catch { return body; }
  }
  return body;
}

function extractBodyFromMime(raw, headers) {
  const ct = headers['content-type'] || 'text/plain';
  const boundaryMatch = ct.match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
  if (boundaryMatch && /multipart\//i.test(ct)) {
    const boundary = boundaryMatch[1] || boundaryMatch[2];
    const parts = raw.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?\\r?\\n?`));
    let plain = '';
    let html = '';
    for (const part of parts.slice(1)) {
      if (!part || part.trim() === '--') continue;
      const sep = part.search(/\r?\n\r?\n/);
      if (sep === -1) continue;
      const pHeaders = parseHeaders(part.slice(0, sep));
      const pBody = part.slice(sep).replace(/^\r?\n\r?\n/, '');
      const pCt = (pHeaders['content-type'] || 'text/plain').toLowerCase();
      if (pCt.includes('multipart/')) {
        const nested = extractBodyFromMime(pBody, pHeaders);
        if (nested.plain && !plain) plain = nested.plain;
        if (nested.html && !html) html = nested.html;
      } else if (pCt.includes('text/plain') && !plain) {
        plain = decodePartBody(pBody, pHeaders['content-transfer-encoding']);
      } else if (pCt.includes('text/html') && !html) {
        html = decodePartBody(pBody, pHeaders['content-transfer-encoding']);
      }
    }
    return { plain, html };
  }
  const decoded = decodePartBody(raw, headers['content-transfer-encoding']);
  if (/text\/html/i.test(ct)) return { plain: '', html: decoded };
  return { plain: decoded, html: '' };
}

export function parseRawEmail(rawMessage, meta = {}) {
  const sep = rawMessage.search(/\r?\n\r?\n/);
  const headerPart = sep >= 0 ? rawMessage.slice(0, sep) : rawMessage;
  const bodyPart = sep >= 0 ? rawMessage.slice(sep).replace(/^\r?\n\r?\n/, '') : '';
  const headers = parseHeaders(headerPart);
  const { plain, html } = extractBodyFromMime(bodyPart, headers);
  const text = (plain || (html ? stripTags(html) : '')).replace(/\r\n/g, '\n').trim();
  const snippet = text.replace(/\s+/g, ' ').slice(0, 260);

  return {
    id: meta.id || (meta.uid ? `imap-${meta.uid}` : uid()),
    uid: meta.uid || null,
    messageId: headers['message-id'] || '',
    from: headers.from || 'Unknown sender',
    to: headers.to || '',
    subject: headers.subject || '(no subject)',
    date: headers.date ? new Date(headers.date).toISOString() : new Date().toISOString(),
    snippet,
    body: text.slice(0, 12_000),
    flags: meta.flags || [],
    unread: meta.unread ?? !(meta.flags || []).includes('\\Seen'),
    source: meta.source || 'imap',
  };
}

// ---------- Pure Node.js IMAP4rev1 Client (Buffer-accurate literal parser) ----------
class ImapClient {
  constructor({ host, port = 993, tls: useTls = true, timeoutMs = 20_000 }) {
    this.host = host;
    this.port = port;
    this.useTls = useTls;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.tagNum = 0;
    this.buf = Buffer.alloc(0);
    this.waiter = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const onConnect = () => {
        this.socket.setTimeout(this.timeoutMs);
        // Wait for initial "* OK ..." greeting line
        this._readLine().then((line) => {
          if (/^\* (OK|PREAUTH)/i.test(line)) resolve(line);
          else reject(new Error(`Unexpected IMAP greeting: ${line}`));
        }, reject);
      };
      this.socket = this.useTls
        ? tls.connect({ host: this.host, port: this.port, servername: this.host, rejectUnauthorized: true }, onConnect)
        : net.connect({ host: this.host, port: this.port }, onConnect);

      this.socket.on('data', (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        this._pump();
      });
      this.socket.on('error', (err) => {
        if (this.waiter) {
          const w = this.waiter;
          this.waiter = null;
          w.reject(err);
        } else reject(err);
      });
      this.socket.on('timeout', () => {
        const err = new Error('IMAP socket timed out');
        this.socket.destroy(err);
      });
      this.socket.on('close', () => {
        if (this.waiter) {
          const w = this.waiter;
          this.waiter = null;
          w.reject(new Error('IMAP connection closed unexpectedly'));
        }
      });
    });
  }

  _pump() {
    if (!this.waiter) return;
    if (this.waiter.type === 'line') {
      const idx = this.buf.indexOf('\r\n');
      if (idx !== -1) {
        const line = this.buf.subarray(0, idx).toString('utf8');
        this.buf = this.buf.subarray(idx + 2);
        const w = this.waiter;
        this.waiter = null;
        w.resolve(line);
      }
    } else if (this.waiter.type === 'bytes') {
      if (this.buf.length >= this.waiter.count) {
        const data = this.buf.subarray(0, this.waiter.count);
        this.buf = this.buf.subarray(this.waiter.count);
        const w = this.waiter;
        this.waiter = null;
        w.resolve(data);
      }
    }
  }

  _readLine() {
    return new Promise((resolve, reject) => {
      this.waiter = { type: 'line', resolve, reject };
      this._pump();
    });
  }

  _readBytes(count) {
    return new Promise((resolve, reject) => {
      this.waiter = { type: 'bytes', count, resolve, reject };
      this._pump();
    });
  }

  async command(cmd) {
    const tag = `A${++this.tagNum}`;
    this.socket.write(`${tag} ${cmd}\r\n`);
    return this._collect(tag, cmd);
  }

  // Command whose last argument is sent as an IMAP literal ({n} + continuation) — needed for UTF-8 search text.
  async commandLit(prefix, literal, suffix = '') {
    const tag = `A${++this.tagNum}`;
    const data = Buffer.from(String(literal), 'utf8');
    this.socket.write(`${tag} ${prefix} {${data.length}}\r\n`);
    const first = await this._readLine();
    if (!first.startsWith('+')) {
      if (first.startsWith(`${tag} `)) throw new Error(`IMAP ${prefix.split(' ')[0]} failed: ${first.slice(tag.length + 1)}`);
      throw new Error(`IMAP: expected continuation, got: ${first.slice(0, 120)}`);
    }
    this.socket.write(Buffer.concat([data, Buffer.from(`${suffix}\r\n`, 'utf8')]));
    return this._collect(tag, prefix);
  }

  async _collect(tag, cmd) {
    const lines = [];
    const literals = [];
    while (true) {
      const line = await this._readLine();
      if (line.startsWith(`${tag} `)) {
        const status = line.slice(tag.length + 1);
        if (!/^OK\b/i.test(status)) throw new Error(`IMAP ${cmd.split(' ')[0]} failed: ${status}`);
        return { status, lines, literals };
      }
      lines.push(line);
      // Handle IMAP literal "{N}" at end of line
      const litMatch = line.match(/\{(\d+)\}$/);
      if (litMatch) {
        const byteCount = Number(litMatch[1]);
        const rawBytes = await this._readBytes(byteCount);
        literals.push({ headerLine: line, data: rawBytes.toString('utf8') });
      }
    }
  }

  async login(user, pass) {
    const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    try {
      return await this.command(`LOGIN ${q(user)} ${q(pass)}`);
    } catch (err) {
      const m = String(err?.message || err);
      if (/gmail\.com/i.test(this.host) && /AUTHENTICATIONFAILED|Invalid credentials|Application-specific/i.test(m)) {
        throw new Error('Gmail rejected the login — use a 16-character Google App Password (myaccount.google.com/apppasswords, requires 2-Step Verification), not your regular Google password.');
      }
      throw err;
    }
  }

  async select(mailbox = 'INBOX') {
    const q = `"${String(mailbox).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    return this.command(`SELECT ${q}`);
  }

  // Name of the "all mail" folder (RFC 6154 \All, e.g. Gmail's [Gmail]/All Mail), or null.
  async findAllMailbox() {
    const res = await this.command('LIST "" "*"');
    for (const line of res.lines) {
      const m = line.match(/^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) (.+)$/i);
      if (m && /\\All\b/i.test(m[1])) return m[2].trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1');
    }
    return null;
  }

  async uidSearchLit(prefix, text) {
    return this._searchUids(await this.commandLit(`UID SEARCH ${prefix}`, text));
  }

  async uidSearch(criteria = 'UNSEEN') {
    return this._searchUids(await this.command(`UID SEARCH ${criteria}`));
  }

  _searchUids(res) {
    const uids = [];
    for (const line of res.lines) {
      if (line.startsWith('* SEARCH')) {
        const parts = line.slice(8).trim().split(/\s+/).filter(Boolean);
        for (const p of parts) {
          const n = Number(p);
          if (Number.isFinite(n) && n > 0) uids.push(n);
        }
      }
    }
    return uids;
  }

  // partialBytes: only download the first N bytes of each message (text parts come first; skips big attachments).
  async uidFetchMessages(uids, { partialBytes = 0, idPrefix = 'imap-' } = {}) {
    if (!uids.length) return [];
    const seq = uids.join(',');
    const res = await this.command(`UID FETCH ${seq} (UID FLAGS BODY.PEEK[]${partialBytes ? `<0.${partialBytes}>` : ''})`);
    const messages = [];
    for (const lit of res.literals) {
      const uidMatch = lit.headerLine.match(/\bUID\s+(\d+)/i);
      const flagsMatch = lit.headerLine.match(/\bFLAGS\s+\(([^)]*)\)/i);
      const msgUid = uidMatch ? Number(uidMatch[1]) : null;
      const flags = flagsMatch ? flagsMatch[1].trim().split(/\s+/).filter(Boolean) : [];
      messages.push(parseRawEmail(lit.data, { uid: msgUid, flags, source: 'imap', ...(msgUid && idPrefix !== 'imap-' ? { id: `${idPrefix}${msgUid}` } : {}) }));
    }
    return messages;
  }

  async logout() {
    try { await this.command('LOGOUT'); } catch { /* ignore */ }
    try { this.socket?.end(); this.socket?.destroy(); } catch { /* ignore */ }
  }
}

// ---------- Pure Node.js SMTP Client (TLS 465 + STARTTLS 587) ----------
function readSmtpResponse(socket) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i];
        if (/^\d{3} /.test(line)) {
          cleanup();
          resolve({ code: Number(line.slice(0, 3)), text: buf.trim() });
          return;
        }
      }
    };
    const onErr = (err) => { cleanup(); reject(err); };
    const onClose = () => { cleanup(); reject(new Error('SMTP connection closed')); };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onErr);
      socket.off('close', onClose);
    };
    socket.on('data', onData);
    socket.on('error', onErr);
    socket.on('close', onClose);
  });
}

async function smtpCmd(socket, cmd, expectedCodes) {
  socket.write(`${cmd}\r\n`);
  const resp = await readSmtpResponse(socket);
  if (expectedCodes && !expectedCodes.includes(resp.code)) {
    throw new Error(`SMTP error (${resp.code}): ${resp.text}`);
  }
  return resp;
}

export async function sendSmtpMail({ to, subject, body, inReplyTo = '' }) {
  if (!isSmtpConfigured()) {
    throw new Error('SMTP is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in Settings or .env.');
  }
  const { smtpHost, smtpPort, smtpUser, smtpPass, smtpSecure, fromAddress } = CONFIG.email;
  const from = fromAddress || smtpUser;

  let socket = await new Promise((resolve, reject) => {
    const s = smtpSecure
      ? tls.connect({ host: smtpHost, port: smtpPort, servername: smtpHost }, () => resolve(s))
      : net.connect({ host: smtpHost, port: smtpPort }, () => resolve(s));
    s.setTimeout(20_000);
    s.once('error', reject);
  });

  try {
    const greet = await readSmtpResponse(socket);
    if (greet.code !== 220) throw new Error(`SMTP greeting error: ${greet.text}`);
    const ehlo = await smtpCmd(socket, 'EHLO pond.local', [250]);

    if (!smtpSecure && /STARTTLS/i.test(ehlo.text)) {
      await smtpCmd(socket, 'STARTTLS', [220]);
      socket = await new Promise((resolve, reject) => {
        const upgraded = tls.connect({ socket, servername: smtpHost }, () => resolve(upgraded));
        upgraded.once('error', reject);
      });
      await smtpCmd(socket, 'EHLO pond.local', [250]);
    }

    // AUTH PLAIN
    const plainToken = Buffer.from(`\0${smtpUser}\0${smtpPass}`, 'utf8').toString('base64');
    try {
      await smtpCmd(socket, `AUTH PLAIN ${plainToken}`, [235]);
    } catch {
      // Fallback AUTH LOGIN
      await smtpCmd(socket, 'AUTH LOGIN', [334]);
      await smtpCmd(socket, Buffer.from(smtpUser).toString('base64'), [334]);
      await smtpCmd(socket, Buffer.from(smtpPass).toString('base64'), [235]);
    }

    await smtpCmd(socket, `MAIL FROM:<${from}>`, [250]);
    const recipients = String(to)
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const rcpt of recipients) {
      const m = rcpt.match(/<([^>]+)>/);
      await smtpCmd(socket, `RCPT TO:<${m ? m[1] : rcpt}>`, [250, 251]);
    }
    await smtpCmd(socket, 'DATA', [354]);

    const headers = [
      `From: ${from}`,
      `To: ${recipients.join(', ')}`,
      `Subject: ${String(subject || '(no subject)').replace(/\r?\n/g, ' ')}`,
      `Date: ${new Date().toUTCString()}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=utf-8`,
      ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
    ];
    const safeBody = String(body || '')
      .replace(/\r?\n/g, '\r\n')
      .replace(/^\./gm, '..');
    socket.write(`${headers.join('\r\n')}\r\n\r\n${safeBody}\r\n.\r\n`);
    const sent = await readSmtpResponse(socket);
    if (sent.code !== 250) throw new Error(`SMTP DATA rejected: ${sent.text}`);
    await smtpCmd(socket, 'QUIT', [221]).catch(() => {});
    return { ok: true, from, to: recipients, subject };
  } finally {
    try { socket.end(); socket.destroy(); } catch { /* ignore */ }
  }
}

// ---------- Compact email text for the model ----------
// Marketing mail is ~2/3 tracking URLs by length. The model rarely needs them, and they cost real prefill time.
// Long links become [link:domain]; links to unsubscribe / manage a subscription are kept whole.
const KEEP_LINK = /unsub|opt-?out|optout|preferences|manage|cancel|subscription|account\/settings|配信停止|解除/i;
export function compactEmailText(text, { fullLinks = false } = {}) {
  let t = String(text || '');
  if (!fullLinks) {
    const src = t;
    t = t.replace(/<?(https?:\/\/[^\s<>()"']+)>?/g, (m, url, offset) => {
      if (url.length <= 48) return url;
      // keep it when the URL or the words right before it are about unsubscribing / managing the subscription
      if (KEEP_LINK.test(url) || KEEP_LINK.test(src.slice(Math.max(0, offset - 80), offset))) return url.length > 400 ? url.slice(0, 400) + '…' : url;
      let host = ''; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { host = 'link'; }
      return `[link:${host}]`;
    });
    t = t.replace(/(\[link:[^\]]+\]\s*){2,}/g, (m) => `${m.trim().split(/\s+/)[0]} `); // runs of the same kind of link
  }
  return t.replace(/[ \t ]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- Whole-mailbox search (beyond the recent-sync window) ----------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const toDate = (v) => { const d = new Date(String(v || '').trim()); return Number.isNaN(d.getTime()) ? null : d; };
const imapDate = (d) => `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
const gmailDate = (d) => `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
const isGmailHost = (h) => /(^|\.)(gmail|googlemail)\.com$/i.test(String(h || ''));
const imapQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// Gmail understands its own search syntax over IMAP (X-GM-RAW): OR, "phrases", from:, subject:, after:, before:.
export function buildGmailQuery({ query = '', from = '', since = '', before = '' } = {}) {
  const s = toDate(since); const b = toDate(before);
  return [String(query || '').trim(), from ? `from:(${from})` : '', s ? `after:${gmailDate(s)}` : '', b ? `before:${gmailDate(b)}` : '']
    .filter(Boolean).join(' ') || 'in:anywhere';
}

// Plain IMAP SEARCH criteria: "a OR b OR from:x" → OR TEXT "a" OR TEXT "b" FROM "x" …
export function buildImapCriteria({ query = '', from = '', since = '', before = '' } = {}) {
  const terms = String(query || '').split(/\s+OR\s+/i).map((t) => t.trim()).filter(Boolean);
  const key = (t) => {
    const m = t.match(/^(from|subject|to):(.+)$/i);
    const v = (m ? m[2] : t).replace(/^"(.*)"$/, '$1').replace(/^\((.*)\)$/, '$1');
    return `${m ? m[1].toUpperCase() : 'TEXT'} ${imapQuote(v)}`;
  };
  const parts = [];
  if (terms.length) parts.push(terms.map(key).reduce((acc, k) => (acc ? `OR ${acc} ${k}` : k), ''));
  if (from) parts.push(`FROM ${imapQuote(from)}`);
  const s = toDate(since); const b = toDate(before);
  if (s) parts.push(`SINCE ${imapDate(s)}`);
  if (b) parts.push(`BEFORE ${imapDate(b)}`);
  const crit = parts.join(' ') || 'ALL';
  return /[^\x00-\x7f]/.test(crit) ? `CHARSET UTF-8 ${crit}` : crit;
}

export async function searchImapMailbox({ query = '', from = '', since = '', before = '', limit = 30 } = {}) {
  if (!isEmailConfigured()) return { ok: false, configured: false, emails: [] };
  const { imapHost, imapPort, imapUser, imapPass, imapTls, imapMailbox } = CONFIG.email;
  const client = new ImapClient({ host: imapHost, port: imapPort, tls: imapTls, timeoutMs: 45_000 });
  try {
    await client.connect();
    await client.login(imapUser, imapPass);
    // Search everything (archived mail too) when the server has an "all mail" folder.
    const allBox = await client.findAllMailbox().catch(() => null);
    const mailbox = allBox || imapMailbox || 'INBOX';
    await client.select(mailbox);
    const caps = await client.command('CAPABILITY').then((r) => r.lines.join(' ')).catch(() => '');
    const gmail = /\bX-GM-EXT-1\b/i.test(caps) || isGmailHost(imapHost); // Gmail search syntax available
    const uids = gmail
      ? await client.uidSearchLit('CHARSET UTF-8 X-GM-RAW', buildGmailQuery({ query, from, since, before }))
      : await client.uidSearch(buildImapCriteria({ query, from, since, before }));
    uids.sort((a, b) => a - b);
    const pick = uids.slice(-Math.max(1, Math.min(100, limit)));
    const msgs = await client.uidFetchMessages(pick, { partialBytes: 200_000, idPrefix: allBox ? 'imap-all-' : 'imap-' });
    return { ok: true, configured: true, mailbox, totalMatches: uids.length, emails: msgs.map((m) => ({ ...m, account: imapUser })) };
  } finally {
    await client.logout();
  }
}

// Messages found by mailbox search are kept here (not in the inbox list) so read_email can open them later.
const ARCHIVE_FILE = 'email-archive.json';
export async function archiveEmails(items = []) {
  if (!items.length) return;
  await updateJson(ARCHIVE_FILE, { items: [] }, (cur) => {
    const byId = new Map((cur?.items || []).map((m) => [m.id, m]));
    for (const m of items) byId.set(m.id, { ...m, archivedAt: new Date().toISOString() });
    return { items: [...byId.values()].sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt))).slice(0, 400) };
  });
}
export async function findEmail(id) {
  const store = await getEmailStore();
  const hit = (store.items || []).find((x) => x.id === id);
  if (hit) return hit;
  const arch = await readJson(ARCHIVE_FILE, { items: [] });
  return (arch.items || []).find((x) => x.id === id) || null;
}

// ---------- Local Inbox Store & Sync ----------
const EMPTY_STORE = { lastUid: 0, seenIds: [], items: [], drafts: [], lastSyncAt: null, lastError: null };

export async function getEmailStore() {
  const store = await readJson('emails.json', EMPTY_STORE);
  return {
    lastUid: store.lastUid || 0,
    seenIds: Array.isArray(store.seenIds) ? store.seenIds : [],
    items: Array.isArray(store.items) ? store.items : [],
    drafts: Array.isArray(store.drafts) ? store.drafts : [],
    lastSyncAt: store.lastSyncAt || null,
    lastError: store.lastError || null,
  };
}

export async function ingestEmail({ from, to = '', subject, body, date = null, source = 'webhook' }) {
  const item = {
    id: `mail-${uid()}`,
    uid: null,
    from: String(from || 'unknown@example.com'),
    to: String(to || CONFIG.email.imapUser || ''),
    subject: String(subject || '(no subject)'),
    date: date ? new Date(date).toISOString() : new Date().toISOString(),
    snippet: String(body || '').replace(/\s+/g, ' ').slice(0, 260),
    body: String(body || '').slice(0, 12_000),
    unread: true,
    source,
    triaged: false,
    notified: false,
    importance: null,
    receivedAt: new Date().toISOString(),
  };

  await updateJson('emails.json', EMPTY_STORE, (store) => {
    const s = { ...EMPTY_STORE, ...store };
    s.items = [item, ...(s.items || [])].slice(0, 150);
    return s;
  });

  await logActivity({
    kind: 'email',
    title: `Email received (${source})`,
    detail: `From: ${item.from} — ${item.subject}`,
  });

  return item;
}

export async function syncImapEmails({ limit = 15 } = {}) {
  if (!isEmailConfigured()) {
    return { ok: false, configured: false, fetched: 0, newEmails: [] };
  }
  const { imapHost, imapPort, imapUser, imapPass, imapTls, imapMailbox } = CONFIG.email;
  const client = new ImapClient({ host: imapHost, port: imapPort, tls: imapTls });

  try {
    await client.connect();
    await client.login(imapUser, imapPass);
    await client.select(imapMailbox || 'INBOX');

    // Fetch recent UNSEEN emails; if none, also check most recent ALL so user sees their inbox on first sync
    let uids = await client.uidSearch('UNSEEN');
    const store = await getEmailStore();
    if (!uids.length && store.items.length === 0) {
      uids = await client.uidSearch('ALL');
    }
    uids.sort((a, b) => a - b);
    const recentUids = uids.slice(-limit);
    const unseenByPond = recentUids.filter((u) => !store.seenIds.includes(`imap-${u}`));

    let fetchedMsgs = [];
    if (unseenByPond.length) {
      fetchedMsgs = await client.uidFetchMessages(unseenByPond);
    }

    await updateJson('emails.json', EMPTY_STORE, (s) => {
      const next = { ...EMPTY_STORE, ...s };
      next.lastSyncAt = new Date().toISOString();
      next.lastError = null;
      const seenSet = new Set(next.seenIds || []);
      for (const m of fetchedMsgs) {
        if (seenSet.has(m.id)) continue;
        seenSet.add(m.id);
        if (m.uid && m.uid > (next.lastUid || 0)) next.lastUid = m.uid;
        next.items.unshift({ ...m, triaged: false, notified: false, receivedAt: new Date().toISOString() });
      }
      next.seenIds = Array.from(seenSet).slice(-500);
      next.items = next.items.slice(0, 150);
      return next;
    });

    if (fetchedMsgs.length) {
      await logActivity({
        kind: 'email',
        title: `Synced ${fetchedMsgs.length} new email(s) via IMAP`,
        detail: fetchedMsgs.map((m) => `${m.from}: ${m.subject}`).join(' | ').slice(0, 400),
      });
    }

    return { ok: true, configured: true, fetched: fetchedMsgs.length, newEmails: fetchedMsgs };
  } catch (err) {
    const msg = String(err?.message || err);
    await updateJson('emails.json', EMPTY_STORE, (s) => ({
      ...EMPTY_STORE,
      ...s,
      lastSyncAt: new Date().toISOString(),
      lastError: msg,
    }));
    await logActivity({ kind: 'email', level: 'error', title: 'IMAP sync failed', detail: msg });
    return { ok: false, configured: true, error: msg, fetched: 0, newEmails: [] };
  } finally {
    await client.logout();
  }
}

export async function saveDraft({ to, subject, body, replyToId = null }) {
  const draft = {
    id: `draft-${uid()}`,
    to: String(to || ''),
    subject: String(subject || ''),
    body: String(body || ''),
    replyToId,
    createdAt: new Date().toISOString(),
  };
  await updateJson('emails.json', EMPTY_STORE, (s) => {
    const next = { ...EMPTY_STORE, ...s };
    next.drafts = [draft, ...(next.drafts || [])].slice(0, 50);
    return next;
  });
  return draft;
}

export async function markEmailTriaged(id, triage) {
  await updateJson('emails.json', EMPTY_STORE, (s) => {
    const next = { ...EMPTY_STORE, ...s };
    next.items = (next.items || []).map((m) =>
      m.id === id
        ? {
            ...m,
            triaged: true,
            importance: triage,
            notified: Boolean(triage?.notified ?? m.notified),
          }
        : m
    );
    return next;
  });
}

export async function dismissEmail(id) {
  await updateJson('emails.json', EMPTY_STORE, (s) => {
    const next = { ...EMPTY_STORE, ...s };
    next.items = (next.items || []).map((m) =>
      m.id === id ? { ...m, unread: false, dismissed: true } : m
    );
    return next;
  });
  return { ok: true };
}

export async function dismissAllEmails() {
  await updateJson('emails.json', EMPTY_STORE, (s) => {
    const next = { ...EMPTY_STORE, ...s };
    next.items = (next.items || []).map((m) => ({ ...m, unread: false, dismissed: true }));
    return next;
  });
  return { ok: true };
}

// Fast local heuristic fallback (used alongside or when LLM unavailable)
export function heuristicTriageEmail(email) {
  const hay = `${email.from} ${email.subject} ${email.snippet}`.toLowerCase();
  const isVip = (CONFIG.email.vipSenders || []).some((v) => hay.includes(v.toLowerCase()));
  const matchedKw = (CONFIG.email.importantKeywords || []).filter((k) => hay.includes(k.toLowerCase()));
  const looksPromo = /\b(unsubscribe|newsletter|promo|sale|digest|marketing|weekly roundup)\b/i.test(hay);

  if (isVip) {
    return {
      important: true,
      urgency: 'high',
      category: 'vip',
      summary: `VIP email from ${email.from}: "${email.subject}"`,
      reason: 'Sender matches your VIP list.',
      suggestedAction: 'Review and reply promptly.',
    };
  }
  if (matchedKw.length > 0 && !looksPromo) {
    const critical = /security|verify|fraud|bank|payment|flight|cancelled|urgent|asap|deadline/i.test(matchedKw.join(' '));
    return {
      important: true,
      urgency: critical ? 'critical' : 'high',
      category: critical ? 'action_required' : 'important',
      summary: `${email.subject} — from ${email.from}`,
      reason: `Matched important signals: ${matchedKw.slice(0, 3).join(', ')}`,
      suggestedAction: 'Open and check if action is needed.',
    };
  }
  return {
    important: false,
    urgency: 'low',
    category: looksPromo ? 'promo' : 'normal',
    summary: `${email.subject} — from ${email.from}`,
    reason: 'No urgent signals detected.',
    suggestedAction: '',
  };
}

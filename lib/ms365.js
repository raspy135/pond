// Zero-dependency Microsoft 365 / Outlook 365 (Exchange Online) connector via Microsoft Graph API + OAuth2 Device Code Flow.
// Works seamlessly with custom-domain Microsoft 365 business accounts and MFA — no Basic Auth required!
import crypto from 'node:crypto';
import { readJson, updateJson, logActivity } from './storage.js';
import { stripTags } from './web.js';
import { broadcast } from './notifications.js';

const MS_FILE = 'ms365.json';
const EMPTY_MS = {
  enabled: false,
  clientId: '',
  tenantId: 'organizations', // 'organizations' for work/M365 custom domains, 'common' for personal+work
  allowSend: true,
  accountEmail: '',
  accountName: '',
  accessToken: '',
  refreshToken: '',
  expiresAt: 0,
  lastSyncAt: null,
  lastError: null,
};

let activePoll = null; // { timer, aborted, userCode, verificationUri, expiresAt }

export async function getMs365State() {
  const saved = await readJson(MS_FILE, EMPTY_MS);
  return { ...EMPTY_MS, ...(saved || {}) };
}

export async function getPublicMs365Status() {
  const s = await getMs365State();
  return {
    enabled: Boolean(s.enabled),
    configured: Boolean(s.clientId),
    connected: Boolean(s.refreshToken || (s.accessToken && s.expiresAt > Date.now())),
    clientId: s.clientId || '',
    tenantId: s.tenantId || 'organizations',
    allowSend: s.allowSend !== false,
    accountEmail: s.accountEmail || '',
    accountName: s.accountName || '',
    lastSyncAt: s.lastSyncAt || null,
    lastError: s.lastError || null,
    pendingLogin: activePoll
      ? { userCode: activePoll.userCode, verificationUri: activePoll.verificationUri, expiresAt: activePoll.expiresAt }
      : null,
  };
}

export async function isMs365Connected() {
  const s = await getMs365State();
  return Boolean(s.enabled && s.clientId && (s.refreshToken || (s.accessToken && s.expiresAt > Date.now())));
}

export async function disconnectMs365() {
  if (activePoll) {
    activePoll.aborted = true;
    clearTimeout(activePoll.timer);
    activePoll = null;
  }
  await updateJson(MS_FILE, EMPTY_MS, (cur) => ({
    ...EMPTY_MS,
    clientId: cur?.clientId || '',
    tenantId: cur?.tenantId || 'organizations',
    allowSend: cur?.allowSend !== false,
  }));
  broadcast({ type: 'ms365_auth', status: 'disconnected' });
  return getPublicMs365Status();
}

function buildScopes(allowSend = true) {
  return allowSend
    ? 'offline_access User.Read Mail.Read Mail.Send'
    : 'offline_access User.Read Mail.Read';
}

export async function startMs365DeviceLogin({ clientId, tenantId = 'organizations', allowSend = true, onConnected = null } = {}) {
  const cid = String(clientId || '').trim();
  const tid = String(tenantId || 'organizations').trim() || 'organizations';
  if (!cid) throw new Error('Microsoft Application (client) ID is required.');

  // Cancel any earlier login poll
  if (activePoll) {
    activePoll.aborted = true;
    clearTimeout(activePoll.timer);
    activePoll = null;
  }

  await updateJson(MS_FILE, EMPTY_MS, (cur) => ({
    ...EMPTY_MS,
    ...(cur || {}),
    clientId: cid,
    tenantId: tid,
    allowSend: Boolean(allowSend),
    lastError: null,
  }));

  const scope = buildScopes(allowSend);
  const requestDeviceCode = async (targetTenant) => {
    const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(targetTenant)}/oauth2/v2.0/devicecode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cid, scope }),
      signal: AbortSignal.timeout(15_000),
    });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok && Boolean(d.device_code), status: r.status, data: d };
  };

  let effectiveTenant = tid;
  let dc = await requestDeviceCode(effectiveTenant);
  // Auto-fallback to /consumers if the Entra app is registered for personal Microsoft accounts only (AADSTS9002346)
  if (!dc.ok && /AADSTS9002346|\/consumers/i.test(String(dc.data?.error_description || ''))) {
    effectiveTenant = 'consumers';
    dc = await requestDeviceCode(effectiveTenant);
    if (dc.ok) {
      await updateJson(MS_FILE, EMPTY_MS, (cur) => ({ ...EMPTY_MS, ...(cur || {}), tenantId: effectiveTenant }));
    }
  }
  const data = dc.data;
  if (!dc.ok) {
    const errMsg = data.error_description || data.error || `Microsoft devicecode HTTP ${dc.status}`;
    throw new Error(errMsg);
  }

  const intervalMs = Math.max(3, Number(data.interval) || 5) * 1000;
  const expiresAt = Date.now() + (Number(data.expires_in) || 900) * 1000;
  const pollState = {
    aborted: false,
    timer: null,
    userCode: data.user_code,
    verificationUri: data.verification_uri || 'https://microsoft.com/devicelogin',
    expiresAt,
  };
  activePoll = pollState;

  const pollOnce = async () => {
    if (pollState.aborted || Date.now() > expiresAt) {
      if (activePoll === pollState) activePoll = null;
      broadcast({ type: 'ms365_auth', status: 'expired' });
      return;
    }
    try {
      const tokResp = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(effectiveTenant)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: cid,
          device_code: data.device_code,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const tok = await tokResp.json().catch(() => ({}));
      if (tokResp.ok && tok.access_token) {
        if (activePoll === pollState) activePoll = null;
        // Fetch signed-in user identity (e.g. you@company.com)
        let accountEmail = '';
        let accountName = '';
        try {
          const meResp = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', {
            headers: { Authorization: `Bearer ${tok.access_token}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (meResp.ok) {
            const me = await meResp.json();
            accountEmail = me.mail || me.userPrincipalName || '';
            accountName = me.displayName || '';
          }
        } catch { /* best effort */ }

        await updateJson(MS_FILE, EMPTY_MS, (cur) => ({
          ...EMPTY_MS,
          ...(cur || {}),
          enabled: true,
          clientId: cid,
          tenantId: effectiveTenant,
          allowSend: Boolean(allowSend),
          accountEmail,
          accountName,
          accessToken: tok.access_token,
          refreshToken: tok.refresh_token || cur?.refreshToken || '',
          expiresAt: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
          lastError: null,
        }));

        await logActivity({
          kind: 'email',
          title: `Connected Microsoft 365 (${accountEmail || 'account'})`,
          detail: 'Microsoft Graph OAuth2 sign-in succeeded',
        });
        broadcast({ type: 'ms365_auth', status: 'connected', accountEmail, accountName });
        if (typeof onConnected === 'function') onConnected().catch(() => {});
        return;
      }

      if (tok.error === 'authorization_pending' || tok.error === 'slow_down') {
        pollState.timer = setTimeout(pollOnce, tok.error === 'slow_down' ? intervalMs + 3000 : intervalMs);
        return;
      }

      // Terminal OAuth error (declined, expired, bad client config)
      if (activePoll === pollState) activePoll = null;
      let errMsg = tok.error_description || tok.error || 'Microsoft sign-in failed';
      if (/AADSTS7000218/i.test(errMsg)) {
        errMsg = 'Enable "Allow public client flows = Yes" under Entra App → Authentication → Advanced settings, click Save, and sign in again.';
      }
      await updateJson(MS_FILE, EMPTY_MS, (cur) => ({ ...EMPTY_MS, ...(cur || {}), lastError: errMsg }));
      broadcast({ type: 'ms365_auth', status: 'error', error: errMsg });
    } catch {
      pollState.timer = setTimeout(pollOnce, intervalMs);
    }
  };

  pollState.timer = setTimeout(pollOnce, intervalMs);

  return {
    ok: true,
    userCode: data.user_code,
    verificationUri: pollState.verificationUri,
    message: data.message || `Go to ${pollState.verificationUri} and enter code ${data.user_code}`,
    expiresIn: Number(data.expires_in) || 900,
  };
}

async function getValidAccessToken() {
  const s = await getMs365State();
  if (!s.enabled || !s.clientId) throw new Error('Microsoft 365 is not connected.');
  if (s.accessToken && s.expiresAt > Date.now() + 120_000) {
    return s.accessToken;
  }
  if (!s.refreshToken) {
    throw new Error('Microsoft 365 session expired — please sign in again under Agent Hub → Email.');
  }

  const tid = s.tenantId || 'organizations';
  const resp = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tid)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: s.clientId,
      refresh_token: s.refreshToken,
      scope: buildScopes(s.allowSend !== false),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const tok = await resp.json().catch(() => ({}));
  if (!resp.ok || !tok.access_token) {
    const errMsg = tok.error_description || tok.error || `Token refresh failed (${resp.status})`;
    await updateJson(MS_FILE, EMPTY_MS, (cur) => ({ ...EMPTY_MS, ...(cur || {}), lastError: errMsg }));
    throw new Error(errMsg);
  }
  await updateJson(MS_FILE, EMPTY_MS, (cur) => ({
    ...EMPTY_MS,
    ...(cur || {}),
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token || cur.refreshToken,
    expiresAt: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
    lastError: null,
  }));
  return tok.access_token;
}

const EMPTY_EMAIL_STORE = { lastUid: 0, seenIds: [], items: [], drafts: [], lastSyncAt: null, lastError: null };

function graphToItem(m, state) {
  const shortHash = crypto.createHash('sha1').update(String(m.id)).digest('hex').slice(0, 14);
  const fromAddr = m.from?.emailAddress?.address || '';
  const fromName = m.from?.emailAddress?.name || '';
  const bodyRaw = m.body?.content || m.bodyPreview || '';
  const bodyText = (m.body?.contentType === 'html' ? stripTags(bodyRaw) : String(bodyRaw)).replace(/\r\n/g, '\n').trim();
  return {
    id: `ms365-${shortHash}`,
    uid: null,
    messageId: m.internetMessageId || '',
    from: fromName && fromAddr ? `${fromName} <${fromAddr}>` : (fromAddr || fromName || 'Unknown sender'),
    to: (m.toRecipients || []).map((r) => r.emailAddress?.address).filter(Boolean).join(', ') || state.accountEmail || '',
    subject: m.subject || '(no subject)',
    date: m.receivedDateTime ? new Date(m.receivedDateTime).toISOString() : new Date().toISOString(),
    snippet: (m.bodyPreview || bodyText).replace(/\s+/g, ' ').slice(0, 260),
    body: bodyText.slice(0, 12_000),
    unread: !m.isRead,
    hasAttachments: Boolean(m.hasAttachments),
    source: 'microsoft365',
    account: state.accountEmail || 'Microsoft 365',
  };
}

// Graph $search uses KQL: OR, "phrases", from:, subject:, received>=YYYY-MM-DD.
export function buildKql({ query = '', from = '', since = '', before = '' } = {}) {
  const d = (v) => { const t = new Date(String(v || '').trim()); return Number.isNaN(t.getTime()) ? '' : t.toISOString().slice(0, 10); };
  return [String(query || '').trim(), from ? `from:${from}` : '', d(since) ? `received>=${d(since)}` : '', d(before) ? `received<${d(before)}` : '']
    .filter(Boolean).join(' ');
}

// Search the whole mailbox (all folders), newest first, up to `limit` messages.
export async function searchMs365Mail({ query = '', from = '', since = '', before = '', limit = 30 } = {}) {
  if (!(await isMs365Connected())) return { ok: false, configured: false, emails: [] };
  const state = await getMs365State();
  const token = await getValidAccessToken();
  const max = Math.max(1, Math.min(100, limit));
  const select = 'id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview,body,internetMessageId,hasAttachments';
  const kql = buildKql({ query, from, since, before });
  const params = kql
    ? new URLSearchParams({ $search: `"${kql.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`, $top: String(Math.min(50, max)), $select: select })
    : new URLSearchParams({ $orderby: 'receivedDateTime desc', $top: String(Math.min(50, max)), $select: select });
  let url = `https://graph.microsoft.com/v1.0/me/messages?${params}`;
  const out = [];
  for (let page = 0; url && out.length < max && page < 4; page++) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"' }, signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) throw new Error(`Microsoft Graph search HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 300)}`);
    const data = await resp.json();
    for (const m of data.value || []) out.push(graphToItem(m, state));
    url = data['@odata.nextLink'] || null;
  }
  out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { ok: true, configured: true, emails: out.slice(0, max) };
}

export async function syncMs365Emails({ limit = 15 } = {}) {
  if (!(await isMs365Connected())) {
    return { ok: false, configured: false, fetched: 0, newEmails: [] };
  }
  const state = await getMs365State();
  try {
    const token = await getValidAccessToken();
    const params = new URLSearchParams({
      $top: String(Math.min(30, Math.max(1, limit))),
      $orderby: 'receivedDateTime desc',
      $select: 'id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview,body,internetMessageId',
    });
    const resp = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?${params}`, {
      headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok) {
      const t = (await resp.text().catch(() => '')).slice(0, 300);
      throw new Error(`Microsoft Graph Mail HTTP ${resp.status}: ${t}`);
    }
    const data = await resp.json();
    const rawList = Array.isArray(data.value) ? data.value : [];

    const fetchedMsgs = [];
    await updateJson('emails.json', EMPTY_EMAIL_STORE, (s) => {
      const next = { ...EMPTY_EMAIL_STORE, ...s };
      const seenSet = new Set(next.seenIds || []);
      for (const m of rawList) {
        const shortHash = crypto.createHash('sha1').update(String(m.id)).digest('hex').slice(0, 14);
        const id = `ms365-${shortHash}`;
        if (seenSet.has(id)) continue;
        seenSet.add(id);

        const fromAddr = m.from?.emailAddress?.address || '';
        const fromName = m.from?.emailAddress?.name || '';
        const from = fromName && fromAddr ? `${fromName} <${fromAddr}>` : (fromAddr || fromName || 'Unknown sender');
        const to = (m.toRecipients || []).map((r) => r.emailAddress?.address).filter(Boolean).join(', ');
        const bodyRaw = m.body?.content || m.bodyPreview || '';
        const bodyText = (m.body?.contentType === 'html' ? stripTags(bodyRaw) : String(bodyRaw)).replace(/\r\n/g, '\n').trim();

        const item = {
          id,
          uid: null,
          messageId: m.internetMessageId || '',
          from,
          to: to || state.accountEmail || '',
          subject: m.subject || '(no subject)',
          date: m.receivedDateTime ? new Date(m.receivedDateTime).toISOString() : new Date().toISOString(),
          snippet: (m.bodyPreview || bodyText).replace(/\s+/g, ' ').slice(0, 260),
          body: bodyText.slice(0, 12_000),
          unread: !m.isRead,
          source: 'microsoft365',
          account: state.accountEmail || 'Microsoft 365',
          triaged: false,
          notified: false,
          receivedAt: new Date().toISOString(),
        };
        fetchedMsgs.push(item);
        next.items.unshift(item);
      }
      next.seenIds = Array.from(seenSet).slice(-500);
      next.items = next.items.slice(0, 150);
      next.lastSyncAt = new Date().toISOString();
      return next;
    });

    await updateJson(MS_FILE, EMPTY_MS, (cur) => ({
      ...EMPTY_MS,
      ...(cur || {}),
      lastSyncAt: new Date().toISOString(),
      lastError: null,
    }));

    if (fetchedMsgs.length) {
      await logActivity({
        kind: 'email',
        title: `Synced ${fetchedMsgs.length} new email(s) via Microsoft 365`,
        detail: fetchedMsgs.map((m) => `${m.from}: ${m.subject}`).join(' | ').slice(0, 400),
      });
    }
    return { ok: true, configured: true, fetched: fetchedMsgs.length, newEmails: fetchedMsgs };
  } catch (err) {
    const msg = String(err?.message || err);
    await updateJson(MS_FILE, EMPTY_MS, (cur) => ({
      ...EMPTY_MS,
      ...(cur || {}),
      lastSyncAt: new Date().toISOString(),
      lastError: msg,
    }));
    await logActivity({ kind: 'email', level: 'error', title: 'Microsoft 365 sync failed', detail: msg });
    return { ok: false, configured: true, error: msg, fetched: 0, newEmails: [] };
  }
}

export async function sendMs365Mail({ to, subject, body }) {
  const token = await getValidAccessToken();
  const recipients = String(to)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((addr) => {
      const m = addr.match(/<([^>]+)>/);
      return { emailAddress: { address: m ? m[1] : addr } };
    });
  const resp = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: String(subject || '(no subject)'),
        body: { contentType: 'Text', content: String(body || '') },
        toRecipients: recipients,
      },
      saveToSentItems: true,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    const t = (await resp.text().catch(() => '')).slice(0, 300);
    throw new Error(`Microsoft Graph sendMail HTTP ${resp.status}: ${t}`);
  }
  const s = await getMs365State();
  return { ok: true, provider: 'microsoft365', from: s.accountEmail, to: recipients.map((r) => r.emailAddress.address), subject };
}

// Zero-dependency Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291).
// Lets Pond alert phones/desktops even when the app is closed (iOS 16.4+ home-screen PWA, Chrome, Edge, Firefox).
import crypto from 'node:crypto';
import { readJson, updateJson, logActivity } from './storage.js';
import { CONFIG } from './config.js';

const FILE = 'push.json';
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s || ''), 'base64url');

// ---------- VAPID keys (generated once, persisted in data/push.json) ----------
let vapidCache = null;
export async function getVapid() {
  if (vapidCache) return vapidCache;
  let store = await readJson(FILE, {});
  if (!store.vapid?.publicKey || !store.vapid?.privateJwk) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pubJwk = publicKey.export({ format: 'jwk' });
    const vapid = {
      publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(pubJwk.x), fromB64u(pubJwk.y)])),
      privateJwk: privateKey.export({ format: 'jwk' }),
      createdAt: new Date().toISOString(),
    };
    store = await updateJson(FILE, {}, (s) => {
      const obj = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
      if (!obj.vapid?.publicKey) obj.vapid = vapid; // another caller may have won the race
      obj.subscriptions = Array.isArray(obj.subscriptions) ? obj.subscriptions : [];
      return obj;
    });
    if (!store?.vapid) store = await readJson(FILE, {});
  }
  vapidCache = {
    publicKey: store.vapid.publicKey,
    privateKey: crypto.createPrivateKey({ key: store.vapid.privateJwk, format: 'jwk' }),
  };
  return vapidCache;
}

function vapidSubject() {
  const explicit = process.env.PUSH_CONTACT || process.env.OPEN_DOTS_PUSH_CONTACT || '';
  if (explicit) return /^(mailto:|https:)/.test(explicit) ? explicit : `mailto:${explicit}`;
  const user = CONFIG.email?.imapUser || CONFIG.email?.smtpUser || '';
  // Apple rejects obviously bogus subjects like @localhost, so fall back to a well-formed address.
  return `mailto:${user.includes('@') ? user : 'pond-agent@example.com'}`;
}

const jwtCache = new Map(); // audience -> { token, exp }
async function vapidAuthHeader(endpoint) {
  const { publicKey, privateKey } = await getVapid();
  const aud = new URL(endpoint).origin;
  const now = Math.floor(Date.now() / 1000);
  let cached = jwtCache.get(aud);
  if (!cached || cached.exp - now < 600) {
    const exp = now + 12 * 3600;
    const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64u(JSON.stringify({ aud, exp, sub: vapidSubject() }));
    const unsigned = `${header}.${claims}`;
    const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' });
    cached = { token: `${unsigned}.${b64u(sig)}`, exp };
    jwtCache.set(aud, cached);
  }
  return `vapid t=${cached.token}, k=${publicKey}`;
}

// ---------- RFC 8291 payload encryption ----------
export function encryptPayload(payload, p256dhB64u, authB64u) {
  const uaPublic = fromB64u(p256dhB64u);
  const authSecret = fromB64u(authB64u);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('Invalid subscription keys');

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(); // 65-byte uncompressed
  const shared = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const plaintext = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 0x02 = last record, no padding
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ciphertext]);
}

// ---------- Subscriptions ----------
async function loadStore() {
  const s = await readJson(FILE, {});
  return { ...s, subscriptions: Array.isArray(s.subscriptions) ? s.subscriptions : [] };
}

export async function listSubscriptions() {
  return (await loadStore()).subscriptions;
}

export async function saveSubscription({ subscription, muted = false, label = '', origin = '' } = {}) {
  const endpoint = subscription?.endpoint;
  const keys = subscription?.keys || {};
  if (!endpoint || !/^https:\/\//.test(endpoint) || !keys.p256dh || !keys.auth) throw new Error('Invalid push subscription');
  const now = new Date().toISOString();
  await getVapid();
  await updateJson(FILE, {}, (s) => {
    const obj = s && typeof s === 'object' ? s : {};
    const subs = Array.isArray(obj.subscriptions) ? obj.subscriptions : [];
    const existing = subs.find((x) => x.endpoint === endpoint);
    if (existing) {
      Object.assign(existing, { keys: { p256dh: keys.p256dh, auth: keys.auth }, origin: String(origin || existing.origin || '').slice(0, 200), muted: Boolean(muted), label: String(label || existing.label || '').slice(0, 80), updatedAt: now, failures: 0 });
    } else {
      subs.push({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, origin: String(origin || '').slice(0, 200), muted: Boolean(muted), label: String(label || '').slice(0, 80), createdAt: now, updatedAt: now, failures: 0 });
    }
    obj.subscriptions = subs.slice(-30);
    return obj;
  });
  return { ok: true };
}

export async function removeSubscription(endpoint) {
  await updateJson(FILE, {}, (s) => {
    const obj = s && typeof s === 'object' ? s : {};
    obj.subscriptions = (Array.isArray(obj.subscriptions) ? obj.subscriptions : []).filter((x) => x.endpoint !== endpoint);
    return obj;
  });
}

// ---------- Sending ----------
const URGENCY = { low: 'low', normal: 'normal', high: 'high', critical: 'high' };

export async function sendPush(sub, data, { ttl = 24 * 3600, urgency = 'normal', topic = null } = {}) {
  const body = encryptPayload(JSON.stringify(data), sub.keys.p256dh, sub.keys.auth);
  const headers = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(body.length),
    TTL: String(ttl),
    Urgency: URGENCY[urgency] || 'normal',
    Authorization: await vapidAuthHeader(sub.endpoint),
  };
  if (topic) headers.Topic = String(topic).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const resp = await fetch(sub.endpoint, { method: 'POST', headers, body, signal: ac.signal });
    const text = resp.ok ? '' : (await resp.text().catch(() => '')).slice(0, 200);
    return { status: resp.status, ok: resp.ok, text };
  } finally {
    clearTimeout(timer);
  }
}

// Deliver a Pond notification entry to every subscribed device. Never throws.
export async function pushToAllDevices(entry) {
  let subs;
  try { subs = await listSubscriptions(); } catch { return []; }
  if (!subs.length) return [];
  const payload = {
    id: entry.id,
    title: entry.title || CONFIG.assistantName,
    body: String(entry.body || '').slice(0, 1500),
    urgency: entry.urgency || 'normal',
    category: entry.category || 'system',
    sessionId: entry.sessionId || null,
    tag: entry.tag || `pond-${entry.id}`,
    ts: entry.ts,
  };
  const results = await Promise.all(subs.filter((s) => !s.muted).map(async (sub) => {
    try {
      const r = await sendPush(sub, payload, { urgency: payload.urgency, ttl: entry.category === 'reminder' ? 3600 : 24 * 3600 });
      return { sub, ...r };
    } catch (err) {
      return { sub, ok: false, status: 0, text: String(err?.message || err) };
    }
  }));

  const gone = results.filter((r) => r.status === 404 || r.status === 410).map((r) => r.sub.endpoint);
  const failed = results.filter((r) => !r.ok && r.status !== 404 && r.status !== 410);
  const okEndpoints = new Set(results.filter((r) => r.ok).map((r) => r.sub.endpoint));
  if (gone.length || failed.length || okEndpoints.size) {
    await updateJson(FILE, {}, (s) => {
      const obj = s && typeof s === 'object' ? s : {};
      let list = Array.isArray(obj.subscriptions) ? obj.subscriptions : [];
      list = list.filter((x) => !gone.includes(x.endpoint));
      for (const x of list) {
        if (okEndpoints.has(x.endpoint)) { x.failures = 0; x.lastOkAt = new Date().toISOString(); }
        const f = failed.find((r) => r.sub.endpoint === x.endpoint);
        if (f) { x.failures = (x.failures || 0) + 1; x.lastError = `${f.status} ${f.text}`.trim(); }
      }
      obj.subscriptions = list.filter((x) => (x.failures || 0) < 20); // drop subscriptions that keep failing
      return obj;
    }).catch(() => {});
  }
  for (const f of failed) {
    logActivity({ kind: 'system', level: 'warn', title: 'Web Push delivery failed', detail: `${new URL(f.sub.endpoint).host}: ${f.status} ${f.text}` }).catch(() => {});
  }
  return results.map((r) => ({ host: new URL(r.sub.endpoint).host, label: r.sub.label, status: r.status, ok: r.ok }));
}

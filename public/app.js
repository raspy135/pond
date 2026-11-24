// Pond — frontend logic: daily chief-of-staff UI, first-class Browser Notifications, Email Triage, Sentinel Approvals & Agent Hub.
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const messagesEl = $('#messages');

// ---------- Routines ----------
const pendingJobRuns = new Set(); // clicked ▶, server hasn't reported it running yet
// Strip under the top bar while routines run — visible on phones too (no sidebar there).
let runningJobsInfo = []; // [{ id, name, startedAt }]
function renderActivityStrip() {
  const strip = $('#activityStrip');
  if (!strip) return;
  if (!runningJobsInfo.length) { strip.hidden = true; return; }
  const first = runningJobsInfo[0];
  const secs = Math.max(0, Math.floor((Date.now() - (first.startedAt || Date.now())) / 1000));
  const t = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  $('#activityText').textContent = runningJobsInfo.length > 1 ? `${runningJobsInfo.length} routines running · ${t}` : `Running "${first.name}" · ${t}`;
  strip.hidden = false;
}
setInterval(() => { if (runningJobsInfo.length) renderActivityStrip(); }, 1000);
// "0 7 * * *" → "Daily 7:00", "30 8 * * 1-5" → "Weekdays 8:30"; anything else stays as written
function cronLabel(expr) {
  const m = String(expr).trim().match(/^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|0,6|6,0)$/);
  if (!m) return String(expr);
  const time = `${Number(m[2])}:${String(m[1]).padStart(2, '0')}`;
  return `${m[3] === '*' ? 'Daily' : m[3] === '1-5' ? 'Weekdays' : 'Weekends'} ${time}`;
}

// ---------- Scrolling: follow new output only while the reader is at the bottom ----------
// Scrolling up (to re-read while Pond is thinking or writing) stops the auto-follow; the ↓ button
// or scrolling back down resumes it.
let stickToBottom = true;
function scrollToLatest(force = false) {
  if (force) stickToBottom = true;
  if (stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  updateJumpBtn();
}
function updateJumpBtn() {
  const btn = document.getElementById('jumpLatestBtn');
  if (!btn) return;
  const away = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight > 80;
  btn.hidden = !away;
  const composer = document.getElementById('composer');
  if (composer) btn.style.bottom = `${composer.offsetHeight + 14}px`;
}
messagesEl.addEventListener('scroll', () => {
  stickToBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  updateJumpBtn();
}, { passive: true });
const input = $('#input');
const composer = $('#composer');
const sendBtn = $('#sendBtn');
const toastEl = $('#toast');

let history = [];
let busy = false;
let assistantName = 'Pond';
let currentSessionId = null;
// Each window (tab / installed app) shows its own chat; other windows and devices never switch it.
// Remembered per tab, so a reload stays on the same chat.
const SESSION_KEY = 'pond_window_session';
try { currentSessionId = sessionStorage.getItem(SESSION_KEY) || null; } catch { /* storage off */ }
function setCurrentSession(id) {
  currentSessionId = id || null;
  try { if (id) sessionStorage.setItem(SESSION_KEY, id); else sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}
const chatQs = () => (currentSessionId ? `?session=${encodeURIComponent(currentSessionId)}` : '');
let lastRenderedSessionKey = '';
// What the chat on screen was drawn from: `count` saved messages of `sessionId`, plus (liveTail) a reply that was
// streamed in live after them. When that reply is saved, the saved copy is adopted without redrawing the chat.
let renderedConv = { sessionId: null, count: 0, liveTail: false, expectUser: false, liveBody: null, finishedAt: 0 };
let activeRequestId = null;
// Cross-device sync state
let eventSource = null;          // current EventSource
let lastSseAt = 0;               // last time ANY SSE data (incl. heartbeat) arrived
let lastSyncRev = null;          // server sync revision we last saw
let lastSessionsDataKey = '';    // fingerprint of the last rendered chat list
let lastStreamAt = 0;            // last time bytes arrived on the /api/chat stream
let streamStalled = false;       // we aborted a hung stream ourselves (not the user)
const SSE_STALE_MS = 45_000;     // server heartbeats every 15s
const STREAM_STALL_MS = 45_000;  // server sends stream keepalives every 15s
const SYNC_INTERVAL_MS = 10_000;
let lastNotifSeq = Number(localStorage.getItem('pond_last_notif_seq') || 0);
let unreadNotifCount = 0;
let swRegistration = null;
const bubbleByRequest = new Map(); // requestId -> assistant body element (for live plugin footers)
let modelInputTypes = ['text'];
let appliedPaletteKey = '';
let uiState = {};            // server ui settings (palette, custom avatar)
let appliedAvatarKey = null; // from active LLM profile
let pendingImages = [];          // [{ dataUrl }] waiting in the composer
let pushActive = false; // this device receives OS notifications via Web Push (so skip duplicate SSE popups)
const clientId = crypto.randomUUID ? crypto.randomUUID() : `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// Preferences stored locally per browser
const prefs = {
  get sound() { return localStorage.getItem('pond_sound') !== 'false'; },
  set sound(v) { localStorage.setItem('pond_sound', String(Boolean(v))); },
  get mute() { return localStorage.getItem('pond_mute') === 'true'; },
  set mute(v) { localStorage.setItem('pond_mute', String(Boolean(v))); },
  get theme() { return localStorage.getItem('pond_theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); },
  set theme(v) { localStorage.setItem('pond_theme', v); },
  get look() { return localStorage.getItem('pond_look') || 'plate'; },
  get emoji() { return localStorage.getItem('pond_emoji') || 'ink'; },
  set emoji(v) { localStorage.setItem('pond_emoji', v); },
  set look(v) { localStorage.setItem('pond_look', v); },
};

const icon = (name, size = 15, cls = '') => (window.flatIcon ? window.flatIcon(name, size, cls) : '');

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelectorAll('.artifact iframe').forEach((f) => { try { f.contentWindow?.postMessage({ pondTheme: theme }, '*'); } catch { /* ignore */ } });
  prefs.theme = theme;
  syncThemeColor();
  const tBtn = $('#themeBtn');
  if (tBtn) tBtn.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon', 15);
}
// Look = overall style ("plate": TideLM-style serif plate; "classic": the original). Per device, like the theme.
function applyLook(look) {
  const v = look === 'classic' ? 'classic' : 'plate';
  document.documentElement.setAttribute('data-look', v);
  prefs.look = v;
  syncThemeColor();
}
function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  meta.setAttribute('content', document.documentElement.getAttribute('data-look') === 'plate' && bg ? bg : (prefs.theme === 'dark' ? '#17171f' : '#ffffff'));
}
if (window.hydrateIcons) window.hydrateIcons();
applyLook(prefs.look);
applyTheme(prefs.theme);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 4200);
}

// ---------- Synthesized Notification Chime (Zero external audio files!) ----------
function playChime(urgency = 'normal') {
  if (!prefs.sound || prefs.mute) return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const notes = urgency === 'critical' ? [880, 1174.66, 1318.5] : urgency === 'high' ? [659.25, 987.77] : [587.33, 783.99];
    let t = ctx.currentTime;
    for (const freq of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.exponentialRampToValueAtTime(0.11, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.24);
      t += 0.11;
    }
    setTimeout(() => ctx.close().catch(() => {}), 900);
  } catch { /* audio autoplay blocked before first click */ }
}

// ---------- First-Class Browser Notifications Manager ----------
function updateTabBadge(count) {
  unreadNotifCount = Math.max(0, Number(count) || 0);
  const badge = $('#notifBadge');
  badge.textContent = unreadNotifCount > 99 ? '99+' : String(unreadNotifCount);
  badge.hidden = unreadNotifCount === 0;
  document.title = unreadNotifCount > 0 ? `(${unreadNotifCount}) ${assistantName}` : `${assistantName} — Personal AI agent`;
  if ('setAppBadge' in navigator) {
    if (unreadNotifCount > 0) navigator.setAppBadge(unreadNotifCount).catch(() => {});
    else navigator.clearAppBadge?.().catch(() => {});
  }
}

function syncNotifPermissionUI() {
  const supported = 'Notification' in window;
  const perm = supported ? Notification.permission : 'unsupported';
  const label = $('#notifPermLabel');
  const reqBtn = $('#reqNotifBtn');
  const banner = $('#notifBanner');
  const bell = $('#notifBtn');

  bell.classList.toggle('needs-perm', perm === 'default');

  if (!supported) {
    label.innerHTML = `${icon('ban', 14)}<span>Browser notifications not supported here</span>`;
    reqBtn.hidden = true;
    banner.hidden = true;
  } else if (perm === 'granted') {
    label.innerHTML = `${icon('check-circle', 14, 'icon-ok')}<span>Browser notifications enabled</span>`;
    reqBtn.hidden = true;
    banner.hidden = true;
  } else if (perm === 'denied') {
    label.innerHTML = `${icon('ban', 14, 'icon-danger')}<span>Blocked in browser site settings (allow via address bar)</span>`;
    reqBtn.hidden = true;
    banner.hidden = true;
  } else {
    label.innerHTML = `${icon('bell', 14)}<span>Click Allow to enable desktop notifications</span>`;
    reqBtn.hidden = false;
    banner.hidden = sessionStorage.getItem('pond_banner_dismissed') === '1';
  }
}

async function requestBrowserNotifPermission() {
  if (!('Notification' in window)) {
    showToast('This browser does not support desktop notifications.');
    return 'unsupported';
  }
  const result = await Notification.requestPermission();
  syncNotifPermissionUI();
  if (result === 'granted') {
    showToast('Desktop notifications enabled!');
    await fireDesktopNotification({
      title: `${assistantName} Notifications Ready`,
      body: 'You will get instant alerts here for important emails, upcoming events, reminders, and proactive updates.',
      urgency: 'normal',
      tag: 'pond-welcome-notif',
    });
    ensurePushSubscription();
  } else if (result === 'denied') {
    showToast('Notifications were blocked. You can re-enable them in browser site settings.');
  }
  return result;
}

// ---------- Web Push (alerts while the app is closed) ----------
function urlB64ToUint8Array(s) {
  const b64 = (s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function sameKey(a, b) {
  if (!a) return true; // some browsers don't expose it; assume unchanged
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone;
  return `${os} · ${br}${standalone ? ' (app)' : ''}`;
}
function renderPushStatus(result) {
  const label = $('#pushStatusLabel');
  const btn = $('#testPushBtn');
  if (!label) return;
  const reason = result?.reason || '';
  let html;
  if (result?.ok) html = `${icon('check-circle', 14, 'icon-ok')}<span>Push enabled — alerts arrive even when Pond is closed</span>`;
  else if (reason === 'insecure') html = `${icon('ban', 14)}<span>Push needs HTTPS (e.g. tailscale serve) or localhost</span>`;
  else if (reason === 'unsupported') {
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    html = `${icon('ban', 14)}<span>${ios ? 'On iPhone: Share → Add to Home Screen, then open Pond from there for push' : 'Push not supported in this browser'}</span>`;
  } else if (reason === 'permission') html = `${icon('bell', 14)}<span>Push off — allow notifications first</span>`;
  else html = `${icon('alert', 14, 'icon-danger')}<span>Push setup failed: ${escapeHtml(reason)}</span>`;
  label.innerHTML = html;
  if (btn) btn.hidden = !result?.ok;
}
async function ensurePushSubscription() {
  let result;
  try {
    if (!window.isSecureContext) result = { ok: false, reason: 'insecure' };
    else if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) result = { ok: false, reason: 'unsupported' };
    else if (Notification.permission !== 'granted') result = { ok: false, reason: 'permission' };
    else {
      const reg = await navigator.serviceWorker.ready;
      const cfg = await fetch('/api/push/config', { cache: 'no-store' }).then((r) => r.json());
      const key = urlB64ToUint8Array(cfg.publicKey);
      let sub = await reg.pushManager.getSubscription();
      if (sub && !sameKey(sub.options?.applicationServerKey, key)) { await sub.unsubscribe().catch(() => {}); sub = null; }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const resp = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), muted: prefs.mute, label: deviceLabel() }),
      });
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || `HTTP ${resp.status}`);
      result = { ok: true };
    }
  } catch (err) {
    console.warn('Push subscription failed', err);
    result = { ok: false, reason: String(err?.message || err) };
  }
  pushActive = Boolean(result.ok);
  renderPushStatus(result);
  return result;
}

// Re-register with the server on reconnect / foreground, so a server restart, a cleared
// subscription list or a lost write can't leave this device silently without push.
let lastPushResync = 0;
function resyncPushSubscription() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (Date.now() - lastPushResync < 30_000) return;
  lastPushResync = Date.now();
  ensurePushSubscription();
}

async function fireDesktopNotification(n) {
  if (prefs.mute || n.silent) return;
  // Real server alerts reach this device by Web Push; showing them here too would double-notify.
  if (pushActive && n.id) return;
  playChime(n.urgency || 'normal');

  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const opts = {
    body: n.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: n.tag || `pond-${n.id || Date.now()}`,
    renotify: true,
    requireInteraction: n.urgency === 'critical' || n.urgency === 'high',
    vibrate: n.urgency === 'critical' ? [180, 80, 180] : [100],
    data: {
      id: n.id,
      category: n.category,
      sessionId: n.sessionId,
      meta: n.meta || {},
    },
  };

  try {
    const reg = swRegistration || (navigator.serviceWorker ? await navigator.serviceWorker.getRegistration() : null);
    if (reg && reg.showNotification) {
      await reg.showNotification(n.title || assistantName, {
        ...opts,
        actions:
          n.category === 'approval'
            ? [{ action: 'review', title: 'Review' }, { action: 'dismiss', title: 'Dismiss' }]
            : [{ action: 'open', title: 'Open Pond' }, { action: 'dismiss', title: 'Dismiss' }],
      });
      return;
    }
  } catch { /* fallback to window.Notification */ }

  try {
    const notif = new Notification(n.title || assistantName, opts);
    notif.onclick = () => {
      window.focus();
      handleNotificationJump(opts.data);
      notif.close();
    };
  } catch (err) {
    console.warn('Notification display failed:', err);
  }
}

function handleNotificationJump(data) {
  if (!data) return;
  if (data.category === 'email') openDrawer('emailDrawer');
  else if (data.category === 'approval') renderSentinelBanner();
  else if (data.sessionId && data.sessionId !== currentSessionId) switchSession(data.sessionId); // e.g. a routine's result
  if (data.id) {
    fetch('/api/notifications/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: data.id }),
    }).catch(() => {});
  }
}

// Listen for notification clicks routed from Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'notification_clicked') {
      handleNotificationJump(event.data.data);
    }
  });
}

async function copyText(text, btn) {
  const str = String(text ?? '');
  if (!str) return;
  let ok = false;
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(str); ok = true; } catch { /* fallback below */ }
  }
  if (!ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = str;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, str.length);
      ok = document.execCommand('copy');
      ta.remove();
    } catch { ok = false; }
  }
  if (!ok) { showToast('Could not copy to clipboard'); return false; }
  if (btn) {
    const actions = btn.closest('.msg-actions');
    btn.classList.add('copied');
    actions?.classList.add('copied');
    btn.innerHTML = `${icon('check', 13)}<span>Copied</span>`;
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => {
      btn.classList.remove('copied');
      actions?.classList.remove('copied');
      btn.innerHTML = icon('copy', 13);
    }, 1500);
  }
  return true;
}

// ---------- Chat UI ----------
// ---------- HTML previews size themselves to their content (message from the sandboxed iframe) ----------
addEventListener('message', (e) => {
  const h = Number(e.data?.pondFrameHeight);
  if (!h) return;
  for (const f of document.querySelectorAll('.artifact iframe')) {
    if (f.contentWindow === e.source) { f.style.height = `${Math.max(160, Math.min(1400, h))}px`; break; }
  }
});

// ---------- Model chip: switch model profile and reasoning effort from the top bar ----------
let chatLlm = { profile: '', effort: '' }; // the model of the chat on screen (from /api/state)
const EFFORT_CHOICES = [['', 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Max']];
async function renderModelMenu() {
  const menu = $('#modelMenu');
  menu.innerHTML = '<div class="model-menu-note">Loading…</div>';
  let cfg;
  try { cfg = await fetch('/api/llm', { cache: 'no-store' }).then((r) => r.json()); } catch { menu.innerHTML = '<div class="model-menu-note">Could not load models</div>'; return; }
  // this chat's model (its own pick, else the default)
  const active = chatLlm.profile && cfg.profiles?.[chatLlm.profile] ? chatLlm.profile : cfg.activeProfile;
  const effort = chatLlm.profile ? chatLlm.effort || '' : cfg.profiles?.[active]?.reasoningEffort || '';
  const rows = Object.entries(cfg.profiles || {}).map(([key, p]) => `
    <button type="button" class="model-menu-item${key === active ? ' active' : ''}" role="menuitemradio" aria-checked="${key === active}" data-profile="${escapeHtml(key)}">
      <span class="mm-check">${key === active ? icon('check', 14) : ''}</span>
      <span class="mm-main"><span class="mm-label">${escapeHtml(p.label || key)}</span><span class="mm-sub">${escapeHtml(p.model || '')}${(p.inputTypes || []).includes('image') ? ' · vision' : ''}</span></span>
    </button>`).join('');
  const efforts = EFFORT_CHOICES.map(([v, l]) => `<button type="button" class="effort-btn${v === effort ? ' active' : ''}" data-effort="${v}">${l}</button>`).join('');
  menu.innerHTML = `<div class="model-menu-head">Model</div>${rows}
    <div class="model-menu-head">Reasoning effort</div><div class="effort-row">${efforts}</div>
    <div class="model-menu-note">For this chat (and new chats). Some models put the effort into the prompt — changing it may make the next reply re-read the chat once.</div>
    <button type="button" class="model-menu-item manage" data-manage="1"><span class="mm-check"></span><span class="mm-main"><span class="mm-label">Manage models…</span></span></button>`;
}
function closeModelMenu() { $('#modelMenu').hidden = true; $('#modelChip').setAttribute('aria-expanded', 'false'); }
$('#modelChip').addEventListener('click', async (e) => {
  e.stopPropagation();
  const menu = $('#modelMenu');
  if (!menu.hidden) return closeModelMenu();
  menu.hidden = false; $('#modelChip').setAttribute('aria-expanded', 'true');
  await renderModelMenu();
});
$('#modelMenu').addEventListener('click', async (e) => {
  e.stopPropagation();
  const item = e.target.closest('[data-profile], [data-effort], [data-manage]');
  if (!item) return;
  if (item.dataset.manage) { closeModelMenu(); openHub('llm'); return; }
  const body = item.dataset.profile !== undefined ? { profile: item.dataset.profile } : { effort: item.dataset.effort };
  const r = currentSessionId
    ? await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/llm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => ({}))
    : await fetch('/api/llm/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => ({}));
  if (r.error) { showToast(r.error); return; }
  if (r.llm) chatLlm = { profile: r.llm.profile, effort: r.llm.effort || '' };
  if (body.profile !== undefined) closeModelMenu(); else await renderModelMenu();
  refreshState();
});
document.addEventListener('click', (e) => { if (!e.target.closest?.('.model-switch')) closeModelMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModelMenu(); });

// Instant jump: a smooth scroll would chase a reply that keeps growing and never reach the bottom.
$('#jumpLatestBtn')?.addEventListener('click', () => scrollToLatest(true));

// ---------- Sidebar cards: click a long (clamped) item to show all of it ----------
document.addEventListener('click', (e) => {
  const item = e.target.closest?.('.item-list .item');
  if (!item || e.target.closest('button, a')) return;
  const text = item.firstElementChild?.firstElementChild;
  if (item.classList.contains('expanded') || (text && text.scrollHeight > text.clientHeight + 1)) item.classList.toggle('expanded');
});
// Mark clamped items (pointer cursor) when a sidebar list re-renders — watches only the sidebar lists
const markClamped = (list) => requestAnimationFrame(() => {
  for (const item of list.querySelectorAll(':scope > .item')) {
    const text = item.firstElementChild?.firstElementChild;
    item.classList.toggle('clamped', Boolean(text && text.scrollHeight > text.clientHeight + 1) || item.classList.contains('expanded'));
  }
});
for (const list of document.querySelectorAll('.item-list')) new MutationObserver(() => markClamped(list)).observe(list, { childList: true });

// ---------- 3D viewport buttons (expand / show code) ----------
document.addEventListener('click', (e) => {
  const btn = e.target.closest?.('.artifact-btn');
  if (!btn) return;
  const art = btn.closest('.artifact');
  if (btn.dataset.act === 'expand') art.classList.toggle('expanded');
  if (btn.dataset.act === 'code') { const pre = art.querySelector('.artifact-code'); if (pre) pre.hidden = !pre.hidden; }
  if (btn.dataset.act === 'copy-link') {
    e.preventDefault();
    const url = new URL(btn.dataset.url, location.href).href;
    copyText(url).then((ok) => { if (ok) showToast(`Link copied: ${url}`); else window.prompt('Copy this link:', url); });
  }
});


// ---------- Plugin UI slots ----------
function setMessageFooter(bodyEl, footers) {
  const col = bodyEl?.closest('.msg-col');
  if (!col || !footers) return;
  let el = col.querySelector(':scope > .msg-footer');
  if (!el) { el = document.createElement('div'); el.className = 'msg-footer'; col.appendChild(el); }
  const merged = { ...(JSON.parse(el.dataset.footers || '{}')), ...footers };
  el.dataset.footers = JSON.stringify(merged);
  el.textContent = Object.values(merged).filter(Boolean).join('  ·  ');
  el.hidden = !el.textContent;
}
function renderPluginStatus(items = []) {
  const el = $('#pluginStatus');
  if (!el) return;
  el.innerHTML = items.map((s) => `<div class="status-row model" title="plugin: ${escapeHtml(s.pluginId)}">${escapeHtml(s.text)}</div>`).join('');
}

// ---------- Image attachments (shown only when the active LLM profile accepts images) ----------
const visionEnabled = () => modelInputTypes.includes('image');
function appendMessageImages(bodyEl, urls) {
  if (!bodyEl || !urls?.length) return;
  const wrap = document.createElement('div');
  wrap.className = 'msg-images';
  for (const u of urls) {
    const a = document.createElement('a');
    a.href = u; a.target = '_blank'; a.rel = 'noopener';
    const img = document.createElement('img');
    img.src = u; img.loading = 'lazy'; img.alt = 'attached image';
    a.appendChild(img);
    wrap.appendChild(a);
  }
  const bubble = bodyEl.closest('.bubble') || bodyEl.parentElement;
  if (!String(bodyEl.dataset.rawText || '').trim()) bodyEl.hidden = true; // image-only message
  bubble.insertBefore(wrap, bodyEl.hidden ? bodyEl : bodyEl.nextSibling);
}
function renderAttachStrip() {
  const strip = $('#attachStrip');
  strip.innerHTML = '';
  strip.hidden = !pendingImages.length;
  pendingImages.forEach((p, i) => {
    const t = document.createElement('div');
    t.className = 'attach-thumb';
    t.innerHTML = `<img src="${p.dataUrl}" alt="" /><button type="button" aria-label="Remove">×</button>`;
    t.querySelector('button').onclick = () => { pendingImages.splice(i, 1); renderAttachStrip(); };
    strip.appendChild(t);
  });
}
function updateAttachUi() {
  $('#attachBtn').hidden = !visionEnabled();
  if (!visionEnabled() && pendingImages.length) { pendingImages = []; renderAttachStrip(); }
}
// Downscale to keep requests small and vision-token cost sane (long side <= 1600px, JPEG).
function fileToDataUrl(file, maxSide = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); // flatten transparency for JPEG
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Can't read ${file.name || 'image'}`)); };
    img.src = url;
  });
}
async function addImageFiles(files) {
  const imgs = [...(files || [])].filter((f) => f && f.type && f.type.startsWith('image/'));
  if (!imgs.length) return false;
  if (!visionEnabled()) {
    showToast('The active model profile does not accept images. Enable "Image (vision)" in Agent Hub → LLM Engine.');
    return true;
  }
  for (const f of imgs) {
    if (pendingImages.length >= 6) { showToast('Up to 6 images per message.'); break; }
    try { pendingImages.push({ dataUrl: await fileToDataUrl(f) }); } catch (err) { showToast(String(err.message || err)); }
  }
  renderAttachStrip();
  return true;
}

// ---------- Mascot moods (layered ink-splash slime, see public/mascot.js) ----------
function setMood(rowOrEl, mood) {
  const row = rowOrEl?.closest ? rowOrEl.closest('.msg-row') : null;
  const m = row?.querySelector('.avatar .pond-mascot');
  if (!m || !window.PondMascot) return;
  window.PondMascot.setMood(m, mood);
  row.dataset.mood = mood;
}
// Only the newest assistant mascot runs idle animations (blink, sway, float) — keeps CPU low.
function makeAliveMascot(m) {
  document.querySelectorAll('.pond-mascot.pm-alive').forEach((e) => { if (e !== m) e.classList.remove('pm-alive'); });
  m.classList.add('pm-alive');
}

function markStopped(bodyEl) {
  const row = bodyEl?.closest('.msg-row');
  if (!row || row.classList.contains('stopped')) return;
  row.classList.add('stopped');
  const note = document.createElement('div');
  note.className = 'stopped-note';
  note.textContent = 'Stopped · not sent to Pond';
  row.querySelector('.msg-col')?.appendChild(note);
}

function addMessage(role, text, { proactive = false, tag = '' } = {}) {
  const row = document.createElement('div');
  row.className = `msg-row ${role}`;
  if (role === 'assistant') {
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    if (window.PondMascot) {
      const mood = proactive ? 'wow' : 'happy';
      const m = uiState.avatarMode === 'image' && uiState.avatarExt
        ? window.PondMascot.createImage(`/appearance/avatar?v=${uiState.avatarVersion || 0}`, mood, { circle: uiState.avatarCircle !== false })
        : (uiState.avatarMode === 'icosa' || !uiState.avatarMode) && window.PondMascot.createIcosa
          ? window.PondMascot.createIcosa(mood)
          : window.PondMascot.create(mood, { compact: true });
      avatar.appendChild(m);
      makeAliveMascot(m);
    } else {
      avatar.textContent = (assistantName[0] || 'P').toUpperCase();
    }
    avatar.title = assistantName;
    row.appendChild(avatar);
    row.dataset.mood = proactive ? 'wow' : 'happy';
  }
  const col = document.createElement('div');
  col.className = 'msg-col';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (proactive) {
    const t = document.createElement('span');
    t.className = 'proactive-tag';
    t.textContent = tag || `${assistantName} checked in`;
    bubble.appendChild(t);
  }
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = text;
  body.dataset.rawText = text || '';
  bubble.appendChild(body);
  col.appendChild(bubble);

  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'msg-copy-btn';
  copyBtn.title = 'Copy message';
  copyBtn.setAttribute('aria-label', 'Copy message');
  copyBtn.innerHTML = icon('copy', 13);
  copyBtn.onclick = () => copyText(body.dataset.rawText || body.textContent || '', copyBtn);
  actions.appendChild(copyBtn);
  if (proactive && role === 'assistant') {
    // Talk about a check-in / alert in its own chat, so replying doesn't pull the current conversation off course.
    const br = document.createElement('button');
    br.type = 'button';
    br.className = 'msg-copy-btn msg-branch-btn';
    br.title = 'Continue in a new chat';
    br.setAttribute('aria-label', 'Continue in a new chat');
    br.innerHTML = `${icon('branch', 13)}<span>New chat</span>`;
    br.onclick = () => continueInNewChat(body.dataset.rawText || body.textContent || '', tag);
    actions.appendChild(br);
  }
  col.appendChild(actions);

  row.appendChild(col);
  messagesEl.appendChild(row);
  scrollToLatest(role === 'user'); // your own message always brings you to the bottom
  return body;
}

function renderAssistantBody(bodyEl, text) {
  bodyEl.classList.remove('streaming');
  bodyEl.dataset.rawText = text || '';
  bodyEl.innerHTML = window.renderMarkdown ? window.renderMarkdown(text) : escapeHtml(text);
  inkEmoji(bodyEl);
}

// "Ink" emoji (Plate look): common emoji become Pond's thin line icons in the text colour; the rest are drawn
// as quiet monochrome symbols. Copying a message still copies the real emoji. Agent Hub → Appearance → Emoji.
const EMOJI_ICON = {
  '✅': 'check', '✔': 'check', '☑': 'check', '❌': 'close', '✖': 'close', '❎': 'close',
  '⚠': 'alert', '🚨': 'alert', '❗': 'alert', '‼': 'alert', '❓': 'alert',
  '📧': 'mail', '✉': 'mail', '📨': 'mail', '📩': 'mail', '📬': 'mail', '📥': 'mail', '📤': 'send',
  '📅': 'calendar', '📆': 'calendar', '🗓': 'calendar', '⏰': 'clock', '⏱': 'clock', '🕐': 'clock', '⌛': 'clock', '⏳': 'clock',
  '💡': 'bulb', '🔔': 'bell', '🔗': 'link', '📄': 'file', '📝': 'file', '📃': 'file', '📎': 'file', '📋': 'list', '🗒': 'list',
  '🌐': 'globe', '⚡': 'zap', '✨': 'sparkles', '🎉': 'sparkles', '👋': 'handwave', '🔄': 'refresh', '🔁': 'refresh',
  '▶': 'play', '🗑': 'trash', '👀': 'eye', '👁': 'eye', '🛡': 'shield', '🔒': 'shield', '🔐': 'shield', '🔌': 'plug',
  '📊': 'activity', '📈': 'activity', '📉': 'activity', '☀': 'sun', '🌞': 'sun', '🌙': 'moon', '🚫': 'ban', '⛔': 'ban',
  '💻': 'terminal', '🖥': 'terminal', '🧠': 'cpu', '🤖': 'cpu', '🚀': 'send', '👉': 'send', '➡': 'send',
};
const EMOJI_RE = /\p{Extended_Pictographic}(?:\uFE0F|\u20E3|[\u{1F3FB}-\u{1F3FF}]|\u200D\p{Extended_Pictographic}\uFE0F?)*/gu;
function inkEmoji(root) {
  if (document.documentElement.getAttribute('data-look') !== 'plate' || prefs.emoji === 'color' || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('code, pre, .katex, .emo') || !/\p{Extended_Pictographic}/u.test(n.nodeValue) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(EMOJI_RE)) {
      const ch = m[0];
      if (/^[©®™]/.test(ch)) continue;
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const span = document.createElement('span');
      const name = EMOJI_ICON[ch.replace(/[\uFE0F\u{1F3FB}-\u{1F3FF}]/gu, '')];
      span.className = name ? 'emo emo-icon' : 'emo emo-mono';
      span.dataset.emoji = ch;
      if (name) { span.innerHTML = icon(name, 15); span.setAttribute('role', 'img'); span.setAttribute('aria-label', ch); }
      else span.textContent = ch;
      frag.appendChild(span);
      last = m.index + ch.length;
    }
    if (!last) continue;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.replaceWith(frag);
  }
}
// copying text keeps the real emoji
document.addEventListener('copy', (e) => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.anchorNode?.parentElement?.closest('.msg-body')) return;
  const box = document.createElement('div');
  box.appendChild(sel.getRangeAt(0).cloneContents());
  if (!box.querySelector('.emo-icon')) return;
  box.querySelectorAll('.emo-icon').forEach((s) => s.replaceWith(s.dataset.emoji || ''));
  e.clipboardData.setData('text/plain', box.textContent);
  e.preventDefault();
});

function addThoughtBlock(bubbleEl, text, { open = false, label = 'Thought' } = {}) {
  const details = document.createElement('details');
  details.className = 'thought-trace';
  if (open) details.open = true;
  details.innerHTML = `<summary>${icon('bulb', 12)}<span class="thought-label">${escapeHtml(label)}</span></summary><div class="thought-body"></div>`;
  details.querySelector('.thought-body').textContent = text || '';
  const bodyEl = bubbleEl.querySelector('.msg-body');
  if (bodyEl) bubbleEl.insertBefore(details, bodyEl);
  else bubbleEl.appendChild(details);
  return details;
}

function createWorkingIndicator(label = 'Thinking…') {
  const el = document.createElement('div');
  el.className = 'working-indicator';
  el.innerHTML = `<span class="working-dots"><span></span><span></span><span></span></span><span class="working-label">${escapeHtml(label)}</span>`;
  return el;
}

function addToolTrace(name, args, result) {
  const details = document.createElement('details');
  details.className = 'tool-trace';
  const argStr = args && Object.keys(args).length ? JSON.stringify(args) : '';
  const resStr = typeof result === 'string' ? result : JSON.stringify(result);
  const shortSummary = `${name}(${argStr.slice(0, 80)}${argStr.length > 80 ? '…' : ''})`;
  details.innerHTML = `
    <summary>${icon('sliders', 12)}<span class="tool-trace-label">${escapeHtml(shortSummary)}</span></summary>
    <div class="tool-trace-detail">${escapeHtml(argStr ? `args: ${argStr}\n` : '')}result: ${escapeHtml(resStr.length > 800 ? resStr.slice(0, 800) + '…' : resStr)}</div>
  `;
  messagesEl.appendChild(details);
  scrollToLatest();
}

let activeChatAbort = null;

function setBusy(v) {
  busy = v;
  if (v) {
    sendBtn.disabled = false;
    sendBtn.classList.add('is-stop');
    sendBtn.title = 'Stop generation';
    sendBtn.setAttribute('aria-label', 'Stop generation');
    sendBtn.innerHTML = icon('stop', 18);
  } else {
    activeChatAbort = null;
    sendBtn.disabled = false;
    sendBtn.classList.remove('is-stop');
    sendBtn.title = 'Send';
    sendBtn.setAttribute('aria-label', 'Send');
    sendBtn.innerHTML = icon('send', 19);
  }
}

// ---------- Running turns ----------
// A reply in progress belongs to its chat on the server (lib/turns.js), not to this tab. This view either
// started it (sendMessage) or attached to it (after switching chats, reopening the app, or from another device).
// Leaving the chat only *detaches* the view — the server keeps working and the reply is saved to its chat.
let attachedTurn = null; // { requestId, sessionId, view, abort, detached, stopRequested }

function createTurnView({ startedAt = Date.now() } = {}) {
  const bubbleBody = addMessage('assistant', '');
  const msgRow = bubbleBody.closest('.msg-row');
  const bubbleEl = bubbleBody.closest('.bubble');
  msgRow.classList.add('is-working');
  setMood(msgRow, 'thinking');
  const workingEl = createWorkingIndicator('Thinking…');
  bubbleEl.insertBefore(workingEl, bubbleBody);
  let baseWorkLabel = 'Thinking…';
  const refreshWorkText = () => {
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    const lbl = workingEl.querySelector('.working-label');
    if (lbl) lbl.textContent = secs >= 2 ? `${baseWorkLabel} (${secs}s)` : baseWorkLabel;
  };
  const setWorkingLabel = (txt) => { baseWorkLabel = txt; refreshWorkText(); };
  const workTicker = setInterval(refreshWorkText, 1000);
  bubbleBody.classList.add('streaming');

  const v = { bubbleBody, msgRow, acc: '', thoughtAcc: '', thoughtEl: null, hadToolSinceText: false, finished: false };
  const follow = () => { if (msgRow.isConnected) scrollToLatest(); };
  v.handle = (payload) => {
    if (v.finished) return;
    if (payload.type === 'reasoning') {
      v.thoughtAcc += payload.text;
      if (!v.thoughtEl) v.thoughtEl = addThoughtBlock(bubbleEl, v.thoughtAcc, { open: false, label: 'Thinking…' });
      else v.thoughtEl.querySelector('.thought-body').textContent = v.thoughtAcc;
      setWorkingLabel('Thinking…');
      follow();
    } else if (payload.type === 'tool_start') {
      workingEl.hidden = false;
      setWorkingLabel(`Working · ${payload.name}…`);
      follow();
    } else if (payload.type === 'token') {
      workingEl.hidden = true;
      if (v.thoughtEl) v.thoughtEl.querySelector('.thought-label').textContent = 'Thought';
      if (v.hadToolSinceText && v.acc && !v.acc.endsWith('\n')) v.acc += '\n\n';
      v.hadToolSinceText = false;
      v.acc += payload.text;
      bubbleBody.dataset.rawText = v.acc;
      // Styled as it arrives: re-render the markdown a few times a second (less often for very long replies).
      if (!v.mdTimer) {
        v.mdTimer = setTimeout(() => {
          v.mdTimer = null;
          if (v.finished) return;
          bubbleBody.classList.remove('streaming');
          bubbleBody.innerHTML = window.renderMarkdown ? window.renderMarkdown(v.acc, { streaming: true }) : escapeHtml(v.acc);
          inkEmoji(bubbleBody);
          follow();
        }, v.acc.length > 30000 ? 400 : 90);
      }
      follow();
    } else if (payload.type === 'tool') {
      if (v.acc) v.hadToolSinceText = true;
      workingEl.hidden = false;
      setWorkingLabel('Thinking…');
      if (msgRow.isConnected) addToolTrace(payload.name, payload.args, payload.result);
      refreshState();
    } else if (payload.type === 'error') {
      workingEl.remove();
      bubbleBody.innerHTML = `<span class="inline-icon-text">${icon('alert', 14)}<span>${escapeHtml(payload.message)}</span></span>`;
      msgRow.classList.add('error');
    }
  };
  v.finish = ({ stopped = false, notice = '' } = {}) => {
    if (v.finished) return;
    v.finished = true;
    clearInterval(workTicker);
    workingEl.remove();
    msgRow.classList.remove('is-working');
    if (v.thoughtEl) v.thoughtEl.querySelector('.thought-label').textContent = 'Thought';
    if (notice) bubbleBody.innerHTML = `<span class="inline-icon-text">${icon('refresh', 14)}<span>${escapeHtml(notice)}</span></span>`;
    else if (stopped) { if (v.acc) renderAssistantBody(bubbleBody, `${v.acc}\n\n*(stopped)*`); else bubbleBody.textContent = '(stopped)'; }
    else if (v.acc) renderAssistantBody(bubbleBody, v.acc);
    else if (!msgRow.classList.contains('error')) bubbleBody.textContent = '(no response)';
    setMood(msgRow, msgRow.classList.contains('error') ? 'sad' : stopped ? 'sleepy' : 'happy');
    if (msgRow.isConnected) scrollToLatest(); // the final render can change height
  };
  return v;
}

// Read a text/event-stream response, calling onEvent(payload) for every `data:` line.
async function readSse(resp, onEvent) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    lastStreamAt = Date.now();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const evt of events) {
      const line = evt.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let payload;
      try { payload = JSON.parse(line.slice(5).trim()); } catch { continue; }
      onEvent(payload);
    }
  }
}

function takeTurn(t) { attachedTurn = t; activeChatAbort = t.abort; activeRequestId = t.requestId; streamStalled = false; lastStreamAt = Date.now(); setBusy(true); }
function releaseTurn(t) { if (attachedTurn !== t) return; attachedTurn = null; activeRequestId = null; streamStalled = false; lastStreamAt = 0; setBusy(false); }

// Stop *rendering* the running reply (switching chats / re-rendering). The server turn keeps going.
function detachTurnView() {
  const t = attachedTurn;
  if (!t) return;
  t.detached = true;
  releaseTurn(t);
  try { t.abort.abort(); } catch { /* ignore */ }
}

// Follow a turn that is already running on the server (replays progress so far, then live).
async function attachToTurn(turn) {
  if (!turn?.requestId || attachedTurn?.requestId === turn.requestId) return;
  detachTurnView();
  const t = { requestId: turn.requestId, sessionId: currentSessionId, abort: new AbortController(), detached: false, stopRequested: false };
  t.view = createTurnView({ startedAt: turn.startedAt || Date.now() });
  Object.assign(renderedConv, { liveTail: true, expectUser: false, liveBody: t.view.bubbleBody, finishedAt: 0 });
  bubbleByRequest.set(t.requestId, t.view.bubbleBody);
  takeTurn(t);
  let notice = '';
  try {
    const resp = await fetch(`/api/turns/${encodeURIComponent(t.requestId)}/stream`, { signal: t.abort.signal, cache: 'no-store' });
    await readSse(resp, (p) => { if (p.type !== 'done') t.view.handle(p); });
  } catch (err) {
    if (!t.detached && !t.stopRequested) { notice = 'Connection interrupted — syncing latest reply…'; scheduleSyncRecovery(); }
  } finally {
    if (!t.detached) {
      t.view.finish({ stopped: t.stopRequested, notice });
      renderedConv.finishedAt = Date.now();
      releaseTurn(t);
      if (t.stopRequested) { lastRenderedSessionKey = ''; renderedConv.liveTail = false; }
      setTimeout(() => loadConversation({ force: false, silent: true }).then(() => loadSessions()), 600); // adopt the saved copy (footers)
    }
  }
}

async function sendMessage(text) {
  const trimmed = text.trim();
  if ((!trimmed && !pendingImages.length) || busy) return;
  closeSlashMenu();
  const outgoingImages = pendingImages.map((p) => p.dataUrl);
  pendingImages = [];
  renderAttachStrip();
  document.body.classList.remove('sidebar-open');
  closeAllDrawers();

  appendMessageImages(addMessage('user', trimmed), outgoingImages);
  history.push({ role: 'user', content: trimmed });
  input.value = '';
  autoGrowInput();

  const requestId = crypto.randomUUID ? crypto.randomUUID() : `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const t = { requestId, sessionId: currentSessionId, abort: new AbortController(), detached: false, stopRequested: false, own: true };
  t.view = createTurnView();
  Object.assign(renderedConv, { liveTail: true, expectUser: true, liveBody: t.view.bubbleBody, finishedAt: 0 });
  bubbleByRequest.set(requestId, t.view.bubbleBody);
  if (bubbleByRequest.size > 50) bubbleByRequest.delete(bubbleByRequest.keys().next().value);
  takeTurn(t);

  let notice = '';
  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history, clientId, requestId, sessionId: currentSessionId, ...(outgoingImages.length ? { images: outgoingImages } : {}) }),
      signal: t.abort.signal,
    });
    if (!resp.ok || !resp.body) {
      const err = await resp.json().catch(() => ({}));
      t.view.handle({ type: 'error', message: err.error || `Request failed (${resp.status})` });
      if (resp.status === 409) input.value = trimmed; // chat still busy: give the text back
      return;
    }
    await readSse(resp, (p) => t.view.handle(p));
    if (t.view.acc) history.push({ role: 'assistant', content: t.view.acc });
  } catch (err) {
    if (t.detached) {
      // Left this chat (or re-rendered it): nothing to show here — the server finishes and saves the reply.
    } else if (err?.name === 'AbortError' && streamStalled) {
      notice = 'Connection stalled — syncing latest reply…'; // iOS froze the stream in the background
      scheduleSyncRecovery();
    } else if (err?.name === 'AbortError') {
      // Stopped before any reply: hand the text back so it can be edited and re-sent.
      if (t.stopRequested && !t.view.acc && !input.value.trim()) { input.value = trimmed; autoGrowInput(); }
      if (t.view.acc) history.push({ role: 'assistant', content: t.view.acc });
    } else {
      // Mobile / Tailscale drop: the server keeps going — resync (and re-attach if still running).
      notice = `Connection interrupted (${err.message || err}) — syncing latest reply…`;
      scheduleSyncRecovery();
    }
  } finally {
    if (!t.detached) { t.view.finish({ stopped: t.stopRequested, notice }); renderedConv.finishedAt = Date.now(); }
    releaseTurn(t);
    refreshState();
    if (t.stopRequested && !t.detached) { lastRenderedSessionKey = ''; renderedConv.liveTail = false; setTimeout(() => loadConversation({ force: false, silent: true }), 400); } // show it as stopped
    else if (!t.detached && !notice) setTimeout(() => loadConversation({ force: false, silent: true }), 600); // adopt the saved copy (footers)
  }
}

// ---------- State & Sidebar ----------
let latestPendingApprovals = [];

async function refreshState() {
  try {
    const resp = await fetch(`/api/state${chatQs()}`);
    const s = await resp.json();
    assistantName = s.assistantName || 'Pond';
    if (s.ui && window.PondMascot) {
      uiState = s.ui;
      const key = `${s.ui.mascotPalette}|${s.ui.mascotColor}`;
      if (key !== appliedPaletteKey) { appliedPaletteKey = key; window.PondMascot.setPalette(s.ui.mascotPalette, s.ui.mascotColor); }
      const avatarKey = `${s.ui.avatarMode}|${s.ui.avatarVersion}|${s.ui.avatarCircle}`;
      // re-render avatars when the character changes — and on first load if it isn't the default splash (the chat was drawn before settings arrived)
      if (avatarKey !== appliedAvatarKey && (appliedAvatarKey !== null || s.ui.avatarMode !== 'mascot')) loadConversation({ force: true });
      appliedAvatarKey = avatarKey;
    }
    modelInputTypes = Array.isArray(s.inputTypes) ? s.inputTypes : ['text'];
    updateAttachUi();
    updateTabBadge(s.unreadNotifications || 0);

    const keyDot = $('#keyDot');
    keyDot.className = 'dot-indicator ' + (s.keyConfigured ? 'ok' : 'bad');
    $('#keyStatus').textContent = s.keyConfigured ? 'Model connected' : 'API key missing (.env)';
    const ctxLabel = s.contextLength ? ` · ${Math.round(s.contextLength / 1000)}k` : '';
    const effortLabel = s.reasoningEffort && s.reasoningEffort !== 'default' ? ` · ${s.reasoningEffort}` : '';
    $('#modelLine').textContent = `${s.model}${ctxLabel}${effortLabel}`;
    if (s.chatLlm) chatLlm = { profile: s.chatLlm.profile || '', effort: s.chatLlm.effort || '' };
    $('#modelChipText').textContent = s.llmLabel && s.llmLabel !== 'Default' ? s.llmLabel : String(s.model || 'Model').split('/').pop();
    $('#modelChipEffort').textContent = s.reasoningEffort && s.reasoningEffort !== 'default' ? s.reasoningEffort : '';
    $('#modelChip').title = `${s.model} — switch model / reasoning effort`;
    if (s.contextLength && s.sessionTokens != null) {
      const pct = Math.min(100, Math.round((s.sessionTokens / s.contextLength) * 100));
      const usedK = (s.sessionTokens / 1000).toFixed(1);
      const maxK = Math.round(s.contextLength / 1000);
      $('#contextLine').textContent = `Context: ~${usedK}k / ${maxK}k (${pct}% · auto-compacts at 75%)`;
    }

    const aggr = (s.proactive?.aggressiveness || 'high').toUpperCase();
    $('#proactiveLine').textContent = s.proactive?.enabled
      ? `Proactive ${aggr} · every ${s.proactive.intervalMin}m`
      : 'Proactive off';
    $('#proactivePillText').textContent = s.proactive?.enabled ? `Proactive · ${aggr}` : 'Proactive off';
    $('#emailStatusLine').textContent = s.ms365Connected && s.emailConfigured
      ? `Email: M365 (${s.ms365Account || 'on'}) + IMAP · ${s.emailCount || 0}`
      : s.ms365Connected
      ? `Email: M365 (${s.ms365Account || 'connected'}) · ${s.emailCount || 0}`
      : s.emailConfigured
      ? `Email monitor ON · ${s.emailCount || 0} synced`
      : `Email: configure Gmail or M365 (${s.emailCount || 0} local)`;

    // Email badge
    const eBadge = $('#emailBadge');
    const impCount = s.importantUnreadCount || 0;
    eBadge.textContent = String(impCount);
    eBadge.hidden = impCount === 0;

    // Sentinel approvals
    latestPendingApprovals = s.pendingApprovals || [];
    const appBtn = $('#approvalsBtn');
    const appBadge = $('#approvalsBadge');
    appBtn.hidden = latestPendingApprovals.length === 0;
    appBadge.textContent = String(latestPendingApprovals.length);
    renderSentinelBanner();

    // Upcoming Calendar Events
    const evList = $('#eventList');
    const events = s.events || [];
    $('#eventCount').textContent = events.length || '';
    if (!events.length) {
      const nx = s.nextEvent;
      evList.innerHTML = nx
        ? `<div class="empty">Nothing in the next 2 weeks · <button class="link-btn" id="nextEvLink">Next: ${escapeHtml(new Date(nx.startAt).toLocaleDateString([], { month: 'short', day: 'numeric' }))} · ${escapeHtml(nx.title)}</button></div>`
        : '<div class="empty">No upcoming events</div>';
      if (nx) $('#nextEvLink').onclick = () => { document.body.classList.remove('sidebar-open'); closeAllDrawers(); $('#calDrawer').hidden = false; openCalendar(calKey(new Date(nx.startAt))); };
    } else {
      evList.innerHTML = '';
      for (const ev of events.slice(0, 6)) {
        const div = document.createElement('div');
        div.className = 'item event-item';
        const when = ev.allDay
          ? `${new Date(ev.startAt).toLocaleDateString([], { month: 'short', day: 'numeric' })} · all day`
          : new Date(ev.startAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        div.innerHTML = `<div class="ev-open" title="Open in calendar"><div>${escapeHtml(ev.title)}</div><div class="sub">${when}${ev.location ? ' · ' + escapeHtml(ev.location) : ''}</div></div>`;
        div.querySelector('.ev-open').onclick = () => { document.body.classList.remove('sidebar-open'); closeAllDrawers(); $('#calDrawer').hidden = false; openCalendar(calKey(new Date(ev.startAt))); };
        const del = document.createElement('button');
        del.innerHTML = icon('close', 13);
        del.title = 'Remove event';
        del.onclick = async () => {
          await fetch(`/api/calendar/${encodeURIComponent(ev.id)}`, { method: 'DELETE' });
          refreshState();
        };
        if (ev.source !== 'ics') div.appendChild(del); // linked-calendar events come back on the next sync
        evList.appendChild(div);
      }
    }

    // Tasks / Things To Do
    const taskList = $('#taskList');
    const tasks = s.tasks || [];
    $('#taskCount').textContent = tasks.length || '';
    if (!tasks.length) {
      taskList.innerHTML = '<div class="empty">Nothing on your list</div>';
    } else {
      taskList.innerHTML = '';
      for (const t of tasks) {
        const div = document.createElement('div');
        div.className = 'item task-item';
        const latestNote = t.progress?.length ? t.progress[t.progress.length - 1].note : (t.plan || '').split('\n')[0];
        div.innerHTML = `<div><div>${escapeHtml(t.title)}</div><div class="sub">${latestNote ? escapeHtml(latestNote.slice(0, 75)) : 'in progress'}</div></div>`;
        const done = document.createElement('button');
        done.innerHTML = icon('check', 13);
        done.title = 'Mark done';
        done.onclick = async () => {
          await fetch(`/api/tasks/${t.id}/complete`, { method: 'POST' });
          refreshState();
        };
        div.appendChild(done);
        taskList.appendChild(div);
      }
    }

    // Routines / Scheduled Jobs
    runningJobsInfo = Array.isArray(s.runningJobsInfo) ? s.runningJobsInfo : [];
    for (const id of pendingJobRuns) if (!runningJobsInfo.some((x) => x.id === id)) { const pj = (s.jobs || []).find((x) => x.id === id); if (pj) runningJobsInfo.push({ id, name: pj.name, startedAt: Date.now() }); }
    renderActivityStrip();
    const sideJobList = $('#sideJobList');
    const jobs = (s.jobs || []).filter((j) => j.enabled);
    $('#jobCount').textContent = jobs.length || '';
    if (!jobs.length) {
      sideJobList.innerHTML = '<div class="empty">No recurring routines</div>';
    } else {
      sideJobList.innerHTML = '';
      for (const j of jobs.slice(0, 5)) {
        const div = document.createElement('div');
        div.className = 'item';
        const running = (s.runningJobs || []).includes(j.id) || pendingJobRuns.has(j.id);
        const when = j.cron ? cronLabel(j.cron) : `every ${j.intervalMin}m`;
        const status = running ? '<span class="job-running">Running…</span>'
          : j.lastStatus === 'error' ? `<span class="job-err" title="${escapeHtml(j.lastOutput || '')}">· last run failed</span>`
          : j.lastRunAt && Date.now() - Date.parse(j.lastRunAt) < 10 * 60_000 ? '<span class="job-ok">· ✓ done just now</span>' : '';
        div.innerHTML = `<div><div>${escapeHtml(j.name)}</div><div class="sub">${running ? '' : escapeHtml(when) + ' '}${status}</div></div>`;
        const run = document.createElement('button');
        run.innerHTML = running ? '<span class="spinner"></span>' : icon('play', 12);
        run.title = running ? 'Running…' : 'Run now';
        run.disabled = running;
        run.onclick = async () => {
          pendingJobRuns.add(j.id);
          if (!runningJobsInfo.some((x) => x.id === j.id)) { runningJobsInfo.push({ id: j.id, name: j.name, startedAt: Date.now() }); renderActivityStrip(); }
          run.disabled = true; run.innerHTML = '<span class="spinner"></span>'; run.title = 'Running…';
          div.querySelector('.sub').innerHTML = '<span class="job-running">Running…</span>';
          await fetch(`/api/jobs/${j.id}/run`, { method: 'POST' }).catch(() => {});
          setTimeout(() => { pendingJobRuns.delete(j.id); }, 5000); // server state takes over
        };
        div.appendChild(run);
        if (j.sessionId) {
          div.classList.add('job-item');
          div.title = 'Open this routine\'s chat (every run, its steps and results)';
          div.addEventListener('click', (e) => { if (!e.target.closest('button')) { switchSession(j.sessionId); document.body.classList.remove('sidebar-open'); } });
        }
        sideJobList.appendChild(div);
      }
    }

    // Reminders
    const rList = $('#reminderList');
    const pending = (s.reminders || []).slice().sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
    $('#reminderCount').textContent = pending.length || '';
    if (!pending.length) {
      rList.innerHTML = '<div class="empty">No reminders</div>';
    } else {
      rList.innerHTML = '';
      for (const r of pending) {
        const div = document.createElement('div');
        div.className = 'item';
        const when = new Date(r.dueAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        div.innerHTML = `<div><div>${escapeHtml(r.text)}</div><div class="sub">${when}</div></div>`;
        const done = document.createElement('button');
        done.innerHTML = icon('check', 13);
        done.title = 'Mark done';
        done.onclick = async () => {
          await fetch('/api/reminders/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: r.id }),
          });
          refreshState();
        };
        div.appendChild(done);
        rList.appendChild(div);
      }
    }

    // Memory
    const memList = $('#memoryList');
    memList.innerHTML = '';
    const memories = s.memory || [];
    if (!memories.length) {
      memList.innerHTML = '<li class="empty" style="border:none;background:none;padding-left:0">Nothing remembered yet</li>';
    } else {
      for (const m of memories) {
        const fact = typeof m === 'string' ? m : m.fact;
        const id = typeof m === 'string' ? null : m.id;
        const li = document.createElement('li');
        const span = document.createElement('span');
        span.innerHTML = memLinkify(escapeHtml(fact));
        li.appendChild(span);
        if (id) {
          const del = document.createElement('button');
          del.innerHTML = icon('close', 13);
          del.title = 'Forget';
          del.onclick = async () => {
            await fetch(`/api/memory/${id}`, { method: 'DELETE' });
            refreshState();
          };
          li.appendChild(del);
        }
        memList.appendChild(li);
      }
    }
    renderMemorySide(s.memoryDocs || [], s.dream || null);
  } catch (err) {
    console.error('state refresh failed', err);
  }
}

// ---------- Sentinel Out-of-Band Approval Banner ----------
function renderSentinelBanner() {
  const banner = $('#sentinelBanner');
  if (!latestPendingApprovals.length) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  banner.hidden = false;
  banner.innerHTML = '';
  for (const ap of latestPendingApprovals) {
    const card = document.createElement('div');
    card.className = 'sentinel-card';
    card.innerHTML = `
      <div class="sentinel-card-head">
        <span class="inline-icon-text">${icon('shield', 15)}<span>Sentinel Approval Required: ${escapeHtml(ap.summary)}</span></span>
        <span class="pill high">${escapeHtml(ap.tool)} · ${escapeHtml(ap.source)}</span>
      </div>
      <div class="sentinel-card-args">${escapeHtml(JSON.stringify(ap.args, null, 2))}</div>
      <div class="sentinel-card-actions">
        <button class="btn primary sm" data-dec="approve_once">Approve Once</button>
        <button class="btn sm" data-dec="approve_session">Approve This Session</button>
        <button class="btn sm" data-dec="approve_always">Always Allow</button>
        <button class="btn danger sm" data-dec="deny">Deny</button>
      </div>
    `;
    card.querySelectorAll('button[data-dec]').forEach((btn) => {
      btn.onclick = async () => {
        await fetch(`/api/approvals/${ap.id}/decide`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision: btn.dataset.dec }),
        });
        showToast(btn.dataset.dec === 'deny' ? 'Action denied' : 'Action approved');
        refreshState();
      };
    });
    banner.appendChild(card);
  }
}

// ---------- Drawers (Notifications & Email Triage) ----------
function closeAllDrawers() {
  $('#notifDrawer').hidden = true;
  $('#emailDrawer').hidden = true;
  $('#calDrawer').hidden = true;
  $('#memDrawer').hidden = true;
}

function openDrawer(id) {
  closeAllDrawers();
  $(`#${id}`).hidden = false;
  if (id === 'notifDrawer') loadNotificationsDrawer();
  if (id === 'emailDrawer') loadEmailDrawer();
  if (id === 'calDrawer') openCalendar();
  if (id === 'memDrawer') loadMemoryDrawer();
}

// ---------- Search: chats, email, notifications ----------
const search = { timer: null, seq: 0, terms: [] };
function markTerms(text) {
  let html = escapeHtml(text);
  for (const t of search.terms) {
    if (!t) continue;
    const re = new RegExp(escapeHtml(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    html = html.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return html;
}
function setSearching(on) {
  $('#sidebar').classList.toggle('searching', on);
  $('#searchResults').hidden = !on;
}
function clearSearch() {
  $('#searchInput').value = '';
  setSearching(false);
  $('#searchResults').innerHTML = '';
}
async function runSearch() {
  const q = $('#searchInput').value.trim();
  if (!q) { setSearching(false); return; }
  const seq = ++search.seq;
  let data;
  try { data = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { cache: 'no-store' }).then((r) => r.json()); } catch { return; }
  if (seq !== search.seq) return; // a newer query is on its way
  search.terms = data.terms || [];
  setSearching(true);
  renderSearchResults(data);
}
function searchItem({ title, meta = '', snippet = '', onClick, iconName }) {
  const b = document.createElement('button');
  b.className = 'search-item';
  b.innerHTML = `<div class="search-item-top">${iconName ? icon(iconName, 12) : ''}<span class="search-item-title">${markTerms(title)}</span>${meta ? `<span class="search-item-meta">${escapeHtml(meta)}</span>` : ''}</div>${snippet ? `<div class="search-item-snippet">${markTerms(snippet)}</div>` : ''}`;
  if (!title) b.classList.add('cont'); // another match in the same chat
  b.onclick = onClick;
  return b;
}
const shortDate = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
function renderSearchResults(data) {
  const box = $('#searchResults');
  box.innerHTML = '';
  const group = (label, n) => {
    const h = document.createElement('div');
    h.className = 'side-title search-group';
    h.textContent = `${label} · ${n}`;
    box.appendChild(h);
  };
  const leave = () => { document.body.classList.remove('sidebar-open'); };
  if (data.chats?.length) {
    group('Chats', data.chats.length);
    for (const c of data.chats) {
      if (!c.matches.length) box.appendChild(searchItem({ title: c.title, meta: shortDate(c.updatedAt), iconName: 'list', onClick: () => { leave(); openChatAt(c.sessionId, null); } }));
      c.matches.forEach((m, i) => box.appendChild(searchItem({
        title: i ? '' : c.title, meta: i ? '' : shortDate(m.ts || c.updatedAt), snippet: `${m.role === 'user' ? 'You' : 'Pond'}: ${m.snippet}`, iconName: i ? '' : 'list',
        onClick: () => { leave(); openChatAt(c.sessionId, m.ts); },
      })));
    }
  }
  if (data.emails?.length) {
    group('Email', data.emails.length);
    for (const m of data.emails) box.appendChild(searchItem({ title: m.subject, meta: shortDate(m.date), snippet: `${m.from} — ${m.snippet}`, iconName: 'mail', onClick: () => { leave(); openEmailView(m.id); } }));
  }
  if (data.notifications?.length) {
    group('Notifications', data.notifications.length);
    for (const n of data.notifications) box.appendChild(searchItem({
      title: n.title, meta: shortDate(n.ts), snippet: n.snippet, iconName: 'bell',
      onClick: () => {
        leave();
        fetch('/api/notifications/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: n.id }) }).catch(() => {});
        if (n.emailId) openEmailView(n.emailId);
        else if (n.sessionId) openChatAt(n.sessionId, null);
        else openDrawer('notifDrawer');
      },
    }));
  }
  if (!data.chats?.length && !data.emails?.length && !data.notifications?.length) box.innerHTML = '<div class="empty">Nothing found</div>';
}
// Open a chat and bring a message into view.
async function openChatAt(sessionId, ts) {
  if (sessionId !== currentSessionId) await switchSession(sessionId);
  if (!ts) return;
  const row = [...messagesEl.querySelectorAll('.msg-row[data-ts]')].find((r) => r.dataset.ts === ts);
  if (!row) return;
  row.scrollIntoView({ block: 'center' });
  row.classList.remove('search-flash');
  void row.offsetWidth;
  row.classList.add('search-flash');
  setTimeout(() => row.classList.remove('search-flash'), 2400);
}
async function openEmailView(id) {
  const r = await fetch(`/api/emails/${encodeURIComponent(id)}`).then((x) => x.json()).catch(() => ({ error: 'network error' }));
  if (r.error || !r.email) { showToast(r.error || 'Email not found'); return; }
  const m = r.email;
  closeAllDrawers();
  $('#emailViewSubject').textContent = m.subject || '(no subject)';
  $('#emailViewMeta').textContent = `${m.from || ''} · ${new Date(m.date).toLocaleString()}${m.account ? ` · ${m.account}` : ''}`;
  const body = String(m.body || m.snippet || '');
  $('#emailViewBody').innerHTML = window.pondLinkify ? window.pondLinkify(body) : escapeHtml(body);
  for (const a of $('#emailViewBody').querySelectorAll('a')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  $('#emailViewSummarize').onclick = () => { $('#emailViewModal').hidden = true; startChatWith(`✉ ${m.subject || 'Email'}`, `Read email id "${m.id}" ("${m.subject}" from ${m.from}) and summarize what I need to know or do.`); };
  $('#emailViewReply').onclick = () => { $('#emailViewModal').hidden = true; startChatWith(`✉ Reply: ${m.subject || 'Email'}`, `Read email id "${m.id}" ("${m.subject}" from ${m.from}) and draft a concise, polite reply for me to review.`); };
  $('#emailViewModal').hidden = false;
  $('#emailViewBody').scrollTop = 0;
}
$('#searchInput').addEventListener('input', () => {
  clearTimeout(search.timer);
  if (!$('#searchInput').value.trim()) { search.seq++; setSearching(false); return; }
  search.timer = setTimeout(runSearch, 180);
});
$('#searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { clearSearch(); $('#searchInput').blur(); }
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('#searchResults .search-item')?.click(); }
});
$('#searchKbd').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K';
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    document.body.classList.add('sidebar-open');
    $('#searchInput').focus();
    $('#searchInput').select();
  }
});
$('#emailViewModal').addEventListener('click', (e) => { if (e.target === $('#emailViewModal')) $('#emailViewModal').hidden = true; });

// ---------- Memory: core facts, topic docs, nightly dream ----------
const memUi = { doc: null, data: null };
const memLinkify = (html) => html.replace(/\[\[([^\]<>\n]{1,80})\]\]/g, (_, n) => `<a href="#" class="memdoc-link" data-memdoc="${n.trim()}">${n.trim()}</a>`);
const hourLabel = (h) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
function dreamWhen(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(today.getTime() - 86_400_000);
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `today ${t}`;
  if (d.toDateString() === yest.toDateString()) return `last night ${t}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`;
}
function dreamStatusText(dream) {
  if (!dream) return '';
  if (dream.running) return 'Dreaming… reorganizing memory';
  const last = dream.lastRun;
  const next = dream.enabled ? `next at ${hourLabel(dream.hour)}` : 'nightly dream off';
  if (!last) return `Hasn't dreamed yet · ${next}`;
  if (!last.ok) return `Last dream failed (${dreamWhen(last.at)}) · ${next}`;
  if (last.undone) return `Last dream undone · ${next}`;
  return `Dreamed ${dreamWhen(last.at)} · ${next}`;
}
function renderMemorySide(docs, dream) {
  const list = $('#memoryDocList');
  if (list) {
    list.innerHTML = '';
    for (const d of docs) {
      const b = document.createElement('button');
      b.className = 'mem-doc-row';
      b.title = d.description || d.title;
      b.innerHTML = `${icon('file', 12)}<span></span>`;
      b.querySelector('span').textContent = d.title || d.name;
      b.onclick = () => { document.body.classList.remove('sidebar-open'); memUi.doc = d.name; openDrawer('memDrawer'); };
      list.appendChild(b);
    }
  }
  const line = $('#dreamLine');
  if (line) {
    line.hidden = !dream;
    line.innerHTML = `${icon('moon', 12)}<span></span>`;
    line.querySelector('span').textContent = dreamStatusText(dream);
    line.classList.toggle('running', Boolean(dream?.running));
  }
  if (!$('#memDrawer').hidden && memUi.data && dream) { memUi.data.dream = dream; renderMemoryControls(); }
}
function renderMemoryControls() {
  const dream = memUi.data?.dream;
  if (!dream) return;
  $('#dreamStatus').innerHTML = `${icon('moon', 14)}<span></span>`;
  $('#dreamStatus').querySelector('span').textContent = dreamStatusText(dream);
  $('#dreamNowBtn').disabled = dream.running;
  $('#dreamNowBtn').textContent = dream.running ? 'Dreaming…' : 'Dream now';
  $('#dreamUndoBtn').hidden = !dream.canUndo || dream.running;
  $('#dreamToggle').checked = dream.enabled;
  const sel = $('#dreamHour');
  if (!sel.options.length) for (let h = 0; h < 24; h++) sel.add(new Option(hourLabel(h), String(h)));
  sel.value = String(dream.hour);
  sel.disabled = !dream.enabled;
}
async function loadMemoryDrawer() {
  try {
    memUi.data = await fetch('/api/memory', { cache: 'no-store' }).then((r) => r.json());
  } catch { memUi.data = { core: [], docs: [], dream: null }; }
  renderMemoryControls();
  if (memUi.doc) return showMemoryDoc(memUi.doc);
  renderMemoryOverview();
}
function renderMemoryOverview() {
  memUi.doc = null;
  const { core = [], docs = [], dream } = memUi.data || {};
  const body = $('#memBody');
  body.innerHTML = '';
  const last = dream?.lastRun;
  if (last?.summary) {
    const card = document.createElement('div');
    card.className = 'dream-card' + (last.ok ? '' : ' failed');
    const st = last.stats || {};
    const bits = last.ok && !last.skipped ? [st.chats != null && `${st.chats} chats read`, st.facts != null && `${st.facts} new facts`, st.coreBefore != null && `core ${st.coreBefore} → ${st.coreAfter}`, st.docsWritten && `${st.docsWritten} docs updated`].filter(Boolean) : [];
    card.innerHTML = `<div class="dream-card-head">${icon('moon', 13)}<span></span></div><div class="dream-card-text"></div>${bits.length ? '<div class="dream-card-stats"></div>' : ''}`;
    card.querySelector('.dream-card-head span').textContent = `${last.reason === 'manual' ? 'Dream' : 'Nightly dream'} · ${dreamWhen(last.at)}${last.undone ? ' · undone' : ''}`;
    card.querySelector('.dream-card-text').textContent = last.summary;
    if (bits.length) card.querySelector('.dream-card-stats').textContent = bits.join(' · ');
    body.appendChild(card);
  }
  const h1 = document.createElement('div');
  h1.className = 'mem-section';
  h1.textContent = `Core · in every chat (${core.length})`;
  body.appendChild(h1);
  if (!core.length) body.insertAdjacentHTML('beforeend', '<div class="empty">Nothing yet — tell Pond about yourself, or it will pick things up from your chats tonight.</div>');
  const ul = document.createElement('ul');
  ul.className = 'memory-list mem-core';
  for (const m of core) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${memLinkify(escapeHtml(m.fact))}</span>`;
    const del = document.createElement('button');
    del.innerHTML = icon('close', 13);
    del.title = 'Forget';
    del.onclick = async () => { await fetch(`/api/memory/${m.id}`, { method: 'DELETE' }); loadMemoryDrawer(); refreshState(); };
    li.appendChild(del);
    ul.appendChild(li);
  }
  body.appendChild(ul);
  const h2 = document.createElement('div');
  h2.className = 'mem-section';
  h2.textContent = `Docs · opened when needed (${docs.length})`;
  body.appendChild(h2);
  if (!docs.length) body.insertAdjacentHTML('beforeend', '<div class="empty">No docs yet. The nightly dream moves details out of the core into topic docs.</div>');
  const changed = new Set(dream?.lastRun?.ok && !dream.lastRun.undone ? dream.lastRun.changed || [] : []);
  for (const d of docs) {
    const row = document.createElement('button');
    row.className = 'mem-doc-card';
    row.innerHTML = '<div class="mem-doc-title"><span></span></div><div class="mem-doc-desc"></div>';
    row.querySelector('.mem-doc-title span').textContent = d.title || d.name;
    if (changed.has(d.name)) row.querySelector('.mem-doc-title').insertAdjacentHTML('beforeend', '<em class="mem-new">updated</em>');
    row.querySelector('.mem-doc-desc').textContent = d.description || '';
    row.onclick = () => showMemoryDoc(d.name);
    body.appendChild(row);
  }
}
async function showMemoryDoc(name) {
  const body = $('#memBody');
  let doc;
  try {
    const r = await fetch(`/api/memory/docs/${encodeURIComponent(name)}`, { cache: 'no-store' });
    doc = r.ok ? await r.json() : null;
  } catch { doc = null; }
  if (!doc) { memUi.doc = null; renderMemoryOverview(); showToast(`No memory doc "${name}"`); return; }
  memUi.doc = doc.name;
  body.innerHTML = `<div class="mem-doc-nav"><button class="link-btn" id="memBack">‹ All memory</button><button class="link-btn danger" id="memDocDel">Delete doc</button></div>
    <div class="mem-doc-view"><h2></h2><p class="mem-doc-desc"></p><div class="bubble-body mem-doc-md"></div><div class="mem-doc-file"></div></div>`;
  body.querySelector('h2').textContent = doc.title;
  body.querySelector('.mem-doc-view > .mem-doc-desc').textContent = doc.description || '';
  const md = window.renderMarkdown ? window.renderMarkdown(doc.content || '') : escapeHtml(doc.content || '');
  body.querySelector('.mem-doc-md').innerHTML = memLinkify(md);
  inkEmoji?.(body.querySelector('.mem-doc-md'));
  body.querySelector('.mem-doc-file').textContent = `data/memory/${doc.name}.md`;
  $('#memBack').onclick = () => renderMemoryOverview();
  $('#memDocDel').onclick = async () => {
    if (!confirm(`Delete the memory doc "${doc.title}"? Pond will no longer know what's in it.`)) return;
    await fetch(`/api/memory/docs/${encodeURIComponent(doc.name)}`, { method: 'DELETE' });
    memUi.doc = null;
    loadMemoryDrawer();
    refreshState();
  };
  body.scrollTop = 0;
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a.memdoc-link');
  if (!a) return;
  e.preventDefault();
  memUi.doc = a.dataset.memdoc;
  if ($('#memDrawer').hidden) { document.body.classList.remove('sidebar-open'); openDrawer('memDrawer'); } else showMemoryDoc(memUi.doc);
});

// ---------- Calendar panel ----------
// Month view + the selected day + what's coming up. Pond's own events can be added/edited here; events from the
// linked calendar (iCal feed) are read-only — they'd come back on the next sync.
const cal = { events: [], linked: false, month: null, selected: null, editing: null, byDay: new Map() };
const calKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const calKeyToDate = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
function calEventDays(ev) {
  const s = new Date(ev.startAt);
  let e = ev.endAt ? new Date(ev.endAt) : s;
  if (ev.allDay && ev.endAt) e = new Date(e.getTime() - 86_400_000); // all-day end date is exclusive
  else if (e > s && e.getHours() === 0 && e.getMinutes() === 0) e = new Date(e.getTime() - 1); // ends at midnight
  if (e < s) e = s;
  const keys = [];
  const d = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  for (let i = 0; i < 62 && d <= e; i++) { keys.push(calKey(d)); d.setDate(d.getDate() + 1); }
  return keys.length ? keys : [calKey(s)];
}
async function loadCalendar() {
  try {
    const r = await fetch('/api/calendar', { cache: 'no-store' }).then((x) => x.json());
    cal.events = (r.events || []).filter((e) => !Number.isNaN(new Date(e.startAt).getTime()));
    cal.linked = Boolean(r.linked);
  } catch { /* keep what we had */ }
  cal.byDay = new Map();
  for (const ev of cal.events) for (const k of calEventDays(ev)) {
    if (!cal.byDay.has(k)) cal.byDay.set(k, []);
    cal.byDay.get(k).push(ev);
  }
  for (const list of cal.byDay.values()) list.sort((a, b) => (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0) || new Date(a.startAt) - new Date(b.startAt));
  $('#calSyncBtn').hidden = !cal.linked;
  renderCalendar();
}
function openCalendar(dayKey = null) {
  const target = dayKey ? calKeyToDate(dayKey) : new Date();
  cal.month = new Date(target.getFullYear(), target.getMonth(), 1);
  cal.selected = calKey(target);
  hideCalForm();
  loadCalendar();
}
function calTimeLabel(ev, dayKey) {
  if (ev.allDay) return 'All day';
  const s = new Date(ev.startAt);
  const e = ev.endAt ? new Date(ev.endAt) : null;
  const t = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (calKey(s) !== dayKey) return e && calKey(e) === dayKey ? `until ${t(e)}` : 'All day';
  return e && calKey(e) === dayKey ? `${t(s)} – ${t(e)}` : t(s);
}
function renderCalendar() {
  const m = cal.month || new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  $('#calMonthLabel').textContent = m.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const grid = $('#calGrid');
  grid.innerHTML = '';
  const base = new Date(2026, 10, 1); // a Sunday → localized weekday initials
  for (let i = 0; i < 7; i++) {
    const h = document.createElement('div');
    h.className = 'cal-wd';
    h.textContent = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i).toLocaleDateString([], { weekday: 'narrow' });
    grid.appendChild(h);
  }
  const todayKey = calKey(new Date());
  const first = new Date(m.getFullYear(), m.getMonth(), 1 - m.getDay());
  const weeks = Math.ceil((m.getDay() + new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate()) / 7);
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i);
    const k = calKey(d);
    const evs = cal.byDay.get(k) || [];
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cal-cell';
    if (d.getMonth() !== m.getMonth()) cell.classList.add('other');
    if (k === todayKey) cell.classList.add('today');
    if (k === cal.selected) cell.classList.add('selected');
    cell.setAttribute('aria-label', `${d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}${evs.length ? `, ${evs.length} event${evs.length === 1 ? '' : 's'}` : ''}`);
    const dots = evs.slice(0, 3).map((e) => `<i class="${e.source === 'ics' ? 'ics' : ''}"></i>`).join('');
    cell.innerHTML = `<span class="n">${d.getDate()}</span><span class="dots">${dots}${evs.length > 3 ? '<b>+</b>' : ''}</span>`;
    cell.addEventListener('click', () => {
      cal.selected = k;
      if (d.getMonth() !== m.getMonth()) cal.month = new Date(d.getFullYear(), d.getMonth(), 1);
      renderCalendar();
    });
    grid.appendChild(cell);
  }
  renderCalDay();
}
function calEventRow(ev, dayKey) {
  const row = document.createElement('div');
  row.className = `cal-ev${ev.source === 'ics' ? ' ics' : ''}`;
  const meta = [ev.location ? escapeHtml(ev.location) : '', ev.source === 'ics' ? 'linked calendar' : '', ev.recurring ? 'repeats' : ''].filter(Boolean).join(' · ');
  row.innerHTML = `<div class="cal-ev-time">${escapeHtml(calTimeLabel(ev, dayKey))}</div>
    <div class="cal-ev-main"><div class="cal-ev-title">${escapeHtml(ev.title)}</div>${meta ? `<div class="sub">${meta}</div>` : ''}${ev.notes ? `<div class="cal-ev-notes">${escapeHtml(ev.notes)}</div>` : ''}</div>`;
  if (ev.source !== 'ics') {
    const act = document.createElement('div');
    act.className = 'cal-ev-actions';
    const edit = document.createElement('button');
    edit.className = 'link-btn'; edit.textContent = 'Edit';
    edit.onclick = () => showCalForm(ev);
    const del = document.createElement('button');
    del.className = 'link-btn'; del.textContent = 'Delete';
    del.onclick = async () => {
      if (!confirm(`Delete "${ev.title}"?`)) return;
      await fetch(`/api/calendar/${encodeURIComponent(ev.id)}`, { method: 'DELETE' });
      await loadCalendar(); refreshState();
    };
    act.append(edit, del);
    row.appendChild(act);
  }
  return row;
}
function renderCalDay() {
  const dayEl = $('#calDay');
  const k = cal.selected || calKey(new Date());
  const d = calKeyToDate(k);
  const isToday = k === calKey(new Date());
  dayEl.innerHTML = `<div class="cal-day-head">${isToday ? 'Today · ' : ''}${escapeHtml(d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }))}</div>`;
  const evs = cal.byDay.get(k) || [];
  if (!evs.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = 'Nothing planned. ';
    const add = document.createElement('button');
    add.className = 'link-btn'; add.textContent = 'Add an event';
    add.onclick = () => showCalForm(null, k);
    empty.appendChild(add);
    dayEl.appendChild(empty);
  } else for (const ev of evs) dayEl.appendChild(calEventRow(ev, k));

  // Coming up: the next events after the selected day (handy on a phone, where the grid is small)
  const up = $('#calUpcoming');
  up.innerHTML = '';
  const after = calKeyToDate(k); after.setDate(after.getDate() + 1);
  const horizon = new Date(after); horizon.setDate(horizon.getDate() + 60);
  const seen = new Set();
  const next = cal.events
    .filter((e) => { const t = new Date(e.startAt); return t >= after && t < horizon; })
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))
    .filter((e) => (seen.has(e.id) ? false : seen.add(e.id)))
    .slice(0, 10);
  if (next.length) {
    up.innerHTML = '<div class="cal-day-head">Coming up</div>';
    let last = '';
    for (const ev of next) {
      const ek = calKey(new Date(ev.startAt));
      if (ek !== last) {
        const sub = document.createElement('button');
        sub.className = 'cal-date-link link-btn';
        sub.textContent = calKeyToDate(ek).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        sub.onclick = () => openCalendar(ek);
        up.appendChild(sub);
        last = ek;
      }
      up.appendChild(calEventRow(ev, ek));
    }
  }
  $('#calFoot').textContent = cal.linked
    ? 'Events from your linked calendar are read-only here (change them in that app). Pond refreshes them every 15 minutes.'
    : 'Tip: link Google / Apple / Outlook in Agent Hub → Proactive (iCal link) to see those events here too.';
}
function hideCalForm() { $('#calForm').hidden = true; cal.editing = null; }
function showCalForm(ev = null, dayKey = null) {
  cal.editing = ev;
  const f = $('#calForm');
  $('#calFormTitle').textContent = ev ? 'Edit event' : 'New event';
  const s = ev ? new Date(ev.startAt) : null;
  const e = ev?.endAt ? new Date(ev.endAt) : null;
  const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  $('#calTitle').value = ev?.title || '';
  $('#calDate').value = s ? calKey(s) : (dayKey || cal.selected || calKey(new Date()));
  $('#calAllDay').checked = Boolean(ev?.allDay);
  $('#calStart').value = s && !ev.allDay ? hm(s) : (ev ? '' : '09:00');
  $('#calEnd').value = e && !ev.allDay ? hm(e) : (ev ? '' : '10:00');
  $('#calLocation').value = ev?.location || '';
  $('#calNotes').value = ev?.notes || '';
  syncCalAllDay();
  f.hidden = false;
  f.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('#calTitle').focus();
}
function syncCalAllDay() {
  const all = $('#calAllDay').checked;
  $$('#calForm .cal-time').forEach((l) => { l.hidden = all; });
}
$('#calAllDay').addEventListener('change', syncCalAllDay);
$('#calCancel').addEventListener('click', hideCalForm);
$('#calForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const date = $('#calDate').value;
  if (!date) return;
  const allDay = $('#calAllDay').checked;
  const start = new Date(`${date}T${allDay ? '09:00' : ($('#calStart').value || '09:00')}`);
  let end = null;
  if (!allDay && $('#calEnd').value) {
    end = new Date(`${date}T${$('#calEnd').value}`);
    if (end <= start) end.setDate(end.getDate() + 1); // ends after midnight
  }
  const body = {
    title: $('#calTitle').value.trim() || 'Untitled event',
    startAt: start.toISOString(),
    endAt: end ? end.toISOString() : null,
    allDay,
    location: $('#calLocation').value.trim(),
    notes: $('#calNotes').value.trim(),
  };
  const editing = cal.editing;
  const r = await fetch(editing ? `/api/calendar/${encodeURIComponent(editing.id)}` : '/api/calendar', {
    method: editing ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) { const err = await r.json().catch(() => ({})); showToast(err.error || 'Could not save the event'); return; }
  hideCalForm();
  cal.selected = date;
  cal.month = new Date(start.getFullYear(), start.getMonth(), 1);
  await loadCalendar();
  refreshState();
  showToast(editing ? 'Event updated' : 'Event added');
});
$('#calPrev').addEventListener('click', () => { cal.month = new Date(cal.month.getFullYear(), cal.month.getMonth() - 1, 1); renderCalendar(); });
$('#calNext').addEventListener('click', () => { cal.month = new Date(cal.month.getFullYear(), cal.month.getMonth() + 1, 1); renderCalendar(); });
$('#calTodayBtn').addEventListener('click', () => openCalendar());
$('#calAddBtn').addEventListener('click', () => showCalForm(null, cal.selected));
$('#calSyncBtn').addEventListener('click', async () => {
  showToast('Syncing calendar…');
  const r = await fetch('/api/calendar/sync', { method: 'POST' }).then((x) => x.json()).catch(() => ({}));
  showToast(r.ok ? `Calendar synced (${r.synced} events)` : `Calendar sync failed${r.error ? `: ${r.error}` : ''}`);
  loadCalendar();
});

const CAT_ICON_NAMES = {
  email: 'mail',
  reminder: 'clock',
  calendar: 'calendar',
  approval: 'shield',
  job: 'zap',
  watch: 'eye',
  task: 'list',
  webhook: 'link',
  proactive: 'sparkles',
  system: 'bell',
  sentinel: 'shield',
  mcp: 'plug',
  python: 'terminal',
  subagent: 'sparkles',
};
const catIcon = (cat, size = 14) => icon(CAT_ICON_NAMES[cat] || 'bell', size);

async function loadNotificationsDrawer() {
  syncNotifPermissionUI();
  $('#soundToggle').checked = prefs.sound;
  $('#muteToggle').checked = prefs.mute;
  const resp = await fetch('/api/notifications');
  const data = await resp.json();
  updateTabBadge(data.unreadCount || 0);
  const list = $('#notifList');
  const items = data.notifications || [];
  if (!items.length) {
    list.innerHTML = '<div class="empty">No notifications yet. Click "Test" above to verify desktop popups!</div>';
    return;
  }
  list.innerHTML = '';
  for (const n of items) {
    const card = document.createElement('div');
    card.className = `notif-card ${n.read ? '' : 'unread'} ${n.urgency || ''}`;
    card.innerHTML = `
      <div class="card-top">
        <span class="inline-icon-text">${catIcon(n.category, 14)}<span>${escapeHtml(n.title)}</span></span>
        <div class="btn-group" style="align-items:center;">
          <span class="pill ${n.urgency || ''}">${escapeHtml(n.urgency || 'normal')}</span>
          <button class="close-btn" style="width:22px;height:22px;" title="Dismiss notification" data-dismiss="${escapeHtml(n.id)}">${icon('close', 13)}</button>
        </div>
      </div>
      <div class="card-text">${escapeHtml(n.body)}</div>
      <div class="card-meta">${new Date(n.ts).toLocaleString()}</div>
    `;
    card.querySelector('[data-dismiss]').onclick = async (e) => {
      e.stopPropagation();
      await fetch(`/api/notifications/${n.id}`, { method: 'DELETE' });
      loadNotificationsDrawer();
      refreshState();
    };
    card.onclick = async () => {
      if (!n.read) {
        await fetch('/api/notifications/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: n.id }),
        });
        loadNotificationsDrawer();
      }
    };
    list.appendChild(card);
  }
}

async function loadEmailDrawer() {
  const resp = await fetch('/api/emails');
  const data = await resp.json();
  const statusEl = $('#emailDrawerStatus');
  if (data.lastError) {
    statusEl.innerHTML = `${icon('alert', 14, 'icon-danger')}<span>Sync error: ${escapeHtml(data.lastError.slice(0, 60))}</span>`;
  } else if (data.configured) {
    statusEl.innerHTML = `${icon('check-circle', 14, 'icon-ok')}<span>${
      data.lastSyncAt ? `IMAP connected · synced ${new Date(data.lastSyncAt).toLocaleTimeString()}` : 'IMAP connected'
    }</span>`;
  } else {
    statusEl.innerHTML = `${icon('mail', 14)}<span>IMAP not configured yet (click Configure or Test Email)</span>`;
  }

  const list = $('#emailList');
  const items = data.emails || [];
  if (!items.length) {
    list.innerHTML = '<div class="empty">No emails yet. Configure IMAP in Settings or click "Test Email" to see AI triage & browser alerts in action!</div>';
    return;
  }
  list.innerHTML = '';
  for (const m of items) {
    const imp = m.importance || {};
    const card = document.createElement('div');
    card.className = `email-card ${imp.urgency || ''}`;
    card.innerHTML = `
      <div class="card-top">
        <span>${escapeHtml(m.subject)}</span>
        <div class="btn-group" style="align-items:center;">
          <span class="pill ${imp.urgency || ''}">${escapeHtml(imp.important ? (imp.urgency || 'important') : (imp.category || 'normal'))}</span>
          <button class="close-btn" style="width:22px;height:22px;" title="Dismiss email" data-act="dismiss">${icon('close', 13)}</button>
        </div>
      </div>
      <div class="card-meta">${escapeHtml(m.from)} · ${new Date(m.date).toLocaleString()}${m.account ? ` · ${escapeHtml(m.account)}` : ''}</div>
      <div class="card-text">${escapeHtml(imp.summary || m.snippet || '')}</div>
      ${imp.suggestedAction ? `<div class="card-meta inline-icon-text">${icon('bulb', 13)}<span>${escapeHtml(imp.suggestedAction)}</span></div>` : ''}
      <div class="btn-group" style="margin-top:4px;">
        <button class="btn sm" data-act="summarize">Read & Summarize</button>
        <button class="btn sm" data-act="reply">Draft Reply</button>
        <button class="btn ghost sm" data-act="dismiss-btn">Dismiss</button>
      </div>
    `;
    const doDismiss = async () => {
      await fetch(`/api/emails/${m.id}/dismiss`, { method: 'POST' });
      loadEmailDrawer();
      refreshState();
    };
    card.querySelector('[data-act="dismiss"]').onclick = doDismiss;
    card.querySelector('[data-act="dismiss-btn"]').onclick = doDismiss;
    // Each email action gets its own chat (like routines), so it never collides with a reply running elsewhere.
    card.querySelector('[data-act="summarize"]').onclick = () => {
      closeAllDrawers();
      startChatWith(`✉ ${m.subject || 'Email'}`, `Read email id "${m.id}" ("${m.subject}" from ${m.from}) and summarize what I need to know or do.`);
    };
    card.querySelector('[data-act="reply"]').onclick = () => {
      closeAllDrawers();
      startChatWith(`✉ Reply: ${m.subject || 'Email'}`, `Read email id "${m.id}" ("${m.subject}" from ${m.from}) and draft a concise, polite reply for me to review.`);
    };
    list.appendChild(card);
  }
}

// ---------- Agent Hub Modal ----------
async function openHub(tabName = 'proactive') {
  closeAllDrawers();
  $('#hubModal').hidden = false;
  switchHubTab(tabName);
  await loadHubData();
}

async function loadMcpDiscovery() {
  const discEl = $('#hubMcpDiscovered');
  const presetsEl = $('#hubMcpPresets');
  const importAllBtn = $('#importAllMcpBtn');
  discEl.innerHTML = '<div class="empty">Scanning local configs (Claude, Cursor, VS Code, Antigravity) & localhost ports…</div>';
  try {
    const res = await fetch('/api/mcp/discover').then((r) => r.json());
    const discovered = res.discovered || [];
    const newOnes = discovered.filter((d) => !d.alreadyAdded);
    importAllBtn.hidden = newOnes.length === 0;
    importAllBtn.textContent = `Import All (${newOnes.length})`;

    if (!discovered.length) {
      discEl.innerHTML = '<div class="empty">No external MCP servers detected locally. Paste a URL/command below or pick a preset!</div>';
    } else {
      discEl.innerHTML = '';
      for (const item of discovered) {
        const c = document.createElement('div');
        c.className = 'hub-card';
        c.innerHTML = `
          <div class="card-top">
            <span class="inline-icon-text">${icon('plug', 14)}<span>${escapeHtml(item.label || item.name)}</span></span>
            <span class="pill ${item.alreadyAdded ? 'ok' : ''}">${escapeHtml(item.source)}</span>
          </div>
          <div class="card-meta">${escapeHtml(item.transport === 'http' ? item.url : `${item.command} ${(item.args || []).join(' ')}`)}</div>
          <div class="btn-group">
            ${item.alreadyAdded ? '<span class="card-meta">Already connected</span>' : '<button class="btn primary sm" data-act="import">Import & Connect</button>'}
          </div>
        `;
        const btn = c.querySelector('[data-act="import"]');
        if (btn) {
          btn.onclick = async () => {
            showToast(`Connecting "${item.name}"…`);
            await fetch('/api/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item) });
            await loadHubData();
          };
        }
        discEl.appendChild(c);
      }
    }

    const presets = res.presets || [];
    presetsEl.innerHTML = '';
    for (const p of presets) {
      const c = document.createElement('div');
      c.className = 'hub-card';
      c.innerHTML = `
        <div class="card-top">
          <span>${escapeHtml(p.label)}</span>
          <span class="pill">${escapeHtml(p.transport)}</span>
        </div>
        <div class="card-text">${escapeHtml(p.description)}</div>
        ${p.envHints?.length ? `<div class="card-meta">Optional env: ${escapeHtml(p.envHints.join(', '))}</div>` : ''}
        <div class="btn-group">
          ${p.alreadyAdded ? '<span class="card-meta">Added</span>' : '<button class="btn sm" data-act="add">One-Click Add</button>'}
        </div>
      `;
      const btn = c.querySelector('[data-act="add"]');
      if (btn) {
        btn.onclick = async () => {
          showToast(`Connecting ${p.label}…`);
          await fetch('/api/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
          await loadHubData();
        };
      }
      presetsEl.appendChild(c);
    }
  } catch (err) {
    discEl.innerHTML = `<div class="empty">Discovery error: ${escapeHtml(err.message || err)}</div>`;
  }
}

function switchHubTab(tabName) {
  $$('#hubTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tabName));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tabName));
  if (tabName === 'mcp') { loadMcpDiscovery(); loadSearchSettings(); }
  if (tabName === 'sentinel') loadFileRoot();
}

// ---------- File access folder (Agent Hub → Sentinel) ----------
async function loadFileRoot() {
  const s = await fetch('/api/settings', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({}));
  if (!s.fsRoot) return;
  $('#setFsRoot').value = s.fsRoot;
  $('#fsRootResult').textContent = '';
  const pol = (name) => (s.sentinel?.policies?.[name]) || (name === 'run_python' ? 'ask' : 'allow');
  const how = (v) => (v === 'allow' ? 'without asking' : v === 'deny' ? 'never' : 'after asking you');
  $('#fsRootHint').textContent = `In this folder and below, the AI writes and edits files ${how(pol('write_file'))}; anything else (listing, moving, deleting) goes through Python, which runs ${how(pol('run_python'))}. Pond Share: ${s.shareDir}`;
}
$('#saveFsRootBtn').addEventListener('click', async () => {
  const out = $('#fsRootResult');
  const r = await fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fsRoot: $('#setFsRoot').value }) })
    .then(async (x) => ({ ok: x.ok, ...(await x.json().catch(() => ({}))) })).catch(() => ({ ok: false, error: 'offline' }));
  if (!r.ok) { out.textContent = `✗ ${r.error || 'Could not save'}`; out.dataset.state = 'bad'; return; }
  await loadFileRoot();
  out.textContent = '✓ Saved — applies right away'; out.dataset.state = 'good';
});

// ---------- Web search provider (Agent Hub → MCP & API) ----------
async function loadSearchSettings() {
  const s = await fetch('/api/settings', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({}));
  const se = s.search || {};
  $('#searchBackend').value = se.backend || 'auto';
  $('#searchTavilyKey').value = se.tavilyApiKey || '';
  $('#searchTestResult').textContent = '';
}
$('#saveSearchBtn').addEventListener('click', async () => {
  const body = { search: { backend: $('#searchBackend').value, tavilyApiKey: $('#searchTavilyKey').value.trim() } };
  const r = await fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  showToast(r?.ok ? 'Web search settings saved' : 'Could not save web search settings');
  await loadSearchSettings();
});
$('#testSearchBtn').addEventListener('click', async () => {
  const out = $('#searchTestResult');
  out.textContent = 'Searching…';
  const r = await fetch('/api/search/test', { method: 'POST' }).then((x) => x.json()).catch(() => ({ ok: false, error: 'offline' }));
  const name = { tavily: 'Tavily', deepseek: 'DeepSeek', bing: 'Bing' };
  if (r.ok) out.textContent = `✓ ${name[r.backend] || r.backend} — ${r.count} result${r.count === 1 ? '' : 's'} (${r.ms} ms)`;
  else if (r.fallbackFrom) out.textContent = `✗ ${name[r.fallbackFrom] || r.fallbackFrom} failed, used Bing instead — ${r.note || ''}`;
  else out.textContent = `✗ ${r.backend ? `${name[r.backend] || r.backend}: ` : ''}${r.error || 'search failed'}${r.backend === 'bing' ? ' (no key needed, but it needs internet access)' : ''}`;
  out.dataset.state = r.ok ? 'good' : 'bad';
});

let latestLlmConfig = null;

function syncLlmProfileFields(cfg, key) {
  const p = cfg?.profiles?.[key] || {};
  $('#llmLabel').value = p.label || key || '';
  $('#llmModel').value = p.model || '';
  $('#llmContextLength').value = p.contextLength ?? 128000;
  $('#llmEffort').value = p.reasoningEffort || '';
  $('#llmBaseUrl').value = p.baseUrl || '';
  $('#llmApiKey').value = p.apiKey || '';
  $('#llmTemp').value = p.temperature ?? '';
  $('#llmMaxTokens').value = p.maxTokens ?? '';
  $('#llmInputImage').checked = Array.isArray(p.inputTypes) && p.inputTypes.includes('image');
  $('#llmTestResult').textContent = '';
  const count = Object.keys(cfg?.profiles || {}).length;
  $('#deleteLlmProfileBtn').disabled = count <= 1;
}

async function loadHubData() {
  const [settings, ms365Res, llmRes, pyRes, jobsRes, watchesRes, approvalsRes, mcpRes, artifactsRes, activityRes] = await Promise.all([
    fetch('/api/settings').then((r) => r.json()),
    fetch('/api/ms365').then((r) => r.json()).catch(() => ({})),
    fetch('/api/llm').then((r) => r.json()),
    fetch('/api/python/status').then((r) => r.json()).catch(() => ({ available: false })),
    fetch('/api/jobs').then((r) => r.json()),
    fetch('/api/watches').then((r) => r.json()),
    fetch('/api/approvals').then((r) => r.json()),
    fetch('/api/mcp').then((r) => r.json()),
    fetch('/api/artifacts').then((r) => r.json()),
    fetch('/api/activity').then((r) => r.json()),
  ]);

  // Microsoft 365 card
  renderMs365Status(ms365Res);

  // LLM Engine tab (data/llm.json)
  latestLlmConfig = llmRes;
  const activeSel = $('#llmActiveProfile');
  const fastSel = $('#llmFastProfile');
  const pKeys = Object.keys(llmRes.profiles || {});
  activeSel.innerHTML = pKeys.map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(llmRes.profiles[k].label || k)} (${escapeHtml(k)})</option>`).join('');
  fastSel.innerHTML = '<option value="">Same as active profile</option>' + activeSel.innerHTML;
  activeSel.value = llmRes.activeProfile || pKeys[0] || 'default';
  fastSel.value = llmRes.fastProfile || '';
  syncLlmProfileFields(llmRes, activeSel.value);
  $('#llmJsonEditor').value = JSON.stringify({ activeProfile: llmRes.activeProfile, fastProfile: llmRes.fastProfile, profiles: llmRes.profiles }, null, 2);
  $('#pythonStatusLabel').textContent = pyRes?.available
    ? `Python tool ready: ${pyRes.version}`
    : 'Python tool: Python 3 not detected (set PYTHON_BIN in .env)';

  // Proactive & Calendar tab
  $('#setProactiveEnabled').checked = Boolean(settings.proactive?.enabled);
  $('#setAggressiveness').value = settings.proactive?.aggressiveness || 'high';
  $('#setIntervalMin').value = settings.proactive?.intervalMin || 3;
  $('#setMinGapMin').value = settings.proactive?.minGapMin || 5;
  if ($('#setDndHours')) $('#setDndHours').value = settings.proactive?.dndHours ?? 4;
  $('#setQuietHours').value = settings.proactive?.quietHours || '';
  $('#setHeadsUpMin').value = settings.proactive?.upcomingReminderHeadsUpMin ?? 15;
  $('#setUserLocation').value = settings.userLocation || '';
  $('#setEventLeadMin').value = settings.calendar?.reminderLeadMin ?? 30;
  $('#setIcsUrl').value = settings.calendar?.icsUrl || '';
  $('#setAutoTasks').checked = Boolean(settings.proactive?.autoExecuteTasks);
  $('#setBriefings').checked = Boolean(settings.proactive?.proactiveBriefings);

  // Email tab
  $('#setEmailEnabled').checked = Boolean(settings.email?.enabled);
  $('#setEmailAutoTriage').checked = settings.email?.autoTriage !== false;
  $('#setImapHost').value = settings.email?.imapHost || '';
  $('#setImapPort').value = settings.email?.imapPort || 993;
  $('#setImapUser').value = settings.email?.imapUser || '';
  $('#setImapPass').value = settings.email?.imapPass || '';
  $('#setImapMailbox').value = settings.email?.imapMailbox || 'INBOX';
  $('#setEmailPollMin').value = settings.email?.pollIntervalMin || 10;
  $('#setSmtpHost').value = settings.email?.smtpHost || '';
  $('#setSmtpPort').value = settings.email?.smtpPort || 465;
  $('#setSmtpUser').value = settings.email?.smtpUser || '';
  $('#setSmtpPass').value = settings.email?.smtpPass || '';
  $('#setVipSenders').value = (settings.email?.vipSenders || []).join(', ');
  $('#setImportantKeywords').value = (settings.email?.importantKeywords || []).join(', ');

  // Sync Quick Connect card with saved email config
  $('#quickEmailAddr').value = settings.email?.imapUser || '';
  $('#quickEmailPass').value = settings.email?.imapPass || '';
  const detectedProv = detectEmailProvider(settings.email?.imapHost || settings.email?.imapUser || '');
  $('#emailProviderPreset').value = detectedProv;
  updateEmailProviderGuide(detectedProv);
  $('#emailTestStatus').textContent = settings.email?.configured ? 'Connected' : '';

  // Jobs list
  const jobsEl = $('#hubJobsList');
  const jobs = jobsRes.jobs || [];
  jobsEl.innerHTML = jobs.length ? '' : '<div class="empty">No recurring routines yet.</div>';
  for (const j of jobs) {
    const c = document.createElement('div');
    c.className = 'hub-card';
    c.innerHTML = `
      <div class="card-top">
        <span>${escapeHtml(j.name)}</span>
        <span class="pill ${j.enabled ? 'ok' : ''}">${j.enabled ? (j.cron || `every ${j.intervalMin}m`) : 'paused'}</span>
      </div>
      <div class="card-text">${escapeHtml(j.prompt)}</div>
      <div class="card-meta">${j.lastRunAt ? `Last run: ${new Date(j.lastRunAt).toLocaleString()} (${j.lastStatus})` : 'Never run yet'}</div>
      <div class="btn-group">
        <button class="btn sm inline-icon-text" data-act="run">${icon('play', 11)}<span>Run Now</span></button>
        <button class="btn sm" data-act="toggle">${j.enabled ? 'Pause' : 'Resume'}</button>
        <button class="btn danger sm" data-act="del">Delete</button>
      </div>
    `;
    c.querySelector('[data-act="run"]').onclick = async () => {
      showToast(`Running "${j.name}"…`);
      await fetch(`/api/jobs/${j.id}/run`, { method: 'POST' });
    };
    c.querySelector('[data-act="toggle"]').onclick = async () => {
      await fetch(`/api/jobs/${j.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !j.enabled }) });
      loadHubData();
      refreshState();
    };
    c.querySelector('[data-act="del"]').onclick = async () => {
      await fetch(`/api/jobs/${j.id}`, { method: 'DELETE' });
      loadHubData();
      refreshState();
    };
    jobsEl.appendChild(c);
  }

  // Watches list
  const wEl = $('#hubWatchesList');
  const watches = watchesRes.watches || [];
  wEl.innerHTML = watches.length ? '' : '<div class="empty">No proactive watchers yet.</div>';
  for (const w of watches) {
    const c = document.createElement('div');
    c.className = 'hub-card';
    c.innerHTML = `
      <div class="card-top">
        <span class="inline-icon-text">${icon('eye', 14)}<span>${escapeHtml(w.name)}</span></span>
        <span class="pill">${escapeHtml(w.type)} · every ${w.intervalMin}m</span>
      </div>
      <div class="card-meta">${escapeHtml(w.target)}</div>
      ${w.criteria ? `<div class="card-text">Criteria: ${escapeHtml(w.criteria)}</div>` : ''}
      <div class="card-meta">${w.lastError ? `Error: ${escapeHtml(w.lastError)}` : w.lastCheckedAt ? `Checked ${new Date(w.lastCheckedAt).toLocaleTimeString()}` : 'Waiting for first check'}</div>
      <div class="btn-group">
        <button class="btn sm" data-act="check">Check Now</button>
        <button class="btn danger sm" data-act="del">Delete</button>
      </div>
    `;
    c.querySelector('[data-act="check"]').onclick = async () => {
      showToast(`Checking "${w.name}"…`);
      await fetch(`/api/watches/${w.id}/check`, { method: 'POST' });
      loadHubData();
    };
    c.querySelector('[data-act="del"]').onclick = async () => {
      await fetch(`/api/watches/${w.id}`, { method: 'DELETE' });
      loadHubData();
    };
    wEl.appendChild(c);
  }

  // Sentinel tab
  $('#setSentinelEnabled').checked = settings.sentinel?.enabled !== false;
  const polGrid = $('#sentinelPoliciesGrid');
  polGrid.innerHTML = '';
  const policyLabels = {
    send_email: ['mail', 'Send Email'],
    run_python: ['terminal', 'Run Python (also file listing & deleting)'],
    write_file: ['file', 'Write & Edit Files'],
    http_request_write: ['globe', 'External API Write'],
    mcp_tool: ['plug', 'External MCP Tool'],
  };
  const policies = settings.sentinel?.policies || {};
  for (const [key, [iconName, label]] of Object.entries(policyLabels)) {
    const row = document.createElement('div');
    row.className = 'policy-row';
    row.innerHTML = `<span class="inline-icon-text">${icon(iconName, 14)}<span>${label}</span></span>
      <select data-pol="${key}">
        <option value="ask">Ask me first</option>
        <option value="allow">Allow automatically</option>
        <option value="deny">Always block</option>
      </select>`;
    row.querySelector('select').value = policies[key] || 'ask';
    polGrid.appendChild(row);
  }

  const apList = $('#hubApprovalsList');
  const approvals = approvalsRes.approvals || [];
  apList.innerHTML = approvals.length ? '' : '<div class="empty">No Sentinel approval events yet.</div>';
  for (const a of approvals.slice(0, 15)) {
    const c = document.createElement('div');
    c.className = 'hub-card';
    c.innerHTML = `
      <div class="card-top"><span>${escapeHtml(a.summary)}</span><span class="pill ${a.status === 'approved' ? 'ok' : a.status === 'denied' ? 'critical' : 'high'}">${escapeHtml(a.status)}</span></div>
      <div class="card-meta">${escapeHtml(a.tool)} · ${new Date(a.createdAt).toLocaleString()}</div>
    `;
    apList.appendChild(c);
  }

  // MCP & Endpoints tab
  const mcpEl = $('#hubMcpList');
  const servers = mcpRes.servers || [];
  mcpEl.innerHTML = servers.length ? '' : '<div class="empty">No MCP servers connected yet. Connect Google Calendar, Notion, Spotify, or any MCP server above!</div>';
  for (const s of servers) {
    const c = document.createElement('div');
    c.className = 'hub-card';
    c.innerHTML = `
      <div class="card-top">
        <span class="inline-icon-text">${icon('plug', 14)}<span>${escapeHtml(s.name)} (${escapeHtml(s.transport)})</span></span>
        <span class="pill ${s.status === 'connected' ? 'ok' : 'critical'}">${escapeHtml(s.status)} · ${(s.tools || []).length} tools</span>
      </div>
      <div class="card-meta">${escapeHtml(s.transport === 'http' ? s.url : `${s.command} ${(s.args || []).join(' ')}`)}</div>
      ${s.error ? `<div class="card-meta" style="color:var(--danger)">${escapeHtml(s.error)}</div>` : ''}
      <div class="btn-group">
        <button class="btn sm" data-act="reconn">Reconnect</button>
        <button class="btn danger sm" data-act="del">Remove</button>
      </div>
    `;
    c.querySelector('[data-act="reconn"]').onclick = async () => {
      await fetch(`/api/mcp/${s.name}/reconnect`, { method: 'POST' });
      loadHubData();
    };
    c.querySelector('[data-act="del"]').onclick = async () => {
      await fetch(`/api/mcp/${s.name}`, { method: 'DELETE' });
      loadHubData();
    };
    mcpEl.appendChild(c);
  }

  const origin = window.location.origin;
  $('#endpointsBox').innerHTML = `
    <div><strong>Email Ingest Webhook:</strong> POST ${origin}/api/emails/ingest</div>
    <div><strong>Generic Event Webhook:</strong> POST ${origin}/api/webhooks/&lt;source&gt;</div>
    <div><strong>OpenAI-Compatible Agent API:</strong> POST ${origin}/api/v1/chat/completions</div>
  `;

  loadSkillsPanel();
  loadPluginsPanel();
  loadAppearancePanel();
  loadPersonaPanel();

  // Artifacts & Activity tab
  const artEl = $('#hubArtifactsList');
  const arts = artifactsRes.artifacts || [];
  artEl.innerHTML = arts.length ? '' : '<div class="empty">No saved artifacts yet. Ask Pond to build a trip itinerary, weekly planner, or tracker!</div>';
  for (const a of arts) {
    const c = document.createElement('div');
    c.className = 'hub-card';
    c.innerHTML = `
      <div class="card-top"><span class="inline-icon-text">${icon('layout', 14)}<span>${escapeHtml(a.title)}</span></span><span class="pill">${escapeHtml(a.type)}</span></div>
      <div class="btn-group">
        <a class="btn primary sm" href="${escapeHtml(a.url)}" target="_blank" rel="noopener">Open</a>
        <button class="btn danger sm" data-act="del">Delete</button>
      </div>
    `;
    c.querySelector('[data-act="del"]').onclick = async () => {
      await fetch(`/api/artifacts/${a.id}`, { method: 'DELETE' });
      loadHubData();
    };
    artEl.appendChild(c);
  }

  const actEl = $('#hubActivityList');
  const acts = activityRes.activity || [];
  actEl.innerHTML = acts.length ? '' : '<div class="empty">No autonomous activity logged yet.</div>';
  for (const a of acts.slice(0, 40)) {
    const c = document.createElement('div');
    c.className = 'hub-card';
    c.innerHTML = `
      <div class="card-top"><span class="inline-icon-text">${catIcon(a.kind, 14)}<span>${escapeHtml(a.title)}</span></span><span class="card-meta">${new Date(a.ts).toLocaleTimeString()}</span></div>
      ${a.detail ? `<div class="card-text">${escapeHtml(a.detail)}</div>` : ''}
    `;
    actEl.appendChild(c);
  }
}

// ---------- Personality (role / tone prompt) ----------
async function loadPersonaPanel() {
  const el = $('#hubPersona');
  if (!el) return;
  const s = await fetch('/api/settings').then((r) => r.json()).catch(() => ({}));
  const persona = s.persona || { preset: 'default', custom: '', presets: {} };
  const presets = persona.presets || {};
  const labels = { default: 'Default — warm chief-of-staff', casual: 'Casual — like a friend', concise: 'Concise — straight to the point', playful: 'Playful — fun and upbeat', custom: 'Custom — write your own' };
  el.innerHTML = `
    <div class="persona-grid">
      <label>Name<input type="text" data-k="name" maxlength="40" value="${escapeHtml(s.assistantName || 'Pond')}"></label>
      <label>Style<select data-k="preset">${Object.keys(labels).map((k) => `<option value="${k}" ${persona.preset === k ? 'selected' : ''}>${labels[k]}</option>`).join('')}</select></label>
    </div>
    <label class="persona-custom" ${persona.preset === 'custom' ? '' : 'hidden'}>Describe the personality and tone
      <textarea data-k="custom" rows="4" maxlength="2000" placeholder="e.g. Talk like a laid-back friend. Keep replies short. Reply in Japanese unless I write in English.">${escapeHtml(persona.custom || '')}</textarea></label>
    <div class="persona-preview card-meta"></div>
    <div class="btn-group" style="margin-top:8px"><button class="btn primary sm" data-act="save-persona">Save personality</button></div>`;
  const nameEl = el.querySelector('[data-k="name"]'), presetEl = el.querySelector('[data-k="preset"]'), customEl = el.querySelector('[data-k="custom"]');
  const preview = () => {
    const p = presetEl.value, name = nameEl.value.trim() || 'Pond';
    const role = p === 'custom' ? `a personal AI assistant. Personality and tone, as set by you: ${customEl.value.trim() || '…'}` : (presets[p] || '');
    el.querySelector('.persona-preview').innerHTML = `<b>Preview:</b> “You are ${escapeHtml(name)}, ${escapeHtml(role)}”`;
  };
  presetEl.onchange = () => {
    const custom = presetEl.value === 'custom';
    el.querySelector('.persona-custom').hidden = !custom;
    if (custom && !customEl.value.trim()) customEl.value = (presets[persona.preset] || presets.default || '').replace(/^an? /, ''); // start from the current style
    preview();
  };
  nameEl.oninput = preview; customEl.oninput = preview;
  el.querySelector('[data-act="save-persona"]').onclick = async () => {
    if (presetEl.value === 'custom' && !customEl.value.trim()) { showToast('Describe the personality first'); customEl.focus(); return; }
    await fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assistantName: nameEl.value.trim() || 'Pond', persona: { preset: presetEl.value, custom: customEl.value } }) });
    showToast('Personality saved — applies from the next message');
    refreshState();
  };
  preview();
}

// ---------- Appearance tab (mascot color) ----------
async function loadAppearancePanel() {
  const el = $('#hubAppearance');
  if (!el || !window.PondMascot) return;
  if (!el.dataset.lookWired) {
    el.dataset.lookWired = '1';
    el.addEventListener('click', (e) => {
      const eb = e.target.closest('.emoji-opt');
      if (eb) {
        prefs.emoji = eb.dataset.emoji;
        el.querySelectorAll('.emoji-opt').forEach((x) => x.classList.toggle('primary', x === eb));
        lastRenderedSessionKey = ''; loadConversation({ force: true }); // redraw answers
        return;
      }
      const b = e.target.closest('.look-opt');
      if (!b) return;
      applyLook(b.dataset.look);
      el.querySelectorAll('.look-opt').forEach((x) => x.classList.toggle('primary', x === b));
      lastRenderedSessionKey = ''; loadConversation({ force: true });
    });
  }
  const settings = await fetch('/api/settings').then((r) => r.json()).catch(() => ({}));
  let sel = settings.ui?.mascotPalette || 'cyan';
  let color = settings.ui?.mascotColor || '#22c3e6';
  const names = Object.keys(window.PondMascot.PALETTES);
  const ui = settings.ui || {};
  const usingImage = ui.avatarMode === 'image' && ui.avatarExt;
  const usingIcosa = ui.avatarMode === 'icosa' || !ui.avatarMode;
  const makeChar = (opts) => (usingIcosa ? window.PondMascot.createIcosa('happy') : window.PondMascot.create('happy', opts));
  el.innerHTML = `
    <div class="section-sub" style="margin-top:0">Look <span class="card-meta">(this device)</span></div>
    <div class="btn-group look-row" style="margin-bottom:14px">
      <button type="button" class="btn sm look-opt${prefs.look === 'plate' ? ' primary' : ''}" data-look="plate">Plate — serif, quiet</button>
      <button type="button" class="btn sm look-opt${prefs.look === 'classic' ? ' primary' : ''}" data-look="classic">Classic</button>
    </div>
    <div class="section-sub">Emoji in answers <span class="card-meta">(Plate look, this device)</span></div>
    <div class="btn-group" style="margin-bottom:14px">
      <button type="button" class="btn sm emoji-opt${prefs.emoji !== 'color' ? ' primary' : ''}" data-emoji="ink">Ink — line icons, monochrome</button>
      <button type="button" class="btn sm emoji-opt${prefs.emoji === 'color' ? ' primary' : ''}" data-emoji="color">Colour</button>
    </div>
    <div class="section-sub">Character</div>
    <div class="appearance-row" style="margin-bottom:14px">
      <div class="appearance-preview avatar-preview">${usingImage ? `<img src="/appearance/avatar?v=${ui.avatarVersion}" alt="" class="${ui.avatarCircle !== false ? 'circle' : ''}">` : ''}</div>
      <div style="flex:1;min-width:220px">
        <div class="btn-group">
          <button type="button" class="btn sm${!usingImage && !usingIcosa ? ' primary' : ''}" data-act="mascot">Ink splash</button>
          <button type="button" class="btn sm${usingIcosa ? ' primary' : ''}" data-act="icosa">Icosahedron</button>
          <label class="btn sm${usingImage ? ' primary' : ''}">Upload image…<input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" data-act="upload" hidden></label>
        </div>
        <label class="checkbox-field" style="margin-top:6px"><input type="checkbox" data-act="circle" ${ui.avatarCircle !== false ? 'checked' : ''}> Crop to circle</label>
        <div class="card-meta">${usingImage ? 'Using your image. Color below still sets the send button.' : usingIcosa ? 'A wireframe icosahedron. It turns faster while Pond works. In the Plate look it is drawn in ink; in Classic, in the color below.' : 'The Pond ink splash. Or upload a PNG, JPG, WebP, GIF or SVG, up to 2 MB.'}</div>
      </div>
    </div>
    <div class="section-sub">Color</div>
    <div class="appearance-row">
      <div class="appearance-preview"></div>
      <div class="appearance-preview small"></div>
      <div style="flex:1;min-width:220px">
        <div class="swatches">${names.map((n) => `<button type="button" class="swatch" data-p="${n}" title="${n}" aria-label="${n}" style="background:${window.PondMascot.PALETTES[n].body}"></button>`).join('')}
          <label class="swatch custom" title="Custom color"><input type="color" value="${escapeHtml(color)}" /></label></div>
        <div class="card-meta appearance-name"></div>
        <div class="btn-group" style="margin-top:8px"><button class="btn primary sm" data-act="save">Save</button></div>
      </div>
    </div>`;
  const big = makeChar(); big.classList.add('pm-alive', 'pm-preview'); // color preview
  const small = makeChar({ compact: true }); small.classList.add('pm-alive', 'pm-preview');
  el.querySelector('.appearance-preview:not(.avatar-preview):not(.small)').appendChild(big);
  el.querySelector('.appearance-preview.small').appendChild(small);
  const row = el.querySelectorAll('.appearance-row')[1];
  const show = () => {
    window.PondMascot.setPalette(sel, color, row); // preview only (scoped), saved palette applies on Save
    el.querySelectorAll('.swatch[data-p]').forEach((b) => b.classList.toggle('on', b.dataset.p === sel));
    el.querySelector('.swatch.custom').classList.toggle('on', sel === 'custom');
    el.querySelector('.appearance-name').textContent = sel === 'custom' ? `Custom ${color}` : sel[0].toUpperCase() + sel.slice(1);
  };
  el.querySelectorAll('.swatch[data-p]').forEach((b) => { b.onclick = () => { sel = b.dataset.p; show(); window.PondMascot.act(big, 'jump'); }; });
  if (!usingImage) { const pv = el.querySelector('.avatar-preview'); const m = makeChar(); m.classList.add('pm-alive', 'pm-preview'); pv.appendChild(m); }
  const setChar = async (mode) => {
    await fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ui: { avatarMode: mode } }) }).catch(() => {});
    await refreshState();
    loadAppearancePanel();
  };
  el.querySelector('[data-act="icosa"]').onclick = () => setChar('icosa');
  el.querySelector('[data-act="upload"]').onchange = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { showToast('Please pick an image under 8 MB.'); return; }
    let dataUrl;
    try {
      // Photos are downscaled to 256px; GIF (animation) and SVG (vector) are kept as-is.
      dataUrl = /gif|svg/.test(f.type)
        ? await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = bad; r.readAsDataURL(f); })
        : await new Promise((ok, bad) => {
            const url = URL.createObjectURL(f); const img = new Image();
            img.onload = () => { const s = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight)); const c = document.createElement('canvas');
              c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
              URL.revokeObjectURL(url); ok(c.toDataURL('image/png')); };
            img.onerror = () => { URL.revokeObjectURL(url); bad(new Error('Could not read that image')); }; img.src = url;
          });
    } catch (err) { showToast(String(err.message || err)); return; }
    const r = await fetch('/api/appearance/avatar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl, circle: el.querySelector('[data-act="circle"]').checked }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { showToast(j.error || 'Upload failed'); return; }
    showToast('Avatar updated');
    await refreshState(); loadAppearancePanel();
  };
  const mascotBtn = el.querySelector('[data-act="mascot"]');
  if (mascotBtn) mascotBtn.onclick = async () => {
    if (usingImage) { await fetch('/api/appearance/avatar', { method: 'DELETE' }); showToast('Back to the Pond mascot'); await refreshState(); loadAppearancePanel(); return; }
    setChar('mascot');
  };
  el.querySelector('[data-act="circle"]').onchange = async (e) => {
    await fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ui: { avatarCircle: e.target.checked } }) });
    await refreshState(); loadAppearancePanel();
  };
  el.querySelector('.swatch.custom input').oninput = (e) => { sel = 'custom'; color = e.target.value; show(); };
  el.querySelector('[data-act="save"]').onclick = async () => {
    await fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ui: { mascotPalette: sel, mascotColor: sel === 'custom' ? color : '' } }) });
    showToast('Mascot color saved');
    refreshState();
  };
  show();
}

// ---------- Plugins tab ----------
async function loadPluginsPanel() {
  const el = $('#hubPluginsList');
  if (!el) return;
  const { plugins = [] } = await fetch('/api/plugins').then((r) => r.json()).catch(() => ({}));
  el.innerHTML = plugins.length ? '' : '<div class="empty">No plugins found in the <code>plugins/</code> folder.</div>';
  for (const p of plugins) {
    const c = document.createElement('div');
    c.className = 'hub-card';
    const state = p.active ? '<span class="pill">active</span>' : p.enabled ? '<span class="pill">error</span>' : '<span class="pill">off</span>';
    const fields = (p.settingsSchema || []).map((s) => {
      const v = p.settings?.[s.key] ?? '';
      const type = s.type === 'number' ? 'number' : s.type === 'password' ? 'password' : s.type === 'boolean' ? 'checkbox' : 'text';
      const attr = type === 'checkbox' ? (v ? 'checked' : '') : `value="${escapeHtml(String(v))}"`;
      return `<label>${escapeHtml(s.label || s.key)}<input type="${type}" data-key="${escapeHtml(s.key)}" ${attr} /></label>`;
    }).join('');
    c.innerHTML = `
      <div class="card-top"><span class="inline-icon-text">${icon('plug', 14)}<span>${escapeHtml(p.name)} <span class="card-meta">v${escapeHtml(p.version || '?')}</span></span></span>
        <label class="inline-icon-text" style="gap:6px;">${state}<input type="checkbox" data-act="toggle" ${p.enabled ? 'checked' : ''} /></label></div>
      <div class="card-text">${escapeHtml(p.description || '')}${p.author ? ` <span class="card-meta">— ${escapeHtml(p.author)}</span>` : ''}</div>
      ${p.error ? `<div class="plugin-err">${escapeHtml(p.error)}</div>` : ''}
      ${p.tools?.length ? `<div class="card-meta">Tools: ${p.tools.map(escapeHtml).join(', ')}</div>` : ''}
      ${p.routes?.length ? `<div class="card-meta">Routes: ${p.routes.map(escapeHtml).join(', ')}</div>` : ''}
      ${p.panel ? `<div class="plugin-panel msg-body"></div>` : ''}
      ${fields ? `<div class="plugin-settings">${fields}<div><button class="btn sm" data-act="save">Save settings</button></div></div>` : ''}`;
    if (p.panel) renderAssistantBody(c.querySelector('.plugin-panel'), p.panel);
    c.querySelector('[data-act="toggle"]').onchange = async (e) => {
      await fetch(`/api/plugins/${p.id}/enable`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: e.target.checked }) });
      loadPluginsPanel();
      refreshState();
    };
    const saveBtn = c.querySelector('[data-act="save"]');
    if (saveBtn) saveBtn.onclick = async () => {
      const values = {};
      c.querySelectorAll('.plugin-settings input[data-key]').forEach((i) => {
        if (i.type === 'password' && i.value === '••••••••') return; // unchanged secret
        values[i.dataset.key] = i.type === 'checkbox' ? i.checked : i.value;
      });
      await fetch(`/api/plugins/${p.id}/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) });
      showToast(`Saved ${p.name} settings`);
      loadPluginsPanel();
    };
    el.appendChild(c);
  }
}
$('#reloadPluginsBtn')?.addEventListener('click', async () => {
  await fetch('/api/plugins/reload', { method: 'POST' });
  showToast('Plugins reloaded');
  loadPluginsPanel();
});

// ---------- Skills tab ----------
async function loadSkillsPanel() {
  const el = $('#hubSkillsList');
  if (!el) return;
  const { skills = [] } = await fetch('/api/skills').then((r) => r.json()).catch(() => ({}));
  el.innerHTML = skills.length ? '' : '<div class="empty">No skills yet. After Pond builds a dashboard or report you like, say "save this as a skill".</div>';
  for (const s of skills) {
    const c = document.createElement('div');
    c.className = 'hub-card';
    c.innerHTML = `
      <div class="card-top"><span class="inline-icon-text">${icon('sparkles', 14)}<span>/${escapeHtml(s.name)}</span></span><span class="card-meta">${s.builtin ? '<span class="pill">built-in</span>' : s.overridesBuiltin ? '<span class="pill">customized</span>' : new Date(s.updatedAt).toLocaleDateString()}</span></div>
      <div class="card-text">${escapeHtml(s.description || '')}</div>
      ${s.files?.length ? `<div class="card-meta">Files: ${s.files.map(escapeHtml).join(', ')}</div>` : ''}
      <pre class="skill-md" hidden></pre>
      <div class="btn-group">
        <button class="btn primary sm" data-act="run">Run</button>
        <button class="btn sm" data-act="view">View</button>
        ${s.builtin ? '' : '<button class="btn danger sm" data-act="del">Delete</button>'}
      </div>`;
    c.querySelector('[data-act="run"]').onclick = () => { $('#hubModal').hidden = true; sendMessage(`/${s.name}`); };
    c.querySelector('[data-act="view"]').onclick = async () => {
      const pre = c.querySelector('.skill-md');
      if (pre.hidden && !pre.textContent) pre.textContent = (await fetch(`/api/skills/${s.name}`).then((r) => r.json())).markdown || '';
      pre.hidden = !pre.hidden;
    };
    const delBtn = c.querySelector('[data-act="del"]');
    if (delBtn) delBtn.onclick = async () => {
      if (!confirm(`Delete skill "${s.name}"?`)) return;
      await fetch(`/api/skills/${s.name}`, { method: 'DELETE' });
      loadSkillsPanel();
    };
    el.appendChild(c);
  }
}

// ---------- Sessions ----------
// Pinned chats sit at the top in the user's order (drag to reorder; drag a chat above the line to pin it, below to
// unpin). Every other chat is listed by recent activity. Double-click a title (or the pencil) to rename.
function sessionsKeyOf(data) {
  return `${(data.running || []).join(',')}|${(data.pinned || []).join(',')}|${(data.sessions || []).map((x) => `${x.id}:${x.updatedAt || ''}:${x.title || ''}`).join(',')}`;
}

const sessUi = { renamingId: null, dragging: false, pinned: [], suppressClick: 0 };

async function savePins(ids) {
  sessUi.pinned = ids;
  try {
    await fetch('/api/sessions/pins', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
  } catch (err) { console.error('save pins failed', err); }
  loadSessions({ force: true });
}

function startRename(row, s) {
  if (sessUi.renamingId) return;
  sessUi.renamingId = s.id;
  const titleBtn = row.querySelector('.title');
  const input = document.createElement('input');
  input.className = 'sess-rename';
  input.value = s.title || '';
  input.maxLength = 80;
  input.setAttribute('aria-label', 'Chat name');
  titleBtn.replaceWith(input);
  row.classList.add('renaming');
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const title = input.value.replace(/\s+/g, ' ').trim();
    if (save && title && title !== s.title) {
      try {
        await fetch(`/api/sessions/${s.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
      } catch (err) { console.error('rename failed', err); }
    }
    sessUi.renamingId = null;
    loadSessions({ force: true });
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

function attachSessionDrag(row, list) {
  row.addEventListener('contextmenu', (e) => { if (e.pointerType === 'touch' || sessUi.dragging) e.preventDefault(); });
  row.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || sessUi.renamingId || e.target.closest('.sess-act')) return;
    const touch = e.pointerType !== 'mouse';
    const startY = e.clientY, startX = e.clientX;
    let active = false, timer = null, scrollTimer = null, lastY = startY;
    const begin = () => {
      active = true;
      sessUi.dragging = true;
      list.classList.add('dragging');
      row.classList.add('drag-row');
      try { row.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (touch && navigator.vibrate) navigator.vibrate(10);
      scrollTimer = setInterval(() => {
        const r = list.getBoundingClientRect();
        if (lastY < r.top + 24) list.scrollTop -= 6;
        else if (lastY > r.bottom - 24) list.scrollTop += 6;
      }, 16);
    };
    if (touch) timer = setTimeout(begin, 380);
    const place = (y) => {
      const others = [...list.children].filter((el) => el !== row && (el.classList.contains('session-item') || el.classList.contains('sess-sep')));
      const before = others.find((el) => { const r = el.getBoundingClientRect(); return y < r.top + r.height / 2; });
      if (before) { if (row.nextElementSibling !== before) list.insertBefore(row, before); }
      else if (list.lastElementChild !== row) list.appendChild(row);
    };
    const move = (ev) => {
      lastY = ev.clientY;
      if (!active) {
        const moved = Math.max(Math.abs(ev.clientY - startY), Math.abs(ev.clientX - startX));
        if (touch) { if (moved > 8) cleanup(); return; } // finger moved first: it's a scroll
        if (Math.abs(ev.clientY - startY) < 6) return;
        begin();
      }
      ev.preventDefault();
      place(ev.clientY);
    };
    const up = () => {
      const wasActive = active;
      cleanup();
      if (!wasActive) return;
      sessUi.suppressClick = Date.now();
      const ids = [];
      for (const el of list.children) {
        if (el.classList.contains('sess-sep')) break;
        if (el.dataset.id) ids.push(el.dataset.id);
      }
      if (ids.join(',') !== sessUi.pinned.join(',')) savePins(ids);
      else loadSessions({ force: true }); // dropped among recent chats: snap back to recency order
    };
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(scrollTimer);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      if (active) {
        list.classList.remove('dragging');
        row.classList.remove('drag-row');
        sessUi.dragging = false;
      }
      active = false;
    };
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  });
}

async function loadSessions({ force = false } = {}) {
  try {
    if (sessUi.renamingId || sessUi.dragging) return; // don't rebuild the list under the user's hands
    const resp = await fetch('/api/sessions', { cache: 'no-store' });
    const data = await resp.json();
    if (sessUi.renamingId || sessUi.dragging) return;
    const dataKey = sessionsKeyOf(data);
    const renderKey = `${dataKey}#${currentSessionId || ''}`;
    if (!force && renderKey === lastSessionsDataKey) return;
    lastSessionsDataKey = renderKey;
    const list = $('#sessionList');
    const sessions = data.sessions || [];
    if (!sessions.length) {
      list.innerHTML = '<div class="empty">No chats yet</div>';
      return;
    }
    const byId = new Map(sessions.map((s) => [s.id, s]));
    sessUi.pinned = (data.pinned || []).filter((id) => byId.has(id));
    const pinnedSet = new Set(sessUi.pinned);
    const runningSet = new Set(data.running || []); // chats with a reply in progress
    const ordered = [...sessUi.pinned.map((id) => byId.get(id)), ...sessions.filter((s) => !pinnedSet.has(s.id))];
    if (!list.dataset.touchGuard) {
      list.dataset.touchGuard = '1';
      // Once a long-press drag has started, stop the list (and page) from scrolling under the finger.
      list.addEventListener('touchmove', (e) => { if (sessUi.dragging) e.preventDefault(); }, { passive: false });
    }
    list.innerHTML = '';
    list.classList.toggle('has-pins', sessUi.pinned.length > 0);
    ordered.forEach((s, i) => {
      const pinned = pinnedSet.has(s.id);
      if (i === sessUi.pinned.length) {
        const sep = document.createElement('div');
        sep.className = 'sess-sep';
        sep.innerHTML = '<span>Drop above to pin</span>';
        list.appendChild(sep);
      }
      const row = document.createElement('div');
      row.className = 'session-item' + (s.id === currentSessionId ? ' active' : '') + (pinned ? ' pinned' : '') + (runningSet.has(s.id) ? ' running' : '');
      row.dataset.id = s.id;
      const title = document.createElement('button');
      title.className = 'title';
      title.textContent = s.title || 'New chat';
      title.title = `${new Date(s.updatedAt).toLocaleString()} · double-click to rename`;
      title.onclick = () => { if (Date.now() - sessUi.suppressClick > 300) switchSession(s.id); };
      title.ondblclick = (e) => { e.preventDefault(); startRename(row, s); };
      const act = (name, label, cls, fn) => {
        const b = document.createElement('button');
        b.className = `sess-act ${cls}`;
        b.innerHTML = icon(name, 13);
        b.title = label;
        b.setAttribute('aria-label', label);
        b.onclick = (e) => { e.stopPropagation(); fn(); };
        return b;
      };
      const pinBtn = act('pin', pinned ? 'Unpin' : 'Pin to top', 'pin' + (pinned ? ' on' : ''), () => {
        savePins(pinned ? sessUi.pinned.filter((id) => id !== s.id) : [...sessUi.pinned, s.id]);
      });
      const renBtn = act('pencil', 'Rename', 'ren', () => startRename(row, s));
      const del = act('close', 'Delete chat', 'del', async () => {
        await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' });
      });
      row.append(title, pinBtn, renBtn, del);
      attachSessionDrag(row, list);
      list.appendChild(row);
    });
    if (sessUi.pinned.length === ordered.length) {
      const sep = document.createElement('div');
      sep.className = 'sess-sep';
      sep.innerHTML = '<span>Drop above to pin</span>';
      list.appendChild(sep);
    }
  } catch (err) {
    console.error('loadSessions failed', err);
  }
}

// A reply that was shown live has been saved: take the saved copy (history, footers) without redrawing the chat —
// a redraw re-lays out steps and thinking, reloads embeds and jumps the scroll. Returns null when a redraw is needed.
function adoptSavedTurn(data, key) {
  const rc = renderedConv;
  if (!rc.liveTail || attachedTurn || data.activeTurn) return null;
  if (!data.sessionId || data.sessionId !== rc.sessionId || data.sessionId !== currentSessionId) return null;
  const msgs = data.messages || [];
  const tail = msgs.slice(rc.count);
  const turnPart = rc.expectUser ? tail.slice(1) : tail;
  if (rc.expectUser && tail.length && !(tail[0].role === 'user' && !tail[0].toolImage)) return null;
  const onlyTurn = turnPart.every((m) => !m.proactive && !m.cancelled && (m.role === 'assistant' || m.role === 'tool' || (m.role === 'user' && m.toolImage)));
  if (!onlyTurn) return null; // something else arrived meanwhile (a check-in, another device): redraw
  const finalMsg = [...turnPart].reverse().find((m) => m.role === 'assistant' && String(m.content || '').trim());
  if (!finalMsg) {
    // not saved yet: look again on the next sync; if it never shows up (an error), redraw after a while
    return rc.finishedAt && Date.now() - rc.finishedAt > 8000 ? null : false;
  }
  if (finalMsg.pluginFooters && rc.liveBody?.isConnected) setMessageFooter(rc.liveBody, finalMsg.pluginFooters);
  history = [];
  for (const m of msgs) {
    if (m.role === 'user' && !m.toolImage && !m.cancelled) history.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant' && String(m.content || '').trim()) history.push({ role: 'assistant', content: m.content });
  }
  renderedConv = { sessionId: data.sessionId, count: msgs.length, liveTail: false, expectUser: false, liveBody: null, finishedAt: 0 };
  lastRenderedSessionKey = key;
  return false;
}

async function loadConversation({ force = true, silent = false } = {}) {
  try {
    let resp = await fetch(`/api/conversation${chatQs()}`, { cache: 'no-store' });
    if (resp.status === 404 && currentSessionId) { // this window's chat was deleted: go to the chat used last
      setCurrentSession(null);
      detachTurnView();
      lastRenderedSessionKey = '';
      force = true;
      resp = await fetch('/api/conversation', { cache: 'no-store' });
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const key = `${data.sessionId || ''}|${data.updatedAt || ''}|${(data.messages || []).length}`;
    if (!force && key === lastRenderedSessionKey) return false;
    if (!force) {
      const soft = adoptSavedTurn(data, key);
      if (soft !== null) return soft;
    }

    const wasNearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
    detachTurnView(); // the DOM is rebuilt below; a running turn is re-attached from the server afterwards
    if (data.sessionId !== currentSessionId) detachTurnView();
    setCurrentSession(data.sessionId || null);
    lastRenderedSessionKey = key;
    history = [];
    messagesEl.innerHTML = '';
    for (const m of data.messages || []) {
      if (m.role === 'tool') {
        let parsedRes = m.content;
        try { parsedRes = JSON.parse(m.content); } catch { /* raw string */ }
        addToolTrace(m.name || 'tool', m.args || {}, parsedRes);
        continue;
      }
      if (m.role === 'assistant') {
        const hasText = typeof m.content === 'string' && m.content.trim().length > 0;
        if (!hasText && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          if (m.reasoning) {
            const wrap = document.createElement('div');
            wrap.className = 'thought-step';
            addThoughtBlock(wrap, m.reasoning, { open: false, label: 'Thought' });
            messagesEl.appendChild(wrap);
          }
          continue;
        }
        history.push({ role: 'assistant', content: m.content || '' });
        const bodyEl = addMessage('assistant', '', { proactive: !!m.proactive, tag: m.tag || '' });
        if (m.ts) bodyEl.closest('.msg-row').dataset.ts = m.ts;
        if (m.reasoning) addThoughtBlock(bodyEl.closest('.bubble'), m.reasoning, { open: false, label: 'Thought' });
        renderAssistantBody(bodyEl, m.content || '');
        if (m.pluginFooters) setMessageFooter(bodyEl, m.pluginFooters);
      } else if (m.role === 'user' && m.toolImage) {
        // A picture a tool showed the AI (an image file it read, a browser/Blender screenshot): part of the steps.
        const wrap = document.createElement('div');
        wrap.className = 'tool-trace tool-image';
        wrap.innerHTML = `<div class="tool-image-label">${icon('eye', 12)}<span>${escapeHtml(String(m.content || '').replace(/^\[|\]$/g, ''))}</span></div>`;
        for (const img of m.images || []) {
          const a = document.createElement('a');
          a.href = img.url; a.target = '_blank'; a.rel = 'noopener';
          a.innerHTML = `<img src="${escapeHtml(img.url)}" alt="" loading="lazy">`;
          wrap.appendChild(a);
        }
        messagesEl.appendChild(wrap);
      } else if (m.role === 'user') {
        if (!m.cancelled) history.push({ role: 'user', content: m.content });
        const body = addMessage('user', m.content);
        if (m.ts) body.closest('.msg-row').dataset.ts = m.ts;
        appendMessageImages(body, (m.images || []).map((i) => i.url));
        if (m.cancelled) markStopped(body);
      }
    }
    renderedConv = { sessionId: data.sessionId || null, count: (data.messages || []).length, liveTail: false, expectUser: false, liveBody: null, finishedAt: 0 };
    if (!(data.messages || []).length && !data.activeTurn) showGreeting();
    if (force || wasNearBottom) scrollToLatest(true); else updateJumpBtn();
    if (data.activeTurn) attachToTurn(data.activeTurn); // reply still running (switched back / reopened / other device)
    return true;
  } catch (err) {
    if (!silent) {
      console.error('loadConversation failed', err);
      if (!messagesEl.children.length) showGreeting();
    }
    return false;
  }
}

// Cheap cross-device sync: ask the server for fingerprints, fetch full data only if something changed.
let syncInFlight = false;
async function syncAll() {
  if (syncInFlight || document.visibilityState === 'hidden') return false;
  syncInFlight = true;
  try {
    const resp = await fetch(`/api/sync${chatQs()}`, { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const s = await resp.json();
    if (s.rev) lastSyncRev = s.rev;
    let changed = false;
    // Don't re-render the conversation mid-stream — it would wipe the live bubble.
    if (!busy && s.conversationKey !== lastRenderedSessionKey) {
      changed = await loadConversation({ force: false, silent: true });
    }
    if (`${s.sessionsKey}#${currentSessionId || ''}` !== lastSessionsDataKey) await loadSessions();
    return changed;
  } catch {
    return false;
  } finally {
    syncInFlight = false;
  }
}

// Runs on a timer and whenever the app comes back to the foreground / online.
function syncTick() {
  if (document.visibilityState === 'hidden') return;
  // 1) Dead or silent SSE (phone slept, Wi-Fi <-> cellular, Tailscale reconnect) -> reconnect.
  if (!eventSource || eventSource.readyState === 2 || Date.now() - lastSseAt > SSE_STALE_MS) {
    connectEvents();
  }
  // 2) Our chat stream went silent (iOS froze the fetch) -> abort it so `busy` can't block syncing.
  if (busy && activeChatAbort && lastStreamAt && Date.now() - lastStreamAt > STREAM_STALL_MS) {
    streamStalled = true;
    try { activeChatAbort.abort(); } catch { /* ignore */ }
  }
  // 3) Pull anything we missed.
  syncAll();
}

function scheduleSyncRecovery() {
  for (const delay of [1500, 4000, 8000, 15000]) {
    setTimeout(() => {
      if (!busy) {
        loadConversation({ force: false, silent: true }).then((changed) => {
          if (changed) { loadSessions(); refreshState(); }
        });
      }
    }, delay);
  }
}

async function switchSession(id) {
  if (id === currentSessionId) { document.body.classList.remove('sidebar-open'); return; }
  detachTurnView(); // the reply in the chat we're leaving keeps running on the server
  fetch('/api/sessions/activate', { // only marks it "used last"; other windows don't follow
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  }).catch(() => {});
  setCurrentSession(id);
  lastRenderedSessionKey = '';
  await loadConversation();
  refreshState(); // this chat's model and context use
  loadSessions();
  document.body.classList.remove('sidebar-open');
}

function showGreeting() {
  renderAssistantBody(
    addMessage('assistant', ''),
    `Hi, I'm **${assistantName}** — your proactive personal AI assistant.\n\nI watch your inbox for important emails, manage your agenda & things to do, send instant browser notifications, and proactively suggest events and plans for your day. Open **Agent Hub** in the top-right to connect your email or calendar, or just tell me what's on your mind.`
  );
}

// ---------- Live SSE Stream (with missed-notification replay!) ----------
let sseEverOpened = false;
function connectEvents() {
  if (eventSource) { try { eventSource.close(); } catch { /* ignore */ } }
  const qs = lastNotifSeq ? `?since=${lastNotifSeq}` : '';
  const es = new EventSource(`/api/events${qs}`);
  eventSource = es;
  lastSseAt = Date.now(); // grace period while connecting
  es.onopen = () => {
    lastSseAt = Date.now();
    if (sseEverOpened) {
      // Reconnected after mobile sleep/network switch — pull any missed messages immediately!
      syncAll();
      refreshState();
    }
    sseEverOpened = true;
  };
  es.onmessage = (e) => {
    if (es !== eventSource) return; // stale connection
    lastSseAt = Date.now();
    let payload;
    try { payload = JSON.parse(e.data); } catch { return; }

    if (payload.type === 'hello') resyncPushSubscription();
    if (payload.type === 'ping' || payload.type === 'hello') {
      // Heartbeat: if the server's revision moved without us seeing the event, resync.
      if (payload.rev && lastSyncRev && payload.rev !== lastSyncRev) syncAll();
      if (payload.rev) lastSyncRev = payload.rev;
      if (payload.type === 'ping') return;
    } else if (payload.rev) {
      lastSyncRev = payload.rev;
    }

    if (payload.type === 'message') {
      if (payload.sessionId && payload.sessionId !== currentSessionId) { loadSessions(); return; }
      if (payload.clientId && payload.clientId === clientId) { loadSessions(); return; }
      // a reply this tab is showing live (attached from another device): already on screen
      if (payload.role === 'assistant' && (attachedTurn || renderedConv.liveTail)) { loadSessions(); return; }
      history.push({ role: payload.role, content: payload.content });
      if (payload.role === 'assistant') {
        const bodyEl = addMessage('assistant', '');
        renderAssistantBody(bodyEl, payload.content);
      } else {
        appendMessageImages(addMessage('user', payload.content), payload.images || []);
      }
      loadSessions();
      return;
    }

    if (payload.type === 'sessions') {
      loadSessions();
      if (payload.deleted && payload.deleted === currentSessionId) loadConversation({ force: true }); // falls back to another chat
      return;
    }
    if (payload.type === 'settings_updated') { refreshState(); if (!$('#hubModal').hidden) loadAppearancePanel(); return; }
    if (payload.type === 'turn_started') {
      if (payload.sessionId === currentSessionId && payload.clientId !== clientId && !attachedTurn) attachToTurn({ requestId: payload.requestId, startedAt: Date.now() });
      loadSessions(); // mark the chat as running
      return;
    }
    if (payload.type === 'turn_finished') { loadSessions(); return; } // attached views end via their own stream
    if (payload.type === 'plugin_ui') {
      if (payload.slot === 'status') renderPluginStatus(payload.items || []);
      if (payload.slot === 'footer') {
        const b = bubbleByRequest.get(payload.requestId);
        if (b) setMessageFooter(b, { [payload.pluginId]: payload.text });
      }
      return;
    }
    if (payload.type === 'plugins_updated') { if (!$('#hubModal').hidden) loadPluginsPanel(); fetch('/api/plugins/ui').then((r) => r.json()).then((u) => renderPluginStatus(u.status)).catch(() => {}); return; }
    if (payload.type === 'skills_updated') { refreshSkillCache(); if (!$('#hubModal').hidden) loadSkillsPanel(); return; }
    if (payload.type === 'session_switched') return; // windows choose their own chat
    if (payload.type === 'chat_llm') { if (payload.sessionId === currentSessionId) refreshState(); return; }

    if (payload.type === 'proactive' && payload.routine) {
      if (payload.sessionId === currentSessionId && !attachedTurn) { lastRenderedSessionKey = ''; loadConversation({ force: false, silent: true }); }
      loadSessions();
      refreshState();
      return;
    }
    if (payload.type === 'sessions_updated') { loadSessions(); if (payload.sessionId === currentSessionId) loadConversation({ force: false, silent: true }); return; }
    if (payload.type === 'proactive') {
      if (!payload.sessionId || payload.sessionId === currentSessionId) {
        const bodyEl = addMessage('assistant', '', { proactive: true, tag: payload.tag || '' });
        renderAssistantBody(bodyEl, payload.text);
        history.push({ role: 'assistant', content: payload.text });
      }
      loadSessions();
      refreshState();
      return;
    }

    if (payload.type === 'notification' && payload.notification) {
      const n = payload.notification;
      if (n.seq && n.seq > lastNotifSeq) {
        lastNotifSeq = n.seq;
        localStorage.setItem('pond_last_notif_seq', String(lastNotifSeq));
      }
      if (!payload.replay) {
        showToast(`${n.title}: ${n.body}`);
        fireDesktopNotification(n);
      }
      refreshState();
      if (!$('#notifDrawer').hidden) loadNotificationsDrawer();
      return;
    }

    if (payload.type === 'notifications_updated') {
      refreshState();
      if (!$('#notifDrawer').hidden) loadNotificationsDrawer();
      return;
    }

    if (payload.type === 'job_started' || payload.type === 'job_finished') {
      if (payload.type === 'job_started' && !runningJobsInfo.some((x) => x.id === payload.jobId)) runningJobsInfo.push({ id: payload.jobId, name: payload.name, startedAt: payload.startedAt || Date.now() });
      if (payload.type === 'job_finished') runningJobsInfo = runningJobsInfo.filter((x) => x.id !== payload.jobId);
      renderActivityStrip();
      if (payload.type === 'job_finished') {
        pendingJobRuns.delete(payload.jobId);
        if (payload.status === 'error') showToast(`Routine "${payload.name}" failed: ${payload.error || 'error'}`);
      }
      refreshState();
      return;
    }
    if (payload.type === 'proactive_status') {
      const pill = $('#proactivePill');
      pill.classList.toggle('active', Boolean(payload.running));
      if (payload.running && payload.phase) $('#proactivePillText').textContent = payload.phase;
      else refreshState();
      return;
    }

    if (payload.type === 'approval_required' || payload.type === 'approval_resolved') {
      refreshState();
      return;
    }

    if (payload.type === 'email_alert' || payload.type === 'emails_updated') {
      refreshState();
      if (!$('#emailDrawer').hidden) loadEmailDrawer();
      return;
    }

    if (payload.type === 'session_compacted') {
      showToast(`Chat compacted (${payload.folded} older messages summarized)`);
      loadConversation();
      refreshState();
      return;
    }

    if (payload.type === 'ms365_auth') {
      if (payload.status === 'connected') {
        showToast(`Microsoft 365 connected (${payload.accountEmail || 'ready'})!`);
      } else if (payload.status === 'error') {
        showToast(`Microsoft 365 sign-in error: ${payload.error || 'failed'}`);
      }
      refreshState();
      if (!$('#hubModal').hidden) loadHubData();
      return;
    }

    if (payload.type === 'memory_updated') {
      refreshState();
      if (!$('#memDrawer').hidden) {
        if (payload.running && memUi.data?.dream) { memUi.data.dream.running = true; renderMemoryControls(); }
        else loadMemoryDrawer();
      }
      return;
    }
    if (payload.type === 'calendar_updated') {
      if (!$('#calDrawer').hidden && $('#calForm').hidden) loadCalendar();
      refreshState();
      return;
    }
    if (payload.type === 'reminder') {
      refreshState();
    }
  };
  es.onerror = () => { /* EventSource auto-reconnects */ };
}

// ---------- Wiring ----------
composer.addEventListener('submit', (e) => {
  e.preventDefault();
  // A reply still attached from another chat must never be stopped by sending here: let go of it and send.
  if (attachedTurn && attachedTurn.sessionId !== currentSessionId) detachTurnView();
  if (busy && activeChatAbort) {
    if (attachedTurn) attachedTurn.stopRequested = true;
    if (activeRequestId) {
      fetch('/api/chat/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: activeRequestId }),
      }).catch(() => {});
    }
    activeChatAbort.abort();
    return;
  }
  sendMessage(input.value);
});
// ---------- Slash-command completion for skills (/name + Tab) ----------
let skillCache = [];
let slashMatches = [];
let slashIndex = 0;
async function refreshSkillCache() {
  try { skillCache = (await fetch('/api/skills', { cache: 'no-store' }).then((r) => r.json())).skills || []; } catch { /* keep old */ }
}
function slashQuery() {
  // Only while the message is just "/partial" (before the first space).
  const m = input.value.match(/^\/([a-z0-9-]*)$/i);
  return m ? m[1].toLowerCase() : null;
}
function closeSlashMenu() { slashMatches = []; $('#slashMenu').hidden = true; }
function renderSlashMenu() {
  const q = slashQuery();
  if (q === null || !skillCache.length) return closeSlashMenu();
  const starts = skillCache.filter((s) => s.name.startsWith(q));
  const contains = skillCache.filter((s) => !s.name.startsWith(q) && (s.name.includes(q) || (s.description || '').toLowerCase().includes(q)));
  slashMatches = [...starts, ...contains].slice(0, 8);
  if (!slashMatches.length) return closeSlashMenu();
  slashIndex = Math.min(slashIndex, slashMatches.length - 1);
  const menu = $('#slashMenu');
  menu.innerHTML = slashMatches.map((s, i) => `
    <div class="slash-item${i === slashIndex ? ' active' : ''}" role="option" data-i="${i}">
      <span class="slash-name">/${escapeHtml(s.name)}</span><span class="slash-desc">${escapeHtml(s.description || '')}</span>
    </div>`).join('') + '<div class="slash-hint">Tab / Enter to complete · ↑↓ to choose · Esc to close</div>';
  menu.querySelectorAll('.slash-item').forEach((el) => {
    el.addEventListener('mousedown', (ev) => { ev.preventDefault(); acceptSlash(Number(el.dataset.i)); });
  });
  menu.hidden = false;
}
function acceptSlash(i = slashIndex) {
  const s = slashMatches[i];
  if (!s) return;
  input.value = `/${s.name} `; // trailing space lets you add details, e.g. "/mission-control-dashboard for this week"
  closeSlashMenu();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

input.addEventListener('keydown', (e) => {
  if (!$('#slashMenu').hidden && slashMatches.length) {
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); acceptSlash(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); slashIndex = (slashIndex + 1) % slashMatches.length; renderSlashMenu(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); slashIndex = (slashIndex - 1 + slashMatches.length) % slashMatches.length; renderSlashMenu(); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeSlashMenu(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input.value); }
});
// Grow the composer with its content. box-sizing is border-box, so add the border back:
// using scrollHeight alone left it 2px short and showed a scrollbar even for one line.
function autoGrowInput() {
  input.style.height = 'auto';
  const border = input.offsetHeight - input.clientHeight;
  const full = input.scrollHeight + border;
  input.style.height = Math.min(full, 180) + 'px';
  input.style.overflowY = full > 180 ? 'auto' : 'hidden'; // scrollbar only when really needed
}
input.addEventListener('input', () => {
  autoGrowInput();
  if (input.value === '/') { slashIndex = 0; refreshSkillCache().then(renderSlashMenu); }
  renderSlashMenu();
});
input.addEventListener('blur', () => setTimeout(closeSlashMenu, 150));
refreshSkillCache();
fetch('/api/plugins/ui').then((r) => r.json()).then((u) => renderPluginStatus(u.status)).catch(() => {});

$('#themeBtn').addEventListener('click', () => {
  applyTheme(prefs.theme === 'dark' ? 'light' : 'dark');
});

async function continueInNewChat(text, tag = '') {
  const first = String(text).replace(/[#*_`>\[\]]/g, '').replace(/\s+/g, ' ').trim();
  const title = `↳ ${first.slice(0, 50)}${first.length > 50 ? '…' : ''}`;
  try {
    const r = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, carry: { content: text, tag, at: new Date().toISOString() } }) });
    const { session } = await r.json();
    detachTurnView();
    await switchSession(session.id);
    input.focus();
  } catch {
    showToast('Could not start a new chat');
  }
}

// Open a fresh chat with a title and send the first message in it.
async function startChatWith(title, text) {
  try {
    const r = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
    const { session } = await r.json();
    detachTurnView(); // a reply running in the chat we leave keeps going on the server
    setCurrentSession(session.id);
    lastRenderedSessionKey = '';
    history = [];
    messagesEl.innerHTML = '';
    loadSessions();
    document.body.classList.remove('sidebar-open');
    await sendMessage(text);
  } catch {
    showToast('Could not start a new chat');
  }
}

$('#newChatBtn').addEventListener('click', async () => {
  try {
    detachTurnView(); // a reply running in the chat we leave keeps going on the server — and the send button is ours again
    const { session } = await fetch('/api/sessions', { method: 'POST' }).then((r) => r.json());
    const data = { sessionId: session.id };
    setCurrentSession(session.id);
    lastRenderedSessionKey = '';
    renderedConv = { sessionId: data.sessionId || null, count: 0, liveTail: false, expectUser: false, liveBody: null, finishedAt: 0 };
    history = [];
    messagesEl.innerHTML = '';
    showGreeting();
    loadSessions();
    refreshState();
  } catch {
    showToast('Could not create a new chat');
  }
  document.body.classList.remove('sidebar-open');
});

$('#menuBtn').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
$('#backdrop').addEventListener('click', () => document.body.classList.remove('sidebar-open'));

$('#syncChatBtn').addEventListener('click', async () => {
  showToast('Syncing messages…');
  await Promise.all([loadConversation({ force: true }), loadSessions(), refreshState()]);
  showToast('Synced!');
});

$('#checkInBtn').addEventListener('click', async () => {
  showToast(`Asking ${assistantName} to check emails & agenda now…`);
  try { await fetch('/api/proactive/check', { method: 'POST' }); } catch { /* offline */ }
});

$('#notifBtn').addEventListener('click', async () => {
  if ('Notification' in window && Notification.permission === 'default') {
    await requestBrowserNotifPermission();
  }
  if ($('#notifDrawer').hidden) openDrawer('notifDrawer');
  else closeAllDrawers();
});
$('#enableNotifBannerBtn').addEventListener('click', requestBrowserNotifPermission);
$('#dismissNotifBannerBtn').addEventListener('click', () => {
  sessionStorage.setItem('pond_banner_dismissed', '1');
  $('#notifBanner').hidden = true;
});
$('#reqNotifBtn').addEventListener('click', requestBrowserNotifPermission);
$('#testNotifBtn').addEventListener('click', async () => {
  if ('Notification' in window && Notification.permission === 'default') {
    await requestBrowserNotifPermission();
  }
  await fetch('/api/notifications/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
});
$('#soundToggle').addEventListener('change', (e) => { prefs.sound = e.target.checked; });
$('#muteToggle').addEventListener('change', (e) => { prefs.mute = e.target.checked; if (pushActive) ensurePushSubscription(); });
$('#attachBtn').addEventListener('click', () => $('#attachInput').click());
$('#attachInput').addEventListener('change', async (e) => { await addImageFiles(e.target.files); e.target.value = ''; input.focus(); });
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.items || [])].filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
  if (files.some((f) => f.type.startsWith('image/'))) { e.preventDefault(); addImageFiles(files); }
});
composer.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); composer.classList.add('drag-over'); } });
composer.addEventListener('dragleave', () => composer.classList.remove('drag-over'));
composer.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); composer.classList.remove('drag-over'); addImageFiles(e.dataTransfer.files); } });
$('#testPushBtn').addEventListener('click', async () => {
  const r = await fetch('/api/push/test', { method: 'POST' }).then((x) => x.json()).catch(() => ({ ok: false, results: [] }));
  const bad = (r.results || []).filter((x) => !x.ok);
  showToast(r.ok ? `Push sent to ${(r.results || []).length - bad.length} device(s)${bad.length ? `, ${bad.length} failed` : ''}` : 'Push failed — check Activity log');
});
$('#markAllReadBtn').addEventListener('click', async () => {
  await fetch('/api/notifications/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) });
  loadNotificationsDrawer();
});
$('#clearNotifBtn').addEventListener('click', async () => {
  await fetch('/api/notifications', { method: 'DELETE' });
  loadNotificationsDrawer();
});

$('#calBtn').addEventListener('click', () => {
  if ($('#calDrawer').hidden) openDrawer('calDrawer');
  else closeAllDrawers();
});
$('#openCalLink').addEventListener('click', () => { document.body.classList.remove('sidebar-open'); openDrawer('calDrawer'); });
$('#emailBtn').addEventListener('click', () => {
  if ($('#emailDrawer').hidden) openDrawer('emailDrawer');
  else closeAllDrawers();
});
$('#syncEmailBtn').addEventListener('click', async () => {
  showToast('Syncing & triaging inbox…');
  const r = await fetch('/api/emails/sync', { method: 'POST' }).then((x) => x.json());
  if (r.lastError) showToast(`Email sync error: ${r.lastError}`);
  else showToast(`Inbox synced (${r.checked || 0} triaged, ${r.alerted || 0} alerts)`);
  loadEmailDrawer();
  refreshState();
});
$('#simEmailBtn').addEventListener('click', async () => {
  showToast('Simulating an urgent incoming email for AI triage…');
  await fetch('/api/emails/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'United Airlines <notifications@united.com>',
      subject: 'Action Required: Flight UA 418 Gate Change & Earlier Boarding',
      body: 'Heads up! Your upcoming flight UA 418 departure has moved 35 minutes earlier and changed to Gate B14. Please check in before 4:30 PM today.',
      source: 'test-simulation',
    }),
  });
  loadEmailDrawer();
  refreshState();
});
$('#dismissAllEmailBtn').addEventListener('click', async () => {
  await fetch('/api/emails/dismiss-all', { method: 'POST' });
  showToast('All email alerts dismissed');
  loadEmailDrawer();
  refreshState();
});
$('#configEmailJumpBtn').addEventListener('click', () => openHub('email'));

$('#approvalsBtn').addEventListener('click', () => {
  $('#sentinelBanner').scrollIntoView({ behavior: 'smooth' });
});

$('#hubBtn').addEventListener('click', () => openHub('proactive'));
$('#openHubFooter').addEventListener('click', () => openHub('proactive'));

$$('.close-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.close;
    if (id) $(`#${id}`).hidden = true;
  });
});
$('#hubModal').addEventListener('click', (e) => {
  if (e.target === $('#hubModal')) $('#hubModal').hidden = true;
});
$$('#hubTabs .tab').forEach((t) => t.addEventListener('click', () => switchHubTab(t.dataset.tab)));

// LLM Engine: Add / Switch / Save / Delete / Test Profiles + Raw llm.json
const LLM_PROVIDER_PRESETS = {
  ollama: { label: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
  lmstudio: { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
  vllm: { label: 'vLLM', baseUrl: 'http://localhost:8000/v1' },
  sglang: { label: 'SGLang', baseUrl: 'http://localhost:30000/v1' },
  llamacpp: { label: 'llama.cpp', baseUrl: 'http://localhost:8080/v1' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  custom: { label: '', baseUrl: '' },
};

// Ask the server which models it serves and offer them in the Model ID field (datalist).
async function findServerModels({ urlEl, keyEl, modelEl, listEl, hintEl, profileKey = null }) {
  const baseUrl = urlEl.value.trim();
  if (!/^https?:\/\//i.test(baseUrl)) { hintEl.textContent = ''; return; }
  hintEl.textContent = 'Looking for models…';
  try {
    const r = await fetch('/api/llm/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl, apiKey: keyEl.value.trim(), profileKey }) }).then((x) => x.json());
    if (!r.ok) { hintEl.textContent = `Can't reach it yet — ${String(r.error || 'no answer').slice(0, 80)}`; hintEl.dataset.state = 'bad'; return; }
    const models = r.sampleModels || [];
    listEl.innerHTML = models.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
    if (models.length && !modelEl.value.trim()) modelEl.value = models[0];
    hintEl.textContent = models.length ? `✓ Connected — ${r.modelsCount ?? models.length} model${(r.modelsCount ?? models.length) === 1 ? '' : 's'} found` : '✓ Connected';
    hintEl.dataset.state = 'good';
  } catch (e) { hintEl.textContent = ''; }
}
const newProfFinder = () => findServerModels({ urlEl: $('#newProfBaseUrl'), keyEl: $('#newProfApiKey'), modelEl: $('#newProfModel'), listEl: $('#newProfModelList'), hintEl: $('#newProfFound') });
$('#newProfBaseUrl').addEventListener('change', newProfFinder);
$('#newProfApiKey').addEventListener('change', newProfFinder);
$('#llmBaseUrl').addEventListener('change', () => findServerModels({ urlEl: $('#llmBaseUrl'), keyEl: $('#llmApiKey'), modelEl: $('#llmModel'), listEl: $('#llmModelList'), hintEl: $('#llmFound'), profileKey: $('#llmActiveProfile').value }));

$('#toggleNewProfileBtn').addEventListener('click', () => {
  const panel = $('#newProfilePanel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) $('#newProfKey').focus();
});
$('#cancelNewProfileBtn').addEventListener('click', () => {
  $('#newProfilePanel').hidden = true;
});
$('#newProfPreset').addEventListener('change', (e) => {
  const p = LLM_PROVIDER_PRESETS[e.target.value];
  if (!p) return;
  $('#newProfLabel').value = p.label;
  $('#newProfBaseUrl').value = p.baseUrl;
  $('#newProfModel').value = p.model || '';
  $('#newProfModelList').innerHTML = '';
  $('#newProfFound').textContent = '';
  if (p.baseUrl) newProfFinder();
  else $('#newProfBaseUrl').focus();
});

$('#createProfileBtn').addEventListener('click', async () => {
  if (!latestLlmConfig) await loadHubData();
  const slug = (v) => String(v || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const model = $('#newProfModel').value.trim();
  const baseUrl = $('#newProfBaseUrl').value.trim();
  if (!model || !baseUrl) { showToast('Server URL and Model ID are required.'); return; }
  const profiles = structuredClone(latestLlmConfig?.profiles || {});
  // Profile ID is optional: derive it from the label / provider / model, and never overwrite an existing one by accident
  let rawKey = slug($('#newProfKey').value) || slug($('#newProfLabel').value) || slug($('#newProfPreset').value) || slug(model.split('/').pop()) || 'model';
  if (!slug($('#newProfKey').value)) { const base = rawKey; let n = 2; while (profiles[rawKey]) rawKey = `${base}-${n++}`; }

  profiles[rawKey] = {
    label: $('#newProfLabel').value.trim() || rawKey,
    baseUrl,
    apiKey: $('#newProfApiKey').value.trim(),
    model,
    contextLength: Number($('#newProfContextLength').value) || 128000,
    reasoningEffort: $('#newProfEffort').value,
    temperature: null,
    maxTokens: null,
    inputTypes: $('#newProfInputImage').checked ? ['text', 'image'] : ['text'],
    extraHeaders: {},
    extraBody: {},
  };
  const activate = $('#newProfActivate').checked;
  const payload = {
    activeProfile: activate ? rawKey : (latestLlmConfig?.activeProfile || rawKey),
    fastProfile: latestLlmConfig?.fastProfile || '',
    profiles,
  };
  const resp = await fetch('/api/llm', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await resp.json();
  if (!resp.ok) { showToast(`Create failed: ${data.error || resp.status}`); return; }

  $('#newProfilePanel').hidden = true;
  $('#newProfKey').value = '';
  $('#newProfPreset').value = '';
  $('#newProfLabel').value = '';
  $('#newProfModel').value = '';
  $('#newProfBaseUrl').value = '';
  $('#newProfApiKey').value = '';
  $('#newProfFound').textContent = '';
  $('#newProfModelList').innerHTML = '';
  $('#newProfContextLength').value = '';
  $('#newProfEffort').value = '';
  showToast(`Created LLM profile "${rawKey}"${activate ? ' (now active)' : ''}`);
  await loadHubData();
  $('#llmActiveProfile').value = rawKey;
  syncLlmProfileFields(latestLlmConfig, rawKey);
  refreshState();
});

$('#llmActiveProfile').addEventListener('change', () => {
  if (latestLlmConfig) syncLlmProfileFields(latestLlmConfig, $('#llmActiveProfile').value);
});

$('#saveLlmFormBtn').addEventListener('click', async () => {
  if (!latestLlmConfig) return;
  const activeKey = $('#llmActiveProfile').value || 'default';
  const next = {
    activeProfile: activeKey,
    fastProfile: $('#llmFastProfile').value || '',
    profiles: structuredClone(latestLlmConfig.profiles || {}),
  };
  next.profiles[activeKey] = {
    ...(next.profiles[activeKey] || { extraHeaders: {}, extraBody: {} }),
    label: $('#llmLabel').value.trim() || activeKey,
    model: $('#llmModel').value.trim(),
    contextLength: Number($('#llmContextLength').value) || 128000,
    reasoningEffort: $('#llmEffort').value,
    baseUrl: $('#llmBaseUrl').value.trim(),
    apiKey: $('#llmApiKey').value.trim(),
    temperature: $('#llmTemp').value === '' ? null : Number($('#llmTemp').value),
    maxTokens: $('#llmMaxTokens').value === '' ? null : Number($('#llmMaxTokens').value),
    inputTypes: $('#llmInputImage').checked ? ['text', 'image'] : ['text'],
  };
  const resp = await fetch('/api/llm', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
  const data = await resp.json();
  if (!resp.ok) { showToast(`LLM error: ${data.error || resp.status}`); return; }
  showToast(`Saved & activated "${activeKey}"`);
  await loadHubData();
  refreshState();
});

$('#deleteLlmProfileBtn').addEventListener('click', async () => {
  if (!latestLlmConfig) return;
  const keys = Object.keys(latestLlmConfig.profiles || {});
  if (keys.length <= 1) { showToast('Cannot delete the only profile.'); return; }
  const target = $('#llmActiveProfile').value;
  const profiles = structuredClone(latestLlmConfig.profiles);
  delete profiles[target];
  const remaining = Object.keys(profiles);
  const next = {
    activeProfile: latestLlmConfig.activeProfile === target ? remaining[0] : latestLlmConfig.activeProfile,
    fastProfile: latestLlmConfig.fastProfile === target ? '' : latestLlmConfig.fastProfile,
    profiles,
  };
  const resp = await fetch('/api/llm', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
  if (!resp.ok) { showToast('Could not delete profile'); return; }
  showToast(`Deleted profile "${target}"`);
  await loadHubData();
  refreshState();
});

$('#testLlmBtn').addEventListener('click', async () => {
  const out = $('#llmTestResult');
  out.textContent = 'Testing connection…';
  const res = await fetch('/api/llm/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      profileKey: $('#llmActiveProfile').value,
      baseUrl: $('#llmBaseUrl').value.trim(),
      apiKey: $('#llmApiKey').value.trim(),
      model: $('#llmModel').value.trim(),
    }),
  }).then((r) => r.json());
  if (res.ok) {
    out.textContent = `✓ Connected (${res.latencyMs}ms${res.modelsCount != null ? `, ${res.modelsCount} model${res.modelsCount === 1 ? '' : 's'}` : ''})`;
  } else {
    out.textContent = `Failed: ${res.error || 'unreachable'}`;
  }
});

$('#saveLlmJsonBtn').addEventListener('click', async () => {
  let parsed;
  try {
    parsed = JSON.parse($('#llmJsonEditor').value);
  } catch (err) {
    showToast(`Invalid JSON: ${err.message}`);
    return;
  }
  const resp = await fetch('/api/llm', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) });
  const data = await resp.json();
  if (!resp.ok) { showToast(`Save failed: ${data.error || resp.status}`); return; }
  showToast('Saved data/llm.json!');
  await loadHubData();
  refreshState();
});

// Save Proactive + Calendar Settings
$('#saveProactiveBtn').addEventListener('click', async () => {
  await fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userLocation: $('#setUserLocation').value.trim(),
      calendar: {
        icsUrl: $('#setIcsUrl').value.trim(),
        reminderLeadMin: Number($('#setEventLeadMin').value || 30),
      },
      proactive: {
        enabled: $('#setProactiveEnabled').checked,
        aggressiveness: $('#setAggressiveness').value,
        intervalMin: Number($('#setIntervalMin').value || 3),
        minGapMin: Number($('#setMinGapMin').value || 5),
        ...($('#setDndHours') ? { dndHours: Number($('#setDndHours').value || 0) } : {}),
        quietHours: $('#setQuietHours').value.trim(),
        upcomingReminderHeadsUpMin: Number($('#setHeadsUpMin').value || 15),
        autoExecuteTasks: $('#setAutoTasks').checked,
        proactiveBriefings: $('#setBriefings').checked,
      },
    }),
  });
  showToast('Proactive & calendar settings saved!');
  refreshState();
});

$('#syncIcsBtn').addEventListener('click', async () => {
  await fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ calendar: { icsUrl: $('#setIcsUrl').value.trim() } }),
  });
  const res = await fetch('/api/calendar/sync', { method: 'POST' }).then((r) => r.json());
  showToast(res.ok ? `Synced ${res.synced} calendar event(s)!` : `Calendar sync: ${res.error || 'No iCal URL set'}`);
  refreshState();
});

// Microsoft 365 / Outlook 365 Hosted Email UI (Device Code OAuth2)
function renderMs365Status(ms) {
  if (!ms) return;
  $('#ms365ClientId').value = ms.clientId || '';
  $('#ms365TenantId').value = ms.tenantId || 'organizations';
  $('#ms365AllowSend').checked = ms.allowSend !== false;
  const pill = $('#ms365StatusPill');
  const info = $('#ms365InfoText');
  const syncBtn = $('#ms365SyncBtn');
  const discBtn = $('#ms365DisconnectBtn');
  const devBox = $('#ms365DeviceBox');

  if (ms.connected) {
    pill.textContent = ms.accountEmail || 'Connected';
    pill.className = 'pill ok';
    syncBtn.hidden = false;
    discBtn.hidden = false;
    devBox.hidden = true;
    info.textContent = ms.lastError
      ? `Error: ${ms.lastError}`
      : ms.lastSyncAt
      ? `Synced ${new Date(ms.lastSyncAt).toLocaleTimeString()}`
      : 'Ready';
  } else {
    pill.textContent = ms.pendingLogin ? 'Waiting for browser sign-in…' : 'Not connected';
    pill.className = ms.pendingLogin ? 'pill high' : 'pill';
    syncBtn.hidden = true;
    discBtn.hidden = true;
    info.textContent = ms.lastError ? `Error: ${ms.lastError}` : '';
    if (ms.pendingLogin) {
      devBox.hidden = false;
      $('#ms365UserCode').textContent = ms.pendingLogin.userCode;
      $('#ms365VerifyLink').href = ms.pendingLogin.verificationUri || 'https://microsoft.com/devicelogin';
    } else {
      devBox.hidden = true;
    }
  }
}

$('#ms365LoginBtn').addEventListener('click', async () => {
  const clientId = $('#ms365ClientId').value.trim();
  const tenantId = $('#ms365TenantId').value.trim() || 'organizations';
  const allowSend = $('#ms365AllowSend').checked;
  if (!clientId) {
    showToast('Paste your Microsoft Application (client) ID first.');
    return;
  }
  $('#ms365InfoText').textContent = 'Starting Microsoft 365 sign-in…';
  const resp = await fetch('/api/ms365/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, tenantId, allowSend }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    $('#ms365InfoText').textContent = `Error: ${data.error || resp.status}`;
    showToast(`M365 login failed: ${data.error || resp.status}`);
    return;
  }
  $('#ms365DeviceBox').hidden = false;
  $('#ms365UserCode').textContent = data.userCode;
  $('#ms365VerifyLink').href = data.verificationUri || 'https://microsoft.com/devicelogin';
  $('#ms365StatusPill').textContent = 'Waiting for browser sign-in…';
  $('#ms365StatusPill').className = 'pill high';
  $('#ms365InfoText').textContent = '';
  copyText(data.userCode, null);
  showToast(`Code ${data.userCode} copied! Paste it at microsoft.com/devicelogin`);
});

$('#ms365CopyCodeBtn').addEventListener('click', () => {
  copyText($('#ms365UserCode').textContent.trim(), null);
  showToast('Device code copied!');
});

$('#ms365SyncBtn').addEventListener('click', async () => {
  $('#ms365InfoText').textContent = 'Syncing Microsoft 365 inbox…';
  const res = await fetch('/api/ms365/sync', { method: 'POST' }).then((r) => r.json());
  if (res.error) showToast(`M365 sync error: ${res.error}`);
  else showToast(`M365 synced (${res.fetched || 0} new, ${res.alerted || 0} alerts)`);
  await loadHubData();
  refreshState();
});

$('#ms365DisconnectBtn').addEventListener('click', async () => {
  await fetch('/api/ms365/disconnect', { method: 'POST' });
  showToast('Microsoft 365 disconnected');
  await loadHubData();
  refreshState();
});

// Quick Email Provider Presets & 2-Field Gmail Connect
const EMAIL_PROVIDERS = {
  gmail: {
    imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465,
    appPassUrl: 'https://myaccount.google.com/apppasswords', appPassLabel: 'Get Gmail App Password',
    guide: '<strong>Gmail 30-second setup:</strong> 1) Open <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">Google App Passwords</a> (requires 2-Step Verification) → 2) Name it <code>Pond</code> and click Create → 3) Paste the 16-letter code below (spaces stripped automatically).',
  },
  icloud: {
    imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587,
    appPassUrl: 'https://appleid.apple.com/account/manage', appPassLabel: 'Get iCloud App Password',
    guide: '<strong>iCloud setup:</strong> Create an App-Specific Password in <a href="https://appleid.apple.com/account/manage" target="_blank" rel="noopener">Apple Account → Sign-In & Security</a> and paste it below.',
  },
  outlook: {
    imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587,
    appPassUrl: 'https://account.live.com/proofs/AppPassword', appPassLabel: 'Get Outlook App Password',
    guide: '<strong>Outlook / Hotmail setup:</strong> Create an App Password in <a href="https://account.live.com/proofs/AppPassword" target="_blank" rel="noopener">Microsoft Account Security</a> and enter your email + app password below.',
  },
  fastmail: {
    imapHost: 'imap.fastmail.com', imapPort: 993, smtpHost: 'smtp.fastmail.com', smtpPort: 465,
    appPassUrl: 'https://app.fastmail.com/settings/security/apps', appPassLabel: 'Get Fastmail App Password',
    guide: '<strong>Fastmail setup:</strong> Generate an IMAP/SMTP App Password in Fastmail Settings → Privacy & Security → Integrations.',
  },
  yahoo: {
    imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465,
    appPassUrl: 'https://login.yahoo.com/account/security', appPassLabel: 'Get Yahoo App Password',
    guide: '<strong>Yahoo setup:</strong> Generate a Third-Party App Password under Yahoo Account Security and paste it below.',
  },
  custom: {
    imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465,
    appPassUrl: '', appPassLabel: '',
    guide: 'Open <strong>Advanced IMAP / SMTP Server Settings</strong> below to enter your custom mail host and port.',
  },
};

function detectEmailProvider(str) {
  const s = String(str || '').toLowerCase();
  if (!s || s.includes('gmail') || s.includes('googlemail')) return 'gmail';
  if (s.includes('icloud') || s.includes('me.com') || s.includes('mac.com')) return 'icloud';
  if (s.includes('outlook') || s.includes('hotmail') || s.includes('live.com') || s.includes('office365')) return 'outlook';
  if (s.includes('fastmail')) return 'fastmail';
  if (s.includes('yahoo')) return 'yahoo';
  return 'custom';
}

function updateEmailProviderGuide(provKey) {
  const p = EMAIL_PROVIDERS[provKey] || EMAIL_PROVIDERS.gmail;
  $('#gmailGuideBox').innerHTML = p.guide;
  const link = $('#openAppPassLink');
  if (p.appPassUrl) {
    link.href = p.appPassUrl;
    link.textContent = p.appPassLabel;
    link.hidden = false;
  } else {
    link.hidden = true;
  }
  if (provKey === 'custom') $('#advancedEmailDetails').open = true;
}

$('#emailProviderPreset').addEventListener('change', (e) => {
  const key = e.target.value;
  updateEmailProviderGuide(key);
  const p = EMAIL_PROVIDERS[key];
  if (p && p.imapHost) {
    $('#setImapHost').value = p.imapHost;
    $('#setImapPort').value = p.imapPort;
    $('#setSmtpHost').value = p.smtpHost;
    $('#setSmtpPort').value = p.smtpPort;
  }
});

$('#quickEmailAddr').addEventListener('input', () => {
  const addr = $('#quickEmailAddr').value.trim();
  if (addr.includes('@')) {
    const prov = detectEmailProvider(addr);
    if ($('#emailProviderPreset').value !== prov && prov !== 'custom') {
      $('#emailProviderPreset').value = prov;
      updateEmailProviderGuide(prov);
    }
  }
});

$('#quickConnectEmailBtn').addEventListener('click', async () => {
  const addr = $('#quickEmailAddr').value.trim();
  const pass = $('#quickEmailPass').value;
  if (!addr || !pass) {
    showToast('Enter your email address and App Password first.');
    return;
  }
  const provKey = $('#emailProviderPreset').value || detectEmailProvider(addr);
  const prov = EMAIL_PROVIDERS[provKey] || EMAIL_PROVIDERS.gmail;
  const imapHost = prov.imapHost || $('#setImapHost').value.trim();
  const imapPort = prov.imapHost ? prov.imapPort : Number($('#setImapPort').value || 993);
  const smtpHost = prov.smtpHost || $('#setSmtpHost').value.trim();
  const smtpPort = prov.smtpHost ? prov.smtpPort : Number($('#setSmtpPort').value || 465);

  if (!imapHost) {
    $('#advancedEmailDetails').open = true;
    showToast('Enter your custom IMAP host in Advanced settings below.');
    return;
  }

  // Mirror into advanced inputs too so everything stays in sync
  $('#setEmailEnabled').checked = true;
  $('#setImapHost').value = imapHost;
  $('#setImapPort').value = imapPort;
  $('#setImapUser').value = addr;
  $('#setImapPass').value = pass;
  $('#setSmtpHost').value = smtpHost;
  $('#setSmtpPort').value = smtpPort;
  $('#setSmtpUser').value = addr;
  $('#setSmtpPass').value = pass;

  const status = $('#emailTestStatus');
  status.textContent = 'Connecting & syncing inbox…';
  await saveEmailSettings();
  const res = await fetch('/api/emails/sync', { method: 'POST' }).then((r) => r.json());
  if (res.lastError) {
    status.textContent = `Error: ${res.lastError}`;
    showToast(`Email login failed: ${res.lastError}`);
  } else {
    status.textContent = `Connected! Checked ${res.checked || 0} email(s), ${res.alerted || 0} alert(s).`;
    showToast('Email connected & inbox synced!');
    await loadHubData();
    refreshState();
  }
});

// Save Email Settings
async function saveEmailSettings() {
  await fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: {
        enabled: $('#setEmailEnabled').checked,
        autoTriage: $('#setEmailAutoTriage').checked,
        imapHost: $('#setImapHost').value.trim(),
        imapPort: Number($('#setImapPort').value || 993),
        imapUser: $('#setImapUser').value.trim() || $('#quickEmailAddr').value.trim(),
        imapPass: $('#setImapPass').value || $('#quickEmailPass').value,
        imapMailbox: $('#setImapMailbox').value.trim() || 'INBOX',
        pollIntervalMin: Number($('#setEmailPollMin').value || 10),
        smtpHost: $('#setSmtpHost').value.trim(),
        smtpPort: Number($('#setSmtpPort').value || 465),
        smtpUser: $('#setSmtpUser').value.trim() || $('#quickEmailAddr').value.trim(),
        smtpPass: $('#setSmtpPass').value || $('#quickEmailPass').value,
        vipSenders: $('#setVipSenders').value,
        importantKeywords: $('#setImportantKeywords').value,
      },
    }),
  });
}
$('#saveEmailBtn').addEventListener('click', async () => {
  await saveEmailSettings();
  showToast('Email monitor settings saved!');
  refreshState();
});
$('#testSyncEmailBtn').addEventListener('click', async () => {
  await saveEmailSettings();
  showToast('Testing IMAP connection & syncing…');
  const res = await fetch('/api/emails/sync', { method: 'POST' }).then((r) => r.json());
  showToast(res.lastError ? `IMAP error: ${res.lastError}` : `IMAP synced! Checked ${res.checked || 0} email(s).`);
  refreshState();
});

// Add Job & Watch
$('#addJobBtn').addEventListener('click', async () => {
  const name = $('#newJobName').value.trim();
  const prompt = $('#newJobPrompt').value.trim();
  const cron = $('#newJobCron').value.trim() || null;
  const intervalMin = Number($('#newJobInterval').value) || null;
  if (!name || !prompt || (!cron && !intervalMin)) {
    showToast('Enter routine name, prompt, and either a cron schedule or interval minutes.');
    return;
  }
  await fetch('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, prompt, cron, intervalMin }),
  });
  $('#newJobName').value = '';
  $('#newJobPrompt').value = '';
  $('#newJobCron').value = '';
  $('#newJobInterval').value = '';
  showToast(`Added routine "${name}"`);
  loadHubData();
  refreshState();
});

$('#addWatchBtn').addEventListener('click', async () => {
  const name = $('#newWatchName').value.trim();
  const type = $('#newWatchType').value;
  const target = $('#newWatchTarget').value.trim();
  const intervalMin = Number($('#newWatchInterval').value) || 60;
  const criteria = $('#newWatchCriteria').value.trim();
  if (!name || !target) {
    showToast('Enter a watch name and target URL/query.');
    return;
  }
  await fetch('/api/watches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, type, target, intervalMin, criteria }),
  });
  $('#newWatchName').value = '';
  $('#newWatchTarget').value = '';
  $('#newWatchCriteria').value = '';
  showToast(`Added watcher "${name}"`);
  loadHubData();
});

// Save Sentinel Policies
$('#saveSentinelBtn').addEventListener('click', async () => {
  const policies = {};
  $$('#sentinelPoliciesGrid select[data-pol]').forEach((s) => { policies[s.dataset.pol] = s.value; });
  await fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sentinel: { enabled: $('#setSentinelEnabled').checked, policies } }),
  });
  showToast('Sentinel policies saved!');
});

// Smart Auto-Connect & Auto-Discovery MCP controls
$('#scanMcpBtn').addEventListener('click', loadMcpDiscovery);
$('#importAllMcpBtn').addEventListener('click', async () => {
  showToast('Importing & connecting all discovered MCP servers…');
  const res = await fetch('/api/mcp/import-all', { method: 'POST' }).then((r) => r.json());
  showToast(`Imported ${(res.added || []).length} MCP server(s)`);
  await loadHubData();
  loadMcpDiscovery();
});
$('#quickAddMcpBtn').addEventListener('click', async () => {
  const inputVal = $('#mcpQuickInput').value.trim();
  if (!inputVal) { showToast('Paste a URL, npx command, package name, or mcpServers JSON.'); return; }
  showToast('Auto-detecting & connecting MCP…');
  const resp = await fetch('/api/mcp/quick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: inputVal }),
  });
  const data = await resp.json();
  if (!resp.ok) { showToast(`MCP error: ${data.error || resp.status}`); return; }
  $('#mcpQuickInput').value = '';
  showToast(`Connected MCP: ${(data.added || []).join(', ')}`);
  await loadHubData();
  loadMcpDiscovery();
});

$('#compactBtn').addEventListener('click', async () => {
  showToast('Compacting older chat history…');
  const res = await fetch('/api/sessions/compact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: currentSessionId }) }).then((r) => r.json());
  if (res.error) showToast(res.error);
  else if (!res.compacted) showToast('Chat is already short — nothing to compact yet.');
  refreshState();
});

$('#openMemoryLink').addEventListener('click', () => { document.body.classList.remove('sidebar-open'); memUi.doc = null; openDrawer('memDrawer'); });
$('#dreamLine').addEventListener('click', () => { document.body.classList.remove('sidebar-open'); memUi.doc = null; openDrawer('memDrawer'); });
$('#dreamNowBtn').addEventListener('click', async () => {
  $('#dreamNowBtn').disabled = true;
  $('#dreamNowBtn').textContent = 'Dreaming…';
  await fetch('/api/memory/dream', { method: 'POST' }).catch(() => {});
  showToast('Dreaming — reading recent chats and reorganizing memory. This can take a few minutes.');
});
$('#dreamUndoBtn').addEventListener('click', async () => {
  if (!confirm('Undo the last dream? Memory goes back to how it was before it (anything Pond remembered since is kept).')) return;
  const r = await fetch('/api/memory/dream/undo', { method: 'POST' }).then((x) => x.json()).catch(() => ({ error: 'network error' }));
  if (r.error) showToast(`Couldn't undo: ${r.error}`); else showToast('Last dream undone');
  loadMemoryDrawer();
  refreshState();
});
async function saveDreamSettings() {
  await fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memory: { dream: $('#dreamToggle').checked, dreamHour: Number($('#dreamHour').value) } }) });
  loadMemoryDrawer();
  refreshState();
}
$('#dreamToggle').addEventListener('change', saveDreamSettings);
$('#dreamHour').addEventListener('change', saveDreamSettings);
$('#clearMemory').addEventListener('click', async () => {
  await fetch('/api/memory', { method: 'DELETE' });
  refreshState();
  showToast('Long-term memory cleared');
});

// PWA install prompt
let deferredInstall = null;
const installBtn = $('#installBtn');
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  installBtn.hidden = false;
});
installBtn.addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  installBtn.hidden = true;
});

// Service Worker registration
if ('serviceWorker' in navigator) {
  navigator.serviceWorker
    .register('/sw.js')
    .then((reg) => { swRegistration = reg; ensurePushSubscription(); })
    .catch((err) => { console.warn('SW registration failed', err); renderPushStatus({ ok: false, reason: 'unsupported' }); });
} else {
  setTimeout(() => renderPushStatus({ ok: !1, reason: window.isSecureContext ? 'unsupported' : 'insecure' }), 0);
}

// Auto-sync immediately when returning to the iPhone PWA from sleep/background or regaining network
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { syncTick(); refreshState(); resyncPushSubscription(); }
});
window.addEventListener('online', () => { connectEvents(); syncAll(); refreshState(); });
window.addEventListener('pageshow', (e) => { if (e.persisted) { connectEvents(); syncAll(); refreshState(); } });
window.addEventListener('focus', () => syncTick());

// Boot
(async function init() {
  syncNotifPermissionUI();
  const wantSession = new URLSearchParams(location.search).get('session');
  if (wantSession) {
    window.history.replaceState(null, '', location.pathname); // tidy URL (`history` here is the chat array)
    setCurrentSession(wantSession);
    fetch('/api/sessions/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: wantSession }) }).catch(() => {});
  }
  await loadConversation({ force: true });
  await loadSessions();
  await refreshState();
  connectEvents();
  setInterval(syncTick, SYNC_INTERVAL_MS);
  setInterval(refreshState, 25_000);
})();

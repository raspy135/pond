// Pond service worker — app-shell caching, network-first for API, rich desktop/PWA notifications.
const CACHE = 'pond-shell-v58';
const SHELL = ['/', '/index.html', '/styles.css', '/icons.js', '/app.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/markdown.js', '/mascot.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/artifacts/') || url.pathname.startsWith('/files/') || url.pathname.startsWith('/share/') || url.pathname.startsWith('/html/')) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(event.request).then((r) => r || caches.match('/index.html')))
  );
});

// Handle clicking on a Pond browser/desktop notification -> focus or open Pond window & route to alert
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const data = event.notification.data || {};
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          client.postMessage({ type: 'notification_clicked', action: event.action || 'open', data });
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('/');
      }
    })
  );
});

// Web Push from the Pond server (lib/push.js) — works while the app is closed.
// Always show a notification: iOS revokes push permission for pushes that show nothing.
self.addEventListener('push', (event) => {
  let p = { title: 'Pond', body: 'New update from your AI agent' };
  try { p = event.data ? event.data.json() : p; } catch { try { p.body = event.data.text(); } catch { /* ignore */ } }
  const isApproval = p.category === 'approval';
  event.waitUntil(
    self.registration.showNotification(p.title || 'Pond', {
      body: p.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: p.tag || `pond-${p.id || Date.now()}`,
      renotify: true,
      requireInteraction: p.urgency === 'critical' || p.urgency === 'high',
      vibrate: p.urgency === 'critical' ? [180, 80, 180] : [100],
      timestamp: p.ts ? Date.parse(p.ts) : Date.now(),
      actions: isApproval
        ? [{ action: 'review', title: 'Review' }, { action: 'dismiss', title: 'Dismiss' }]
        : [{ action: 'open', title: 'Open Pond' }, { action: 'dismiss', title: 'Dismiss' }],
      data: { id: p.id, category: p.category, sessionId: p.sessionId, meta: p.meta || {} },
    }).then(() => (self.navigator && self.navigator.setAppBadge ? self.navigator.setAppBadge().catch(() => {}) : null))
  );
});

// Browser rotated the push subscription — re-subscribe and tell the server.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const cfg = await fetch('/api/push/config', { cache: 'no-store' }).then((r) => r.json());
    const key = Uint8Array.from(atob(cfg.publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), oldEndpoint: event.oldSubscription?.endpoint || null }),
    });
  })().catch(() => {}));
});

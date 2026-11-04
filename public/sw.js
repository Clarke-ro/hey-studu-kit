const CACHE = 'hey-studu-v1';
const SHELL = ['/', '/style.css', '/md.js', '/app.js', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/badge-96.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) { // network first, last good copy offline (lists, curriculum, progress, lessons, opps)
    if (url.pathname === '/api/vapid-public-key') return;
    e.respondWith(fetch(req).then(r => { if (r.ok && !r.redirected) { const c = r.clone(); caches.open(CACHE).then(ca => ca.put(req, c)); } return r; }).catch(() => caches.match(req)));
    return;
  }
  if (url.pathname === '/login' || url.pathname === '/logout') return; // login page: always network, never cached
  if (req.mode === 'navigate') { // every route (/, /roadmap, /lessons/<id>, /m/<id> …) is the same app shell
    e.respondWith(fetch(req).then(r => {
      if (r.ok && !r.redirected && r.type === 'basic' && new URL(r.url).pathname !== '/login') { const c = r.clone(); caches.open(CACHE).then(ca => ca.put('/', c)); }
      return r;
    }).catch(() => caches.match('/')));
    return;
  }
  e.respondWith(fetch(req).then(r => {
    if (r.ok && !r.redirected) { const c = r.clone(); caches.open(CACHE).then(ca => ca.put(req, c)); }
    return r;
  }).catch(() => caches.match(req)));
});

// WindowClient.url doesn't follow the SPA's pushState, so ask the page for its live route (300ms; unknown = show)
const askRoute = (c) => new Promise((res) => {
  const ch = new MessageChannel(), t = setTimeout(() => res(null), 300);
  ch.port1.onmessage = (ev) => { clearTimeout(t); res(ev.data); };
  try { c.postMessage({ type: 'route?' }, [ch.port2]); } catch { clearTimeout(t); res(null); }
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'hey studu', body: e.data && e.data.text() }; }
  const url = d.id ? `/m/${d.id}` : (d.url || '/');
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // quiet_path: the screen this push is about (/chat for chat bot replies, /lessons/<id> for lesson feedback).
    // If that screen is visible right now, skip the banner; the app refreshes itself.
    const quiet = d.quiet_path || (d.tag === 'chat' ? '/chat' : null);
    const chatOpen = !!quiet && (await Promise.all(wins.filter(c => c.focused || c.visibilityState === 'visible').map(askRoute)))
      .some(r => r && r.visible && r.path.replace(/\/$/, '') === quiet);
    wins.forEach(c => c.postMessage({ type: 'refresh' })); // app refreshes chat + badge
    if (chatOpen) {
      // That screen is up: no banner. iOS revokes push subscriptions that receive pushes without showing
      // a notification, so there we show a silent one and close it immediately.
      if (/iPhone|iPad|iPod|Macintosh/.test(self.navigator.userAgent)) {
        await self.registration.showNotification(d.title || 'Chat', { body: d.body || '', tag: 'chat-quiet', silent: true, data: { url } });
        (await self.registration.getNotifications({ tag: 'chat-quiet' })).forEach(n => n.close());
      }
      return;
    }
    await self.registration.showNotification(d.title || 'hey studu', {
      body: d.body || '', icon: '/icons/icon-192.png', badge: '/icons/badge-96.png',
      tag: d.tag || (d.id ? 'msg-' + d.id : undefined), renotify: !!d.tag, data: { url, id: d.id },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const d = e.notification.data || {};
  const target = new URL(d.id ? `/m/${d.id}` : (d.url || '/'), self.location.origin).href;
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        if ('navigate' in c) return c.navigate(target);
        return;
      }
    }
    return self.clients.openWindow(target);
  })());
});

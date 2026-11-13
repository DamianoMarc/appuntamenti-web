// Service worker: rende l'app installabile e carica la shell anche offline.
// Le chiamate al backend (altra origine / /api) NON vengono mai messe in cache.
const CACHE = 'appuntamenti-v4';
const SHELL = ['./', './index.html', './styles.css', './app.js', './config.js', './pwa.js', './qrcode.js', './manifest.webmanifest', './icon.svg', './logo.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  // un file mancante non blocca più l'installazione
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // network-first: gli aggiornamenti arrivano subito, la cache è il paracadute offline
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});

// ---- Notifiche push (nuove prenotazioni, per la gestione) ----
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {body: e.data ? e.data.text() : ''}; }
  e.waitUntil(self.registration.showNotification(d.title || 'Appuntamenti', {
    body: d.body || '',
    tag: d.tag || 'appuntamento',
    renotify: !!d.renotify,
    requireInteraction: !!d.requireInteraction,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    data: d.data || {}
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  // l'URL è costruito qui (non preso dal payload): niente redirect arbitrari
  const target = new URL('./#admin', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow(target);
  }));
});

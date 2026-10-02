// Service Worker: App-Hülle und Supabase-Bibliothek für den Offline-Start cachen,
// Push-Mitteilungen anzeigen. Daten von Supabase werden nie gecacht.
const CACHE = 'menuplan-v5';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'logik.js', 'config.js', 'icon.svg', 'manifest.webmanifest', 'icons/icon-192.png'];
const CDN = 'https://cdn.jsdelivr.net/';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const speichern = (req, res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; };

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin === location.origin) {
    // Eigene Dateien: Netzwerk zuerst (immer aktuelle Version), sonst Cache
    e.respondWith(fetch(e.request).then((res) => speichern(e.request, res)).catch(() => caches.match(e.request)));
  } else if (e.request.url.startsWith(CDN)) {
    // Bibliotheken: versioniert, darum Cache zuerst
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => speichern(e.request, res))));
  }
});

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: 'Menüplan', body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Menüplan', {
    body: d.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: d.tag || 'menuplan',
    data: { url: d.url || './' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const ziel = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const offen = list.find((c) => c.url.startsWith(self.registration.scope));
    return offen ? offen.focus() : self.clients.openWindow(ziel);
  }));
});

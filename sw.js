/* STMA Bot · service worker v17
   - met en cache la « coquille » de l'appli (HTML, icônes, manifest) pour l'ouvrir hors ligne
   - met en cache les bibliothèques CDN (Tailwind, polices)
   - ne met JAMAIS en cache les données de marché (Binance, Yahoo, relais, Fear & Greed…)
   - affiche / gère le clic sur les notifications */
const VERSION = 'stma-v19.10';
const SHELL_CACHE = VERSION + '-shell';
const CDN_CACHE = VERSION + '-cdn';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png'];
const CDN_HOSTS = ['cdn.tailwindcss.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }

// Réseau d'abord (pour recevoir les mises à jour), cache si hors ligne ou trop lent
async function networkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await Promise.race([fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }), timeout(4000)]);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req, { ignoreSearch: true }) || await cache.match('./index.html');
    if (hit) return hit;
    throw e;
  }
}

// Cache d'abord avec mise à jour en arrière-plan (bibliothèques CDN)
async function staleWhileRevalidate(req) {
  const cache = await caches.open(CDN_CACHE);
  const hit = await cache.match(req);
  const net = fetch(req).then((res) => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || net;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith('/sw.js')) return;
    event.respondWith(networkFirst(req));
    return;
  }
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }
  // Tout le reste (API de marché, relais CORS, TradingView, WebSocket) : réseau direct, aucune mise en cache.
});

// Notifications envoyées par le serveur Cloudflare (Web Push), même appli fermée.
// iOS exige d'afficher une notification pour CHAQUE message push reçu (sinon il coupe l'abonnement).
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { body: event.data ? event.data.text() : '' }; }
  const title = d.title || 'STMA Bot';
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || '', tag: d.tag || 'stma-server', renotify: true,
    icon: 'icon-192.png', badge: 'icon-192.png', timestamp: d.ts || Date.now(),
    data: { url: d.url || './?src=server' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { if (/src=server/.test(target) && 'navigate' in c) { try { await c.navigate(new URL(target, self.registration.scope).href); } catch (e) {} } return c.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});

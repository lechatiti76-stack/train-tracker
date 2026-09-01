// Service Worker : mise en cache de l'app shell pour un fonctionnement
// hors-ligne (PWA). Les appels vers Google Apps Script (horaires théoriques)
// sont volontairement exclus du cache pour ne jamais servir des horaires
// périmés — sheets-sync.js gère déjà lui-même les échecs réseau.
const CACHE_NAME = 'traintrack-cache-v1';

const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/config.js',
  './js/storage.js',
  './js/time-utils.js',
  './js/delay-calc.js',
  './js/sheets-sync.js',
  './js/splitflap.js',
  './js/charts.js',
  './js/card.js',
  './manifest.json',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon-180.png',
  './assets/icons/favicon-32.png',
  './assets/icons/favicon-16.png',
];

const CDN_ASSETS = ['https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await Promise.all(
      CDN_ASSETS.map((url) => cache.add(url).catch(() => {
        /* Pas bloquant : sera mis en cache au premier chargement en ligne. */
      }))
    );
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Ne jamais mettre en cache les échanges avec le Web App Google Apps
  // Script : les horaires doivent toujours venir du réseau si disponible.
  if (req.url.includes('script.google.com') || req.url.includes('script.googleusercontent.com')) {
    event.respondWith(fetch(req));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone());
        return fresh;
      } catch (err) {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match(req)) || (await cache.match('./index.html'));
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    } catch (err) {
      return cached || Response.error();
    }
  })());
});

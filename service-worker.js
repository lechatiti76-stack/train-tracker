// Service Worker : mise en cache de l'app shell pour un fonctionnement
// hors-ligne (PWA). Les appels vers Google Apps Script (horaires théoriques)
// sont volontairement exclus du cache pour ne jamais servir des horaires
// périmés — sheets-sync.js gère déjà lui-même les échecs réseau.
// IMPORTANT : incrémentez ce numéro à CHAQUE modification d'un fichier de
// APP_SHELL (js/*.js, css/style.css, index.html...). C'est ce qui force les
// appareils ayant déjà installé la PWA à abandonner l'ancien cache et à
// retélécharger les fichiers à jour — sans ça, le Service Worker sert
// indéfiniment l'ancienne version même après un nouveau déploiement.
const CACHE_NAME = 'traintrack-cache-v40';

const INTRO_VIDEO_PATH = './assets/lhte-intro-v2.mp4';

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
  './js/stopwatch.js',
  './js/archives.js',
  './manifest.json',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon-180.png',
  './assets/icons/favicon-32.png',
  './assets/icons/favicon-16.png',
  // Vidéo de l'animation d'introduction (logo LHTE + musique), voir
  // playIntroSplash dans js/app.js et respondWithMedia ci-dessous.
  INTRO_VIDEO_PATH,
];

const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js',
  // jsPDF : génère le PDF récap du jour (bouton "📄 PDF récap") entièrement
  // côté client, sans backend — voir generateDailyRecapPDF dans js/app.js.
  'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
];

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

  // Vidéos (.mp4) : les navigateurs (Safari/iOS surtout) les demandent par
  // morceaux (en-tête Range) et refusent de les lire si on leur renvoie le
  // fichier entier à la place. On sert donc le morceau demandé à partir de
  // la copie complète en cache (réponse 206), ce qui permet aussi de jouer
  // l'intro hors-ligne.
  if (new URL(req.url).pathname.endsWith('.mp4')) {
    event.respondWith(respondWithMedia(req));
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

async function respondWithMedia(req) {
  const cache = await caches.open(CACHE_NAME);
  let full = await cache.match(req.url);
  if (!full) {
    try {
      // Requête SANS Range pour récupérer (et mettre en cache) le fichier
      // complet, réutilisable ensuite pour n'importe quel morceau.
      const fresh = await fetch(req.url);
      if (!fresh.ok) return fresh;
      await cache.put(req.url, fresh.clone());
      full = fresh;
    } catch (err) {
      return Response.error();
    }
  }
  const range = req.headers.get('range');
  if (!range) return full;
  const buf = await full.arrayBuffer();
  const size = buf.byteLength;
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = 0;
  let end = size - 1;
  if (m) {
    if (m[1] === '' && m[2] !== '') {
      start = Math.max(0, size - Number(m[2]));
    } else {
      start = Number(m[1] || 0);
      if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
    }
  }
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': full.headers.get('Content-Type') || 'video/mp4',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

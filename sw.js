/*
 * Suivi des circulations - service worker de l'application installée.
 * Toujours le réseau d'abord (les mises à jour arrivent tout de suite) ; la dernière copie des pages sert
 * seulement si le réseau manque. Le serveur Google (données, clé) n'est jamais intercepté ni gardé.
 */
var CACHE = 'suivi-circulations-v5';

self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (cles) {
    return Promise.all(cles.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // copie gardée seulement pour les fichiers de l'application (pas version.txt, pas les adresses avec paramètres)
  var garder = !url.search && !/version\.txt$/.test(url.pathname) && !req.headers.has('range');
  e.respondWith(fetch(req).then(function (rep) {
    if (garder && rep.status === 200) { var copie = rep.clone(); caches.open(CACHE).then(function (c) { c.put(req, copie); }); }
    return rep;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (r) { return r || Response.error(); });
  }));
});

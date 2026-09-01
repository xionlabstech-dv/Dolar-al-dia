// Subir este numero cada vez que cambie index.html, manifest.json o los
// estilos/scripts inline, o el telefono va a seguir mostrando la version
// vieja aunque el archivo ya haya cambiado en el servidor.
var CACHE_NAME = 'dolaraldia-shell-v7';

var SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return Promise.all(
        SHELL_FILES.map(function (url) {
          return cache.add(url).catch(function () {
            // Si un archivo falla (ej. no existe todavia), no tumba la
            // instalacion completa del service worker.
          });
        })
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) { return key !== CACHE_NAME; })
          .map(function (key) { return caches.delete(key); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  var url = new URL(request.url);

  // Nunca tocar peticiones que no son GET, ni las que van a otro origen
  // (la API del Worker, fuentes de Google, etc.) -- esas siempre van a la
  // red directo, para que la tasa nunca se sirva desde una cache vieja.
  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(request).then(function (cached) {
      return (
        cached ||
        fetch(request).then(function (response) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(request, copy);
          });
          return response;
        })
      );
    })
  );
});

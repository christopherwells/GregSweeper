const CACHE_NAME = 'gregsweeper-v1.4';
const ASSETS = [
  './',
  './index.html',
  './src/main.js',
  './src/audio/sounds.js',
  './src/logic/boardGenerator.js',
  './src/logic/boardSolver.js',
  './src/logic/difficulty.js',
  './src/logic/fogOfWar.js',
  './src/logic/powerUps.js',
  './src/logic/seededRandom.js',
  './src/logic/achievements.js',
  './src/storage/statsStorage.js',
  './src/styles/global.css',
  './src/styles/animations.css',
  './src/styles/themes/classic.css',
  './src/styles/themes/dark.css',
  './src/styles/themes/neon.css',
  './src/styles/themes/ocean.css',
  './src/styles/themes/sunset.css',
  './src/styles/themes/candy.css',
  './src/styles/themes/midnight.css',
  './src/styles/themes/aurora.css',
  './src/styles/themes/galaxy.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache a fresh copy for offline use
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone);
          });
        }
        return response;
      })
      .catch(() => {
        // Network failed — try cache (ignoreSearch so ?v=X still matches)
        return caches.match(event.request, { ignoreSearch: true });
      })
  );
});

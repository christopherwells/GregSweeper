const CACHE_NAME = 'gregsweeper-v0.7';
const ASSETS = [
  '/',
  '/index.html',
  '/src/main.js',
  '/src/audio/sounds.js',
  '/src/logic/boardGenerator.js',
  '/src/logic/boardSolver.js',
  '/src/logic/difficulty.js',
  '/src/logic/fogOfWar.js',
  '/src/logic/powerUps.js',
  '/src/logic/seededRandom.js',
  '/src/logic/achievements.js',
  '/src/storage/statsStorage.js',
  '/src/styles/global.css',
  '/src/styles/animations.css',
  '/src/styles/themes/classic.css',
  '/src/styles/themes/dark.css',
  '/src/styles/themes/neon.css',
  '/src/styles/themes/ocean.css',
  '/src/styles/themes/sunset.css',
  '/src/styles/themes/candy.css',
  '/src/styles/themes/midnight.css',
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
    caches.match(event.request).then((cached) => {
      // Network first for HTML (to get updates), cache first for assets
      if (event.request.mode === 'navigate') {
        return fetch(event.request).catch(() => cached);
      }
      return cached || fetch(event.request);
    })
  );
});

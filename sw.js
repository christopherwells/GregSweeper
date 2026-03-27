const CACHE_NAME = 'gregsweeper-v1.3';
const ASSETS = [
  './',
  './index.html',
  './src/main.js',
  './src/state/gameState.js',
  './src/ui/domHelpers.js',
  './src/ui/boardRenderer.js',
  './src/ui/headerRenderer.js',
  './src/ui/modalManager.js',
  './src/ui/powerUpBar.js',
  './src/ui/toastManager.js',
  './src/ui/effectsRenderer.js',
  './src/ui/themeManager.js',
  './src/ui/themeEffects.js',
  './src/game/gameActions.js',
  './src/game/winLossHandler.js',
  './src/game/powerUpActions.js',
  './src/game/modeManager.js',
  './src/game/gamePersistence.js',
  './src/game/timerManager.js',
  './src/audio/sounds.js',
  './src/logic/boardGenerator.js',
  './src/logic/boardSolver.js',
  './src/logic/constraintSolver.js',
  './src/logic/difficulty.js',
  './src/logic/gimmicks.js',
  './src/logic/skillTrainer.js',
  './src/ui/skillTrainerUI.js',
  './src/ui/collectionManager.js',
  './src/logic/powerUps.js',
  './src/logic/seededRandom.js',
  './src/logic/achievements.js',
  './src/storage/storageAdapter.js',
  './src/storage/statsStorage.js',
  './src/styles/global.css',
  './src/styles/animations.css',
  './src/styles/themes/classic.css',
  './src/styles/themes/dark.css',
  // Other themes are lazy-loaded and cached on-demand via network-first strategy
  './src/firebase/firebaseLeaderboard.js',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Bypass browser HTTP cache on install so a CACHE_NAME bump
      // always fetches truly fresh assets from the server.
      Promise.all(ASSETS.map((url) =>
        fetch(url, { cache: 'reload' }).then((res) => cache.put(url, res))
      ))
    )
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

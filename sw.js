const CACHE_NAME = 'gregsweeper-v0.9';
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
  './src/logic/fogOfWar.js',
  './src/logic/gimmicks.js',
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
  './src/styles/themes/forest.css',
  './src/styles/themes/stealth.css',
  './src/styles/themes/cherry-blossom.css',
  './src/styles/themes/volcano.css',
  './src/styles/themes/ice.css',
  './src/styles/themes/cyberpunk.css',
  './src/styles/themes/retro.css',
  './src/styles/themes/holographic.css',
  './src/styles/themes/toxic.css',
  './src/styles/themes/royal.css',
  './src/styles/themes/prismatic.css',
  './src/styles/themes/void.css',
  './src/styles/themes/arctic.css',
  './src/styles/themes/jungle.css',
  './src/styles/themes/obsidian.css',
  './src/styles/themes/matrix.css',
  './src/styles/themes/inferno.css',
  './src/styles/themes/celestial.css',
  './src/styles/themes/bloodmoon.css',
  './src/styles/themes/synthwave.css',
  './src/styles/themes/supernova.css',
  './src/styles/themes/legendary.css',
  './src/styles/themes/copper.css',
  './src/styles/themes/sakura.css',
  './src/styles/themes/deepspace.css',
  './src/styles/themes/emerald.css',
  './src/styles/themes/lavender.css',
  './src/styles/themes/autumn.css',
  './src/styles/themes/coral.css',
  './src/styles/themes/slate.css',
  './src/styles/themes/phantom.css',
  './src/styles/themes/solar.css',
  './src/firebase/firebaseLeaderboard.js',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/apple-touch-icon.png',
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

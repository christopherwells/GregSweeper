const CACHE_NAME = 'gregsweeper-v1.5.65';
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
  './src/logic/dailyFeatures.js',
  './src/logic/handicaps.js',
  './src/logic/handicaps.json',
  './src/logic/experimentDesign.js',
  './src/logic/experimentTarget.json',
  './src/logic/modelHistory.json',
  './src/logic/selectDailyRngSeed.js',
  './src/logic/gimmicks.js',
  // Stats-tab, diagnostics, and skill-trainer modules are dynamic-imported
  // on demand — no need to pre-cache at install time. Runtime fetch handler
  // caches them on first use so offline access still works once the user
  // has opened those surfaces once.
  //   './src/logic/skillTrainer.js',
  //   './src/ui/skillTrainerUI.js',
  //   './src/ui/dailyHistoryChart.js',
  //   './src/ui/charts.js',
  //   './src/ui/statsRenderer.js',
  //   './src/ui/diagnosticsModal.js',
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
  './src/firebase/firebaseProgress.js',
  './src/firebase/dailyBoardSync.js',
  './src/firebase/weeklyBoardSync.js',
  './src/firebase/waitForFirebase.js',
  './src/firebase/firebasePush.js',
  './src/logic/selectWeeklyRngSeed.js',
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
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      ),
      // Broadcast our cache name to every client window so the page knows
      // exactly which build is serving it. Used for forensic provenance
      // (`codeVersion` field on canonical board writes) and for runtime
      // diagnostics. Stops the bug where the page hardcoded a stale
      // version literal that didn't match what was actually running.
      self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
        for (const client of clients) {
          client.postMessage({ type: 'codeVersion', value: CACHE_NAME });
        }
      }),
    ])
  );
  self.clients.claim();
});

// Reply to client requests for the current cache name. The page asks
// this on first load (when it has a controller but missed the activate
// broadcast) so it can populate `state.codeVersion` synchronously.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'getCodeVersion') {
    event.source?.postMessage({ type: 'codeVersion', value: CACHE_NAME });
  }
});

// ── Push notifications ─────────────────────────────────
// Inbound push from FCM. Payload shape (set by scripts/send-push.mjs):
//   { title: string, body: string, tag?: string, deepLink?: string }
// We always show the notification (browsers reject silent pushes after
// the user has granted permission). Tag prevents duplicate stacking
// when multiple pushes for the same category arrive.
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let raw;
  try { raw = event.data.json(); }
  catch { raw = { title: 'GregSweeper', body: event.data.text() }; }
  // FCM can deliver the payload in any of three shapes depending on
  // how the v1 message was structured: flat (data-only message lands
  // as flat data), nested under .data, or under .notification (when
  // the sender used the platform-default notification block). Reading
  // from all three keeps us robust to any structure switch.
  const title = raw?.notification?.title || raw?.data?.title || raw?.title || 'GregSweeper';
  const body = raw?.notification?.body || raw?.data?.body || raw?.body || '';
  const tag = raw?.notification?.tag || raw?.data?.tag || raw?.tag || 'gregsweeper-notification';
  const deepLink = raw?.data?.deepLink || raw?.deepLink || raw?.fcmOptions?.link || './?mode=daily';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: './assets/icon-192.png',
      badge: './assets/icon-192.png',
      tag,
      data: { deepLink },
    })
  );
});

// Notification click → focus an existing tab on the deep-link URL or
// open a new one. Closes the notification. The deepLink is passed
// through from send-push.mjs's payload.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.deepLink || './?mode=daily';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      try {
        if (c.url.endsWith(url) && 'focus' in c) return c.focus();
      } catch {}
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

self.addEventListener('fetch', (event) => {
  // Same-origin only. Cross-origin (Firebase SDK CDN, gstatic, etc.)
  // bypasses the SW entirely so it can't accidentally cache or stall
  // those.
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Bypass HTTP cache on every same-origin fetch. Without this, the
  // SW's network-first strategy still pulled stale resources from
  // the browser/PWA HTTP cache when the cached entry hadn't expired
  // (GH Pages defaults to 10-minute HTML cache; iOS PWAs hold even
  // longer at the OS shell layer). cache:'no-store' tells fetch to
  // ignore HTTP cache and always go to the network. Combined with the
  // no-cache meta tags in index.html, this means an updated deploy
  // reaches every active user on their next reload — no Check-for-
  // Updates dance, no PWA reinstall, no support emails.
  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone);
          });
        }
        return response;
      })
      .catch(() => {
        // Network failed — fall back to cache for offline play.
        return caches.match(event.request, { ignoreSearch: true });
      })
  );
});

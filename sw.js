const CACHE_NAME = 'gregsweeper-v1.5.80';
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
//
// `skipWaiting` lets the boot-time gate ask a NEW-but-stuck-in-waiting
// SW to take over immediately. The install event already calls
// self.skipWaiting() unconditionally, so this is a no-op in the common
// fresh-install path; it matters when iOS ships us a SW that's been
// installed but not activated (per R3).
self.addEventListener('message', (event) => {
  if (event.data?.type === 'getCodeVersion') {
    event.source?.postMessage({ type: 'codeVersion', value: CACHE_NAME });
  } else if (event.data?.type === 'skipWaiting') {
    self.skipWaiting();
  }
});

// ── Push notifications ─────────────────────────────────
// Inbound push from FCM. Payload schema (set by scripts/send-push.mjs):
//   v1 (current): { v: "1", title, body, tag?, deepLink? }
// The `v` field is a permanent contract — a push delivered today might
// be processed by a SW that's days or weeks old. When `v` increments
// to 2+, this handler keeps reading v1 fields exactly as it does today,
// so old SWs still render notifications safely. New SWs get a v2+
// branch that consumes the new fields. NEVER repurpose a v1 field.
const PUSH_SCHEMA_KNOWN_VERSIONS = ['1'];
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
  // Schema-version awareness. Absence is treated as v1 (legacy pushes
  // from before the version field shipped). A version this SW doesn't
  // recognise gets logged so we can see staleness rates after a future
  // schema bump. The fields above are v1 — if a future v2 adds new
  // fields, add a branch here.
  const schemaVersion = raw?.data?.v || raw?.v || '1';
  if (!PUSH_SCHEMA_KNOWN_VERSIONS.includes(schemaVersion)) {
    console.warn(`[push] unknown schema version: ${schemaVersion} — treating as v1`);
  }
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
      .catch(async () => {
        // Network failed — fall back to cache for offline play.
        const cached = await caches.match(event.request, { ignoreSearch: true });
        if (cached) return cached;
        // Navigation request with no cache hit (e.g. user navigates to a
        // route we don't have, or first-time offline visit). Serve the
        // app shell so the player sees something other than the browser's
        // generic offline screen. The app handles routing client-side
        // from `?mode=...` etc., so index.html bootstraps the same way
        // it would online.
        if (event.request.mode === 'navigate') {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
        }
        // Last resort — return a minimal offline response so at least
        // the request resolves rather than producing an unhandled
        // network error in the page.
        return new Response('Offline — please reconnect to load this resource.', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      })
  );
});

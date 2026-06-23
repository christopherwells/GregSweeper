const CACHE_NAME = 'gregsweeper-v1.6.66';
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
  './src/logic/bombInfoValue.js',
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
  './src/logic/nameFilter.js',
  './src/logic/hateSpeechTerms.js',
  // Stats-tab + diagnostics modules are dynamic-imported on demand — no
  // need to pre-cache at install time. Runtime fetch handler caches them
  // on first use so offline access still works once the user has opened
  // those surfaces once. (Skill Trainer was removed 2026-05-13.)
  //   './src/ui/dailyHistoryChart.js',
  //   './src/ui/charts.js',
  //   './src/ui/statsRenderer.js',
  //   './src/ui/diagnosticsModal.js',
  './src/ui/receiptRenderer.js',
  './src/ui/cruxTeaser.js',
  './src/logic/gregVoice.js',
  './src/logic/proofExplainer.js',
  './src/logic/patternNames.js',
  './src/logic/cruxExtract.js',
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
  // Hard static imports of main.js / the firebase modules — without
  // these, a first-visit install that goes offline before its first
  // online page load fails to boot (runtime caching only covers files
  // that have been fetched once).
  './src/firebase/firebaseAuth.js',
  './src/firebase/env.js',
  './src/firebase/boardCache.js',
  './src/diagnostics/errorReporter.js',
  './src/ui/tutorialManager.js',
  './src/logic/selectWeeklyRngSeed.js',
  // leaderboardViews is a STATIC import of main.js (boot-critical);
  // friendCodes/firebaseFriends are lazy but precached for offline.
  './src/logic/leaderboardViews.js',
  './src/logic/friendCodes.js',
  './src/firebase/firebaseFriends.js',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-maskable-512.png',
  './assets/apple-touch-icon.png',
  './assets/sprites/mine.png',
  './assets/sprites/flag.png',
  './assets/sprites/idle.png',
  './assets/sprites/win.png',
  './assets/sprites/loss.png',
  './assets/sprites/strike.png',
  './assets/sprites/mode-challenge.svg',
  './assets/sprites/mode-quickplay.svg',
  './assets/sprites/mode-daily.svg',
  './assets/sprites/mode-weekly.svg',
  './assets/sprites/mode-chaos.svg',
  './assets/sprites/mode-gym.svg',
  './assets/sprites/pow-revealsafe.svg',
  './assets/sprites/pow-shield.svg',
  './assets/sprites/pow-scan.svg',
  './assets/sprites/pow-lifeline.svg',
  './assets/sprites/pow-magnet.svg',
  './assets/sprites/pow-xray.svg',
  './assets/sprites/medal-diamond.svg',
  './assets/sprites/medal-gold.svg',
  './assets/sprites/medal-silver.svg',
  './assets/sprites/medal-bronze.svg',
  './assets/sprites/medal-emerald.svg',
  // Modifier (gimmick) icons — the 10 modifier types
  './assets/sprites/mod-walls.svg',
  './assets/sprites/mod-liar.svg',
  './assets/sprites/mod-mystery.svg',
  './assets/sprites/mod-mineshift.svg',
  './assets/sprites/mod-locked.svg',
  './assets/sprites/mod-wormhole.svg',
  './assets/sprites/mod-mirror.svg',
  './assets/sprites/mod-pressure.svg',
  './assets/sprites/mod-sonar.svg',
  './assets/sprites/mod-compass.svg',
  // Per-theme object sets (batch 1) — each world's mine/flag/strike in
  // its own material language.
  './assets/sprites/themes/editorial-mine.svg',
  './assets/sprites/themes/editorial-flag.svg',
  './assets/sprites/themes/editorial-strike.svg',
  './assets/sprites/themes/sumie-mine.svg',
  './assets/sprites/themes/sumie-flag.svg',
  './assets/sprites/themes/sumie-strike.svg',
  './assets/sprites/themes/blueprint-mine.svg',
  './assets/sprites/themes/blueprint-flag.svg',
  './assets/sprites/themes/blueprint-strike.svg',
  './assets/sprites/themes/cartography-mine.svg',
  './assets/sprites/themes/cartography-flag.svg',
  './assets/sprites/themes/cartography-strike.svg',
  './assets/sprites/themes/chalkboard-mine.svg',
  './assets/sprites/themes/chalkboard-flag.svg',
  './assets/sprites/themes/chalkboard-strike.svg',
  './assets/sprites/themes/noir-strike.svg',
  './assets/sprites/themes/splitflap-mine.svg',
  './assets/sprites/themes/splitflap-flag.svg',
  './assets/sprites/themes/splitflap-strike.svg',
  './assets/sprites/themes/galaxy-mine.svg',
  './assets/sprites/themes/galaxy-flag.svg',
  './assets/sprites/themes/galaxy-strike.svg',
  './assets/sprites/themes/circuitboard-mine.svg',
  './assets/sprites/themes/circuitboard-flag.svg',
  './assets/sprites/themes/circuitboard-strike.svg',
  './assets/sprites/themes/comic-mine.svg',
  './assets/sprites/themes/comic-flag.svg',
  './assets/sprites/themes/comic-strike.svg',
  './assets/sprites/themes/sakura-mine.svg',
  './assets/sprites/themes/sakura-flag.svg',
  './assets/sprites/themes/sakura-strike.svg',
  './assets/sprites/themes/apothecary-mine.svg',
  './assets/sprites/themes/apothecary-strike.svg',
  './assets/sprites/themes/aurora-mine.svg',
  './assets/sprites/themes/aurora-flag.svg',
  './assets/sprites/themes/aurora-strike.svg',
  // Per-theme Greg (the three smiley slots), all 24 themed worlds.
  // Precached like the object sprites so a themed player never flashes a
  // broken image in the smiley slot on a fresh offline load.
  './assets/sprites/greg/themed-editorial-idle.svg',
  './assets/sprites/greg/themed-editorial-win.svg',
  './assets/sprites/greg/themed-editorial-loss.svg',
  './assets/sprites/greg/themed-sumie-idle.svg',
  './assets/sprites/greg/themed-sumie-win.svg',
  './assets/sprites/greg/themed-sumie-loss.svg',
  './assets/sprites/greg/themed-blueprint-idle.svg',
  './assets/sprites/greg/themed-blueprint-win.svg',
  './assets/sprites/greg/themed-blueprint-loss.svg',
  './assets/sprites/greg/themed-cartography-idle.svg',
  './assets/sprites/greg/themed-cartography-win.svg',
  './assets/sprites/greg/themed-cartography-loss.svg',
  './assets/sprites/greg/themed-origami-idle.svg',
  './assets/sprites/greg/themed-origami-win.svg',
  './assets/sprites/greg/themed-origami-loss.svg',
  './assets/sprites/greg/themed-chalkboard-idle.svg',
  './assets/sprites/greg/themed-chalkboard-win.svg',
  './assets/sprites/greg/themed-chalkboard-loss.svg',
  './assets/sprites/greg/themed-noir-idle.svg',
  './assets/sprites/greg/themed-noir-win.svg',
  './assets/sprites/greg/themed-noir-loss.svg',
  './assets/sprites/greg/themed-ocean-idle.svg',
  './assets/sprites/greg/themed-ocean-win.svg',
  './assets/sprites/greg/themed-ocean-loss.svg',
  './assets/sprites/greg/themed-forest-idle.svg',
  './assets/sprites/greg/themed-forest-win.svg',
  './assets/sprites/greg/themed-forest-loss.svg',
  './assets/sprites/greg/themed-sakura-idle.svg',
  './assets/sprites/greg/themed-sakura-win.svg',
  './assets/sprites/greg/themed-sakura-loss.svg',
  './assets/sprites/greg/themed-apothecary-idle.svg',
  './assets/sprites/greg/themed-apothecary-win.svg',
  './assets/sprites/greg/themed-apothecary-loss.svg',
  './assets/sprites/greg/themed-splitflap-idle.svg',
  './assets/sprites/greg/themed-splitflap-win.svg',
  './assets/sprites/greg/themed-splitflap-loss.svg',
  './assets/sprites/greg/themed-stainedglass-idle.svg',
  './assets/sprites/greg/themed-stainedglass-win.svg',
  './assets/sprites/greg/themed-stainedglass-loss.svg',
  './assets/sprites/greg/themed-aurora-idle.svg',
  './assets/sprites/greg/themed-aurora-win.svg',
  './assets/sprites/greg/themed-aurora-loss.svg',
  './assets/sprites/greg/themed-galaxy-idle.svg',
  './assets/sprites/greg/themed-galaxy-win.svg',
  './assets/sprites/greg/themed-galaxy-loss.svg',
  './assets/sprites/greg/themed-candy-idle.svg',
  './assets/sprites/greg/themed-candy-win.svg',
  './assets/sprites/greg/themed-candy-loss.svg',
  './assets/sprites/greg/themed-comic-idle.svg',
  './assets/sprites/greg/themed-comic-win.svg',
  './assets/sprites/greg/themed-comic-loss.svg',
  './assets/sprites/greg/themed-circuitboard-idle.svg',
  './assets/sprites/greg/themed-circuitboard-win.svg',
  './assets/sprites/greg/themed-circuitboard-loss.svg',
  './assets/sprites/greg/themed-matrix-idle.svg',
  './assets/sprites/greg/themed-matrix-win.svg',
  './assets/sprites/greg/themed-matrix-loss.svg',
  './assets/sprites/greg/themed-neon-idle.svg',
  './assets/sprites/greg/themed-neon-win.svg',
  './assets/sprites/greg/themed-neon-loss.svg',
  './assets/sprites/greg/themed-synthwave-idle.svg',
  './assets/sprites/greg/themed-synthwave-win.svg',
  './assets/sprites/greg/themed-synthwave-loss.svg',
  './assets/sprites/greg/themed-inferno-idle.svg',
  './assets/sprites/greg/themed-inferno-win.svg',
  './assets/sprites/greg/themed-inferno-loss.svg',
  './assets/sprites/greg/themed-supernova-idle.svg',
  './assets/sprites/greg/themed-supernova-win.svg',
  './assets/sprites/greg/themed-supernova-loss.svg',
  './assets/sprites/greg/themed-legendary-idle.svg',
  './assets/sprites/greg/themed-legendary-win.svg',
  './assets/sprites/greg/themed-legendary-loss.svg',
  './assets/loading.jpg',
  './src/ui/spriteLoader.js',
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

  // Cache-first for static assets (sprites, icons, loading splash).
  // These are versioned by CACHE_NAME — when CACHE_NAME bumps on
  // deploy, install pre-caches the new bytes and the old cache is
  // deleted in activate. So serving from cache is always fresh-as-of-
  // deploy, and we skip a network roundtrip per image. Without this,
  // every <img src> request waited for the network even though the
  // sprite was already cached, which made flag/mine renders feel
  // sluggish on mobile cellular (10-20 s in the worst cases).
  if (url.pathname.includes('/assets/')) {
    event.respondWith(
      caches.match(event.request, { ignoreSearch: true }).then((cached) => {
        if (cached) return cached;
        // Cache miss (rare — install pre-caches everything in ASSETS).
        // Fall through to network; cache the response for next time.
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => new Response('Offline asset', {
          status: 503, statusText: 'Service Unavailable',
        }));
      })
    );
    return;
  }

  // Network-first for everything else (HTML, JS, CSS). cache:'no-store'
  // bypasses the browser HTTP cache so an updated deploy reaches every
  // active user on their next reload. Cache fallback covers offline.
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

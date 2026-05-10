# GregSweeper PWA Hardening Checklist

Generated 2026-05-07 from research after a session that surfaced 5 cache /
update / push bugs. 51 items prioritized P0 / P1 / P2. This doc is the
checklist a new session should pick up cold.

---

## How to use this doc

- **P0 items** are user-facing risks that have either already bitten us or
  are imminent. Do these first.
- **P1 items** are real risks at scale; ship in the next 1-2 weeks.
- **P2 items** are polish; defer until P0/P1 are clean.
- **Open research questions** at the bottom — items where the research agent
  flagged design choices that need a quick spike before implementation.
- Each item references the specific file/line where the current code is
  exposed, so a fresh agent can locate the surface area without re-reading
  the whole codebase.
- Cross-reference: today's work shipped the following structural fixes that
  this checklist builds on — `<meta http-equiv="Cache-Control"
  content="no-store">`, SW `cache: 'no-store'` fetch, version-mismatch
  self-healer polling sw.js every 5 min, modal-aware toast z-index,
  pushManager.unsubscribe in token mint paths, multi-shape SW push handler,
  double-write FCM payload, never-disable notification toggle.

---

## Tier P0 — ship this week

### Service worker safety

- [ ] **1.4 SW skipWaiting mid-game.** `sw.js:79` calls `skipWaiting()` and
      `sw.js:100` calls `clients.claim()`. Combined with the auto-reload in
      `index.html:957`, the page reloads as soon as a new SW activates — but
      only when no `.cell.revealed` is present. The "playing" check is
      brittle: it reads DOM at the moment the listener fires, but a player
      who just clicked their first cell and is about to click the next
      could be yanked. Fix: replace `.cell.revealed` heuristic with
      `state.status === 'playing'` (game's own truth). And: don't
      `skipWaiting()` unconditionally — have the page agree first via
      postMessage.

- [ ] **1.5 Push handler runs in stale code.** A push arriving days after
      the user last opened the app wakes the OLD `sw.js` (whatever was
      active then) and runs the push handler with stale logic. If you ever
      change the push payload schema or deepLink rules, the handler
      interprets new payload with old code. Fix: treat the push payload
      schema as a permanent contract. Version it (`{ v: 2, ... }`) and
      keep v1 fallback forever. Add a `console.warn` in the handler when
      it sees an unknown version (will surface in remote diagnostics
      once item 12.1 ships).

### iOS / storage

- [x] **2.1 / 5.1 Persistent storage.** **Shipped v1.5.73** as
      `requestPersistentStorage()` in `src/storage/storageAdapter.js`,
      called fire-and-forget from `main.js` right after the storage-
      failing toast check. Per R4 research the call is silent on iOS
      Safari (no permission prompt — installed PWAs grant automatically)
      and on Chrome / Firefox once the engagement heuristic passes. We
      call at boot rather than after-first-completion as the doc
      originally suggested: the call costs nothing if it fails, and
      calling early means even a player who never finishes their first
      daily still gets the protection on subsequent visits. Result is
      cached at `gregsweeper_persist_granted` for diagnostics
      readback via `getPersistentStorageStatus()`.

- [ ] **2.3 Verify shell-cache fix actually works.** Ship a probe: a
      static `_v.txt` file at the repo root containing the build version.
      Fetch on every app load. Write `lag = days behind deployed` to
      Firebase. If lag > 24h on any user, residual iOS shell-cache problem
      that warrants more aggressive mitigation. This is the validation
      step for today's structural fix.

### Offline + update safety

- [ ] **4.1 Offline navigation fallback.** Current `fetch().catch(() =>
      caches.match(...))` can resolve to undefined on a navigation request
      that misses both network and cache → blank page. Add
      navigation-request fallback:
      ```js
      if (event.request.mode === 'navigate') {
        return caches.match('./index.html', { ignoreSearch: true })
          || new Response('<h1>GregSweeper offline — reconnect to update.</h1>',
                          { headers: { 'Content-Type': 'text/html' } });
      }
      ```

- [ ] **6.3 Mid-game update safety.** The 5-min mismatch detector
      (`index.html:1027`) checks `playing = !!document.querySelector('.cell.revealed')`.
      Same brittleness as 1.4. Use `state.status` source-of-truth AND
      modal-open detection. Always `persistGameState()` before reload;
      pause 200ms for the write to land.

### Security

- [x] **9.5 Player-name XSS audit.** ~~The leaderboard renders `name` from
      Firebase.~~ **Audit clean v1.5.72.** Every render site
      (`main.js:816` weekly, `main.js:983` daily) goes through
      `escapeHtml(entry.name)` — the createElement→textContent→innerHTML
      pattern, bulletproof. Submission paths in `firebaseLeaderboard.js`
      already cap length and trim. Defense in depth added:
      (a) Firebase rules now reject names containing `<`, `>`, `&`, `"`,
      `'`, or backtick on both `daily/$date/$entry/name` and
      `weekly/$weekStart/$uid/name` (regex
      `/^[^<>&\"'`]+$/`); (b) `setPlayerName` in `statsStorage.js`
      strips the same chars before saving locally so the player can't
      type a name that would silently fail submission. Requires
      `firebase deploy --only database` after push.

- [ ] **11.4 Audit zero sensor-permission usage.** Confirm: no
      `navigator.geolocation`, no `getUserMedia`, no clipboard read.
      Currently true; document in CLAUDE.md as a deliberate constraint.

### Accessibility

- [x] **10.1 Modal focus trap.** **Shipped v1.5.74.** Per R2 research,
      native `<dialog>` doesn't auto-trap on iOS Safari, so the custom-
      modal + JS-trap path was the right call regardless of which it
      was easier to write. `src/ui/modalManager.js` now: captures
      `document.activeElement` at `showModal`, focuses the first
      visible focusable inside, attaches a Tab/Shift+Tab handler that
      wraps focus inside, and restores focus to the trigger element on
      `hideModal` / `hideAllModals`. Verified in Playwright on the
      Settings modal — Tab from the last button (Reset Profile)
      wraps to the close ×, Shift+Tab from × wraps to Reset Profile.
      Per-modal state in a WeakMap so multiple modals stack safely
      even though the app pattern is one-at-a-time.

### Observability

- [x] **12.1 Remote error reporting.** ~~Without this, the next debug session
      looks exactly like today's — hours of guessing.~~ **Shipped v1.5.71**
      in `src/diagnostics/errorReporter.js`, wired in `src/main.js` right
      after the SW codeVersion handshake. Captures `error` +
      `unhandledrejection`, buffers until uid resolves, drains via 1s
      flush. Writes `errors/{uid}/{timestamp} = { message, stack, url,
      codeVersion, userAgent, isStandalone, createdAt }`. Capped at 10
      per session. Owner-readable via Firebase Console; per-uid read so
      Kate can't see Chris's errors and vice versa. Test with
      `?debug=1` then `gsTestError('label')` in DevTools. Firebase rules
      updated in `firebase-rules.json` — requires `firebase deploy --only
      database` after push.

---

## Tier P1 — ship next 1-2 weeks

### Service worker

- [ ] **1.1 Drop the 30s update poll.** `index.html:949` polls
      `reg.update()` every 30s for the entire tab lifetime. With the new
      5-min version-mismatch check, it's redundant. Replace with
      visibilitychange trigger:
      ```js
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
      ```

- [ ] **1.2 Single SW registration path.** `index.html` has TWO register
      paths (head + body, lines 84 and 945). They can race on first
      install. Consolidate into a single body-script registration; reduce
      head to just the `controllerchange` reload listener.

- [ ] **1.6 Pre-cache Firebase CDN scripts.** Cold-start pulls 4 SDK
      files (~300 KB) through SW with `cache: 'no-store'`. Add a runtime
      cache-first handler for the four exact gstatic URLs (whitelist by
      path so it can never accidentally cache other cross-origin content).
      When SDK version bumps (10.14.1 → 11.x), new URL pattern misses
      cache and re-downloads cleanly.

### iOS / Android

- [ ] **2.2 Server-side push liveness signal.** `send-push.mjs` already
      clears subscription on UNREGISTERED. Add "last successful push"
      timestamp written to `users/{uid}/lastPushAt` so the diagnostics
      modal shows staleness without console access.

- [ ] **3.1 / 3.2 Manifest immutability.** WebAPK update is unreliable
      for `name`, `short_name`, and `icons`. Pin manifest shape in
      CLAUDE.md as frozen. NEVER rename `manifest.json` or move it
      (orphans every installed WebAPK forever).

### Offline / cache strategy

- [ ] **4.2 Strategy-by-request-type.** `cache: 'no-store'` on every
      fetch fixed today's stale-HTML problem but kills repeat-visit
      speed by re-fetching every CSS/PNG/font on every load. Split:
      - HTML / `request.mode === 'navigate'`: NetworkFirst with `no-store`
        (current, correct).
      - Static assets (CSS, PNG, SVG, fonts, themes):
        StaleWhileRevalidate WITHOUT `no-store` — serve cached, refresh
        in background.
      - JS modules: NetworkFirst with `no-store` (versions can change
        outside of CACHE_NAME bumps).
      - JSON config (`handicaps.json`, `experimentTarget.json`,
        `modelHistory.json`): NetworkFirst with `no-store` (these change
        every refit).

- [ ] **4.4 Cross-origin Firebase cache.** Combines with 1.6 above —
      same implementation.

### Storage

- [ ] **5.2 Quota monitoring.** Periodic `navigator.storage.estimate()`.
      If `usage / quota > 0.8`, prune `minesweeper_daily_par_*` keys
      older than 90 days. Surface usage in diagnostics modal so we can
      see when a returning user has been wiped.

### Updates

- [ ] **6.1 BroadcastChannel for split-brain.** Two tabs of different
      versions sharing localStorage can write/read different schemas.
      Coordinate via `BroadcastChannel('gregsweeper-update')` so when
      one tab detects an update, the other safely defers reload until
      idle.

- [ ] **6.2 cacheClear ordering.** `index.html:964` reads
      `window.gregsweeperCacheClear` — defined later in the same file.
      Move the function definition to a head script so it's available
      before the update banner could need it.

### Manifest / install

- [ ] **7.1 Add manifest fields.** `id` is critical (must add NOW or
      future scope changes duplicate-install). Plus `description`,
      `categories`, `screenshots`. See agent's full spec; the `id`
      should be `/Minesweeper/` (or whatever the deployed scope is).

### Performance

- [ ] **8.3 Await cache.put.** `sw.js:181` doesn't `event.waitUntil(...)`
      the cache write. SW termination between response return and put
      completion = lost cache entry. Wrap in waitUntil.

### Security

- [ ] **9.1 / 9.2 postMessage origin validation.** Both directions
      currently accept any source. Validate `event.source.url` origin in
      SW handler; validate `e.source` matches registered SW in page
      handler.

### Accessibility

- [ ] **10.2 Toast aria-live.** Add `role="status" aria-live="polite"
      aria-atomic="true"` to `#toast-container` in `index.html:432`. For
      critical messages (errors, "stale build"), add a separate
      `aria-live="assertive"` container.

- [ ] **10.4 Audit no `history.back()`.** Standalone display-mode hides
      browser chrome. A back-button-driven modal close would exit the
      app. Verify nothing in the codebase does this.

### Permissions

- [ ] **11.2 Notification pre-prompt.** Show your own modal first
      ("Want a daily ping when today's puzzle is ready? You can change
      this anytime in Settings.") before triggering
      `Notification.requestPermission()`. Browser remembers Block forever
      — protect the one shot.

### Observability

- [ ] **12.2 SW health endpoint.** On every SW activate, write
      `users/{uid}/swHealth = { lastActivate, codeVersion, userAgent }`.
      Lets you spot stuck-on-stale population from admin diagnostics.

- [ ] **12.4 Deploy-confirmation page.** Admin-only view of swHealth
      entries sorted by codeVersion ascending. Watch the list shrink
      after a deploy.

### Misc

- [ ] **13.1 pageshow bfcache check.** When iOS Safari restores from
      bfcache after midnight ET, `state.dailySeed` is stale. Reload if
      `gameMode === 'daily'` and `state.dailySeed !== getLocalDateString()`.

- [ ] **13.3 CI grep check for messaging.getToken signatures.** Every
      `getToken` call must pass `serviceWorkerRegistration: reg`;
      otherwise FCM auto-registers a non-existent
      `firebase-messaging-sw.js` and silently fails.

---

## Tier P2 — defer until P0/P1 clean

| ID | Item |
|---|---|
| 1.3 | Scope-mismatch guard (consistency check on registered SW scope) |
| 3.3 | Notification-click URL deepLink parsing (proper URL.pathname compare) |
| 4.3 | Navigation preload via `registration.navigationPreload.enable()` |
| 5.3 | Surface `isStorageFailing()` as a visible warning toast |
| 6.4 | "What's New" modal accumulates entries across version skips |
| 7.2 | Capture `beforeinstallprompt` for in-app install button |
| 7.3 | Web Share Target API (likely needs Cloud Function, GH Pages incompat) |
| 8.1 | SW message-port cleanup (only matters at very high tab counts) |
| 8.2 | IndexedDB transaction lifetime if/when SW writes IDB directly |
| 8.4 | Bounded cache size (LRU prune on activate beyond install set + 100) |
| 9.3 | CSP `<meta http-equiv>` (limited; some directives need HTTP header) |
| 9.4 | start_url scope validation (low practical risk; ours is clean) |
| 10.3 | Keyboard navigation on the board itself (out of scope for this pass) |
| 11.3 | Permission-revocation detection (Notification.permission === 'denied' but Firebase enabled) |
| 12.3 | Cache hit/miss telemetry counter |
| 13.2 | Generalize `Date.now()` differential pattern for all timers |
| 13.4 | `apple-touch-startup-image` for iOS launch splash (~12 image sizes) |
| 13.5 | Verify Google Fonts `font-display: swap` actually swapping |

---

## Open research questions

These are items where the research agent flagged a design decision but the
right answer needs a small spike before implementation. The new session
should resolve these BEFORE writing the code:

### R1. Manifest `id` field — adding to existing deployment

When you add `"id"` to a manifest that's been live for a while, what
happens to existing PWA installs?
  - Best case: silent migration; existing installs adopt the id.
  - Plausible bad case: existing installs orphan and a new install with
    the id appears as a duplicate on home screen.

**Test plan.** Set up a throwaway PWA on a test domain. Install it. Add
`id` field to manifest. Wait for WebAPK update. Verify installs aren't
duplicated. If they ARE duplicated, the id should be added BEFORE
launching publicly. Currently low-stakes (only Chris and Kate installed),
so we have a one-time window to set it. **Priority: do this BEFORE any
broader user invitation.**

### R2. `<dialog>` element on iOS Safari standalone mode

Native `<dialog>` + `.showModal()` is the cleanest path for item 10.1
(modal focus trap), but iOS Safari has had bugs with `dialog::backdrop`
on older WebKit. We need iOS 16+ for push anyway, so `<dialog>` should
work — but verify on actual iOS PWA before rewriting all modals.

**Test plan.** Build one modal as `<dialog>` in a branch. Test on Kate's
iOS (16.x). Check: focus trap works, Escape closes, `.modal` CSS still
applies, scroll lock works, backdrop click handler still fires. If any
fail, fall back to manual focus-trap implementation.

### R3. CSP via meta tag — what's actually enforceable?

The agent recommended `<meta http-equiv="Content-Security-Policy">` since
GH Pages can't set HTTP headers. But several CSP directives are HTTP-only
(notably `frame-ancestors`, `report-uri`, sandbox in some browsers). Need
to enumerate which directives ACTUALLY enforce via meta on Chrome and
Safari. Worth a quick test, otherwise we ship a CSP that LOOKS enforced
but isn't.

**Source to check.** [MDN CSP `<meta>` element notes](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP).

### R4. `navigator.storage.persist()` UX on iOS Safari

Agent claims it's silent (no permission prompt) on Chrome and Safari.
Verify on actual iOS Safari standalone PWA. Some sources suggest iOS
Safari may show a prompt for this; the agent's assertion needs
verification.

**Test plan.** Open the PWA, call `navigator.storage.persist()` from
DevTools / a test button. Observe whether any UI appears. If silent,
wire it up as planned. If there's a prompt, gate it behind a more
explicit "save my progress" UI moment.

### R5. Bayesian par-model fitting on N=2 users — is brms doing the right thing?

Today the par-model R script fits with informative lognormal priors on
each coefficient. With only 2 distinct users and ~115 scores, the
posterior is heavily prior-driven. Need a check: does the variance of
the posterior shrink as N grows past, say, 200? Or does it plateau,
suggesting the data isn't actually informative on certain features?

**Test plan.** Look at modelHistory.json over time; track posterior SD
of each coefficient as N grows. If certain coefficients (probably
gimmick-related ones with sparse representation) show no shrinkage,
flag them as "not yet identified" in the diagnostics modal.

### R6. Push payload schema versioning pattern

Item 1.5 says treat push payload as a permanent contract. The standard
pattern is:
```json
{ "v": 1, "title": "...", "body": "...", "tag": "...", "deepLink": "..." }
```
But the SW handler today reads from `notification.*`, `data.*`, and
root.* (multi-shape). Need to decide: do we EXPLICITLY add `v: 1` now
even though no v0 exists? Or wait until we need v2? The conservative
choice is "add v: 1 now, ignore for v1, treat absence as v1." That way
when v2 ships, `if (raw.v >= 2)` is the migration boundary.

### R7. WebAPK deep-link launch URL semantics

When a notification with `deepLink: './?mode=daily'` is tapped on
Android, Chrome routes through the WebAPK. What's the actual launch URL
the PWA sees? Is it the deepLink as-written, or does WebAPK normalize
to `start_url` and pass deepLink as a referrer? This affects the
`focus()`-existing-tab logic in the SW notificationclick handler.

**Test plan.** Send a push with deepLink. Tap it. Inspect
`window.location.href` and `document.referrer` in the resulting page.
Compare to the SW's `clients.matchAll()` URL strings. Adjust the
endsWith() comparison if needed (item 3.3).

### R8. Storage budget for remote error reporting (12.1)

If we write to `errors/{uid}/{timestamp}` on every uncaught error, what's
the worst-case Firebase write cost? Need a back-of-envelope: assume
10 errors/session × N daily users × 30 days. Compare to free-tier
Realtime DB limits. If ceiling is reached, add a server-side cron that
prunes errors older than 30 days. Probably free-tier-fine but worth
confirming before shipping.

---

## Suggested 1-week sprint (P0 only)

If you have appetite for ~5 items, these would deliver the biggest blast-
radius reduction:

1. **12.1 Remote error reporting** — unblocks all future debugging.
2. **9.5 XSS audit on player names** — single bad-actor name takes down
   every leaderboard viewer. Highest-severity risk on the list.
3. **10.1 Modal focus trap** — accessibility table-stakes for primetime.
   Resolve R2 first; native `<dialog>` is the cleanest path.
4. **2.1 / 5.1 Persistent storage** — three-line call after first daily
   completion. Resolve R4 first.
5. **6.3 Mid-game update safety** — already have the self-healer; this
   tightens the safety check (~10 lines).

That set is roughly 1-2 evenings of work and addresses the highest-blast-
radius items without touching the core game logic.

---

## Reference: structural fixes shipped 2026-05-07

For context when reading this list — these are the foundations the items
above build on:

- `<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">`
  + `<meta http-equiv="Pragma" content="no-cache">` + `<meta http-equiv="Expires" content="0">`
  in `index.html` (browsers and PWA shells now refuse to cache the HTML)
- Service worker `fetch()` passes `cache: 'no-store'` for same-origin
  requests (bypasses HTTP cache; FUTURE WORK: switch to strategy-by-
  type per item 4.2)
- Cross-origin requests skip SW entirely (FUTURE: cache-first for
  Firebase CDN per item 1.6)
- 5-minute version-mismatch self-healer in `index.html`: fetches live
  `sw.js` with `no-store` + unique query, parses CACHE_NAME, force-
  reloads if it differs from the SW's broadcast codeVersion (only when
  not mid-game)
- Toast container `z-index` raised from 1000 to 10000 to render above
  modals (which sit at 1001)
- `enableNotifications` and `refreshTokenIfStale` in
  `src/firebase/firebasePush.js` now do
  `pushManager.getSubscription().unsubscribe()` BEFORE
  `messaging.deleteToken()` + `getToken()`. This breaks the
  "FCM mints a new token tied to a dead browser subscription" cycle
  that was 404ing every push.
- Service worker push handler reads from `raw.notification.*`,
  `raw.data.*`, and root.* in priority order so it tolerates any FCM
  payload shape variation.
- `scripts/send-push.mjs` writes title/body to BOTH `notification`
  field and `data` field of the FCM v1 message so legacy SW shapes can
  also extract them.
- Notification toggle no longer auto-disables when
  `firebase.messaging.isSupported()` returns falsy at sync time (the
  toggle's own change handler reports specific error toasts instead).

If a future change reverses any of these, expect the corresponding bug to
return.

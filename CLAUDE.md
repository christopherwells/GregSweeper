# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
GregSweeper — modern Minesweeper game built with vanilla JavaScript (ES6 modules). No framework, no bundler, no package.json. Deployed on GitHub Pages.

## Development

**Local server:** `python -m http.server 8080` (or use `GregSweeper.bat` which opens the browser too).
No build step, no npm install, no dependencies to manage. Firebase SDK loaded via CDN.

**Testing:** No automated test framework. Use `debug-gimmicks.html` for interactive modifier testing (8x8 board with per-gimmick controls). For UI verification, use Playwright via MCP.

**Deploy:** Push to `master` branch triggers GitHub Pages. After push, bump `CACHE_NAME` in `sw.js` (format: `gregsweeper-v1.4.N`). No CI/CD pipeline.

## Key Architecture

**Entry point:** `src/main.js` (large orchestrator file) handles init sequence: theme load, Firebase init, storage check, URL params (`?mode=daily` deep link), onboarding/tutorial, then title screen or game.

**State:** `src/state/gameState.js` — single mutable state object (~60 properties). Direct property mutations, not immutable. `dirtyCells` Set tracks changed cells for targeted re-renders.

**Core modules:**
- `src/game/gameActions.js` — newGame(), revealCell(), toggleFlag()
- `src/game/modeManager.js` — switchMode() for Challenge/Timed/Daily/SkillTrainer/Chaos
- `src/game/winLossHandler.js` — handleWin(), handleLoss(), handleDailyBombHit()
- `src/game/timerManager.js` — timer and mine-shift intervals
- `src/game/gamePersistence.js` — save/restore game state (auto-persists every 5s while playing)
- `src/logic/` — boardGenerator, boardSolver, constraintSolver, difficulty, gimmicks, powerUps, skillTrainer, achievements, seededRandom
- `src/ui/` — boardRenderer, headerRenderer, modalManager, powerUpBar, effectsRenderer, themeManager, skillTrainerUI, collectionManager, toastManager, tutorialManager, domHelpers
- `src/storage/statsStorage.js` — localStorage persistence for stats, power-ups, checkpoints
- `src/storage/storageAdapter.js` — graceful fallback from localStorage to in-memory Map (private browsing, quota exceeded)
- `src/firebase/firebaseLeaderboard.js` — online leaderboards; Firebase config is hardcoded in this file

## Board Solver Architecture

Two-layer solver guarantees no 50/50 guesses:

1. **Board solver** (`boardSolver.js`): Simulates full game playthrough from first click. Wall-aware neighbor lists. Gimmick handling via `getPlayerVisibleCount`:
   - **Mystery / sonar / compass / wormhole:** return UNKNOWN (no direct per-cell constraint; sonar/compass/wormhole contribute separate gimmick-range constraints in Pass B/C).
   - **Liar:** return UNKNOWN. Liar's displayed value is true count ±1 — a disjunctive constraint, not a single value. `buildLiarConstraints` emits `{allowedMines: [X-1, X+1]}` for Pass C tank solver.
   - **Mirror:** return `cell.adjacentMines` (the true count). The displayed value shows the partner's count for visual deception; a smart player who recognizes the pair can mentally un-swap. Using `displayedMines` would create false constraints that made post-gimmick boards spuriously unsolvable.
   - Returns `{ solvable, remainingUnknowns, totalClicks, techniqueLevel }` where `techniqueLevel` is 0 (Pass A), 1 (Pass B subset), 2 (Pass C tank/gauss), or 3 (required disjunctive liar reasoning).

2. **Constraint solver** (`constraintSolver.js`): Union-find partitions independent constraint groups. Constraints use `allowedMines: number[]` — single-element for exact, multi-element for disjunctive (liar). Tank solver (bitmask brute-force with disjunctive check) for <=20 unknowns; Gaussian elimination for larger groups (exact constraints only — disjunctive filtered out before gauss).

**Generation (challenge mode, `gameActions.js`):** Retry loop with two layers of "smart":
- **Constructive mystery placement** — mystery cells are placed one at a time, verified after each; kept only if the board stays solvable. May place fewer than requested intensity. Other gimmicks (sonar/compass/wormhole/wall/liar/etc.) contribute info, so random placement works for them.
- **Technique-floor verification** — each level demands a minimum `techniqueLevel` via `getRequiredTechnique(level)`: L1-30→0, L31-60→1, L61+→2. Boards below the floor are rejected. After 15 base-board attempts without success, the floor relaxes to 0 so we don't spin forever.
- Up to 25 gimmick re-rolls per base board before regenerating the (expensive) base board. Daily strips gimmicks if unsolvable. Chaos is exempt from solvability.

## Important Patterns

- **DOM structure:** `#title-screen` is a sibling of `#app`, not inside it. Modals are inside `#app` — when `#app` has `.hidden` class (display: none), child modals can't render. Modals that need to show on title screen must be outside `#app`.
- **`_returnToTitle` flag** in main.js tracks when modals were opened from the title screen.
- **`$()` / `$$()`** are querySelector/querySelectorAll helpers from `src/ui/domHelpers.js`.
- **"Gimmicks" in code = "Modifiers" in player-facing UI.** Always use "Modifier" in user-facing text.
- **Daily mode** uses seeded RNG (`createDailyRNG(dateString)`) for deterministic boards per date.
- **`CURRENT_VERSION`** in main.js triggers "What's New" modal on first load after update.
- **`debug-gimmicks.html` has its own cell renderer** — fixes to `boardRenderer.js` do NOT automatically apply there. Both must be updated.
- **`generateBoard` calls `cleanSolverArtifacts`** on every return path (solver leaks `isRevealed` onto cells).

## Service Worker (sw.js)

Network-first with cache fallback. `ignoreSearch: true` on cache.match. Install uses `cache: 'reload'` to bypass HTTP cache. Activation deletes all old cache versions. Core assets pre-cached; non-default themes lazy-load.

**Cache busting:** Only bump `CACHE_NAME` in `sw.js`. No per-file `?v=` query strings on imports. SW registers on localhost too — unregister via DevTools or add `?v=N` when testing locally.

## Game Modes
- **Challenge (normal):** 120 levels, sawtooth difficulty, checkpoints every 5 levels, modifiers from L11+
- **Timed:** Race the clock, 4 difficulty tabs (Beginner/Intermediate/Expert/Extreme)
- **Daily:** One seeded puzzle per day, no levels. Modifiers are force-injected on improvement days when the target maps to a gimmick (sonar, wormhole, walls, mystery, liar, locked, mirror, compass) — see Adaptive Experimental Design. Falls back to the natural ~35% lottery only when the target is a non-gimmick feature (move-type counts, structural features).
- **Bonus Daily** (one-off): on dates listed in `BONUS_DAILY_DATES` in `main.js` (currently `2026-05-07` only) the title screen surfaces a second daily card. The bonus uses a `YYYY-MM-DD_bonus` seed everywhere (Firebase keys, completion flag, RNG input) and runs the SAME generation pipeline (`selectDailyRngSeed` → 10 candidate slots → primary + coverage missions). Bonus completions submit to `daily/{date}_bonus/` and write features to `dailyMeta/{date}_bonus` so the R refit picks them up as separate rows. They DO NOT touch streak / handicap / `dailyHistory` / regular `markDailyCompleted` — completing the bonus is free play. Tracked separately via `markBonusDailyCompleted` (`minesweeper_bonus_daily_completed_date` localStorage key) so the regular completion flag isn't clobbered. Firebase rules accept the `(_bonus|_weekly_first)?` suffix for `daily/$date`, `dailyMeta/$date`, and `dailyBoard/$date`. The bonus canonical board must be pre-generated via `node scripts/precompute-daily-board.mjs YYYY-MM-DD_bonus` before the date goes live.
- **Weekly:** ONE single canonical puzzle for the whole ET week (Monday → Sunday), one attempt per day for 7 days. Best time across the 7 attempts wins. Same bomb-hit mechanic as daily (10s + reveal-fog reset, no game-over). Board size 8–14 × 8–14, 2–4 modifiers stacked, daily-density. Architecture mirrors daily's canonical-board: `weeklyBoard/{weekStart}` is write-once on Firebase, pre-generated by `precompute-weekly-board.yml` Monday 00:00 UTC (`scripts/precompute-weekly-board.mjs`). Cloud-synced one-attempt-per-day cap at `users/{uid}/weeklyAttempts/{weekStart}/dayAttempts/{N}` so clearing localStorage can't grant a second try. Leaderboard is one row per player per week at `weekly/{weekStart}/{uid}` (set, not push) carrying `bestTime` and a `dayTimes` map. Submission helpers: `submitWeeklyScore`/`fetchWeeklyLeaderboard` (firebaseLeaderboard.js), `markWeeklyDayAttempted`/`loadWeeklyAttempts` (firebaseProgress.js). Seed selection in `selectWeeklyRngSeed.js` scores 10 candidates by `activeGimmicks.length + advancedLogicMoves * 0.01`. Gimmick pool: `getWeeklyGimmicks` picks 2–4 distinct from the daily-safe subset, no `singleOnly`. **First-attempt-of-the-week qualifies for par-model fit data**: when `Object.keys(state.weeklyDayTimes).length === 0` at win time, winLossHandler additionally calls `submitOnlineScore('{weekStart}_weekly_first', ...)` so the score lands in `daily/{weekStart}_weekly_first` and features in `dailyMeta/{weekStart}_weekly_first`. Days 2–7 attempts are speedruns of a known board and stay out of the fit. Weekly does NOT touch streak / handicap / `dailyHistory`. The Stats modal has a Weekly tab with a 7-day line chart.
- **Skill Trainer:** 15 interactive lessons — currently HIDDEN from the UI but code intact (see `src/logic/skillTrainer.js`, `src/ui/skillTrainerUI.js`). Re-enable by uncommenting the mode card in `index.html` and the help-modal bullet.
- **Chaos:** Rapid rounds with random modifiers, exempt from solvability guarantee

## Push Notifications
PWA web push via FCM, opt-in via Settings (`Notifications` block alongside the modifier-popup toggle). The `notify-daily-ready.yml` workflow runs an hourly cron at `0 * * * *` UTC; `send-push.mjs` reads each enabled subscriber's `notificationPrefs.hourLocal` from Firebase and only sends to those whose chosen ET hour matches the current ET hour. So each subscriber gets at most one push per day at the time they picked in Settings.

Message text rotates day-to-day from a small per-category pool (`DAILY_BODIES`, `WEEKLY_BODIES`, `BONUS_BODIES` in `send-push.mjs`). Pick is deterministic by date so all subscribers on the same day see the same line, but the wording varies day-to-day instead of repeating "Today's daily is waiting" forever. Categories: `weekly` (Monday — overrides daily), `bonus` (`BONUS_DAILY_DATES`), `daily` (default).

- `src/firebase/firebasePush.js`: `enableNotifications({hourLocal})`, `disableNotifications()`, `loadNotificationPrefs()`, `updateNotificationHour()`. Hardcoded `VAPID_PUBLIC_KEY` constant — set this from the Firebase Console value (Project Settings → Cloud Messaging → Web Push certificates) before push will work. Empty string = `'no-key'` toast.
- Subscription stored at `users/{uid}/pushSubscription = { token, subscribedAt }` with auth.uid match. Token is the FCM-managed string from `messaging.getToken({vapidKey})` — server-side script POSTs against `fcm.googleapis.com/v1/projects/{id}/messages:send` using this token.
- Prefs stored at `users/{uid}/notificationPrefs = { enabled, hourLocal, dailyReminder, streakWarning }`.
- SW handlers in `sw.js`: `push` event renders the notification with icon + tag + deepLink in `data`; `notificationclick` focuses an existing tab matching the deepLink or opens `?mode=daily` / `?mode=weekly`.
- **Manual prereqs (one-time setup before push works)**: (a) Generate VAPID key pair in Firebase Console → Cloud Messaging → store the **public** key as the `VAPID_PUBLIC_KEY` constant in `src/firebase/firebasePush.js` (safe to ship publicly), (b) Generate a service-account JSON in Firebase Console → Project Settings → Service Accounts → store the entire JSON (one line) as the `FIREBASE_SERVICE_ACCOUNT` repo secret. Without (a) the toggle shows "Push not configured yet"; without (b) the workflow fails on access-token mint.
- iOS: requires add-to-home-screen on iOS 16.4+. `firebasePush.js` detects iOS-non-standalone and surfaces "Install GregSweeper to your home screen first" instead of silently failing. Android/desktop work without that hoop.
- Categories: `weekly` (Mon morning), `bonus` (BONUS_DAILY_DATES), `daily` (default). The cron picks based on the calendar; per-category opt-out via `notificationPrefs.dailyReminder` (default true).

## Greg-par Model (Daily)
Daily par is a linear regression over board features, fit in R offline against real completion data. Coefficients live in `PAR_MODEL` in `src/logic/difficulty.js`; the whole model lives in `src/logic/dailyFeatures.js` (`computeDailyFeatures`, `predictPar`, `breakdownPar`).
- **Move type, not move count, is the primary signal.** The solver in `boardSolver.js` classifies every deduction into one of five buckets at the three `totalClicks++` sites: `passAMoves` (trivial propagation), `canonicalSubsetMoves` (Pass B subset with larger-constraint size ≤3 — 1-1 / 1-2 / 1-1-1 shapes), `genericSubsetMoves` (Pass B, size ≥4), `advancedLogicMoves` (Pass C tank/gauss), `disjunctiveMoves` (Pass C with liar). Invariant: `passA + canonical + generic + advanced + disjunctive + 1 === totalClicks` for solvable boards. Of these five, only the first four are model coefficients — `disjunctiveMoves` was dropped from the regression on 2026-05-04 because it's structurally confounded with `liarCellCount` (every liar board produces disjunctive moves) and we had N=1 liar board, so the two coefficients couldn't be separately identified. The solver still counts `disjunctiveMoves` for diagnostics; the linear predictor just doesn't multiply it.
- **Feature vector:** move-type counts + board shape (rows, cols, cellCount, totalMines, wallEdgeCount, etc.) + gimmick cell counts (mystery, liar, locked, wormhole/mirror pairs, sonar, compass). All numeric, safe to JSON-serialise for Firebase.
- **End-of-game modal** renders a per-term breakdown below par: `+14s advanced logic · +9s generic subsets · …`. Baseline terms (intercept + size + flag count) are merged into a single chip to keep the line readable.
- **R refit workflow:** export Firebase JSON from the console → run `scripts/fit-par-model.qmd` → paste the emitted `PAR_MODEL = { ... }` block into `difficulty.js` → commit + deploy. The .qmd also runs diagnostics (residual plots, QQ for log-linear check, VIF for collinearity, bootstrap CIs).
- **Pre-ship scale anchor:** `scripts/calibrate-today.mjs` regenerates today's daily board locally and verifies `predictPar` lands inside the observed completion-time range before shipping new coefficients. One-board check, not a fit.

## Daily History Chart
- `src/ui/dailyHistoryChart.js` — pure-SVG timeline of the signed-in user's past 30 days of deltas from par. Rendered below the leaderboard table on modal open. No external library. Dots coloured green (under par) / grey (even) / red (over).
- Data source: `users/{uid}/dailyHistory/{date} = { time, submittedAt }` in Firebase — ONLY the raw time is stored. Par and delta are computed at render time against the current `PAR_MODEL` (via `predictPar` on `dailyMeta/{date}` features) PLUS the user's current handicap. This keeps older entries automatically in sync with the latest model after each refit — no server-side rewrites needed.
- The delta plotted is against the user's PERSONAL par (global par + handicap), so a dot below zero means "better than your typical" regardless of how fast you are in absolute terms.

## Handicaps (user-specific par offsets)
- Each user has a handicap in seconds — their typical over/under vs Greg's par across recent dailies. Golf-style: negative = faster than typical, positive = slower.
- Stored in `src/logic/handicaps.json`, a static JSON asset committed to the repo. Keyed by Firebase anonymous uid. Not in Firebase — shipping via static file avoids write-permission issues and lets handicaps update the same way everything else does (commit → GitHub Pages redeploy).
- Computed server-side (well, GitHub-Actions-side) by `scripts/refit-par-model.R` running daily: fits `brm(time ~ features + (1|uid))` with informative lognormal priors on each fixed-effect coefficient (centered on seed values, log-scale sigma = 1.0) plus `student_t(3,0,5)` on the between-user SD. Posterior means go to `PAR_MODEL`; random-intercept posterior means become handicaps after play-weighted recentering so they sum to approximately zero across users. Falls back to the mean-residuals path when N or n_players is below the fit threshold.
- Client reads via `src/logic/handicaps.js`: `loadHandicaps()` fetches once, `getHandicap(uid)` returns the number or 0, `getHandicapsMeta()` returns `{updatedAt, modelFitN, nPlayers, method}`. Used in the end-of-game modal to show "Your par" alongside "Greg's Time" and in the diagnostics modal to surface what the user's device has cached.

## Refit Workflow (.github/workflows/refit-par-model.yml)
- Runs daily at 10am America/New_York (14:00 UTC; 9am ET in winter since Actions cron doesn't observe DST).
- Pulls `daily/*` and `dailyMeta/*` from Firebase (both world-readable — no secrets required), fits the Bayesian mixed-effects model via `brms` + Stan, patches `src/logic/difficulty.js` between `PAR_MODEL:START` / `PAR_MODEL:END` markers, and rewrites `src/logic/handicaps.json`. Commits both files under "Christopher Wells" identity and pushes to master; GitHub Pages redeploys.
- Guards: `MIN_SCORES_TO_FIT = 30` (total scores required, priors do the regularisation so the old `MAX_COEF_DRIFT` clamp was retired), `MIN_PLAYS_FOR_FIT_INCLUSION = 30` (per-user TOTAL-play threshold — only users above this contribute to the global PAR_MODEL and receive a handicap entry in handicaps.json; below-threshold users get a provisional handicap computed client-side via `estimateHandicapFromHistory`. Bomb-hit plays count toward the threshold now that they're included in the fit via the `bombHits` regressor), `ADAPT_DELTA = 0.99` with `MAX_DIVERGENT_FRAC = 0.25%` — a fit that comes back with Rhat > 1.05, ESS < 400, or more than 0.25% divergent transitions is rejected and the previous `PAR_MODEL` stays.
- Priors live in `PRIOR_MEANS` + `PRIOR_SIGMAS` at the top of the R script. Each per-coefficient prior is `lognormal(log(mean), sigma)`, naturally positive, with sigma = 1.0 giving roughly `[seed/2.7, seed*2.7]` at ±2 SD — wide enough for data to move a well-supported coefficient, tight enough to stop the collinearity-driven 10x swings the old lme4 fit produced at N=62.
- After the fit: random-intercept means are play-weighted-recentered to sum to zero (brms's sampler can park any overall baseline in either the global intercept or the random intercepts; without this recentering both users' handicaps come out shifted by the same ~100s constant). Intercept is then bias-corrected so mean(clean-time-equivalent predicted par) = mean(actual time minus `bombHits * bombCoef`) across the FIT POPULATION — subtracting the bomb contribution from the actual times before comparing keeps `predictPar` as "clean-play par" while still including bomb-hit plays in the fit.
- First CI run after a `brms` package cache miss takes ~5 min (Stan + dependencies compile). Subsequent runs hit the cache and finish in ~2–3 min including Stan model compilation.
- **Bomb-hit plays ARE INCLUDED in the fit via a `bombHits` regressor** (one fitted constant ≈ +14.66s per hit, surfaced in `handicaps.json` as `secPerBombHit`). The regressor is fit-only — NOT shipped to JS `predictPar`, which stays "clean-play par." This was changed from the earlier filter-out approach because filtering threw out ~60% of plays with asymmetric bias (Chris's bomb-hit rate is higher than Kate's, so the clean subset over-represented him on easy boards). From v1.5.9+ clients also submit per-hit `bombHitEvents: [{ t, row, col }, ...]` so a future bomb-adjusted model (option C in `NEXT_SESSION.md`) can re-run the solver with the hit cells pre-revealed and produce per-play effective feature vectors.
- New features added to the fit follow a threshold guard: until ≥20 plays have nonzero values for a given new feature, its coefficient is forced to 0 in the SHIPPED `PAR_MODEL` even if brms has fit a posterior. This avoids the lognormal-prior median (~prior_mean × 1.65) being shipped as a real coefficient, which would inflate `predictPar` with no data justification. The fit still treats it as a regressor so other coefficients aren't polluted by missing-data variance.
- `scripts/refit-par-model.R` is the full pipeline; `scripts/fit-par-model.qmd` is the exploratory Quarto notebook (diagnostic plots, VIF, bootstrap CIs) for interactive review.

## Canonical Daily Board (cross-client board agreement)
Every player on the same ET date plays the same board, period. Three divergence sources are eliminated:

1. **Code-version drift** between clients on different cached SW bundles. Same seed + different code = different board. Closed by storing the resolved board on Firebase, not the seed.
2. **Experiment-target drift** between clients with different cached `experimentTarget.json`. Same code + different target = different `selectDailyRngSeed` winner = different board. Same fix.
3. **Firebase cold-load race** where `loadDailyBoard` returns null because the Firebase SDK hasn't initialized yet, and the client silently falls through to local generation against a stale `experimentTarget.json` — different `:trialN` winner from whatever wrote the canonical, so same date but divergent board. Closed by `runStartupGate` in `main.js`, which renders nothing user-interactive until the SW is current, Firebase is ready, and today's canonical is in memory. Without this gate, a player who lost the cold-load race would silently play a divergent board (this happened to Kate on 2026-05-06 v1.5.30 — the trigger for the gate).

Mechanism:
- **`dailyBoard/{date}`** in Firebase Realtime DB stores the fully-resolved board (mine layout, gimmick assignments, displayed numbers, wall edges) — write-once at the rules layer.
- **`getLocalDateString()`** is anchored to America/New_York via `Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })`. A player in Tokyo loading at 9am JST sees the puzzle for the previous ET date if it's still before midnight ET.
- **`src/firebase/dailyBoardSync.js`** — `loadDailyBoard(date)` / `saveDailyBoard(date, payload)` / `serializeBoard({ board, rows, cols, ... })` / `deserializeBoard(raw)`. Both load and save now go through `waitForFirebaseReady` (50ms-poll up to 8s) so a cold-load race can't make them silently no-op. The serialiser drops `false`-valued booleans to keep the JSON tight (~30% smaller), and the deserialiser fills them back in from defaults so the consuming code sees a fully-shaped cell object.
- **Startup gate (`runStartupGate` in `main.js`)** — runs before `init`'s routing branch, behind the `#boot-overlay` div in `index.html`. Three steps: (1) `ensureLatestServiceWorker` — `registration.update()` and wait up to 3s for any new SW to activate (controllerchange handler in `<head>` reloads us if it does), (2) wait up to 8s for `firebase.apps.length > 0` and stash the result in `state.firebaseReady`, (3) pre-fetch `loadDailyBoard(today)` into `state.canonicalDailyBoard = { date, raw }`. Practice loads (`?seed=`) skip step 3. Boot overlay only hides at the END of `init` (after routing + first newGame await), so the player never sees a flash of a wrong board.
- **Daily entry path** (`gameActions.js` daily branch — `async`): read `state.canonicalDailyBoard` first; if it exists and matches `state.dailySeed`, deserialize verbatim (skip generation, gimmicks, solvability retry). Fall back to a fresh `loadDailyBoard` call only when the cached canonical is for a different date (tab open across midnight) or when the gate's fetch failed. If both miss, run the full local-generation flow and `saveDailyBoard` the result fire-and-forget so the next visitor sees what we generated. The solver still runs locally on the resolved board to compute features (move-type counts) and the best-start cell — that's deterministic, so different clients agree on features even if they came in via different paths.
- **Stale-completion check** in `runStartupGate`: if `isDailyCompleted(today)` is true but the player's Firebase score for today is missing or has an `rngSeed` that doesn't match the canonical's, clear `minesweeper_daily_completed_date` plus the cached par/moves keys. This is what unblocks a player whose previous load was divergent — without it, the "already completed today" toast would lock them out of replaying the canonical.
- **Saved-game divergence check** in `tryResumeGame` (`src/game/gamePersistence.js`): if a resumed daily save has `dailyRngSeed` ≠ `state.canonicalDailyBoard.raw.rngSeed`, return false to drop the save and let `newGame` use the canonical instead.
- **codeVersion provenance**: SW posts `{ type: 'codeVersion', value: CACHE_NAME }` to clients on activate, plus replies to `getCodeVersion` requests. Page caches the result in `state.codeVersion` and stamps it onto canonical-board writes (replaces the stale `'v1.5.19'` literal that used to lie about which build wrote a board).
- **On-demand par calc** in `main.js` (leaderboard modal opening before play) calls `loadDailyBoard` directly — also benefits from `waitForFirebaseReady` now.
- **Practice daily** (`?seed=...`) bypasses canonical fetch/write — practice is per-user and shouldn't pollute the shared bucket.
- **Pre-generation** runs nightly at 00:00 UTC via `.github/workflows/precompute-daily-board.yml` (`scripts/precompute-daily-board.mjs`). Anchoring to UTC gives a 4-5h buffer before the daily flips at 00:00 ET. The script runs the SAME pipeline `selectDailyRngSeed` + `gameActions.js` would: load the experiment target, force-inject the gimmick if applicable, run candidate selection across 10 trial seeds, pick the winner, write to Firebase. Idempotent — write-once rules silently no-op repeated writes for the same date.
- **One-off bootstraps** (e.g., a date played by a real user before the canonical-board ship): `scripts/bootstrap-daily-board.mjs` — hardcode date + seed + force-injection state, regenerate, write. Used to lock 2026-04-27 to Chris's actual played v1.5.18 board.
- **Audit script**: `scripts/audit-divergent-scores.mjs` reads `daily/*` and `dailyBoard/*` and reports any score whose `rngSeed` mismatches the canonical's for that date. Read-only by default; `--delete` flag does the cleanup. Used to confirm no historical divergent rows remain after the gate ships.

## Adaptive Experimental Design
- EVERY daily generates 10 candidate seeds (`${dateString}:trial0`..`trial9`), solves each, scores each by its assigned mission, and picks the highest-scoring candidate. ~500–800 ms of CPU on first daily load.
- **Multi-objective per-slot missions.** Slot 0 = the PRIMARY mission, force-injecting the high-CV target's gimmick (chosen by the R refit) and allowed to roll a second gimmick at the natural ~10% rate. Slots 1–9 = COVERAGE missions, each force-injecting a different undersampled gimmick from the ranked `coverage_targets` list (also produced by the refit) and constrained to single-gimmick only via `getDailyGimmick(seed, rng, forcedGimmick, singleOnly=true)`. Slots cycle through the coverage list if it's shorter than 9 entries.
- **Scoring.** Each candidate's score is `target_count_in_features × deficit_weight`, where the target and weight come from `getMissionForSlot(i)` in `experimentDesign.js`. Slot 0's weight is fixed low (`PRIMARY_WEIGHT = 0.1`) so it only wins when its target's cell count is high enough to overcome the gap with the heaviest coverage weight (typically ~0.5 for the most undersampled gimmick). In practice this yields roughly 1-in-10 primary outcomes when the coverage list is well-populated — matching the design intent that 9 of every 10 dailies probe sample-size deficits, not posterior-uncertainty.
- **Force-injection rationale.** Without forcing, the natural per-seed gimmick-inclusion rate of ~6.6% means ~50% of seeds have zero of the targeted feature, making maximisation meaningless. Force-injection drops miss rate to 0% so the 10-way contest competes on cell COUNT and DEFICIT WEIGHT instead of mere presence. All four call sites of `getDailyGimmick` (`selectDailyRngSeed`, `gameActions.js`'s play path, the on-demand par calc in `main.js`, and the precompute script) pass the same `(forcedGimmick, singleOnly)` resolved from `getMissionForSeed(seed)` so the chosen seed and the regenerated board agree.
- **Primary-target selection.** Same as before: after each fit, the coefficient with the highest posterior coefficient of variation (SD / |mean|) from a whitelist of push-able features wins — EXCLUDING any feature targeted in the last 3 days (`recentTargets` in `experimentTarget.json`). Stops three liar-heavy dailies in a row while still pushing data toward the most uncertain coefficient. Client fetches via `loadExperimentTarget()` in `src/logic/experimentDesign.js`.
- **Coverage-target selection.** The R refit counts unique-date occurrences of each gimmick feature in `df_fit`, computes `deficit_weight = 1 / (count + 1)` per gimmick, excludes the chosen primary target, and emits the result sorted descending by deficit. So `liarCellCount` with 1 board (deficit 0.5) ranks above `compassCellCount` with 5 boards (deficit 0.17). Lives in `experimentTarget.json` as `coverage_targets: [{feature, n_boards, deficit_weight}, ...]`.
- **Double-gimmick rate.** Default `DOUBLE_GIMMICK_PROB = 0.10` (was 0.20). The coverage missions absorb most of the "make boards more varied" goal so we don't need the natural double rate doing as much work, and lower noise = cleaner per-feature deltas. Coverage slots additionally suppress the roll entirely via `singleOnly`.
- **State plumbing.** `state.dailyRngSeed` holds the effective RNG seed (the trial variant on improvement days, plain dateString otherwise). All daily-mode RNG creation in `gameActions.js` routes through this field; `state.dailySeed` remains the plain date for Firebase keys / leaderboard joins / local-storage lookups. The play path uses `getMissionForSeed(state.dailyRngSeed)` to recover which mission won, then force-injects the matching gimmick — without this, a coverage-slot winner would get the primary gimmick force-injected on the play board and we'd ship the wrong layout.
- **Determinism.** Same date + same loaded primary + same coverage_targets list → same per-slot missions → same candidates → same winner across all clients. Cache-version drift on `experimentTarget.json` between clients can desync the chosen seed; Check-for-Updates handles most cases, and the diagnostics modal surfaces the loaded primary target + coverage list so mismatches are inspectable.

## Challenge Difficulty Curve (Sawtooth)
Computed by `getDifficultyForLevel()` in `difficulty.js` — no static table.
- **L1-10:** Tutorial ramp, 5x5→9x9, 8%→16% density, no gimmicks
- **L11-90:** Each 10-level block introduces one gimmick. Board drops to 11x11 at intro, ramps to 14x14 by block end. Density drops 10% (relative) at intro, ramps to next peak.
- **L91-120:** Final 30-level ramp from 11x11 to 14x14, density reaches 34%.
- **Gimmick selection:** Primary gimmick is 100% present during its intro block. Old gimmicks appear as secondary (60%) and tertiary (10%). By L120: guaranteed 3 gimmicks.
- **Hard cap:** 34% mine density maximum for fast board generation.

## Modifier (Gimmick) System
10 types defined in `src/logic/gimmicks.js`:
- walls (L11), liar (L21), mystery (L31), locked (L41), wormhole (L51), mirror (L61), pressurePlate (L71), sonar (L81), compass (L91), mineShift (chaos-only)
- 10-level intro blocks (intro to intro+9): primary gimmick always present
- Daily-safe subset: mystery, locked, walls, liar, wormhole, mirror, sonar, compass
- First-encounter popup tracked in localStorage key `minesweeper_seen_gimmicks`
- Popup can be disabled via `minesweeper_modifier_popup_disabled`
- **Persistent active-modifier reminder:** the `#active-gimmick-bar` (rendered above the board) shows icons for all currently-active modifiers in daily / weekly / challenge modes. Updated by `updateActiveGimmickBar()` in `src/ui/headerRenderer.js`, called at the end of `newGame()` (covers daily/weekly where modifiers are settled at start) and again after challenge first-click gimmick application. Hidden when no modifiers are active or in chaos (which has its own bar).
- **Liar visual cue:** liar cells use rose-pink background tint + italic + underlined number (CSS in `global.css` `.cell.liar-cell`). The pink background is the primary cue — italic+underline alone disappears at small mobile font sizes. Color avoids conflict with sonar cyan, compass gold, wormhole amber/magenta/green, and mirror blue/purple/green.
- **Per-cell stacking rules** (enforced in `applyGimmicks` via `hasBaseValueGimmick` / `hasDisplayBlockingGimmick`):
  - Base-value gimmicks (wormhole, mirror, sonar, compass) are mutually exclusive with each other — only one number can be displayed per cell.
  - Liar (±1 offset) stacks freely on any base-value gimmick. `recomputeDisplayedMines` computes the base value first, then applies the liar offset.
  - Locked stacks with any base-value gimmick and with liar — it's a temporary gate that reveals whatever the base/liar layers dictate once unlocked.
  - Mystery and pressure plate are fully exclusive (mystery hides the number, plate shows a timer instead of a count).
- **Displayed-number source of truth:** `recomputeDisplayedMines(board)` in `gimmicks.js` is the single function that writes `displayedMines`. Called at the end of `applyGimmicks` and after any mine-layout change (`defuseMine`, `shieldDefuse`, `magnetPull`, `performMineShift`).
- **Mirror is a 2-cell adjacent swap** (not a 2x2 zone). Pair count scales 1–3 with intensity. Cells store `mirrorPair = { row, col, pairIndex }`.
- **Walls:** `applyWalls` ALWAYS calls `recalcAllAdjacency` at the end, even when its isolation check forces walls to be cleared. Without this, cells retain stale wall-aware counts from a prior pass (shown-too-low vs. actual mines). `applyGimmicks` skips re-rolling walls when `board._wallEdges` is already populated (challenge mode pre-applies walls via `preWallEdges` so the constructive generator can build a wall-aware layout; re-rolling would invalidate it).
- **Wall rendering:** `renderWallOverlays()` is called at the end of `newGame()` so daily mode's pre-generated walls are visible before first click. Challenge and chaos modes also call it inside their first-click handler (gimmicks apply on first click in those modes).

## Theme System
- 30+ themes unlocked by level progression
- CSS custom properties per theme in `src/styles/themes/`
- `THEME_UNLOCKS` in `src/ui/themeManager.js` maps theme to required level
- Num colors 9-18 exist for wormhole sums; dark themes override them with bright variants
- `--color-wall` contrast must be >= 3.5:1 against cell backgrounds

## Firebase
- SDK v10.14.1 (compat) loaded via CDN in index.html: App, Database, Auth
- Config hardcoded in `firebaseLeaderboard.js` — `initFirebase()` with 5s connection timeout
- Rate limiting: 30s cooldown between score submissions
- Score validation: 5-3600 seconds
- Database paths:
  - `daily/{dateString}/{pushId}` — leaderboard score objects (`name, time, bombHits, uid, par, timestamp, rngSeed, bombHitEvents`)
  - `dailyMeta/{dateString}` — per-date board features (write-once, public-read) — `{ features: {...}, writtenAt }`. Read by the R refit. Upserted on first score submission for a date, or via `backfill-features.html` for historical dailies.
  - `dailyBoard/{dateString}` — canonical board layout for the date (write-once, public-read) — `{ rows, cols, totalMines, rngSeed, codeVersion, activeGimmicks, cells: [{isMine, adjacentMines, displayedMines, isLocked, isMystery, ...}, ...], wallEdges?, writtenAt }`. The source of truth for "what board does today look like" — `gameActions.js`'s daily branch fetches this BEFORE local generation so every player on the same ET date plays the exact same layout regardless of cached code or experimentTarget. Written by either the GitHub Actions pre-gen workflow at 00:00 UTC or, as fallback, by the first client that loads on a fresh date. Each cell ships with both `adjacentMines` AND `displayedMines` so future changes to wall-aware adjacency or gimmick-display logic can't retroactively shift historical numbers. ~1-3 KB per day.
  - `users/{uid}/` — cloud progress sync (maxCheckpoint, dailyStreak, bestDailyStreak, lastDailyDate)
  - `users/{uid}/dailyHistory/{dateString}` — per-user completion record (`time, par, delta, submittedAt`). Written on every daily completion, read on every leaderboard-modal open for the SVG history chart.
- Anonymous auth (`firebaseProgress.js`): silent sign-in on load, no UI. `saveProgress` calls before auth completes are coalesced into a pending-save and flushed once `_ready` flips, so fast daily completions on slow connections don't drop their cloud sync.
- Cloud sync: saves on checkpoint advance + daily completion, loads on init. Checkpoint takes the max. Daily streak is date-anchored: cloud date > local date adopts cloud's streak AND date verbatim (even if streak went down — the most recent play has the latest info), same date takes the higher streak, cloud stale keeps local. `bestDailyStreak` is always the high-water mark.
- Falls back to localStorage leaderboards if Firebase unavailable
- Rules deployed via `firebase deploy --only database` (config in `.firebaserc` + `firebase.json`)
- Rules reference file: `firebase-rules.json`
- Security rules in `firebase-rules.json` (reference only, not auto-deployed)

## Commit Convention
- No "Claude" or "Opus" or AI attribution in commits
- Git identity: Christopher Wells <c.wells@bowdoin.edu>

## Version
Current: v1.5 (app), cache version in sw.js incremented per deploy

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
- **Skill Trainer:** 15 interactive lessons — currently HIDDEN from the UI but code intact (see `src/logic/skillTrainer.js`, `src/ui/skillTrainerUI.js`). Re-enable by uncommenting the mode card in `index.html` and the help-modal bullet.
- **Chaos:** Rapid rounds with random modifiers, exempt from solvability guarantee

## Greg-par Model (Daily)
Daily par is a linear regression over board features, fit in R offline against real completion data. Coefficients live in `PAR_MODEL` in `src/logic/difficulty.js`; the whole model lives in `src/logic/dailyFeatures.js` (`computeDailyFeatures`, `predictPar`, `breakdownPar`).
- **Move type, not move count, is the primary signal.** The solver in `boardSolver.js` classifies every deduction into one of five buckets at the three `totalClicks++` sites: `passAMoves` (trivial propagation), `canonicalSubsetMoves` (Pass B subset with larger-constraint size ≤3 — 1-1 / 1-2 / 1-1-1 shapes), `genericSubsetMoves` (Pass B, size ≥4), `advancedLogicMoves` (Pass C tank/gauss), `disjunctiveMoves` (Pass C with liar). Invariant: `passA + canonical + generic + advanced + disjunctive + 1 === totalClicks` for solvable boards.
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
Every player on the same ET date plays the same board, period. Two divergence sources are eliminated:

1. **Code-version drift** between clients on different cached SW bundles. Same seed + different code = different board. Closed by storing the resolved board on Firebase, not the seed.
2. **Experiment-target drift** between clients with different cached `experimentTarget.json`. Same code + different target = different `selectDailyRngSeed` winner = different board. Same fix.

Mechanism:
- **`dailyBoard/{date}`** in Firebase Realtime DB stores the fully-resolved board (mine layout, gimmick assignments, displayed numbers, wall edges) — write-once at the rules layer.
- **`getLocalDateString()`** is anchored to America/New_York via `Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })`. A player in Tokyo loading at 9am JST sees the puzzle for the previous ET date if it's still before midnight ET.
- **`src/firebase/dailyBoardSync.js`** — `loadDailyBoard(date)` / `saveDailyBoard(date, payload)` / `serializeBoard({ board, rows, cols, ... })` / `deserializeBoard(raw)`. The serialiser drops `false`-valued booleans to keep the JSON tight (~30% smaller), and the deserialiser fills them back in from defaults so the consuming code sees a fully-shaped cell object.
- **Daily entry path** (`gameActions.js` daily branch — now `async`): try `loadDailyBoard(state.dailySeed)` first; if hit, deserialize and use directly (skip generation, gimmicks, solvability retry); if miss, run the full local-generation flow and `saveDailyBoard` the result fire-and-forget so the next visitor sees what we generated. The solver still runs locally on the resolved board to compute features (move-type counts) and the best-start cell — that's deterministic, so different clients agree on features even if they came in via different paths.
- **On-demand par calc** in `main.js` (leaderboard modal opening before play) does the same fetch-first dance.
- **Practice daily** (`?seed=...`) bypasses canonical fetch/write — practice is per-user and shouldn't pollute the shared bucket.
- **Pre-generation** runs nightly at 00:00 UTC via `.github/workflows/precompute-daily-board.yml` (`scripts/precompute-daily-board.mjs`). Anchoring to UTC gives a 4-5h buffer before the daily flips at 00:00 ET. The script runs the SAME pipeline `selectDailyRngSeed` + `gameActions.js` would: load the experiment target, force-inject the gimmick if applicable, run candidate selection across 10 trial seeds, pick the winner, write to Firebase. Idempotent — write-once rules silently no-op repeated writes for the same date.
- **One-off bootstraps** (e.g., a date played by a real user before the canonical-board ship): `scripts/bootstrap-daily-board.mjs` — hardcode date + seed + force-injection state, regenerate, write. Used to lock 2026-04-27 to Chris's actual played v1.5.18 board.

## Adaptive Experimental Design
- EVERY daily generates 10 candidate seeds (`${dateString}:trial0`..`trial9`), solves each, and picks the one whose board maximises the currently-targeted feature. ~500–800 ms of CPU on first daily load.
- When the target maps to a gimmick (the `TARGET_TO_GIMMICK` table in `experimentDesign.js`: mysteryCellCount→mystery, sonarCellCount→sonar, wormholePairCount→wormhole, etc.), `getDailyGimmick(seed, rng, forcedGimmick)` force-injects that gimmick as the primary on every candidate. Without this, the natural per-seed inclusion rate of ~6.6% (45% any-gimmick × 1/8 uniform pick + small secondary contribution) means ~50% of dailies have zero of the target across all 10 candidates, making the maximisation meaningless. Force-injection drops miss rate to 0% and lets the 10-way max compete on cell COUNT instead. Both call sites of `getDailyGimmick` (`selectDailyRngSeed`, the play path in `gameActions`, and the on-demand par calc in `main.js`) pass the same `forcedGimmick` so the chosen seed and the regenerated board agree.
- The target feature is chosen server-side by the R refit: after each fit, the coefficient with the highest posterior coefficient of variation (SD / |mean|) from a whitelist of push-able features wins — but EXCLUDING any feature that was the target on any of the last 3 days (tracked via `recentTargets` in `experimentTarget.json`). This keeps boards varied (no three liar-heavy dailies in a row) while still pushing data toward the most uncertain coefficient. The whitelist excludes features that either can't be meaningfully pushed (`passAMoves` always non-zero) or that we don't want to inflate (`cellCount`). The client fetches this JSON at startup via `loadExperimentTarget()` in `src/logic/experimentDesign.js`.
- `state.dailyRngSeed` holds the effective RNG seed for the day's board (the trial variant on improvement days, plain dateString otherwise). All daily-mode RNG creation in `gameActions.js` routes through this field; `state.dailySeed` remains the plain date for Firebase keys, leaderboard joins, and local-storage lookups.
- `src/logic/selectDailyRngSeed.js` is the selection mechanism — mirrors the daily-gen pipeline (dimensions, gimmick apply, solver) across candidates. Both `gameActions.js` (play) and `main.js` (on-demand par calc) call it so they agree on which board is today's.
- The daily REMAINS deterministic across players: same date + same loaded target → same candidates → same winner. If a client's cache has a stale target while another has fresh, they'd compute different seeds — in practice Check-for-Updates addresses this, and after v1.5.9 the diagnostics modal surfaces the loaded target so mismatches are inspectable.

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

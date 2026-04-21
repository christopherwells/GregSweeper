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
- **Daily:** One seeded puzzle per day, no levels, optional modifiers (~35% of days)
- **Skill Trainer:** 15 interactive lessons teaching minesweeper techniques (beginner/intermediate/advanced)
- **Chaos:** Rapid rounds with random modifiers, exempt from solvability guarantee

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
  - `daily/{dateString}` — flat array of score objects (leaderboard)
  - `users/{uid}/` — cloud progress sync (maxCheckpoint, dailyStreak, bestDailyStreak, lastDailyDate)
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
Current: v1.4 (app), cache version in sw.js incremented per deploy

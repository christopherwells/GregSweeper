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

1. **Board solver** (`boardSolver.js`): Simulates full game playthrough from first click. Wall-aware neighbor lists, gimmick-aware (mystery=unknown, liar=displayedMines, mirror=displayedMines, sonar/compass/wormhole=unknown). Returns `{ solvable, remainingUnknowns, totalClicks }` (clicks, not individual cell reveals — cascades count as 1).

2. **Constraint solver** (`constraintSolver.js`): Union-find partitions independent constraint groups. Tank solver (bitmask brute-force) for <=20 unknowns; Gaussian elimination for larger groups. Returns forced mines/safe cells.

Board generation retries until `remainingUnknowns === 0`. Challenge mode retries 10 times with gimmick re-check. Daily strips gimmicks if unsolvable. Chaos is exempt from solvability.

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

## Theme System
- 30+ themes unlocked by level progression
- CSS custom properties per theme in `src/styles/themes/`
- `THEME_UNLOCKS` in `src/ui/themeManager.js` maps theme to required level
- Num colors 9-18 exist for wormhole sums; dark themes override them with bright variants
- `--color-wall` contrast must be >= 3.5:1 against cell backgrounds

## Firebase
- SDK v10.14.1 (compat) loaded via CDN in index.html
- Config hardcoded in `firebaseLeaderboard.js` — `initFirebase()` with 5s connection timeout
- Rate limiting: 30s cooldown between score submissions
- Score validation: 5-3600 seconds
- Database path: `daily/{dateString}` — flat array of score objects
- Falls back to localStorage leaderboards if Firebase unavailable
- Security rules in `firebase-rules.json` (reference only, not auto-deployed)

## Commit Convention
- No "Claude" or "Opus" or AI attribution in commits
- Git identity: Christopher Wells <c.wells@bowdoin.edu>

## Version
Current: v1.4 (app), cache version in sw.js incremented per deploy

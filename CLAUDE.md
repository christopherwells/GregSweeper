# GregSweeper

## Project Overview
Modern Minesweeper game built with vanilla JavaScript (ES6 modules). No framework, no bundler. Deployed on GitHub Pages.

## Tech Stack
- Vanilla JS with ES6 modules (import/export)
- CSS custom properties for theming
- Firebase Realtime Database for leaderboards
- GitHub Pages for hosting

## Key Architecture
- `src/state/gameState.js` — central mutable state object
- `src/game/gameActions.js` — newGame(), revealCell(), toggleFlag()
- `src/game/modeManager.js` — switchMode() for Challenge/Timed/Daily/SkillTrainer
- `src/game/winLossHandler.js` — handleWin(), handleLoss(), handleDailyBombHit()
- `src/game/timerManager.js` — timer and mine-shift intervals
- `src/logic/` — boardGenerator, boardSolver, difficulty, gimmicks, powerUps, skillTrainer
- `src/ui/` — boardRenderer, headerRenderer, modalManager, skillTrainerUI, collectionManager
- `src/styles/global.css` — main styles; `src/styles/themes/` — per-theme CSS files
- `src/storage/statsStorage.js` — localStorage persistence for stats, power-ups, checkpoints
- `src/firebase/firebaseLeaderboard.js` — online leaderboards and rooms
- `index.html` — single-page app, all modals inside #app div

## Important Patterns
- Cache busting: all imports use `?v=1.0` query string — bump when deploying changes
- Modals are inside `#app` — when `#app` has `.hidden` class (display: none), child modals can't render
- Title screen (`#title-screen`) is a sibling of `#app`, not inside it
- `_returnToTitle` flag in main.js tracks when modals were opened from the title screen
- Daily mode uses seeded RNG (`createDailyRNG(dateString)`) for deterministic boards per date
- "Gimmicks" in code, "Modifiers" in player-facing UI
- `$()` / `$$()` are querySelector/querySelectorAll helpers from `src/ui/domHelpers.js`

## Game Modes
- **Challenge (normal):** 100 levels, increasing difficulty, checkpoints every 5 levels, modifiers from L11+
- **Timed:** Race the clock, 4 difficulty tabs (Beginner/Intermediate/Expert/Extreme)
- **Daily:** One seeded puzzle per day, no levels, optional modifiers (~35% of days)
- **Skill Trainer:** 15 interactive lessons teaching minesweeper techniques (beginner/intermediate/advanced)

## Modifier (Gimmick) System
7 types defined in `src/logic/gimmicks.js`:
- mystery (L11), locked (L16), liar (L21), mineShift (L26), walls (L31), wormhole (L36), mirror (L41)
- Daily-safe subset: mystery, locked, walls, liar (no dynamic board changes)
- First-encounter popup tracked in localStorage key `minesweeper_seen_gimmicks`
- Popup can be disabled via `minesweeper_modifier_popup_disabled`

## Theme System
- 30+ themes unlocked by level progression
- CSS custom properties per theme in `src/styles/themes/`
- `THEME_UNLOCKS` in `src/ui/themeManager.js` maps theme → required level

## Commit Convention
- No "Claude" or "Opus" attribution in commits
- Git identity: Christopher Wells <c.wells@bowdoin.edu>

## Deployment
- GitHub Pages: https://christopherwells.github.io/GregSweeper/
- Push to main triggers deploy
- After push, bump `?v=` query string if browser caching is stale

## Version
Current: v1.0.6

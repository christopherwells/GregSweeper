# GregSweeper

The daily Minesweeper, no guesses required. Every board guaranteed solvable. Ten optional modifiers stack on the classic ruleset, a worldwide leaderboard ranks the day's times, and a personal par adjusts to your skill. Free to play in your browser, no ads, no tracking, no signup. (A paid native-app wrapper may ship to mobile stores later; the browser version stays free.)

## Play it

**[gregsweeper.live (or christopherwells.github.io/GregSweeper)](https://christopherwells.github.io/GregSweeper/)**

## What makes it different

- **No 50/50 guesses, ever.** A two-layer constraint solver (subset propagation through bitmask tank-solve and Gaussian elimination) verifies every generated board is solvable through deduction alone. If a board can't be solved without a coin flip, it's regenerated.

- **Ten modifier types** that change the rules without breaking solvability: walls that block adjacency, sonar pings that count mines in a 3×3 zone, wormholes that pair distant cells, mirrors that swap displayed counts, liar cells that show truth ±1, locked cells that delay reveal, pressure plates, mystery cells, hidden compass arrows, and a chaos-only mine shift. Modifiers unlock progressively in challenge mode and rotate into the daily.

- **A daily puzzle that learns.** Each completed game contributes to a Bayesian mixed-effects par model fit nightly via brms / Stan. Your personal handicap is the random intercept on that model — golf-style, recentered to zero across the active player base. Sub-30-play players get a provisional handicap from recent residuals.

- **A weekly tournament** built on the same canonical-board infrastructure: one board for the whole week (Monday → Sunday, ET), one attempt per day, best time across the seven wins.

- **Built for the browser.** Vanilla JavaScript, no framework, no bundler, no npm. Service worker caches assets for offline play. Firebase Realtime Database handles leaderboards. The whole thing fits in a few hundred KB.

## Install as a PWA

- **iOS (16.4+):** open in Safari → Share → Add to Home Screen.
- **Android (Chrome / Edge):** open in the browser → menu → Install App.
- **Desktop (Chrome / Edge):** click the install icon in the address bar.

Installed instances get push notifications for the day's puzzle, opt-in via Settings.

## How it's built

`index.html` + ES6 module imports under `src/`. State is a single mutable object; rendering is `dirtyCells`-based to keep the DOM hot path cheap. Daily and weekly boards are pre-generated server-side (GitHub Actions) and shipped to clients via Firebase as immutable JSON, so everyone plays the exact same board for that date. The par model is fit nightly in R against the day's completion data, the new coefficients are committed to the repo, and GitHub Pages redeploys.

`scripts/refit-par-model.R` runs the daily refit. `scripts/fit-par-model.qmd` is the interactive notebook with diagnostics (Rhat, ESS, divergent transitions, posterior CV, prior-vs-posterior comparison).

## Credits

GregSweeper is built by Christopher Wells. Greg dreamed up the modifiers; the mines are his fault.

Issues and feedback: [github.com/christopherwells/GregSweeper/issues](https://github.com/christopherwells/GregSweeper/issues)

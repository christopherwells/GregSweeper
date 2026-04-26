# Handoff — current state of stats / handicap pipeline

This supersedes the previous handoff (most of those TODOs landed). Picking up
from a session that hardened the v1.5 stats pipeline end to end: Bayesian
refit, adaptive experimental design, bomb-event capture, in-app diagnostics,
Kate's uid migration, and a string of stats-modal accuracy fixes.

## Current state — what's shipping

- **v1.5.14 deployed.** Stats modal Daily tab renders the full panel
  cleanly (handicap with two-line trajectory overlay, daily history,
  cascaded complexity delta, strike rate, modifier heatmap, delta
  distribution, rank vs. field). Stats / charts / diagnostics modules
  are dynamic-imported on demand to keep the cold-load path light.
- **Refit is fully Bayesian.** `scripts/refit-par-model.R` runs
  `brm(time ~ features + (1|uid))` with informative `lognormal` priors
  centred on the seed coefficients (sigma=1.0 on the log scale).
  Convergence guard: Rhat ≤ 1.05, ESS ≥ 400, divergent ≤ 0.25%.
  Bias-correction targets the FIT POPULATION only (uid-tagged + ≥15
  clean plays), so anonymous-visitor outliers don't pollute the
  intercept. `MIN_PLAYS_FOR_FIT_INCLUSION = 15` (acknowledges the
  ~50-65% bomb-hit rate).
- **PAR_MODEL** (as of last successful refit): see
  `src/logic/difficulty.js` between markers. Re-run is automatic at
  ~10am ET via `.github/workflows/refit-par-model.yml`.
- **Handicaps** (`src/logic/handicaps.json`):
  - Chris (`5Ht9d2io0ugU1NGsjdJmZvkJi382`): around **−1.3s**
  - Kate (`AYXrTjKPieYrZI8sksnYqbI3Pmh1`, post-migration): around **+1.1s**
  - Numbers reflect clean-play skill, not bomb-hit pollution. Sign
    flipped from the seed-residuals era because we now exclude
    bomb-hit plays from the fit.
- **Adaptive experimental design** (every 3rd daily, day-of-month % 3 == 0):
  client tries 10 candidate seeds and picks the board that maximises
  the currently-targeted feature. Target is auto-selected by the R
  refit (highest posterior CV from a whitelist) and written to
  `src/logic/experimentTarget.json`. Other days are plain date-seeded
  dailies. Determinism preserved across players: same date + same
  loaded target → same winning seed.
- **Bomb-hit event capture.** Every bomb hit pushes `{ t, row, col }`
  onto `state.dailyBombHitEvents`; submission to Firebase includes the
  array plus the effective `rngSeed`. Old plays only have a `bombHits`
  count; new plays from v1.5.9+ carry the full event log.
- **Bomb-hit plays excluded from fit.** Their times describe a
  materially easier puzzle (bomb defuses reveal cells the solver's
  optimal path didn't use), so including them distorts the
  coefficients. The events log will eventually feed a bomb-adjusted
  effective-feature model that re-includes them — see open item #1.
- **In-app diagnostics modal.** Hidden by default; Settings →
  🔬 Show Diagnostics is gated behind `?debug=1` URL flag (persisted
  in localStorage). Surfaces uid, Firebase status, history join
  count, current PAR_MODEL, handicaps.json metadata, version, and a
  Copy-as-JSON button.
- **Kate's data migrated.** Old uid (`kPkUkn5mndZG2SIGC1xC329zhrA3`)
  scores rewritten to her current uid (`AYXrTjKPieYrZI8sksnYqbI3Pmh1`)
  in both `daily/*` and `users/{uid}/dailyHistory/*`. Old-uid data
  left intact as a rollback option.
- **Firebase rules updated** to allow `bombHitEvents` and `rngSeed`
  fields on score submissions. Deployed via
  `firebase deploy --only database`.
- **Refit workflow:** runs daily at 14:00 UTC (10am ET EDT). Cache
  key is `r-pkgs-Linux-noble-brms-v2` — bump if ubuntu-latest moves
  to a new Ubuntu major version.

## Recent learnings worth preserving

- **Bomb-hit rate is high (~50-65%).** Daily mode's re-fog design
  makes bomb hits feel cheap (flags preserved, just re-click), but
  the back-of-envelope cost is much higher than the explicit 10s
  penalty. With Chris's overall delta averaging ~+32s vs his clean
  handicap of −1.3s, each bomb hit averages ~+25s real cost vs the
  10s nominal — players are systematically under-weighting bombs.
  See open item #2 for the rebalance question.
- **Posterior CV is sensitive at low N.** Disjunctive-move and liar-
  cell coefficients show CV > 1.0 in the current fit because we have
  few liar/disjunctive boards in the clean dataset. The adaptive
  experiment design targets these features on the 1-in-3 days, which
  should compress those posteriors over the next few weeks.
- **brms identifiability quirk.** Non-centred predictors (which we
  need so JS can plug in raw feature counts) leave the global
  intercept and random intercepts non-identifiable up to an additive
  constant. We play-weight-recentre the random intercepts post-fit
  so handicaps sum to zero across users — without this both users'
  handicaps came out as +100s offsets.
- **History dots can sit dramatically below personal par.** This is
  a real artifact of the small-N posterior on disjunctive/canonical
  coefficients: the model OVERPREDICTS par on hard boards, so actual
  times look superhuman. Will compress as N grows. Don't "fix" by
  filtering bomb-hit plays from the chart — keep the user's full
  history visible.
- **Ubuntu major-version transitions break the R cache.** Cached
  binaries built on Jammy crash on Noble with
  `undefined symbol: SETLENGTH`. Cache key now includes the OS
  release; install step uses the RSPM env var that
  `r-lib/actions/setup-r` sets automatically.

## Open items

### 1. Bomb-adjusted effective-feature model (option 2: client-side)

`bombHitEvents` are streaming in but the R script just filters bomb-hit
plays. To re-include them, the client should compute an effective
feature vector at end-of-game when bomb hits occurred — re-run the
solver on the original board with the bomb cells marked as revealed
starting points, take the resulting `passAMoves / canonical / generic /
advanced / disjunctive` counts as the effective vector, submit alongside
the regular features. R script then prefers `effectiveFeatures` when
present, falls back to nominal `features` otherwise.

Estimated work: ~45 min. Steps:
- In `winLossHandler.js` win path, if `state.dailyBombHits > 0`, save
  a copy of the original board layout, mark bomb cells revealed, run
  `isBoardSolvable` again, derive features.
- Submit as `extras.effectiveFeatures` in `submitOnlineScore`.
- Update Firebase rules to allow the new field.
- R script: `coalesce(effectiveFeatures, features)` when building the
  feature matrix, drop the `bombHits == 0` filter.

### 2. Bomb penalty rebalance

Current: +10s per hit + re-fog all non-flag cells. Empirically the
real cost is closer to +25s per hit (10s explicit + ~15s re-fog
re-click time + disruption). The 60% bomb-hit rate suggests players
under-perceive cost. Once we have ~20-40 bomb-event-tagged plays we
can compute the per-bomb info-value rigorously. Knobs: bump explicit
penalty to ~20s, or remove flag-preservation, or both.

Tied to item #1 — once effective-feature data is collected we can
measure the actual time saved per bomb hit vs the 10s penalty.

### 3. Slowness on cold load

Lazy-imports landed in v1.5.14 (statsRenderer / charts /
dailyHistoryChart / diagnosticsModal / skillTrainer all dynamic-imported,
removed from SW pre-cache). Bundling would shave another 2-5s but
breaks the `no-build-step` rule. Revisit if the perceived slowness
returns after these optimisations propagate.

### 4. Hidden Skill Trainer

Skill Trainer mode is hidden from the UI but the code is intact (see
`src/logic/skillTrainer.js`, `src/ui/skillTrainerUI.js`). Modules are
dynamic-imported via `modeManager.js` and excluded from SW pre-cache.
Decide whether to ship Skill Trainer publicly or remove the dead code.

## Quick reference — how to rerun things locally

```bash
# Dev server
python -m http.server 8080

# Manual refit (writes difficulty.js + handicaps.json + experimentTarget.json
# only if N >= 30 total clean scores AND >= 2 users with >= 15 clean plays)
"/c/Program Files/R/R-4.5.2/bin/Rscript.exe" scripts/refit-par-model.R

# Trigger remote refit
gh workflow run "Refit Greg-par" --ref master

# Deploy Firebase rules (when firebase-rules.json changes)
MSYS_NO_PATHCONV=1 firebase deploy --only database

# Apply a multi-path Firebase update (admin bypasses rules)
MSYS_NO_PATHCONV=1 firebase database:update / update.json -f

# Backfill historical dailyMeta
# Start a dev server, then open /backfill-features.html, set dates, type BACKFILL, click Run.

# Open diagnostics modal (one-time per device — flag persists)
# https://christopherwells.github.io/GregSweeper/?debug=1
```

## Who's who (current uid map)

- **Chris** uid = `5Ht9d2io0ugU1NGsjdJmZvkJi382` — handicap around −1.3s
- **Kate** uid = `AYXrTjKPieYrZI8sksnYqbI3Pmh1` — handicap around +1.1s
  (old uid `kPkUkn5mndZG2SIGC1xC329zhrA3` migrated, scores left intact for rollback)
- **Wendy / Sebas** — single anonymous-visitor scores, excluded from fit
  by the `MIN_PLAYS_FOR_FIT_INCLUSION` threshold

## Files that matter

- `src/logic/difficulty.js` — `PAR_MODEL` between markers
- `src/logic/dailyFeatures.js` — feature computation, `predictPar`,
  `breakdownPar`
- `src/logic/handicaps.js` — handicap lookup + client-side fallback
- `src/logic/handicaps.json` — current handicaps (refitted daily)
- `src/logic/experimentDesign.js` — adaptive-experiment policy
- `src/logic/experimentTarget.json` — current target (refitted daily)
- `src/logic/selectDailyRngSeed.js` — candidate-seed selection
- `src/ui/charts.js` — SVG chart toolkit (now supports `secondary`
  series for the handicap-trajectory two-line overlay)
- `src/ui/statsRenderer.js` — Daily-tab orchestration; lazy-imported
- `src/ui/diagnosticsModal.js` — diagnostics surface; lazy-imported,
  Settings button hidden behind `?debug=1`
- `scripts/refit-par-model.R` — daily Bayesian regression + handicap
  computation + experiment-target selection
- `scripts/fit-par-model.qmd` — interactive Quarto diagnostics
- `.github/workflows/refit-par-model.yml` — cron schedule + R env
- `firebase-rules.json` — RTDB security rules (allows
  `bombHitEvents` and `rngSeed` on daily entries)
- `backfill-features.html` — one-shot browser utility for dailyMeta

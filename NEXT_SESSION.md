# Handoff — current state of stats / handicap pipeline

This supersedes the previous handoff. Picking up from a session that:
- Replaced the bomb-hit filter with a `bombHits` regressor (option A) so
  all 90 plays now contribute to the fit instead of just the clean 38
- Found and fixed a critical auto-submit bug that had been silently
  dropping `bombHitEvents` and `rngSeed` from EVERY play since v1.5.9
- Added two new structural features (`nonZeroSafeCellCount`,
  `zeroClusterCount`) AND backfilled them across all 48 historical
  dailyMeta records via a Playwright + admin Firebase pipeline
- Tried and dropped a third (`fragmentationRatio`) — turns out it's
  structurally zero on solvable boards by construction
- Made every daily a "learning daily" with a no-repeat-target-within-
  3-days rule (was previously every 3rd day)
- Several stats-modal accuracy fixes (share card, percentile flip,
  complexity cascade, two-line handicap trajectory overlay)
- Lazy-imported the stats / charts / diagnostics / skill-trainer
  modules off the cold-load critical path
- Fixed the GitHub Actions cron after the ubuntu-latest Jammy → Noble
  migration broke the R package cache
- Hid the diagnostics button behind `?debug=1` URL flag

## Current state — what's shipping

- **v1.5.18 deployed.** Every daily picks a candidate seed targeting
  the most-uncertain coefficient; rotation guarantees no target
  repeats within 3 days. Stats / charts / diagnostics modules are
  dynamic-imported on demand.
- **Refit is fully Bayesian.** `scripts/refit-par-model.R` runs
  `brm(time ~ features + bombHits + (1|uid))` with informative
  `lognormal` priors. Convergence guard: Rhat ≤ 1.05, ESS ≥ 400,
  divergent ≤ 0.25%. `MIN_PLAYS_FOR_FIT_INCLUSION = 30` (clean-play
  threshold lifted now that bomb-hit plays are kept).
- **`bombHits` regressor absorbs bomb-time inflation.** Each hit
  fitted at +14.66s (visible as `secPerBombHit` in handicaps.json).
  This regressor is FIT but NOT shipped to JS — `predictPar(features)`
  stays "clean-play par" and the bombHits coef exists only to keep
  per-user random intercepts representing pure solving skill.
- **Handicaps** (`src/logic/handicaps.json`, last refit 2026-04-26):
  - Chris (`5Ht9d2io0ugU1NGsjdJmZvkJi382`): **+6.05s**
  - Kate  (`AYXrTjKPieYrZI8sksnYqbI3Pmh1`): **−6.63s**
  - The ~12s gap reflects clean-equivalent skill, not bomb-rate
    asymmetry. Sign flipped from earlier seed-residuals era (+2.45/
    −2.53) because the model now properly accounts for bombs.
- **Two structural features active in PAR_MODEL:**
  - `secPerNonZeroSafeCell`: 0.36 s/cell (cells the player must deduce)
  - `secPerZeroCluster`: 0.69 s/cluster (cascade entry points)
  - `fragmentationRatio` was tried and dropped — always 0 because
    isolated safe regions are unsolvable and the solver filters them
    out before they ever ship.
- **Backfilled dailyMeta.** All 48 historical dates have the new
  structural features computed by regenerating each board from its
  deterministic seed (Playwright + JS modules + admin Firebase
  multi-path update). Threshold guard satisfied; coefficients now
  fit on real data not just priors.
- **Adaptive experimental design.** EVERY daily generates 10 candidate
  seeds (`{date}:trial0..9`), solves each, picks the one whose board
  maximises the currently-targeted feature. Target chosen server-side
  by the R refit (highest posterior CV from a whitelist), excluding
  any feature that was the target on any of the last 3 days
  (`recentTargets` in `experimentTarget.json` is a rolling 3-slot
  memory). Determinism preserved across players.
- **Bomb-hit event capture.** Every bomb hit pushes `{ t, row, col }`
  to `state.dailyBombHitEvents`. Submission includes the array plus
  the effective `rngSeed`. **AUTO-SUBMIT PATH FIXED in
  `cf87e3f` — pre-fix, ~51 plays from Apr 22-25 had bombHits counted
  but events DROPPED on the floor.** End-to-end verified via
  Playwright that post-fix submissions land cleanly with the array.
- **In-app diagnostics modal.** Hidden by default. Visit
  `?debug=1` once on a device to unlock (persisted via localStorage).
  Settings → 🔬 Show Diagnostics surfaces uid, Firebase status,
  history join count, current PAR_MODEL, handicaps.json metadata,
  Copy-as-JSON button.
- **Kate's data migrated.** Old uid (`kPkUkn5mndZG2SIGC1xC329zhrA3`)
  scores rewritten to current uid (`AYXrTjKPieYrZI8sksnYqbI3Pmh1`) in
  `daily/*` and `users/{uid}/dailyHistory/*`. Old-uid data left intact
  as rollback option.
- **Firebase rules** allow `bombHitEvents` (array of `{t, row, col}`)
  and `rngSeed` (string) on score submissions. Deployed via
  `firebase deploy --only database`.
- **Refit workflow:** runs daily at 14:00 UTC (10am ET EDT). Cache
  key `r-pkgs-Linux-noble-brms-v2` — bump if ubuntu-latest moves
  again. Install step uses RSPM env var (auto-detects OS).

## Recent learnings worth preserving

- **Trust outcomes, not element existence.** I shipped v1.5.9's bomb-
  event capture by verifying the deployed code looked correct and
  that Firebase rules accepted the field — but never actually played
  a daily and confirmed events landed. The auto-submit path bug went
  undetected for 4 days, costing 51 plays of position data we can't
  recover. Rule: before claiming "shipped" on a data-flow change,
  RUN A PLAY through it and inspect the resulting Firebase entry.
- **Bomb-hit rate is high (~50-65%).** Daily re-fog design makes
  bomb hits feel cheap. Empirical cost is closer to ~25s per hit
  (10s explicit penalty + ~15s re-fog re-click + disruption) vs the
  nominal 10s. Player behaviour confirms: nobody would hit bombs
  60%+ of the time if they actually felt the cost.
- **Selection bias on clean-only fits.** Filtering bomb-hit plays
  isn't symmetric — Chris bombed on harder boards, Kate on slightly
  easier ones, so the clean subset compared "Chris on easy boards"
  to "Kate on slightly-harder boards" and called them equal. The
  bombHits regressor restores symmetry by including all plays and
  letting bomb count absorb its own variance.
- **Posterior MEAN of a lognormal prior overshoots the median by
  ~1.65×.** With sigma=1.0 priors, a coefficient with no data signal
  comes out at `prior_mean × exp(0.5)` ≈ 1.65 × prior_median, not at
  the median. New coefs that lock to prior expectation will inflate
  predictPar by a noticeable amount unless guarded.
- **Threshold guard for new features.** When adding a feature, force
  its coefficient to 0 in the SHIPPED PAR_MODEL until ≥20 plays have
  nonzero values for it. Otherwise the prior mean alone bends
  predictPar with no data justification. The fit still includes the
  feature as a regressor (so other coefficients aren't polluted), but
  the JS side only sees the data-fit value once a real signal exists.
- **brms identifiability quirk** (still applies). Non-centred
  predictors leave alpha + u_j non-identifiable up to an additive
  constant. We play-weight-recentre the random intercepts post-fit
  so handicaps sum to zero. Without this both users' handicaps came
  out as ~+100s offsets.
- **Ubuntu major-version transitions break R cache.** Cached binaries
  built on one Ubuntu release crash on the next with
  `undefined symbol: SETLENGTH`. Cache key now includes OS release.
- **Backfill via Playwright works for any deterministic-seed feature.**
  Pattern: load page locally → import JS modules → for each historical
  date regenerate the board → compute new features → batch update via
  `firebase database:update / update.json -f` (admin bypasses
  write-once rules). 48 dates × ~50ms = ~2.5s of compute.

## Open items

### 1. Full bomb-adjusted effective-feature model (option C)

For each bomb-hit play, re-run the solver with the bomb cells marked
as pre-revealed starting points, then take the resulting
move-type counts as the "effective" feature vector for that play.
This isolates the structural information value of each bomb position
instead of treating all bombs as worth +14.66s flat.

Status: blocked on data accumulation. Auto-submit fix landed today
(`cf87e3f`); need ~20-40 bomb-hit plays with `bombHitEvents`
populated before this is worth building. Pre-fix bomb-hit plays
have only `bombHits` count, no positions, can't be retrofitted.
At ~2 dailies/day across 2 users with ~50% bomb rate, ~2-3 weeks
of data accumulation.

When ready, implementation:
- Add an `effectiveFeatures` field to score submissions, computed at
  end-of-game when `state.dailyBombHits > 0` by re-running the solver
  on the original board with bomb cells marked revealed
- R script reads `coalesce(effectiveFeatures, features)` per play
- Drop the `bombHits` regressor (the effective vector already
  reflects the post-bomb difficulty)
- Update Firebase rules to allow the new field

### 2. Bomb penalty rebalance

Current: 10s explicit + flag-preserved re-fog. Effective cost per
hit ≈ 25s. The system rewards risky play.

Knobs (cheapest first):
- Bump explicit penalty 10 → 20s
- Drop flag-preservation (re-fog ALL non-mine cells, not just
  non-flag)
- Both

Empirical evidence will be cleaner once option (1) lands — the
bomb-adjusted model gives the precise info-value of each hit, which
sets a defensible floor for the explicit penalty.

### 3. Handicap interpretation / confidence intervals

Statistician deep-dive concluded the +6/−6 point estimates are
honest but the data is severely underpowered: 95% CrI on the gap is
roughly ±15s. Displaying "+6.05s" makes it look more precise than
it is. Consider showing "+6.05s ± 8s (95% CrI)" in the UI so
players read it as "we can't tell exactly yet" instead of a
verdict.

### 4. New features worth investigating

User has been generative about features. We added 2 (kept) and tried
1 (dropped). Other candidates that vary on solvable boards:
- **Mean cell adjacency** among safe cells (range 0-8). Sign
  uncertain — tighter constraints could go either way.
- **Border-cell count** (cells touching board edge). Different
  shape signal beyond cellCount.
- **Mine-density ratio** as its own coefficient (currently the model
  has totalMines and cellCount separately but no density term).
- **Max single-cell adjacency** (the most-constrained safe cell on
  the board).

Each would follow the same pattern: add to `dailyFeatures.js`
+ `COEF_TERMS` + `PAR_MODEL` placeholder + R script formula/priors/
whitelist + threshold guard, then backfill via Playwright. The
backfill harness is now proven — see `experimentTarget.json` flow.

### 5. Hidden Skill Trainer

Skill Trainer mode is hidden from the UI but the code is intact
(`src/logic/skillTrainer.js`, `src/ui/skillTrainerUI.js`). Modules
are dynamic-imported via `modeManager.js` and excluded from SW
pre-cache. Decide whether to ship publicly or remove the dead code.

### 6. Node.js 20 deprecation in CI

The Refit workflow uses `actions/cache@v4`, `actions/checkout@v4`,
`r-lib/actions/setup-r@v2` — all of which run on Node 20, deprecated
June 2026. Bump action versions before then.

## Quick reference — how to rerun things locally

```bash
# Dev server
python -m http.server 8080

# Manual refit (writes difficulty.js + handicaps.json + experimentTarget.json
# only if N >= 30 total uid-tagged scores AND >= 2 users with >= 30 plays each)
"/c/Program Files/R/R-4.5.2/bin/Rscript.exe" scripts/refit-par-model.R

# Trigger remote refit
gh workflow run "Refit Greg-par" --ref master

# Deploy Firebase rules (when firebase-rules.json changes)
MSYS_NO_PATHCONV=1 firebase deploy --only database

# Apply a multi-path Firebase update (admin bypasses rules)
MSYS_NO_PATHCONV=1 firebase database:update / update.json -f

# Backfill new features for historical dailyMeta records:
#   1. Edit dailyFeatures.js to compute the new feature
#   2. Start dev server: python -m http.server 8082
#   3. Open Playwright, navigate to localhost:8082
#   4. Use browser_evaluate to import the JS modules and iterate
#      over dailyMeta dates regenerating boards + computing features
#   5. Output an update payload (paths like
#      `dailyMeta/{date}/features/{newField}: <value>`)
#   6. Apply via firebase database:update
# (See session history "backfill-update.json" pattern)

# Open diagnostics modal (one-time per device — flag persists)
# https://christopherwells.github.io/GregSweeper/?debug=1
```

## Who's who (current uid map)

- **Chris** uid = `5Ht9d2io0ugU1NGsjdJmZvkJi382` — handicap +6.05s
- **Kate** uid = `AYXrTjKPieYrZI8sksnYqbI3Pmh1` — handicap −6.63s
  (old uid `kPkUkn5mndZG2SIGC1xC329zhrA3` migrated, scores left intact
  for rollback)
- **Wendy / Sebas** — single anonymous-visitor scores, excluded by
  `MIN_PLAYS_FOR_FIT_INCLUSION` threshold

## Files that matter

- `src/logic/difficulty.js` — `PAR_MODEL` between markers (overwritten
  daily by the R refit)
- `src/logic/dailyFeatures.js` — `computeDailyFeatures`, `predictPar`,
  `breakdownPar`, `COEF_TERMS` table
- `src/logic/handicaps.js` — handicap lookup + client-side fallback
- `src/logic/handicaps.json` — current handicaps + `secPerBombHit`
  (refitted daily)
- `src/logic/experimentDesign.js` — adaptive-experiment policy
  (every-daily, target rotation memory)
- `src/logic/experimentTarget.json` — current target + `recentTargets`
  rolling-3 memory (refitted daily)
- `src/logic/selectDailyRngSeed.js` — candidate-seed selection
  mechanism
- `src/ui/charts.js` — SVG chart toolkit (supports `secondary` series
  for the handicap-trajectory two-line overlay)
- `src/ui/statsRenderer.js` — Daily-tab orchestration (lazy-imported)
- `src/ui/diagnosticsModal.js` — diagnostics surface (lazy-imported,
  Settings button hidden behind `?debug=1`)
- `src/game/winLossHandler.js` — daily completion: handleDailyBombHit
  pushes events; auto-submit path passes them through to Firebase
  (THE AUTO-SUBMIT PATH MUST STAY IN SYNC WITH the manual submit in
  main.js — both pass `{uid, par, features, bombHitEvents, rngSeed}`)
- `scripts/refit-par-model.R` — daily Bayesian regression + handicap
  computation + experiment-target selection
- `scripts/fit-par-model.qmd` — interactive Quarto diagnostics
- `.github/workflows/refit-par-model.yml` — cron schedule + R env
- `firebase-rules.json` — RTDB security rules (allows
  `bombHitEvents` array and `rngSeed` string on daily entries)
- `backfill-features.html` — one-shot browser utility for ORIGINAL
  dailyMeta upload (write-once); for UPDATING existing records to
  add new features, use the Playwright-based pattern instead

## CLAUDE.md sections worth re-reading

- "Greg-par Model (Daily)"
- "Daily History Chart"
- "Handicaps (user-specific par offsets)"
- "Refit Workflow (.github/workflows/refit-par-model.yml)"
- "Adaptive Experimental Design"
- "Firebase" → Database paths

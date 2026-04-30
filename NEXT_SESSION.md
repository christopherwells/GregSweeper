# Handoff — current state of stats / handicap pipeline

This supersedes the previous handoff. Picking up from a session that:
- Shipped the **canonical daily board** architecture: every player on the
  same ET date plays the EXACT same board layout, locked in Firebase as
  `dailyBoard/{date}` (write-once). Closes both the experimentTarget-
  cache-divergence problem (surfaced as 2026-04-26's two-seeds-one-date
  split) and any future code-version drift between SW bundles.
- **Anchored `getLocalDateString` to America/New_York.** Tokyo player at
  9am JST plays the same daily as an NY player, regardless of local
  clock. No more timezone-fork dailies.
- Added **force-injection** of the experiment-target gimmick into all 10
  candidate seeds. Without it, the natural per-seed inclusion rate of
  ~6.6% meant ~50% of dailies had zero of the target across all
  candidates and the maximisation was meaningless.
- **GitHub Actions cron** at 00:00 UTC pre-generates tomorrow's
  canonical board (`scripts/precompute-daily-board.mjs`), eliminating
  the first-player race for every future day.
- **One-off bootstrap script** (`scripts/bootstrap-daily-board.mjs`)
  used to lock 2026-04-27 to Chris's actual played v1.5.18 board so
  any visitor today fetches it instead of generating something
  divergent.
- **Fixed the deserializer row/col bug** (v1.5.20): cells reconstructed
  from Firebase lacked `row` / `col` properties, which made
  `updateCells(revealedCells)` silently no-op because
  `updateCell(undefined, undefined)` early-exits. Symptom: tapping cells
  appeared frozen even though state was updating underneath. Root cause
  found after a player report. Defensive guard in `tryResumeGame` also
  added so any persisted-broken state forces a fresh canonical fetch.
- **Removed the `max(0, ...)` clamp** on the R script's intercept bias
  correction step. The clamp had been pinning intercept at 0.0 whenever
  the bias correction wanted negative, leaving predictPar systematically
  ~12s too high. Manual refit triggered; new intercept is −5.91s and
  mean residual dropped from −11.75s to −0.68s.
- Audited bomb-hit data collection — 8 events captured across 4 plays
  since the auto-submit fix on 2026-04-25. Schema is clean (no count vs
  events mismatch); just sparse.
- Audited per-user residual structure — found no significant difference
  in mean residual between Chris and Kate (Welch t=0.04) but real
  divergence within: gimmick coefficients are too high for both
  players, and Kate/Chris have opposite-signed correlations between
  delta and feature counts. Real signal but blocked on more players.

## Current state — what's shipping

- **v1.5.20 deployed.** Canonical-board fetch + ET-anchored dates +
  force-injection + deserializer row/col fix all live.
- **`dailyBoard/{date}` Firebase path** stores the fully-resolved board
  (mines, gimmick assignments, adjacencies, displayed numbers, walls).
  ~1-3 KB per date. Public read, write-once at the rules layer. Each
  cell ships with both `adjacentMines` AND `displayedMines` so future
  changes to wall-aware adjacency or gimmick-display logic can't
  retroactively shift historical numbers.
- **Daily-mode entry** (`gameActions.js` daily branch — now `async`):
  fetch `loadDailyBoard(state.dailySeed)` first; if hit, deserialize
  and use directly; if miss, run local-generation fallback and
  `saveDailyBoard` the result fire-and-forget. Solver still runs
  locally on the resolved board for features and best-start cell.
  Practice-daily (`?seed=` URL param) bypasses canonical fetch/write.
- **Refit is fully Bayesian.** `scripts/refit-par-model.R` runs
  `brm(time ~ features + bombHits + (1|uid))` with informative
  `lognormal` priors. Convergence guard: Rhat ≤ 1.05, ESS ≥ 400,
  divergent ≤ 0.25%. `MIN_PLAYS_FOR_FIT_INCLUSION = 30`.
- **Intercept now bias-corrects properly.** The `max(0, ...)` clamp
  that was blocking negative bias correction is removed. After today's
  refit, intercept = −5.91s and population mean residual = −0.68s
  (was −11.75s with clamp).
- **`bombHits` regressor absorbs bomb-time inflation.** Each hit
  fitted at +14.66s (visible as `secPerBombHit` in handicaps.json).
  Fit-only — NOT shipped to JS predictPar, which stays "clean-play par."
- **Handicaps** (`src/logic/handicaps.json`, last refit 2026-04-30):
  - Chris (`5Ht9d2io0ugU1NGsjdJmZvkJi382`): **+5.64s**
  - Kate  (`AYXrTjKPieYrZI8sksnYqbI3Pmh1`): **−6.25s**
- **Adaptive experimental design.** EVERY daily generates 10 candidate
  seeds (`{date}:trial0..9`). When the target maps to a gimmick, that
  gimmick is force-injected into every candidate; the maximisation
  then competes on cell COUNT instead of mere PRESENCE. Target chosen
  server-side by the R refit (highest posterior CV from a whitelist),
  excluding any feature targeted in the last 3 days.
- **Pre-generation workflow.** `.github/workflows/precompute-daily-board.yml`
  runs at 00:00 UTC. Uses anonymous Firebase auth via the REST API,
  writes to `dailyBoard/{date}` with write-once rules. Idempotent.
- **Bomb-hit event capture.** Every bomb hit pushes `{ t, row, col }`
  to `state.dailyBombHitEvents`. Submission includes the array. Auto-
  submit fix landed in `cf87e3f` (2026-04-25); pre-fix plays from Apr
  22-25 had bombHits counted but events DROPPED. End-to-end verified
  via Playwright that post-fix submissions land cleanly.
- **In-app diagnostics modal.** Hidden by default. Visit `?debug=1`
  once on a device to unlock (persisted via localStorage).
- **Refit workflow:** runs daily at 14:00 UTC (10am ET EDT). Cache key
  `r-pkgs-Linux-noble-brms-v2`.

## Recent learnings worth preserving

- **Cells need `row` and `col` properties.** `createEmptyBoard` sets
  them; many code paths read `cell.row` / `cell.col` directly
  (especially `updateCells(revealedCells)` from cascade-reveal). Any
  code path that produces cell objects WITHOUT row/col will look like
  it works (state updates correctly) but the DOM will silently fail
  to update. Found this the hard way during canonical-board ship.
- **`max(0, ...)` clamps in calibration math are usually wrong.** The
  intercept-bias-correction step's clamp seemed harmless ("don't let
  intercept go negative for theoretical purity") but quietly broke
  population-mean calibration whenever the feature-only sum
  overshot. The intercept is just an additive constant — letting it
  absorb residual bias is its only job.
- **Deploy Firebase rules BEFORE running scripts that need them.**
  When adding the `dailyBoard/{date}` rules, the bootstrap script
  failed with "permission denied" until I deployed via
  `firebase deploy --only database`. Deploy first, then run.
- **Trust outcomes, not element existence.** I shipped v1.5.9's
  bomb-event capture by verifying the deployed code looked correct
  and that Firebase rules accepted the field — but never actually
  played a daily and confirmed events landed. The auto-submit path
  bug went undetected for 4 days. Same lesson re-validated when
  v1.5.19's deserializer bug took a player report to surface.
  Rule: before claiming "shipped" on a data-flow change, RUN A PLAY
  through it and inspect the resulting Firebase entry / DOM.
- **Cache divergence is real even on a single player's machine.** My
  cached `experimentTarget.json` was apparently a stale value when I
  played 2026-04-27 — none of the 10 candidates I'd compute under the
  fresh `sonarCellCount` target would have produced trial1 as winner.
  Two players coordinating manually cannot trust caches to align.
- **Bomb-hit rate is high (~50-65%).** Daily re-fog design makes
  bomb hits feel cheap. Empirical cost is closer to ~25s per hit
  vs the nominal 10s. The fitted +14.66s coefficient is consistent
  with the explicit-penalty + recovery time.
- **Selection bias on clean-only fits.** Filtering bomb-hit plays
  isn't symmetric — Chris bombed on harder boards, Kate on slightly
  easier ones. The bombHits regressor (option A) restores symmetry
  by including all plays.
- **Posterior MEAN of a lognormal prior overshoots the median by
  ~1.65×.** With sigma=1.0 priors, a coefficient with no data signal
  comes out at `prior_mean × exp(0.5)` ≈ 1.65 × prior_median. Threshold
  guards exist for new features that are rare in the data.

## Open items

### 1. Wordle-inspired UX polish (Chris's plan)

Goal: smooth out the new-player experience and turn completion into
a virality vehicle. Three small changes, plus one deferred until
N grows.

#### 1a. Puzzle numbering

Display "GregSweeper #N" instead of "today's daily" in the UI.
Stable identifier for conversation ("did you get #45?"), works
seamlessly for new players who joined mid-stream.

- Anchor #1 to a launch date (e.g., 2026-03-06 if that's when
  daily mode started — verify against `dailyMeta` earliest date).
  Day index = days elapsed from anchor. Stays monotonic.
- Add a `getDailyPuzzleNumber(dateString)` helper in
  `src/logic/seededRandom.js` next to `getLocalDateString`.
- Surface the number in:
  - The daily completion modal heading
  - The leaderboard modal heading
  - The share string (item 1b)
  - The history-chart entries (currently labelled by date)
- Keep date strings as the Firebase keys — the puzzle number is a
  display-only derivation. No schema change.
- Effort: ~30 min, mostly UI plumbing.

#### 1b. Shareable result string

Make the existing share-card text-paste-friendly so it spreads on
iMessage / Slack / Twitter the way Wordle's colored squares do.
Plain ASCII renders inline; image attachments don't.

- Audit current share output (`statsRenderer.js` share card) for what
  format it produces. If it's an image, add a text-string variant.
- Format proposal:
  ```
  GregSweeper #45  1:25 (par 1:47, −22s)
  💣💣 hits   ⏱️ −15% par   ⭐ +1 streak
  https://christopherwells.github.io/GregSweeper/
  ```
- Use unicode emoji that render universally. NO copyrighted color
  squares (Wordle's are theirs). Mine emoji + clock + star are fine.
- Make the URL the LAST line so iMessage gives it a rich preview
  card. Test in iMessage/Slack/Twitter before declaring done.
- "Copy result" button on the win/loss modal triggers
  `navigator.clipboard.writeText(string)` + toast confirmation.
- Effort: ~45 min including format iteration.

#### 1c. Zero-friction first play

Audit how long it takes a brand-new visitor to be tapping cells on
the daily. Currently `isOnboarded()` triggers a tutorial for new
users → tutorial completion → challenge mode (NOT daily). A
returning visitor with `?mode=daily` deep link skips onboarding,
but a fresh visitor doesn't.

- Reproduce: open in Incognito. How long from URL to first cell
  reveal? If >5 seconds for daily-deep-link visitors, that's the
  bounce window.
- Likely fix: when `?mode=daily` is in the URL, set
  `minesweeper_onboarded = true` and skip the tutorial. Show a
  one-line tip toast instead ("tap to reveal, long-press to flag").
- Tutorial still triggers for non-deep-link first-visit (default
  challenge mode entry), so the depth-of-game story isn't lost —
  just not blocking the daily.
- Effort: ~20 min plus a Playwright check.

#### 1d. Post-game percentile (deferred until N > ~50 plays/day)

Wordle's "X% of players guessed in 3 tries" is the iconic stats
moment. Yours maps to "your time fell at the Pth percentile of
solvers today." Need:
- Enough Firebase scores per date to compute a meaningful quantile
  (with N=2-3 plays/day this would just say "you're 50th %" or
  "100th %" most days — not informative).
- Render in the win modal beside par-delta breakdown.

Defer until the player base supports it. Once daily plays-per-date
> ~30, this becomes worth building. Until then the par-delta
breakdown carries the comparison weight.

### 2. Player acquisition (the actual bottleneck)

Every modeling refinement we've discussed is downstream of N. With 2
players:
- Random-effect variance unidentifiable
- Move-type collinearity unresolvable
- Bomb-hit effective-feature model unfittable
- Per-feature posterior CVs noisy

The structural prerequisites (deterministic boards, ET anchor,
canonical Firebase) are now in place. The Wordle-inspired UX polish
above (item 1) is a directly-aligned investment. After that lands,
the work shifts from engineering to outreach, which is its own
discipline outside this handoff.

### 3. Per-user random slopes (deferred — blocked on N_users)

The audit found that gimmick coefficients are too high relative to
move-type coefficients for both players (gimmick days delta ~−5 to
−11, no-gimmick ~+4 to +9). And Chris/Kate have opposite-signed
delta correlations with cellCount, totalClicks, and disjunctive
moves — they have different slopes for different features.

A `(1 + features | uid)` slope-and-intercept random-effects model
would capture this. BUT:
- With 2 users, random slopes degenerate into per-user fixed
  effects — the variance prior is doing all the regularization
  because there's nothing else to identify variance from.
- Random slopes really shine at 5+ users.
- Even if implemented, would need ~50-75 plays per user per slope
  fit (roughly 150-225 plays per user for 3 slopes), so ~5-7 months
  at current rate.

Revisit when player base grows past 4. Until then, one fixed slope
per feature is the honest model.

### 4. Move-type coefficient ordering issue (deferred)

The latest fit shipped:
- `secPerCanonicalSubsetMove`: 4.21
- `secPerGenericSubsetMove`:   2.37
- `secPerAdvancedLogicMove`:   1.25
- `secPerDisjunctiveMove`:     7.43

That ordering doesn't match difficulty intuition (canonical < generic
< advanced < disjunctive). Most likely cause: collinearity between
move types — passA, canonical, and generic almost always co-occur on
boards, so the brms posterior has a degree of freedom in how it
splits the marginal time among them.

Possible fixes (in increasing weight):
- Tighter priors on the easy/medium coefficients (reduce sigma from 1.0
  to 0.5 for passA / canonical / generic). Forces the data to push
  harder against the prior to move them.
- Add an ordering constraint via `lower=` bounds in brms: each subsequent
  coefficient must be ≥ the previous (use `set_prior` with `lb=`).
- Combine `canonicalSubsetMoves` + `genericSubsetMoves` into a single
  `subsetMoves` count if the data can't reliably distinguish them.

Worth waiting for more data before applying any of these — the current
fit isn't *wrong*, it's just unidentifiable. With 2x or 3x more plays
(and more players to diversify the feature mix), it may resolve itself.

### 5. Full bomb-adjusted effective-feature model (option C)

For each bomb-hit play, re-run the solver with the bomb cells marked
as pre-revealed starting points, then take the resulting move-type
counts as the "effective" feature vector. Replaces the lump
`bombHits * +14.66s` with per-position info-value.

Status: blocked on data accumulation. Audit on 2026-04-30 found 8
bomb-hit events captured across 4 plays — far too few for a per-event
model. At ~1.2 bombs/play × 2 plays/day ≈ 2.4 events/day, expect
~70 events by end of May, ~150 by end of June. Probably worth
revisiting in 1-2 months.

When ready:
- Add `effectiveFeatures` field to score submissions, computed at
  end-of-game when `state.dailyBombHits > 0` by re-running the solver
  on the original board with bomb cells marked revealed
- R script reads `coalesce(effectiveFeatures, features)` per play
- Drop the `bombHits` regressor (effective vector already reflects
  post-bomb difficulty)
- Update Firebase rules to allow the new field

### 6. Bomb penalty rebalance

Current: 10s explicit + flag-preserved re-fog. Effective cost per
hit ≈ 25s. The system rewards risky play.

Knobs (cheapest first):
- Bump explicit penalty 10 → 20s
- Drop flag-preservation (re-fog ALL non-mine cells, not just non-flag)
- Both

Empirical evidence will be cleaner once item 5 lands.

### 7. Handicap interpretation / confidence intervals

Statistician deep-dive concluded the +6/−6 point estimates are honest
but the data is severely underpowered: 95% CrI on the gap is roughly
±15s. Displaying "+5.64s" makes it look more precise than it is.
Consider showing "+5.64s ± 8s (95% CrI)" in the UI so players read it
as "we can't tell exactly yet" instead of a verdict.

### 8. New features worth investigating

User has been generative about features. We added 2 (kept) and tried 1
(dropped). Other candidates that vary on solvable boards:
- **Mean cell adjacency** among safe cells (range 0-8)
- **Border-cell count** (cells touching board edge)
- **Mine-density ratio** as its own coefficient
- **Max single-cell adjacency** (the most-constrained safe cell)

Each follows the same pattern: add to `dailyFeatures.js` + `COEF_TERMS`
+ `PAR_MODEL` placeholder + R script formula/priors/whitelist + threshold
guard, then backfill via Playwright.

### 9. Hidden Skill Trainer

Skill Trainer mode is hidden from the UI but the code is intact
(`src/logic/skillTrainer.js`, `src/ui/skillTrainerUI.js`). Modules are
dynamic-imported via `modeManager.js` and excluded from SW pre-cache.
Decide whether to ship publicly or remove the dead code.

### 10. Node.js 20 deprecation in CI

The Refit and Precompute workflows use `actions/cache@v4`,
`actions/checkout@v4`, `r-lib/actions/setup-r@v2`, `actions/setup-node@v4`
— all of which run on Node 20, deprecated June 2026. Bump action
versions before then.

## Quick reference — how to rerun things locally

```bash
# Dev server
python -m http.server 8080

# Manual refit (writes difficulty.js + handicaps.json + experimentTarget.json
# only if N >= 30 total uid-tagged scores AND >= 2 users with >= 30 plays each)
"/c/Program Files/R/R-4.6.0/bin/Rscript.exe" scripts/refit-par-model.R

# Trigger remote refit
gh workflow run "Refit Greg-par" --ref master

# Trigger remote canonical-board pre-gen for a specific date
gh workflow run "Precompute daily board" --ref master -f date=2026-05-01

# Manually pre-generate locally (writes to Firebase via REST + anon auth)
node scripts/precompute-daily-board.mjs 2026-05-01

# Deploy Firebase rules (when firebase-rules.json changes)
MSYS_NO_PATHCONV=1 firebase deploy --only database

# Apply a multi-path Firebase update (admin bypasses rules)
MSYS_NO_PATHCONV=1 firebase database:update / update.json -f

# Open diagnostics modal (one-time per device — flag persists)
# https://christopherwells.github.io/GregSweeper/?debug=1
```

## Who's who (current uid map)

- **Chris** uid = `5Ht9d2io0ugU1NGsjdJmZvkJi382` — handicap +5.64s
- **Kate** uid = `AYXrTjKPieYrZI8sksnYqbI3Pmh1` — handicap −6.25s
  (old uid `kPkUkn5mndZG2SIGC1xC329zhrA3` migrated, scores left intact
  for rollback)
- **Wendy / Sebas** — single anonymous-visitor scores from pre-uid era,
  excluded by `MIN_PLAYS_FOR_FIT_INCLUSION` threshold

## Files that matter

- `src/firebase/dailyBoardSync.js` — canonical-board serialize/deserialize
  + Firebase load/save. Exports `loadDailyBoard`, `saveDailyBoard`,
  `serializeBoard`, `deserializeBoard`. CELL_FIELDS list controls what
  per-cell properties round-trip; `_deserializeCell(raw, r, c)` MUST
  stamp row/col on every reconstructed cell.
- `src/logic/seededRandom.js` — `getLocalDateString()` anchored to
  America/New_York via `Intl.DateTimeFormat('en-CA', { timeZone })`.
- `src/logic/difficulty.js` — `PAR_MODEL` between markers (overwritten
  daily by the R refit)
- `src/logic/dailyFeatures.js` — `computeDailyFeatures`, `predictPar`,
  `breakdownPar`, `COEF_TERMS` table
- `src/logic/handicaps.js` — handicap lookup + client-side fallback
- `src/logic/handicaps.json` — current handicaps + `secPerBombHit`
- `src/logic/experimentDesign.js` — adaptive-experiment policy +
  `TARGET_TO_GIMMICK` map for force-injection
- `src/logic/experimentTarget.json` — current target + `recentTargets`
  rolling-3 memory
- `src/logic/selectDailyRngSeed.js` — candidate-seed selection
- `src/game/gameActions.js` — `newGame()` is now `async`; daily branch
  fetches canonical first, falls back to local generation
- `src/game/gamePersistence.js` — `tryResumeGame` has a defensive guard
  that detects cells missing row/col and forces a fresh canonical fetch
- `src/game/winLossHandler.js` — daily completion submission
- `scripts/refit-par-model.R` — daily Bayesian regression. Intercept
  bias correction at line ~620 NO LONGER clamped at 0.
- `scripts/precompute-daily-board.mjs` — nightly pre-gen script
- `scripts/bootstrap-daily-board.mjs` — one-off retroactive seed
  (used once for 2026-04-27)
- `.github/workflows/refit-par-model.yml` — daily 14:00 UTC cron
- `.github/workflows/precompute-daily-board.yml` — daily 00:00 UTC cron
- `firebase-rules.json` — RTDB security rules; `dailyBoard/{date}`
  block added with write-once + per-field validation

## CLAUDE.md sections worth re-reading

- "Canonical Daily Board (cross-client board agreement)"
- "Adaptive Experimental Design"
- "Greg-par Model (Daily)"
- "Daily History Chart"
- "Handicaps (user-specific par offsets)"
- "Refit Workflow (.github/workflows/refit-par-model.yml)"
- "Firebase" → Database paths

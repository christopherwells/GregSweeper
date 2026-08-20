# Automated Greg-par refit — Bayesian mixed-effects model.
#
# Pulls `daily/*` scores and `dailyMeta/*` features from Firebase Realtime
# Database via public HTTPS reads (security rules make both world-readable),
# joins them, fits `brm(time ~ features + (1|uid))` with weakly informative
# priors centered on the hand-picked seed coefficients, and patches
# src/logic/difficulty.js between its PAR_MODEL:START / PAR_MODEL:END markers.
# Also writes src/logic/handicaps.json keyed by uid.
#
# Why Bayesian: the previous lme4 approach produced wild coefficients at
# N=62 (canonical 2.0 -> 14.77, wormhole 0.8 -> 32) because ordinary maximum
# likelihood has no regularization on the fixed effects. Priors centered on
# the seed values pull the fit toward sensible numbers whenever the data
# isn't yet strong enough to override them, so we can refit at low N without
# catastrophic drift and decommission the hard MAX_COEF_DRIFT = 10 clamp.
#
# Run manually with Rscript scripts/refit-par-model.R, or automatically on
# the cron schedule defined in .github/workflows/refit-par-model.yml.

suppressPackageStartupMessages({
  library(jsonlite)
  library(dplyr)
  library(tidyr)
  library(purrr)
  library(stringr)
  library(brms)          # Bayesian mixed-effects via Stan. The fixed-effects
                         # priors are what prevent the wild coefficient
                         # swings that killed the lme4 approach; random
                         # intercepts still do what lmer did for handicaps.
  library(posterior)     # as_draws_array() and summarise_draws() used below
                         # for convergence diagnostics. brms exports S3
                         # methods but the generics live here.
})

# Reproducible sampling. Not strictly necessary with enough iterations but
# avoids committing a different set of coefficients on identical data.
set.seed(20260422)

`%||%` <- function(a, b) if (is.null(a)) b else a

# REFIT_DB_URL exists for the pre-merge smoke, which points it at the
# committed fixture directory (jsonlite::fromJSON reads local paths through
# the same string paste). Unset, this is the production database, verbatim.
DB_URL          <- Sys.getenv("REFIT_DB_URL", "https://gregsweeper-66d02-default-rtdb.firebaseio.com")
DIFFICULTY_PATH <- "src/logic/difficulty.js"
HANDICAPS_PATH  <- "src/logic/handicaps.json"

# Fixed base component of the info-value bomb penalty (mirrors
# BOMB_PENALTY_BASE in src/logic/difficulty.js). For a new-mechanic
# bomb-hit play, this is the only part of the per-hit penalty that's a
# true added cost — the info-value part offsets the deduction time the
# player skipped — so it's what we subtract to recover clean-play time.
BOMB_PENALTY_BASE <- 3

# Minimum total scores before we bother fitting at all. With informative
# priors the fit is stable at much lower N than the old lm/lmer approach
# (which needed ~150 before coefficients stopped blowing up), so the floor
# is mostly about "is there enough signal to move the prior at all" rather
# than "will the fit explode". 30 is roughly 2 observations per predictor.
MIN_SCORES_TO_FIT <- 30

# Minimum total plays before a user's scores are allowed to influence
# the GLOBAL model and earn a shipped handicap. Set low (5) because the
# heavy players anchor the fixed effects and partial pooling shrinks a
# small-N user's random intercept toward zero, so a light player can
# neither drag the board-difficulty coefficients nor get an over-
# confident handicap; the threshold's only job now is to keep true
# one-offs (1-4 plays) out. Bomb-hit plays count toward the total:
# new-mechanic plays have their deterministic info-value penalty
# subtracted into `clean_time` upstream; legacy +10s/re-fog plays carry
# their cost via the `legacy_bombs` regressor. Anyone below this still
# gets a client-side provisional handicap from their own residuals
# (handicaps.js).
MIN_PLAYS_FOR_FIT_INCLUSION <- 5

# (MIN_PLAYS_FOR_HANDICAP retired; the residuals-fallback path now uses
# the same MIN_PLAYS_FOR_FIT_INCLUSION threshold as the main fit, so
# handicaps.json has a single meaning: "users with enough plays to
# contribute to the population calibration". Anyone below the threshold
# needs client-side handicap estimation via handicaps.js.)

# ── Revalidation targeting (2026-07-17, approved 2026-07-12) ────────────
# Every REVALIDATION_INTERVAL days the primary experiment target becomes
# the STALEST SETTLED feature (low remaining uncertainty, longest since it
# was last targeted) instead of the top-CV feature, so a finding Greg
# closed months ago gets deliberately re-tested. The cadence is anchored
# to `lastRevalidationDate` in experimentTarget.json (robust to missed
# refits, unlike a modulo on refit count); a missing anchor treats the
# first post-deploy run as due, so the mechanism is visible immediately.
# "Settled" mirrors the journal's RESTING contract: bottom-half of the
# current CV ordering. The recentTargets (last 3) exclusion still holds.
REVALIDATION_INTERVAL <- 14

# ── Clue-digit studies (2026-07-17) ────────────────────────────────────
# Per-board nonzero-digit SHARES, derived from the canonical boards at fit
# time (full historical coverage from day one — no client instrumentation
# needed), for the arithmetic-load question: beyond board size and the
# reasoning tiers, does clue MAGNITUDE (more 2s vs 3s) cost time? Absorbed
# from Christopher's cwells/par-digit-feature experiment (commit 51d451f):
# nonzero-digit shares with 5+ lumped and the 1s as the omitted reference
# (raw counts are density in disguise — mean clue ~ 8*density, r = 0.94 —
# so only the SHAPE at fixed density can carry new signal). Scaled ×10 so
# one unit is "one extra clue-in-ten of that digit", which reads naturally
# in the journal's per-unit estimate line.
#
# These are measured in a SEPARATE canonical-era secondary fit (below) and
# their posteriors feed ONLY the experiment-target candidates and the
# journal's study cards. They are NEVER emitted into PAR_MODEL — the
# strongest form of the new-feature ship-guard: the shipped predictPar is
# byte-identical with or without this block, so a digit coefficient that is
# still confounded with density (see r = 0.94) can never move real par.
# Promote to a shipped term only once the confound is resolved on more
# players, through the normal refit path.
DIGIT_FEATURES <- c("clueShare2", "clueShare3", "clueShare4", "clueShare5plus")
# Board-derived features are trustworthy only from the canonical era: before
# this date the stored dailyBoard was REGENERATED by the backfill and does
# not match the date's original dailyMeta features or its played time, so a
# re-derived digit share would describe a different board than the score
# row (Christopher's provenance note, 2026-06-28).
DIGIT_ERA_START <- "2026-04-27"

# ── Gimmick-contribution study (2026-07-30, secondary fit only) ────────
# Christopher's hypothesis: an INTEGRAL gimmick (one the solve needs) and an
# incidental one price differently, and the raw cell counts cannot see it —
# force-injection holds them nearly constant (every compass daily ships
# exactly 3 compass cells). The client now records the strip-and-resolve
# counterfactual the load-bearing filter always computed and discarded:
# per testable type, `<g>Required` (board unsolvable without the gimmick's
# information) and `<g>ClicksSaved` (deduction clicks it spares — reported 0
# when required, where the quantity is undefined; the pair must be read
# jointly). Plus the locked split: what is UNDER a lock (a mine to prove vs
# a number delayed) is different work, and lockedCellCount pools them.
#
# Sources, in precedence order: dailyMeta-carried keys (the generation-time
# solver of record, prospective rows) then scripts/data/gimmick-contribution.json
# (the committed Node backfill over stored canonicals — a re-measure under
# the backfill run's solver, covering the canonical era R itself cannot
# compute, since the solver is JS). Same provenance floor as the digit
# study: DIGIT_ERA_START, below which stored boards are not the boards the
# scores describe.
#
# These are NEVER emitted into PAR_MODEL, and deliberately NOT merged into
# target_candidates either (a contribution feature is not force-injectable
# by the candidate scorer, which never computes these keys — a mission
# targeting one would occupy a slot it can never win). The posteriors land
# in modelHistory rows under `contribution` for longitudinal reading.
CONTRIB_FEATURES <- c(
  "sonarRequired",    "sonarClicksSaved",
  "compassRequired",  "compassClicksSaved",
  "wormholeRequired", "wormholeClicksSaved",
  "liarRequired",     "liarClicksSaved",
  "mirrorRequired",   "mirrorClicksSaved",
  "lockedMineCount",  "lockedNumberCount"
)
CONTRIB_BACKFILL_PATH <- "scripts/data/gimmick-contribution.json"
# A column enters the study formula only with real variation behind it:
# nonzero on at least this many distinct dates. What this gate actually drops
# on today's data is the thin/empty ClicksSaved columns (sonar has 2 shortcut
# dates; wormhole/liar/mirror have none). It does NOT drop the Required
# flags: wormholeRequired is 1 on 11 of 13 wormhole boards and mirrorRequired
# on 17 of 18 mirror boards, so both pass easily — but they are then
# NEAR-collinear with their own pair-count controls (Required ≈ presence for
# those types), so read their posteriors as "the pair count and the flag
# share one effect", not as separated quantities, until a shipped
# non-required wormhole/mirror board exists to split them.
CONTRIB_MIN_NONZERO_DATES <- 3

# ── Decorrelation missions (Journal PR F1) ─────────────────────────────
# The experiment's missions all chase either one coefficient's uncertainty
# (the CV / revalidation primary target) or one gimmick's sample gap
# (coverage). Neither breaks COLLINEARITY, and collinearity is what actually
# blocks a confounded coefficient: more boards of the SAME correlated shape
# cannot separate a feature from its confounder. What separates them is an
# observation in the design's weakest direction.
#
# So each night we look for the worst-confounded pair we can actually act on,
# fit the line between them, and hand the client that line. The client then
# scores candidate boards by their RESIDUAL against it — how far the feature
# sits from what the confounder predicts — and ships the board furthest into
# the under-sampled corner. The statistics stay here; the client does one
# subtraction and one divide, so every player resolves the same board.
#
# Deliberately PAIRWISE rather than a multi-term VIF: the client's scorer
# takes exactly two features, so naming a feature whose confound is spread
# across several terms would emit a mission it cannot act on. Pairwise R² is
# the part of the confound a single decorrelation board can actually attack.
DECORRELATION_FEATURES <- DIGIT_FEATURES
# Confounder candidates must be computable client-side by computeDailyFeatures
# under the SAME key, since the client looks them up by name in the feature
# vector. These five are; the pooled reasoning tiers (patternMoves /
# searchMoves) are derived at fit time and are not, so they stay out.
DECORRELATION_CONFOUNDERS <- c("density", "cellCount", "totalMines",
                               "wallEdgeCount", "zeroClusterCount")
# Below this pairwise |r| the pair is not meaningfully confounded and a
# decorrelation day would spend a board on nothing. clueShare3 vs density
# measured r = 0.80 on the canonical-era boards, so this bar is a long way
# below the live case it was built for.
DECORRELATION_MIN_ABS_R <- 0.5
# The weight is DERIVED, not guessed, because a guessed one is dead code.
# Every mission scores `min(raw, COUNT_CAP) * weight`, but the raw inputs are
# on different scales: a coverage count saturates the cap on almost any board
# (wormLoad runs 0.6-12), while a residual z rarely passes 2.5. At a flat 0.3
# a decorrelation candidate topped out around 0.75 against a coverage slot
# sitting at 5 * 0.33 = 1.67, so it lost every single day and the mission
# would have shipped without ever selecting a board.
#
# So: solve for the weight that makes a board DECORRELATION_TARGET_Z residual
# SDs into the corner exactly tie the strongest coverage mission. A board
# deeper than that takes the day; a shallower one leaves it to coverage. That
# rule re-calibrates itself whenever the coverage deficits move, which a
# hardcoded constant cannot.
DECORRELATION_TARGET_Z <- 1.0
# Mirrors COUNT_CAP in src/logic/experimentDesign.js, which is the source of
# truth for the scoring formula. Only used to solve for the weight above.
DECORRELATION_COUNT_CAP <- 5
# Mirrors PRIMARY_WEIGHT in the same file: the floor competitor when the
# coverage list is empty.
DECORRELATION_PRIMARY_WEIGHT <- 0.1
# Rows needed before the fitted line is worth shipping as a mission.
DECORRELATION_MIN_ROWS <- 30
# How often a decorrelation night comes round, anchored to
# lastDecorrelationDate in experimentTarget.json exactly like the
# revalidation clock (robust to missed refits; a missing anchor makes the
# first run due, so the mechanism is visible right after deploy).
#
# This cadence is the whole frequency policy, and it exists because the
# weight cannot express one. A confound severe enough to be worth a mission
# is severe every night, so an always-emitted mission calibrated to actually
# WIN takes the calendar: measured at 11 of 12 days, which would starve the
# coverage slate while wormLoad still sits on two boards. Emitting one night
# in seven keeps coverage at roughly six days in seven AND lets that one
# night be decisive rather than a coin flip.
DECORRELATION_INTERVAL <- 7

# Choose tonight's decorrelation mission, or NULL.
#
# For every (feature, confounder) pair, regress the feature on the confounder
# and keep the strongest confound. The client scores candidate boards on the
# MAGNITUDE of the residual against this line, so BOTH tails are in play: a
# board below the line breaks the correlation as well as one above it
# (Christopher's ruling, 2026-07-18). We therefore emit only the line and its
# scale, and never a preferred direction.
choose_decorrelation_mission <- function(dat, features, confounders, rival_weights = numeric(0)) {
  if (is.null(dat) || nrow(dat) < DECORRELATION_MIN_ROWS) return(NULL)
  # The strongest mission this one has to beat on a given day.
  top_rival <- max(c(rival_weights, DECORRELATION_PRIMARY_WEIGHT), na.rm = TRUE)
  weight <- DECORRELATION_COUNT_CAP * top_rival / DECORRELATION_TARGET_Z
  best <- NULL
  for (f in intersect(features, names(dat))) {
    for (cf in intersect(confounders, names(dat))) {
      if (f == cf) next
      y <- suppressWarnings(as.numeric(dat[[f]]))
      x <- suppressWarnings(as.numeric(dat[[cf]]))
      ok <- is.finite(y) & is.finite(x)
      if (sum(ok) < DECORRELATION_MIN_ROWS) next
      y <- y[ok]; x <- x[ok]
      if (stats::sd(y) <= 0 || stats::sd(x) <= 0) next
      r <- suppressWarnings(stats::cor(y, x))
      if (!is.finite(r) || abs(r) < DECORRELATION_MIN_ABS_R) next
      if (!is.null(best) && abs(r) <= best$absR) next
      fit <- stats::lm(y ~ x)
      slope <- unname(stats::coef(fit)[2])
      intercept <- unname(stats::coef(fit)[1])
      resid <- stats::residuals(fit)
      rsd <- stats::sd(resid)
      if (!is.finite(slope) || !is.finite(intercept) || !is.finite(rsd) || rsd <= 0) next
      best <- list(
        feature    = f,
        confounder = cf,
        slope      = round(slope, 6),
        intercept  = round(intercept, 6),
        residualSd = round(rsd, 6),
        weight     = round(weight, 4),
        absR       = abs(r),
        rsq        = round(r^2, 4),
        n          = length(y),
        # Diagnostics only: how the EXISTING boards sit either side of the
        # line. Never shipped, and never used to pick a direction — it is
        # here so the refit log says whether the design is currently lopsided.
        n_hi       = sum(resid >  rsd),
        n_lo       = sum(resid < -rsd)
      )
    }
  }
  best
}

# Sampling budget. 4 chains × 2000 iterations (1000 warmup) is standard;
# more than enough for this model size on any plausible N.
N_CHAINS    <- 4
N_ITER      <- 2000
N_WARMUP    <- 1000
ADAPT_DELTA <- 0.99   # tight step-size adaptation: coefficients near the
                      # zero edge of their positive-support lognormal
                      # priors (cellCount ~ 0.02, etc.) create sharp
                      # curvature in the log-posterior, and looser
                      # adaptation produces a handful of divergent
                      # transitions. 0.99 is the usual fix.

# Max fraction of post-warmup draws that may diverge before we reject the
# fit. Stan's own guidance is "much less than 1%" — 0.25% is comfortably
# below that. A nonzero but small count is common near boundaries and does
# not invalidate the posterior means we care about.
MAX_DIVERGENT_FRAC <- 0.0025

# SMOKE MODE (REFIT_SMOKE=1): the pre-merge exercise of this script's data
# shaping and emission, run in CI over the committed fixture snapshot
# (test/fixtures/refit-db/, reached via REFIT_DB_URL). Twice in one week the
# nightly died on a data regime no code path had ever met (the first match_
# rows under daily/, then the first fully saturated coverage list), and both
# crashes were in shaping or emission, not in the sampler, so the smoke runs
# everything, with the fit shrunk to a toy. Toy-fit diagnostics are LOGGED
# but never gate acceptance (see the convergence check), because a toy
# posterior's convergence says nothing and the smoke ships no coefficients;
# what a green run proves is that every branch downstream of the fit still
# runs on the data regimes production actually holds. With the variable
# unset, every value in this file is exactly what it was.
REFIT_SMOKE <- nzchar(Sys.getenv("REFIT_SMOKE"))
if (REFIT_SMOKE) {
  N_CHAINS    <- 2
  N_ITER      <- 500
  N_WARMUP    <- 250
  ADAPT_DELTA <- 0.9
}

# NOTE (log-model migration, 2026-07): the model response is now
# log(pure_time), so every slope is a log-MULTIPLIER, not seconds. The LIVE
# prior CENTERS are therefore seeded per-refit from an OLS fit of
# log(pure_time) ~ features (compute_log_ols_seeds, below) rather than from the
# seconds-scale PRIOR_MEANS here, which are retained only as documentation of
# the original additive intent and are NO LONGER read by build_priors. What is
# still used: PRIOR_SIGMAS (prior WIDTHS on the log scale) and
# PRIOR_INTERCEPT_SD. To freeze a stable non-ratcheting anchor instead of the
# per-run OLS seeds, hardcode a log-scale PRIOR_MEANS and pass it to build_priors.
#
# Prior means, one per fixed-effect coefficient. These are the original
# hand-picked seed values that were in difficulty.js before any refit ran,
# and represent our "reasonable guess" for how many seconds each kind of
# move / cell / mine / modifier adds to par. Keeping them fixed in the R
# script (rather than re-reading them from the current PAR_MODEL) means
# the priors are a stable anchor — successive refits can't ratchet the
# prior toward a drift direction.
PRIOR_MEANS <- list(
  # Intercept centered at 0: no real board has all features = 0, so the
  # intercept is only meaningful as an extrapolation artifact that catches
  # whatever calibration mismatch the slopes can't explain. A seed of 0
  # says "we have no strong opinion about the baseline, let the data
  # decide" while still penalising absurd values through PRIOR_INTERCEPT_SD.
  Intercept            = 0.0,
  # Size (2026-06-08 feature rework). cellCount is the lone board-size axis
  # — it absorbs trivial-propagation time, so passAMoves is no longer a
  # predictor; its seed is well above the old 0.02 to carry that cost.
  # totalMines stays a raw count: VIF 3.6 (fine once the redundant size
  # features are dropped), and density made its coefficient unreadable
  # (352/-80 intercept), so we keep the interpretable per-mine form.
  cellCount            = 0.30,
  totalMines           = 0.3,
  # Reasoning load, two earned tiers: pattern = canonical + generic subset
  # deductions; search = advanced (tank/gauss) enumeration. The raw four
  # move-types are too sparse/small-count to identify separately.
  patternMoves         = 4.0,
  searchMoves          = 6.0,
  wallEdgeCount        = 0.15,
  # Modifier cells — kept split; sparse (each on ~5-10% of boards), so
  # prior-anchored until the coverage missions accumulate boards.
  mysteryCellCount     = 0.8,
  liarCellCount        = 0.6,
  lockedCellCount      = 0.4,
  wormholePairCount    = 0.8,
  mirrorPairCount      = 1.0,
  sonarCellCount       = 0.5,
  compassCellCount     = 0.5,
  # wormLoad: pre-programmed worm segment-moves in HUNDREDS (egg lengths x
  # the board's 30-80 move budget; runs ~0.6-12 per worm board, the same
  # numeric range as the count features). Worms delay information without
  # destroying it (a memory/patience tax, not a deduction), so the per-unit
  # cost should sit at the light end. Zero-guarded in the shipped model
  # until NEW_FEATURE_DATA_THRESHOLD plays carry nonzero values.
  wormLoad             = 0.05,
  # legacy_bombs: per-hit cost for plays under the old +10s/re-fog mechanic
  # (v1.5.148 and earlier). New-mechanic plays already have their info-value
  # penalty subtracted into clean_time and contribute 0 here, so this only
  # explains the legacy cohort. Fit-only — folded into each player's
  # handicap, not shipped to predictPar.
  legacy_bombs         = 15.0,
  # archivePlay: per-row offset for archive replays (PR 3 daily archive). A
  # replay carries no day-of stakes (no streak, separate leaderboard), so a
  # relaxed, slightly-slower pace is the expected direction; seed it small and
  # let the data move it. Fit-only — NEVER shipped to predictPar (predictPar
  # is day-of par). NOTE: archivePlay's lognormal prior has support only above
  # zero, so this asserts a NON-NEGATIVE offset; revisit the prior family if
  # pooled archive plays turn out systematically faster once real data lands.
  # (Non-negativity also rides the class bound — the flat path's class-wide
  # lb = 0 blanket, or the base nlpar's bound on the nl path; see build_priors.)
  archivePlay          = 2.0,
  # matchPlay has NO entry here on purpose: it is a SIGNED deviation, fitted in
  # the `dev` nlpar alongside the shape deviations rather than in this bounded
  # block. See the dev_cols construction in the fit section for why.
  zeroClusterCount     = 1.0
  # The old per-shape intercept offsets (shape488..shapeDeltoidal, seeded 0.05
  # each) are GONE (2026-08-01): board shape is now a full per-shape equation,
  # fit as SIGNED deviations from the square fit with centers FIXED at zero
  # (normal(0, INTERACTION_PRIOR_SD) — see the shape registry below). A
  # deviation has no prior-mean entry because a zero center IS the design:
  # "priors informed by the square fit" means a shape's equation starts as the
  # square's and peels away only as its own data justifies.
)

# Per-coefficient prior *log-scale* sigmas. Each non-intercept prior is
# `lognormal(log(mean), sigma)`: lognormal is inherently positive (par is
# monotonic non-decreasing in every feature, so slopes can't be negative),
# and its median equals the seed value. sigma on the log scale is roughly
# the coefficient of variation: 0.5 gives ~[seed/1.65, seed*1.65] at ±1 SD
# and ~[seed/2.7, seed*2.7] at ±2 SD — wide enough to let strong data
# override, tight enough to prevent the 10x fixed-effect swings that killed
# the lme4 approach. The intercept keeps a plain normal prior (could
# legitimately be near zero after bias correction).
PRIOR_INTERCEPT_SD <- 2.0    # LOG scale now (was 15s additive): the log
                              # baseline is ~log(30)≈3.4, so SD 2.0 is very
                              # wide (±2SD ≈ ×[0.018, 55]) yet not degenerate;
                              # the OLS seed + bias-correction set the level.
PRIOR_SIGMAS <- list(
  # cellCount has NO entry here any more (his M1 ruling, 2026-08-18): the
  # size pair (cellCount + logCells) is SIGNED and rides the dev nlpar at
  # normal(0, SIZE_DEV_PRIOR_SD), routed around this bounded-lognormal
  # machinery the way matchPlay is. See the SIZE_DEV_COLS block below
  # COEF_TO_PREDICTOR.
  # The rate predictors (2026-08-20). Wide, like the counts they replace: the
  # priors are OLS-seeded, so the seed adapts to the rates' own scale
  # (coefficients near 5 rather than near 0.05) and sigma stays a statement
  # about how much the prior should say, not about units.
  mineRate             = 1.0,
  patternRate          = 1.0,
  searchRate           = 1.0,
  # The COUNTS keep their sigmas even though the primary fit no longer uses
  # them. They are retired as SHIPPED coefficients, not as predictors: the
  # digit, contribution and decorrelation fits still carry them as controls,
  # and build_priors stop()s on any formula term without a sigma. The pipeline
  # smoke caught exactly this ("Missing prior sigma for totalMines").
  totalMines           = 1.0,
  patternMoves         = 1.0,
  searchMoves          = 1.0,
  wallEdgeCount        = 1.0,
  mysteryCellCount     = 1.0,
  liarCellCount        = 1.0,
  lockedCellCount      = 1.0,
  wormholePairCount    = 1.0,
  mirrorPairCount      = 1.0,
  sonarCellCount       = 1.0,
  compassCellCount     = 1.0,
  wormLoad             = 1.0,
  # Tighter prior on legacy_bombs (sigma=0.4): OLS on legacy data gives a
  # clean ~15s estimate, with little need for the wide spread the others get.
  legacy_bombs         = 0.4,
  archivePlay          = 1.0,   # wide: little prior knowledge of the offset size
  # No matchPlay entry: it is fitted as a signed deviation, not a bounded slope.
  zeroClusterCount     = 1.0,
  # No shape entries here: shape terms are DEVIATIONS (normal(0,
  # INTERACTION_PRIOR_SD), signed) routed around the lognormal machinery by
  # build_priors' deviation_names argument. build_priors still stop()s on any
  # non-deviation name that reaches the formula without a sigma, so the
  # abort-don't-degrade discipline is unchanged.
  # Digit shares — wide, so the canonical-era data (not the prior) decides.
  # Used only in the secondary digit fit; never shipped to predictPar.
  clueShare2           = 1.0,
  clueShare3           = 1.0,
  clueShare4           = 1.0,
  clueShare5plus       = 1.0
)

# ── Per-shape par equations (2026-08-01) ───────────────────────────────
# Christopher's ruling, 2026-08-01: "we might just want different par
# equations for each shape... priors can be informed by the square tilings."
# This replaces the six secPerShape* intercept offsets, which asserted a
# lattice can only shift par by a constant. The joint fit below instead
# estimates, per shape, a SIGNED deviation of every feature's log-multiplier
# from the square fit's (shape-by-feature interactions) plus the old intercept
# offset relocated as the shape's intercept deviation. It stays ONE fit, not
# six per-shape fits, because the player random intercept (1|uid) must be
# estimated across every board a player touches — six slices would ship six
# disagreeing handicaps.

# JS coefficient key -> R model predictor, in EMISSION ORDER. One table drives
# the fit extraction, the emitted difficulty.js blocks, the per-shape
# composition and apply_par_model, so adding a coefficient here adds it
# everywhere at once — the property the two hand-maintained sprintf templates
# this replaced did not have (their slot/arg counts silently drifted twice,
# each drift shifting every later coefficient one slot).
COEF_TO_PREDICTOR <- c(
  # THE RATE FORM (his ruling 2026-08-20, proven in
  # scripts/par-model-move-rates.qmd). Every count that grows with board AREA
  # now enters divided by the board, and log(cells) carries size on its own.
  #
  # Why: counts multiply on the log scale, so a board four times larger
  # carried four times the moves and par grew like e^(4*beta*n). Measured, the
  # shipped form priced a 660-cell board that two people finished in twenty
  # minutes at five to thirty-one hours. Trained at <= 187 cells and asked to
  # price 638-660 cell boards, the count form missed by 23.9x typically, this
  # one by 1.3x, which also beats the marathon lane's own anchor pricing
  # (1.5x) on boards it was purpose-built for. In sample the two are
  # indistinguishable (residual SD 0.404 against 0.399), so nothing is given
  # up where people actually play.
  #
  # secPerCell, secPerMineFlag, secPerPatternMove and secPerSearchMove are
  # RETIRED, the way secPerShape* was: gone from this table, gone from the
  # emitted blocks, and gone from COEF_TERMS on the JS side, so a stale
  # coefficient cannot be applied to a predictor that no longer means what it
  # did. Retiring rather than zeroing is deliberate; a key at 0 reads as
  # "not yet earned", and these are not coming back.
  secPerLogCell      = "logCells",
  secPerMineRate     = "mineRate",
  secPerPatternRate  = "patternRate",
  secPerSearchRate   = "searchRate",
  secPerWallEdge     = "wallEdgeCount",
  secPerZeroCluster  = "zeroClusterCount",
  secPerMysteryCell  = "mysteryCellCount",
  secPerLiarCell     = "liarCellCount",
  secPerLockedCell   = "lockedCellCount",
  secPerWormholePair = "wormholePairCount",
  secPerMirrorPair   = "mirrorPairCount",
  secPerSonarCell    = "sonarCellCount",
  secPerCompassCell  = "compassCellCount",
  secPerWormLoad     = "wormLoad"
)
BASE_MODEL_FEATURES <- unname(COEF_TO_PREDICTOR)

# ── The size pair (his M1 ruling, 2026-08-18) ──────────────────────────
# `logCells = log(cellCount)` beside the linear term, fitted as ONE concave
# size curve: gamma ~ +0.9 on the log term with the linear term going
# NEGATIVE (~ -0.01), measured in scripts/par-model-size-offset.qmd on 800
# rows (M1; the replace-form M2 found gamma 0.15 and was refuted, so BOTH
# terms stay). The pair dissolves the 19s zero-feature intercept into the
# size curve and takes the marathon-envelope extrapolation from 5.5 days to
# ~2 hours.
#
# BOTH terms ride the dev nlpar (matchPlay's routing, and for matchPlay's
# reason): the class-wide lb = 0 on the base block is a claim about single
# features par is monotonic in, and under M1 the SIZE CURVE is the pair
# jointly. Its linear half is negative by measurement, so bounded it would
# pile at zero and push the curvature into the board coefficients. The two
# columns are never gated: any frame that clears MIN_SCORES_TO_FIT spans
# many board sizes, and a degenerate frame fails the Rhat/ESS gate rather
# than a variance check here.
#
# Prior: normal(0, SIZE_DEV_PRIOR_SD) on both. INTERACTION_PRIOR_SD (0.5)
# would shrink the measured gamma ~14% toward zero (posterior SE ~0.2 against
# a 0.5-wide prior); at 1.0 the pull is ~4%, and an elasticity above 2
# (par growing faster than cells squared) stays implausible under it.
# Under the rate form the linear half is retired, so the size curve is
# log(cells) alone and its elasticity is firmly positive (1.164 [1.060,
# 1.267], measured). It stays on the SIGNED dev nlpar anyway: the lb = 0
# blanket is a claim that par is monotonic non-decreasing in the feature, and
# leaving the one term the whole size question rides on unbounded keeps the
# data able to say otherwise. Keeping the column non-empty also keeps Path B
# permanent for the primary fit, which the dev_cols construction relies on.
SIZE_DEV_COLS <- c("logCells")
SIZE_DEV_PRIOR_SD <- 1.0

# JS tilingType string (the PAR_MODEL_SHAPES key) -> R predictor stem. Must
# stay in lockstep with TILING_TYPES in src/logic/tilingGeometry.js — R cannot
# import the registry, so test/tilingParModelContract.test.mjs pins the two
# against each other. '6.6.6' has no row here on purpose: it is a deep-link
# alias for 'hex' that never reaches a stored tilingType (builders stamp
# canonical names); the client's modelFor normalizes it.
SHAPE_TABLE <- c(
  "4.8.8"     = "shape488",
  "hex"       = "shapeHex",
  "cairo"     = "shapeCairo",
  "floret"    = "shapeFloret",
  "rhombille" = "shapeRhombille",
  "deltoidal" = "shapeDeltoidal"
)
SHAPE_PREDICTORS <- unname(SHAPE_TABLE)

# Every shape-by-feature interaction column: shape<S>_x_<F> = indicator x
# feature. A column is all-zero until that shape has fit rows, so the
# per-column zero-variance gate in the fit block collapses the whole layer to
# nothing today. wormLoad is included: its interaction can be nonzero only on
# rows where wormLoad itself is, so the base term's own gate (add_worm_term)
# is implied whenever the interaction's passes.
SHAPE_INTERACTION_COLS <- as.vector(t(outer(SHAPE_PREDICTORS, BASE_MODEL_FEATURES,
                                            paste, sep = "_x_")))
SHAPE_DEV_NAMES <- c(SHAPE_PREDICTORS, SHAPE_INTERACTION_COLS)

# Prior SD for every SIGNED deviation term (each shape indicator and each
# shape-by-feature interaction): normal(0, INTERACTION_PRIOR_SD). Why 0.5
# against PRIOR_SIGMAS' 1.0: those sigmas are MULTIPLICATIVE widths around a
# nonzero lognormal median (roughly a CV), while this is an ABSOLUTE width
# around zero on the same log-multiplier axis, so the two numbers are not
# directly comparable and quoting them side by side overstates how much
# tighter this is. Half the lognormal sigma encodes "the deviation of a
# shape's per-unit cost from the square's is plausibly smaller than the cost
# itself" — the reasoning tiers transfer in meaning across lattices, so most
# of what a shape changes is already carried by the feature values and the
# deviation holds only the remainder. It still cannot bind: the largest base
# coefficient ever shipped is ~0.05 per unit, so ±1 SD here is ten times the
# whole cost of the dearest feature.
INTERACTION_PRIOR_SD <- 0.5

# Ship guard threshold, shared by the base new-feature zero-guard and the
# per-deviation earn guard (hoisted from the extraction block so both layers
# and the emitted header read one value): a coefficient/deviation ships only
# once its column has this many nonzero fit rows, else it is zeroed and the
# lognormal-prior median (or a prior-blend deviation) never reaches predictPar.
NEW_FEATURE_DATA_THRESHOLD <- 20

# ── Par Lab prior seeding (Christopher's four rulings, 2026-08-03) ──────
# The completed 86-board Par Lab battery (scripts/fit-parlab-priors.qmd; its
# posteriors frozen in scripts/data/parlab-prior-centers.json) measured the
# per-shape deviations live data structurally cannot identify: the rotation
# ships one fixed config per shape, so a shape's cellCount/totalMines
# deviation columns are exactly collinear with its intercept deviation. His
# rulings on how the lab enters this fit:
#   1. SEED THE SHIPPED BLOCKS NOW: a lab-seeded deviation ships its center
#      even before live rows exist (the flip must not price a deltoidal
#      daily at parity), and the fitted posterior takes over continuously
#      as live rows accumulate.
#   2. Strikes as symptom: the centers come from the lab's primary model
#      (no strike regressor), matching this fit's own bombs convention.
#   3. DOUBLED lab widths: normal(lab mean, 2 x lab sd). The center holds,
#      live data can override at moderate evidence — honest about one
#      practiced player's multipliers pricing everyone.
#   4. The n=1 gimmick observation cells stay ZERO-centered wide (his
#      small-n ruling: observations, not conclusions). Enforced by
#      LAB_SEED_MIN_ROWS, which the core grid terms (8-12 lab rows) pass
#      and the single-board gimmick cells (1 row) do not.
# The loader fails SOFT — a missing/malformed file degrades to zero-centered
# deviations, the pre-seeding behavior — because the nightly must fit either
# way. A silently lost seeding still fails LOUDLY: the contract test pins
# difficulty.js against the JSON, so the refit's own commit reddens CI.
LAB_PRIORS_PATH      <- "scripts/data/parlab-prior-centers.json"
LAB_SEED_MIN_ROWS    <- 5
LAB_PRIOR_WIDTH_MULT <- 2
lab_seed_devs <- tryCatch({
  lab <- fromJSON(LAB_PRIORS_PATH, simplifyVector = FALSE)
  out <- list()
  for (nm in names(lab$deviations %||% list())) {
    d <- lab$deviations[[nm]]
    if (nm %in% SHAPE_DEV_NAMES && (d$nRows %||% 0) >= LAB_SEED_MIN_ROWS) {
      out[[nm]] <- list(mean = as.numeric(d$mean),
                        sd   = as.numeric(d$sd) * LAB_PRIOR_WIDTH_MULT)
    }
  }
  out
}, error = function(e) {
  message("  lab priors unavailable (", conditionMessage(e),
          ") — shape deviations fall back to zero-centered")
  list()
})

# Parse the current PAR_MODEL block out of difficulty.js. Used as the
# "previous values" baseline for the drift sanity check and as the fallback
# when no new fit runs.
parse_par_model <- function(path) {
  src <- paste(readLines(path, warn = FALSE, encoding = "UTF-8"),
               collapse = "\n")
  block_start <- str_locate(src, fixed("// PAR_MODEL:START"))[1, "end"]
  block_end   <- str_locate(src, fixed("// PAR_MODEL:END"))[1, "start"]
  if (is.na(block_start) || is.na(block_end)) {
    stop("PAR_MODEL markers missing in ", path)
  }
  block <- substr(src, block_start + 1, block_end - 1)
  rx <- "(\\w+)\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)"
  m <- str_match_all(block, rx)[[1]]
  if (nrow(m) == 0) stop("Could not parse any coefficients from PAR_MODEL")
  setNames(as.list(as.numeric(m[, 3])), m[, 2])
}

# Apply the full PAR_MODEL formula to every row of `df` and return predicted
# times in SECONDS. Kept close to the JS predictPar so the two stay in sync.
# `log_scale` selects the model form, mirroring predictPar's `scale` branch:
#   log_scale = TRUE  -> par = exp(intercept + Σ coef·x)   (multiplicative; median)
#   log_scale = FALSE -> par = intercept + Σ coef·x        (legacy additive seconds)
# The linear predictor is identical either way; only the back-transform differs.
#
# `shape_devs` is a named list of shape DEVIATION terms (indicator +
# interaction names from SHAPE_DEV_NAMES) added to the linear predictor. This
# keeps the function ONE equation mirroring the FIT rather than six shipped
# blocks: base + dev·indicator + Σ dev_F·indicator·F is algebraically the same
# as applying the composed shape block to that shape's rows, and pricing rows
# exactly as the fit sees them is what the outlier screen and the residual
# fallback need. NULL (or empty) prices everything on the base equation.
apply_par_model <- function(df, coefs, log_scale = TRUE, shape_devs = NULL) {
  # Default every model column, every shape indicator, and every interaction
  # column. Defaulted HERE rather than relied upon from the caller because
  # this function runs against several frames (df, df_fit, timed_df, the
  # residual fallback) and a rectangles-only frame legitimately carries none
  # of the shape columns; the old with(df, ...) form errored on any missing
  # name, which is why the loop is explicit.
  for (.f in c(BASE_MODEL_FEATURES, SHAPE_DEV_NAMES)) {
    if (!.f %in% colnames(df)) df[[.f]] <- 0
    df[[.f]] <- ifelse(is.na(df[[.f]]), 0, as.numeric(df[[.f]]))
  }
  # logCells is DERIVED, never defaulted: a frame built before the mutate
  # that adds it (timed_df, ad-hoc predict frames) still carries cellCount,
  # and pricing its log term as 0 would misprice every board the moment the
  # coefficient is nonzero. Same pmax guard as the JS derivation; recomputing
  # on a frame that already has the column is the identical value.
  df$logCells <- log(pmax(1, df$cellCount))
  # The RATE predictors, derived here for the same reason logCells is: a frame
  # built before the mutate that adds them still carries the raw counts, and
  # pricing a rate as 0 would misprice every board. Division is by the same
  # pmax-guarded cell count, so a degenerate zero-cell row cannot produce Inf.
  cells_safe <- pmax(1, df$cellCount)
  if (!is.null(df$totalMines))   df$mineRate    <- df$totalMines / cells_safe
  if (!is.null(df$patternMoves)) df$patternRate <- df$patternMoves / cells_safe
  if (!is.null(df$searchMoves))  df$searchRate  <- df$searchMoves / cells_safe
  # Data-driven off COEF_TO_PREDICTOR — the same table the emitter and the
  # extraction read, so a coefficient cannot exist in the shipped block
  # without being priced here. `%||% 0` keeps it correct against a parsed
  # block predating any given coefficient.
  lp <- rep(as.numeric(coefs$intercept), nrow(df))
  for (k in names(COEF_TO_PREDICTOR)) {
    lp <- lp + (coefs[[k]] %||% 0) * df[[COEF_TO_PREDICTOR[[k]]]]
  }
  for (cn in names(shape_devs %||% list())) {
    lp <- lp + as.numeric(shape_devs[[cn]]) * df[[cn]]
  }
  if (log_scale) exp(lp) else lp
}

# Recover the SHIPPED shape deviations from the PAR_MODEL_SHAPES block:
# parse each per-shape coefficient set and difference it against the base
# coefficients, mapping back to fit-term names (shape<S> for the intercept,
# shape<S>_x_<F> for a slope). The outlier screen and the residual fallback
# price rows against the previously shipped model, and a tiling row must be
# priced on its own shipped equation — not the base one — or a shape with a
# real earned deviation would screen its own rows against the wrong par.
# Returns an empty list when the markers are missing or every shipped
# deviation is zero (today), both meaning "price on the base equation".
parse_par_model_shapes_devs <- function(path, base_coefs) {
  src <- paste(readLines(path, warn = FALSE, encoding = "UTF-8"), collapse = "\n")
  s <- str_locate(src, fixed("// PAR_MODEL_SHAPES:START"))[1, "end"]
  e <- str_locate(src, fixed("// PAR_MODEL_SHAPES:END"))[1, "start"]
  if (is.na(s) || is.na(e)) return(list())
  block <- substr(src, s + 1, e - 1)
  devs <- list()
  for (js_key in names(SHAPE_TABLE)) {
    stem <- SHAPE_TABLE[[js_key]]
    # Each entry is `'4.8.8': { ... },` or `hex: { ... },` — take its body up
    # to the first closing brace (the entries are flat, no nesting inside).
    key_rx <- paste0("(?:'", gsub(".", "\\.", js_key, fixed = TRUE), "'|",
                     gsub(".", "\\.", js_key, fixed = TRUE), ")\\s*:\\s*\\{")
    m <- str_locate(block, regex(key_rx))
    if (is.na(m[1, "end"])) next
    rest <- substr(block, m[1, "end"] + 1, nchar(block))
    close_at <- str_locate(rest, fixed("}"))[1, "start"]
    if (is.na(close_at)) next
    body <- substr(rest, 1, close_at - 1)
    kv <- str_match_all(body, "(\\w+)\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)")[[1]]
    if (nrow(kv) == 0) next
    vals <- setNames(as.list(as.numeric(kv[, 3])), kv[, 2])
    d_int <- (vals$intercept %||% base_coefs$intercept) - base_coefs$intercept
    if (d_int != 0) devs[[stem]] <- d_int
    for (k in names(COEF_TO_PREDICTOR)) {
      d <- (vals[[k]] %||% base_coefs[[k]] %||% 0) - (base_coefs[[k]] %||% 0)
      if (d != 0) devs[[paste0(stem, "_x_", COEF_TO_PREDICTOR[[k]])]] <- d
    }
  }
  devs
}

# Detect whether a parsed PAR_MODEL block is on the log (multiplicative) scale.
# The refit stamps `scale: 'log'` into the emitted block; its absence means the
# historical additive model. Drives the back-transform for the outlier screen
# and the residual fallback, which run against the CURRENTLY shipped model.
par_model_is_log <- function(path) {
  src <- paste(readLines(path, warn = FALSE, encoding = "UTF-8"), collapse = "\n")
  block_start <- str_locate(src, fixed("// PAR_MODEL:START"))[1, "end"]
  block_end   <- str_locate(src, fixed("// PAR_MODEL:END"))[1, "start"]
  if (is.na(block_start) || is.na(block_end)) return(FALSE)
  block <- substr(src, block_start + 1, block_end - 1)
  str_detect(block, "scale\\s*:\\s*'log'")
}

# ── Log-model constants (2026-07 migration) ─────────────
# Legacy (+10s/re-fog, pre-2026-05-31) per-hit bomb cost in SECONDS. The
# mechanic is frozen, so this cohort only shrinks. Under the multiplicative
# model a seconds-scale bomb regressor no longer belongs in the log fit, so
# legacy bomb cost is subtracted from time up front (like the new-mechanic base
# surcharge) at this fixed rate and folded into each player's additive
# bombSeconds. Shipped as secPerBombHit. (To make it data-driven again, fit a
# small seconds-scale lm on legacy rows and set this from its bombHits slope.)
LEGACY_BOMB_RATE <- 15.0
# WIDE sanity bound on the multiplicative handicap — purely to reject a
# degenerate/garbage value (e.g. a broken fit), NOT to shape real players. The
# regularizer is partial pooling here (and shrinkage in the client provisional),
# which correctly leaves a WELL-SAMPLED player on their own data however extreme;
# clamping a confidently-fit k would censor real skill (Christopher, 2026-07-02:
# "Kate has lots of plays. Why are we clamping?"). [0.1, 10] never bites a
# plausible human — nobody is 10x faster or slower than Greg.
HANDICAP_K_MIN <- 0.1
HANDICAP_K_MAX <- 10.0
# Floor on pure clean-play time before log() — a very fast board can be a few
# seconds, so guard against <= 0 after subtracting bomb cost.
PURE_TIME_FLOOR <- 1.0
# Floor for an OLS-seeded prior mean so lognormal(log(mean), sigma) is defined
# when a sparse/collinear predictor yields a tiny/negative slope.
PRIOR_MEAN_FLOOR <- 1e-3

# OLS-seed the prior CENTERS on the log scale: fit log(pure_time) ~ features by
# ordinary least squares and use each slope as its lognormal prior median (the
# "OLS-seeded priors" choice). Memoryless w.r.t. prior refits — re-derived from
# all current data each run, never from the previous posterior, so it can't
# ratchet. Missing/NA/non-positive slopes floor to PRIOR_MEAN_FLOOR; the wide
# PRIOR_SIGMAS keep every prior weakly informative.
compute_log_ols_seeds <- function(df_fit, fixed_names) {
  f <- as.formula(paste("log(pure_time) ~", paste(fixed_names, collapse = " + ")))
  co <- tryCatch(coef(lm(f, data = df_fit)), error = function(e) numeric(0))
  names(co)[names(co) == "(Intercept)"] <- "Intercept"
  out <- list()
  out[["Intercept"]] <- if (!is.null(co["Intercept"]) && !is.na(co["Intercept"]) && is.finite(co["Intercept"])) {
    as.numeric(co["Intercept"])
  } else {
    log(30)  # ~typical board par when OLS can't set a baseline
  }
  for (nm in fixed_names) {
    v <- co[nm]
    out[[nm]] <- if (!is.null(v) && !is.na(v) && is.finite(v) && v > 0) as.numeric(v) else PRIOR_MEAN_FLOOR
  }
  out
}

# Build the brms prior list — the geometry-critical half of the TWO-PATH fit
# design (path selection lives in the fit block; the paths differ only in how
# the formula and priors are constructed, everything downstream is shared).
#
# FLAT path (`deviation_names` empty — every night until tiling scores exist):
# per-coefficient lognormals (positive support, median = the OLS-seeded
# log-multiplier) under the restored class-wide blanket, bit-identical to the
# construction that fit cleanly for months before PR #203. The blanket looks
# redundant next to positive-support priors; it is not. The bound is a
# TRANSFORM statement, support only a density statement: bounded, Stan samples
# each coefficient through a log transform — smooth unconstrained geometry
# however close the mass sits to zero — while unbounded, the lognormal density
# is a HARD WALL at zero in the sampled space, with several OLS-seeded medians
# (~exp(-6.9) ≈ 0.001) pressed right against it. PR #203 removed the blanket
# so signed shape deviations could share class b, betting on support-as-bound;
# the first dispatched run (2026-08-01) was REJECTED — divergent 14/4000
# (gate 10), 2950/4000 max-treedepth exceedances, min ESS 464 — on the SAME
# data the bounded setup had fit twelve hours earlier at Rhat 1.007 /
# ESS 1060 / 0 divergent, with brms itself warning that a lower-bounded prior
# sat on an unbounded parameter. The blanket may therefore only exist while
# class b carries NO signed term, which the flat path guarantees by
# construction (deviations are the only signed terms, and they force the nl
# path).
#
# NL path (`deviation_names` non-empty): bounds in brms attach per parameter
# CLASS, and a non-linear formula gives each nlpar its OWN class b — the
# sanctioned way to bound one group of fixed effects and not another. Base
# terms keep their lognormals plus the class blanket under nlpar = "base"
# (constrained transform restored); deviations get zero-centered SIGNED
# normals under nlpar = "dev" with NO bound — a lattice can make a feature
# cheaper as well as dearer, and the zero center is the "priors informed by
# the square fit" mechanism (at zero data every deviation posterior sits at 0
# and the shape's equation IS the square's). With nl = TRUE there is no
# global Intercept class: the base intercept is an ordinary class-b
# coefficient (coef = "Intercept", nlpar = "base"), so its normal prior moves
# there and picks up the class bound — harmless, the log baseline sits at
# ~log(30) ≈ 3.4, far from zero. The (1|uid) random intercept rides the base
# nlpar, so its sd prior carries the same tag. sigma is response-level and
# stays untagged on both paths. Residual and handicap SD priors are on the
# LOG scale (times are lognormal), NOT the old seconds scale.
build_priors <- function(means, fixed_names, deviation_names = character(0)) {
  nl <- length(deviation_names) > 0
  parts <- list()
  if (!nl) {
    # Class-wide lower bound: log-multiplier slopes are non-negative (par is
    # monotonic non-decreasing in every feature) and lognormal requires
    # positivity. brms can't combine `coef` with `lb`, so the bound rides a
    # class-wide placeholder and the distributions come through per-coef priors.
    parts[[length(parts) + 1]] <- set_prior("", class = "b", lb = 0)
  } else {
    # Same bound, scoped to the base nlpar's own class b so the signed
    # deviations in the dev nlpar stay unbounded.
    parts[[length(parts) + 1]] <- set_prior("", class = "b", nlpar = "base", lb = 0)
  }
  for (nm in fixed_names) {
    m <- means[[nm]]
    if (is.null(m)) stop("Missing prior mean for ", nm)
    if (nm == "Intercept") {
      parts[[length(parts) + 1]] <- if (nl) {
        set_prior(sprintf("normal(%f, %f)", m, PRIOR_INTERCEPT_SD),
                  class = "b", coef = "Intercept", nlpar = "base")
      } else {
        set_prior(sprintf("normal(%f, %f)", m, PRIOR_INTERCEPT_SD),
                  class = "Intercept")
      }
    } else {
      sig <- PRIOR_SIGMAS[[nm]]
      if (is.null(sig)) stop("Missing prior sigma for ", nm)
      parts[[length(parts) + 1]] <- if (nl) {
        set_prior(sprintf("lognormal(%f, %f)", log(max(m, PRIOR_MEAN_FLOOR)), sig),
                  class = "b", coef = nm, nlpar = "base")
      } else {
        set_prior(sprintf("lognormal(%f, %f)", log(max(m, PRIOR_MEAN_FLOOR)), sig),
                  class = "b", coef = nm)
      }
    }
  }
  for (nm in deviation_names) {
    # No means/PRIOR_SIGMAS lookup: a deviation's center is zero by design —
    # EXCEPT the lab-seeded core terms, whose centers come from the Par Lab
    # posteriors at doubled width (the seeding block by the shape registry).
    # Unseeded terms, including every gimmick-by-shape cell, keep the
    # zero-centered signed normal at the documented INTERACTION_PRIOR_SD.
    # The SIZE PAIR (cellCount + logCells, M1) rides this nlpar for its sign
    # freedom but takes its own wider SIZE_DEV_PRIOR_SD: the elasticity's
    # posterior SE is ~0.2, and INTERACTION_PRIOR_SD would shrink the
    # measured gamma ~14% toward zero (see the SIZE_DEV_COLS block).
    # lab_seed_devs cannot collide here: its keys are shape stems and
    # shape_x_feature names, never a bare predictor.
    seed <- lab_seed_devs[[nm]]
    parts[[length(parts) + 1]] <- if (nm %in% SIZE_DEV_COLS) {
      set_prior(sprintf("normal(0, %f)", SIZE_DEV_PRIOR_SD),
                class = "b", coef = nm, nlpar = "dev")
    } else if (!is.null(seed)) {
      set_prior(sprintf("normal(%f, %f)", seed$mean, seed$sd),
                class = "b", coef = nm, nlpar = "dev")
    } else {
      set_prior(sprintf("normal(0, %f)", INTERACTION_PRIOR_SD),
                class = "b", coef = nm, nlpar = "dev")
    }
  }
  # Residual SD on the LOG scale (completion-time log-residuals are O(0.1-0.5)).
  parts[[length(parts) + 1]] <- set_prior("normal(0, 1)", class = "sigma")
  # Between-user SD on the LOG scale — weakly informative for a log-scale
  # variance component (real users' k spread sits well within the [0.5, 2] clamp).
  parts[[length(parts) + 1]] <- if (nl) {
    set_prior("student_t(3, 0, 1)", class = "sd", group = "uid", nlpar = "base")
  } else {
    set_prior("student_t(3, 0, 1)", class = "sd", group = "uid")
  }
  do.call(c, parts)
}

# ── NL-path name normalization (the extraction boundary) ────────────────
# On the nl path brms prefixes every population-level name with its nlpar:
# fixef rows read `base_Intercept`, `base_cellCount`, `dev_shape488_x_...`,
# and the uid random-intercept slice in ranef is keyed `base_Intercept`. ONE
# normalization at the extraction boundary strips the prefixes back to the
# flat names, so new_coefs, shape_dev_summary, earned_shape_devs,
# apply_par_model and the emitter all see exactly the names they see today —
# never scattered renames (a bare fixef/ranef read on the nl path would miss
# every coefficient SOFTLY, through the %||% 0 and %in% lookups, not loudly).
# On the flat path both helpers are no-ops: no coefficient of ours begins
# with "base_" or "dev_", so the strip cannot collide.
strip_nlpar_prefix <- function(x) sub("^(base|dev)_", "", x)
flat_fixef <- function(f) {
  fe <- fixef(f)
  rownames(fe) <- strip_nlpar_prefix(rownames(fe))
  fe
}
flat_ranef_uid <- function(f) {
  arr <- ranef(f)$uid
  dimnames(arr)[[3]] <- strip_nlpar_prefix(dimnames(arr)[[3]])
  arr
}

# ── Clue-digit buckets (ported from clueHistogram in
# scripts/extract-par-experiment.mjs, commit 51d451f) ──────────────────
# Bin the TRUE adjacency count (adjacentMines) of every non-mine cell that
# eventually shows a NUMBER to the player: exclude mines (no clue), mystery
# (number hidden), and pressure plates (a timer, not a count). Reads the
# SERIALIZED canonical cells directly — serializeBoard drops false booleans, so
# a missing isMine/isMystery/isPressurePlate is false and adjacentMines is
# always present. Whole-board (every such cell), and the TRUE count, kept
# independent of the gimmick-DISPLAY magnitude (wormhole pair sums, sonar 5x5
# counts) that the modifier terms already model.
#
# Counted into the four reported buckets plus a denominator, with NO upper bound
# on the digit. This used to be a nine-wide histogram indexed 0-8, which quietly
# assumed no cell can touch more than eight others — true on a rectangle and on
# both tilings shipped through 2026-07-22, false on a lattice of higher valence
# (a rhombille rhombus has ten corner-inclusive neighbors, a deltoidal kite
# nine). A dropped digit vanished from numerator AND denominator, so all four
# shares described a smaller board than the one stored, silently. This function
# and dailyFeatures.clueShares are ONE definition in two languages: the client
# scores a candidate board on its copy and the fit measures the same board on
# this one, so they must change together or only the fit ever finds out.
clue_digit_counts <- function(board) {
  counts <- c(nz = 0L, d2 = 0L, d3 = 0L, d4 = 0L, d5plus = 0L)
  cells <- board$cells
  if (is.null(cells)) return(counts)
  for (cell in cells) {
    if (isTRUE(cell$isMine) || isTRUE(cell$isMystery) || isTRUE(cell$isPressurePlate)) next
    v <- cell$adjacentMines
    if (is.null(v)) v <- 0
    v <- as.integer(v)
    # Zeros cascade away and are already told as zeroClusterCount; the
    # denominator is the cells that show a NUMBER.
    if (is.na(v) || v <= 0) next
    counts["nz"] <- counts["nz"] + 1L
    if (v == 2) counts["d2"] <- counts["d2"] + 1L
    else if (v == 3) counts["d3"] <- counts["d3"] + 1L
    else if (v == 4) counts["d4"] <- counts["d4"] + 1L
    else if (v >= 5) counts["d5plus"] <- counts["d5plus"] + 1L
  }
  counts
}

# Per-date nonzero-digit shares from the canonical boards, canonical era
# only (see DIGIT_ERA_START). Returns one row per date with the four
# shipped digit-share features (5+ lumped, 1s the omitted reference),
# scaled ×10 so a unit is "one extra clue-in-ten of that digit". Dates
# whose board has no numbered clue at all are dropped (no denominator).
digit_shares_from_boards <- function(db_raw, cutoff_date) {
  dates <- sort(names(db_raw))
  dates <- dates[grepl("^\\d{4}-\\d{2}-\\d{2}$", dates) &
                   dates >= DIGIT_ERA_START & dates <= cutoff_date]
  rows <- lapply(dates, function(d) {
    h <- clue_digit_counts(db_raw[[d]])
    nz <- h[["nz"]]
    if (nz == 0) return(NULL)
    data.frame(
      date           = d,
      clueShare2     = 10 * h[["d2"]] / nz,
      clueShare3     = 10 * h[["d3"]] / nz,
      clueShare4     = 10 * h[["d4"]] / nz,
      clueShare5plus = 10 * h[["d5plus"]] / nz,
      stringsAsFactors = FALSE
    )
  })
  do.call(rbind, rows)
}

# ── 1. Pull data ────────────────────────────────────────

message("[", format(Sys.time(), tz = "UTC", usetz = TRUE), "] fetching Firebase…")

meta_raw   <- fromJSON(paste0(DB_URL, "/dailyMeta.json"), simplifyVector = FALSE) %||% list()
scores_raw <- fromJSON(paste0(DB_URL, "/daily.json"),     simplifyVector = FALSE) %||% list()

# Timed-mode rows (timed/{pushId}, features embedded per row since every
# timed board is unique). NOT yet in the fit: the modeTimed effect
# activates once >= TIMED_FIT_THRESHOLD rows exist — same instrument-
# first-model-later pattern as new feature coefficients. Until then this
# is a progress counter so the workflow log shows the data accumulating.
TIMED_FIT_THRESHOLD <- 20
timed_raw <- tryCatch(
  fromJSON(paste0(DB_URL, "/timed.json"), simplifyVector = FALSE) %||% list(),
  error = function(e) list()
)

message(sprintf("  dailyMeta dates: %d", length(meta_raw)))
message(sprintf("  daily score dates: %d", length(scores_raw)))
message(sprintf("  timed rows: %d (modeTimed effect activates at >= %d)",
                length(timed_raw), TIMED_FIT_THRESHOLD))

# Daily archive rows (dailyArchive/{date}/{pushId}): replays of PAST dailies
# (PR 3). Same board features as the day-of play, so they sharpen the
# board-difficulty coefficients — especially the sparse modifiers a replay
# happens to land on. Instrument-first like timed mode: accumulated and logged
# now, pooled into the fit only once >= ARCHIVE_FIT_THRESHOLD rows exist (the
# replay-pace offset needs data to be identifiable, and a tiny biased stream
# shouldn't move the shared coefficients).
ARCHIVE_FIT_THRESHOLD <- 20
archive_raw <- tryCatch(
  fromJSON(paste0(DB_URL, "/dailyArchive.json"), simplifyVector = FALSE) %||% list(),
  error = function(e) list()
)
message(sprintf("  archive rows: %d (pooled into the fit at >= %d)",
                sum(map_int(archive_raw, length)), ARCHIVE_FIT_THRESHOLD))

# Challenge MATCH rows arrive inside the same daily/* node, under keys of the
# form `match_<16 hex>` derived from the board's own seed (see
# src/logic/matchCodes.js matchRowKey). They are not dates, and that is
# deliberate: a match board is a library board, not a day, so the same board
# played in two different matches by four different people pools into one key
# with one dailyMeta, which is exactly the structure the per-shape layer is
# starved of. Their frame differs from a daily's, though — a run of boards
# played back to back, with no once-a-day ritual around it — so a matchPlay
# dummy absorbs the offset, fit-only and never shipped to predictPar.
#
# Instrument-first, the same shape archive replays take: accumulate and log
# now, pool once the offset is identifiable. Held out entirely below that, so
# n_scores, the outlier screen and every board coefficient see the daily frame
# only.
MATCH_ROW_PREFIX <- "^match_[0-9a-f]{16}$"
MATCH_FIT_THRESHOLD <- 20

# Canonical boards (dailyBoard/{date}): world-readable, no secret. Used to
# derive the clue-digit shares at fit time (full historical coverage — every
# board back to the canonical era carries the data, no client instrument).
# Fetch is best-effort: if it fails, the digit secondary fit simply doesn't
# run and the primary pipeline is untouched.
board_raw <- tryCatch(
  fromJSON(paste0(DB_URL, "/dailyBoard.json"), simplifyVector = FALSE) %||% list(),
  error = function(e) { message("  dailyBoard fetch failed (digit studies skipped): ", conditionMessage(e)); list() }
)
message(sprintf("  dailyBoard dates: %d", length(board_raw)))

if (length(meta_raw) == 0 || length(scores_raw) == 0) {
  message("Empty dataset — nothing to fit. Exiting cleanly.")
  quit(status = 0)
}

meta <- tibble(
  date     = names(meta_raw),
  features = map(meta_raw, ~ .x$features)
) |>
  filter(!map_lgl(features, is.null)) |>
  unnest_wider(features)

# Both day-of (daily/) and archive (dailyArchive/) entries carry the same
# score shape, so one parser extracts both. cruxViewed is archive-only (the
# PR 4 `?crux=` preview marker; absent → FALSE). Returns a typed 0-row tibble
# for an empty node so bind_rows works when no archive rows exist yet.
parse_score_rows <- function(raw) {
  if (length(raw) == 0) {
    return(tibble(date = character(), time = double(), uid = character(),
                  bombHits = double(), totalBombPenalty = double(), bombBaseSum = double(),
                  wormRealized = double(),
                  n_hints = integer(), cruxViewed = logical()))
  }
  tibble(
    date  = rep(names(raw), map_int(raw, length)),
    entry = flatten(map(raw, ~ .x))
  ) |>
    mutate(
      time              = map_dbl(entry, ~ .x$time %||% NA_real_),
      uid               = map_chr(entry, ~ .x$uid  %||% NA_character_),
      bombHits          = map_dbl(entry, ~ .x$bombHits %||% 0),
      # v1.5.149+ (info-value bomb mechanic): totalBombPenalty is the sum of
      # per-hit deterministic penalties already added to `time`. Legacy plays
      # (re-fog / +10s mechanic) don't have this field — detected by
      # `bombHits > 0 & totalBombPenalty == 0` and carried by `legacy_bombs`.
      totalBombPenalty  = map_dbl(entry, ~ .x$totalBombPenalty %||% 0),
      # Base-only bomb surcharge actually added to `time`: Σ(penalty − infoValue)
      # over the per-hit events. The info-value part of each penalty offsets the
      # deduction the player skipped by bombing (real board difficulty — it stays
      # in clean_time); only this base is a pure surcharge to remove. Reading it
      # from the stored per-hit penalties makes it correct for BOTH cohorts with
      # NO date split: pre-2026-06-15 rows charged a flat BOMB_PENALTY_BASE per
      # hit (Σ = base × hits), later rows charge an escalating base × strike#
      # (Σ = base × hits·(hits+1)/2). Legacy +10s rows have no per-hit penalty
      # field, so this is 0 and their cost rides the `legacy_bombs` regressor.
      bombBaseSum       = map_dbl(entry, ~ {
        ev <- .x$bombHitEvents %||% list()
        if (length(ev) == 0) return(0)
        sum(map_dbl(ev, ~ (.x$penalty %||% 0) - (.x$infoValue %||% 0)))
      }),
      # REALIZED worm dose (2026-07-17): Σ len × moves / 100 over the row's
      # wormEvents — the exact pace-agnostic segment-moves this run actually
      # experienced. The board's scheduled wormLoad (dailyMeta) is the MAX
      # dose; a fast solver or a late hatch realizes less, and that gap is
      # systematic (correlated with speed), so fitting on the schedule would
      # attenuate the coefficient. NA = no events on the row (a pre-worm
      # board, or an old client that could not log) — the join below falls
      # back to the scheduled value for those rows.
      wormRealized      = map_dbl(entry, ~ {
        ev <- .x$wormEvents %||% list()
        if (length(ev) == 0) return(NA_real_)
        sum(map_dbl(ev, ~ (.x$len %||% 0) * (.x$moves %||% 0))) / 100
      }),
      # Lens hints (the in-game "Stuck?" helper, shipped v1.6.12 and REMOVED
      # 2026-07-18). No new row can carry hintEvents, but the historical ones
      # do, and a hinted completion is still not an honest observation of board
      # difficulty. KEEP this filter: dropping it would readmit every old
      # hinted play into the fit. It is simply a no-op on new data now.
      n_hints           = map_int(entry, ~ length(.x$hintEvents %||% list())),
      # PR 4 crux preview: an archive row whose crux the player saw is dropped
      # from the fit (previewing the answer changes the completion time).
      cruxViewed        = map_lgl(entry, ~ isTRUE(.x$cruxViewed)),
    ) |>
    select(-entry)
}

# Day-of plays (archive = 0) and archive replays (archive = 1), filtered and
# bomb-corrected together. The pooling gate (after the meta join) decides
# whether the archive rows actually enter the fit.
scores_df <- bind_rows(
  parse_score_rows(scores_raw)  |> mutate(archive = 0L),
  parse_score_rows(archive_raw) |> mutate(archive = 1L)
) |>
  filter(!is.na(time), time >= 5, time <= 3600) |>
  filter(n_hints == 0) |>
  # Drop archive rows whose crux was previewed; day-of rows never carry the
  # flag, so this only ever removes archive rows.
  filter(!(archive == 1L & cruxViewed)) |>
  mutate(
    archivePlay    = as.numeric(archive),  # nuisance dummy; in the fit only when pooled
    # Challenge match boards live in the same daily/ node under a seed-derived
    # `match_<hash>` key rather than a date. Their board coefficients are the
    # daily's; only the frame around them differs, which matchPlay absorbs.
    is_match       = grepl(MATCH_ROW_PREFIX, date),
    matchPlay      = as.numeric(is_match),
    is_legacy_bomb = bombHits > 0 & totalBombPenalty == 0,
    legacy_bombs   = if_else(is_legacy_bomb, bombHits, 0),
    # clean_time = the time the player would have scored solving the FULL
    # board with no bomb hits. For a new-mechanic play, `time` already
    # includes Σ(infoValue + base) of penalty; the infoValue part exactly
    # offsets the deduction time the player skipped by bombing, so the only
    # true added cost is the base surcharge — `bombBaseSum`, which escalates
    # per hit under the new mechanic. Subtract just that — NOT totalBombPenalty
    # (which would over-subtract by Σ infoValue and make bomb-hit plays look
    # artificially fast, dragging the coefficients down). Legacy plays keep
    # their full `time` here and contribute their cost through the
    # `legacy_bombs` regressor instead.
    clean_time     = time - if_else(totalBombPenalty > 0, bombBaseSum, 0),
    # pure_time additionally removes the LEGACY per-hit cost (the new-mechanic
    # base is already out via clean_time), so the log response below is
    # genuinely clean-play time for BOTH cohorts and no bomb regressor is
    # needed. Floored so log() is always defined on a very fast board.
    pure_time      = pmax(clean_time - if_else(is_legacy_bomb, LEGACY_BOMB_RATE * bombHits, 0), PURE_TIME_FLOOR),
  )

legacy_n <- sum(scores_df$is_legacy_bomb, na.rm = TRUE)
new_n    <- sum(scores_df$totalBombPenalty > 0, na.rm = TRUE)
if (legacy_n > 0 || new_n > 0) {
  message(sprintf("  bomb cohort split: %d legacy (+10s/re-fog) | %d new-mechanic (info-value)",
                  legacy_n, new_n))
}

df <- scores_df |>
  inner_join(meta, by = "date")

# Archive pooling gate (instrument-first, same philosophy as timed mode and
# new feature coefficients): until archive replays are numerous enough to fit
# their replay-pace offset, hold them out of the fit entirely so n_scores, the
# outlier screen, and every board-difficulty coefficient see day-of plays
# only. They keep accumulating in Firebase; the fetch log above tracks the
# count. Once pooled, an archivePlay dummy absorbs the offset (in the fit
# block below).
n_archive <- sum(df$archive)
pool_archive <- n_archive >= ARCHIVE_FIT_THRESHOLD
if (pool_archive) {
  # First-completion-only is enforced client-side, but a falls-open history
  # read could leave an archive row for a date the player also has a day-of
  # row for. Drop those archive duplicates so a board is never double-counted;
  # day-of rows are never touched.
  dayof_keys <- df |> filter(archive == 0L) |> distinct(uid, date) |>
    mutate(.has_dayof = TRUE)
  df <- df |>
    left_join(dayof_keys, by = c("uid", "date")) |>
    filter(!(archive == 1L & !is.na(.has_dayof))) |>
    select(-.has_dayof)
} else {
  df <- df |> filter(archive == 0L)
}
message(sprintf("  archive: %d row(s) after filters — %s", n_archive,
                if (pool_archive) "POOLED into the fit (archivePlay offset)"
                else sprintf("held out of the fit (< %d to pool)", ARCHIVE_FIT_THRESHOLD)))

# Challenge match pooling gate, the same instrument-first shape. Below the
# threshold the rows keep accumulating in Firebase and are held out entirely,
# so no board coefficient moves on a frame offset nobody has measured yet.
n_match <- sum(df$matchPlay)
pool_match <- n_match >= MATCH_FIT_THRESHOLD
if (!pool_match) {
  df <- df |> filter(matchPlay == 0)
}
message(sprintf("  match: %d row(s) after filters — %s", n_match,
                if (pool_match) "POOLED into the fit (matchPlay offset)"
                else sprintf("held out of the fit (< %d to pool)", MATCH_FIT_THRESHOLD)))

# v1.5.16+ structural features may not exist in older dailyMeta records
# (the field is write-once per Firebase rules). Default missing columns
# to 0 so old plays still contribute to the OTHER coefficients; their
# new-feature contributions just get computed against a 0 baseline,
# which biases the new coefficients slightly downward at first but
# straightens out as new plays accumulate.
# NOTE: this is the THIRD place that answers "a new structural feature is
# missing from older dailyMeta rows", and R cannot import the other two. The
# nightly sweep (scripts/verify-canonical-boards.mjs) answers it with
# FEATURES_EPOCH against each meta's writtenAt, and dailyFeatures.js exports
# SOLVER_DERIVED_FEATURE_KEYS for the structural-vs-solver split. Adding a
# feature key means visiting all three; they are independent by necessity, not
# by design.
NEW_STRUCTURAL_FEATURES <- c("nonZeroSafeCellCount", "zeroClusterCount",
                             # wormLoad ships 2026-07: every dailyMeta row
                             # before the worm-tiles release lacks the key.
                             "wormLoad")
for (f in NEW_STRUCTURAL_FEATURES) {
  if (!f %in% colnames(df)) df[[f]] <- 0
}

# Worm dose: the FIT uses each row's realized load (from its wormEvents),
# not the board's scheduled maximum. `wormScheduled` keeps the structural
# value for the realization-ratio the shipped coefficient needs (predictPar
# can only know the schedule pre-play). Rows without events (old clients on
# a worm board) keep the scheduled value — a documented overstatement that
# only affects the launch-day cohort.
df$wormScheduled <- ifelse(is.na(df$wormLoad), 0, df$wormLoad)
df$wormLoad <- ifelse(!is.na(df$wormRealized), df$wormRealized, df$wormScheduled)

df <- df |>
  mutate(across(
    c(passAMoves, canonicalSubsetMoves, genericSubsetMoves,
      advancedLogicMoves,
      totalMines, cellCount, wallEdgeCount, mysteryCellCount,
      liarCellCount, lockedCellCount, wormholePairCount,
      mirrorPairCount, sonarCellCount, compassCellCount,
      wormLoad, nonZeroSafeCellCount, zeroClusterCount),
    ~ ifelse(is.na(.x), 0, as.numeric(.x))
  ))

# Board shape (Project Coastline). computeDailyFeatures emits `tilingType`
# ONLY on a non-rectangular board — absent, never "rect" — so a missing column
# here is the normal all-rectangles case, not a parse failure. Expanded into
# one 0/1 indicator per shipped tiling with rectangles as the omitted
# reference. SHAPE_TABLE is the one list to grow when a tiling lands; the
# indicator columns, interaction columns, gates, priors, extraction and
# emission all derive from it.
if (!"tilingType" %in% colnames(df)) df$tilingType <- NA_character_
df$tilingType <- as.character(df$tilingType)
for (.js_key in names(SHAPE_TABLE)) {
  df[[SHAPE_TABLE[[.js_key]]]] <- as.numeric(!is.na(df$tilingType) & df$tilingType == .js_key)
}
# One count per shape, built as name/value pairs rather than a hand-kept
# sprintf: this message once grew its own slot/arg count alongside the old
# PAR_MODEL template's, and a message whose format string and argument list
# drift apart either errors or prints the wrong shape's total.
message(sprintf("  tiling rows: %s of %d total",
                paste(sprintf("%d (%s)",
                              vapply(SHAPE_PREDICTORS, function(p) sum(df[[p]]), numeric(1)),
                              names(SHAPE_TABLE)),
                      collapse = " + "),
                nrow(df)))

# Anti-cheat (mirrors isBombHitCheat in difficulty.js — KEEP THE TWO IN STEP):
# a run that found most of the board's mines by stepping on them was probing the
# layout, not solving it — its time is a garbage data point (tiny wall-clock +
# every mine's info-value) no matter how it is priced, so it must never anchor
# the model. The client blocks these at submission; this drops the historical
# ones (e.g. the 100%-mine brute-force on 2026-06-15). Rows with unknown/zero
# totalMines are kept — we can't judge them.
#
# TWO arms, because a bare fraction is scale-FREE and the board scale moved
# under it (2026-08-09: the tiling rotation ships configs with as few as 6
# mines, where the old flat 30% meant TWO hits, and it refused a real player who
# hit 3 on a 9-mine Kites board). Arm 1 is "far more mistakes than a bad day",
# floored because half of a 6-mine board proves nothing; arm 2 is "you excavated
# the board", and it is the arm that still bites on boards so small that the
# floor exceeds the mine count.
#
# Calibrated on every row ever submitted: worst genuine run 25% of the mines,
# the three real probing episodes 81/100/100%. Loosening from the old flat 30%
# changed ZERO verdicts across 602 per-attempt readings, so this fit is
# byte-identical to the one the old threshold produced.
BOMB_HIT_CHEAT_FRACTION    <- 0.50
BOMB_HIT_CHEAT_FLOOR       <- 10
BOMB_HIT_EXCAVATED_FRACTION <- 0.80
.n_pre_cheat <- nrow(df)
df <- df |> filter(is.na(totalMines) | totalMines <= 0 |
                   (bombHits <= pmax(BOMB_HIT_CHEAT_FLOOR,
                                     BOMB_HIT_CHEAT_FRACTION * totalMines) &
                    bombHits <  BOMB_HIT_EXCAVATED_FRACTION * totalMines))
if (.n_pre_cheat - nrow(df) > 0) {
  message(sprintf("  anti-cheat: dropped %d probing row(s) (> max(%d, %.0f%%) or >= %.0f%% of mines detonated)",
                  .n_pre_cheat - nrow(df), BOMB_HIT_CHEAT_FLOOR,
                  100 * BOMB_HIT_CHEAT_FRACTION, 100 * BOMB_HIT_EXCAVATED_FRACTION))
}

# Derived model predictors (2026-06-08 feature rework): reasoning pooled
# into pattern (canonical + generic) + search (advanced). Derived from the
# raw dailyMeta fields above, so every historical board stays usable with
# no dailyMeta migration. (Size = cellCount alone; totalMines stays raw.)
df <- df |>
  mutate(
    patternMoves = canonicalSubsetMoves + genericSubsetMoves,
    searchMoves  = advancedLogicMoves,
    # The size elasticity's predictor (M1): DERIVED from the stored cellCount,
    # never a stored feature, so every historical row carries it and
    # NEW_STRUCTURAL_FEATURES / FEATURES_EPOCH stay untouched. The pmax guard
    # mirrors the JS derivation (log(max(1, cellCount))).
    logCells     = log(pmax(1, cellCount)),
    # THE RATE FORM (2026-08-20). Every count that grows with board AREA
    # enters divided by the board, so the coefficients describe per-cell
    # difficulty, a quantity with no reason to grow with the board. Derived
    # from stored features exactly as logCells is, so no stored vector
    # changes and FEATURES_EPOCH stays put.
    mineRate     = totalMines / pmax(1, cellCount),
    patternRate  = patternMoves / pmax(1, cellCount),
    searchRate   = searchMoves / pmax(1, cellCount)
  )

# Shape-by-feature interaction columns (per-shape par equations): indicator ×
# feature, giving the joint fit one SIGNED deviation of that feature's
# log-multiplier from the square fit's per shape. Built AFTER the
# patternMoves/searchMoves derivation and the realized-wormLoad substitution,
# because the interactions must multiply exactly the columns the fit consumes.
for (.s in SHAPE_PREDICTORS) {
  for (.f in BASE_MODEL_FEATURES) {
    df[[paste0(.s, "_x_", .f)]] <- df[[.s]] * df[[.f]]
  }
}

n_scores  <- nrow(df)
n_dates   <- n_distinct(df$date)
n_players <- df |> filter(!is.na(uid), uid != "") |> pull(uid) |> n_distinct()

# Users who have played enough to be included in the fit (see
# MIN_PLAYS_FOR_FIT_INCLUSION). These are the only users whose scores
# calibrate the global PAR_MODEL and who receive a handicap entry in
# handicaps.json. Below-threshold users are left out so a single slow
# visitor can't drag the intercept.
eligible_uids <- df |>
  filter(!is.na(uid), uid != "") |>
  count(uid) |>
  filter(n >= MIN_PLAYS_FOR_FIT_INCLUSION) |>
  pull(uid)
n_eligible <- length(eligible_uids)

message(sprintf("  joined: N=%d scores, %d dates, %d players (%d eligible with >= %d plays)",
                n_scores, n_dates, n_players, n_eligible, MIN_PLAYS_FOR_FIT_INCLUSION))

current_coefs <- parse_par_model(DIFFICULTY_PATH)
new_coefs     <- current_coefs  # default: no refit, keep what's there
# Shipped per-shape deviations (PAR_MODEL_SHAPES minus PAR_MODEL) — empty
# today, since every deviation is unearned and the blocks are identical.
current_shape_devs <- parse_par_model_shapes_devs(DIFFICULTY_PATH, current_coefs)
# Scale of the CURRENTLY shipped PAR_MODEL, so the pre-fit outlier screen and
# the residual fallback back-transform it correctly across the additive->log
# transition. `new_model_is_log` tracks the scale of whatever we END UP
# shipping: TRUE once a log brms fit succeeds, else the previous model's scale.
prev_is_log      <- par_model_is_log(DIFFICULTY_PATH)
new_model_is_log <- prev_is_log

# CSci P0 #7: reject impossibly-fast rows BEFORE fitting. A single 4-sigma
# lognormal outlier (e.g. 3s on a 60s daily) drags the intercept by ~0.6s
# at N=90 — meaningful pollution. Compare against the CURRENT shipped
# PAR_MODEL (the best estimate of "what the time should have been" before
# this refit runs). Threshold: time < max(5s, 0.3 × predicted_par).
df$predicted_for_outlier <- apply_par_model(df, current_coefs, prev_is_log, current_shape_devs)
pre_outlier_n <- nrow(df)

# THE SCREEN MUST NOT FIRE ON A PREDICTION IT CANNOT MAKE (2026-08-20).
# A row is only "impossibly fast" relative to a par worth believing. Where
# the shipped model is out of its depth the floor it computes is nonsense,
# and the rows it then refuses are exactly the ones that would fix the
# pricing: measured the day the first marathon rows landed, the count-form
# model priced 638-660 cell boards at 16,000-18,000s, putting the floor near
# 5,000s, and SIX OF THE TEN honest plays (658-1,321s) were thrown out. That
# is the anti-cheat lesson of 2026-08-09 in a second gate, a filter censoring
# its own calibration set.
#
# The guard is the score validator's own ceiling rather than a new number:
# no real board is submitted above SCORE_MAX_SECONDS, so a prediction past it
# is a statement about the model, never about the row. Deliberately NOT
# widened (his standing ruling on goalposts): a believable prediction screens
# exactly as hard as it always did, and only an unbelievable one abstains.
SCORE_MAX_SECONDS <- 3600
df$screen_is_usable <- df$predicted_for_outlier <= SCORE_MAX_SECONDS
n_unpriceable <- sum(!df$screen_is_usable)
df <- df |> filter(!screen_is_usable | time >= pmax(5, 0.3 * predicted_for_outlier))
n_outliers <- pre_outlier_n - nrow(df)
if (n_unpriceable > 0) {
  message(sprintf(
    "  screen ABSTAINED on %d row(s) the shipped model prices above %ds; unusable prediction, not a verdict",
    n_unpriceable, SCORE_MAX_SECONDS))
}
if (n_outliers > 0) {
  message(sprintf("  rejected %d outlier row(s) with time < max(5, 0.3 × predicted_par)", n_outliers))
}
df$screen_is_usable <- NULL
df$predicted_for_outlier <- NULL

# Recompute n_scores after outlier rejection so downstream diagnostics
# (modelHistory.json, the threshold check against MIN_SCORES_TO_FIT) reflect
# what actually went into the fit.
n_scores <- nrow(df)
n_dates  <- length(unique(df$date))

# ── Digit-study fit frame (secondary, canonical-era) ────────────────────
# Derive the per-board digit shares and join them onto the CLEANED,
# eligible-user rows, restricted to the canonical era where the stored
# board matches its played score. This frame feeds ONLY the secondary
# digit fit (below); the primary df and its shipped coefficients never see
# these columns. Empty when the board fetch failed or no canonical-era
# eligible rows exist — the secondary fit then simply doesn't run.
digit_shares <- if (length(board_raw) > 0) {
  digit_shares_from_boards(board_raw, format(Sys.Date()))
} else {
  NULL
}
digit_df <- NULL
decor_df <- NULL
if (!is.null(digit_shares) && nrow(digit_shares) > 0) {
  # EVERY SHAPE, AND CHALLENGE MATCHES, since 2026-08-14 (his call). This frame
  # was rectangles-only and daily-only, and the two exclusions had the same
  # root: at fixed density the digit shares differ BY LATTICE (rhombille's
  # 5plus share measured 4.4x the 4.8.8's and 15x the hex's), so pooled rows
  # with nothing to separate them turn the digit coefficients into part-shape
  # indicators. The answer to a confound you can name is a term, not an
  # exclusion. The fit below carries shape and shape-by-digit deviations, plus
  # the matchPlay offset, so a lattice row informs the digit question instead of
  # contaminating it.
  #
  # The cost of the old rule was severe and worth recording: under the 50/50
  # rotation the study accrued data at half speed, and 47 of the first 48
  # Challenge boards were tilings, so the two exclusions between them refused
  # almost every board the game now produces. The frame stood at 276 rows after
  # three months.
  #
  # SHARES COME FROM THE BOARD WHERE THERE IS ONE, otherwise from the meta. The
  # board-derived values stay authoritative: they cover every canonical date
  # back to DIGIT_ERA_START, including boards written before any client could
  # compute them. A match board has no canonical, so before this the
  # inner_join dropped it whatever the filter said, and only the meta copy can
  # answer for it. Same coalesce shape the contribution frame uses.
  #
  # The rename is what keeps that safe. Both sides carry these names (the
  # client computes the same histogram now, and every dailyMeta key is
  # unnest_wider'd into df), and a plain join suffixes them to .x/.y, leaves
  # digit_df$clueShare2 NULL, makes sd(NULL) an NA, and kills the eligibility
  # `if` below, which sits OUTSIDE its tryCatch and would take the WHOLE refit
  # down rather than just this block.
  digit_df <- df |>
    filter(uid %in% eligible_uids, date >= DIGIT_ERA_START) |>
    # Behind the SAME pooling gate the main fit uses: a row the main fit is
    # still holding out has no business anchoring a secondary study.
    filter(pool_match | matchPlay == 0) |>
    rename_with(~ paste0(.x, "_dgmeta"), any_of(DIGIT_FEATURES)) |>
    left_join(digit_shares, by = "date")
  for (f in DIGIT_FEATURES) {
    mcol <- paste0(f, "_dgmeta")
    if (!f %in% colnames(digit_df)) digit_df[[f]] <- NA_real_
    if (!mcol %in% colnames(digit_df)) digit_df[[mcol]] <- NA_real_
    digit_df[[f]] <- dplyr::coalesce(as.numeric(digit_df[[f]]), as.numeric(digit_df[[mcol]]))
    digit_df[[mcol]] <- NULL
  }
  # What the inner_join used to do implicitly: a row with shares from neither
  # source cannot be studied. Explicit, so the count below is honest, and
  # checked on ALL FOUR rather than the first. The eligibility `if` below calls
  # sd() on each of them and sits OUTSIDE its tryCatch, so a single surviving
  # NA in the fourth column takes the whole refit down, not just this study.
  digit_df <- digit_df |>
    filter(if_all(all_of(DIGIT_FEATURES), ~ !is.na(.x)))

  # THE DECORRELATION LINE KEEPS THE OLD FRAME, and this split is the whole
  # reason it is a separate object. That machinery takes exactly TWO features
  # and cannot see a third axis, so it has no way to hold shape still; and it
  # selects tomorrow's DAILY board, where a Challenge row is not evidence about
  # what to schedule. Tiling days are single-candidate anyway, so a
  # decorrelation mission never runs on one.
  decor_df <- digit_df |> filter(is.na(tilingType), matchPlay == 0)

  message(sprintf("  digit frame: %d canonical-era rows, %d boards (secondary fit only), %d from Challenge matches, %d on tilings",
                  nrow(digit_df), n_distinct(digit_df$date), sum(digit_df$matchPlay),
                  sum(!is.na(digit_df$tilingType))))
  message(sprintf("  decorrelation frame: %d rows (rectangles, day-of only)", nrow(decor_df)))
}

# ── Contribution-study fit frame (secondary, canonical-era) ─────────────
# Meta-carried keys win over the backfill file (generation-time solver of
# record vs a later re-measure); rows with neither source drop. The whole
# build is failure-tolerant — a missing/malformed backfill file just means
# the study doesn't run tonight, never that the refit dies (the digit
# block's select(-any_of()) join-suffix lesson applies here too, so the
# meta copies are renamed aside before the join rather than dropped).
contrib_df <- tryCatch({
  bf <- fromJSON(CONTRIB_BACKFILL_PATH, simplifyDataFrame = TRUE)$rows
  if (!is.data.frame(bf) || nrow(bf) == 0) {
    NULL
  } else {
    bf <- bf[, c("date", intersect(CONTRIB_FEATURES, colnames(bf)))]
    # No archive replays: a replay of a known board is not a first-encounter
    # observation, and this frame has no archivePlay offset to absorb the
    # cohort's pace shift — once pool_archive flips TRUE upstream, df keeps
    # those rows and an unfiltered study would read the shift as a finding
    # arriving mid-series. (The digit frame shares this latent gap;
    # flagged 2026-07-30, fix it there when archive pooling actually opens.)
    # MATCH ROWS ARE IN (2026-08-14), behind the same pooling gate the main fit
    # uses and carrying the same matchPlay offset, added to contrib_fixed below.
    # They were excluded on the same grounds as archive replays, that this frame
    # had no offset to absorb a different cohort's pace, so pooling them would
    # read a 31% mode difference as a finding arriving mid-series. The answer to
    # a missing offset is an offset, not an exclusion: the whole point of the
    # Challenge ladder is volume for exactly these studies, and this frame is
    # 328 rows after three months.
    #
    # Until today the exclusion was moot anyway, because no library board
    # carried contribution keys at all (0 of 48 played boards, measured
    # 2026-08-14): the builder never asked for them. It does now, and
    # backfill-match-contribution.mjs measured the 2,759 already in the library,
    # so a match row arrives with a real vector rather than an absent one.
    #
    # archivePlay == 0 STAYS. Archive replays sit at 3 rows against a threshold
    # of 20, so they are still held out of the main fit, and a row the main fit
    # refuses has no business anchoring a secondary one.
    cdf <- df |> filter(uid %in% eligible_uids, date >= DIGIT_ERA_START,
                        archivePlay == 0, pool_match | matchPlay == 0)
    for (f in CONTRIB_FEATURES) {
      if (!f %in% colnames(cdf)) cdf[[f]] <- NA_real_
      if (!f %in% colnames(bf)) bf[[f]] <- NA_real_
    }
    cdf <- cdf |>
      rename_with(~ paste0(.x, "_ctmeta"), all_of(CONTRIB_FEATURES)) |>
      left_join(bf, by = "date")
    for (f in CONTRIB_FEATURES) {
      cdf[[f]] <- dplyr::coalesce(as.numeric(cdf[[paste0(f, "_ctmeta")]]),
                                  as.numeric(cdf[[f]]))
      cdf[[paste0(f, "_ctmeta")]] <- NULL
    }
    cdf <- cdf |> filter(!is.na(.data[[CONTRIB_FEATURES[1]]]))
    if (nrow(cdf) > 0) cdf else NULL
  }
}, error = function(e) {
  message("  contribution frame unavailable (", conditionMessage(e), ") — study skipped tonight")
  NULL
})
if (!is.null(contrib_df)) {
  # The match count is printed even at zero, because "no Challenge boards
  # reached this study" and "Challenge boards were never measured" looked
  # identical in this log for as long as the exclusion stood.
  message(sprintf("  contribution frame: %d canonical-era rows, %d dates (secondary fit only), %d from Challenge matches",
                  nrow(contrib_df), n_distinct(contrib_df$date), sum(contrib_df$matchPlay)))
}

handicaps        <- list()      # uid -> k (multiplicative clean-skill ratio)
handicap_details <- list()      # uid -> { k, bombSeconds } — the split the
                                # client itemizes ("Your par = Greg × k + bombs")
# NO refPar HERE ANY MORE (his ruling 2026-08-14). The seconds RATING the client
# shows is quoted against a FIXED one-minute reference par, so nothing in this
# script computes or writes one. It used to be the median day-of par, recomputed
# nightly, and the reason that was wrong is worth keeping: displaySeconds is
# (1 - k) times a constant either way, so the fitted version added no
# information the percent did not already carry, only DRIFT. The same player's
# rating moved with the board mix, the shape rotation included, on a night they
# had not played. The unit now lives once, in handicaps.js as RATING_REF_PAR.
fit_method    <- "seed-residuals"
r2            <- NA_real_
diag_note     <- ""
bomb_coef     <- NA_real_       # populated by the brms fit; NA in fallback paths
# Set TRUE if a brms fit ran but failed diagnostics (Rhat / ESS / divergent).
# After all the normal write-outs, the script exits with status 2 so the
# GitHub Actions workflow registers the run as failed and the Discord
# webhook fires. Closes the silent-degrade gap COO P0 #1 flagged.
diagnostic_failure <- FALSE

# ── 2. Fit ──────────────────────────────────────────────

fit_formula_fixed <- log(pure_time) ~
  totalMines +
  patternMoves + searchMoves +
  wallEdgeCount +
  mysteryCellCount + liarCellCount + lockedCellCount +
  wormholePairCount + mirrorPairCount +
  sonarCellCount + compassCellCount +
  zeroClusterCount
  # cellCount is GONE from this bounded formula (his M1 ruling, 2026-08-18):
  # the size pair (cellCount + logCells) is SIGNED and enters through
  # dev_cols below, because M1's linear half is negative by measurement and
  # the class-wide lb = 0 would censor it. See the SIZE_DEV_COLS block.
  # wormLoad joins conditionally below (add_worm_term): until the first
  # worm board's scores land it is identically zero in df_fit — a
  # zero-variance predictor — so it gates on real data like archivePlay.
  # Response is log(pure_time) — the multiplicative model. pure_time already
  # has ALL bomb cost removed (new base + legacy rate), so there is NO bomb
  # regressor; each player's bomb cost rides in their additive bombSeconds.

if (n_scores >= MIN_SCORES_TO_FIT && n_eligible >= 2) {
  # Bayesian mixed-effects fit on the eligible users (>=
  # MIN_PLAYS_FOR_FIT_INCLUSION plays). Partial pooling shrinks a light
  # player's random intercept toward zero and the bias-correction step
  # is play-weighted, so an included small-N user can't dominate either
  # the coefficients or the recentering — the threshold mainly keeps
  # true one-off visitors out. brms can estimate the random-intercept
  # variance even at n_eligible == 2 because the student_t prior on
  # sd(uid) gives it enough structure to separate "two players differ
  # by X" from "zero handicap variance, pure residual".
  df_fit <- df |> filter(uid %in% eligible_uids)
  # The archivePlay offset enters the fixed effects only when archive rows
  # were pooled (gate above) AND at least one survived the eligible-user
  # filter — an all-one-value column would be a zero-variance predictor brms
  # rejects. all.vars on the active formula drives both the prior list and the
  # coefficient extraction, so the term is consistently present or absent.
  add_archive_term <- pool_archive && length(unique(df_fit$archive)) > 1
  fit_formula_fixed_active <- if (add_archive_term) {
    update(fit_formula_fixed, ~ . + archivePlay)
  } else {
    fit_formula_fixed
  }
  # Challenge match frame offset, on the same two conditions archivePlay has:
  # the rows were pooled by the gate above, AND at least one survived the
  # eligible-user filter, since an all-one-value column is a zero-variance
  # predictor brms rejects. It does NOT join fit_formula_fixed_active: it is a
  # SIGNED term and belongs in the dev nlpar (see dev_cols below).
  add_match_term <- pool_match && length(unique(df_fit$matchPlay)) > 1
  # Worm Tiles (2026-07): enter the term only once real worm boards exist in
  # the fit data — same zero-variance gate as archivePlay. The shipped
  # coefficient additionally sits behind the NEW_FEATURE_DATA_THRESHOLD
  # zero-guard until 20 plays carry nonzero values.
  add_worm_term <- any(df_fit$wormLoad > 0, na.rm = TRUE)
  if (add_worm_term) {
    fit_formula_fixed_active <- update(fit_formula_fixed_active, ~ . + wormLoad)
  }
  # Board shape (per-shape par equations, 2026-08-01): the shape indicator
  # (that shape's intercept deviation — the old offset relocated) and every
  # shape-by-feature interaction enter the fit (through the dev nlpar — see
  # the path selection below) under the same
  # zero-variance gate as archivePlay and wormLoad, applied PER COLUMN. An
  # interaction of a shape is nonzero only on that shape's rows, so per-column
  # gating suffices — and with no tiling rows at all the whole layer collapses
  # to nothing and this is exactly the pre-shape fit. Gated per shape rather
  # than pooled into one "is a tiling" flag for the measured reason the old
  # offsets were: the shipped tilings behave nothing like each other (a
  # honeycomb certifies at technique level 0 on 95-99% of boards and produced
  # no tier-2 board at any density in a 1200-layout sweep, while 4.8.8 spans
  # the full range much as a rectangle does), so pooling would average
  # genuinely different worlds into one meaningless number.
  active_shape_cols <- SHAPE_DEV_NAMES[vapply(SHAPE_DEV_NAMES, function(cn)
    any(df_fit[[cn]] > 0, na.rm = TRUE), logical(1))]

  # ── Path selection: ONE boolean, chosen here where the formula is built ──
  # Both paths flow into the same downstream extraction through
  # flat_fixef/flat_ranef_uid, so the split is a formula-construction detail,
  # not two pipelines. build_priors keys the same condition off its
  # deviation_names argument (empty on path A, active_shape_cols on path B).
  #
  # Path A (no active deviation column — every night until tiling scores
  # exist): the flat formula under build_priors' class-wide lb = 0 blanket,
  # bit-identical in specification to the setup that fit this data cleanly
  # before PR #203. See build_priors for the 2026-08-01 incident that forced
  # the split.
  #
  # Path B (active deviation columns): a brms non-linear split. Bounds attach
  # per parameter class, and bf(..., nl = TRUE) gives each nlpar its own
  # class b — base keeps the bounded lognormal geometry, dev carries the
  # signed deviations unbounded. base owns the intercept and (1|uid); dev is
  # `0 +` the active columns, so the deviations stay pure interaction terms.
  #
  # NO custom init on either path: with the bound restored (flat class b on
  # path A, the base nlpar's class b on path B), Stan samples the bounded
  # block through its log transform and its default random inits are valid
  # again — the retired make_positive_init only patched initialization, never
  # the boundary geometry, which is why the 2026-08-01 run initialized fine
  # and then diverged.
  # The dev nlpar carries every SIGNED term. Shape deviations were its only
  # occupants; matchPlay joins them, and the reason is the same reason the
  # bound exists at all.
  #
  # The class-wide lb = 0 on the base block is a real modeling claim about
  # BOARD FEATURES: par is monotonic non-decreasing in every one of them, so
  # more mines cannot make a board faster and a negative slope would be
  # nonsense. matchPlay is not a board feature. It is a group indicator (1 on a
  # Challenge run's rows, 0 on a daily's), and its coefficient answers "how
  # much slower is a match board than a daily board of identical difficulty".
  # Nobody knows that sign. A match run is plausibly FASTER: the player is
  # warmed up and goes straight from one board into the next with no
  # once-a-day ritual around it.
  #
  # Under the bound it could not say so. The posterior would pile up just above
  # zero and the real speed-up would have to be absorbed elsewhere, and it
  # cannot be absorbed by the (1 | uid) intercept, because the same players
  # supply both kinds of row and a player-level intercept cannot represent a
  # WITHIN-player difference between them. It would leak into the board
  # coefficients and the residual instead, growing exactly as the mode
  # succeeds. In the dev nlpar it is unbounded and centered at zero, so the
  # data pick the sign.
  #
  # INTERACTION_PRIOR_SD is reused rather than given its own constant: at 0.5
  # on the log scale, +-1 SD spans roughly a 40% speed-up to a 65% slowdown,
  # which is wide enough for a frame offset nobody has measured and, as the
  # constant's own note says, far too wide to bind.
  #
  # The SIZE PAIR leads dev_cols unconditionally (his M1 ruling, 2026-08-18):
  # cellCount + logCells are jointly the concave size curve, the linear half
  # is negative by measurement, and neither is gated because any frame that
  # clears MIN_SCORES_TO_FIT spans many board sizes (see SIZE_DEV_COLS). This
  # makes Path B PERMANENT for the primary fit: dev_cols can no longer be
  # empty, so the flat branch below survives as the specification anchor the
  # two-path comments reason from (and the digit fit's else-branch shape),
  # not as a branch this fit can reach.
  dev_cols <- c(SIZE_DEV_COLS, active_shape_cols,
                if (add_match_term) "matchPlay" else NULL)
  use_nl_split <- length(dev_cols) > 0
  base_terms <- all.vars(fit_formula_fixed_active)[-1]
  # OLS seeds cover the BASE terms only: a deviation's prior center is fixed
  # at zero (build_priors routes deviation_names around the means lookup).
  # The size pair joins the OLS FORMULA all the same, because the intercept
  # seed must come from the M1-form fit: without any size regressor the OLS
  # intercept absorbs the mean size effect (~3 on the log scale) and centers
  # the intercept prior a full form away from the M1 posterior (~0).
  # build_priors never reads the pair's own OLS slopes: it looks up fixed
  # names only.
  ols_seeds <- compute_log_ols_seeds(df_fit, c(base_terms, SIZE_DEV_COLS))
  priors <- build_priors(ols_seeds, c("Intercept", base_terms),
                         deviation_names = dev_cols)
  fit_formula <- if (use_nl_split) {
    bf(log(pure_time) ~ base + dev,
       as.formula(paste("base ~", paste(c("1", base_terms, "(1 | uid)"),
                                        collapse = " + "))),
       as.formula(paste("dev ~ 0 +", paste(dev_cols, collapse = " + "))),
       nl = TRUE)
  } else {
    update(fit_formula_fixed_active, ~ . + (1 | uid))
  }

  message("Fitting brms model (this takes ~1-2 min on first run)…")
  fit <- brm(
    fit_formula,
    data    = df_fit,
    prior   = priors,
    chains  = N_CHAINS,
    iter    = N_ITER,
    warmup  = N_WARMUP,
    control = list(adapt_delta = ADAPT_DELTA),
    cores   = min(N_CHAINS, parallel::detectCores()),
    refresh = 0,
    seed    = 20260422
  )

  # Convergence diagnostics. Reject the fit if any Rhat > 1.05 or any ESS
  # < 400 — Stan's rule-of-thumb for "posterior summaries are trustworthy".
  # Divergent transitions are a hard-fail: they mean the posterior geometry
  # has pockets the sampler couldn't explore and the point estimates could
  # be seriously off.
  post_summary <- posterior::summarise_draws(
    as_draws_array(fit), c("mean", "rhat", "ess_bulk")
  )
  rhat_bad <- any(post_summary$rhat > 1.05, na.rm = TRUE)
  ess_bad  <- any(post_summary$ess_bulk < 400, na.rm = TRUE)
  diverge  <- sum(nuts_params(fit)$Value[nuts_params(fit)$Parameter == "divergent__"])
  total_draws <- N_CHAINS * (N_ITER - N_WARMUP)
  diverge_bad <- (diverge / total_draws) > MAX_DIVERGENT_FRAC

  diag_note <- sprintf("max Rhat = %.3f, min ESS = %.0f, divergent = %d/%d",
                       max(post_summary$rhat, na.rm = TRUE),
                       min(post_summary$ess_bulk, na.rm = TRUE),
                       diverge, total_draws)
  message("  diagnostics: ", diag_note)

  if (REFIT_SMOKE && (rhat_bad || ess_bad || diverge_bad)) {
    message("  smoke mode: toy-fit diagnostics ignored (", diag_note, "); proceeding as accepted, ",
            "because the smoke tests the machinery downstream of the fit, never the posterior.")
  }
  if (!REFIT_SMOKE && (rhat_bad || ess_bad || diverge_bad)) {
    message("Fit diagnostics failed — keeping previous PAR_MODEL and handicaps.")
    message("  Rerun scripts/fit-par-model.qmd for a closer look at why.")
    fit_method <- "seed-residuals"   # trigger residual fallback below
    diagnostic_failure <- TRUE       # surface as workflow failure at end of script
  } else {
    # fixef() on a brmsfit returns a matrix with Estimate / Est.Error / CIs;
    # Estimate = posterior mean, which is what we want as the point value.
    # flat_fixef/flat_ranef_uid are the extraction boundary — on the nl path
    # they strip the base_/dev_ prefixes back to the flat names, on the flat
    # path they are no-ops (see their definition beside build_priors).
    co <- flat_fixef(fit)[, "Estimate"]
    fit_method <- "brms-ranef"
    new_model_is_log <- TRUE   # a log fit succeeded — we ship the log model

    # Random intercepts. These are the raw posterior means from brms.
    re <- flat_ranef_uid(fit)[, , "Intercept"]
    re_values <- if (is.matrix(re)) re[, "Estimate"] else re["Estimate"]
    re_names  <- if (is.matrix(re)) rownames(re) else names(re_values)

    # Recenter the random intercepts to sum to zero, absorbing the shift
    # into the global Intercept. Without this, brms's sampler is free to
    # park the overall baseline in either the fixed Intercept or the random
    # intercepts (the two are non-identifiable up to an additive constant
    # when predictors aren't centered at zero — which ours aren't, since we
    # want the JS side to plug raw feature counts into the formula). The
    # raw posterior here handed us alpha = -84.83 with both users' random
    # intercepts around +100, which gave correct predictions internally but
    # stored a nonsense "handicap = +100s" for each player. Centering moves
    # the baseline into alpha so each handicap reads as the user's offset
    # from the population mean, which is what the rest of the app expects.
    #
    # Play-weight the centering so users with very different N aren't
    # re-centered in a way that makes a low-N user's handicap swing the
    # mean. Play counts come from the fit data.
    play_counts <- table(df_fit$uid)[re_names]
    weighted_mean_re <- sum(re_values * play_counts) / sum(play_counts)
    co["Intercept"] <- co["Intercept"] + weighted_mean_re
    re_values       <- re_values - weighted_mean_re

    # re_values are now recentered LOG offsets (Σ w·b = 0, i.e. the play-
    # weighted GEOMETRIC mean of k is 1). The multiplicative handicap is
    # k = exp(offset), defensively clamped to [HANDICAP_K_MIN, HANDICAP_K_MAX].
    k_values  <- pmin(HANDICAP_K_MAX, pmax(HANDICAP_K_MIN, exp(re_values)))
    handicaps <- setNames(as.list(round(k_values, 3)), re_names)

    # Marginal R² (fixed effects only): var(fixed predictions) / total var.
    # brms has bayes_R2() for conditional R², but the marginal definition
    # here is directly comparable to the lmer pipeline and to OLS. Note
    # that model.matrix names the intercept column "(Intercept)" whereas
    # brms names it "Intercept" — normalise before the match.
    mm <- model.matrix(fit_formula_fixed, data = df_fit)
    mm_names <- colnames(mm); mm_names[mm_names == "(Intercept)"] <- "Intercept"
    fe_pred_log <- as.numeric(mm %*% co[match(mm_names, names(co))])  # linear predictor (log scale)
    log_y <- log(df_fit$pure_time)
    r2 <- as.numeric(1 - var(log_y - fe_pred_log) / var(log_y))       # marginal R² on the log scale

    cat("\nbrms posterior means (fixed effects, post-recenter):\n")
    print(round(co, 3))
    cat(sprintf("  marginal R² ≈ %.3f, handicaps: %d users\n\n",
                r2, length(handicaps)))

    # Choose the experiment target — the coefficient with the highest
    # posterior coefficient of variation (SD / |mean|), from a whitelist
    # of features we can practically push with seed selection. cellCount is
    # excluded (load-bearing for board size, not something to inflate); these
    # names match the reworked PAR_MODEL predictors (fixef rownames).
    target_whitelist <- c(
      "patternMoves", "searchMoves",
      "totalMines", "wallEdgeCount",
      "mysteryCellCount", "liarCellCount", "lockedCellCount",
      "wormholePairCount", "mirrorPairCount",
      "sonarCellCount", "compassCellCount", "wormLoad",
      "zeroClusterCount"
    )
    fe_summary <- flat_fixef(fit)  # posterior mean + SD for every fixed effect
    # Conditional terms (wormLoad before its first board) are absent
    # from the fit — subset the whitelist to what actually has a posterior.
    target_whitelist <- intersect(target_whitelist, rownames(fe_summary))
    target_candidates <- data.frame(
      feature = target_whitelist,
      post_mean = fe_summary[target_whitelist, "Estimate"],
      post_sd   = fe_summary[target_whitelist, "Est.Error"],
      stringsAsFactors = FALSE
    )

    # ── Secondary digit fit ──────────────────────────────────────────
    # Measure the clue-digit shares in their own canonical-era fit, so the
    # primary shipped coefficients above are byte-identical with or without
    # this block. It reuses the SAME lognormal + lb=0 + OLS-seeded prior
    # machinery as the primary fit (so a digit study reads on the same
    # positive log-multiplier scale as every other study — its estimate line
    # then renders "between 0% and about X%" honestly, no negative-mean
    # wrinkle). The digit posteriors merge into target_candidates below, so
    # a digit share can become the experiment target (a journal study) and
    # appear in the parameter table, WITHOUT ever entering PAR_MODEL. Fully
    # failure-tolerant: any error or bad diagnostics simply drops the digit
    # candidates for the night and leaves the shipped pipeline untouched.
    digit_candidates <- NULL
    if (!is.null(digit_df) && nrow(digit_df) >= MIN_SCORES_TO_FIT &&
        n_distinct(digit_df$uid) >= 2 &&
        all(vapply(DIGIT_FEATURES, function(f) stats::sd(digit_df[[f]]) > 0, logical(1)))) {
      digit_candidates <- tryCatch({
        # cellCount is NOT among the bounded controls (M1): the size pair
        # rides digit_dev_cols below, signed, exactly as it does in the
        # primary fit. Measuring the digit shares against the M0 size curve
        # would leave the curvature miss in the residual this study reads.
        digit_controls <- c("totalMines", "patternMoves", "searchMoves",
                             "wallEdgeCount", "mysteryCellCount", "liarCellCount",
                             "lockedCellCount", "wormholePairCount", "mirrorPairCount",
                             "sonarCellCount", "compassCellCount", "zeroClusterCount")
        digit_fixed <- c(digit_controls, DIGIT_FEATURES)
        # SHAPE, as deviations rather than as an exclusion (2026-08-14). One
        # indicator per lattice plus one shape-by-digit interaction each, which
        # is what makes the four digit coefficients mean "at a given shape"
        # instead of quietly averaging six lattices whose share distributions
        # are known to differ. Built here rather than beside the par model's
        # SHAPE_INTERACTION_COLS because those multiply BASE_MODEL_FEATURES,
        # and a digit share is deliberately not one of those.
        for (.s in SHAPE_PREDICTORS) {
          for (.f in DIGIT_FEATURES) {
            digit_df[[paste0(.s, "_x_", .f)]] <- digit_df[[.s]] * digit_df[[.f]]
          }
        }
        digit_shape_cols <- c(SHAPE_PREDICTORS,
                              as.vector(t(outer(SHAPE_PREDICTORS, DIGIT_FEATURES,
                                                paste, sep = "_x_"))))
        # Per-column variation gate, the same one active_shape_cols applies: a
        # lattice with no rows yet contributes an all-zero column, which is not
        # estimable and would cost the whole fit rather than one term.
        #
        # NOTE, for a reader deciding whether to change it: the plain shape
        # indicators share their names with the par model's LAB-SEEDED terms, so
        # build_priors centers them on the Par Lab posteriors here too, while
        # every shape-by-digit column is unseeded and stays zero-centered. That
        # is defensible, the outcome is the same log(pure_time) and the controls
        # nearly the same set, so "hex runs faster than a rectangle" is the same
        # claim in both fits. It is also an inheritance nobody chose on purpose.
        # The alternative is a wide zero-centered prior on a nuisance parameter
        # in a secondary study. Left as the machinery does it, flagged rather
        # than special-cased.
        digit_dev_cols <- c(
          # The size pair leads, ungated, for the primary fit's reason (see
          # SIZE_DEV_COLS): its dev routing is what lets the linear half go
          # negative here too.
          SIZE_DEV_COLS,
          digit_shape_cols[vapply(digit_shape_cols,
                                  function(cn) any(digit_df[[cn]] != 0, na.rm = TRUE), logical(1))],
          if (length(unique(digit_df$matchPlay)) > 1) "matchPlay" else NULL
        )
        # The size pair joins the OLS formula for the intercept seed's sake
        # (the primary fit's reasoning at its own ols_seeds call).
        digit_seeds <- compute_log_ols_seeds(digit_df, c(digit_fixed, SIZE_DEV_COLS))
        digit_priors <- build_priors(digit_seeds, c("Intercept", digit_fixed),
                                     deviation_names = digit_dev_cols)
        # TWO PATHS, exactly as the main fit has them, and for the same reason.
        # The controls and the four shares are lognormal and bounded at zero;
        # a shape deviation and the match offset are SIGNED, and nobody knows
        # their sign in advance. Bounding them would pile the posterior at zero
        # and push the difference into the digit coefficients, which is the
        # contamination this whole change exists to stop. With no deviation
        # column active the formula is the flat one this fit has always used,
        # bit-identical in specification (see build_priors for the 2026-08-01
        # geometry incident that forced the split upstream).
        digit_formula <- if (length(digit_dev_cols) > 0) {
          bf(log(pure_time) ~ base + dev,
             as.formula(paste("base ~", paste(c("1", digit_fixed, "(1 | uid)"), collapse = " + "))),
             as.formula(paste("dev ~ 0 +", paste(digit_dev_cols, collapse = " + "))),
             nl = TRUE)
        } else {
          as.formula(paste("log(pure_time) ~",
                           paste(c(digit_fixed, "(1 | uid)"), collapse = " + ")))
        }
        message(sprintf("Fitting secondary digit model on %d canonical-era rows (%d deviation term(s): %s)…",
                        nrow(digit_df), length(digit_dev_cols),
                        if (length(digit_dev_cols)) paste(digit_dev_cols, collapse = ", ") else "none"))
        digit_fit <- brm(
          digit_formula, data = digit_df, prior = digit_priors,
          chains = N_CHAINS, iter = N_ITER, warmup = N_WARMUP,
          control = list(adapt_delta = ADAPT_DELTA),
          cores = min(N_CHAINS, parallel::detectCores()),
          refresh = 0, seed = 20260422, silent = 2
        )
        dps <- posterior::summarise_draws(as_draws_array(digit_fit), c("rhat", "ess_bulk"))
        d_diverge <- sum(nuts_params(digit_fit)$Value[nuts_params(digit_fit)$Parameter == "divergent__"])
        d_total   <- N_CHAINS * (N_ITER - N_WARMUP)
        if (any(dps$rhat > 1.05, na.rm = TRUE) || any(dps$ess_bulk < 400, na.rm = TRUE) ||
            (d_diverge / d_total) > MAX_DIVERGENT_FRAC) {
          message("  secondary digit fit failed diagnostics — digit studies skipped tonight (shipped model untouched)")
          NULL
        } else {
          # flat_fixef, NOT fixef: under the deviation path brms names the rows
          # base_clueShare2 / dev_shape488_x_clueShare2, and indexing this
          # matrix by the plain feature name would subscript out of bounds and
          # lose the whole study to the handler below. Stripping the nlpar
          # prefix is what keeps the two paths one pipeline downstream, the
          # same reason the main fit reads through it.
          dfe <- flat_fixef(digit_fit)
          # VIF of the digit block, so the collinearity the r=0.94 confound
          # warns about is on the record. Computed manually (VIF_j = 1/(1-R²_j)
          # of feature j regressed on the other fixed terms) to avoid a `car`
          # dependency the CI image doesn't carry.
          dvif <- tryCatch(
            vapply(DIGIT_FEATURES, function(f) {
              others <- setdiff(digit_fixed, f)
              r2 <- summary(lm(as.formula(paste(f, "~", paste(others, collapse = " + "))), data = digit_df))$r.squared
              if (is.finite(r2) && r2 < 1) 1 / (1 - r2) else NA_real_
            }, numeric(1)),
            error = function(e) setNames(rep(NA_real_, length(DIGIT_FEATURES)), DIGIT_FEATURES)
          )
          message(sprintf("  digit VIF: %s", paste(sprintf("%s=%.1f", DIGIT_FEATURES, dvif), collapse = ", ")))
          message(sprintf("  digit posteriors (log-mult, shape-adjusted): %s",
                          paste(sprintf("%s=%.3f±%.3f", DIGIT_FEATURES,
                                        dfe[DIGIT_FEATURES, "Estimate"], dfe[DIGIT_FEATURES, "Est.Error"]),
                                collapse = ", ")))
          # The per-shape half, reported with its OWN row count beside it. A
          # deviation fitted on four boards is a prior with a decoration, and
          # printing the estimate without the n invites reading it as a
          # finding. Log only: the digit candidates emitted below stay the four
          # pooled shares, because target_candidates drives experiment
          # targeting and the shares deliberately score 0 there.
          for (cn in digit_dev_cols) {
            if (!cn %in% rownames(dfe)) next
            message(sprintf("  digit deviation %s: %+.3f±%.3f (%d nonzero rows)",
                            cn, dfe[cn, "Estimate"], dfe[cn, "Est.Error"],
                            sum(digit_df[[cn]] != 0, na.rm = TRUE)))
          }
          data.frame(
            feature   = DIGIT_FEATURES,
            post_mean = dfe[DIGIT_FEATURES, "Estimate"],
            post_sd   = dfe[DIGIT_FEATURES, "Est.Error"],
            stringsAsFactors = FALSE
          )
        }
      }, error = function(e) {
        message("  secondary digit fit errored — digit studies skipped tonight: ", conditionMessage(e))
        NULL
      })
    } else if (!is.null(digit_df)) {
      message(sprintf("  digit studies inactive: %d canonical-era rows (< %d) or thin variance",
                      nrow(digit_df), MIN_SCORES_TO_FIT))
    }
    if (!is.null(digit_candidates)) {
      target_candidates <- rbind(target_candidates, digit_candidates)
    }

    # ── Contribution study fit (secondary; posteriors → modelHistory only,
    # NEVER target_candidates, NEVER PAR_MODEL — see CONTRIB_FEATURES) ────
    # The whole block, INCLUDING its eligibility checks, lives inside one
    # tryCatch: the digit block's eligibility `if` once sat outside its
    # tryCatch and a NULL comparison there could kill the entire nightly.
    contribution_candidates <- tryCatch({
      if (is.null(contrib_df) || nrow(contrib_df) < MIN_SCORES_TO_FIT ||
          n_distinct(contrib_df$uid) < 2) {
        message(sprintf("  contribution study inactive: %s usable rows",
                        if (is.null(contrib_df)) "no" else nrow(contrib_df)))
        NULL
      } else {
        active_contrib <- CONTRIB_FEATURES[vapply(CONTRIB_FEATURES, function(f) {
          v <- contrib_df[[f]]
          isTRUE(stats::sd(v) > 0) &&
            n_distinct(contrib_df$date[v != 0]) >= CONTRIB_MIN_NONZERO_DATES
        }, logical(1))]
        if (length(active_contrib) == 0) {
          message("  contribution study inactive: no column with real variation")
          NULL
        } else {
          # NO lockedCellCount control: the study columns lockedMineCount +
          # lockedNumberCount sum to it EXACTLY (the JS derives one from the
          # other; the partition is test-pinned), so keeping all three makes
          # the design matrix rank-deficient — the data then identifies only
          # sums and contrasts, and the individual locked posteriors written
          # to modelHistory would be prior-blend artifacts whose bands can
          # never narrow (verified: QR rank 2 of 3 on the committed backfill).
          # In this fit the SPLIT replaces the pooled count.
          # logCells sits beside cellCount (M1's concave size pair). No
          # special routing here: this fit's controls are already unbounded
          # normals, so the pair needs no dev nlpar to take its signs.
          contrib_controls <- c("cellCount", "logCells", "totalMines", "patternMoves", "searchMoves",
                                "wallEdgeCount", "mysteryCellCount", "liarCellCount",
                                "wormholePairCount", "mirrorPairCount",
                                "sonarCellCount", "compassCellCount", "zeroClusterCount")
          # The offset that lets match rows into this frame at all. Same
          # variation guard the main fit's add_match_term uses: a column that is
          # all-zero (nothing pooled yet) or all-one (a frame of nothing but
          # match rows, which the archive filter above makes unreachable today)
          # is not estimable and would abort the fit rather than inform it.
          # Without this term a Challenge run's 31% faster pace has nowhere to
          # go but the contribution posteriors, and it would land on whichever
          # modifier the library happens to favour.
          contrib_match <- if (length(unique(contrib_df$matchPlay)) > 1) "matchPlay" else NULL
          # SHAPE INDICATORS, for the reason the digit frame carries them. Match
          # rows are 96% lattice boards against 5% of dailies, so admitting them
          # without a shape term pours a large block of one lattice family into
          # a study that has no way to hold lattice still, and the contribution
          # coefficients absorb the difference. Measured on the night the rows
          # first arrived: wormholeRequired flipped -0.269 to +0.153 and
          # compassRequired tripled. matchPlay does not cover this on its own,
          # precisely BECAUSE it is near-collinear with the tiling indicator; it
          # separates mode from board, not lattice from lattice.
          #
          # Main effects only. The contribution columns are already sparse
          # enough to need CONTRIB_MIN_NONZERO_DATES, and a shape-by-
          # contribution interaction would be fitted on single figures.
          contrib_shape <- SHAPE_PREDICTORS[vapply(SHAPE_PREDICTORS, function(cn)
            cn %in% colnames(contrib_df) && any(contrib_df[[cn]] != 0, na.rm = TRUE), logical(1))]
          contrib_fixed <- c(contrib_controls, active_contrib, contrib_match, contrib_shape)
          # UNBOUNDED normal priors, deliberately NOT build_priors' lb=0
          # lognormals: a contribution effect has no a-priori sign. A
          # required gimmick plausibly costs time (+) while a big shortcut
          # plausibly refunds it — the 7-click-shortcut compass day ran
          # 0.39× par — and a zero lower bound would forbid the hypothesis
          # half this study exists to test. Study-only, so the controls
          # share the unbounded prior rather than importing the shipped
          # model's monotonicity assumption.
          contrib_priors <- c(
            set_prior("normal(0, 1)", class = "b"),
            set_prior(sprintf("normal(%f, 1.5)", log(30)), class = "Intercept"),
            set_prior("normal(0, 1)", class = "sigma"),
            set_prior("student_t(3, 0, 1)", class = "sd", group = "uid")
          )
          contrib_formula <- as.formula(paste("log(pure_time) ~",
                                              paste(c(contrib_fixed, "(1 | uid)"), collapse = " + ")))
          message(sprintf("Fitting secondary contribution model on %d canonical-era rows (%s)…",
                          nrow(contrib_df), paste(active_contrib, collapse = ", ")))
          contrib_fit <- brm(
            contrib_formula, data = contrib_df, prior = contrib_priors,
            chains = N_CHAINS, iter = N_ITER, warmup = N_WARMUP,
            control = list(adapt_delta = ADAPT_DELTA),
            cores = min(N_CHAINS, parallel::detectCores()),
            refresh = 0, seed = 20260730, silent = 2
          )
          cps <- posterior::summarise_draws(as_draws_array(contrib_fit), c("rhat", "ess_bulk"))
          c_diverge <- sum(nuts_params(contrib_fit)$Value[nuts_params(contrib_fit)$Parameter == "divergent__"])
          c_total   <- N_CHAINS * (N_ITER - N_WARMUP)
          if (any(cps$rhat > 1.05, na.rm = TRUE) || any(cps$ess_bulk < 400, na.rm = TRUE) ||
              (c_diverge / c_total) > MAX_DIVERGENT_FRAC) {
            message("  secondary contribution fit failed diagnostics — study skipped tonight")
            NULL
          } else {
            cfe <- fixef(contrib_fit)
            message(sprintf("  contribution posteriors (log scale, signed): %s",
                            paste(sprintf("%s=%.3f±%.3f", active_contrib,
                                          cfe[active_contrib, "Estimate"], cfe[active_contrib, "Est.Error"]),
                                  collapse = ", ")))
            data.frame(
              feature   = active_contrib,
              post_mean = cfe[active_contrib, "Estimate"],
              post_sd   = cfe[active_contrib, "Est.Error"],
              stringsAsFactors = FALSE
            )
          }
        }
      }
    }, error = function(e) {
      message("  secondary contribution fit errored — study skipped tonight: ", conditionMessage(e))
      NULL
    })

    target_candidates$cv <- target_candidates$post_sd / pmax(abs(target_candidates$post_mean), 0.01)
    target_candidates <- target_candidates[order(-target_candidates$cv), ]

    # Read previous target choice + recent-target memory + the revalidation
    # clock from the existing experimentTarget.json. Every daily is now an
    # improvement day, so the "no repeat within 3 days" rule is enforced
    # server-side here: we track the last 3 chosen targets and pick the
    # top-CV candidate that ISN'T in that recent list. That keeps boards
    # varied while still pushing data toward the most uncertain coefficient.
    RECENT_DAYS <- 3
    prev_experiment <- tryCatch(
      fromJSON("src/logic/experimentTarget.json", simplifyVector = FALSE),
      error = function(e) list()
    )
    prev_recent <- unlist(prev_experiment$recentTargets %||% list())
    last_reval  <- prev_experiment$lastRevalidationDate %||% NA_character_

    # ── Revalidation: is one due? ────────────────────────────────────
    # Every REVALIDATION_INTERVAL days the primary target becomes the
    # STALEST SETTLED feature (bottom half of the CV ordering, longest since
    # last targeted) instead of the top-CV feature, so a closed finding gets
    # deliberately re-checked. The cadence is anchored to lastRevalidationDate
    # (robust to missed refits); a missing anchor makes the first run due, so
    # the mechanism shows up right after deploy.
    today_str <- format(Sys.Date())
    days_since_reval <- if (is.character(last_reval) && grepl("^\\d{4}-\\d{2}-\\d{2}", last_reval)) {
      as.integer(as.Date(today_str) - as.Date(substr(last_reval, 1, 10)))
    } else NA_integer_
    reval_due <- is.na(days_since_reval) || days_since_reval >= REVALIDATION_INTERVAL

    # Each candidate's most-recent study day (last modelHistory row that
    # targeted it), for the staleness ranking. A feature never targeted has
    # no staleness — the CV path already prioritizes those; revalidation is
    # for re-testing CLOSED findings, so it considers targeted features only.
    hist_for_reval <- tryCatch(
      fromJSON("src/logic/modelHistory.json", simplifyVector = FALSE),
      error = function(e) list()
    )
    last_targeted_date <- function(feat) {
      ds <- vapply(hist_for_reval, function(r) {
        if (!is.null(r$target) && identical(as.character(r$target), feat) && is.character(r$date)) r$date else NA_character_
      }, character(1))
      ds <- ds[!is.na(ds)]
      if (length(ds) == 0) NA_character_ else max(ds)
    }

    # Settled = bottom half of the CV ordering (mirrors the journal's RESTING
    # contract). Among those, previously targeted and not recently targeted,
    # the stalest wins the revalidation slot.
    n_cand <- nrow(target_candidates)
    reval_target <- NA_character_
    reval_idle   <- NA_integer_
    settled_start <- ceiling(n_cand / 2) + 1
    if (reval_due && n_cand > 1 && settled_start <= n_cand) {
      settled <- setdiff(target_candidates$feature[settled_start:n_cand], prev_recent)
      idle <- vapply(settled, function(f) {
        lt <- last_targeted_date(f)
        if (is.na(lt)) NA_integer_ else as.integer(as.Date(today_str) - as.Date(lt))
      }, integer(1))
      idle <- idle[!is.na(idle)]
      if (length(idle) > 0) {
        idle <- sort(idle, decreasing = TRUE)
        reval_target <- names(idle)[1]
        reval_idle   <- idle[[1]]
      }
    }

    if (!is.na(reval_target)) {
      chosen_target <- reval_target
      chosen_reason <- "revalidation"
      message(sprintf("  REVALIDATION target: %s (settled, idle %d days; %d days since last revalidation)",
                      chosen_target, reval_idle,
                      ifelse(is.na(days_since_reval), -1L, days_since_reval)))
    } else {
      eligible <- target_candidates[!target_candidates$feature %in% prev_recent, ]
      chosen_target <- if (nrow(eligible) > 0) {
        eligible$feature[1]
      } else {
        # The candidate list far outnumbers RECENT_DAYS=3, so this branch
        # should never fire — defensive fallback uses the top candidate even
        # if it repeats (better to pick something than nothing).
        message("  no eligible target after applying recent-3 filter — using top candidate anyway")
        target_candidates$feature[1]
      }
      chosen_reason <- "cv"
      message(sprintf("  experiment target: %s (posterior CV = %.3f)  [excluded recent: %s]",
                      chosen_target,
                      target_candidates$cv[match(chosen_target, target_candidates$feature)],
                      if (length(prev_recent)) paste(prev_recent, collapse = ", ") else "none"))
    }
    chosen_cv <- target_candidates$cv[match(chosen_target, target_candidates$feature)]

    # Reset the revalidation clock only when a revalidation actually fired.
    # If one was due but no settled candidate qualified, leave the anchor so
    # the next run tries again (never write a literal "NA").
    new_last_reval <- if (chosen_reason == "revalidation") today_str
                      else if (is.character(last_reval) && grepl("^\\d{4}-\\d{2}-\\d{2}", last_reval)) last_reval
                      else NULL

    # Build the new recent-targets list: today's choice + previous entries,
    # dedup, trim to RECENT_DAYS. dedup is defensive; both the CV eligibility
    # filter and the revalidation recent-exclusion keep chosen_target fresh.
    new_recent <- unique(c(chosen_target, prev_recent))
    new_recent <- new_recent[seq_len(min(RECENT_DAYS, length(new_recent)))]

    # Coverage targets — the "secondary mission" half of candidate
    # selection. The current high-CV target drives slot 0 of the daily's
    # 10 candidate seeds; slots 1-9 are dedicated to filling per-gimmick
    # data gaps. Counts are taken over UNIQUE DATES (not per-play rows)
    # so a single board with many plays doesn't dominate. Deficit weight
    # is 1/(count+1), so a gimmick with 1 board scores 0.5 and one with
    # 10 boards scores 0.09 — the ranking flows from "least sampled" to
    # "most sampled". Primary target is excluded from this list since
    # it already gets slot 0 attention. Non-gimmick features (move-type
    # counts, structural) aren't included because the per-slot
    # force-injection mechanism only works on gimmicks.
    GIMMICK_FEATURES <- c(
      "mysteryCellCount", "liarCellCount", "lockedCellCount",
      "wallEdgeCount", "wormholePairCount", "mirrorPairCount",
      "sonarCellCount", "compassCellCount", "wormLoad"
    )
    coverage_features <- setdiff(GIMMICK_FEATURES, chosen_target)
    date_first <- df_fit[!duplicated(df_fit$date), , drop = FALSE]
    # Coverage throttle: a gimmick with >= COVERAGE_SATURATION_BOARDS
    # unique-date boards in the fit data has enough coverage that
    # force-injecting more of it is wasted experiment budget — drop it
    # from the coverage list so the candidate slots concentrate on the
    # genuinely undersampled features. (Saturated features still appear
    # via the primary CV target or the natural lottery.)
    COVERAGE_SATURATION_BOARDS <- 20
    coverage_targets <- lapply(coverage_features, function(f) {
      vals <- date_first[[f]]
      cnt <- if (is.null(vals)) 0L else sum(vals > 0, na.rm = TRUE)
      list(
        feature = f,
        n_boards = as.integer(cnt),
        deficit_weight = round(1 / (cnt + 1), 4)
      )
    })
    n_before_throttle <- length(coverage_targets)
    coverage_targets <- Filter(
      function(x) x$n_boards < COVERAGE_SATURATION_BOARDS,
      coverage_targets
    )
    if (length(coverage_targets) < n_before_throttle) {
      message(sprintf("  coverage throttle: dropped %d saturated gimmick(s) (>= %d boards)",
                      n_before_throttle - length(coverage_targets), COVERAGE_SATURATION_BOARDS))
    }
    # Sort descending by deficit_weight (most undersampled first).
    #
    # vapply, not sapply, and the length guard, because EVERY GIMMICK CAN BE
    # SATURATED AT ONCE and on 2026-08-14 all eight were: the match library's
    # first top-up added 11,227 boards in a night and took every modifier past
    # the 20-board line together. sapply over an empty list returns list(),
    # unary minus on a list is an error rather than an empty vector, and the
    # refit died at exactly the moment its coverage question had been fully
    # answered. An empty coverage_targets is a SUCCESS state: nothing is
    # undersampled, so the daily emits no coverage missions and its slots fall
    # through to the primary target and the lottery, which experimentDesign
    # already handles.
    if (length(coverage_targets) > 0) {
      coverage_targets <- coverage_targets[order(
        -vapply(coverage_targets, function(x) as.numeric(x$deficit_weight), numeric(1))
      )]
    }

    # Shape coverage: the coverage question again, asked about the board
    # LATTICE rather than the modifiers on it, and emitted for the Challenge
    # match's mission steering (src/logic/matchSteering.js). The daily has no
    # use for it, since its shape comes from a fixed 50/50 rotation draw that
    # nobody steers.
    #
    # DESCRIPTIVE, not prescriptive. These counts report what the fit is thin
    # on. Which of those a match can actually reach stays the client's
    # question, because only the client knows the host's unlocks, and a shape
    # the host has not unlocked can never be dealt no matter how starved it
    # is.
    #
    # `deficit_weight` is the SAME 1/(n+1) scale coverage_targets uses, and
    # deliberately so: the client ranks shape and gimmick missions against
    # each other for one steered slot, so without a shared scale it would
    # have to invent a conversion between "boards of this lattice" and
    # "boards carrying this modifier". One scale, defined once, here.
    #
    # Counted over df_fit's unique boards, the same date_first frame the
    # gimmick counts use, so both lists mean "boards the FIT has seen". Match
    # rows held out below MATCH_FIT_THRESHOLD do not count yet, which is the
    # honest reading: no coefficient has moved on them, so they have covered
    # nothing.
    #
    # Rectangles are the omitted reference in the shape layer and still get a
    # row here, because a count is a count. Their count is also what settles
    # rect at the bottom of the client's ranking without a special case
    # (hundreds of boards, so a weight near zero, so it never wins a slot).
    shape_coverage_keys <- c("rect", names(SHAPE_TABLE))
    shape_of_row <- ifelse(is.na(date_first$tilingType) | date_first$tilingType == "",
                           "rect", date_first$tilingType)
    shape_coverage <- lapply(shape_coverage_keys, function(k) {
      cnt <- sum(shape_of_row == k, na.rm = TRUE)
      list(
        shape = k,
        n_boards = as.integer(cnt),
        deficit_weight = round(1 / (cnt + 1), 4)
      )
    })
    # Same guard, same reason (see coverage_targets above): a sort over an
    # empty list must not be an error. shape_coverage cannot empty today, since
    # rect is always present and always gets a row, but the two blocks are read
    # together and one of them silently lacking the guard is how the next
    # version of this bug ships.
    if (length(shape_coverage) > 0) {
      shape_coverage <- shape_coverage[order(
        -vapply(shape_coverage, function(x) as.numeric(x$deficit_weight), numeric(1))
      )]
    }
    message(sprintf("  shape coverage: %s",
                    paste(sapply(shape_coverage, function(x)
                      sprintf("%s %d", x$shape, x$n_boards)), collapse = ", ")))
    # A lattice with fit rows that SHAPE_TABLE does not name falls into no
    # bucket, so it reports no deficit and nothing ever steers toward it.
    # test/tilingParModelContract.test.mjs pins the same class from the
    # other side; this catches a stored type the registry never grew.
    unnamed_shapes <- setdiff(unique(shape_of_row), shape_coverage_keys)
    if (length(unnamed_shapes) > 0) {
      message(sprintf("  WARNING: %d row-shape(s) absent from SHAPE_TABLE: %s",
                      length(unnamed_shapes), paste(unnamed_shapes, collapse = ", ")))
    }

    # Write experimentTarget.json. Daily clients fetch this at startup
    # and the selectDailyRngSeed helper reads `target` to bias every
    # daily toward exercising that feature. `recentTargets` is the
    # rolling memory the next refit reads to avoid same-target streaks.
    # `coverage_targets` is the ranked secondary-mission list — slots
    # 1-9 of each candidate selection cycle through it. `shape_coverage` is
    # the lattice half of the same report, read only by the Challenge
    # match's steering (the daily's shape comes from a rotation draw).
    # The `reason` field is BOTH a human note and a client signal: the
    # journal fires its revalidation story only when reason === 'revalidation'
    # exactly (planJournalScreen), so a revalidation day emits the bare tag
    # and a normal day keeps the descriptive CV sentence. lastRevalidationDate
    # is the cadence anchor the next refit reads.
    # Tonight's decorrelation mission, if any pair is confounded badly enough
    # to be worth a board. Computed from the digit fit FRAME, not the fit, so
    # it survives a night when the secondary brms fit fails diagnostics — the
    # fitted line between two columns needs no posterior. NULL on any night
    # with too few canonical-era rows or no pair past the |r| bar, and the key
    # is then dropped entirely, which the client reads as an ordinary day.
    # Is a decorrelation night due? Same anchor shape as the revalidation
    # clock above, read off the previous experiment file.
    last_decor <- prev_experiment$lastDecorrelationDate %||% NA_character_
    days_since_decor <- if (is.character(last_decor) && grepl("^\\d{4}-\\d{2}-\\d{2}", last_decor)) {
      as.integer(as.Date(today_str) - as.Date(substr(last_decor, 1, 10)))
    } else NA_integer_
    decor_due <- is.na(days_since_decor) || days_since_decor >= DECORRELATION_INTERVAL

    decor_mission <- if (!decor_due) NULL else tryCatch(
      choose_decorrelation_mission(
        # decor_df, NOT digit_df: the study frame now carries every lattice and
        # the Challenge rows, and this machinery takes exactly two features, so
        # it has no way to hold shape still. It also picks tomorrow's DAILY
        # board, which a Challenge row says nothing about.
        decor_df, DECORRELATION_FEATURES, DECORRELATION_CONFOUNDERS,
        # The coverage weights it competes against, so the emitted weight is
        # calibrated to THIS night's slate rather than a stale constant.
        vapply(coverage_targets, function(x) as.numeric(x$deficit_weight), numeric(1))
      ),
      error = function(e) {
        message("  decorrelation mission skipped: ", conditionMessage(e))
        NULL
      }
    )
    if (!is.null(decor_mission)) {
      message(sprintf(
        "  decorrelation mission: %s vs %s (R2 %.2f, n=%d, residual sd %.3f, weight %.3f; existing rows %d above / %d below 1 SD)",
        decor_mission$feature, decor_mission$confounder, decor_mission$rsq,
        decor_mission$n, decor_mission$residualSd, decor_mission$weight,
        decor_mission$n_hi, decor_mission$n_lo))
      # absR / rsq / n / the tail counts are diagnostics for that log line
      # only; the client reads just the line, its scale, and the weight, and
      # scores on the residual's MAGNITUDE so both tails compete.
      decor_mission <- decor_mission[c("feature", "confounder", "slope",
                                       "intercept", "residualSd", "weight")]
    } else if (!decor_due) {
      message(sprintf("  decorrelation mission: not due (%d of %d days since the last one)",
                      days_since_decor, DECORRELATION_INTERVAL))
    } else {
      message("  decorrelation mission: none (no pair past the confound bar)")
    }
    # Advance the clock only on a night that actually SHIPPED a mission, so a
    # night the confound bar rejected stays due tomorrow rather than burning
    # the slot.
    new_last_decor <- if (!is.null(decor_mission)) today_str
                      else if (is.character(last_decor)) last_decor else NULL

    experiment_obj <- list(
      updatedAt = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
      target    = chosen_target,
      reason    = if (chosen_reason == "revalidation") "revalidation"
                  else sprintf("highest posterior CV (%.3f) excluding last %d targets",
                               chosen_cv, RECENT_DAYS),
      lastRevalidationDate = new_last_reval,
      recentTargets = as.list(new_recent),
      candidates = lapply(seq_len(min(5, nrow(target_candidates))), function(i) {
        list(
          feature  = target_candidates$feature[i],
          mean     = round(target_candidates$post_mean[i], 3),
          sd       = round(target_candidates$post_sd[i], 3),
          cv       = round(target_candidates$cv[i], 3)
        )
      }),
      coverage_targets = coverage_targets,
      shape_coverage = shape_coverage,
      lastDecorrelationDate = new_last_decor,
      decorrelation_mission = decor_mission
    )
    # A NULL anchor (no revalidation fired AND no prior valid date) would
    # serialize as an ugly empty object — drop the key entirely instead, which
    # the reader treats as "clock not started" (first run is due).
    if (is.null(new_last_reval)) experiment_obj[["lastRevalidationDate"]] <- NULL
    # Same for a night with no decorrelation mission: absent, not empty. Both
    # the client's normalizeDecorrelationMission and the precompute's
    # loadExperimentSpec treat a missing key as an ordinary selection day.
    if (is.null(decor_mission)) experiment_obj[["decorrelation_mission"]] <- NULL
    if (is.null(new_last_decor)) experiment_obj[["lastDecorrelationDate"]] <- NULL
    writeLines(toJSON(experiment_obj, auto_unbox = TRUE, pretty = TRUE),
               "src/logic/experimentTarget.json")
  }
} else {
  message(sprintf(
    "Too few scores or eligible players to fit (N=%d, eligible players=%d; need N >= %d and >= 2 users with >= %d plays each). Seed coefficients unchanged.",
    n_scores, n_eligible, MIN_SCORES_TO_FIT, MIN_PLAYS_FOR_FIT_INCLUSION
  ))
}

# ── 3. Build new_coefs from the fit (if any) ─────────────

if (fit_method == "brms-ranef") {
  # Non-negative clamp for BASE coefficients — their lognormal priors have
  # support only above zero so this should never trigger; cheap insurance
  # against a future prior change. Shape DEVIATIONS are signed by design and
  # are handled separately below — never through nn(). The SIZE PAIR
  # (cellCount + logCells) is signed by design too: M1's linear half is
  # negative on real data, so routing it through nn() would clamp it to 0
  # and ship the log term alone, the refuted M2 form at its worst (the
  # concavity gone, every big board overpriced). sn() is its extraction.
  nn <- function(x, name) {
    v <- if (is.na(x)) 0 else as.numeric(x)
    if (v < 0) {
      message(sprintf("  clamping negative coefficient: %s = %.3f → 0", name, v))
      return(0)
    }
    v
  }
  sn <- function(x) if (is.na(x)) 0 else as.numeric(x)

  # TABLE-DRIVEN off COEF_TO_PREDICTOR, never a hand-written list. The hand
  # list this replaced was the one remaining place a coefficient could exist in
  # the formula, the priors and the extraction yet silently VANISH from every
  # emitted block, because ordered_model_fields iterates only the table's keys
  # — exactly the silent-drop class the generated emitter was built to kill.
  # Now the table IS the extraction, so a key missing from it never has a
  # posterior to lose in the first place, and adding a coefficient is one
  # table entry plus its prior. NA (a term gated out of the formula, e.g. the
  # worm term pre-first-board) maps to 0 via nn(). secPerWormLoad's posterior
  # is per REALIZED wormLoad unit (the fit's regressor); the
  # scheduled-to-realized bridge is applied below, after the realization ratio
  # is computed.
  new_coefs <- c(
    list(intercept = nn(co["Intercept"], "intercept")),
    setNames(
      lapply(names(COEF_TO_PREDICTOR), function(k) {
        p <- COEF_TO_PREDICTOR[[k]]
        if (p %in% SIZE_DEV_COLS) sn(co[p]) else nn(co[p], k)
      }),
      names(COEF_TO_PREDICTOR)
    )
  )

  # ── Shape deviations (per-shape par equations) ────────────────────────
  # `shape_dev_summary` records {mean, sd} for every deviation term that
  # actually entered the fit — the modelHistory row's `shapeDeviations` field,
  # its only longitudinal home (NEVER target_candidates: a deviation is not
  # force-injectable, and the target chooser must not see it).
  # `earned_shape_devs` is the SHIPPED subset after the same two-layer guard
  # wormLoad uses: a deviation is zeroed until its own column has
  # NEW_FEATURE_DATA_THRESHOLD nonzero fit rows, so a thin first week of
  # tiling boards ships the square's equation, never a prior-blend artifact.
  # Earned values stay on the FIT scale here (the wormLoad deviation is per
  # REALIZED unit, like the base term before its bridge); the composition
  # step below is where a wormLoad deviation gets the realization-ratio
  # bridge, so internal apply_par_model calls on fit frames stay consistent
  # with the realized wormLoad column they multiply.
  #
  # Play-weighted worm realization ratio (Σ realized / Σ scheduled over worm
  # rows) — hoisted above the bias correction because both the base
  # secPerWormLoad bridge and the composed shape blocks read it.
  worm_rows <- df_fit$wormScheduled > 0 & !is.na(df_fit$wormRealized)
  worm_realization_ratio <- if (any(worm_rows)) {
    sum(df_fit$wormRealized[worm_rows]) / max(sum(df_fit$wormScheduled[worm_rows]), 1e-9)
  } else 1

  fe_all <- flat_fixef(fit)
  shape_dev_summary <- list()
  earned_shape_devs <- list()
  for (nm in intersect(SHAPE_DEV_NAMES, rownames(fe_all))) {
    n_dev <- sum(df_fit[[nm]] != 0, na.rm = TRUE)
    # nRows rides the summary because the SHIPPED value cannot be reproduced
    # without it: a reader holding only {mean, sd} cannot tell an earned
    # posterior from one the guard below replaced with its lab center, and the
    # contract test has to be able to tell (it re-derives difficulty.js from
    # this row plus the lab file). A row that omits it predates the guard and
    # is read as unearned, which is the conservative direction.
    shape_dev_summary[[nm]] <- list(
      mean  = round(as.numeric(fe_all[nm, "Estimate"]), 4),
      sd    = round(as.numeric(fe_all[nm, "Est.Error"]), 4),
      nRows = n_dev
    )
    if (n_dev >= NEW_FEATURE_DATA_THRESHOLD) {
      earned_shape_devs[[nm]] <- as.numeric(fe_all[nm, "Estimate"])
      message(sprintf("  shape deviation %s: %+.5f (earned on %d nonzero rows)",
                      nm, earned_shape_devs[[nm]], n_dev))
    } else if (!is.null(lab_seed_devs[[nm]])) {
      # A LAB-SEEDED TERM SHIPS ITS LAB CENTER UNTIL IT EARNS ITS POSTERIOR,
      # on the same threshold every other deviation answers to.
      #
      # This branch used to ship the fitted posterior with no row guard, on
      # the reasoning that the guard exists to stop a bare prior median
      # reaching predictPar and a lab center is 86 boards of designed data,
      # so the posterior below the threshold would be the lab prior gently
      # updated by the first live rows. That holds only while the prior is
      # narrow enough to do the anchoring, and rhombille's is not: the lab
      # measured it as its noisiest shape (sd 0.181 on the totalMines
      # interaction against ~0.06 for the others), and his doubling ruling
      # widens that to 0.361. On 2026-08-13 ONE live rhombille board moved
      # both of its core deviations far enough, in cancelling directions, to
      # re-price the shape 62% cheaper. A 72-cell board fell from 110s to
      # 22s, out of the daily band and under the weekly floor, and the frozen
      # artifacts calibrated to it (band configs, spec pool, climb and match
      # libraries) all broke on the refit's own commit.
      #
      # So the guard is uniform now, and his two seeding rulings still hold
      # exactly: a lattice prices as ITSELF from the day the rotation flips
      # (ruling 1: the center ships, never parity), and live data takes over
      # at doubled width (ruling 3) once there is enough of it to be evidence
      # rather than an anecdote. The prior still does its job in the fit; it
      # is only the SHIPPED number that waits.
      earned_shape_devs[[nm]] <- lab_seed_devs[[nm]]$mean
      message(sprintf("  shape deviation %s: %+.5f (lab center; %d of %d live rows)",
                      nm, earned_shape_devs[[nm]], n_dev, NEW_FEATURE_DATA_THRESHOLD))
    } else {
      message(sprintf("  shape deviation %s: unearned (%d nonzero rows; need %d) — shipping 0",
                      nm, n_dev, NEW_FEATURE_DATA_THRESHOLD))
    }
  }
  # Lab-seeded terms with NO live rows never enter the formula at all (the
  # per-column zero-variance gate), so they cannot appear in fe_all — ship
  # their lab centers directly. This is the his-ruling half of the seeding:
  # the composed blocks price the lattices from the day the rotation flips,
  # not after each column accumulates NEW_FEATURE_DATA_THRESHOLD rows.
  for (nm in setdiff(names(lab_seed_devs), rownames(fe_all))) {
    earned_shape_devs[[nm]] <- lab_seed_devs[[nm]]$mean
  }
  if (length(lab_seed_devs) > 0) {
    message(sprintf("  lab-seeded deviations shipping on the lab center alone: %d of %d",
                    length(setdiff(names(lab_seed_devs), rownames(fe_all))),
                    length(lab_seed_devs)))
  }

  # Median calibration (log scale): set the log-intercept so the mean of
  # log(pure_time) equals the mean linear predictor across DAY-OF rows. Under a
  # symmetric-error log model that makes par = exp(Xβ) the conditional MEDIAN,
  # the time Greg beats half the runs (the "no smearing" target). pure_time
  # already has ALL bomb cost removed, so there is nothing bomb-related left to
  # net out. Archive replays (a fit-only nuisance offset) are EXCLUDED here, not
  # netted, so their replay-pace slowness can't leak into day-of par.
  bomb_coef <- LEGACY_BOMB_RATE   # shipped as secPerBombHit (fixed legacy rate)
  archive_coef <- if ("archivePlay" %in% rownames(fe_all)) {
    as.numeric(fe_all["archivePlay", "Estimate"])
  } else {
    0
  }
  match_coef <- if ("matchPlay" %in% rownames(fe_all)) {
    as.numeric(fe_all["matchPlay", "Estimate"])
  } else {
    0
  }
  # Match boards are excluded from the bias-correction set for the same reason
  # archive replays are, and the reason is the whole point of having an offset:
  # `archive == 0` alone would let a match run's pace into the anchor that sets
  # day-of par, which is the leak the exclusion above exists to stop.
  dayof <- df_fit$archive == 0 & df_fit$matchPlay == 0
  # log(apply_par_model(..., log_scale = TRUE)) recovers the linear predictor.
  # Earned deviations ride along so a tiling day-of row is calibrated on the
  # equation it will actually ship under, not the base one.
  lp_dayof <- log(apply_par_model(df_fit[dayof, , drop = FALSE], new_coefs, TRUE,
                                  earned_shape_devs))
  bias <- mean(log(df_fit$pure_time[dayof])) - mean(lp_dayof)
  new_coefs$intercept <- new_coefs$intercept + bias
  message(sprintf("  log-intercept median bias-correction: %+.3f (mean log pure-play time matches mean predicted log-par over day-of rows)",
                  bias))
  if (archive_coef != 0) {
    message(sprintf("  archivePlay coef: %+.3f log-multiplier (archive-replay offset, fit-only, not shipped)",
                    archive_coef))
  }
  if (match_coef != 0) {
    # SIGNED, so the sign is a reading rather than an artifact of a bound:
    # negative means a Challenge run is faster than a daily of the same board
    # difficulty, positive means slower.
    message(sprintf("  matchPlay coef: %+.3f log-multiplier (%.0f%% %s than a daily; Challenge-run offset, fit-only, not shipped)",
                    match_coef, abs(exp(match_coef) - 1) * 100,
                    if (match_coef < 0) "faster" else "slower"))
  }

  # Bombs are part of your HANDICAP, not par. predictPar stays clean board
  # difficulty (par = exp(Xβ)); each player's typical bomb cost rides SEPARATELY
  # as additive seconds (personalPar = par × k + bombSeconds). Per-play bomb
  # cost = the time bombs add vs clean play: the escalating base surcharge
  # (bombBaseSum) for new-mechanic plays, the fixed LEGACY_BOMB_RATE/hit for old
  # +10s/re-fog plays. The clean-skill ratio k and this bombSeconds are the two
  # halves of handicapDetails; the shipped `handicaps` map is k alone.
  df_fit$bomb_cost <- ifelse(df_fit$totalBombPenalty > 0,
                             df_fit$bombBaseSum,
                             LEGACY_BOMB_RATE * df_fit$bombHits)
  bomb_cost_by_uid <- tapply(df_fit$bomb_cost, df_fit$uid, mean)
  # handicapDetails = { k (clean-skill ratio), bombSeconds } per uid, so the
  # client can itemize "Your par = Greg × k + bombs". `handicaps[[u]]` stays k
  # (the ratio) — bombs are NOT folded into it (they are additive, not a ratio).
  for (u in names(handicaps)) {
    bc <- bomb_cost_by_uid[[u]]
    bc <- if (is.null(bc) || is.na(bc)) 0 else bc
    handicap_details[[u]] <- list(k = round(handicaps[[u]], 3), bombSeconds = round(bc, 2))
  }
  if (any(bomb_cost_by_uid > 0, na.rm = TRUE)) {
    message(sprintf("  bomb factor (additive seconds, separate from k): %s",
                    paste(sprintf("%s +%.2fs", names(bomb_cost_by_uid), bomb_cost_by_uid),
                          collapse = ", ")))
  }

  # (No reference par is computed here any more. See the note at the handicaps
  # declarations above: the client quotes its seconds rating against a fixed
  # one-minute unit, so a median day-of par would only add drift.)

  # Guard: until enough plays have NONZERO values for each new structural
  # feature, its posterior is essentially the lognormal prior expectation
  # (~prior_mean * 1.65) — and that's not a real fit, just a prior. If we
  # ship those prior-locked numbers to JS predictPar, every new board gets
  # an unjustified +40s par bump because the predictions go up but actuals
  # don't. Zero out below the data threshold so predictPar stays honest;
  # once we have real variation in the feature columns, the threshold lifts
  # and the fitted coefficients flow through. Old plays don't have these
  # fields in dailyMeta (write-once) so we can only build data forward.
  # predictPar multiplies secPerWormLoad by the board's SCHEDULED wormLoad
  # (the only value knowable pre-play), but the coefficient was fit on the
  # REALIZED dose. Bridge with the play-weighted realization ratio (computed
  # above, beside the shape-deviation guard that also reads it), so the
  # shipped term predicts the dose a typical run actually experiences. The
  # ratio defaults to 1 while no worm rows exist (the coefficient is 0 there
  # anyway via the gate + zero-guard).
  if (new_coefs$secPerWormLoad > 0) {
    message(sprintf("  secPerWormLoad: %.5g per realized unit x realization ratio %.3g -> %.5g shipped",
                    new_coefs$secPerWormLoad, worm_realization_ratio,
                    new_coefs$secPerWormLoad * worm_realization_ratio))
    new_coefs$secPerWormLoad <- new_coefs$secPerWormLoad * worm_realization_ratio
  }

  # (NEW_FEATURE_DATA_THRESHOLD is defined with the shape registry up top —
  # the per-deviation earn guard above shares it.) The per-shape data counts
  # that used to sit here as secPerShape* entries are superseded: the
  # deviation guard tracks every shape indicator and interaction separately.
  feature_data_counts <- list(
    secPerZeroCluster = sum(df_fit$zeroClusterCount > 0, na.rm = TRUE),
    secPerWormLoad    = sum(df_fit$wormLoad > 0, na.rm = TRUE)
  )
  for (coef_name in names(feature_data_counts)) {
    n_with_data <- feature_data_counts[[coef_name]]
    if (n_with_data < NEW_FEATURE_DATA_THRESHOLD) {
      new_coefs[[coef_name]] <- 0
      message(sprintf("  zeroed %s (only %d plays have data; need %d)",
                      coef_name, n_with_data, NEW_FEATURE_DATA_THRESHOLD))
    } else {
      message(sprintf("  %s: %.3f (fit on %d plays with nonzero data)",
                      coef_name, new_coefs[[coef_name]], n_with_data))
    }
  }

  # ── Compose the per-shape equations (PAR_MODEL_SHAPES) ────────────────
  # shape coefficient = final shipped base + deviation, per key. Since the
  # 2026-08-03 seeding ruling a deviation is the fitted posterior where its
  # column carries live rows and the Par Lab center where it does not, so
  # the blocks are lab-seeded rather than parity — the relationship
  # (block minus base equals the lab center for every seeded term, exactly
  # base for unseeded coefficients) is what
  # test/tilingParModelContract.test.mjs pins against the frozen JSON.
  # Composed AFTER the bias correction, the worm bridge and the
  # zero-guards, so a block is base-consistent with what actually ships in
  # PAR_MODEL.
  shape_models <- list()
  for (js_key in names(SHAPE_TABLE)) {
    stem <- SHAPE_TABLE[[js_key]]
    blk <- list(intercept = new_coefs$intercept + (earned_shape_devs[[stem]] %||% 0))
    for (k in names(COEF_TO_PREDICTOR)) {
      d <- earned_shape_devs[[paste0(stem, "_x_", COEF_TO_PREDICTOR[[k]])]] %||% 0
      # A wormLoad deviation was fit per REALIZED unit like the base term;
      # bridge it with the same realization ratio so the composed coefficient
      # predicts the scheduled dose predictPar can actually know.
      if (k == "secPerWormLoad") d <- d * worm_realization_ratio
      blk[[k]] <- (new_coefs[[k]] %||% 0) + d
    }
    shape_models[[js_key]] <- blk
  }
}

# If the fit didn't run or failed diagnostics, compute handicaps from
# residuals against the EXISTING coefficients. Only eligible users (>=
# MIN_PLAYS_FOR_FIT_INCLUSION plays) are included — same threshold the
# main fit uses, so handicaps.json has a consistent meaning regardless
# of which path wrote it. Only the clean-skill part is recentered (play-
# weighted), so seed-par bias doesn't push everyone the same way; the bomb
# factor is absolute and lifts each handicap, matching the brms path. So the
# handicap is clean offset + your typical bomb cost (it does NOT sum to zero).
if (fit_method == "seed-residuals") {
  # Fallback: no brms fit (or it failed diagnostics). Derive RATIO handicaps
  # from residuals against the CURRENTLY shipped model. apply_par_model uses the
  # shipped model's own scale (prev_is_log) to return SECONDS, so the ratio math
  # is correct whether the live PAR_MODEL is still additive or already log.
  # new_coefs is still the shipped model here, so its shipped deviations
  # (empty until a shape earns one) price any tiling row on its own equation.
  df$predicted <- apply_par_model(df, new_coefs, prev_is_log, current_shape_devs)
  # Per-play bomb cost in seconds (new base surcharge / fixed legacy rate).
  df$bomb_cost <- ifelse(df$totalBombPenalty > 0,
                         df$bombBaseSum,
                         LEGACY_BOMB_RATE * df$bombHits)
  # Clean-play log ratio vs par: log((time - bombs) / par).
  df$pure_secs <- pmax(df$time - df$bomb_cost, PURE_TIME_FLOOR)
  df$log_ratio <- log(df$pure_secs / pmax(df$predicted, PURE_TIME_FLOOR))
  per_user <- df |>
    filter(uid %in% eligible_uids) |>
    group_by(uid) |>
    summarise(n = n(), mean_log = mean(log_ratio), bomb_h = mean(bomb_cost), .groups = "drop")
  if (nrow(per_user) > 0) {
    total_plays <- sum(per_user$n)
    # Play-weighted recentering in log space (geometric-mean k = 1), matching
    # the brms path; then k = exp(recentered offset), clamped.
    wm_log <- sum(per_user$mean_log * per_user$n) / total_plays
    per_user$k <- pmin(HANDICAP_K_MAX, pmax(HANDICAP_K_MIN, exp(per_user$mean_log - wm_log)))
    for (i in seq_len(nrow(per_user))) {
      handicap_details[[per_user$uid[i]]] <- list(
        k = round(per_user$k[i], 3),
        bombSeconds = round(per_user$bomb_h[i], 2)
      )
    }
    handicaps <- setNames(as.list(round(per_user$k, 3)), per_user$uid)
    # (This fallback path once derived a refPar here too, and had to exclude
    # match boards and archive replays to keep the rating quoted against a board
    # somebody plays each morning. The fixed one-minute unit retires the
    # question: there is no anchor left for a cohort's pace to contaminate.)
  } else {
    handicaps <- list()
  }
  message(sprintf("Ratio handicaps (residuals fallback): %d users (min %d plays)",
                  length(handicaps), MIN_PLAYS_FOR_FIT_INCLUSION))
}

# ── 4. Write handicaps.json only if we produced new handicaps ────────

# If the fit didn't run AND the residuals fallback produced no entries
# (e.g. after bomb-hit filtering leaves every player below the inclusion
# threshold), do NOT overwrite the existing handicaps.json — that would
# erase yesterday's good data in exchange for today's empty fit. Only
# refresh when we actually have new handicaps to offer.
if (length(handicaps) > 0) {
  handicaps_obj <- list(
    # Format tag: the client's dual-reader treats a file WITHOUT this as the
    # legacy additive seconds format and ignores it (k=1 for everyone), so an
    # old additive file is never misread as ratios.
    format    = "logratio-v1",
    updatedAt = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
    modelFitN = n_scores,
    nPlayers  = n_players,
    method    = fit_method,
    diagnostics = if (nchar(diag_note)) diag_note else NULL,
    # No refPar. The client quotes its seconds rating against a fixed one-minute
    # unit (RATING_REF_PAR in handicaps.js) and ignores this field even when an
    # older file still carries it, so writing one would be dead weight that
    # implies the number is fitted.
    # Fixed legacy (+10s/re-fog) per-hit cost in seconds — a frozen historical
    # cohort, surfaced for transparency. NOT a predictPar coefficient.
    secPerBombHit = round(LEGACY_BOMB_RATE, 2),
    # Multiplicative clean-skill ratio per uid: k > 1 = slower than Greg, k < 1 =
    # faster. adjusted = time / k; personalPar = par × k + bombSeconds.
    handicaps = handicaps,
    # { k, bombSeconds } per uid — the split the client itemizes as
    # "Your par = Greg × k + bombs". k mirrors the handicaps map; bombSeconds is
    # the player's additive bomb cost (0 for a clean player).
    handicapDetails = if (length(handicap_details) > 0) handicap_details else NULL
  )
  writeLines(toJSON(handicaps_obj, auto_unbox = TRUE, pretty = TRUE),
             HANDICAPS_PATH)
} else {
  message("No new handicaps to write — keeping existing handicaps.json.")
}

# ── Quick-play model (PAR_MODEL_TIMED) ────────────────────────────────
# Timed rows exist only when someone WINS (a loss dies on a mine and
# never reports), so the sample is win-censored and CANNOT be pooled
# with the effectively-uncensored daily completions (Christopher,
# 2026-06-12). Quick play gets its own equation, interpreted honestly
# as "par for a WINNING run":
#   - response: handicap-adjusted winning time (time minus the player's
#     CLEAN handicap component; timed has no bombs). Rows from players
#     without a fitted handicap are excluded - their skill would leak
#     into the coefficients.
#   - outlier screen, TWO-tailed, against the daily-model prediction:
#     rows outside [0.3x, 3x] predicted are dropped. The slow tail is
#     the AFK case (a 181s beginner board with par 31s); the fast tail
#     mirrors the daily fit's impossibly-fast screen.
#   - priors centered on the CURRENT daily posterior (lognormal,
#     log(daily coef), sigma 0.7): the daily model is the best
#     available prior for what makes boards hard; timed wins pull the
#     coefficients only where they carry real signal.
#   - below TIMED_FIT_THRESHOLD usable rows, PAR_MODEL_TIMED ships as a
#     verbatim copy of PAR_MODEL (today's behavior, unchanged).
TIMED_PRIOR_SIGMA <- 0.7
timed_coefs  <- new_coefs    # default: copy of the daily model
timed_method <- "copy-of-daily"
timed_n_used <- 0
if (length(timed_raw) > 0) {
  timed_df <- tryCatch({
    tibble(entry = map(timed_raw, ~ .x)) |>
      mutate(
        time     = map_dbl(entry, ~ .x$time %||% NA_real_),
        uid      = map_chr(entry, ~ .x$uid %||% NA_character_),
        features = map(entry, ~ .x$features)
      ) |>
      filter(!is.na(time), time >= 5, time <= 3600, !map_lgl(features, is.null)) |>
      select(-entry) |>
      unnest_wider(features)
  }, error = function(e) NULL)
  if (!is.null(timed_df) && nrow(timed_df) > 0) {
    timed_needed <- c("passAMoves", "canonicalSubsetMoves", "genericSubsetMoves",
                      "advancedLogicMoves", "totalMines", "cellCount", "wallEdgeCount",
                      "mysteryCellCount", "liarCellCount", "lockedCellCount",
                      "wormholePairCount", "mirrorPairCount", "sonarCellCount",
                      "compassCellCount", "wormLoad", "zeroClusterCount")
    for (f in timed_needed) if (!f %in% colnames(timed_df)) timed_df[[f]] <- 0
    timed_df <- timed_df |>
      mutate(across(all_of(timed_needed), ~ ifelse(is.na(.x), 0, as.numeric(.x)))) |>
      mutate(
        patternMoves = canonicalSubsetMoves + genericSubsetMoves,
        searchMoves  = advancedLogicMoves
      )
    # Each player's multiplicative handicap k (clean skill). handicap_details
    # carries { k, bombSeconds }; the handicaps map is k directly.
    timed_ratio <- function(u) {
      det <- handicap_details[[u]]
      if (!is.null(det) && !is.null(det$k)) return(as.numeric(det$k))
      h <- handicaps[[u]]
      if (!is.null(h)) return(as.numeric(h))
      NA_real_
    }
    timed_df$ratioK <- vapply(timed_df$uid, timed_ratio, numeric(1))
    timed_df <- timed_df |> filter(!is.na(ratioK), ratioK > 0)
    if (nrow(timed_df) > 0) {
      # Two-tailed outlier screen vs the player's PERSONAL predicted time
      # (day-of median par × their ratio). Timed has no bombs.
      timed_df$predicted <- apply_par_model(timed_df, new_coefs, new_model_is_log) * timed_df$ratioK
      n_before <- nrow(timed_df)
      timed_df <- timed_df |>
        filter(time >= pmax(5, 0.3 * predicted), time <= 3 * predicted)
      n_outliers <- n_before - nrow(timed_df)
      if (n_outliers > 0) {
        message(sprintf("  timed: dropped %d outlier row(s) outside [0.3x, 3x] predicted (AFK / misclick screen)", n_outliers))
      }
      # Divide out the multiplicative handicap: adjTime is the ratio-normalized
      # winning time, fit on the log scale like the daily model.
      timed_df$adjTime <- timed_df$time / timed_df$ratioK
      timed_n_used <- nrow(timed_df)
    }
    if (timed_n_used >= TIMED_FIT_THRESHOLD) {
      timed_formula <- log(adjTime) ~
        cellCount + totalMines + patternMoves + searchMoves +
        wallEdgeCount + mysteryCellCount + liarCellCount + lockedCellCount +
        wormholePairCount + mirrorPairCount + sonarCellCount +
        compassCellCount + wormLoad + zeroClusterCount
      # Priors centered on the just-emitted DAILY LOG coefficients.
      daily_center <- list(
        cellCount = new_coefs$secPerCell, totalMines = new_coefs$secPerMineFlag,
        patternMoves = new_coefs$secPerPatternMove, searchMoves = new_coefs$secPerSearchMove,
        wallEdgeCount = new_coefs$secPerWallEdge, mysteryCellCount = new_coefs$secPerMysteryCell,
        liarCellCount = new_coefs$secPerLiarCell, lockedCellCount = new_coefs$secPerLockedCell,
        wormholePairCount = new_coefs$secPerWormholePair, mirrorPairCount = new_coefs$secPerMirrorPair,
        sonarCellCount = new_coefs$secPerSonarCell, compassCellCount = new_coefs$secPerCompassCell,
        wormLoad = new_coefs$secPerWormLoad,
        zeroClusterCount = new_coefs$secPerZeroCluster
      )
      timed_priors_parts <- list(set_prior("", class = "b", lb = 0))
      for (nm in names(daily_center)) {
        m_center <- max(daily_center[[nm]], PRIOR_MEAN_FLOOR)  # lognormal needs > 0
        timed_priors_parts[[length(timed_priors_parts) + 1]] <-
          set_prior(sprintf("lognormal(%f, %f)", log(m_center), TIMED_PRIOR_SIGMA),
                    class = "b", coef = nm)
      }
      timed_priors_parts[[length(timed_priors_parts) + 1]] <-
        set_prior(sprintf("normal(%f, %f)", new_coefs$intercept, PRIOR_INTERCEPT_SD), class = "Intercept")
      timed_priors_parts[[length(timed_priors_parts) + 1]] <- set_prior("normal(0, 1)", class = "sigma")
      timed_priors <- do.call(c, timed_priors_parts)
      message(sprintf("Fitting quick-play model on %d handicap-adjusted wins…", timed_n_used))
      timed_fit <- tryCatch(
        brm(timed_formula, data = timed_df, prior = timed_priors,
            chains = N_CHAINS, iter = N_ITER, warmup = N_WARMUP,
            control = list(adapt_delta = ADAPT_DELTA),
            silent = 2, refresh = 0),
        error = function(e) { message("  timed fit FAILED: ", conditionMessage(e)); NULL }
      )
      if (!is.null(timed_fit)) {
        ts <- summary(timed_fit)
        t_rhat_ok <- all(ts$fixed[, "Rhat"] < 1.05, na.rm = TRUE)
        t_ess_ok  <- all(ts$fixed[, "Bulk_ESS"] > 400, na.rm = TRUE)
        if (t_rhat_ok && t_ess_ok) {
          tco <- fixef(timed_fit)[, "Estimate"]
          # 5 decimals: log-multipliers are ~0.001-0.08, so 3 places (fine for
          # the old seconds coefficients) would lose meaningful precision here.
          tnn <- function(v, fallback) if (!is.na(v)) round(as.numeric(v), 5) else fallback
          timed_coefs <- list(
            intercept          = tnn(tco["Intercept"],         new_coefs$intercept),
            secPerCell         = tnn(tco["cellCount"],         new_coefs$secPerCell),
            secPerMineFlag     = tnn(tco["totalMines"],        new_coefs$secPerMineFlag),
            secPerPatternMove  = tnn(tco["patternMoves"],      new_coefs$secPerPatternMove),
            secPerSearchMove   = tnn(tco["searchMoves"],       new_coefs$secPerSearchMove),
            secPerWallEdge     = tnn(tco["wallEdgeCount"],     new_coefs$secPerWallEdge),
            secPerMysteryCell  = tnn(tco["mysteryCellCount"],  new_coefs$secPerMysteryCell),
            secPerLiarCell     = tnn(tco["liarCellCount"],     new_coefs$secPerLiarCell),
            secPerLockedCell   = tnn(tco["lockedCellCount"],   new_coefs$secPerLockedCell),
            secPerWormholePair = tnn(tco["wormholePairCount"], new_coefs$secPerWormholePair),
            secPerMirrorPair   = tnn(tco["mirrorPairCount"],   new_coefs$secPerMirrorPair),
            secPerSonarCell    = tnn(tco["sonarCellCount"],    new_coefs$secPerSonarCell),
            secPerCompassCell  = tnn(tco["compassCellCount"],  new_coefs$secPerCompassCell),
            secPerWormLoad     = tnn(tco["wormLoad"],          new_coefs$secPerWormLoad),
            secPerZeroCluster  = tnn(tco["zeroClusterCount"],  new_coefs$secPerZeroCluster)
          )
          timed_method <- sprintf("brms-timed (n=%d)", timed_n_used)
          message(sprintf("  quick-play model ACTIVE: %s", timed_method))
        } else {
          message("  timed fit rejected on diagnostics — keeping copy-of-daily")
        }
      }
    } else {
      message(sprintf("  quick-play model inactive: %d usable rows (< %d) — shipping copy of daily",
                      timed_n_used, TIMED_FIT_THRESHOLD))
    }
  }
}

# ── 5. Emit per-refit diagnostics row to modelHistory.json ──
#
# Backend timeline of how the model is doing over time, surfaced only in
# Chris's diagnostics modal (uid-gated client-side). One row per refit so
# the question "is RMSE shrinking? are CVs tightening? is N growing?" can
# be answered without re-pulling Firebase + git history each time. Both
# fit branches emit so a no-fit day still lands a row — gaps would
# obscure whether the pipeline failed or the model just stayed put.
{
  history_path <- "src/logic/modelHistory.json"

  if (fit_method == "brms-ranef") {
    # RMSE in SECONDS (comparable to historical rows), pure-play vs the MEDIAN
    # par. apply_par_model back-transforms the bias-corrected log coefficients;
    # df_fit$pure_time already nets out ALL bomb cost (new base + legacy), so
    # the residual is pure-play vs pure-par. NOTE: under median calibration the
    # mean residual is the expected mean−median gap (a few seconds positive) —
    # watch bias DRIFT over time, not its absolute value.
    predicted_clean   <- apply_par_model(df_fit, new_coefs, TRUE, earned_shape_devs)
    resid             <- df_fit$pure_time - predicted_clean
    cv_rows <- lapply(seq_len(nrow(target_candidates)), function(i) {
      list(
        feature = target_candidates$feature[i],
        mean    = round(target_candidates$post_mean[i], 4),
        sd      = round(target_candidates$post_sd[i], 4),
        cv      = round(target_candidates$cv[i], 4)
      )
    })
    target_field <- chosen_target
  } else {
    # Seed-residuals fallback: seconds residual (pure-play vs par) from the
    # columns the fallback set above. No new fit so no candidates posterior;
    # carry the previously-chosen experiment target forward.
    resid <- if (!is.null(df$pure_secs) && !is.null(df$predicted)) df$pure_secs - df$predicted else numeric(0)
    cv_rows <- list()
    target_field <- tryCatch({
      prev <- fromJSON("src/logic/experimentTarget.json", simplifyVector = FALSE)
      prev$target %||% NA_character_
    }, error = function(e) NA_character_)
  }

  rmse_val <- if (length(resid) > 0) sqrt(mean(resid^2, na.rm = TRUE)) else NA_real_
  bias_val <- if (length(resid) > 0) mean(resid, na.rm = TRUE) else NA_real_

  new_row <- list(
    date        = format(Sys.time(), "%Y-%m-%d", tz = "UTC"),
    updatedAt   = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
    method      = fit_method,
    n_scores    = n_scores,
    n_dates     = n_dates,
    n_players   = n_players,
    n_eligible  = n_eligible,
    rmse        = if (is.na(rmse_val)) NA_real_ else round(rmse_val, 2),
    bias        = if (is.na(bias_val)) NA_real_ else round(bias_val, 2),
    diagnostics = if (nchar(diag_note)) diag_note else NA_character_,
    target      = target_field,
    candidates  = cv_rows
  )
  # Contribution-study posteriors (signed log scale) ride the history row —
  # their only longitudinal home, since they never enter target_candidates
  # or PAR_MODEL. Additive field: every modelHistory consumer reads named
  # fields, so old rows without it and new rows with it coexist.
  if (exists("contribution_candidates") && !is.null(contribution_candidates)) {
    new_row$contribution <- lapply(seq_len(nrow(contribution_candidates)), function(i) {
      list(
        feature = contribution_candidates$feature[i],
        mean    = round(contribution_candidates$post_mean[i], 4),
        sd      = round(contribution_candidates$post_sd[i], 4)
      )
    })
  }
  # Fitted per-shape deviations (signed log scale) ride the row the same
  # additive way `contribution` does — their only longitudinal home. NEVER
  # merged into target_candidates: a deviation is not force-injectable, so a
  # mission targeting one could never win a day, and the Journal reads
  # candidates only.
  if (exists("shape_dev_summary") && length(shape_dev_summary) > 0) {
    new_row$shapeDeviations <- shape_dev_summary
  }

  history <- tryCatch(
    fromJSON(history_path, simplifyVector = FALSE),
    error = function(e) list()
  )
  # Defensive: empty-file or named-list edge case → coerce to unnamed
  # list so JSON serialises as an array rather than an object.
  if (!is.list(history) || !is.null(names(history))) history <- list()
  history[[length(history) + 1]] <- new_row

  writeLines(toJSON(history, auto_unbox = TRUE, pretty = TRUE, na = "null"),
             history_path)
  message(sprintf("Wrote modelHistory.json — %d rows total (this row: rmse=%s, bias=%s, target=%s)",
                  length(history),
                  if (is.na(rmse_val)) "NA" else sprintf("%.2fs", rmse_val),
                  if (is.na(bias_val)) "NA" else sprintf("%+.2fs", bias_val),
                  if (is.na(target_field)) "NA" else target_field))
}

# ── 6. Write the PAR_MODEL / PAR_MODEL_TIMED / PAR_MODEL_SHAPES blocks
#       (only if the fit produced new coefficients) ──

if (fit_method != "brms-ranef") {
  message("No new coefficients — difficulty.js untouched.")
  quit(status = 0)
}

r2_str <- if (is.na(r2)) "NA" else sprintf("%.3f", r2)
method_str <- sprintf("brms (%d users · %s)", length(handicaps), diag_note)

# EMITTER:START
# ---- Emitted-block generator -------------------------------------------
# ONE generator for every refit-owned block in difficulty.js. The two blocks
# used to be hand-maintained sprintf templates whose numeric slot counts and
# argument lists drifted apart twice, each drift silently shifting every later
# coefficient one slot. A generated block cannot shift a neighbor: each key
# carries its own value, and adding a coefficient is adding one entry to
# COEF_TO_PREDICTOR. The EMITTER markers on this section are load-bearing:
# the scratch parity harness behind test/tilingParModelContract.test.mjs
# extracts and evals exactly this region, so the emitter that is tested IS
# the emitter that runs.
JS_INTERCEPT_DIGITS <- 4
JS_COEF_DIGITS      <- 5   # log-multipliers run ~0.001-0.08; four places
                           # would round the smallest to one significant digit

fmt_js_number <- function(key, value) {
  digits <- if (identical(key, "intercept")) JS_INTERCEPT_DIGITS else JS_COEF_DIGITS
  formatC(as.numeric(value), format = "f", digits = digits)
}

# One `key: value,` line per entry of an ORDERED named list, preceded by the
# fixed `scale: 'log'` line predictPar branches on.
format_model_fields <- function(coefs, indent = "  ") {
  lines <- c(paste0(indent, "scale: 'log',"),
             vapply(names(coefs), function(k)
               paste0(indent, k, ": ", fmt_js_number(k, coefs[[k]]), ","),
               character(1)))
  paste(lines, collapse = "\n")
}

# A flat refit-owned block: PAR_MODEL and PAR_MODEL_TIMED.
emit_model_block <- function(const_name, header_lines, coefs) {
  paste0(
    "export const ", const_name, " = {\n",
    paste0("  // ", header_lines, collapse = "\n"), "\n",
    format_model_fields(coefs), "\n",
    "};"
  )
}

# The nested per-shape block: one full composed coefficient set per tiling,
# keyed by the exact TILING_TYPES strings ('4.8.8' needs quoting; the rest
# are valid identifiers).
emit_shape_models_block <- function(const_name, header_lines, models) {
  entries <- vapply(names(models), function(js_key) {
    key_lit <- if (grepl("^[A-Za-z_$][A-Za-z0-9_$]*$", js_key)) js_key
               else paste0("'", js_key, "'")
    paste0("  ", key_lit, ": {\n",
           format_model_fields(models[[js_key]], indent = "    "), "\n",
           "  },")
  }, character(1))
  paste0(
    "export const ", const_name, " = {\n",
    paste0("  // ", header_lines, collapse = "\n"), "\n",
    paste(entries, collapse = "\n"), "\n",
    "};"
  )
}

# Marker-bounded splice, shared by all three artifacts.
patch_js_markers <- function(src, start_marker, end_marker, block) {
  s <- str_locate(src, fixed(start_marker))
  e <- str_locate(src, fixed(end_marker))
  if (is.na(s[1, "start"]) || is.na(e[1, "end"])) {
    stop("Could not find ", start_marker, " markers in difficulty.js")
  }
  paste0(substr(src, 1, s[1, "start"] - 1),
         start_marker, "\n", block, "\n", end_marker,
         substr(src, e[1, "end"] + 1, nchar(src)))
}

# Coefficient list in EMISSION ORDER: intercept first, then
# COEF_TO_PREDICTOR's own order. The one place field order is decided.
ordered_model_fields <- function(coefs) {
  out <- list(intercept = coefs$intercept)
  for (k in names(COEF_TO_PREDICTOR)) out[[k]] <- coefs[[k]] %||% 0
  out
}
# EMITTER:END

# The two fixed doc lines every flat block carries under its header.
scale_doc <- c(
  "scale:\"log\" => par = exp(intercept + Σ coef·feature): multiplicative,",
  "lognormal MEDIAN. Coefficients are LOG-MULTIPLIERS per unit, NOT seconds."
)

daily_header <- c(
  sprintf("Last refit: %s | %s | N=%d scores, %d dates, %d players | R²=%s (log scale)",
          Sys.Date(), method_str, n_scores, n_dates, n_players, r2_str),
  scale_doc
)
block <- emit_model_block("PAR_MODEL", daily_header, ordered_model_fields(new_coefs))

src <- paste(readLines(DIFFICULTY_PATH, warn = FALSE, encoding = "UTF-8"),
             collapse = "\n")
new_src <- patch_js_markers(src, "// PAR_MODEL:START", "// PAR_MODEL:END", block)

# ---- Quick-play block (TIMED_PAR_MODEL markers) ----
# Same marker contract as PAR_MODEL. Below the activation threshold
# timed_coefs is a verbatim copy of the daily model, so the shipped block
# always exists and always parses. Quick play is rectangles-only, so there is
# no per-shape variant of this block and no shape keys in it.
timed_header <- c(
  sprintf("Last refit: %s | %s", Sys.Date(), timed_method),
  scale_doc,
  "Below the activation threshold this is a verbatim copy of the daily model."
)
timed_block <- emit_model_block("PAR_MODEL_TIMED", timed_header,
                                ordered_model_fields(timed_coefs))
new_src <- patch_js_markers(new_src, "// TIMED_PAR_MODEL:START",
                            "// TIMED_PAR_MODEL:END", timed_block)

# ---- Per-shape block (PAR_MODEL_SHAPES markers) ----
# One full composed equation per tiling (base + deviations, composed in
# section 3). The blocks are LAB-SEEDED (2026-08-03 ruling): each deviation
# is the fitted posterior where live rows exist and the Par Lab prior center
# where they do not, so a lattice prices as itself from the day the rotation
# flips. The contract test pins block minus base against the frozen JSON.
shapes_header <- c(
  sprintf("Last refit: %s | composed: PAR_MODEL base + per-shape deviations",
          Sys.Date()),
  "Deviations: the Par Lab center (scripts/data/parlab-prior-centers.json,",
  sprintf("the 2026-08-03 seeding ruling) until a term's own column carries %d",
          NEW_FEATURE_DATA_THRESHOLD),
  "nonzero fit rows (NEW_FEATURE_DATA_THRESHOLD), then its fitted posterior;",
  "0 for unseeded terms until the same threshold earns them."
)
shapes_block <- emit_shape_models_block("PAR_MODEL_SHAPES", shapes_header,
                                        lapply(shape_models, ordered_model_fields))
new_src <- patch_js_markers(new_src, "// PAR_MODEL_SHAPES:START",
                            "// PAR_MODEL_SHAPES:END", shapes_block)

if (identical(new_src, src)) {
  message("No coefficient changes — file already up to date.")
  quit(status = 0)
}

writeLines(new_src, DIFFICULTY_PATH, useBytes = TRUE)
message(sprintf("Wrote updated PAR_MODEL + PAR_MODEL_TIMED + PAR_MODEL_SHAPES to %s",
                DIFFICULTY_PATH))

# Fail the workflow loudly if the brms fit was rejected for diagnostic
# reasons. The previous PAR_MODEL stays in effect (good), but the run
# should NOT register green — that's how silent degradation creeps in.
if (diagnostic_failure) {
  message("REFIT REJECTED: brms fit failed diagnostics; previous PAR_MODEL retained.")
  quit(save = "no", status = 2)
}

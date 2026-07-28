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
# likelihood has no regularisation on the fixed effects. Priors centered on
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

DB_URL          <- "https://gregsweeper-66d02-default-rtdb.firebaseio.com"
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
ADAPT_DELTA <- 0.99   # tight step-size adaptation: coefficients near their
                      # lb = 0 boundary (cellCount ~ 0.02, etc.) create
                      # sharp curvature in the log-posterior, and looser
                      # adaptation produces a handful of divergent
                      # transitions. 0.99 is the usual fix.

# Max fraction of post-warmup draws that may diverge before we reject the
# fit. Stan's own guidance is "much less than 1%" — 0.25% is comfortably
# below that. A nonzero but small count is common near boundaries and does
# not invalidate the posterior means we care about.
MAX_DIVERGENT_FRAC <- 0.0025

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
  # is day-of par). NOTE: build_priors bounds every b-coef at lb=0, so this
  # asserts a NON-NEGATIVE offset; revisit the prior family if pooled archive
  # plays turn out systematically faster once real data lands.
  archivePlay          = 2.0,
  zeroClusterCount     = 1.0,
  # shape488 / shapeHex / shapeCairo / shapeFloret / shapeRhombille /
  # shapeDeltoidal: per-board offset for a non-rectangular tiling (Project
  # Coastline), rectangles the omitted reference. This is NOT board difficulty —
  # the reasoning tiers already measure that on any lattice, and a honeycomb's
  # near-total absence of subset/search moves shows up in those columns on its
  # own. What is left for the offset is the parse cost of an unfamiliar
  # geometry, so seed each small and let the data move it. Every shape gets the
  # SAME seed: an unfamiliarity tax has no reason to be larger for one lattice
  # than another before any of them has a completion, and seeding them apart
  # would be the prior deciding an ordering the data is meant to.
  # NOTE, same caveat as archivePlay: build_priors bounds every b-coef at
  # lb = 0, so this asserts a NON-NEGATIVE offset — "a tiling board never
  # takes LESS time than a rectangle with the same measured work". That is the
  # a-priori direction for an unfamiliarity tax, but if a shape's coefficient
  # piles up at zero once real boards land, the bound is the thing to revisit.
  shape488             = 0.05,
  shapeHex             = 0.05,
  shapeCairo           = 0.05,
  shapeFloret          = 0.05,
  shapeRhombille       = 0.05,
  shapeDeltoidal       = 0.05
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
  cellCount            = 1.0,
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
  zeroClusterCount     = 1.0,
  # Board-shape offsets — wide, so the tiling boards (not the prior) decide.
  # build_priors stop()s on a missing sigma, so a shape name that reaches the
  # formula without an entry here aborts the WHOLE nightly refit rather than
  # dropping its own term.
  shape488             = 1.0,
  shapeHex             = 1.0,
  shapeCairo           = 1.0,
  shapeFloret          = 1.0,
  shapeRhombille       = 1.0,
  shapeDeltoidal       = 1.0,
  # Digit shares — wide, so the canonical-era data (not the prior) decides.
  # Used only in the secondary digit fit; never shipped to predictPar.
  clueShare2           = 1.0,
  clueShare3           = 1.0,
  clueShare4           = 1.0,
  clueShare5plus       = 1.0
)

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
apply_par_model <- function(df, coefs, log_scale = TRUE) {
  # Board-shape indicators (Project Coastline). Defaulted HERE rather than
  # relied upon from the caller because `with(df, ...)` errors on a missing
  # column — this function runs against several frames (df, df_fit, timed_df,
  # the residual fallback), and a rectangles-only frame legitimately has no
  # shape column at all. Same defensive shape as the `timed_needed` loop.
  for (.f in c("shape488", "shapeHex", "shapeCairo", "shapeFloret",
               "shapeRhombille", "shapeDeltoidal")) {
    if (!.f %in% colnames(df)) df[[.f]] <- 0
    df[[.f]] <- ifelse(is.na(df[[.f]]), 0, as.numeric(df[[.f]]))
  }
  lp <- with(df,
    coefs$intercept +
    coefs$secPerCell                 * cellCount +
    coefs$secPerMineFlag             * totalMines +
    (coefs$secPerPatternMove %||% 0)  * patternMoves +
    (coefs$secPerSearchMove  %||% 0)  * searchMoves +
    coefs$secPerWallEdge             * wallEdgeCount +
    coefs$secPerMysteryCell          * mysteryCellCount +
    coefs$secPerLiarCell             * liarCellCount +
    coefs$secPerLockedCell           * lockedCellCount +
    coefs$secPerWormholePair         * wormholePairCount +
    coefs$secPerMirrorPair           * mirrorPairCount +
    coefs$secPerSonarCell            * sonarCellCount +
    coefs$secPerCompassCell          * compassCellCount +
    (coefs$secPerWormLoad    %||% 0) * wormLoad +
    (coefs$secPerZeroCluster %||% 0) * zeroClusterCount +
    # Board-shape offsets. The coefficient is `%||% 0` so this stays correct
    # against a shipped PAR_MODEL block predating Coastline; the columns are
    # guaranteed present by the defaulting loop above. Mirrors predictPar's
    # COEF_TERMS, which reads `f.tilingType` and contributes 0 on a rectangle.
    (coefs$secPerShape488       %||% 0) * shape488 +
    (coefs$secPerShapeHex       %||% 0) * shapeHex +
    (coefs$secPerShapeCairo     %||% 0) * shapeCairo +
    (coefs$secPerShapeFloret    %||% 0) * shapeFloret +
    (coefs$secPerShapeRhombille %||% 0) * shapeRhombille +
    (coefs$secPerShapeDeltoidal %||% 0) * shapeDeltoidal
  )
  if (log_scale) exp(lp) else lp
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

# Build the brms prior list. Per-coefficient priors are lognormal (positive,
# median = the OLS-seeded log-multiplier) — this does the regularisation. The
# Intercept gets a plain normal. Residual and handicap SD priors are on the LOG
# scale (times are lognormal), NOT the old seconds scale.
build_priors <- function(means, fixed_names) {
  parts <- list()
  # Class-wide lower bound: log-multiplier slopes are non-negative (par is
  # monotonic non-decreasing in every feature) and lognormal requires
  # positivity. brms can't combine `coef` with `lb`, so the bound rides a
  # class-wide placeholder and the distributions come through per-coef priors.
  parts[[length(parts) + 1]] <- set_prior("", class = "b", lb = 0)

  for (nm in fixed_names) {
    m <- means[[nm]]
    if (is.null(m)) stop("Missing prior mean for ", nm)
    if (nm == "Intercept") {
      parts[[length(parts) + 1]] <- set_prior(
        sprintf("normal(%f, %f)", m, PRIOR_INTERCEPT_SD),
        class = "Intercept"
      )
    } else {
      sig <- PRIOR_SIGMAS[[nm]]
      if (is.null(sig)) stop("Missing prior sigma for ", nm)
      parts[[length(parts) + 1]] <- set_prior(
        sprintf("lognormal(%f, %f)", log(max(m, PRIOR_MEAN_FLOOR)), sig),
        class = "b", coef = nm
      )
    }
  }
  # Residual SD on the LOG scale (completion-time log-residuals are O(0.1-0.5)).
  parts[[length(parts) + 1]] <- set_prior("normal(0, 1)", class = "sigma")
  # Between-user SD on the LOG scale — weakly informative for a log-scale
  # variance component (real users' k spread sits well within the [0.5, 2] clamp).
  parts[[length(parts) + 1]] <- set_prior(
    "student_t(3, 0, 1)", class = "sd", group = "uid"
  )
  do.call(c, parts)
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
# reference, exactly as COEF_TERMS does on the client. Another tiling adds one
# line on each side.
if (!"tilingType" %in% colnames(df)) df$tilingType <- NA_character_
df$tilingType <- as.character(df$tilingType)
df$shape488       <- as.numeric(!is.na(df$tilingType) & df$tilingType == "4.8.8")
df$shapeHex       <- as.numeric(!is.na(df$tilingType) & df$tilingType == "hex")
df$shapeCairo     <- as.numeric(!is.na(df$tilingType) & df$tilingType == "cairo")
df$shapeFloret    <- as.numeric(!is.na(df$tilingType) & df$tilingType == "floret")
df$shapeRhombille <- as.numeric(!is.na(df$tilingType) & df$tilingType == "rhombille")
df$shapeDeltoidal <- as.numeric(!is.na(df$tilingType) & df$tilingType == "deltoidal")
# One count per shape, built as name/value pairs rather than a hand-kept
# sprintf: this message grew its own slot/arg count alongside the PAR_MODEL
# template's, and a message whose format string and argument list drift apart
# either errors or prints the wrong shape's total.
message(sprintf("  tiling rows: %s of %d total",
                paste(sprintf("%d (%s)",
                              c(sum(df$shape488), sum(df$shapeHex), sum(df$shapeCairo),
                                sum(df$shapeFloret), sum(df$shapeRhombille),
                                sum(df$shapeDeltoidal)),
                              c("4.8.8", "hex", "cairo", "floret", "rhombille", "deltoidal")),
                      collapse = " + "),
                nrow(df)))

# Anti-cheat (mirrors isBombHitCheat in difficulty.js): a run that detonated
# more than BOMB_HIT_CHEAT_FRACTION of the board's mines was brute-forcing /
# probing the layout, not solving it — its time is a garbage data point (tiny
# wall-clock + every mine's info-value) no matter how it is priced, so it must
# never anchor the model. The client now blocks these at submission; this drops
# the historical ones (e.g. the 100%-mine brute-force on 2026-06-15). Rows with
# unknown/zero totalMines are kept — we can't judge them.
BOMB_HIT_CHEAT_FRACTION <- 0.30
.n_pre_cheat <- nrow(df)
df <- df |> filter(is.na(totalMines) | totalMines <= 0 |
                   bombHits <= BOMB_HIT_CHEAT_FRACTION * totalMines)
if (.n_pre_cheat - nrow(df) > 0) {
  message(sprintf("  anti-cheat: dropped %d brute-force row(s) (> %.0f%% of mines detonated)",
                  .n_pre_cheat - nrow(df), 100 * BOMB_HIT_CHEAT_FRACTION))
}

# Derived model predictors (2026-06-08 feature rework): reasoning pooled
# into pattern (canonical + generic) + search (advanced). Derived from the
# raw dailyMeta fields above, so every historical board stays usable with
# no dailyMeta migration. (Size = cellCount alone; totalMines stays raw.)
df <- df |>
  mutate(
    patternMoves = canonicalSubsetMoves + genericSubsetMoves,
    searchMoves  = advancedLogicMoves
  )

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
df$predicted_for_outlier <- apply_par_model(df, current_coefs, prev_is_log)
pre_outlier_n <- nrow(df)
df <- df |> filter(time >= pmax(5, 0.3 * predicted_for_outlier))
n_outliers <- pre_outlier_n - nrow(df)
if (n_outliers > 0) {
  message(sprintf("  rejected %d outlier row(s) with time < max(5, 0.3 × predicted_par)", n_outliers))
}
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
if (!is.null(digit_shares) && nrow(digit_shares) > 0) {
  digit_df <- df |>
    filter(uid %in% eligible_uids, date >= DIGIT_ERA_START) |>
    # Drop any meta-carried copies of the shares BEFORE the join. The client
    # computes the same histogram now (dailyFeatures.clueShares, ported so the
    # decorrelation mission can score a candidate board), and every feature key
    # in dailyMeta is unnest_wider'd into df. Without this the join finds the
    # names on both sides, dplyr suffixes them to .x/.y, digit_df$clueShare2
    # becomes NULL, sd(NULL) is NA, and the eligibility `if` below — which sits
    # OUTSIDE its tryCatch — dies on "missing value where TRUE/FALSE needed",
    # taking the WHOLE refit down rather than just the digit block. The
    # BOARD-derived shares are authoritative regardless: they cover every
    # canonical date back to DIGIT_ERA_START, including boards written before
    # any client could compute them.
    select(-any_of(DIGIT_FEATURES)) |>
    inner_join(digit_shares, by = "date")
  message(sprintf("  digit frame: %d canonical-era rows, %d dates (secondary fit only)",
                  nrow(digit_df), n_distinct(digit_df$date)))
}

handicaps        <- list()      # uid -> k (multiplicative clean-skill ratio)
handicap_details <- list()      # uid -> { k, bombSeconds } — the split the
                                # client itemizes ("Your par = Greg × k + bombs")
refPar           <- 60          # reference board par (seconds) for the seconds
                                # display of a ratio; both fit paths overwrite
                                # it from real data (median day-of par).
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
  cellCount + totalMines +
  patternMoves + searchMoves +
  wallEdgeCount +
  mysteryCellCount + liarCellCount + lockedCellCount +
  wormholePairCount + mirrorPairCount +
  sonarCellCount + compassCellCount +
  zeroClusterCount
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
  # Worm Tiles (2026-07): enter the term only once real worm boards exist in
  # the fit data — same zero-variance gate as archivePlay. The shipped
  # coefficient additionally sits behind the NEW_FEATURE_DATA_THRESHOLD
  # zero-guard until 20 plays carry nonzero values.
  add_worm_term <- any(df_fit$wormLoad > 0, na.rm = TRUE)
  if (add_worm_term) {
    fit_formula_fixed_active <- update(fit_formula_fixed_active, ~ . + wormLoad)
  }
  # Board shape (Project Coastline): one offset per tiling, entering the fixed
  # effects only once that shape has rows in the fit data — the same
  # zero-variance gate as archivePlay and wormLoad. Gated PER SHAPE rather than
  # as one "is a tiling" flag on purpose: the shipped tilings behave nothing
  # like each other (a honeycomb certifies at technique level 0 on 95-99% of
  # boards and produced no tier-2 board at any density in a 1200-layout sweep,
  # while 4.8.8 spans the full range much as a rectangle does), so pooling them
  # would average genuinely different worlds into one meaningless number, and
  # whichever shape shipped first would set it. That argument only gets stronger
  # with six shapes whose interior valences run from 6 to 10.
  add_shape488_term       <- any(df_fit$shape488 > 0, na.rm = TRUE)
  add_shapeHex_term       <- any(df_fit$shapeHex > 0, na.rm = TRUE)
  add_shapeCairo_term     <- any(df_fit$shapeCairo > 0, na.rm = TRUE)
  add_shapeFloret_term    <- any(df_fit$shapeFloret > 0, na.rm = TRUE)
  add_shapeRhombille_term <- any(df_fit$shapeRhombille > 0, na.rm = TRUE)
  add_shapeDeltoidal_term <- any(df_fit$shapeDeltoidal > 0, na.rm = TRUE)
  if (add_shape488_term) {
    fit_formula_fixed_active <- update(fit_formula_fixed_active, ~ . + shape488)
  }
  if (add_shapeHex_term) {
    fit_formula_fixed_active <- update(fit_formula_fixed_active, ~ . + shapeHex)
  }
  if (add_shapeCairo_term) {
    fit_formula_fixed_active <- update(fit_formula_fixed_active, ~ . + shapeCairo)
  }
  if (add_shapeFloret_term) {
    fit_formula_fixed_active <- update(fit_formula_fixed_active, ~ . + shapeFloret)
  }
  if (add_shapeRhombille_term) {
    fit_formula_fixed_active <- update(fit_formula_fixed_active, ~ . + shapeRhombille)
  }
  if (add_shapeDeltoidal_term) {
    fit_formula_fixed_active <- update(fit_formula_fixed_active, ~ . + shapeDeltoidal)
  }
  fit_formula <- update(fit_formula_fixed_active, ~ . + (1 | uid))

  ols_seeds <- compute_log_ols_seeds(df_fit, all.vars(fit_formula_fixed_active)[-1])
  priors <- build_priors(ols_seeds, c("Intercept", all.vars(fit_formula_fixed_active)[-1]))

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

  if (rhat_bad || ess_bad || diverge_bad) {
    message("Fit diagnostics failed — keeping previous PAR_MODEL and handicaps.")
    message("  Rerun scripts/fit-par-model.qmd for a closer look at why.")
    fit_method <- "seed-residuals"   # trigger residual fallback below
    diagnostic_failure <- TRUE       # surface as workflow failure at end of script
  } else {
    # fixef() on a brmsfit returns a matrix with Estimate / Est.Error / CIs.
    # Estimate = posterior mean, which is what we want as the point value.
    co <- fixef(fit)[, "Estimate"]
    fit_method <- "brms-ranef"
    new_model_is_log <- TRUE   # a log fit succeeded — we ship the log model

    # Random intercepts. These are the raw posterior means from brms.
    re <- ranef(fit)$uid[, , "Intercept"]
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
    fe_summary <- fixef(fit)  # posterior mean + SD for every fixed effect
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
        digit_controls <- c("cellCount", "totalMines", "patternMoves", "searchMoves",
                             "wallEdgeCount", "mysteryCellCount", "liarCellCount",
                             "lockedCellCount", "wormholePairCount", "mirrorPairCount",
                             "sonarCellCount", "compassCellCount", "zeroClusterCount")
        digit_fixed <- c(digit_controls, DIGIT_FEATURES)
        digit_seeds <- compute_log_ols_seeds(digit_df, digit_fixed)
        digit_priors <- build_priors(digit_seeds, c("Intercept", digit_fixed))
        digit_formula <- as.formula(paste("log(pure_time) ~",
                                          paste(c(digit_fixed, "(1 | uid)"), collapse = " + ")))
        message(sprintf("Fitting secondary digit model on %d canonical-era rows…", nrow(digit_df)))
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
          dfe <- fixef(digit_fit)
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
          message(sprintf("  digit posteriors (log-mult): %s",
                          paste(sprintf("%s=%.3f±%.3f", DIGIT_FEATURES,
                                        dfe[DIGIT_FEATURES, "Estimate"], dfe[DIGIT_FEATURES, "Est.Error"]),
                                collapse = ", ")))
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
    coverage_targets <- coverage_targets[order(
      -sapply(coverage_targets, function(x) x$deficit_weight)
    )]

    # Write experimentTarget.json. Daily clients fetch this at startup
    # and the selectDailyRngSeed helper reads `target` to bias every
    # daily toward exercising that feature. `recentTargets` is the
    # rolling memory the next refit reads to avoid same-target streaks.
    # `coverage_targets` is the ranked secondary-mission list — slots
    # 1-9 of each candidate selection cycle through it.
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
        digit_df, DECORRELATION_FEATURES, DECORRELATION_CONFOUNDERS,
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
  # Non-negative clamp — our priors are truncated at 0 so this should never
  # trigger, but cheap insurance against a future prior change.
  nn <- function(x, name) {
    v <- if (is.na(x)) 0 else as.numeric(x)
    if (v < 0) {
      message(sprintf("  clamping negative coefficient: %s = %.3f → 0", name, v))
      return(0)
    }
    v
  }

  new_coefs <- list(
    intercept          = nn(co["Intercept"],         "intercept"),
    secPerCell         = nn(co["cellCount"],         "cell"),
    secPerMineFlag     = nn(co["totalMines"],        "mineFlag"),
    secPerPatternMove  = nn(co["patternMoves"],      "patternMove"),
    secPerSearchMove   = nn(co["searchMoves"],       "searchMove"),
    secPerWallEdge     = nn(co["wallEdgeCount"],     "wallEdge"),
    secPerMysteryCell  = nn(co["mysteryCellCount"],  "mysteryCell"),
    secPerLiarCell     = nn(co["liarCellCount"],     "liarCell"),
    secPerLockedCell   = nn(co["lockedCellCount"],   "lockedCell"),
    secPerWormholePair = nn(co["wormholePairCount"], "wormholePair"),
    secPerMirrorPair   = nn(co["mirrorPairCount"],   "mirrorPair"),
    secPerSonarCell    = nn(co["sonarCellCount"],    "sonarCell"),
    secPerCompassCell  = nn(co["compassCellCount"],  "compassCell"),
    # NA (worm term gated out pre-first-board) maps to 0 via nn(). The
    # posterior coefficient is per REALIZED wormLoad unit (the fit's
    # regressor); the scheduled-to-realized bridge is applied below, after
    # the realization ratio is computed.
    secPerWormLoad     = nn(co["wormLoad"],          "wormLoad"),
    secPerZeroCluster  = nn(co["zeroClusterCount"],  "zeroCluster"),
    # NA (shape term gated out because that tiling has no rows yet) maps to 0
    # via nn(), so a rectangles-only fit emits an explicit 0.00000 and par is
    # unchanged on every board shipped to date.
    secPerShape488       = nn(co["shape488"],       "shape488"),
    secPerShapeHex       = nn(co["shapeHex"],       "shapeHex"),
    secPerShapeCairo     = nn(co["shapeCairo"],     "shapeCairo"),
    secPerShapeFloret    = nn(co["shapeFloret"],    "shapeFloret"),
    secPerShapeRhombille = nn(co["shapeRhombille"], "shapeRhombille"),
    secPerShapeDeltoidal = nn(co["shapeDeltoidal"], "shapeDeltoidal")
  )

  # Median calibration (log scale): set the log-intercept so the mean of
  # log(pure_time) equals the mean linear predictor across DAY-OF rows. Under a
  # symmetric-error log model that makes par = exp(Xβ) the conditional MEDIAN,
  # the time Greg beats half the runs (the "no smearing" target). pure_time
  # already has ALL bomb cost removed, so there is nothing bomb-related left to
  # net out. Archive replays (a fit-only nuisance offset) are EXCLUDED here, not
  # netted, so their replay-pace slowness can't leak into day-of par.
  bomb_coef <- LEGACY_BOMB_RATE   # shipped as secPerBombHit (fixed legacy rate)
  archive_coef <- if ("archivePlay" %in% rownames(fixef(fit))) {
    as.numeric(fixef(fit)["archivePlay", "Estimate"])
  } else {
    0
  }
  dayof <- df_fit$archive == 0
  # log(apply_par_model(..., log_scale = TRUE)) recovers the linear predictor.
  lp_dayof <- log(apply_par_model(df_fit[dayof, , drop = FALSE], new_coefs, TRUE))
  bias <- mean(log(df_fit$pure_time[dayof])) - mean(lp_dayof)
  new_coefs$intercept <- new_coefs$intercept + bias
  message(sprintf("  log-intercept median bias-correction: %+.3f (mean log pure-play time matches mean predicted log-par over day-of rows)",
                  bias))
  if (archive_coef != 0) {
    message(sprintf("  archivePlay coef: %+.3f log-multiplier (archive-replay offset, fit-only, not shipped)",
                    archive_coef))
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

  # Reference par for the client's seconds display of a ratio: (k-1) × refPar.
  # The median predicted par over day-of boards — a stable "typical board" so
  # the handicap chip reads in comparable seconds across dates.
  refPar <- round(median(apply_par_model(df_fit[dayof, , drop = FALSE], new_coefs, TRUE)), 1)

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
  # REALIZED dose. Bridge with the play-weighted realization ratio
  # (Σ realized / Σ scheduled over worm rows), so the shipped term predicts
  # the dose a typical run actually experiences. Both factors are printed;
  # the ratio defaults to 1 while no worm rows exist (the coefficient is 0
  # there anyway via the gate + zero-guard).
  worm_rows <- df_fit$wormScheduled > 0 & !is.na(df_fit$wormRealized)
  worm_realization_ratio <- if (any(worm_rows)) {
    sum(df_fit$wormRealized[worm_rows]) / max(sum(df_fit$wormScheduled[worm_rows]), 1e-9)
  } else 1
  if (new_coefs$secPerWormLoad > 0) {
    message(sprintf("  secPerWormLoad: %.5f per realized unit x realization ratio %.3f -> %.5f shipped",
                    new_coefs$secPerWormLoad, worm_realization_ratio,
                    new_coefs$secPerWormLoad * worm_realization_ratio))
    new_coefs$secPerWormLoad <- new_coefs$secPerWormLoad * worm_realization_ratio
  }

  NEW_FEATURE_DATA_THRESHOLD <- 20
  feature_data_counts <- list(
    secPerZeroCluster = sum(df_fit$zeroClusterCount > 0, na.rm = TRUE),
    secPerWormLoad    = sum(df_fit$wormLoad > 0, na.rm = TRUE),
    # A board-shape offset ships only once that tiling has real completions
    # behind it. Until then predictPar prices a tiling board on the shared
    # coefficients alone, which is the design's own null hypothesis (the par
    # model is geometry-blind the way the solver turned out to be) rather than
    # a placeholder — so the zero here is a claim we are content to ship.
    secPerShape488       = sum(df_fit$shape488 > 0, na.rm = TRUE),
    secPerShapeHex       = sum(df_fit$shapeHex > 0, na.rm = TRUE),
    secPerShapeCairo     = sum(df_fit$shapeCairo > 0, na.rm = TRUE),
    secPerShapeFloret    = sum(df_fit$shapeFloret > 0, na.rm = TRUE),
    secPerShapeRhombille = sum(df_fit$shapeRhombille > 0, na.rm = TRUE),
    secPerShapeDeltoidal = sum(df_fit$shapeDeltoidal > 0, na.rm = TRUE)
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
  df$predicted <- apply_par_model(df, new_coefs, prev_is_log)
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
    dayof_pred <- df$predicted[df$archive == 0]
    if (length(dayof_pred) > 0) refPar <- round(median(dayof_pred, na.rm = TRUE), 1)
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
    # Reference board par (seconds) for the client's seconds display of a ratio:
    # displaySeconds = (k - 1) × refPar. Median day-of par from this fit.
    refPar    = refPar,
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
    predicted_clean   <- apply_par_model(df_fit, new_coefs, TRUE)
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

# ── 6. Write updated PAR_MODEL block (only if fit produced new coefs) ──

if (fit_method != "brms-ranef") {
  message("No new coefficients — difficulty.js untouched.")
  quit(status = 0)
}

r2_str <- if (is.na(r2)) "NA" else sprintf("%.3f", r2)
method_str <- sprintf("brms (%d users · %s)", length(handicaps), diag_note)
block <- sprintf(
'export const PAR_MODEL = {
  // Last refit: %s | %s | N=%d scores, %d dates, %d players | R\u00b2=%s (log scale)
  // scale:"log" => par = exp(intercept + \u03a3 coef\u00b7feature): multiplicative,
  // lognormal MEDIAN. Coefficients are LOG-MULTIPLIERS per unit, NOT seconds.
  scale: \'log\',
  intercept: %.4f,

  // Size baseline. cellCount is the lone size axis (it absorbs trivial
  // propagation); totalMines stays a raw count. (2026-06-08 rework.)
  secPerCell:        %.5f,
  secPerMineFlag:    %.5f,

  // Reasoning tiers: pattern = canonical + generic subsets; search = advanced.
  secPerPatternMove: %.5f,
  secPerSearchMove:  %.5f,

  // Board structure.
  secPerWallEdge:    %.5f,
  secPerZeroCluster: %.5f,

  // Modifier cells (kept split; sparse, prior-anchored until data builds).
  secPerMysteryCell:   %.5f,
  secPerLiarCell:      %.5f,
  secPerLockedCell:    %.5f,
  secPerWormholePair:  %.5f,
  secPerMirrorPair:    %.5f,
  secPerSonarCell:     %.5f,
  secPerCompassCell:   %.5f,
  secPerWormLoad:      %.5f,

  // Board shape (Project Coastline). One log-multiplier per non-rectangular
  // tiling, rectangles the omitted reference — held at 0 until tiling boards
  // have produced real completions, so par is unchanged on every board to date.
  secPerShape488:      %.5f,
  secPerShapeHex:      %.5f,
  secPerShapeCairo:      %.5f,
  secPerShapeFloret:     %.5f,
  secPerShapeRhombille:  %.5f,
  secPerShapeDeltoidal:  %.5f,

};',
  Sys.Date(), method_str, n_scores, n_dates, n_players, r2_str,
  new_coefs$intercept,
  new_coefs$secPerCell,
  new_coefs$secPerMineFlag,
  new_coefs$secPerPatternMove,
  new_coefs$secPerSearchMove,
  new_coefs$secPerWallEdge,
  new_coefs$secPerZeroCluster,
  new_coefs$secPerMysteryCell,
  new_coefs$secPerLiarCell,
  new_coefs$secPerLockedCell,
  new_coefs$secPerWormholePair,
  new_coefs$secPerMirrorPair,
  new_coefs$secPerSonarCell,
  new_coefs$secPerCompassCell,
  new_coefs$secPerWormLoad,
  new_coefs$secPerShape488,
  new_coefs$secPerShapeHex,
  new_coefs$secPerShapeCairo,
  new_coefs$secPerShapeFloret,
  new_coefs$secPerShapeRhombille,
  new_coefs$secPerShapeDeltoidal
)

src <- paste(readLines(DIFFICULTY_PATH, warn = FALSE, encoding = "UTF-8"),
             collapse = "\n")
start_marker <- "// PAR_MODEL:START"
end_marker   <- "// PAR_MODEL:END"
start_loc <- str_locate(src, fixed(start_marker))
end_loc   <- str_locate(src, fixed(end_marker))
if (is.na(start_loc[1, "start"]) || is.na(end_loc[1, "end"])) {
  stop("Could not find PAR_MODEL markers in ", DIFFICULTY_PATH)
}

new_src <- paste0(
  substr(src, 1, start_loc[1, "start"] - 1),
  start_marker, "\n", block, "\n", end_marker,
  substr(src, end_loc[1, "end"] + 1, nchar(src))
)

# ── Quick-play block (TIMED_PAR_MODEL markers) ──
# Same marker contract as PAR_MODEL. Below the activation threshold
# timed_coefs is a verbatim copy of the daily model, so the shipped
# block always exists and always parses.
timed_block <- sprintf(
'export const PAR_MODEL_TIMED = {
  // Last refit: %s | %s
  // Same log scale as PAR_MODEL (par = exp(intercept + Σ coef·feature)); below
  // the activation threshold this is a verbatim copy of the daily model.
  scale: \'log\',
  intercept: %.4f,
  secPerCell:        %.5f,
  secPerMineFlag:    %.5f,
  secPerPatternMove: %.5f,
  secPerSearchMove:  %.5f,
  secPerWallEdge:    %.5f,
  secPerZeroCluster: %.5f,
  secPerMysteryCell:   %.5f,
  secPerLiarCell:      %.5f,
  secPerLockedCell:    %.5f,
  secPerWormholePair:  %.5f,
  secPerMirrorPair:    %.5f,
  secPerSonarCell:     %.5f,
  secPerCompassCell:   %.5f,
  secPerWormLoad:      %.5f,
  secPerShape488:      %.5f,
  secPerShapeHex:      %.5f,
  secPerShapeCairo:      %.5f,
  secPerShapeFloret:     %.5f,
  secPerShapeRhombille:  %.5f,
  secPerShapeDeltoidal:  %.5f,
};',
  Sys.Date(), timed_method,
  timed_coefs$intercept,
  timed_coefs$secPerCell,
  timed_coefs$secPerMineFlag,
  timed_coefs$secPerPatternMove,
  timed_coefs$secPerSearchMove,
  timed_coefs$secPerWallEdge,
  timed_coefs$secPerZeroCluster,
  timed_coefs$secPerMysteryCell,
  timed_coefs$secPerLiarCell,
  timed_coefs$secPerLockedCell,
  timed_coefs$secPerWormholePair,
  timed_coefs$secPerMirrorPair,
  timed_coefs$secPerSonarCell,
  timed_coefs$secPerCompassCell,
  timed_coefs$secPerWormLoad,
  # Quick play is rectangles-only, so these are carried purely to keep the two
  # blocks the same shape (COEF_TERMS is shared, and test/timedModel.test.mjs
  # pins that every PAR_MODEL key has a PAR_MODEL_TIMED counterpart). The
  # copy-of-daily default supplies them when no timed fit ran.
  timed_coefs$secPerShape488       %||% 0,
  timed_coefs$secPerShapeHex       %||% 0,
  timed_coefs$secPerShapeCairo     %||% 0,
  timed_coefs$secPerShapeFloret    %||% 0,
  timed_coefs$secPerShapeRhombille %||% 0,
  timed_coefs$secPerShapeDeltoidal %||% 0
)

t_start_marker <- "// TIMED_PAR_MODEL:START"
t_end_marker   <- "// TIMED_PAR_MODEL:END"
t_start_loc <- str_locate(new_src, fixed(t_start_marker))
t_end_loc   <- str_locate(new_src, fixed(t_end_marker))
if (is.na(t_start_loc[1, "start"]) || is.na(t_end_loc[1, "end"])) {
  stop("Could not find TIMED_PAR_MODEL markers in ", DIFFICULTY_PATH)
}
new_src <- paste0(
  substr(new_src, 1, t_start_loc[1, "start"] - 1),
  t_start_marker, "\n", timed_block, "\n", t_end_marker,
  substr(new_src, t_end_loc[1, "end"] + 1, nchar(new_src))
)

if (identical(new_src, src)) {
  message("No coefficient changes — file already up to date.")
  quit(status = 0)
}

writeLines(new_src, DIFFICULTY_PATH, useBytes = TRUE)
message(sprintf("Wrote updated PAR_MODEL + PAR_MODEL_TIMED to %s", DIFFICULTY_PATH))

# Fail the workflow loudly if the brms fit was rejected for diagnostic
# reasons. The previous PAR_MODEL stays in effect (good), but the run
# should NOT register green — that's how silent degradation creeps in.
if (diagnostic_failure) {
  message("REFIT REJECTED: brms fit failed diagnostics; previous PAR_MODEL retained.")
  quit(save = "no", status = 2)
}

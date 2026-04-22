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

# Minimum total scores before we bother fitting at all. With informative
# priors the fit is stable at much lower N than the old lm/lmer approach
# (which needed ~150 before coefficients stopped blowing up), so the floor
# is mostly about "is there enough signal to move the prior at all" rather
# than "will the fit explode". 30 is roughly 2 observations per predictor.
MIN_SCORES_TO_FIT <- 30

# Minimum plays before a user's scores are allowed to influence the GLOBAL
# model (PAR_MODEL coefficients and the bias-correction calibration). Users
# below this threshold are excluded from the mixed-effects fit entirely,
# which means the intercept/slopes describe "the average regular player"
# instead of being dragged around by the occasional anonymous visitor.
# Those below-threshold users can still see per-user stats client-side
# (estimateHandicapFromHistory in handicaps.js computes a provisional
# handicap from their own play history against the current PAR_MODEL),
# but they don't get an entry in handicaps.json until they cross 30.
MIN_PLAYS_FOR_FIT_INCLUSION <- 30

# (MIN_PLAYS_FOR_HANDICAP retired; the residuals-fallback path now uses
# the same MIN_PLAYS_FOR_FIT_INCLUSION threshold as the main fit, so
# handicaps.json has a single meaning: "users with enough plays to
# contribute to the population calibration". Anyone below the threshold
# needs client-side handicap estimation via handicaps.js.)

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
  passAMoves           = 1.2,
  canonicalSubsetMoves = 2.0,
  genericSubsetMoves   = 4.5,
  advancedLogicMoves   = 7.0,
  disjunctiveMoves     = 10.0,
  cellCount            = 0.02,
  totalMines           = 0.3,
  wallEdgeCount        = 0.15,
  mysteryCellCount     = 0.8,
  liarCellCount        = 0.6,
  lockedCellCount      = 0.4,
  wormholePairCount    = 0.8,
  mirrorPairCount      = 1.0,
  sonarCellCount       = 0.5,
  compassCellCount     = 0.5
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
PRIOR_INTERCEPT_SD <- 15.0   # lets the intercept float freely; bias-
                              # correction + slope priors carry the
                              # calibration
PRIOR_SIGMAS <- list(
  passAMoves           = 1.0,
  canonicalSubsetMoves = 1.0,
  genericSubsetMoves   = 1.0,
  advancedLogicMoves   = 1.0,
  disjunctiveMoves     = 1.0,
  cellCount            = 1.0,
  totalMines           = 1.0,
  wallEdgeCount        = 1.0,
  mysteryCellCount     = 1.0,
  liarCellCount        = 1.0,
  lockedCellCount      = 1.0,
  wormholePairCount    = 1.0,
  mirrorPairCount      = 1.0,
  sonarCellCount       = 1.0,
  compassCellCount     = 1.0
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
# times. Kept close to the JS predictPar so the two stay in sync.
apply_par_model <- function(df, coefs) {
  with(df,
    coefs$intercept +
    coefs$secPerPassAMove            * passAMoves +
    coefs$secPerCanonicalSubsetMove  * canonicalSubsetMoves +
    coefs$secPerGenericSubsetMove    * genericSubsetMoves +
    coefs$secPerAdvancedLogicMove    * advancedLogicMoves +
    coefs$secPerDisjunctiveMove      * disjunctiveMoves +
    coefs$secPerCell                 * cellCount +
    coefs$secPerMineFlag             * totalMines +
    coefs$secPerWallEdge             * wallEdgeCount +
    coefs$secPerMysteryCell          * mysteryCellCount +
    coefs$secPerLiarCell             * liarCellCount +
    coefs$secPerLockedCell           * lockedCellCount +
    coefs$secPerWormholePair         * wormholePairCount +
    coefs$secPerMirrorPair           * mirrorPairCount +
    coefs$secPerSonarCell            * sonarCellCount +
    coefs$secPerCompassCell          * compassCellCount
  )
}

# Build the brms prior list. Per-coefficient priors are lognormal so they're
# inherently positive and centered (as median) on the seed value — this is
# what does the regularisation work. The Intercept gets a plain normal.
# Residual SD and handicap SD get weakly informative priors appropriate for
# variance components.
build_priors <- function(fixed_names) {
  parts <- list()
  # Class-wide constraint: lognormal priors only make sense for positive
  # parameters, so we need to tell Stan the b-class parameters are bounded
  # below by zero. brms doesn't allow combining `coef` with `lb`, so the
  # bound goes on a class-wide placeholder prior and the distribution
  # specifications come through the per-coef priors below.
  parts[[length(parts) + 1]] <- set_prior("", class = "b", lb = 0)

  for (nm in fixed_names) {
    m <- PRIOR_MEANS[[nm]]
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
        sprintf("lognormal(%f, %f)", log(m), sig),
        class = "b", coef = nm
      )
    }
  }
  # Residual SD: observation-level completion times vary on the order of
  # tens of seconds; half-normal(0, 20) covers that with plenty of slack.
  parts[[length(parts) + 1]] <- set_prior("normal(0, 20)", class = "sigma")
  # Between-user SD for handicaps: student_t(3, 0, 5) is the brms default-
  # style weakly informative prior for variance components.
  parts[[length(parts) + 1]] <- set_prior(
    "student_t(3, 0, 5)", class = "sd", group = "uid"
  )
  do.call(c, parts)
}

# ── 1. Pull data ────────────────────────────────────────

message("[", format(Sys.time(), tz = "UTC", usetz = TRUE), "] fetching Firebase…")

meta_raw   <- fromJSON(paste0(DB_URL, "/dailyMeta.json"), simplifyVector = FALSE) %||% list()
scores_raw <- fromJSON(paste0(DB_URL, "/daily.json"),     simplifyVector = FALSE) %||% list()

message(sprintf("  dailyMeta dates: %d", length(meta_raw)))
message(sprintf("  daily score dates: %d", length(scores_raw)))

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

scores_df <- tibble(
  date  = rep(names(scores_raw), map_int(scores_raw, length)),
  entry = flatten(map(scores_raw, ~ .x))
) |>
  mutate(
    time = map_dbl(entry, ~ .x$time %||% NA_real_),
    uid  = map_chr(entry, ~ .x$uid  %||% NA_character_),
  ) |>
  select(-entry) |>
  filter(!is.na(time), time >= 5, time <= 3600)

df <- scores_df |>
  inner_join(meta, by = "date") |>
  mutate(across(
    c(passAMoves, canonicalSubsetMoves, genericSubsetMoves,
      advancedLogicMoves, disjunctiveMoves,
      totalMines, cellCount, wallEdgeCount, mysteryCellCount,
      liarCellCount, lockedCellCount, wormholePairCount,
      mirrorPairCount, sonarCellCount, compassCellCount),
    as.numeric
  ))

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
handicaps     <- list()         # uid -> seconds
fit_method    <- "seed-residuals"
r2            <- NA_real_
diag_note     <- ""

# ── 2. Fit ──────────────────────────────────────────────

fit_formula_fixed <- time ~
  passAMoves + canonicalSubsetMoves + genericSubsetMoves +
  advancedLogicMoves + disjunctiveMoves +
  cellCount + totalMines + wallEdgeCount +
  mysteryCellCount + liarCellCount + lockedCellCount +
  wormholePairCount + mirrorPairCount +
  sonarCellCount + compassCellCount

if (n_scores >= MIN_SCORES_TO_FIT && n_eligible >= 2) {
  # Bayesian mixed-effects fit on only the eligible users (>= 30 plays).
  # This keeps the global model from being dragged around by one-off
  # visitors or brand-new players whose handful of scores would otherwise
  # carry as much weight in the bias-correction step as a regular
  # player's 40+ scores. brms can estimate the random-intercept variance
  # even at n_eligible == 2 because the student_t prior on sd(uid) gives
  # it enough structure to separate "two players differ by X" from "zero
  # handicap variance, pure residual".
  df_fit <- df |> filter(uid %in% eligible_uids)
  fit_formula <- update(fit_formula_fixed, ~ . + (1 | uid))

  priors <- build_priors(c("Intercept", all.vars(fit_formula_fixed)[-1]))

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
  } else {
    # fixef() on a brmsfit returns a matrix with Estimate / Est.Error / CIs.
    # Estimate = posterior mean, which is what we want as the point value.
    co <- fixef(fit)[, "Estimate"]
    fit_method <- "brms-ranef"

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

    handicaps <- setNames(as.list(round(re_values, 2)), re_names)

    # Marginal R² (fixed effects only): var(fixed predictions) / total var.
    # brms has bayes_R2() for conditional R², but the marginal definition
    # here is directly comparable to the lmer pipeline and to OLS. Note
    # that model.matrix names the intercept column "(Intercept)" whereas
    # brms names it "Intercept" — normalise before the match.
    mm <- model.matrix(fit_formula_fixed, data = df_fit)
    mm_names <- colnames(mm); mm_names[mm_names == "(Intercept)"] <- "Intercept"
    fe_pred <- mm %*% co[match(mm_names, names(co))]
    r2 <- as.numeric(1 - var(df_fit$time - fe_pred) / var(df_fit$time))

    cat("\nbrms posterior means (fixed effects, post-recenter):\n")
    print(round(co, 3))
    cat(sprintf("  marginal R² ≈ %.3f, handicaps: %d users\n\n",
                r2, length(handicaps)))
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
    intercept                   = nn(co["Intercept"],              "intercept"),
    secPerPassAMove             = nn(co["passAMoves"],             "passA"),
    secPerCanonicalSubsetMove   = nn(co["canonicalSubsetMoves"],   "canonicalSubset"),
    secPerGenericSubsetMove     = nn(co["genericSubsetMoves"],     "genericSubset"),
    secPerAdvancedLogicMove     = nn(co["advancedLogicMoves"],     "advancedLogic"),
    secPerDisjunctiveMove       = nn(co["disjunctiveMoves"],       "disjunctive"),
    secPerCell                  = nn(co["cellCount"],              "cell"),
    secPerMineFlag              = nn(co["totalMines"],             "mineFlag"),
    secPerWallEdge              = nn(co["wallEdgeCount"],          "wallEdge"),
    secPerMysteryCell           = nn(co["mysteryCellCount"],       "mysteryCell"),
    secPerLiarCell              = nn(co["liarCellCount"],          "liarCell"),
    secPerLockedCell            = nn(co["lockedCellCount"],        "lockedCell"),
    secPerWormholePair          = nn(co["wormholePairCount"],      "wormholePair"),
    secPerMirrorPair            = nn(co["mirrorPairCount"],        "mirrorPair"),
    secPerSonarCell             = nn(co["sonarCellCount"],         "sonarCell"),
    secPerCompassCell           = nn(co["compassCellCount"],       "compassCell")
  )

  # Bias-correct the intercept so the mean predicted par matches the mean
  # actual time across the FIT population (df_fit), not the full df. This
  # matters because some scores are submitted without a uid (retrofit gaps,
  # anonymous Firebase sign-in race, etc.) and are filtered out of the
  # mixed-effects fit. Their residuals don't belong in the calibration:
  # they'd be absorbed into the intercept as if they were "population-
  # average player" plays, which inflates predictPar and makes every
  # uid-tagged user's displayed handicap look smaller than their true
  # offset from the fit population. Against df_fit, the identity
  # mean(time - predictPar) = play-weighted mean(u_j) = 0 holds exactly,
  # so bias should be essentially zero — the step exists as a safety net
  # for any future prior/clamping change that could violate the identity.
  biased_pred <- apply_par_model(df_fit, new_coefs)
  bias <- mean(df_fit$time) - mean(biased_pred)
  new_coefs$intercept <- max(0, new_coefs$intercept + bias)
  message(sprintf("  intercept bias-correction: %+.2fs (so mean predicted par = mean actual time across fit population)", bias))
}

# If the fit didn't run or failed diagnostics, compute handicaps from
# residuals against the EXISTING coefficients. Only eligible users (>=
# MIN_PLAYS_FOR_FIT_INCLUSION plays) are included — same threshold the
# main fit uses, so handicaps.json has a consistent meaning regardless
# of which path wrote it. Residuals are recentered (play-weighted) so
# the mean handicap is exactly zero — otherwise systematic bias in the
# seed par pushes every user's residual in the same direction, making
# handicaps useless for inter-player comparison.
if (fit_method == "seed-residuals") {
  df$predicted <- apply_par_model(df, new_coefs)
  df$residual  <- df$time - df$predicted
  per_user <- df |>
    filter(uid %in% eligible_uids) |>
    group_by(uid) |>
    summarise(n = n(), raw_handicap = mean(residual), .groups = "drop")
  if (nrow(per_user) > 0) {
    total_plays <- sum(per_user$n)
    weighted_mean <- sum(per_user$raw_handicap * per_user$n) / total_plays
    per_user$handicap <- round(per_user$raw_handicap - weighted_mean, 2)
  } else {
    per_user$handicap <- numeric(0)
  }
  handicaps <- setNames(as.list(per_user$handicap), per_user$uid)
  message(sprintf("Handicaps computed from residuals (recentered): %d users (min %d plays)",
                  length(handicaps), MIN_PLAYS_FOR_FIT_INCLUSION))
}

# ── 4. Write handicaps.json (always, even if fit didn't run) ────────

handicaps_obj <- list(
  updatedAt = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  modelFitN = n_scores,
  nPlayers  = n_players,
  method    = fit_method,
  diagnostics = if (nchar(diag_note)) diag_note else NULL,
  handicaps = handicaps
)
writeLines(toJSON(handicaps_obj, auto_unbox = TRUE, pretty = TRUE),
           HANDICAPS_PATH)

# ── 5. Write updated PAR_MODEL block (only if fit produced new coefs) ──

if (fit_method != "brms-ranef") {
  message("No new coefficients — difficulty.js untouched.")
  quit(status = 0)
}

r2_str <- if (is.na(r2)) "NA" else sprintf("%.3f", r2)
method_str <- sprintf("brms (%d users · %s)", length(handicaps), diag_note)
block <- sprintf(
'export const PAR_MODEL = {
  // Last refit: %s | %s | N=%d scores, %d dates, %d players | R\u00b2=%s
  intercept: %.2f,

  // Move-type coefficients (primary)
  secPerPassAMove:            %.2f,
  secPerCanonicalSubsetMove:  %.2f,
  secPerGenericSubsetMove:    %.2f,
  secPerAdvancedLogicMove:    %.2f,
  secPerDisjunctiveMove:      %.2f,

  // Board shape (secondary)
  secPerCell:      %.3f,
  secPerMineFlag:  %.3f,
  secPerWallEdge:  %.3f,

  // Gimmick cell counts (tertiary)
  secPerMysteryCell:   %.3f,
  secPerLiarCell:      %.3f,
  secPerLockedCell:    %.3f,
  secPerWormholePair:  %.3f,
  secPerMirrorPair:    %.3f,
  secPerSonarCell:     %.3f,
  secPerCompassCell:   %.3f,
};',
  Sys.Date(), method_str, n_scores, n_dates, n_players, r2_str,
  new_coefs$intercept,
  new_coefs$secPerPassAMove,
  new_coefs$secPerCanonicalSubsetMove,
  new_coefs$secPerGenericSubsetMove,
  new_coefs$secPerAdvancedLogicMove,
  new_coefs$secPerDisjunctiveMove,
  new_coefs$secPerCell,
  new_coefs$secPerMineFlag,
  new_coefs$secPerWallEdge,
  new_coefs$secPerMysteryCell,
  new_coefs$secPerLiarCell,
  new_coefs$secPerLockedCell,
  new_coefs$secPerWormholePair,
  new_coefs$secPerMirrorPair,
  new_coefs$secPerSonarCell,
  new_coefs$secPerCompassCell
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

if (identical(new_src, src)) {
  message("No coefficient changes — file already up to date.")
  quit(status = 0)
}

writeLines(new_src, DIFFICULTY_PATH, useBytes = TRUE)
message(sprintf("Wrote updated PAR_MODEL to %s", DIFFICULTY_PATH))

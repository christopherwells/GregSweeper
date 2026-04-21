# Automated Greg-par refit.
#
# Pulls `daily/*` scores and `dailyMeta/*` features from Firebase Realtime
# Database via public HTTPS reads (security rules make both world-readable),
# joins them, fits a mixed-effects model (fixed effects = par coefficients,
# random intercept per uid = handicap), and patches src/logic/difficulty.js
# between its PAR_MODEL:START / PAR_MODEL:END markers. Also writes
# src/logic/handicaps.json keyed by uid.
#
# Run manually with Rscript scripts/refit-par-model.R, or automatically on
# the cron schedule defined in .github/workflows/refit-par-model.yml.

suppressPackageStartupMessages({
  library(jsonlite)
  library(dplyr)
  library(tidyr)
  library(purrr)
  library(stringr)
  library(lme4)   # lmer — estimates fixed effects AND per-user random intercepts
                  # jointly, which is what makes the handicap unbiased by who-
                  # played-more. Without the random intercept we'd have a
                  # circular reference where a player with many submissions
                  # pulls the fixed effects toward their own time, and their
                  # handicap (residual from those same effects) then looks
                  # smaller than it really is. lmer breaks the cycle.
})

`%||%` <- function(a, b) if (is.null(a)) b else a

DB_URL          <- "https://gregsweeper-66d02-default-rtdb.firebaseio.com"
DIFFICULTY_PATH <- "src/logic/difficulty.js"
HANDICAPS_PATH  <- "src/logic/handicaps.json"

# Minimum scores before the regression runs at all. Intentionally low — the
# user explicitly wants to watch the model develop from early days. Below
# this, the seed coefficients stay and handicaps fall back to a mean-residual
# estimator. Coefficients may be noisy early; that's expected and fine.
MIN_SCORES_TO_FIT <- 20

# Soft guard: reject a refit that pushes any move-type coefficient more than
# this multiple away from the PREVIOUS value (not the seed — yesterday's
# coefficients are the baseline for today's drift). Prevents catastrophic
# overwrites from a bad join or broken data while still letting the model
# evolve gradually over time.
MAX_COEF_DRIFT <- 10.0

# Users with fewer than this many submitted scores get a handicap of 0 rather
# than a noisy per-user mean. With lmer, partial pooling already shrinks
# low-N users toward zero, so this is extra conservatism. When we're using
# lm() instead (no random effects), this threshold actually matters.
MIN_PLAYS_FOR_HANDICAP <- 3

# Parse the current PAR_MODEL block out of difficulty.js. Used as both the
# drift baseline and the fallback when no new fit runs.
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

message(sprintf("  joined: N=%d scores, %d dates, %d players",
                n_scores, n_dates, n_players))

current_coefs <- parse_par_model(DIFFICULTY_PATH)
new_coefs     <- current_coefs  # default: no refit, keep what's there
handicaps     <- list()         # uid -> seconds
used_lmer     <- FALSE
used_lm       <- FALSE
r2            <- NA_real_

# ── 2. Fit ──────────────────────────────────────────────

fit_formula_fixed <- time ~
  passAMoves + canonicalSubsetMoves + genericSubsetMoves +
  advancedLogicMoves + disjunctiveMoves +
  cellCount + totalMines + wallEdgeCount +
  mysteryCellCount + liarCellCount + lockedCellCount +
  wormholePairCount + mirrorPairCount +
  sonarCellCount + compassCellCount

if (n_scores >= MIN_SCORES_TO_FIT && n_players >= 2) {
  # Mixed-effects fit: one random intercept per uid = that user's handicap.
  # Partial pooling shrinks low-N users toward zero automatically, which
  # is why we don't need to worry about a brand-new player's first score
  # blowing out their handicap estimate.
  fit_formula <- update(fit_formula_fixed, ~ . + (1 | uid))
  df_lmer <- df |> filter(!is.na(uid), uid != "")

  fit <- lmer(fit_formula, data = df_lmer, REML = TRUE,
              control = lmerControl(
                check.conv.singular = .makeCC(action = "ignore", tol = 1e-4)
              ))
  co <- fixef(fit)
  used_lmer <- TRUE

  # Random intercepts = handicaps. ranef() returns a list with one entry
  # per grouping factor; $uid is a 1-column data frame (the intercept).
  re <- ranef(fit)$uid
  handicaps <- setNames(as.list(round(re[, 1], 2)), rownames(re))

  # Marginal R² (fixed effects only): var(fixed predictions) / total var.
  # Close enough to OLS R² for diagnostic display; conditional (fixed+random)
  # would always be higher and less comparable.
  fe_pred <- model.matrix(fit_formula_fixed, data = df_lmer) %*%
             co[match(colnames(model.matrix(fit_formula_fixed, data = df_lmer)), names(co))]
  r2 <- as.numeric(1 - var(df_lmer$time - fe_pred) / var(df_lmer$time))

  cat("\nlmer fixed effects:\n"); print(co)
  cat(sprintf("  marginal R² ≈ %.3f, handicaps: %d users\n\n",
              r2, length(handicaps)))

} else if (n_scores >= MIN_SCORES_TO_FIT) {
  # Single-user or uid-less data: lmer can't fit a random intercept.
  # Fall back to plain lm for fixed effects; handicaps come from residuals.
  fit <- lm(fit_formula_fixed, data = df)
  co <- coef(fit)
  used_lm <- TRUE
  r2 <- summary(fit)$r.squared

  cat("\nlm fit (n_players < 2, no random effect):\n")
  print(summary(fit)$coefficients[, c("Estimate", "Std. Error", "Pr(>|t|)")])
  cat(sprintf("  R² = %.3f\n\n", r2))

} else {
  message(sprintf(
    "Too few scores to refit fixed effects (%d < %d). Seed coefficients unchanged.",
    n_scores, MIN_SCORES_TO_FIT
  ))
}

# ── 3. Build new_coefs from the fit (if any) ─────────────

if (used_lmer || used_lm) {
  # Non-negative clamp — par should be monotonic non-decreasing in every
  # feature. Negative coefficients are collinearity/noise, not signal.
  nn <- function(x, name) {
    v <- if (is.na(x)) 0 else as.numeric(x)
    if (v < 0) {
      message(sprintf("  clamping negative coefficient: %s = %.3f → 0", name, v))
      return(0)
    }
    v
  }

  new_coefs <- list(
    intercept                   = nn(co["(Intercept)"],           "intercept"),
    secPerPassAMove             = nn(co["passAMoves"],            "passA"),
    secPerCanonicalSubsetMove   = nn(co["canonicalSubsetMoves"],  "canonicalSubset"),
    secPerGenericSubsetMove     = nn(co["genericSubsetMoves"],    "genericSubset"),
    secPerAdvancedLogicMove     = nn(co["advancedLogicMoves"],    "advancedLogic"),
    secPerDisjunctiveMove       = nn(co["disjunctiveMoves"],      "disjunctive"),
    secPerCell                  = nn(co["cellCount"],             "cell"),
    secPerMineFlag              = nn(co["totalMines"],             "mineFlag"),
    secPerWallEdge              = nn(co["wallEdgeCount"],         "wallEdge"),
    secPerMysteryCell           = nn(co["mysteryCellCount"],      "mysteryCell"),
    secPerLiarCell              = nn(co["liarCellCount"],         "liarCell"),
    secPerLockedCell            = nn(co["lockedCellCount"],       "lockedCell"),
    secPerWormholePair          = nn(co["wormholePairCount"],     "wormholePair"),
    secPerMirrorPair            = nn(co["mirrorPairCount"],       "mirrorPair"),
    secPerSonarCell             = nn(co["sonarCellCount"],        "sonarCell"),
    secPerCompassCell           = nn(co["compassCellCount"],      "compassCell")
  )

  # Drift guard (move-type coefs only — shape/gimmick can be noisier).
  drift_fields <- c("intercept", "secPerPassAMove", "secPerCanonicalSubsetMove",
                    "secPerGenericSubsetMove", "secPerAdvancedLogicMove",
                    "secPerDisjunctiveMove")
  violations <- c()
  for (f in drift_fields) {
    prev <- current_coefs[[f]]
    new  <- new_coefs[[f]]
    if (is.null(prev) || prev <= 0 || is.null(new) || new <= 0) next
    ratio <- new / prev
    if (ratio > MAX_COEF_DRIFT || ratio < 1 / MAX_COEF_DRIFT) {
      violations <- c(violations,
        sprintf("%s: prev=%.2f -> new=%.2f (%.1fx drift)", f, prev, new, ratio))
    }
  }
  if (length(violations) > 0) {
    message("Fit rejected — coefficients drifted too far from previous values:")
    for (v in violations) message("  ", v)
    message("Keeping previous PAR_MODEL. Investigate via scripts/fit-par-model.qmd.")
    new_coefs <- current_coefs
    used_lmer <- FALSE
    used_lm   <- FALSE
  }
}

# If lm was used (no random effect available), compute handicaps from
# residuals against NEW coefficients. Users below MIN_PLAYS_FOR_HANDICAP
# are dropped to avoid noisy single-game means.
if (used_lm || (!used_lmer && !used_lm)) {
  df$predicted <- apply_par_model(df, new_coefs)
  df$residual  <- df$time - df$predicted
  per_user <- df |>
    filter(!is.na(uid), uid != "") |>
    group_by(uid) |>
    summarise(n = n(), handicap = round(mean(residual), 2), .groups = "drop") |>
    filter(n >= MIN_PLAYS_FOR_HANDICAP)
  handicaps <- setNames(as.list(per_user$handicap), per_user$uid)
  message(sprintf("Handicaps computed from residuals: %d users (min %d plays)",
                  length(handicaps), MIN_PLAYS_FOR_HANDICAP))
} else {
  message(sprintf("Handicaps from lmer random intercepts: %d users",
                  length(handicaps)))
}

# ── 4. Write handicaps.json (always, even if fit didn't run) ────────

handicaps_obj <- list(
  updatedAt = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  modelFitN = n_scores,
  nPlayers  = n_players,
  method    = if (used_lmer) "lmer-ranef" else if (used_lm) "lm-residuals" else "seed-residuals",
  handicaps = handicaps
)
writeLines(toJSON(handicaps_obj, auto_unbox = TRUE, pretty = TRUE),
           HANDICAPS_PATH)

# ── 5. Write updated PAR_MODEL block (only if fit produced new coefs) ──

if (!used_lmer && !used_lm) {
  message("No new coefficients — difficulty.js untouched.")
  quit(status = 0)
}

r2_str <- if (is.na(r2)) "NA" else sprintf("%.3f", r2)
method_str <- if (used_lmer) sprintf("lmer (%d random intercepts)", length(handicaps)) else "lm"
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

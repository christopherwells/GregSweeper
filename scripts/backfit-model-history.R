# One-off sequential backfit — re-measure the pre-2026-07-02 model history
# with today's yardstick.
#
# The par model changed coefficient scales on 2026-07-02 (additive seconds →
# log-multipliers, v1.6.127), so modelHistory rows before that date carry
# posterior SDs in units the Journal cannot compare against the current era.
# This script refits the CURRENT log-scale pipeline (the same model, filters,
# and priors as scripts/refit-par-model.R) once per historical refit date D,
# on the cumulative day-of data with board dates <= D — a statistically sound
# retrodiction: "what would tonight's model have estimated with only the data
# available on date D". Each date's per-feature posterior mean/sd lands as a
# NEW `candidatesLog` field on that date's LAST modelHistory row, leaving the
# original `candidates` untouched as provenance. journalFindings.js then reads
# one consistent log-scale series (candidatesLog before the epoch, candidates
# on/after it) so study trajectories reach back to April.
#
# Pipeline parity with refit-par-model.R (same constants, copied deliberately —
# this is a frozen one-off, not a shared library):
#   - filters: time in [5, 3600], hinted plays excluded, crux-previewed archive
#     rows n/a (archive rows are excluded wholesale — see below), the >30%
#     bomb-hit anti-cheat drop, and the impossibly-fast outlier screen. The
#     outlier screen compares against the CURRENTLY SHIPPED PAR_MODEL (today's
#     yardstick) rather than each date's historical model — the whole point of
#     the retrodiction is one consistent ruler.
#   - bomb cost: new-mechanic base surcharge (bombBaseSum) and the legacy
#     LEGACY_BOMB_RATE/hit are subtracted into pure_time BEFORE logging, so
#     there is no bomb regressor (identical to the nightly fit).
#   - archive rows (dailyArchive/*) are EXCLUDED entirely: the nightly pipeline
#     holds them out below ARCHIVE_FIT_THRESHOLD = 20 pooled rows, and the
#     archive has never crossed that threshold (1 date node as of 2026-07-12),
#     so exclusion IS current-pipeline behavior for every backfit date.
#   - weekly-first rows (daily/{weekStart}_weekly_first) participate exactly as
#     in the nightly fit; the cumulative cutoff compares their DATE PREFIX
#     (substr 1..10, the week start) against D.
#   - priors: OLS-seeded lognormal centers on the log scale, computed per
#     cumulative subset (memoryless, exactly like the nightly run would have).
#   - gates: MIN_SCORES_TO_FIT = 30, >= 2 eligible users, and the same
#     Rhat/ESS/divergent diagnostics bar. A date that fails any gate is
#     SKIPPED (logged, no candidatesLog) — the Journal reader tolerates gaps,
#     and a number that failed the quality bar must never ship.
#
# Usage (from the repo root):
#   Rscript scripts/backfit-model-history.R --dates 2026-04-22            # smoke one date
#   Rscript scripts/backfit-model-history.R --shard 1/3                   # one of 3 parallel workers
#   Rscript scripts/backfit-model-history.R                               # all missing dates, one process
#   Rscript scripts/backfit-model-history.R --merge f1.json,f2.json,...   # fold scratch results into modelHistory.json
#
# Fit results are written incrementally to a scratch file (--out, default
# scripts/backfit-results-shard<k>.json) so a crash loses at most one fit;
# the --merge pass is the only writer of src/logic/modelHistory.json. Dates
# whose LAST history row already carries candidatesLog are skipped, so the
# script is resume-safe and re-runnable. Scratch files are temporary — delete
# after merging, never commit.
#
# WHAT THE RETRODICTION MAY CLAIM (measured on this data, 2026-07-12): a
# feature with little usable signal on an early date gets a posterior that
# mostly echoes its OLS-seeded prior — e.g. sonar's sd sat near its
# prior-floor level (~0.002) through Apr 24 with 3 sonar boards on record,
# then jumped to ~0.032 the moment the Apr 23 sonar-study scores landed, and
# compass stayed prior-flat into June. No cheap detector separates "the data
# spoke" from "the prior echoed" (board counts don't: compass had 5 boards
# while still flat), so the JOURNAL READER treats these points as chart
# history only: verdict sentences stay windowed to the live model era
# (non-retro fits), and the sparkline draws retrodicted points dimmed,
# normalized to the era anchor, under the re-measured caption. Do not build
# copy that compares a retrodicted sd to a live sd.

suppressPackageStartupMessages({
  library(jsonlite)
  library(dplyr)
  library(tidyr)
  library(purrr)
  library(stringr)
  library(brms)
  library(posterior)
})

set.seed(20260422)

`%||%` <- function(a, b) if (is.null(a)) b else a

DB_URL          <- "https://gregsweeper-66d02-default-rtdb.firebaseio.com"
DIFFICULTY_PATH <- "src/logic/difficulty.js"
HISTORY_PATH    <- "src/logic/modelHistory.json"

# The scale epoch: rows dated before this get candidatesLog; the backfit
# never touches rows on/after it (their candidates are already log-scale).
SCALE_EPOCH <- "2026-07-02"

# ── Constants mirrored from refit-par-model.R ───────────────────────────
BOMB_PENALTY_BASE <- 3
MIN_SCORES_TO_FIT <- 30
MIN_PLAYS_FOR_FIT_INCLUSION <- 5
N_CHAINS    <- 4
N_ITER      <- 2000
N_WARMUP    <- 1000
ADAPT_DELTA <- 0.99
MAX_DIVERGENT_FRAC <- 0.0025
LEGACY_BOMB_RATE <- 15.0
PURE_TIME_FLOOR  <- 1.0
PRIOR_MEAN_FLOOR <- 1e-3
PRIOR_INTERCEPT_SD <- 2.0
# Mirrors isBombHitCheat in difficulty.js — see the fuller note in
# refit-par-model.R. Two arms: far-more-mistakes-than-a-bad-day (floored,
# because a bare fraction is scale-free and small tiling boards carry as few
# as 6 mines), and you-excavated-the-board (which still bites where the floor
# exceeds the mine count).
BOMB_HIT_CHEAT_FRACTION     <- 0.50
BOMB_HIT_CHEAT_FLOOR        <- 10
BOMB_HIT_EXCAVATED_FRACTION <- 0.80
PRIOR_SIGMAS <- list(
  cellCount = 1.0, totalMines = 1.0, patternMoves = 1.0, searchMoves = 1.0,
  wallEdgeCount = 1.0, mysteryCellCount = 1.0, liarCellCount = 1.0,
  lockedCellCount = 1.0, wormholePairCount = 1.0, mirrorPairCount = 1.0,
  sonarCellCount = 1.0, compassCellCount = 1.0, zeroClusterCount = 1.0
)

# The candidatesLog feature table — the nightly fit's target whitelist
# (fixef rownames minus cellCount, which is load-bearing for board size and
# never a push target). Order in the emitted table is by posterior CV, desc,
# matching how the nightly writes `candidates`.
TARGET_WHITELIST <- c(
  "patternMoves", "searchMoves", "totalMines", "wallEdgeCount",
  "mysteryCellCount", "liarCellCount", "lockedCellCount",
  "wormholePairCount", "mirrorPairCount", "sonarCellCount",
  "compassCellCount", "zeroClusterCount"
)

# ── CLI ──────────────────────────────────────────────────────────────────
args <- commandArgs(trailingOnly = TRUE)
arg_value <- function(flag) {
  i <- which(args == flag)
  if (length(i) == 1 && i < length(args)) args[i + 1] else NULL
}
opt_dates  <- arg_value("--dates")   # comma-separated explicit date list
opt_shard  <- arg_value("--shard")   # "k/n" — every n-th missing date, offset k
opt_out    <- arg_value("--out")     # scratch results path
opt_merge  <- arg_value("--merge")   # comma-separated scratch files to fold in

read_history <- function() {
  history <- fromJSON(HISTORY_PATH, simplifyVector = FALSE)
  if (!is.list(history)) stop("modelHistory.json did not parse to a list")
  history
}

# The nightly refit rewrites modelHistory.json with exactly these toJSON
# settings, so matching them keeps this file's formatting stable across both
# writers (and proves candidatesLog survives the nightly's own round-trip).
write_history <- function(history) {
  writeLines(toJSON(history, auto_unbox = TRUE, pretty = TRUE, na = "null"),
             HISTORY_PATH)
}

# Last row index per date — the Journal reader's dedupe rule
# (last-row-per-date wins), so candidatesLog must land on that row.
last_row_index_for_date <- function(history, d) {
  idx <- which(vapply(history, function(r) identical(r$date, d), logical(1)))
  if (length(idx) == 0) NA_integer_ else max(idx)
}

# ── Merge mode: fold scratch results into modelHistory.json ─────────────
if (!is.null(opt_merge)) {
  history <- read_history()
  n_applied <- 0
  for (path in str_split(opt_merge, ",")[[1]]) {
    path <- str_trim(path)
    if (!file.exists(path)) stop("Missing scratch file: ", path)
    results <- fromJSON(path, simplifyVector = FALSE)
    for (res in results) {
      d <- res$date
      if (is.null(d) || d >= SCALE_EPOCH) stop("Refusing to merge a non-pre-epoch date: ", d %||% "<null>")
      i <- last_row_index_for_date(history, d)
      if (is.na(i)) { message("  no history row for ", d, " — skipped"); next }
      history[[i]]$candidatesLog    <- res$candidatesLog
      history[[i]]$candidatesLogFit <- res$candidatesLogFit
      n_applied <- n_applied + 1
    }
  }
  write_history(history)
  message(sprintf("Merged candidatesLog onto %d row(s) in %s", n_applied, HISTORY_PATH))
  quit(status = 0)
}

# ── Parse the current PAR_MODEL for the outlier screen ───────────────────
parse_par_model <- function(path) {
  src <- paste(readLines(path, warn = FALSE, encoding = "UTF-8"), collapse = "\n")
  block_start <- str_locate(src, fixed("// PAR_MODEL:START"))[1, "end"]
  block_end   <- str_locate(src, fixed("// PAR_MODEL:END"))[1, "start"]
  if (is.na(block_start) || is.na(block_end)) stop("PAR_MODEL markers missing in ", path)
  block <- substr(src, block_start + 1, block_end - 1)
  if (!str_detect(block, "scale\\s*:\\s*'log'")) {
    stop("Shipped PAR_MODEL is not log-scale — this backfit assumes today's log model")
  }
  m <- str_match_all(block, "(\\w+)\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)")[[1]]
  if (nrow(m) == 0) stop("Could not parse any coefficients from PAR_MODEL")
  setNames(as.list(as.numeric(m[, 3])), m[, 2])
}

apply_par_model <- function(df, coefs) {
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
    (coefs$secPerZeroCluster %||% 0) * zeroClusterCount
  )
  exp(lp)
}

compute_log_ols_seeds <- function(df_fit, fixed_names) {
  f <- as.formula(paste("log(pure_time) ~", paste(fixed_names, collapse = " + ")))
  co <- tryCatch(coef(lm(f, data = df_fit)), error = function(e) numeric(0))
  names(co)[names(co) == "(Intercept)"] <- "Intercept"
  out <- list()
  out[["Intercept"]] <- if (!is.null(co["Intercept"]) && !is.na(co["Intercept"]) && is.finite(co["Intercept"])) {
    as.numeric(co["Intercept"])
  } else {
    log(30)
  }
  for (nm in fixed_names) {
    v <- co[nm]
    out[[nm]] <- if (!is.null(v) && !is.na(v) && is.finite(v) && v > 0) as.numeric(v) else PRIOR_MEAN_FLOOR
  }
  out
}

build_priors <- function(means, fixed_names) {
  parts <- list()
  parts[[length(parts) + 1]] <- set_prior("", class = "b", lb = 0)
  for (nm in fixed_names) {
    m <- means[[nm]]
    if (is.null(m)) stop("Missing prior mean for ", nm)
    if (nm == "Intercept") {
      parts[[length(parts) + 1]] <- set_prior(
        sprintf("normal(%f, %f)", m, PRIOR_INTERCEPT_SD), class = "Intercept")
    } else {
      sig <- PRIOR_SIGMAS[[nm]]
      if (is.null(sig)) stop("Missing prior sigma for ", nm)
      parts[[length(parts) + 1]] <- set_prior(
        sprintf("lognormal(%f, %f)", log(max(m, PRIOR_MEAN_FLOOR)), sig),
        class = "b", coef = nm)
    }
  }
  parts[[length(parts) + 1]] <- set_prior("normal(0, 1)", class = "sigma")
  parts[[length(parts) + 1]] <- set_prior("student_t(3, 0, 1)", class = "sd", group = "uid")
  do.call(c, parts)
}

# ── Pull + prepare data once (shared across all per-date fits) ───────────
message("[", format(Sys.time(), tz = "UTC", usetz = TRUE), "] fetching Firebase…")
meta_raw   <- fromJSON(paste0(DB_URL, "/dailyMeta.json"), simplifyVector = FALSE) %||% list()
scores_raw <- fromJSON(paste0(DB_URL, "/daily.json"),     simplifyVector = FALSE) %||% list()
if (length(meta_raw) == 0 || length(scores_raw) == 0) stop("Empty dataset — nothing to backfit.")

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
    time             = map_dbl(entry, ~ .x$time %||% NA_real_),
    uid              = map_chr(entry, ~ .x$uid  %||% NA_character_),
    bombHits         = map_dbl(entry, ~ .x$bombHits %||% 0),
    totalBombPenalty = map_dbl(entry, ~ .x$totalBombPenalty %||% 0),
    bombBaseSum      = map_dbl(entry, ~ {
      ev <- .x$bombHitEvents %||% list()
      if (length(ev) == 0) return(0)
      sum(map_dbl(ev, ~ (.x$penalty %||% 0) - (.x$infoValue %||% 0)))
    }),
    n_hints          = map_int(entry, ~ length(.x$hintEvents %||% list())),
  ) |>
  select(-entry) |>
  filter(!is.na(time), time >= 5, time <= 3600) |>
  filter(n_hints == 0) |>
  mutate(
    is_legacy_bomb = bombHits > 0 & totalBombPenalty == 0,
    clean_time     = time - if_else(totalBombPenalty > 0, bombBaseSum, 0),
    pure_time      = pmax(clean_time - if_else(is_legacy_bomb, LEGACY_BOMB_RATE * bombHits, 0), PURE_TIME_FLOOR),
  )

df <- scores_df |> inner_join(meta, by = "date")

NEW_STRUCTURAL_FEATURES <- c("nonZeroSafeCellCount", "zeroClusterCount")
for (f in NEW_STRUCTURAL_FEATURES) {
  if (!f %in% colnames(df)) df[[f]] <- 0
}
df <- df |>
  mutate(across(
    c(passAMoves, canonicalSubsetMoves, genericSubsetMoves,
      advancedLogicMoves,
      totalMines, cellCount, wallEdgeCount, mysteryCellCount,
      liarCellCount, lockedCellCount, wormholePairCount,
      mirrorPairCount, sonarCellCount, compassCellCount,
      nonZeroSafeCellCount, zeroClusterCount),
    ~ ifelse(is.na(.x), 0, as.numeric(.x))
  ))

# Anti-cheat drop (mirrors isBombHitCheat).
df <- df |> filter(is.na(totalMines) | totalMines <= 0 |
                   (bombHits <= pmax(BOMB_HIT_CHEAT_FLOOR,
                                     BOMB_HIT_CHEAT_FRACTION * totalMines) &
                    bombHits <  BOMB_HIT_EXCAVATED_FRACTION * totalMines))

df <- df |>
  mutate(
    patternMoves = canonicalSubsetMoves + genericSubsetMoves,
    searchMoves  = advancedLogicMoves
  )

# Outlier screen against today's shipped model — one consistent yardstick
# for every retrodicted date.
current_coefs <- parse_par_model(DIFFICULTY_PATH)
df$predicted_for_outlier <- apply_par_model(df, current_coefs)
pre_outlier_n <- nrow(df)
df <- df |> filter(time >= pmax(5, 0.3 * predicted_for_outlier))
if (pre_outlier_n - nrow(df) > 0) {
  message(sprintf("  outlier screen dropped %d row(s)", pre_outlier_n - nrow(df)))
}
df$predicted_for_outlier <- NULL

# Cumulative cutoff key: the board-date prefix (weekly-first keys are
# "{weekStart}_weekly_first" — their prefix is the week start).
df$cut_date <- substr(df$date, 1, 10)

message(sprintf("  prepared: %d rows across %d date keys", nrow(df), n_distinct(df$date)))

# ── Which dates need a fit ───────────────────────────────────────────────
history <- read_history()
history_dates <- sort(unique(vapply(history, function(r) r$date %||% NA_character_, character(1))))
pre_epoch_dates <- history_dates[!is.na(history_dates) & history_dates < SCALE_EPOCH]

has_log <- vapply(pre_epoch_dates, function(d) {
  i <- last_row_index_for_date(history, d)
  !is.na(i) && !is.null(history[[i]]$candidatesLog)
}, logical(1))
missing_dates <- pre_epoch_dates[!has_log]

fixed_names <- c("cellCount", "totalMines", "patternMoves", "searchMoves",
                 "wallEdgeCount", "mysteryCellCount", "liarCellCount",
                 "lockedCellCount", "wormholePairCount", "mirrorPairCount",
                 "sonarCellCount", "compassCellCount", "zeroClusterCount")

todo <- if (!is.null(opt_dates)) {
  str_trim(str_split(opt_dates, ",")[[1]])
} else if (!is.null(opt_shard)) {
  m <- str_match(opt_shard, "^(\\d+)/(\\d+)$")
  if (is.na(m[1, 1])) stop("--shard must look like 1/3")
  k <- as.integer(m[1, 2]); n <- as.integer(m[1, 3])
  missing_dates[seq_along(missing_dates) %% n == (k %% n)]
} else {
  missing_dates
}
if (length(todo) == 0) { message("Nothing to do — every pre-epoch date already has candidatesLog."); quit(status = 0) }

shard_tag <- if (!is.null(opt_shard)) str_replace(opt_shard, "/", "of") else "all"
out_path  <- opt_out %||% sprintf("scripts/backfit-results-%s.json", shard_tag)
message(sprintf("Backfitting %d date(s) → %s", length(todo), out_path))

# Resume: keep any results already in the scratch file.
results <- if (file.exists(out_path)) fromJSON(out_path, simplifyVector = FALSE) else list()
done_dates <- vapply(results, function(r) r$date %||% "", character(1))

fit_formula <- as.formula(paste("log(pure_time) ~",
                                paste(fixed_names, collapse = " + "), "+ (1 | uid)"))

for (D in todo) {
  if (D %in% done_dates) { message(sprintf("[%s] already in scratch — skipped", D)); next }
  t0 <- Sys.time()
  df_D <- df |> filter(cut_date <= D)
  eligible_uids <- df_D |>
    filter(!is.na(uid), uid != "") |>
    count(uid) |>
    filter(n >= MIN_PLAYS_FOR_FIT_INCLUSION) |>
    pull(uid)
  df_fit <- df_D |> filter(uid %in% eligible_uids)
  n_scores <- nrow(df_D)
  n_eligible <- length(eligible_uids)
  if (n_scores < MIN_SCORES_TO_FIT || n_eligible < 2) {
    message(sprintf("[%s] SKIPPED — N=%d, eligible=%d below the fit gates", D, n_scores, n_eligible))
    next
  }

  ols_seeds <- compute_log_ols_seeds(df_fit, fixed_names)
  priors <- build_priors(ols_seeds, c("Intercept", fixed_names))

  fit <- tryCatch(
    brm(fit_formula, data = df_fit, prior = priors,
        chains = N_CHAINS, iter = N_ITER, warmup = N_WARMUP,
        control = list(adapt_delta = ADAPT_DELTA),
        cores = min(N_CHAINS, parallel::detectCores()),
        refresh = 0, silent = 2, seed = 20260422),
    error = function(e) { message(sprintf("[%s] FIT ERROR — %s", D, conditionMessage(e))); NULL }
  )
  if (is.null(fit)) next

  post_summary <- posterior::summarise_draws(as_draws_array(fit), c("mean", "rhat", "ess_bulk"))
  diverge <- sum(nuts_params(fit)$Value[nuts_params(fit)$Parameter == "divergent__"])
  total_draws <- N_CHAINS * (N_ITER - N_WARMUP)
  diag_note <- sprintf("max Rhat = %.3f, min ESS = %.0f, divergent = %d/%d",
                       max(post_summary$rhat, na.rm = TRUE),
                       min(post_summary$ess_bulk, na.rm = TRUE),
                       diverge, total_draws)
  if (any(post_summary$rhat > 1.05, na.rm = TRUE) ||
      any(post_summary$ess_bulk < 400, na.rm = TRUE) ||
      (diverge / total_draws) > MAX_DIVERGENT_FRAC) {
    message(sprintf("[%s] DIAGNOSTICS FAILED (%s) — no candidatesLog for this date", D, diag_note))
    next
  }

  fe <- fixef(fit)
  tc <- data.frame(
    feature   = TARGET_WHITELIST,
    post_mean = fe[TARGET_WHITELIST, "Estimate"],
    post_sd   = fe[TARGET_WHITELIST, "Est.Error"],
    stringsAsFactors = FALSE
  )
  tc$cv <- tc$post_sd / pmax(abs(tc$post_mean), 0.01)
  tc <- tc[order(-tc$cv), ]

  res <- list(
    date = D,
    candidatesLog = lapply(seq_len(nrow(tc)), function(i) {
      list(
        feature = tc$feature[i],
        mean    = round(tc$post_mean[i], 4),
        sd      = round(tc$post_sd[i], 4),
        cv      = round(tc$cv[i], 4)
      )
    }),
    # Provenance for the retrodiction: when it ran, on how much data, and
    # that it passed the same quality bar as a nightly fit.
    candidatesLogFit = list(
      fittedAt    = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
      n_scores    = n_scores,
      n_eligible  = n_eligible,
      diagnostics = diag_note
    )
  )
  results[[length(results) + 1]] <- res
  writeLines(toJSON(results, auto_unbox = TRUE, pretty = TRUE), out_path)
  message(sprintf("[%s] OK — N=%d, eligible=%d, %s (%.1f min)",
                  D, n_scores, n_eligible, diag_note,
                  as.numeric(difftime(Sys.time(), t0, units = "mins"))))
}

message(sprintf("Shard complete — %d result(s) in %s. Fold in with --merge.", length(results), out_path))

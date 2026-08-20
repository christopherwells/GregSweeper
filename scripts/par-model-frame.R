# The par model's fit frame, built once and shared by every decision document.
#
# WHY THIS FILE EXISTS. `par-model-size-offset.qmd` (the M1 / log(cells)
# decision, 2026-08-18) built this frame inline. The next question about the
# model's form needed exactly the same frame, and copying ~110 lines of filter
# logic into a second document would have created precisely the mirror pair
# this codebase keeps getting burned by: the two would agree on the day they
# were written and disagree the first time the pipeline's rules moved. A
# conclusion drawn on a frame that no longer mirrors the refit is worse than
# no conclusion, because it still reads like evidence.
#
# WHAT IT PROMISES. The frame mirrors `scripts/refit-par-model.R` closely
# enough that a conclusion here transfers to the pipeline:
#   - the bomb algebra removes ALL bomb cost from the response, reading the
#     base surcharge from the STORED per-hit events (sum of penalty minus
#     infoValue, never a closed form), with the flat legacy rate for rows that
#     predate the events;
#   - hint rows drop (the Lens survivor filter);
#   - probing rows drop on the pipeline's own two-arm anti-cheat rule;
#   - match rows pool only past MATCH_FIT_THRESHOLD;
#   - the pre-fit outlier screen prices through the CLIENT's own predictPar,
#     so the two languages cannot disagree about the screen;
#   - players below MIN_PLAYS_FOR_FIT_INCLUSION are held out.
# `build_par_frame()` then CHECKS the mirror against the shipped
# modelHistory's own n_scores and stops if the two have parted company.
#
# Archive rows are stored under dailyArchive/, a node nothing here pulls, as
# the pipeline holds them below their own threshold; probe rows are gated at
# the client and never reach daily/. Neither needs a filter.

library(jsonlite)
library(dplyr)
library(purrr)
library(tidyr)

# The refit's own constants (refit-par-model.R). If they drift there, they
# must be followed here, and the crosscheck below is what notices.
DB                          <- "https://gregsweeper-66d02-default-rtdb.firebaseio.com"
MIN_PLAYS_FOR_FIT_INCLUSION <- 5
ARCHIVE_FIT_THRESHOLD       <- 20
MATCH_FIT_THRESHOLD         <- 20
LEGACY_BOMB_RATE            <- 10
PURE_TIME_FLOOR             <- 5
# The two-arm probing filter, calibrated on every row ever submitted (worst
# genuine run 25% of the mines, the three real probing episodes 81/100/100%).
BOMB_HIT_CHEAT_FRACTION     <- 0.50
BOMB_HIT_CHEAT_FLOOR        <- 10
BOMB_HIT_EXCAVATED_FRACTION <- 0.80

num_or <- function(x, d = 0) if (is.null(x)) d else as.numeric(x)

#' Pull daily/ and dailyMeta/, both world-readable by design.
pull_par_data <- function(db = DB) {
  list(
    daily = fromJSON(paste0(db, "/daily.json"), simplifyVector = FALSE),
    meta  = fromJSON(paste0(db, "/dailyMeta.json"), simplifyVector = FALSE)
  )
}

#' One row per score entry, joined to its date's stored feature vector.
#' Every filter here restates a rule in refit-par-model.R.
#'
#' @param raw the list returned by pull_par_data()
#' @param verbose print the screen's drop count and the mirror crosscheck
#' @param max_gap how far this frame may EXCEED the last refit's own row count
#'   before the crosscheck stops. The default covers ordinary append lag. A
#'   caller may widen it, but only with a measured reason written at the call
#'   site, because the whole point of the check is that a diverged frame still
#'   reads like evidence. The one reason measured so far is a change of model
#'   FORM: the screen below prices under whichever model is CURRENTLY shipped,
#'   while the recorded n_scores was produced by a screen pricing under the
#'   model shipped before that refit ran, so on a transition night the two
#'   counts are not comparable. Measured 2026-08-20, the count form's screen
#'   rejected 50 rows and the rate form's rejected 9, off the same 872.
#' @return a list: `df` (all eligible rows) and `df_fit` (fit rows, with
#'   logCells and the per-cell rate columns already derived)
build_par_frame <- function(raw, verbose = TRUE, max_gap = 25) {
  rows <- imap(raw$daily, function(entries, date_key) {
    meta <- raw$meta[[date_key]]
    if (is.null(meta) || is.null(meta$features)) return(NULL)
    f <- meta$features
    imap(entries, function(e, push_id) {
      if (is.null(e$time) || is.null(e$uid)) return(NULL)
      n_bomb  <- num_or(e$bombHits)
      penalty <- num_or(e$totalBombPenalty)
      # The pipeline's own bomb algebra: the base surcharge is read from the
      # stored per-hit events, never recomputed. A legacy row is bombHits > 0
      # with totalBombPenalty == 0, and takes the flat legacy rate instead.
      ev <- if (is.null(e$bombHitEvents)) list() else e$bombHitEvents
      bomb_base <- if (length(ev) == 0) 0 else
        sum(map_dbl(ev, ~ num_or(.x$penalty) - num_or(.x$infoValue)))
      is_legacy <- n_bomb > 0 && penalty == 0
      clean <- num_or(e$time) - if (penalty > 0) bomb_base else 0
      pure  <- max(clean - if (is_legacy) LEGACY_BOMB_RATE * n_bomb else 0,
                   PURE_TIME_FLOOR)
      tibble(
        date = date_key, uid = as.character(e$uid),
        time = num_or(e$time),
        pure_time = pure,
        # The par the player was SHOWN. For a marathon board this is the
        # lane's anchor pricing rather than predictPar, which makes it the
        # incumbent any candidate form has to beat out past the fit ceiling.
        shown_par = num_or(e$par),
        hints = length(if (is.null(e$hintEvents)) list() else e$hintEvents),
        # The board-as-played flag (2026-08-18). ABSENT means a client too old
        # to measure, which is every row before v1.11.14 and is NOT the same
        # claim as FALSE, so it is carried as NA and nothing here models it.
        scrolled = if (is.null(e$scrolled)) NA else as.logical(e$scrolled),
        bombHits = n_bomb,
        matchRow = grepl("^match_", date_key),
        weeklyFirst = grepl("_weekly_first$", date_key),
        cellCount = num_or(f$cellCount, num_or(f$rows) * num_or(f$cols)),
        totalMines = num_or(f$totalMines),
        passAMoves = num_or(f$passAMoves),
        patternMoves = num_or(f$canonicalSubsetMoves) + num_or(f$genericSubsetMoves),
        searchMoves = num_or(f$advancedLogicMoves),
        wallEdgeCount = num_or(f$wallEdgeCount),
        zeroClusterCount = num_or(f$zeroClusterCount),
        mysteryCellCount = num_or(f$mysteryCellCount),
        liarCellCount = num_or(f$liarCellCount),
        lockedCellCount = num_or(f$lockedCellCount),
        wormholePairCount = num_or(f$wormholePairCount),
        mirrorPairCount = num_or(f$mirrorPairCount),
        sonarCellCount = num_or(f$sonarCellCount),
        compassCellCount = num_or(f$compassCellCount),
        wormLoad = num_or(f$wormLoad),
        tilingType = if (is.null(f$tilingType)) "rect" else as.character(f$tilingType)
      )
    }) |> compact() |> bind_rows()
  }) |> compact() |> bind_rows()

  df <- rows |>
    filter(hints == 0) |>
    mutate(matchPlay = as.integer(matchRow), archivePlay = 0L)
  if (sum(df$matchRow) < MATCH_FIT_THRESHOLD) df <- df |> filter(!matchRow)

  # The anti-cheat filter, which this frame lacked until 2026-08-20 and which
  # the crosscheck below could not see, because the screen's own gap was
  # larger. Measured that day: two probing rows survived into the frame and
  # into every plot drawn from it. Both arms restate refit-par-model.R.
  n_pre_cheat <- nrow(df)
  df <- df |> filter(is.na(totalMines) | totalMines <= 0 |
                     (bombHits <= pmax(BOMB_HIT_CHEAT_FLOOR,
                                       BOMB_HIT_CHEAT_FRACTION * totalMines) &
                      bombHits <  BOMB_HIT_EXCAVATED_FRACTION * totalMines))
  if (verbose && n_pre_cheat > nrow(df)) {
    cat("anti-cheat dropped", n_pre_cheat - nrow(df), "probing row(s)", fill = TRUE)
  }

  # The pre-fit outlier screen: reject rows with time below
  # max(5, 0.3 x predicted par) under the CURRENTLY SHIPPED model, priced
  # through the client's own predictPar so the screen has one definition.
  tmp_in <- tempfile(fileext = ".json"); tmp_out <- tempfile(fileext = ".json")
  df |> select(cellCount, totalMines, patternMoves, searchMoves, wallEdgeCount,
               mysteryCellCount, liarCellCount, lockedCellCount,
               wormholePairCount, mirrorPairCount, sonarCellCount,
               compassCellCount, zeroClusterCount, wormLoad, tilingType) |>
    toJSON(auto_unbox = TRUE) |> writeLines(tmp_in)
  system2("node", c("predict-par-bridge.mjs", tmp_in, tmp_out))
  pred <- fromJSON(tmp_out)
  stopifnot(length(pred) == nrow(df))
  pre_n <- nrow(df)
  df_all <- df |> mutate(predicted = pred, screenFloor = pmax(5, 0.3 * predicted))
  df_screened_out <- df_all |> filter(time < screenFloor)
  df <- df_all |> filter(time >= screenFloor)
  if (verbose) cat("outlier screen dropped", pre_n - nrow(df), "row(s)", fill = TRUE)

  n_scores_here <- nrow(df)
  eligible <- df |> count(uid) |> filter(n >= MIN_PLAYS_FOR_FIT_INCLUSION) |> pull(uid)
  df_fit <- df |> filter(uid %in% eligible) |>
    mutate(
      logCells = log(cellCount),
      # The rate columns. Every one of these is a count that grows with the
      # BOARD rather than with a decision the player makes, which is the whole
      # hypothesis under test.
      patternRate = patternMoves / cellCount,
      searchRate  = searchMoves / cellCount,
      passARate   = passAMoves / cellCount,
      mineRate    = totalMines / cellCount
    )

  # CHECK: the mirror is honest. daily/ is append-only, so this frame may
  # EXCEED the refit's by whatever landed since its pull (a finished Challenge
  # match posts its whole batch at once), but may never sit UNDER it, which
  # would mean a filter here has diverged from the pipeline.
  hist_raw <- fromJSON(file.path("..", "src", "logic", "modelHistory.json"),
                       simplifyVector = FALSE)
  latest <- hist_raw[[length(hist_raw)]]
  stopifnot(!is.null(latest$n_scores))
  gap <- n_scores_here - as.numeric(latest$n_scores)
  if (verbose) {
    cat("modelHistory n_scores:", latest$n_scores,
        " | this frame:", n_scores_here, " | gap:", gap, fill = TRUE)
  }
  stopifnot(gap >= 0, gap <= max_gap)

  # `screened_out` rides the return because a screen priced off a broken
  # extrapolation can refuse REAL data, and a document that only ever sees the
  # survivors cannot notice. Measured 2026-08-20: the screen refused six of
  # the ten marathon rows, on boards where predicted par is 16,000 seconds and
  # the floor therefore sits near 5,000, against honest plays of 658 to 1,321.
  # Carrying them lets a holdout test ask the one question that matters, which
  # is whether a candidate form can price a board it never saw.
  add_rate_cols <- function(d) d |>
    mutate(logCells = log(cellCount),
           patternRate = patternMoves / cellCount,
           searchRate = searchMoves / cellCount,
           passARate = passAMoves / cellCount,
           mineRate = totalMines / cellCount)
  list(df = df, df_fit = df_fit, screened_out = add_rate_cols(df_screened_out),
       n_scores = n_scores_here, eligible = eligible)
}

#' The shape indicator columns, rect absorbed into the intercept.
#'
#' Shape enters every fit as plain columns so that lattice cell counts cannot
#' masquerade as a size effect: lattices are the small-cell-count boards, and
#' without shape terms a size coefficient soaks up their intercept differences.
add_shape_columns <- function(df_fit) {
  shape_cols <- df_fit |>
    mutate(one = 1L) |>
    pivot_wider(names_from = tilingType, values_from = one,
                values_fill = 0L, names_prefix = "shape_") |>
    select(starts_with("shape_"), -any_of("shape_rect"))
  list(df = bind_cols(df_fit, shape_cols), names = names(shape_cols))
}

#' The gimmick and structure predictors every candidate form shares.
#' These are PLACED counts, not quantities derived from board area, so they
#' stay counts in every form under test.
shared_terms <- function(df, shape_names) {
  terms <- c("wallEdgeCount", "mysteryCellCount", "liarCellCount",
             "lockedCellCount", "wormholePairCount", "mirrorPairCount",
             "sonarCellCount", "compassCellCount", "zeroClusterCount")
  if (any(df$wormLoad > 0)) terms <- c(terms, "wormLoad")
  if (length(unique(df$archivePlay)) > 1) terms <- c(terms, "archivePlay")
  if (length(unique(df$matchPlay)) > 1) terms <- c(terms, "matchPlay")
  c(terms, shape_names)
}

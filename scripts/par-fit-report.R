# Build the data behind the par-model fit report.
#
# WHY THIS EXISTS. Every judgment about the par model's form on 2026-08-20 was
# reported in prose: the count form pricing a 660-cell board at hours, the rate
# form missing by 1.3x on held-out big boards where the count form missed by
# 23.9x, the outlier screen refusing real rows. Prose is not checkable. This
# script re-derives each of those numbers from the live data and writes them as
# one JSON bundle, so the claims can be looked at rather than taken.
#
# It CHANGES NOTHING. No file in src/ is touched, no model is patched, nothing
# is pushed. It reads Firebase, fits, and writes one JSON file.
#
#   Rscript par-fit-report.R [out.json] [count-form-repo]
#
# `count-form-repo` is optional: a path to a checkout whose src/logic still
# carries the COUNT form, which on 2026-08-20 means main. Given one, the
# script also prices every row through that client's own predictPar and reports
# what the outlier screen did under each form. Without one, those fields are
# written as null and the report says the comparison was not run, rather than
# quietly dropping the panel.
#
# Runtime is dominated by four brms fits (two forms, each on the full frame and
# again on a training subset for the holdout test). Expect several minutes.

source("par-model-frame.R")
library(brms)
library(loo)

args       <- commandArgs(trailingOnly = TRUE)
OUT        <- if (length(args) >= 1) args[[1]] else "par-fit-report.json"
COUNT_REPO <- if (length(args) >= 2) args[[2]] else NA_character_

# ---- The frame -------------------------------------------------------------
# max_gap is widened from its default 25 with the reason measured rather than
# assumed. The recorded n_scores (822) was produced by a screen pricing under
# the COUNT form; this frame's screen prices under whatever is shipped now.
# Reproduced 2026-08-20 by re-running the pipeline's own frame section against
# each coefficient block: the count form rejected 50 rows and abstained on 8,
# landing exactly on 822; the rate form rejects 9. The gap is the screen, not a
# filter that has drifted.
raw    <- pull_par_data()
frame  <- build_par_frame(raw, max_gap = 60)
df_fit <- frame$df_fit

MARATHON_CELLS <- 400   # nothing between 187 and 638 cells has ever been played
TRAIN_CELLS    <- 250   # the holdout's training ceiling

sh     <- add_shape_columns(df_fit)
d      <- sh$df
shared <- shared_terms(d, sh$names)

# ---- The two forms ---------------------------------------------------------
# M1 is what shipped to players until 2026-08-20: move counts and mine counts
# enter raw, and size is carried by a linear and a log term together.
f_m1 <- as.formula(paste(
  "log(pure_time) ~ cellCount + logCells + totalMines + patternMoves + searchMoves +",
  paste(shared, collapse = " + "), "+ (1|uid)"))

# R1 divides every count that grows with board AREA by the board, so size is
# carried once, by log(cells), and the move terms describe per-cell difficulty.
f_r1 <- as.formula(paste(
  "log(pure_time) ~ logCells + mineRate + patternRate + searchRate +",
  paste(shared, collapse = " + "), "+ (1|uid)"))

# adapt_delta is 0.99 rather than the pipeline's 0.95. At 0.95 the rate form's
# full-frame fit produced 145 divergent transitions in 4000 draws (3.6%), which
# is fourteen times the 0.25% at which the pipeline rejects a fit outright, and
# its interval estimates could not have been quoted. Raising the target
# acceptance rate is Stan's own remedy for that, not a loosened standard: the
# diagnostics below are collected per fit and reported on the page, so whether
# it worked is visible rather than asserted.
ADAPT_DELTA <- 0.99
FIT <- function(f, data = d) brm(
  f, data = data, family = gaussian(), chains = 4, iter = 2000, cores = 4,
  seed = 20260820, control = list(adapt_delta = ADAPT_DELTA), refresh = 0)

# Divergences, worst Rhat and worst bulk ESS for one fit. A fit that fails here
# is reported as failing rather than quietly used.
diagnose <- function(m, label) {
  np  <- brms::nuts_params(m)
  div <- sum(np$Value[np$Parameter == "divergent__"])
  su  <- summary(m)
  blk <- rbind(su$fixed, su$spec_pars,
               if (!is.null(su$random$uid)) su$random$uid else NULL)
  draws <- nrow(as.matrix(m))
  list(fit = label, divergent = div, draws = draws,
       divergentPct = 100 * div / draws,
       maxRhat = max(blk[, "Rhat"], na.rm = TRUE),
       minBulkESS = min(blk[, "Bulk_ESS"], na.rm = TRUE),
       minTailESS = min(blk[, "Tail_ESS"], na.rm = TRUE))
}

message("fitting M1 (count form) on ", nrow(d), " rows...")
m_m1 <- FIT(f_m1)
message("fitting R1 (rate form) on ", nrow(d), " rows...")
m_r1 <- FIT(f_r1)

# ---- The holdout: price a board four times larger than anything you saw ----
# In-sample fit rewards a form for describing boards already in the data.
# Neither that nor LOO asks the question the marathon lane poses. So: refit on
# small boards only, then predict the big ones, INCLUDING any the screen threw
# out, since those are exactly the rows a broken extrapolation censors.
train <- d |> filter(cellCount <= TRAIN_CELLS)
held  <- bind_rows(df_fit |> filter(cellCount > MARATHON_CELLS),
                   frame$screened_out |> filter(cellCount > MARATHON_CELLS))
for (sc in sh$names) held[[sc]] <- as.integer(paste0("shape_", held$tilingType) == sc)

message("holdout: training on ", nrow(train), " rows up to ", max(train$cellCount),
        " cells, predicting ", nrow(held), " rows of ",
        paste(range(held$cellCount), collapse = "-"), " cells")
h_m1 <- update(m_m1, newdata = train, refresh = 0)
h_r1 <- update(m_r1, newdata = train, refresh = 0)

# Population-level prediction: Greg's clean par for the board, with no player
# offset, which is the quantity par actually is.
pred_pop <- function(m, nd) exp(fitted(m, newdata = nd, re_formula = NA,
                                       allow_new_levels = TRUE)[, "Estimate"])

# ---- What the outlier screen did, under each form --------------------------
# Priced through each client's OWN predictPar, so an R-side re-implementation
# cannot disagree with the shipped model about what a board is worth.
SCORE_MAX_SECONDS <- 3600   # the score validator's ceiling; the abstention bound

price_through <- function(repo, rows) {
  if (is.na(repo)) return(rep(NA_real_, nrow(rows)))
  tin <- tempfile(fileext = ".json"); tout <- tempfile(fileext = ".json")
  rows |> select(cellCount, totalMines, patternMoves, searchMoves, wallEdgeCount,
                 mysteryCellCount, liarCellCount, lockedCellCount, wormholePairCount,
                 mirrorPairCount, sonarCellCount, compassCellCount, zeroClusterCount,
                 wormLoad, tilingType) |>
    toJSON(auto_unbox = TRUE) |> writeLines(tin)
  owd <- setwd(file.path(repo, "scripts")); on.exit(setwd(owd), add = TRUE)
  system2("node", c("predict-par-bridge.mjs", shQuote(tin), shQuote(tout)))
  fromJSON(tout)
}

all_rows <- bind_rows(frame$df, frame$screened_out)
all_rows$countPar <- price_through(COUNT_REPO, all_rows)

# A row priced believably whose time falls under a third of that price is
# REFUSED. Where the price itself sits past the score validator's own ceiling
# there is no usable floor to compare against, and the verdict is ABSTAIN.
# Both are reported per form, so the difference is visible rather than argued.
screen_verdict <- function(par, time) {
  ifelse(is.na(par), NA_character_,
         ifelse(par > SCORE_MAX_SECONDS, "abstain",
                ifelse(time < pmax(5, 0.3 * par), "refuse", "keep")))
}
all_rows$countVerdict <- screen_verdict(all_rows$countPar, all_rows$time)
all_rows$rateVerdict  <- screen_verdict(all_rows$predicted, all_rows$time)

# ---- Assemble --------------------------------------------------------------
# One point per BOARD for the coverage panel: a board played by two people is
# one board, and plotting it twice would overstate how much of the space has
# been reached.
boards <- frame$df |>
  group_by(date) |>
  summarize(shape = first(tilingType), cells = first(cellCount),
            mines = first(totalMines), plays = n(),
            kind = if (first(matchRow)) "match" else
                   if (first(weeklyFirst)) "weekly" else "daily",
            .groups = "drop") |>
  mutate(mineRate = mines / cells, marathon = cells > MARATHON_CELLS)

# Per-player: volume, the shipped handicap, and how each form partitions the
# same players, since a change of form re-partitions every rating.
k_of <- function(m) {
  r <- ranef(m)$uid[, "Estimate", "Intercept"]
  w <- df_fit |> count(uid) |> arrange(match(uid, names(r))) |> pull(n)
  exp(r - sum(r * w) / sum(w))
}
k_m1 <- k_of(m_m1)
k_r1 <- k_of(m_r1)
hc   <- fromJSON(file.path("..", "src", "logic", "handicaps.json"))

# The display name a player last submitted under, read from the raw rows.
name_for <- function(u) {
  for (entries in raw$daily) for (e in entries) {
    if (!is.null(e$uid) && e$uid == u && !is.null(e$name)) return(as.character(e$name))
  }
  "unknown"
}

players <- tibble(
  uid    = names(k_m1),
  plays  = df_fit |> count(uid) |> arrange(match(uid, names(k_m1))) |> pull(n),
  kCount = as.numeric(k_m1),
  kRate  = as.numeric(k_r1)
) |>
  mutate(kShipped = vapply(uid, function(u) {
           v <- hc$handicaps[[u]]; if (is.null(v)) NA_real_ else as.numeric(v)
         }, numeric(1)),
         name = vapply(uid, name_for, character(1)))

# Residual trend across size. The defect that motivated the change would show
# as a slope here, so the bins carry their counts and nothing is smoothed: the
# top bins are small and the panel has to say so.
brks <- c(0, 60, 90, 120, 160, 200, MARATHON_CELLS, Inf)
resid_bins <- d |>
  mutate(rM1 = residuals(m_m1)[, "Estimate"], rR1 = residuals(m_r1)[, "Estimate"],
         bin = cut(cellCount, breaks = brks, dig.lab = 5)) |>
  group_by(bin) |>
  summarize(n = n(), lo = min(cellCount), hi = max(cellCount),
            residCount = mean(rM1), residRate = mean(rR1), .groups = "drop") |>
  mutate(bin = as.character(bin))

big_end <- held |>
  transmute(board = date, shape = tilingType, cells = cellCount, mines = totalMines,
            uid = uid, played = pure_time, rawTime = time,
            # `par` is absent on some stored rows. 0 means ABSENT, never a
            # prediction of zero, so it is carried as NA and every consumer
            # has to decide what to do about it rather than plotting it.
            lane = ifelse(shown_par > 0, shown_par, NA_real_),
            countHoldout = pred_pop(h_m1, held),    # never saw a board past 250 cells
            rateHoldout  = pred_pop(h_r1, held)) |>
  arrange(desc(cells), desc(mines))

# The row count the LAST refit actually fitted. `frame$n_scores` is this
# frame's own count, not that one, and reporting it as the refit's would have
# put a false number on the page.
hist_rows <- fromJSON(file.path("..", "src", "logic", "modelHistory.json"),
                      simplifyVector = FALSE)
recorded_refit_n <- as.numeric(hist_rows[[length(hist_rows)]]$n_scores)
recorded_refit_at <- as.character(hist_rows[[length(hist_rows)]]$updatedAt)

ci <- function(m, rows) {
  f <- fixef(m); k <- intersect(rows, rownames(f))
  tibble(term = k, est = f[k, "Estimate"], lo = f[k, "Q2.5"], hi = f[k, "Q97.5"])
}
sig <- function(m) as.numeric(summary(m)$spec_pars["sigma", "Estimate"])
lc  <- loo_compare(loo(m_m1), loo(m_r1))

# Median absolute error in LOG space: being ten times too slow and ten times
# too fast count as the same size of mistake, which is the honest metric on a
# quantity spanning four orders of magnitude.
miss <- function(pred, actual) exp(median(abs(log(pred / actual))))

bundle <- list(
  meta = list(
    generatedFor     = as.character(Sys.Date()),
    nRowsJoined      = nrow(frame$df) + nrow(frame$screened_out),
    nRowsAfterScreen = nrow(frame$df),
    nScreenedOut     = nrow(frame$screened_out),
    nFitRows         = nrow(df_fit),
    nEligiblePlayers = length(frame$eligible),
    nPlayersAll      = n_distinct(frame$df$uid),
    nBoards          = nrow(boards),
    frameScreenedN   = frame$n_scores,
    recordedRefitN   = recorded_refit_n,
    recordedRefitAt  = recorded_refit_at,
    cellRange        = range(df_fit$cellCount),
    marathonCells    = MARATHON_CELLS,
    trainCells       = TRAIN_CELLS,
    countRepoUsed    = !is.na(COUNT_REPO),
    # `scrolled` is written on no row yet, so nothing here models it. Counted
    # so the report can state the field is empty rather than omit it.
    nScrolledStated  = sum(!is.na(frame$df$scrolled))
  ),
  boards  = boards,
  rows    = frame$df |> transmute(uid, shape = tilingType, cells = cellCount,
                                  mines = totalMines, played = pure_time, time,
                                  shippedPar = predicted,
                                  marathon = cellCount > MARATHON_CELLS),
  players = players,
  # Row counts for EVERY player in the frame. The fit only estimates an offset
  # for those clearing MIN_PLAYS_FOR_FIT_INCLUSION, and a panel that silently
  # dropped the others would overstate how complete the picture is.
  allPlayers = frame$df |> count(uid, name = "rows") |>
    mutate(eligible = uid %in% frame$eligible,
           name = vapply(uid, name_for, character(1))) |>
    arrange(desc(rows)),
  bigEnd  = big_end,
  bigEndMiss = list(
    # The lane's miss is measured only over rows that actually carry a par.
    lane        = miss(big_end$lane[!is.na(big_end$lane)],
                       big_end$played[!is.na(big_end$lane)]),
    nLaneStated = sum(!is.na(big_end$lane)),
    countForm   = miss(big_end$countHoldout, big_end$played),
    rateForm    = miss(big_end$rateHoldout, big_end$played),
    nHeld       = nrow(big_end),
    nTrain      = nrow(train),
    trainMaxCells = max(train$cellCount)
  ),
  residBins = resid_bins,
  screen = list(
    countRefused = sum(all_rows$countVerdict == "refuse", na.rm = TRUE),
    countAbstain = sum(all_rows$countVerdict == "abstain", na.rm = TRUE),
    rateRefused  = sum(all_rows$rateVerdict == "refuse", na.rm = TRUE),
    rateAbstain  = sum(all_rows$rateVerdict == "abstain", na.rm = TRUE),
    marathonRows = sum(all_rows$cellCount > MARATHON_CELLS),
    # Geometry, independent of the abstention rule: how often each form's floor
    # sits above the time actually played. This is what the screen did before
    # the abstention rule was added on 2026-08-20, and it is what the rule now
    # rescues rather than refuses.
    countFloorAbovePlay = sum(all_rows$time < pmax(5, 0.3 * all_rows$countPar), na.rm = TRUE),
    rateFloorAbovePlay  = sum(all_rows$time < pmax(5, 0.3 * all_rows$predicted), na.rm = TRUE),
    marathonCountFloorAbove = sum((all_rows$time < pmax(5, 0.3 * all_rows$countPar))[all_rows$cellCount > MARATHON_CELLS], na.rm = TRUE),
    marathonRateFloorAbove  = sum((all_rows$time < pmax(5, 0.3 * all_rows$predicted))[all_rows$cellCount > MARATHON_CELLS], na.rm = TRUE),
    marathonCountRefused = sum(all_rows$countVerdict[all_rows$cellCount > MARATHON_CELLS] == "refuse", na.rm = TRUE),
    detail = all_rows |> filter(cellCount > MARATHON_CELLS) |>
      transmute(board = date, cells = cellCount, mines = totalMines, time,
                countPar, ratePar = predicted,
                countFloor = pmax(5, 0.3 * countPar),
                rateFloor  = pmax(5, 0.3 * predicted),
                countVerdict, rateVerdict)
  ),
  fitQuality = list(
    sigmaCount = sig(m_m1), sigmaRate = sig(m_r1),
    looDiff = as.numeric(lc[2, "elpd_diff"]), looSE = as.numeric(lc[2, "se_diff"]),
    looBetter = rownames(lc)[1]
  ),
  diagnostics = list(
    adaptDelta = ADAPT_DELTA,
    # The pipeline rejects a fit above this; the same bar is applied here.
    divergentRejectPct = 0.25,
    fits = list(diagnose(m_m1, "count form, full frame"),
                diagnose(m_r1, "rate form, full frame"),
                diagnose(h_m1, "count form, holdout training set"),
                diagnose(h_r1, "rate form, holdout training set"))
  ),
  rateCoefs  = ci(m_r1, c("logCells", "mineRate", "patternRate", "searchRate")),
  countCoefs = ci(m_m1, c("logCells", "cellCount", "totalMines", "patternMoves", "searchMoves"))
)

write(toJSON(bundle, auto_unbox = TRUE, digits = 6, na = "null"), OUT)
message("wrote ", OUT)

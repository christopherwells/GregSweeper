# One-off: seed PAR_MODEL_SHAPES in src/logic/difficulty.js with the Par Lab
# prior centers (Christopher's 2026-08-03 seeding ruling — see the rulings
# block in scripts/refit-par-model.R beside LAB_PRIORS_PATH).
#
# Composes each shape block as the CURRENT shipped PAR_MODEL base plus that
# shape's lab deviation centers (terms with >= LAB_SEED_MIN_ROWS lab rows;
# the n=1 gimmick cells stay at zero per his ruling), and splices the result
# between the PAR_MODEL_SHAPES markers. The block text is built by the
# nightly refit's OWN emitter — this script extracts and evals the
# EMITTER:START/END region of refit-par-model.R — so the bytes written here
# are the bytes the next nightly fit would write for the same values, and
# the first post-seed refit produces no spurious formatting diff.
#
# Re-runnable: composing base + centers is idempotent for a fixed base, and
# the nightly recomposes the blocks from the same JSON every fit night
# anyway. This script exists so the seeding could land reviewed in a PR
# rather than waiting for the next nightly to write it unattended.
#
# Run from the repo root: Rscript scripts/seed-par-model-shapes.R

suppressPackageStartupMessages({
  library(jsonlite)
  library(stringr)
})

`%||%` <- function(a, b) if (is.null(a)) b else a

DIFFICULTY_PATH   <- "src/logic/difficulty.js"
REFIT_PATH        <- "scripts/refit-par-model.R"
LAB_PRIORS_PATH   <- "scripts/data/parlab-prior-centers.json"
LAB_SEED_MIN_ROWS <- 5   # mirrors refit-par-model.R

# Mirrors of the refit's two registry tables (the contract test pins the
# real ones; these exist because sourcing the whole refit runs its pipeline).
COEF_TO_PREDICTOR <- c(
  secPerCell         = "cellCount",
  secPerMineFlag     = "totalMines",
  secPerPatternMove  = "patternMoves",
  secPerSearchMove   = "searchMoves",
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
SHAPE_TABLE <- c(
  "4.8.8"     = "shape488",
  "hex"       = "shapeHex",
  "cairo"     = "shapeCairo",
  "floret"    = "shapeFloret",
  "rhombille" = "shapeRhombille",
  "deltoidal" = "shapeDeltoidal"
)

# ── The shipped base model ──────────────────────────────────────────────
src <- paste(readLines(DIFFICULTY_PATH, warn = FALSE, encoding = "UTF-8"),
             collapse = "\n")
bs <- str_locate(src, fixed("// PAR_MODEL:START"))[1, "end"]
be <- str_locate(src, fixed("// PAR_MODEL:END"))[1, "start"]
stopifnot(!is.na(bs), !is.na(be))
kv <- str_match_all(substr(src, bs + 1, be - 1),
                    "(\\w+)\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)")[[1]]
base <- setNames(as.list(as.numeric(kv[, 3])), kv[, 2])
stopifnot(all(c("intercept", names(COEF_TO_PREDICTOR)) %in% names(base)))

# ── The lab centers (seeded terms only) ─────────────────────────────────
lab <- fromJSON(LAB_PRIORS_PATH, simplifyVector = FALSE)
seed_devs <- list()
for (nm in names(lab$deviations %||% list())) {
  d <- lab$deviations[[nm]]
  if ((d$nRows %||% 0) >= LAB_SEED_MIN_ROWS) {
    seed_devs[[nm]] <- as.numeric(d$mean)
  }
}
stopifnot(length(seed_devs) > 0)
message(sprintf("lab centers: %d seeded terms (of %d in the file; the rest are n=1 observation cells)",
                length(seed_devs), length(lab$deviations)))

# ── The nightly's own emitter, extracted and evaled ─────────────────────
r_src <- paste(readLines(REFIT_PATH, warn = FALSE, encoding = "UTF-8"),
               collapse = "\n")
es <- str_locate(r_src, fixed("# EMITTER:START"))[1, "end"]
ee <- str_locate(r_src, fixed("# EMITTER:END"))[1, "start"]
stopifnot(!is.na(es), !is.na(ee))
eval(parse(text = substr(r_src, es + 1, ee - 1)))

# ── Compose and splice ──────────────────────────────────────────────────
shape_models <- list()
for (js_key in names(SHAPE_TABLE)) {
  stem <- SHAPE_TABLE[[js_key]]
  blk <- list(intercept = base$intercept + (seed_devs[[stem]] %||% 0))
  for (k in names(COEF_TO_PREDICTOR)) {
    blk[[k]] <- base[[k]] + (seed_devs[[paste0(stem, "_x_", COEF_TO_PREDICTOR[[k]])]] %||% 0)
  }
  shape_models[[js_key]] <- blk
  message(sprintf("  %-9s intercept %+0.5f | per-cell %+0.5f | per-mine %+0.5f (deviations)",
                  js_key, seed_devs[[stem]] %||% 0,
                  seed_devs[[paste0(stem, "_x_cellCount")]] %||% 0,
                  seed_devs[[paste0(stem, "_x_totalMines")]] %||% 0))
}

shapes_header <- c(
  sprintf("Seeded %s from the Par Lab prior fit: PAR_MODEL base + lab deviation", Sys.Date()),
  "centers (scripts/data/parlab-prior-centers.json; scripts/fit-parlab-priors.qmd;",
  "the 2026-08-03 seeding ruling). The nightly refit recomposes this block on",
  "every fit night: fitted posterior where live rows exist, the lab center",
  "where none do, 0 for unseeded terms until they earn out."
)
shapes_block <- emit_shape_models_block("PAR_MODEL_SHAPES", shapes_header,
                                        lapply(shape_models, ordered_model_fields))
new_src <- patch_js_markers(src, "// PAR_MODEL_SHAPES:START",
                            "// PAR_MODEL_SHAPES:END", shapes_block)

if (identical(new_src, src)) {
  message("PAR_MODEL_SHAPES already carries these values — nothing to write.")
} else {
  writeLines(new_src, DIFFICULTY_PATH, useBytes = TRUE)
  message(sprintf("Wrote lab-seeded PAR_MODEL_SHAPES to %s", DIFFICULTY_PATH))
}

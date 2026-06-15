// ── Solvability Checker ─────────────────────────────────────
// Multi-layer constraint solver that verifies a board can be completed
// without guessing (or with at most minimal guessing).
//
// Layers:
//   A. Simple constraint propagation (all-mine / all-safe rules)
//   B. Pairwise subset/superset analysis
//   C. Advanced solver (Gauss elimination + tank/partition enumeration)

import { solveConstraints } from './constraintSolver.js';
import { hasWallBetween } from './gimmicks.js';

// Sentinel: cell provides no usable number info to the solver
const UNKNOWN = 255;

// Returns the EXACT mine count a smart player can read from this cell.
// Returns UNKNOWN when the player can only deduce a range or set of values:
//   - mystery/sonar/compass/wormhole: hide or aggregate count, no per-cell exact constraint
//   - liar: display is true count ± 1, so it's one of two values, not a single number
//     (the disjunctive constraint is emitted separately in buildLiarConstraints)
// Mirror cells display the partner's count for visual deception; a player who
// recognises the pair can mentally un-swap and reason with the cell's TRUE
// adjacency (cell.adjacentMines).
//
// `stripGimmicks` (Set<string>) lets callers ask "what could the player solve
// without info from these gimmick types?" — used by the load-bearing check
// in candidate selection. When mirror is stripped the player loses the un-
// swap deduction and the cell becomes UNKNOWN.
function getPlayerVisibleCount(cell, stripGimmicks) {
  if (cell.isMystery || cell.isSonar || cell.isCompass || cell.isWormhole) return UNKNOWN;
  if (cell.isLiar) return UNKNOWN;
  if (cell.mirrorPair && stripGimmicks && stripGimmicks.has('mirror')) return UNKNOWN;
  return cell.adjacentMines;
}

// True when this cell contributes a "value is X-1 OR X+1" constraint to the
// solver (plain liar, possibly stacked with locked). Liar combined with a
// base-value or display-blocking gimmick produces too tangled a deduction
// path to model precisely — those cells contribute nothing.
//
// When 'liar' is in `stripGimmicks`, no liar disjunctive constraints fire at
// all (the load-bearing test for liar).
function isPureLiar(cell, stripGimmicks) {
  if (stripGimmicks && stripGimmicks.has('liar')) return false;
  return cell.isLiar
    && !cell.isMystery && !cell.isSonar && !cell.isCompass
    && !cell.isWormhole && !cell.mirrorPair;
}

/**
 * Pre-compute wall-aware neighbor lists for every cell.
 * Reuse across multiple isBoardSolvable() calls on the same board
 * to avoid redundant O(rows*cols*8) computation.
 */
export function buildNeighborCache(board, rows, cols) {
  const wallEdges = board._wallEdges || null;
  const cache = new Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const nbrs = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr;
          const nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
            if (wallEdges && hasWallBetween(wallEdges, r, c, nr, nc)) continue;
            nbrs.push(nr * cols + nc);
          }
        }
      }
      cache[r * cols + c] = nbrs;
    }
  }
  return cache;
}

/**
 * Check if a Minesweeper board is solvable without guessing.
 * Works on a simulation — does NOT mutate the original board.
 *
 * @param {Array<Array<Object>>} board  - 2D array of cell objects
 * @param {number} rows                 - board height
 * @param {number} cols                 - board width
 * @param {number} safeRow              - first click row
 * @param {number} safeCol              - first click column
 * @param {Array} [preNeighborCache]    - optional pre-built neighbor cache from buildNeighborCache()
 * @returns {{
 *   solvable: boolean,
 *   remainingUnknowns: number,
 *   totalClicks: number,
 *   techniqueLevel: 0 | 1 | 2 | 3,
 *   passAMoves: number,
 *   canonicalSubsetMoves: number,
 *   genericSubsetMoves: number,
 *   advancedLogicMoves: number,
 *   disjunctiveMoves: number,
 * }}
 *
 * Invariant (for solvable boards): passA + canonicalSubset + genericSubset +
 * advancedLogic + disjunctive + 1 === totalClicks (the +1 accounts for the
 * first click, which is a setup action, not a deduction).
 */
export function isBoardSolvable(board, rows, cols, safeRow, safeCol, preNeighborCache, options) {
  // Optional: callers can pass `{ stripGimmicks: ['liar', 'mirror', ...] }`
  // to ask "could the board be solved if these gimmick types contributed
  // nothing?" — the basis of the load-bearing filter in candidate selection.
  const stripGimmicks = options && options.stripGimmicks
    ? (options.stripGimmicks instanceof Set ? options.stripGimmicks : new Set(options.stripGimmicks))
    : null;

  // Reveal gating: sonar / compass / wormhole constraints are available
  // only once their number is on screen — the origin cell revealed (for
  // wormhole: either endpoint, both display the pair sum). Without the
  // gate the certifier can rely on a clue the player cannot SEE yet (a
  // fogged gimmick cell displays nothing), weakening the no-guess
  // guarantee on gimmick boards. The default comes from the BOARD's own
  // contract flag (`board._gatedCert`, stamped by createEmptyBoard and
  // carried through canonical payloads and game saves), so historical
  // boards certified ungated keep their original contract and newly
  // generated boards are certified gated — on every solver surface,
  // automatically. `options.gateGimmickOrigins` overrides for
  // measurement tooling.
  const gateGimmickOrigins = options && options.gateGimmickOrigins !== undefined
    ? !!options.gateGimmickOrigins
    : !!(board && board._gatedCert);

  // Build a lightweight simulation grid:
  // 0 = unrevealed unknown, 1 = revealed, 2 = flagged as mine
  const sim = new Uint8Array(rows * cols); // all 0 (unrevealed)
  const idx = (r, c) => r * cols + c;

  // Optional: pre-flag cells before the deduction loop runs. Used by
  // computeBombInfoValue (src/logic/bombInfoValue.js) to ask "what does
  // the rest of the solve look like if the player already knows THIS
  // cell is a mine?". sim[i]===2 is treated as a known-mine constraint
  // by the existing deduction loop, so the move-type counts reflect a
  // strictly easier board than the unflagged baseline.
  if (options && Array.isArray(options.preFlagCells)) {
    for (const pf of options.preFlagCells) {
      if (!pf) continue;
      const pr = pf.row, pc = pf.col;
      if (Number.isInteger(pr) && pr >= 0 && pr < rows
          && Number.isInteger(pc) && pc >= 0 && pc < cols) {
        sim[idx(pr, pc)] = 2;
      }
    }
  }

  // Cache mine locations and player-visible adjacency counts.
  // liarBase[i] = displayed value for cells that contribute a {X-1, X+1}
  // disjunctive constraint (plain liar, possibly + locked); -1 otherwise.
  const isMine = new Uint8Array(rows * cols);
  const adjCount = new Uint8Array(rows * cols);
  const liarBase = new Int8Array(rows * cols).fill(-1);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = idx(r, c);
      const cell = board[r][c];
      if (cell.isMine) isMine[i] = 1;
      adjCount[i] = getPlayerVisibleCount(cell, stripGimmicks);
      if (isPureLiar(cell, stripGimmicks) && cell.displayedMines != null) {
        liarBase[i] = cell.displayedMines;
      }
    }
  }

  // Cascade count: the effective value for flood-fill purposes.
  // Mirror cells cascade based on displayedMines (what the player sees).
  const cascadeCount = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = idx(r, c);
      const cell = board[r][c];
      cascadeCount[i] = cell.displayedMines != null ? cell.displayedMines : cell.adjacentMines;
    }
  }

  // Count total non-mine cells — our target for "all revealed"
  let totalSafe = 0;
  for (let i = 0; i < rows * cols; i++) {
    if (!isMine[i]) totalSafe++;
  }
  let revealedCount = 0;

  // Pre-compute neighbor lists (or reuse provided cache)
  const neighborCache = preNeighborCache || buildNeighborCache(board, rows, cols);

  // Pre-compute static gimmick constraints (sonar / compass / wormhole).
  // stripGimmicks suppresses the constraint for the named types — used to
  // detect whether a gimmick is load-bearing on this board.
  const gimmickConstraints = buildStaticGimmickConstraints(board, rows, cols, neighborCache, stripGimmicks);

  // Track locked cells
  const isLocked = new Uint8Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c].isLocked) isLocked[idx(r, c)] = 1;
    }
  }

  // Check if a locked cell can unlock: all non-mine, non-locked neighbors must be revealed
  function canUnlock(i) {
    if (!isLocked[i]) return false;
    for (const ni of neighborCache[i]) {
      if (sim[ni] === 0 && !isMine[ni] && !isLocked[ni]) return false; // unrevealed non-mine non-locked neighbor
    }
    return true;
  }

  // Unlock locked cells whose conditions are met. Unlocking follows the
  // BOARD's mechanics (ground truth is fine - the lock itself opens),
  // but the certifier must NEVER auto-reveal the freed cell: in
  // gameplay the player has to CLICK it, and a click without proof is
  // a guess. An unlocked cell becomes an ordinary unknown the passes
  // must prove safe (or prove mine) like any other - that was the
  // locked-cell certification oracle (closed 2026-06-12; previously
  // the solver revealed freed cells via isMine ground truth, so a
  // board could certify even when the freed cell was a 50/50).
  // Unlock chains can't cascade without reveals (a freed-but-unrevealed
  // cell blocks its locked neighbors), so a single sweep suffices.
  // Returns whether anything unlocked - callers treat that as round
  // progress so the passes re-run over the loosened board.
  function tryUnlockAll() {
    let unlockedAny = false;
    for (let i = 0; i < rows * cols; i++) {
      if (isLocked[i] && sim[i] === 0 && canUnlock(i)) {
        isLocked[i] = 0;
        unlockedAny = true;
      }
    }
    return unlockedAny;
  }

  // Reveal a cell (simulate); if it's a zero, flood-fill
  const revealQueue = [];
  let totalClicks = 0; // counts player clicks (cascades = 1 click)
  // Per-move-type counters: the mix of deduction techniques the board requires
  // is the primary feature driving predicted par time. `totalClicks` = 1 (first
  // click) + sum of the five buckets below.
  let passAMoves = 0;            // trivial propagation (count == flags / unknowns)
  let canonicalSubsetMoves = 0;  // Pass B subset where the larger constraint is small (<=3 unknowns) — local 1-1 / 1-2 / 1-1-1 shapes
  let genericSubsetMoves = 0;    // Pass B subset over a larger constraint — non-local, slower
  let advancedLogicMoves = 0;    // Pass C tank / gauss over exact constraints
  let disjunctiveMoves = 0;      // Pass C where liar disjunctive constraints were in play

  // Highest technique level the board required (hoisted so buildResult can read it):
  //   0 = simple propagation only (Pass A)
  //   1 = subset / superset analysis (Pass B)
  //   2 = advanced solver — tank / gauss (Pass C)
  //   3 = required liar disjunctive reasoning to make a deduction
  let techniqueLevel = 0;

  // Opt-in deduction trace ({ trace: true }): one entry per deduced
  // reveal — { cell, tier, sources } where sources are the origin cells
  // of the constraints that PROVED the deduction (Pass A: the one
  // constraint; Pass B: the subset pair; Pass C: the whole union-find
  // component, which is the honest minimal explanation for enumeration).
  // Collection only — behavior, counters, and ordering are unchanged.
  // Off in generation retry loops (they call without the option).
  // Invariant on solvable boards: trace.length + 1 === totalClicks.
  const trace = options && options.trace ? [] : null;

  // Opt-in pre-crux snapshot ({ captureCruxState: true }): a copy of the
  // sim grid (0 hidden / 1 revealed / 2 flagged) taken the instant before
  // the FIRST tier>=1 reveal — the exact state a player faces at the
  // board's crux. cruxExtract uses it to materialize the daily teaser
  // without re-implementing the flood/unlock logic. Like trace, this is
  // collection-only and off in generation hot loops.
  const captureCruxState = !!(options && options.captureCruxState);
  let cruxSim = null;

  const buildResult = (solvable, remainingUnknowns) => {
    const out = {
      solvable,
      remainingUnknowns,
      totalClicks,
      techniqueLevel,
      passAMoves,
      canonicalSubsetMoves,
      genericSubsetMoves,
      advancedLogicMoves,
      disjunctiveMoves,
    };
    if (trace) out.trace = trace;
    if (cruxSim) out.cruxSim = cruxSim;
    return out;
  };
  function revealCell(i) {
    if (sim[i] !== 0 || isMine[i] || isLocked[i]) return;
    sim[i] = 1;
    revealedCount++;
    if (cascadeCount[i] === 0) {
      for (const ni of neighborCache[i]) {
        if (sim[ni] === 0 && !isMine[ni] && !isLocked[ni]) {
          revealQueue.push(ni);
        }
      }
    }
  }

  function flagCell(i) {
    if (sim[i] !== 0) return;
    sim[i] = 2; // flagged
  }

  // Step 1: Simulate first click — reveal safeRow, safeCol and flood-fill zeros
  totalClicks++;
  revealQueue.push(idx(safeRow, safeCol));
  while (revealQueue.length > 0) {
    revealCell(revealQueue.pop());
  }
  tryUnlockAll(); // unlock any locked cells freed by the initial cascade

  if (revealedCount === totalSafe) return buildResult(true, 0);

  // Step 2: Iterative multi-layer constraint solving.
  // (techniqueLevel is hoisted above buildResult so returns include it.)
  const MAX_ITERATIONS = 1000;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let progress = false;

    // ── Pass A: Simple constraint propagation ──
    // Each revealed numbered cell + each gimmick constraint (sonar / compass /
    // wormhole) is a single-value constraint. We deduce flags and reveals
    // when the constraint pins a cell uniquely.
    const passACells = (i) => {
      // Zeros are normally moot (the flood already cleared their
      // neighbors) but a zero ADJACENT TO A LOCKED CELL is a real
      // proving constraint - the lock blocked the flood, and "the 0
      // touches it" is exactly how a player proves the freed cell
      // safe. Zero sources with no unknown neighbors no-op instantly.
      const ok = sim[i] === 1 && adjCount[i] !== UNKNOWN;
      if (!ok) return null;
      return { nbrs: neighborCache[i], expected: adjCount[i] };
    };

    // Iterate cell-source constraints first, then gimmick constraints.
    const constraintSources = [];
    for (let i = 0; i < rows * cols; i++) {
      const c = passACells(i);
      if (c) { c.origin = i; constraintSources.push(c); }
    }
    for (const gc of gimmickConstraints) {
      if (gateGimmickOrigins && !gimmickConstraintVisible(gc, sim)) continue;
      constraintSources.push({ nbrs: gc.cells, expected: gc.expected, origin: gc.origin });
    }

    for (const src of constraintSources) {
      const nbrs = src.nbrs;
      let unknowns = 0;
      let flagged = 0;
      for (const ni of nbrs) {
        if (sim[ni] === 0) unknowns++;
        else if (sim[ni] === 2) flagged++;
      }

      const remaining = src.expected - flagged;

      if (remaining < 0 || remaining > unknowns) {
        return buildResult(false, totalSafe - revealedCount);
      }

      // Rule 1: All unknowns must be mines
      if (remaining === unknowns && unknowns > 0) {
        for (const ni of nbrs) {
          if (sim[ni] === 0) {
            flagCell(ni);
            progress = true;
          }
        }
      }

      // Rule 2: All mines accounted for — remaining unknowns are safe
      if (remaining === 0 && unknowns > 0) {
        for (const ni of nbrs) {
          // Still-locked cells stay unknowns: provably safe but
          // unclickable until their lock opens. Skipping (not counting)
          // also keeps the round's progress flag honest.
          if (sim[ni] === 0 && isLocked[ni]) continue;
          if (sim[ni] === 0) {
            totalClicks++;
            passAMoves++;
            if (trace) trace.push({ cell: ni, tier: 0, sources: src.origin != null ? [src.origin] : [] });
            revealQueue.push(ni);
            progress = true;
          }
        }
        while (revealQueue.length > 0) {
          revealCell(revealQueue.pop());
        }
      }
    }

    if (tryUnlockAll()) progress = true; // freed locks = new deduction surface
    if (revealedCount === totalSafe) return buildResult(true, 0);
    if (progress) continue;

    // ── Pass B: Subset / superset constraint analysis ──
    // Subset arithmetic only works with single-value (exact) constraints, so
    // we skip Pass B for liar — its disjunctive constraints feed Pass C only.
    // Sonar / compass / wormhole are exact constraints over larger cell sets
    // and DO participate in subset analysis here.
    const baseConstraints = buildConstraints(sim, adjCount, neighborCache, rows * cols);
    const gimmickRuntime = buildGimmickRuntimeConstraints(gimmickConstraints, sim, gateGimmickOrigins);
    const constraints = [...baseConstraints, ...gimmickRuntime];

    // Pre-build sets once per pass — avoids O(n) Array.includes / new Set() per pair
    const constraintSets = constraints.map(c => new Set(c.unknowns));

    let subsetProgress = false;
    for (let a = 0; a < constraints.length; a++) {
      const cA = constraints[a];
      const setA = constraintSets[a];
      for (let b = 0; b < constraints.length; b++) {
        if (a === b) continue;
        const cB = constraints[b];

        if (cA.unknowns.length >= cB.unknowns.length) continue;

        const setB = constraintSets[b];
        let isSubset = true;
        for (const x of cA.unknowns) {
          if (!setB.has(x)) { isSubset = false; break; }
        }
        if (!isSubset) continue;

        const diff = [];
        for (const x of cB.unknowns) {
          if (!setA.has(x)) diff.push(x);
        }
        const diffMines = cB.allowedMines[0] - cA.allowedMines[0];

        if (diffMines < 0 || diffMines > diff.length) continue;

        if (diffMines === diff.length && diff.length > 0) {
          for (const di of diff) {
            if (sim[di] === 0) {
              flagCell(di);
              subsetProgress = true;
            }
          }
        }

        if (diffMines === 0 && diff.length > 0) {
          // Classify by the size of the LARGER constraint (cB.unknowns.length).
          // <= 3 captures canonical 1-1, 1-2, and most 1-1-1 shapes — moves an
          // experienced player recognises instantly. Larger constraints require
          // real scanning and are grouped under "generic subset".
          const isCanonical = cB.unknowns.length <= 3;
          for (const di of diff) {
            if (sim[di] === 0 && isLocked[di]) continue; // unclickable until unlocked
            if (sim[di] === 0) {
              if (captureCruxState && cruxSim === null) cruxSim = sim.slice(); // pre-crux snapshot (first tier>=1 reveal)
              totalClicks++;
              if (isCanonical) canonicalSubsetMoves++;
              else genericSubsetMoves++;
              if (trace) {
                const sources = [];
                if (cA.origin != null) sources.push(cA.origin);
                if (cB.origin != null && cB.origin !== cA.origin) sources.push(cB.origin);
                trace.push({ cell: di, tier: 1, sources });
              }
              revealQueue.push(di);
              subsetProgress = true;
            }
          }
          while (revealQueue.length > 0) {
            revealCell(revealQueue.pop());
          }
        }
      }
    }

    const unlockedAfterB = tryUnlockAll(); // progress, but not a subset TECHNIQUE
    if (subsetProgress) techniqueLevel = Math.max(techniqueLevel, 1);
    if (revealedCount === totalSafe) return buildResult(true, 0);
    if (subsetProgress || unlockedAfterB) continue;

    // ── Pass C: Advanced solver (Gauss + Tank) ──
    // Combine exact constraints from non-liar cells, exact constraints from
    // gimmick cells (sonar/compass/wormhole), and disjunctive constraints
    // from plain-liar cells (each contributes "X-1 OR X+1" mines).
    const freshConstraints = buildConstraints(sim, adjCount, neighborCache, rows * cols);
    const liarCs = buildLiarConstraints(sim, liarBase, neighborCache, rows * cols);
    const gimmickCs = buildGimmickRuntimeConstraints(gimmickConstraints, sim, gateGimmickOrigins);
    const solved = solveConstraints([...freshConstraints, ...liarCs, ...gimmickCs]);

    // Per-deduction disjunctive attribution. The old version batch-flagged
    // EVERY Pass C deduction of a round as disjunctive whenever ANY liar
    // constraint existed anywhere on the board, inflating disjunctiveMoves
    // in dailyMeta for every liar board (and over-promoting techniqueLevel
    // to 3). Honest version: a deduction is disjunctive only if ITS
    // union-find component carries a disjunctive constraint.
    const isDisjDeduction = (cellIdx) => {
      const g = solved.cellGroup.get(cellIdx);
      return g != null ? solved.groups[g].hasDisjunctive : liarCs.length > 0;
    };

    let advancedProgress = false;
    let anyDisjThisRound = false;

    for (const cellIdx of solved.mines) {
      if (sim[cellIdx] === 0) {
        flagCell(cellIdx);
        if (isDisjDeduction(cellIdx)) anyDisjThisRound = true;
        advancedProgress = true;
      }
    }

    for (const cellIdx of solved.safe) {
      if (sim[cellIdx] === 0 && isLocked[cellIdx]) continue; // unclickable until unlocked
      if (sim[cellIdx] === 0) {
        if (captureCruxState && cruxSim === null) cruxSim = sim.slice(); // pre-crux snapshot (first tier>=1 reveal)
        totalClicks++;
        const disj = isDisjDeduction(cellIdx);
        if (disj) { disjunctiveMoves++; anyDisjThisRound = true; }
        else advancedLogicMoves++;
        if (trace) {
          const g = solved.cellGroup.get(cellIdx);
          trace.push({
            cell: cellIdx,
            tier: disj ? 3 : 2,
            sources: g != null ? solved.groups[g].origins : [],
          });
        }
        revealQueue.push(cellIdx);
        advancedProgress = true;
      }
    }
    while (revealQueue.length > 0) {
      revealCell(revealQueue.pop());
    }

    const unlockedAfterC = tryUnlockAll(); // progress, but not an advanced TECHNIQUE
    if (advancedProgress) techniqueLevel = Math.max(techniqueLevel, anyDisjThisRound ? 3 : 2);
    if (revealedCount === totalSafe) return buildResult(true, 0);
    if (advancedProgress || unlockedAfterC) continue;

    // No progress from any layer — board requires guessing
    break;
  }

  return buildResult(false, totalSafe - revealedCount);
}

// The player-facing certificate summary of a solver check: how long the
// proven chain is (totalClicks = entry click + deductions) and the
// hardest technique it needed. Returns null unless the check actually
// certified a full clear — a certificate must never overclaim, so a
// failed or partial check produces NO stamp rather than a hedged one.
// (The acceptance condition mirrors the generation loops: solvable, or
// zero unknowns remaining.)
export function certificateFromCheck(check) {
  if (!check) return null;
  if (!(check.solvable || check.remainingUnknowns === 0)) return null;
  return { clicks: check.totalClicks, tier: check.techniqueLevel ?? 0 };
}

// Gimmick types that meaningfully contribute info the player uses for
// deduction. The "load-bearing" filter strips one of these at a time and
// re-runs the solver: if the board is still solvable without that gimmick's
// info, the gimmick was decorative on this board.
//
//   - mystery: removes info by definition, can't be load-bearing — skipped.
//   - walls: changes adjacency topology, cell numbers were computed WITH walls;
//     stripping would break the board's number coherence. Always structural.
//   - locked: changes reveal order, not deductions. Always structural.
//   - pressurePlate: challenge L71+ and chaos. It adds a real-time
//     deadline, not a deduction constraint — the load-bearing question
//     doesn't apply. mineShift: chaos-only.
const TESTABLE_GIMMICK_TYPES = ['sonar', 'compass', 'wormhole', 'liar', 'mirror'];

// A gimmick "contributes" to the solve if stripping it does any of:
//   1. Makes the board unsolvable (strict load-bearing).
//   2. Forces a higher technique level (the player would have to reason
//      harder without the gimmick — e.g. Pass C tank/gauss instead of
//      Pass A).
//   3. Adds a meaningful number of clicks the player would have to make
//      manually because the gimmick no longer shortcuts the deduction
//      chain. Threshold of 2 because saving exactly 1 click is often
//      incidental — the same cell would have been deduced moments later
//      via a neighbor anyway.
// If none of those three hold, the gimmick was decorative on this board.
const SHORTCUT_CLICK_THRESHOLD = 2;

function _gimmickContributes(withCheck, strippedCheck) {
  if (!strippedCheck.solvable && strippedCheck.remainingUnknowns > 0) return true;
  if ((strippedCheck.techniqueLevel ?? 0) > (withCheck.techniqueLevel ?? 0)) return true;
  if (strippedCheck.totalClicks - withCheck.totalClicks >= SHORTCUT_CLICK_THRESHOLD) return true;
  return false;
}

// Grade ONE gimmick type's contribution to this board, for the win
// receipt's modifier verdict. Same strip-and-resolve analysis as the
// load-bearing filter, but returns the honest TIER instead of a boolean,
// so the receipt copy can never overclaim ("required" is only said when
// stripping the gimmick literally leaves the board unsolvable):
//   required   — without it, no solution
//   technique  — it lowers the reasoning class the board demands
//   shortcut   — it saves >= SHORTCUT_CLICK_THRESHOLD clicks
//   decorative — a free hint this time (relax-valve boards ship these)
//   structural — walls/locked/mystery: the question doesn't apply
export function gradeGimmickContribution(board, rows, cols, safeRow, safeCol, type) {
  if (!TESTABLE_GIMMICK_TYPES.includes(type)) return { tier: 'structural' };
  const nbrCache = buildNeighborCache(board, rows, cols);
  const withCheck = isBoardSolvable(board, rows, cols, safeRow, safeCol, nbrCache);
  const stripped = isBoardSolvable(board, rows, cols, safeRow, safeCol, nbrCache, { stripGimmicks: [type] });
  if (!stripped.solvable && stripped.remainingUnknowns > 0) return { tier: 'required' };
  if ((stripped.techniqueLevel ?? 0) > (withCheck.techniqueLevel ?? 0)) {
    return { tier: 'technique', from: withCheck.techniqueLevel ?? 0, to: stripped.techniqueLevel ?? 0 };
  }
  const clicksSaved = stripped.totalClicks - withCheck.totalClicks;
  if (clicksSaved >= SHORTCUT_CLICK_THRESHOLD) return { tier: 'shortcut', clicksSaved };
  return { tier: 'decorative' };
}

/**
 * Returns the subset of activeGimmicks that are decorative on this board —
 * i.e. stripping them changes nothing meaningful (board still solvable at
 * the same technique level with similar click count). A gimmick that
 * SHORTCUTS the solve (lets the player skip ≥2 clicks or use easier
 * reasoning) counts as contributing, even if not strictly required.
 * Empty array means every testable gimmick contributes.
 *
 * Mystery, walls, and locked are skipped (structural / informational gimmicks
 * for which the load-bearing question doesn't apply).
 *
 * Cost: one baseline solver run plus one additional run per testable type
 * present on the board (typically 2-3 runs total per board).
 *
 * @param {Array<Array<Object>>} board  - 2D cell grid (already gimmick-applied)
 * @param {number} rows
 * @param {number} cols
 * @param {number} safeRow              - first-click row
 * @param {number} safeCol              - first-click col
 * @param {string[]} activeGimmicks     - the modifier types present on the board
 * @param {Array} [preNeighborCache]    - optional pre-built neighbor cache
 * @returns {string[]}                  - decorative gimmick type names
 */
export function findDecorativeGimmicks(board, rows, cols, safeRow, safeCol, activeGimmicks, preNeighborCache) {
  const decorative = [];
  if (!Array.isArray(activeGimmicks) || activeGimmicks.length === 0) return decorative;
  // Baseline: the with-gimmicks solve. We compare each strip-test against
  // this — if technique level rises or clicks rise meaningfully, the
  // gimmick contributed. If neither, the gimmick was decoration.
  const withCheck = isBoardSolvable(board, rows, cols, safeRow, safeCol, preNeighborCache);
  if (!withCheck.solvable && withCheck.remainingUnknowns > 0) {
    // Caller should have verified solvability already — bail rather than
    // report misleading results on an unsolvable board.
    return decorative;
  }
  for (const g of activeGimmicks) {
    if (!TESTABLE_GIMMICK_TYPES.includes(g)) continue;
    const stripped = isBoardSolvable(board, rows, cols, safeRow, safeCol, preNeighborCache, {
      stripGimmicks: [g],
    });
    if (!_gimmickContributes(withCheck, stripped)) {
      decorative.push(g);
    }
  }
  return decorative;
}

// ── Build constraints from current simulation state ──────────
// Each constraint: { unknowns: cellIdx[], allowedMines: number[] } where the
// final mine count among `unknowns` must equal one of the `allowedMines`
// values. Exact constraints (normal numbered cells) have a single-element
// `allowedMines`; liar cells contribute disjunctive 2-element sets.

function buildConstraints(sim, adjCount, neighborCache, totalCells) {
  const constraints = [];
  for (let i = 0; i < totalCells; i++) {
    if (sim[i] !== 1 || adjCount[i] === 0 || adjCount[i] === 255) continue; // 255 = mystery/unknown

    const nbrs = neighborCache[i];
    const unknownSet = [];
    let flagged = 0;
    for (const ni of nbrs) {
      if (sim[ni] === 0) unknownSet.push(ni);
      else if (sim[ni] === 2) flagged++;
    }
    const remaining = adjCount[i] - flagged;
    if (unknownSet.length > 0 && remaining >= 0) {
      unknownSet.sort((a, b) => a - b);
      constraints.push({ unknowns: unknownSet, allowedMines: [remaining], origin: i });
    }
  }
  return constraints;
}

// Pre-computes the static (board-topology-only) part of gimmick constraints.
// Each entry: { cells: cellIdx[], expected: number }
//   - sonar: cells in the 5x5 area (radius 2). Wall blocks adjacency only at
//     radius 1 (matches recomputeDisplayedMines).
//   - compass: cells along the cell's compassDir line to the board edge.
//   - wormhole: union of A's and B's neighborhoods. Skipped when neighborhoods
//     overlap (would need a weighted constraint with shared cells contributing 2).
// The runtime constraint per Pass C/B is built from this via
// buildGimmickRuntimeConstraints, which subtracts already-flagged/revealed cells.
function buildStaticGimmickConstraints(board, rows, cols, neighborCache, stripGimmicks) {
  const wallEdges = board._wallEdges || null;
  const idx = (r, c) => r * cols + c;
  const skipSonar = stripGimmicks && stripGimmicks.has('sonar');
  const skipCompass = stripGimmicks && stripGimmicks.has('compass');
  const skipWormhole = stripGimmicks && stripGimmicks.has('wormhole');
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (cell.isMine || cell.displayedMines == null) continue;
      // Liar stacks freely on base-value gimmicks (gimmicks.js stacking
      // rules), and displayedMines then INCLUDES the ±1 lie. Emitting
      // that as an exact constraint would let the certifier deduce from
      // a false premise — isPureLiar's contract says liar-stacked
      // gimmick cells contribute nothing, and that must hold here too.
      if (cell.isLiar) continue;

      if (cell.isSonar && !skipSonar) {
        const cells = [];
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
            if (Math.abs(dr) <= 1 && Math.abs(dc) <= 1 && wallEdges && hasWallBetween(wallEdges, r, c, nr, nc)) continue;
            cells.push(nr * cols + nc);
          }
        }
        if (cells.length > 0) out.push({ cells, expected: cell.displayedMines, origin: idx(r, c) });
      } else if (cell.isCompass && cell.compassDir && !skipCompass) {
        const cells = [];
        let nr = r + cell.compassDir.dr;
        let nc = c + cell.compassDir.dc;
        while (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
          cells.push(nr * cols + nc);
          nr += cell.compassDir.dr;
          nc += cell.compassDir.dc;
        }
        if (cells.length > 0) out.push({ cells, expected: cell.displayedMines, origin: idx(r, c) });
      } else if (cell.isWormhole && cell.wormholePair && !skipWormhole) {
        const myIdx = idx(r, c);
        const pIdx = idx(cell.wormholePair.row, cell.wormholePair.col);
        if (myIdx > pIdx) continue; // lower-index cell owns the constraint
        const myNbrs = neighborCache[myIdx];
        const pNbrs = neighborCache[pIdx];
        const seen = new Uint8Array(rows * cols);
        let overlap = false;
        const cells = [];
        for (const ni of myNbrs) { seen[ni] = 1; cells.push(ni); }
        for (const ni of pNbrs) {
          if (seen[ni]) { overlap = true; break; }
          cells.push(ni);
        }
        if (overlap) continue;
        // Origin = the owning wormhole cell; the UI can pull the partner
        // from cell.wormholePair when it highlights the proving region.
        // `partner` is carried for reveal-gating: both endpoints display
        // the pair sum, so the constraint is on screen when EITHER is
        // revealed.
        if (cells.length > 0) out.push({ cells, expected: cell.displayedMines, origin: myIdx, partner: pIdx });
      }
    }
  }
  return out;
}

// A sonar / compass / wormhole constraint is on screen — usable by the
// player — only when its number is visible: the origin cell is revealed,
// or, for wormhole (both endpoints display the pair sum), either endpoint
// is. Locked gimmick cells pass through naturally: once unlocked and
// revealed, sim[origin] === 1.
function gimmickConstraintVisible(gc, sim) {
  return sim[gc.origin] === 1 || (gc.partner != null && sim[gc.partner] === 1);
}

// Sonar / compass / wormhole gimmicks each define a STATIC set of cells
// they constrain (5x5 area, line, or union of two neighborhoods) and an
// expected exact mine count. This converts each static constraint into a
// runtime constraint over only the unknown cells, after subtracting cells
// already revealed (counted as 0) and flagged (counted as mines).
// `gateOrigins` filters to constraints whose number the player can SEE.
function buildGimmickRuntimeConstraints(staticConstraints, sim, gateOrigins) {
  const cs = [];
  for (const gc of staticConstraints) {
    if (gateOrigins && !gimmickConstraintVisible(gc, sim)) continue;
    const unknownSet = [];
    let flagged = 0;
    for (const ci of gc.cells) {
      if (sim[ci] === 0) unknownSet.push(ci);
      else if (sim[ci] === 2) flagged++;
    }
    if (unknownSet.length === 0) continue;
    const remaining = gc.expected - flagged;
    if (remaining < 0 || remaining > unknownSet.length) continue; // infeasible — Pass A check will catch
    unknownSet.sort((a, b) => a - b);
    cs.push({ unknowns: unknownSet, allowedMines: [remaining], origin: gc.origin });
  }
  return cs;
}

// Liar cells contribute "true count is display - 1 OR display + 1" — a
// disjunctive constraint with two allowed mine counts. Values that are
// already infeasible given the current flagged count are filtered out;
// if both become infeasible the constraint is a contradiction (caller's
// deductions will then fail naturally and the board is reported unsolvable).
function buildLiarConstraints(sim, liarBase, neighborCache, totalCells) {
  const constraints = [];
  for (let i = 0; i < totalCells; i++) {
    if (sim[i] !== 1 || liarBase[i] < 0) continue;

    const nbrs = neighborCache[i];
    const unknownSet = [];
    let flagged = 0;
    for (const ni of nbrs) {
      if (sim[ni] === 0) unknownSet.push(ni);
      else if (sim[ni] === 2) flagged++;
    }
    if (unknownSet.length === 0) continue;
    unknownSet.sort((a, b) => a - b);

    const display = liarBase[i];
    const allowed = [];
    const v1 = display - 1 - flagged;
    const v2 = display + 1 - flagged;
    if (v1 >= 0 && v1 <= unknownSet.length) allowed.push(v1);
    if (v2 >= 0 && v2 <= unknownSet.length) allowed.push(v2);
    if (allowed.length > 0) {
      constraints.push({ unknowns: unknownSet, allowedMines: allowed, origin: i });
    }
  }
  return constraints;
}

// ── Find Next Safe Move (for post-death analysis) ────────────
// Analyzes the current board state and returns a deducible safe cell,
// or null if the situation was a genuine 50/50.

// Analyze the live player-visible board state and return EVERYTHING that
// is provably deducible right now — the full safe + mine frontier, each
// deduction carrying its proving region (constraint origin cells), plus a
// contradiction signal.
//
// `respectFlags: false` runs flags-blind: player flags are treated as
// plain unknowns. This matters because flags are CLAIMS, not facts — a
// single wrong flag can poison the constraint system into certifying a
// mine as "provably safe" or stamping "genuine 50/50" on a deducible
// position. Every player-facing verdict (receipts, lens) must come from
// the flags-blind run; the flags-respecting run's `contradiction` flag is
// itself the signal that some flag is provably wrong.
//
// @returns {{
//   safe:  Array<{row, col, tier, sources: Array<{row, col}>}>,
//   mines: Array<{row, col, tier, sources: Array<{row, col}>}>,
//   contradiction: boolean,
// }}  tier 0 = a single constraint pins it; tier 2 = needed the joint
//     constraint solve (sources = the whole component — the honest
//     minimal explanation for enumeration); tier 3 = its component
//     carried a liar disjunction.
export function findDeducibleFrontier(board, opts = {}) {
  const respectFlags = opts.respectFlags !== false;
  // Same per-board reveal gate as isBoardSolvable: only count sonar /
  // compass / wormhole constraints whose number is on screen. Defaults
  // to the board's own contract flag so the lens / receipts / wrong-flag
  // verdicts never cite a clue the player cannot see on a gated board.
  const gateGimmickOrigins = opts.gateGimmickOrigins !== undefined
    ? !!opts.gateGimmickOrigins
    : !!(board && board._gatedCert);
  const rows = board.length;
  const cols = board[0].length;
  const idx = (r, c) => r * cols + c;
  const rc = (i) => ({ row: Math.floor(i / cols), col: i % cols });
  const totalCells = rows * cols;

  // Build simulation state from actual board — gimmick-aware (matches isBoardSolvable)
  const sim = new Uint8Array(totalCells);
  const adjCount = new Uint8Array(totalCells);
  const liarBase = new Int8Array(totalCells).fill(-1);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = idx(r, c);
      const cell = board[r][c];
      // A revealed MINE (a daily/weekly strike cell, or a loss-cascade
      // reveal) is a KNOWN MINE, not a revealed-safe cell — model it
      // like a confirmed flag (sim=2) so neighboring numbers count it.
      // Modeling it as sim=1 (zero mine contribution) poisons every
      // adjacent constraint: after one strike the engine would assert
      // contradictions on flagless boards and certify genuinely safe
      // cells as "provable mines". This is a FACT, not a player claim,
      // so it applies in the flags-blind run too.
      if (cell.isRevealed) sim[i] = cell.isMine ? 2 : 1;
      else if (respectFlags && cell.isFlagged) sim[i] = 2;
      adjCount[i] = getPlayerVisibleCount(cell);
      if (isPureLiar(cell) && cell.displayedMines != null) {
        liarBase[i] = cell.displayedMines;
      }
    }
  }

  // Use wall-aware neighbor cache (matches isBoardSolvable)
  const neighborCache = buildNeighborCache(board, rows, cols);
  const gimmickConstraints = buildStaticGimmickConstraints(board, rows, cols, neighborCache);

  const safe = new Map();  // cellIdx -> { tier, sources: number[] }
  const mines = new Map();
  let contradiction = false;
  const addTo = (map, i, tier, sources) => {
    if (!map.has(i)) map.set(i, { tier, sources });
  };

  // Pass A: single-constraint deductions over numbered cells + gimmick
  // constraints, collected in board-scan order (preserves the pick order
  // the one-cell findNextSafeMove always had).
  const passASources = [];
  for (let i = 0; i < totalCells; i++) {
    if (sim[i] !== 1 || adjCount[i] === 0 || adjCount[i] === UNKNOWN) continue;
    passASources.push({ cells: neighborCache[i], expected: adjCount[i], origin: i });
  }
  for (const gc of gimmickConstraints) {
    if (gateGimmickOrigins && !gimmickConstraintVisible(gc, sim)) continue;
    passASources.push({ cells: gc.cells, expected: gc.expected, origin: gc.origin });
  }
  for (const src of passASources) {
    let unknowns = 0;
    let flagged = 0;
    for (const ci of src.cells) {
      if (sim[ci] === 0) unknowns++;
      else if (sim[ci] === 2) flagged++;
    }
    const remaining = src.expected - flagged;
    if (remaining < 0 || remaining > unknowns) {
      // Infeasible single constraint. Flags-respecting: a wrong flag.
      // Flags-blind: shouldn't happen on a generator board.
      contradiction = true;
      continue;
    }
    if (remaining === 0 && unknowns > 0) {
      for (const ci of src.cells) if (sim[ci] === 0) addTo(safe, ci, 0, [src.origin]);
    }
    if (remaining === unknowns && unknowns > 0) {
      for (const ci of src.cells) if (sim[ci] === 0) addTo(mines, ci, 0, [src.origin]);
    }
  }

  const constraints = buildConstraints(sim, adjCount, neighborCache, totalCells);
  const liarCs = buildLiarConstraints(sim, liarBase, neighborCache, totalCells);
  const gimmickCs = buildGimmickRuntimeConstraints(gimmickConstraints, sim, gateGimmickOrigins);

  // Pass B mirror: two-clue subset deductions with the PAIR as the
  // minimal explanation (tier 1). Without this stage every subset
  // deduction fell through to the joint solve and surfaced as a
  // whole-component tier-2 answer ("all 6 highlighted clues at once"),
  // which is technically true but pedagogically useless for a plain
  // 1-1 — the player should be pointed at exactly the two clues that
  // settle it. Exact constraints only, same as the solver's Pass B.
  const exact = [...constraints, ...gimmickCs].filter(c => c.allowedMines.length === 1);
  for (let a = 0; a < exact.length; a++) {
    const cA = exact[a];
    const setA = new Set(cA.unknowns);
    for (let b = 0; b < exact.length; b++) {
      if (a === b) continue;
      const cB = exact[b];
      if (cA.unknowns.length >= cB.unknowns.length) continue;
      let isSubset = true;
      for (const x of cA.unknowns) {
        if (!cB.unknowns.includes(x)) { isSubset = false; break; }
      }
      if (!isSubset) continue;
      const diff = cB.unknowns.filter(x => !setA.has(x));
      const diffMines = cB.allowedMines[0] - cA.allowedMines[0];
      if (diff.length === 0 || diffMines < 0 || diffMines > diff.length) continue;
      const srcs = [cA.origin, cB.origin].filter(o => o != null);
      if (diffMines === 0) {
        for (const di of diff) addTo(safe, di, 1, srcs);
      } else if (diffMines === diff.length) {
        for (const di of diff) addTo(mines, di, 1, srcs);
      }
    }
  }

  // Joint constraint solve (tank/gauss): numbered + liar disjunctive +
  // gimmick exact constraints, with per-component provenance. Catches
  // everything the single-clue and two-clue stages above could not.
  const solved = solveConstraints([...constraints, ...liarCs, ...gimmickCs]);
  if (solved.contradiction) contradiction = true;

  const groupMeta = (i) => {
    const g = solved.cellGroup.get(i);
    if (g == null) return { tier: 2, sources: [] };
    const grp = solved.groups[g];
    return { tier: grp.hasDisjunctive ? 3 : 2, sources: grp.origins };
  };
  for (const ci of solved.safe) {
    if (sim[ci] === 0) { const m = groupMeta(ci); addTo(safe, ci, m.tier, m.sources); }
  }
  for (const ci of solved.mines) {
    if (sim[ci] === 0) { const m = groupMeta(ci); addTo(mines, ci, m.tier, m.sources); }
  }

  const toList = (map) => [...map.entries()].map(([i, m]) => ({
    ...rc(i),
    tier: m.tier,
    sources: m.sources.filter(s => s != null).map(rc),
  }));
  return { safe: toList(safe), mines: toList(mines), contradiction };
}

// Back-compat one-cell wrapper (post-death verdicts): first deducible safe
// cell respecting the player's flags, or null for a genuine 50/50.
export function findNextSafeMove(board) {
  const f = findDeducibleFrontier(board, { respectFlags: true });
  return f.safe.length > 0 ? { row: f.safe[0].row, col: f.safe[0].col } : null;
}

// Wrong-flag detection by dual-solve diff. A player flag is PROVABLY
// wrong when the flags-blind run proves that cell safe; the
// flags-respecting run's contradiction flag additionally says "some flag
// is wrong" even when it can't be localized. The most common true cause
// of a stuck player is a wrong flag placed minutes earlier — this is the
// honest version of "are you stuck?".
export function detectWrongFlags(board) {
  const blind = findDeducibleFrontier(board, { respectFlags: false });
  const wrongFlags = [];
  for (const s of blind.safe) {
    if (board[s.row][s.col].isFlagged) wrongFlags.push({ row: s.row, col: s.col });
  }
  const trusting = findDeducibleFrontier(board, { respectFlags: true });
  return { wrongFlags, contradiction: trusting.contradiction };
}

// ── Game-play reveal / chord functions ──────────────────────

export function floodFillReveal(board, startRow, startCol) {
  const rows = board.length;
  const cols = board[0].length;
  const wallEdges = board._wallEdges || null;
  const revealed = [];
  const visited = new Set();
  const queue = [{ row: startRow, col: startCol, distance: 0 }];
  visited.add(`${startRow},${startCol}`);

  while (queue.length > 0) {
    const { row, col, distance } = queue.shift();
    const cell = board[row][col];

    if (cell.isFlagged || cell.isMine || cell.isLocked) continue;

    cell.isRevealed = true;
    cell.revealAnimDelay = distance * 30;
    revealed.push(cell);

    // Cascade on displayed value (mirror cells show swapped numbers)
    const effectiveMines = cell.displayedMines != null ? cell.displayedMines : cell.adjacentMines;
    if (effectiveMines === 0) {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = row + dr;
          const nc = col + dc;
          // Don't propagate across wall edges
          if (wallEdges && hasWallBetween(wallEdges, row, col, nr, nc)) continue;
          const key = `${nr},${nc}`;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && !visited.has(key)) {
            visited.add(key);
            if (!board[nr][nc].isRevealed && !board[nr][nc].isFlagged) {
              queue.push({ row: nr, col: nc, distance: distance + 1 });
            }
          }
        }
      }
    }
  }

  return revealed;
}

// Estimate how many cell reveals are needed to disarm a pressure plate
// (reveal all non-mine neighbors). Runs a lightweight solver simulation on a
// snapshot of the current board state without mutating the real board.
export function estimatePlateMovesToDisarm(board, plateRow, plateCol) {
  const rows = board.length, cols = board[0].length;
  const wallEdges = board._wallEdges || null;

  // Identify the safe neighbors we need revealed
  const targets = new Set();
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = plateRow + dr, nc = plateCol + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
        const adj = board[nr][nc];
        if (!adj.isMine && !adj.isRevealed) targets.add(`${nr},${nc}`);
      }
    }
  }
  if (targets.size === 0) return { moves: 0, steps: 0, unsolved: 0 };

  // Snapshot: track revealed/flagged state without mutating the board
  const revealed = new Set();
  const flagged = new Set();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (board[r][c].isRevealed) revealed.add(`${r},${c}`);
      if (board[r][c].isFlagged) flagged.add(`${r},${c}`);
    }
  }

  function getAdj(r, c) {
    return board[r][c].displayedMines != null ? board[r][c].displayedMines : board[r][c].adjacentMines;
  }

  let totalMoves = 0;
  let totalSteps = 0;
  let remaining = new Set(targets);

  for (let iter = 0; iter < 200 && remaining.size > 0; iter++) {
    const toReveal = new Set();
    const toFlag = new Set();

    for (const key of revealed) {
      const [r, c] = key.split(',').map(Number);
      const cell = board[r][c];
      // This estimator does single-cell Pass-A-style propagation only.
      // Skip cells whose value isn't a single integer for that purpose:
      //   - mystery/sonar/compass/wormhole give no per-cell constraint
      //   - liar's value is {display-1, display+1}; the bounds differ
      //     by 2, so no Pass-A rule can fire on it alone (the multi-
      //     constraint solver in solveConstraints/tankSolve DOES use the
      //     disjunctive constraint via buildLiarConstraints — we just
      //     can't use it here without that machinery).
      // Mirror cells use cell.adjacentMines directly: a smart player
      // decodes the swap and reasons with the true count.
      if (cell.isMystery || cell.isSonar || cell.isCompass || cell.isWormhole || cell.isLiar) continue;
      const adj = cell.adjacentMines;
      if (adj === 0) continue;

      let fCount = 0;
      const unknowns = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          if (wallEdges && hasWallBetween(wallEdges, r, c, nr, nc)) continue;
          const nk = `${nr},${nc}`;
          if (flagged.has(nk)) fCount++;
          else if (!revealed.has(nk)) unknowns.push(nk);
        }
      }

      if (fCount === adj && unknowns.length > 0) {
        for (const nk of unknowns) toReveal.add(nk);
      }
      if (unknowns.length === adj - fCount && unknowns.length > 0) {
        for (const nk of unknowns) toFlag.add(nk);
      }
    }

    if (toReveal.size === 0 && toFlag.size === 0) break; // stuck

    for (const key of toFlag) flagged.add(key);

    let batchMoves = 0;
    for (const key of toReveal) {
      if (revealed.has(key)) continue;
      const [r, c] = key.split(',').map(Number);
      if (board[r][c].isMine) continue;
      revealed.add(key);
      remaining.delete(key);
      batchMoves++;

      // Simulate cascade for 0-cells
      const eff = getAdj(r, c);
      if (eff === 0) {
        const queue = [[r, c]];
        while (queue.length > 0) {
          const [cr, cc] = queue.shift();
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;
              const nr = cr + dr, nc = cc + dc;
              if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
              if (wallEdges && hasWallBetween(wallEdges, cr, cc, nr, nc)) continue;
              const nk = `${nr},${nc}`;
              if (revealed.has(nk) || flagged.has(nk)) continue;
              if (board[nr][nc].isMine) continue;
              revealed.add(nk);
              remaining.delete(nk);
              batchMoves++;
              if (getAdj(nr, nc) === 0) queue.push([nr, nc]);
            }
          }
        }
      }
    }

    totalMoves += batchMoves;
    if (batchMoves > 0) totalSteps++;
  }

  // Targets this Pass-A-only estimator could NOT resolve need subset /
  // tank reasoning. They are returned in `unsolved` and priced by
  // plateSeconds() at the par model's tier rate — the old flat
  // "+2 steps each" fudge systematically under-timed exactly the
  // plates that need the hardest thinking (the contract gap).
  return { moves: totalMoves, steps: totalSteps, unsolved: remaining.size };
}

export function checkWin(board) {
  for (const row of board) {
    for (const cell of row) {
      // Skip mines (don't need to be revealed to win)
      if (cell.isMine) continue;
      // Locked cells that aren't mines must eventually be revealed too
      if (!cell.isRevealed) return false;
    }
  }
  return true;
}

export function revealAllMines(board) {
  const mines = [];
  for (const row of board) {
    for (const cell of row) {
      if (cell.isMine && !cell.isRevealed) {
        cell.isRevealed = true;
        mines.push(cell);
      }
    }
  }
  return mines;
}

export function countAdjacentFlags(board, row, col) {
  const rows = board.length;
  const cols = board[0].length;
  let count = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr;
      const nc = col + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && board[nr][nc].isFlagged) {
        count++;
      }
    }
  }
  return count;
}

export function chordReveal(board, row, col) {
  const cell = board[row][col];
  const effectiveCount = cell.displayedMines != null ? cell.displayedMines : cell.adjacentMines;
  if (!cell.isRevealed || effectiveCount === 0) return [];

  // Can't chord ON a cell whose displayed number isn't its OWN adjacent-mine
  // count. Liar (true ±1) and mystery (hidden) were already covered; the
  // base-value gimmicks show something unrelated to the 8 neighbors — sonar a
  // region count, compass a directional count, wormhole/mirror the PARTNER
  // cell's count — so chording them reveals the neighbors against a number
  // that doesn't describe them and pops a mine. This is exactly the
  // base-value set recomputeDisplayedMines (gimmicks.js) treats specially.
  if (cell.isLiar || cell.isMystery || cell.isSonar || cell.isCompass || cell.isWormhole || cell.mirrorPair) return [];

  const wallEdges = board._wallEdges || null;

  // Count adjacent flags (respecting wall edges). Strike cells —
  // mines the player previously hit in daily/weekly — count as flags
  // too: the player has visually confirmed the mine is there, the
  // bomb-hit handler leaves the cell as `isMine: true` so adjacent
  // numbers don't drop, and the strike marker functions as a flag for
  // chord-counting. Without this, a "3" next to a strike + two flags
  // wouldn't satisfy the chord even though the player has correctly
  // accounted for all three mines.
  let flagCount = 0;
  const rows = board.length;
  const cols = board[0].length;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr, nc = col + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
        if (wallEdges && hasWallBetween(wallEdges, row, col, nr, nc)) continue;
        if (board[nr][nc].isFlagged || board[nr][nc].isStrike) flagCount++;
      }
    }
  }

  if (flagCount !== effectiveCount) return [];

  const allRevealed = [];
  let hitMine = false;

  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr;
      const nc = col + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
        // Don't chord across wall edges
        if (wallEdges && hasWallBetween(wallEdges, row, col, nr, nc)) continue;
        const neighbor = board[nr][nc];
        // Don't chord-reveal locked cells (must unlock first)
        if (!neighbor.isRevealed && !neighbor.isFlagged && !neighbor.isLocked) {
          if (neighbor.isMine) {
            hitMine = true;
            neighbor.isRevealed = true;
            allRevealed.push(neighbor);
          } else if ((neighbor.displayedMines != null ? neighbor.displayedMines : neighbor.adjacentMines) === 0) {
            const filled = floodFillReveal(board, nr, nc);
            allRevealed.push(...filled);
          } else {
            neighbor.isRevealed = true;
            neighbor.revealAnimDelay = 0;
            allRevealed.push(neighbor);
          }
        }
      }
    }
  }

  return { revealed: allRevealed, hitMine };
}

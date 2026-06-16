// Par-model technique-counts experiment — data extraction.
//
// Question (Christopher): are the named techniques viable par-model predictors,
// and does a NESTED structure (composites shrunk toward their 1-2 parent) beat
// the current pooled pattern/search tiers? This emits the data for the R/Quarto
// fit (scripts/par-experiment.qmd):
//
//   par-experiment-boards.csv  — one row per DATE: the stored dailyMeta
//     baseline features (size + the 5 solver move-type buckets + structure)
//     PLUS per-board named-technique counts from re-solving the canonical board
//     with the SOUND classifier (proofClassify.classifyByProof), in BOTH flag
//     models — flags-aware (fa_*, flag proven mines then count) and flags-blind
//     (fb_*, never flag). The two differ because a flag turns a subset read
//     into a count (see the 2026-06-16 finding); "try both" was your call.
//
//   par-experiment-scores.csv  — one row per COMPLETION (daily + dailyArchive):
//     date, uid, time, bombBaseSum (= Σ(penalty − infoValue), to subtract bomb
//     cost into clean_time), n_hints (drop hinted plays), archive flag.
//
// Read-only Firebase (public REST). Run: node scripts/extract-par-experiment.mjs
import fs from 'fs';
import { isBoardSolvable, findDeducibleFrontier } from '../src/logic/boardSolver.js';
import { cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { clueUniverse } from '../src/logic/minimalProof.js';
import { classifyByProof } from '../src/logic/proofClassify.js';

const BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const get = async (p) => { const r = await fetch(`${BASE}/${p}.json`); return r.ok ? (await r.json()) || {} : {}; };

// ── Deserialize a canonical dailyBoard payload into a solver-ready grid.
// (dailyBoardSync.deserializeBoard pulls in the browser Firebase SDK, so we
// inline the same shape here, matching scripts/_extract-named.mjs.)
function deserializeCell(raw, r, c) {
  const cell = {
    row: r, col: c, isMine: false, adjacentMines: 0, displayedMines: undefined,
    isMystery: false, isLiar: false, inLiarZone: false, isLocked: false,
    isWormhole: false, isSonar: false, isCompass: false, isMirror: false,
    isPressurePlate: false, plateDisarmed: false, isFlagged: false, isRevealed: false, isStrike: false,
  };
  if (raw) for (const k in raw) cell[k] = raw[k];
  if (cell.displayedMines === undefined) cell.displayedMines = cell.adjacentMines;
  return cell;
}
function deserialize(raw) {
  const { rows, cols, cells, wallEdges } = raw;
  const board = [];
  for (let r = 0; r < rows; r++) { const row = []; for (let c = 0; c < cols; c++) row.push(deserializeCell(cells[r * cols + c], r, c)); board.push(row); }
  if (Array.isArray(wallEdges) && wallEdges.length) board._wallEdges = new Set(wallEdges);
  if (raw.gatedCert === true) board._gatedCert = true;
  return { board, rows, cols };
}
function flood(board, rows, cols, r, c) {
  const q = [[r, c]];
  while (q.length) {
    const [rr, cc] = q.pop(); const ce = board[rr][cc];
    if (ce.isRevealed || ce.isMine || ce.isFlagged) continue; ce.isRevealed = true;
    if (ce.adjacentMines === 0) for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue; const nr = rr + dr, nc = cc + dc;
      if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) q.push([nr, nc]);
    }
  }
}

// Names classifyByProof can return (count + the 9 shapes + pair/region).
const NAMES = ['count', '1-1', '1-2', 'hole', 'triangle', '1-2-1', '1-2-2-1', '1-3-1', '2-2-2', 'pair', 'region'];
const COL = { count: 'count', '1-1': '11', '1-2': '12', hole: 'hole', triangle: 'triangle', '1-2-1': '121', '1-2-2-1': '1221', '1-3-1': '131', '2-2-2': '222', pair: 'pair', region: 'region' };

// Tally the SAFE deductions of a full canonical solve by classifyByProof name,
// one flag model. flagsAware: flag proven mines each wave before classifying
// (so a satisfied clue reads as 'count'); flags-blind never flags.
function tallyTechniques(raw, flagsAware) {
  const { board, rows, cols } = deserialize(raw);
  flood(board, rows, cols, Math.floor(rows / 2), Math.floor(cols / 2));
  const counts = {};
  let guard = 400;
  while (guard-- > 0) {
    if (flagsAware) {
      const blind = findDeducibleFrontier(board, { respectFlags: false });
      for (const m of blind.mines) board[m.row][m.col].isFlagged = true; // proven mines are sound to mark
    }
    const fr = findDeducibleFrontier(board, { respectFlags: flagsAware });
    if (fr.safe.length === 0) break;
    const universe = clueUniverse(board, { respectFlags: flagsAware });
    for (const s of fr.safe) {
      const name = classifyByProof(board, { row: s.row, col: s.col, kind: 'safe' }, { rows, cols, universe, respectFlags: flagsAware }).name || 'region';
      counts[name] = (counts[name] || 0) + 1;
    }
    for (const s of fr.safe) flood(board, rows, cols, s.row, s.col);
  }
  return counts;
}

const bombBaseSum = (row) => {
  const ev = row && row.bombHitEvents;
  if (!Array.isArray(ev)) return 0;
  let s = 0;
  for (const e of ev) if (e && typeof e.penalty === 'number') s += e.penalty - (typeof e.infoValue === 'number' ? e.infoValue : 0);
  return Math.round(s * 10) / 10;
};

const [dailyBoard, dailyMeta, daily, archive] = await Promise.all([
  get('dailyBoard'), get('dailyMeta'), get('daily'), get('dailyArchive'),
]);

// ── boards CSV ──
const META_COLS = ['cellCount', 'totalMines', 'passAMoves', 'canonicalSubsetMoves', 'genericSubsetMoves', 'advancedLogicMoves', 'disjunctiveMoves', 'wallEdgeCount', 'zeroClusterCount'];
const techCols = NAMES.flatMap(n => [`fa_${COL[n]}`, `fb_${COL[n]}`]);
const boardCols = ['date', ...META_COLS, ...techCols];
const boardRows = [boardCols.join(',')];
const dates = Object.keys(dailyBoard).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
let done = 0;
for (const d of dates) {
  const feat = dailyMeta[d] && dailyMeta[d].features;
  if (!feat) continue; // need the baseline features to compare against
  let fa, fb;
  try {
    fa = tallyTechniques(dailyBoard[d], true);
    fb = tallyTechniques(dailyBoard[d], false);
  } catch (e) { console.error('skip board', d, e.message); continue; }
  const row = [d, ...META_COLS.map(k => feat[k] ?? 0)];
  for (const n of NAMES) { row.push(fa[n] || 0); row.push(fb[n] || 0); }
  boardRows.push(row.join(','));
  done++;
  if (done % 20 === 0) console.error(`  ${done} boards…`);
}
fs.writeFileSync('scripts/par-experiment-boards.csv', boardRows.join('\n'));

// ── scores CSV ──
// `bombHits` is carried so the R can drop > 30%-mines brute-force rows (the
// same isBombHitCheat filter the production refit applies; the experiment must
// match it or a probe's fast clean_time pollutes the fit).
const scoreRows = [['date', 'uid', 'time', 'bombBaseSum', 'bombHits', 'n_hints', 'archive'].join(',')];
const addScores = (root, data, archiveFlag) => {
  for (const d of Object.keys(data)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue; // skip weekly_first etc.
    for (const row of Object.values(data[d] || {})) {
      if (!row || typeof row.time !== 'number') continue;
      const nh = Array.isArray(row.hintEvents) ? row.hintEvents.length : 0;
      scoreRows.push([d, row.uid || '', row.time, bombBaseSum(row), row.bombHits || 0, nh, archiveFlag].join(','));
    }
  }
};
addScores('daily', daily, 0);
addScores('dailyArchive', archive, 1);
fs.writeFileSync('scripts/par-experiment-scores.csv', scoreRows.join('\n'));

console.error(`\nwrote par-experiment-boards.csv (${done} dates) + par-experiment-scores.csv (${scoreRows.length - 1} completions)`);

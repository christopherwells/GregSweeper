// The match library's standing contract, and its refit-drift alarm.
//
// The library stores ~900 pre-generated boards over the proven
// CHALLENGE_POOL specs (scripts/build-match-library.mjs); the config
// sheet's time bands filter on each board's STORED par, so the nightly
// refit must re-price the file (scripts/reprice-match-library.mjs) or the
// sheet quietly mislabels its bands. These tests hold the data to that
// contract under the model of the day, the climbLibrary pattern applied to
// the match bins:
//
//   - vintage lockstep: every file carries the CURRENT model fingerprint,
//     with the remedy named in the failure;
//   - price honesty: every board's stored par is exactly predictPar of its
//     own stored features;
//   - index honesty: the per-shape index shards reproduce the page files row
//     for row (the two are written by one function, matchIndexRow, and
//     this is the alarm if a partial rewrite ever splits them), and the
//     summary's corner counts answer a rule set with exactly the number the
//     deal's own row filter would, which is what makes the split safe;
//   - the deduction floor: no stored board is over on the opening click
//     (his immediately-done ruling; the pool's easiest corner certified at
//     work 1 when probed, which is why the build enforces the floor);
//   - stocked corners: the bands the sheet sells have real supply in every
//     shape where supply structurally exists (rhombille tops out near 130s
//     and deltoidal near 200s, so their 'long' cells are the pool's truth
//     and deliberately NOT pinned).

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { OUT_DIR } from '../scripts/build-match-library.mjs';
import {
  SUMMARY_FILE, LEGACY_INDEX_FILE, matchPageNames,
} from '../scripts/match-index-files.mjs';
import {
  parseMatchIndex, parseMatchSummary, countEligibleCorners, eligibleRows,
  matchIndexRow, matchIndexFeatureKeys, timeBandOf, MATCH_TIME_BANDS,
  matchShardFileForRow, MARATHON_PAR_CEILING_SECONDS,
} from '../src/logic/matchRules.js';
import { marathonFits, marathonProvisionalPar, inSupportCells } from '../src/logic/marathonFit.js';
import { predictPar } from '../src/logic/dailyFeatures.js';
import { modelFingerprint } from '../src/logic/parModelFingerprint.js';
import { CLIMB_MIN_DEDUCTIONS } from '../src/logic/challenge250.js';
import { TILING_TYPES } from '../src/logic/tilingGeometry.js';
import { deserializeBoard } from '../src/firebase/dailyBoardSync.js';
import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { recalcAllAdjacency, recomputeDisplayedMines } from '../src/logic/gimmicks.js';
import {
  cornerTotalTarget, ARITY_BUFFERS, arityOfKey, validateTargetCorners, specsForCorner,
} from '../scripts/topup-match-library.mjs';
import { narrowHoles } from '../scripts/match-narrow-holes.mjs';
import { rectFitsPhone } from '../src/logic/boardFit.js';
import { BOARD_WIDTH_CAP } from '../src/logic/difficulty.js';

const summary = JSON.parse(readFileSync(SUMMARY_FILE, 'utf8'));
const pageNames = matchPageNames(OUT_DIR);
const pages = pageNames.map((f) => JSON.parse(readFileSync(new URL(f, OUT_DIR), 'utf8')));
// SLOTS vs BOARDS, since the tombstone eviction (2026-08-15): an evicted
// board's slot holds `{ evicted, seed }` so every survivor keeps its
// page:idx, the seen-cycle key. The library's DEALABLE population is the
// survivors; the pages' slot counts include the stubs.
const slots = pages.flatMap((p) => p.boards);
const stubs = slots.filter((b) => b && b.evicted);
const boards = slots.filter((b) => b && !b.evicted);
const SHAPES = ['rect', ...TILING_TYPES];
// ONE FILE PER CORNER since 2026-08-14, so the shard set is read off the
// directory rather than composed from SHAPES: the corner axis includes the
// modifier SET, and there is no list of those to iterate.
// BOTH FILE CLASSES: `mx-` holds the fit lane, `mxo-` the marathon lane
// (2026-08-17). A regex of `^mx-` matches only the first, which is the whole
// point of the name (a client predating the lane cannot ask for a file it
// cannot construct), so the test has to name both deliberately or it would
// measure the library against half of itself.
const fitShardNames = readdirSync(OUT_DIR).filter((f) => /^mx-.+\.json$/.test(f)).sort();
const laneShardNames = readdirSync(OUT_DIR).filter((f) => /^mxo-.+\.json$/.test(f)).sort();
const shardNames = [...fitShardNames, ...laneShardNames].sort();
const shards = Object.fromEntries(shardNames
  .map((f) => [f, JSON.parse(readFileSync(new URL(f, OUT_DIR), 'utf8'))]));
/** Every shard's rows, parsed and concatenated: what a deal over everything,
 * INCLUDING the scroll opt-in, sees. */
const allRows = shardNames.flatMap((f) => parseMatchIndex(shards[f]) || []);

test('the match library is real, sharded, and its summary tells the truth', () => {
  assert.equal(pages.length, summary.pages, 'page files match the summary page count');
  assert.ok(boards.length >= 800, `${boards.length} boards is too few to be the real library`);
  assert.equal(boards.length, summary.boards, 'summary.boards counts DEALABLE boards, stubs excluded');
  assert.deepEqual(summary.counts, pages.map((p) => p.boards.length),
    'summary.counts are SLOT counts per page file, stubs included');
  pages.forEach((p, i) => assert.equal(p.page, i, `page file ${i} numbers itself`));

  // A tombstone holds a slot and nothing more: exactly its seed for audit,
  // never a payload the deal could resurrect, and never a missing seed that
  // would make the eviction unauditable.
  for (const s of stubs) {
    assert.deepEqual(Object.keys(s).sort(), ['evicted', 'seed'],
      'a tombstone must carry exactly { evicted, seed }');
    assert.equal(s.evicted, true);
    assert.ok(typeof s.seed === 'string' && s.seed.length > 0);
  }

  // ONE SHARD PER OCCUPIED CORNER, and every board in exactly one of them. A
  // corner whose file went missing would deal nothing while the summary went
  // on advertising it, which is this split's own failure mode.
  // A corner has a base file when it holds fit boards and a lane file when
  // it holds oversized ones, so the count is over (corner x class) rather
  // than over corners. Derived from the rows themselves through the writer's
  // own function, so the two cannot disagree about where a row lives.
  const expectedFiles = new Set(allRows.map((r) => matchShardFileForRow(r)));
  assert.equal(shardNames.length, expectedFiles.size,
    'every occupied (corner, lane) needs its own shard file, and no file may outlive it');
  assert.deepEqual(shardNames, [...expectedFiles].sort(),
    'the files on disk and the files the rows call for must be the same set');
  assert.equal(allRows.length, boards.length, 'the shards together hold every board exactly once');
  // The summary's per-shape totals still have to add up, even though nothing
  // is stored per shape any more: the sheet's supply line reads them.
  const byShape = {};
  for (const r of allRows) byShape[r.shape] = (byShape[r.shape] || 0) + 1;
  assert.deepEqual(summary.shards, byShape);
  // A row must live in the file its own corner names. Anywhere else and the
  // deal, which asks for files BY corner, would never find it.
  for (const f of shardNames) {
    for (const r of parseMatchIndex(shards[f])) {
      assert.equal(matchShardFileForRow(r), f, `${r.page}#${r.idx} is in the wrong shard`);
    }
  }

  // The monolith is GONE, not merely unread. Leaving it would make the
  // nightly re-price keep a second copy of every row in step forever, which
  // is the payload the split exists to stop paying.
  assert.ok(!existsSync(LEGACY_INDEX_FILE),
    'match-index.json still exists; the split replaces it rather than adding to it');
});

test('the summary counts what the deal can actually reach', () => {
  // The split's load-bearing equality: the sheet renders a number from the
  // SUMMARY and the deal draws from the SHARDS, so a corner key that does not
  // reproduce boardMatchesRules' own decisions would advertise supply nobody
  // can be dealt. Swept over rule sets rather than spot-checked, because the
  // modifier test is a SUBSET test and the disagreements would live in the
  // combinations, not in the simple cases.
  const corners = parseMatchSummary(summary);
  assert.ok(corners && corners.length > 0, 'the shipped summary must parse');
  const MODS = ['walls', 'liar', 'mystery', 'locked', 'wormhole', 'mirror', 'sonar', 'compass', 'worm'];
  const TIMES = ['any', ...MATCH_TIME_BANDS.map((b) => b.key)];
  const DENSITIES = ['any', 'sparse', 'standard', 'dense'];
  const DIFFICULTIES = ['any', 'gentle', 'standard', 'mean'];
  let nonZero = 0;
  for (let t = 0; t < 240; t++) {
    // Deterministic sweep: a fixed bit pattern per trial, so a failure is
    // reproducible rather than a flake nobody can re-run. Difficulty joined
    // the sweep 2026-08-16: its counts ride a per-corner SPLIT in the
    // summary rather than the corner key, and this equality is what holds
    // the split to the deal's own row filter.
    const rules = {
      shapes: SHAPES.filter((_, i) => (t >> i) & 1),
      mods: MODS.filter((_, i) => (t >> (i % 7)) & 1 || i % 3 === t % 3),
      time: TIMES[t % TIMES.length],
      density: DENSITIES[(t >> 2) % DENSITIES.length],
      difficulty: DIFFICULTIES[(t >> 1) % DIFFICULTIES.length],
      // The scroll opt-in joined 2026-08-17: its counts ride the per-corner
      // `over` split the way difficulty rides `diff`. Swept in both states
      // so the day the library first holds an oversized board, an
      // over-split error here is a red suite, not a wrong sheet count.
      scroll: ((t >> 3) & 1) === 1,
      count: 5,
    };
    if (!rules.shapes.length) continue;
    const filtered = eligibleRows(allRows, rules).length;
    assert.equal(countEligibleCorners(corners, rules), filtered,
      `the summary and the shards disagree on ${JSON.stringify(rules)}`);
    if (filtered > 0) nonZero++;
  }
  assert.ok(nonZero >= 100,
    `only ${nonZero} sweep rule sets found any supply — the sweep is not exercising the equality`);
});

test('LOCKSTEP: every file is priced under the model of the day', () => {
  const fp = modelFingerprint();
  const stale = [];
  if (summary.parModel !== fp) stale.push(`match-summary.json (${summary.parModel})`);
  for (const [shape, file] of Object.entries(shards)) {
    if (file.parModel !== fp) stale.push(`match-index-${shape}.json (${file.parModel})`);
  }
  pages.forEach((p, i) => {
    if (p.parModel !== fp) stale.push(`match-${String(i).padStart(3, '0')}.json (${p.parModel})`);
  });
  assert.deepEqual(stale, [],
    `these files were priced under an older model than the shipped ${fp}; `
    + 'run: node scripts/reprice-match-library.mjs');
});

test('every FIT board prices from its own stored features', () => {
  // Oversized boards are excluded because they price by a DIFFERENT rule,
  // not because they are unchecked: the model has no support at marathon
  // sizes (raw predictPar puts a 660-cell rect at 1068s and a 600-cell hex
  // at 17s), so the lane prices through marathonProvisionalPar from a real
  // anchor in support. The test right below holds every lane board to that
  // rule just as strictly as this one holds the fit library to predictPar.
  for (const b of boards) {
    if (b.oversized === true) continue;
    assert.ok(b.features, `${b.seed} stores its feature vector`);
    const par = Math.round(predictPar(b.features) * 10) / 10;
    assert.ok(Math.abs(par - b.par) < 0.06,
      `${b.seed}: stored par ${b.par} vs predictPar ${par}; run scripts/reprice-match-library.mjs`);
  }
});

test('the shard rows reproduce the page files row for row', () => {
  // The header is derived from the boards, so a feature key that reached the
  // pages and not the shards would show up here as a shorter union. It is
  // derived over EVERY board rather than per shard, so the positional
  // encoding means the same thing in all seven files.
  const keys = matchIndexFeatureKeys(boards);
  const expected = new Map();
  pages.forEach((p, pi) => p.boards.forEach((b, i) => {
    // A tombstoned slot yields no expected row, at its ORIGINAL index: a
    // shard row still pointing at one then fails below as "a board no page
    // holds", which is the failure an eviction must produce rather than mask.
    if (!b || b.evicted) return;
    expected.set(`${pi}:${i}`, matchIndexRow(pi, i, b, keys));
  }));
  // Keyed by FILE now, not by shape: the corner axis includes the modifier
  // set, so the filename is the only handle. Placement is already proven
  // above, against each row's own corner; what this checks is that the row
  // BYTES and the header match the pages.
  for (const f of shardNames) {
    assert.deepEqual(shards[f].featureKeys, keys,
      `${f}'s shard header must match the boards it describes`);
    for (const row of shards[f].rows) {
      const want = expected.get(`${row[0]}:${row[1]}`);
      assert.ok(want, `shard row p${row[0]}#${row[1]} names a board no page holds`);
      assert.deepEqual(row, want);
      expected.delete(`${row[0]}:${row[1]}`);
    }
  }
  assert.deepEqual([...expected.keys()], [], 'these stored boards reached no shard');
  assert.ok(allRows.length === boards.length, 'the client parser accepts every shipped shard');
});

test('every shipped index row carries a usable feature vector', () => {
  // Mission steering scores on these numbers, and a vector that silently
  // arrived empty would steer nothing while every test above stayed green.
  const parsed = allRows;
  const need = ['cellCount', 'totalMines', 'density', 'clueShare3'];
  for (const r of parsed) {
    for (const k of need) {
      assert.ok(Number.isFinite(r.features[k]),
        `${r.key} has no ${k}: steering cannot score it`);
    }
    assert.ok(r.features.cellCount > 0, `${r.key} has cellCount ${r.features.cellCount}`);
  }
  // Non-vacuity: the modifier counts must actually vary, or "a real count
  // outranks a bare presence" is a claim about a column of ones.
  const compass = parsed.map((r) => r.features.compassCellCount || 0).filter((n) => n > 0);
  assert.ok(compass.length > 20, `only ${compass.length} boards carry compass cells`);
  assert.ok(new Set(compass).size > 1, 'compassCellCount never varies: the vector is degenerate');
});

test('REGRESSION: no stored board is over on the opening click (his immediately-done ruling)', () => {
  // The pool's easiest corner certified at work 1 when probed (a 25-cell
  // rect), so the build's floor is what stands between the sheet's Quick
  // band and one-click boards.
  for (const b of boards) {
    assert.ok(b.work >= CLIMB_MIN_DEDUCTIONS,
      `${b.seed}: ${b.work} decisions is under the ${CLIMB_MIN_DEDUCTIONS}-decision floor`);
  }
});

test('seeds are unique across the whole library', () => {
  const seen = new Set();
  for (const b of boards) {
    assert.ok(!seen.has(b.seed), `${b.seed} appears twice`);
    seen.add(b.seed);
  }
});

test('every payload deserializes and its mine count is honest', () => {
  for (const b of boards) {
    const d = deserializeBoard(b.payload);
    let mines = 0;
    for (const row of d.board) for (const cell of row) { if (cell.isMine) mines++; }
    assert.equal(mines, d.totalMines, `${b.seed}: payload mines vs totalMines`);
    assert.equal(mines, b.spec.mines, `${b.seed}: payload mines vs spec`);
    assert.ok(Number.isInteger(d.firstClick), `${b.seed}: stored opener`);
  }
});

test('a deterministic sample re-certifies from its stored opener', () => {
  // The full ground-truth audit + no-guess proof on all ~900 boards is the
  // runtime's job one board at a time (certifyStoredBoard at install); here
  // a fixed-stride sample proves the pipeline end to end without minutes of
  // CI. Stride chosen so every shape lands in the sample.
  const sample = boards.filter((_, i) => i % 90 === 0);
  assert.ok(sample.length >= 8, 'the sample must be real');
  for (const b of sample) {
    const d = deserializeBoard(b.payload);
    const stored = d.board.flat().map((c) => [c.adjacentMines, c.displayedMines]);
    recalcAllAdjacency(d.board);
    recomputeDisplayedMines(d.board);
    const flat = d.board.flat();
    for (let i = 0; i < flat.length; i++) {
      assert.deepEqual([flat[i].adjacentMines, flat[i].displayedMines], stored[i],
        `${b.seed}: stored numbers must describe the stored mines (cell ${i})`);
    }
    const fc = d.firstClick;
    const check = isBoardSolvable(d.board, d.rows, d.cols, Math.floor(fc / d.cols), fc % d.cols);
    assert.ok(check.solvable && check.remainingUnknowns === 0,
      `${b.seed}: stored board no longer certifies from its opener`);
  }
});

test('the bands the sheet sells are stocked', () => {
  const cnt = {};
  for (const b of boards) {
    const band = timeBandOf(b.par);
    cnt[band] = (cnt[band] || 0) + 1;
    cnt[`${b.spec.shape}|${band}`] = (cnt[`${b.spec.shape}|${band}`] || 0) + 1;
  }
  for (const band of MATCH_TIME_BANDS) {
    // MARATHON is stocked by the lane, which grows a few boards a night
    // rather than arriving full, and it is also the one band a player
    // cannot reach by accident. Its floor is therefore its own and is
    // stated as a number that must RISE: if this ever reads as failing
    // because the lane shrank, that is the alarm working. Every other band
    // serves every host on every deal and keeps the full bar.
    const floor = band.key === 'marathon' ? 10 : 100;
    assert.ok((cnt[band.key] || 0) >= floor,
      `band ${band.key} holds ${cnt[band.key] || 0} boards, under its floor of ${floor}`);
  }
  for (const shape of SHAPES) {
    for (const band of ['quick', 'short']) {
      assert.ok((cnt[`${shape}|${band}`] || 0) >= 10,
        `${shape} x ${band} holds ${cnt[`${shape}|${band}`] || 0} boards; the sheet sells this corner`);
    }
  }
});

// ── The nightly refit actually re-prices it ─────────────────────────────
//
// The lockstep test above reddens when the library is stale, which only
// helps if something re-prices it every night. Source-scanned in the
// poolReprice pattern: the workflow is the one place this is wired, and a
// rename or a dropped step is exactly the silent failure the alarm cannot
// distinguish from a human forgetting.

test('the nightly refit re-prices the match library and commits it', () => {
  const wf = readFileSync(new URL(
    '../.github/workflows/refit-par-model.yml', import.meta.url), 'utf8');
  assert.match(wf, /node scripts\/reprice-match-library\.mjs/,
    'the refit no longer re-prices the match library');
  assert.match(wf, /git add [^\n]*scripts\/data\/match-library/,
    'the refit re-prices the library but never commits it');
  // A price-only night would otherwise report "nothing to commit" and throw
  // the re-price away.
  assert.match(wf, /git diff --quiet [^\n]*scripts\/data\/match-library/,
    'a price-only change would be seen as nothing to commit');
  assert.ok(wf.indexOf('reprice-match-library') < wf.indexOf('Commit and push'),
    'the re-price runs after the commit step, so its result is never committed');
  // Allowed to fail without costing the night its model fit, then reported
  // with the remedy named (the pool re-price's own contract).
  assert.match(wf, /id: matchreprice\s+continue-on-error: true/,
    'a failed re-price would abort the workflow before the model is committed');
  assert.match(wf, /steps\.matchreprice\.outcome == 'failure'/,
    'nothing checks the re-price outcome, so a failure would pass silently');
});

// ---- The top-up's aim: arity-scaled depth, and the targeted scalpel ----
//
// His ruling 2026-08-15: the modifier filter is a SUBSET test, so depth on a
// stacked corner serves hosts who already see the most boards (median 21
// eligible at zero modifiers allowed, 79 at three, measured with shape,
// length and density fixed). The buffer scales 20/15/10/8 by arity so
// generation lands where an audience can actually be short.

test('cornerTotalTarget scales its buffer by modifier arity (his 20/15/10/8 ruling)', () => {
  assert.equal(cornerTotalTarget(0, 0), 20);
  assert.equal(cornerTotalTarget(0, 1), 15);
  assert.equal(cornerTotalTarget(0, 2), 10);
  assert.equal(cornerTotalTarget(0, 3), 8);
  // Arity past the table's end holds at the deepest taper.
  assert.equal(cornerTotalTarget(0, 6), 8);
  assert.deepEqual(ARITY_BUFFERS, [20, 15, 10, 8]);
  // The played taper and the 100 ceiling are untouched by arity.
  assert.equal(cornerTotalTarget(90, 0), 100);
  assert.equal(cornerTotalTarget(150, 3), 160);
  assert.equal(cornerTotalTarget(300, 0), 305);
});

test('arityOfKey reads the corner key, plain corners included', () => {
  assert.equal(arityOfKey('rect||short|sparse'), 0);
  assert.equal(arityOfKey('cairo|sonar|long|dense'), 1);
  assert.equal(arityOfKey('hex|liar+walls|quick|standard'), 2);
});

test('validateTargetCorners refuses a key the library cannot hold', () => {
  assert.throws(() => validateTargetCorners([]), /non-empty/);
  assert.throws(() => validateTargetCorners(['nonsense|sonar|quick|dense']));
  assert.throws(() => validateTargetCorners(['rect|sonar|someday|dense']));
  // An unsorted modifier set would match no corner ever (matchCornerKey
  // sorts), so it throws rather than silently generating for nothing.
  assert.throws(() => validateTargetCorners(['rect|walls+liar|quick|dense']));
  const ok = validateTargetCorners(['rect||quick|dense', 'rect|liar+walls|quick|dense']);
  assert.equal(ok.length, 2);
});

test('every dealable FIT rect board fits the phone the rules describe', () => {
  // The pool outlives the rules it was searched under (BOARD_WIDTH_CAP moved
  // 2026-08-14), and the overnight burst regenerated 365 phone-illegal rects
  // from stale pool dims because nothing at the match generation boundary
  // re-checked fit. specsForCorner filters at consumption now and the
  // eviction tool tombstones offenders; this is the alarm if either stops.
  //
  // OVERSIZED boards are excluded BY DEFINITION, not waved through: the
  // marathon lane exists to ship boards a phone cannot hold, dealt only
  // under the scroll opt-in. They are held to their own ceiling by the test
  // below, so nothing is unmeasured; what would be a bug is an oversized
  // board reachable WITHOUT the opt-in, which the filter tests pin.
  const bad = boards
    .filter((b) => b.oversized !== true)
    .filter((b) => b.spec.shape === 'rect' && !rectFitsPhone(b.spec.rows, b.spec.cols))
    .map((b) => `${b.spec.rows}x${b.spec.cols}`);
  assert.deepEqual([...new Set(bad)].sort(), [],
    `${bad.length} dealable rect board(s) fail rectFitsPhone; run scripts/evict-match-surplus.mjs`);
});

test('every oversized board is inside the lane region, and priced by the right rule', () => {
  // The lane's own alarm, the counterpart to the fit rule above. His ceiling
  // is 2x the established fit-legal dims per shape (marathonFit.js), so a
  // lane board outside marathonFits is one nothing should have generated,
  // and a lane board without its anchor could never be re-priced when the
  // model moves.
  const lane = boards.filter((b) => b.oversized === true);
  for (const b of lane) {
    const M = b.spec.shape === 'rect' ? b.spec.rows : b.spec.M;
    const N = b.spec.shape === 'rect' ? b.spec.cols : b.spec.N;
    assert.ok(marathonFits(b.spec.shape, M, N),
      `${b.seed}: ${b.spec.shape} ${M}x${N} is outside the lane region`);
    assert.ok(b.par > 0 && b.par <= MARATHON_PAR_CEILING_SECONDS,
      `${b.seed}: par ${b.par}s is outside the lane's admission ceiling`);
    // WHICH PRICING RULE depends on whether the model has support at this
    // size, not on whether the board scrolls. An in-support board (the
    // proportion half of the lane: ordinary cell count, extraordinary shape)
    // is priced by predictPar like anything else and must NOT be flagged
    // provisional, or the flag would stop meaning "nobody has measured a
    // board this size".
    if (inSupportCells(b.spec.shape, b.spec.cells)) {
      assert.ok(!b.parProvisional,
        `${b.seed}: in-support board must not be flagged provisional`);
      assert.equal(b.anchorCells, undefined, `${b.seed}: in-support board needs no anchor`);
      const par = Math.round(predictPar(b.features) * 10) / 10;
      assert.ok(Math.abs(par - b.par) < 0.06,
        `${b.seed}: stored par ${b.par} vs predictPar ${par}; run scripts/reprice-match-library.mjs`);
    } else {
      assert.equal(b.parProvisional, true,
        `${b.seed}: an out-of-support par must be flagged provisional`);
      assert.ok(Number.isFinite(b.anchorCells) && b.anchorCells > 0,
        `${b.seed}: no anchorCells, so the nightly re-price cannot re-anchor it`);
      assert.ok(b.anchorFeatures && typeof b.anchorFeatures === 'object',
        `${b.seed}: no anchorFeatures`);
      // The stored par must be exactly what the pure rule says, so a page
      // hand-edited or written by an older tool cannot drift from the scheme.
      assert.equal(b.par, marathonProvisionalPar({
        cells: b.spec.cells, anchorPar: predictPar(b.anchorFeatures), anchorCells: b.anchorCells,
      }), `${b.seed}: stored par disagrees with marathonProvisionalPar under today's model`);
    }
  }
});

test('specsForCorner: anchors join, illegal rects are refused, only quick leads small', () => {
  // The illegal candidate is derived from the cap rather than typed, because
  // the cap itself is derived from the tap floor (2026-08-20) and a fixture
  // holding a remembered number stops testing anything the day it moves.
  const tooWide = BOARD_WIDTH_CAP + 1;
  const pool = [
    { shape: 'rect', rows: 12, cols: tooWide, cells: 12 * tooWide, mines: 30, gimmicks: [] },
    { shape: 'rect', rows: 8, cols: 9, cells: 72, mines: 14, gimmicks: [] },
    { shape: 'rect', rows: 13, cols: BOARD_WIDTH_CAP - 1, cells: 13 * (BOARD_WIDTH_CAP - 1), mines: 30, gimmicks: [] },
  ];
  // His expandable rule: a board already in the cell, whatever it wears,
  // donates its geometry to this corner's candidates.
  const anchor = { shape: 'rect', rows: 10, cols: 10, cells: 100, mines: 12, gimmicks: ['sonar', 'walls'] };
  const short = specsForCorner(pool, 'rect', 'sonar', 'short', [anchor]);
  assert.ok(short.length > 0, 'non-vacuous: candidates must exist');
  assert.ok(!short.some((s) => s.cols > BOARD_WIDTH_CAP), 'an illegal-width dim reached the candidates');
  assert.ok(short.every((s) => (s.gimmicks || []).join('+') === 'sonar'),
    'every candidate wears the corner\'s own modifier set');
  assert.ok(short.some((s) => s.cells === 100), 'the anchor geometry joined the candidates');
  // The big end leads for short (the census used to spend its budget on
  // boards that could only ever land quick), and the big end includes the
  // SYNTHESIZED legal ceiling the pool never held (probe-proven when the cap
  // was 11: 17x11 certifies long|standard plain, 16x11 short|sparse with one
  // sonar). The ceiling is re-derived here, not remembered, for the same
  // reason the illegal width above is.
  let ceilRows = 0;
  for (let r = 1; r <= 40; r++) if (rectFitsPhone(r, BOARD_WIDTH_CAP)) ceilRows = r;
  assert.equal(short[0].cells, ceilRows * BOARD_WIDTH_CAP,
    'the synthesized legal ceiling must lead the short candidates');
  assert.ok(short.every((s) => s.shape !== 'rect' || rectFitsPhone(s.rows, s.cols)),
    'a synthesized dim must be phone-legal too');
  // Quick keeps its proven small dims and gains no synthesized giants.
  const quick = specsForCorner(pool, 'rect', '', 'quick', []);
  assert.equal(quick[0].cells, 72);
  assert.ok(!quick.some((s) => s.cells > 13 * (BOARD_WIDTH_CAP - 1)),
    'quick must not carry synthesized big-end dims');
});

test('narrowHoles: pooled supply cannot hide an empty narrow floor', () => {
  const rows = [
    // hex short sparse holds ONLY a stacked board, so a host permitting
    // exactly sonar (or exactly walls) there draws nothing.
    { shape: 'hex', mods: ['sonar', 'walls'], time: 'short', dens: 'sparse' },
    // The same modifier single elsewhere must not mask the hole above.
    { shape: 'hex', mods: ['sonar'], time: 'quick', dens: 'sparse' },
    // A plain board floors every modifier at its own cell.
    { shape: 'rect', mods: [], time: 'short', dens: 'sparse' },
    { shape: 'rect', mods: ['sonar', 'walls'], time: 'short', dens: 'sparse' },
  ];
  const corners = narrowHoles(rows).map((h) => h.corner);
  assert.ok(corners.includes('hex|sonar|short|sparse'));
  assert.ok(corners.includes('hex|walls|short|sparse'));
  assert.ok(!corners.some((c) => c.startsWith('rect|')), 'plain supply floors the rect cell');
  // A cell with no pooled boards at all is a band question, not a hole:
  // nothing lists it, because generation cannot be sent there usefully.
  assert.ok(!corners.includes('hex|sonar|long|sparse'));
});

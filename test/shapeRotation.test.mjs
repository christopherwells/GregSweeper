// Daily shape rotation (Project Coastline) — the date-seeded draw, its start
// gate, the tiling-day mission lottery, the shared single-candidate builder,
// and the pipeline↔client agreement that builder exists to guarantee.
//
// The rotation went LIVE with v1.10, so the first test here is the shipped
// contract that replaced "dark means dark": the start date is set, dates
// behind it stay rectangular forever (their canonicals are already written),
// and dates from it forward actually draw. Everything else runs the machinery
// through explicit rotationStart/spec arguments, which is how the tests reach
// the tiling paths without depending on the shipped date.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TILING_ROTATION_START, resolveDailyShape, dailyTilingConfig,
  setDailyShapeOverride, getDailyShapeOverride, buildTilingDailyBoard,
} from '../src/logic/shapeRotation.js';
import { TILING_BAND_CONFIGS, drawDailyTilingConfig, tilingConfigAttempts } from '../src/logic/tilingBandConfigs.js';
import { selectTilingMission, candidateSeed, missionStamp } from '../src/logic/experimentDesign.js';
import { TILING_TYPES, buildTiling, containerIsStorable } from '../src/logic/tilingGeometry.js';
import { TILING_SAFE_GIMMICKS } from '../src/logic/tilingGenerator.js';
import { DAILY_SAFE_GIMMICKS } from '../src/logic/gimmicks.js';
import { serializeBoard, deserializeBoard } from '../src/firebase/dailyBoardSync.js';
import { isBoardSolvable } from '../src/logic/boardSolver.js';
import { cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import {
  selectBestCandidate, buildCanonicalPayload, buildCandidateFeatures, candidateOpener,
} from '../scripts/daily-board-pipeline.mjs';

// Sequential ET-style date strings starting 2027-01-01 (all future, so no
// collision with any real canonical's namespace).
function dates(n, from = '2027-01-01') {
  const out = [];
  const d = new Date(`${from}T12:00:00Z`);
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const START = '2027-01-01';

// ── The shipped gate: live, and the past stays rectangular ───────────────

// The flip date the v1.10 release set. The rotation shipped dark for two
// weeks behind a null constant; this is the contract that replaced it.
const SHIPPED_START = '2026-08-05';

test('shipped contract: the rotation is LIVE from its start date, and every earlier date stays rectangular', () => {
  assert.equal(TILING_ROTATION_START, SHIPPED_START,
    'moving the start date is a release (version bump + What\'s New + player copy), never a side effect');

  // Every date BEHIND the start must resolve rectangular forever. Those
  // canonicals are rectangles already written to write-once nodes, so a
  // client falling back to local generation on one of them would otherwise
  // build a board the canonical is not. This is why the constant may never
  // move backward.
  for (const d of dates(200, '2026-01-14')) {
    if (d >= SHIPPED_START) break;
    assert.equal(resolveDailyShape(d), null, `${d} predates the rotation and must be rectangular`);
  }

  // And from the start date the draw is actually running — a live month
  // with no tiling day would mean the flip landed inert.
  const live = dates(31, SHIPPED_START).map((d) => resolveDailyShape(d));
  assert.ok(live.some((s) => s !== null), 'the first live month drew no tiling day at all');
  assert.ok(live.some((s) => s === null), 'the first live month drew no rectangle at all');
});

test('the gate respects the start date and ignores non-dates', () => {
  assert.equal(resolveDailyShape('2026-12-31', START), null, 'the day before the start is rectangular');
  // On/after the start the draw runs — over a month, some days must be tilings.
  const drawn = dates(31, START).map((d) => resolveDailyShape(d, START));
  assert.ok(drawn.some((s) => s !== null), 'a live month with no tiling day means the draw is dead');
  // Practice custom seeds and malformed dates never draw, rotation on or off.
  for (const bad of ['rotatest1', '', '2027-1-1', '20270101', null, undefined, 42]) {
    assert.equal(resolveDailyShape(bad, START), null, `non-date ${String(bad)} must not draw`);
  }
});

test('the draw is deterministic and lands near the ruled 50/50 with all six tilings reachable', () => {
  const sample = dates(720, START);
  const counts = { rect: 0 };
  for (const t of TILING_TYPES) counts[t] = 0;
  for (const d of sample) {
    const first = resolveDailyShape(d, START);
    assert.equal(resolveDailyShape(d, START), first, `draw for ${d} must be stable across calls`);
    counts[first === null ? 'rect' : first]++;
  }
  const rectShare = counts.rect / sample.length;
  assert.ok(rectShare > 0.4 && rectShare < 0.6,
    `rectangles must hold ~50% of days (Christopher's ruling); got ${(rectShare * 100).toFixed(1)}%`);
  for (const t of TILING_TYPES) {
    assert.ok(counts[t] / sample.length >= 0.03,
      `${t} must be a real presence in the rotation (uniform among tilings); got ${counts[t]}/${sample.length}`);
  }
});

// ── The lockstep guard ───────────────────────────────────────────────────
// A daily mission force-injects a DAILY_SAFE gimmick onto the day's one
// board; on a tiling day that board is a tiling. If a future daily-safe
// gimmick ships without a tiling story, this must fail in CI — the runtime
// filter in buildTilingDailyBoard would otherwise drop it silently
// (deterministically, but silently).

test('LOCKSTEP GUARD: every daily-safe gimmick is tiling-safe', () => {
  for (const g of DAILY_SAFE_GIMMICKS) {
    assert.ok(TILING_SAFE_GIMMICKS.includes(g),
      `'${g}' is DAILY_SAFE but not TILING_SAFE — a tiling daily cannot honor its mission. `
      + 'Port the gimmick (tilingGenerator.js) or exclude it from tiling days EXPLICITLY '
      + 'before the rotation can ship it.');
  }
});

// ── The per-shape daily configs (banded draw, Par Bands Phase 2) ─────────
// Table validity (storability, proven density ranges, constructive routing,
// the rhombille 72-cell cost ceiling, in-band pricing) is pinned per entry
// in test/tilingBandConfigs.test.mjs. What THIS file pins is the seam:
// dailyTilingConfig(type, date) must BE the band module's draw — a private
// copy here is the missionSlots drift class reborn as configs.

test('dailyTilingConfig is the banded draw, dated, and always a real table entry', () => {
  for (const type of TILING_TYPES) {
    const cfg = dailyTilingConfig(type, '2027-03-01');
    assert.ok(cfg && Number.isInteger(cfg.M) && Number.isInteger(cfg.N) && Number.isInteger(cfg.mines),
      `${type} needs a daily config`);
    assert.equal(cfg, drawDailyTilingConfig(type, '2027-03-01'),
      `${type}: dailyTilingConfig must delegate to the band module's one draw`);
    assert.ok(TILING_BAND_CONFIGS[type].includes(cfg),
      `${type}: the drawn config must be a committed table entry`);
    const total = buildTiling(type, cfg.M, cfg.N).total;
    assert.ok(containerIsStorable(total),
      `${type} daily (${total} cells) must factor into a canonical-storable container`);
  }
  // Different dates draw different configs (the fixed-config era is over):
  // over a month of dates, at least one shape must vary its config.
  const varied = TILING_TYPES.some((type) => {
    const ids = new Set(dates(31, '2027-03-01').map((d) => dailyTilingConfig(type, d).id));
    return ids.size > 1;
  });
  assert.ok(varied, 'the banded draw must actually vary configs across dates');
});

// ── The tiling-day mission lottery ───────────────────────────────────────

const COVERAGE = [
  { feature: 'liarCellCount', n_boards: 1, deficit_weight: 0.5 },
  { feature: 'sonarCellCount', n_boards: 3, deficit_weight: 0.25 },
];

test('selectTilingMission draws gimmick-bearing slots only, deterministically', () => {
  // Observational primary + empty coverage: nothing to force → null (the
  // caller then uses the plain dateString seed + natural lottery).
  assert.equal(selectTilingMission('2027-02-01', 'clueShare3', []), null);

  // Gimmick primary + empty coverage: the primary is the whole pool.
  const p = selectTilingMission('2027-02-01', 'wormLoad', []);
  assert.equal(p.slot, 0);
  assert.equal(p.mission.isPrimary, true);
  assert.equal(p.mission.target, 'wormLoad');

  // Observational primary + coverage: the draw lives entirely in the
  // coverage slots — slot 0 must never appear.
  const seen = new Map();
  for (const d of dates(300, '2027-02-01')) {
    const pick = selectTilingMission(d, 'clueShare3', COVERAGE);
    assert.notEqual(pick, null);
    assert.notEqual(pick.slot, 0, 'an observational primary has no gimmick to force');
    assert.deepEqual(pick, selectTilingMission(d, 'clueShare3', COVERAGE), `draw for ${d} must be stable`);
    seen.set(pick.mission.target, (seen.get(pick.mission.target) || 0) + 1);
  }
  const liar = seen.get('liarCellCount') || 0;
  const sonar = seen.get('sonarCellCount') || 0;
  assert.ok(liar > 0 && sonar > 0, 'both coverage missions must be reachable');
  // P ∝ weight: 0.5 vs 0.25 → liar should run about twice as often. Loose
  // bounds — this is a frequency mechanism, not a quota.
  assert.ok(liar / sonar > 1.3 && liar / sonar < 3.2,
    `deficit weight must set frequency (liar ${liar} vs sonar ${sonar})`);
});

// ── The shared builder ───────────────────────────────────────────────────

const SPEC_SONAR = { target: 'sonarCellCount', coverage_targets: [] };

test('buildTilingDailyBoard produces a certified board on the DATE\'s drawn config, with the mission honored', () => {
  const built = buildTilingDailyBoard('2027-03-01', 'hex', SPEC_SONAR);
  assert.ok(built, 'hex daily must generate');
  const cfg = dailyTilingConfig('hex', '2027-03-01');
  assert.equal(built.rows * built.cols, buildTiling('hex', cfg.M, cfg.N).total,
    'the board must be built on the banded draw for this date');
  assert.equal(built.board._tiling.M, cfg.M);
  assert.equal(built.board._tiling.N, cfg.N);
  assert.equal(built.firstClick, buildTiling('hex', cfg.M, cfg.N).centerIndex,
    'the opener is the tiling\'s own centre, never the container centre');
  assert.equal(built.rngSeed, candidateSeed('2027-03-01', 0), 'gimmick primary + empty coverage → slot 0 seed');
  assert.ok(built.activeGimmicks.includes('sonar'), 'the mission gimmick must be force-injected');
  assert.ok(built.check.solvable && built.check.remainingUnknowns === 0, 'certified');
  let mines = 0;
  for (const row of built.board) for (const c of row) if (c.isMine) mines++;
  assert.equal(built.totalMines, mines);
  assert.equal(built.board._tiling.type, 'hex');

  // Re-certify independently from the returned opener — the builder's claim
  // checked with a fresh solver run, not its own word for it.
  const fr = Math.floor(built.firstClick / built.cols), fc = built.firstClick % built.cols;
  const check = isBoardSolvable(built.board, built.rows, built.cols, fr, fc);
  cleanSolverArtifacts(built.board);
  assert.ok(check.solvable && check.remainingUnknowns === 0, 'independent re-certification');
});

test('a no-mission day uses the plain date seed and still certifies', () => {
  const built = buildTilingDailyBoard('2027-03-02', 'hex', { target: 'clueShare3', coverage_targets: [] });
  assert.ok(built);
  assert.equal(built.rngSeed, '2027-03-02', 'no gimmick-bearing slot → plain dateString seed');
  assert.equal(built.mission.target, 'clueShare3', 'the day still records the primary banner');
  assert.ok(built.check.solvable && built.check.remainingUnknowns === 0);
});

test('the builder is deterministic: two runs serialize byte-identically', () => {
  const a = buildTilingDailyBoard('2027-03-03', 'hex', SPEC_SONAR);
  const b = buildTilingDailyBoard('2027-03-03', 'hex', SPEC_SONAR);
  const wire = (r) => JSON.stringify(serializeBoard({
    board: r.board, rows: r.rows, cols: r.cols, totalMines: r.totalMines,
    rngSeed: r.rngSeed, activeGimmicks: r.activeGimmicks, firstClick: r.firstClick,
  }));
  assert.equal(wire(a), wire(b));
});

// ── Pipeline ↔ client agreement ──────────────────────────────────────────
// Both paths call buildTilingDailyBoard, so agreement is structural; what
// these pin is that the PIPELINE threads the builder's result through
// unchanged (payload, features, opener) — the seam where a private copy
// could quietly reappear (the missionSlots drift class).

test('DIFFERENTIAL: the pipeline tiling branch is the shared builder verbatim', () => {
  const built = buildTilingDailyBoard('2027-03-04', 'hex', SPEC_SONAR);
  const cand = selectBestCandidate('2027-03-04', SPEC_SONAR, 'hex');
  assert.equal(cand.tilingType, 'hex');
  assert.equal(cand.rngSeed, built.rngSeed);
  assert.equal(cand.firstClick, built.firstClick);
  assert.equal(candidateOpener(cand), built.firstClick);

  const pipelinePayload = buildCanonicalPayload(cand, 'test-build');
  const clientPayload = serializeBoard({
    board: built.board, rows: built.rows, cols: built.cols,
    totalMines: built.totalMines, rngSeed: built.rngSeed,
    activeGimmicks: built.activeGimmicks, codeVersion: 'test-build',
    firstClick: built.firstClick,
  });
  Object.assign(clientPayload, missionStamp(built.mission));
  assert.equal(JSON.stringify(pipelinePayload), JSON.stringify(clientPayload),
    'precompute and client fallback must write the SAME canonical, byte for byte');

  // The payload carries the tiling contract fields and the features carry
  // the shape, from the tiling's own opener.
  assert.ok(Array.isArray(pipelinePayload.cellNeighbors));
  assert.equal(pipelinePayload.tiling.type, 'hex');
  assert.equal(pipelinePayload.firstClick, built.firstClick);
  assert.equal(pipelinePayload.missionTarget, 'sonarCellCount');
  const features = buildCandidateFeatures(cand);
  assert.equal(features.tilingType, 'hex');

  // And the stored payload round-trips to the same certified opener.
  const restored = deserializeBoard(JSON.parse(JSON.stringify(pipelinePayload)));
  assert.equal(restored.firstClick, built.firstClick);
});

test('rect control: a null shape leaves the rectangular contest untouched and its payload clean', () => {
  const cand = selectBestCandidate('2027-03-05', { target: 'clueShare3', coverage_targets: [] }, null);
  assert.equal(cand.tilingType, undefined);
  assert.equal(cand.firstClick, undefined);
  const payload = buildCanonicalPayload(cand, 'test-build');
  for (const key of ['firstClick', 'cellNeighbors', 'cellPos', 'tiling', 'tilingWalls']) {
    assert.ok(!(key in payload), `a rectangular payload must not grow a '${key}' field`);
  }
  // Same opener rule as before the rotation: the container centre.
  assert.equal(candidateOpener(cand), Math.floor(cand.rows / 2) * cand.cols + Math.floor(cand.cols / 2));
});

// ── The test-env override ────────────────────────────────────────────────

test('setDailyShapeOverride accepts tiling names, lay aliases, rect/Classic — rejects everything else', () => {
  try {
    assert.equal(setDailyShapeOverride('hex'), 'hex');
    assert.equal(getDailyShapeOverride(), 'hex');
    assert.equal(setDailyShapeOverride('RHOMBILLE'), 'rhombille');
    assert.equal(setDailyShapeOverride('rect'), 'rect');
    // The player-facing names work as override tokens too (the naming
    // ruling, 2026-08-02): the Classic grid and the lay tiling names.
    assert.equal(setDailyShapeOverride('classic'), 'rect');
    assert.equal(setDailyShapeOverride('Honeycomb'), 'hex');
    assert.equal(setDailyShapeOverride('3dcubes'), 'rhombille');
    assert.equal(setDailyShapeOverride('kites'), 'deltoidal');
    assert.equal(setDailyShapeOverride('bogus'), null, 'an unknown token clears rather than guesses');
    assert.equal(getDailyShapeOverride(), null);
    assert.equal(setDailyShapeOverride(''), null);
  } finally {
    setDailyShapeOverride(null); // module state — leave it clean for other files
  }
});

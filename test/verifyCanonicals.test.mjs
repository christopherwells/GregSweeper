// Canonical-board integrity sweep (the #114 detection layer). The sweep is
// only worth its alarm if it actually bites on tampering, so these pin: real
// shipped canonicals PASS, and each tamper class FAILS with the right reason.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { verifyCanonicalPayload, verifyCruxPayload, verifyMetaAgainstBoard, FEATURES_EPOCH } =
  await import('../scripts/verify-canonical-boards.mjs');
const { deserializeBoard } = await import('../src/firebase/dailyBoardSync.js');
const { isBoardSolvable } = await import('../src/logic/boardSolver.js');
const { cleanSolverArtifacts } = await import('../src/logic/boardGenerator.js');
const { computeDailyFeatures, SOLVER_DERIVED_FEATURE_KEYS } = await import('../src/logic/dailyFeatures.js');

// Mirror verifyMetaAgainstBoard's own recompute so tests can build an
// exactly-matching "stored" features object to perturb.
function recomputeFeatures(raw) {
  const d = deserializeBoard(raw);
  const fr = Math.floor(d.rows / 2), fc = Math.floor(d.cols / 2);
  const check = isBoardSolvable(d.board, d.rows, d.cols, fr, fc);
  cleanSolverArtifacts(d.board);
  return computeDailyFeatures(
    { board: d.board, rows: d.rows, cols: d.cols, totalMines: d.totalMines, activeGimmicks: d.activeGimmicks, rngSeed: d.rngSeed || '' },
    check,
    // The sweep passes the stored opener, so the mirror must too — without
    // it the "stored" meta lacks the contribution keys the recompute now
    // emits, and every fixture reads as lying-by-omission.
    { contributionOpener: { row: fr, col: fc } },
  );
}

const dailyRaw = JSON.parse(readFileSync(new URL('./fixtures/dailyBoard-2026-06-14.json', import.meta.url), 'utf8'));
const weeklyRaw = JSON.parse(readFileSync(new URL('./fixtures/weeklyBoard-2026-05-25.json', import.meta.url), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

test('real shipped canonicals verify clean (daily + weekly)', () => {
  assert.equal(verifyCanonicalPayload(dailyRaw).ok, true);
  assert.equal(verifyCanonicalPayload(weeklyRaw).ok, true);
});

test('REGRESSION #114: a lying displayed number is caught', () => {
  const tampered = clone(dailyRaw);
  // Find a numbered non-mine cell and shift its displayed value.
  const i = tampered.cells.findIndex((c) => !c.isMine && (c.displayedMines || 0) > 0);
  assert.ok(i >= 0, 'fixture has a numbered cell');
  tampered.cells[i].displayedMines = (tampered.cells[i].displayedMines || 0) + 1;
  const v = verifyCanonicalPayload(tampered);
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /inconsistent displayedMines/);
});

test('REGRESSION #114: a mine-count lie is caught', () => {
  const tampered = clone(dailyRaw);
  tampered.totalMines = tampered.totalMines + 3;
  const v = verifyCanonicalPayload(tampered);
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /mine count/);
});

test('REGRESSION #114: a relocated mine (stale numbers) is caught', () => {
  const tampered = clone(dailyRaw);
  const mineIdx = tampered.cells.findIndex((c) => c.isMine);
  const safeIdx = tampered.cells.findIndex((c) => !c.isMine);
  tampered.cells[mineIdx].isMine = false;
  tampered.cells[safeIdx].isMine = true;
  const v = verifyCanonicalPayload(tampered);
  assert.equal(v.ok, false, 'moving a mine without fixing the numbers must fail');
});

test('REGRESSION: a pre-worm meta (no wormLoad key) passes on an egg-free board — pipeline vintage, not tampering', () => {
  // Future-dated boards precomputed before worm tiles shipped carry metas
  // without the wormLoad key; the sweep recomputes 0 and must not
  // hard-fail every one of them the night the feature merges.
  const features = recomputeFeatures(dailyRaw);
  delete features.wormLoad;
  const v = verifyMetaAgainstBoard(dailyRaw, { features });
  assert.equal(v.ok, true, `vintage meta must pass: ${v.reasons.join('; ')}`);
});

test('a tampered worm egg count is still a hard failure', () => {
  const features = recomputeFeatures(dailyRaw);
  // Stored claims eggs on an egg-free board.
  const lying = { ...features, wormLoad: 2 };
  const v1 = verifyMetaAgainstBoard(dailyRaw, { features: lying });
  assert.equal(v1.ok, false);
  assert.match(v1.reasons.join(' '), /wormLoad/);
  // Board carries an egg but the meta omits the key entirely — an old
  // pipeline cannot have produced an egg board, so vintage does not excuse it.
  const eggBoard = clone(dailyRaw);
  const safeIdx = eggBoard.cells.findIndex((c) => !c.isMine && (c.adjacentMines || 0) > 0);
  eggBoard.cells[safeIdx].isWormEgg = true;
  const vintage = recomputeFeatures(dailyRaw);
  delete vintage.wormLoad;
  const v2 = verifyMetaAgainstBoard(eggBoard, { features: vintage });
  assert.equal(v2.ok, false, 'an egg board with a keyless meta must hard-fail');
  assert.match(v2.reasons.join(' '), /wormLoad/);
});

// ── Issue #180: structural is the DEFAULT, not an allowlist ───────────────
// The sweep used to hard-fail only the feature names on a hand-written list.
// Two of them named fields computeDailyFeatures never emits, and everything
// the list never mentioned — density, gimmickTypeCount, nonZeroSafeCellCount,
// zeroClusterCount (a shipped par predictor) and the four clue shares — was
// silently downgraded to a warning on a green workflow. dailyMeta is unsigned
// and anonymous-writable write-once, so this sweep is its ONLY integrity layer.

test('REGRESSION #180: a fabricated STRUCTURAL feature hard-fails rather than warning', () => {
  const features = recomputeFeatures(dailyRaw);
  const structural = Object.keys(features).filter((k) => !SOLVER_DERIVED_FEATURE_KEYS.includes(k));
  assert.ok(structural.length >= 20, `expected a full structural set, got ${structural.length}`);

  for (const key of structural) {
    const lying = { ...features, [key]: typeof features[key] === 'number' ? features[key] + 1 : 'TAMPERED' };
    const v = verifyMetaAgainstBoard(dailyRaw, { features: lying });
    assert.equal(v.ok, false, `a fabricated features.${key} must FAIL the sweep, not warn`);
    assert.match(v.reasons.join(' '), new RegExp(`features\\.${key}\\b`));
    assert.equal(v.warnings.length, 0, `features.${key} must not be excused as solver drift`);
  }
});

test('REGRESSION #180: a meta written BEFORE a feature shipped is vintage, not tampering', () => {
  // The horizon collision that makes the inverted default dangerous if it
  // ships bare. dailyMeta is write-once and the pipeline writes seven days
  // ahead, so for a week after any new feature key lands, every future board in
  // flight carries a meta that legitimately lacks it. MEASURED against the live
  // database with an absence-hard-fails rule: dailyMeta/2026-07-19..22 all fail
  // on `clueShare2: stored undefined` (the clue shares shipped 2026-07-18), and
  // the printed remediation would have regenerated four perfectly good boards.
  const features = recomputeFeatures(dailyRaw);
  // A share the board really carries, so the value hatch cannot excuse it.
  assert.ok(features.clueShare2 > 0, 'fixture must carry a nonzero clue share');
  const { clueShare2, ...withoutShare } = features;

  const old = verifyMetaAgainstBoard(dailyRaw, {
    features: withoutShare, writtenAt: Date.parse('2026-07-01T00:00:00Z'),
  });
  assert.equal(old.ok, true, 'a meta predating the feature must not fail the workflow');
  assert.match(old.warnings.join(' '), /features\.clueShare2.*vintage/);

  // The other side of the same rule: a meta written by a pipeline that KNEW the
  // key is lying by omission, which is how a poisoner would otherwise zero a
  // feature without ever stating a false number. "Knew" means written after
  // the LIVE epoch — anchored to the sweep's own export, because the epoch
  // legitimately sits a few days in the FUTURE right after a new feature key
  // ships (the deploy buffer), and a clock-anchored writtenAt would read as
  // vintage exactly then.
  const recent = verifyMetaAgainstBoard(dailyRaw, {
    features: withoutShare, writtenAt: Date.parse(`${FEATURES_EPOCH}T00:00:00Z`) + 86400000,
  });
  assert.equal(recent.ok, false, 'omitting a key a recent pipeline knew must hard-fail');
  assert.match(recent.reasons.join(' '), /features\.clueShare2/);
});

test('a zero-recomputing absent key stays vintage regardless of when the meta was written', () => {
  // The original hatch, preserved: the board does not carry the thing, so a
  // pipeline that never knew the key is indistinguishable from one that wrote 0.
  const features = recomputeFeatures(dailyRaw);
  assert.equal(features.wormLoad, 0, 'fixture is egg-free');
  delete features.wormLoad;
  const v = verifyMetaAgainstBoard(dailyRaw, { features, writtenAt: Date.now() });
  assert.equal(v.ok, true);
});

test('solver-derived move counts still WARN — a mid-horizon solver change is not tampering', () => {
  const features = recomputeFeatures(dailyRaw);
  for (const key of SOLVER_DERIVED_FEATURE_KEYS) {
    const drifted = { ...features, [key]: (features[key] || 0) + 1 };
    const v = verifyMetaAgainstBoard(dailyRaw, { features: drifted });
    assert.equal(v.ok, true, `features.${key} drifting must not fail the workflow`);
    assert.match(v.warnings.join(' '), new RegExp(`features\\.${key}\\b`));
  }
});

test('a structurally broken payload fails gracefully, never throws', () => {
  const broken = clone(dailyRaw);
  broken.cells = broken.cells.slice(0, 10);
  const v = verifyCanonicalPayload(broken);
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /deserialize failed/);
  assert.equal(verifyCanonicalPayload(null).ok, false);
});

// ── Tiling canonicals (Coastline shape rotation) ──────────────────────────
// The rotation ships dark, but the sweep must already bite on the payloads it
// will one day walk: a tiling canonical carries its topology, geometry, and
// certified opener as data, and every tamper class the rectangular fixtures
// pin needs its tiling counterpart — plus the two classes only a tiling has
// (a corrupted adjacency list, a forged opener).

const { buildTilingDailyBoard: _buildTiling } = await import('../src/logic/shapeRotation.js');
const { selectBestCandidate: _sbc, buildCanonicalPayload: _bcp, buildCandidateFeatures: _bcf } =
  await import('../scripts/daily-board-pipeline.mjs');
const { cruxPayloadFromBoard } = await import('../src/logic/cruxExtract.js');

const _tilingSpec = { target: 'sonarCellCount', coverage_targets: [] };
const _tilingCand = _sbc('2027-06-01', _tilingSpec, 'hex');
const tilingRaw = clone(_bcp(_tilingCand, 'test-build'));

test('a tiling canonical verifies clean, end to end', () => {
  const v = verifyCanonicalPayload(tilingRaw);
  assert.equal(v.ok, true, `tiling payload must pass the sweep: ${v.reasons.join('; ')}`);
  // And its meta, exactly as the pipeline writes it.
  const m = verifyMetaAgainstBoard(tilingRaw, {
    features: _bcf(_tilingCand), writtenAt: Date.now(),
  }, '2027-06-01');
  assert.equal(m.ok, true, `tiling meta must pass: ${m.reasons.join('; ')}`);
});

test('tiling tamper: a lying displayed number is caught on a lattice too', () => {
  const tampered = clone(tilingRaw);
  const i = tampered.cells.findIndex((c) => !c.isMine && (c.displayedMines || 0) > 0);
  assert.ok(i >= 0);
  tampered.cells[i].displayedMines = (tampered.cells[i].displayedMines || 0) + 1;
  const v = verifyCanonicalPayload(tampered);
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /inconsistent displayedMines/);
});

test('tiling tamper: a forged opener (firstClick onto a mine) fails certification', () => {
  const tampered = clone(tilingRaw);
  const mineIdx = tampered.cells.findIndex((c) => c.isMine);
  assert.ok(mineIdx >= 0);
  tampered.firstClick = mineIdx;
  const v = verifyCanonicalPayload(tampered);
  assert.equal(v.ok, false, 'certifying from a forged opener must fail');
  assert.match(v.reasons.join(' '), /does NOT certify/);
});

test('tiling tamper: an asymmetric adjacency list is refused at deserialize', () => {
  // One direction of one edge removed: cell A still counts B's mines, B no
  // longer counts A's. This does not crash anything downstream — it quietly
  // certifies a board nobody can solve — which is exactly why
  // defineCellNeighbors validates symmetry and the sweep must report it as
  // a deserialize failure, not play through it.
  const tampered = clone(tilingRaw);
  const a = tampered.cellNeighbors.findIndex((l) => Array.isArray(l) && l.length > 0);
  const b = tampered.cellNeighbors[a][0];
  tampered.cellNeighbors[a] = tampered.cellNeighbors[a].filter((n) => n !== b);
  const v = verifyCanonicalPayload(tampered);
  assert.equal(v.ok, false);
  assert.match(v.reasons.join(' '), /deserialize failed/);
});

test('tiling meta tamper: a shape lie is STRUCTURAL and hard-fails', () => {
  const features = _bcf(_tilingCand);
  assert.equal(features.tilingType, 'hex');
  // Claiming a different lattice: par would price under the wrong shape
  // equation (modelFor dispatches on this key), so it must never warn.
  const shapeLie = verifyMetaAgainstBoard(tilingRaw, {
    features: { ...features, tilingType: 'rhombille' }, writtenAt: Date.now(),
  }, '2027-06-01');
  assert.equal(shapeLie.ok, false);
  assert.match(shapeLie.reasons.join(' '), /features\.tilingType/);
  assert.equal(shapeLie.warnings.length, 0, 'a shape lie must not be excused as solver drift');
  // And a garden-variety count lie on the same payload.
  const countLie = verifyMetaAgainstBoard(tilingRaw, {
    features: { ...features, totalMines: features.totalMines + 2 }, writtenAt: Date.now(),
  }, '2027-06-01');
  assert.equal(countLie.ok, false);
});

test('a tiling board ships NO crux teaser (rectangular crop is meaningless on a lattice)', () => {
  const fr = Math.floor(_tilingCand.firstClick / _tilingCand.cols);
  const fc = _tilingCand.firstClick % _tilingCand.cols;
  assert.equal(
    cruxPayloadFromBoard(_tilingCand.board, _tilingCand.rows, _tilingCand.cols, fr, fc),
    null,
    'the precompute/regenerate crux write must skip tiling days',
  );
});

test('crux soundness: an honest mini passes, a lying one fails', () => {
  // Classic 1-1 overlap: the corner 1 caps {(0,1),(1,0)} at one mine, a
  // subset of the center 1's neighborhood — so the center's remaining
  // neighbors, (2,2) included, are provably safe. (No revealed 0s: a real
  // crux never has an unflooded 0, and the frontier treats flood as a
  // mechanic, not a deduction.)
  const cells = [{ r: 1, c: 1, n: 1 }, { r: 0, c: 0, n: 1 }];
  assert.equal(verifyCruxPayload({ rows: 3, cols: 3, cells, answer: { r: 2, c: 2 } }).ok, true);
  // Same layout claiming an UNPROVABLE cell as the answer — a lying teaser.
  const wrongAnswer = verifyCruxPayload({ rows: 3, cols: 3, cells, answer: { r: 0, c: 1 } });
  assert.equal(wrongAnswer.ok, false);
  assert.match(wrongAnswer.reasons.join(' '), /not provably safe/);
  // An 8 makes every neighbor a provable MINE — no safe cell exists at all.
  const noSafe = verifyCruxPayload({ rows: 3, cols: 3, cells: [{ r: 1, c: 1, n: 8 }], answer: { r: 0, c: 0 } });
  assert.equal(noSafe.ok, false);
  assert.match(noSafe.reasons.join(' '), /NO provably safe/);
  assert.equal(verifyCruxPayload({ rows: 99, cols: 1, cells: [] }).ok, false);
  assert.equal(verifyCruxPayload(null).ok, false);
});

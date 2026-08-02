// Par Lab: the designed 100-board battery for per-shape par priors, its
// deterministic builder, and the recording contract. The exhaustive
// every-board generation proof lives in scripts/validate-parlab-battery.mjs
// (run offline on any battery revision — the Laves lattices cost seconds);
// what CI pins here is the DESIGN (composition, coverage, ordering, stable
// ids) and the recording semantics the offline fit depends on, plus a
// fast-shape generation sample so the builder itself stays proven.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PAR_LAB_BATTERY, PAR_LAB_CHUNK_SIZE, parLabSeed, buildParLabBoard,
  resolvedIds, nextParLabBoard, attemptCountFor, labProgress,
  buildParLabRow, appendParLabRow, exportParLab,
} from '../src/logic/parLab.js';
import { TILING_TYPES, buildTiling } from '../src/logic/tilingGeometry.js';
import { TILING_SAFE_GIMMICKS } from '../src/logic/tilingGenerator.js';
import { DAILY_SAFE_GIMMICKS } from '../src/logic/gimmicks.js';
import { coastlineBoardFor } from '../src/logic/coastlineLink.js';

// ── Battery design ───────────────────────────────────────────────────────

test('the battery is 105 boards in 21 chunks of 5 with stable unique ids and seeds', () => {
  assert.equal(PAR_LAB_BATTERY.length, 105);
  assert.equal(PAR_LAB_CHUNK_SIZE, 5);
  const ids = new Set();
  const seeds = new Set();
  PAR_LAB_BATTERY.forEach((b, i) => {
    assert.equal(b.seq, i + 1, 'seq is 1-based battery order');
    assert.equal(b.chunk, Math.floor(i / 5) + 1, 'chunk derives from seq');
    ids.add(b.id);
    seeds.add(parLabSeed(b, 0));
  });
  assert.equal(ids.size, 105, 'ids must be unique — progress is keyed on them');
  assert.equal(seeds.size, 105, 'seeds must be unique — two boards must never share a layout');
  assert.equal(PAR_LAB_BATTERY.at(-1).chunk, 21);
});

test('composition: 18 warm-ups in same-shape runs of three, 9 square anchors interleaved, 16 boards per tiling', () => {
  const warmups = PAR_LAB_BATTERY.filter((b) => b.warmup);
  assert.equal(warmups.length, 18, 'three warm-ups per tiling');
  // The learning curve must land at the START, where the analysis excludes it.
  assert.ok(PAR_LAB_BATTERY.slice(0, 18).every((b) => b.warmup), 'warm-ups are the first 18 boards');
  assert.ok(warmups.every((b) => b.gimmicks.length === 0), 'warm-ups are plain');
  // SAME-SHAPE RUNS (his call): acclimation builds on consecutive boards of
  // one lattice, so each shape's three warm-ups are back to back.
  for (let i = 0; i < 18; i += 3) {
    const run = PAR_LAB_BATTERY.slice(i, i + 3);
    assert.equal(new Set(run.map((b) => b.shape)).size, 1,
      `warm-up boards ${i + 1}-${i + 3} must share one shape (got ${run.map((b) => b.shape).join(', ')})`);
  }
  for (const shape of TILING_TYPES) {
    const cfg = coastlineBoardFor(shape);
    const w = warmups.filter((b) => b.shape === shape);
    assert.equal(w.length, 3, `${shape} gets three warm-ups`);
    assert.ok(w.every((b) => b.M === cfg.M && b.N === cfg.N && b.mines === cfg.mines),
      `${shape} warm-ups are its daily config`);
  }

  const anchors = PAR_LAB_BATTERY.filter((b) => b.shape === 'rect');
  assert.equal(anchors.length, 9, 'nine square calibration anchors');
  assert.ok(anchors.every((b) => b.gimmicks.length === 0 && !b.warmup));
  // Interleaved through the session, not bunched: first soon after the
  // warm-ups, last inside the closing stretch, no two adjacent.
  const anchorSeqs = anchors.map((b) => b.seq);
  assert.ok(Math.min(...anchorSeqs) <= 28 && Math.max(...anchorSeqs) >= 85,
    `anchors must span the session (got ${anchorSeqs.join(',')})`);
  const sorted = [...anchorSeqs].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i] - sorted[i - 1] >= 2, 'no two anchors back to back');
  }

  for (const shape of TILING_TYPES) {
    const all = PAR_LAB_BATTERY.filter((b) => b.shape === shape);
    assert.equal(all.length, 16, `${shape}: 3 warm-up + 9 plain grid + 4 modifier`);
    const plain = all.filter((b) => !b.warmup && b.gimmicks.length === 0);
    assert.equal(plain.length, 9, `${shape}: 3 sizes x 3 densities`);
    const totals = new Set(plain.map((b) => `${b.M}x${b.N}`));
    assert.equal(totals.size, 3, `${shape}: three distinct sizes`);
    for (const dims of totals) {
      assert.equal(plain.filter((b) => `${b.M}x${b.N}` === dims).length, 3,
        `${shape} ${dims}: three density points`);
    }
    assert.equal(all.filter((b) => b.gimmicks.length === 1).length, 4, `${shape}: four modifier singles`);
  }
});

test('the size x density grid is the block live dailies cannot supply', () => {
  // The shape rotation ships FIXED per-shape configs, so live tiling rows
  // carry constant cellCount/totalMines within a shape and those deviation
  // columns are collinear with the intercept. The lab grid must actually
  // VARY both axes per shape — that is its whole reason to exist.
  for (const shape of TILING_TYPES) {
    const plain = PAR_LAB_BATTERY.filter((b) => b.shape === shape && !b.warmup && b.gimmicks.length === 0);
    const totals = new Set(plain.map((b) => buildTiling(b.shape, b.M, b.N).total));
    const densities = new Set(plain.map((b) => (b.mines / buildTiling(b.shape, b.M, b.N).total).toFixed(3)));
    assert.ok(totals.size >= 3, `${shape}: cell count must vary`);
    assert.ok(densities.size >= 5, `${shape}: density must vary across the grid (got ${[...densities].join(', ')})`);
    for (const b of plain) {
      const d = b.mines / buildTiling(b.shape, b.M, b.N).total;
      assert.ok(d >= 0.13 && d <= 0.29, `${b.id}: density ${d.toFixed(3)} inside the designed band`);
    }
  }
});

test('modifier coverage follows the mechanism: region-geometry gimmicks oversampled, all tiling-safe', () => {
  const counts = new Map();
  const shapesFor = new Map();
  for (const b of PAR_LAB_BATTERY) {
    for (const g of b.gimmicks) {
      assert.ok(TILING_SAFE_GIMMICKS.includes(g), `${b.id}: '${g}' is not tiling-safe`);
      counts.set(g, (counts.get(g) || 0) + 1);
      if (!shapesFor.has(g)) shapesFor.set(g, new Set());
      shapesFor.get(g).add(b.shape);
    }
  }
  for (const g of DAILY_SAFE_GIMMICKS) {
    assert.ok((counts.get(g) || 0) >= 2,
      `'${g}' needs at least two lab boards for a usable pooled prior (got ${counts.get(g) || 0})`);
  }
  // The gimmicks whose information REGION is a function of the lattice get
  // the replication — they are where a per-shape effect is mechanically
  // plausible, so they are where the boards buy the most.
  assert.ok(counts.get('sonar') >= 4, 'sonar: depth-2 graph ball scales with valence');
  assert.ok(counts.get('compass') >= 4, 'compass: three direction families across the lattices');
  assert.ok(counts.get('wormhole') >= 3, 'wormhole: pair-sum ceiling varies by lattice');
  assert.ok(counts.get('worm') >= 3, 'worm: crawls the neighbor graph');
  // Compass must actually SPAN its three direction families (8-dir, 60°,
  // 30°), or its boards measure one family three times.
  const compassShapes = shapesFor.get('compass');
  assert.ok(['4.8.8', 'cairo'].some((s) => compassShapes.has(s)), 'compass covers an 8-dir lattice');
  assert.ok(['hex', 'rhombille'].some((s) => compassShapes.has(s)), 'compass covers a 60° lattice');
  assert.ok(['floret', 'deltoidal'].some((s) => compassShapes.has(s)), 'compass covers a 30° lattice');
  // And the sum-20 case is real, not hypothetical.
  assert.ok(shapesFor.get('wormhole').has('rhombille'), 'wormhole must visit the sum-ceiling-20 lattice');
});

test('ordering interleaves shapes — no lattice is learned in one block', () => {
  // After the warm-ups (which are deliberately same-shape runs), no three
  // consecutive boards share a shape, so practice effects spread across
  // lattices instead of loading onto one.
  const main = PAR_LAB_BATTERY.slice(18);
  for (let i = 2; i < main.length; i++) {
    const s = new Set([main[i].shape, main[i - 1].shape, main[i - 2].shape]);
    assert.ok(s.size >= 2, `boards ${main[i - 2].seq}-${main[i].seq} are all ${main[i].shape}`);
  }
});

test('seeds carry design salts and retries get fresh layouts', () => {
  const salted = PAR_LAB_BATTERY.find((b) => b.id === 'p-deltoidal-L0');
  assert.ok(salted, 'the salted spec exists');
  assert.match(parLabSeed(salted, 0), /:s\d+$/, 'the design salt is part of the seed');
  const plain = PAR_LAB_BATTERY[0];
  assert.equal(parLabSeed(plain, 0), `parlab:${plain.id}`);
  assert.equal(parLabSeed(plain, 2), `parlab:${plain.id}:r2`);
  assert.notEqual(parLabSeed(plain, 1), parLabSeed(plain, 2), 'every retry is a fresh layout');
});

// ── Builder (fast sample; the full sweep is the offline validator) ───────

test('the builder is deterministic and certified on both board families', () => {
  const hexWarmup = PAR_LAB_BATTERY.find((b) => b.id === 'w-hex-1');
  const anchor = PAR_LAB_BATTERY.find((b) => b.shape === 'rect');
  for (const spec of [hexWarmup, anchor]) {
    const a = buildParLabBoard(spec, 0);
    const b = buildParLabBoard(spec, 0);
    assert.ok(a && b, `${spec.id} must generate`);
    assert.ok(a.check.solvable && a.check.remainingUnknowns === 0, `${spec.id} certified`);
    const mines = (r) => r.board.flat().map((c) => (c.isMine ? 1 : 0)).join('');
    assert.equal(mines(a), mines(b), `${spec.id}: identical layout on every build`);
    assert.equal(a.firstClick, b.firstClick);
    // A fresh-seed retry is a DIFFERENT layout of the same spec.
    const r = buildParLabBoard(spec, 1);
    assert.ok(r, `${spec.id} retry generates`);
    assert.notEqual(mines(a), mines(r), `${spec.id}: retry must not repeat the seen layout`);
  }
});

// ── Recording contract ───────────────────────────────────────────────────

test('progress walks the battery in order; losses hold, skips and wins advance', () => {
  assert.equal(nextParLabBoard([]).seq, 1);
  const first = PAR_LAB_BATTERY[0];
  const second = PAR_LAB_BATTERY[1];

  const loss = buildParLabRow(first, 0, 'loss', { timeSec: 40, seq: 1 });
  let rows = appendParLabRow([], loss);
  assert.equal(nextParLabBoard(rows).id, first.id, 'a loss leaves the board open (fresh-seed retry)');
  assert.equal(attemptCountFor(rows, first.id), 1, 'the loss consumed attempt 0');

  const win = buildParLabRow(first, 1, 'win', { timeSec: 80, seq: 2 });
  rows = appendParLabRow(rows, win);
  assert.equal(nextParLabBoard(rows).id, second.id, 'a win resolves the board');

  const skip = buildParLabRow(second, 0, 'skip', { seq: 3 });
  rows = appendParLabRow(rows, skip);
  assert.equal(nextParLabBoard(rows).id, PAR_LAB_BATTERY[2].id, 'a skip resolves too');
  assert.equal(attemptCountFor(rows, second.id), 0, 'skips are not attempts');

  const prog = labProgress(rows);
  assert.equal(prog.resolved, 2);
  assert.equal(prog.complete, false);
});

test('REGRESSION guard: a replayed layout can never record twice', () => {
  // The gameover modal's own Play Again regenerates the same (id, attempt)
  // seed; a second solve of a SEEN layout is not a measurement.
  const spec = PAR_LAB_BATTERY[0];
  const rows = appendParLabRow([], buildParLabRow(spec, 0, 'win', { timeSec: 60, seq: 1 }));
  assert.equal(appendParLabRow(rows, buildParLabRow(spec, 0, 'win', { timeSec: 12, seq: 2 })), null,
    'duplicate (id, attempt) must be refused');
  assert.equal(appendParLabRow(rows, buildParLabRow(spec, 0, 'loss', { timeSec: 12, seq: 2 })), null,
    'result flavor does not bypass the guard');
  assert.ok(appendParLabRow(rows, buildParLabRow(spec, 1, 'win', { timeSec: 70, seq: 2 })),
    'a fresh attempt records normally');
});

test('rows carry what the offline fit needs and the export round-trips', () => {
  const tiling = PAR_LAB_BATTERY.find((b) => b.shape !== 'rect' && b.gimmicks.length === 1);
  const row = buildParLabRow(tiling, 0, 'win', {
    timeSec: 92.4,
    features: { tilingType: tiling.shape, totalMines: tiling.mines },
    par: 88.26,
    wormEvents: [{ t: 5, r: 1, c: 1 }],
    seq: 7,
  });
  assert.equal(row.shape, tiling.shape);
  assert.equal(row.M, tiling.M);
  assert.equal(row.warmup, false);
  assert.equal(row.par, 88.3);
  assert.equal(row.features.tilingType, tiling.shape);
  assert.equal(row.seed, parLabSeed(tiling, 0));
  assert.ok(row.playedAt);

  const rect = PAR_LAB_BATTERY.find((b) => b.shape === 'rect');
  const rrow = buildParLabRow(rect, 0, 'win', { timeSec: 30, seq: 8 });
  assert.equal(rrow.rows, rect.rows);
  assert.equal(rrow.cols, rect.cols);
  assert.equal(rrow.M, undefined);

  const parsed = JSON.parse(exportParLab([row, rrow]));
  assert.equal(parsed.format, 'parlab-v1');
  assert.equal(parsed.battery, PAR_LAB_BATTERY.length);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].features.tilingType, tiling.shape);
});

test('the parLab rules block admits exactly what buildParLabRow emits', () => {
  // The sync writer pushes rows into a $other:false whitelist; a field
  // added to buildParLabRow without a rules entry makes the WHOLE write
  // fail validation and drop silently (the 866683d class). Pin the row's
  // key set against the whitelist, both directions of drift.
  const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8'));
  const block = rules.rules.parLab.$entry;
  assert.ok(block, 'parLab rules block exists');
  assert.equal(block['.read'], undefined, 'reads are granted at the node, writes per row');
  assert.match(block['.write'], /auth != null && !data\.exists\(\)/, 'append-only, authed');
  assert.match(block['.write'], /uid.*auth\.uid/, 'rows are uid-owned');
  assert.equal(rules.rules.parLab['.read'], true, 'world-readable — the analysis fetches without credentials');

  const whitelisted = new Set(Object.keys(block).filter((k) => !k.startsWith('.') && k !== '$other'));
  const tiling = PAR_LAB_BATTERY.find((b) => b.shape !== 'rect' && b.gimmicks.length === 1);
  const rect = PAR_LAB_BATTERY.find((b) => b.shape === 'rect');
  const emitted = new Set();
  for (const spec of [tiling, rect]) {
    const row = buildParLabRow(spec, 0, 'win', {
      timeSec: 60, features: { rows: 9, cols: 7, totalMines: 13 }, par: 90,
      wormEvents: [{ t: 1 }], seq: 1,
    });
    for (const k of Object.keys(row)) emitted.add(k);
  }
  // The writer adds uid + the server timestamp on push.
  emitted.add('uid');
  emitted.add('timestamp');
  for (const k of emitted) {
    assert.ok(whitelisted.has(k), `row field '${k}' is not whitelisted — the write would silently drop`);
  }
  assert.equal(block.$other['.validate'], false, 'the whitelist must stay closed');
});

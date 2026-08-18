// Daily score submission field-parity contract. A daily win submits from ONE
// place (auto in winLossHandler) via the shared buildDailyScoreExtras — a field
// missing from that extras object is dropped silently (the documented
// bombHitEvents/rngSeed data-loss). This pins the exact field set AND asserts
// the submit path uses the shared builder (never a hand-rolled extras).
//
// (Until the name-gate change there were TWO paths — the second was a
// dismissible manual name form in main.js that also submitted; it was removed
// once a nameless daily is gated before the end card, leaving one path.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDailyScoreExtras } from '../src/logic/winSubmissionPlan.js';

const FIELDS = ['uid', 'par', 'features', 'bombHitEvents', 'wormEvents', 'rngSeed', 'totalMines', 'scrolled'];

test('the extras payload carries exactly the contracted field set', () => {
  const state = {
    dailyPar: 90, dailyFeatures: { rows: 9 }, dailyBombHitEvents: [{ t: 1 }],
    wormEvents: [{ t: 3, r: 1, c: 2, len: 4, life: 50, pace: 1.1, moves: 12 }],
    dailyRngSeed: '2026-06-23:trial1', totalMines: 20,
  };
  const extras = buildDailyScoreExtras(state, '2026-06-23', 'uid-1');
  assert.deepEqual(Object.keys(extras).sort(), [...FIELDS].sort(),
    'extras field set changed — update the submit path and this contract together');
  assert.equal(extras.uid, 'uid-1');
  assert.equal(extras.par, 90);
  assert.deepEqual(extras.features, { rows: 9 });
  assert.deepEqual(extras.bombHitEvents, [{ t: 1 }]);
  assert.deepEqual(extras.wormEvents, [{ t: 3, r: 1, c: 2, len: 4, life: 50, pace: 1.1, moves: 12 }]);
  assert.equal(extras.rngSeed, '2026-06-23:trial1');
  assert.equal(extras.totalMines, 20);
});

test('bombHitEvents defaults to an empty array, rngSeed falls back to dateStr', () => {
  const extras = buildDailyScoreExtras({ dailyPar: 60, dailyFeatures: null, totalMines: 10 }, '2026-06-23', 'uid-2');
  assert.deepEqual(extras.bombHitEvents, []);
  assert.equal(extras.rngSeed, '2026-06-23', 'a plain-date board reports its date as the seed');
  assert.deepEqual(Object.keys(extras).sort(), [...FIELDS].sort());
});

test('the daily submit path uses the shared builder (no hand-rolled extras)', () => {
  // Source-level guard: the auto-submit path must not hand-roll the extras
  // object. If someone re-inlines it, this fails.
  const repoRoot = new URL('..', import.meta.url);
  const winLoss = readFileSync(new URL('src/game/winLossHandler.js', repoRoot), 'utf8');
  assert.ok(winLoss.includes('buildDailyScoreExtras('), 'winLossHandler auto-submit must use buildDailyScoreExtras');
});

// ── The traversal covariate (his ruling 2026-08-17) ─────────────────────
//
// `scrolled` says the board did not fit the screen while it was played,
// whatever the cause: marathon dims, a wide board, or an ordinary board
// under the player's own cell-size preference. It exists because the fit has
// never carried the cost of TRAVELLING a board, only of thinking about one,
// and because the per-player k absorbs a stable preference habit but not a
// player who changes the setting between runs.

test('scrolled is stated in BOTH directions, never omitted when false', () => {
  // Absent means a client older than the field; false means one that
  // measured and found the board fitted. The refit needs to tell those
  // apart, so the boolean is always written.
  const fitted = buildDailyScoreExtras(
    { dailyPar: 60, totalMines: 10, boardScrolled: false }, '2026-06-23', 'u');
  assert.equal(fitted.scrolled, false);
  assert.ok(Object.prototype.hasOwnProperty.call(fitted, 'scrolled'),
    'false must be WRITTEN, not implied by absence');

  const scrolled = buildDailyScoreExtras(
    { dailyPar: 60, totalMines: 10, boardScrolled: true }, '2026-06-23', 'u');
  assert.equal(scrolled.scrolled, true);

  // A state that predates the flag reads as false rather than undefined, so
  // the row is still well-formed for the rules.
  const legacy = buildDailyScoreExtras({ dailyPar: 60, totalMines: 10 }, '2026-06-23', 'u');
  assert.equal(legacy.scrolled, false);
});

test('REGRESSION: every field the daily row writes is whitelisted in the rules', () => {
  // The 866683d class, and the reason this test is here rather than in a
  // Firebase emulator: `daily/$date/$entry` ends in `$other: false`, so ONE
  // un-whitelisted child drops the WHOLE score row with no client error.
  // Derived from the rules file so the two move together.
  const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8'));
  for (const family of ['daily', 'dailyArchive']) {
    const block = rules.rules[family].$date.$entry;
    assert.equal(block.$other['.validate'], false, `${family} must keep a closed whitelist`);
    const allowed = new Set(Object.keys(block).filter((k) => !k.startsWith('.') && k !== '$other'));
    assert.ok(allowed.has('scrolled'),
      `${family} writes scrolled but its whitelist lacks it, so every row would drop whole`);
  }
  // And the daily row's own builder must not have grown a field the daily
  // family cannot hold. `features` and `totalMines` ride dailyMeta rather
  // than the score row, so they are the two deliberate exceptions.
  const dailyAllowed = new Set(Object.keys(rules.rules.daily.$date.$entry)
    .filter((k) => !k.startsWith('.') && k !== '$other'));
  const META_ONLY = new Set(['features', 'totalMines']);
  for (const key of FIELDS) {
    if (META_ONLY.has(key)) continue;
    assert.ok(dailyAllowed.has(key), `the daily row writes ${key} but the rules refuse it`);
  }
});

// ── Issue #373: the flag reads the overflow, not the controls predicate ──
//
// `needsZoom()` answers "should the camera controls show", and it carries a
// deliberate legacy clause on a Challenge board's STORAGE CONTAINER dims
// (rows > 13) so squeezed-but-FITTING boards keep their buttons. Reading it
// for `scrolled` made the field claim traversal on boards that were entirely
// on screen: measured over the shipped library, 17% of dealable match boards,
// and systematically by shape (4.8.8 35%, cairo 25%, rect 4%) because on a
// lattice rows/cols are an arbitrary factorization of the cell count rather
// than the shape a player sees. A source scan is the right layer: the defect
// is WHICH predicate the assignment reads.

test('REGRESSION #373: boardScrolled is set from the overflow, never from needsZoom()', () => {
  const src = readFileSync(new URL('../src/ui/boardRenderer.js', import.meta.url), 'utf8');
  const assignments = src.split('\n').filter((l) => /state\.boardScrolled\s*=/.test(l));
  assert.ok(assignments.length >= 1, 'the flag must still be set somewhere');
  for (const line of assignments) {
    assert.ok(!/needsZoom\s*\(/.test(line),
      `the flag reads needsZoom(), which fires on boards that FIT: ${line.trim()}`);
    assert.ok(/_boardOverflowsWrapper\s*\(/.test(line),
      `the flag must read the overflow measurement itself: ${line.trim()}`);
  }
  // And the legacy clause must still be doing its own job for the BUTTONS,
  // or this test would pass by deleting the thing it is guarding against.
  assert.ok(/state\.gameMode === 'match' && \(state\.cols > 13 \|\| state\.rows > 13\)/.test(src),
    'the legacy rows>13 clause must survive in needsZoom for the zoom buttons');
});

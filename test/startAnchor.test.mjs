// The stored Start-here anchor (his 2026-08-17 ruling: "This should
// definitely not be client-side ever").
//
// The incident: the client searched for the anchor at load, zeros-first in
// reading order, stopping at the FIRST cell whose full solve certifies. On
// the 2026-08-17 daily that was (0,0), whose 9-cell opening was followed by
// one subset move and four consecutive tank-class deductions: a certified
// path a human reads as "unsolvable at the start". The anchor is now chosen
// once by the canonical's WRITER (precompute, regenerate, or the weekly
// first-client fallback), stored as `bestStart`, signed, and rendered
// verbatim; the old search survives only as the vintage fallback, as the one
// copy in startAnchor.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { chooseStartAnchor, legacyStartSearch, resolveStoredAnchor } from '../src/logic/startAnchor.js';
import { generateBoard, cleanSolverArtifacts } from '../src/logic/boardGenerator.js';
import { createDailyRNG } from '../src/logic/seededRandom.js';
import { buildOneCandidate, buildCanonicalPayload } from '../scripts/daily-board-pipeline.mjs';
import { deserializeBoard } from '../src/firebase/dailyBoardSync.js';
import { verifyCanonicalPayload } from '../scripts/verify-canonical-boards.mjs';

function freshBoard(seed, rows = 9, cols = 9, mines = 12) {
  const board = generateBoard(rows, cols, mines, Math.floor(rows / 2), Math.floor(cols / 2), createDailyRNG(seed));
  cleanSolverArtifacts(board);
  return { board, rows, cols };
}

test('chooseStartAnchor returns a certifying anchor, at least as friendly as the legacy pick', () => {
  // Property over several generated boards: the policy's pick certifies, and
  // its opening (leading pass-A run) is never WORSE than what the legacy
  // first-certifying-in-reading-order search settles for. That ordering is
  // the whole reason the policy exists.
  for (const seed of ['anchor-a', 'anchor-b', 'anchor-c']) {
    const { board, rows, cols } = freshBoard(seed);
    const chosen = chooseStartAnchor(board, rows, cols);
    const legacy = legacyStartSearch(board, rows, cols);
    assert.ok(chosen, `${seed}: a generated no-guess board must yield an anchor`);
    assert.ok(chosen.check && chosen.check.solvable && chosen.check.remainingUnknowns === 0,
      `${seed}: the chosen anchor must carry its own full-solve check`);
    assert.ok(legacy && legacy.check, `${seed}: the legacy search certifies on this board too`);
    const prefixOf = (check) => {
      let n = 0;
      for (const e of check.trace || []) { if (e.tier === 0) n++; else break; }
      return n;
    };
    // The legacy check has no trace (it never asked for one), so re-run its
    // anchor with tracing for an apples-to-apples prefix comparison.
    const { isBoardSolvable } = awaitImportSolver();
    const legacyTraced = isBoardSolvable(board, rows, cols, legacy.r, legacy.c, null, { trace: true });
    cleanSolverArtifacts(board);
    const chosenTraced = isBoardSolvable(board, rows, cols, chosen.r, chosen.c, null, { trace: true });
    cleanSolverArtifacts(board);
    assert.ok(prefixOf(chosenTraced) >= prefixOf(legacyTraced),
      `${seed}: chosen prefix ${prefixOf(chosenTraced)} must not be worse than legacy ${prefixOf(legacyTraced)}`);
  }
});

// node:test runs this file as ESM; a tiny sync indirection keeps the solver
// import at top-level semantics without an await inside the test body.
import { isBoardSolvable as _solver } from '../src/logic/boardSolver.js';
function awaitImportSolver() { return { isBoardSolvable: _solver }; }

test('resolveStoredAnchor rejects out-of-bounds, mines, and non-certifying cells', () => {
  const { board, rows, cols } = freshBoard('anchor-d');
  assert.equal(resolveStoredAnchor(board, rows, cols, -1), null);
  assert.equal(resolveStoredAnchor(board, rows, cols, rows * cols), null);
  assert.equal(resolveStoredAnchor(board, rows, cols, 2.5), null);
  let mineIdx = -1;
  outer:
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (board[r][c].isMine) { mineIdx = r * cols + c; break outer; }
  }
  assert.ok(mineIdx >= 0, 'the board has a mine to point at');
  assert.equal(resolveStoredAnchor(board, rows, cols, mineIdx), null,
    'a stored anchor on a mine must resolve to null, never render');
  const good = chooseStartAnchor(board, rows, cols);
  const resolved = resolveStoredAnchor(board, rows, cols, good.r * cols + good.c);
  assert.ok(resolved && resolved.r === good.r && resolved.c === good.c);
  assert.ok(resolved.check.solvable && resolved.check.remainingUnknowns === 0);
});

test('the pipeline stores bestStart in the canonical payload, and deserializeBoard returns it', () => {
  const cand = buildOneCandidate('2027-03-01:trial0', null, false);
  assert.ok(cand.check && (cand.check.solvable || cand.check.remainingUnknowns === 0),
    'the candidate must certify for this test to mean anything');
  const payload = buildCanonicalPayload(cand, 'test');
  assert.ok(Number.isInteger(payload.bestStart), 'the payload carries a stored anchor');
  assert.ok(payload.bestStart >= 0 && payload.bestStart < cand.rows * cand.cols);
  const d = deserializeBoard(payload);
  assert.equal(d.bestStart, payload.bestStart, 'the ONE read-side definition returns it');
  const anchor = resolveStoredAnchor(d.board, d.rows, d.cols, d.bestStart);
  assert.ok(anchor, 'the stored anchor certifies on the round-tripped board');
});

test('a vintage payload without the field reads bestStart null (the legacy fallback lane)', () => {
  const cand = buildOneCandidate('2027-03-02:trial0', null, false);
  const payload = buildCanonicalPayload(cand, 'test');
  delete payload.bestStart;
  assert.equal(deserializeBoard(payload).bestStart, null);
});

test('the sweep hard-fails a stored anchor the board does not stand behind', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/canonical-sweep.json', import.meta.url), 'utf8'));
  const [date, raw] = Object.entries(fx.db.dailyBoard)[0];
  const clean = verifyCanonicalPayload(raw);
  assert.ok(clean.ok, `fixture board ${date} verifies clean before tampering`);
  // Point the stored anchor at a mine: the exact class the check exists for.
  const d = deserializeBoard(raw);
  let mineIdx = -1;
  outer:
  for (let r = 0; r < d.rows; r++) for (let c = 0; c < d.cols; c++) {
    if (d.board[r][c].isMine) { mineIdx = r * d.cols + c; break outer; }
  }
  const tampered = { ...raw, bestStart: mineIdx };
  const verdict = verifyCanonicalPayload(tampered);
  assert.equal(verdict.ok, false, 'a mine-pointing stored anchor must fail the sweep');
  assert.ok(verdict.reasons.some((r) => r.includes('bestStart')), 'with the reason named');
});

test('both canonical rules blocks whitelist bestStart (the 866683d class)', () => {
  const rules = readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8');
  const daily = rules.slice(rules.indexOf('"dailyBoard"'), rules.indexOf('"weeklyBoard"'));
  const weekly = rules.slice(rules.indexOf('"weeklyBoard"'));
  assert.match(daily, /"bestStart"/, 'dailyBoard block must whitelist bestStart');
  assert.match(weekly.slice(0, weekly.indexOf('}}')) || weekly, /"bestStart"/,
    'weeklyBoard block must whitelist bestStart (its first-client fallback writer sends it; an un-whitelisted child drops the WHOLE write)');
});

test('the client renders the stored anchor and never re-searches when one is stored (source scan)', () => {
  const src = readFileSync(new URL('../src/game/gameActions.js', import.meta.url), 'utf8');
  assert.match(src, /resolveStoredAnchor\(state\.board, state\.rows, state\.cols, reconstructed\.bestStart\)/,
    'the daily/weekly anchor must come from the stored field first');
  assert.match(src, /legacyStartSearch\(state\.board, state\.rows, state\.cols\)/,
    'the vintage fallback routes through the ONE legacy copy in startAnchor.js');
  // The old inline loop is gone: its tell was the zeros-first candidate sort.
  assert.doesNotMatch(src, /startCandidates\.filter\(c => c\.adj === 0\)/,
    'no inline client-side anchor search may survive (his ruling: never client-side)');
});

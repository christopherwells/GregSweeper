// Par bands (Christopher's ruling 2026-08-02): dailies land at par in
// [20, 240] and weeklies in [60, 360], skewed lightly toward the easy end
// with occasional hard boards — the "hard-day coin" shape he picked from a
// rendered three-way comparison (85% easy Beta(2,5) on the original
// [20,180]/[60,300] spans, 15% hard Beta(2,2) on [108,240]/[192,360]; the
// ceilings were raised in the same conversation with the easy hill kept
// anchored where he approved it).
//
// Everything here is determinism-critical: the target draw and the band
// weighting run on BOTH sides of two mirror pairs (selectDailyRngSeed.js /
// daily-board-pipeline.mjs, and selectWeeklyRngSeed.js which the weekly
// precompute now calls directly), so these pins are what turns a silent
// cross-path drift into a red test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_PAR_BAND, WEEKLY_PAR_BAND, HARD_DAY_PROB, PAR_KERNEL_SIGMA,
  drawTargetPar, drawDailyTargetPar, drawWeeklyTargetPar,
  parKernel, parBandWeight, bandWeightsFor, bandedArgmax,
} from '../src/logic/parBand.js';
import { selectDailyRngSeed } from '../src/logic/selectDailyRngSeed.js';
import { selectWeeklyRngSeed } from '../src/logic/selectWeeklyRngSeed.js';

// Independent re-derivations of the two regularized incomplete Beta CDFs,
// written from the definition (integrate the pdf term by term), NOT copied
// from parBand.js — so an algebra slip in the module's Horner form fails
// here instead of agreeing with itself.
//   Beta(2,5): pdf 30·x(1-x)^4  → F(x) = 15x² − 40x³ + 45x⁴ − 24x⁵ + 5x⁶
//   Beta(2,2): pdf 6·x(1-x)     → F(x) = 3x² − 2x³
const refCdf25 = x => 15 * x ** 2 - 40 * x ** 3 + 45 * x ** 4 - 24 * x ** 5 + 5 * x ** 6;
const refCdf22 = x => 3 * x ** 2 - 2 * x ** 3;

// A stub rng that replays a fixed sequence — drawTargetPar consumes exactly
// two values: the regime coin, then the position draw.
const seq = values => { let i = 0; return () => values[i++]; };

test('band constants are the ruling: [20,240] daily, [60,360] weekly, easy hill anchored', () => {
  assert.deepEqual(DAILY_PAR_BAND, { lo: 20, hi: 240, easyHi: 180, hardLo: 108 });
  assert.deepEqual(WEEKLY_PAR_BAND, { lo: 60, hi: 360, easyHi: 300, hardLo: 192 });
  assert.equal(HARD_DAY_PROB, 0.15);
});

test('the Beta inverses invert the true CDFs (independent polynomial check)', () => {
  for (let k = 1; k < 20; k++) {
    const u = k / 20;
    // Easy regime: coin below 0.85, position u → T = lo + inv25(u)·(easyHi−lo)
    const tEasy = drawTargetPar(seq([0.5, u]), DAILY_PAR_BAND);
    const xEasy = (tEasy - DAILY_PAR_BAND.lo) / (DAILY_PAR_BAND.easyHi - DAILY_PAR_BAND.lo);
    assert.ok(Math.abs(refCdf25(xEasy) - u) < 1e-9, `inv25 at u=${u}: F(inv)=${refCdf25(xEasy)}`);
    // Hard regime: coin at/above 0.85 → T = hardLo + inv22(u)·(hi−hardLo)
    const tHard = drawTargetPar(seq([0.99, u]), DAILY_PAR_BAND);
    const xHard = (tHard - DAILY_PAR_BAND.hardLo) / (DAILY_PAR_BAND.hi - DAILY_PAR_BAND.hardLo);
    assert.ok(Math.abs(refCdf22(xHard) - u) < 1e-9, `inv22 at u=${u}: F(inv)=${refCdf22(xHard)}`);
  }
});

test('the regime coin splits at exactly 1 − HARD_DAY_PROB, and spans stay inside their sub-bands', () => {
  const justEasy = drawTargetPar(seq([0.8499999, 0.999]), DAILY_PAR_BAND);
  assert.ok(justEasy <= DAILY_PAR_BAND.easyHi, 'a 0.8499… coin is still an easy day');
  const justHard = drawTargetPar(seq([0.8500001, 0.001]), DAILY_PAR_BAND);
  assert.ok(justHard >= DAILY_PAR_BAND.hardLo, 'a 0.8500…1 coin is a hard day');
  assert.ok(drawTargetPar(seq([0.1, 0.0000001]), DAILY_PAR_BAND) >= DAILY_PAR_BAND.lo);
  assert.ok(drawTargetPar(seq([0.99, 0.9999999]), DAILY_PAR_BAND) <= DAILY_PAR_BAND.hi);
});

test('REGRESSION: frozen target-par goldens — any change to the draw moves shipped boards', () => {
  // Pinned from the shipped implementation on 2026-08-02. The draw is pure
  // integer-seeded rng + polynomial bisection, so these are exact on every
  // engine; a drift here means every client and the precompute disagree
  // about which board a date gets.
  const close = (a, b) => Math.abs(a - b) < 1e-6;
  assert.ok(close(drawDailyTargetPar('2026-09-01'), 27.194348), String(drawDailyTargetPar('2026-09-01')));
  assert.ok(close(drawDailyTargetPar('2026-09-02'), 54.833185), String(drawDailyTargetPar('2026-09-02')));
  assert.ok(close(drawDailyTargetPar('2026-12-25'), 105.231109), String(drawDailyTargetPar('2026-12-25')));
  assert.ok(close(drawWeeklyTargetPar('2026-09-07'), 93.178458), String(drawWeeklyTargetPar('2026-09-07')));
  assert.ok(close(drawWeeklyTargetPar('2026-10-05'), 146.960203), String(drawWeeklyTargetPar('2026-10-05')));
});

test('daily and weekly draws are namespaced apart — a Monday is both a date and a weekStart', () => {
  const monday = '2026-09-07';
  assert.notEqual(drawDailyTargetPar(monday), drawWeeklyTargetPar(monday));
  // And each is deterministic.
  assert.equal(drawDailyTargetPar(monday), drawDailyTargetPar(monday));
  assert.equal(drawWeeklyTargetPar(monday), drawWeeklyTargetPar(monday));
});

test('over a frozen 2000-date window: every target inside the band, hard tail at its designed rate', () => {
  let aboveEasyHi = 0;
  const d0 = new Date('2026-08-03T12:00:00Z');
  for (let i = 0; i < 2000; i++) {
    const d = new Date(d0);
    d.setUTCDate(d.getUTCDate() + i);
    const t = drawDailyTargetPar(d.toISOString().slice(0, 10));
    assert.ok(t >= DAILY_PAR_BAND.lo && t <= DAILY_PAR_BAND.hi, `target ${t} outside the band`);
    if (t > DAILY_PAR_BAND.easyHi) aboveEasyHi++;
  }
  // Exact golden for the frozen window, plus the analytic sanity band: only
  // hard-regime draws can exceed easyHi, and P(hard ∧ above 180) =
  // 0.15 × (1 − F22((180−108)/132)) ≈ 6.5%.
  assert.equal(aboveEasyHi, 125);
  assert.ok(aboveEasyHi / 2000 > 0.045 && aboveEasyHi / 2000 < 0.085);
});

test('the kernel is 1 at the target, symmetric in log-ratio, and the clamp is the band edge exactly', () => {
  assert.equal(parKernel(90, 90), 1);
  assert.ok(Math.abs(parKernel(140, 70) - parKernel(35, 70)) < 1e-9, '2× over and 2× under weigh the same');
  assert.ok(parKernel(140, 70) > 0.10 && parKernel(140, 70) < 0.20, 'a 2× miss keeps ~14% at σ=0.35');
  assert.ok(parKernel(210, 70) < 0.01, 'a 3× miss keeps under 1%');
  assert.equal(parBandWeight(19.999, 70, DAILY_PAR_BAND), 0);
  assert.equal(parBandWeight(240.001, 70, DAILY_PAR_BAND), 0);
  assert.ok(parBandWeight(20, 70, DAILY_PAR_BAND) > 0, 'the floor itself is inside the band');
  assert.ok(parBandWeight(240, 70, DAILY_PAR_BAND) > 0, 'the ceiling itself is inside the band');
  assert.ok(Math.abs(PAR_KERNEL_SIGMA - 0.35) < 1e-12);
});

test('bandWeightsFor: missing pars weigh 0, an all-par-less slate disengages, an all-outside slate falls back to the raw kernel', () => {
  assert.equal(bandWeightsFor([{ score: 1 }, { score: 2 }], 70, DAILY_PAR_BAND), null);
  const mixed = bandWeightsFor([{ par: 70 }, {}, { par: NaN }], 70, DAILY_PAR_BAND);
  assert.equal(mixed[0], 1);
  assert.equal(mixed[1], 0);
  assert.equal(mixed[2], 0);
  const outside = bandWeightsFor([{ par: 300 }, { par: 260 }], 70, DAILY_PAR_BAND);
  assert.ok(outside[1] > outside[0] && outside[1] > 0, 'outside the band, nearer-in-log still ranks higher');
});

test('bandedArgmax: the band beats raw score, falls back to nearest when nothing is in band, ties go earliest', () => {
  const T = 70;
  assert.equal(bandedArgmax([{ score: 99, par: 300 }, { score: 1, par: 70 }], T, DAILY_PAR_BAND), 1,
    'an out-of-band monster score must lose to any in-band candidate');
  assert.equal(bandedArgmax([{ score: 1, par: 300 }, { score: 1, par: 250 }], 100, DAILY_PAR_BAND), 1,
    'all outside → nearest-in-log wins');
  assert.equal(bandedArgmax([{ score: 2, par: 70 }, { score: 2, par: 70 }], T, DAILY_PAR_BAND), 0,
    'exact ties keep the earlier slot, matching the un-banded argmax');
  assert.equal(bandedArgmax([{ score: 1 }, { score: 2 }], T, DAILY_PAR_BAND), 1,
    'a par-less slate is the legacy score argmax');
  assert.equal(bandedArgmax([], T, DAILY_PAR_BAND), -1);
  assert.equal(bandedArgmax([{ score: 0, par: 70 }, { score: 0, par: 90 }], 90, DAILY_PAR_BAND), 1,
    'all-zero scores: the band weight alone decides');
});

// ── The selection goldens: the band BITES on real generation ──────────
// Break-tested 2026-08-02: with the bandCtx removed, 2026-09-01 selects
// :trial0 (104s vs the 27s target) and 2026-09-14 selects :trial7 (180s vs
// the 91s target) — these pins exist to fail if the band ever silently
// disengages from either selector. They run the full generation contest
// (~0.5s total, DEFAULT experiment target since nothing loads the JSON in
// this process).
//
// The pinned DATE moved 2026-09-01 -> 2026-09-04 on 2026-08-18: the M1
// size-term refit re-priced every candidate, 09-01's winner fell to a 29%
// lottery share, and the flip is the documented replacement case below
// (a pin flips on a big re-price without anything being wrong). 09-04 wins
// by the wide-margin rule: trial5 takes 91% of the effective lottery
// weight, top-two 0.463 against 0.025 (18.5x), measured under the M1
// equations. Pick any future replacement the same way — a dominant SHARE
// of the weighted draw, not just a fresh recording, and not a share built
// on near-zero scores (2026-09-29 reads 100% on 0.036 vs 0.000, the
// everything-out-of-band trap).

test('REGRESSION: selectDailyRngSeed is banded — frozen-date golden', () => {
  assert.equal(selectDailyRngSeed('2026-09-04'), '2026-09-04:trial5');
});

// A pinned week has to have a DECISIVE winner or the pin guards nothing.
// 2026-09-07 was replaced on 2026-08-06 for that reason rather than merely
// re-recorded: measured, its top two candidates scored 1.434 and 1.405 — a 2%
// margin, two 3-modifier boards on either side of the target (61s and 144s
// against 93s). The 2026-08-06 refit moved par slightly, the tie fell the
// other way, and the pin went red without anything being wrong. Any refit
// that moves par by more than about 2% would flip it again, which trains
// whoever sees it to update the number rather than read it.
//
// Both weeks below win by a wide margin instead: 2026-09-28 takes trial7 at
// 1.880 against a 0.634 runner-up (197%), and 2026-09-14 takes trial4 at
// 2.781 against 2.058 (35%). Pick replacements the same way — a margin, not
// just a fresh recording — and note that a week can score decisively for the
// wrong reason, since 2026-09-21's 82% margin sits on scores of 0.006 vs
// 0.003, where nearly every candidate is out of band.
test('REGRESSION: selectWeeklyRngSeed is banded — frozen-week goldens', () => {
  assert.equal(selectWeeklyRngSeed('2026-09-14'), '2026-09-14:trial4');
  assert.equal(selectWeeklyRngSeed('2026-09-28'), '2026-09-28:trial7');
});

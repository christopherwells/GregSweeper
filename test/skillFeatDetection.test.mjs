// Skill-feat detection from a won game. Pins the certifiedClicks solver
// invariant (passA + pattern + search + disjunctive + 1), the flagless timeline
// read, and the feature/mode gating (chaos earns nothing; challenge can still
// earn flagless). skill-feats.test.mjs exercises the counter side effects via
// saveGameResult; this pins the detection logic that feeds it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSkillFeats } from '../src/logic/skillFeatDetection.js';

// A feature vector whose move-type counts sum (with +1) to a known click total.
function features({ passA = 0, canon = 0, generic = 0, adv = 0, disj = 0 } = {}) {
  return {
    passAMoves: passA, canonicalSubsetMoves: canon, genericSubsetMoves: generic,
    advancedLogicMoves: adv, disjunctiveMoves: disj,
  };
}
const reveals = (n) => Array.from({ length: n }, () => ({ a: 'r' }));

test('chaos earns nothing', () => {
  assert.deepEqual(detectSkillFeats({ gameMode: 'chaos', clickTimeline: reveals(5) }), {});
});

test('flagless: true only when the timeline has reveals and no flag action', () => {
  // challenge/normal has no feature vector but can still earn flagless.
  assert.equal(detectSkillFeats({ gameMode: 'normal', clickTimeline: reveals(8) }).flagless, true);
  assert.equal(detectSkillFeats({ gameMode: 'normal', clickTimeline: [{ a: 'r' }, { a: 'f' }] }).flagless, false);
  // An empty timeline is not "flagless" — nothing was played.
  assert.equal(detectSkillFeats({ gameMode: 'normal', clickTimeline: [] }).flagless, false);
});

test('feature-only feats are false without a feature vector', () => {
  const f = detectSkillFeats({ gameMode: 'normal', clickTimeline: reveals(8) });
  assert.equal(f.efficient, false);
  assert.equal(f.search, false);
  assert.equal(f.liar, false);
});

test('efficient: player clicks at or below the certified click count', () => {
  // certifiedClicks = 3 passA + 2 canon + 0 + 1 adv + 0 + 1 = 7.
  const winFeatures = features({ passA: 3, canon: 2, adv: 1 });
  // 7 player reveals == 7 certified → efficient.
  assert.equal(detectSkillFeats({ gameMode: 'daily', dailyFeatures: winFeatures, clickTimeline: reveals(7) }).efficient, true);
  // 6 (beat it) → efficient.
  assert.equal(detectSkillFeats({ gameMode: 'daily', dailyFeatures: winFeatures, clickTimeline: reveals(6) }).efficient, true);
  // 8 (one wasted click) → not efficient.
  assert.equal(detectSkillFeats({ gameMode: 'daily', dailyFeatures: winFeatures, clickTimeline: reveals(8) }).efficient, false);
  // chords count as player clicks too (a === 'c'); flags do not.
  assert.equal(detectSkillFeats({ gameMode: 'daily', dailyFeatures: winFeatures, clickTimeline: [...reveals(6), { a: 'c' }, { a: 'f' }] }).efficient, true);
  // zero player clicks is never "efficient" (degenerate).
  assert.equal(detectSkillFeats({ gameMode: 'daily', dailyFeatures: winFeatures, clickTimeline: [{ a: 'f' }] }).efficient, false);
});

test('search and liar read the provably-required move counts', () => {
  assert.equal(detectSkillFeats({ gameMode: 'timed', timedFeatures: features({ adv: 1 }), clickTimeline: reveals(2) }).search, true);
  assert.equal(detectSkillFeats({ gameMode: 'timed', timedFeatures: features({ adv: 0 }), clickTimeline: reveals(2) }).search, false);
  assert.equal(detectSkillFeats({ gameMode: 'weekly', weeklyFeatures: features({ disj: 1 }), clickTimeline: reveals(2) }).liar, true);
  assert.equal(detectSkillFeats({ gameMode: 'weekly', weeklyFeatures: features({ disj: 0 }), clickTimeline: reveals(2) }).liar, false);
});

test('the per-mode feature vector is selected by gameMode', () => {
  // A daily win reads dailyFeatures, ignores a stray weeklyFeatures.
  const f = detectSkillFeats({
    gameMode: 'daily',
    dailyFeatures: features({ adv: 1 }),
    weeklyFeatures: features({ disj: 1 }),
    clickTimeline: reveals(2),
  });
  assert.equal(f.search, true);
  assert.equal(f.liar, false, 'weeklyFeatures must not leak into a daily win');
});

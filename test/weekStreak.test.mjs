// The week streak's STORAGE half: the local record, the cloud merge, and the
// rules whitelist that lets it reach the cloud at all.
//
// The rules half is the one that fails silently. The users/{uid} block ends
// with a strict "$other": false, so a field saveProgress writes but the rules
// do not name makes the WHOLE progress update() fail validation and drop —
// streak, molt bank and all (the 866683d class). Both directions are pinned
// here: what the writer sends must be whitelisted, and what is whitelisted
// must be a shape the writer actually produces.

import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const {
  applyChallenge250Reset, applyCloudProgress, loadStats, invalidateStatsCache,
  recordWeeklyCompletion, getWeekStreak, getWeekStreakNotice,
  reconcileWeekStreakFromHistory,
} = await import('../src/storage/statsStorage.js');

const STATS_KEY = 'minesweeper_stats';
const { addWeeks } = await import('../src/logic/weeklyProgress.js');
const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8')).rules;
const user = rules.users?.['$uid'];

function fresh() {
  localStorage.clear();
  invalidateStatsCache?.();
}

// ── Rules lockstep ───────────────────────────────────────────────────────

test('weekStreak is whitelisted under users/$uid, optional and nullable', () => {
  assert.equal(user.$other?.['.validate'], false,
    'the $other:false catch-all is why every new field must be whitelisted');
  const node = user.weekStreak;
  assert.ok(node, 'weekStreak must be whitelisted or the whole progress write drops');
  assert.ok(node['.validate'].includes("'streak'"), 'streak is the one required child');
  assert.ok(node['.validate'].includes('newData.val() === null'), 'a null weekStreak is allowed');
  assert.ok(!user['.validate'] || !String(user['.validate']).includes("'weekStreak'"),
    'never a REQUIRED child of users — every existing account has none');
});

test('every field the writer sends is named in the rules, and nothing more', () => {
  // What saveProgress puts in the object, read off the source so the two
  // cannot drift: recordWeeklyCompletion's return feeds it directly.
  const written = ['streak', 'best', 'lastWeek'];
  const whitelisted = Object.keys(user.weekStreak).filter((k) => !k.startsWith('.') && k !== '$other');
  assert.deepEqual(whitelisted.sort(), [...written].sort(),
    'writer fields and rule children must match exactly in both directions');
  assert.equal(user.weekStreak.$other?.['.validate'], false,
    'the sub-block needs its own strict guard too');
  for (const k of ['streak', 'best']) {
    const v = user.weekStreak[k]['.validate'];
    assert.ok(v.includes('newData.isNumber()') && v.includes('>= 0'), `${k} must be a non-negative number`);
  }
  assert.ok(user.weekStreak.lastWeek['.validate'].includes('length === 10'),
    'lastWeek is a YYYY-MM-DD week anchor');
});

// ── Local record ─────────────────────────────────────────────────────────

test('recording a completion banks the week; a second one that week is a no-op', () => {
  fresh();
  const first = recordWeeklyCompletion('2026-07-27');
  assert.equal(first.streak, 1);
  assert.deepEqual(loadStats().weekStreak, { streak: 1, best: 1, lastWeek: '2026-07-27' });

  const again = recordWeeklyCompletion('2026-07-27');
  assert.equal(again.streak, 1, 'one of the seven is the rule — the rest are the same week');
  const next = recordWeeklyCompletion('2026-08-03');
  assert.equal(next.streak, 2);
  assert.equal(loadStats().weekStreak.best, 2);
});

test('getWeekStreak reports a live streak and hides a lapsed one, keeping best', () => {
  fresh();
  recordWeeklyCompletion('2026-07-27');
  recordWeeklyCompletion('2026-08-03');
  assert.equal(getWeekStreak('2026-08-03').streak, 2, 'played this week');
  assert.equal(getWeekStreak('2026-08-10').streak, 2, 'the week after is still live');
  const lapsed = getWeekStreak('2026-08-17');
  assert.equal(lapsed.streak, 0, 'two weeks on, the run is over');
  assert.equal(lapsed.best, 2, 'the high-water mark is not a streak and never lapses');
  assert.equal(loadStats().weekStreak.streak, 2, 'a READ never rewrites the record');
});

test('the at-risk notice fires only in the week the streak is riding on', () => {
  fresh();
  recordWeeklyCompletion('2026-07-27');
  assert.equal(getWeekStreakNotice('2026-07-27'), null, 'already played this week');
  assert.deepEqual(getWeekStreakNotice('2026-08-03'), { streakHeld: 1, wouldBe: 2 });
  assert.equal(getWeekStreakNotice('2026-08-17'), null, 'already lapsed — nothing to hold');
});

test('a player who has never played the weekly shows nothing', () => {
  fresh();
  assert.equal(getWeekStreak('2026-08-03').streak, 0);
  assert.equal(getWeekStreakNotice('2026-08-03'), null);
  assert.equal(loadStats().weekStreak, undefined, 'and no record is written by reading');
});

// ── Cloud merge ──────────────────────────────────────────────────────────

test('cloud merge: a newer week is adopted whole, an older one is ignored', () => {
  fresh();
  recordWeeklyCompletion('2026-07-27');            // local: 1 week, last 07-27

  // Initial load, cloud is BEHIND: keep local.
  applyCloudProgress({ weekStreak: { streak: 9, best: 9, lastWeek: '2026-07-20' } });
  assert.equal(loadStats().weekStreak.streak, 1, 'a stale cloud week never overwrites');
  assert.equal(loadStats().weekStreak.best, 9, 'but best is a high-water mark across devices');

  // Initial load, cloud is AHEAD: adopt verbatim, even when SHORTER — the
  // other device knows something this one does not (it saw the break).
  applyCloudProgress({ weekStreak: { streak: 1, best: 9, lastWeek: '2026-08-10' } });
  assert.equal(loadStats().weekStreak.streak, 1);
  assert.equal(loadStats().weekStreak.lastWeek, '2026-08-10');
});

test('cloud merge: same week takes the longer streak; the listener adopts verbatim', () => {
  fresh();
  recordWeeklyCompletion('2026-08-03');
  applyCloudProgress({ weekStreak: { streak: 5, best: 5, lastWeek: '2026-08-03' } });
  assert.equal(loadStats().weekStreak.streak, 5, 'same week, the longer run wins');

  // The overwrite listener is the authoritative path: cloud verbatim, even down.
  applyCloudProgress({ weekStreak: { streak: 2, best: 5, lastWeek: '2026-08-03' } }, { overwrite: true });
  assert.equal(loadStats().weekStreak.streak, 2, 'an admin correction or a reset must stick');
});

test('a cloud snapshot with no week says nothing, and never zeroes a local streak', () => {
  fresh();
  recordWeeklyCompletion('2026-08-03');
  // The pre-feature shape every existing account holds: no weekStreak node.
  applyCloudProgress({ dailyStreak: 4, lastDailyDate: '2026-08-03' });
  assert.equal(loadStats().weekStreak.streak, 1, 'absence of information is not an authoritative 0');
  // A node with a streak but no lastWeek has no position to compare — same rule.
  applyCloudProgress({ weekStreak: { streak: 0, best: 0 } });
  assert.equal(loadStats().weekStreak.streak, 1);
});

test('the C250 reset leaves the week streak alone (different mode, different ladder)', () => {
  fresh();
  recordWeeklyCompletion('2026-08-03');
  const s = loadStats();
  s.maxLevelReached = 120;
  localStorage.setItem(STATS_KEY, JSON.stringify(s));
  invalidateStatsCache?.();
  applyChallenge250Reset();
  assert.equal(loadStats().weekStreak.streak, 1, 'the challenge epoch has nothing to do with the weekly');
});

// ── The reconcile (his report, 2026-08-05) ───────────────────────────────

test('REGRESSION: a player with unbroken history gets their streak back', () => {
  fresh();
  // Exactly the shipped state: fourteen weeks played, counter at zero because
  // the feature only started counting when it shipped.
  const weeks = [];
  let w = '2026-05-04';
  for (let i = 0; i < 14; i++) { weeks.push(w); w = addWeeks(w, 1); }
  assert.equal(getWeekStreak('2026-08-03').streak, 0, 'precondition: nothing counted yet');

  assert.equal(reconcileWeekStreakFromHistory(weeks), true);
  const after = getWeekStreak('2026-08-03');
  assert.equal(after.streak, 14);
  assert.equal(after.best, 14);
  assert.equal(loadStats().weekStreak.lastWeek, '2026-08-03');
});

test('the reconcile is upward-only and never contradicts a live counter', () => {
  fresh();
  recordWeeklyCompletion('2026-08-03');           // counter says 1, this week
  // A history read that came back SHORT (a hole from a failed write) must not
  // demote the streak the player just earned.
  assert.equal(reconcileWeekStreakFromHistory(['2026-08-03']), false);
  assert.equal(getWeekStreak('2026-08-03').streak, 1);

  // A history read that is LONGER raises it.
  reconcileWeekStreakFromHistory(['2026-07-20', '2026-07-27', '2026-08-03']);
  assert.equal(getWeekStreak('2026-08-03').streak, 3);
  assert.equal(loadStats().weekStreak.best, 3);

  // An empty or unusable read changes nothing.
  assert.equal(reconcileWeekStreakFromHistory([]), false);
  assert.equal(reconcileWeekStreakFromHistory(null), false);
  assert.equal(getWeekStreak('2026-08-03').streak, 3);
});

test('a lapsed history restores the record but the card still reads 0', () => {
  fresh();
  // Six weeks, all long past. The run is real history and belongs in `best`,
  // but the streak itself is over and the card must not claim it.
  const weeks = ['2026-05-04', '2026-05-11', '2026-05-18', '2026-05-25', '2026-06-01', '2026-06-08'];
  assert.equal(reconcileWeekStreakFromHistory(weeks), true);
  assert.equal(loadStats().weekStreak.streak, 6, 'the record keeps the run');
  assert.equal(getWeekStreak('2026-08-03').streak, 0, 'but it lapsed weeks ago');
  assert.equal(getWeekStreak('2026-08-03').best, 6);
});

// Hate-speech scrub coverage contract (issue #54).
//
// The server sweep (scripts/scrub-leaderboard-names.mjs) is the authoritative
// backstop behind the client name filter, but it only protects the paths it
// walks: timed/ shipped world-readable with a name child and NO sweep. This
// derives the set of world-readable name-bearing leaderboard paths FROM
// firebase-rules.json and fails if the scrub script doesn't reference each —
// so a future leaderboard path can't silently escape the backstop again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rules = JSON.parse(readFileSync(new URL('../firebase-rules.json', import.meta.url), 'utf8')).rules;
const scrubSrc = readFileSync(new URL('../scripts/scrub-leaderboard-names.mjs', import.meta.url), 'utf8');

// A node "bears names" if any descendant (walking $-wildcards) has a `name` rule.
function bearsName(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 3) return false;
  if ('name' in node) return true;
  return Object.keys(node).some((k) => !k.startsWith('.') && bearsName(node[k], depth + 1));
}

test('every world-readable name-bearing path has a scrub sweep', () => {
  const uncovered = [];
  for (const [path, node] of Object.entries(rules)) {
    if (path.startsWith('.') || path.startsWith('$')) continue;
    if (node?.['.read'] !== true) continue;   // gated/expression reads (e.g. friendCodes) are exempt
    if (!bearsName(node)) continue;
    if (!scrubSrc.includes(`ref('${path}')`)) uncovered.push(path);
  }
  assert.deepEqual(uncovered, [],
    `world-readable paths with player names but no scrub sweep: ${uncovered.join(', ')}`);
});

test('REGRESSION #54: the sweep set includes timed and dailyArchive', () => {
  for (const path of ['daily', 'weekly', 'timed', 'dailyArchive']) {
    assert.ok(scrubSrc.includes(`ref('${path}')`), `scrub must sweep ${path}/`);
  }
});

test('match player names are swept even though the derivation exempts them', () => {
  // `matches` is read-gated on `auth != null` rather than world-readable, so
  // the derivation above skips it the way it skips friendCodes. That is a
  // deliberate read posture (a match is found by its code, never by browsing,
  // and the node must not be enumerable), NOT a decision that the names inside
  // it do not matter. Every one of them is shown to other players, so the
  // backstop covers them; this assertion is what keeps the sweep from being
  // dropped on the grounds that the derivation no longer demands it.
  assert.equal(rules.matches?.['.read'], undefined,
    'the matches root must stay non-enumerable');
  assert.equal(rules.matches?.$matchId?.['.read'], 'auth != null');
  assert.ok(scrubSrc.includes("ref('matches')"),
    'scrub must sweep matches/ — its player names are shown to other players');
});

test('friend-list names are swept, and the rules hold them to the shared character class (#330)', () => {
  // users/{uid}/friends is owner-read, so the derivation skips it the way it
  // skips matches, and the same reasoning applies: the read posture says
  // nothing about whether the names inside are shown to people. A friend
  // row's name renders on the victim's own friends panel, and the friends
  // grant deliberately lets a stranger write the entry keyed by their own
  // uid into anyone's node (the one-redemption-serves-both-sides design).
  // Issue #330: this was the ONE name-bearing field with neither a
  // character class nor a sweep, so a stranger could plant a permanent
  // name only the victim can see.
  const friendName = rules.users?.$uid?.friends?.$friendUid?.name?.['.validate'] || '';
  assert.ok(friendName.includes('matches('),
    'friends/{friendUid}/name must carry the shared character class every other name field has');
  assert.ok(friendName.includes('length >= 1'),
    'and the same non-empty floor');
  assert.ok(scrubSrc.includes("ref('users')"),
    'scrub must sweep users/{uid}/friends names — they are shown on the friends panel');
  assert.ok(scrubSrc.includes('sweepFriendNames'),
    'the friend-name sweep must stay wired into the run');
});

test('expired match codes are swept, not just friend codes', () => {
  // A match code lives seven days rather than fifteen minutes, so without a
  // sweep the node accumulates a week of dead codes at a time.
  assert.ok(scrubSrc.includes("ref('matchCodes')"), 'scrub must sweep matchCodes/');
  assert.ok(/MATCH_CODE_SWEEP_AGE_MS\s*=\s*7 \* 24 \* 60 \* 60 \* 1000/.test(scrubSrc),
    'the match-code sweep window must be the seven-day lifetime');
});

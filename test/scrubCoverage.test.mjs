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

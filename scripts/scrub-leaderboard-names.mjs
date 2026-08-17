// Server-side hate-speech sweep for leaderboard display names.
//
// Scans EVERY world-readable name-bearing path — daily/{date}/{pushId}.name,
// weekly/{weekStart}/{uid}.name, timed/{pushId}.name,
// dailyArchive/{date}/{pushId}.name, and playerNames/{uid}.name (the canonical
// name the leaderboards join against) — and rewrites any name containing a
// slur to "Anonymous". Keep that path list in sync with the rules: a new
// world-readable leaderboard path MUST get a sweep here in the same change
// (issue #54: timed/ shipped without one). This is the
// authoritative backstop behind the client-side reject in
// src/logic/nameFilter.js — it catches names written before the filter
// shipped, clever evasions the naive client matcher misses, and direct
// writes to Firebase that bypass the app entirely.
//
// Detection uses the `obscenity` library, which has boundary- and
// whitelist-aware matching (so "Nigeria", "Pakistani", "raccoon",
// "Scunthorpe", "assassin" etc. do NOT match) plus transformers that
// defeat leetspeak / spacing evasion. The blacklist is OUR curated
// hate-speech-only term set (no general profanity), so "ass"-style mild
// profanity is left alone per the "hate speech only" scope.
//
// Runs on a cron and on manual dispatch (scrub-leaderboard-names.yml).
// Scrubs to "Anonymous" rather than deleting the row — the score and
// streak are not the problem, the name is.

import admin from 'firebase-admin';
import { RegExpMatcher, parseRawPattern, englishRecommendedTransformers } from 'obscenity';
import { HATE_SPEECH_TERMS } from '../src/logic/hateSpeechTerms.js';
import { containsHateSpeech as clientContainsHateSpeech } from '../src/logic/nameFilter.js';

// Innocent words that contain a slur as a substring. obscenity skips a
// blacklist match when it falls inside a whitelisted term, which is how
// we keep "Nigeria" / "Pakistan" / "raccoon" / "San Diego" / "Fagan"
// safe while still blacklisting the bare slurs.
const WHITELIST = [
  'scunthorpe', 'assassin', 'cockpit',
  'nigeria', 'nigerien', 'niger', 'nigerian',
  'pakistan', 'pakistani',
  'raccoon', 'tycoon', 'cocoon',
  'spice', 'spicer', 'conspicuous', 'despicable',
  'sandiego', 'san diego',
  'fagan', 'fagin',
];

const matcher = new RegExpMatcher({
  blacklistedTerms: HATE_SPEECH_TERMS.map((term, id) => ({ id, pattern: parseRawPattern(term) })),
  whitelistedTerms: WHITELIST,
  ...englishRecommendedTransformers,
});

function isHateSpeech(name) {
  if (typeof name !== 'string' || !name) return false;
  // OR two detectors:
  //  - obscenity: boundary/whitelist-aware matching of the FULL term
  //    list (catches coon/spic/paki without flagging raccoon/Nigeria).
  //  - the client normalizer: aggressive leetspeak (e.g. 4→a maps
  //    "tr4nny"→"tranny", which obscenity's transformer misses) over
  //    the collision-free client-safe subset.
  // Union = comprehensive, and neither path false-positives.
  return matcher.hasMatch(name) || clientContainsHateSpeech(name);
}

const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!sa) {
  console.error('FIREBASE_SERVICE_ACCOUNT env not set');
  process.exit(2);
}
const dryRun = process.argv.includes('--dry-run');

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(sa)),
  databaseURL: 'https://gregsweeper-66d02-default-rtdb.firebaseio.com',
});
const db = admin.database();

const SCRUBBED = 'Anonymous';

async function sweepDaily() {
  const snap = await db.ref('daily').once('value');
  const root = snap.val() || {};
  const updates = {};
  let hits = 0;
  for (const date of Object.keys(root)) {
    const entries = root[date] || {};
    for (const pushId of Object.keys(entries)) {
      const name = entries[pushId] && entries[pushId].name;
      if (isHateSpeech(name)) {
        console.log(`  daily/${date}/${pushId}: "${name}" → ${SCRUBBED}`);
        updates[`daily/${date}/${pushId}/name`] = SCRUBBED;
        hits++;
      }
    }
  }
  if (!dryRun && hits > 0) await db.ref().update(updates);
  return hits;
}

async function sweepWeekly() {
  const snap = await db.ref('weekly').once('value');
  const root = snap.val() || {};
  const updates = {};
  let hits = 0;
  for (const weekStart of Object.keys(root)) {
    const rows = root[weekStart] || {};
    for (const uid of Object.keys(rows)) {
      const name = rows[uid] && rows[uid].name;
      if (isHateSpeech(name)) {
        console.log(`  weekly/${weekStart}/${uid}: "${name}" → ${SCRUBBED}`);
        updates[`weekly/${weekStart}/${uid}/name`] = SCRUBBED;
        hits++;
      }
    }
  }
  if (!dryRun && hits > 0) await db.ref().update(updates);
  return hits;
}

// timed/{pushId} is FLAT (one push per run, no date bucket).
async function sweepTimed() {
  const snap = await db.ref('timed').once('value');
  const root = snap.val() || {};
  const updates = {};
  let hits = 0;
  for (const pushId of Object.keys(root)) {
    const name = root[pushId] && root[pushId].name;
    if (isHateSpeech(name)) {
      console.log(`  timed/${pushId}: "${name}" → ${SCRUBBED}`);
      updates[`timed/${pushId}/name`] = SCRUBBED;
      hits++;
    }
  }
  if (!dryRun && hits > 0) await db.ref().update(updates);
  return hits;
}

// dailyArchive/{date}/{pushId} mirrors the daily/ shape.
async function sweepDailyArchive() {
  const snap = await db.ref('dailyArchive').once('value');
  const root = snap.val() || {};
  const updates = {};
  let hits = 0;
  for (const date of Object.keys(root)) {
    const entries = root[date] || {};
    for (const pushId of Object.keys(entries)) {
      const name = entries[pushId] && entries[pushId].name;
      if (isHateSpeech(name)) {
        console.log(`  dailyArchive/${date}/${pushId}: "${name}" → ${SCRUBBED}`);
        updates[`dailyArchive/${date}/${pushId}/name`] = SCRUBBED;
        hits++;
      }
    }
  }
  if (!dryRun && hits > 0) await db.ref().update(updates);
  return hits;
}

// playerNames/{uid} is uid-keyed and flat (the canonical display name the
// leaderboards join against). A scrub here is what actually clears a slur from
// the visible leaderboard now that names are joined by uid, not just read off
// each row.
async function sweepPlayerNames() {
  const snap = await db.ref('playerNames').once('value');
  const root = snap.val() || {};
  const updates = {};
  let hits = 0;
  for (const uid of Object.keys(root)) {
    const name = root[uid] && root[uid].name;
    if (isHateSpeech(name)) {
      console.log(`  playerNames/${uid}: "${name}" → ${SCRUBBED}`);
      updates[`playerNames/${uid}/name`] = SCRUBBED;
      hits++;
    }
  }
  if (!dryRun && hits > 0) await db.ref().update(updates);
  return hits;
}

// matches/{matchId}/players/{uid}.name — the name every other player in a
// Challenge match sees in the standings.
//
// The derivation in test/scrubCoverage.test.mjs does NOT force this sweep,
// because `matches` is read-gated on `auth != null` rather than world-readable
// (a match is found by its code, not by browsing, so the node is deliberately
// not enumerable). Read posture is not the question that matters here though:
// the name is shown to other humans, so it gets the same backstop every other
// name-bearing path gets. The coverage test asserts this sweep exists anyway,
// so the choice stays deliberate rather than accidental.
async function sweepMatchNames() {
  const snap = await db.ref('matches').once('value');
  const root = snap.val() || {};
  const updates = {};
  let hits = 0;
  for (const matchId of Object.keys(root)) {
    const players = (root[matchId] && root[matchId].players) || {};
    for (const uid of Object.keys(players)) {
      const name = players[uid] && players[uid].name;
      if (isHateSpeech(name)) {
        console.log(`  matches/${matchId}/players/${uid}: "${name}" → ${SCRUBBED}`);
        updates[`matches/${matchId}/players/${uid}/name`] = SCRUBBED;
        hits++;
      }
    }
  }
  if (!dryRun && hits > 0) await db.ref().update(updates);
  return hits;
}

// Friend-list names. users/{uid}/friends/{friendUid} is owner-READ, which is
// exactly why the rules-derived coverage set skips it, and the matches sweep
// already wrote down why that exemption does not settle the question: a read
// posture says nothing about whether the names inside are shown to people.
// A friend row's name IS shown, on the victim's own friends panel, and the
// friends grant deliberately lets a stranger write the entry keyed by their
// own uid into anyone's node (the one-redemption-serves-both-sides design,
// never to be "fixed"). So this is the one path where a stranger chooses a
// victim and plants a permanent name only the victim can see: issue #330.
// The rules now hold the field to the shared character class; this sweep is
// the backstop for what predates them and for anything the class lets by.
async function sweepFriendNames() {
  const snap = await db.ref('users').once('value');
  const root = snap.val() || {};
  const updates = {};
  let hits = 0;
  for (const uid of Object.keys(root)) {
    const friends = (root[uid] && root[uid].friends) || {};
    for (const friendUid of Object.keys(friends)) {
      const name = friends[friendUid] && friends[friendUid].name;
      if (isHateSpeech(name)) {
        console.log(`  users/${uid}/friends/${friendUid}: "${name}" → ${SCRUBBED}`);
        updates[`users/${uid}/friends/${friendUid}/name`] = SCRUBBED;
        hits++;
      }
    }
  }
  if (!dryRun && hits > 0) await db.ref().update(updates);
  return hits;
}

// Expired match codes. Unlike friend codes this is not only tidiness: a match
// lives seven days, so without a sweep the node accumulates a week of dead
// codes at a time and never releases them back to the alphabet. Deleting the
// code does NOT delete the match, which stays readable forever by anyone who
// already joined it (his ruling: writes freeze, reads do not).
const MATCH_CODE_SWEEP_AGE_MS = 7 * 24 * 60 * 60 * 1000;
async function sweepExpiredMatchCodes() {
  const snap = await db.ref('matchCodes').once('value');
  const root = snap.val() || {};
  const updates = {};
  let hits = 0;
  const cutoff = Date.now() - MATCH_CODE_SWEEP_AGE_MS;
  for (const code of Object.keys(root)) {
    const createdAt = root[code] && root[code].createdAt;
    if (typeof createdAt !== 'number' || createdAt < cutoff) {
      console.log(`  matchCodes/${code}: expired (createdAt=${createdAt})`);
      updates[`matchCodes/${code}`] = null;
      hits++;
    }
  }
  if (!dryRun && hits > 0) await db.ref().update(updates);
  return hits;
}

// Expired friend codes: the rules read gate already hides codes older
// than 15 minutes, so this is pure tidiness — delete codes older than
// an hour so the node never accumulates dead entries.
const FRIEND_CODE_SWEEP_AGE_MS = 60 * 60 * 1000;
async function sweepExpiredFriendCodes() {
  const snap = await db.ref('friendCodes').once('value');
  const root = snap.val() || {};
  const updates = {};
  let hits = 0;
  const cutoff = Date.now() - FRIEND_CODE_SWEEP_AGE_MS;
  for (const code of Object.keys(root)) {
    const createdAt = root[code] && root[code].createdAt;
    if (typeof createdAt !== 'number' || createdAt < cutoff) {
      console.log(`  friendCodes/${code}: expired (createdAt=${createdAt})`);
      updates[`friendCodes/${code}`] = null;
      hits++;
    }
  }
  if (!dryRun && hits > 0) await db.ref().update(updates);
  return hits;
}

(async () => {
  console.log(dryRun ? '[DRY RUN] scanning, no writes' : 'scanning + scrubbing');
  const d = await sweepDaily();
  const w = await sweepWeekly();
  const t = await sweepTimed();
  const a = await sweepDailyArchive();
  const p = await sweepPlayerNames();
  const m = await sweepMatchNames();
  const f = await sweepFriendNames();
  const c = await sweepExpiredFriendCodes();
  const mc = await sweepExpiredMatchCodes();
  console.log(`Done. daily hits: ${d}, weekly hits: ${w}, timed hits: ${t}, archive hits: ${a}, playerNames hits: ${p}, match hits: ${m}, friend-name hits: ${f}, expired friend codes: ${c}, expired match codes: ${mc}${dryRun ? ' (dry run — nothing written)' : ''}.`);
  process.exit(0);
})().catch(err => {
  console.error('Sweep FAILED:', err);
  process.exit(1);
});

// Server-side hate-speech sweep for leaderboard display names.
//
// Scans daily/{date}/{pushId}.name and weekly/{weekStart}/{uid}.name,
// and rewrites any name containing a slur to "Anonymous". This is the
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

(async () => {
  console.log(dryRun ? '[DRY RUN] scanning, no writes' : 'scanning + scrubbing');
  const d = await sweepDaily();
  const w = await sweepWeekly();
  console.log(`Done. daily hits: ${d}, weekly hits: ${w}${dryRun ? ' (dry run — nothing written)' : ''}.`);
  process.exit(0);
})().catch(err => {
  console.error('Sweep FAILED:', err);
  process.exit(1);
});

// Find leaderboard scores whose rngSeed doesn't match the canonical
// board's rngSeed for that date. The canonical-board sync (~v1.5.27)
// guarantees every player on the same ET date plays the same layout,
// but a brief window before runStartupGate shipped (v1.5.31) allowed
// silent divergence on a Firebase cold-load race. This script flags
// any score that recorded an rngSeed different from the canonical's
// for that date — those scores are paired against the wrong feature
// vector in the R refit and should be dropped.
//
// Usage:
//   node scripts/audit-divergent-scores.mjs              # report only
//   node scripts/audit-divergent-scores.mjs --delete     # also delete
//
// Read-only by default. The `--delete` flag does NOT require
// authentication because `daily/$date/$entry` has public write
// rules — but be careful: deletion is irreversible.

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

(async () => {
  const args = process.argv.slice(2);
  const doDelete = args.includes('--delete');

  console.log(`Audit divergent scores (${doDelete ? 'DELETE MODE' : 'report only'})`);
  console.log('');

  const [boards, daily] = await Promise.all([
    fetchJson(`${DB_BASE}/dailyBoard.json`),
    fetchJson(`${DB_BASE}/daily.json`),
  ]);

  if (!boards) { console.error('no canonical boards on Firebase'); process.exit(1); }
  if (!daily)  { console.log('no scores on Firebase — nothing to audit'); return; }

  const dates = Object.keys(daily).sort();
  let totalScores = 0;
  let auditableScores = 0;
  let divergentScores = 0;
  const divergentRows = [];

  for (const date of dates) {
    const scores = daily[date] || {};
    const board = boards[date];
    const canonicalSeed = board?.rngSeed || null;

    for (const [pushId, score] of Object.entries(scores)) {
      totalScores++;
      // Pre-canonical-system dates have no board record; skip.
      if (!canonicalSeed) continue;
      // Pre-rngSeed-tracking submissions don't carry the field. The
      // submitter omits it when seed === date (non-experiment day),
      // so a missing rngSeed means "scored against the date itself."
      const scoreSeed = score?.rngSeed || date;
      auditableScores++;
      if (scoreSeed !== canonicalSeed) {
        divergentScores++;
        divergentRows.push({
          date, pushId, name: score?.name || '?', uid: score?.uid || '?',
          time: score?.time, scoreSeed, canonicalSeed,
        });
      }
    }
  }

  console.log(`dates with canonical: ${Object.keys(boards).length}`);
  console.log(`total score rows: ${totalScores}`);
  console.log(`auditable rows (canonical exists): ${auditableScores}`);
  console.log(`divergent rows: ${divergentScores}`);
  console.log('');

  if (divergentRows.length === 0) {
    console.log('No divergent scores found.');
    return;
  }

  console.log('Divergent scores:');
  for (const row of divergentRows) {
    console.log(`  ${row.date} ${row.pushId}  ${row.name.padEnd(15)}  ${String(row.time).padStart(6)}s  ${row.scoreSeed} (expected ${row.canonicalSeed})`);
  }

  if (!doDelete) {
    console.log('');
    console.log('Re-run with --delete to remove these from Firebase.');
    return;
  }

  console.log('');
  console.log('Deleting…');
  for (const row of divergentRows) {
    const url = `${DB_BASE}/daily/${row.date}/${row.pushId}.json`;
    const r = await fetch(url, { method: 'DELETE' });
    if (!r.ok) {
      console.error(`  FAILED  ${row.date}/${row.pushId}: ${r.status}`);
    } else {
      console.log(`  deleted ${row.date}/${row.pushId}`);
    }
  }
  console.log('Done.');
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});

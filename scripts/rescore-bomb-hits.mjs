// One-off migration: re-price every rescorable bomb-hit row under the new
// ESCALATING base penalty (strike n costs BOMB_PENALTY_BASE × n: 1st +3, 2nd
// +6, 3rd +9 …). The old flat base was +3/hit, so the time delta for an
// H-hit play is Σ(3n − 3) = 3·H·(H−1)/2 — added to the stored time, and the
// per-hit penalties bumped by 3·i (i = 0-based strike index).
//
// Only NEW-mechanic rows are touched (per-hit `penalty` present in
// bombHitEvents, or per-day counts on weekly). Legacy +10s/re-fog rows used a
// different mechanic and are left alone ("all you can"). Single-hit plays are
// unchanged (delta 0).
//
// clean_time is INVARIANT here (time and base move together), so the par-model
// difficulty fit is unaffected; only each player's bomb HANDICAP grows.
//
// Read-only by itself: writes the multi-path update to scripts/_rescore-updates.json.
// Apply with:  firebase database:update / scripts/_rescore-updates.json -f --project gregsweeper-66d02
import fs from 'fs';

const BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';
const BASE_PEN = 3;
const r1 = (x) => Math.round(x * 10) / 10;
const get = async (p) => { const r = await fetch(`${BASE}/${p}.json`); return r.ok ? (await r.json()) || {} : {}; };

const [daily, archive, weekly] = await Promise.all([get('daily'), get('dailyArchive'), get('weekly')]);

const updates = {};
const byPlayer = {};
let rows = 0, totalAdded = 0;
const bump = (name, secs) => { byPlayer[name] = (byPlayer[name] || 0) + secs; };

// daily + dailyArchive: per-hit events carry penalty/infoValue.
for (const [root, data] of [['daily', daily], ['dailyArchive', archive]]) {
  for (const date of Object.keys(data)) {
    for (const [id, row] of Object.entries(data[date] || {})) {
      const ev = row && row.bombHitEvents;
      if (!Array.isArray(ev) || ev.length < 2) continue;
      if (!ev.every(e => e && typeof e.penalty === 'number')) continue; // new-mechanic only
      const H = ev.length;
      const delta = BASE_PEN * (H * (H - 1) / 2);
      if (delta === 0) continue;
      const newEv = ev.map((e, i) => ({ ...e, penalty: r1(e.penalty + BASE_PEN * i) }));
      const base = `${root}/${date}/${id}`;
      updates[`${base}/time`] = r1(row.time + delta);
      updates[`${base}/bombHitEvents`] = newEv;
      if (typeof row.totalBombPenalty === 'number') {
        updates[`${base}/totalBombPenalty`] = r1(row.totalBombPenalty + delta);
      }
      rows++; totalAdded += delta; bump(row.name || '(no name)', delta);
    }
  }
}

// weekly: leaderboard row stores dayTimes + dayBombHits (no per-hit events),
// so use the base-delta formula per day. bestTime = min over the updated map.
for (const wk of Object.keys(weekly)) {
  for (const [uid, row] of Object.entries(weekly[wk] || {})) {
    const dbh = (row && row.dayBombHits) || {};
    const dt = { ...((row && row.dayTimes) || {}) };
    let changed = false;
    for (const [day, H] of Object.entries(dbh)) {
      if (H >= 2 && typeof dt[day] === 'number') {
        const delta = BASE_PEN * (H * (H - 1) / 2);
        if (delta === 0) continue;
        dt[day] = r1(dt[day] + delta);
        updates[`weekly/${wk}/${uid}/dayTimes/${day}`] = dt[day];
        rows++; totalAdded += delta; bump(row.name || '(no name)', delta); changed = true;
      }
    }
    if (changed) {
      const best = Math.min(...Object.values(dt).filter(v => typeof v === 'number'));
      updates[`weekly/${wk}/${uid}/bestTime`] = r1(best);
    }
  }
}

fs.writeFileSync('scripts/_rescore-updates.json', JSON.stringify(updates, null, 0));
console.log(`Rescored ${rows} bomb-hit rows; +${r1(totalAdded)}s added in total.`);
console.log(`Wrote ${Object.keys(updates).length} update paths to scripts/_rescore-updates.json`);
console.log('\nPer-player seconds added:');
for (const [name, secs] of Object.entries(byPlayer).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name.padEnd(20)} +${r1(secs)}s`);
}
console.log('\nApply with:\n  firebase database:update / scripts/_rescore-updates.json -f --project gregsweeper-66d02');

// Leaderboard view logic, pure (no DOM, no Firebase) so the
// regression suite can pin ranking math and the friend-write shapes.
// main.js renders these; firebaseFriends.js sends the update objects.

// Handicap-adjusted ranking. rows: [{uid, name, time, ...}].
// handicapMap: uid -> k (a MULTIPLICATIVE ratio), as either a Map OR the
// plain object loadHandicaps()/getHandicapRatioMap() resolves, the SHIPPED
// fit, identical for every viewer (client-side provisional handicaps are
// self-only estimates, never applied to other players). k > 1 = typically
// slower than Greg, k < 1 = faster.
//
//   adjusted = time / k  - a Greg-equivalent time. Playing exactly to your
//   own ratio lands you at par regardless of k, so the ranking is by
//   FRACTIONAL performance vs your own par (the leveling property the old
//   additive `time - seconds` form lacked, and the reason a 1.2s run by a
//   very fast player no longer produces a nonsense adjusted time).
//
// A row whose uid has no fitted ratio (or a non-positive/garbage one) ranks
// by raw time (k=1) and is flagged unrated. Sort is stable: ties keep input
// (raw-time) order.
export function rankAdjusted(rows, handicapMap) {
  const lookup = (uid) => {
    if (!handicapMap || uid == null) return undefined;
    if (typeof handicapMap.get === 'function') return handicapMap.get(uid);
    return Object.prototype.hasOwnProperty.call(handicapMap, uid) ? handicapMap[uid] : undefined;
  };
  const out = (rows || []).map((row, i) => {
    const raw = lookup(row.uid);
    // Rated = present in the shipped ratio fit with a positive, finite k.
    // A non-positive/garbage k falls back to unrated (k=1) rather than
    // producing a divide-by-zero or negative adjusted time.
    const rated = typeof raw === 'number' && Number.isFinite(raw) && raw > 0;
    const ratio = rated ? raw : 1;
    return {
      ...row,
      ratio,
      adjusted: row.time / ratio,
      rated,
      _i: i,
    };
  });
  out.sort((a, b) => (a.adjusted - b.adjusted) || (a._i - b._i));
  for (const r of out) delete r._i;
  return out;
}

// Friends-view filter: the viewer always sees themself alongside their
// friends, even with an empty friend list.
export function filterToFriends(rows, friendUids, myUid) {
  const set = new Set(friendUids || []);
  if (myUid) set.add(myUid);
  return (rows || []).filter(r => set.has(r.uid));
}

// Multi-location update payloads for the MUTUAL friendship writes.
// Path shapes and field sets are pinned by test/leaderboardViews.test.mjs
// against firebase-rules.json's `$other: validate false`, a drifted
// field fails CI before it can fail at the rules layer in prod.
// `ts` is the caller-supplied timestamp sentinel
// (firebase.database.ServerValue.TIMESTAMP, never Date.now(), the
// rules validate addedAt === now).
export function buildFriendAddUpdate(myUid, myName, theirUid, theirName, ts) {
  if (!myUid || !theirUid) throw new Error('missing uid');
  if (myUid === theirUid) throw new Error('cannot add yourself');
  return {
    [`users/${myUid}/friends/${theirUid}`]: { name: String(theirName || '').slice(0, 20), addedAt: ts },
    [`users/${theirUid}/friends/${myUid}`]: { name: String(myName || '').slice(0, 20), addedAt: ts },
  };
}

export function buildFriendRemoveUpdate(myUid, theirUid) {
  if (!myUid || !theirUid) throw new Error('missing uid');
  if (myUid === theirUid) throw new Error('cannot remove yourself');
  return {
    [`users/${myUid}/friends/${theirUid}`]: null,
    [`users/${theirUid}/friends/${myUid}`]: null,
  };
}

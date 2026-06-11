// Leaderboard view logic — pure (no DOM, no Firebase) so the
// regression suite can pin ranking math and the friend-write shapes.
// main.js renders these; firebaseFriends.js sends the update objects.

// Handicap-adjusted ranking. rows: [{uid, name, time, ...}].
// handicapMap: uid -> seconds, as either a Map OR the plain object that
// loadHandicaps() actually resolves ({uid: number} straight from
// handicaps.json) — the SHIPPED fit, identical for every viewer
// (client-side provisional handicaps are self-only estimates and are
// never applied to other players). A row whose uid has no fitted
// handicap ranks by raw time and is flagged unrated. Sort is stable:
// ties keep input order (the raw fetch is already time-ordered, so
// equal adjusted times fall back to raw order).
export function rankAdjusted(rows, handicapMap) {
  const lookup = (uid) => {
    if (!handicapMap || uid == null) return undefined;
    if (typeof handicapMap.get === 'function') return handicapMap.get(uid);
    return Object.prototype.hasOwnProperty.call(handicapMap, uid) ? handicapMap[uid] : undefined;
  };
  const out = (rows || []).map((row, i) => {
    const h = lookup(row.uid);
    // Rated = present in the shipped fit. A fitted handicap of exactly
    // 0 is still rated — absence from the map is what "unrated" means.
    const rated = typeof h === 'number' && Number.isFinite(h);
    return {
      ...row,
      handicap: rated ? h : 0,
      adjusted: row.time - (rated ? h : 0),
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
// against firebase-rules.json's `$other: validate false` — a drifted
// field fails CI before it can fail at the rules layer in prod.
// `ts` is the caller-supplied timestamp sentinel
// (firebase.database.ServerValue.TIMESTAMP — never Date.now(), the
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

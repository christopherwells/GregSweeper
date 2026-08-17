// A player's Challenge history: the solo-run records this device keeps, and
// the verdict lines the finished list derives from any run, solo or shared.
//
// A SHARED run's record is its match node, readable forever by his ruling, so
// the cloud already remembers those. A SOLO run has no node: its results lived
// only in the save slot, and the end card was the last anyone saw of them. His
// ruling (2026-08-17) follows the Quick Play precedent: a compact record in
// this device's own storage, stripped of board payloads, capped, never synced.
// A solo run played on the phone stays on the phone, and the list says so.
//
// Pure and a leaf. Storage I/O lives in src/storage/matchHistoryStorage.js;
// the record is assembled NODE-SHAPED on demand (soloNodeShape) so the clean
// comparison painter and matchBoardBreakdown read a solo run exactly the way
// they read a fetched node, one painter for every report (his 2026-08-16
// design, extended rather than duplicated).

/** Newest-first cap on stored solo runs. */
export const SOLO_HISTORY_CAP = 50;

/**
 * The uid a solo record's one player sits under in its node shape.
 *
 * A fixed token rather than the live uid, deliberately: records are
 * device-local, and keying them by whoever was signed in at the time would
 * strand every earlier run behind an account switch. Callers pass this as
 * `myUid` when painting, so `isMe` resolves without any identity at all.
 */
export const SOLO_UID = 'solo';

/**
 * A finished solo run, compacted for storage.
 *
 * Boards keep seed, par and spec and drop everything else: the payload is the
 * other 95% of the bytes and a report never re-deals a finished run, while the
 * spec is what names each board's shape and the splits' buckets. Results keep
 * the three numbers the comparison grid reads. Null when there is nothing
 * worth recording (no boards, or no board ever cleared).
 *
 * @param {object|null} match  the state.match shape: {rules, entries, results}
 * @param {number} finishedAt  epoch ms
 * @returns {object|null}
 */
export function soloRunRecord(match, finishedAt) {
  const entries = Array.isArray(match && match.entries) ? match.entries : [];
  const results = Array.isArray(match && match.results) ? match.results : [];
  const finite = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const played = results.filter((r) => r && finite(r.time) !== null);
  if (entries.length === 0 || played.length === 0) return null;
  return {
    v: 1,
    finishedAt: Number(finishedAt) || 0,
    rules: (match.rules && typeof match.rules === 'object')
      ? match.rules : { count: entries.length },
    boards: entries.map((e) => ({
      seed: (e && e.seed) || null,
      par: finite(e && e.par) || 0,
      spec: (e && e.spec) || null,
    })),
    results: entries.map((_, i) => {
      const r = results[i];
      const time = finite(r && r.time);
      if (time === null) return null;
      return {
        time,
        penalty: finite(r.penalty) || 0,
        strikes: finite(r.strikes) || 0,
      };
    }),
  };
}

/**
 * Add a record to the stored list: newest first, capped, oldest dropped.
 * Returns a NEW list; the input is not mutated.
 */
export function appendSoloRun(list, record, cap = SOLO_HISTORY_CAP) {
  const base = Array.isArray(list) ? list : [];
  if (!record) return base.slice(0, cap);
  return [record, ...base].slice(0, cap);
}

/**
 * A solo record in the match NODE shape, so matchStandings, the breakdown and
 * the clean comparison painter take it unchanged. The one player sits under
 * SOLO_UID with a stamped finishedAt (a record only exists for a finished
 * run), and there is no name child at all: the painter labels the viewer's
 * own column "You", which is the only column there is.
 */
export function soloNodeShape(record) {
  if (!record || !Array.isArray(record.boards)) return null;
  return {
    rules: record.rules || { count: record.boards.length },
    createdAt: Number(record.finishedAt) || 0,
    boards: record.boards.map((b) => ({
      seed: (b && b.seed) || null,
      par: (b && b.par) || 0,
      spec: (b && b.spec) || null,
    })),
    players: {
      [SOLO_UID]: {
        results: record.results.map((r) => (r ? { ...r } : null)),
        finishedAt: Number(record.finishedAt) || 1,
      },
    },
  };
}

// ── The finished list's verdict line ────────────────────────────────────

/**
 * One run's outcome, from its ranked standings rows (matchStandings order:
 * adjusted, finished above unfinished). The kinds mirror the clean
 * comparison's own headline logic, because the list row is that headline
 * compressed to a phrase; the two surfaces must never disagree about who won.
 *
 *   won        first among two or more finished, by `gap` adjusted seconds
 *   tied       level with the nearest finished rival
 *   behind     finished `place` of `of`, `gap` behind the leader
 *   waiting    finished, with rivals still on the boards
 *   alone      finished, and nobody else ever joined (solo runs land here)
 *   unfinished this player's own run stopped at `done` of `of`
 *   none       this player has no row at all
 *
 * Gaps are rounded to a tenth, the grid's own precision; the caller formats
 * them through fmtGap so the two speak alike.
 */
export function runOutcome(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const me = list.find((r) => r && r.isMe) || null;
  if (!me) return { kind: 'none' };
  if (!me.finished) return { kind: 'unfinished', done: me.done || 0, of: me.of || 0 };
  if (list.length === 1) return { kind: 'alone' };
  const finished = list.filter((r) => r.finished);
  if (finished.length >= 2) {
    const place = finished.indexOf(me);
    const tenth = (x) => Math.round(x * 10) / 10;
    if (place === 0) {
      const gap = tenth(finished[1].adjusted - me.adjusted);
      return gap === 0
        ? { kind: 'tied', rivalUid: finished[1].uid }
        : { kind: 'won', gap, rivalUid: finished[1].uid };
    }
    return {
      kind: 'behind',
      place: place + 1,
      of: list.length,
      gap: tenth(me.adjusted - finished[0].adjusted),
      rivalUid: finished[0].uid,
    };
  }
  return { kind: 'waiting' };
}

// ── Dates for the list ──────────────────────────────────────────────────
//
// Fixed English month names rather than a locale call, the app's own
// convention (prettyDate renders leaderboard dates the same way), so a test
// can pin the output and two devices group one run under one label.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** "August 2026", the finished list's section header. */
export function monthLabel(ms) {
  const d = new Date(Number(ms) || 0);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "Aug 14", the row's own date. */
export function shortDate(ms) {
  const d = new Date(Number(ms) || 0);
  return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
}

/**
 * Group already-sorted entries into month sections, preserving order within
 * and across groups. `timeOf` reads each entry's epoch ms; entries whose time
 * cannot be read land under the epoch's own month rather than being dropped,
 * because a run with a broken stamp is still a run.
 */
export function groupRunsByMonth(entries, timeOf) {
  const groups = [];
  const byKey = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const t = Number(timeOf(entry)) || 0;
    const d = new Date(t);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    let group = byKey.get(key);
    if (!group) {
      group = { key, label: monthLabel(t), entries: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

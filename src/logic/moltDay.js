// Molt day: the daily-streak insurance. Every MOLT_EARN_EVERY consecutive
// daily completions banks one molt day (capped at MOLT_CAP). A banked molt day
// is spent automatically and lazily at the next completion to cover a missed ET
// day, so the streak survives a day off. When the gap exceeds the bank the
// streak resets and the bank is RETAINED: a molt day is only spent when it
// actually saves the streak (all-or-nothing). The metaphor is Greg the crab
// taking a day to shelter while it molts.
//
// Pure module: no DOM, no Firebase, no clock. Callers pass the dates in. This
// is the single source of truth for all three consumers — the completion path
// (statsStorage.saveGameResult), the app-load provisional notice (the title
// daily card in main.js), and the push script (send-push.mjs) — so the bank
// math can never disagree between them.

// Bank one molt day for every run of this many consecutive completions.
export const MOLT_EARN_EVERY = 5;
// The most molt days a player can hold at once.
export const MOLT_CAP = 2;

// Whole ET days from `from` to `to` (both 'YYYY-MM-DD'). Same midnight-anchored
// parse + rounding the streak code in statsStorage.js already uses, so a DST
// boundary (a 23- or 25-hour day) still rounds to a whole calendar day.
// Positive when `to` is after `from`.
function dayDiff(from, to) {
  const a = new Date(from + 'T00:00:00');
  const b = new Date(to + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

// `date` plus `n` calendar days, formatted 'YYYY-MM-DD'. Parses and formats in
// the same local basis as dayDiff, so it never crosses into UTC; setDate is
// DST-safe (it adjusts the wall clock to keep the calendar day correct).
function addDays(date, n) {
  const d = new Date(date + 'T00:00:00');
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// The ET dates strictly between `from` and `to` — the days that were missed and
// are now covered by spent molt days.
function missedDatesBetween(from, to) {
  const out = [];
  const diff = dayDiff(from, to);
  for (let i = 1; i < diff; i++) out.push(addDays(from, i));
  return out;
}

function clampBank(banked) {
  const n = Math.floor(banked || 0);
  if (n < 0) return 0;
  if (n > MOLT_CAP) return MOLT_CAP;
  return n;
}

/**
 * One-time launch grant for players who already hold a streak when molt days
 * ship: a streak past one earn cycle (> MOLT_EARN_EVERY-1) is worth 1, past two
 * (> 2*MOLT_EARN_EVERY-1) is worth the full cap. Mirrors what they would have
 * banked had the mechanic always existed. Pure; the caller guards idempotency.
 *
 * @param {number} streak the player's current daily streak
 * @returns {number} molt days to grant (0..MOLT_CAP)
 */
export function backfillGrant(streak) {
  const s = Math.max(0, Math.floor(streak || 0));
  if (s > 2 * MOLT_EARN_EVERY - 1) return MOLT_CAP; // > 9 -> 2
  if (s > MOLT_EARN_EVERY - 1) return 1;            // > 4 -> 1
  return 0;
}

/**
 * Apply a real daily completion on `today` to the stored streak and molt bank.
 * Earn (the streak reaching a multiple of MOLT_EARN_EVERY) is applied AFTER any
 * spend or increment, and only on a completion that advances the streak, so a
 * covered day can never earn a molt day on its own.
 *
 * @param {Object} p
 * @param {string|null} p.lastDailyDate previous completion's ET date, or null/'' if none
 * @param {number} p.streak the stored dailyStreak going into today
 * @param {number} p.banked molt days currently held (0..MOLT_CAP)
 * @param {string} p.today this completion's ET date (the puzzle's seed date)
 * @returns {{ streak: number, banked: number, coveredDates: string[], earned: boolean }}
 */
export function applyStreakContinuation({ lastDailyDate, streak, banked, today }) {
  const prevStreak = Math.max(0, Math.floor(streak || 0));
  let bank = clampBank(banked);
  let coveredDates = [];
  let newStreak;
  let advanced;

  if (!lastDailyDate) {
    // First daily ever.
    newStreak = 1;
    advanced = true;
  } else {
    const diff = dayDiff(lastDailyDate, today);
    if (diff <= 0) {
      // Same day (or a stale duplicate): the streak was already counted.
      newStreak = prevStreak;
      advanced = false;
    } else if (diff === 1) {
      // Consecutive day.
      newStreak = prevStreak + 1;
      advanced = true;
    } else {
      // Gap. The missed days are those strictly between last and today.
      const missedDays = diff - 1;
      if (missedDays <= bank) {
        // Covered: spend, streak continues with today's +1 only (the covered
        // days themselves add nothing to the count).
        bank -= missedDays;
        coveredDates = missedDatesBetween(lastDailyDate, today);
        newStreak = prevStreak + 1;
      } else {
        // Not enough cover: reset to 1, bank retained.
        newStreak = 1;
      }
      advanced = true;
    }
  }

  // Earn AFTER the spend/increment, only when the streak advanced (so a
  // defensive same-day re-run can't re-bank at a multiple of 5).
  let earned = false;
  if (advanced && newStreak > 0 && newStreak % MOLT_EARN_EVERY === 0 && bank < MOLT_CAP) {
    bank += 1;
    earned = true;
  }

  return { streak: newStreak, banked: bank, coveredDates, earned };
}

/**
 * Read-only projection of what completing today WOULD do, for the app-load
 * provisional notice and any "what happens if I play" surface. Thin wrapper
 * over applyStreakContinuation with no commit. `willCover` is true when a molt
 * day would be spent to save the streak.
 *
 * @param {Object} p see applyStreakContinuation
 * @returns {{ willCover: boolean, coveredDates: string[], streakAfter: number }}
 */
export function projectContinuation({ lastDailyDate, streak, banked, today }) {
  const r = applyStreakContinuation({ lastDailyDate, streak, banked, today });
  return {
    willCover: r.coveredDates.length > 0,
    coveredDates: r.coveredDates,
    streakAfter: r.streak,
  };
}

/**
 * Is the streak still alive as of `today`, before any completion is committed?
 * True when the last completion was today or yesterday, OR the missed gap is
 * still within the bank (a molt day will cover it when the player next plays).
 * This is the read-side companion to getDailyStreak's lapse check: a covered
 * gap shows the live streak, not zero.
 *
 * @param {Object} p
 * @param {string|null} p.lastDailyDate previous completion's ET date
 * @param {number} p.banked molt days currently held
 * @param {string} p.today current ET date
 * @returns {boolean}
 */
export function isStreakAlive({ lastDailyDate, banked, today }) {
  if (!lastDailyDate) return false;
  const diff = dayDiff(lastDailyDate, today);
  if (diff <= 1) return true;
  return diff - 1 <= clampBank(banked);
}

/**
 * Push gate, evaluated at the 8pm ET warning when the player has not played
 * today: would a banked molt day cover them skipping tonight? True means there
 * is no real risk tonight, so the at-risk warning should be suppressed.
 *
 * Skipping today turns today into a missed day on top of any already missed
 * since lastDailyDate, so the bank covers tonight iff it can absorb that extra
 * day: banked >= alreadyMissed + 1.
 *
 * @param {Object} p
 * @param {string|null} p.lastDailyDate previous completion's ET date
 * @param {number} p.banked molt days currently held
 * @param {string} p.today current ET date
 * @returns {boolean}
 */
export function coversTonight({ lastDailyDate, banked, today }) {
  if (!lastDailyDate) return false;
  const diff = dayDiff(lastDailyDate, today);
  if (diff <= 0) return false; // already played today
  const alreadyMissed = Math.max(0, diff - 1);
  return clampBank(banked) >= alreadyMissed + 1;
}

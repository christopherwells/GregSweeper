// Daily win-modal par display decision.
//
// Resolves the handicap (the refit value, else a provisional mean from local
// residuals), the newcomer gate, and the par-relative delta line. The win
// handler keeps the DOM (innerHTML, sprites, the one-time primer, the Lab File
// itemization); this returns the numbers and copy it renders. Extracted so the
// newcomer gate and the ±0.5s delta thresholds are node-tested instead of
// living inside a 100-line modal builder.
//
// Pure module — node-tested in test/parDisplayDecision.test.mjs.

import { estimateHandicapDetails } from './handicaps.js';

// A newcomer's first few dailies show ONLY the plain "vs Greg's Time" line.
// Handicap/personal-par, the per-feature breakdown chips, and the history strip
// stay hidden until the player has more than this many plays, so the very first
// result screen isn't a wall of scoring jargon.
export const NEWCOMER_DAILY_LIMIT = 3;

/**
 * @param {object} args
 * @param {number} args.precise        the player's completion time (seconds)
 * @param {number} args.dailyPar       Greg's par for today's board (seconds)
 * @param {number} args.refitRatio      getHandicapRatio(uid); 1 (neutral) when the refit hasn't included this user
 * @param {number} [args.refitBombSeconds] the fit's additive bomb-seconds for this user (0 if none)
 * @param {boolean} args.isRated        isRatedHandicap(uid); true when the user is in the shipped ratio fit
 * @param {Array}  args.residuals       loadDailyResiduals() AFTER this play was appended (today included)
 * @returns {{
 *   ratio: number, provisional: (object|null), isNewcomerDaily: boolean,
 *   personalPar: number, useHandicap: boolean, referencePar: number,
 *   parClass: string, deltaText: string, deltaShort: string, yourParLabel: string,
 *   showOneMoreHint: boolean,
 * }}
 */
export function resolveParDisplay({ precise, dailyPar, refitRatio, refitBombSeconds, isRated, residuals }) {
  const safeResiduals = Array.isArray(residuals) ? residuals : [];

  // Prefer the refit ratio; if the refit hasn't included this user, fall back
  // to a provisional geometric-mean ratio from the player's own residuals so a
  // newcomer sees a tightening "Your par" instead of "Greg's Time" alone. The
  // provisional carries no clean/bomb split (bombs ride in the ratio); the
  // separate bombSeconds term only exists once the fit ships it.
  let ratio = (typeof refitRatio === 'number' && refitRatio > 0) ? refitRatio : 1;
  let bombSeconds = typeof refitBombSeconds === 'number' ? refitBombSeconds : 0;
  let provisional = null;
  if (!isRated) {
    bombSeconds = 0;
    const est = estimateHandicapDetails(safeResiduals.map((r) => ({
      time: r.time,
      predictedPar: r.par,
    })));
    ratio = est ? est.k : 1;
    provisional = est;
  }

  const isNewcomerDaily = safeResiduals.length <= NEWCOMER_DAILY_LIMIT;
  // Skill scales with the board (ratio); bombs are a fixed seconds cost.
  const personalPar = dailyPar * ratio + bombSeconds;
  const useHandicap = (ratio !== 1 || bombSeconds !== 0) && !isNewcomerDaily;
  const referencePar = useHandicap ? personalPar : dailyPar;
  const delta = precise - referencePar;
  const absDelta = Math.abs(delta).toFixed(1);

  // deltaText is the full phrase ("2.3s under your par"); deltaShort drops the
  // "your par"/"par" suffix ("2.3s under") for the simplified daily win line,
  // where the label already reads "Your par …" / "Greg's time …" and repeating
  // it double-says. Both share the ±0.5s thresholds so they can't disagree.
  let parClass, deltaText, deltaShort;
  if (delta < -0.5) {
    parClass = 'par-under';
    deltaShort = absDelta + 's under';
    deltaText = deltaShort + ' ' + (useHandicap ? 'your par' : 'par');
  } else if (delta > 0.5) {
    parClass = 'par-over';
    deltaShort = absDelta + 's over';
    deltaText = deltaShort + ' ' + (useHandicap ? 'your par' : 'par');
  } else {
    parClass = 'par-even';
    deltaShort = 'even';
    deltaText = useHandicap ? 'Even with your par!' : 'Even par!';
  }

  // Provisional handicaps carry a "(N plays)" qualifier so the player knows the
  // number will tighten and we don't pretend a 2-play mean rivals a 30-play fit.
  const yourParLabel = provisional
    ? 'Your par (provisional, ' + provisional.n + ' plays): '
    : 'Your par: ';

  // "1 more daily and your personal par appears" — shown only in the
  // no-handicap branch, when the player has exactly one residual.
  const showOneMoreHint = safeResiduals.length === 1;

  return {
    ratio, provisional, isNewcomerDaily, personalPar, useHandicap,
    referencePar, parClass, deltaText, deltaShort, yourParLabel, showOneMoreHint,
  };
}

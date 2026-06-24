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
 * @param {number} args.refitHandicap  getHandicap(uid); 0 when the refit hasn't included this user yet
 * @param {Array}  args.residuals      loadDailyResiduals() AFTER this play was appended (today included)
 * @returns {{
 *   handicap: number, provisional: (object|null), isNewcomerDaily: boolean,
 *   personalPar: number, useHandicap: boolean, referencePar: number,
 *   parClass: string, deltaText: string, yourParLabel: string,
 *   showOneMoreHint: boolean,
 * }}
 */
export function resolveParDisplay({ precise, dailyPar, refitHandicap, residuals }) {
  const safeResiduals = Array.isArray(residuals) ? residuals : [];

  // Prefer the refit handicap; if the refit hasn't included this user (0),
  // fall back to a provisional mean residual so a newcomer sees a tightening
  // "Your par" instead of "Greg's Time" alone. (estimateHandicapDetails uses
  // time − predictedPar; the bombHits field is carried but currently unused.)
  let handicap = refitHandicap;
  let provisional = null;
  if (refitHandicap === 0) {
    const est = estimateHandicapDetails(safeResiduals.map((r) => ({
      time: r.time,
      predictedPar: r.par,
      bombHits: r.bombHits || 0,
    })));
    if (est) {
      handicap = est.handicap;
      provisional = est;
    }
  }

  const isNewcomerDaily = safeResiduals.length <= NEWCOMER_DAILY_LIMIT;
  const personalPar = dailyPar + handicap;
  const useHandicap = handicap !== 0 && !isNewcomerDaily;
  const referencePar = useHandicap ? personalPar : dailyPar;
  const delta = precise - referencePar;
  const absDelta = Math.abs(delta).toFixed(1);

  let parClass, deltaText;
  if (delta < -0.5) {
    parClass = 'par-under';
    deltaText = absDelta + 's under ' + (useHandicap ? 'your par' : 'par');
  } else if (delta > 0.5) {
    parClass = 'par-over';
    deltaText = absDelta + 's over ' + (useHandicap ? 'your par' : 'par');
  } else {
    parClass = 'par-even';
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
    handicap, provisional, isNewcomerDaily, personalPar, useHandicap,
    referencePar, parClass, deltaText, yourParLabel, showOneMoreHint,
  };
}

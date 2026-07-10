// Daily share-card text (pure, node-tested).
//
// The Wordle-style daily card: a HARD CEILING of five content lines plus the
// crux-challenge link. Extracted from main.js so the two contracts that used
// to be untestable are pinned:
//
//   - The date on the card is the BOARD's date (state.dailySeed), never the
//     wall clock. The submit paths were always anchored this way ("a finish
//     at 12:00:01 AM lands on the board's own leaderboard"), but the share
//     card stamped getLocalDateString() — wrong for a finish just past
//     midnight ET and for every archive replay of a past board
//     (2026-07-10 audit).
//   - The five-line ceiling + single link line.

/**
 * Build the daily win share card's lines.
 *
 * @param {Object} p
 * @param {string} p.mineEmoji   theme mine glyph for the title line
 * @param {string} p.dateStr     the BOARD's date (state.dailySeed), YYYY-MM-DD
 * @param {number} p.time        completion seconds
 * @param {number} p.par         Greg's par for the board (0 = unknown)
 * @param {string} p.gimmickIcons concatenated modifier icons ('' when none)
 * @param {number} p.certTier    certified technique tier (0-3) or 0
 * @param {number} p.bombHits    strikes this run
 * @param {string} p.cruxUrl     full URL of the crux-challenge link
 * @returns {string[]} card lines, ready to join('\n')
 */
export function dailyShareLines({ mineEmoji, dateStr, time, par, gimmickIcons, certTier, bombHits, cruxUrl }) {
  const lines = [`${mineEmoji} GregSweeper · ${dateStr}`];

  if (par > 0) {
    const delta = time - par;
    const absDelta = Math.abs(delta).toFixed(1);
    // Greg IS par: under par beats Greg, over par he wins.
    lines.push(delta <= 0
      ? `⏱ ${time}s · beat Greg by ${absDelta}s 🦀`
      : `⏱ ${time}s · Greg won by ${absDelta}s 🦀`);

    // Pace bar: 8 dots, full at ±20% of par.
    const magnitude = Math.min(1, Math.abs(delta) / (par * 0.2));
    const filled = Math.round(magnitude * 8);
    const fillDot = delta <= 0 ? '🟢' : '🔴';
    lines.push(fillDot.repeat(filled) + '⚪'.repeat(8 - filled));
  } else {
    lines.push(`⏱ ${time}s`);
  }

  // Modifier icons + the hardest step the board required, in plain words
  // (the certified tier — never more than the solver proved).
  const stepPhrase = certTier >= 3 ? 'hardest step: liar logic'
    : certTier === 2 ? 'hardest step: region logic'
    : certTier === 1 ? 'hardest step: clue-comparison'
    : '';
  const line4 = [gimmickIcons, stepPhrase].filter(Boolean).join(' · ');
  if (line4) lines.push(line4);

  if (bombHits > 0) {
    lines.push(`💥×${bombHits}`);
  }

  // The card's single link is a crux challenge: a softer hook than a bare
  // play link, and the teaser's own "Play today's board" CTA still routes
  // the recipient to the daily.
  lines.push(`🦀 Try yesterday's crux: ${cruxUrl}`);
  return lines;
}

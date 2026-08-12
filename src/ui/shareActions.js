// ── Share actions ─────────────────────────────────────
// Extracted from main.js (2026-07-10 split). Builds the mode-specific
// share text (the daily card via the pure, node-tested dailyShareLines)
// and drives Web Share / clipboard fallbacks. main.js wires the buttons.

import { state } from '../state/gameState.js';
import { getThemeEmoji } from './boardRenderer.js';
import { uiSpriteImgHTML } from './spriteLoader.js';
import { showToast } from './toastManager.js';
import { getLastShareFile } from './shareCardImage.js';
import { loadStats } from '../storage/statsStorage.js';
import { matchTotals } from '../logic/matchRules.js';
import { getHandicapRatio, isRatedHandicap } from '../logic/handicaps.js';
import { getUid } from '../firebase/firebaseProgress.js';
import { getHighestTier } from '../logic/achievements.js';
import { getGimmickDefs } from '../logic/gimmicks.js';
import { getLocalDateString, addCalendarDays } from '../logic/seededRandom.js';
import { dailyShareLines } from '../logic/shareCard.js';
import { PROD_SITE_BASE } from '../config.js';

// Exported for the node test that pins each mode's card facts (the weekly
// card once stamped the stale challenge level's dimensions).
export function generateShareCard() {
  const level = state.currentLevel;
  const time = state.elapsedTime;
  // The card describes the PLAYED board, so it reads the live state
  // rather than re-deriving from a level table (no mode has a level→dims
  // function any more: a Climb level is a spec, a match board is a deal,
  // and the board on screen is what was played).
  const diff = { rows: state.rows, cols: state.cols, mines: state.totalMines };
  const mode = state.gameMode;
  const modeLabel = { normal: 'The Climb', match: 'Challenge', daily: 'Daily', weekly: 'Weekly', chaos: 'Chaos' }[mode] || 'The Climb';

  const stats = loadStats();
  const streakText = stats.currentStreak > 1 ? ` | 🔥 ${stats.currentStreak} streak` : '';
  const tier = getHighestTier(stats);
  const tierText = tier ? ` | ${tier.icon} ${tier.name}` : '';

  const levelLabel = `Level ${level}`;

  if (mode === 'daily') {
    // Wordle-style card, built by the pure (node-tested) dailyShareLines:
    // HARD CEILING of five content lines plus the crux-challenge URL. The
    // date is the BOARD's (state.dailySeed), the same anchor as the score
    // submission, so a finish just past midnight ET or an archive replay
    // never stamps the wrong day on the card.
    const defs = getGimmickDefs();
    const icons = (state.activeGimmicks || [])
      .map(g => defs[g] && defs[g].icon)
      .filter(Boolean)
      .join('');
    return dailyShareLines({
      mineEmoji: getThemeEmoji('mine'),
      dateStr: state.dailySeed || getLocalDateString(),
      time,
      par: state.dailyPar || 0,
      gimmickIcons: icons,
      certTier: state.boardCertificate ? state.boardCertificate.tier : 0,
      bombHits: state.dailyBombHits || 0,
      cruxUrl: `${PROD_SITE_BASE}?crux=${addCalendarDays(getLocalDateString(), -1)}`,
    }).join('\n');
  }

  if (mode === 'match') {
    // A match card reports the MATCH, not the board just finished: the
    // per-board clocks are the match's own business and the total is the
    // thing a player would share. Adjusted rides beneath it when this
    // player carries a rating (his adjusted-only ruling is about
    // comparison, and the total is the comparable number).
    const results = (state.match && state.match.results || []).filter(Boolean);
    const uid = getUid();
    const totals = matchTotals(results, isRatedHandicap(uid) ? getHandicapRatio(uid) : null);
    const n = results.length;
    const adjLine = totals.adjusted != null ? ` · ${totals.adjusted.toFixed(1)}s adjusted` : '';
    return `${getThemeEmoji('mine')} GregSweeper · Challenge\n` +
           `${n} board${n === 1 ? '' : 's'} in ${totals.raw.toFixed(1)}s${adjLine}${tierText}\n\n` +
           PROD_SITE_BASE;
  }

  if (mode === 'weekly') {
    // Weekly has no challenge level, state.currentLevel is whatever the
    // last challenge run left behind, so the generic card below stamped
    // that level's label and DIMENSIONS on the weekly board. Describe the
    // board actually played instead.
    return `${getThemeEmoji('mine')} GregSweeper · Weekly\n` +
           `${state.rows}x${state.cols} in ${time}s${streakText}${tierText}\n\n` +
           PROD_SITE_BASE;
  }

  if (mode === 'chaos') {
    // Same class as weekly: chaos PINS currentLevel at 1 on entry and
    // sizes its boards by chaosRound (getChaosDifficulty), so the generic
    // card deterministically claimed "Level 1 (5x5)" for every chaos
    // share while the image beside it drew the real 8x8+ board. Report
    // the round and the board actually played, in the mode's own words.
    return `${getThemeEmoji('mine')} GregSweeper · Chaos\n` +
           `Round ${state.chaosRound || 1} · ${state.rows}x${state.cols} in ${time}s${tierText}\n\n` +
           PROD_SITE_BASE;
  }

  return `${getThemeEmoji('mine')} GregSweeper · ${modeLabel}\n` +
         `${levelLabel} (${diff.rows}x${diff.cols}) in ${time}s${streakText}${tierText}\n\n` +
         PROD_SITE_BASE;
}

export function handleShare() {
  const text = generateShareCard();
  const file = getLastShareFile();
  // Web Share Level 2: share the rendered card IMAGE plus the caption.
  // Must stay inside the click gesture, no await before navigator.share.
  if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], text }).catch((e) => {
      if (e && e.name === 'AbortError') return; // user dismissed the sheet
      copyToClipboard(text);
    });
    return;
  }
  if (navigator.share) {
    navigator.share({ text }).catch(() => copyToClipboard(text));
  } else if (file) {
    // Desktop without Web Share files: download the image, copy the caption.
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = 'gregsweeper.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    copyToClipboard(text);
    showToast('Card image saved · caption copied');
  } else {
    copyToClipboard(text);
  }
}

export function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showShareCopiedToast();
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showShareCopiedToast();
  });
}

function showShareCopiedToast() {
  const toast = document.createElement('div');
  toast.className = 'share-copied-toast';
  toast.innerHTML = `${uiSpriteImgHTML('uiCopy', 'toast-icon')} Copied to clipboard!`;
  toast.classList.add('has-icon');
  document.getElementById('app').appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

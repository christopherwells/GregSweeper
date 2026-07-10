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
import { getDifficultyForLevel, getTimedDifficulty, getSpeedRating } from '../logic/difficulty.js';
import { getHighestTier } from '../logic/achievements.js';
import { getGimmickDefs } from '../logic/gimmicks.js';
import { getLocalDateString, addCalendarDays } from '../logic/seededRandom.js';
import { dailyShareLines } from '../logic/shareCard.js';
import { PROD_SITE_BASE } from '../config.js';

function generateShareCard() {
  const level = state.currentLevel;
  const time = state.elapsedTime;
  const diff = state.gameMode === 'timed'
    ? getTimedDifficulty(level)
    : getDifficultyForLevel(level);
  const mode = state.gameMode;
  const modeLabel = { normal: 'Challenge', timed: 'Timed', daily: 'Daily', weekly: 'Weekly', chaos: 'Chaos' }[mode] || 'Challenge';

  const stats = loadStats();
  const streakText = stats.currentStreak > 1 ? ` | 🔥 ${stats.currentStreak} streak` : '';
  const tier = getHighestTier(stats);
  const tierText = tier ? ` | ${tier.icon} ${tier.name}` : '';

  const levelLabel = diff.label || `Level ${level}`;

  if (mode === 'daily') {
    // Wordle-style card, built by the pure (node-tested) dailyShareLines:
    // HARD CEILING of five content lines plus the crux-challenge URL. The
    // date is the BOARD's (state.dailySeed) — the same anchor as the score
    // submission — so a finish just past midnight ET or an archive replay
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

  if (mode === 'timed') {
    const rating = getSpeedRating(level, time);
    return `${getThemeEmoji('mine')} GregSweeper · Timed ${levelLabel}\n` +
           `${rating.icon} ${rating.name} · ${time}s (${diff.rows}×${diff.cols})${tierText}\n\n` +
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
  // Must stay inside the click gesture — no await before navigator.share.
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

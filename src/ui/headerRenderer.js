import { state } from '../state/gameState.js';
import {
  $, $$, mineCounterEl, levelDisplay, checkpointDisplay,
  streakDisplayEl, cellsRemainingEl, progressBarContainer,
  progressBarFill, progressBarMarkers, bestTimeDisplay,
  maxLevelDisplay, resetBtn, streakBorder,
  flagModeBar, flagModeToggle, flagModeIcon, flagModeLabel,
} from './domHelpers.js';
import { getThemeEmoji } from './boardRenderer.js';
import { applyIcon } from './spriteLoader.js';
import { getTimedDifficulty, getSpeedRating, MAX_LEVEL } from '../logic/difficulty.js';
import { loadStats, getDailyStreak } from '../storage/statsStorage.js';
import { getGimmickDef } from '../logic/gimmicks.js';

// ── Checkpoint Display ─────────────────────────────────
export const CHECKPOINT_INTERVAL = 5;

export function getCheckpointForLevel(level) {
  return Math.floor((level - 1) / CHECKPOINT_INTERVAL) * CHECKPOINT_INTERVAL + 1;
}

export function updateCheckpointDisplay() {
  if (!checkpointDisplay) return;
  const isLevelMode = state.gameMode === 'normal';
  if (isLevelMode && state.checkpoint > 1) {
    checkpointDisplay.textContent = `🏁 CP ${state.checkpoint}`;
    checkpointDisplay.classList.remove('hidden');
  } else {
    checkpointDisplay.classList.add('hidden');
  }
}

export function updateProgressBar() {
  if (!progressBarContainer) return;
  const isLevelMode = state.gameMode === 'normal';
  if (!isLevelMode) {
    progressBarContainer.classList.add('hidden');
    return;
  }
  progressBarContainer.classList.remove('hidden');
  const pct = ((state.currentLevel - 1) / (MAX_LEVEL - 1)) * 100;
  progressBarFill.style.width = `${pct}%`;

  // Render checkpoint markers
  if (progressBarMarkers) {
    progressBarMarkers.innerHTML = '';
    for (let cp = CHECKPOINT_INTERVAL + 1; cp <= MAX_LEVEL; cp += CHECKPOINT_INTERVAL) {
      const marker = document.createElement('div');
      marker.className = 'checkpoint-marker';
      if (state.currentLevel >= cp) marker.classList.add('reached');
      marker.style.left = `${((cp - 1) / (MAX_LEVEL - 1)) * 100}%`;
      progressBarMarkers.appendChild(marker);
    }
  }
}

// Persistent reminder of which modifiers are active in this game.
// Renders icon chips into #active-gimmick-bar. Hidden when no gimmicks
// are active, when in chaos mode (chaos has its own bar), or when in
// timed mode (no gimmicks). Daily / weekly / challenge with at least
// one active gimmick all render here.
export function updateActiveGimmickBar() {
  const bar = document.getElementById('active-gimmick-bar');
  const icons = document.getElementById('active-gimmick-icons');
  if (!bar || !icons) return;
  const eligibleMode = state.gameMode === 'normal'
    || state.gameMode === 'daily'
    || state.gameMode === 'weekly';
  const list = Array.isArray(state.activeGimmicks) ? state.activeGimmicks : [];
  if (!eligibleMode || list.length === 0) {
    bar.classList.add('hidden');
    icons.innerHTML = '';
    return;
  }
  icons.innerHTML = list.map(g => {
    const def = getGimmickDef(g);
    if (!def) return '';
    const tooltip = (def.name + ': ' + (def.desc || '')).replace(/"/g, '&quot;');
    // data-gimmick drives the tap-to-explain toast below. The title
    // attr only serves desktop hover — touch devices never see it,
    // which left phone players with unexplainable icons mid-game.
    return '<span class="active-gimmick-icon" role="button" tabindex="0" data-gimmick="' + g + '" title="' + tooltip + '">' + def.icon + '</span>';
  }).join('');
  bar.classList.remove('hidden');
}

// Tap (or Enter on a focused chip) → toast the modifier's name + rule.
// Touch devices have no hover, so without this the bar's icons are
// undecipherable once the first-encounter popup has been dismissed.
// Delegated once on the container — survives every innerHTML rebuild.
function _explainGimmickChip(target) {
  const chip = target && target.closest ? target.closest('.active-gimmick-icon[data-gimmick]') : null;
  if (!chip) return;
  const def = getGimmickDef(chip.dataset.gimmick);
  if (!def) return;
  import('./toastManager.js').then(m => {
    m.showToast(`${def.icon} ${def.name}: ${def.desc || ''}`, 4500);
  });
}
const _gimmickIconsEl = document.getElementById('active-gimmick-icons');
if (_gimmickIconsEl) {
  _gimmickIconsEl.addEventListener('click', (e) => _explainGimmickChip(e.target));
  _gimmickIconsEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      _explainGimmickChip(e.target);
      e.preventDefault();
    }
  });
}

export function updateCellsRemaining() {
  if (!cellsRemainingEl) return;
  if (state.status === 'playing') {
    let lockedCount = 0;
    if (state.board) {
      for (const row of state.board) {
        for (const cell of row) {
          if (cell.isLocked && !cell.isRevealed) lockedCount++;
        }
      }
    }
    const totalSafe = state.rows * state.cols - state.totalMines - lockedCount;
    const remaining = totalSafe - state.revealedCount;
    if (remaining > 0) {
      cellsRemainingEl.textContent = `${remaining} left`;
      cellsRemainingEl.classList.remove('hidden');
    } else {
      cellsRemainingEl.classList.add('hidden');
    }
  } else {
    cellsRemainingEl.classList.add('hidden');
  }
}

export function updateStreakDisplay() {
  if (!streakDisplayEl) return;
  const stats = loadStats();
  const streak = stats.currentStreak || 0;
  if (streak >= 2) {
    streakDisplayEl.textContent = `🔥 ${streak}`;
    streakDisplayEl.classList.remove('hidden');
  } else {
    streakDisplayEl.classList.add('hidden');
  }
}

export function updateHeader() {
  // Strike cells (daily/weekly bomb-hit markers) count as flags for
  // mine accounting — the player has visually confirmed the mine
  // and the chord-reveal logic treats the strike as a flag. Without
  // subtracting strikes here the mine counter stays stuck at the
  // original count after a bomb hit, which doesn't match the
  // player's mental model ("I know where that one is").
  const dailyMode = state.gameMode === 'daily' || state.gameMode === 'weekly';
  const strikeCount = dailyMode
    ? (state.gameMode === 'weekly' ? (state.weeklyBombHits || 0) : (state.dailyBombHits || 0))
    : 0;
  const remaining = state.totalMines - state.flagCount - strikeCount;
  if (remaining < 0) {
    mineCounterEl.textContent = '-' + String(Math.abs(remaining)).padStart(2, '0');
  } else {
    mineCounterEl.textContent = String(remaining).padStart(3, '0');
  }
  updateTimerDisplayInHeader();

  // Level display
  if (state.gameMode === 'daily') {
    // Append the current streak (the one going INTO today's play) so
    // the player can see what's on the line at a glance. Suppressed at
    // streak 0/1 since "Daily · 🔥 0" reads like noise.
    const { streak } = getDailyStreak();
    levelDisplay.textContent = streak >= 2 ? `📅 Daily · 🔥 ${streak}` : '📅 Daily';
  } else if (state.gameMode === 'weekly') {
    const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const dayLbl = state.weeklyDay != null ? dayLabels[state.weeklyDay] : '';
    levelDisplay.textContent = dayLbl ? `🏁 Weekly · ${dayLbl}` : '🏁 Weekly';
  } else if (state.gameMode === 'timed') {
    const tdiff = getTimedDifficulty(state.currentLevel);
    levelDisplay.textContent = tdiff.label || `Level ${state.currentLevel}`;
  } else if (state.gameMode === 'chaos') {
    levelDisplay.textContent = '🌀 Chaos';
  } else {
    levelDisplay.textContent = `Level ${state.currentLevel}`;
  }

  updateCheckpointDisplay();
  updateProgressBar();
  updateCellsRemaining();
  updateStreakDisplay();

  // Show best time for timed/normal mode (with speed rating for timed)
  const stats = loadStats();
  if (bestTimeDisplay) {
    const bestKey = `level${state.currentLevel}`;
    const best = stats.bestTimes[bestKey];
    if (best != null && (state.gameMode === 'timed' || state.gameMode === 'normal')) {
      if (state.gameMode === 'timed') {
        const rating = getSpeedRating(state.currentLevel, best);
        bestTimeDisplay.textContent = `Best: ${best}s ${rating.icon}`;
      } else {
        bestTimeDisplay.textContent = `Best: ${best}s`;
      }
      bestTimeDisplay.classList.remove('hidden');
    } else {
      bestTimeDisplay.classList.add('hidden');
    }
  }

  // Show max level reached in normal mode
  if (maxLevelDisplay) {
    const maxLevel = stats.maxLevelReached || 1;
    if (state.gameMode === 'normal' && maxLevel > 1) {
      maxLevelDisplay.textContent = `Peak: ${maxLevel}`;
      maxLevelDisplay.classList.remove('hidden');
    } else {
      maxLevelDisplay.classList.add('hidden');
    }
  }

  const smileyKey = state.status === 'won' ? 'smileyWin'
    : state.status === 'lost' ? 'smileyLoss'
    : 'smiley';
  applyIcon(resetBtn, smileyKey, getThemeEmoji(smileyKey), { sizeClass: 'sprite-smiley' });

  // Daily/Weekly are canonical single-puzzle modes — no board reset. Keep
  // the smiley as a status face but strip its interactivity.
  resetBtn.disabled = state.gameMode === 'daily' || state.gameMode === 'weekly';
}

// ── Streak Fire Effect ─────────────────────────────────

export function updateStreakBorder() {
  if (!streakBorder) return;
  const stats = loadStats();
  const streak = stats.currentStreak || 0;
  const prevStreak = streakBorder.dataset.prevStreak ? parseInt(streakBorder.dataset.prevStreak) : 0;

  streakBorder.classList.remove('active', 'streak-1', 'streak-2', 'streak-3');

  if (streak >= 5) {
    streakBorder.classList.add('active', 'streak-3');
  } else if (streak >= 3) {
    streakBorder.classList.add('active', 'streak-2');
  } else if (streak >= 2) {
    streakBorder.classList.add('active', 'streak-1');
  }

  // Streak shake animation when streak increases
  if (streak > prevStreak && streak >= 2) {
    streakBorder.classList.remove('streak-shake');
    void streakBorder.offsetWidth;
    streakBorder.classList.add('streak-shake');
    setTimeout(() => streakBorder.classList.remove('streak-shake'), 500);
  }
  streakBorder.dataset.prevStreak = streak;
}

// ── Flag Mode Toggle ──────────────────────────────────

export function updateFlagModeBar() {
  if (!flagModeBar) return;
  // Show on all devices during gameplay. The toggle started as a
  // mobile-only affordance (touch has no right-click for flagging),
  // but desktop users without easy right-click — Chromebooks, beginners
  // who don't know about it — benefit too. Right-click-to-flag still
  // works alongside the toggle.
  if (state.status !== 'won' && state.status !== 'lost') {
    flagModeBar.classList.remove('hidden');
  } else {
    flagModeBar.classList.add('hidden');
  }
  if (flagModeToggle) {
    flagModeToggle.classList.toggle('flag-active', state.flagMode);
    flagModeToggle.setAttribute('aria-pressed', state.flagMode ? 'true' : 'false');
  }
  if (flagModeIcon) {
    flagModeIcon.textContent = state.flagMode ? '🚩' : '👆';
  }
  if (flagModeLabel) {
    // "Tap" reads wrong with a mouse; "Click" reads wrong on a phone.
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const verb = isTouchDevice ? 'Tap' : 'Click';
    flagModeLabel.textContent = state.flagMode ? `${verb} to Flag` : `${verb} to Reveal`;
  }
}

// Internal: updateHeader calls updateTimerDisplay for the timer section
// Import from timerManager would be circular, so we inline the display logic
function updateTimerDisplayInHeader() {
  const timerEl = document.getElementById('timer-display');
  if (!timerEl) return;
  const display = Math.min(Math.floor(state.elapsedTime), 999);
  timerEl.textContent = String(display).padStart(3, '0');
  timerEl.classList.remove('timer-critical', 'timer-warning');
}

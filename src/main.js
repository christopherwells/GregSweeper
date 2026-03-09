// ── GregSweeper Entry Point ────────────────────────────
// All game logic and UI rendering is in modules.
// This file handles imports, event wiring, and init.

import { state } from './state/gameState.js?v=0.9';
import { $, $$, boardEl, resetBtn, flagModeToggle, boardScrollWrapper, muteBtn } from './ui/domHelpers.js?v=0.9';
import { resizeCells, updateAllCells, getThemeEmoji, needsZoom, updateZoom, zoomIn, zoomOut } from './ui/boardRenderer.js?v=0.9';
import { updateHeader, updateStreakBorder, updateFlagModeBar, getCheckpointForLevel } from './ui/headerRenderer.js?v=0.9';
import { updatePowerUpBar } from './ui/powerUpBar.js?v=0.9';
import { showModal, hideModal, hideAllModals } from './ui/modalManager.js?v=0.9';
import { showToast, showLevelUpToast, showCheckpointToast } from './ui/toastManager.js?v=0.9';
import { showCelebration, haptic } from './ui/effectsRenderer.js?v=0.9';
import { THEME_UNLOCKS, getUnlockedThemes, updateThemeSwatches } from './ui/themeManager.js?v=0.9';
import { newGame, revealCell, toggleFlag, handleChordReveal } from './game/gameActions.js?v=0.9';
import './game/winLossHandler.js?v=0.9'; // side-effect: registers handleWin with powerUpActions
import { useRevealSafe, useShield, activateScan, activateXRay, activateMagnet } from './game/powerUpActions.js?v=0.9';
import { switchMode, updateTimedDiffVisibility, syncTimedDiffButtons } from './game/modeManager.js?v=0.9';
import { persistGameState, tryResumeGame } from './game/gamePersistence.js?v=0.9';
import { getDifficultyForLevel, getTimedDifficulty, getSpeedRating, MAX_LEVEL, MAX_TIMED_LEVEL } from './logic/difficulty.js?v=0.9';
import {
  loadStats, saveTheme, loadTheme, resetStats,
  saveCheckpoint, loadCheckpoint,
  loadDailyLeaderboard, addDailyLeaderboardEntry,
  saveModePowerUps,
  isOnboarded, setOnboarded,
} from './storage/statsStorage.js?v=0.9';
import {
  playLevelUp, isMuted, setMuted, loadMuted,
} from './audio/sounds.js?v=0.9';
import {
  getAchievementState, getTotalScore, checkNewUnlocks,
  getHighestTier, getAllTierNames, getTierIcon, getTierColor,
} from './logic/achievements.js?v=0.9';
import {
  initFirebase, isFirebaseOnline, submitOnlineScore, fetchOnlineLeaderboard,
} from './firebase/firebaseLeaderboard.js?v=0.9';

// ── Stats Display ─────────────────────────────────────

function updateStatsDisplay() {
  const stats = loadStats();
  $('#stat-played').textContent = stats.totalGames;
  const rate = stats.totalGames > 0 ? Math.round((stats.wins / stats.totalGames) * 100) : 0;
  $('#stat-win-rate').textContent = `${rate}%`;
  $('#stat-streak').textContent = stats.currentStreak;
  $('#stat-best-streak').textContent = stats.bestStreak;

  const bestKey = `level${state.currentLevel}`;
  const best = stats.bestTimes[bestKey];
  $('#stat-best-time').textContent = best != null ? `${best}s` : '--';

  const chart = $('#recent-games-chart');
  chart.innerHTML = '';
  const recent = stats.recentGames.slice(-20);

  if (recent.length === 0) {
    chart.innerHTML = '<span class="chart-empty">Play some games to see your history!</span>';
  } else {
    const winTimes = recent.filter(g => g.won).map(g => g.time);
    const maxTime = winTimes.length > 0 ? Math.max(...winTimes, 30) : 30;

    for (const game of recent) {
      const bar = document.createElement('div');
      bar.className = `game-bar ${game.won ? 'win' : 'loss'}`;
      if (game.won) {
        const pct = Math.max(15, 100 - (game.time / maxTime) * 70);
        bar.style.height = `${pct}%`;
        bar.title = `Win: ${game.time}s (Level ${game.level || '?'})`;
      } else {
        bar.style.height = '30%';
        bar.title = 'Loss';
      }
      chart.appendChild(bar);
    }
  }
}

// ── Leaderboard Display ───────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function updateLeaderboardDisplay() {
  const dateStr = new Date().toISOString().slice(0, 10);
  $('#leaderboard-date').textContent = `Date: ${dateStr}`;
  const statusBadge = $('#leaderboard-status');
  const tbody = $('#leaderboard-body');
  tbody.innerHTML = '';

  let entries = null;
  let isOnline = false;

  if (isFirebaseOnline()) {
    entries = await fetchOnlineLeaderboard(dateStr);
    if (entries !== null) isOnline = true;
  }

  if (entries === null) {
    entries = loadDailyLeaderboard(dateStr);
  }

  if (statusBadge) {
    statusBadge.textContent = isOnline ? '🌐 Online' : '📱 Local';
    statusBadge.className = `lb-status ${isOnline ? 'online' : 'offline'}`;
  }

  if (entries.length === 0) {
    $('#leaderboard-table').classList.add('hidden');
    $('#leaderboard-empty').classList.remove('hidden');
    return;
  }

  $('#leaderboard-table').classList.remove('hidden');
  $('#leaderboard-empty').classList.add('hidden');

  entries.forEach((entry, i) => {
    const tr = document.createElement('tr');
    const bombCol = entry.bombHits != null ? `<td>${entry.bombHits}</td>` : '<td>-</td>';
    tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(entry.name)}</td><td>${entry.time}s</td>${bombCol}`;
    tbody.appendChild(tr);
  });
}

// ── Achievements Display ──────────────────────────────

function updateAchievementsDisplay() {
  const grid = $('#achievements-grid');
  const progressFill = $('#achievement-progress-fill');
  const progressText = $('#achievement-progress-text');

  const stats = loadStats();
  const achievements = getAchievementState(stats);
  const { total, max } = getTotalScore(stats);

  progressFill.style.width = `${(total / max) * 100}%`;
  progressText.textContent = `${total} / ${max}`;

  grid.innerHTML = '';

  for (const ach of achievements) {
    const item = document.createElement('div');
    item.className = 'achievement-category-card';

    const tierNames = getAllTierNames();
    let tiersHtml = '<div class="tier-badges">';
    for (let i = 0; i < tierNames.length; i++) {
      const isUnlocked = i <= ach.tierIndex;
      const tierName = tierNames[i];
      const icon = getTierIcon(tierName);
      const color = getTierColor(tierName);
      tiersHtml += `<span class="tier-badge ${isUnlocked ? 'unlocked' : 'locked'}" title="${tierName}" style="${isUnlocked ? `color:${color}; text-shadow: 0 0 6px ${color}40` : ''}">${icon}</span>`;
    }
    tiersHtml += '</div>';

    let progressHtml = '';
    if (ach.nextTier) {
      progressHtml = `
        <div class="ach-progress-row">
          <div class="ach-progress-bar">
            <div class="ach-progress-fill" style="width: ${ach.progress * 100}%"></div>
          </div>
          <span class="ach-progress-label">Next: ${ach.format(ach.nextValue)}</span>
        </div>
      `;
    } else {
      progressHtml = `<div class="ach-progress-label ach-maxed">Maxed Out!</div>`;
    }

    item.innerHTML = `
      <div class="ach-header">
        <span class="ach-cat-icon">${ach.icon}</span>
        <div class="ach-cat-info">
          <div class="ach-cat-name">${ach.name}</div>
          <div class="ach-cat-desc">${ach.desc}</div>
        </div>
        <span class="ach-current-tier">${ach.currentTierIcon}</span>
      </div>
      ${tiersHtml}
      ${progressHtml}
    `;
    grid.appendChild(item);
  }
}

// ── Share Card ─────────────────────────────────────────

function generateShareCard() {
  const level = state.currentLevel;
  const time = state.elapsedTime;
  const diff = state.gameMode === 'timed'
    ? getTimedDifficulty(level)
    : getDifficultyForLevel(level);
  const mode = state.gameMode;
  const modeLabel = { normal: 'Challenge', timed: 'Timed', fogOfWar: 'Fog of War', daily: 'Daily' }[mode] || 'Challenge';

  const stats = loadStats();
  const streakText = stats.currentStreak > 1 ? ` | 🔥 ${stats.currentStreak} streak` : '';
  const tier = getHighestTier(stats);
  const tierText = tier ? ` | ${tier.icon} ${tier.name}` : '';

  let dateStr = '';
  if (mode === 'daily') {
    dateStr = ` (${new Date().toISOString().slice(0, 10)})`;
  }

  const levelLabel = diff.label || `Level ${level}`;

  if (mode === 'daily') {
    const strikesText = state.dailyBombHits > 0 ? ` | 💥 ${state.dailyBombHits} strike${state.dailyBombHits !== 1 ? 's' : ''}` : '';
    return `${getThemeEmoji('mine')} GregSweeper — Daily${dateStr}\n` +
           `⏱️ ${time}s (${state.rows}×${state.cols})${strikesText}${tierText}\n` +
           `Can you beat my time?\n\n` +
           `https://christopherwells.github.io/GregSweeper/?mode=daily`;
  }

  if (mode === 'timed') {
    const rating = getSpeedRating(level, time);
    return `${getThemeEmoji('mine')} GregSweeper — Timed ${levelLabel}\n` +
           `${rating.icon} ${rating.name} — ${time}s (${diff.rows}×${diff.cols})${tierText}\n\n` +
           `https://christopherwells.github.io/GregSweeper/`;
  }

  return `${getThemeEmoji('mine')} GregSweeper — ${modeLabel}\n` +
         `${levelLabel} (${diff.rows}x${diff.cols}) in ${time}s${streakText}${tierText}\n\n` +
         `https://christopherwells.github.io/GregSweeper/`;
}

function handleShare() {
  const text = generateShareCard();
  if (navigator.share) {
    navigator.share({ text }).catch(() => copyToClipboard(text));
  } else {
    copyToClipboard(text);
  }
}

function copyToClipboard(text) {
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
  toast.textContent = '📋 Copied to clipboard!';
  document.getElementById('app').appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

// ── Event Handlers ─────────────────────────────────────

let longPressTimer = null;
let longPressTriggered = false;
let lastTouchTime = 0;

boardEl.addEventListener('mousedown', (e) => {
  if (Date.now() - lastTouchTime < 500) return;
  const cellEl = e.target.closest('.cell');
  if (!cellEl) return;
  const row = parseInt(cellEl.dataset.row);
  const col = parseInt(cellEl.dataset.col);

  if (e.button === 0) {
    const cell = state.board[row]?.[col];
    if (cell && cell.isRevealed && cell.adjacentMines > 0) {
      handleChordReveal(row, col);
    } else {
      revealCell(row, col);
    }
  }
});

boardEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const cellEl = e.target.closest('.cell');
  if (!cellEl) return;
  const row = parseInt(cellEl.dataset.row);
  const col = parseInt(cellEl.dataset.col);
  toggleFlag(row, col);
});

// Touch support: tap to reveal, long press to flag
let touchedCellRow = null;
let touchedCellCol = null;
let touchStartX = 0;
let touchStartY = 0;
let touchedCellEl = null;

boardEl.addEventListener('touchstart', (e) => {
  const touch = e.touches[0];
  const cellEl = document.elementFromPoint(touch.clientX, touch.clientY)?.closest('.cell');
  if (!cellEl) return;
  e.preventDefault();

  longPressTriggered = false;
  touchedCellRow = parseInt(cellEl.dataset.row);
  touchedCellCol = parseInt(cellEl.dataset.col);
  touchStartX = touch.clientX;
  touchStartY = touch.clientY;
  touchedCellEl = cellEl;

  cellEl.classList.add('touch-holding');

  longPressTimer = setTimeout(() => {
    longPressTriggered = true;
    if (touchedCellEl) {
      touchedCellEl.classList.remove('touch-holding');
      touchedCellEl = null;
    }
    if (touchedCellRow != null && touchedCellCol != null) {
      toggleFlag(touchedCellRow, touchedCellCol);
      haptic([40]);
    }
  }, 300);
}, { passive: false });

boardEl.addEventListener('touchend', (e) => {
  lastTouchTime = Date.now();
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  if (touchedCellEl) { touchedCellEl.classList.remove('touch-holding'); touchedCellEl = null; }
  if (longPressTriggered) {
    longPressTriggered = false;
    touchedCellRow = null;
    touchedCellCol = null;
    e.preventDefault();
    return;
  }
  if (touchedCellRow == null || touchedCellCol == null) return;
  e.preventDefault();
  const row = touchedCellRow;
  const col = touchedCellCol;
  touchedCellRow = null;
  touchedCellCol = null;

  const cell = state.board[row]?.[col];
  if (cell && cell.isRevealed && cell.adjacentMines > 0) {
    handleChordReveal(row, col);
  } else if (state.flagMode && !cell?.isRevealed) {
    toggleFlag(row, col);
  } else {
    revealCell(row, col);
  }
});

boardEl.addEventListener('touchmove', (e) => {
  const touch = e.touches[0];
  const dx = Math.abs(touch.clientX - touchStartX);
  const dy = Math.abs(touch.clientY - touchStartY);
  if (dx > 20 || dy > 20) {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    if (touchedCellEl) { touchedCellEl.classList.remove('touch-holding'); touchedCellEl = null; }
    touchedCellRow = null;
    touchedCellCol = null;
  }
}, { passive: true });

resetBtn.addEventListener('click', () => {
  resetBtn.classList.add('smiley-pressed');
  setTimeout(() => resetBtn.classList.remove('smiley-pressed'), 150);
  state.currentLevel = 1;
  newGame();
});

// Power-up buttons
for (const btn of $$('.powerup-btn')) {
  btn.addEventListener('click', () => {
    const type = btn.dataset.powerup;
    if (type === 'revealSafe') useRevealSafe();
    else if (type === 'shield') useShield();
    else if (type === 'scanRowCol') activateScan();
    else if (type === 'magnet') activateMagnet();
    else if (type === 'xray') activateXRay();
  });
}

// Flag mode toggle
if (flagModeToggle) {
  flagModeToggle.addEventListener('click', () => {
    state.flagMode = !state.flagMode;
    updateFlagModeBar();
  });
}

// Zoom controls
$('#zoom-in').addEventListener('click', zoomIn);
$('#zoom-out').addEventListener('click', zoomOut);

// Pinch-to-zoom for touch devices
let pinchStartDist = 0;
let pinchStartZoom = 100;
boardScrollWrapper.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    pinchStartDist = Math.hypot(dx, dy);
    pinchStartZoom = state.zoomLevel;
  }
}, { passive: true });
boardScrollWrapper.addEventListener('touchmove', (e) => {
  if (e.touches.length === 2 && needsZoom()) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.hypot(dx, dy);
    const ratio = dist / pinchStartDist;
    state.zoomLevel = Math.round(Math.min(200, Math.max(50, pinchStartZoom * ratio)));
    updateZoom();
  }
}, { passive: true });

// Nav buttons
$('#btn-settings').addEventListener('click', () => {
  updateThemeSwatches();
  showModal('settings-modal');
});
$('#btn-stats').addEventListener('click', () => {
  updateStatsDisplay();
  showModal('stats-modal');
});
$('#btn-achievements').addEventListener('click', () => {
  updateAchievementsDisplay();
  showModal('achievements-modal');
});
$('#btn-leaderboard').addEventListener('click', () => {
  updateLeaderboardDisplay();
  showModal('leaderboard-modal');
});
$('#btn-help').addEventListener('click', () => showModal('help-modal'));
$('#title-bar').addEventListener('click', () => showModal('about-modal'));

// Close modals
for (const closeBtn of $$('.modal-close')) {
  closeBtn.addEventListener('click', (e) => {
    const modal = e.target.closest('.modal');
    if (modal) hideModal(modal.id);
  });
}
for (const modal of $$('.modal')) {
  modal.addEventListener('click', (e) => {
    if (e.target === modal && modal.id !== 'gameover-overlay') {
      hideModal(modal.id);
    }
  });
}

// Theme selection
for (const swatch of $$('.theme-swatch')) {
  swatch.addEventListener('click', () => {
    if (swatch.classList.contains('locked')) {
      swatch.classList.add('swatch-shake');
      setTimeout(() => swatch.classList.remove('swatch-shake'), 400);
      return;
    }
    const theme = swatch.dataset.theme;
    state.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    saveTheme(theme);
    for (const s of $$('.theme-swatch')) s.classList.remove('active');
    swatch.classList.add('active');
    if (state.status === 'won') resetBtn.textContent = getThemeEmoji('smileyWin');
    else if (state.status === 'lost') resetBtn.textContent = getThemeEmoji('smileyLoss');
    else resetBtn.textContent = getThemeEmoji('smiley');
    updateAllCells();
  });
}

// Theme collapse toggle
const toggleLockedBtn = $('#toggle-locked-themes');
if (toggleLockedBtn) {
  toggleLockedBtn.addEventListener('click', () => {
    const isExpanded = toggleLockedBtn.classList.toggle('expanded');
    for (const swatch of $$('.theme-swatch.locked')) {
      swatch.classList.toggle('locked-collapsed', !isExpanded);
    }
    toggleLockedBtn.textContent = isExpanded ? '🔓 Hide locked themes' : '';
    if (!isExpanded) {
      toggleLockedBtn.textContent = '🔒 Show ';
      const s = document.createElement('span');
      s.id = 'locked-theme-count';
      s.textContent = $$('.theme-swatch.locked').length;
      toggleLockedBtn.appendChild(s);
      toggleLockedBtn.appendChild(document.createTextNode(' locked themes'));
    }
  });
}

// Mode selection
for (const modeBtn of $$('.mode-btn')) {
  modeBtn.addEventListener('click', () => switchMode(modeBtn.dataset.mode));
}
for (const pill of $$('.mode-pill')) {
  pill.addEventListener('click', () => switchMode(pill.dataset.mode));
}

// Timed difficulty selection
for (const diffBtn of $$('.timed-diff-btn')) {
  diffBtn.addEventListener('click', () => {
    const level = parseInt(diffBtn.dataset.level, 10);
    state.currentLevel = level;
    for (const d of $$('.timed-diff-btn')) d.classList.remove('active');
    diffBtn.classList.add('active');
    newGame();
  });
}

// Reset Profile
$('#btn-reset-profile').addEventListener('click', () => {
  if (confirm('Are you sure you want to reset your profile? This will erase ALL stats, achievements, and leaderboard data. This cannot be undone.')) {
    resetStats();
    state.theme = 'classic';
    document.documentElement.setAttribute('data-theme', 'classic');
    saveTheme('classic');
    for (const s of $$('.theme-swatch')) s.classList.remove('active');
    const classicSwatch = $('.theme-swatch[data-theme="classic"]');
    if (classicSwatch) classicSwatch.classList.add('active');
    updateThemeSwatches();
    state.currentLevel = 1;
    state.powerUps = { revealSafe: 0, shield: 0, lifeline: 0, scanRowCol: 0, magnet: 0, xray: 0 };
    updatePowerUpBar();
    newGame();
    $('#settings-modal').classList.add('hidden');
  }
});

// Game over actions
$('#gameover-retry').addEventListener('click', () => {
  const postDeathBar = $('#post-death-bar');
  if (postDeathBar) postDeathBar.classList.add('hidden');
  newGame();
});

// Explore Board — dismiss modal, keep board visible for analysis
$('#gameover-explore').addEventListener('click', () => {
  hideModal('gameover-overlay');
  const postDeathBar = $('#post-death-bar');
  if (postDeathBar) postDeathBar.classList.remove('hidden');
});

// Post-death floating replay button
$('#post-death-replay').addEventListener('click', () => {
  const postDeathBar = $('#post-death-bar');
  if (postDeathBar) postDeathBar.classList.add('hidden');
  newGame();
});

$('#gameover-nextlevel').addEventListener('click', () => {
  const maxLevel = state.gameMode === 'timed' ? MAX_TIMED_LEVEL : MAX_LEVEL;
  const completedLevel = state.currentLevel;
  if (state.currentLevel < maxLevel) state.currentLevel++;

  const isLevelMode = state.gameMode === 'normal' || state.gameMode === 'fogOfWar';
  if (isLevelMode) {
    const newCheckpoint = getCheckpointForLevel(state.currentLevel);
    if (newCheckpoint > state.checkpoint) {
      state.checkpoint = newCheckpoint;
      saveCheckpoint(state.gameMode, newCheckpoint);
      showCheckpointToast(newCheckpoint);
    }
  }

  playLevelUp();
  showLevelUpToast(state.currentLevel);
  showCelebration();
  syncTimedDiffButtons();
  newGame();
});

$('#gameover-submit-daily').addEventListener('click', async () => {
  const nameInput = $('#daily-name-input');
  const name = nameInput ? nameInput.value : '';
  if (name && name.trim()) {
    const sanitized = name.trim().slice(0, 20);
    const dateStr = new Date().toISOString().slice(0, 10);
    addDailyLeaderboardEntry(dateStr, sanitized, state.elapsedTime);
    await submitOnlineScore(dateStr, sanitized, state.elapsedTime, state.dailyBombHits || 0);
    const dailySubmitForm = $('#daily-submit-form');
    if (dailySubmitForm) dailySubmitForm.classList.add('hidden');
    showToast('✅ Score submitted!');
  }
});

$('#gameover-share').addEventListener('click', () => handleShare());

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  const anyModalOpen = [...$$('.modal')].some(m => !m.classList.contains('hidden'));

  if (e.key === 'Escape') {
    const gameoverOpen = !$('#gameover-overlay').classList.contains('hidden');
    if (!gameoverOpen) {
      const visibleModals = [...$$('.modal')].filter(m => !m.classList.contains('hidden'));
      if (visibleModals.length > 0) {
        hideModal(visibleModals[visibleModals.length - 1].id);
      }
    }
    return;
  }

  if (e.key === 'r' || e.key === 'R') {
    state.currentLevel = 1;
    newGame();
    return;
  }

  if (anyModalOpen) return;

  if (e.key === '1') useRevealSafe();
  else if (e.key === '2') useShield();
  else if (e.key === '3') activateScan();
  else if (e.key === '4') activateMagnet();
  else if (e.key === '5') activateXRay();
});

// ── Mute Toggle ────────────────────────────────────────

if (muteBtn) {
  muteBtn.addEventListener('click', () => {
    const nowMuted = !isMuted();
    setMuted(nowMuted);
    muteBtn.textContent = nowMuted ? '🔇' : '🔊';
    muteBtn.title = nowMuted ? 'Unmute' : 'Mute';
  });
}

// ── Init ───────────────────────────────────────────────

function init() {
  const theme = loadTheme();
  const unlocked = getUnlockedThemes();

  let activeTheme = theme;
  if (unlocked[theme] === false) {
    const stats = loadStats();
    const maxLevel = stats.maxLevelReached || 1;
    const sortedThemes = Object.entries(THEME_UNLOCKS)
      .filter(([, info]) => maxLevel >= info.levelRequired)
      .sort((a, b) => b[1].levelRequired - a[1].levelRequired);
    activeTheme = sortedThemes.length > 0 ? sortedThemes[0][0] : 'classic';
    saveTheme(activeTheme);
  }

  state.theme = activeTheme;
  document.documentElement.setAttribute('data-theme', activeTheme);
  const activeSwatch = $(`.theme-swatch[data-theme="${activeTheme}"]`);
  if (activeSwatch) {
    for (const s of $$('.theme-swatch')) s.classList.remove('active');
    activeSwatch.classList.add('active');
  }

  const muted = loadMuted();
  if (muteBtn) {
    muteBtn.textContent = muted ? '🔇' : '🔊';
    muteBtn.title = muted ? 'Unmute' : 'Mute';
  }

  initFirebase();

  const urlParams = new URLSearchParams(window.location.search);
  const deepLinkMode = urlParams.get('mode');
  if (deepLinkMode === 'daily') {
    state.gameMode = 'daily';
  } else if (!isOnboarded()) {
    state.gameMode = 'normal';
  }

  if (!tryResumeGame()) {
    newGame();
  }

  if (!isOnboarded()) {
    setOnboarded();
    const onboarding = $('#onboarding-overlay');
    if (onboarding) showModal('onboarding-overlay');
    const startBtn = $('#onboarding-start');
    if (startBtn) {
      startBtn.addEventListener('click', () => hideModal('onboarding-overlay'));
    }
  }

  setInterval(() => persistGameState(), 5000);
}

// Recalculate cell sizes on window resize
window.addEventListener('resize', () => {
  resizeCells();
  boardEl.style.gridTemplateColumns = `repeat(${state.cols}, var(--cell-size))`;
  boardEl.style.gridTemplateRows = `repeat(${state.rows}, var(--cell-size))`;
});

init();

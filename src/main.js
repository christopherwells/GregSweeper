// ── GregSweeper Entry Point ────────────────────────────
// All game logic and UI rendering is in modules.
// This file handles imports, event wiring, and init.

import { state } from './state/gameState.js?v=0.9.1';
import { $, $$, boardEl, resetBtn, flagModeToggle, boardScrollWrapper, muteBtn } from './ui/domHelpers.js?v=0.9.1';
import { resizeCells, updateAllCells, getThemeEmoji, needsZoom, updateZoom, zoomIn, zoomOut, invalidateEmojiCache } from './ui/boardRenderer.js?v=0.9.1';
import { updateHeader, updateStreakBorder, updateFlagModeBar, getCheckpointForLevel } from './ui/headerRenderer.js?v=0.9.1';
import { updatePowerUpBar } from './ui/powerUpBar.js?v=0.9.1';
import { showModal, hideModal, hideAllModals } from './ui/modalManager.js?v=0.9.1';
import { showToast, showLevelUpToast, showCheckpointToast } from './ui/toastManager.js?v=0.9.1';
import { showCelebration, haptic } from './ui/effectsRenderer.js?v=0.9.1';
import { THEME_UNLOCKS, getUnlockedThemes, updateThemeSwatches } from './ui/themeManager.js?v=0.9.1';
import { newGame, revealCell, toggleFlag, handleChordReveal } from './game/gameActions.js?v=0.9.1';
import './game/winLossHandler.js?v=0.9.1'; // side-effect: registers handleWin with powerUpActions
import { useRevealSafe, useShield, activateScan, activateXRay, activateMagnet } from './game/powerUpActions.js?v=0.9.1';
import { switchMode } from './game/modeManager.js?v=0.9.1';
import { persistGameState, tryResumeGame } from './game/gamePersistence.js?v=0.9.1';
import { getDifficultyForLevel, getTimedDifficulty, getSpeedRating, MAX_LEVEL, MAX_TIMED_LEVEL } from './logic/difficulty.js?v=0.9.1';
import {
  loadStats, saveTheme, loadTheme, resetStats,
  saveCheckpoint, loadCheckpoint,
  loadDailyLeaderboard, addDailyLeaderboardEntry,
  saveModePowerUps,
  isOnboarded, setOnboarded,
} from './storage/statsStorage.js?v=0.9.1';
import {
  playLevelUp, isMuted, setMuted, loadMuted,
  setSFXVolume, getSFXVolume,
} from './audio/sounds.js?v=0.9.1';
import {
  getAchievementState, getTotalScore, checkNewUnlocks,
  getHighestTier, getAllTierNames, getTierIcon, getTierColor,
} from './logic/achievements.js?v=0.9.1';
import {
  initFirebase, isFirebaseOnline, submitOnlineScore, fetchOnlineLeaderboard,
  createRoom, joinRoom, leaveRoom, submitRoomScore,
  fetchRoomLeaderboard, fetchRoomHistory, getRoomMembers, getRoomInfo,
  saveRoomInfo, loadRoomInfo, clearRoomInfo,
} from './firebase/firebaseLeaderboard.js?v=0.9.1';
import {
  EMOJI_PACKS, EFFECTS, TITLES,
  loadEmojiPack, saveEmojiPack, getActiveEmojiPack, isPackUnlocked,
  isEffectUnlocked, isTitleUnlocked,
  loadEffects, saveEffects, loadTitle, saveTitle,
} from './ui/collectionManager.js?v=0.9.1';

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

// ── Room Leaderboard Display ─────────────────────────

async function updateRoomPanel() {
  const roomInfo = loadRoomInfo();
  const noRoomDiv = $('#room-no-room');
  const activeDiv = $('#room-active');

  if (!roomInfo) {
    noRoomDiv.classList.remove('hidden');
    activeDiv.classList.add('hidden');
    return;
  }

  noRoomDiv.classList.add('hidden');
  activeDiv.classList.remove('hidden');

  const info = await getRoomInfo(roomInfo.code);
  const nameDisplay = $('#room-name-display');
  const codeBadge = $('#room-code-badge');
  nameDisplay.textContent = info ? info.name : roomInfo.code;
  codeBadge.textContent = roomInfo.code;

  // Members
  const membersList = $('#room-members-list');
  const members = await getRoomMembers(roomInfo.code);
  if (members && members.length > 0) {
    membersList.innerHTML = '<span class="room-members-label">Members:</span> ' +
      members.map(m => `<span class="room-member-chip">${escapeHtml(m)}</span>`).join(' ');
  } else {
    membersList.innerHTML = '<span class="room-members-label">Members:</span> —';
  }

  // Today's scores
  const dateStr = new Date().toISOString().slice(0, 10);
  const entries = await fetchRoomLeaderboard(roomInfo.code, dateStr);
  const tbody = $('#room-leaderboard-body');
  const emptyMsg = $('#room-leaderboard-empty');
  tbody.innerHTML = '';

  if (!entries || entries.length === 0) {
    $('#room-leaderboard-table').classList.add('hidden');
    emptyMsg.classList.remove('hidden');
  } else {
    $('#room-leaderboard-table').classList.remove('hidden');
    emptyMsg.classList.add('hidden');
    entries.forEach((entry, i) => {
      const tr = document.createElement('tr');
      const bombCol = entry.bombHits != null ? `<td>${entry.bombHits}</td>` : '<td>-</td>';
      tr.innerHTML = `<td>${i + 1}</td><td>${escapeHtml(entry.name)}</td><td>${entry.time}s</td>${bombCol}`;
      tbody.appendChild(tr);
    });
  }

  // History
  const historyContent = $('#room-history-content');
  const history = await fetchRoomHistory(roomInfo.code, 7);
  if (history && Object.keys(history).length > 0) {
    let html = '';
    for (const [date, dayEntries] of Object.entries(history).sort((a, b) => b[0].localeCompare(a[0]))) {
      html += `<div class="room-history-day"><strong>${date}</strong>`;
      html += '<ol class="room-history-list">';
      dayEntries.forEach(e => {
        html += `<li>${escapeHtml(e.name)} — ${e.time}s${e.bombHits ? ' 💥' + e.bombHits : ''}</li>`;
      });
      html += '</ol></div>';
    }
    historyContent.innerHTML = html;
  } else {
    historyContent.innerHTML = '<p class="room-history-empty">No past results yet.</p>';
  }
}

// ── Collection Display ───────────────────────────────

function renderCollectionModal() {
  const stats = loadStats();
  const maxLevel = stats.maxLevelReached || 1;

  // Themes tab — clone theme swatches from THEME_UNLOCKS
  const themeGrid = $('#collection-theme-grid');
  themeGrid.innerHTML = '';
  const unlocked = getUnlockedThemes();
  const currentTheme = state.theme;

  for (const [theme, info] of Object.entries(THEME_UNLOCKS)) {
    const btn = document.createElement('button');
    btn.className = 'theme-swatch' + (theme === currentTheme ? ' active' : '') + (unlocked[theme] === false ? ' locked' : '');
    btn.dataset.theme = theme;
    const gradientMap = {
      classic: 'linear-gradient(135deg, #c0c0c0, #e0e0e0)',
      dark: 'linear-gradient(135deg, #1a1a2e, #16213e)',
    };
    btn.innerHTML = `<span class="swatch-color" style="background: var(--board-bg, #888)"></span>` +
      `<span class="swatch-name">${info.displayName}</span>` +
      (unlocked[theme] === false ? `<span class="swatch-lock">🔒 Lv.${info.levelRequired}</span>` : '');
    btn.addEventListener('click', () => {
      if (unlocked[theme] === false) {
        btn.classList.add('swatch-shake');
        setTimeout(() => btn.classList.remove('swatch-shake'), 400);
        return;
      }
      state.theme = theme;
      document.documentElement.setAttribute('data-theme', theme);
      saveTheme(theme);
      for (const s of themeGrid.querySelectorAll('.theme-swatch')) s.classList.remove('active');
      btn.classList.add('active');
      // Sync settings modal swatches
      for (const s of $$('.theme-swatch')) s.classList.remove('active');
      const settingsSwatch = $(`.theme-swatch[data-theme="${theme}"]`);
      if (settingsSwatch) settingsSwatch.classList.add('active');
      updateAllCells();
    });
    themeGrid.appendChild(btn);
  }

  // Emoji tab
  const emojiGrid = $('#emoji-pack-grid');
  emojiGrid.innerHTML = '';
  const activePack = loadEmojiPack();

  for (const [packId, pack] of Object.entries(EMOJI_PACKS)) {
    const card = document.createElement('div');
    const packUnlocked = isPackUnlocked(packId);
    card.className = 'emoji-pack-card' + (packId === activePack ? ' active' : '') + (!packUnlocked ? ' locked' : '');
    card.innerHTML = `
      <div class="emoji-pack-preview">${pack.mine} ${pack.flag} ${pack.smiley}</div>
      <div class="emoji-pack-name">${pack.name}</div>
      ${!packUnlocked ? `<div class="emoji-pack-lock">🔒 Lv.${pack.unlock.value}</div>` : ''}
    `;
    card.addEventListener('click', () => {
      if (!packUnlocked) {
        card.classList.add('swatch-shake');
        setTimeout(() => card.classList.remove('swatch-shake'), 400);
        return;
      }
      saveEmojiPack(packId);
      invalidateEmojiCache();
      for (const c of emojiGrid.querySelectorAll('.emoji-pack-card')) c.classList.remove('active');
      card.classList.add('active');
      showToast(`Emoji pack: ${pack.name}`);
    });
    emojiGrid.appendChild(card);
  }

  // Effects tab
  const effectsConfig = loadEffects();
  for (const [category, options] of Object.entries(EFFECTS)) {
    const grid = $(`#effects-${category}`);
    if (!grid) continue;
    grid.innerHTML = '';
    for (const [effectId, effect] of Object.entries(options)) {
      const effUnlocked = isEffectUnlocked(category, effectId);
      const opt = document.createElement('div');
      opt.className = 'effect-option' + (effectsConfig[category] === effectId ? ' active' : '') + (!effUnlocked ? ' locked' : '');
      opt.innerHTML = `<span class="effect-name">${effect.name}</span>` +
        (!effUnlocked ? `<span class="effect-lock">🔒 Lv.${effect.unlock.value}</span>` : '');
      opt.addEventListener('click', () => {
        if (!effUnlocked) {
          opt.classList.add('swatch-shake');
          setTimeout(() => opt.classList.remove('swatch-shake'), 400);
          return;
        }
        effectsConfig[category] = effectId;
        saveEffects(effectsConfig);
        for (const o of grid.querySelectorAll('.effect-option')) o.classList.remove('active');
        opt.classList.add('active');
      });
      grid.appendChild(opt);
    }
  }

  // Titles tab
  const titlesGrid = $('#titles-grid');
  titlesGrid.innerHTML = '';
  const activeTitle = loadTitle();
  const titleDisplay = $('#active-title-display');

  for (const [titleId, title] of Object.entries(TITLES)) {
    const titleUnlocked = isTitleUnlocked(titleId);
    const card = document.createElement('div');
    card.className = 'title-card' + (titleId === activeTitle ? ' active' : '') + (!titleUnlocked ? ' locked' : '');
    card.innerHTML = `<span class="title-name">${title.name}</span>` +
      (!titleUnlocked ? `<span class="title-lock">🔒 Lv.${title.unlock.value}</span>` : '');
    card.addEventListener('click', () => {
      if (!titleUnlocked) {
        card.classList.add('swatch-shake');
        setTimeout(() => card.classList.remove('swatch-shake'), 400);
        return;
      }
      saveTitle(titleId);
      for (const c of titlesGrid.querySelectorAll('.title-card')) c.classList.remove('active');
      card.classList.add('active');
      if (titleDisplay) titleDisplay.textContent = `Active: ${title.name}`;
    });
    titlesGrid.appendChild(card);
  }

  if (titleDisplay) {
    const t = TITLES[activeTitle];
    titleDisplay.textContent = t ? `Active: ${t.name}` : '';
  }
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
  const modeLabel = { normal: 'Challenge', timed: 'Timed', skillTrainer: 'Skill Trainer', daily: 'Daily' }[mode] || 'Challenge';

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

// Track when a modal was opened from the title screen
let _returnToTitle = false;

function closeModalAndReturn(modalId) {
  hideModal(modalId);
  if (_returnToTitle) {
    _returnToTitle = false;
    showTitleScreen();
  }
}

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
$('#btn-home').addEventListener('click', () => {
  showTitleScreen();
});
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
$('#btn-collection').addEventListener('click', () => {
  renderCollectionModal();
  showModal('collection-modal');
});
$('#btn-help').addEventListener('click', () => showModal('help-modal'));
$('#title-bar').addEventListener('click', () => showModal('about-modal'));

// Leaderboard tab switching
for (const tab of $$('.lb-tab')) {
  tab.addEventListener('click', () => {
    for (const t of $$('.lb-tab')) t.classList.remove('active');
    tab.classList.add('active');
    const isRoom = tab.dataset.tab === 'room';
    $('#lb-global-panel').classList.toggle('hidden', isRoom);
    $('#lb-room-panel').classList.toggle('hidden', !isRoom);
    if (isRoom) updateRoomPanel();
  });
}

// Room create
$('#room-create-btn').addEventListener('click', async () => {
  const name = $('#room-create-name').value.trim();
  const code = $('#room-create-code').value.trim();
  const player = $('#room-create-player').value.trim();
  if (!name || !code || !player) { showToast('Fill in all fields'); return; }
  if (!/^[A-Za-z0-9]{4,8}$/.test(code)) { showToast('Code must be 4-8 letters/numbers'); return; }
  const ok = await createRoom(code, name, player);
  if (ok) {
    saveRoomInfo(code, player);
    showToast('Room created!');
    updateRoomPanel();
  } else {
    showToast('Could not create room (code taken?)');
  }
});

// Room join
$('#room-join-btn').addEventListener('click', async () => {
  const code = $('#room-join-code').value.trim();
  const player = $('#room-join-player').value.trim();
  if (!code || !player) { showToast('Fill in all fields'); return; }
  const ok = await joinRoom(code, player);
  if (ok) {
    saveRoomInfo(code, player);
    showToast('Joined room!');
    updateRoomPanel();
  } else {
    showToast('Room not found or join failed');
  }
});

// Room leave
$('#room-leave-btn').addEventListener('click', async () => {
  const info = loadRoomInfo();
  if (info) {
    await leaveRoom(info.code, info.playerName);
    clearRoomInfo();
    showToast('Left room');
    updateRoomPanel();
  }
});

// Room code badge copy
$('#room-code-badge').addEventListener('click', () => {
  const code = $('#room-code-badge').textContent;
  navigator.clipboard.writeText(code).then(() => showToast('Room code copied!')).catch(() => {});
});

// Collection tab switching
for (const tab of $$('.collection-tab')) {
  tab.addEventListener('click', () => {
    for (const t of $$('.collection-tab')) t.classList.remove('active');
    tab.classList.add('active');
    const panels = ['themes', 'emoji', 'effects', 'titles'];
    for (const p of panels) {
      $(`#collection-${p}`).classList.toggle('hidden', p !== tab.dataset.tab);
    }
  });
}

// Close modals
for (const closeBtn of $$('.modal-close')) {
  closeBtn.addEventListener('click', (e) => {
    const modal = e.target.closest('.modal');
    if (modal) closeModalAndReturn(modal.id);
  });
}
for (const modal of $$('.modal')) {
  modal.addEventListener('click', (e) => {
    if (e.target === modal && modal.id !== 'gameover-overlay') {
      closeModalAndReturn(modal.id);
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

// Mode selection handled by title screen mode cards (see below)

// Timed size tabs (above board)
for (const tab of $$('.timed-tab')) {
  tab.addEventListener('click', () => {
    const level = parseInt(tab.dataset.level, 10);
    state.currentLevel = level;
    for (const t of $$('.timed-tab')) t.classList.remove('active');
    tab.classList.add('active');
    // Sync settings modal buttons
    for (const d of $$('.timed-diff-btn')) d.classList.toggle('active', parseInt(d.dataset.level, 10) === level);
    newGame();
  });
}

// ── Title Screen ──────────────────────────────────────

function updateTitleProgress() {
  const stats = loadStats();
  const challengeEl = $('#title-challenge-progress');
  const timedEl = $('#title-timed-progress');
  const dailyEl = $('#title-daily-progress');

  if (challengeEl) {
    const cLevel = stats.modeStats?.challenge?.maxLevelReached || 1;
    challengeEl.textContent = `Level ${cLevel} · ${Math.round(cLevel / MAX_LEVEL * 100)}%`;
  }
  if (timedEl) {
    const tWins = stats.modeStats?.timed?.wins || 0;
    timedEl.textContent = tWins > 0 ? `${tWins} wins` : 'Race the clock';
  }
  if (dailyEl) {
    const dStreak = stats.modeStats?.daily?.dailyStreak || 0;
    dailyEl.textContent = dStreak > 0 ? `${dStreak} day streak` : "Today's challenge";
  }
}

function showTitleScreen() {
  const titleScreen = $('#title-screen');
  const app = $('#app');
  if (!titleScreen || !app) return;

  updateTitleProgress();
  titleScreen.classList.remove('hidden');
  app.classList.add('hidden');
}

function hideTitleScreen() {
  const titleScreen = $('#title-screen');
  const app = $('#app');
  if (!titleScreen || !app) return;

  titleScreen.classList.add('hidden');
  app.classList.remove('hidden');
}

// Title screen mode cards
for (const card of $$('.mode-card')) {
  card.addEventListener('click', () => {
    hideTitleScreen();
    switchMode(card.dataset.mode);
  });
}

// Title screen footer buttons
// Title screen footer buttons — open modals then return to title on close
const titleSettingsBtn = $('#title-settings-btn');
if (titleSettingsBtn) {
  titleSettingsBtn.addEventListener('click', () => {
    _returnToTitle = true;
    hideTitleScreen();
    updateThemeSwatches();
    showModal('settings-modal');
  });
}
const titleStatsBtn = $('#title-stats-btn');
if (titleStatsBtn) {
  titleStatsBtn.addEventListener('click', () => {
    _returnToTitle = true;
    hideTitleScreen();
    updateStatsDisplay();
    showModal('stats-modal');
  });
}
const titleCollectionBtn = $('#title-collection-btn');
if (titleCollectionBtn) {
  titleCollectionBtn.addEventListener('click', () => {
    _returnToTitle = true;
    hideTitleScreen();
    renderCollectionModal();
    showModal('collection-modal');
  });
}

// Reset Profile
$('#btn-reset-profile').addEventListener('click', () => {
  if (confirm('Are you sure you want to reset your profile? This will erase ALL stats, achievements, and leaderboard data. This cannot be undone.')) {
    _returnToTitle = false; // Stay in game after reset
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

  const isLevelMode = state.gameMode === 'normal';
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
    // Auto-submit to room if in one
    const roomInfo = loadRoomInfo();
    if (roomInfo) {
      await submitRoomScore(roomInfo.code, dateStr, roomInfo.playerName, state.elapsedTime, state.dailyBombHits || 0);
    }
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
        closeModalAndReturn(visibleModals[visibleModals.length - 1].id);
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

// ── Audio Volume Controls ─────────────────────────────

const sfxSlider = $('#sfx-volume');
if (sfxSlider) {
  sfxSlider.value = getSFXVolume();
  sfxSlider.addEventListener('input', () => setSFXVolume(Number(sfxSlider.value)));
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

  if (!isOnboarded()) {
    // First time — show onboarding, start in challenge mode
    setOnboarded();
    state.gameMode = 'normal';
    hideTitleScreen();
    newGame();
    const onboarding = $('#onboarding-overlay');
    if (onboarding) showModal('onboarding-overlay');
    const startBtn = $('#onboarding-start');
    if (startBtn) {
      startBtn.addEventListener('click', () => hideModal('onboarding-overlay'));
    }
  } else if (deepLinkMode === 'daily') {
    // Deep link to daily mode
    state.gameMode = 'daily';
    hideTitleScreen();
    if (!tryResumeGame()) newGame();
  } else {
    // Returning user — show title screen
    showTitleScreen();
    // Pre-load the game in background so it's ready
    if (!tryResumeGame()) newGame();
  }

  // Persist game state periodically (only when actively playing)
  let _lastPersistTime = 0;
  setInterval(() => {
    if (state.status === 'playing' && state.elapsedTime !== _lastPersistTime) {
      _lastPersistTime = state.elapsedTime;
      persistGameState();
    }
  }, 10000); // Every 10s instead of 5s to reduce serialization overhead
}

// Recalculate cell sizes on window resize
window.addEventListener('resize', () => {
  resizeCells();
  boardEl.style.gridTemplateColumns = `repeat(${state.cols}, var(--cell-size))`;
  boardEl.style.gridTemplateRows = `repeat(${state.rows}, var(--cell-size))`;
});

init();

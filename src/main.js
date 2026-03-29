// ── GregSweeper Entry Point ────────────────────────────
// All game logic and UI rendering is in modules.
// This file handles imports, event wiring, and init.

// ── Local Date Utility ──────────────────────────────
// Use local dates (not UTC) so daily challenges reset at local midnight
function getLocalDateString() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

import { state } from './state/gameState.js';
import { $, $$, boardEl, resetBtn, flagModeToggle, boardScrollWrapper, muteBtn } from './ui/domHelpers.js';
import { resizeCells, updateAllCells, getThemeEmoji, needsZoom, updateZoom, zoomIn, zoomOut, invalidateEmojiCache, setFocusedCell, announceGame } from './ui/boardRenderer.js';
import { updateHeader, updateStreakBorder, updateFlagModeBar, getCheckpointForLevel, CHECKPOINT_INTERVAL } from './ui/headerRenderer.js';
import { updatePowerUpBar } from './ui/powerUpBar.js';
import { showModal, hideModal, hideAllModals } from './ui/modalManager.js';
import { showToast, showLevelUpToast, showCheckpointToast } from './ui/toastManager.js';
import { showCelebration, haptic } from './ui/effectsRenderer.js';
import { THEME_UNLOCKS, getUnlockedThemes, loadThemeCSS } from './ui/themeManager.js';
import { applyThemeEffects, clearThemeEffects } from './ui/themeEffects.js';
import { newGame, revealCell, toggleFlag, handleChordReveal } from './game/gameActions.js';
import './game/winLossHandler.js'; // side-effect: registers handleWin with powerUpActions
import { useRevealSafe, useShield, activateScan, activateXRay, activateMagnet } from './game/powerUpActions.js';
import { switchMode, isChaosUnlocked, updateModeUI } from './game/modeManager.js';
import { persistGameState, tryResumeGame } from './game/gamePersistence.js';
import { getDifficultyForLevel, getTimedDifficulty, getSpeedRating, MAX_LEVEL, MAX_TIMED_LEVEL, CHAOS_UNLOCK_LEVEL } from './logic/difficulty.js';
import {
  loadStats, saveTheme, loadTheme, resetStats,
  saveCheckpoint, loadCheckpoint,
  loadDailyLeaderboard, addDailyLeaderboardEntry,
  saveModePowerUps, loadGameState,
  isOnboarded, setOnboarded,
  isDailyCompleted,
  getDailyStreak,
  getPlayerName, setPlayerName,
  getLastSeenVersion, setLastSeenVersion,
} from './storage/statsStorage.js';

const CURRENT_VERSION = 'v1.4';
import {
  playLevelUp, isMuted, setMuted, loadMuted,
  setSFXVolume, getSFXVolume,
} from './audio/sounds.js';
import {
  getAchievementState, getTotalScore, checkNewUnlocks,
  getHighestTier, getAllTierNames, getTierIcon, getTierColor,
} from './logic/achievements.js';
import {
  initFirebase, isFirebaseOnline, submitOnlineScore, fetchOnlineLeaderboard,
  createRoom, joinRoom, leaveRoom, submitRoomScore,
  fetchRoomLeaderboard, fetchRoomHistory, getRoomMembers, getRoomInfo,
  saveRoomInfo, loadRoomInfo, clearRoomInfo,
} from './firebase/firebaseLeaderboard.js';
import {
  EMOJI_PACKS, EFFECTS, TITLES,
  loadEmojiPack, saveEmojiPack, getActiveEmojiPack, isPackUnlocked,
  isEffectUnlocked, isTitleUnlocked,
  loadEffects, saveEffects, loadTitle, saveTitle,
} from './ui/collectionManager.js';
import { isModifierPopupDisabled, setModifierPopupDisabled } from './logic/gimmicks.js';
import { isStorageFailing, safeGet, safeSet } from './storage/storageAdapter.js';
import { pauseTimer, resumeTimer } from './game/timerManager.js';
import { startTutorial } from './ui/tutorialManager.js';

// ── Theme-color meta tag (Android nav bar) ───────────
function updateThemeColor() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--color-app-bg').trim();
  if (bg) {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', bg);
  }
}

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
  const dateStr = getLocalDateString();
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
  const dateStr = getLocalDateString();
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
    const swatchColors = {
      classic: 'linear-gradient(135deg, #c0c0c0, #e0e0e0)',
      dark: 'linear-gradient(135deg, #1a1a2e, #1e2745)',
      ocean: 'linear-gradient(135deg, #1b3a4b, #1e4a5f)',
      sunset: 'linear-gradient(135deg, #2d1b2e, #3d2240)',
      forest: 'linear-gradient(135deg, #2d3a2e, #3e5a3a)',
      candy: 'linear-gradient(135deg, #fff0f5, #ffc1d3)',
      midnight: 'linear-gradient(135deg, #1a1040, #221555)',
      stealth: 'linear-gradient(135deg, #1a1a1a, #2a2a2a)',
      neon: 'linear-gradient(135deg, #0a0a0a, #1a1a1a)',
      'cherry-blossom': 'linear-gradient(135deg, #f5e6ee, #f0c4d8)',
      aurora: 'linear-gradient(135deg, #0b1628, #122040)',
      volcano: 'linear-gradient(135deg, #2a1008, #5c2210)',
      ice: 'linear-gradient(135deg, #d8eaf5, #a8ceea)',
      cyberpunk: 'linear-gradient(135deg, #0a0a1a, #1a1a3a)',
      retro: 'linear-gradient(135deg, #1a0a2e, #3a1860)',
      holographic: 'linear-gradient(135deg, #1a1a2a, #2a2a3e)',
      copper: 'linear-gradient(135deg, #1c1410, #8b5e3c)',
      sakura: 'linear-gradient(135deg, #fdf0f4, #f5c6d0)',
      galaxy: 'linear-gradient(135deg, #0a0015, #1a0838)',
      lavender: 'linear-gradient(135deg, #f0ecf8, #c8b8e0)',
      toxic: 'linear-gradient(135deg, #0a0f0a, #1a2a18)',
      autumn: 'linear-gradient(135deg, #201810, #8c5828)',
      royal: 'linear-gradient(135deg, #1e1038, #2e1a55)',
      coral: 'linear-gradient(135deg, #1c100e, #b85848)',
      emerald: 'linear-gradient(135deg, #081c14, #18603c)',
      prismatic: 'linear-gradient(135deg, #141420, #222238)',
      slate: 'linear-gradient(135deg, #1c2028, #4a5468)',
      void: 'linear-gradient(135deg, #080808, #0e0e0e)',
      arctic: 'linear-gradient(135deg, #e8f0f8, #c0d8f0)',
      deepspace: 'linear-gradient(135deg, #0a0818, #2a2050)',
      jungle: 'linear-gradient(135deg, #0c1a0c, #1e3a1e)',
      obsidian: 'linear-gradient(135deg, #000000, #111111)',
      phantom: 'linear-gradient(135deg, #101218, #2c3040)',
      matrix: 'linear-gradient(135deg, #000000, #0a1a0a)',
      solar: 'linear-gradient(135deg, #fdf8ec, #e8c850)',
      bloodmoon: 'linear-gradient(135deg, #080000, #2a0810)',
      inferno: 'linear-gradient(135deg, #0d0000, #3d1008)',
      synthwave: 'linear-gradient(135deg, #0a0020, #1a0848)',
      celestial: 'linear-gradient(135deg, #080c1a, #182040)',
      supernova: 'linear-gradient(135deg, #1a0808, #3a1810)',
      legendary: 'linear-gradient(135deg, #0e0618, #261240)',
      chaos: 'linear-gradient(135deg, #0a0a14, #1a0a2e)',
    };
    const bg = swatchColors[theme] || '#888';
    btn.innerHTML = `<span class="swatch-color" style="background: ${bg}"></span>` +
      `<span class="swatch-name">${info.displayName}</span>` +
      (unlocked[theme] === false ? `<span class="swatch-lock">🔒 Lv.${info.levelRequired}</span>` : '');
    btn.addEventListener('click', () => {
      if (unlocked[theme] === false) {
        btn.classList.add('swatch-shake');
        setTimeout(() => btn.classList.remove('swatch-shake'), 400);
        return;
      }
      state.theme = theme;
      loadThemeCSS(theme);
      document.documentElement.setAttribute('data-theme', theme);
      applyThemeEffects(theme);
      updateThemeColor();
      saveTheme(theme);
      for (const s of themeGrid.querySelectorAll('.theme-swatch')) s.classList.remove('active');
      btn.classList.add('active');
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
    dateStr = ` (${getLocalDateString()})`;
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
// Track previous theme so we can restore it when leaving chaos
let _previousTheme = null;

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

// ── Keyboard Navigation ─────────────────────────────
boardEl.addEventListener('keydown', (e) => {
  // Only handle when board is active
  if (state.status !== 'idle' && state.status !== 'playing') return;
  let r = state.focusedRow;
  let c = state.focusedCol;
  let handled = true;

  switch (e.key) {
    case 'ArrowUp':    r = Math.max(0, r - 1); break;
    case 'ArrowDown':  r = Math.min(state.rows - 1, r + 1); break;
    case 'ArrowLeft':  c = Math.max(0, c - 1); break;
    case 'ArrowRight': c = Math.min(state.cols - 1, c + 1); break;
    case 'Enter':
    case ' ': {
      // Reveal or chord
      const cell = state.board[r]?.[c];
      if (cell && cell.isRevealed && cell.adjacentMines > 0) {
        handleChordReveal(r, c);
      } else {
        revealCell(r, c);
      }
      break;
    }
    case 'f':
    case 'F':
      toggleFlag(r, c);
      break;
    default:
      handled = false;
  }

  if (handled) {
    e.preventDefault();
    if (r !== state.focusedRow || c !== state.focusedCol) {
      setFocusedCell(r, c);
    }
  }
});

resetBtn.addEventListener('click', () => {
  resetBtn.classList.add('smiley-pressed');
  setTimeout(() => resetBtn.classList.remove('smiley-pressed'), 150);
  if (state.gameMode === 'normal') {
    state.currentLevel = state.checkpoint || loadCheckpoint(state.gameMode) || 1;
  } else {
    state.currentLevel = 1;
  }
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
      // Don't close if user is typing in an input inside the modal (mobile keyboard can cause stray taps)
      const active = document.activeElement;
      if (active && modal.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
      closeModalAndReturn(modal.id);
    }
  });
}

// Mode selection handled by title screen mode cards (see below)

// Quick Play size tabs (above board)
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

// Quick Play timer toggle
const timerToggleBtn = $('#timer-toggle');
if (timerToggleBtn) {
  timerToggleBtn.addEventListener('click', () => {
    state.timerHidden = !state.timerHidden;
    timerToggleBtn.classList.toggle('timer-off', state.timerHidden);
    const timerEl = $('#timer-display');
    if (timerEl) {
      timerEl.style.visibility = state.timerHidden ? 'hidden' : 'visible';
    }
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
    challengeEl.textContent = `Level ${cLevel} · ${Math.min(100, Math.round(cLevel / MAX_LEVEL * 100))}%`;
  }
  if (timedEl) {
    const tWins = stats.modeStats?.timed?.wins || 0;
    timedEl.textContent = tWins > 0 ? `${tWins} wins` : 'Race the clock';
  }
  if (dailyEl) {
    const today = getLocalDateString();
    const dailyCard = $('.mode-card[data-mode="daily"]');
    const { streak } = getDailyStreak();
    if (isDailyCompleted(today)) {
      dailyEl.textContent = streak > 0 ? `Completed! 🔥 ${streak} day streak` : 'Completed today!';
      if (dailyCard) dailyCard.classList.add('daily-completed');
    } else {
      dailyEl.textContent = streak > 0 ? `🔥 ${streak} day streak` : "Today's challenge";
      if (dailyCard) dailyCard.classList.remove('daily-completed');
    }
  }

  // Chaos mode card
  const chaosEl = $('#title-chaos-progress');
  const chaosCard = $('.mode-card[data-mode="chaos"]');
  if (chaosCard) {
    const unlocked = isChaosUnlocked();
    if (unlocked) {
      chaosCard.classList.remove('mode-card-locked');
      chaosCard.style.display = '';
      const chaosStats = stats.modeStats?.chaos;
      const bestRun = chaosStats?.bestRun || 0;
      const totalRuns = chaosStats?.totalRuns || 0;
      if (chaosEl) {
        chaosEl.textContent = totalRuns > 0
          ? `Best: ${bestRun} board${bestRun !== 1 ? 's' : ''} · ${totalRuns} run${totalRuns !== 1 ? 's' : ''}`
          : 'Roguelike madness';
      }
    } else {
      chaosCard.style.display = 'none';
    }
  }
}

function showTitleScreen() {
  const titleScreen = $('#title-screen');
  const app = $('#app');
  if (!titleScreen || !app) return;

  // Persist current game state before showing title (guard is inside persistGameState)
  persistGameState();

  // Restore theme if leaving chaos mode
  if (state.gameMode === 'chaos' && _previousTheme) {
    document.documentElement.setAttribute('data-theme', _previousTheme);
    applyThemeEffects(_previousTheme);
    updateThemeColor();
    _previousTheme = null;
  }

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

  // Re-apply theme effects now that #board is visible
  // (applyThemeEffects silently returns if called during title screen since #board doesn't exist)
  const activeTheme = document.documentElement.getAttribute('data-theme') || 'classic';
  applyThemeEffects(activeTheme);
}

// ── Checkpoint Selector (Challenge mode) ────────────────
const GIMMICK_LABELS = {
  11: { icon: '🧱', name: 'Walls' },
  21: { icon: '🤥', name: 'Liar' },
  31: { icon: '❓', name: 'Mystery' },
  41: { icon: '🔒', name: 'Locked' },
  51: { icon: '🌀', name: 'Wormholes' },
  61: { icon: '🪞', name: 'Mirror' },
  71: { icon: '🔴', name: 'Pressure Plates' },
  81: { icon: '📡', name: 'Sonar' },
  91: { icon: '🧭', name: 'Compass' },
};

function showCheckpointSelector() {
  const stats = loadStats();
  const maxLevel = stats.modeStats?.challenge?.maxLevelReached || 1;
  // maxLevelReached is the level you WON — the next level you'd play is maxLevel + 1
  const nextPlayable = Math.min(maxLevel + 1, MAX_LEVEL);
  const savedGame = loadGameState('normal');
  const hasSavedGame = !!(savedGame && savedGame.board && savedGame.gameMode);

  const resumeEl = $('#checkpoint-resume');
  const listEl = $('#checkpoint-list');

  // Resume button (if a saved game exists)
  if (hasSavedGame) {
    resumeEl.classList.remove('hidden');
    resumeEl.innerHTML = '';
    const btn = document.createElement('button');
    btn.className = 'checkpoint-resume-btn';
    btn.innerHTML = `<span class="resume-icon">▶️</span><span class="resume-label">Resume Game<br><span class="resume-level">Level ${savedGame.currentLevel}</span></span>`;
    btn.addEventListener('click', () => {
      hideModal('checkpoint-modal');
      hideTitleScreen();
      switchMode('normal');
    });
    resumeEl.appendChild(btn);
  } else {
    resumeEl.classList.add('hidden');
  }

  // Checkpoint list
  listEl.innerHTML = '';
  const highestCheckpoint = getCheckpointForLevel(nextPlayable);

  for (let cp = 1; cp <= MAX_LEVEL; cp += CHECKPOINT_INTERVAL) {
    const unlocked = cp <= highestCheckpoint || cp === 1;
    const btn = document.createElement('button');
    btn.className = 'checkpoint-btn' + (unlocked ? '' : ' checkpoint-locked');

    // Build label
    let levelText = `Level ${cp}`;
    if (cp + CHECKPOINT_INTERVAL - 1 <= MAX_LEVEL) {
      levelText = `Level ${cp}–${Math.min(cp + CHECKPOINT_INTERVAL - 1, MAX_LEVEL)}`;
    }

    const gimmick = GIMMICK_LABELS[cp];
    let modifierHtml = '';
    if (gimmick) {
      modifierHtml = `<span class="cp-modifier"><span class="cp-modifier-icon">${gimmick.icon}</span> ${gimmick.name}</span>`;
    } else if (!unlocked) {
      modifierHtml = `<span class="cp-modifier">Reach Level ${cp}</span>`;
    }

    btn.innerHTML = `<span class="cp-level">${levelText}</span>${modifierHtml}`;

    if (unlocked) {
      btn.addEventListener('click', () => {
        hideModal('checkpoint-modal');
        hideTitleScreen();
        state.gameMode = 'normal';
        updateModeUI('normal');
        state.currentLevel = cp;
        newGame();
      });
    }

    listEl.appendChild(btn);

    // Stop after last unlocked + one row of locked (show a few locked ones as tease)
    if (!unlocked && cp > highestCheckpoint + CHECKPOINT_INTERVAL * 2) break;
  }

  showModal('checkpoint-modal');
}

// Checkpoint modal close button
const cpModal = $('#checkpoint-modal');
if (cpModal) {
  cpModal.querySelector('.modal-close')?.addEventListener('click', () => hideModal('checkpoint-modal'));
  cpModal.addEventListener('click', (e) => {
    if (e.target === cpModal) hideModal('checkpoint-modal');
  });
}

// Title screen mode cards
for (const card of $$('.mode-card')) {
  card.addEventListener('click', () => {
    const mode = card.dataset.mode;
    if (mode === 'normal') {
      showCheckpointSelector();
      return;
    }
    if (mode === 'chaos') {
      if (!isChaosUnlocked()) {
        showToast(`Reach Challenge Level ${CHAOS_UNLOCK_LEVEL} to unlock Chaos mode!`);
        return;
      }
      // Apply chaos theme automatically
      _previousTheme = state.theme;
      document.documentElement.setAttribute('data-theme', 'chaos');
      loadThemeCSS('chaos');
      applyThemeEffects('chaos');
      updateThemeColor();
      hideTitleScreen();
      switchMode('chaos');
      return;
    }
    if (mode === 'daily') {
      const today = getLocalDateString();
      if (isDailyCompleted(today)) {
        showToast("You've already completed today's daily!");
        return;
      }
    }
    hideTitleScreen();
    switchMode(mode);
  });
}

// Title screen footer buttons — open modals on top of title screen
// Settings/Stats/Collection modals live outside #app (in the HTML) so they
// render regardless of #app's visibility, with z-index above the title screen.
function showModalFromTitle(modalId) {
  _returnToTitle = true;
  showModal(modalId);
}

const titleSettingsBtn = $('#title-settings-btn');
if (titleSettingsBtn) {
  titleSettingsBtn.addEventListener('click', () => {
    // Load saved player name into settings input
    const nameInput = $('#player-name-input');
    if (nameInput) nameInput.value = getPlayerName();
    showModalFromTitle('settings-modal');
  });
}
const titleWhatsnewBtn = $('#title-whatsnew-btn');
if (titleWhatsnewBtn) {
  titleWhatsnewBtn.addEventListener('click', () => {
    setLastSeenVersion(CURRENT_VERSION);
    // Remove NEW badge if present
    const badge = titleWhatsnewBtn.querySelector('.whatsnew-badge');
    if (badge) badge.remove();
    showModalFromTitle('whatsnew-modal');
  });
  // Show NEW badge if user hasn't seen current version
  if (getLastSeenVersion() !== CURRENT_VERSION) {
    const badge = document.createElement('span');
    badge.className = 'whatsnew-badge';
    badge.textContent = 'NEW';
    titleWhatsnewBtn.appendChild(badge);
  }
}
const titleStatsBtn = $('#title-stats-btn');
if (titleStatsBtn) {
  titleStatsBtn.addEventListener('click', () => {
    updateStatsDisplay();
    showModalFromTitle('stats-modal');
  });
}
const titleCollectionBtn = $('#title-collection-btn');
if (titleCollectionBtn) {
  titleCollectionBtn.addEventListener('click', () => {
    renderCollectionModal();
    showModalFromTitle('collection-modal');
  });
}
const titleAchievementsBtn = $('#title-achievements-btn');
if (titleAchievementsBtn) {
  titleAchievementsBtn.addEventListener('click', () => {
    updateAchievementsDisplay();
    showModalFromTitle('achievements-modal');
  });
}
const titleLeaderboardBtn = $('#title-leaderboard-btn');
if (titleLeaderboardBtn) {
  titleLeaderboardBtn.addEventListener('click', () => {
    updateLeaderboardDisplay();
    showModalFromTitle('leaderboard-modal');
  });
}

// Clear Cache & Reload
$('#btn-clear-cache').addEventListener('click', () => {
  if (window.gregsweeperCacheClear) window.gregsweeperCacheClear();
});

// Reset Profile
$('#btn-reset-profile').addEventListener('click', () => {
  if (confirm('Are you sure you want to reset your profile? This will erase ALL stats, achievements, and leaderboard data. This cannot be undone.')) {
    _returnToTitle = false; // Stay in game after reset
    resetStats();
    state.theme = 'classic';
    document.documentElement.setAttribute('data-theme', 'classic');
    applyThemeEffects('classic');
    updateThemeColor();
    saveTheme('classic');
    state.currentLevel = 1;
    state.powerUps = { revealSafe: 0, shield: 0, lifeline: 0, scanRowCol: 0, magnet: 0, xray: 0 };
    updatePowerUpBar();
    newGame();
    $('#settings-modal').classList.add('hidden');
    hideTitleScreen(); // Show the game after reset
  }
});

// Game over actions
$('#gameover-retry').addEventListener('click', () => {
  const postDeathBar = $('#post-death-bar');
  if (postDeathBar) postDeathBar.classList.add('hidden');
  // Chaos mode: "Play Again" starts a fresh run
  if (state.gameMode === 'chaos') {
    state.chaosRound = 1;
    state.chaosTotalTime = 0;
    state.chaosModifiers = [];
  }
  newGame();
});

// Chaos mode: "Next Board" advances to the next round
const chaosNextBtn = $('#gameover-chaos-next');
if (chaosNextBtn) {
  chaosNextBtn.addEventListener('click', () => {
    state.chaosRound = (state.chaosRound || 1) + 1;
    newGame();
  });
}

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
    const dateStr = getLocalDateString();
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

$('#gameover-done').addEventListener('click', () => {
  hideModal('gameover-overlay');
  showTitleScreen();
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  // Don't intercept keys when user is typing in an input field
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  // Belt-and-suspenders: also check activeElement (some mobile keyboards fire events with wrong target)
  const activeTag = document.activeElement?.tagName;
  if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return;

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

  if (anyModalOpen) return;

  if (e.key === 'r' || e.key === 'R') {
    if (state.gameMode === 'normal') {
      state.currentLevel = state.checkpoint || loadCheckpoint(state.gameMode) || 1;
    } else {
      state.currentLevel = 1;
    }
    newGame();
    return;
  }

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

// ── Player Name Setting ──────────────────────────────

const playerNameInput = $('#player-name-input');
if (playerNameInput) {
  playerNameInput.value = getPlayerName();
  playerNameInput.addEventListener('input', () => {
    setPlayerName(playerNameInput.value.trim().slice(0, 20));
  });
}

// ── Audio Volume Controls ─────────────────────────────

const sfxSlider = $('#sfx-volume');
if (sfxSlider) {
  sfxSlider.value = getSFXVolume();
  sfxSlider.addEventListener('input', () => setSFXVolume(Number(sfxSlider.value)));
}

// ── Modifier Popup Toggle ─────────────────────────────

const modifierToggle = $('#modifier-popup-toggle');
if (modifierToggle) {
  modifierToggle.checked = !isModifierPopupDisabled();
  modifierToggle.addEventListener('change', () => {
    setModifierPopupDisabled(!modifierToggle.checked);
  });
}

// Colorblind mode toggle
const colorblindToggle = $('#colorblind-toggle');
const COLORBLIND_KEY = 'minesweeper_colorblind';
function applyColorblind(enabled) {
  document.documentElement.setAttribute('data-colorblind', enabled ? 'true' : 'false');
  safeSet(COLORBLIND_KEY, enabled ? '1' : '0');
}
if (colorblindToggle) {
  const cbEnabled = safeGet(COLORBLIND_KEY) === '1';
  colorblindToggle.checked = cbEnabled;
  applyColorblind(cbEnabled);
  colorblindToggle.addEventListener('change', () => applyColorblind(colorblindToggle.checked));
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
  loadThemeCSS(activeTheme);
  document.documentElement.setAttribute('data-theme', activeTheme);
  applyThemeEffects(activeTheme);
  updateThemeColor();

  const muted = loadMuted();
  if (muteBtn) {
    muteBtn.textContent = muted ? '🔇' : '🔊';
    muteBtn.title = muted ? 'Unmute' : 'Mute';
  }

  initFirebase();

  // Warn if localStorage is broken (private browsing, quota, etc.)
  if (isStorageFailing()) {
    showToast('⚠️ Playing in temporary mode — progress won\'t be saved', 5000);
  }

  const urlParams = new URLSearchParams(window.location.search);
  const deepLinkMode = urlParams.get('mode');

  if (!isOnboarded()) {
    // First time — launch interactive tutorial, then start challenge mode
    startTutorial(() => {
      state.gameMode = 'normal';
      hideTitleScreen();
      newGame();
    });
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
  }, 5000); // Every 5s for reliable mobile persistence
}

// Pause timer + persist when app loses focus; resume when visible
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (state.status === 'playing') pauseTimer();
    persistGameState(); // Always persist (guard is inside)
  } else {
    if (state.status === 'playing') {
      resumeTimer();
    }
  }
});
window.addEventListener('beforeunload', () => {
  persistGameState(); // Guard is inside persistGameState
});
// pagehide fires more reliably than beforeunload on mobile (swipe-kill)
window.addEventListener('pagehide', () => {
  persistGameState(); // Guard is inside persistGameState
});

// Recalculate cell sizes on window resize
window.addEventListener('resize', () => {
  resizeCells();
  boardEl.style.gridTemplateColumns = `repeat(${state.cols}, var(--cell-size))`;
  boardEl.style.gridTemplateRows = `repeat(${state.rows}, var(--cell-size))`;
});

init();

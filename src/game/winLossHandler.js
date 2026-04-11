import { state, ENCOURAGEMENT_LINES } from '../state/gameState.js';
import { $, $$, boardEl, resetBtn, scanToast } from '../ui/domHelpers.js';
import { getThemeEmoji, updateAllCells, announceGame } from '../ui/boardRenderer.js';
import { updateHeader, updateStreakBorder, updateCheckpointDisplay, getCheckpointForLevel } from '../ui/headerRenderer.js';
import { updatePowerUpBar } from '../ui/powerUpBar.js';
import { showModal } from '../ui/modalManager.js';
import {
  triggerHeavyShake, showRedFlash, showGreenFlash,
  haptic, chainRevealMines, showCelebration, showConfettiBurst,
} from '../ui/effectsRenderer.js';
import { showToast } from '../ui/toastManager.js';
import { stopTimer, pauseTimer, resumeTimer } from './timerManager.js';
import { awardPowerUps } from './powerUpActions.js';
import { setHandleWin } from './powerUpActions.js';
import { defuseMine } from '../logic/powerUps.js';
import { findNextSafeMove } from '../logic/boardSolver.js';
import { getSpeedRating, MAX_LEVEL, MAX_TIMED_LEVEL, getChaosDifficulty, LIFELINE_WIN_REWARD_CHANCE } from '../logic/difficulty.js';
import {
  loadStats, saveGameResult, saveModePowerUps, clearGameState,
  markDailyCompleted, getDailyStreak, getPlayerName,
} from '../storage/statsStorage.js';
import { safeSetJSON } from '../storage/storageAdapter.js';
import {
  playExplosion, playWin, playTimeRecord,
} from '../audio/sounds.js';
import {
  checkNewUnlocks, getHighestTier, getTotalScore,
  getAchievementState, getAllTierNames, getTierIcon, getTierColor,
} from '../logic/achievements.js';
import { checkThemeUnlocks, showThemeUnlockToasts } from '../ui/themeManager.js';
import { submitOnlineScore } from '../firebase/firebaseLeaderboard.js';
import { addDailyLeaderboardEntry } from '../storage/statsStorage.js';
import { getLocalDateString } from '../logic/seededRandom.js';

// ── Achievements Display (for game over) ───────────────

function showAchievementToasts(unlocks) {
  const toast = $('#achievement-toast');
  let index = 0;

  function showNext() {
    if (index >= unlocks.length) return;
    const unlock = unlocks[index];
    toast.querySelector('.achievement-toast-icon').textContent = unlock.categoryIcon;
    toast.querySelector('.achievement-toast-title').textContent = 'Achievement Unlocked!';
    toast.querySelector('.achievement-toast-name').textContent =
      `${unlock.category} — ${unlock.tier.charAt(0).toUpperCase() + unlock.tier.slice(1)} ${unlock.tierIcon}`;
    toast.classList.remove('hidden', 'hiding');

    setTimeout(() => {
      toast.classList.add('hiding');
      setTimeout(() => {
        toast.classList.add('hidden');
        toast.classList.remove('hiding');
        index++;
        if (index < unlocks.length) {
          setTimeout(showNext, 200);
        }
      }, 300);
    }, 2000);
  }

  // Delay first toast slightly to let game over show first
  setTimeout(showNext, 600);
}

// ── Share Card Preview ─────────────────────────────────

function renderShareCardPreview() {
  const preview = $('#share-card-preview');
  const grid = $('#share-card-grid');
  if (!preview || !grid) return;

  const totalCells = state.rows * state.cols;
  const mines = state.totalMines;
  const revealed = state.revealedCount;
  const unrevealed = totalCells - revealed - mines;

  const cells = [];
  for (let i = 0; i < mines; i++) cells.push('mine');
  for (let i = 0; i < revealed; i++) cells.push('safe');
  for (let i = 0; i < unrevealed; i++) cells.push('empty');

  // Shuffle (Fisher-Yates)
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }

  grid.innerHTML = '';
  grid.style.gridTemplateColumns = `repeat(${state.cols}, 10px)`;
  cells.slice(0, state.rows * state.cols).forEach(type => {
    const cell = document.createElement('div');
    cell.className = `share-card-cell ${type}`;
    grid.appendChild(cell);
  });

  preview.classList.remove('hidden');
}

// ── Handle Win ─────────────────────────────────────────

export function handleWin() {
  state.status = 'won';
  stopTimer();
  announceGame('You won! Board cleared.');
  resetBtn.textContent = getThemeEmoji('smileyWin');
  resetBtn.classList.add('smiley-win-bounce');
  setTimeout(() => resetBtn.classList.remove('smiley-win-bounce'), 800);

  const prevStats = loadStats();
  const prevMaxLevel = prevStats.maxLevelReached || 1;

  const isDaily = state.gameMode === 'daily';
  const stats = saveGameResult(true, state.elapsedTime, state.currentLevel, {
    isDaily,
    usedPowerUps: state.usedPowerUps,
    gameMode: state.gameMode,
    hadGimmicks: state.activeGimmicks && state.activeGimmicks.length > 0,
    dailySeed: state.dailySeed,
  });
  const earnedPowerUp = state.gameMode === 'chaos' ? null : awardPowerUps(stats);

  // Mark daily as completed so it cannot be replayed today
  if (isDaily && state.dailySeed) {
    markDailyCompleted(state.dailySeed);
  }

  // Persist power-ups after win (award changes them) — skip for chaos (no power-ups)
  if (state.gameMode !== 'chaos') {
    saveModePowerUps(state.gameMode, state.powerUps);
  }

  // 30% chance to earn a free lifeline on level completion (Challenge mode)
  if (state.gameMode === 'normal' && Math.random() < LIFELINE_WIN_REWARD_CHANCE) {
    state.powerUps.lifeline = (state.powerUps.lifeline || 0) + 1;
    saveModePowerUps(state.gameMode, state.powerUps);
    showToast('❤️ Lifeline earned!');
  }

  playWin();
  showCelebration();
  haptic([50, 30, 50, 30, 80]);

  // Check for newly unlocked themes
  const newThemes = checkThemeUnlocks(prevMaxLevel, stats.maxLevelReached || 1);
  if (newThemes.length > 0) {
    showThemeUnlockToasts(newThemes);
  }

  // Check for newly unlocked achievement tiers
  const newUnlocks = checkNewUnlocks(prevStats, stats);

  const gameoverTitle = $('#gameover-title');
  const gameoverTime = $('#gameover-time');
  const gameoverRecord = $('#gameover-record');
  const nextLevelBtn = $('#gameover-nextlevel');
  const powerupEarned = $('#gameover-powerup-earned');
  const shareBtn = $('#gameover-share');
  const achievementsDiv = $('#gameover-achievements');

  gameoverTitle.textContent = 'You Win!';
  // Win title bounce animation
  gameoverTitle.classList.remove('win-title-bounce');
  void gameoverTitle.offsetWidth;
  gameoverTitle.classList.add('win-title-bounce');
  setTimeout(() => gameoverTitle.classList.remove('win-title-bounce'), 700);

  const strikesInfo = state.gameMode === 'daily' && state.dailyBombHits > 0
    ? ` | 💥 ${state.dailyBombHits} strike${state.dailyBombHits !== 1 ? 's' : ''}`
    : '';

  const parEl = $('#gameover-par');
  if (parEl) parEl.classList.add('hidden');

  // Timed mode: show speed rating
  if (state.gameMode === 'timed') {
    const rating = getSpeedRating(state.currentLevel, state.elapsedTime);
    gameoverTime.textContent = `Time: ${state.elapsedTime}s — ${rating.icon} ${rating.name}!`;
  } else if (state.gameMode === 'daily') {
    // Daily: show precise time + par comparison
    const precise = state.preciseTime || state.elapsedTime;
    gameoverTime.textContent = `Time: ${precise.toFixed(1)}s${strikesInfo}`;
    const { streak } = getDailyStreak();
    if (streak > 0) {
      gameoverTime.textContent += ` | \u{1F525} ${streak} day streak`;
    }
    // Show Greg's par time
    if (parEl && state.dailyPar > 0) {
      const delta = precise - state.dailyPar;
      const absDelta = Math.abs(delta).toFixed(1);
      let parClass, deltaText;
      if (delta < -0.5) {
        parClass = 'par-under';
        deltaText = absDelta + 's under par';
      } else if (delta > 0.5) {
        parClass = 'par-over';
        deltaText = absDelta + 's over par';
      } else {
        parClass = 'par-even';
        deltaText = 'Even par!';
      }
      parEl.innerHTML = "Greg's Time: " + state.dailyPar.toFixed(1) + 's — <span class="' + parClass + '">' + deltaText + '</span>';
      parEl.classList.remove('hidden');
    }
  } else {
    gameoverTime.textContent = `Time: ${state.elapsedTime}s${strikesInfo}`;
  }

  // Stats cascade animation on time display
  gameoverTime.classList.remove('stats-cascade');
  void gameoverTime.offsetWidth;
  gameoverTime.classList.add('stats-cascade');
  gameoverTime.style.animationDelay = '0.1s';
  setTimeout(() => gameoverTime.classList.remove('stats-cascade'), 500);

  const bestKey = `level${state.currentLevel}`;
  const isNewRecord = state.gameMode !== 'chaos' && stats.bestTimes[bestKey] === state.elapsedTime;
  if (isNewRecord) {
    if (state.gameMode === 'timed') {
      const rating = getSpeedRating(state.currentLevel, state.elapsedTime);
      gameoverRecord.textContent = `🏆 New Record: ${state.elapsedTime}s ${rating.icon}`;
    } else {
      gameoverRecord.textContent = '🎉 New Record!';
    }
    gameoverRecord.classList.remove('hidden');

    // Extra celebration for timed mode records
    if (state.gameMode === 'timed') {
      playTimeRecord();
      setTimeout(() => showConfettiBurst(0.5, 0.3, 40), 200);
      setTimeout(() => showConfettiBurst(0.3, 0.5, 30), 500);
      setTimeout(() => showConfettiBurst(0.7, 0.5, 30), 800);
    }
  } else {
    gameoverRecord.classList.add('hidden');
  }

  if (earnedPowerUp) {
    powerupEarned.textContent = `Earned: ${earnedPowerUp}`;
    powerupEarned.classList.remove('hidden');
    // Animate power-up buttons with earned bounce
    setTimeout(() => {
      for (const btn of $$('.powerup-btn')) {
        const count = state.powerUps[btn.dataset.powerup] || 0;
        if (count > 0) {
          btn.classList.add('powerup-earned');
          setTimeout(() => btn.classList.remove('powerup-earned'), 600);
        }
      }
    }, 300);
  } else {
    powerupEarned.classList.add('hidden');
  }

  // Hide loss-specific elements
  const encouragementEl = $('#gameover-encouragement');
  if (encouragementEl) encouragementEl.classList.add('hidden');
  const analysisEl = $('#gameover-analysis');
  if (analysisEl) analysisEl.classList.add('hidden');
  const exploreBtn = $('#gameover-explore');
  if (exploreBtn) exploreBtn.classList.add('hidden');

  // Show visual share card (scrambled grid)
  renderShareCardPreview();

  // Show newly unlocked achievement tiers in game over
  if (newUnlocks.length > 0) {
    achievementsDiv.innerHTML = '';
    for (const unlock of newUnlocks) {
      const badge = document.createElement('div');
      badge.className = 'gameover-achievement-badge tier-up-badge';
      badge.innerHTML = `<span>${unlock.categoryIcon}</span><span>${unlock.category} ${unlock.tierIcon} ${unlock.tier.charAt(0).toUpperCase() + unlock.tier.slice(1)}</span>`;
      achievementsDiv.appendChild(badge);
    }
    achievementsDiv.classList.remove('hidden');

    // Show achievement toasts
    showAchievementToasts(newUnlocks);
  } else {
    achievementsDiv.classList.add('hidden');
  }

  // Chaos mode: show "Next Board" button, hide "Next Level"
  const chaosNextBtn = $('#gameover-chaos-next');
  const chaosRunSummary = $('#chaos-run-summary');
  if (state.gameMode === 'chaos') {
    nextLevelBtn.classList.add('hidden');
    if (chaosNextBtn) chaosNextBtn.classList.remove('hidden');
    if (chaosRunSummary) chaosRunSummary.classList.add('hidden');
    // Update chaos state for next round
    state.chaosTotalTime = (state.chaosTotalTime || 0) + state.elapsedTime;
    gameoverTitle.textContent = 'Board Cleared!';
    gameoverTime.textContent = 'Round ' + (state.chaosRound || 1) + ' · ' + state.elapsedTime + 's';
  } else {
    if (chaosNextBtn) chaosNextBtn.classList.add('hidden');
    if (chaosRunSummary) chaosRunSummary.classList.add('hidden');
    const maxLevel = state.gameMode === 'timed' ? MAX_TIMED_LEVEL : MAX_LEVEL;
    if (state.currentLevel < maxLevel && state.gameMode !== 'daily' && state.gameMode !== 'timed') {
      nextLevelBtn.classList.remove('hidden');
    } else {
      nextLevelBtn.classList.add('hidden');
    }
  }

  const dailySubmitForm = $('#daily-submit-form');
  if (isDaily && dailySubmitForm) {
    const savedName = getPlayerName();
    if (savedName) {
      // Auto-submit with saved name
      dailySubmitForm.classList.add('hidden');
      const dateStr = getLocalDateString();
      const scoreTime = Math.round((state.preciseTime || state.elapsedTime) * 10) / 10;
      addDailyLeaderboardEntry(dateStr, savedName, scoreTime);
      submitOnlineScore(dateStr, savedName, scoreTime, state.dailyBombHits || 0);
      showToast('✅ Score submitted!');
    } else {
      dailySubmitForm.classList.remove('hidden');
      const nameInput = $('#daily-name-input');
      if (nameInput) nameInput.value = '';
    }
  } else if (dailySubmitForm) {
    dailySubmitForm.classList.add('hidden');
  }

  // Always show share button on win
  shareBtn.classList.remove('hidden');

  // Hide "Play Again" for daily mode (can't replay today's daily)
  const retryBtn = $('#gameover-retry');
  if (retryBtn) {
    if (isDaily) retryBtn.classList.add('hidden');
    else retryBtn.classList.remove('hidden');
  }

  // Show "Done" button for daily mode (no next level or retry available)
  const doneBtn = $('#gameover-done');
  if (doneBtn) {
    if (isDaily) doneBtn.classList.remove('hidden');
    else doneBtn.classList.add('hidden');
  }

  // Clear saved game state on win
  clearGameState(state.gameMode);

  showModal('gameover-overlay');
  updatePowerUpBar();
  updateStreakBorder();
}

// Register handleWin with powerUpActions to break circular dependency
setHandleWin(handleWin);

// ── Handle Loss ────────────────────────────────────────

export function handleLoss(mineRow, mineCol) {
  state.status = 'lost';
  stopTimer();
  announceGame('Game over. Hit a mine.');
  resetBtn.textContent = getThemeEmoji('smileyLoss');
  resetBtn.classList.add('smiley-loss-shake');
  setTimeout(() => resetBtn.classList.remove('smiley-loss-shake'), 500);

  state.hitMine = { row: mineRow, col: mineCol };

  // Post-death analysis: mark wrong flags and find suggested safe move
  let wrongFlagCount = 0;
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      const cell = state.board[r][c];
      if (cell.isFlagged && !cell.isMine) {
        cell.wrongFlag = true;
        wrongFlagCount++;
      }
      if (cell.isFlagged && cell.isMine) {
        cell.correctFlag = true;
      }
    }
  }

  // Find what the solver says was the correct next move
  const suggestedMove = findNextSafeMove(state.board);
  state.suggestedMove = suggestedMove;
  if (suggestedMove) {
    const cell = state.board[suggestedMove.row]?.[suggestedMove.col];
    if (cell) cell.suggestedMove = true;
  }

  // Chain explosion: reveal mines in expanding rings from the hit
  chainRevealMines(mineRow, mineCol);

  playExplosion();
  triggerHeavyShake();
  showRedFlash();
  haptic([100, 40, 100, 40, 200]);
  saveGameResult(false, state.elapsedTime, state.currentLevel, { gameMode: state.gameMode });

  // Power-ups persist on loss within same mode
  saveModePowerUps(state.gameMode, state.powerUps);

  // Death penalty: checkpoint-aware
  const lostLevel = state.currentLevel;
  const isLevelMode = state.gameMode === 'normal';

  // Reset to the checkpoint for the CURRENT level range (not the highest-ever checkpoint)
  if (isLevelMode && state.currentLevel > 1) {
    state.currentLevel = getCheckpointForLevel(state.currentLevel);
  }

  const gameoverTitle = $('#gameover-title');
  const gameoverTime = $('#gameover-time');
  const encouragementEl = $('#gameover-encouragement');

  gameoverTitle.textContent = 'Game Over';
  gameoverTitle.classList.remove('win-title-bounce');
  void gameoverTitle.offsetWidth;
  gameoverTitle.classList.add('win-title-bounce');
  setTimeout(() => gameoverTitle.classList.remove('win-title-bounce'), 700);

  if (state.gameMode === 'chaos') {
    const boardsCleared = (state.chaosRound || 1) - 1;
    const totalTime = (state.chaosTotalTime || 0) + state.elapsedTime;
    gameoverTitle.textContent = 'Run Over!';
    gameoverTime.textContent = boardsCleared > 0
      ? 'Cleared ' + boardsCleared + ' board' + (boardsCleared !== 1 ? 's' : '') + ' · ' + totalTime + 's total'
      : 'Wiped out on Round 1 · ' + state.elapsedTime + 's';

    // Save chaos stats
    const chaosStatsObj = loadStats();
    const chaosStats = chaosStatsObj.modeStats?.chaos;
    if (chaosStats) {
      chaosStats.totalRuns = (chaosStats.totalRuns || 0) + 1;
      if (boardsCleared > (chaosStats.bestRun || 0)) {
        chaosStats.bestRun = boardsCleared;
      }
      // Persist updated chaos stats
      safeSetJSON('minesweeper_stats', chaosStatsObj);
    }

    // Show chaos run summary
    const chaosRunSummary = $('#chaos-run-summary');
    if (chaosRunSummary) {
      chaosRunSummary.classList.remove('hidden');
      const boardsClearedEl = $('#chaos-boards-cleared');
      const totalTimeEl = $('#chaos-total-time');
      const bestRunEl = $('#chaos-best-run');
      if (boardsClearedEl) boardsClearedEl.textContent = boardsCleared;
      if (totalTimeEl) totalTimeEl.textContent = totalTime + 's';
      if (bestRunEl) bestRunEl.textContent = chaosStats?.bestRun || boardsCleared;
    }
  } else if (lostLevel > state.currentLevel && isLevelMode) {
    gameoverTime.textContent = 'Time: ' + state.elapsedTime + 's · Back to Level ' + state.currentLevel;
  } else {
    gameoverTime.textContent = 'Time: ' + state.elapsedTime + 's';
  }

  // Show encouragement line
  if (encouragementEl) {
    const line = ENCOURAGEMENT_LINES[Math.floor(Math.random() * ENCOURAGEMENT_LINES.length)];
    encouragementEl.textContent = line;
    encouragementEl.classList.remove('hidden');
  }

  // Stats cascade on loss
  gameoverTime.classList.remove('stats-cascade');
  void gameoverTime.offsetWidth;
  gameoverTime.classList.add('stats-cascade');
  gameoverTime.style.animationDelay = '0.1s';
  setTimeout(() => gameoverTime.classList.remove('stats-cascade'), 500);
  $('#gameover-record').classList.add('hidden');
  $('#gameover-nextlevel').classList.add('hidden');
  const chaosNextBtn = $('#gameover-chaos-next');
  if (chaosNextBtn) chaosNextBtn.classList.add('hidden');
  if (state.gameMode !== 'chaos') {
    const chaosRunSummary = $('#chaos-run-summary');
    if (chaosRunSummary) chaosRunSummary.classList.add('hidden');
  }
  const dailySubmitForm = $('#daily-submit-form');
  if (dailySubmitForm) dailySubmitForm.classList.add('hidden');
  $('#gameover-powerup-earned').classList.add('hidden');
  $('#gameover-share').classList.add('hidden');
  const doneBtnLoss = $('#gameover-done');
  if (doneBtnLoss) doneBtnLoss.classList.add('hidden');
  $('#gameover-achievements').classList.add('hidden');
  const sharePreview = $('#share-card-preview');
  if (sharePreview) sharePreview.classList.add('hidden');

  // Show post-death analysis info
  const analysisEl = $('#gameover-analysis');
  const analysisText = $('#gameover-analysis-text');
  if (analysisEl && analysisText) {
    if (wrongFlagCount > 0 && suggestedMove) {
      analysisText.textContent = `${wrongFlagCount} wrong flag${wrongFlagCount > 1 ? 's' : ''} · Safe move available`;
    } else if (wrongFlagCount > 0) {
      analysisText.textContent = `${wrongFlagCount} wrong flag${wrongFlagCount > 1 ? 's' : ''} · It was a 50/50`;
    } else if (suggestedMove) {
      analysisText.textContent = 'A safe move was available';
    } else {
      analysisText.textContent = 'It was a genuine 50/50';
    }
    analysisEl.classList.remove('hidden');
  }

  // Show explore button on loss
  const exploreBtn = $('#gameover-explore');
  if (exploreBtn) exploreBtn.classList.remove('hidden');

  // Ensure "Play Again" is visible on loss
  const lossRetryBtn = $('#gameover-retry');
  if (lossRetryBtn) lossRetryBtn.classList.remove('hidden');

  // Clear saved game state on loss
  clearGameState(state.gameMode);

  setTimeout(() => showModal('gameover-overlay'), 900);
  updatePowerUpBar();
  updateStreakBorder();
  updateCheckpointDisplay();
}

// ── Handle Timed Loss ──────────────────────────────────

export function handleTimedLoss() {
  state.status = 'lost';
  stopTimer();
  resetBtn.textContent = getThemeEmoji('smileyLoss');
  resetBtn.classList.add('smiley-loss-shake');
  setTimeout(() => resetBtn.classList.remove('smiley-loss-shake'), 500);
  playExplosion();
  triggerHeavyShake();
  showRedFlash();
  haptic([100, 40, 100, 40, 200]);
  saveGameResult(false, state.elapsedTime, state.currentLevel, { gameMode: state.gameMode });
  saveModePowerUps(state.gameMode, state.powerUps);

  // Death penalty: reset to the checkpoint for the CURRENT level range
  const lostLevel = state.currentLevel;
  if (state.gameMode === 'normal' && state.currentLevel > 1) {
    state.currentLevel = getCheckpointForLevel(state.currentLevel);
  }

  const gameoverTitle = $('#gameover-title');
  const gameoverTime = $('#gameover-time');
  gameoverTitle.textContent = 'Time\'s Up!';
  if (lostLevel > state.currentLevel && state.gameMode === 'normal') {
    gameoverTime.textContent = `You ran out of time! Back to Level ${state.currentLevel}`;
  } else {
    gameoverTime.textContent = `You ran out of time!`;
  }
  $('#gameover-record').classList.add('hidden');
  $('#gameover-nextlevel').classList.add('hidden');
  const chaosNextBtn = $('#gameover-chaos-next');
  if (chaosNextBtn) chaosNextBtn.classList.add('hidden');
  if (state.gameMode !== 'chaos') {
    const chaosRunSummary = $('#chaos-run-summary');
    if (chaosRunSummary) chaosRunSummary.classList.add('hidden');
  }
  const dailySubmitForm2 = $('#daily-submit-form');
  if (dailySubmitForm2) dailySubmitForm2.classList.add('hidden');
  $('#gameover-powerup-earned').classList.add('hidden');
  $('#gameover-share').classList.add('hidden');
  const doneBtnLoss = $('#gameover-done');
  if (doneBtnLoss) doneBtnLoss.classList.add('hidden');
  $('#gameover-achievements').classList.add('hidden');
  const sharePreview2 = $('#share-card-preview');
  if (sharePreview2) sharePreview2.classList.add('hidden');

  // Encouragement line
  const encouragement2 = $('#gameover-encouragement');
  if (encouragement2) {
    encouragement2.textContent = ENCOURAGEMENT_LINES[Math.floor(Math.random() * ENCOURAGEMENT_LINES.length)];
    encouragement2.classList.remove('hidden');
  }

  // Clear saved game state
  clearGameState(state.gameMode);

  setTimeout(() => showModal('gameover-overlay'), 400);
  updatePowerUpBar();
  updateStreakBorder();
}

// ── Daily Mode: Bomb Hit Re-Fog ─────────────────────────

export function handleDailyBombHit(mineRow, mineCol) {
  state.dailyBombHits++;

  // Time penalty: +10s per strike
  state.elapsedTime += 10;

  // Defuse the hit mine so it won't kill again
  defuseMine(state.board, mineRow, mineCol);
  state.board[mineRow][mineCol].isRevealed = true;
  state.totalMines--;

  // Re-fog ALL non-mine revealed cells
  let refogCount = 0;
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      const cell = state.board[r][c];
      if (cell.isRevealed && !cell.isMine && !(r === mineRow && c === mineCol)) {
        cell.isRevealed = false;
        cell.isHiddenNumber = false;
        refogCount++;
      }
    }
  }
  state.revealedCount = 1; // only the defused mine cell remains revealed

  // Shake + muffled explosion effect
  playExplosion();
  triggerHeavyShake();
  showRedFlash();
  haptic([80, 30, 60]);

  // Pause timer during popup so display time doesn't add to penalty
  pauseTimer();

  // Show centered popup for 1.5s
  const popup = document.createElement('div');
  popup.className = 'daily-bomb-popup';
  const strikes = state.dailyBombHits;
  popup.innerHTML = `<div class="daily-bomb-popup-content">💥 You hit a mine!<br><span class="daily-bomb-sub">+10s penalty · Board reset · Mine removed</span></div>`;
  document.getElementById('app').appendChild(popup);

  setTimeout(() => {
    popup.remove();
    state.elapsedTime = Math.floor(state.elapsedTime);
    resumeTimer();
    updateAllCells();
    updateHeader();
  }, 2000);
}

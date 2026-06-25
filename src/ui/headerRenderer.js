import { state } from '../state/gameState.js';
import {
  $, $$, mineCounterEl, levelDisplay, checkpointDisplay,
  streakDisplayEl, cellsRemainingEl, progressBarContainer,
  progressBarFill, progressBarMarkers, bestTimeDisplay,
  maxLevelDisplay, resetBtn, streakBorder,
  flagModeToggle, flagModeIcon,
} from './domHelpers.js';
import { getThemeEmoji } from './boardRenderer.js';
import { applyIcon, gimmickSpriteImgHTML, spriteImgHTML, uiSpriteImgHTML } from './spriteLoader.js';
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
    checkpointDisplay.innerHTML = `${uiSpriteImgHTML('uiFlagChecked', 'lcd-icon')} CP ${state.checkpoint}`;
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
// are active or in chaos mode (chaos has its own bar) — the Certified
// chip lives in #game-info-bar precisely so gimmick-free boards never
// pay a row for it. The chip is toggled here because every call site
// that settles gimmicks (newGame, first-click generation, resume) is
// also where the certificate is settled.
export function updateActiveGimmickBar() {
  const bar = document.getElementById('active-gimmick-bar');
  const icons = document.getElementById('active-gimmick-icons');
  if (!bar || !icons) return;
  const chip = document.getElementById('cert-chip');
  if (chip) chip.classList.toggle('hidden', !state.boardCertificate);
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
    const iconHtml = gimmickSpriteImgHTML(g, 'sprite-gimmick', def.name) || def.icon;
    return '<span class="active-gimmick-icon" role="button" tabindex="0" data-gimmick="' + g + '" title="' + tooltip + '">' + iconHtml + '</span>';
  }).join('');
  bar.classList.remove('hidden');
}

// ── Certificate modal ─────────────────────────────────
// Opened from the ✓ Certified chip (and the Chaos "No guarantees"
// chip). One plain-language paragraph plus the board facts the solver
// actually proved — the copy can never outrun the certificate.
const CERT_TIER_LINES = {
  low: 'Counting the clues is enough to walk the whole chain.',
  enumerate: 'Some steps take case-by-case thinking: trying the possibilities until only one survives.',
  liar: 'Some steps take liar reasoning: weighing both values a lying number could mean.',
};

export function showCertificateModal() {
  const body = document.getElementById('cert-modal-body');
  const title = document.getElementById('cert-modal-title');
  if (!body || !title) return;
  const cert = state.boardCertificate;
  if (state.gameMode === 'chaos' || !cert) {
    title.textContent = 'No guarantees here';
    body.innerHTML = '<p>Chaos boards are the one exception to the no-guess rule: '
      + 'they are not checked by the solver, 50/50s can happen, and mines can move.</p>'
      + '<p>Every other mode keeps the guarantee.</p>';
  } else {
    const deductions = Math.max(0, (cert.clicks || 1) - 1);
    const fromWhere = (state.gameMode === 'daily' || state.gameMode === 'weekly')
      ? 'from the marked start square'
      : 'from your first click';
    const tierLine = cert.tier >= 3 ? CERT_TIER_LINES.liar
      : cert.tier === 2 ? CERT_TIER_LINES.enumerate
      : CERT_TIER_LINES.low;
    const chainLine = deductions === 0
      ? 'the opening reveal clears the whole board on its own'
      : deductions === 1
        ? 'a single provable move finishes the board'
        : 'a chain of <strong>' + deductions + ' provable moves</strong> clears the whole board';
    title.textContent = 'This board is checked';
    let html = '<p>The solver played this board to the end before you saw it. '
      + 'Starting ' + fromWhere + ', ' + chainLine + '. No step needs a guess.</p>'
      + '<p>' + tierLine + '</p>';
    if (state.gameMode === 'daily' || state.gameMode === 'weekly') {
      html += '<p class="cert-recheck">Checked when the board was generated, and checked again when your device loaded it.</p>';
    }
    body.innerHTML = html;
  }
  import('./modalManager.js').then(m => m.showModal('cert-modal'));
}

// Both chips are static elements, so bind once at module load (same
// pattern as the gimmick-icons delegation below).
for (const chipId of ['cert-chip', 'chaos-no-cert-chip']) {
  const el = document.getElementById(chipId);
  if (el) el.addEventListener('click', showCertificateModal);
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
    streakDisplayEl.innerHTML = `${uiSpriteImgHTML('achStreak', 'lcd-icon')} ${streak}`;
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
    const calIcon = uiSpriteImgHTML('uiDaily', 'lcd-icon');
    levelDisplay.innerHTML = streak >= 2
      ? `${calIcon} Daily · ${uiSpriteImgHTML('achStreak', 'lcd-icon')} ${streak}`
      : `${calIcon} Daily`;
  } else if (state.gameMode === 'weekly') {
    const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const dayLbl = state.weeklyDay != null ? dayLabels[state.weeklyDay] : '';
    const flagIcon = uiSpriteImgHTML('uiFlagChecked', 'lcd-icon');
    levelDisplay.innerHTML = dayLbl ? `${flagIcon} Weekly · ${dayLbl}` : `${flagIcon} Weekly`;
  } else if (state.gameMode === 'timed') {
    const tdiff = getTimedDifficulty(state.currentLevel);
    levelDisplay.textContent = tdiff.label || `Level ${state.currentLevel}`;
  } else if (state.gameMode === 'chaos') {
    levelDisplay.innerHTML = `${uiSpriteImgHTML('uiChaos', 'lcd-icon')} Chaos`;
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

// ── Flag Mode Toggle + Lens (header icon buttons) ─────
// The toggle and the Stuck? button flank the smiley in the LCD row —
// the dedicated flag-mode-bar row was removed to give phones the
// vertical space. Same visibility semantics the bar had: shown on all
// devices during gameplay (touch has no right-click for flagging, and
// desktop beginners benefit too; right-click still works alongside),
// hidden on win/loss so the header reflows to the classic three.
export function updateFlagModeBar() {
  const over = state.status === 'won' || state.status === 'lost';
  if (flagModeToggle) {
    flagModeToggle.classList.toggle('hidden', over);
    flagModeToggle.classList.toggle('flag-active', state.flagMode);
    flagModeToggle.setAttribute('aria-pressed', state.flagMode ? 'true' : 'false');
    // Icon-only button, so the state lives in the label. "Tap" reads
    // wrong with a mouse; "Click" reads wrong on a phone.
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    const verb = isTouchDevice ? 'Taps' : 'Clicks';
    const label = state.flagMode
      ? `Flag mode on: ${verb.toLowerCase()} place flags`
      : `Flag mode off: ${verb.toLowerCase()} reveal`;
    flagModeToggle.setAttribute('aria-label', label);
    flagModeToggle.title = label;
  }
  if (flagModeIcon) {
    flagModeIcon.innerHTML = state.flagMode
      ? spriteImgHTML('flag', 'ui-icon', 'Flag')
      : uiSpriteImgHTML('uiCursor', 'ui-icon', 'Reveal');
  }
  const stuckBtn = document.getElementById('stuck-btn');
  if (stuckBtn) stuckBtn.classList.toggle('hidden', over);
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

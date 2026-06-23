import { state, ENCOURAGEMENT_LINES, getActiveBombPenaltyTotal } from '../state/gameState.js';
import { $, $$, boardEl, resetBtn, scanToast, escapeHtml } from '../ui/domHelpers.js';
import { getThemeEmoji, updateAllCells, announceGame } from '../ui/boardRenderer.js';
import { applyIcon, spriteImgHTML, medalImgForEmoji, achievementSpriteImgHTML } from '../ui/spriteLoader.js';
import { updateHeader, updateStreakBorder, updateCheckpointDisplay, getCheckpointForLevel } from '../ui/headerRenderer.js';
import { updatePowerUpBar } from '../ui/powerUpBar.js';
import { showModal, hideModal } from '../ui/modalManager.js';
import {
  triggerHeavyShake, showRedFlash, showGreenFlash,
  haptic, chainRevealMines, showVictoryCelebration, showConfettiBurst,
} from '../ui/effectsRenderer.js';
import { showToast } from '../ui/toastManager.js';
import { stopTimer, pauseTimer, resumeTimer, updateTimerDisplay } from './timerManager.js';
import { awardPowerUps } from './powerUpActions.js';
import { setHandleWin } from './powerUpActions.js';
import { findNextSafeMove, gradeGimmickContribution } from '../logic/boardSolver.js';
import { extractCrux } from '../logic/cruxExtract.js';
import { prepareLossReceipt, bombStrikeVerdict } from '../ui/receiptRenderer.js';
import { computeBombInfoValue } from '../logic/bombInfoValue.js';
import { getSpeedRating, MAX_LEVEL, MAX_TIMED_LEVEL, getChaosDifficulty, LIFELINE_WIN_REWARD_CHANCE, BOMB_PENALTY_BASE, BOMB_PENALTY_RAMP } from '../logic/difficulty.js';
import {
  loadStats, saveGameResult, saveModePowerUps, clearGameState,
  markDailyCompleted, getDailyStreak, getPlayerName,
  hasSeenNotice, markNoticeSeen, consumeMoltEvent, flagMoltCelebrate,
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
import { submitOnlineScore, submitArchiveScore, submitTimedScore, submitWeeklyScore, fetchWeeklyLeaderboard } from '../firebase/firebaseLeaderboard.js';

// (HTML escaping for the weekly leaderboard rows now comes from
// ui/domHelpers.js's escapeHtml — single source of truth.)
import { saveProgress, saveDailyHistoryEntry, fetchDailyHistoryEntry, getUid, markWeeklyDayAttempted } from '../firebase/firebaseProgress.js';
import { archiveSubmitPlan, CRUX_VIEWED_KEY_PREFIX } from '../logic/archiveEligibility.js';
import { isTestEnvironment } from '../firebase/env.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';
import { breakdownPar } from '../logic/dailyFeatures.js';
import { getHandicap, getHandicapDetails } from '../logic/handicaps.js';
import { resolveParDisplay } from '../logic/parDisplayDecision.js';
import { buildDailyScoreExtras } from '../logic/winSubmissionPlan.js';
import { detectSkillFeats } from '../logic/skillFeatDetection.js';
import { labFileLine } from '../logic/gregVoice.js';
import { addDailyLeaderboardEntry, appendDailyResidual, loadDailyResiduals, loadPowerUps } from '../storage/statsStorage.js';
import { getLocalDateString } from '../logic/seededRandom.js';

// Weekly's first-attempt-of-the-week play is supposed to feed the
// par-model fit pool (honest first encounter, no memorisation
// advantage). Disabled while the weekly mode is still being shaken
// down — we don't want test plays with shifting rules to drag the
// model coefficients. Flip to true when the rules are stable.
const WEEKLY_FIT_DATA_ENABLED = false;

// Friendly phrase for the molt-day covered note: a covered gap is always 1 or
// 2 days (the bank cap), and always within the last few days, so the weekday
// name reads naturally ("covered Tuesday", "covered Monday and Tuesday").
function _coveredPhrase(dates) {
  const names = (dates || []).map(d =>
    new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' }));
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.length} days`;
}

// ── Achievements Display (for game over) ───────────────

function showAchievementToasts(unlocks) {
  const toast = $('#achievement-toast');
  let index = 0;

  function showNext() {
    if (index >= unlocks.length) return;
    const unlock = unlocks[index];
    const toastIcon = toast.querySelector('.achievement-toast-icon');
    const toastIconHtml = achievementSpriteImgHTML(unlock.categoryId, 'sprite-rank', unlock.category);
    if (toastIconHtml) toastIcon.innerHTML = toastIconHtml;
    else toastIcon.textContent = unlock.categoryIcon;
    toast.querySelector('.achievement-toast-title').textContent = 'Achievement Unlocked!';
    toast.querySelector('.achievement-toast-name').textContent =
      `${unlock.category} · ${unlock.tier.charAt(0).toUpperCase() + unlock.tier.slice(1)} ${unlock.tierIcon}`;
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

// Render the compact 7-dot daily-history strip on the win modal.
// Reads localStorage residuals (already includes today's just-appended
// play). One dot per of the last 7 ET dates; days the player missed
// render as faint outlines, days they played render in green/gray/red
// based on (time - par) sign. Today's dot is enlarged + accent-ringed.
function _renderWinModalHistoryDots(todayDate) {
  const el = document.getElementById('gameover-history-dots');
  if (!el) return;
  const residuals = loadDailyResiduals();
  if (residuals.length === 0) {
    el.classList.add('hidden');
    return;
  }
  // Build a date → entry index for fast lookup.
  const byDate = new Map();
  for (const r of residuals) byDate.set(r.date, r);
  // Walk the last 7 ET dates ending at today (or the play's date if it
  // differs from today — e.g., a late-night submit just after midnight).
  const dots = [];
  const baseDate = todayDate || new Date().toISOString().slice(0, 10);
  const [by, bm, bd] = baseDate.split('-').map(Number);
  const baseUtc = Date.UTC(by, bm - 1, bd);
  for (let i = 6; i >= 0; i--) {
    const ts = baseUtc - i * 24 * 3600 * 1000;
    const d = new Date(ts);
    const ds = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const entry = byDate.get(ds);
    let cls = 'missed';
    if (entry) {
      const delta = entry.time - entry.par;
      if (delta < -0.5) cls = 'under';
      else if (delta > 0.5) cls = 'over';
      else cls = 'even';
    }
    const isToday = ds === baseDate;
    dots.push(`<div class="gameover-history-dot ${cls}${isToday ? ' today' : ''}" title="${ds}${entry ? ` · ${entry.time}s (par ${entry.par.toFixed(1)})` : ' · no play'}"></div>`);
  }
  el.innerHTML = dots.join('');
  el.classList.remove('hidden');
}

// ── Win receipt: the board's confession ────────────────
// One line on the daily/weekly win modal naming (a) the board's crux —
// the first deduction trivial propagation couldn't reach — and (b) the
// modifier's CERTIFIED contribution, graded by the same strip-and-
// resolve analysis the generator used to admit the board. Voice rule:
// these are statements about the BOARD's proof, never about how the
// player reasoned. Runs async after the modal shows (two solver runs
// ≈ tens of ms on a phone; the modal must feel instant).
const TIER_PHRASE = {
  1: 'comparing two clues',
  2: 'weighing a whole region at once',
  3: 'seeing through the liar',
};

function _renderWinReceipt() {
  const el = $('#gameover-receipt');
  if (!el) return;
  el.classList.add('hidden');
  el.onclick = null;
  const board = state.board;
  const rows = state.rows, cols = state.cols;
  const fr = Math.floor(rows / 2), fc = Math.floor(cols / 2);
  setTimeout(() => {
    try {
      // The solver simulates in its own arrays — live revealed state is
      // untouched (and cleanSolverArtifacts must NOT run here: it would
      // wipe cell.isRevealed on the live, fully-revealed board).
      // extractCrux is the SAME crux finder the daily teaser uses, so the
      // receipt and the teaser can never disagree about the crux square.
      const crux = extractCrux(board, rows, cols, fr, fc);
      const parts = [];
      let cruxJump = null;
      if (crux) {
        // Coordinates mean nothing to a player; take them THERE instead.
        // Tapping the line hides the modal, pulses the crux square and
        // the clues that prove it, then brings the modal back.
        parts.push(`Hardest step: the first square that took ${TIER_PHRASE[crux.tier] || 'real thought'} (tap to see it)`);
        cruxJump = { cell: crux.cell, sources: crux.sources };
      } else {
        parts.push('Every square here fell to plain counting. A breather board');
      }
      const testable = (state.activeGimmicks || [])
        .filter(g => ['sonar', 'compass', 'wormhole', 'liar', 'mirror'].includes(g));
      if (testable.length > 0) {
        const g = testable[0];
        const grade = gradeGimmickContribution(board, rows, cols, fr, fc, g);
        if (grade.tier === 'required') {
          parts.push(`without the ${g}, this board had no solution`);
        } else if (grade.tier === 'technique') {
          parts.push(`the ${g} spared you ${TIER_PHRASE[grade.to] || 'harder thinking'}`);
        } else if (grade.tier === 'shortcut') {
          parts.push(`the ${g} saved you ${grade.clicksSaved} clicks`);
        } else if (grade.tier === 'decorative') {
          parts.push(`the ${g} was a free extra clue this time`);
        }
      }
      if (parts.length > 0) {
        el.textContent = parts.join(' · ');
        el.classList.toggle('gameover-receipt-tappable', !!cruxJump);
        if (cruxJump) {
          el.onclick = () => {
            // Show, don't tell: drop the modal, light the crux square
            // and its proving clues on the real board, then bring the
            // results back.
            hideModal('gameover-overlay');
            const els = [];
            const mark = (pos, cls) => {
              const cellEl = boardEl.children[pos.row * cols + pos.col];
              if (cellEl) { cellEl.classList.add(cls); els.push([cellEl, cls]); }
            };
            mark(cruxJump.cell, 'receipt-crux');
            for (const s of cruxJump.sources) mark(s, 'receipt-source-pulse');
            setTimeout(() => {
              for (const [cellEl, cls] of els) cellEl.classList.remove(cls);
              showModal('gameover-overlay');
            }, 3200);
          };
        }
        el.classList.remove('hidden');
      }
    } catch (err) {
      console.warn('win receipt failed:', err && err.message);
    }
  }, 80);
}

/**
 * Record an archive replay completion with first-completion-only semantics.
 * Reads the player's dailyHistory for the date (the dedup key); on a fresh
 * date it submits a dailyArchive fit row (when the date is at or after the
 * fit epoch) and writes the dailyHistory row. A replay (history present)
 * records nothing. Streak, daily-completed, and the residual cache are never
 * touched here — those are gated off upstream by isArchivePlay.
 *
 * @param {string} dateStr   YYYY-MM-DD of the replayed board
 * @param {string} name      player handle
 * @param {number} scoreTime completion seconds (already rounded)
 */
export async function submitArchiveCompletion(dateStr, name, scoreTime) {
  // Tell a CONFIRMED-absent row (a genuine first completion) apart from a read
  // we couldn't complete. fetchDailyHistoryEntry throws when Firebase isn't
  // ready or the read fails; treating that as 'absent' would double-feed the
  // par fit on a replay (see archiveSubmitPlan's 'unknown' fail-closed branch).
  let historyStatus;
  try {
    const existing = await fetchDailyHistoryEntry(dateStr);
    historyStatus = existing ? 'present' : 'absent';
  } catch {
    historyStatus = 'unknown';
  }
  const plan = archiveSubmitPlan(dateStr, historyStatus);
  if (!plan.submitFit && !plan.writeHistory) {
    showToast(historyStatus === 'unknown'
      ? "Couldn't reach the server — this run wasn't recorded."
      : 'Your first run on this day is already recorded.');
    return;
  }
  if (plan.submitFit) {
    let cruxViewed = false;
    try { cruxViewed = localStorage.getItem(CRUX_VIEWED_KEY_PREFIX + dateStr) === '1'; }
    catch { /* storage unavailable — treat as not viewed */ }
    await submitArchiveScore(dateStr, name, scoreTime, state.dailyBombHits || 0, {
      uid: getUid(),
      par: state.dailyPar,
      features: state.dailyFeatures,
      bombHitEvents: state.dailyBombHitEvents || [],
      hintEvents: state.hintEvents || [],
      rngSeed: state.dailyRngSeed || dateStr,
      totalMines: state.totalMines,
      cruxViewed,
    });
  }
  // dailyHistory is durable (its own retry queue), so the completion and the
  // delta-chart entry survive even if the fit-row upload failed.
  if (plan.writeHistory) {
    saveDailyHistoryEntry(dateStr, { time: scoreTime });
  }
  showToast('Archive run recorded.');
}

// ── Handle Win ─────────────────────────────────────────

export function handleWin() {
  state.status = 'won';
  stopTimer();
  announceGame('You won! Board cleared.');
  // Shared modal hygiene: the win receipt only renders for daily/weekly;
  // hide it up front so a prior game's line can't bleed through.
  const winReceiptEl = $('#gameover-receipt');
  if (winReceiptEl) winReceiptEl.classList.add('hidden');
  applyIcon(resetBtn, 'smileyWin', getThemeEmoji('smileyWin'), { sizeClass: 'sprite-smiley' });
  resetBtn.classList.add('smiley-win-bounce');
  setTimeout(() => resetBtn.classList.remove('smiley-win-bounce'), 800);

  const prevStats = loadStats();
  const prevMaxLevel = prevStats.maxLevelReached || 1;

  const isDaily = state.gameMode === 'daily';
  const isWeekly = state.gameMode === 'weekly';
  // Practice daily (URL ?seed=custom) plays like a daily but must not touch
  // stats, streak, completion flags, or personal history — it exists for
  // replaying after today's real daily has already been won. Weekly is its
  // own world entirely — see the dedicated weekly branch below.
  // Archive replay: a PAST daily relaunched from the calendar. It looks like
  // a daily (board, par, features) but must never touch streak, completion,
  // or the residual cache, and it submits to dailyArchive/ instead of daily/.
  // It DOES earn one fit row on first completion (the submit block below).
  const isArchivePlay = isDaily && !!state.isArchivePlay;
  const isRealDaily = isDaily && !state.isDailyPractice && !isArchivePlay;
  // Skill feats — honestly detectable from the click timeline + the board's
  // certified solve (flagless / efficient / search / liar), never heuristics;
  // chaos earns nothing. The certifiedClicks invariant and the feature/mode
  // gating live in (and are node-tested at) src/logic/skillFeatDetection.js.
  const skillFeats = detectSkillFeats(state);
  const stats = saveGameResult(true, state.elapsedTime, state.currentLevel, {
    isDaily: isRealDaily,
    isArchive: isArchivePlay,
    usedPowerUps: state.usedPowerUps,
    gameMode: state.gameMode,
    hadGimmicks: state.activeGimmicks && state.activeGimmicks.length > 0,
    skillFeats,
    dailySeed: isRealDaily ? state.dailySeed : null,
  });
  // Drain the molt-day outcome of this completion (a cover earned, or covers
  // spent to save the streak). Null on every non-daily / archive win, so the
  // note below renders only where it's real.
  const moltEvent = consumeMoltEvent();
  let moltNote = '';
  if (moltEvent) {
    if (moltEvent.coveredDates && moltEvent.coveredDates.length > 0) {
      // A cover saved the streak — a quiet inline confirmation here.
      moltNote = `<span class="molt-note">🦀 Molt day covered ${_coveredPhrase(moltEvent.coveredDates)}. Streak intact at ${moltEvent.streakKept}.</span><br>`;
    } else if (moltEvent.earned && isRealDaily) {
      // Earning one is a milestone — flag the celebratory popup + the crab
      // placement animation that play when the player lands back on the title.
      flagMoltCelebrate();
    }
  }

  // Skip power-up awarding for chaos AND weekly. Weekly is a pure
  // time-trial against a fixed board — power-ups would let later-week
  // attempts cheese the leaderboard against earlier days.
  const earnedPowerUp = (state.gameMode === 'chaos' || state.gameMode === 'weekly') ? null : awardPowerUps(stats);

  // Sync progress to cloud (fire-and-forget)
  if (state.gameMode === 'normal') {
    saveProgress({ maxCheckpoint: stats.maxLevelReached || state.currentLevel });
  }
  if (isRealDaily) {
    const streak = getDailyStreak();
    saveProgress({
      dailyStreak: streak.streak,
      bestDailyStreak: streak.best,
      lastDailyDate: state.dailySeed,
      // The molt bank + last-use ride the same write so a cross-device merge
      // always sees a coherent (streak, bank) snapshot.
      moltDay: { banked: streak.banked, lastUse: stats.modeStats?.daily?.moltLastUse || null },
    });
  }

  // Mark daily as completed so it cannot be replayed today.
  if (isRealDaily && state.dailySeed) {
    markDailyCompleted(state.dailySeed);
  }

  // Weekly mode win: mark this day's attempt cloud-synced, update the
  // weeklyDayTimes map, submit to the weekly leaderboard, and (only on
  // the player's FIRST attempt this week) submit a synthetic-daily row
  // to daily/{weekStart}_weekly_first so the par-model fit gets honest
  // first-encounter timing data.
  if (isWeekly && state.weeklySeed != null && state.weeklyDay != null) {
    // Snapshot the prior-times BEFORE we mutate state.weeklyDayTimes,
    // so the modal-render code below can compute "1st attempt" vs
    // "Nth attempt" correctly. Without this snapshot the modal would
    // see the just-written entry as a "prior" attempt and double-count.
    state._weeklyPriorTimesAtWin = Object.values(state.weeklyDayTimes || {})
      .filter(t => typeof t === 'number');
    const isFirstAttemptThisWeek = state._weeklyPriorTimesAtWin.length === 0;

    // Test branch: skip both Firebase + in-memory weekly attempt
    // marking so the weekly can be replayed indefinitely for testing.
    // markWeeklyDayAttempted is already a no-op on test (Firebase
    // guard), but the in-memory cachedWeeklyDayAttempts set would
    // still gate the player out within the session — bypass that too.
    if (!isTestEnvironment()) {
      markWeeklyDayAttempted(state.weeklySeed, state.weeklyDay);
      // Keep the local attempt cache in sync. Without this, every gate that
      // reads state.cachedWeeklyDayAttempts (title-screen weekly card, mode-card
      // click handler, deep-link router, reset-button gate) sees the stale
      // pre-win value until the player reloads — which means smashing the
      // smiley or revisiting the title spawns another attempt for the same day.
      if (!state.cachedWeeklyDayAttempts) state.cachedWeeklyDayAttempts = {};
      state.cachedWeeklyDayAttempts[state.weeklyDay] = true;
    }

    const scoreTime = Math.round((state.preciseTime || state.elapsedTime) * 10) / 10;
    const updated = { ...(state.weeklyDayTimes || {}), [state.weeklyDay]: scoreTime };
    state.weeklyDayTimes = updated;
    // Merge this attempt's strike count into the per-day map. Used by
    // the leaderboard to show the strikes from whichever day produced
    // the player's best time.
    const updatedBombs = { ...(state.weeklyDayBombHits || {}), [state.weeklyDay]: state.weeklyBombHits || 0 };
    state.weeklyDayBombHits = updatedBombs;
    const bestTime = Math.min(...Object.values(updated));
    // Solver-optimal click count for this board, derived once at
    // canonical resolve in gameActions. Same number for every player
    // (same board), used by the leaderboard's pace column.
    const totalMoves = state.weeklyFeatures?.totalClicks || null;

    const playerName = (getPlayerName() || '').slice(0, 20).trim();
    if (playerName) {
      submitWeeklyScore(state.weeklySeed, getUid(), playerName, bestTime,
        { [state.weeklyDay]: scoreTime },
        {
          dayBombHits: { [state.weeklyDay]: state.weeklyBombHits || 0 },
          totalMoves,
          totalMines: state.totalMines,
          attemptBombHits: state.weeklyBombHits || 0,
        }
      ).catch(err => reportCaughtError('weekly-score-submit', err));

      if (isFirstAttemptThisWeek && WEEKLY_FIT_DATA_ENABLED) {
        // Honest first encounter — qualifies for par-model fit data.
        // Reuses submitOnlineScore so we land in the same daily/* and
        // dailyMeta/* tables the R refit already reads, with a unique
        // key suffix so it joins as its own row.
        //
        // Currently DISABLED via WEEKLY_FIT_DATA_ENABLED. Weekly is
        // brand-new and we're still iterating on its rules (gimmick
        // count, bomb-hit handling, end-screen). Letting test plays
        // pollute the par-model fit pool would skew coefficients on
        // half-baked data. Flip the flag to true once the weekly
        // mechanic has stabilised and we trust the inputs.
        submitOnlineScore(
          state.weeklySeed + '_weekly_first',
          playerName,
          scoreTime,
          state.weeklyBombHits || 0,
          {
            uid: getUid(),
            features: state.weeklyFeatures,
            bombHitEvents: state.weeklyBombHitEvents || [],
            rngSeed: state.weeklyRngSeed || state.weeklySeed,
            totalMines: state.totalMines,
          }
        ).catch(err => reportCaughtError('weekly-first-fit-submit', err));
      }
    } else {
      // Players without a name still get the local attempt counted
      // (markWeeklyDayAttempted already fired) but their time stays
      // out of the leaderboard. Surface a soft hint.
      showToast('Set your name in Settings to appear on the weekly leaderboard');
    }
  }

  // Persist power-ups after win (award changes them). Skip for chaos
  // and weekly — neither mode uses power-ups so the saved counts would
  // just be empty objects bouncing around localStorage.
  if (state.gameMode !== 'chaos' && state.gameMode !== 'weekly') {
    saveModePowerUps(state.gameMode, state.powerUps);
  saveProgress({ powerUps: loadPowerUps() });
  }

  // 30% chance to earn a free lifeline on level completion (Challenge mode)
  if (state.gameMode === 'normal' && Math.random() < LIFELINE_WIN_REWARD_CHANCE) {
    state.powerUps.lifeline = (state.powerUps.lifeline || 0) + 1;
    saveModePowerUps(state.gameMode, state.powerUps);
  saveProgress({ powerUps: loadPowerUps() });
    showToast('❤️ Lifeline earned!');
  }

  playWin();
  showVictoryCelebration();
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

  const _strikes = state.gameMode === 'weekly'
    ? (state.weeklyBombHits || 0)
    : state.gameMode === 'daily' ? (state.dailyBombHits || 0) : 0;
  const _bombEvents = state.gameMode === 'weekly'
    ? (state.weeklyBombHitEvents || [])
    : state.gameMode === 'daily' ? (state.dailyBombHitEvents || []) : [];
  const _totalPenalty = _bombEvents.reduce(
    (s, e) => s + (e && typeof e.penalty === 'number' ? e.penalty : 0), 0);
  const strikesInfo = _strikes > 0
    ? ` | 💥 ${_strikes} strike${_strikes !== 1 ? 's' : ''}${_totalPenalty > 0 ? ` (+${_totalPenalty.toFixed(1)}s)` : ''}`
    : '';

  const parEl = $('#gameover-par');
  if (parEl) parEl.classList.add('hidden');
  const parBreakdownEl = $('#gameover-par-breakdown');
  if (parBreakdownEl) parBreakdownEl.classList.add('hidden');
  const historyDotsEl = document.getElementById('gameover-history-dots');
  if (historyDotsEl) historyDotsEl.classList.add('hidden');

  // Timed mode: show speed rating + par-relative delta, and feed the run
  // into the fit pipeline (timed/{pushId} — the modeTimed effect
  // activates in the R refit once >= 20 rows exist).
  if (state.gameMode === 'timed') {
    const precise = state.preciseTime || state.elapsedTime;
    const rating = getSpeedRating(state.currentLevel, precise);
    gameoverTime.innerHTML = `Time: ${precise.toFixed(1)}s · ${medalImgForEmoji(rating.icon, 'sprite-rank', rating.name) || rating.icon} ${rating.name}!`;
    if (parEl && state.timedPar > 0) {
      const tDelta = precise - state.timedPar;
      const tAbs = Math.abs(tDelta).toFixed(1);
      const tClass = tDelta < -0.5 ? 'par-under' : tDelta > 0.5 ? 'par-over' : 'par-even';
      const tText = tDelta < -0.5 ? `${tAbs}s under par` : tDelta > 0.5 ? `${tAbs}s over par` : 'Even par!';
      parEl.innerHTML = `${spriteImgHTML('smiley', 'sprite-greg-par', 'Greg')}Greg's Time: ${state.timedPar.toFixed(1)}s · <span class="${tClass}">${tText}</span>`;
      parEl.classList.remove('hidden');
    }
    if (state.timedFeatures && state.timedPar > 0) {
      const timedName = getPlayerName() || 'Anonymous';
      submitTimedScore(timedName, Math.round(precise * 10) / 10, state.currentLevel, {
        uid: getUid(),
        par: state.timedPar,
        features: state.timedFeatures,
      }).catch(err => reportCaughtError('timed-score-submit', err));
    }
  } else if (state.gameMode === 'daily') {
    // Daily: show precise time + par comparison
    const precise = state.preciseTime || state.elapsedTime;
    gameoverTime.textContent = `Time: ${precise.toFixed(1)}s${strikesInfo}`;
    // The streak suffix implies "this counts toward your streak" — true for a
    // live daily, false for an archive replay (archive never touches the
    // streak), so suppress it on archive to avoid the wrong implication.
    if (!isArchivePlay) {
      const { streak } = getDailyStreak();
      if (streak > 0) {
        gameoverTime.textContent += ` | \u{1F525} ${streak} day streak`;
      }
    }
    // Greg's Time = global par from the current PAR_MODEL applied to today's
    // board features. Personal par = Greg's + your handicap (your typical
    // over/under across recent dailies). When a handicap is known we show
    // both numbers and the primary delta is measured against YOUR par —
    // that's the one that tells you whether you had a good or bad day
    // relative to your own skill.
    // Par only meaningful in regular daily mode. Weekly doesn't carry
    // a par (same board across the week — par would be a moving target
    // anyway since the player learns the board). Without this gate,
    // state.dailyPar can leak from a previous in-session daily play and
    // render here.
    if (parEl && state.dailyPar > 0 && state.gameMode === 'daily') {
      // Stash this play's residual locally BEFORE computing the provisional
      // handicap so the current play counts toward the running mean. We
      // dedupe by date inside appendDailyResidual, so replaying after a
      // resume doesn't double-count.
      // Archive replays stay out of the residual cache: the provisional
      // handicap is built from day-of plays, so an old, easy board should
      // not shift it. (The par line below still renders for archive.)
      if (!isArchivePlay) {
        appendDailyResidual({
          date: state.dailySeed,
          time: precise,
          par: state.dailyPar,
          bombHits: state.dailyBombHits || 0,
          bombPenalty: getActiveBombPenaltyTotal(),
        });
      }

      // Handicap resolution: prefer the refit value from handicaps.json
      // (set by the nightly Bayesian fit once the user crosses
      // MIN_PLAYS_FOR_FIT_INCLUSION=30 plays). If the refit hasn't
      // included this user yet, fall back to the client-side mean
      // residual across at least 2 local plays so newcomers see a
      // "Your par" line that tightens with each daily instead of
      // staring at "Greg's Time" alone for a month.
      // Resolve the handicap (refit value, else a provisional from local
      // residuals), the newcomer gate, and the par-relative delta line. The
      // residual for THIS play was appended just above, so the count passed in
      // includes today. A newcomer's first few dailies show only the plain "vs
      // Greg's Time" line (handicap/personal-par/breakdown/history hidden);
      // past the gate the delta is measured against the player's personal par.
      const {
        isNewcomerDaily, personalPar, useHandicap,
        parClass, deltaText, yourParLabel, showOneMoreHint,
      } = resolveParDisplay({
        precise,
        dailyPar: state.dailyPar,
        refitHandicap: getHandicap(getUid()),
        residuals: loadDailyResiduals(),
      });

      // First daily a player ever finishes: define par in one plain
      // sentence before throwing numbers at them. Shows once, ever.
      let parPrimer = '';
      if (!hasSeenNotice('par_primer')) {
        markNoticeSeen('par_primer');
        parPrimer = '<span class="par-primer">Greg’s Time is the typical solve time for today’s board. Finish faster and you’re under par.</span><br>';
      }

      if (useHandicap) {
        // Lab File itemization (handicaps.json v2): when the refit has
        // emitted the clean/bomb split, "your par" stops being one
        // oracular number and becomes an explanation — Greg + your pace
        // + your bomb habit. Falls back to the plain line when the
        // decomposition hasn't shipped; we never fabricate a split.
        const details = getHandicapDetails(getUid());
        const itemized = details ? labFileLine(state.dailyPar, details) : null;
        parEl.innerHTML = moltNote + parPrimer +
          spriteImgHTML('smiley', 'sprite-greg-par', 'Greg') +
          (itemized
            ? itemized + ' · '
            : "Greg's Time: " + state.dailyPar.toFixed(1) + 's · ' +
              yourParLabel + personalPar.toFixed(1) + 's · ') +
          '<span class="' + parClass + '">' + deltaText + '</span>';
      } else {
        // No handicap yet — surface a small hint about what would
        // unlock one so a brand-new player (1 daily complete) doesn't
        // think the system is just ignoring them.
        const needHint = showOneMoreHint
          ? ' <span class="par-hint">· 1 more daily and your personal par appears</span>'
          : '';
        parEl.innerHTML = moltNote + parPrimer +
          spriteImgHTML('smiley', 'sprite-greg-par', 'Greg') +
          "Greg's Time: " + state.dailyPar.toFixed(1) + 's · ' +
          '<span class="' + parClass + '">' + deltaText + '</span>' + needHint;
      }
      parEl.classList.remove('hidden');

      // Per-feature breakdown of what drove Greg's par. Held back for a
      // newcomer's first few dailies (jargon overload on the first
      // result). Only shown when state.dailyFeatures is populated
      // (older resumed games may predate features).
      if (!isNewcomerDaily && parBreakdownEl && state.dailyFeatures) {
        const terms = breakdownPar(state.dailyFeatures);
        if (terms.length > 0) {
          parBreakdownEl.innerHTML = terms
            .map(t => '<span class="par-term" title="Extra time this part of the board adds to Greg’s Time">+' + t.seconds + 's ' + t.label + '</span>')
            .join('<span class="par-term-sep"> · </span>');
          parBreakdownEl.classList.remove('hidden');
        }
      }
      // 7-dot history strip — at-a-glance look at the player's recent
      // trajectory. Also held back until they have a few dailies under
      // their belt; one or two dots says nothing. Reads localStorage
      // residuals (just-appended above) so it's instant and offline.
      if (!isNewcomerDaily) _renderWinModalHistoryDots(state.dailySeed);
      // Win receipt: the board's confession (crux + modifier verdict).
      if (!isNewcomerDaily) _renderWinReceipt();
    }
  } else if (state.gameMode === 'weekly') {
    // Weekly: show precise time, day-of-week dot indicators, vs-best
    // comparison, and the live leaderboard inline.
    const precise = state.preciseTime || state.elapsedTime;
    gameoverTime.textContent = `Time: ${precise.toFixed(1)}s${strikesInfo}`;

    // CAPTURE the prior-times snapshot BEFORE handleWin's weekly win
    // block mutates state.weeklyDayTimes (which it does to compute the
    // bestTime for submitWeeklyScore). Without this snapshot, priorTimes
    // would already include the current attempt's time and the modal
    // would report a 1st attempt as a 2nd attempt.
    const priorTimes = state._weeklyPriorTimesAtWin
      || Object.values(state.weeklyDayTimes || {}).filter(t => typeof t === 'number' && Math.abs(t - precise) > 0.01);
    const priorBest = priorTimes.length > 0 ? Math.min(...priorTimes) : null;
    const newBest = priorBest != null ? Math.min(priorBest, precise) : precise;
    const attemptsUsed = priorTimes.length + 1;

    // Day circles: ● for played, ○ for not-yet, ◉ for the day this win
    // landed on. After the win-flow mutation, state.weeklyDayTimes
    // contains all played days including today. Find which one is today.
    const playedDays = state.weeklyDayTimes || {};
    const dayCircles = [0, 1, 2, 3, 4, 5, 6].map(d => {
      if (d === state.weeklyDay) return '◉';
      if (playedDays[d] != null) return '●';
      return '○';
    }).join(' ');

    let summary;
    if (priorBest == null) {
      summary = `<span class="par-even">First attempt this week. You set the bar at ${precise.toFixed(1)}s.</span>`;
    } else if (precise < priorBest) {
      const delta = (priorBest - precise).toFixed(1);
      summary = `<span class="par-under">${delta}s faster than your best</span> · new best ${newBest.toFixed(1)}s`;
    } else if (precise > priorBest) {
      const delta = (precise - priorBest).toFixed(1);
      summary = `<span class="par-over">${delta}s off your best</span> · still ${newBest.toFixed(1)}s to beat`;
    } else {
      summary = `<span class="par-even">Matched your best!</span> · ${newBest.toFixed(1)}s`;
    }

    if (parEl) {
      parEl.innerHTML = `
        <div class="weekly-summary-row weekly-day-dots">${dayCircles}</div>
        <div class="weekly-summary-row">Best this week: <strong>${newBest.toFixed(1)}s</strong> · Attempts: ${attemptsUsed}/7</div>
        <div class="weekly-summary-row">${summary}</div>
        <div class="weekly-leaderboard" id="weekly-leaderboard-inline">
          <div class="weekly-leaderboard-loading">Loading leaderboard…</div>
        </div>
      `;
      parEl.classList.remove('hidden');

      // Fetch and render the leaderboard inline. Fire-and-forget — the
      // gameover modal renders immediately with a "Loading…" placeholder
      // and replaces it once Firebase responds. Keeps the modal snappy
      // even on slow networks; if the fetch fails the placeholder just
      // stays as "Loading…" which is harmless.
      fetchWeeklyLeaderboard(state.weeklySeed).then((rows) => {
        const el = document.getElementById('weekly-leaderboard-inline');
        if (!el) return;
        if (!rows || rows.length === 0) {
          el.innerHTML = '<div class="weekly-leaderboard-empty">No scores yet this week.</div>';
          return;
        }
        const myUid = getUid();
        const myIdx = myUid ? rows.findIndex(r => r.uid === myUid) : -1;
        // Show top 5 + your row if you're outside top 5.
        const maxRows = 5;
        const display = rows.slice(0, maxRows).map((r, i) => ({ ...r, rank: i + 1, mine: r.uid === myUid }));
        if (myIdx >= maxRows) {
          display.push({ ...rows[myIdx], rank: myIdx + 1, mine: true });
        }
        const rowsHtml = display.map(r =>
          `<div class="weekly-lb-row${r.mine ? ' weekly-lb-row-mine' : ''}">` +
            `<span class="weekly-lb-rank">${r.rank}.</span>` +
            `<span class="weekly-lb-name">${escapeHtml(r.name)}</span>` +
            `<span class="weekly-lb-time">${r.bestTime.toFixed(1)}s</span>` +
            `<span class="weekly-lb-attempts">${r.attemptsUsed}/7</span>` +
          `</div>`
        ).join('');
        const myRank = myIdx >= 0 ? myIdx + 1 : null;
        const header = myRank
          ? `Rank #${myRank} of ${rows.length}`
          : `${rows.length} player${rows.length !== 1 ? 's' : ''} this week`;
        el.innerHTML = `<div class="weekly-leaderboard-header">${header}</div>${rowsHtml}`;
      }).catch(err => reportCaughtError('weekly-leaderboard-render', err));
    }
    // Weekly gets the board's confession too (crux + modifier verdict).
    _renderWinReceipt();
  } else {
    const precise = state.preciseTime || state.elapsedTime;
    gameoverTime.textContent = `Time: ${precise.toFixed(1)}s${strikesInfo}`;
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
      gameoverRecord.innerHTML = `🏆 New Record: ${state.elapsedTime}s ${medalImgForEmoji(rating.icon, 'sprite-rank', rating.name) || rating.icon}`;
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
      badge.innerHTML = `<span>${achievementSpriteImgHTML(unlock.categoryId, 'sprite-rank', unlock.category) || unlock.categoryIcon}</span><span>${unlock.category} ${unlock.tierIcon} ${unlock.tier.charAt(0).toUpperCase() + unlock.tier.slice(1)}</span>`;
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
    const precise = state.preciseTime || state.elapsedTime;
    state.chaosTotalTime = (state.chaosTotalTime || 0) + precise;
    gameoverTitle.textContent = 'Board Cleared!';
    gameoverTime.textContent = 'Round ' + (state.chaosRound || 1) + ' · ' + precise.toFixed(1) + 's';
  } else {
    if (chaosNextBtn) chaosNextBtn.classList.add('hidden');
    if (chaosRunSummary) chaosRunSummary.classList.add('hidden');
    const maxLevel = state.gameMode === 'timed' ? MAX_TIMED_LEVEL : MAX_LEVEL;
    if (state.currentLevel < maxLevel && state.gameMode !== 'daily' && state.gameMode !== 'weekly' && state.gameMode !== 'timed') {
      nextLevelBtn.classList.remove('hidden');
    } else {
      nextLevelBtn.classList.add('hidden');
    }
  }

  const dailySubmitForm = $('#daily-submit-form');
  if (isDaily && dailySubmitForm) {
    const savedName = getPlayerName();
    if (isArchivePlay) {
      // Archive replay: no manual name form (archive is a later-game feature
      // and the player already has a handle). Record only with a saved name,
      // through the first-completion-only path — never the daily/ submitters.
      dailySubmitForm.classList.add('hidden');
      if (savedName) {
        const aDate = state.dailySeed || getLocalDateString();
        const aTime = Math.round((state.preciseTime || state.elapsedTime) * 10) / 10;
        submitArchiveCompletion(aDate, savedName, aTime)
          .catch(err => reportCaughtError('archive-completion', err));
      } else {
        showToast('Set a name in Settings to record archive runs.');
      }
    } else if (savedName) {
      // Auto-submit with saved name
      dailySubmitForm.classList.add('hidden');
      // Anchor to the puzzle's seed, not the current local date (same as
      // the manual-submit path in main.js) — finishing at 12:00:01 AM
      // would otherwise post yesterday's board onto today's leaderboard.
      const dateStr = state.dailySeed || getLocalDateString();
      const scoreTime = Math.round((state.preciseTime || state.elapsedTime) * 10) / 10;
      addDailyLeaderboardEntry(dateStr, savedName, scoreTime);
      // CRITICAL: this auto-submit path (used whenever the player has a
      // saved name) MUST stay in sync with the manual-submit path in
      // main.js. Both need to include bombHitEvents and rngSeed —
      // missing either of those fields drops the experimental-design
      // and bomb-adjusted-model data streams silently.
      submitOnlineScore(dateStr, savedName, scoreTime, state.dailyBombHits || 0,
        buildDailyScoreExtras(state, dateStr, getUid())).then((ok) => {
        // Show the REAL outcome. Previously this toasted success
        // unconditionally, so an offline player thought their score
        // uploaded when it had only been queued — that's how Kate
        // believed she'd posted scores that never reached the board.
        // 'duplicate' = this account already has a row for this exact
        // board (another device finished first, or a queued retry had
        // already landed) — first completion wins, so the personal-
        // history entry is skipped too rather than overwriting the
        // first device's time.
        if (ok === 'duplicate') {
          showToast('Already on the board from another device');
        } else if (ok === 'cheat') {
          // Probing run (> 30% of mines hit): kept off the leaderboard and
          // out of the personal history timeline.
          showToast('Too many mines hit — this run won\'t be ranked');
        } else {
          showToast(ok ? '✅ Score submitted!' : '📡 Saved. Uploads when you reconnect');
          // Per-user daily-history timeline feeds the leaderboard-modal
          // chart. Skip for practice dailies — they play on a custom seed
          // and don't belong on the player's regular history timeline.
          // Durable: queues to localStorage and re-sends on reconnect if
          // the write fails.
          if (!state.isDailyPractice) {
            saveDailyHistoryEntry(dateStr, { time: scoreTime });
          }
        }
      }).catch(() => {
        showToast('📡 Saved. Uploads when you reconnect');
        if (!state.isDailyPractice) {
          saveDailyHistoryEntry(dateStr, { time: scoreTime });
        }
      });
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

  // Daily/weekly wins offer a one-tap "challenge a friend" that copies a
  // link to YESTERDAY's crux teaser — a real puzzle, never today's board
  // (the route refuses today and later). Other modes have no crux to share.
  const cruxChallengeBtn = $('#gameover-crux-challenge');
  if (cruxChallengeBtn) cruxChallengeBtn.classList.toggle('hidden', !(isDaily || isWeekly));

  // Daily-win opt-in CTA — shown on daily/weekly wins ONLY when push
  // notifications are currently disabled. Best single moment to convert
  // a one-off player into a returning one. Hidden by default; the show
  // path checks notification prefs asynchronously and unhides.
  const remindBtn = $('#gameover-remind-tomorrow');
  if (remindBtn) {
    remindBtn.classList.add('hidden');
    if (isDaily || isWeekly) {
      (async () => {
        try {
          const { loadNotificationPrefs } = await import('../firebase/firebasePush.js');
          const prefs = await loadNotificationPrefs();
          if (!prefs?.enabled) remindBtn.classList.remove('hidden');
        } catch {
          // If push module fails to load (offline, missing SDK), leave
          // the button hidden — the prompt wouldn't work anyway.
        }
      })();
    }
  }

  // Hide "Play Again" for daily mode (can't replay today's daily)
  const retryBtn = $('#gameover-retry');
  if (retryBtn) {
    if (isDaily || isWeekly) retryBtn.classList.add('hidden');
    else retryBtn.classList.remove('hidden');
  }

  // Show "Done" button for daily mode (no next level or retry available)
  const doneBtn = $('#gameover-done');
  if (doneBtn) {
    if (isDaily || isWeekly) doneBtn.classList.remove('hidden');
    else doneBtn.classList.add('hidden');
  }

  // Clear saved game state on win
  clearGameState(state.gameMode);

  // Delay the modal so the VICTORY! overlay (3.6 s total) has a chance
  // to play before the modal covers it. 2 s lands the modal after the
  // VICTORY bounce has settled into its hold phase — confetti still
  // visible behind, win chime audible, but the modal arrives in time
  // for the Play Again button to be useful before the user moves on.
  setTimeout(() => showModal('gameover-overlay'), 2000);
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
  applyIcon(resetBtn, 'smileyLoss', getThemeEmoji('smileyLoss'), { sizeClass: 'sprite-smiley' });
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

  // The loss receipt: the FULL deducible frontier (flags-blind — a wrong
  // flag must never make the verdict lie), painted on the board for the
  // explore view's tap-to-interrogate. The first frontier cell keeps the
  // legacy one-cell NEXT MOVE chip.
  const lossFrontier = prepareLossReceipt();
  const suggestedMove = lossFrontier.safe.length > 0
    ? { row: lossFrontier.safe[0].row, col: lossFrontier.safe[0].col }
    : null;
  state.suggestedMove = suggestedMove;
  if (suggestedMove) {
    const cell = state.board[suggestedMove.row]?.[suggestedMove.col];
    if (cell) cell.suggestedMove = true;
  }

  // Chain detonation: each non-flagged mine pops in turn from the blast
  // outward, swapping mine.png to strike.png with explosion sound every
  // 3rd. Returns a Promise resolving when the cascade settles; we attach
  // the modal reveal to it below so the modal doesn't interrupt the
  // animation.
  const cascadePromise = chainRevealMines(mineRow, mineCol);

  playExplosion();
  triggerHeavyShake();
  showRedFlash();
  haptic([100, 40, 100, 40, 200]);
  saveGameResult(false, state.elapsedTime, state.currentLevel, { gameMode: state.gameMode });

  // Power-ups persist on loss within same mode
  saveModePowerUps(state.gameMode, state.powerUps);
  saveProgress({ powerUps: loadPowerUps() });

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
    const precise = state.preciseTime || state.elapsedTime;
    gameoverTime.textContent = 'Time: ' + precise.toFixed(1) + 's · Back to Level ' + state.currentLevel;
  } else {
    const precise = state.preciseTime || state.elapsedTime;
    gameoverTime.textContent = 'Time: ' + precise.toFixed(1) + 's';
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
  $('#gameover-crux-challenge')?.classList.add('hidden');
  const doneBtnLoss = $('#gameover-done');
  if (doneBtnLoss) doneBtnLoss.classList.add('hidden');
  $('#gameover-achievements').classList.add('hidden');
  const lossReceiptEl = $('#gameover-receipt');
  if (lossReceiptEl) lossReceiptEl.classList.add('hidden');
  const sharePreview = $('#share-card-preview');
  if (sharePreview) sharePreview.classList.add('hidden');

  // Post-death verdict — honest counts from the flags-blind frontier.
  // "Genuine 50/50" is now a TRUSTWORTHY claim: the old one-cell check
  // trusted player flags, so a wrong flag could stamp 50/50 on a fully
  // deducible position. Tap any cell in the explore view to see its
  // proof (receiptRenderer.handleInterrogateTap).
  const analysisEl = $('#gameover-analysis');
  const analysisText = $('#gameover-analysis-text');
  if (analysisEl && analysisText) {
    const n = lossFrontier.safe.length;
    const flagNote = wrongFlagCount > 0
      ? `${wrongFlagCount} wrong flag${wrongFlagCount > 1 ? 's' : ''} · ` : '';
    if (n > 0) {
      analysisText.textContent = `${flagNote}${n} square${n !== 1 ? 's' : ''} could still be worked out safely. Tap any square to see how`;
    } else if (state.gameMode === 'chaos') {
      analysisText.textContent = `${flagNote}Chaos boards carry no guarantees. Out here, sometimes there is no safe move`;
    } else {
      // An empty frontier at death on a certified board never means a
      // forced 50/50: if the player had only ever clicked knowable
      // squares, a knowable square would still exist. Reaching this
      // state means an earlier click already left the provable path,
      // so the copy must not absolve it as bad luck.
      analysisText.textContent = `${flagNote}Nothing you had open could prove a safe square here. The provable path was left behind earlier`;
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

  // Show the modal only after the chain-detonation cascade finishes
  // (resolved Promise from chainRevealMines). Reduced-motion path
  // resolves the promise instantly, so the modal still appears
  // immediately for those users.
  cascadePromise.then(() => showModal('gameover-overlay'));
  updatePowerUpBar();
  updateStreakBorder();
  updateCheckpointDisplay();
}

// ── Handle Timed Loss ──────────────────────────────────

export function handleTimedLoss() {
  state.status = 'lost';
  stopTimer();
  applyIcon(resetBtn, 'smileyLoss', getThemeEmoji('smileyLoss'), { sizeClass: 'sprite-smiley' });
  resetBtn.classList.add('smiley-loss-shake');
  setTimeout(() => resetBtn.classList.remove('smiley-loss-shake'), 500);
  playExplosion();
  triggerHeavyShake();
  showRedFlash();
  haptic([100, 40, 100, 40, 200]);
  saveGameResult(false, state.elapsedTime, state.currentLevel, { gameMode: state.gameMode });
  saveModePowerUps(state.gameMode, state.powerUps);
  saveProgress({ powerUps: loadPowerUps() });

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
  $('#gameover-crux-challenge')?.classList.add('hidden');
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

// ── Daily / Weekly Mode: Info-Value Bomb Penalty ────────
// New (post-2026-05-31) mechanic: NO re-fog, NO flat +10s. Hitting a
// mine instead costs a deterministic info-value penalty + a small base.
//   penalty = max(0, infoValue) + BOMB_PENALTY_BASE
// where info-value is computed by computeBombInfoValue (src/logic/
// bombInfoValue.js) by running the solver twice — once without this
// mine pre-flagged, once with — and weighting the difference in move-
// type counts by PAR_MODEL coefficients. A mine the solver was about
// to nail anyway scores ~0; a mine anchoring a Pass-C deduction can
// score 20+. The base keeps every bomb-pop slightly punishing so it's
// never a strict-zero shortcut.
//
// Strike cell stays visible (isMine=true, isStrike=true, isRevealed=
// true) so the player sees what they hit and the adjacency contribution
// stays correct. Other revealed cells are NOT re-fogged.
//
// The function name remains handleDailyBombHit for backward-compat
// with all the call sites; it handles both daily and weekly via the
// isWeekly branch.

export function handleDailyBombHit(mineRow, mineCol) {
  const isWeekly = state.gameMode === 'weekly';

  // Prior strikes on this attempt — pre-flagged in the info-value
  // computation so the returned value is the MARGINAL info-value of
  // this hit given those prior hits, not the cumulative value.
  const priorEvents = (isWeekly ? state.weeklyBombHitEvents : state.dailyBombHitEvents) || [];
  const priorHits = isWeekly ? (state.weeklyBombHits || 0) : (state.dailyBombHits || 0);
  // state.elapsedTime is pure wall-clock (penalties live in the event log,
  // not in elapsedTime), so it already IS the clean hit timestamp.
  const tClean = Math.round(state.elapsedTime * 10) / 10;

  // Pause the timer immediately. The penalty is applied while the
  // clock is frozen so we don't race a tick.
  pauseTimer();
  state.modalPaused = true;

  // Compute info-value penalty BEFORE marking the strike cell so the
  // solver's "before" run sees the same board state the player saw.
  // Daily / weekly always use the centre cell as the first click.
  const fr = Math.floor(state.rows / 2);
  const fc = Math.floor(state.cols / 2);
  const priorStrikes = priorEvents.map(e => ({ row: e.row, col: e.col }));
  let infoValue = 0;
  try {
    const result = computeBombInfoValue(state.board, state.rows, state.cols, fr, fc, mineRow, mineCol, priorStrikes);
    infoValue = result.infoValue;
  } catch (err) {
    // The solver is robust on well-formed daily/weekly boards; if it
    // ever does throw we'd rather charge the base penalty than crash
    // the player's attempt.
    console.warn('computeBombInfoValue failed:', err && err.message);
    reportCaughtError('bomb-info-value', err);
  }
  // Ramped base penalty: the n-th strike's base is BOMB_PENALTY_BASE × (1 +
  // BOMB_PENALTY_RAMP × (n-1)) — 1st +3s, 2nd +4.5s, 3rd +6s, 4th +7.5s … The
  // first hit costs the standard base; each later one adds half a base on top,
  // so casual mine-popping is discouraged without clobbering a player who hits
  // a couple legitimately (the >30% anti-cheat handles brute-forcers). The
  // info-value term (the par-seconds the struck mine was anchoring) rides on
  // top, unchanged.
  const strikeNumber = priorHits + 1;
  const rampedBase = BOMB_PENALTY_BASE * (1 + BOMB_PENALTY_RAMP * (strikeNumber - 1));
  const penalty = Math.round((infoValue + rampedBase) * 10) / 10;
  const infoValueRounded = Math.round(infoValue * 10) / 10;

  // The strike verdict — computed from the board state the player SAW
  // (before the strike cell is marked below), flags-blind so a wrong
  // flag can't make the receipt lie. Three honest answers: the mine was
  // provable / safe moves existed elsewhere / genuinely at the frontier.
  let strikeVerdict = null;
  try {
    strikeVerdict = bombStrikeVerdict(state.board, mineRow, mineCol);
  } catch (err) {
    console.warn('bombStrikeVerdict failed:', err && err.message);
  }

  // Bump the per-attempt strike counter + append the event with its
  // penalty value. The penalty field is new in this mechanic; legacy
  // events (under the old +10s/re-fog mechanic) lack it, and the R
  // refit treats `bombHits > 0 && no penalty` as the legacy cohort.
  const event = { t: tClean, row: mineRow, col: mineCol, penalty, infoValue: infoValueRounded };
  if (isWeekly) {
    state.weeklyBombHits = priorHits + 1;
    if (!Array.isArray(state.weeklyBombHitEvents)) state.weeklyBombHitEvents = [];
    state.weeklyBombHitEvents.push(event);
  } else {
    state.dailyBombHits = priorHits + 1;
    if (!Array.isArray(state.dailyBombHitEvents)) state.dailyBombHitEvents = [];
    state.dailyBombHitEvents.push(event);
  }

  // Mark the hit cell as a strike. NO re-fog: every other revealed cell
  // stays revealed. The mine is preserved (we never call defuseMine):
  //   (a) Adjacent numbers don't drop — a "3" next to the strike stays
  //       a "3" because the mine is still there.
  //   (b) Strike counts as a flag for chordReveal (sums isFlagged ||
  //       isStrike), so chording around it works.
  //   (c) checkWin treats isMine cells as don't-need-to-reveal; win
  //       still requires every non-mine cell revealed.
  const hitCell = state.board[mineRow][mineCol];
  hitCell.isRevealed = true;
  hitCell.isStrike = true;

  // The penalty is NOT added to elapsedTime/preciseTime here. It lives in
  // the hit-event log (event.penalty, pushed above) and is folded into the
  // displayed time by getDisplayTime() and into the final time by
  // stopTimer(), both via getActiveBombPenaltyTotal(). Keeping the
  // wall-clock counters penalty-free is what lets the daily auto-save
  // round-trip without double-counting the penalty.

  // Safety net: tear down any active pressure-plate timers. Daily /
  // weekly don't currently use plates, but if they ever do a stale
  // per-cell interval could fire a spurious handleLoss after this hit.
  import('./gameActions.js').then(m => m.clearAllPlateTimers?.()).catch(err => reportCaughtError('plate-timer-teardown', err));

  // Effects
  playExplosion();
  triggerHeavyShake();
  showRedFlash();
  haptic([80, 30, 60]);

  // Update the displayed time NOW so the new total reads on screen
  // before any popup appears — without this the player sees the old
  // time during the popup and a jump when it closes, which reads as
  // "the clock ran while I was reading" even though it was paused.
  updateTimerDisplay();

  function finishBombHit() {
    state.modalPaused = false;
    resumeTimer();
    updateAllCells();
    updateHeader();
  }

  // First-time popup. Uses a NEW notice key so existing users who saw
  // the old "+10s · board re-fog" explainer still see the new
  // mechanic's explainer the first time they encounter it.
  if (!hasSeenNotice('bombhit_explainer_v2')) {
    markNoticeSeen('bombhit_explainer_v2');
    const modal = document.getElementById('bombhit-explainer');
    const okBtn = document.getElementById('bombhit-explainer-ok');
    // First hit gets its verdict inside the explainer (the per-hit popup
    // only shows from the second hit onward).
    const verdictEl = document.getElementById('bombhit-verdict');
    if (verdictEl) {
      if (strikeVerdict) {
        verdictEl.textContent = `This one: ${strikeVerdict.text.charAt(0).toLowerCase()}${strikeVerdict.text.slice(1)}.`;
        verdictEl.classList.remove('hidden');
      } else {
        verdictEl.classList.add('hidden');
      }
    }
    if (modal && okBtn) {
      // Cleanup must run no matter how the modal closes (button or
      // Escape) — observe the 'hidden' class transition.
      let done = false;
      let obs = null;
      const finishOnce = () => {
        if (done) return;
        done = true;
        if (obs) obs.disconnect();
        finishBombHit();
      };
      obs = new MutationObserver(() => {
        if (modal.classList.contains('hidden')) finishOnce();
      });
      obs.observe(modal, { attributes: true, attributeFilter: ['class'] });
      const fresh = okBtn.cloneNode(true);
      okBtn.parentNode.replaceChild(fresh, okBtn);
      fresh.addEventListener('click', () => hideModal('bombhit-explainer'), { once: true });
      showModal('bombhit-explainer');
      return;
    }
    // Modal element missing — fall through to the transient popup.
  }

  // Subsequent hits: brief centred popup showing the penalty breakdown
  // so the cost reads as principled, not arbitrary.
  const popup = document.createElement('div');
  popup.className = 'daily-bomb-popup';
  // Tier thresholds re-anchored 2026-06-09 for the pooled PAR_MODEL
  // scale (scripts/reanchor-bomb-tiers.mjs): quantile-matched against the
  // design-era four-coefficient pricing across all 60 canonical boards
  // (1,449 mines), so the Minor/Key/Critical label frequencies match what
  // the original 2/8/16 tuning intended. Key/Critical land at ~3.9%/~2.8%
  // of mines (designed: 3.6%/2.7%); Minor runs lower than designed
  // (8.1% vs 10.4%) because Pass-A-anchoring mines price 0 under the
  // pooled model by design.
  const bombLabel = infoValueRounded < 2   ? '' :
                    infoValueRounded < 6.5 ? ' · Minor mine' :
                    infoValueRounded < 13  ? ' · Key mine' :
                                            '! Critical mine';
  const verdictHtml = strikeVerdict
    ? `<div class="daily-bomb-verdict">${strikeVerdict.text}</div>` : '';
  popup.innerHTML = `<div class="daily-bomb-popup-content">${spriteImgHTML('strike', 'sprite-popup', 'Mine hit')} <span class="daily-bomb-penalty">+${penalty.toFixed(1)}s${bombLabel}</span>${verdictHtml}</div>`;
  document.getElementById('app').appendChild(popup);

  setTimeout(() => {
    popup.remove();
    finishBombHit();
  }, 2000);
}

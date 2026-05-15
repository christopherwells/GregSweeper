import { state, ENCOURAGEMENT_LINES } from '../state/gameState.js';
import { $, $$, boardEl, resetBtn, scanToast } from '../ui/domHelpers.js';
import { getThemeEmoji, updateAllCells, announceGame } from '../ui/boardRenderer.js';
import { applyIcon, spriteImgHTML } from '../ui/spriteLoader.js';
import { updateHeader, updateStreakBorder, updateCheckpointDisplay, getCheckpointForLevel } from '../ui/headerRenderer.js';
import { updatePowerUpBar } from '../ui/powerUpBar.js';
import { showModal } from '../ui/modalManager.js';
import {
  triggerHeavyShake, showRedFlash, showGreenFlash,
  haptic, chainRevealMines, showVictoryCelebration, showConfettiBurst,
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
import { submitOnlineScore, submitWeeklyScore, fetchWeeklyLeaderboard } from '../firebase/firebaseLeaderboard.js';

// Inline HTML-escape used in the weekly leaderboard rows so a player
// name with `<` or `&` doesn't break out of the cell.
function escapeHtmlInline(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
import { saveProgress, saveDailyHistoryEntry, getUid, markWeeklyDayAttempted } from '../firebase/firebaseProgress.js';
import { isTestEnvironment } from '../firebase/env.js';
import { breakdownPar } from '../logic/dailyFeatures.js';
import { getHandicap, estimateHandicapDetails } from '../logic/handicaps.js';
import { addDailyLeaderboardEntry, appendDailyResidual, loadDailyResiduals } from '../storage/statsStorage.js';
import { getLocalDateString } from '../logic/seededRandom.js';

// Weekly's first-attempt-of-the-week play is supposed to feed the
// par-model fit pool (honest first encounter, no memorisation
// advantage). Disabled while the weekly mode is still being shaken
// down — we don't want test plays with shifting rules to drag the
// model coefficients. Flip to true when the rules are stable.
const WEEKLY_FIT_DATA_ENABLED = false;

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

// ── Handle Win ─────────────────────────────────────────

export function handleWin() {
  state.status = 'won';
  stopTimer();
  announceGame('You won! Board cleared.');
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
  const isRealDaily = isDaily && !state.isDailyPractice;
  const stats = saveGameResult(true, state.elapsedTime, state.currentLevel, {
    isDaily: isRealDaily,
    usedPowerUps: state.usedPowerUps,
    gameMode: state.gameMode,
    hadGimmicks: state.activeGimmicks && state.activeGimmicks.length > 0,
    dailySeed: isRealDaily ? state.dailySeed : null,
  });
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
      submitWeeklyScore(state.weeklySeed, getUid(), playerName, bestTime, updated, {
        dayBombHits: updatedBombs,
        totalMoves,
      }).catch(() => {});

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
          }
        ).catch(() => {});
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
  }

  // 30% chance to earn a free lifeline on level completion (Challenge mode)
  if (state.gameMode === 'normal' && Math.random() < LIFELINE_WIN_REWARD_CHANCE) {
    state.powerUps.lifeline = (state.powerUps.lifeline || 0) + 1;
    saveModePowerUps(state.gameMode, state.powerUps);
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
  const strikesInfo = _strikes > 0
    ? ` | 💥 ${_strikes} strike${_strikes !== 1 ? 's' : ''}`
    : '';

  const parEl = $('#gameover-par');
  if (parEl) parEl.classList.add('hidden');
  const parBreakdownEl = $('#gameover-par-breakdown');
  if (parBreakdownEl) parBreakdownEl.classList.add('hidden');
  const historyDotsEl = document.getElementById('gameover-history-dots');
  if (historyDotsEl) historyDotsEl.classList.add('hidden');

  // Timed mode: show speed rating
  if (state.gameMode === 'timed') {
    const precise = state.preciseTime || state.elapsedTime;
    const rating = getSpeedRating(state.currentLevel, precise);
    gameoverTime.textContent = `Time: ${precise.toFixed(1)}s — ${rating.icon} ${rating.name}!`;
  } else if (state.gameMode === 'daily') {
    // Daily: show precise time + par comparison
    const precise = state.preciseTime || state.elapsedTime;
    gameoverTime.textContent = `Time: ${precise.toFixed(1)}s${strikesInfo}`;
    const { streak } = getDailyStreak();
    if (streak > 0) {
      gameoverTime.textContent += ` | \u{1F525} ${streak} day streak`;
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
      appendDailyResidual({
        date: state.dailySeed,
        time: precise,
        par: state.dailyPar,
        bombHits: state.dailyBombHits || 0,
      });

      // Handicap resolution: prefer the refit value from handicaps.json
      // (set by the nightly Bayesian fit once the user crosses
      // MIN_PLAYS_FOR_FIT_INCLUSION=30 plays). If the refit hasn't
      // included this user yet, fall back to the client-side mean
      // residual across at least 2 local plays so newcomers see a
      // "Your par" line that tightens with each daily instead of
      // staring at "Greg's Time" alone for a month.
      const refitHandicap = getHandicap(getUid());
      let handicap = refitHandicap;
      let provisional = null;
      if (refitHandicap === 0) {
        const residuals = loadDailyResiduals();
        // Pass bombHits per residual so the provisional handicap subtracts
        // secPerBombHit × bombHits before averaging. Older residuals
        // (pre-schema-bump) lack the field — defaults to 0 inside
        // estimateHandicapDetails.
        const pairs = residuals.map(r => ({
          time: r.time,
          predictedPar: r.par,
          bombHits: r.bombHits || 0,
        }));
        const est = estimateHandicapDetails(pairs);
        if (est) {
          handicap = est.handicap;
          provisional = est;
        }
      }
      const personalPar = state.dailyPar + handicap;
      const referencePar = handicap !== 0 ? personalPar : state.dailyPar;
      const delta = precise - referencePar;
      const absDelta = Math.abs(delta).toFixed(1);
      let parClass, deltaText;
      if (delta < -0.5) {
        parClass = 'par-under';
        deltaText = absDelta + 's under ' + (handicap !== 0 ? 'your par' : 'par');
      } else if (delta > 0.5) {
        parClass = 'par-over';
        deltaText = absDelta + 's over ' + (handicap !== 0 ? 'your par' : 'par');
      } else {
        parClass = 'par-even';
        deltaText = handicap !== 0 ? 'Even with your par!' : 'Even par!';
      }

      // Provisional handicaps carry a "(based on N plays)" qualifier so
      // the player understands the number will tighten with more data,
      // and so we don't pretend a 2-play mean is anywhere near as
      // trustworthy as a 30-play Bayesian random intercept.
      const yourParLabel = provisional
        ? 'Your par (provisional, ' + provisional.n + ' plays): '
        : 'Your par: ';

      if (handicap !== 0) {
        parEl.innerHTML =
          "Greg's Time: " + state.dailyPar.toFixed(1) + 's · ' +
          yourParLabel + personalPar.toFixed(1) + 's — ' +
          '<span class="' + parClass + '">' + deltaText + '</span>';
      } else {
        // No handicap yet — surface a small hint about what would
        // unlock one so a brand-new player (1 daily complete) doesn't
        // think the system is just ignoring them.
        const residuals = loadDailyResiduals();
        const needHint = residuals.length === 1
          ? ' <span class="par-hint">· 1 more daily and your personal par appears</span>'
          : '';
        parEl.innerHTML =
          "Greg's Time: " + state.dailyPar.toFixed(1) + 's — ' +
          '<span class="' + parClass + '">' + deltaText + '</span>' + needHint;
      }
      parEl.classList.remove('hidden');

      // Per-feature breakdown of what drove Greg's par. Only shown when
      // state.dailyFeatures is populated (older resumed games may have
      // been persisted before features existed).
      if (parBreakdownEl && state.dailyFeatures) {
        const terms = breakdownPar(state.dailyFeatures);
        if (terms.length > 0) {
          parBreakdownEl.innerHTML = terms
            .map(t => '<span class="par-term">+' + t.seconds + 's ' + t.label + '</span>')
            .join('<span class="par-term-sep"> · </span>');
          parBreakdownEl.classList.remove('hidden');
        }
      }
      // 7-dot history strip — at-a-glance look at the player's recent
      // trajectory. Today's just-played dot is the rightmost; older
      // days fall off the left edge. Reads localStorage residuals
      // (just-appended above) so it's instant and works offline.
      _renderWinModalHistoryDots(state.dailySeed);
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
      summary = `<span class="par-even">First attempt this week — set the bar at ${precise.toFixed(1)}s.</span>`;
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
            `<span class="weekly-lb-name">${escapeHtmlInline(r.name)}</span>` +
            `<span class="weekly-lb-time">${r.bestTime.toFixed(1)}s</span>` +
            `<span class="weekly-lb-attempts">${r.attemptsUsed}/7</span>` +
          `</div>`
        ).join('');
        const myRank = myIdx >= 0 ? myIdx + 1 : null;
        const header = myRank
          ? `Rank #${myRank} of ${rows.length}`
          : `${rows.length} player${rows.length !== 1 ? 's' : ''} this week`;
        el.innerHTML = `<div class="weekly-leaderboard-header">${header}</div>${rowsHtml}`;
      }).catch(() => {});
    }
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
    if (savedName) {
      // Auto-submit with saved name
      dailySubmitForm.classList.add('hidden');
      const dateStr = getLocalDateString();
      const scoreTime = Math.round((state.preciseTime || state.elapsedTime) * 10) / 10;
      addDailyLeaderboardEntry(dateStr, savedName, scoreTime);
      // CRITICAL: this auto-submit path (used whenever the player has a
      // saved name) MUST stay in sync with the manual-submit path in
      // main.js. Both need to include bombHitEvents and rngSeed —
      // missing either of those fields drops the experimental-design
      // and bomb-adjusted-model data streams silently.
      submitOnlineScore(dateStr, savedName, scoreTime, state.dailyBombHits || 0, {
        uid: getUid(),
        par: state.dailyPar,
        features: state.dailyFeatures,
        bombHitEvents: state.dailyBombHitEvents || [],
        rngSeed: state.dailyRngSeed || dateStr,
      });
      // Per-user daily-history timeline feeds the leaderboard-modal chart.
      // Skip for practice dailies — they play on a custom seed and don't
      // belong on the player's regular history timeline.
      if (!state.isDailyPractice) {
        saveDailyHistoryEntry(dateStr, { time: scoreTime });
      }
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

  // Find what the solver says was the correct next move
  const suggestedMove = findNextSafeMove(state.board);
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

// ── Daily / Weekly Mode: Bomb Hit Re-Fog ────────────────
// Same mechanic for both modes: +10s penalty, all non-mine reveals
// re-fog, hit mine becomes a defused safe cell. Per-attempt counters
// route to dailyBombHits/dailyBombHitEvents in daily, or
// weeklyBombHits/weeklyBombHitEvents in weekly. Function name kept
// as handleDailyBombHit for backward-compat with all the call sites.

export function handleDailyBombHit(mineRow, mineCol) {
  const isWeekly = state.gameMode === 'weekly';

  // Capture priorHits BEFORE incrementing so the per-event `t` stamp is
  // accurate. The previous version stamped `t = state.elapsedTime` after
  // prior strikes had already added their +10s penalties, so the 3rd
  // hit's `t` read ~30s later than wall-clock truth. Subtracting
  // 10 * priorHits gives the clean precise-timer value at the moment of
  // the actual hit — unblocks the future bomb-adjusted per-play model.
  const priorHits = isWeekly ? (state.weeklyBombHits || 0) : (state.dailyBombHits || 0);
  const tClean = Math.round((state.elapsedTime - 10 * priorHits) * 10) / 10;

  // Bump the per-attempt strike counter for whichever mode owns this
  // attempt. Also append to the per-hit event log so a future bomb-
  // adjusted refit can reconstruct what the player saw for free.
  if (isWeekly) {
    state.weeklyBombHits = priorHits + 1;
    if (!Array.isArray(state.weeklyBombHitEvents)) state.weeklyBombHitEvents = [];
    state.weeklyBombHitEvents.push({ t: tClean, row: mineRow, col: mineCol });
  } else {
    state.dailyBombHits = priorHits + 1;
    if (!Array.isArray(state.dailyBombHitEvents)) state.dailyBombHitEvents = [];
    state.dailyBombHitEvents.push({ t: tClean, row: mineRow, col: mineCol });
  }

  // Time penalty: +10s per strike
  state.elapsedTime += 10;

  // Defuse the hit mine so it won't kill again. defuseMine also refreshes
  // gimmick displays (wormhole sums, liar offsets, mirror swaps, sonar,
  // compass) AND recalculates adjacent-mine counts in the 3x3 area, so
  // surrounding revealed numbers automatically reflect the new layout.
  defuseMine(state.board, mineRow, mineCol);
  const hitCell = state.board[mineRow][mineCol];
  hitCell.isRevealed = true;
  // Clear isLocked on the defused cell. defuseMine flips isMine=false but
  // leaves isLocked alone; without this, the cell still counts as
  // non-startable in startCandidates and as locked in solver paths,
  // even though it's now a revealed safe value.
  hitCell.isLocked = false;
  // Mark the hit spot so the renderer keeps showing the strike sprite —
  // the player gets a permanent "here's where the bomb went off" marker
  // instead of just a re-numbered cell.
  hitCell.isStrike = true;
  state.revealedCount++;
  state.totalMines--;

  // Safety net: tear down any active pressure-plate timers. Daily/weekly
  // don't currently include plates in their gimmick subset, but if a
  // future change ever does, stale per-cell intervals could fire a
  // spurious handleLoss after the mid-attempt mine removal.
  // Dynamic import to avoid a top-level circular dependency with
  // gameActions.js (which imports handleDailyBombHit from this file).
  import('./gameActions.js').then(m => m.clearAllPlateTimers?.()).catch(() => {});

  // Re-fog every revealed cell EXCEPT mines (still unrevealed) and
  // strike cells (defused-bomb markers from prior hits + the just-hit
  // one — these stay visible so the player can see where the bombs
  // were). This is the classic daily/weekly bomb behavior: +10s
  // penalty + board reset + adjacent numbers (now hidden) recalculated
  // so the next reveal reflects one fewer mine in the neighbourhood.
  // Without the re-fog, chord-reveal on a strike cell could cascade
  // into an unrevealed mine — the "click an already exploded mine for
  // more penalty" footgun. handleChordReveal also blocks chord on
  // strike cells as belt-and-suspenders.
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      const cell = state.board[r][c];
      if (cell.isRevealed && !cell.isMine && !cell.isStrike) {
        cell.isRevealed = false;
        cell.isHiddenNumber = false;
      }
    }
  }
  // revealedCount now equals the number of strike cells on the board
  // (one per bomb hit so far this attempt, including this one).
  state.revealedCount = isWeekly
    ? (state.weeklyBombHits || 0)
    : (state.dailyBombHits || 0);

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
  const strikes = isWeekly ? state.weeklyBombHits : state.dailyBombHits;
  popup.innerHTML = `<div class="daily-bomb-popup-content">${spriteImgHTML('strike', 'sprite-popup', 'Mine hit')} You hit a mine!<br><span class="daily-bomb-sub">+10s · Board reset · Mine defused at that spot</span></div>`;
  document.getElementById('app').appendChild(popup);

  setTimeout(() => {
    popup.remove();
    state.elapsedTime = Math.floor(state.elapsedTime);
    resumeTimer();
    updateAllCells();
    updateHeader();
  }, 2000);
}

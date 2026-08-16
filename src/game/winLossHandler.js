import { state, ENCOURAGEMENT_LINES, getActiveBombPenaltyTotal, ownsSaveSlot } from '../state/gameState.js';
import { $, $$, boardEl, resetBtn, scanToast, escapeHtml } from '../ui/domHelpers.js';
import { getThemeEmoji, updateAllCells, announceGame } from '../ui/boardRenderer.js';
import { applyIcon, spriteImgHTML, achievementSpriteImgHTML, uiSpriteImgHTML } from '../ui/spriteLoader.js';
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
import { findNextSafeMove, gradeGimmickContribution, checkWin } from '../logic/boardSolver.js';
// Leaf module (imports nothing): the tiling-center fallback in
// liveBoardOpener re-derives a local-gen tiling board's opener from its
// own _tiling descriptor.
import { buildTiling } from '../logic/tilingGeometry.js';
import { extractCrux } from '../logic/cruxExtract.js';
import { prepareLossReceipt, bombStrikeVerdict } from '../ui/receiptRenderer.js';
import { computeBombInfoValue } from '../logic/bombInfoValue.js';
import { getChaosDifficulty, BOMB_PENALTY_BASE, BOMB_PENALTY_RAMP } from '../logic/difficulty.js';
import { matchAdvance, matchTotals, needsTenths, fmtClock } from '../logic/matchRules.js';
import { tilingLabel, CLASSIC_SHAPE_LABEL } from '../logic/coastlineLink.js';
import { powerUpAwardCount, LIFELINE_BONUS_CHANCE } from '../logic/challenge250.js';
import {
  loadStats, saveGameResult, saveModePowerUps, clearGameState,
  markDailyCompleted, unlockDailyReplay, getDailyStreak, getPlayerName,
  hasSeenNotice, markNoticeSeen, consumeMoltEvent, flagMoltCelebrate,
} from '../storage/statsStorage.js';
import { safeSetJSON } from '../storage/storageAdapter.js';
import {
  playExplosion, playWin,
} from '../audio/sounds.js';
import {
  checkNewUnlocks, getHighestTier, getTotalScore,
  getAchievementState, getAllTierNames, getTierIcon, getTierColor,
} from '../logic/achievements.js';
import { checkThemeUnlocks, showThemeUnlockToasts } from '../ui/themeManager.js';
import { submitOnlineScore, submitArchiveScore, submitWeeklyScore, fetchWeeklyLeaderboard, fetchOnlineLeaderboard, submitMatchFitRows } from '../firebase/firebaseLeaderboard.js';
import { dailyStanding } from '../logic/leaderboardViews.js';
import { getHandicapRatioMap } from '../logic/handicaps.js';
import { matchFitRows, MATCH_FIT_MIN_TIME } from '../logic/matchStandings.js';

// (HTML escaping for the weekly leaderboard rows now comes from
// ui/domHelpers.js's escapeHtml, single source of truth.)
import { saveProgress, saveDailyHistoryEntry, fetchDailyHistoryEntry, getUid, markWeeklyDayAttempted, markWeeklyCompleted } from '../firebase/firebaseProgress.js';
import { deserializeBoard } from '../firebase/dailyBoardSync.js';
import { archiveSubmitPlan, CRUX_VIEWED_KEY_PREFIX } from '../logic/archiveEligibility.js';
import { gameoverModalPlan } from '../logic/gameoverPlan.js';
import { isTestEnvironment } from '../firebase/env.js';
import { reportCaughtError } from '../diagnostics/errorReporter.js';
import { getHandicapRatio, getHandicapDetails, isRatedHandicap } from '../logic/handicaps.js';
import { resolveParDisplay } from '../logic/parDisplayDecision.js';
import { buildDailyScoreExtras } from '../logic/winSubmissionPlan.js';
import { detectSkillFeats } from '../logic/skillFeatDetection.js';
import { summarizeWeeklyAttempt } from '../logic/weeklyAttemptSummary.js';
import { ensureLeaderboardName } from '../ui/nameCapture.js';
import { addDailyLeaderboardEntry, appendDailyResidual, loadDailyResiduals, loadPowerUps, recordWeeklyCompletion, getWeekStreakRecord } from '../storage/statsStorage.js';
import { weekRangeLabel } from '../logic/weeklyProgress.js';
import { getLocalDateString } from '../logic/seededRandom.js';

// Weekly's first-attempt-of-the-week play feeds the par-model fit pool: an
// honest first encounter with no memorisation advantage, which is exactly the
// observation the daily supplies and the reason days 2-7 are excluded.
//
// ENABLED 2026-08-04 (his call: "get the weeklies in to the par model"). It
// shipped false in v1.6 as a deliberate hold while the weekly's rules were
// still moving, gimmick count, bomb handling and the end screen all changed
// after launch, and half-baked inputs would have dragged the coefficients.
// The rules have been stable for two months; the flag outlived its
// reason, and fourteen weeks of real completions went unrecorded because of
// it. The history is recoverable and was recovered separately
// (scripts/backfill-weekly-fit-rows.mjs).
const WEEKLY_FIT_DATA_ENABLED = true;

// End a game by dropping ITS OWN save, never someone else's. An archive
// replay and a ?level= / coastline practice run borrow a live mode's name and
// share its storage key without owning it, so ending one must leave that key
// alone, the mirror of persistGameState's guard, which is the half that was
// there. Unguarded, winning a past daily deleted the real daily in progress
// (issue #247). These lanes never persist, so there is nothing of their own
// to clean up and skipping the clear leaves nothing behind.
function _clearOwnSave() {
  if (!ownsSaveSlot(state)) return;
  clearGameState(state.gameMode);
}

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

// Render the shareable card IMAGE (Wave D): a themed PNG with the real
// sprites, painted into the preview and stashed as a File for Web Share.
// Lazy-loaded (only needed on a win); on failure the preview hides and
// the text card remains the share fallback.
function renderShareCardPreview() {
  const preview = $('#share-card-preview');
  if (!preview) return;
  preview.classList.remove('hidden');
  import('../ui/shareCardImage.js')
    .then((m) => m.prepareShareCard(state, preview))
    .catch(() => { preview.classList.add('hidden'); });
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
  // differs from today, e.g., a late-night submit just after midnight).
  const dots = [];
  // Fallback anchors to the ET clock like every other daily surface, the
  // UTC ISO date is a different calendar day from 8pm ET onward.
  const baseDate = todayDate || getLocalDateString();
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

// ── The live board's certified opener ──────────────────
// The anchor the play path solved from, as a flat index (issue #201, the
// #195 class). A canonical daily/weekly board's opener comes from
// deserializeBoard, the ONE definition: stored firstClick on a tiling,
// container center on every rectangle, read back here from the same raw
// payload newGame consumed (the today-stash, the weekly stash, or the
// archive stash). The win receipt and the bomb strike pricing below used
// to re-derive floor(rows/2), floor(cols/2), which on a tiling canonical
// is an unrelated container slot where the solve stalls at click 1: the
// receipt would confess a breather on a board with a real crux, and every
// strike's info-value, which rides into the SUBMITTED time, would come
// off the failed solve. A RECTANGULAR board with no matching canonical
// (local-gen fallback, practice ?seed=, Climb or match deals) was generated
// around the container center, which stays its opener, and a rectangular
// canonical stores no firstClick, so deserializeBoard returns the center
// there too: byte-identical on every rectangular board either way. A
// TILING board with no canonical (the shape rotation's local-gen fallback,
// or a ?dailyShape= practice run) re-derives its opener from its own
// _tiling descriptor below, buildTiling's centerIndex is exact integer
// lattice arithmetic and is what generateTilingBoard anchored this very
// board on, so within a session (and across its saves, which restore
// _tiling) the derivation reproduces the generation anchor exactly.
export function liveBoardOpener() {
  const center = Math.floor(state.rows / 2) * state.cols + Math.floor(state.cols / 2);
  const tilingCenter = () => {
    const t = state.board && state.board._tiling;
    if (!t || !t.type) return center;
    try {
      return buildTiling(t.type, t.M, t.N).centerIndex;
    } catch { return center; }
  };
  let raw = null;
  if (state.gameMode === 'daily' && !state.isDailyPractice) {
    // An archive replay is dated in the PAST; the calendar's fetch lives in the
    // archive stash and must never be confused with the today-stash.
    raw = state.isArchivePlay
      ? (state._archiveRaw && state._archiveRaw.date === state.dailySeed
          ? state._archiveRaw.raw : null)
      : (state.canonicalDailyBoard && state.canonicalDailyBoard.date === state.dailySeed
          ? state.canonicalDailyBoard.raw : null);
  } else if (state.gameMode === 'weekly') {
    raw = state.canonicalWeeklyBoard && state.canonicalWeeklyBoard.weekStart === state.weeklySeed
      ? state.canonicalWeeklyBoard.raw : null;
  }
  if (!raw) return tilingCenter();
  try {
    const d = deserializeBoard(raw);
    // The stash can outlive a failed adoption (deserialize threw in newGame
    // and local generation took over): only trust an opener that describes
    // the container actually in play.
    if (d.rows === state.rows && d.cols === state.cols) return d.firstClick;
  } catch { /* corrupt canonical, the play path fell back to local gen too */ }
  return tilingCenter();
}

// ── Win receipt: the board's confession ────────────────
// One line on the daily/weekly win modal naming (a) the board's crux,
// the first deduction trivial propagation couldn't reach, and (b) the
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

// Exported for the headless call-test (canonicalOpenerResiduals), the
// receipt's false-breather claim is only observable through the render.
export function _renderWinReceipt() {
  const el = $('#gameover-receipt');
  if (!el) return;
  el.classList.add('hidden');
  el.onclick = null;
  const board = state.board;
  const rows = state.rows, cols = state.cols;
  // The certified opener, never the container center (issue #201): a
  // center-anchored solve stalls on a tiling canonical, extractCrux
  // returns null, and the receipt calls a real crux board a breather.
  const opener = liveBoardOpener();
  const fr = Math.floor(opener / cols), fc = opener % cols;
  setTimeout(() => {
    try {
      // The solver simulates in its own arrays, live revealed state is
      // untouched (and cleanSolverArtifacts must NOT run here: it would
      // wipe cell.isRevealed on the live, fully-revealed board).
      // extractCrux is the SAME crux finder the daily teaser uses, so the
      // receipt and the teaser can never disagree about the crux square.
      const crux = extractCrux(board, rows, cols, fr, fc);
      const parts = [];
      let cruxJump = null;
      if (crux) {
        // Coordinates mean nothing to a player; take them THERE instead.
        // Tapping the line closes the modal, pulses the crux square and
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
 * touched here, those are gated off upstream by isArchivePlay.
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
      ? "Couldn't reach the server, so this run wasn't recorded."
      : 'Your first run on this day is already recorded.');
    return;
  }
  if (plan.submitFit) {
    let cruxViewed = false;
    try { cruxViewed = localStorage.getItem(CRUX_VIEWED_KEY_PREFIX + dateStr) === '1'; }
    catch { /* storage unavailable, treat as not viewed */ }
    await submitArchiveScore(dateStr, name, scoreTime, state.dailyBombHits || 0, {
      uid: getUid(),
      par: state.dailyPar,
      features: state.dailyFeatures,
      bombHitEvents: state.dailyBombHitEvents || [],
      rngSeed: state.dailyRngSeed || dateStr,
      totalMines: state.totalMines,
      cruxViewed,
    });
  }
  // dailyHistory is durable (its own retry queue), so the completion and the
  // delta-chart entry survive even if the fit-row upload failed. The archive
  // marker keeps the row out of the streak derivation (issue #113): the date
  // still marks the calendar and feeds the chart, but a replayed gap day must
  // never retroactively extend the streak.
  if (plan.writeHistory) {
    saveDailyHistoryEntry(dateStr, { time: scoreTime, archive: true });
  }
  showToast('Archive run recorded.');
}

// Apply a gameoverModalPlan: one complete show/hide pass over every optional
// section of the shared #gameover-overlay, so no render path can leak a
// previous game's content (the stale-weekly-leaderboard / missing-retry
// class, see gameoverPlan.js). Handlers unhide their data-dependent
// sections AFTER this baseline.
function _applyGameoverPlan(plan) {
  for (const [id, visible] of Object.entries(plan)) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !visible);
  }
}

// Render the end-of-match summary into #match-summary: one row per board
// (final clock + strikes), the raw total, and the adjusted total (time / k,
// rankAdjusted's own convention) when this player carries a rating. His
// adjusted-only ruling is about COMPARISON, which is the next PR's
// head-to-head breakdown; a solo summary still shows the literal clock,
// with the adjusted line beneath it wherever a rating exists.
function _renderMatchSummary() {
  const el = document.getElementById('match-summary');
  if (!el || !state.match) return;
  const results = (state.match.results || []).filter(Boolean);
  const entries = state.match.entries || [];
  const uid = getUid();
  const rated = isRatedHandicap(uid);
  const k = rated ? getHandicapRatio(uid) : null;
  const totals = matchTotals(results, k);

  // The solo end board wears the shared end board's own clothes (his ask
  // 2026-08-16: time, adjusted, strikes and par per board, "more like the
  // other one"): the match-grid table, board labels LEFT with the shape,
  // metric columns instead of player columns, Total/Adjusted/Par rows in
  // the tfoot. The adjusted column exists only for a rated player, the
  // panel's standing rule, and an adjusted time under the board's par
  // takes the leader green: on a solo run the opponent is Greg.
  const shapeOf = (i) => {
    const s = entries[i] && entries[i].spec && entries[i].spec.shape;
    return !s || s === 'rect' ? CLASSIC_SHAPE_LABEL : (tilingLabel(s) || s);
  };
  const parOf = (i) => {
    const p = (results[i] && results[i].par) || (entries[i] && entries[i].par);
    return Number.isFinite(p) && p > 0 ? p : null;
  };
  const adjOf = (r) => (k ? Math.round((r.time / k) * 10) / 10 : r.time);

  const headerCells = `<th>Time</th>${rated ? '<th>Adjusted</th>' : ''}<th>Strikes</th><th>Par</th>`;
  // Rows keep their ORIGINAL index (a filter would silently misalign shape
  // and par past any hole in the results array).
  const played = (state.match.results || [])
    .map((r, i) => ({ r, i })).filter((x) => x.r);
  const bodyRows = played.map(({ r, i }) => {
    const par = parOf(i);
    const adj = adjOf(r);
    const beatPar = par != null && adj < par;
    const compareCell = rated
      ? `<td class="${beatPar ? 'match-grid-lead' : ''}">${adj.toFixed(1)}</td>`
      : '';
    const timeCell = rated
      ? `<td>${r.time.toFixed(1)}</td>`
      : `<td class="${beatPar ? 'match-grid-lead' : ''}">${r.time.toFixed(1)}</td>`;
    return `<tr><th scope="row" class="match-grid-board">${i + 1} · ${shapeOf(i)}</th>`
      + timeCell + compareCell
      + `<td class="${r.strikes > 0 ? '' : 'match-grid-none'}">${r.strikes > 0 ? r.strikes : '·'}</td>`
      + `<td>${par != null ? Math.round(par) : '·'}</td></tr>`;
  }).join('');

  const parTotal = played.reduce((a, { i }) => (parOf(i) != null ? a + parOf(i) : a), 0);
  const tenths = needsTenths([totals.raw, totals.adjusted ?? totals.raw, parTotal || totals.raw]);
  const totalRow = `<tr><th scope="row" class="match-grid-board">Total</th>`
    + `<td>${fmtClock(totals.raw, tenths)}</td>${rated ? '<td></td>' : ''}<td></td><td></td></tr>`;
  const adjRow = totals.adjusted != null
    ? `<tr><th scope="row" class="match-grid-board">Adjusted</th><td></td>`
      + `<td>${fmtClock(totals.adjusted, tenths)}</td><td></td><td></td></tr>`
    : '';
  const parRow = parTotal > 0
    ? `<tr><th scope="row" class="match-grid-board">Par</th><td></td>${rated ? '<td></td>' : ''}<td></td>`
      + `<td>${fmtClock(parTotal, tenths)}</td></tr>`
    : '';
  el.innerHTML = `<div class="match-grid-wrap"><table class="match-grid">
      <thead><tr><th class="match-grid-board"></th>${headerCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
      <tfoot>${totalRow}${adjRow}${parRow}</tfoot>
    </table></div>`;
  el.classList.remove('hidden');

  // A SHARED match also shows where everyone stands, live. The panel owns its
  // own subscription and markup (ui/matchLobby.js) so this handler stays out
  // of the Firebase listener business; it decides only whether to show one.
  const board = document.getElementById('match-standings');
  if (board && state.match.id) {
    import('../ui/matchLobby.js')
      .then((m) => m.renderMatchStandingsInto(board, state.match.id))
      .catch((err) => reportCaughtError('match-standings-render', err));
  } else if (board) {
    board.classList.add('hidden');
  }
}

/**
 * Everything a finished match run owes the world, once.
 *
 * FILED ONCE, and the `filed` marker is why. handleWin can run more than once
 * against the same completed match (a restored save re-rendering its card, a
 * summary reopened), and while the submit path dedupes per (uid, board key) on
 * a read that fails OPEN, a flag costs nothing and does not depend on a
 * network read behaving.
 *
 * Par-fit rows go from EVERY match, solo or shared. The offset the refit
 * fits describes the FRAME (a run of boards back to back, no daily ritual
 * around it), and solo and shared runs share that frame exactly; holding solo
 * rows back would throw away most of the data for no measured reason. A pinned
 * practice board is the one exception, as it is for every other mode.
 */
function _finishMatchRun() {
  const m = state.match;
  if (!m || m.filed) return;
  m.filed = true;
  if (state.isLevelPractice) return;

  const uid = getUid();
  const name = (getPlayerName() || '').slice(0, 20).trim();
  const { rows, tooFast } = matchFitRows(m.entries, m.results);
  if (tooFast > 0) {
    // Visible rather than silent: these are boards cleared under the daily row
    // family's five-second floor. Rare by construction, and a change in how
    // often it happens is worth being able to see.
    console.warn(`match: ${tooFast} board(s) cleared under the ${MATCH_FIT_MIN_TIME}s fit floor, not filed`);
  }
  if (rows.length > 0 && uid && name) {
    submitMatchFitRows(rows, name, uid)
      .catch((err) => reportCaughtError('match-fit-submit', err));
  }
  if (m.id) {
    import('../firebase/firebaseMatch.js')
      .then((mod) => mod.finishMatch(m.id))
      .catch((err) => reportCaughtError('match-finish', err));
  }
}

// ── Handle Win ─────────────────────────────────────────

export async function handleWin() {
  state.status = 'won';
  stopTimer();
  announceGame('You won! Board cleared.');
  // Baseline visibility for every optional modal section (complete map).
  // Data-dependent sections (par, record, unlocks, dots, receipt...) are
  // unhidden below once their content actually renders.
  _applyGameoverPlan(gameoverModalPlan('win', state.gameMode));
  applyIcon(resetBtn, 'smileyWin', getThemeEmoji('smileyWin'), { sizeClass: 'sprite-smiley' });
  resetBtn.classList.add('smiley-win-bounce');
  setTimeout(() => resetBtn.classList.remove('smiley-win-bounce'), 800);

  // Name gate: daily / weekly / match wins put a name in front of other
  // people, so require a handle BEFORE anything submits or the end card
  // renders (weekly used to drop a nameless win silently, the old Quick Play
  // posted "Anonymous", and the daily's inline form was dismissible). MATCH
  // joined the set with the match node: a match board files a par-fit row
  // under this name, and a shared match shows it in the standings every other
  // player watches. Resolves immediately when a name is already saved or the
  // mode isn't gated; awaited so every submission below sees the name.
  // Fire-and-forget callers don't await handleWin, and state.status/stopTimer
  // already ran synchronously above, so awaiting here is safe.
  // (state.isArchivePlay is only meaningful in daily mode.)
  await ensureLeaderboardName(state.gameMode, {
    // Either archive lane: neither posts to a leaderboard, so neither has a
    // name to demand.
    isArchive: !!state.isArchivePlay || !!state.isWeeklyArchive,
    // A pinned practice board (?seed=, ?matchboard=) records nothing anywhere,
    // so it has no name to demand either.
    isPractice: !!state.isDailyPractice || !!state.isLevelPractice,
  });

  const prevStats = loadStats();
  const prevMaxLevel = prevStats.maxLevelReached || 1;

  const isDaily = state.gameMode === 'daily';
  const isWeekly = state.gameMode === 'weekly';
  // Practice daily (URL ?seed=custom) plays like a daily but must not touch
  // stats, streak, completion flags, or personal history, it exists for
  // replaying after today's real daily has already been won. Weekly is its
  // own world entirely, see the dedicated weekly branch below.
  // Archive replay: a PAST daily relaunched from the calendar. It looks like
  // a daily (board, par, features) but must never touch streak, completion,
  // or the residual cache, and it submits to dailyArchive/ instead of daily/.
  // It DOES earn one fit row on first completion (the submit block below).
  const isArchivePlay = isDaily && !!state.isArchivePlay;
  const isRealDaily = isDaily && !state.isDailyPractice && !isArchivePlay;
  // Skill feats, honestly detectable from the click timeline + the board's
  // certified solve (flagless / efficient / search / liar), never heuristics;
  // chaos earns nothing. The certifiedClicks invariant and the feature/mode
  // gating live in (and are node-tested at) src/logic/skillFeatDetection.js.
  const skillFeats = detectSkillFeats(state);
  const stats = saveGameResult(true, state.elapsedTime, state.currentLevel, {
    isDaily: isRealDaily,
    isArchive: isArchivePlay,
    isPractice: isDaily && !!state.isDailyPractice,
    isLevelPractice: !!state.isLevelPractice,
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
      // A cover saved the streak, a quiet inline confirmation here.
      moltNote = `<span class="molt-note">${uiSpriteImgHTML('uiMolt', 'molt-inline')} Molt day covered ${_coveredPhrase(moltEvent.coveredDates)}. Streak intact at ${moltEvent.streakKept}.</span><br>`;
    } else if (moltEvent.earned && isRealDaily) {
      // Earning one is a milestone, flag the celebratory popup + the crab
      // placement animation that play when the player lands back on the title.
      flagMoltCelebrate();
    }
  }

  // Skip power-up awarding for chaos AND weekly. Weekly is a pure
  // time-trial against a fixed board, power-ups would let later-week
  // attempts cheese the leaderboard against earlier days. On the
  // Challenge 250 ladder the award COUNT is banded by level (his ruling:
  // 1 through L100, 2 through L250, 3 in the endless zone), a
  // guaranteed award per win, not a probability.
  let earnedPowerUp = null;
  if (state.gameMode !== 'chaos' && state.gameMode !== 'weekly' && !state.isLevelPractice) {
    const count = state.gameMode === 'normal' ? powerUpAwardCount(state.currentLevel) : 0;
    earnedPowerUp = count > 0 ? awardPowerUps(stats, count) : null;
    // Bonus lifeline on top of the banded award (his 33% ruling). Rolled
    // here rather than in awardPowerUps so the banded count stays a
    // clean guarantee and the bonus reads as a bonus in the win copy.
    if (state.gameMode === 'normal' && Math.random() < LIFELINE_BONUS_CHANCE) {
      state.powerUps.lifeline = (state.powerUps.lifeline || 0) + 1;
      const bonus = `${uiSpriteImgHTML('powLifeline', 'inline-pu')} Lifeline`;
      earnedPowerUp = earnedPowerUp ? `${earnedPowerUp} + ${bonus}` : bonus;
    }
  }

  // Sync progress to cloud (fire-and-forget). Never from a ?level=
  // playtest run, its wins are not progression.
  if (state.gameMode === 'normal' && !state.isLevelPractice) {
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

  // Mark daily as completed so it cannot be replayed today. The board's
  // effective seed rides along, because the lock's real question is "has this
  // account finished TODAY'S board" and the date alone cannot answer it, a
  // client that missed the canonical completes a different board on the same
  // date. Same expression the score row uses (buildDailyScoreExtras), so the
  // local record and the submitted row can never name different boards.
  if (isRealDaily && state.dailySeed) {
    markDailyCompleted(state.dailySeed, state.dailyRngSeed || state.dailySeed);
  }

  // Weekly mode win: mark this day's attempt cloud-synced, update the
  // weeklyDayTimes map, submit to the weekly leaderboard, and (only on
  // the player's FIRST attempt this week) submit a synthetic-daily row
  // to daily/{weekStart}_weekly_first so the par-model fit gets honest
  // first-encounter timing data.
  // A past-weekly replay is walled off from the whole block below: no attempt
  // marked, no leaderboard row, no fit row, no streak. It is the weekly's
  // version of an archive daily, and the same rule applies, the week it
  // belongs to is over, and its record is already written.
  if (isWeekly && !state.isWeeklyArchive && state.weeklySeed != null && state.weeklyDay != null) {
    // The week streak: one completion banks the week (his rule, "only need to
    // play one of the weekly"), so this is idempotent across the week's seven
    // attempts and the later ones land on the week already banked.
    const banked = recordWeeklyCompletion(state.weeklySeed);
    // Read the payload back rather than re-shaping the return value: the
    // self-heal in main.js pushes the same node, and one definition of the
    // shape is what keeps the two writers from disagreeing (issue #248).
    saveProgress({ weekStreak: getWeekStreakRecord() });
    // The per-week completion record, the fact the trio above compresses
    // away. `extended` is true exactly when this completion newly banked the
    // week (a later completion of an already-banked week returns false), so
    // the node is written once per week and keeps its first-completion
    // stamp. Feeds the Past Weeklies 'done' marks and the post-epoch half of
    // the week-streak self-heal; internally test-gated like the attempt
    // marker below.
    if (banked.extended) markWeeklyCompleted(state.weeklySeed);

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
    // still gate the player out within the session, bypass that too.
    if (!isTestEnvironment()) {
      markWeeklyDayAttempted(state.weeklySeed, state.weeklyDay);
      // Keep the local attempt cache in sync. Without this, every gate that
      // reads state.cachedWeeklyDayAttempts (title-screen weekly card, mode-card
      // click handler, deep-link router, reset-button gate) sees the stale
      // pre-win value until the player reloads, which means smashing the
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
          // Which board this was played on. Same expression the weekly fit row
          // uses below, so the two can never name different boards, and the
          // same shape the daily has carried since the canonical era.
          rngSeed: state.weeklyRngSeed || state.weeklySeed,
        }
      ).then((ok) => {
        // The board was not the week's canonical, so it cannot be compared
        // against anyone else's, a week's whole leaderboard is one board. The
        // attempt still counted and the week streak is already banked above;
        // only the comparison is refused, which is the daily's split exactly.
        if (ok === 'divergent') {
          showToast('That board wasn\'t this week\'s, so it can\'t be ranked.', 5000, 'uiWarning');
        }
      }).catch(err => reportCaughtError('weekly-score-submit', err));

      if (isFirstAttemptThisWeek && WEEKLY_FIT_DATA_ENABLED) {
        // Honest first encounter, qualifies for par-model fit data.
        // Reuses submitOnlineScore so we land in the same daily/* and
        // dailyMeta/* tables the R refit already reads, with a unique
        // key suffix so it joins as its own row.
        //
        submitOnlineScore(
          state.weeklySeed + '_weekly_first',
          playerName,
          scoreTime,
          state.weeklyBombHits || 0,
          {
            uid: getUid(),
            features: state.weeklyFeatures,
            bombHitEvents: state.weeklyBombHitEvents || [],
            wormEvents: state.wormEvents || [],
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
  // and weekly, neither mode uses power-ups so the saved counts would
  // just be empty objects bouncing around localStorage. Skip for Par Lab
  // runs too: they play on a deliberately EMPTY inventory (gameActions
  // zeroes it), and persisting those zeros under the 'normal' key would
  // wipe the player's real challenge power-ups.
  if (state.gameMode !== 'chaos' && state.gameMode !== 'weekly' && !state.parLab) {
    saveModePowerUps(state.gameMode, state.powerUps);
  saveProgress({ powerUps: loadPowerUps() });
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
  const achievementsDiv = $('#gameover-achievements');

  gameoverTitle.textContent = 'You Win!';
  // Win title bounce animation
  gameoverTitle.classList.remove('win-title-bounce');
  void gameoverTitle.offsetWidth;
  gameoverTitle.classList.add('win-title-bounce');
  setTimeout(() => gameoverTitle.classList.remove('win-title-bounce'), 700);

  // Match strikes ride the daily event fields (handleDailyBombHit's own
  // else branch), so the daily read covers both modes.
  const _dailyLike = state.gameMode === 'daily' || state.gameMode === 'match';
  const _strikes = state.gameMode === 'weekly'
    ? (state.weeklyBombHits || 0)
    : _dailyLike ? (state.dailyBombHits || 0) : 0;
  const _bombEvents = state.gameMode === 'weekly'
    ? (state.weeklyBombHitEvents || [])
    : _dailyLike ? (state.dailyBombHitEvents || []) : [];
  const _totalPenalty = _bombEvents.reduce(
    (s, e) => s + (e && typeof e.penalty === 'number' ? e.penalty : 0), 0);
  const strikesInfo = _strikes > 0
    ? ` | ${spriteImgHTML('strike', 'inline-strike')} ${_strikes} strike${_strikes !== 1 ? 's' : ''}${_totalPenalty > 0 ? ` (+${_totalPenalty.toFixed(1)}s)` : ''}`
    : '';

  // (par / par-breakdown / history-dots start hidden via the plan above.)
  const parEl = $('#gameover-par');

  // Challenge match: bank this board's result, show its par delta, and
  // route the flow, another board or the match summary. Nothing submits
  // anywhere yet: the async match node (and his open call on whether solo
  // rows carry a matchPlay-style offset into the daily fit) is the next
  // PR's contract, so a solo match records only local stats.
  if (state.gameMode === 'match' && state.match) {
    const precise = state.preciseTime || state.elapsedTime;
    // Index-aligned assignment, not push: a board replayed out of a
    // restored mid-board save overwrites its own slot instead of banking
    // twice. `current` advances in the Next-board handler, never here.
    //
    // The strike and worm event logs ride the result because the fit rows are
    // filed in ONE batch when the match ends (submitting per board would run
    // into the 30-second cooldown and queue most of a short match), and by then
    // state has been reset per board several times over. Both arrays reset in
    // newGame, so each one describes exactly this board.
    state.match.results[state.match.current] = {
      seed: state.challengeBoardSeed || null,
      time: Math.round(precise * 10) / 10,
      penalty: getActiveBombPenaltyTotal(),
      strikes: state.dailyBombHits || 0,
      par: state.matchPar || 0,
      bombHitEvents: (state.dailyBombHitEvents || []).slice(),
      wormEvents: (state.wormEvents || []).slice(),
    };
    // Post it live (his ruling: times appear as they land, for everyone,
    // finished or not). Fire-and-forget: a refused post is almost always the
    // seven-day gate closing, and the local summary still renders. Never from
    // a solo match or a pinned practice board, neither of which has a node.
    if (state.match.id && !state.isLevelPractice) {
      const _postIdx = state.match.current;
      const _postRow = state.match.results[_postIdx];
      import('../firebase/firebaseMatch.js')
        .then((m) => m.postMatchResult(state.match.id, _postIdx, _postRow))
        .catch((err) => reportCaughtError('match-result-post', err));
    }
    const n = state.match.entries.length;
    gameoverTime.innerHTML = `Board ${state.match.current + 1} of ${n} · ${precise.toFixed(1)}s${strikesInfo}`;
    if (parEl && state.matchPar > 0) {
      const tDelta = precise - state.matchPar;
      const tAbs = Math.abs(tDelta).toFixed(1);
      const tClass = tDelta < -0.5 ? 'par-under' : tDelta > 0.5 ? 'par-over' : 'par-even';
      const tText = tDelta < -0.5 ? `${tAbs}s under par` : tDelta > 0.5 ? `${tAbs}s over par` : 'Even par!';
      parEl.innerHTML = `${spriteImgHTML('smiley', 'sprite-greg-par', 'Greg')}Greg's Time: ${state.matchPar.toFixed(1)}s · <span class="${tClass}">${tText}</span>`;
      parEl.classList.remove('hidden');
    }
    if (matchAdvance(state.match) === 'next') {
      gameoverTitle.textContent = 'Board cleared!';
      const nextBtn = document.getElementById('gameover-match-next');
      if (nextBtn) {
        nextBtn.textContent = `Next board (${state.match.current + 2} of ${n})`;
        nextBtn.classList.remove('hidden');
      }
    } else {
      gameoverTitle.textContent = 'Match complete!';
      _renderMatchSummary();
      _finishMatchRun();
      const doneBtn = document.getElementById('gameover-done');
      if (doneBtn) doneBtn.classList.remove('hidden');
      const againBtn = document.getElementById('gameover-match-again');
      // His rematch ruling: a NEW set of boards under the SAME rules, so
      // nobody replays a board they have already seen and it stays a fair
      // fight. The button is the setup sheet's Start with the rules already
      // chosen, which is why it needs no surface of its own.
      if (againBtn && !state.isLevelPractice) againBtn.classList.remove('hidden');
    }
  } else if (state.gameMode === 'daily') {
    // Daily: show precise time + par comparison
    const precise = state.preciseTime || state.elapsedTime;
    gameoverTime.innerHTML = `Time: ${precise.toFixed(1)}s${strikesInfo}`;
    // The streak suffix implies "this counts toward your streak", true for a
    // live daily, false for an archive replay (archive never touches the
    // streak), so suppress it on archive to avoid the wrong implication.
    if (!isArchivePlay) {
      const { streak } = getDailyStreak();
      if (streak > 0) {
        gameoverTime.textContent += ` | \u{1F525} ${streak} day streak`;
      }
    }
    // His ask 2026-08-16: "when you do the daily, you should see how you
    // stack up." The live field's rank renders when the fetch answers, with
    // the player's own row spliced in (dailyStanding), because the submit
    // sits behind its cooldown queue and this line must not wait for it.
    // Live dailies only: an archive replay is not in today's race, and a
    // practice lane never files a row. Fail-silent; the win screen never
    // hangs on a courtesy line, and "so far" is the honest frame for a
    // field that grows all day.
    const standingEl = $('#gameover-standing');
    if (standingEl) {
      standingEl.classList.add('hidden');
      if (!isArchivePlay && !state.isLevelPractice) {
        const boardDate = state.dailySeed;
        fetchOnlineLeaderboard(boardDate).then((rows) => {
          // A second board can be underway by the time the field answers;
          // painting the old board's rank onto it would be the wrong claim.
          if (!rows || state.dailySeed !== boardDate) return;
          const s = dailyStanding(rows, {
            uid: getUid(), myTime: precise, handicaps: getHandicapRatioMap(),
          });
          if (!s) return;
          const nth = (n) => {
            const t = n % 10;
            const h = n % 100;
            return `${n}${t === 1 && h !== 11 ? 'st' : t === 2 && h !== 12 ? 'nd' : t === 3 && h !== 13 ? 'rd' : 'th'}`;
          };
          const fieldStr = s.capped ? `of the top ${s.field}` : `of ${s.field}`;
          standingEl.textContent = s.rankAdj === s.rankRaw
            ? `${nth(s.rankAdj)} ${fieldStr} on today's board so far.`
            : `${nth(s.rankAdj)} ${fieldStr} on today's board so far, adjusted (${nth(s.rankRaw)} raw).`;
          standingEl.classList.remove('hidden');
        }).catch(() => { /* the line stays hidden */ });
      }
    }
    // Greg's Time = global par from the current PAR_MODEL applied to today's
    // board features. Personal par = Greg's + your handicap (your typical
    // over/under across recent dailies). When a handicap is known we show
    // both numbers and the primary delta is measured against YOUR par,
    // that's the one that tells you whether you had a good or bad day
    // relative to your own skill.
    // Par only meaningful in regular daily mode. Weekly doesn't carry
    // a par (same board across the week, par would be a moving target
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
        parClass, deltaShort, showOneMoreHint,
      } = resolveParDisplay({
        precise,
        dailyPar: state.dailyPar,
        refitRatio: getHandicapRatio(getUid()),
        refitBombSeconds: (getHandicapDetails(getUid()) || {}).bombSeconds || 0,
        isRated: isRatedHandicap(getUid()),
        residuals: loadDailyResiduals(),
      });

      // First daily a player ever finishes: define par in one plain
      // sentence before throwing numbers at them. Shows once, ever.
      let parPrimer = '';
      if (!hasSeenNotice('par_primer')) {
        markNoticeSeen('par_primer');
        parPrimer = '<span class="par-primer">Greg’s Time is the typical solve time for today’s board. Finish faster and you’re under par.</span><br>';
      }

      // Simplified par line (2026-07): the personal par + how the player did
      // against it, on ONE line. The old Lab File decomposition ("Greg's Time X
      // + your pace + bomb habit = Your par Y") and the per-feature breakdown
      // chips below it were cut to keep the daily card to one screen, the full
      // model is still in Stats. deltaShort drops the redundant "your par"
      // suffix since the label already carries it.
      if (useHandicap) {
        parEl.innerHTML = moltNote + parPrimer +
          spriteImgHTML('smiley', 'sprite-greg-par', 'Greg') +
          'Your par ' + personalPar.toFixed(1) + 's · ' +
          '<span class="' + parClass + '">' + deltaShort + '</span>';
      } else {
        // No handicap yet, surface a small hint about what would
        // unlock one so a brand-new player (1 daily complete) doesn't
        // think the system is just ignoring them.
        const needHint = showOneMoreHint
          ? ' <span class="par-hint">· 1 more daily and your personal par appears</span>'
          : '';
        parEl.innerHTML = moltNote + parPrimer +
          spriteImgHTML('smiley', 'sprite-greg-par', 'Greg') +
          "Greg's time " + state.dailyPar.toFixed(1) + 's · ' +
          '<span class="' + parClass + '">' + deltaShort + '</span>' + needHint;
      }
      parEl.classList.remove('hidden');

      // 7-dot history strip, at-a-glance look at the player's recent
      // trajectory. Also held back until they have a few dailies under
      // their belt; one or two dots says nothing. Reads localStorage
      // residuals (just-appended above) so it's instant and offline.
      if (!isNewcomerDaily) _renderWinModalHistoryDots(state.dailySeed);
      // Win receipt: the board's confession (crux + modifier verdict).
      if (!isNewcomerDaily) _renderWinReceipt();
    }
  } else if (state.gameMode === 'weekly' && state.isWeeklyArchive) {
    // A past-weekly replay has no attempts, no best-of-week and no row, so it
    // gets none of the weekly summary below, that whole card is about a week
    // still in progress. It says what it is and shows the time.
    const precise = state.preciseTime || state.elapsedTime;
    gameoverTime.innerHTML = `Time: ${precise.toFixed(1)}s${strikesInfo}`;
    if (parEl) {
      parEl.innerHTML = `<div class="weekly-summary-row">Replay of the week of `
        + `${weekRangeLabel(state.weeklySeed)}. Nothing records.</div>`;
      parEl.classList.remove('hidden');
    }
  } else if (state.gameMode === 'weekly') {
    // Weekly: show precise time, day-of-week dot indicators, vs-best
    // comparison, and the live leaderboard inline.
    const precise = state.preciseTime || state.elapsedTime;
    gameoverTime.innerHTML = `Time: ${precise.toFixed(1)}s${strikesInfo}`;

    // Summarize this attempt from the prior-times snapshot captured BEFORE the
    // weekly win block mutated state.weeklyDayTimes, else a 1st attempt would
    // report as a 2nd. The DOM template below consumes the result; the
    // attempts-count and best math are pinned in weeklyAttemptSummary.
    const {
      newBest, attemptsUsed, dayCircles, summaryClass, summarySpanText, summaryTrailing,
    } = summarizeWeeklyAttempt({
      precise,
      priorTimesAtWin: state._weeklyPriorTimesAtWin,
      weeklyDayTimes: state.weeklyDayTimes,
      weeklyDay: state.weeklyDay,
    });
    const summary = `<span class="${summaryClass}">${summarySpanText}</span>${summaryTrailing}`;

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

      // Fetch and render the leaderboard inline. Fire-and-forget, the
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
    gameoverTime.innerHTML = `Time: ${precise.toFixed(1)}s${strikesInfo}`;
  }

  // Stats cascade animation on time display
  gameoverTime.classList.remove('stats-cascade');
  void gameoverTime.offsetWidth;
  gameoverTime.classList.add('stats-cascade');
  gameoverTime.style.animationDelay = '0.1s';
  setTimeout(() => gameoverTime.classList.remove('stats-cascade'), 500);

  const bestKey = `level${state.currentLevel}`;
  // Match wins never write global bestTimes (a board index is not a
  // level), so the banner excludes the mode outright rather than trusting
  // a coincidence of equal times against a Climb level's record.
  const isNewRecord = state.gameMode !== 'chaos' && state.gameMode !== 'match'
    && stats.bestTimes[bestKey] === state.elapsedTime;
  if (isNewRecord) {
    gameoverRecord.innerHTML = `${uiSpriteImgHTML('uiCelebrate', 'record-icon')} New Record!`;
    gameoverRecord.classList.remove('hidden');
  } else {
    gameoverRecord.classList.add('hidden');
  }

  if (earnedPowerUp) {
    powerupEarned.innerHTML = `Earned: ${earnedPowerUp}`;
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

  // Chaos win: the "Next Board" button visibility comes from the plan;
  // update the run state + headline here.
  if (state.gameMode === 'chaos') {
    const precise = state.preciseTime || state.elapsedTime;
    state.chaosTotalTime = (state.chaosTotalTime || 0) + precise;
    gameoverTitle.textContent = 'Board Cleared!';
    gameoverTime.textContent = 'Round ' + (state.chaosRound || 1) + ' · ' + precise.toFixed(1) + 's';
  } else {
    // Next Level is the Climb's alone: the ladder has no top (past the
    // L250 crown the endless zone takes over, his ruling), a match routes
    // through its own Next-board button, and daily/weekly end their day.
    if (state.gameMode === 'normal') {
      nextLevelBtn.classList.remove('hidden');
    }
  }

  if (isDaily) {
    const savedName = getPlayerName();
    if (isArchivePlay) {
      // Archive replay: record only with a saved name, through the
      // first-completion-only path, never the daily/ submitters. Archive is
      // excluded from the name gate (a later-game feature), so a nameless
      // archive run still just nudges toward Settings.
      if (savedName) {
        const aDate = state.dailySeed || getLocalDateString();
        const aTime = Math.round((state.preciseTime || state.elapsedTime) * 10) / 10;
        submitArchiveCompletion(aDate, savedName, aTime)
          .catch(err => reportCaughtError('archive-completion', err));
      } else {
        showToast('Set a name in Settings to record archive runs.');
      }
    } else if (savedName) {
      // Auto-submit with the saved name. The name gate at the top of handleWin
      // guarantees a real daily has one, so this is the only submit path now,
      // the old dismissible inline form (and its main.js handler) is gone.
      // Anchor to the puzzle's seed, not the current local date (same as
      // the manual-submit path in main.js), finishing at 12:00:01 AM
      // would otherwise post yesterday's board onto today's leaderboard.
      const dateStr = state.dailySeed || getLocalDateString();
      const scoreTime = Math.round((state.preciseTime || state.elapsedTime) * 10) / 10;
      addDailyLeaderboardEntry(dateStr, savedName, scoreTime);
      // CRITICAL: this auto-submit path (used whenever the player has a
      // saved name) MUST stay in sync with the manual-submit path in
      // main.js. Both need to include bombHitEvents and rngSeed,
      // missing either of those fields drops the experimental-design
      // and bomb-adjusted-model data streams silently.
      submitOnlineScore(dateStr, savedName, scoreTime, state.dailyBombHits || 0,
        buildDailyScoreExtras(state, dateStr, getUid())).then((ok) => {
        // Show the REAL outcome. Previously this toasted success
        // unconditionally, so an offline player thought their score
        // uploaded when it had only been queued, that's how Kate
        // believed she'd posted scores that never reached the board.
        // 'duplicate' = this account already has a row for this exact
        // board (another device finished first, or a queued retry had
        // already landed), first completion wins, so the personal-
        // history entry is skipped too rather than overwriting the
        // first device's time.
        if (ok === 'duplicate') {
          showToast('Already on the board from another device');
        } else if (ok === 'divergent') {
          // The board played was not the day's canonical, so it cannot be
          // compared against everyone else's and stays off the leaderboard
          // and out of the par fit. The DAY still counts: the history entry
          // below is what streaks read, which is why this branch writes it
          // where 'duplicate' deliberately does not ('cheat' now writes it too,
          // for the same reason, see that branch).
          //
          // And the real board is still unplayed, so give it back rather than
          // locking the day on a run that could not be ranked. Immediately,
          // not at the next boot: this is the moment the client LEARNS the
          // board was wrong, and the sticky unlock is what stops
          // applyCloudProgress re-locking the card from the cloud's
          // lastDailyDate (which the streak write above has just set to today).
          unlockDailyReplay(dateStr);
          showToast('That board wasn\'t today\'s, so it can\'t be ranked. Your streak counts. Play today\'s real board to get on the leaderboard.', 6000, 'uiWarning');
          if (!state.isDailyPractice) {
            saveDailyHistoryEntry(dateStr, { time: scoreTime });
          }
        } else if (ok === 'cheat') {
          // Probing run (see isBombHitCheat): kept off the leaderboard and out
          // of the par fit. The DAY still counts, exactly as the 'divergent'
          // branch above rules, the streak is a record of showing up, not a
          // competitive claim, and dailyHistory never feeds the fit, so writing
          // it costs no data hygiene. Withholding it is what made the 2026-08-09
          // false positive expensive: Kate lost the leaderboard row AND the dot
          // on her own history chart, and a hole in that node is what a later
          // reconcile reads as a missed day.
          showToast('You hit most of the board\'s mines, so this run can\'t be ranked. The day still counts toward your streak.', 6000, 'uiWarning');
          if (!state.isDailyPractice) {
            saveDailyHistoryEntry(dateStr, { time: scoreTime });
          }
        } else {
          showToast(ok ? 'Score submitted!' : 'Saved. Uploads when you reconnect', 2000, ok ? 'uiSuccess' : 'uiCloud');
          // Per-user daily-history timeline feeds the leaderboard-modal
          // chart. Skip for practice dailies, they play on a custom seed
          // and don't belong on the player's regular history timeline.
          // Durable: queues to localStorage and re-sends on reconnect if
          // the write fails.
          if (!state.isDailyPractice) {
            saveDailyHistoryEntry(dateStr, { time: scoreTime });
          }
        }
      }).catch(() => {
        showToast('Saved. Uploads when you reconnect', 2000, 'uiCloud');
        if (!state.isDailyPractice) {
          saveDailyHistoryEntry(dateStr, { time: scoreTime });
        }
      });
    }
    // No else: a real daily always has a name past the gate. If the gate ever
    // failed open (missing modal markup), we skip submission rather than
    // posting a nameless row.
  }

  // (Share button + crux-challenge visibility come from the plan: share on
  // every win, crux only for daily/weekly, other modes have no crux.)

  // Daily-win opt-in CTA, shown on daily/weekly wins ONLY when push
  // notifications are currently disabled. Best single moment to convert
  // a one-off player into a returning one. Hidden by the plan baseline;
  // the show path checks notification prefs asynchronously and unhides.
  const remindBtn = $('#gameover-remind-tomorrow');
  if (remindBtn) {
    if (isDaily || isWeekly) {
      (async () => {
        try {
          const { loadNotificationPrefs } = await import('../firebase/firebasePush.js');
          const prefs = await loadNotificationPrefs();
          if (!prefs?.enabled) remindBtn.classList.remove('hidden');
        } catch {
          // If push module fails to load (offline, missing SDK), leave
          // the button hidden, the prompt wouldn't work anyway.
        }
      })();
    }
  }

  // (Play Again / Done visibility comes from the plan: retry everywhere
  // except daily/weekly, Done only there, the canonical single-puzzle
  // modes can't be replayed today.)

  // Clear saved game state on win
  _clearOwnSave();

  // Delay the modal so the VICTORY! overlay (3.6 s total) has a chance
  // to play before the modal covers it. 2 s lands the modal after the
  // VICTORY bounce has settled into its hold phase, confetti still
  // visible behind, win chime audible, but the modal arrives in time
  // for the Play Again button to be useful before the user moves on.
  setTimeout(() => showModal('gameover-overlay'), 2000);
  updatePowerUpBar();
  updateStreakBorder();

  // Par Lab (test-only): record the result and hand the session flow to the
  // lab HUD. Lazy import, the module never loads outside a lab run.
  if (state.parLab) {
    import('../ui/parLabUI.js').then((m) => m.onParLabResult(true)).catch(() => {});
  }
}

// Register handleWin with powerUpActions to break circular dependency
// Wrapped so the injected reference includes the labeled rejection path:
// handleWin is async (name gate) and powerUpActions fires it without await.
setHandleWin(() => handleWin().catch(err => reportCaughtError('handle-win', err)));

// ── Handle Loss ────────────────────────────────────────

export function handleLoss(mineRow, mineCol) {
  state.status = 'lost';
  stopTimer();
  announceGame('Game over. Hit a mine.');
  // Baseline visibility for every optional modal section, this is what
  // clears a previous win's par line / weekly leaderboard / history dots
  // out of the shared overlay (they were never reset on the loss paths).
  _applyGameoverPlan(gameoverModalPlan('loss', state.gameMode));
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

  // The loss receipt: the FULL deducible frontier (flags-blind, a wrong
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
  saveGameResult(false, state.elapsedTime, state.currentLevel, { gameMode: state.gameMode, isLevelPractice: !!state.isLevelPractice });

  // Power-ups persist on loss within same mode, except Par Lab runs, whose
  // deliberately-zeroed inventory must never overwrite the real one.
  if (!state.parLab) {
    saveModePowerUps(state.gameMode, state.powerUps);
    saveProgress({ powerUps: loadPowerUps() });
  }

  // Par Lab (test-only): record the loss; the HUD offers a fresh-seed retry.
  if (state.parLab) {
    import('../ui/parLabUI.js').then((m) => m.onParLabResult(false)).catch(() => {});
  }

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
    // chaosTotalTime accumulates precise floats, format for display or the
    // headline can read "45.10000000000001s total".
    const totalTime = ((state.chaosTotalTime || 0) + state.elapsedTime).toFixed(1);
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
  // (Win-only sections, record, next-level, share, crux, done, unlocks,
  // receipt, share preview, are hidden by the plan applied at the top.)

  // Post-death verdict, honest counts from the flags-blind frontier.
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
      analysisText.textContent = `${flagNote}No guarantees in Chaos. Out here, sometimes there is no safe move`;
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

  // (Explore Board + Play Again visibility come from the plan.)

  // Clear saved game state on loss
  _clearOwnSave();

  // Show the modal only after the chain-detonation cascade finishes
  // (resolved Promise from chainRevealMines). Reduced-motion path
  // resolves the promise instantly, so the modal still appears
  // immediately for those users. Status guard: a restart during the
  // cascade window (the R key works before the modal is up) starts a
  // fresh game, and the stale loss modal must not pop over it
  // (2026-07-11 audit).
  cascadePromise.then(() => {
    if (state.status === 'lost') showModal('gameover-overlay');
  });
  updatePowerUpBar();
  updateStreakBorder();
  updateCheckpointDisplay();
}

// ── Daily / Weekly Mode: Info-Value Bomb Penalty ────────
// New (post-2026-05-31) mechanic: NO re-fog, NO flat +10s. Hitting a
// mine instead costs a deterministic info-value penalty + a small base.
//   penalty = max(0, infoValue) + BOMB_PENALTY_BASE
// where info-value is computed by computeBombInfoValue (src/logic/
// bombInfoValue.js) by running the solver twice, once without this
// mine pre-flagged, once with, and weighting the difference in move-
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

export function handleDailyBombHit(mineRow, mineCol, extraMines = []) {
  const isWeekly = state.gameMode === 'weekly';

  // The batch: the primary mine plus any further mines the same gesture
  // exposed (a chord across two wrong flags, 2026-07-11, per-mine
  // charging). Every mine in the batch is priced, logged, and marked in
  // ONE pass so the pause/popup/explainer machinery (which is not
  // re-entrant) runs exactly once per gesture.
  const mines = [{ row: mineRow, col: mineCol }];
  for (const m of Array.isArray(extraMines) ? extraMines : []) {
    if (m && Number.isInteger(m.row) && Number.isInteger(m.col)
        && !mines.some(x => x.row === m.row && x.col === m.col)) {
      mines.push({ row: m.row, col: m.col });
    }
  }

  // Prior strikes on this attempt, pre-flagged in the info-value
  // computation so each returned value is the MARGINAL info-value of
  // that hit given every hit before it, not the cumulative value.
  const priorEvents = (isWeekly ? state.weeklyBombHitEvents : state.dailyBombHitEvents) || [];
  const priorHits = isWeekly ? (state.weeklyBombHits || 0) : (state.dailyBombHits || 0);
  // state.elapsedTime is pure wall-clock (penalties live in the event log,
  // not in elapsedTime), so it already IS the clean hit timestamp. A
  // chord's mines share the one gesture's timestamp.
  const tClean = Math.round(state.elapsedTime * 10) / 10;

  // Pause the timer immediately. The penalty is applied while the
  // clock is frozen so we don't race a tick.
  pauseTimer();
  state.modalPaused = true;

  // The strike verdict, computed from the board state the player SAW
  // (before any strike cell is marked below), flags-blind so a wrong
  // flag can't make the receipt lie. Three honest answers: the mine was
  // provable / safe moves existed elsewhere / genuinely at the frontier.
  // A multi-mine chord gets the primary mine's verdict.
  let strikeVerdict = null;
  try {
    strikeVerdict = bombStrikeVerdict(state.board, mineRow, mineCol);
  } catch (err) {
    console.warn('bombStrikeVerdict failed:', err && err.message);
  }

  // Price + log + mark each mine in the batch. computeBombInfoValue reads
  // only structural board fields (never isRevealed/isStrike), so marking
  // earlier mines in the loop cannot perturb later pricing, the marginal
  // chain runs entirely through priorStrikes. Ramped base per strike: the
  // n-th strike's base is BOMB_PENALTY_BASE × (1 + BOMB_PENALTY_RAMP ×
  // (n-1)), 1st +3s, 2nd +4.5s, 3rd +6s … so casual mine-popping is
  // discouraged without clobbering a legit multi-hit day (the >30%
  // anti-cheat handles brute-forcers). The info-value term (the
  // par-seconds each struck mine was anchoring) rides on top, unchanged.
  // Anchor the pricing solves on the certified opener, never the container
  // center (issue #201): on a tiling canonical the center solve stalls at
  // click 1, both info-value runs count nothing, and every strike would be
  // priced off the failed solve, a wrong number riding into the submitted
  // time. On every rectangular board the opener IS the center, so pricing
  // is byte-identical there (pinned with a rectangle control).
  const opener = liveBoardOpener();
  const fr = Math.floor(opener / state.cols);
  const fc = opener % state.cols;
  const priorStrikes = priorEvents.map(e => ({ row: e.row, col: e.col }));
  // Daily, weekly, match, and Par Lab strikes all route here; the board's
  // feature vector sets the par baseline the info-value is priced against
  // under the log-scale model, a lab board's own features live in
  // coastlineFeatures.
  const boardFeatures = state.weeklyFeatures || state.dailyFeatures
    || state.matchFeatures || state.coastlineFeatures || null;
  let totalPenalty = 0;
  let firstInfoValueRounded = 0;
  for (let i = 0; i < mines.length; i++) {
    const m = mines[i];
    let infoValue = 0;
    try {
      const result = computeBombInfoValue(state.board, state.rows, state.cols, fr, fc, m.row, m.col, priorStrikes, boardFeatures);
      infoValue = result.infoValue;
    } catch (err) {
      // The solver is robust on well-formed daily/weekly boards; if it
      // ever does throw we'd rather charge the base penalty than crash
      // the player's attempt.
      console.warn('computeBombInfoValue failed:', err && err.message);
      reportCaughtError('bomb-info-value', err);
    }
    const strikeNumber = priorHits + i + 1;
    const rampedBase = BOMB_PENALTY_BASE * (1 + BOMB_PENALTY_RAMP * (strikeNumber - 1));
    const penalty = Math.round((infoValue + rampedBase) * 10) / 10;
    const infoValueRounded = Math.round(infoValue * 10) / 10;
    if (i === 0) firstInfoValueRounded = infoValueRounded;
    totalPenalty += penalty;

    // Append the event with its penalty value. The penalty field is new
    // in this mechanic; legacy events (under the old +10s/re-fog
    // mechanic) lack it, and the R refit treats `bombHits > 0 && no
    // penalty` as the legacy cohort.
    const event = { t: tClean, row: m.row, col: m.col, penalty, infoValue: infoValueRounded };
    if (isWeekly) {
      state.weeklyBombHits = priorHits + i + 1;
      if (!Array.isArray(state.weeklyBombHitEvents)) state.weeklyBombHitEvents = [];
      state.weeklyBombHitEvents.push(event);
    } else {
      state.dailyBombHits = priorHits + i + 1;
      if (!Array.isArray(state.dailyBombHitEvents)) state.dailyBombHitEvents = [];
      state.dailyBombHitEvents.push(event);
    }
    priorStrikes.push({ row: m.row, col: m.col });

    // Mark the hit cell as a strike. NO re-fog: every other revealed cell
    // stays revealed. The mine is preserved (we never call defuseMine):
    //   (a) Adjacent numbers don't drop, a "3" next to the strike stays
    //       a "3" because the mine is still there.
    //   (b) Strike counts as a flag for chordReveal (sums isFlagged ||
    //       isStrike), so chording around it works.
    //   (c) checkWin treats isMine cells as don't-need-to-reveal; win
    //       still requires every non-mine cell revealed.
    const hitCell = state.board[m.row][m.col];
    hitCell.isRevealed = true;
    hitCell.isStrike = true;
  }
  totalPenalty = Math.round(totalPenalty * 10) / 10;

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
  // before any popup appears, without this the player sees the old
  // time during the popup and a jump when it closes, which reads as
  // "the clock ran while I was reading" even though it was paused.
  updateTimerDisplay();

  function finishBombHit() {
    state.modalPaused = false;
    updateAllCells();
    updateHeader();
    // A chord can clear the board's last safe cells in the same gesture
    // that struck its mines, after the strikes are priced there may be
    // no player action left to run win detection, so check here instead
    // of leaving the attempt stuck at 100% revealed.
    if (checkWin(state.board)) {
      handleWin().catch(err => reportCaughtError('handle-win', err));
      return; // handleWin owns the timer from here
    }
    resumeTimer();
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
      // Escape), observe the 'hidden' class transition.
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
    // Modal element missing, fall through to the transient popup.
  }

  // Subsequent hits: brief centered popup showing the penalty breakdown
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
  // A multi-mine chord shows the batch total + count; the per-mine tier
  // label only renders for a single hit (labeling one mine of several
  // would misattribute the aggregate number beside it).
  const bombLabel = mines.length > 1 ? ` · ${mines.length} mines` :
                    firstInfoValueRounded < 2   ? '' :
                    firstInfoValueRounded < 6.5 ? ' · Minor mine' :
                    firstInfoValueRounded < 13  ? ' · Key mine' :
                                                 '! Critical mine';
  const verdictHtml = strikeVerdict
    ? `<div class="daily-bomb-verdict">${strikeVerdict.text}</div>` : '';
  popup.innerHTML = `<div class="daily-bomb-popup-content">${spriteImgHTML('strike', 'sprite-popup', 'Mine hit')} <span class="daily-bomb-penalty">+${totalPenalty.toFixed(1)}s${bombLabel}</span>${verdictHtml}</div>`;
  document.getElementById('app').appendChild(popup);

  setTimeout(() => {
    popup.remove();
    finishBombHit();
  }, 2000);
}

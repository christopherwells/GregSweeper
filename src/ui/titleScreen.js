// ── Title screen controller ───────────────────────────
// Extracted from main.js (2026-07-10 split). Owns the title/game surface
// swap, the mode-card progress copy (Daily corners, Weekly attempts,
// Chaos lock), the one-time notices (meet-Greg, moved, molt-earned), the
// return-to-title modal plumbing, and the Past-dailies archive calendar.
// main.js keeps the mode-card CLICK routing (it owns switchMode/newGame).

import { state } from '../state/gameState.js';
import { $ } from './domHelpers.js';
import { uiSpriteImgHTML } from './spriteLoader.js';
import { showModal, hideModal } from './modalManager.js';
import { showToast } from './toastManager.js';
import { startGregMascot } from './gregMascot.js';
import { restorePreChaosTheme } from './themeManager.js';
import { applyThemeEffects, applyTitleSceneEffects, clearTitleSceneEffects } from './themeEffects.js';
import { persistGameState } from '../game/gamePersistence.js';
import { clearAllPlateTimers } from '../game/gameActions.js';
import { pauseTimer } from '../game/timerManager.js';
import { isChaosUnlocked, launchDailyArchive, launchWeeklyArchive } from '../game/modeManager.js';
import { computeDailyParForDate, computeWeeklyPar } from '../game/parResolve.js';
import {
  loadStats, isDailyCompleted, getDailyStreak, getMoltProvisionalNotice,
  consumeMoltCelebrate, hasSeenNotice, markNoticeSeen, isOnboarded,
  getWeekStreak, getWeekStreakNotice,
} from '../storage/statsStorage.js';
import { loadDailyHistory } from '../firebase/firebaseProgress.js';
import { loadDailyBoard } from '../firebase/dailyBoardSync.js';
import { loadWeeklyBoard } from '../firebase/weeklyBoardSync.js';
import { getLocalDateString, getWeekDayIndex, getWeekStart, addCalendarDays } from '../logic/seededRandom.js';
import { FIRST_ARCHIVE_DATE, archiveDayState } from '../logic/archiveEligibility.js';
import {
  pastWeekStarts, weekArchiveState, weekRangeLabel,
} from '../logic/weeklyProgress.js';
import { CHALLENGE_MAX_LEVEL } from '../logic/challenge250.js';

// ── Return-to-title modal plumbing ────────────────────
// Track when a modal was opened from the title screen so its close
// button routes back there instead of into the game surface.
let _returnToTitle = false;

export function setReturnToTitle(value) {
  _returnToTitle = !!value;
}

export function closeModalAndReturn(modalId) {
  hideModal(modalId);
  if (_returnToTitle) {
    _returnToTitle = false;
    showTitleScreen();
  }
}

// Title screen footer buttons, open modals on top of title screen.
// Settings/Stats/Collection modals live outside #app (in the HTML) so they
// render regardless of #app's visibility, with z-index above the title screen.
export function showModalFromTitle(modalId) {
  _returnToTitle = true;
  showModal(modalId);
}

// ── Title progress copy ───────────────────────────────

// Today's Greg-par for the Daily card subtitle. Resolved once per date
// per session (the solve is not free) by refreshTitleDailyPar(); read
// synchronously by updateTitleProgress().
let _titleDailyPar = { date: null, secs: 0 };
// This week's Greg-par for the Weekly card corner, same contract as the daily
// one above: resolved once per week per session by refreshTitleWeeklyPar()
// (solving the canonical is not free), read synchronously when the card paints.
let _titleWeeklyPar = { week: null, secs: 0 };

export function updateTitleProgress() {
  const stats = loadStats();
  const challengeEl = $('#title-challenge-progress');
  const timedEl = $('#title-timed-progress');
  const dailyEl = $('#title-daily-progress');

  if (challengeEl) {
    const cLevel = stats.modeStats?.challenge?.maxLevelReached || 1;
    // Past the crown the ladder is endless, so a percentage has no
    // denominator to be a percentage OF. The level number is the whole
    // point there (his ruling: max level is the brag stat).
    challengeEl.textContent = cLevel > CHALLENGE_MAX_LEVEL
      ? `Level ${cLevel} · endless`
      : `Level ${cLevel} · ${Math.round(cLevel / CHALLENGE_MAX_LEVEL * 100)}%`;
  }
  if (timedEl) {
    const tWins = stats.modeStats?.timed?.wins || 0;
    timedEl.textContent = tWins > 0 ? `${tWins} wins` : 'Race the clock';
  }
  if (dailyEl) {
    const today = getLocalDateString();
    const dailyCard = $('.mode-card[data-mode="daily"]');
    const { streak, banked } = getDailyStreak();
    const completed = isDailyCompleted(today);
    const provisional = completed ? null : getMoltProvisionalNotice();
    const hasPar = _titleDailyPar.date === today && _titleDailyPar.secs > 0;
    const note = (_titleDailyPar.date === today && _titleDailyPar.note) ? _titleDailyPar.note : '';

    // Corner-anchored stats keep the center clean: molt tokens and the streak
    // together at bottom-left, par at bottom-right, and Greg's note as the one
    // center descriptor. The numbers ride the corners instead of stacking
    // their own rows, so the card stays the height of its siblings. The molt
    // tooltip carries the banked-vs-holding nuance so the face copy stays
    // quiet. (Molt sat top-left until the card became a full-width hero, whose
    // left column is the mode icon; grouping it with the streak is also the
    // truer reading, since both describe the same streak.)
    const moltTitle = provisional
      ? `A molt day is holding your ${provisional.streakHeld} day streak. Play today to keep it going.`
      : 'Molt days banked. Earned every 5 days in a row, spent automatically when you miss a day. Holds 2.';
    const moltCorner = banked > 0
      ? `<span class="daily-corner-molt" title="${moltTitle}">${uiSpriteImgHTML('uiMolt', 'molt-token').repeat(banked)}</span>`
      : '';

    // Greg's note (the daily's character) is the center descriptor. The Greg
    // sprite was dropped here in the 2026-06-25 front-door rebuild, the one
    // Greg now lives in the title header, and this card keeps its calendar
    // icon. Once played, the card just says so (the dimmed .daily-completed
    // style reinforces it).
    // The board's SHAPE leads the center line on a lattice day, and is absent
    // on a Classic one: naming "Classic" on the half of days that are one
    // would be noise, and the four corners are already spoken for (measured:
    // "Paving Stones · Par 240s" in the par corner overlaps the streak corner
    // on a 174px card). It comes from the CANONICAL board, never from
    // re-running the date's shape draw, a forced or fallback board can
    // legitimately differ from the draw, and the card must describe what the
    // player will actually open. Same rule the field note follows, same
    // reason (the 2026-06-10 fieldnote-drift incident).
    const shapeLabel = (_titleDailyPar.date === today && _titleDailyPar.shape) || '';
    const body = note || 'Same puzzle worldwide.';
    const centerText = completed
      ? 'Played today'
      : (shapeLabel ? `${shapeLabel} today. ${body}` : body);

    // Streak (bottom-left, beside the molt tokens) + par (bottom-right) hug
    // the card corners, plain text, not pills, so the Past chip stays the one
    // pill. The bottom-left pair ships as ONE positioned group so neither has
    // to know the other's width; a streak can be 0 while a bank survives (a
    // lapse past the bank keeps the crabs), so neither may nest in the other.
    const streakCorner = streak > 0
      ? `<span class="daily-corner-stat daily-corner-streak" title="Your daily streak">${streak} day${streak === 1 ? '' : 's'}</span>`
      : '';
    const parCorner = hasPar
      ? `<span class="daily-corner-stat daily-corner-par" title="Greg’s par for today">Par ${_titleDailyPar.secs}s</span>`
      : '';
    const bottomLeft = (moltCorner || streakCorner)
      ? `<span class="daily-corner-group">${moltCorner}${streakCorner}</span>`
      : '';

    dailyEl.innerHTML = bottomLeft + parCorner
      + `<span class="mode-card-fieldnote">${centerText}</span>`;
    if (dailyCard) dailyCard.classList.toggle('daily-completed', completed);
  }

  // Weekly card, always visible. Shows attempts used and best time
  // when the gate has populated state.cachedWeeklyDayAttempts and
  // state.weeklyDayTimes (both pre-fetched at startup).
  //
  // Since 2026-08-05 it has the Daily card's corner furniture too, for the same
  // reason that card does: the numbers ride the corners so the center line
  // stays one descriptor and the card stays the height of its siblings. Week
  // streak bottom-left, par bottom-right, Past weeklies top-right. The
  // top-LEFT corner stays empty, that is the daily's molt slot, and the
  // weekly has no molt days (a week is already seven chances at one board).
  const weeklyCard = $('.mode-card[data-mode="weekly"]');
  const weeklyProgressEl = $('#title-weekly-progress');
  if (weeklyCard && weeklyProgressEl) {
    const dayIdx = getWeekDayIndex();
    const thisWeek = getWeekStart();
    const attempts = state.cachedWeeklyDayAttempts || {};
    const used = Object.keys(attempts).length;
    const todayAlreadyAttempted = !!attempts[dayIdx];

    let centerText;
    if (todayAlreadyAttempted) {
      centerText = used >= 7 ? `Done · ${used}/7` : `Played today · ${used}/7`;
      weeklyCard.classList.add('daily-completed');
    } else if (used > 0) {
      centerText = `Play today · ${used}/7 used`;
      weeklyCard.classList.remove('daily-completed');
    } else {
      centerText = 'Same puzzle all week. Your best run wins.';
      weeklyCard.classList.remove('daily-completed');
    }

    // The week streak follows the daily's pattern, in weeks. A streak riding on
    // THIS week (last completion was last week, this week still unplayed) says
    // so, because that is the one moment the number is about to change.
    const { streak: weekStreak } = getWeekStreak(thisWeek);
    const atRisk = getWeekStreakNotice(thisWeek);
    const streakTitle = atRisk
      ? `Your ${atRisk.streakHeld} week streak rides on this week. Finish the weekly to make it ${atRisk.wouldBe}.`
      : 'Weeks in a row you finished the weekly. One completion banks the week.';
    const weekStreakCorner = weekStreak > 0
      ? `<span class="daily-corner-stat daily-corner-streak" title="${streakTitle}">${weekStreak} week${weekStreak === 1 ? '' : 's'}</span>`
      : '';
    const hasWeekPar = _titleWeeklyPar.week === thisWeek && _titleWeeklyPar.secs > 0;
    const weekParCorner = hasWeekPar
      ? `<span class="daily-corner-stat daily-corner-par" title="Greg’s par for this week’s board">Par ${_titleWeeklyPar.secs}s</span>`
      : '';

    weeklyProgressEl.innerHTML = weekStreakCorner + weekParCorner
      + `<span class="mode-card-fieldnote">${centerText}</span>`;
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
        // "No guarantees" is the honest label: chaos is the one mode
        // outside the no-guess contract (unverified boards, moving mines).
        chaosEl.textContent = totalRuns > 0
          ? `Best: ${bestRun} board${bestRun !== 1 ? 's' : ''} · ${totalRuns} run${totalRuns !== 1 ? 's' : ''} · No guarantees`
          : 'Roguelike madness · No guarantees';
      }
    } else {
      chaosCard.style.display = 'none';
    }
  }

  // A hidden card still occupies its :nth-child slot, so CSS alone can't
  // tell 5 visible cards from 6. Count the cards actually shown and flag
  // the grid: odd count → the last card spans the full row instead of
  // leaving an orphan cell (the .odd-cards rule in global.css).
  //
  // The Daily and Weekly heroes are excluded because they already span the
  // row. Counting them happens to give the same answer today (two heroes
  // do not change a parity), which is exactly why it is worth stating: the
  // next hero added, or a hero hidden, would silently invert the flag for
  // every card below it.
  const modeGrid = $('.title-screen-modes');
  if (modeGrid) {
    const gridCards = [...modeGrid.querySelectorAll('.mode-card:not(.mode-card-hero)')]
      .filter((card) => card.style.display !== 'none').length;
    modeGrid.classList.toggle('odd-cards', gridCards % 2 === 1);
  }
}

// The one-time notice for the gregsweeper.com custom-domain move (2026-07-03)
// self-retires after this ET date. getLocalDateString() is 'YYYY-MM-DD', so a
// plain string compare is date-safe.
const MOVED_NOTICE_UNTIL = '2026-08-03';

export function showTitleScreen() {
  const titleScreen = $('#title-screen');
  const app = $('#app');
  if (!titleScreen || !app) return;

  // Persist current game state before showing title (guard is inside persistGameState)
  persistGameState();

  // Kill any armed pressure-plate intervals from the game being left
  // (issue #192): showTitleScreen never changes state.status, so an armed
  // plate's wall-clock deadline kept counting behind the title screen and
  // detonated handleLoss with #app hidden, a silent loss (the gameover
  // modal lives inside #app and cannot render), the save cleared, the
  // level rolled back to checkpoint, and nothing on screen to say why.
  // Resuming the game re-arms them with a fresh countdown (rearmPlateTimers
  // at every resume site), the documented lenient direction.
  clearAllPlateTimers();

  // Leaving the board pauses the game clock, the second consequence of the
  // same #192 root, filed as issue #197: with status still 'playing', the 1s
  // tick kept counting behind the title screen, the 5s auto-persist wrote
  // the inflated elapsedTime into the save, and a resumed daily folded
  // title-screen minutes into the preciseTime submitted to the write-once
  // daily/{date} row and the par fit (a two-minute leaderboard visit charged
  // ~120s, permanently). One pauseTimer call tears down timer + mine-shift +
  // worm intervals (the worm heartbeat matters for data too: wormEvents[].
  // moves is the REALIZED dose the refit fits on, and moves ticked behind
  // the title screen are dose the player never saw) and folds wall-clock
  // into the precise accumulator. The pause is NOT undone by title-screen
  // interaction: resumeTimer refuses while #app is hidden (see
  // timerManager), so the document-level recordInteraction listeners and
  // visibilitychange cannot restart the hidden game's clock, only an
  // actual return to the game does (tryResumeGame's startTimer +
  // startWormCrawl, or the first click of a fresh board).
  pauseTimer();

  restorePreChaosTheme();

  // Idle-pause overlay is a gameplay-only surface, if it was left up by
  // a paused-then-Home-buttoned game, clear it explicitly when the title
  // screen comes back. The _pauseForIdle path is already status-gated to
  // 'playing', so this only matters when stale state survives navigation.
  const idleOverlay = document.getElementById('idle-pause-overlay');
  if (idleOverlay) idleOverlay.classList.add('hidden');
  state.idlePaused = false;

  updateTitleProgress();
  startGregMascot($('#title-greg-mascot'), document.documentElement.getAttribute('data-theme') || 'classic'); // inject + animate the header Greg (idempotent, theme-aware)
  refreshTitleDailyPar(); // fills in "Par: N seconds" once resolved
  refreshTitleWeeklyPar(); // same, for the Weekly card's par corner
  titleScreen.classList.remove('hidden');
  app.classList.add('hidden');
  // Sky worlds (nest) drift clouds + gulls behind the title cards too.
  applyTitleSceneEffects(document.documentElement.getAttribute('data-theme') || 'classic');

  // One-time character introduction: the first title-screen view once
  // onboarding is done. For a brand-new player that lands right after
  // the tutorial, before the daily-card spotlight fades, so they meet
  // the character whose par they are about to race. Marked before the
  // modal opens so a mid-modal tab close can't re-show it.
  if (isOnboarded() && !hasSeenNotice('meet_greg')) {
    markNoticeSeen('meet_greg');
    showModal('meet-greg-modal');
  } else if (getLocalDateString() < MOVED_NOTICE_UNTIL && !hasSeenNotice('moved_2026')) {
    // The gregsweeper.com move (2026-07-03): progress is stored per-origin, so
    // a returning anonymous player lands here with empty local stats. Nudge
    // sign-in once, within the transition window, then auto-retire. Sits after
    // meet_greg so a brand-new player meets Greg first.
    markNoticeSeen('moved_2026');
    showModal('moved-notice-modal');
  } else if (consumeMoltCelebrate()) {
    // Earned a molt day on the last completion: announce it, then drop the
    // crab into the Daily card's top-left corner on dismiss.
    showModal('molt-earned-modal');
  }
}

// Replay the crab's "placed in the corner" animation on the Daily card. Called
// when the earned-molt-day popup is dismissed so the player watches it land.
function _animateMoltPlacement() {
  const crab = $('.mode-card[data-mode="daily"] .daily-corner-molt');
  if (!crab) return;
  crab.classList.remove('molt-placing');
  void crab.offsetWidth; // force reflow so the animation restarts
  crab.classList.add('molt-placing');
}

// Earned-molt-day popup: dismiss, then drop the crab into the card corner.
$('#molt-earned-done')?.addEventListener('click', () => {
  hideModal('molt-earned-modal');
  _animateMoltPlacement();
});

// Resolve today's Greg-par for the Daily card, once per date per
// session. Fire-and-forget: the title shows immediately with the
// fallback subtitle, then the par badge fills in when this resolves.
async function refreshTitleDailyPar() {
  const today = getLocalDateString();
  if (_titleDailyPar.date === today && _titleDailyPar.secs > 0) return;
  try {
    const { par } = await computeDailyParForDate(today, true);
    if (par > 0) {
      // Greg's Field Note, derived from the CANONICAL BOARD, never by
      // re-running the seed→mission lookup. Boards are pre-generated up
      // to 7 days ahead against THAT day's experimentTarget.json, and
      // the nightly refit reorders the coverage list, so resolving the
      // seed's slot against the CURRENT file names the wrong gimmick
      // (2026-06-10: the board had wormholes, the note said
      // compass). fieldNoteFromBoard prefers the mission stamped into
      // the payload at generation and falls back to the board's actual
      // activeGimmicks; either way it cannot contradict the board.
      let note = null;
      let shape = null;
      try {
        if (state.canonicalDailyBoard?.date === today && state.canonicalDailyBoard.raw) {
          const raw = state.canonicalDailyBoard.raw;
          const { fieldNoteFromBoard } = await import('../logic/gregVoice.js');
          note = fieldNoteFromBoard(raw);
          // Same rule, same reason: read the shape OFF the board, so the card
          // can never name a lattice the canonical does not carry.
          if (raw.tiling?.type) {
            const { tilingLabel } = await import('../logic/coastlineLink.js');
            shape = tilingLabel(raw.tiling.type);
          }
        }
      } catch { /* no note, the par line still renders */ }
      _titleDailyPar = { date: today, secs: Math.round(par), note, shape };
      updateTitleProgress();
    }
  } catch { /* keep the fallback subtitle */ }
}

// This week's par for the Weekly card corner. computeWeeklyPar solves the
// canonical once and caches it per week, so this costs one solve per session
// and nothing on later title-screen visits.
//
// The weekly deliberately does not show par at the END of a run (days 2-7 are
// speedruns of a known board, and rating a memorised solve against a
// first-encounter par would be meaningless). Showing it on the CARD is the
// opposite case: it is the one number that says how big the board ahead is
// before you commit an attempt to it, which is what the daily's par corner has
// always been for.
async function refreshTitleWeeklyPar() {
  const week = getWeekStart();
  if (_titleWeeklyPar.week === week && _titleWeeklyPar.secs > 0) return;
  // Unlike the daily, there is no cheap local path here: the weekly's par can
  // only come from solving the week's canonical, and that board only exists on
  // Firebase (no local-gen fallback prices a week nobody generated). So don't
  // start a fetch that cannot land, the card goes without its par
  // corner until a later title visit finds Firebase up.
  if (!state.firebaseReady) return;
  try {
    const par = await computeWeeklyPar(week);
    if (par > 0) {
      _titleWeeklyPar = { week, secs: Math.round(par) };
      updateTitleProgress();
    }
  } catch { /* the card just goes without its par corner */ }
}

// Draw the player's eye to the Daily card after onboarding. Adds a
// pulsing-glow class for ~5 seconds, removed early on first click.
// Called once at end-of-tutorial; subsequent title-screen visits are
// unaffected.
export function spotlightDailyCard() {
  const dailyCard = document.querySelector('.mode-card[data-mode="daily"]');
  if (!dailyCard) return;
  dailyCard.classList.add('spotlight');
  const cleanup = () => dailyCard.classList.remove('spotlight');
  setTimeout(cleanup, 5000);
  dailyCard.addEventListener('click', cleanup, { once: true });
}

export function hideTitleScreen() {
  const titleScreen = $('#title-screen');
  const app = $('#app');
  if (!titleScreen || !app) return;

  titleScreen.classList.add('hidden');
  app.classList.remove('hidden');
  clearTitleSceneEffects(); // tear down the title-screen sky before play

  // Re-apply theme effects now that #board is visible
  // (applyThemeEffects silently returns if called during title screen since #board doesn't exist)
  const activeTheme = document.documentElement.getAttribute('data-theme') || 'classic';
  applyThemeEffects(activeTheme);
}

// ── Past Dailies (archive) calendar ─────────────────────
// Opens from the "Past dailies" link on the Daily card. The grid offers every
// stored past board (FIRST_ARCHIVE_DATE through yesterday); a tap probes the
// canonical and hands it to launchDailyArchive. Completed dates are marked
// from the player's dailyHistory. Archive plays never touch streak/completion
// (enforced in winLossHandler via state.isArchivePlay).
let _archiveView = null;            // { year, month(0-11) } currently shown
let _archiveCompleted = new Set();  // YYYY-MM-DD the player has finished

function _archiveYmd(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function _archiveMonthLabel(y, m) {
  // Day 1 at local noon: a plain month/year label, no timezone edge cases.
  return new Date(y, m, 1, 12).toLocaleString(undefined, { month: 'long', year: 'numeric' });
}
function _archiveCanGoPrev() {
  const [fy, fm] = FIRST_ARCHIVE_DATE.split('-').map(Number);
  return (_archiveView.year * 12 + _archiveView.month) > (fy * 12 + (fm - 1));
}
function _archiveCanGoNext() {
  // Never past the current month, today is the live Daily's job, not the archive's.
  const [ty, tm] = getLocalDateString().split('-').map(Number);
  return (_archiveView.year * 12 + _archiveView.month) < (ty * 12 + (tm - 1));
}

async function openArchiveCalendar() {
  // Refresh the completed-set so the marks reflect the latest cloud state.
  // Keep whatever we had on a failed/offline read rather than clearing marks.
  // Archive-replayed dates count here (the calendar marks any completion,
  // live or replay), only the streak derivation excludes them.
  try {
    const entries = await loadDailyHistory();
    if (Array.isArray(entries)) _archiveCompleted = new Set(entries.map((e) => e.date));
  } catch { /* keep prior marks */ }
  const [ty, tm] = getLocalDateString().split('-').map(Number);
  _archiveView = { year: ty, month: tm - 1 };
  showModalFromTitle('archive-modal');
  renderArchiveCalendar();
}

function renderArchiveCalendar() {
  const grid = $('#archive-grid');
  if (!grid || !_archiveView) return;
  const { year, month } = _archiveView;
  const label = $('#archive-month-label');
  if (label) label.textContent = _archiveMonthLabel(year, month);
  const prevBtn = $('#archive-prev');
  const nextBtn = $('#archive-next');
  if (prevBtn) prevBtn.disabled = !_archiveCanGoPrev();
  if (nextBtn) nextBtn.disabled = !_archiveCanGoNext();

  const today = getLocalDateString();
  const firstDow = new Date(year, month, 1, 12).getDay(); // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0, 12).getDate();
  let html = '';
  for (let i = 0; i < firstDow; i++) html += '<span class="archive-day empty"></span>';
  let anyArchivable = false;
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = _archiveYmd(year, month, d);
    // The pure layer owns the decision; this loop only paints it.
    const dayState = archiveDayState(ds, today, _archiveCompleted);
    if (dayState === 'playable') {
      anyArchivable = true;
      html += `<button type="button" class="archive-day playable" data-date="${ds}" aria-label="${ds}">${d}</button>`;
    } else if (dayState === 'done') {
      // Finished boards stay on the calendar so the month reads as a
      // completion map, but they are spans rather than buttons: a daily
      // is a one-off, and a replay records nothing anyway.
      anyArchivable = true;
      html += `<span class="archive-day completed" title="Already played" aria-label="${ds}, already played">${d}<span class="archive-check">✓</span></span>`;
    } else {
      html += `<span class="archive-day ${dayState === 'today' ? 'today' : 'blocked'}" aria-hidden="true">${d}</span>`;
    }
  }
  grid.innerHTML = html;
  const emptyNote = $('#archive-empty-note');
  if (emptyNote) emptyNote.classList.toggle('hidden', anyArchivable);
}

const _archivePrevBtn = $('#archive-prev');
if (_archivePrevBtn) _archivePrevBtn.addEventListener('click', () => {
  if (!_archiveView || !_archiveCanGoPrev()) return;
  if (_archiveView.month === 0) { _archiveView.month = 11; _archiveView.year--; }
  else _archiveView.month--;
  renderArchiveCalendar();
});
const _archiveNextBtn = $('#archive-next');
if (_archiveNextBtn) _archiveNextBtn.addEventListener('click', () => {
  if (!_archiveView || !_archiveCanGoNext()) return;
  if (_archiveView.month === 11) { _archiveView.month = 0; _archiveView.year++; }
  else _archiveView.month++;
  renderArchiveCalendar();
});

// In-app entry to the crux teaser: open yesterday's crux in a new tab so
// the calendar stays put. Same-origin so it works on whichever build
// (the crux payload is read from prod either way).
const _archiveCruxBtn = $('#archive-crux-btn');
if (_archiveCruxBtn) _archiveCruxBtn.addEventListener('click', () => {
  const y = addCalendarDays(getLocalDateString(), -1);
  window.open(`${location.pathname}?crux=${y}`, '_blank', 'noopener');
});

const _archiveGridEl = $('#archive-grid');
if (_archiveGridEl) _archiveGridEl.addEventListener('click', async (e) => {
  const cell = e.target.closest('.archive-day.playable');
  if (!cell || cell.disabled) return;
  const date = cell.dataset.date;
  if (!date) return;
  // Re-derive the gate instead of trusting the class. The rendered CSS is
  // cosmetic and can go stale (the grid is painted once per month view while
  // the completed-set refreshes on open), so the pure decision is what
  // actually guards the launch.
  if (archiveDayState(date, getLocalDateString(), _archiveCompleted) !== 'playable') {
    renderArchiveCalendar();
    return;
  }
  cell.disabled = true;
  cell.classList.add('loading');
  // Archive has no local-gen fallback: a missing canonical means the date
  // isn't offered. Probe before committing to the launch.
  const raw = await loadDailyBoard(date).catch(() => null);
  if (!raw) {
    cell.disabled = false;
    cell.classList.remove('loading');
    showToast('That day’s board isn’t available.');
    return;
  }
  _returnToTitle = false; // entering a game, not bouncing back to the title
  hideModal('archive-modal');
  hideTitleScreen();
  launchDailyArchive(date, raw);
});

// The "Past dailies" corner chip opens the calendar instead of launching
// today's board. The card is a <button>, so the chip is a role=button span
// inside it; a capture-phase listener catches the tap before the card's own
// (bubble-phase) launch handler and stops it.
const _dailyCardEl = $('.mode-card[data-mode="daily"]');
if (_dailyCardEl) {
  const _openArchiveFromLink = (e) => {
    if (!e.target.closest('.card-archive-btn')) return;
    e.stopPropagation();
    e.preventDefault();
    openArchiveCalendar();
  };
  _dailyCardEl.addEventListener('click', _openArchiveFromLink, true);
  _dailyCardEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') _openArchiveFromLink(e);
  }, true);
}

// ── Past Weeklies (archive) list ────────────────────────
// Opens from the "Past weeklies" chip on the Weekly card. A LIST rather than a
// calendar: the weekly has one board per week, so a month grid would be six
// mostly-empty cells with one row that matters. Each row is a week; a tap
// probes that week's canonical and hands it to launchWeeklyArchive.
//
// Which weeks the player has already cleared comes from the weekly leaderboard
// itself, a `weekly/{weekStart}/{uid}` row exists only for a week they
// finished at least one attempt of, so it is the same fact the streak counts,
// read from the one place both devices already share. Unknown history (signed
// out, or a failed read) leaves the marks off and every week playable: the
// pure gate fails open there, which costs nothing because a replay records
// nothing either way.
let _weeklyPlayed = null;   // Set<weekStart> | null (null = unknown)

async function openWeeklyArchiveList() {
  try {
    const { fetchPlayedWeeks } = await import('../firebase/firebaseProgress.js');
    const weeks = await fetchPlayedWeeks();
    if (Array.isArray(weeks)) _weeklyPlayed = new Set(weeks);
  } catch { /* keep whatever marks we had */ }
  showModalFromTitle('weekly-archive-modal');
  renderWeeklyArchiveList();
}

function renderWeeklyArchiveList() {
  const listEl = $('#weekly-archive-list');
  if (!listEl) return;
  const thisWeek = getWeekStart();
  const weeks = pastWeekStarts(thisWeek);
  let html = '';
  for (const w of weeks) {
    const rowState = weekArchiveState(w, thisWeek, _weeklyPlayed);
    const label = weekRangeLabel(w);
    if (rowState === 'playable') {
      html += `<button type="button" class="weekly-archive-row playable" data-week="${w}">`
        + `<span class="weekly-archive-week">${label}</span>`
        + '<span class="weekly-archive-action">Play ›</span></button>';
    } else if (rowState === 'done') {
      // Finished weeks stay listed so the column reads as a record of what the
      // player has cleared, but they are spans rather than buttons: the week's
      // board is one board, and a replay records nothing anyway.
      html += '<span class="weekly-archive-row completed" title="Already played">'
        + `<span class="weekly-archive-week">${label}</span>`
        + '<span class="archive-check">✓</span></span>';
    }
  }
  listEl.innerHTML = html;
  const emptyNote = $('#weekly-archive-empty');
  if (emptyNote) emptyNote.classList.toggle('hidden', weeks.length > 0);
}

const _weeklyArchiveListEl = $('#weekly-archive-list');
if (_weeklyArchiveListEl) _weeklyArchiveListEl.addEventListener('click', async (e) => {
  const row = e.target.closest('.weekly-archive-row.playable');
  if (!row || row.disabled) return;
  const week = row.dataset.week;
  if (!week) return;
  // Re-derive the gate rather than trusting the rendered class: the list is
  // painted once per open while the played-set refreshes on each one.
  if (weekArchiveState(week, getWeekStart(), _weeklyPlayed) !== 'playable') {
    renderWeeklyArchiveList();
    return;
  }
  row.disabled = true;
  row.classList.add('loading');
  // No local-gen fallback for a past week, probe before committing.
  const raw = await loadWeeklyBoard(week).catch(() => null);
  if (!raw) {
    row.disabled = false;
    row.classList.remove('loading');
    showToast('That week’s board isn’t available.');
    return;
  }
  _returnToTitle = false; // entering a game, not bouncing back to the title
  hideModal('weekly-archive-modal');
  hideTitleScreen();
  launchWeeklyArchive(week, raw);
});

// The "Past weeklies" chip, wired exactly like the Daily card's: the card is a
// <button>, so a capture-phase listener catches the chip's tap before the
// card's own launch handler and stops it.
const _weeklyCardEl = $('.mode-card[data-mode="weekly"]');
if (_weeklyCardEl) {
  const _openWeeklyArchiveFromLink = (e) => {
    if (!e.target.closest('.card-archive-btn')) return;
    e.stopPropagation();
    e.preventDefault();
    openWeeklyArchiveList();
  };
  _weeklyCardEl.addEventListener('click', _openWeeklyArchiveFromLink, true);
  _weeklyCardEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') _openWeeklyArchiveFromLink(e);
  }, true);
}

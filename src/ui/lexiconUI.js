// ── Greg's Gym (player-facing name; module keeps its original
// "lexicon" filename) — a multi-lesson curriculum behind the
// deducibility click-gate. A lesson board where clicking a square the
// clues can't yet settle does nothing except point at the clues that
// hold the next step. The player cannot luck through — completing a
// drill means performing the technique, and the pattern is named only
// when they perform it. Flags are gated the same way: you can only flag a
// square the clues can settle as a MINE, so a flag is a worked deduction
// too, never a guess marker.
//
// The overlay holds three views: a lesson-select screen, the drill, and
// Greg's Field Notebook (the technique reference + your gym counts).
// Pattern naming comes from the shared patternNames.classifyPattern, the
// SAME classifier the receipts and Lens use — the gym can never name a
// shape the rest of the game cannot. Dynamically imported from the
// title-screen card; never touches game state, scores, or the par
// pipeline.

import { findDeducibleFrontier } from '../logic/boardSolver.js';
import { explainDeduction } from '../logic/proofExplainer.js';
import { classifyPattern } from '../logic/patternNames.js';
import { LESSONS, LESSON_ORDER, generateLessonBoard, applyLessonOpening, lessonComplete } from '../logic/lexicon.js';
import { recordGymTechnique, getGymTechniqueCounts } from '../storage/statsStorage.js';
import { showToast } from './toastManager.js';
import { uiSpriteUrl, uiSpriteImgHTML } from './spriteLoader.js';
import { playReveal, playCascade, playFlag, playUnflag, playWin, playGateBounce } from '../audio/sounds.js';

let _overlay = null;
let _lessonBoard = null;
let _lesson = null;
let _boardsDone = 0;
let _pulseTimer = null;
let _coachTimer = null;
let _lpTimer = null;   // long-press flag timer (touch)
let _lpFired = false;  // swallow the click that follows a long-press
let _flagMode = false; // tap-to-flag mode (the reliable touch path; long-press still works)
// Per-board coaching state: the first cheer of a board carries the
// recognition tip; later ones get short rotating affirmations.
let _firstTipPending = true;
let _flagTipShown = false;
let _chordTipShown = false;
// Which technique names the player has performed THIS board — the
// "again" affirmations only fire on a repeat within the same board.
let _namesUsed = new Set();

// Plain-language coaching per technique, keyed by the classifier name.
// Every line points at things on screen (the two numbers, the squares
// they share, the square only one of them touches). No em / en dashes.
const PATTERN_COACH = {
  count: {
    cheer: 'You read the number.',
    tip: 'A number that already touches all of its mines leaves every other square it sees safe. Work the board one number at a time.',
    again: 'Counted clean.',
  },
  '1-1': {
    cheer: 'The 1-1 pattern.',
    tip: 'Two 1s side by side looking at the same squares: the first 1\'s mine already sits in the squares they share, which satisfies the second 1 too, so its far square is safe.',
    again: 'Another clean 1-1.',
  },
  '1-2': {
    cheer: 'The 1-2 pattern.',
    tip: 'A 1 and a 2 looking at the same squares: the 2 needs one mine more than the 1, and the only room for it is the square the 1 cannot see. The 1\'s far square is safe.',
    again: 'Textbook 1-2.',
  },
  '1-2-1': {
    cheer: 'The 1-2-1.',
    tip: 'A 2 flanked by two 1s along a wall: a mine sits under each 1, and the square under the 2 is safe. The 2 confirms there is no room for a third mine.',
    again: 'Another 1-2-1, spotted fast.',
  },
  '1-2-2-1': {
    cheer: 'The 1-2-2-1.',
    tip: 'Four in a row reading 1-2-2-1: the only layout that fits all four numbers puts both mines in the middle under the 2s, and clears the four outer squares.',
    again: 'The 1-2-2-1 again.',
  },
  '1-3-1': {
    cheer: 'The 1-3-1 corner.',
    tip: 'A 3 at the bend of an L with a 1 on each arm. The two 1s hold four of the 3\'s five squares to one mine each, so the fifth, the square only the 3 can see, is a mine, and each 1\'s far square is safe.',
    again: 'Another 1-3-1 corner.',
  },
  hole: {
    cheer: 'A hole.',
    tip: 'A clue boxed in to a small pocket counts that pocket\'s mines exactly; a wider clue that shares the pocket has its mine accounted for, so every other square it touches is safe. Watch for two clues near each other around an enclosed gap.',
    again: 'Another hole read.',
  },
  triangle: {
    cheer: 'A triangle.',
    tip: 'Same read as a hole, but the boxed clue pins a three-square pocket. The wider clue sharing those three has nothing left for the rest, so everything beyond clears at once.',
    again: 'Another triangle.',
  },
  '2-2-2': {
    cheer: 'A 2-2-2 corner.',
    tip: 'Three 2s meeting at a corner: each outer 2 forces a mine into its own squares, which uses up the corner 2\'s two mines, so the square only the corner 2 can see is safe.',
    again: 'Another 2-2-2 corner.',
  },
};

// The named line/corner shapes a move can be cheered as (counting is
// handled separately). A move classifying as one of these is recorded and
// celebrated whether the player revealed a safe square or flagged a mine.
const PATTERN_SHAPE_NAMES = new Set(['1-1', '1-2', '1-2-1', '1-2-2-1', '1-3-1', 'hole', 'triangle', '2-2-2']);

// Notebook sketches: a tiny board picture per technique. Chars: digit = a
// revealed number, M = mine, S = a square the pattern proves safe, . = a
// plain hidden square. The rule text carries the precise reasoning.
const SKETCHES = {
  countingBasics: ['1S', 'MS'],
  subset11: ['11.', 'M.S'],
  subset12: ['12.', 'SMM'],
  holes: ['1SS', 'M1.'],
  triangles: ['1SSS', 'M.1.'],
  oneTwoOne: ['121', 'MSM'],
  oneTwoTwoOne: ['1221', 'SMMS'],
  oneThreeOneCorner: ['.1S', '13.', 'S.M'],
  twoTwoTwoCorner: ['22', '2S'],
};

// Which classifier names count toward each lesson's notebook tally.
const TECHNIQUE_KEYS = {
  countingBasics: ['count'],
  subset11: ['1-1'],
  subset12: ['1-2'],
  holes: ['hole'],
  triangles: ['triangle'],
  oneTwoOne: ['1-2-1'],
  oneTwoTwoOne: ['1-2-2-1'],
  oneThreeOneCorner: ['1-3-1'],
  twoTwoTwoCorner: ['2-2-2'],
};

export function openLexicon() {
  _boardsDone = 0;
  _lesson = null;
  _flagMode = false;   // every gym session starts in reveal ("Dig") mode
  _buildOverlay();
  _showView('select');
}

// Reflect flag-mode state on the toggle: the label says what a tap will do
// ("Dig" reveals, "Flag" arms flagging), plus pressed state and styling.
function _updateFlagToggle() {
  if (!_overlay) return;
  const btn = _overlay.querySelector('.lexicon-flag-toggle');
  if (!btn) return;
  btn.classList.toggle('active', _flagMode);
  btn.setAttribute('aria-pressed', _flagMode ? 'true' : 'false');
  btn.innerHTML = _flagMode ? `${uiSpriteImgHTML('flag', 'btn-icon')} Flag` : `${uiSpriteImgHTML('uiCursor', 'btn-icon')} Reveal`;
}

function _buildOverlay() {
  closeLexicon();
  _overlay = document.createElement('div');
  _overlay.id = 'lexicon-overlay';
  _overlay.innerHTML = `
    <div class="lexicon-card">
      <div class="lexicon-header">
        <button class="lexicon-back" aria-label="Back to lessons" hidden>‹ Lessons</button>
        <span class="lexicon-title">${uiSpriteImgHTML('uiGym', 'lexicon-title-icon')} Greg's Gym</span>
        <button class="lexicon-close" aria-label="Close">&times;</button>
      </div>

      <div class="lexicon-view lexicon-select">
        <p class="lexicon-select-intro">Pick a skill to drill. A square only opens when the clues prove it safe, so you cannot guess your way through. Greg names the move once you make it.</p>
        <div class="lexicon-lesson-list"></div>
        <button class="lexicon-notebook-btn action-btn secondary">${uiSpriteImgHTML('uiNotebook', 'btn-icon')} Greg's Field Notebook</button>
      </div>

      <div class="lexicon-view lexicon-drill" hidden>
        <p class="lexicon-instruction">Open every safe square to finish the board. A square only opens when the clues prove it is safe. If it bounces, look at the clues that light up. To flag a proven mine, tap the Flag button then tap the square (or long-press it); then tap a number whose mines are all flagged to open the rest around it.</p>
        <div class="lexicon-status">
          <span class="lexicon-mines-left"></span>
          <button class="lexicon-flag-toggle" type="button" aria-pressed="false">${uiSpriteImgHTML('uiCursor', 'btn-icon')} Reveal</button>
          <span class="lexicon-board-count"></span>
        </div>
        <div class="lexicon-grid" role="grid"></div>
        <p class="lexicon-coach" aria-live="polite"></p>
        <p class="lexicon-naming hidden"></p>
        <div class="lexicon-actions hidden">
          <button class="lexicon-another action-btn primary">Another</button>
          <button class="lexicon-lessons action-btn secondary">Lessons</button>
        </div>
      </div>

      <div class="lexicon-view lexicon-notebook" hidden></div>
    </div>`;
  document.body.appendChild(_overlay);
  _overlay.querySelector('.lexicon-close').addEventListener('click', closeLexicon);
  _overlay.querySelector('.lexicon-back').addEventListener('click', () => _showView('select'));
  _overlay.querySelector('.lexicon-lessons').addEventListener('click', () => _showView('select'));
  _overlay.querySelector('.lexicon-another').addEventListener('click', _nextBoard);
  _overlay.querySelector('.lexicon-notebook-btn').addEventListener('click', () => _showView('notebook'));

  const grid = _overlay.querySelector('.lexicon-grid');
  grid.addEventListener('click', _onCellClick);
  // Flagging: right-click on desktop, long-press on touch. The pointer
  // timer sets _lpFired so the synthetic click that follows a long-press
  // is swallowed instead of triggering a reveal attempt.
  grid.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // On touch, a long-press fires BOTH the timer below AND this native
    // contextmenu event for the same press. Without a guard the second
    // _tryFlag toggles the just-placed flag right back off — the praise
    // shows but the flag vanishes (the exact Android bug). If the timer
    // already flagged this press, ignore the contextmenu; otherwise
    // (desktop right-click, or a contextmenu that beat the timer) flag once
    // and cancel the pending timer so it can't double-fire.
    if (_lpFired) return;
    if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
    const el = e.target.closest('.lexicon-cell');
    if (el) _tryFlag(parseInt(el.dataset.row, 10), parseInt(el.dataset.col, 10));
  });
  grid.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.lexicon-cell');
    if (!el) return;
    _lpFired = false;                       // fresh gesture; clear any stale swallow flag
    if (e.pointerType === 'mouse') return;  // mouse flags via contextmenu / flag-mode click
    if (_lpTimer) clearTimeout(_lpTimer);
    _lpTimer = setTimeout(() => {
      _lpFired = true;
      _tryFlag(parseInt(el.dataset.row, 10), parseInt(el.dataset.col, 10));
    }, 450);
  });
  const cancelLp = () => { if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; } };
  grid.addEventListener('pointerup', cancelLp);
  grid.addEventListener('pointerleave', cancelLp);
  grid.addEventListener('pointercancel', cancelLp);

  // Flag-mode toggle: the reliable touch path. A plain tap can't be stolen
  // by a scroll or doubled by a contextmenu the way a long-press can, and
  // flagging is a core taught move, so it gets a visible button (mirrors the
  // main game). When on, a tap on a hidden square flags a proven mine.
  const flagToggle = _overlay.querySelector('.lexicon-flag-toggle');
  flagToggle.addEventListener('click', () => { _flagMode = !_flagMode; _updateFlagToggle(); });
  _updateFlagToggle();

  _renderLessonList();
}

export function closeLexicon() {
  if (_pulseTimer) { clearTimeout(_pulseTimer); _pulseTimer = null; }
  if (_coachTimer) { clearTimeout(_coachTimer); _coachTimer = null; }
  if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
  _lpFired = false;
  if (_overlay) { _overlay.remove(); _overlay = null; }
  _lessonBoard = null;
}

// Toggle which of the three views is visible. The back button shows on
// any view other than the lesson list.
function _showView(name) {
  if (!_overlay) return;
  for (const v of _overlay.querySelectorAll('.lexicon-view')) {
    v.hidden = !v.classList.contains(`lexicon-${name}`);
  }
  _overlay.querySelector('.lexicon-back').hidden = name === 'select';
  if (name === 'notebook') _renderNotebook();
}

function _renderLessonList() {
  const list = _overlay.querySelector('.lexicon-lesson-list');
  list.innerHTML = '';
  for (const id of LESSON_ORDER) {
    const lesson = LESSONS[id];
    const card = document.createElement('button');
    card.className = 'lexicon-lesson-card';
    card.dataset.lesson = id;
    card.innerHTML = `
      <span class="lexicon-lesson-name">${lesson.name}${lesson.advanced ? ' <span class="lexicon-adv">Advanced</span>' : ''}</span>
      <span class="lexicon-lesson-blurb">${lesson.blurb}</span>`;
    card.addEventListener('click', () => _startLesson(id));
    list.appendChild(card);
  }
}

function _startLesson(id) {
  _lesson = LESSONS[id];
  _boardsDone = 0;
  _showView('drill');
  _nextBoard();
}

// The coach line: a single slot under the board that updates IN PLACE.
// Toasts queue globally and display serially, so under quick play a note
// would arrive seconds after the move it praises — exactly wrong for
// in-the-moment coaching. One line, instantly replaced, right where the
// player is already looking.
function _coach(message, ms = 3200, icon = null) {
  if (!_overlay) return;
  const el = _overlay.querySelector('.lexicon-coach');
  if (!el) return;
  el.textContent = '';
  const iconUrl = icon ? uiSpriteUrl(icon) : null;
  if (iconUrl) {
    const img = document.createElement('img');
    img.className = 'coach-icon';
    img.src = iconUrl;
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    el.appendChild(img);
    el.appendChild(document.createTextNode(message));
  } else {
    el.textContent = message;
  }
  el.classList.remove('coach-pop');
  void el.offsetWidth;
  el.classList.add('coach-pop');
  if (_coachTimer) clearTimeout(_coachTimer);
  _coachTimer = setTimeout(() => {
    el.textContent = '';
    _coachTimer = null;
  }, ms);
}

function _nextBoard() {
  if (!_lesson) { _showView('select'); return; }
  // Seed by session progression — deterministic enough to debug, varied
  // enough to feel fresh. (No Date/random in the seed: the count varies it.)
  _boardsDone++;
  _firstTipPending = true;
  _flagTipShown = false;
  _chordTipShown = false;
  _namesUsed = new Set();
  _lessonBoard = generateLessonBoard(_lesson, `s${_boardsDone}`);
  if (!_lessonBoard) {
    showToast('Could not build a lesson board. Please try again', 2500);
    _showView('select');
    return;
  }
  applyLessonOpening(_lessonBoard);
  _overlay.querySelector('.lexicon-naming').classList.add('hidden');
  _overlay.querySelector('.lexicon-actions').classList.add('hidden');
  const coach = _overlay.querySelector('.lexicon-coach');
  if (coach) coach.textContent = '';
  if (_coachTimer) { clearTimeout(_coachTimer); _coachTimer = null; }
  _render();
}

function _render() {
  const grid = _overlay.querySelector('.lexicon-grid');
  const { board, rows, cols } = _lessonBoard;
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.innerHTML = '';
  let mines = 0;
  let flags = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = board[r][c];
      if (cell.isMine) mines++;
      if (cell.isFlagged) flags++;
      const el = document.createElement('div');
      el.className = 'lexicon-cell ' + (cell.isRevealed ? 'revealed' : 'unrevealed');
      el.dataset.row = r;
      el.dataset.col = c;
      if (cell.isRevealed && cell.adjacentMines > 0) {
        el.textContent = cell.adjacentMines;
        el.dataset.num = cell.adjacentMines;
      } else if (!cell.isRevealed && cell.isFlagged) {
        el.innerHTML = uiSpriteImgHTML('flag', 'gym-piece');
        el.classList.add('flagged');
      }
      grid.appendChild(el);
    }
  }
  // The same anchor the main game's LCD gives: how many mines are
  // unaccounted for.
  _overlay.querySelector('.lexicon-mines-left').innerHTML = `${uiSpriteImgHTML('mine', 'inline-mine')} ${mines - flags} left`;
  _overlay.querySelector('.lexicon-board-count').textContent = `Board ${_boardsDone}`;
}

// Open a provably-safe square, flooding zeros like the real game.
// Returns how many cells opened so the caller can voice it.
function _floodOpen(row, col) {
  const { board, rows, cols } = _lessonBoard;
  let opened = 0;
  const queue = [[row, col]];
  while (queue.length > 0) {
    const [r, c] = queue.pop();
    const cc = board[r][c];
    if (cc.isRevealed || cc.isMine) continue;
    cc.isRevealed = true;
    opened++;
    if (cc.adjacentMines === 0) {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) queue.push([nr, nc]);
        }
      }
    }
  }
  return opened;
}

// Voice the move, repaint, and handle the naming moment. Returns true
// when the board just completed.
function _finishMove(opened) {
  if (opened > 1) playCascade(opened);
  else if (opened === 1) playReveal();
  _render();
  if (lessonComplete(_lessonBoard)) {
    playWin();
    const naming = _overlay.querySelector('.lexicon-naming');
    naming.textContent = _lesson.naming;
    naming.classList.remove('hidden');
    _overlay.querySelector('.lexicon-actions').classList.remove('hidden');
    return true;
  }
  return false;
}

// ── In-the-moment coaching ──────────────────────────────
// The gate teaches on FAILURE (Socratic bounce); these notes teach on
// SUCCESS, naming the technique the player just performed. Pacing rules
// so it never becomes noise: named shapes earn a cheer every time (the
// first per board carrying the recognition tip); proven-mine flags get
// their reasoning once per board, then a nod; trivial counting reveals
// are voiced only in the counting lesson, where they ARE the technique.
function _celebrate(ded, kind, precomputedCls) {
  if (!ded) return;
  const { board, rows, cols } = _lessonBoard;
  const cls = precomputedCls
    || classifyPattern(board, { row: ded.row, col: ded.col, tier: ded.tier, sources: ded.sources, kind }, { rows, cols });
  const name = cls.name;

  // The Counting lesson frames every safe reveal as counting: its tier-0
  // boards route through subsets flags-blind, but the player's process
  // (flag the forced mines, then clear what those numbers satisfy) IS
  // counting. Mine flags fall through to the flag-reduction beat below.
  if (_lesson.id === 'countingBasics' && kind === 'safe') { _cheerShape('count'); return; }

  // A recognized shape — for a safe reveal OR a proven-mine flag (the
  // 1-3-1's key move is FLAGGING the forced corner) — earns its cheer and
  // is recorded.
  if (PATTERN_SHAPE_NAMES.has(name)) { _cheerShape(name); return; }

  // A bigger pair (2-2, 3-2, ...) is a 1-1 or 1-2 wearing bigger numbers.
  // Nod to it so the player learns to see the basic pattern through the
  // larger digits — sometimes a 1-1 or 1-2 is just a little hidden.
  if (name === 'pair' && (cls.family === '1-1' || cls.family === '1-2')) { _nodPair(ded, cls.family); return; }

  // A proven-mine flag with no named shape: the reasoning, once per board.
  if (kind === 'mine') {
    if (!_flagTipShown) {
      _flagTipShown = true;
      if (_lesson.id === 'countingBasics') {
        _coach('Proven mine. Flag it, and every number beside it now needs one fewer, which often opens the next safe square.', 5600, 'uiPin');
      } else {
        const why = explainDeduction(board, ded, { style: 'full', kind: 'mine' });
        _coach(why ? `Proven mine. ${why}` : 'Proven mine.', 5200, 'uiPin');
      }
    } else {
      _coach('Proven mine.', 2000, 'uiPin');
    }
    return;
  }
  // Safe reveal, no named shape, outside the counting lesson: plain
  // propagation, stays quiet.
}

// Cheer a named technique (or counting): record it, then voice it with
// the recognition tip on the first of the board and short affirmations
// after.
function _cheerShape(name) {
  const copy = PATTERN_COACH[name];
  if (!copy) return;
  recordGymTechnique(name);
  const firstOfName = !_namesUsed.has(name);
  _namesUsed.add(name);
  if (_firstTipPending) {
    _firstTipPending = false;
    _coach(`${copy.cheer} ${copy.tip}`, 6500, 'uiSuccess');
  } else if (firstOfName) {
    _coach(`${copy.cheer}`, 2600, 'uiSuccess');
  } else {
    _coach(`${copy.again}`, 2400, 'uiSuccess');
  }
}

// The two clue digits behind a subset move, e.g. "2-3", read from the
// source clues (which stay revealed through the move). Null if unreadable.
function _clueDigits(ded) {
  if (!ded.sources || ded.sources.length < 2) return null;
  const board = _lessonBoard.board;
  const ds = ded.sources
    .map(s => { const cc = board[s.row]?.[s.col]; return cc && cc.isRevealed && !cc.isMine ? (cc.displayedMines != null ? cc.displayedMines : cc.adjacentMines) : null; })
    .filter(n => typeof n === 'number')
    .sort((a, b) => a - b);
  return ds.length >= 2 ? `${ds[0]}-${ds[1]}` : null;
}

// A bigger pair is a basic pattern in disguise: nod to it (recorded under
// the family) so the player learns to read past the larger digits. The
// first of each family on a board carries the why; repeats get a short
// nod. Lighter than a full lesson cheer, and it never consumes the
// first-tip slot the lesson's own pattern is owed.
function _nodPair(ded, family) {
  recordGymTechnique(family);
  const digits = _clueDigits(ded);
  const lead = digits ? `A ${digits} is` : 'That is';
  const key = `pair-${family}`;
  if (_namesUsed.has(key)) {
    _coach(`Another ${family} hiding behind bigger numbers.`, 2400, 'uiSuccess');
    _namesUsed.add(key);
    return;
  }
  _namesUsed.add(key);
  if (family === '1-1') {
    _coach(`${lead} a 1-1 wearing bigger numbers: two clues that need the same amount and watch the same squares, so the shared squares satisfy both and the extra one is safe. What matters is that they match, not their size.`, 5200, 'uiSuccess');
  } else {
    _coach(`${lead} a 1-2 wearing bigger numbers: one clue needs more than its neighbor, so its extra mines hide in the squares only it can see, and the smaller one's far square is safe. Read the gap between them, not their size.`, 5200, 'uiSuccess');
  }
}

// Gated flagging: a flag only sticks on a square the clues can settle as
// a MINE. Tapping a flagged square unflags it.
function _tryFlag(row, col) {
  if (!_lessonBoard) return;
  const { board } = _lessonBoard;
  const cell = board[row]?.[col];
  if (!cell || cell.isRevealed) return;
  if (cell.isFlagged) {
    cell.isFlagged = false;
    playUnflag();
    _render();
    return;
  }
  const frontier = findDeducibleFrontier(board, { respectFlags: false });
  const provablyMine = frontier.mines.some(m => m.row === row && m.col === col);
  if (!provablyMine) {
    _bounce(row, col);
    const hit = _lowestTier(frontier.mines) || _lowestTier(frontier.safe);
    if (hit) {
      _pulse(hit.sources);
      const ask = explainDeduction(board, hit, {
        style: 'socratic',
        kind: frontier.mines.includes(hit) ? 'mine' : 'safe',
      });
      if (ask) _coach(`The clues can't pin that square yet. ${ask}`, 5200, 'uiLens');
    } else {
      _coach('The clues can\'t pin that square as a mine yet', 3600, 'uiLens');
    }
    return;
  }
  const ded = frontier.mines.find(m => m.row === row && m.col === col);
  // Classify BEFORE the flag lands — flagging removes the square from its
  // clues' hidden sets and dissolves the shape (the 1-3-1's forced corner
  // would otherwise read as a bare tier-2 region once flagged).
  const moveCls = ded
    ? classifyPattern(board, { row, col, tier: ded.tier, sources: ded.sources, kind: 'mine' }, { rows: _lessonBoard.rows, cols: _lessonBoard.cols })
    : null;
  cell.isFlagged = true;
  playFlag();
  _render();
  _celebrate(ded, 'mine', moveCls);
}

function _bounce(row, col) {
  const el = _cellEl(row, col);
  if (el) {
    el.classList.remove('lexicon-bounce');
    void el.offsetWidth;
    el.classList.add('lexicon-bounce');
  }
  playGateBounce();
}

function _cellEl(row, col) {
  return _overlay.querySelector(`.lexicon-cell[data-row="${row}"][data-col="${col}"]`);
}

// Teach the simplest available step.
function _lowestTier(list) {
  return list.reduce((best, d) => (!best || d.tier < best.tier ? d : best), null);
}

function _pulse(cells) {
  if (_pulseTimer) clearTimeout(_pulseTimer);
  const els = [];
  for (const s of cells) {
    const el = _cellEl(s.row, s.col);
    if (el) { el.classList.add('lexicon-pulse'); els.push(el); }
  }
  _pulseTimer = setTimeout(() => {
    for (const el of els) el.classList.remove('lexicon-pulse');
    _pulseTimer = null;
  }, 2200);
}

function _onCellClick(e) {
  if (!_lessonBoard) return;
  if (_lpFired) { _lpFired = false; return; } // long-press already flagged
  const el = e.target.closest('.lexicon-cell');
  if (!el) return;
  const row = parseInt(el.dataset.row, 10);
  const col = parseInt(el.dataset.col, 10);
  const { board } = _lessonBoard;
  const cell = board[row]?.[col];
  if (!cell) return;
  // Tap on an open number: chord, just like the real game.
  if (cell.isRevealed) { _tryChord(row, col); return; }
  // Flag mode (the 🚩 toggle): a tap flags a proven mine, or unflags. Routes
  // through the same gate as long-press, so a tap on a non-mine still bounces
  // and teaches rather than sticking a guess.
  if (_flagMode) { _tryFlag(row, col); return; }
  // A tap on a flagged square unflags it (flags never block proof — the
  // gate below recomputes from the clues alone).
  if (cell.isFlagged) { cell.isFlagged = false; playUnflag(); _render(); return; }

  const frontier = findDeducibleFrontier(board, { respectFlags: false });
  const provablySafe = frontier.safe.some(s => s.row === row && s.col === col);

  if (!provablySafe) {
    // THE GATE: bounce, point at the clues that hold the SIMPLEST next
    // step, and say in plain words what kind of thinking unlocks it.
    _bounce(row, col);
    const next = _lowestTier(frontier.safe);
    if (next) {
      _pulse(next.sources);
      const ask = explainDeduction(board, next, { style: 'socratic', kind: 'safe' });
      if (ask) _coach(`Not that one yet. ${ask}`, 5200, 'uiLens');
    }
    return;
  }

  const ded = frontier.safe.find(s => s.row === row && s.col === col);
  // Classify BEFORE the reveal. Flooding the cell and its neighbors
  // dissolves the pattern's hidden front, so a 1-2-1 read afterward would
  // fall back to the bare digit pair (1-1). Name the move from the state
  // the player actually solved.
  const { rows, cols } = _lessonBoard;
  const moveCls = classifyPattern(
    board, { row, col, tier: ded.tier, sources: ded.sources, kind: 'safe' }, { rows, cols },
  );
  _finishMove(_floodOpen(row, col));
  // The cheer rides the coach line; the completion naming (if the board
  // just finished) rides its own line below, so both can show at once.
  _celebrate(ded, 'safe', moveCls);
}

// Chord on an open number. Gym flags are gate-proven mines, so a number
// whose flags match it has PROVEN its remaining neighbors safe — the
// chord is the physical shortcut for exactly the deduction the gym
// teaches, and it can never hit a mine here.
function _tryChord(row, col) {
  const { board, rows, cols } = _lessonBoard;
  const cell = board[row][col];
  if (!cell.adjacentMines) return;
  let flags = 0;
  const hidden = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr, nc = col + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      const n = board[nr][nc];
      if (n.isFlagged) flags++;
      else if (!n.isRevealed) hidden.push([nr, nc]);
    }
  }
  if (hidden.length === 0) return;
  // An idle tap on a number with no flags around it stays silent; a
  // half-flagged chord attempt gets the teaching bounce.
  if (flags !== cell.adjacentMines) {
    if (flags > 0) {
      _bounce(row, col);
      _coach('Flag all of this number\'s mines first, then tap it to open the rest', 3800, 'uiLens');
    }
    return;
  }
  let opened = 0;
  for (const [nr, nc] of hidden) opened += _floodOpen(nr, nc);
  const completed = _finishMove(opened);
  if (!completed && opened > 0 && !_chordTipShown) {
    _chordTipShown = true;
    _coach(`Chorded: the ${cell.adjacentMines} was fully flagged, so everything else around it opened at once`, 3600, 'uiChord');
  }
}

// ── Greg's Field Notebook ────────────────────────────────
// One entry per technique: a tiny sketch, the plain rule, and how many
// times you have performed it in the gym (every count is a gate-proven
// deduction). Reachable from the lesson-select screen.
function _renderNotebook() {
  const wrap = _overlay.querySelector('.lexicon-notebook');
  const counts = getGymTechniqueCounts();
  let html = '<p class="lexicon-notebook-intro">Greg keeps a note on every technique his gym teaches. The count is how many times you have performed it here, each one a square the clues proved.</p>';
  for (const id of LESSON_ORDER) {
    const lesson = LESSONS[id];
    const n = (TECHNIQUE_KEYS[id] || []).reduce((s, k) => s + (counts[k] || 0), 0);
    html += `
      <div class="lexicon-note">
        <div class="lexicon-note-sketch">${_sketchHTML(SKETCHES[id])}</div>
        <div class="lexicon-note-body">
          <div class="lexicon-note-head">
            <span class="lexicon-note-name">${lesson.name}</span>
            <span class="lexicon-note-count">${n === 0 ? 'not yet' : n === 1 ? '1 time' : `${n} times`}</span>
          </div>
          <p class="lexicon-note-rule">${lesson.rule}</p>
        </div>
      </div>`;
  }
  wrap.innerHTML = html;
}

function _sketchHTML(grid) {
  if (!grid) return '';
  const cols = grid[0].length;
  let cells = '';
  for (const rowStr of grid) {
    for (const ch of rowStr) {
      if (ch === '.') cells += '<span class="sk sk-hidden"></span>';
      else if (ch === 'M') cells += `<span class="sk sk-mine">${uiSpriteImgHTML('mine', 'gym-sketch')}</span>`;
      else if (ch === 'S') cells += '<span class="sk sk-safe">✓</span>';
      else cells += `<span class="sk sk-num" data-num="${ch}">${ch}</span>`;
    }
  }
  return `<div class="lexicon-sketch" style="grid-template-columns:repeat(${cols},1fr)">${cells}</div>`;
}

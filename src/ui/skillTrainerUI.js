// ── Skill Trainer UI ──────────────────────────────────
// Manages the Skill Trainer mode: guided puzzles that teach
// minesweeper techniques through interactive mini-boards.

import {
  SKILL_LESSONS,
  getLesson,
  getLessonsByCategory,
  loadSkillProgress,
  saveSkillProgress,
  markPuzzleCompleted,
  getLessonStars,
} from '../logic/skillTrainer.js?v=1.0';

import { $, $$ } from './domHelpers.js?v=1.0';
import { playReveal, playWin, playFlag } from '../audio/sounds.js?v=1.0';

// ── Constants ─────────────────────────────────────────

const NUMBER_COLORS = {
  1: '#1565c0',
  2: '#2e7d32',
  3: '#c62828',
  4: '#4527a0',
  5: '#880e4f',
  6: '#00838f',
  7: '#37474f',
  8: '#78909c',
};

const CATEGORIES = ['Beginner', 'Intermediate', 'Advanced', 'Modifiers'];

// ── Module State ──────────────────────────────────────

let currentLessonId = null;
let currentCategory = null;
let currentPuzzleIndex = 0;
let mistakeCount = 0;
let completedMoves = new Set();
let feedbackTimeout = null;

// ── Helpers ───────────────────────────────────────────

function getContainer() {
  return $('#skill-trainer-container');
}

function clearFeedbackTimeout() {
  if (feedbackTimeout) {
    clearTimeout(feedbackTimeout);
    feedbackTimeout = null;
  }
}

// ── Exported Functions ────────────────────────────────

/**
 * Show the skill trainer UI (called when switching to skillTrainer mode).
 * Renders the category picker into #skill-trainer-container.
 */
export function showSkillTrainer() {
  const container = getContainer();
  if (!container) return;
  container.classList.remove('hidden');
  container.classList.add('skill-trainer-container');
  currentLessonId = null;
  currentPuzzleIndex = 0;
  mistakeCount = 0;
  completedMoves = new Set();
  renderCategoryPicker();
}

/**
 * Hide the skill trainer UI.
 */
export function hideSkillTrainer() {
  const container = getContainer();
  if (!container) return;
  container.classList.add('hidden');
  container.innerHTML = '';
  clearFeedbackTimeout();
}

/**
 * Returns the number of completed lessons (for title screen progress display).
 */
export function getSkillTrainerCompletedCount() {
  const progress = loadSkillProgress();
  let count = 0;
  for (const lessonId of Object.keys(SKILL_LESSONS)) {
    const stars = getLessonStars(lessonId, progress);
    if (stars > 0) count++;
  }
  return count;
}

// ── Category Picker ───────────────────────────────────

const CATEGORY_ICONS = { Beginner: '🟢', Intermediate: '🟡', Advanced: '🔴' , Modifiers: '⚙️' };

function renderCategoryPicker() {
  const container = getContainer();
  if (!container) return;
  container.innerHTML = '';
  clearFeedbackTimeout();

  const heading = document.createElement('h2');
  heading.className = 'skill-trainer-heading';
  heading.textContent = 'Skill Trainer';
  container.appendChild(heading);

  const cardsWrapper = document.createElement('div');
  cardsWrapper.className = 'skill-category-cards';

  const progress = loadSkillProgress();

  for (const category of CATEGORIES) {
    const lessons = getLessonsByCategory(category);
    let completed = 0;
    for (const lesson of lessons) {
      if (getLessonStars(lesson.id, progress) > 0) completed++;
    }

    const card = document.createElement('button');
    card.className = 'skill-category-card';
    card.type = 'button';

    const icon = document.createElement('div');
    icon.className = 'skill-category-card-icon';
    icon.textContent = CATEGORY_ICONS[category] || '📚';

    const info = document.createElement('div');
    info.className = 'skill-category-card-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'skill-category-card-name';
    nameEl.textContent = category;

    const progressEl = document.createElement('div');
    progressEl.className = 'skill-category-card-progress';
    progressEl.textContent = `${completed}/${lessons.length} completed`;

    info.appendChild(nameEl);
    info.appendChild(progressEl);

    const arrow = document.createElement('div');
    arrow.className = 'skill-category-card-arrow';
    arrow.textContent = '›';

    card.appendChild(icon);
    card.appendChild(info);
    card.appendChild(arrow);

    if (completed === lessons.length && lessons.length > 0) {
      card.classList.add('all-complete');
    }

    card.addEventListener('click', () => {
      renderCategoryLessons(category);
    });

    cardsWrapper.appendChild(card);
  }

  container.appendChild(cardsWrapper);
}

function renderCategoryLessons(category) {
  currentCategory = category;
  const container = getContainer();
  if (!container) return;
  container.innerHTML = '';
  clearFeedbackTimeout();

  const backBtn = document.createElement('button');
  backBtn.className = 'skill-back-btn';
  backBtn.type = 'button';
  backBtn.textContent = '← Back';
  backBtn.addEventListener('click', () => renderCategoryPicker());
  container.appendChild(backBtn);

  const heading = document.createElement('h2');
  heading.className = 'skill-trainer-heading';
  heading.textContent = `${CATEGORY_ICONS[category] || ''} ${category}`;
  container.appendChild(heading);

  const lessons = getLessonsByCategory(category);
  const progress = loadSkillProgress();

  const lessonList = document.createElement('div');
  lessonList.className = 'skill-lesson-list';

  for (const lesson of lessons) {
    const card = document.createElement('button');
    card.className = 'skill-lesson-card';
    card.type = 'button';

    const stars = getLessonStars(lesson.id, progress);
    if (stars > 0) card.classList.add('completed');

    const nameEl = document.createElement('div');
    nameEl.className = 'skill-lesson-name';
    nameEl.textContent = lesson.name;

    const descEl = document.createElement('div');
    descEl.className = 'skill-lesson-desc';
    descEl.textContent = lesson.description;

    const statusEl = document.createElement('div');
    statusEl.className = 'skill-lesson-status';
    if (stars > 0) {
      statusEl.textContent = buildStarDisplay(stars);
    } else {
      const lessonProgress = progress[lesson.id];
      if (lessonProgress && lessonProgress.completedPuzzles && lessonProgress.completedPuzzles.length > 0) {
        statusEl.textContent = 'In Progress';
        statusEl.classList.add('in-progress');
      }
    }

    card.appendChild(nameEl);
    card.appendChild(descEl);
    card.appendChild(statusEl);

    card.addEventListener('click', () => {
      currentLessonId = lesson.id;
      currentPuzzleIndex = 0;
      mistakeCount = 0;
      completedMoves = new Set();
      renderLesson(lesson.id);
    });

    lessonList.appendChild(card);
  }

  container.appendChild(lessonList);
}

function buildStarDisplay(stars) {
  let display = '';
  for (let i = 0; i < 3; i++) {
    display += i < stars ? '\u2605' : '\u2606';
  }
  return display;
}

// ── Lesson View ───────────────────────────────────────

function renderLesson(lessonId) {
  const container = getContainer();
  if (!container) return;
  container.innerHTML = '';
  clearFeedbackTimeout();

  const lesson = getLesson(lessonId);
  if (!lesson) return;

  // Back button
  const backBtn = document.createElement('button');
  backBtn.className = 'skill-back-btn';
  backBtn.type = 'button';
  backBtn.textContent = '\u2190 Back';
  backBtn.addEventListener('click', () => {
    currentLessonId = null;
    if (currentCategory) {
      renderCategoryLessons(currentCategory);
    } else {
      renderCategoryPicker();
    }
  });
  container.appendChild(backBtn);

  // Lesson title
  const title = document.createElement('h2');
  title.className = 'skill-lesson-title';
  title.textContent = lesson.name;
  container.appendChild(title);

  // Explanation
  const explanation = document.createElement('div');
  explanation.className = 'skill-explanation';
  explanation.textContent = lesson.explanation || lesson.description;
  container.appendChild(explanation);

  // Puzzle progress dots
  const puzzleCount = lesson.puzzles ? lesson.puzzles.length : 0;
  if (puzzleCount > 0) {
    const dotsContainer = document.createElement('div');
    dotsContainer.className = 'skill-progress-dots';
    for (let i = 0; i < puzzleCount; i++) {
      const dot = document.createElement('span');
      dot.className = 'skill-progress-dot';
      if (i < currentPuzzleIndex) {
        dot.classList.add('completed');
      } else if (i === currentPuzzleIndex) {
        dot.classList.add('active');
      }
      dotsContainer.appendChild(dot);
    }
    container.appendChild(dotsContainer);

    // Progress label
    const progressLabel = document.createElement('div');
    progressLabel.className = 'skill-progress-label';
    progressLabel.textContent = `Puzzle ${currentPuzzleIndex + 1} of ${puzzleCount}`;
    container.appendChild(progressLabel);

    // Render the current puzzle board
    const puzzle = lesson.puzzles[currentPuzzleIndex];
    if (puzzle) {
      // Puzzle hint area
      if (puzzle.hint) {
        const hintBtn = document.createElement('button');
        hintBtn.className = 'skill-hint-btn';
        hintBtn.type = 'button';
        hintBtn.textContent = 'Show Hint';
        const hintArea = document.createElement('div');
        hintArea.className = 'skill-hint';
        hintArea.classList.add('hidden');
        hintArea.textContent = puzzle.hint;
        hintBtn.addEventListener('click', () => {
          hintArea.classList.toggle('hidden');
          hintBtn.textContent = hintArea.classList.contains('hidden') ? 'Show Hint' : 'Hide Hint';
        });
        container.appendChild(hintBtn);
        container.appendChild(hintArea);
      }

      renderPuzzleBoard(puzzle);
    }
  }

  // Feedback line (inline, non-blocking — appears below the board)
  const feedback = document.createElement('div');
  feedback.className = 'skill-feedback hidden';
  feedback.id = 'skill-feedback';
  container.appendChild(feedback);

  // Add a sound-only correct indicator (no screen blocking)

}

// ── Puzzle Board Rendering ────────────────────────────

function renderPuzzleBoard(puzzle) {
  const container = getContainer();
  if (!container) return;

  // Remove any existing puzzle board
  const existingBoard = container.querySelector('.skill-puzzle-board');
  if (existingBoard) existingBoard.remove();

  const board = puzzle.board;
  if (!board || board.length === 0) return;

  const rows = board.length;
  const cols = board[0].length;
  const correctMoves = puzzle.correctMoves || [];

  const boardEl = document.createElement('div');
  boardEl.className = 'skill-puzzle-board';
  boardEl.style.gridTemplateColumns = `repeat(${cols}, var(--skill-cell-size, 36px))`;
  boardEl.style.gridTemplateRows = `repeat(${rows}, var(--skill-cell-size, 36px))`;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cellData = board[r][c];
      const cellEl = document.createElement('div');
      cellEl.className = 'skill-cell';
      cellEl.dataset.row = r;
      cellEl.dataset.col = c;

      applyCellAppearance(cellEl, cellData);

      boardEl.appendChild(cellEl);
    }
  }

  // Event delegation for cell clicks
  boardEl.addEventListener('click', (e) => {
    const cellEl = e.target.closest('.skill-cell');
    if (!cellEl) return;
    const row = parseInt(cellEl.dataset.row, 10);
    const col = parseInt(cellEl.dataset.col, 10);
    handlePuzzleClick(row, col, puzzle, correctMoves);
  });

  // Prevent context menu on the puzzle board
  boardEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const cellEl = e.target.closest('.skill-cell');
    if (!cellEl) return;
    const row = parseInt(cellEl.dataset.row, 10);
    const col = parseInt(cellEl.dataset.col, 10);
    handlePuzzleClick(row, col, puzzle, correctMoves, true);
  });

  container.appendChild(boardEl);
}

/**
 * Apply the visual appearance to a puzzle cell based on its data.
 * Cell data format: { state, value }
 *   state: 'unrevealed' | 'revealed' | 'flagged' | 'mine'
 *   value: number (0-8) for revealed cells, or special markers
 */
function applyCellAppearance(cellEl, cellData) {
  // Reset
  cellEl.className = 'skill-cell';
  cellEl.textContent = '';
  cellEl.dataset.row = cellEl.dataset.row;
  cellEl.dataset.col = cellEl.dataset.col;

  if (!cellData) {
    cellEl.classList.add('unrevealed');
    return;
  }

  const cellState = typeof cellData === 'object' ? cellData.state : cellData;
  const cellValue = typeof cellData === 'object' ? cellData.value : undefined;

  switch (cellState) {
    case 'revealed':
      cellEl.classList.add('revealed');
      if (cellValue != null && cellValue > 0) {
        cellEl.textContent = cellValue;
        cellEl.classList.add(`num-${cellValue}`);
        const color = NUMBER_COLORS[cellValue];
        if (color) {
          cellEl.style.color = color;
        }
      }
      break;

    case 'flagged':
      cellEl.classList.add('flagged');
      cellEl.textContent = '\uD83D\uDEA9';
      break;

    case 'mine':
      cellEl.classList.add('mine');
      cellEl.textContent = '\uD83D\uDCA3';
      break;

    case 'wall':
      cellEl.classList.add('wall');
      cellEl.textContent = '🧱';
      break;

    case 'unrevealed':
    default:
      cellEl.classList.add('unrevealed');
      break;
  }

  // Modifier indicators (Skill Trainer modifier lessons)
  if (typeof cellData === 'object') {
    if (cellData.mystery) {
      cellEl.textContent = '?';
      cellEl.classList.add('skill-mystery');
    }
    if (cellData.liar) {
      cellEl.classList.add('skill-liar');
    }
    if (cellData.wormhole) {
      cellEl.classList.add('skill-wormhole');
      if (cellData.pairIndex != null) {
        cellEl.classList.add('skill-wormhole-' + cellData.pairIndex);
      }
    }
    if (cellData.mirror) {
      cellEl.classList.add('skill-mirror');
    }
    if (cellData.locked) {
      cellEl.classList.add('skill-locked');
      if (cellEl.classList.contains('unrevealed')) {
        cellEl.textContent = '🔒';
      }
    }
  }
}

// ── Puzzle Click Handling ─────────────────────────────

function handlePuzzleClick(row, col, puzzle, correctMoves, isRightClick = false) {
  const moveKey = `${row},${col}`;

  // Skip already-completed moves
  if (completedMoves.has(moveKey)) return;

  // Find if this cell is one of the correct moves
  const matchingMove = correctMoves.find(
    (m) => m.row === row && m.col === col
  );

  if (matchingMove) {
    // Check if the action type matches (flag vs reveal)
    const wantsFlag = matchingMove.action === 'flag';
    const playerFlags = isRightClick;

    // If the move requires a specific action, validate it
    if (matchingMove.action && wantsFlag !== playerFlags) {
      showFeedback('Wrong action! Try ' + (wantsFlag ? 'flagging' : 'revealing') + ' this cell.', false);
      mistakeCount++;
      return;
    }

    // Correct move
    completedMoves.add(moveKey);

    // Update the cell visually
    const container = getContainer();
    const boardEl = container ? container.querySelector('.skill-puzzle-board') : null;
    if (boardEl) {
      const board = puzzle.board;
      const cols = board[0].length;
      const cellEl = boardEl.children[row * cols + col];
      if (cellEl) {
        if (wantsFlag || matchingMove.action === 'flag') {
          cellEl.className = 'skill-cell flagged';
          cellEl.textContent = '\uD83D\uDEA9';
          playFlag();
        } else {
          cellEl.className = 'skill-cell revealed';
          const revealValue = matchingMove.value != null
            ? matchingMove.value
            : (typeof puzzle.board[row][col] === 'object'
              ? puzzle.board[row][col].revealValue
              : 0);
          if (revealValue != null && revealValue > 0) {
            cellEl.textContent = revealValue;
            cellEl.classList.add(`num-${revealValue}`);
            const color = NUMBER_COLORS[revealValue];
            if (color) {
              cellEl.style.color = color;
            }
          }
          playReveal();
        }
      }
    }

    // Show progress for multi-move puzzles
    if (correctMoves.length > 1) {
      showFeedback('Correct! (' + completedMoves.size + ' of ' + correctMoves.length + ')', true);
    } else {
      showFeedback('Correct!', true);
    }

    // Check if all correct moves are done
    if (completedMoves.size >= correctMoves.length) {
      clearFeedbackTimeout();

      const lesson = getLesson(currentLessonId);
      const puzzleCount = lesson && lesson.puzzles ? lesson.puzzles.length : 0;

      // Mark this puzzle as completed
      markPuzzleCompleted(currentLessonId, currentPuzzleIndex);

      if (currentPuzzleIndex + 1 < puzzleCount) {
        // Move to next puzzle after a short delay
        setTimeout(() => {
          currentPuzzleIndex++;
          completedMoves = new Set();
          renderLesson(currentLessonId);
        }, 800);
      } else {
        // All puzzles complete — show lesson complete screen
        setTimeout(() => {
          renderLessonComplete(currentLessonId, mistakeCount);
        }, 800);
      }
    }
  } else {
    // Wrong cell
    showFeedback('Try again', false);
    mistakeCount++;
  }
}

// ── Feedback Display ──────────────────────────────────

function showFeedback(message, isCorrect) {
  const feedbackEl = $('#skill-feedback');
  if (!feedbackEl) return;

  clearFeedbackTimeout();

  feedbackEl.textContent = message;
  feedbackEl.className = 'skill-feedback';
  feedbackEl.classList.add(isCorrect ? 'correct' : 'wrong');
  feedbackEl.classList.remove('hidden');

  feedbackTimeout = setTimeout(() => {
    feedbackEl.classList.add('hidden');
  }, 1200);
}

// ── Lesson Complete Screen ────────────────────────────

function renderLessonComplete(lessonId, mistakes) {
  const container = getContainer();
  if (!container) return;
  container.innerHTML = '';
  clearFeedbackTimeout();

  const lesson = getLesson(lessonId);
  if (!lesson) return;

  // Calculate stars
  let stars;
  if (mistakes === 0) {
    stars = 3;
  } else if (mistakes <= 2) {
    stars = 2;
  } else {
    stars = 1;
  }

  // Save progress with star rating
  const progress = loadSkillProgress();
  const existing = progress[lessonId];
  const existingStars = existing ? (existing.stars || 0) : 0;
  if (stars > existingStars) {
    progress[lessonId] = progress[lessonId] || {};
    progress[lessonId].stars = stars;
    saveSkillProgress(progress);
  }

  playWin();

  // Completion UI
  const completeCard = document.createElement('div');
  completeCard.className = 'skill-complete-card';

  const titleEl = document.createElement('h2');
  titleEl.className = 'skill-complete-title';
  titleEl.textContent = 'Lesson Complete!';
  completeCard.appendChild(titleEl);

  const lessonNameEl = document.createElement('div');
  lessonNameEl.className = 'skill-complete-lesson-name';
  lessonNameEl.textContent = lesson.name;
  completeCard.appendChild(lessonNameEl);

  // Stars display
  const starsEl = document.createElement('div');
  starsEl.className = 'skill-complete-stars';
  starsEl.textContent = buildStarDisplay(stars);
  completeCard.appendChild(starsEl);

  // Rating description
  const ratingEl = document.createElement('div');
  ratingEl.className = 'skill-complete-rating';
  if (stars === 3) {
    ratingEl.textContent = 'Perfect! No mistakes!';
  } else if (stars === 2) {
    ratingEl.textContent = `Great job! ${mistakes} mistake${mistakes !== 1 ? 's' : ''}.`;
  } else {
    ratingEl.textContent = `Completed with ${mistakes} mistake${mistakes !== 1 ? 's' : ''}. Practice for more stars!`;
  }
  completeCard.appendChild(ratingEl);

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'skill-complete-actions';

  const retryBtn = document.createElement('button');
  retryBtn.className = 'action-btn';
  retryBtn.type = 'button';
  retryBtn.textContent = 'Retry Lesson';
  retryBtn.addEventListener('click', () => {
    currentPuzzleIndex = 0;
    mistakeCount = 0;
    completedMoves = new Set();
    renderLesson(lessonId);
  });
  actions.appendChild(retryBtn);

  const backBtn = document.createElement('button');
  backBtn.className = 'action-btn primary';
  backBtn.type = 'button';
  backBtn.textContent = 'Back to Lessons';
  backBtn.addEventListener('click', () => {
    currentLessonId = null;
    if (currentCategory) {
      renderCategoryLessons(currentCategory);
    } else {
      renderCategoryPicker();
    }
  });
  actions.appendChild(backBtn);

  completeCard.appendChild(actions);
  container.appendChild(completeCard);
}

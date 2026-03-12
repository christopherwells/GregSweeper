import { state, getRevealedCells } from '../state/gameState.js?v=1.0.8';
import { $, $$, boardEl, scanToast } from '../ui/domHelpers.js?v=1.0.8';
import { updateAllCells } from '../ui/boardRenderer.js?v=1.0.8';
import { showGreenFlash } from '../ui/effectsRenderer.js?v=1.0.8';
import { showToast } from '../ui/toastManager.js?v=1.0.8';
import { updateHeader } from '../ui/headerRenderer.js?v=1.0.8';
import { updatePowerUpBar } from '../ui/powerUpBar.js?v=1.0.8';
import { findSafeCell, scanRowCol, shieldDefuse, xRayScan, magnetPull } from '../logic/powerUps.js?v=1.0.8';
import { checkWin } from '../logic/boardSolver.js?v=1.0.8';
import { saveModePowerUps } from '../storage/statsStorage.js?v=1.0.8';
import {
  playPowerUp, playShieldBreak, playXRay, playLifelineSave, playMagnet,
} from '../audio/sounds.js?v=1.0.8';

// Forward declaration — set by winLossHandler to avoid circular import
let _handleWin = null;
export function setHandleWin(fn) { _handleWin = fn; }

// ── Reveal Safe ──────────────────────────────────────
export function useRevealSafe() {
  if (state.powerUps.revealSafe <= 0 || state.status === 'won' || state.status === 'lost') return;
  const cell = findSafeCell(state.board);
  if (!cell) return;
  playPowerUp();
  state.powerUps.revealSafe--;
  state.usedPowerUps = true;
  saveModePowerUps(state.gameMode, state.powerUps);
  cell.isRevealed = true;
  cell.revealAnimDelay = 0;
  state.revealedCount++;

  const cellEl = boardEl.children[cell.row * state.cols + cell.col];
  if (cellEl) {
    cellEl.classList.add('golden-reveal');
    const rect = cellEl.getBoundingClientRect();
    const boardRect = boardEl.getBoundingClientRect();
    const ripple = document.createElement('div');
    ripple.className = 'golden-ripple';
    ripple.style.left = (rect.left - boardRect.left + rect.width / 2) + 'px';
    ripple.style.top = (rect.top - boardRect.top + rect.height / 2) + 'px';
    boardEl.style.position = 'relative';
    boardEl.appendChild(ripple);
    setTimeout(() => ripple.remove(), 800);
  }

  updateAllCells();
  updateHeader();
  updatePowerUpBar();
  if (checkWin(state.board) && _handleWin) _handleWin();
}

// ── Shield ──────────────────────────────────────
export function useShield() {
  if (state.powerUps.shield <= 0 || state.status === 'won' || state.status === 'lost') return;
  playPowerUp();
  state.powerUps.shield--;
  state.usedPowerUps = true;
  state.shieldActive = true;
  saveModePowerUps(state.gameMode, state.powerUps);
  updatePowerUpBar();
}

// ── Lifeline (passive — called from gameActions on mine hit) ──
export function tryLifeline(row, col) {
  if (!state.powerUps.lifeline || state.powerUps.lifeline <= 0) return false;

  state.powerUps.lifeline--;
  state.usedPowerUps = true;
  saveModePowerUps(state.gameMode, state.powerUps);
  playLifelineSave();

  // Flag the mine instead of dying
  state.board[row][col].isFlagged = true;
  state.flagCount++;

  // Golden ripple / shield-break style flash
  const cellEl = boardEl.children[row * state.cols + col];
  if (cellEl) {
    cellEl.classList.add('lifeline-save');
    setTimeout(() => cellEl.classList.remove('lifeline-save'), 1200);
  }

  const flash = document.createElement('div');
  flash.className = 'lifeline-flash';
  document.getElementById('app').appendChild(flash);
  setTimeout(() => flash.remove(), 800);

  // Green screen flash to signal "saved!"
  showGreenFlash();

  // Prominent toast so user knows lifeline was used
  showToast('❤️ Lifeline saved you! Mine auto-flagged.');

  updateAllCells();
  updateHeader();
  updatePowerUpBar();
  return true;
}

// ── Scan Row/Col ──────────────────────────────────────
export function activateScan() {
  if (state.powerUps.scanRowCol <= 0 || state.status === 'won' || state.status === 'lost') return;
  playPowerUp();
  state.usedPowerUps = true;
  state.scanMode = !state.scanMode;
  if (state.magnetMode) state.magnetMode = false;
  updatePowerUpBar();
}

export function performScan(row, col) {
  state.powerUps.scanRowCol--;
  state.scanMode = false;
  saveModePowerUps(state.gameMode, state.powerUps);
  const result = scanRowCol(state.board, row, col);

  boardEl.style.position = 'relative';
  const clickedEl = boardEl.children[row * state.cols + col];
  if (clickedEl) {
    const rect = clickedEl.getBoundingClientRect();
    const boardRect = boardEl.getBoundingClientRect();

    const sweepH = document.createElement('div');
    sweepH.className = 'scan-sweep-h';
    sweepH.style.top = (rect.top - boardRect.top + rect.height / 2) + 'px';
    boardEl.appendChild(sweepH);
    setTimeout(() => sweepH.remove(), 600);

    const sweepV = document.createElement('div');
    sweepV.className = 'scan-sweep-v';
    sweepV.style.left = (rect.left - boardRect.left + rect.width / 2) + 'px';
    boardEl.appendChild(sweepV);
    setTimeout(() => sweepV.remove(), 600);
  }

  for (let c = 0; c < state.cols; c++) {
    const el = boardEl.children[row * state.cols + c];
    if (el) {
      el.style.animationDelay = (Math.abs(c - col) * 40) + 'ms';
      el.classList.add('scan-highlight');
    }
  }
  for (let r = 0; r < state.rows; r++) {
    const el = boardEl.children[r * state.cols + col];
    if (el) {
      el.style.animationDelay = (Math.abs(r - row) * 40) + 'ms';
      el.classList.add('scan-highlight');
    }
  }

  const minesInScan = [];
  for (let c = 0; c < state.cols; c++) {
    if (state.board[row][c].isMine && !state.board[row][c].isRevealed) {
      const el = boardEl.children[row * state.cols + c];
      if (el) minesInScan.push({ el, delay: Math.abs(c - col) * 40 });
    }
  }
  for (let r = 0; r < state.rows; r++) {
    if (state.board[r][col].isMine && !state.board[r][col].isRevealed) {
      const el = boardEl.children[r * state.cols + col];
      if (el && !minesInScan.some(m => m.el === el)) {
        minesInScan.push({ el, delay: Math.abs(r - row) * 40 });
      }
    }
  }
  minesInScan.forEach(({ el, delay }) => {
    setTimeout(() => el.classList.add('xray-mine'), 200 + delay);
  });

  scanToast.textContent = `Row ${row + 1}: ${result.rowMines} mine${result.rowMines !== 1 ? 's' : ''} | Col ${col + 1}: ${result.colMines} mine${result.colMines !== 1 ? 's' : ''}`;
  scanToast.classList.remove('hidden');

  setTimeout(() => {
    scanToast.classList.add('hidden');
    for (const el of $$('.scan-highlight')) {
      el.classList.remove('scan-highlight');
      el.style.animationDelay = '';
    }
    for (const el of $$('.xray-mine')) el.classList.remove('xray-mine');
  }, 3000);

  updatePowerUpBar();
}

// ── Magnet Power-Up ──────────────────────────────────
export function activateMagnet() {
  if (state.powerUps.magnet <= 0 || state.status === 'won' || state.status === 'lost') return;
  playPowerUp();
  state.usedPowerUps = true;
  state.magnetMode = !state.magnetMode;
  if (state.scanMode) state.scanMode = false;
  if (state.xrayMode) state.xrayMode = false;
  updatePowerUpBar();
}

export function performMagnet(row, col) {
  state.powerUps.magnet--;
  state.magnetMode = false;
  playMagnet();
  saveModePowerUps(state.gameMode, state.powerUps);

  const { movedMines, affectedArea } = magnetPull(state.board, row, col);

  // Highlight the 3x3 area with magnet animation
  for (const cell of affectedArea) {
    const el = boardEl.children[cell.row * state.cols + cell.col];
    if (el) {
      el.classList.add('magnet-area');
      setTimeout(() => el.classList.remove('magnet-area'), 1500);
    }
  }

  scanToast.textContent = `🧲 Pulled ${movedMines.length} mine${movedMines.length !== 1 ? 's' : ''} away`;
  scanToast.classList.remove('hidden');
  setTimeout(() => scanToast.classList.add('hidden'), 2500);

  // Update revealed cells that had adjacency changes
  updateAllCells();
  updateHeader();
  updatePowerUpBar();
}

// ── X-Ray Power-Up ──────────────────────────────────
export function activateXRay() {
  if (state.powerUps.xray <= 0 || state.status === 'won' || state.status === 'lost') return;
  playPowerUp();
  state.usedPowerUps = true;
  state.xrayMode = !state.xrayMode;
  if (state.magnetMode) state.magnetMode = false;
  updatePowerUpBar();
}

export function performXRay(row, col) {
  state.powerUps.xray--;
  state.xrayMode = false;
  playXRay();
  saveModePowerUps(state.gameMode, state.powerUps);

  const mines = xRayScan(state.board, row, col);

  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const nr = row + dr;
      const nc = col + dc;
      if (nr >= 0 && nr < state.rows && nc >= 0 && nc < state.cols) {
        const el = boardEl.children[nr * state.cols + nc];
        if (el) el.classList.add('xray-area');
      }
    }
  }

  const centerEl = boardEl.children[row * state.cols + col];
  if (centerEl) {
    const scanLine = document.createElement('div');
    scanLine.className = 'xray-scan-line';
    boardEl.style.position = 'relative';
    boardEl.appendChild(scanLine);
    setTimeout(() => scanLine.remove(), 700);
  }

  mines.forEach((mine, i) => {
    setTimeout(() => {
      const el = boardEl.children[mine.row * state.cols + mine.col];
      if (el) el.classList.add('xray-mine');
    }, 200 + i * 80);
  });

  scanToast.textContent = `🔬 X-Ray: ${mines.length} mine${mines.length !== 1 ? 's' : ''} in area`;
  scanToast.classList.add('xray-toast-top');
  scanToast.classList.remove('hidden');

  setTimeout(() => {
    scanToast.classList.add('hidden');
    scanToast.classList.remove('xray-toast-top');
    for (const el of $$('.xray-area')) el.classList.remove('xray-area');
    for (const el of $$('.xray-mine')) el.classList.remove('xray-mine');
  }, 3000);

  updatePowerUpBar();
}

// ── Award Power-Ups ──────────────────────────────────
export function awardPowerUps(stats) {
  if (state.gameMode === 'timed' || state.gameMode === 'daily') return '';

  const types = ['revealSafe', 'shield', 'scanRowCol', 'lifeline', 'magnet', 'xray'];
  const labels = {
    revealSafe: '🔍 Reveal Safe', shield: '🛡️ Shield', scanRowCol: '🎯 Scan',
    lifeline: '❤️ Lifeline', magnet: '🧲 Magnet', xray: '🔬 X-Ray',
  };

  const awarded = [];
  for (let i = 0; i < 2; i++) {
    const pick = types[Math.floor(Math.random() * types.length)];
    state.powerUps[pick] = (state.powerUps[pick] || 0) + 1;
    awarded.push(labels[pick]);
  }

  return awarded.join(' + ');
}

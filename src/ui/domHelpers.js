// ── DOM Utilities & References ─────────────────────────

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => document.querySelectorAll(sel);

// Canonical HTML escaper for player-controlled strings interpolated
// into innerHTML (leaderboard names, account emails, …). The single
// source of truth — this used to exist as three private copies
// (main.js ×2, winLossHandler.js ×1), which is one forgotten import
// away from an XSS. Escapes quotes too, so the result is safe in
// attribute position as well as text position; the old detached-div
// trick was not.
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export const boardEl = $('#board');
export const mineCounterEl = $('#mine-counter');
export const timerEl = $('#timer-display');
export const resetBtn = $('#reset-btn');
export const levelDisplay = $('#level-display');
export const checkpointDisplay = $('#checkpoint-display');
export const streakDisplayEl = $('#streak-display');
export const cellsRemainingEl = $('#cells-remaining');
export const progressBarContainer = $('#progress-bar-container');
export const progressBarFill = $('#progress-bar-fill');
export const progressBarMarkers = $('#progress-bar-markers');
export const flagModeBar = $('#flag-mode-bar');
export const flagModeToggle = $('#flag-mode-toggle');
export const flagModeIcon = $('#flag-mode-icon');
export const flagModeLabel = $('#flag-mode-label');
export const shakeWrapper = $('#screen-shake-wrapper');
export const particleCanvas = $('#particle-canvas');
export const scanToast = $('#scan-toast');
export const muteBtn = $('#btn-mute');
export const bestTimeDisplay = $('#best-time-display');
export const maxLevelDisplay = $('#max-level-display');
export const streakBorder = $('#streak-border');
export const zoomControls = $('#zoom-controls');
export const zoomLevelDisplay = $('#zoom-level');
export const boardScrollWrapper = $('#board-scroll-wrapper');
export const toastContainer = $('#toast-container');

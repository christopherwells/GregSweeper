import { toastContainer } from './domHelpers.js?v=1.0.9';

// ── Toast Queue ────────────────────────────────────────
const _toastQueue = [];
let _toastActive = false;

export function showToast(message, duration = 2000) {
  _toastQueue.push({ message, duration });
  if (!_toastActive) _processToastQueue();
}

function _processToastQueue() {
  if (_toastQueue.length === 0) { _toastActive = false; return; }
  _toastActive = true;
  const { message, duration } = _toastQueue.shift();
  const el = document.createElement('div');
  el.className = 'queued-toast';
  el.textContent = message;
  if (toastContainer) toastContainer.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-exit');
    setTimeout(() => {
      el.remove();
      _processToastQueue();
    }, 250);
  }, duration);
}

// ── Level Up Toast ─────────────────────────────────────

export function showLevelUpToast(level) {
  const toast = document.createElement('div');
  toast.className = 'level-up-toast';
  toast.textContent = `Level ${level}!`;
  document.getElementById('app').appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

// ── Checkpoint Toast ──────────────────────────────────

export function showCheckpointToast(checkpointLevel) {
  const toast = document.createElement('div');
  toast.className = 'checkpoint-toast';
  toast.innerHTML = `🏁 Checkpoint! <span style="font-size:12px; opacity:0.8">Level ${checkpointLevel}</span>`;
  document.getElementById('app').appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

// ── Level Info Toast ───────────────────────────────────

export function showLevelInfoToast(level, diff, label) {
  const toast = document.createElement('div');
  toast.className = 'level-info-toast';
  const sizeLabel = `${diff.rows}×${diff.cols}`;
  const mineLabel = `${diff.mines} mines`;
  const timeLabel = ''; // Timed mode counts up now, no time limit to show
  const title = label ? `${label}` : `Level ${level}`;
  toast.innerHTML = `<strong>${title}</strong><br><span class="level-info-details">${sizeLabel} · ${mineLabel}${timeLabel}</span>`;
  document.getElementById('app').appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

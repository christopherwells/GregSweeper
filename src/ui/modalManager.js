import { $, $$ } from './domHelpers.js';

// ── Focus trap ────────────────────────────────────────
// Per R2 research: native <dialog> on iOS Safari does NOT auto-trap
// focus, so we'd have to write this trap anyway. Implementing it
// here on the existing custom modals avoids the iOS dialog pitfalls
// (display:none transitions, dialog::backdrop quirks) while still
// giving keyboard users the right behavior.
//
// Per-modal state so multiple modals can coexist (rare — hideAllModals
// closes everything together — but the WeakMap keeps it safe even if
// the call patterns change).

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

const _trapState = new WeakMap();

function _focusableIn(modal) {
  return Array.from(modal.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter(el => !el.hasAttribute('aria-hidden') && el.offsetParent !== null);
}

function _attachTrap(modal) {
  // Guard against re-entrancy: showModal may be called twice on the
  // same modal (e.g. a delayed showModal fires after a synchronous
  // path already opened it). Without this, the first handler stays
  // bound forever and every Tab triggers two trap loops, which
  // overshoot the wrap and land focus in unexpected places. Detach
  // any prior trap before attaching a fresh one.
  if (_trapState.has(modal)) _detachTrap(modal);
  const restoreTarget = document.activeElement;
  const handler = (e) => {
    if (e.key !== 'Tab') return;
    const focusables = _focusableIn(modal);
    if (focusables.length === 0) {
      // No focusable in the modal — block Tab so focus can't escape.
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !modal.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !modal.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };
  modal.addEventListener('keydown', handler);
  _trapState.set(modal, { restoreTarget, handler });
  // Move focus to the first focusable so keyboard users land inside the
  // modal immediately. If there isn't one (rare — informational modals
  // with no buttons) we focus the modal container itself so Escape and
  // Tab still register against it rather than against the page below.
  const focusables = _focusableIn(modal);
  if (focusables.length > 0) {
    focusables[0].focus();
  } else {
    if (!modal.hasAttribute('tabindex')) modal.setAttribute('tabindex', '-1');
    modal.focus();
  }
}

function _detachTrap(modal) {
  const state = _trapState.get(modal);
  if (!state) return;
  modal.removeEventListener('keydown', state.handler);
  _trapState.delete(modal);
  // Restore focus to wherever the user was when the modal opened.
  // Skip if the previous element no longer exists in the DOM (modal
  // open across a board re-render, etc.) — focus would error otherwise.
  const r = state.restoreTarget;
  if (r && typeof r.focus === 'function' && document.body.contains(r)) {
    try { r.focus(); } catch {}
  }
}

export function showModal(id) {
  const modal = $(`#${id}`);
  if (!modal) return;
  modal.classList.remove('hidden');
  _attachTrap(modal);
}

export function hideModal(id) {
  const modal = $(`#${id}`);
  if (!modal || modal.classList.contains('hidden')) return;
  _detachTrap(modal);
  modal.classList.add('modal-closing');
  setTimeout(() => {
    modal.classList.add('hidden');
    modal.classList.remove('modal-closing');
  }, 250);
}

export function hideAllModals() {
  for (const modal of $$('.modal')) {
    _detachTrap(modal);
    modal.classList.add('hidden');
    modal.classList.remove('modal-closing');
  }
}

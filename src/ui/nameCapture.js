// The leaderboard-name gate.
//
// ensureLeaderboardName() is awaited at the top of handleWin for daily /
// weekly / timed wins. When the player has no saved name it shows a small
// blocking modal BEFORE the end card and resolves only once a name is
// committed; otherwise it resolves immediately. Committing routes through
// setPlayerName (so the name fills Settings and is asked once) and
// publishPlayerName (so it lands in the world-readable playerNames node the
// leaderboards join against — see firebaseProgress.publishPlayerName).
//
// The modal is deliberately NOT dismissible: it has no close button, and
// main.js excludes #name-capture-modal from the global backdrop-click and
// Escape close handlers (like #gameover-overlay). The only exit is a valid
// name — that is the whole point of the gate.

import { $ } from './domHelpers.js';
import { showModal, hideModal } from './modalManager.js';
import { showToast } from './toastManager.js';
import { getPlayerName, setPlayerName } from '../storage/statsStorage.js';
import { publishPlayerName } from '../firebase/firebaseProgress.js';
import { shouldPromptForName } from '../logic/shouldPromptForName.js';

/**
 * Ensure a leaderboard name exists before the end card renders.
 * @param {string} mode state.gameMode
 * @param {Object} [opts] { isArchive, isPractice }
 * @returns {Promise<string>} resolves with the name in effect (may be '')
 */
export function ensureLeaderboardName(mode, { isArchive = false, isPractice = false } = {}) {
  if (!shouldPromptForName({ mode, savedName: getPlayerName(), isArchive, isPractice })) {
    return Promise.resolve(getPlayerName());
  }

  return new Promise((resolve) => {
    const modal = $('#name-capture-modal');
    const input = $('#name-capture-input');
    const saveBtn = $('#name-capture-save');
    // Fail OPEN if the markup is missing: a broken modal must never trap the
    // player on their victory. They simply play on without a name (the same
    // as the pre-gate behavior).
    if (!modal || !input || !saveBtn) { resolve(getPlayerName()); return; }

    input.value = '';

    const commit = () => {
      const raw = input.value.trim().slice(0, 20);
      if (!raw) { showToast('Please enter a name.'); input.focus(); return; }
      const result = setPlayerName(raw);
      if (!result || result.ok === false) {
        // Only hate-speech is rejected (setPlayerName strips other bad chars
        // silently). Keep the gate open so they pick another.
        showToast("That name isn't allowed. Please pick another.");
        input.focus();
        return;
      }
      if (!result.value) { showToast('Please enter a name.'); input.focus(); return; }
      // Publish to the world-readable playerNames node so every leaderboard
      // shows this name by uid, past rows included (join-at-read).
      publishPlayerName(result.value);
      cleanup();
      hideModal('name-capture-modal');
      resolve(result.value);
    };

    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
    };

    function cleanup() {
      saveBtn.removeEventListener('click', commit);
      input.removeEventListener('keydown', onKey);
    }

    saveBtn.addEventListener('click', commit);
    input.addEventListener('keydown', onKey);
    showModal('name-capture-modal');
    // showModal focuses the first focusable (the input) via the focus trap,
    // but re-assert after a tick so the mobile keyboard opens reliably.
    setTimeout(() => input.focus(), 50);
  });
}

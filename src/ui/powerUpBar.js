import { state } from '../state/gameState.js?v=0.9';
import { $, $$, boardEl } from './domHelpers.js?v=0.9';

export function updatePowerUpBar() {
  const totalPowerUps = Object.values(state.powerUps).reduce((a, b) => a + b, 0);
  const powerUpBar = $('#powerup-bar');

  // Hide entire bar when no power-ups available
  if (totalPowerUps === 0 && !state.shieldActive && !state.scanMode && !state.xrayMode && !state.magnetMode) {
    powerUpBar.classList.add('hidden');
  } else {
    powerUpBar.classList.remove('hidden');
  }

  for (const btn of $$('.powerup-btn')) {
    const type = btn.dataset.powerup;
    const count = state.powerUps[type] || 0;

    btn.querySelector('.powerup-count').textContent = count;

    // Lifeline is passive — disable button always (indicator only)
    if (type === 'lifeline') {
      btn.disabled = true;
      btn.style.display = count > 0 ? '' : 'none';
      continue;
    }

    btn.disabled = count === 0 || state.status === 'won' || state.status === 'lost';
    btn.classList.toggle('active-powerup', type === 'shield' && state.shieldActive);
    btn.classList.toggle('scan-active', type === 'scanRowCol' && state.scanMode);
    btn.classList.toggle('xray-active', type === 'xray' && state.xrayMode);
    btn.classList.toggle('magnet-active', type === 'magnet' && state.magnetMode);
  }
  // Board state classes
  boardEl.classList.toggle('scan-mode', state.scanMode);
  boardEl.classList.toggle('xray-mode', state.xrayMode);
  boardEl.classList.toggle('magnet-mode', !!state.magnetMode);
  boardEl.classList.toggle('shield-active', state.shieldActive);
}

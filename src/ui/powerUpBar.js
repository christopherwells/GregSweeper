import { state } from '../state/gameState.js';
import { $, $$, boardEl } from './domHelpers.js';

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

    // Lifeline is passive — show count but not clickable, hide when 0
    if (type === 'lifeline') {
      btn.disabled = true;
      btn.classList.add('powerup-passive');
      btn.style.display = count > 0 ? '' : 'none';
      continue;
    }

    // All powerups: hide when count is 0, show when available
    const isActive = (type === 'shield' && state.shieldActive) ||
                     (type === 'scanRowCol' && state.scanMode) ||
                     (type === 'xray' && state.xrayMode) ||
                     (type === 'magnet' && state.magnetMode);
    btn.style.display = (count > 0 || isActive) ? '' : 'none';
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

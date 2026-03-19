import { $, $$ } from './domHelpers.js?v=1.0.9';

export function showModal(id) {
  $(`#${id}`).classList.remove('hidden');
}

export function hideModal(id) {
  const modal = $(`#${id}`);
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('modal-closing');
  setTimeout(() => {
    modal.classList.add('hidden');
    modal.classList.remove('modal-closing');
  }, 250);
}

export function hideAllModals() {
  for (const modal of $$('.modal')) {
    modal.classList.add('hidden');
    modal.classList.remove('modal-closing');
  }
}

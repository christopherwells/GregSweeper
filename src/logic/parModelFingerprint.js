// A stable fingerprint of the shipped par equations.
//
// WHY IT EXISTS. The challenge pool's prices are derived from the par model,
// and the model is REFIT NIGHTLY and pushed to main unattended. So "the pool's
// prices disagree with what the model says today" has two completely different
// meanings — the pool is broken, or the pool is simply older than the last
// refit — and without recording which model a price came from there is no way
// to tell them apart.
//
// That is not a theoretical distinction. It failed CI within hours of the
// re-price landing: a PR's checks run against the branch MERGED INTO MAIN, the
// nightly refit had landed at 00:17 UTC, and the branch's pool was therefore
// being priced by main's newer coefficients. The faithfulness test read that
// as a defect. It is not one; it is a branch that wants a re-price before it
// merges, which is a different message and a different remedy.
//
// It covers PAR_MODEL and PAR_MODEL_SHAPES together, because a tiling entry's
// price comes from its shape block and a rectangle's from the base model —
// a fingerprint over only one of them would call a pool fresh when half of it
// had gone stale. PAR_MODEL_TIMED is deliberately excluded: quick play is
// rectangles-only and nothing in the ladder prices through it.

import { PAR_MODEL, PAR_MODEL_SHAPES } from './difficulty.js';

/** FNV-1a over the canonical rendering below. */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Key-sorted so a re-emit that reorders coefficients is not a model change. */
function canonical(model) {
  if (!model || typeof model !== 'object') return String(model);
  if (Array.isArray(model)) return `[${model.map(canonical).join(',')}]`;
  return `{${Object.keys(model).sort().map((k) => `${k}:${canonical(model[k])}`).join(',')}}`;
}

/**
 * A short, stable id for the equations the ladder is priced through. Changes
 * whenever any coefficient does, and only then.
 * @returns {string}
 */
export function modelFingerprint() {
  return hash(canonical({ base: PAR_MODEL, shapes: PAR_MODEL_SHAPES }));
}

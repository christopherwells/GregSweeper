// Hate-speech filter for leaderboard display names.
//
// SCOPE: slurs only (racial, ethnic, homophobic, transphobic,
// misogynistic). NOT general profanity — "HellRaiser" and the name
// "Dick" are fine; an actual slur is not. This keeps false positives
// near zero, which matters because the display name field is short and
// we'd rather miss a clever evasion (the server-side obscenity sweep
// catches those) than scrub an innocent name.
//
// Used on the client to reject a name at entry time with immediate
// feedback. The authoritative check is the server-side sweep
// (scripts/scrub-leaderboard-names.mjs) which uses the obscenity
// library and runs on a cron, catching anything that bypasses this
// client check (e.g. a name written straight to Firebase via DevTools).

// Normalized base forms of slurs. Each entry is already lowercased with
// no separators, so the normalizer below maps an incoming name into the
// same space before substring-matching. Kept deliberately to
// unambiguous hate-speech terms — do NOT add general profanity here.
// The list is intentionally a separate, clearly-labeled data module so
// the matching logic stays readable.
import { HATE_SPEECH_TERMS_CLIENT_SAFE } from './hateSpeechTerms.js';

// Leetspeak / homoglyph map applied before stripping separators, so
// "n1gg3r", "f@g", "b!tch-style" evasions collapse onto their base form.
const LEET_MAP = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '6': 'g',
  '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's', '!': 'i',
  '|': 'i', '+': 't', '£': 'l', '€': 'e',
};

/**
 * Normalize a display name into the matching space: lowercase, map
 * leetspeak/homoglyphs to letters, drop everything that isn't a-z, and
 * collapse runs of 3+ identical letters to 2 (so "niiiigger" → "niigger"
 * still contains the base term, while legitimate doubles like "ll" in a
 * normal name survive). The collapse-to-2 (not 1) avoids turning "ass"
 * into "as".
 */
export function normalizeForMatch(name) {
  if (typeof name !== 'string') return '';
  let s = name.toLowerCase();
  s = s.replace(/[0-9@$!|+£€]/g, (c) => LEET_MAP[c] || c);
  s = s.replace(/[^a-z]/g, '');
  s = s.replace(/([a-z])\1{2,}/g, '$1$1');
  return s;
}

/**
 * Return true if the name contains a hate-speech term after
 * normalization. Substring match — for short display names the
 * Scunthorpe risk on this curated slur-only list is acceptable
 * (these terms rarely appear inside innocent words).
 */
export function containsHateSpeech(name) {
  const norm = normalizeForMatch(name);
  if (!norm) return false;
  for (const term of HATE_SPEECH_TERMS_CLIENT_SAFE) {
    if (norm.includes(term)) return true;
  }
  return false;
}

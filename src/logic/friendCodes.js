// Friend codes — pure logic (no DOM, no Firebase) so the regression
// suite can pin it. The Firebase I/O lives in firebaseFriends.js.
//
// A friend code is a 6-character token from an unambiguous alphabet
// (no 0/O, no 1/I/L — codes get read off projectors and phone screens).
// Codes live 15 minutes, server-enforced: the firebase-rules.json read
// gate hides codes older than CODE_TTL_MS, so an expired code is
// unreadable regardless of the client clock. test/friendCodes.test.mjs
// asserts the rules and these constants never drift apart.

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
export const CODE_TTL_MS = 900000; // 15 min — mirrored in the rules read gate
// Single source of truth for what a code looks like; the rules carry
// the same pattern as $code.matches(/^[A-Z2-9]{6}$/).
export const CODE_REGEX = /^[A-Z2-9]{6}$/;

export function generateCode(rng = Math.random) {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  }
  return code;
}

// Forgiving input: users type lowercase, paste with spaces or dashes.
// Returns the canonical code, or null if it can't be one.
export function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  const cleaned = input.toUpperCase().replace(/[\s-]/g, '');
  return CODE_REGEX.test(cleaned) ? cleaned : null;
}

// Fresh = still within the TTL window. Expiry is inclusive at the
// boundary (a code created exactly TTL ago is expired) to match the
// rules' strict `createdAt > now - TTL` read gate.
export function isCodeFresh(createdAt, now) {
  if (typeof createdAt !== 'number' || typeof now !== 'number') return false;
  return createdAt > now - CODE_TTL_MS;
}

// Remaining life in ms (0 when expired) — drives the countdown label.
export function codeMsRemaining(createdAt, now) {
  if (!isCodeFresh(createdAt, now)) return 0;
  return createdAt + CODE_TTL_MS - now;
}

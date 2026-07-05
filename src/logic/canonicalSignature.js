// Canonical-board signatures — the trust-model close for issue #114.
//
// The canonical paths (dailyBoard/{date}, weeklyBoard/{weekStart}) are
// write-once but writable by ANY authenticated client (that openness is what
// lets the first client on a precompute-failed day write the fallback board
// everyone else converges on). Signatures make the trust explicit instead of
// implicit: the generation pipeline signs every canonical it writes with a
// private key held only in GitHub Actions, and clients verify against the
// public key below BEFORE playing. A forged or tampered board cannot carry a
// valid signature, and — unlike a client-side re-solve — verification can
// never false-alarm on a legitimate board (no solver, no code-version drift).
//
// TRUST POLICY (assessCanonicalTrust), per fetched canonical:
//   1. Key date before SIGNATURE_EPOCH        -> trusted (grandfathered:
//      every canonical written before signatures shipped is unsigned).
//   2. Carries a `sig`                        -> trusted IFF it verifies.
//      An INVALID signature is affirmative tamper evidence — rejected even
//      if everything else looks right.
//   3. Unsigned at/after the epoch            -> trusted IFF `writtenAt`
//      falls inside the board's own play window (the daily's own ET date;
//      the weekly's Monday..Sunday). That is exactly the first-client
//      fallback shape — a client writing TODAY's board ON the day — and it
//      is trustworthy because the rules validate writtenAt === now (server
//      stamp) and the path is write-once: a pre-poisoned future board
//      necessarily carries a writtenAt BEFORE its window and is rejected.
//
// Rejected canonicals are treated as MISSING by the load path: the caller
// falls back to local generation (daily) or reports the board unavailable
// (archive/weekly probe), and the rejection is reported for forensics.
//
// Key management: ECDSA P-256 (universal WebCrypto support; Ed25519 is not
// there yet on older mobile). Signature = raw r||s, base64. The private key
// lives ONLY in the CANONICAL_SIGNING_KEY GitHub Actions secret (base64
// PKCS8). Rotation is ADDITIVE: generate a new pair, replace the secret, and
// prepend the new SPKI to PUBLIC_KEYS — verification tries every listed key,
// so boards signed under the old key keep verifying and SIGNATURE_EPOCH
// never moves.

// First date (ET) whose canonicals must be signed or fallback-shaped. Every
// future-dated board that existed unsigned at ship time was regenerated
// signed before this date arrived.
export const SIGNATURE_EPOCH = '2026-07-06';

// SPKI, base64. Newest first — verification tries each (rotation support).
// Pairs with the CANONICAL_SIGNING_KEY Actions secret generated 2026-07-05.
export const PUBLIC_KEYS = [
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAECdIHhZM0o+G308fOxQB+m9dUnFh2GHJ1koKh50aV0KqOPlfeipwXM5mDQxri1fr0wxoHX6qr7Dqa0jXzn342wQ==',
];

const textEncoder = new TextEncoder();

function _b64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function _bytesToB64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Deterministic serialization of a canonical payload for signing/verifying.
 * Recursively key-sorted (Firebase does not preserve object key order), and
 * the two fields that legitimately differ between signing time and read time
 * are excluded: `sig` (the signature itself) and `writtenAt` (writers send
 * the server-timestamp sentinel; the stored value is the resolved number).
 *
 * @param {Object} payload the canonical node
 * @returns {string}
 */
export function canonicalStringify(payload) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
      return out;
    }
    return v;
  };
  const { sig, writtenAt, ...rest } = payload || {};
  return JSON.stringify(sort(rest));
}

/**
 * Sign a canonical payload. SERVER-SIDE ONLY (precompute / regenerate /
 * bootstrap scripts) — the private key never exists client-side.
 *
 * @param {Object} payload the canonical node (sig/writtenAt ignored)
 * @param {string} privateKeyPkcs8B64 base64 PKCS8 (the Actions secret)
 * @returns {Promise<string>} base64 raw r||s signature
 */
export async function signCanonicalPayload(payload, privateKeyPkcs8B64) {
  const key = await crypto.subtle.importKey(
    'pkcs8', _b64ToBytes(privateKeyPkcs8B64),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key,
    textEncoder.encode(canonicalStringify(payload)),
  );
  return _bytesToB64(sig);
}

/**
 * Verify a canonical payload's `sig` against the trusted public keys.
 * @param {Object} payload the canonical node (must carry `sig`)
 * @param {string[]} [publicKeys] SPKI-b64 overrides (tests); default PUBLIC_KEYS
 * @returns {Promise<boolean>}
 */
export async function verifyCanonicalPayloadSig(payload, publicKeys = PUBLIC_KEYS) {
  if (!payload || typeof payload.sig !== 'string' || payload.sig.length === 0) return false;
  let sigBytes;
  try { sigBytes = _b64ToBytes(payload.sig); } catch { return false; }
  const data = textEncoder.encode(canonicalStringify(payload));
  for (const spki of publicKeys) {
    try {
      const key = await crypto.subtle.importKey(
        'spki', _b64ToBytes(spki),
        { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
      );
      if (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sigBytes, data)) {
        return true;
      }
    } catch { /* malformed key/sig for this candidate — try the next */ }
  }
  return false;
}

// YYYY-MM-DD + n days, pure string math via UTC noon (no TZ edge cases).
function _addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d, 12));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/**
 * The full trust decision for a fetched canonical. See the policy at the top
 * of this file.
 *
 * @param {Object} raw       the fetched dailyBoard/weeklyBoard node
 * @param {string} key       the date (daily) or weekStart Monday (weekly)
 * @param {'daily'|'weekly'} kind
 * @param {(ms: number) => string|null} etOfMs timestamp → ET date (inject
 *        seededRandom.etDateStringOfMs; parameterized so this stays pure)
 * @param {string[]} [publicKeys] override for tests
 * @returns {Promise<{trusted: boolean, reason: string}>}
 */
export async function assessCanonicalTrust(raw, key, kind, etOfMs, publicKeys = PUBLIC_KEYS) {
  if (!raw || typeof raw !== 'object') return { trusted: false, reason: 'empty payload' };
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(key)) {
    return { trusted: false, reason: `malformed key ${key}` };
  }
  // The `{date}_weekly_first` synthetic keys share the dailyBoard path but
  // only their plain-date prefix matters for the epoch comparison.
  const keyDate = key.slice(0, 10);
  if (keyDate < SIGNATURE_EPOCH) {
    return { trusted: true, reason: 'pre-epoch (grandfathered)' };
  }
  if (typeof raw.sig === 'string') {
    const valid = await verifyCanonicalPayloadSig(raw, publicKeys);
    return valid
      ? { trusted: true, reason: 'valid signature' }
      : { trusted: false, reason: 'INVALID signature' };
  }
  // Unsigned post-epoch: only the first-client fallback shape is trusted —
  // written inside its own play window. writtenAt is rules-validated as a
  // server timestamp on a write-once path, so it cannot be forged or aged.
  const writtenDay = etOfMs && typeof raw.writtenAt === 'number' ? etOfMs(raw.writtenAt) : null;
  if (!writtenDay) return { trusted: false, reason: 'unsigned with no usable writtenAt' };
  const windowEnd = kind === 'weekly' ? _addDays(keyDate, 6) : keyDate;
  if (writtenDay >= keyDate && writtenDay <= windowEnd) {
    return { trusted: true, reason: 'unsigned fallback written inside its own play window' };
  }
  return { trusted: false, reason: `unsigned and written ${writtenDay}, outside its window ${keyDate}..${windowEnd}` };
}

/**
 * Server-side helper for the writer scripts (precompute / regenerate /
 * bootstrap): the base64 PKCS8 private key from the CANONICAL_SIGNING_KEY
 * env (the GitHub Actions secret). THROWS when missing — a pipeline that
 * cannot sign must fail loudly rather than write an unsigned post-epoch
 * canonical that every client will reject.
 */
export function requireSigningKey() {
  const k = ((typeof process !== 'undefined' && process.env && process.env.CANONICAL_SIGNING_KEY) || '').trim();
  if (!k) throw new Error('CANONICAL_SIGNING_KEY not set — refusing to write an unsigned canonical');
  return k;
}

// Curated hate-speech blocklist for leaderboard display-name filtering.
//
// CONTENT WARNING: this file is a moderation blocklist. It contains
// slurs solely so the name filter can DETECT and BLOCK them. Scope is
// deliberately limited to unambiguous racial, ethnic, homophobic,
// transphobic, and misogynistic slurs — NOT general profanity (no
// "damn", "ass", etc.) — to honor the "hate speech only" requirement
// and keep false positives near zero.
//
// Each entry is the NORMALIZED base form (lowercase, letters only) so it
// lines up with normalizeForMatch() in nameFilter.js.
//
// TWO lists because the client and server match differently:
//
//  - HATE_SPEECH_TERMS_CLIENT_SAFE: used by the client's naive
//    substring matcher. Pruned to terms that essentially never appear
//    inside innocent names, so a dumb `includes()` won't reject a
//    legitimate name. Misses some clever evasions — that's fine, the
//    server backstops.
//
//  - HATE_SPEECH_TERMS: the fuller list, used ONLY by the server sweep
//    where obscenity's boundary- and whitelist-aware matcher prevents
//    the Scunthorpe problem (it won't flag "Nigeria", "Pakistan",
//    "raccoon", "San Diego", "Fagan", etc.). Never feed this list to a
//    naive substring matcher.

// Low-collision terms safe for naive client-side substring matching.
export const HATE_SPEECH_TERMS_CLIENT_SAFE = [
  'nigger', 'nigga',
  'faggot', 'fagot',
  'chink', 'kike', 'gook', 'beaner', 'wetback',
  'tranny', 'shemale', 'ladyboy',
  'cunt', 'retard',
  'jigaboo', 'porchmonkey', 'tarbaby',
];

// Fuller list including terms that collide with innocent words as
// substrings (Niger/Nigeria, Pakistan, raccoon/tycoon, San Diego,
// Fagan, etc.). Server-only — obscenity's matcher handles the
// boundaries so these don't false-positive.
export const HATE_SPEECH_TERMS = [
  ...HATE_SPEECH_TERMS_CLIENT_SAFE,
  'coon', 'spic', 'paki', 'dago', 'wop', 'dyke', 'fag',
  'injun', 'redskin', 'gypped', 'sandnigger',
];

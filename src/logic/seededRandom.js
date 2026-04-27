export function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

// Daily date string (YYYY-MM-DD) anchored to America/New_York. Every
// player worldwide gets the same daily puzzle for any given ET date,
// regardless of their machine's timezone — a player in Tokyo who loads
// at 9am JST sees the puzzle for the previous ET date if it's still
// before midnight ET, and rolls over to the new puzzle when ET does.
// Anchoring globally is the only way to keep "everyone on the same
// EST day plays the same board" honest.
//
// `en-CA` is the locale that emits ISO YYYY-MM-DD natively from
// formatToParts, so we don't have to hand-pad with String/padStart.
const _DAILY_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
});

export function getLocalDateString() {
  return _DAILY_DATE_FMT.format(new Date());
}

export function createDailyRNG(dateString) {
  if (!dateString) dateString = getLocalDateString();
  const seed = hashString(dateString);
  return mulberry32(seed);
}

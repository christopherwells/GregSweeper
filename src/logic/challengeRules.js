// THE LADDER'S RULINGS, as constants and predicates — the par ceilings, the
// generation caps, the endless admission floor, and the two dedupe keys.
//
// Split out of challenge250.js because the tools that BUILD the pool have to
// read the rules they are building to, and challenge250.js cannot serve them:
// it assembles the whole ladder at module load and throws when the pool is
// empty, so the search script importing it could never run before the pool
// existed. That is a genuine cycle, not an inconvenience, and this is the cut
// that removes it — rules here, table there, both leaves importing nothing.
//
// challenge250.js re-exports every name below, so nothing that reads the
// ladder needs to know this file exists.

// ── Par ceilings ───────────────────────────────────────────────────────

// The authored ladder's absolute ceiling: eight minutes. Difficulty is
// par-per-cell, never raw par — no giant boards just to inflate the clock.
export const PAR_CEILING_SECONDS = 480;

// The endless zone lifts it to TEN minutes (his ruling 2026-08-04, answering
// the map's one open flag: "in the endless zone it can go to 10 minutes").
export const ENDLESS_PAR_CEILING_SECONDS = 600;

// PER-SHAPE ceiling (his ruling 2026-08-04, after a four-shape pool came back
// without a square board in it): a shape that needs more room to reach the
// summit rate gets it.
//
// Why these three and only these three. The summit rate and the ceiling are
// two separate rulings, and for a gently-priced shape they intersect in a
// sliver: Classic and Paving Stones need ~150 cells to reach 3.6 s/cell at
// all, and 150 cells at that rate IS ten minutes, so every board of theirs
// that clears the rate measures 557-601s against a 600s ceiling. Petals sits
// just under the same way, one step milder, and took +1 minute rather than
// +2 because it needs less.
//
// 3D Cubes is deliberately NOT here: its qualifying boards already price
// 222-464s, comfortably under. Its blocker is generation TIME, which is a
// different ruling and lives in the cap table below. The two allowances are
// not interchangeable — raising Cubes' ceiling would do nothing for it, and
// raising the other two's cap would do nothing for them.
export const ENDLESS_PAR_CEILING_BY_SHAPE = Object.freeze({
  rect: 720,
  cairo: 720,
  floret: 660,
});

/** The endless par ceiling that applies to a shape. */
export function endlessParCeiling(shape) {
  return ENDLESS_PAR_CEILING_BY_SHAPE[shape] || ENDLESS_PAR_CEILING_SECONDS;
}

// ── Generation caps ────────────────────────────────────────────────────

// THE 2-SECOND GENERATION CAP (his ruling): no spec ships whose measured
// worst-case generation exceeds it in the validator's own run, as measured,
// with no margin.
export const GEN_CAP_MS = 2000;

// PER-SHAPE generation cap in the endless zone (his ruling 2026-08-04, that
// the budget "can be 3 [seconds] if it means we get diversity"). 3D Cubes
// gets 3.5 seconds: its certifier has no Pass B and leans on Pass C
// enumeration for every board, so it measured 2.1-9.8s against the 2-second
// cap, and raising ITS cap is the only thing that lets it into the zone.
// Cairo joined on the same reasoning once the phone cap took its endless
// boards from 9x9 to 13x7. Endless generation happens behind a level card,
// never under a click.
export const ENDLESS_GEN_CAP_BY_SHAPE = Object.freeze({
  rhombille: 3500,
  cairo: 3000,
});

/** The endless generation cap that applies to a shape. */
export function endlessGenCap(shape) {
  return ENDLESS_GEN_CAP_BY_SHAPE[shape] || GEN_CAP_MS;
}

// ONE SELF-IMPOSED MARGIN: pool admission requires worst-measured generation
// under 75% of whatever cap applies, not the cap itself. The cap is his
// ruling and is unchanged; the margin is judgement, because a pool board is
// drawn fresh on every attempt AND every death-retry, so a spec sitting at
// 1990ms on the validator's machine is one that intermittently stalls on a
// phone. Generation time is also heavy-tailed — one entry measured 1216ms in
// a search and 9843ms in validation on different seeds — so an entry needs
// HEADROOM, never merely a passing measurement.
export const ENDLESS_GEN_HEADROOM = 0.75;
export const ENDLESS_GEN_BUDGET_MS = GEN_CAP_MS * ENDLESS_GEN_HEADROOM;

/** The admission budget for a shape: its cap, less the standing headroom. */
export function endlessGenBudget(shape) {
  return endlessGenCap(shape) * ENDLESS_GEN_HEADROOM;
}

// ── Endless admission floor ────────────────────────────────────────────

// The pool's ADMISSION floor, distinct from the T12 summit the zone opens at.
// His ruling 2026-08-04: drop it to 3.5 so more boards fit. The two numbers
// do different jobs — the summit says where the zone starts, the floor says
// which boards may sit in the pool it draws from.
export const ENDLESS_PPC_FLOOR = 3.5;

// Per-shape floor, where a lattice cannot reach the shared one on a board a
// phone can hold. His ruling 2026-08-07: every tiling must be available in
// the endless zone, and "without sufficient data, I think it's fine to put
// the top 10 percentile of most difficult paving stones."
//
// The reasoning behind accepting a softer floor is his too: these rates are
// provisional. Every shape looks dear while nobody knows its tricks, and the
// par model is fit on play that is still learning them — Classic priced far
// harder early on than it does now. When cairo's per-cell rate rises on real
// data this entry should shrink toward the shared floor and eventually go.
export const ENDLESS_PPC_FLOOR_BY_SHAPE = Object.freeze({
  cairo: 2.5,
  // 3D Cubes joined on 2026-08-08 for exactly cairo's reason, and it is the
  // clearest case of it. Over 2,486 measured rhombille specs the whole shape
  // reaches ppc 3.58 at its very best — one board, and one that does not hold
  // its price at ten seeds — against a shared floor of 3.5. So on the shared
  // floor the zone has NO 3D Cubes at all, which his ruling forbids. Its 90th
  // percentile is 2.17 and its 95th is 2.40; 2.2 is the top decile, the same
  // bar cairo's entry was set at.
  //
  // The wall sight-line fix (#269) is part of why: severing corner links
  // makes the certifier work harder, which lands hardest on the one lattice
  // with no Pass B at all. Its two previous endless entries are among what
  // that change put over the generation cap — and hand-removing them was
  // never the answer, because they were the shape's whole representation.
  //
  // Same provisional reading as cairo's: these rates are fit on play that is
  // still learning the lattice. When 3D Cubes' per-cell rate rises on real
  // data this entry should shrink toward the shared floor and eventually go.
  rhombille: 2.2,
});

/** The admission floor a shape is held to. */
export function endlessPpcFloor(shape) {
  return ENDLESS_PPC_FLOOR_BY_SHAPE[shape] ?? ENDLESS_PPC_FLOOR;
}

// ── The two dedupe keys ────────────────────────────────────────────────

/**
 * THE FACE: what a player can actually tell apart — shape, dimensions, mine
 * count, modifier set. Uniqueness on the ladder is judged on this and never
 * on specFingerprint.
 *
 * The difference is not academic. The fingerprint separates `gimmickLevel`,
 * `wallSegments` and the deduction caps, none of which a player can see, and
 * measured on the old authored table it reported 130 distinct specs where
 * there were only 109 distinct BOARDS — so a ladder deduped on fingerprints
 * still repeated 21 of them, which is what he hit at L65-70. Worse,
 * gimmickLevel is not even a stable property of a level: L63 (gl63) and L64
 * (gl64) both produced mirror intensity 2 across 300 draws, and post-intro
 * dials take a random ±1 boost per draw.
 *
 * The modifier set is SORTED, because ['walls','liar'] and ['liar','walls']
 * are one board.
 */
export function specFace(spec) {
  const dims = spec.shape === 'rect' ? `${spec.rows}x${spec.cols}` : `${spec.M}x${spec.N}`;
  return `${spec.shape}|${dims}|${spec.mines}|${[...spec.gimmicks].sort().join('+')}`;
}

/**
 * The VALIDATOR's key: two levels sharing a fingerprint draw from the same
 * board distribution, so each distinct distribution is proven once. Finer
 * than specFace by exactly the dials a player cannot see — which is right for
 * proving and wrong for deduping.
 */
export function specFingerprint(spec) {
  const dims = spec.shape === 'rect' ? `${spec.rows}x${spec.cols}` : `${spec.M}x${spec.N}`;
  const opts = [
    spec.gimmickLevel ? `gl${spec.gimmickLevel}` : '',
    spec.wallSegments ? `w${spec.wallSegments}` : '',
    spec.constructive ? 'con' : '',
    spec.minDeductions ? `d${spec.minDeductions}` : '',
    spec.maxDeductions ? `D${spec.maxDeductions}` : '',
  ].filter(Boolean).join(',');
  return `${spec.shape}:${dims}:m${spec.mines}:[${spec.gimmicks.join('+')}]${opts ? ':' + opts : ''}`;
}

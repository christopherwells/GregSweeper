// THE LADDER'S RULINGS, as constants and predicates: the par ceilings, the
// generation caps, the endless admission floor, and the two dedupe keys.
//
// Split out of challenge250.js because the tools that BUILD the pool have to
// read the rules they are building to, and challenge250.js cannot serve them:
// it assembles the whole ladder at module load and throws when the pool is
// empty, so the search script importing it could never run before the pool
// existed. That is a genuine cycle, not an inconvenience, and this is the cut
// that removes it, rules here, table there, both leaves importing nothing.
//
// challenge250.js re-exports every name below, so nothing that reads the
// ladder needs to know this file exists.

// ── The Climb's floor ──────────────────────────────────────────────────
//
// His ruling 2026-08-10, after playing the ladder and clearing a level in one
// click: a Climb level runs longer than two minutes, and "I don't want the
// climb to be immediately done puzzles."
//
// THE TWO-MINUTE FLOOR IS A TARGET, NOT YET A GATE, and the distinction is
// measured rather than cautious. A face's par is its stored ppc times its
// cells, so filtering the pool on it costs nothing to compute, but the pool
// cannot survive the filter: rectangles carrying only the opener's modifiers
// drop from 51 faces to 16, which is the material the ladder must live on
// before any lattice has debuted, and the assignment exhausts at L44.
//
// So this constant is what the next SEARCH is built to satisfy, and the
// ladder starts enforcing it the day the pool can meet it. Wiring it in
// early would either exhaust the assignment or force the introduction
// schedule to route around a pool shortage, which is the one thing the braid
// is documented never to do.
export const CLIMB_MIN_PAR_SECONDS = 120;

// What CAN be enforced against today's pool: a per-DRAW floor on decisions,
// checked by the builder's accept gate exactly as the opener blocks' floor is.
//
// FIVE, because five is what the current specs can actually produce. Measured
// over 25 draws on the six weakest levels, the pass rate is 40-92% at a floor
// of 5 and 0-16% at 8, and a spec that fails almost every draw does not make
// harder boards, it fails to generate. This does not deliver two minutes: a
// five-decision hex board is still around 25 seconds. What it does deliver is
// that no Climb level is ever over on the opening click, which is the defect
// he hit (L29 cleared outright on 13% of draws, L26 on 5%).
export const CLIMB_MIN_DEDUCTIONS = 5;

// ── Par ceilings ───────────────────────────────────────────────────────

// The authored ladder's absolute ceiling: eight minutes. Difficulty is
// par-per-cell, never raw par, no giant boards just to inflate the clock.
//
// His 2026-08-10 ruling lifts this ("the board can go 20 minutes of work, if
// needed, there's no max"), but raising the constant alone buys nothing: the
// SEARCH filtered at 95% of it, so the pool contains no board priced above
// 667s to draw. Raising it is part of the hardness search, not of this floor
// fix, and the number stays where the current pool was built to.
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
// not interchangeable: raising Cubes' ceiling would do nothing for it, and
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
// generation exceeds it as the NORM.
export const GEN_CAP_MS = 2000;

// And the occasional draw may go 30% past it. His ruling 2026-08-10: "2.5s is
// fine on occasion, but I don't want it to be the norm."
//
// The distinction is the whole point, and reading the cap as a hard bar on the
// WORST of a sample gets it backwards. Generation time is heavy-tailed: over
// 971 shipped specs the median is 23ms and the 99th percentile 1149ms, so the
// specs that occasionally spike are otherwise among the fastest in the pool, 
// the ones that were failing a worst-of-N bar have medians of 48 to 447ms.
// Judging them on their tail alone threw away boards nobody would ever
// experience as slow, and it does not converge either, because dropping the
// entries at the boundary just promotes the next tail into view.
//
// So: the MEDIAN is held to GEN_CAP_MS (is slow the norm for this spec?) and
// the peak is what an OCCASIONAL draw may reach.
export const GEN_CAP_PEAK_MS = 2500;

// How often "on occasion" is allowed to happen. This is the part that took
// three tries to get right, and the failure mode is worth recording because it
// looks like diligence.
//
// Holding the WORST of a sample to a bar does not terminate. A validator run
// is ~9,800 draws over ~980 specs, so with any stochastic tail each run names
// a different handful, and dropping the ones it named just lets the next
// sample name others: observed 1 -> 4 -> 2 -> 1 -> 4 failures across
// consecutive runs of an unchanged pool, while roughly a dozen specs were
// deleted chasing it. That is measuring the SAMPLE, not the spec.
//
// It also contradicts the ruling it claims to enforce. If an occasional 2.5s
// draw is acceptable, then a spec whose median is 156ms and which exceeded the
// peak once in ten draws has done nothing wrong. What must be bounded is the
// RATE, so the test is a property of the spec's distribution and gives the
// same verdict twice running.
export const GEN_SLOW_DRAW_RATE = 0.2;

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
// well under whatever cap applies, not merely under it. The cap is his ruling
// and is unchanged; the margin is judgement, because a pool board is drawn
// fresh on every attempt AND every death-retry, so a spec sitting at 1990ms on
// the validator's machine is one that intermittently stalls on a phone.
//
// IT IS 35%, NOT 75%, AND THAT WAS MEASURED. Generation time is heavy-tailed,
// so worst-of-a-few-seeds badly under-estimates worst-of-ten: two entries
// admitted at ~1000-1500ms measured 2207ms and 2327ms on the validator's own
// seeds, roughly 1.5-2.3x their admitted figure, and each re-emit surfaced a
// fresh one: the loop was never going to converge by removing them one at a
// time. 35% gives about 3x headroom against that observed tail.
//
// It costs almost nothing, which is why it is the right knob. Measured over
// 18,576 cached specs, tightening the budget from 1500ms to 600ms drops 1.5%
// of the material and leaves the thinnest shape with 727 specs: the
// distribution is overwhelmingly fast with a thin slow tail, so cutting the
// tail off is nearly free.
export const ENDLESS_GEN_HEADROOM = 0.35;
export const ENDLESS_GEN_BUDGET_MS = GEN_CAP_MS * ENDLESS_GEN_HEADROOM;

/** The admission budget for a shape: its cap, less the standing headroom. */
export function endlessGenBudget(shape) {
  return endlessGenCap(shape) * ENDLESS_GEN_HEADROOM;
}

// ── Endless admission floor ────────────────────────────────────────────

// The pool's ADMISSION floor, distinct from the T12 summit the zone opens at.
// His ruling 2026-08-04: drop it to 3.5 so more boards fit. The two numbers
// do different jobs: the summit says where the zone starts, the floor says
// which boards may enter the pool it draws from.
export const ENDLESS_PPC_FLOOR = 3.5;

// Per-shape floor, where a lattice cannot reach the shared one on a board a
// phone can hold. His ruling 2026-08-07: every tiling must be available in
// the endless zone, and "without sufficient data, I think it's fine to put
// the top 10 percentile of most difficult paving stones."
//
// The reasoning behind accepting a softer floor is his too: these rates are
// provisional. Every shape looks dear while nobody knows its tricks, and the
// par model is fit on play that is still learning them: Classic priced far
// harder early on than it does now. When cairo's per-cell rate rises on real
// data this entry should shrink toward the shared floor and eventually go.
// THE FLOOR SITS UNDER THE MARGIN (2026-08-16 evening). Admission is
// floor x ENDLESS_PPC_FLOOR_MARGIN, and the first cut of these numbers
// set each floor AT its shape's 90th percentile, so the margin quietly
// raised the real bar past the decile and the "top decile earns it"
// ruling admitted the top eight percent: after the evening refit's ripple
// the drawn endless held ONE 4.8.8 and THREE rhombille. Each entry below
// is now its shape's p90 divided by the margin, rounded down to 0.05, so
// the bar the emit actually applies lands ON the decile the ruling names.
// Tonight's p90s: 4.8.8 2.64, hex 2.28, rect 1.43, rhombille 2.16, cairo
// 2.56 (deltoidal 4.31 and floret 5.75 clear the shared floor and carry
// no entry).
export const ENDLESS_PPC_FLOOR_BY_SHAPE = Object.freeze({
  cairo: 2.45,
  // 3D Cubes joined on 2026-08-08 for exactly cairo's reason, and it is the
  // clearest case of it. Over 2,486 measured rhombille specs the whole shape
  // reaches ppc 3.58 at its very best, one board, and one that does not hold
  // its price at ten seeds, against a shared floor of 3.5. So on the shared
  // floor the zone has NO 3D Cubes at all, which his ruling forbids. Its 90th
  // percentile is 2.17 and its 95th is 2.40; 2.2 is the top decile, the same
  // bar cairo's entry was set at.
  //
  // The wall sight-line fix (#269) is part of why: severing corner links
  // makes the certifier work harder, which lands hardest on the one lattice
  // with no Pass B at all. Its two previous endless entries are among what
  // that change put over the generation cap, and hand-removing them was
  // never the answer, because they were the shape's whole representation.
  //
  // Same provisional reading as cairo's: these rates are fit on play that is
  // still learning the lattice. When 3D Cubes' per-cell rate rises on real
  // data this entry should shrink toward the shared floor and eventually go.
  rhombille: 2.05,
  // HONEYCOMB joined on 2026-08-16, his top-decile ruling extended to any
  // shape the model prices below the shared floor. The first fit with match
  // rows pooled cheapened hex 10.5% in one night, and its restored endless
  // entries fell back out for the second time in 24 hours; fresh heavy-stack
  // searches measured under 3.5 at store grade too, so on the shared floor
  // the zone holds no Honeycomb at all, which his every-tiling ruling
  // forbids. Its 90th percentile is 2.34 over 3,425 measured specs; 2.3 is
  // the top decile, the same bar the two entries above were set at. Same
  // provisional reading: when hex's rate rises on real data this entry
  // should shrink toward the shared floor.
  // Re-measured 2026-08-17 after the correction fit (the three-player
  // targeted rows): current-model p90 fell to 1.37. Same method, new night.
  hex: 1.3,
  // OCTAGONS joined on 2026-08-16 evening, the third application of the
  // top-decile ruling in one day and the cleanest sign yet that the trigger
  // is fit volatility, not any one shape: the evening refit took THREE new
  // rows (his own worm plays on this lattice) and the whole-surface ripple
  // slid every 4.8.8 endless entry under the shared admission at once,
  // emptying the shape from both endless surfaces. Its 90th percentile
  // reads 2.64 over 2,698 measured specs; 2.6 is the top decile. The other
  // allowances still track their own deciles (hex 2.28 against 2.3, rect
  // 1.43 against 1.5, cairo 2.56 against 2.5), the consistency check that
  // keeps this mechanism honest. Same provisional reading as the rest:
  // shrink toward the shared floor as real play accumulates.
  // Corrected the same night: 2.55 came from a p90 of 2.64 measured over
  // the WHOLE cache, and most 4.8.8 rows there carry prices no
  // --reprice-cache can refresh (no stored features), so the decile was
  // stale-tail optimism. Over current-model prices only (n=158) the p90
  // reads 2.41 and the max 3.02; the floor sits under the margin as the
  // block note requires. Measure deciles on current-model prices only.
  // Re-measured 2026-08-17 after the correction fit: current-model p90 1.59.
  '4.8.8': 1.5,
  // CLASSIC joined on 2026-08-10, and it is the one case that is not about a
  // shape being under-priced while players learn it. Rect's constraints just
  // conflict: it prices so gently that reaching 3.5 s/cell takes 130-156
  // cells, and BOARD_WIDTH_CAP holds it to 12 columns, so every board that
  // clears the shared floor is big, dense and stacked, which is exactly what
  // makes the certifier work hardest.
  //
  // Measured over 8,753 rect specs (the cache was swept again specifically to
  // check this, more than doubling it): FIVE legal boards clear 3.5, and
  // against a worst-of-N generation bar not one of them passed. So the zone
  // appeared to hold no Classic board at all.
  //
  // THAT BAR WAS THE MISTAKE, NOT THE FLOOR, and the allowance came straight
  // back out. Under his 2.5s peak allowance (see GEN_CAP_PEAK_MS) three of the
  // five are fine: their medians are 241-447ms and only their tails reach past
  // two seconds. For a while Classic reached the SHARED floor and this stayed
  // prose on purpose, the one shape whose absence was a measurement artifact.
  //
  // That ended on 2026-08-16: the first fit with match rows pooled moved the
  // equations enough that the five 3.5-clearing rect boards no longer exist
  // (the whole shape's 95th percentile sits at 1.58 over 14,725 measured
  // specs), so Classic was priced out of the zone entirely and his top-decile
  // ruling now covers it like the others. Its 90th percentile is 1.45; 1.5 is
  // the top decile. Rect prices gently BECAUSE its boards are familiar, which
  // is exactly the provisional reading above: as real play data accumulates
  // this entry should shrink toward the shared floor.
  // 1.35 put the margin bar at 1.3905 and the emit's two-decimal stored
  // prices admitted a 1.39, which sits ON the bar and fails the margin
  // re-check by rounding. One notch down gives stored prices real
  // headroom; 1.30 x 1.03 = 1.339, still under rect's 1.43 decile.
  rect: 1.3,
  // PETALS joined on 2026-08-17, the correction fit's own doing: with
  // rhombille and hex re-priced sane, floret's current-model p90 reads
  // 2.68 against the shared 3.5 floor, under it for the first time. The
  // top-decile ruling covers any shape the model prices below the shared
  // floor, so the same method applies: p90 over current-model prices,
  // divided by the margin, rounded down.
  floret: 2.6,
});

/** The admission floor a shape is held to. */
export function endlessPpcFloor(shape) {
  return ENDLESS_PPC_FLOOR_BY_SHAPE[shape] ?? ENDLESS_PPC_FLOOR;
}

// THE MARGIN THE FLOOR IS REALLY APPLIED AT, in one place because it was in
// three: the emitter admitted at 1.03, the pool's own test asserted 1.02, and
// the nightly re-price judged migration on the BARE floor. A spec measured at
// 3 seeds during the search and re-priced from its 16-seed median can land
// anywhere in that gap, so an entry could be admitted by the emitter, kept by
// the re-price, and refused by the test on the same commit, which is what
// happened to two cairo entries on 2026-08-13.
//
// One number, read by all three. It is the same headroom the generation cap
// and the par ceiling carry, and for the same reason: price varies by seed
// sample, so admission wants room above the ruling rather than a measurement
// that merely passed.
export const ENDLESS_PPC_FLOOR_MARGIN = 1.03;

/** The floor an entry must clear to be ADMITTED to, or KEPT in, the endless pool. */
export function endlessPpcAdmission(shape) {
  return endlessPpcFloor(shape) * ENDLESS_PPC_FLOOR_MARGIN;
}

// ── The two dedupe keys ────────────────────────────────────────────────

/**
 * THE FACE: what a player can actually tell apart: shape, dimensions, mine
 * count, modifier set. Uniqueness on the ladder is judged on this and never
 * on specFingerprint.
 *
 * The difference is not academic. The fingerprint separates `gimmickLevel`,
 * `wallSegments` and the deduction caps, none of which a player can see, and
 * measured on the old authored table it reported 130 distinct specs where
 * there were only 109 distinct BOARDS, so a ladder deduped on fingerprints
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
 * than specFace by exactly the dials a player cannot see, which is right for
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

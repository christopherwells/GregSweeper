// The tap floors, alone in a leaf so anything can ask for them.
//
// These are Christopher's rulings and they are pure data, but they lived in
// boardFit.js, which imports tilingGeometry to measure lattices. That made a
// module wanting nothing but the number 24 pull in the whole geometry layer,
// which is how the cell-size ladder ended up unable to derive from the floor
// it is defined against (2026-08-21).
//
// WHERE 24 COMES FROM (his ruling 2026-08-19, superseding an earlier 28): the
// floor measures the PRESSING SURFACE, the diameter of the circle inscribed in
// the cell polygon. That is verified geometry rather than a proxy, because
// assembleTiling normalizes every isohedral lattice so the inscribed diameter
// is exactly one pitch. The full derivation, and the measured frontier growth
// it bought, stay in boardFit.js beside the rules that consume them.

/** Minimum tap diameter (px) for a board's majority cell class. */
export const MIN_TAP_MAJORITY = 24;

/**
 * Minimum tap diameter (px) for a minority cell class. Only the 4.8.8 has one
 * (its interstitial diamonds); everywhere else min === median and this is
 * unreachable.
 */
export const MIN_TAP_MINORITY = 24;

# Pick up here

Working doc, same role as `PWA_HARDENING.md`. Written 2026-08-13. Delete the
sections as they land; delete the file when nothing is left.

---

## 1. TIME-SENSITIVE: merge PR #323 before a refit night passes

**[PR #323](https://github.com/christopherwells/GregSweeper/pull/323) is open,
green on both checks, and MERGEABLE/CLEAN.** It is the fix for the six reds the
2026-08-13 refit left on main.

The nightly refit runs at **23:17 UTC**. Every night it does not have #323, two
things happen:

1. **It re-ships the broken rhombille equation.** The lab-seeded earn-guard fix
   lives in `scripts/refit-par-model.R` ON THE BRANCH. Main still has the
   waiver, so main's refit re-prices rhombille off one live board and main goes
   red again on the same six tests. The branch's own `difficulty.js` is
   correct, so this only re-breaks MAIN, not the PR.
2. **It widens the merge.** The refit rewrites `difficulty.js`,
   `challengePool.js`, `climb-library/` and `match-library/` on main. The
   libraries are the class `scripts/refit-push-conflict.mjs` calls re-derivable,
   so the resolution is mechanical, but it is still work per night.

There is one conflict shape a plain rebase will NOT resolve on its own:
**`scripts/data/match-library/match-index.json` is DELETED on the branch and
rewritten by every refit on main**, which git reports as modify/delete. The
answer is always "stay deleted", because the split replaced it and nothing
reads it.

### Merging it

Squash-merge. No AI-attribution trailers to scrub (nothing in the commit or the
PR body mentions Claude/Anthropic), and no human co-author to preserve.

After the merge, RE-DERIVE rather than trusting whatever the refit last wrote:

```bash
node scripts/reprice-challenge-pool.mjs && node scripts/reprice-climb-library.mjs && node scripts/reprice-match-library.mjs && node --test test/*.test.mjs
```

Then bump `CACHE_NAME` in `sw.js` (it is at `v1.10.53` on the branch; check
main's value immediately before bumping, since the refit does not touch it).

---

## 2. What #323 actually did, in one screen

The six reds were **all rhombille, all one cause**: the refit re-priced that
shape **62% cheaper on a single live board**, which put its band table (48-110s
to 18-22s) outside the daily band, under the weekly floor, under the endless
400s floor, and out of the match library's rhombille corners.

The cause was a deliberate waiver, not a bug: lab-seeded deviations shipped
their fitted posterior with no row guard, on the reasoning that a lab center is
86 boards of designed data and the first live rows would only nudge it. True
for five shapes. Rhombille's lab prior was the widest the lab produced (sd
0.181 on the totalMines interaction against ~0.06 elsewhere) and the doubling
ruling widens it further, so one row overwrote it rather than nudging it.

**Christopher's ruling:** gate lab-seeded deviations on the same
`NEW_FEATURE_DATA_THRESHOLD` (20) as everything else; below it ship the lab
CENTER. Both seeding rulings survive intact, since a lattice still prices as
itself from the day the rotation flips, and live data still takes over at
doubled width once there is enough of it.

Also in the PR: the endless spec pool takes the merged slice-quota fix (32 to
95 entries, all seven shapes); the ladder pool is deliberately NOT re-emitted;
the "pin the last spec of a shape" rule is gone; and the match index is SPLIT
(`match-summary.json` + per-shape shards, sheet fetch 71 KB gz to 1.7 KB).

Three defects fixed at their producers along the way: the re-binner could not
see the endless per-shape floor, `reserve.json` carried 14 duplicate seeds, and
the endless ppc floor margin existed as three different numbers.

---

## 3. Owed, in the order it is worth doing

### a. Classic's endless spec depth (small, do it first)

`ENDLESS_POOL` ships **2 rect entries against 16 for every lattice**. Five of
the six rect entries the old pool carried are marked `ok: false` in the search
cache: they fail generation on re-measurement and survived only because an
older `harden-endless-pool.mjs` pass admitted them. Re-shipping those is the
wrong answer; the right one is material:

```bash
node scripts/search-endless-specs.mjs --shape rect --seeds 10 --refine --minutes 45
```

then `node scripts/write-challenge-pool.mjs --only endless`, then
`node scripts/reprice-challenge-pool.mjs --capture --merge --seeds 16`, then
`node scripts/reprice-challenge-pool.mjs`.

Re-baseline `GOLDEN: the first endless block is fixed` in
`test/challengeEndless.test.mjs` with a reason appended to its comment stack,
the way every previous move of it is documented.

**Not urgent:** this pool is only the L251+ FALLBACK braid. The play path is the
pre-generated library, where rect holds 81 boards.

### b. Ladder level deficits

210 levels sit under their board minimum (worst: L26-L33 at 10/20). The
nightly's own remedy runs bounded at 20 min/night:

```bash
node scripts/topup-climb-library.mjs --fill
```

It will chip away on its own; run it by hand if the deficit stops shrinking.

### c. Match library depth, the thing the index split unblocked

See `memory/match-library-depth.md` for his design and the pricing. The split is
done, so the **~3,000-board cap is lifted**. His agreed order, with step 2 now
complete:

1. **per-corner seen-cycle (#305)**, still open, and still the most urgent of
   the four. The seen list is ONE GLOBAL list, so a player who exhausts one
   narrow filter wipes their whole library-wide no-repeat record. More boards
   moves that wall without removing it.
2. ~~index split~~, done.
3. **nightly demand-driven top-up**: generate 20 more boards of any combination
   nearly exhausted by any player.
4. **per-shape relative bands**, his ruling that "long" and "dense" are
   relative to their shape, so a long 3D Cubes is shorter than a long Classic.
   Fills the structurally-empty corners truthfully.

He is fine with hours of local background generation to seed a bigger library
once the seen-cycle is fixed. Measured: 2,759 boards generate in ~100 seconds.

**Do not confuse thin corners with empty ones.** An empty corner has no SPEC
covering it, and no number of boards per existing spec reaches one; that is
the spec search, a different job from the library build.

---

## 4. Two things worth remembering before touching any of this

**A big one-night move in one shape's equation is a DATA question, not a
downstream-artifact question.** Check `src/logic/experimentTarget.json` under
`shape_coverage` first. On 2026-08-13 every lattice sat at 0-2 boards in the
fit. Rebuilding the band tables, the spec pool and both libraries to match
would have baked a one-row posterior into all of them.

**The nightly refit skips CI**, so main can be red for a day before any PR
surfaces it. Check whether main is already red before debugging a branch.

```bash
gh run list --branch main --limit 5
```

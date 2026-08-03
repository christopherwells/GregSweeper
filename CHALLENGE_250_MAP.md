# Challenge 250: the 45-block map

**Status: the three open items are RULED (Christopher, 2026-08-03); the map is
settled for planning. Nothing builds until his explicit build go.**
Every design ruling it implements comes from the 2026-08-03 design interview; the
numbers come from the Par Lab prior fit (PR #221, `scripts/fit-parlab-priors.qmd`,
the lab-seeded `PAR_MODEL_SHAPES` equations) and from generation probes run at
those equations on 2026-08-03.

---

## 1. The three open items, now ruled (2026-08-03)

**1. Compass intro host: Octagons (block 19). RULED.** The reasons that carried
it: a diagonal ray reads as visible steps along the octagon/square staircase
(the same legibility that drove the coastline compass-diagonal ruling), and
Paving Stones already hosts sonar's debut. The accepted cost is that Octagons
hosts two debuts (wormhole and compass).

**2. Shape-intro positions: blocks 6 / 9 / 12 / 15 / 21 / 38. RULED.**
Honeycomb, Octagons, 3D Cubes, Paving Stones, Petals, Kites, in the fitted
difficulty order (multipliers 1.02 / 1.20 / 1.77 / 2.03 / 2.77 / 5.14). The
probe constraint stands: a shape cannot intro below its par-per-cell floor
(section 3), and Kites cannot price below about 1.75 s/cell on any proven
config, which keeps its intro at tier 8 or later regardless.

**3. Numeric tier anchors: ADOPTED NOW (T1 0.55 through T12 3.25 s/cell).
RULED** on his "I think we have enough data" call, superseding the interview's
wait-for-live-scores hedge. The reasoning: Challenge-250 ships bundled with the
rotation flip, so no pre-launch live tiling data exists under any plan; the
86-board battery is a designed instrument that measured exactly the axes the
anchors need; challenge stays out of the par fit, so the anchors cannot pollute
it; and the displayed expected time is personalPar off the live equations, so
player-facing time promises self-correct as population data accrues. The
residual (one practiced player's cross-shape ratios standing in for
everyone's) is a post-flip tuning-pass risk: if a refit moves a shape's
equation enough that its authored specs drift ~20% off their tier, re-derive
that shape's specs; indices and the block map do not move.

---

## 2. The frame (settled rulings, restated for reference)

- **A level is a par rating, not a fixed puzzle.** Spec is the identity: level =
  {par-per-cell tier, shape, modifier set}. Every attempt draws a fresh certified
  layout of the spec, with the marked Start-here opener. No memorize-through.
- **Difficulty is par-per-cell, never raw par.** Absolute par ceiling 8 minutes;
  no giant boards just to inflate time. Expected time is displayed,
  handicap-adjusted (personalPar), as a pre-level card plus a quiet in-game bar
  that fills as the timer runs.
- **250 authored levels: 50 blocks of 5** (5 opener blocks + 45 post-opener).
  Block = checkpoint = survival unit; death returns you to the block start.
  Classic loss + lifelines, not strikes.
- **Plateau tiers**: each block holds one par-per-cell tier flat; steps happen
  between blocks. Intro blocks run gentle (the dip rule, section 4).
- **Modifiers must be load-bearing** on ladder boards: the strict filter, no
  relax-to-ship.
- **Pressure plates retire from the ladder** (Chaos-only). MineShift stays
  Chaos-only.
- **Past L250 the game is endless** at the frozen top tier: mixed board lengths
  at fixed intensity, checkpoints keep landing every 5, banked forever; max
  level is the brag stat.
- **Everyone replays from L1; no memento of the old 120 climb. Themes fully
  relock** and re-earn along a ladder re-spread over 250.

---

## 3. The currency: par-per-cell tiers

### The ladder (numeric anchors ADOPTED 2026-08-03; lab-seeded, tuned post-flip
only if a refit moves a shape materially)

Twelve tiers, geometric steps of roughly ×1.18. Par examples show the anchor
applied at two typical board sizes.

| Tier | s/cell | Par at ~72 cells | Par at ~110 cells | First reached |
|------|--------|------------------|-------------------|---------------|
| T1   | 0.55   | 40s              | 60s               | Block 1       |
| T2   | 0.65   | 47s              | 72s               | Block 3       |
| T3   | 0.75   | 54s              | 83s               | Block 5       |
| T4   | 0.90   | 65s              | 99s               | Block 10      |
| T5   | 1.05   | 76s              | 116s              | Block 13      |
| T6   | 1.25   | 90s              | 138s              | Block 16      |
| T7   | 1.50   | 108s             | 165s              | Block 19      |
| T8   | 1.80   | 130s             | 198s              | Block 22      |
| T9   | 2.15   | 155s             | 237s              | Block 26      |
| T10  | 2.55   | 184s             | 281s              | Block 31      |
| T11  | 2.90   | 209s             | 319s              | Block 36      |
| T12  | 3.25   | 234s             | 358s              | Block 42      |

### Two measured facts the ladder is built around

**The currency needs a size floor.** The par model's intercept is ~19 seconds,
so tiny boards read high per cell while being trivially easy (a 5×5 beginner
board prices 22s, 0.90 s/cell). Par-per-cell is the honest difficulty axis from
roughly 48 cells up; the opener blocks are therefore sized by the
deduction-count floor (every board needs 3 to 5 real deductions, killing the
one-click cascade levels) rather than by chasing a per-cell number on a small
board.

**Boosted Classic tops out near 3.2 to 3.4 s/cell, so T12 = 3.25 is set exactly
there.** This is the calibration finding the sweep round asked for. Measured at
the shipped equations: plain Classic at the 34% density cap reaches 2.45 s/cell
(12×12, 49 mines, par 354s), and the 8-minute ceiling binds before the width cap
does (14×12 at 34% prices 602s and is out). A strong 3-stack (locked + sonar +
walls territory) adds roughly 30 to 50%, landing an 11-to-12-wide Classic at
about 3.2 to 3.4 s/cell inside the ceiling. Setting the top authored tier at 4.0
(Kites' natural daily-config number) would have made Classic structurally unable
to reach it; at 3.25 every shape reaches T12 and Kites overshoots it on sparser
configs (its 48-cell, 27%-density config prices 3.13). The "every shape lives at
every tier" rule reads upward, and the probes say it also has a floor direction:

### Per-shape par-per-cell reach (measured, plain boards, shipped equations)

| Shape         | Floor (gentlest proven config)   | Natural high end            | Tier range |
|---------------|----------------------------------|-----------------------------|------------|
| Classic       | ~0.5 (8×8 at 16%)                | 2.45 plain / ~3.3 stacked   | T1 to T12  |
| Honeycomb     | 0.55 (49c at 18%)                | 1.98 at 0.28 / higher by density + stacks | T1 to T12 |
| Octagons      | 0.58 (50c at 14%)                | 1.59 at 0.22 / higher by density + stacks | T1 to T12 |
| 3D Cubes      | 0.98 (48c at 23%)                | 1.57 at 0.28 / ~3.3 with density + stacks | T5 to T12 |
| Paving Stones | 1.00 (49 cells)                  | 1.46 at 84c / ~3.1 big + stacks | T5 to T12 |
| Petals        | 1.14 (36c at 17%)                | 2.53 at 72c 28% / 3.8 at 96c | T6 to T12 |
| Kites         | 1.75 (36c at 17%)                | 3.96 at daily config; 5.14 at 0.28 | T8 to T12 |

Consequences baked into the map: 3D Cubes cannot intro before the T4/T5
neighborhood, Petals not before T6, Kites not before T8. The drafted intro
positions respect these floors with a little room. Paving Stones' lever is size
only (its fitted per-mine deviation cancels the base rate; 49/60/66/84-cell
rungs all price flat across density), so its high tiers come from big boards
plus stacks; Kites' lever is density (per-cell ~0), so its high tiers come from
mines; the interview's "cairo boosts by size, deltoidal by density" is what the
equations independently say.

### Generation caveats that gate the build (not the map)

- Densities above 0.28 were unproven when this map was first drafted (the lab
  grid's ceiling). The density-ceiling sweep (section 7, Christopher's ask
  2026-08-03) has since proven certified generation to 0.38 on every lattice
  at every ladder size, so density is not a viability constraint anywhere the
  ladder reaches; the 34% challenge cap stays as the ladder convention because
  no tier needs more, not because generation fails above it.
- 3D Cubes boards stay at or under 72 cells (the 90-cell fixture measured 13.7s
  worst-case generation; ladder attempts draw fresh layouts, so per-attempt cost
  is player-facing). The sweep adds the cost detail: dense Cubes and dense
  stacked Kites are the two multi-second generators (section 7).
- Sub-0.22 density on the Laves lattices routes through the constructive placer
  (`forceConstructive`), per the banded daily config tables' finding.

---

## 4. The 50-block map

Legend: **SHAPE INTRO** blocks are plain boards on the new lattice at its
gentlest proven config (the quantified dip), with one familiar modifier teased
on the block's fifth level. **MOD INTRO** blocks introduce one modifier on its
venue (mechanism modifiers on a mechanism-chosen lattice the player already
knows; shape-neutral modifiers on the most recently introduced shape). Remix
blocks name their purposeful pairing; nothing rolls random secondaries. Tier
column = the block's plateau (parenthesized tier = intro dip below the line).

### Opener, L1-25, all Classic (three modifier intros)

| Block | Levels | Tier | Beat |
|-------|--------|------|------|
| 1  | 1-5    | T1 | Counting fundamentals. 7×7 to 8×8, every board 3-5 real deductions (the opening floor). |
| 2  | 6-10   | T1 | **MOD INTRO: Walls.** Small boards; the wall as topology, not decoration. |
| 3  | 11-15  | T2 | **MOD INTRO: Liar.** The pink cell; ±1 as a disjunction. |
| 4  | 16-20  | T2 | **MOD INTRO: Mystery.** Information delayed; solving around a hole. |
| 5  | 21-25  | T3 | Opener capstone: first 2-stacks of walls/liar/mystery. Checkpoint L25 = the door to the shapes. |

### The braid, L26-250 (45 blocks)

| Block | Levels | Tier | Shape | Beat |
|-------|--------|------|-------|------|
| 6  | 26-30   | (T2) | Honeycomb | **SHAPE INTRO**. Plain hexes; L30 tease: walls. |
| 7  | 31-35   | T3 | Honeycomb | **MOD INTRO: Locked** (shape-neutral → most recent shape). |
| 8  | 36-40   | T3 | Classic | Remix: walls+liar and walls+mystery pairs at tier. |
| 9  | 41-45   | (T3) | Octagons | **SHAPE INTRO**. Plain; L45 tease: mystery. |
| 10 | 46-50   | T4 | Octagons | **MOD INTRO: Wormhole** (mechanism venue: asymmetric pairs on the two cell sizes). |
| 11 | 51-55   | T4 | Honeycomb | Remix: locked+walls; first same-shape return. |
| 12 | 56-60   | (T4) | 3D Cubes | **SHAPE INTRO** (floor ~0.98 makes the dip land at T5-ish par on 48 cells). L60 tease: liar. |
| 13 | 61-65   | T5 | 3D Cubes | **MOD INTRO: Mirror** (shape-neutral → most recent shape). |
| 14 | 66-70   | T5 | Classic | Remix: liar+locked, mystery+mirror. |
| 15 | 71-75   | (T5) | Paving Stones | **SHAPE INTRO**. Plain pentagons; L75 tease: locked. |
| 16 | 76-80   | T6 | Paving Stones | **MOD INTRO: Sonar** (mechanism venue: the valence-7 depth-2 ball). |
| 17 | 81-85   | T6 | Octagons | Remix: wormhole+locked. |
| 18 | 86-90   | T6 | 3D Cubes | Remix: mirror+walls, density up (Cubes' lever). |
| 19 | 91-95   | T7 | Octagons | **MOD INTRO: Compass** (8-way family; the diagonal ray reads as steps along the octagon/square staircase). |
| 20 | 96-100  | T7 | Classic | Remix: sonar+compass join the home-turf pool. Milestone L100. |
| 21 | 101-105 | (T7) | Petals | **SHAPE INTRO** (floor ~1.14). Plain pinwheels; L105 tease: walls. |
| 22 | 106-110 | T8 | Honeycomb | **MOD INTRO: Worm** (mechanism venue: the purest six-exit crawl, side-only per the shipped ruling). |
| 23 | 111-115 | T8 | Paving Stones | Remix: sonar+liar on the 84-cell board (Paving's size lever). |
| 24 | 116-120 | T8 | Petals | Remix: walls+mystery on the rosettes. |
| 25 | 121-125 | T8 | 3D Cubes | **REPRISE: Wormhole** (sum ceiling 20; the two-token extreme). |
| 26 | 126-130 | T9 | Classic | Remix: 2-stacks on a dense 11×11. |
| 27 | 131-135 | T9 | Honeycomb | Remix: worm+walls (the crawl in corridors). |
| 28 | 136-140 | T9 | 3D Cubes | **REPRISE: Sonar** (valence-10 ball, ~31 cells; structural relief on the no-subset lattice). |
| 29 | 141-145 | T9 | Octagons | Remix: compass+mirror. |
| 30 | 146-150 | T9 | 3D Cubes | Remix: mirror+locked at 0.28 density. Milestone L150. |
| 31 | 151-155 | T10 | Honeycomb | **REPRISE: Compass 60°** (the six-axis family on the lattice that defined it). |
| 32 | 156-160 | T10 | Petals | Remix: sonar+liar on the pinwheel. |
| 33 | 161-165 | T10 | Classic | Remix: 2-stacks, 12×12 toward 0.30. |
| 34 | 166-170 | T10 | Petals | **REPRISE: Worm** (the rotated-pinwheel crawl; heavy realized load). |
| 35 | 171-175 | T10 | Paving Stones | Remix: compass+locked on the big board. |
| 36 | 176-180 | T11 | Honeycomb | Remix: density push past 0.28 (needs the generation-proof pass), 2-stacks. |
| 37 | 181-185 | T11 | Petals | **REPRISE: Compass 30°** (the due-north family; Kites arrives next block as a plain intro, so Petals hosts). |
| 38 | 186-190 | (T9) | Kites | **SHAPE INTRO**, the one late intro with a real dip. Plain kites at the 36-cell floor config; L190 tease: mystery. |
| 39 | 191-195 | T11 | Kites | Consolidation: density-boosted (Kites' lever), one modifier. |
| 40 | 196-200 | T11 | Classic | **3-STACK DEBUT** on home turf. Milestone L200. |
| 41 | 201-205 | T11 | 3D Cubes | 3-stacks: sonar+mirror+walls. |
| 42 | 206-210 | T12 | Octagons | 3-stacks: wormhole+compass+locked. |
| 43 | 211-215 | T12 | Paving Stones | 3-stacks on the size lever (84-cell + locked+sonar+walls). |
| 44 | 216-220 | T12 | Kites | 2-stacks with mines up; its 3-stack waits for the gauntlet. |
| 45 | 221-225 | T12 | Honeycomb | 3-stacks: worm+compass+walls at the density frontier. |
| 46 | 226-230 | T12 | Classic | 3-stacks at the boosted-Classic ceiling (11-12 wide, 34%). |
| 47 | 231-235 | T12 | mixed | Pre-finale remix: 3-stacks drawn across all learned shapes. |
| 48 | 236-240 | T12 | gauntlet | **FINALE I**: Classic → Honeycomb → Octagons → Paving Stones → 3D Cubes, one per level. |
| 49 | 241-245 | T12 | gauntlet | **FINALE II**: Petals → Kites → Classic → 3D Cubes → Paving Stones. |
| 50 | 246-250 | T12 | gauntlet | **FINALE III**: the seven-shape summit; L250 = Kites, 3-stacked, the crown. |
| 51+ | 251+   | T12 | endless | Frozen top tier, mixed board lengths at fixed intensity; checkpoints every 5, banked forever. |

### Consistency checks the table passes

- Shape intros in fitted-multiplier order; every intro at or above its
  par-per-cell floor; every intro plain with a fifth-level tease.
- Venue rule: wormhole debuts on Octagons (block 10, after block 9), sonar on
  Paving Stones (16, after 15), worm on Honeycomb (22, long after 6), compass
  on an 8-way lattice (19, after 9); locked and mirror debut on the most
  recently introduced shape (7 on Honeycomb, 13 on 3D Cubes).
- All five reprises placed in the back half at T8+: wormhole→Cubes (25),
  sonar→Cubes (28), compass 60°→Honeycomb (31), worm→Petals (34), compass
  30°→Petals (37).
- Stacks reach 3 only from block 40; the finale gauntlet is the last three
  blocks; endless freezes T12.
- Every one of the nine ladder modifiers appears in at least one remix after
  its intro; no block rolls a random secondary.

---

## 5. Build notes (declared assumptions from the sweep round, restated so the
build phase inherits them with the map)

- **Progression reset needs an epoch marker** so a stale device's old
  maxCheckpoint cannot resurrect through the cloud max-merge (the moltDay
  date-anchored-snapshot lesson).
- **Power-ups**: inventories wipe to zero at the L1 reset; all six stay; earns
  become tier-scaled; area effects are already graph-native (#218/#220: X-Ray
  depth-2 ball, Magnet depth-1, Scan line sweeps).
- **Checkpoint selector survives** (tier-scaled earns make early-tier farming
  pointless). First-encounter modifier popups do not re-show after the reset.
- **Themes relock** and re-spread across 250 (24 unlockable themes over 45
  post-opener blocks lands one roughly every two blocks; exact spread is a
  build detail).
- **Challenge Climber re-bases** to the 250 ladder + endless (bronze early,
  diamond reaching into the endless zone); medals reset with progression.
- **Chaos gains the shapes** (outside the certification contract; renderer
  reach only). Quick Play stays rectangular.
- **Challenge stays out of the par-model fit**: no submission path,
  progression only.
- **Ships bundled with the v1.10 rotation flip** as one release.

---

## 6. Numbers appendix (probe medians at the 2026-08-03 shipped equations)

Representative certified-generation configs per shape with fitted Greg par and
par-per-cell. All plain boards, 12 probes each; modifier stacks price on top
(locked ≈ +4%/cell it locks, sonar ≈ +5%/cell, compass ≈ +2%/cell, worm by
realized load). One-player-seeded; the live rotation will move these.

**Classic**: 8×8/10m 34s (0.53) · 9×9/18m 55s (0.68) · 11×11/27m 96s (0.80) ·
11×11/31m 126s (1.04) · 12×12/35m 159s (1.11) · 12×12/40m 211s (1.46) ·
12×12/43m 279s (1.93) · 12×12/49m 354s (2.45).
**Honeycomb**: 49c/9m 27s (0.55) · 63c/14m 43s (0.68) · 81c/20m 76s (0.94) ·
81c/23m 106s (1.31) · 110c/28m 158s (1.44) · 110c/31m 218s (1.98).
**Octagons**: 50c/7m 29s (0.58) · 72c/13m 50s (0.69) · 85c/19m 90s (1.06) ·
98c/22m 118s (1.20) · 98c/25m 163s (1.66) · 128c/28m 203s (1.59).
**Paving Stones**: 49c 49s (1.00) · 60c 65s (1.08) · 66c 77s (1.17) · 84c 123s
(1.46), each flat across its density row.
**3D Cubes**: 48c/11m 47s (0.98) · 60c/14m 61s (1.02) · 72c/17m 78s (1.08) ·
60c/17m 88s (1.47) · 72c/20m 113s (1.57).
**Petals**: 36c/6m 41s (1.14) · 48c/10m 61s (1.27) · 72c/15m 100s (1.39) ·
96c/17m 119s (1.24) · 72c/20m 182s (2.53) · 96c/23m 236s (2.46).
**Kites**: 36c/6m 63s (1.75) · 36c/9m 90s (2.50) · 48c/10m 106s (2.21) ·
48c/13m 150s (3.13) · 72c/15m 194s (2.69) · 72c/18m 285s (3.96) · 72c/20m 370s
(5.14).

---

## 7. Density ceilings (the sweep Christopher commissioned 2026-08-03)

Question: how high can each tiling go in mine density? Instrument:
`scripts/measure-tiling-density-ceilings.mjs` (re-runnable, deterministic
seeds). Per lattice, per ladder-relevant size, densities 0.28 through 0.38:
10 plain seeds through the shipped `generateTilingBoard` (production attempt
budget), plus a locked+sonar+walls 3-stack spot check at the mid size at 0.30
and 0.34 (6 seeds). Times are desktop Node; phone generation runs roughly 3 to
5 times slower, and ladder death-retries draw a fresh layout, so worst-case
time is player-facing.

### The headline: no generation ceiling exists in the swept range

**Every cell certified 10/10 plain and 6/6 stacked, on all six lattices, at
every size, through density 0.38.** The constructive placer carries every
lattice well past the 34% challenge cap. Density is therefore not a viability
constraint anywhere the ladder reaches; what actually binds, in order, is the
8-minute par ceiling, the tier targets themselves, and generation COST on two
lattices (below). The 34% cap survives as the ladder convention because no
tier needs more, not because generation fails above it.

### Par-per-cell by density (probe medians; sizes are the ladder set)

Values above 0.28 are EXTRAPOLATIONS of equations fit on densities up to 0.28
(the lab grid's range): read them as the model's best guess, firm enough for
spec drafting, re-checked once live tiling scores exist. Success rate and time
are direct measurements either way.

| Shape / size | 0.28 | 0.30 | 0.32 | 0.34 | 0.36 | 0.38 |
|---|---|---|---|---|---|---|
| Honeycomb 63c  | 1.06 | 1.19 | 1.32 | 1.47 | 1.83 | 2.04 |
| Honeycomb 81c  | 1.30 | 1.45 | 1.81 | 2.25 | 2.50 | 3.11 |
| Honeycomb 110c | 1.98 | 2.46 | 3.06 | 3.82 | 5.28 | 6.57 |
| Octagons 72c   | 1.42 | 1.75 | 1.94 | 2.16 | 2.61 | 2.90 |
| Octagons 98c   | 2.02 | 2.45 | 2.98 | 3.71 | 4.50 | 5.51 |
| Octagons 128c  | 3.66 | 4.47 | 6.13 | 8.08 | 9.92 | 13.6 |
| Paving 49c     | 0.99 | 0.99 | 0.99 | 0.99 | 0.98 | 0.98 |
| Paving 66c     | 1.15 | 1.14 | 1.16 | 1.13 | 1.13 | 1.15 |
| Paving 84c     | 1.46 | 1.51 | 1.52 | 1.45 | 1.42 | 1.46 |
| Cubes 48c      | 0.99 | 1.11 | 1.23 | 1.35 | 1.62 | 1.77 |
| Cubes 60c      | 1.46 | 1.65 | 1.86 | 2.10 | 2.68 | 3.02 |
| Cubes 72c      | 1.56 | 1.99 | 2.25 | 2.54 | 3.23 | 3.65 |
| Petals 36c     | 1.74 | 1.93 | 2.15 | 2.15 | 2.39 | 2.66 |
| Petals 48c     | 1.78 | 1.98 | 2.19 | 2.49 | 2.71 | 3.04 |
| Petals 72c     | 2.40 | 3.11 | 3.33 | 3.71 | 4.55 | 5.08 |
| Petals 96c     | 3.76 | 4.65 | 5.89 | 7.02 | 8.52 | 9.96 |
| Kites 36c      | 2.80 | 3.34 | 3.65 | 3.62 | 4.14 | 4.59 |
| Kites 48c      | 3.08 | 3.48 | 3.97 | 4.53 | 5.08 | 5.76 |
| Kites 72c      | 5.16 | 6.62 | 7.33 | 8.49 | 10.6 | 12.3 |

Classic 12×12 reference: 10/10 certified at 0.30 / 0.34 / 0.36 / 0.38, worst
generation under half a second. The 34% cap was always a feel-and-speed
convention; generation does not fail above it on the square grid either.

### Generation cost (the real budget, two lattices)

Fast everywhere (worst under ~0.2s desktop at any density): Honeycomb, Paving
Stones, Petals, Octagons up to 98c (Octagons 128c reaches ~0.5s at 0.38).
The two to watch, desktop worst cases:

- **3D Cubes**: plain 72c runs 1.7 to 3.2s at 0.34+; the 3-stack at 60c hit
  2.4s (0.30) and 7.7s (0.34). On a phone that is tens of seconds per
  death-retry. Planning rule: top-tier Cubes specs prefer 48 to 60 cells at
  high density, or a 72c spec accepts multi-second regen.
- **Kites**: plain fine to 0.32 (worst ~1.3s at 48c); the 3-stack at 48c hit
  7.5s at 0.34. Same rule: dense stacked Kites stays at 36 to 48 cells.

### What the sweep changes in the plan

- **Every T12 need is comfortably inside the proven range.** T12 = 3.25 s/cell
  is reachable on every shape without leaving it (Honeycomb 110c at ~0.32,
  Octagons 98c at ~0.33, Cubes 72c at ~0.36 plain or 0.34 plus a stack,
  Petals 72c at ~0.32, Kites 36c at ~0.30, Paving and Classic via size +
  stacks), so no spec needs a density the sweep did not prove.
- **Paving Stones' density insensitivity is now measured at every size**: ppc
  is flat to three densities' width across its whole row (per-mine deviation
  cancels the base rate). Density is not merely a weak lever for Paving
  Stones; it is NOT a lever. Its tier boosts are size and stacks, full stop.
- **Kites' natural T12 window is low density** (0.28 to 0.30 at 36 to 48
  cells), which conveniently also keeps its generation fast. Its dense
  extreme (72c at 0.30+ pricing 6+ s/cell) belongs to the endless zone's
  flavor space, not the authored ladder, and would breach the 8-minute
  ceiling anyway.
- Tier-level distributions rode along: Kites 72c runs techniqueLevel 2 at
  every density (the enumeration-rich lattice); Cubes' plain sweep boards sit
  at tier 0 with its 3-stacks at tier 1 (Pass A until something forces Pass
  C); Paving's 84-cell rung runs tier 1 at every density while its smaller
  rungs stay tier 0.

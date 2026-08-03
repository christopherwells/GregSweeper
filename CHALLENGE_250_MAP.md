# Challenge 250: the 45-block map (DRAFT for markup)

**Status: DRAFT. Nothing builds from this document until Christopher marks it up.**
Every design ruling it implements comes from the 2026-08-03 design interview; the
numbers come from the Par Lab prior fit (PR #221, `scripts/fit-parlab-priors.qmd`,
the lab-seeded `PAR_MODEL_SHAPES` equations) and from generation probes run at
those equations on 2026-08-03. Where this draft had to make a call the interview
left open, the call is marked ⚑ and listed in the first section so it can be
approved, changed, or struck in one pass.

---

## 1. The three open items (your markup targets)

**⚑ 1. Compass intro host (8-way family).** The interview fixed one compass intro
on the 8-way direction family plus a dedicated reprise per remaining family (60°,
30°), and left the host open between Octagons and Paving Stones. **Draft:
Octagons (block 19).** Reasons: a diagonal ray reads as visible steps along the
octagon/square staircase (the same legibility that drove the coastline
compass-diagonal ruling), and Paving Stones already hosts sonar's debut, so this
spreads the
showcase moments. The honest counterargument: Octagons then hosts two debuts
(wormhole and compass) while Paving Stones hosts one. Both lattices measure
clean rays (diagonal families at 100% line-in-counted-cells). Swap to Paving
Stones is a one-cell edit in the table.

**⚑ 2. Shape-intro block positions.** Drafted at blocks 6 (Honeycomb), 9
(Octagons), 12 (3D Cubes), 15 (Paving Stones), 21 (Petals), 38 (Kites), in the
fitted difficulty order (multipliers 1.02 / 1.20 / 1.77 / 2.03 / 2.77 / 5.14).
Two specific questions: is Kites at L186 late enough to honor "much later," and
is the three-block gap between Honeycomb and Octagons the right early pacing?
One hard constraint discovered in the probes limits how much earlier the late
shapes could move: a shape cannot intro below its par-per-cell floor (section 3),
and Kites cannot price below about 1.75 s/cell on any proven config, which keeps
its intro at tier 8 or later no matter what.

**⚑ 3. Numeric tier anchors.** The interview ruled the map ships tier indices
with placeholder ranges, anchors finalized after live tiling scores exist. The
draft table in section 3 carries numeric anchors anyway, clearly labeled as
one-player-seeded (the lab multipliers are practiced-Christopher play). They are
there so the block map is checkable against real configs today; treat every
number as provisional and the indices as the contract.

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

### The ladder (⚑ numeric anchors are draft, one-player-seeded)

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

- Densities above 0.28 are unproven on every tiling (the lab grid's ceiling).
  T11/T12 tiling specs that want 0.30+ need a generation-proof pass first, the
  `validate-parlab-battery.mjs` pattern; the challenge cap stays 34%.
- 3D Cubes boards stay at or under 72 cells (the 90-cell fixture measured 13.7s
  worst-case generation; ladder attempts draw fresh layouts, so per-attempt cost
  is player-facing).
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
| 6  | 26-30   | (T2) | Honeycomb | **SHAPE INTRO** ⚑pos. Plain hexes; L30 tease: walls. |
| 7  | 31-35   | T3 | Honeycomb | **MOD INTRO: Locked** (shape-neutral → most recent shape). |
| 8  | 36-40   | T3 | Classic | Remix: walls+liar and walls+mystery pairs at tier. |
| 9  | 41-45   | (T3) | Octagons | **SHAPE INTRO** ⚑pos. Plain; L45 tease: mystery. |
| 10 | 46-50   | T4 | Octagons | **MOD INTRO: Wormhole** (mechanism venue: asymmetric pairs on the two cell sizes). |
| 11 | 51-55   | T4 | Honeycomb | Remix: locked+walls; first same-shape return. |
| 12 | 56-60   | (T4) | 3D Cubes | **SHAPE INTRO** ⚑pos (floor ~0.98 makes the dip land at T5-ish par on 48 cells). L60 tease: liar. |
| 13 | 61-65   | T5 | 3D Cubes | **MOD INTRO: Mirror** (shape-neutral → most recent shape). |
| 14 | 66-70   | T5 | Classic | Remix: liar+locked, mystery+mirror. |
| 15 | 71-75   | (T5) | Paving Stones | **SHAPE INTRO** ⚑pos. Plain pentagons; L75 tease: locked. |
| 16 | 76-80   | T6 | Paving Stones | **MOD INTRO: Sonar** (mechanism venue: the valence-7 depth-2 ball). |
| 17 | 81-85   | T6 | Octagons | Remix: wormhole+locked. |
| 18 | 86-90   | T6 | 3D Cubes | Remix: mirror+walls, density up (Cubes' lever). |
| 19 | 91-95   | T7 | Octagons | **MOD INTRO: Compass** ⚑host (8-way family; the diagonal ray reads as steps along the octagon/square staircase). |
| 20 | 96-100  | T7 | Classic | Remix: sonar+compass join the home-turf pool. Milestone L100. |
| 21 | 101-105 | (T7) | Petals | **SHAPE INTRO** ⚑pos (floor ~1.14). Plain pinwheels; L105 tease: walls. |
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
| 38 | 186-190 | (T9) | Kites | **SHAPE INTRO** ⚑pos, the one late intro with a real dip. Plain kites at the 36-cell floor config; L190 tease: mystery. |
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

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

**3. Numeric tier anchors: ADOPTED NOW (T1 0.55 through T12 3.60 s/cell).
RULED** on his "I think we have enough data" call, superseding the interview's
wait-for-live-scores hedge; the summit moved 3.25 to 3.60 in his second-pass
ruling the same day, once the Classic density sweep showed the reach ("we can
move the difficulty ceiling up some but it'd have to be 3.6 at max"). The reasoning: Challenge-250 ships bundled with the
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
- **Past L250 the game is endless, UNBOUNDED ABOVE T12** (his ruling
  2026-08-03, superseding the earlier frozen-top-tier phrasing): endless
  specs can be any difficulty at or above 3.6 s/cell that certifies, mixed
  board lengths, checkpoints keep landing every 5, banked forever; max level
  is the brag stat. The 5-to-12 s/cell monsters the density sweep priced are
  exactly this zone's material. One flag for his confirmation: whether the
  8-minute par ceiling also lifts in endless (his wording, "any difficulty
  above 3.6 that is solveable", reads as solvability being the only
  constraint; the 2-second generation cap is assumed to stand either way).
- **Everyone replays from L1; no memento of the old 120 climb. Themes fully
  relock** and re-earn along a ladder re-spread over 250.

---

## 3. The currency: par-per-cell tiers

### The ladder (numeric anchors ADOPTED 2026-08-03; T12 raised to 3.60 in his
same-day second-pass ruling; tuned post-flip only if a refit moves a shape
materially)

Twelve tiers, geometric steps of roughly ×1.18 with a slightly larger final
step up to the ruled summit. Par examples show the anchor applied at two
typical board sizes.

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
| T12  | 3.60   | 259s             | 396s              | Block 42      |

### Two measured facts the ladder is built around

**The currency needs a size floor.** The par model's intercept is ~19 seconds,
so tiny boards read high per cell while being trivially easy (a 5×5 beginner
board prices 22s, 0.90 s/cell). Par-per-cell is the honest difficulty axis from
roughly 48 cells up; the opener blocks are therefore sized by the
deduction-count floor (every board needs 3 to 5 real deductions, killing the
one-click cascade levels) rather than by chasing a per-cell number on a small
board.

**Classic reaches T12 plainly once the density cap is revisited, and the
summit was raised on that strength (both moves 2026-08-03).** The original
calibration finding held the 34% cap fixed: plain Classic then capped at 2.45
s/cell (12×12, 49 mines, par 354s) and needed a strong 3-stack to reach about
3.2 to 3.4, which is where T12 first sat at 3.25. His follow-up ("revisit
classic and see what density we can get up to") dissolved the premise: the
Classic density sweep (section 7) finds certification never breaks through
0.50 density, and under the two real caps (the 2-second generation ruling and
the 8-minute par ceiling) plain Classic reaches about 3.2 at 12×12 / 0.38 and
about 3.8 at 11×11 / 0.46. On that reach he raised the summit: **T12 = 3.60,
his stated max** ("that means all the puzzles after would be super difficult"),
with the endless zone above it unbounded. At 3.60 the 8-minute ceiling caps a
T12 board at ~133 cells, so Classic's summit lives on 11×11. The "every shape
lives at every tier" rule reads upward, and the probes say it also has a floor
direction:

### Per-shape par-per-cell reach (measured, plain boards, shipped equations)

| Shape         | Floor (gentlest proven config)   | Natural high end            | Tier range |
|---------------|----------------------------------|-----------------------------|------------|
| Classic       | ~0.5 (8×8 at 16%)                | ~3.8 plain within the 2s + 8-min caps (section 7) | T1 to T12 |
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
| 51+ | 251+   | T12+ | endless | UNBOUNDED above 3.6 s/cell (his ruling): any certified spec at or past the summit, mixed board lengths; checkpoints every 5, banked forever. |

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

### THE 2-SECOND GENERATION CAP (Christopher's ruling, 2026-08-03)

**No ladder spec ships whose measured worst-case generation exceeds 2 seconds
in this sweep's frame** (desktop Node, production attempt budget; phone
generation runs roughly 3 to 5 times slower, so the cap corresponds to a
worst-case death-retry wait of very roughly 6 to 10 seconds on a phone, with
medians far under). The cap is enforceable by measurement: the build-phase
spec validator (the `validate-parlab-battery.mjs` pattern) times every spec
and refuses any over the line. For reference, the shipped banded daily
configs already comply (worst entry 827ms, dense rhombille).

One measurement honesty note: boards are seed-deterministic but wall clock is
not. The same 98-cell stacked Octagons cell measured 2.07s worst in one run
and 1.70s in another (~±30% jitter). **His ruling on this: no margin needed.**
The cap is 2 seconds as the validator measures it, and a board that jitters
to under 3 seconds on some other run is fine. Cells written as "grazing"
below are therefore simply IN; only cells that measure over 2s are out.

### Why stacked Cubes is slow, and the better generator (profiled 2026-08-03)

Phase-timing the stacked 60-cell Cubes cell (the "relatively small board"
case): **99 to 100% of all time is base mine placement**
(`generateConstructive`, the solver-in-the-loop constructive placer), and
the dominant waste is DISCARDED BASES. The current tiling loop builds a
certified base, applies the gimmicks, and if the gimmicked board fails
certification or comes back decorative-only it throws the whole base away
and constructs a new one. Measured across six seeds each: stacked Cubes 60c
paid 97 attempts to ship 6 boards (56 certified bases discarded on
post-gimmick certification failure, 35 more on decorative-only); 72c paid
45 for 6; stacked Kites 48c paid 55 for 6. Gimmick application, the final
solve, and the load-bearing strips are ~1% combined; construction never
failed outright.

The fix is the pattern the rectangular challenge path has always used:
**re-roll the gimmicks on the SAME certified base** (challenge does up to 25
gimmick re-rolls before rebuilding a base). **BUILT AND PROVEN (PR #224,
2026-08-03, his make-sure-these-work directive)**: `generateTilingBoard` now
captures each base's mine layout and re-rolls gimmick placement on it
(`TILING_GIMMICK_REROLLS = 25`), conservative by construction (roll 0 keeps
the legacy seed string, so any board the old search shipped first-try is
byte-identical; plain generation is untouched; `gimmickRerolls: 1`
reproduces the old search and is pinned as the regression control). It also
threads `gimmickLevel` into applyGimmicks' existing intensity ramp, the
knob ladder specs need. Measured before to after, worst-case desktop:

| Stacked cell | one-roll worst | re-roll worst |
|---|---|---|
| Cubes 60c at 0.28 / 0.30 / 0.34 | 2.4s / 2.7s / 9.8s | 0.15s / 0.41s / 0.54s |
| Cubes 72c at 0.28 / 0.30 / 0.34 | 7.7s / 6.9s / 13.9s | 0.58s / 1.5s / 1.0s |
| Kites 48c at 0.30 / 0.34 | 2.7s / 7.1s | 0.12s / 1.0s |
| Kites 72c at 0.28 / 0.30 / 0.34 | 5.4s / 5.9s / 31.9s | 0.44s / 0.48s / 1.5s |
| Octagons 128c at 0.34 | 4.0s | 0.93s |

**Every stacked cell on every lattice now fits the 2-second cap**, so the
stacked frontier lists above describe the RETIRED one-roll generator and
survive only as the record of why the change exists. Downstream re-proven
with the change in place: the Par Lab battery validates 86/86, the banded
daily config calibrator proves all 40 committed entries clean with
plain-probe drift x1.00, and the full suite passes with three new
regression pins. What remains outside the cap is plain-dense only: Cubes
72c at 0.38 (3.2s) and Kites' seed-jittery plain cells above ~0.34, and no
ladder spec needs either (the proven summit table below routes around
them). The background pre-generation option stays in pocket for the endless
zone, unneeded for the authored ladder.

What the cap excluded ON THE ONE-ROLL GENERATOR (3-stack = locked+sonar+walls
at 0.28 / 0.30 / 0.34, six seeds per cell, every size), kept as the record
that motivated the re-roll change in the next subsection, which retired every
stacked exclusion below:

- **Plain boards**: only the dense extremes of two lattices, 3D Cubes 72c at
  0.38 (3.2s; 0.36 grazes at 1.9s) and Kites from ~0.34 up, seed-jittery
  (48c swings 1.0 to 2.4s, 72c crosses at 0.36). Every other plain cell on
  every lattice is comfortably under at every density through 0.38.
- **Stacked Honeycomb, Octagons, Paving Stones, Petals: essentially
  unconstrained.** All their stacked cells pass: Paving under 0.6s
  everywhere, Petals under 1.8s (grazing only at 72c/0.34), Honeycomb under
  1.8s (grazing at 110c/0.34), Octagons in through 98c/0.34 (the 1.7-to-2.1s
  jitter case) with only its 128-cell board out at 0.34 (4.0s).
- **Stacked 3D Cubes: 48 cells only.** 48c passes at every density (worst
  1.2s); 60c misses at EVERY density (2.4 to 2.7s worst even at 0.28, 9.8s
  at 0.34); 72c is far out (6.9 to 13.9s).
- **Stacked Kites: 36 cells at any density, 48 cells only sparse.** 36c
  passes everywhere (worst 0.8s); 48c passes at 0.28 (0.7s) and misses from
  0.30 (2.7s, then 7.1s); 72c is far out (5.4 to 31.9s, the sweep's worst
  single number).

Consequences for the authored blocks, REVISED after the re-roll generator
landed: the 48-cell-only constraint on stacked Cubes and the 36-to-48-cell
constraint on stacked Kites are GONE: every stacked size fits the cap now,
so block 41, block 44, the L250 crown, and the gauntlet's Cubes and Kites
entries size themselves by tier and feel rather than by generation cost.
The build validator still times every spec (the cap stays the rule; the
generator change just stopped it binding).

### The Classic density sweep ("revisit classic", same-day follow-up)

Sizes 9×9 / 11×11 / 12×12, densities 0.34 through 0.50, same instrument, plus
the per-board yield of high clue digits (median count of 6s / 7s / 8s among
certified boards):

| Size / density | 0.34 | 0.38 | 0.40 | 0.42 | 0.44 | 0.46 | 0.48 | 0.50 |
|---|---|---|---|---|---|---|---|---|
| 9×9 ppc        | 1.29 | 1.41 | 1.53 | 1.67 | 1.93 | 2.00 | 2.16 | 2.37 |
| 9×9 worst ms   | 224  | 108  | 306  | 393  | 1491 | 802  | 1797 | 943  |
| 9×9 sixes      | 0    | 1    | 0.5  | 1.5  | 1.5  | 1    | 2    | 2    |
| 11×11 ppc      | 1.83 | 2.39 | 2.52 | 3.02 | 3.39 | 3.81 | 4.44 | 4.98 |
| 11×11 worst ms | 248  | 940  | 914  | 595  | 431  | 1522 | 1640 | 5863 |
| 11×11 sixes    | 0    | 1    | 0.5  | 1    | 2    | 1.5  | 2.5  | 4.5  |
| 12×12 ppc      | 2.52 | 3.16 | 3.96 | 4.36 | 4.86 | 5.78 | 7.23 | 7.88 |
| 12×12 worst ms | 181  | 306  | 761  | 822  | 2004 | 2178 | 1191 | 6701 |
| 12×12 sixes    | 1    | 2    | 2    | 2    | 2    | 3    | 3    | 4    |

All 240 boards certified: **10/10 at every size and density through 0.50**.
No-guess certification simply does not break on the square grid in this
range. The findings:

- **The 2-second cap is the binding constraint, and it lands at about 0.44 to
  0.46 on 12×12, 0.48 on 11×11, and past 0.50 on 9×9** (smaller boards afford
  more density). The old 34% cap was three densities' worth of headroom short
  of the real wall.
- **High digits arrive with density, unevenly by value.** Sixes become
  routine from about 0.42 (medians 1.5 to 4.5 per board by 0.48); sevens stay
  rare (median 0 almost everywhere, first nonzero medians at 0.44+); **a true
  8 never appeared in 240 certified boards, and that is STRUCTURAL, not
  statistical** (his read, verified against the solver): an 8's only route is
  the mine-counter endgame, where every mine is puzzled out and the last
  remaining cell is the 8, because every neighbor of an 8-cell is a mine, so
  no revealed clue is ever adjacent to it and no local pattern can name it.
  The certifier carries NO global mine-count constraint (boardSolver has no
  totalMines term at all), so that endgame route does not exist in-engine and
  a plain board containing an 8 can never certify, at any density. The one
  theoretical exception is a gimmick whose region reaches past adjacency (a
  sonar or wormhole constraint can name the cell), which is an exotic corner,
  not a dial. Adding the global-count constraint to the certifier would be
  real solver-core work with blast radius on every certificate; not worth it
  for a novelty digit unless it earns its way in on other grounds.
- **Plain Classic now reaches T12**: 12×12 at 0.38 prices 3.16 s/cell (par
  455s, inside the 8-minute ceiling, worst generation 306ms), and 11×11 at
  0.46 prices 3.81 (par 461s, worst 1522ms). Stacks become a flavor choice at
  the summit rather than the only route. Note the extrapolation caveat at
  full strength here: the daily fit saw densities up to ~0.30, so pricing at
  0.42+ is far outside the fitted range. The certification, time, and digit
  columns are direct measurements; the ppc column above ~0.38 is the model's
  increasingly speculative guess.
- The 8-minute par ceiling still trims the top: 12×12 above ~0.38 and 11×11
  above ~0.46 price past 480s, so the densest playable Classic lives on the
  smaller sizes.

### Generation cost against the cap (after the re-roll generator)

Fast everywhere at any swept density (worst under ~0.2s desktop): Honeycomb,
Paving Stones, Petals, Octagons up to 98c (Octagons 128c reaches ~0.9s
stacked at 0.34). With the re-roll generator in, every STACKED cell on every
lattice fits the cap; what remains over the line is PLAIN-DENSE only, and no
authored spec needs those cells:

- **3D Cubes plain 72c at 0.38** (3.2s; 0.36 grazes at 1.9s, in under the
  as-measured ruling). Plain placement has no gimmick re-rolls to amortize,
  so this cell keeps its intrinsic constructive cost; its summit spec routes
  through the stacked 60-cell board instead (proven table below).
- **Kites plain above ~0.34** stays seed-jittery (48c swings 1.0 to 2.4s;
  72c crosses at 0.36), so a plain dense Kites spec gets per-spec validator
  timing rather than a density rule of thumb. Its T12 spec sits at 36 cells
  and never goes near the jitter zone.

### What the sweep changes in the plan

- **T12 at the ruled 3.60 is PROVEN on all seven shapes**
  (`scripts/prove-t12-specs.mjs`, re-runnable; requires the PR #224
  generator). Each candidate: 10 seeds, all certified, worst generation
  inside the 2-second cap, par inside the 8-minute ceiling, median
  par-per-cell in the summit band:

  | Proven T12 spec | worst gen | par | ppc |
  |---|---|---|---|
  | Classic 11×11 at 0.45, plain | 948ms | 438s | 3.62 |
  | Honeycomb 110c at 0.34, plain | 21ms | 419s | 3.81 |
  | Octagons 98c at 0.34, plain | 84ms | 359s | 3.66 |
  | Petals 72c at 0.34, plain | 77ms | 274s | 3.80 |
  | Kites 36c at 0.34, plain | 215ms | 132s | 3.67 |
  | 3D Cubes 60c at 0.38, locked+sonar+walls | 1579ms | 236s | 3.93 |
  | Paving 112c at 0.24, locked+sonar+walls at intensity level 115 | 71ms | 381s | 3.41 |

  The two former problem shapes resolved exactly as predicted: Cubes' summit
  needed the re-roll generator (its 72c stacked variant also lands the band
  at ppc 3.98 but one probe seed hit 3.5s, so the 60-cell route with 2x cap
  headroom is the proven one), and Paving's needed construction: the
  112-cell rung with the intensity ramp turned up (`gimmickLevel`, the
  ladder's own mechanism) rather than any density, which its flat density
  response predicted. These seven are EXISTENCE PROOFS the build starts
  from, not final specs; the build-phase validator re-times whatever the
  blocks actually author.
- **Paving Stones' density insensitivity is now measured at every size**: ppc
  is flat to three densities' width across its whole row (per-mine deviation
  cancels the base rate). Density is not merely a weak lever for Paving
  Stones; it is NOT a lever. Its tier boosts are size and stacks, full stop.
- **Kites' T12 window at the ruled 3.60 summit is 36 cells at 0.34 to 0.36**
  (48 cells at ~0.30 to 0.32 also lands), which conveniently also keeps its
  generation fast. Its dense extreme (72c at 0.30+ pricing 6+ s/cell) is now
  exactly the endless zone's material under the unbounded-above-3.6 ruling,
  subject to the 8-minute-ceiling flag in section 2.
- Tier-level distributions rode along: Kites 72c runs techniqueLevel 2 at
  every density (the enumeration-rich lattice); Cubes' plain sweep boards sit
  at tier 0 with its 3-stacks at tier 1 (Pass A until something forces Pass
  C); Paving's 84-cell rung runs tier 1 at every density while its smaller
  rungs stay tier 0.

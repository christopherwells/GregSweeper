// Top up the Climb library where one shape went missing.
//
//   node scripts/topup-climb-library.mjs --shape rhombille [--dry-run]
//     [--add 2] [--minutes 30] [--max-cells 96]
//
// The full build dealt shapes round-robin from a blind pool, and a shape
// whose pricing is bimodal starves in the middle: rhombille's plain boards
// top out near 193s while its heavy stacks start near 490s, so every level
// whose window sits between got nothing (131 of 191 eligible levels at the
// first audit). This script fills exactly that hole: it generates a supply
// of one- and two-modifier boards for ONE shape at the densities the gap
// calls for, then deals the hardest in-window boards to each level that
// lacks the shape. Append-only: existing boards are frozen history, the
// same contract the build's resume rule keeps.
//
// Everything that decides what a level may hold is imported from the build
// script (one copy): par floors and window tops, the hard floor, the
// candidate measurement with its own work/par floors, and the library's
// introduction schedule re-derived from the file's own block number.
//
// Debut blocks are respected from the file's `intro` field: a shape-debut
// level stays single-shape (skipped outright), and a modifier-debut level
// only takes stacks carrying the debut modifier, which is how the build
// populated those blocks in the first place.
//
// Vintage: appended boards carry stored `features`, and the reprice pass
// (`scripts/reprice-climb-library.mjs`, run by the nightly refit) re-prices
// and re-bins the whole library against the model of the day, so a top-up
// run never creates a second vintage story of its own.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import {
  parFloor, parWindowTop, hardFloor, legalPatches, candidate, OUT_DIR,
  LIB_SHAPE_INTROS, intakeRules,
} from './build-climb-library.mjs';
import { TILING_TYPES } from '../src/logic/tilingGeometry.js';
import { TILING_SAFE_GIMMICKS } from '../src/logic/tilingGenerator.js';

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const SHAPE = argVal('--shape', 'rhombille');
const DRY = args.includes('--dry-run');
const FILL = args.includes('--fill');
const ADD_PER_LEVEL = Number(argVal('--add', 2));
const BUDGET_MS = Number(argVal('--minutes', 30)) * 60000;
const MAX_CELLS = Number(argVal('--max-cells', 120));

if (!FILL && !TILING_TYPES.includes(SHAPE)) {
  console.error(`--shape must be one of ${TILING_TYPES.join(', ')} (rect never starves; it is the pool's cheapest supply)`);
  process.exit(1);
}

// Same generation bounds the build's targeted pass uses: an infeasible
// corner must cost attempts, never salts of full certification.
const GEN_BOUNDS = { genAttempts: 80, strictRetries: 1, constructive: true };
const SEEDS_PER_SPEC = 6;
const MAX_KEPT_PER_SPEC = 4;
// Same face-variety rule as the build: at most two boards of one face per
// level, counting the boards already in the file.
const FACE_CAP = 2;
const RELIEF = 0.85; // PAR_FLOOR_SHAPE_RELIEF: a starved shape may sit a
                     // little under the strict floor rather than not appear.

// ── --fill: cover the deficit manifest the reprice left behind ──────────
// His re-bin design's second half: "if there is insufficient boards after,
// more will be generated." Reads deficits.json (written by
// reprice-climb-library.mjs), generates each short level back up to its
// minimum with whatever the introduction schedule allows there, and
// rewrites the manifest with anything still owed. Deficits after a re-bin
// are small by construction (the first run left 12 levels short by 1-2
// boards each), so this is a bounded errand, not a build.
if (FILL) {
  const { minBoardsFor } = await import('./build-climb-library.mjs');
  const DEFICITS_URL = new URL('deficits.json', OUT_DIR);
  const manifest = JSON.parse(readFileSync(DEFICITS_URL, 'utf8'));
  if (!manifest.deficits.length) {
    console.log('no deficits owed');
    process.exit(0);
  }
  const t0 = Date.now();
  const perLevelMs = Math.max(90000, BUDGET_MS / manifest.deficits.length);
  const fnvF = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  };
  const allPatches = legalPatches().filter((p) => p.cells <= 110);
  let totalAdded = 0;
  for (const d of manifest.deficits) {
    const file = `level-${String(d.level).padStart(3, '0')}.json`;
    const j = JSON.parse(readFileSync(new URL(file, OUT_DIR), 'utf8'));
    const rules = intakeRules(j.level, j.intro);
    const lo = parFloor(j.level) * RELIEF, hi = parWindowTop(j.level);
    const hardMin = hardFloor(j.level);
    const need = () => Math.max(0, minBoardsFor(j.level) - j.boards.length);
    if (!need()) continue;

    // The spec grid this level may draw from: its debut rules bound the
    // shapes, its introduced modifiers bound the stacks (a mod-debut level
    // requires its debut mod in every stack, matching the build), and the
    // dial is the build's own level-derived formula.
    const shapes = rules.shapeDebut ? [rules.shapeDebut] : [...rules.shapesIn];
    const modsHere = [...rules.modsIn];
    const fillStacks = [];
    for (const a of modsHere) fillStacks.push([a]);
    for (let i = 0; i < modsHere.length; i++) {
      for (let k = i + 1; k < modsHere.length; k++) fillStacks.push([modsHere[i], modsHere[k]]);
    }
    const usable = rules.requiredMod
      ? fillStacks.filter((g) => g.includes(rules.requiredMod))
      : fillStacks;
    const grid = [];
    for (const q of allPatches.filter((p) => shapes.includes(p.shape))) {
      for (const dens of [0.16, 0.2, 0.24, 0.28]) {
        const mines = Math.round(q.cells * dens);
        if (mines < 4 || mines > q.cells * 0.42) continue;
        for (const g of usable) grid.push({ q, dens, mines, g });
      }
    }
    grid.sort((a, b) => fnvF(`${a.q.shape}:${a.q.cells}:${a.dens}:${a.g.join('.')}`)
      - fnvF(`${b.q.shape}:${b.q.cells}:${b.dens}:${b.g.join('.')}`));

    const lt0 = Date.now();
    const wanted = need();
    const faces = new Map();
    for (const b of j.boards) faces.set(b.face, (faces.get(b.face) || 0) + 1);
    const found = [];
    // Census one seed per spec; specs whose draw lands in-window get mined
    // hardest-of-6 immediately (the deficit is 1-2 boards, so depth beats
    // breadth here and there is no separate mining phase to schedule).
    for (const { q, dens, mines, g } of grid) {
      if (Date.now() - lt0 > perLevelMs || found.length >= wanted + 2) break;
      const mk = (k) => candidate(
        { shape: q.shape, rows: q.rows, cols: q.cols, M: q.M, N: q.N,
          cells: q.cells, mines, gimmicks: g,
          gimmickLevel: 40 + (j.level % 60),
          ...(q.shape === 'rect' ? {} : GEN_BOUNDS) },
        `climbfill:L${j.level}:${q.shape}:${q.cells}c:${dens}:${g.join('.')}:${k}`);
      const c0 = mk(0);
      if (!c0 || c0.par < lo || c0.par > hi) continue;
      const mined = [c0];
      for (let k = 1; k < 6; k++) {
        if (Date.now() - lt0 > perLevelMs) break;
        const c = mk(k);
        if (c && c.par >= lo && c.par <= hi) mined.push(c);
      }
      mined.sort((a, b) => b.hard - a.hard);
      found.push(mined[0]);
    }
    found.sort((a, b) => b.hard - a.hard);
    const takes = [];
    // Floor-meeting boards first; soft ones only to close a hole the
    // supply could not fill properly (same two-tier rule as the deal).
    for (const pass of [(c) => c.hard >= hardMin, () => true]) {
      for (const c of found) {
        if (takes.length >= wanted) break;
        if (takes.includes(c) || !pass(c)) continue;
        if ((faces.get(c.face) || 0) >= FACE_CAP) continue;
        faces.set(c.face, (faces.get(c.face) || 0) + 1);
        takes.push(c);
      }
    }
    if (takes.length && !DRY) {
      for (const c of takes) {
        const { used, ...board } = c;
        j.boards.push(board);
      }
      writeFileSync(new URL(file, OUT_DIR), JSON.stringify(j));
    }
    totalAdded += takes.length;
    console.log(`L${j.level} +${takes.length}/${d.need - d.have}`
      + ` (${takes.map((c) => `${c.spec.shape} ${Math.round(c.par)}s/h${c.hard}`).join(', ') || 'nothing found'})`
      + ` in ${Math.round((Date.now() - lt0) / 1000)}s`);
  }
  // Re-derive what is still owed, so the manifest never claims a debt that
  // was just paid or hides one that was not.
  const remaining = [];
  for (const d of manifest.deficits) {
    const file = `level-${String(d.level).padStart(3, '0')}.json`;
    const j = JSON.parse(readFileSync(new URL(file, OUT_DIR), 'utf8'));
    if (j.boards.length < minBoardsFor(j.level)) {
      remaining.push({ level: j.level, have: j.boards.length, need: minBoardsFor(j.level) });
    }
  }
  if (!DRY) writeFileSync(DEFICITS_URL, JSON.stringify({ parModel: manifest.parModel, deficits: remaining }));
  console.log(`\n${DRY ? '[dry-run] ' : ''}filled ${totalAdded} boards in ${Math.round((Date.now() - t0) / 1000)}s;`
    + ` ${remaining.length} levels still owed`);
  process.exit(0);
}

// The gap's densities. The commissioned probe is 0.24-0.26; 0.28 joins it
// because the upper windows (floor 300s+) need the extra rate and it is the
// proven density cap for the dear shapes (REP_DENSITY_CAP in the build).
const DENSITIES = [0.24, 0.26, 0.28];

// ── 1. Which levels lack the shape, and what may go there ──────────────
// Legality comes from the build script's own intakeRules (one copy): a
// shape-debut level of another lattice is skipped outright, a
// modifier-debut level takes the shape only inside a stack carrying its
// debut modifier.
const files = readdirSync(OUT_DIR).filter((f) => f.endsWith('.json')).sort();
const shapeIntroBlock = Number(Object.entries(LIB_SHAPE_INTROS)
  .find(([, sh]) => sh === SHAPE)[0]);

const targets = [];
for (const f of files) {
  const j = JSON.parse(readFileSync(new URL(f, OUT_DIR), 'utf8'));
  const rules = intakeRules(j.level, j.intro);
  if (rules.block < shapeIntroBlock) continue;
  if (j.boards.some((b) => b.spec.shape === SHAPE)) continue;
  if (rules.shapeDebut && rules.shapeDebut !== SHAPE) continue;
  targets.push({
    file: f, level: j.level, block: rules.block, json: j,
    floor: parFloor(j.level), top: parWindowTop(j.level), hardMin: hardFloor(j.level),
    requiredMod: rules.requiredMod,
    modsIn: rules.modsIn,
  });
}
console.log(`${SHAPE}: ${targets.length} levels lack it (L${targets[0]?.level}..L${targets.at(-1)?.level});`
  + ` windows ${Math.round(targets[0]?.floor ?? 0)}s..${Math.round(targets.at(-1)?.top ?? 0)}s`);
if (!targets.length) process.exit(0);

// ── 2. The supply: one-, two- and three-modifier stacks ────────────────
// The first dry-run swept patch-major and spent its whole budget on the
// smallest patch, whose boards price 121-136s against a lowest window of
// 164s: eleven boards, none usable. Two changes from that lesson. Trios
// join the stacks, because the upper windows (to 710s) sit past what a
// pair on 96 cells can price. And the spec list is SHUFFLED (seeded, so
// reruns walk the same order) before the budget applies, so a budget cut
// lands uniformly across patch sizes instead of on whichever region the
// loop order left for last.
const mods = TILING_SAFE_GIMMICKS.slice();
const stacks = [];
for (const a of mods) stacks.push([a]);
for (let i = 0; i < mods.length; i++) {
  for (let k = i + 1; k < mods.length; k++) stacks.push([mods[i], mods[k]]);
}
for (let i = 0; i < mods.length; i++) {
  for (let k = i + 1; k < mods.length; k++) {
    for (let m = k + 1; m < mods.length; m++) {
      // Every third triple: spread coverage without tripling the space.
      if ((i + k + m) % 3 === 0) stacks.push([mods[i], mods[k], mods[m]]);
    }
  }
}
const patches = legalPatches().filter((p) => p.shape === SHAPE && p.cells <= MAX_CELLS);

const specs = [];
for (const q of patches) {
  for (const dens of DENSITIES) {
    const mines = Math.round(q.cells * dens);
    if (mines < 4 || mines > q.cells * 0.42) continue;
    for (const g of stacks) specs.push({ q, dens, mines, g });
  }
}
const fnv = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
};
specs.sort((a, b) => fnv(`${a.q.cells}:${a.dens}:${a.g.join('.')}`) - fnv(`${b.q.cells}:${b.dens}:${b.g.join('.')}`));
console.log(`supply space: ${patches.length} patches x ${DENSITIES.length} densities x ${stacks.length} stacks`
  + ` = ${specs.length} specs, ${BUDGET_MS / 60000} minute budget`);

// The second dry-run's lesson: keeping the first draws that certify deals
// SOFT boards (h0-h5 against hard floors 6-11), because within one spec the
// hardness spread runs 4-11x and one draw samples its bottom as often as
// its top. Selection is the difficulty lever here exactly as in the main
// build, so the budget splits into a CENSUS (one draw per spec, walking the
// shuffled order: cheap map of where each spec prices and what it costs)
// and a MINE (the rest of the budget re-drawing the specs whose census
// landed inside a needed window, hardest-of-N per spec kept).
const t0 = Date.now();
const supply = [];
let drawn = 0;
const draw = (q, dens, mines, g, k) => {
  drawn++;
  if (drawn % 250 === 0) {
    console.log(`  ...${drawn} draws, ${supply.length} kept, ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  return candidate(
    { shape: q.shape, rows: q.rows, cols: q.cols, M: q.M, N: q.N,
      cells: q.cells, mines, gimmicks: g, gimmickLevel: 110, ...GEN_BOUNDS },
    `climbtopup:${SHAPE}:${q.cells}c:${dens}:${g.join('.')}:${k}`);
};

// The windows that need supply, as [lo, hi] par ranges.
const windows = targets.map((t) => [t.floor * RELIEF, t.top]);
const inAnyWindow = (par) => windows.some(([lo, hi]) => par >= lo && par <= hi);

// Census: one seed per spec until 40% of the budget is gone. A spec whose
// single draw certifies and prices inside some window graduates to mining.
const CENSUS_SHARE = 0.4;
const productive = [];
let censused = 0;
for (const s of specs) {
  if (Date.now() - t0 > BUDGET_MS * CENSUS_SHARE) break;
  censused++;
  const c = draw(s.q, s.dens, s.mines, s.g, 0);
  if (!c) continue;
  supply.push(c);
  if (inAnyWindow(c.par)) productive.push({ ...s, censusPar: c.par, censusHard: c.hard });
}
console.log(`census: ${censused}/${specs.length} specs in ${Math.round((Date.now() - t0) / 1000)}s;`
  + ` ${productive.length} price inside a needed window`);

// Mine: hardest-first evidence, widest par spread first, so the budget goes
// to specs that can serve the emptiest bands before piling onto one region.
productive.sort((a, b) => b.censusHard - a.censusHard || b.censusPar - a.censusPar);
const MINE_SEEDS = 9;
outer:
for (const s of productive) {
  const mined = [];
  for (let k = 1; k <= MINE_SEEDS; k++) {
    if (Date.now() - t0 > BUDGET_MS) {
      console.log(`budget spent after ${drawn} draws; dealing what we have`);
      break outer;
    }
    const c = draw(s.q, s.dens, s.mines, s.g, k);
    if (c && inAnyWindow(c.par)) mined.push(c);
  }
  // Keep the hardest two of this spec's mined draws; the census draw is
  // already in the supply, so a spec contributes at most three boards.
  mined.sort((a, b) => b.hard - a.hard);
  supply.push(...mined.slice(0, 2));
}
supply.sort((a, b) => b.hard - a.hard);
console.log(`supply: ${supply.length} boards from ${drawn} draws in ${Math.round((Date.now() - t0) / 1000)}s;`
  + ` par ${Math.round(Math.min(...supply.map((s) => s.par)))}..${Math.round(Math.max(...supply.map((s) => s.par)))}s;`
  + ` hard p50 ${supply.map((s) => s.hard).sort((a, b) => a - b)[supply.length >> 1]}`
  + ` max ${Math.max(...supply.map((s) => s.hard))}`);

// ── 3. Deal hardest-first into each level's window ─────────────────────
let filled = 0, boardsAdded = 0;
const holes = [];
for (const t of targets) {
  const faces = new Map();
  for (const b of t.json.boards) faces.set(b.face, (faces.get(b.face) || 0) + 1);
  const eligible = (c) => !c.used
    && c.par >= t.floor * RELIEF && c.par <= t.top
    && (!t.requiredMod || c.spec.gimmicks.includes(t.requiredMod))
    && c.spec.gimmicks.every((g) => t.modsIn.has(g))
    && (faces.get(c.face) || 0) < FACE_CAP;
  const takes = [];
  const take = (c) => {
    c.used = true;
    faces.set(c.face, (faces.get(c.face) || 0) + 1);
    takes.push(c);
  };
  // Two tiers: boards meeting the level's hard floor fill first (the supply
  // is sorted hardest-first, so these are the hardest that fit the window).
  // A soft board is dealt ONLY when the level would otherwise stay empty;
  // the shape's presence was the commissioned goal, and one soft board
  // beats a hole, but padding a level with soft seconds does not.
  for (const c of supply) {
    if (takes.length >= ADD_PER_LEVEL) break;
    if (eligible(c) && c.hard >= t.hardMin) take(c);
  }
  if (!takes.length) {
    const soft = supply.find(eligible);
    if (soft) take(soft);
  }
  if (!takes.length) { holes.push(t.level); continue; }
  filled++;
  boardsAdded += takes.length;
  const meetHard = takes.filter((c) => c.hard >= t.hardMin).length;
  console.log(`L${t.level} +${takes.length} (${takes.map((c) => `${Math.round(c.par)}s/h${c.hard}`).join(', ')})`
    + `${meetHard < takes.length ? ` [${takes.length - meetHard} under hard floor ${t.hardMin}]` : ''}`);
  if (!DRY) {
    for (const c of takes) {
      const { used, ...board } = c;
      t.json.boards.push(board);
    }
    writeFileSync(new URL(t.file, OUT_DIR), JSON.stringify(t.json));
  }
}
console.log(`\n${DRY ? '[dry-run] ' : ''}filled ${filled}/${targets.length} levels with ${boardsAdded} boards;`
  + ` ${supply.filter((s) => !s.used).length} supply boards unused`);
if (holes.length) {
  console.log(`still empty: ${holes.length} levels (${holes.slice(0, 12).join(', ')}${holes.length > 12 ? ', ...' : ''})`);
}

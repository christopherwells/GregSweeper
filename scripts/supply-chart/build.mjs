#!/usr/bin/env node
/**
 * Build the Challenge board-supply chart.
 *
 * Reads the two committed libraries and emits a standalone HTML page: one
 * panel per density x length band, rows are shapes, columns are modifiers.
 *
 * The chart is published as an artifact rather than served by the app, so
 * this script exists to make it REPRODUCIBLE: the prose lives in
 * template.html and is edited by hand, while every number here is derived
 * from the libraries at HEAD.
 *
 * Two counting modes ship in the same page, because the deal's modifier
 * filter is a SUBSET test and the two answers differ:
 *
 *   pooled  a board counts once for each modifier it carries, so the cell
 *           is what a host who permits everything can draw.
 *   narrow  plain boards plus single-modifier boards, so the cell is what a
 *           host who permits exactly that one modifier can draw. This is the
 *           floor under every wider choice, and it is the honest number:
 *           measured 2026-08-15, 34 cells read non-empty pooled and EMPTY
 *           narrow, meaning the library holds only multi-modifier boards
 *           there and a focused host gets nothing back.
 *
 *   node scripts/supply-chart/build.mjs [--out <path>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timeBandOf, densityBandOf } from '../../src/logic/matchRules.js';
import { matchPageNames } from '../match-index-files.mjs';
import { cornerTotalTarget } from '../topup-match-library.mjs';
import { matchRowKey } from '../../src/logic/matchCodes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MATCH_DIR = path.join(ROOT, 'scripts', 'data', 'match-library');
const CLIMB_DIR = path.join(ROOT, 'scripts', 'data', 'climb-library');

/**
 * Cells the probes measured CLOSED at the legal ceiling (2026-08-16), keyed
 * shape|time|density, valued with the best par any phone-legal configuration
 * reached against the band's own bound. A closed cell is EXPECTED empty:
 * hatched on the grid, never red, never on the attention list. Re-probe
 * before moving one out (probe-hard-cells / probe-v3 in the session notes);
 * rhombille's standard cells are deliberately NOT here, they sit one second
 * under the line at pool sizes and the nightly's synthesized dims will
 * settle them.
 */
const CLOSED_CELLS = new Map([
  ['hex|short|sparse', 99], ['hex|long|sparse', 99],
  ['4.8.8|long|sparse', 128], ['rect|long|sparse', 174],
  ['rhombille|short|sparse', 51], ['rhombille|long|sparse', 51],
]);

const DB_BASE = 'https://gregsweeper-66d02-default-rtdb.firebaseio.com';

/**
 * Which boards anyone has finished, keyed the way match fit rows are keyed.
 * Fails SOFT with a warning: without it every board reads unplayed, so the
 * corner targets sit at their floors and the header's played stat says so
 * instead of quietly repeating a stale number (the old build hardcoded 81).
 */
async function fetchPlayed() {
  try {
    const r = await fetch(`${DB_BASE}/dailyMeta.json?shallow=true`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const keys = Object.keys((await r.json()) || {});
    return { set: new Set(keys.filter((k) => k.startsWith('match_'))), ok: true };
  } catch (err) {
    console.log(`  WARNING: played set unavailable (${err.message}); targets use played = 0`);
    return { set: new Set(), ok: false };
  }
}

/** Row order and player-facing names (TILING_LABELS, plus Classic for rect). */
const SHAPES = [
  ['rect', 'Classic'], ['hex', 'Honeycomb'], ['4.8.8', 'Octagons'],
  ['cairo', 'Paving Stones'], ['floret', 'Petals'], ['rhombille', '3D Cubes'],
  ['deltoidal', 'Kites'],
];

/** Column order. `(plain)` is boards carrying no modifier at all. */
const MODS = [
  ['(plain)', 'None'], ['walls', 'Walls'], ['mystery', 'Mystery'],
  ['locked', 'Locked'], ['liar', 'Liar'], ['sonar', 'Sonar'],
  ['compass', 'Compass'], ['wormhole', 'Wormhole'], ['mirror', 'Mirror'],
  ['worm', 'Worm'],
];

const DENS = [['sparse', 'Sparse'], ['standard', 'Standard'], ['dense', 'Packed']];
const TIMES = [['quick', 'Quick'], ['short', 'Standard'], ['long', 'Long']];

const argVal = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

/**
 * Every board in both libraries as {lib, shape, mods, density, time}.
 * `lib` is 'm' for the match library and 'c' for the Climb's, which the
 * page's first toggle switches between: a Climb play does not spend a board
 * for Challenge, so its boards count as unplayed supply here.
 */
function readBoards() {
  const rows = [];
  for (const file of matchPageNames()) {
    const page = JSON.parse(fs.readFileSync(path.join(MATCH_DIR, file), 'utf8'));
    for (const b of page.boards) {
      if (!b || b.evicted) continue;   // a tombstone is not supply
      rows.push({
        lib: 'm', shape: b.spec.shape, seed: b.seed,
        mods: (b.spec.gimmicks || []).slice().sort(),
        density: densityBandOf(b.spec.mines, b.spec.cells),
        time: timeBandOf(b.par),
      });
    }
  }
  const climbFiles = fs.readdirSync(CLIMB_DIR)
    .filter((f) => /^(level-\d+|endless-\d+)\.json$/.test(f));
  for (const file of climbFiles) {
    const page = JSON.parse(fs.readFileSync(path.join(CLIMB_DIR, file), 'utf8'));
    for (const b of page.boards || []) {
      const spec = b.spec || {};
      if (!spec.shape) continue;
      rows.push({
        lib: 'c', shape: spec.shape,
        mods: (spec.gimmicks || []).slice().sort(),
        density: densityBandOf(spec.mines, spec.cells),
        time: timeBandOf(b.par),
      });
    }
  }
  return rows;
}

/**
 * One record per (shape, modifier, density, length) cell carrying both
 * counting modes for both libraries: m/c pooled, nm/nc narrow.
 */
export function buildCells(rows) {
  const cells = new Map();
  const at = (key) => {
    if (!cells.has(key)) cells.set(key, { m: 0, c: 0, nm: 0, nc: 0 });
    return cells.get(key);
  };
  const cellKey = (shape, mod, density, time) => [shape, mod, density, time].join('|');

  for (const r of rows) {
    if (!r.mods.length) {
      // A plain board is its own column, and it is also the base every
      // narrow count rests on: a host permitting one modifier still draws it.
      const own = at(cellKey(r.shape, '(plain)', r.density, r.time));
      own[r.lib] += 1;
      own[r.lib === 'm' ? 'nm' : 'nc'] += 1;
      for (const [mod] of MODS) {
        if (mod === '(plain)') continue;
        const cell = at(cellKey(r.shape, mod, r.density, r.time));
        cell[r.lib === 'm' ? 'nm' : 'nc'] += 1;
      }
      continue;
    }
    for (const mod of r.mods) {
      const cell = at(cellKey(r.shape, mod, r.density, r.time));
      cell[r.lib] += 1;
      // Narrow counts a modified board only when that modifier is the ONLY
      // one on it; anything else needs a host who permitted more.
      if (r.mods.length === 1) cell[r.lib === 'm' ? 'nm' : 'nc'] += 1;
    }
  }
  return cells;
}

/**
 * Per-cell TARGETS per counting mode, derived from the match library's own
 * corners under the arity ruling: a cell's pooled target is the sum of
 * cornerTotalTarget(played, arity) over the existing corners its pooled
 * count draws from, and its narrow target sums only the plain and
 * single-modifier corners, exactly mirroring how buildCells counts boards.
 * Only corners that EXIST contribute (empty is not thin, and most empty
 * corners are physics); the Climb's boards count as supply against the same
 * match-side bar.
 */
export function buildTargets(rows, played) {
  const corners = new Map();
  for (const r of rows) {
    if (r.lib !== 'm') continue;
    const key = [r.shape, r.mods.join('+'), r.time, r.density].join('|');
    const c = corners.get(key) || { played: 0, arity: r.mods.length };
    if (played.has(matchRowKey(r.seed))) c.played++;
    corners.set(key, c);
  }
  const tgt = new Map();
  const bump = (cellKey, which, v) => {
    const t = tgt.get(cellKey) || { p: 0, n: 0 };
    t[which] += v;
    tgt.set(cellKey, t);
  };
  for (const [key, c] of corners) {
    const [shape, mods, time, density] = key.split('|');
    const target = cornerTotalTarget(c.played, c.arity);
    const list = mods ? mods.split('+') : [];
    if (!list.length) {
      bump([shape, '(plain)', density, time].join('|'), 'p', target);
      bump([shape, '(plain)', density, time].join('|'), 'n', target);
      for (const [mod] of MODS) {
        if (mod !== '(plain)') bump([shape, mod, density, time].join('|'), 'n', target);
      }
    } else {
      for (const mod of list) {
        bump([shape, mod, density, time].join('|'), 'p', target);
        if (list.length === 1) bump([shape, mod, density, time].join('|'), 'n', target);
      }
    }
  }
  return tgt;
}

/**
 * The four per-mode states of one cell, in toggle order (match/pooled,
 * both/pooled, match/narrow, both/narrow): full, near (>= half), low,
 * hole (a focused host draws nothing while stacked boards exist), closed
 * (the probes measured the whole cell out of reach), none (nothing exists
 * and nothing is owed).
 */
export function cellStates(cellKey, v, t) {
  const [shape, , density, time] = cellKey.split('|');
  const closed = CLOSED_CELLS.has([shape, time, density].join('|'));
  const counts = [v.m, v.m + v.c, v.nm, v.nm + v.nc];
  const pooled = [v.m, v.m + v.c, v.m, v.m + v.c];
  const targets = [t.p, t.p, t.n, t.n];
  return counts.map((n, i) => {
    if (closed && n === 0) return 'closed';
    if (targets[i] === 0) {
      if (n > 0) return 'full';
      return i >= 2 && pooled[i] > 0 ? 'hole' : 'none';
    }
    if (n === 0) return 'hole';
    if (n >= targets[i]) return 'full';
    return n >= targets[i] * 0.5 ? 'near' : 'low';
  });
}

/**
 * The four toggle states, in the order the page's data-v attributes use.
 * Walks the FULL grid rather than the occupied cells, because the closed
 * cells are empty by definition and a stat computed over occupancy alone
 * would count them nowhere (the vacuity class, in miniature).
 */
export function statsFor(cells, targets) {
  const modes = [0, 1, 2, 3].map(() => ({ full: 0, under: 0, hole: 0, closed: 0, none: 0 }));
  for (const [sk] of SHAPES) {
    for (const [mk] of MODS) {
      for (const [dk] of DENS) {
        for (const [tk] of TIMES) {
          const key = [sk, mk, dk, tk].join('|');
          const v = cells.get(key) || { m: 0, c: 0, nm: 0, nc: 0 };
          const t = targets.get(key) || { p: 0, n: 0 };
          cellStates(key, v, t).forEach((s, i) => {
            if (s === 'near' || s === 'low') modes[i].under++;
            else modes[i][s]++;
          });
        }
      }
    }
  }
  return modes;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const commas = (n) => n.toLocaleString('en-US');

function renderPanels(cells, targets) {
  let out = '';
  for (const [dk, dl] of DENS) {
    for (const [tk, tl] of TIMES) {
      out += `<section class="panel"><h3><span class="d">${dl}</span>`
        + `<span class="sep">/</span><span class="t">${tl}</span>`
        + '<span class="verdict"></span></h3>'
        + '<div class="scroll"><table><thead><tr><th class="corner"></th>';
      for (const [, ml] of MODS) out += `<th class="gh"><span>${ml}</span></th>`;
      out += '</tr></thead><tbody>';
      for (const [sk, sl] of SHAPES) {
        out += `<tr><th scope="row">${sl}</th>`;
        for (const [mk, ml] of MODS) {
          const key = [sk, mk, dk, tk].join('|');
          const v = cells.get(key) || { m: 0, c: 0, nm: 0, nc: 0 };
          const t = targets.get(key) || { p: 0, n: 0 };
          const states = cellStates(key, v, t);
          const closedAt = CLOSED_CELLS.get([sk, tk, dk].join('|'));
          const title = (mk === '(plain)'
            ? `${sl} / no modifiers — match ${v.m}, climb ${v.c}, combined ${v.m + v.c}`
            : `${sl} / ${ml} — any set containing it: match ${v.m}, climb ${v.c},`
              + ` combined ${v.m + v.c} · only this modifier: match ${v.nm},`
              + ` climb ${v.nc}, combined ${v.nm + v.nc}`)
            + ` · target pooled ${t.p}, narrow ${t.n}`
            + (closedAt ? ` · measured closed: best legal config reaches ${closedAt}s` : '');
          out += `<td class="c" data-m="${v.m}" data-c="${v.c}" data-nm="${v.nm}"`
            + ` data-nc="${v.nc}" data-t="${t.p}|${t.p}|${t.n}|${t.n}"`
            + ` data-f="${states.join('|')}"`
            + ` data-lbl="${esc(`${sl} · ${mk === '(plain)' ? 'no modifiers' : ml} · ${dl} ${tl}`)}"`
            + ` title="${esc(title)}"></td>`;
        }
        out += '</tr>';
      }
      out += '</tbody></table></div></section>';
    }
  }
  return out;
}

function renderStats(rows, stats, playedCount) {
  const nMatch = rows.filter((r) => r.lib === 'm').length;
  const both = rows.length;
  // Library size does not change with the counting mode, so its two values
  // simply repeat across the narrow half of the toggle.
  const size = [nMatch, both, nMatch, both].map(commas).join('|');
  const label = ['boards in the match library', 'boards across both libraries'];
  const four = (pick) => stats.map(pick).join('|');
  return '<div class="stats">'
    + `<div class="stat"><b data-v="${size}">${commas(both)}</b>`
    + `<span data-v="${[label[0], label[1], label[0], label[1]].join('|')}">${label[1]}</span></div>`
    + `<div class="stat"><b>${commas(playedCount)}</b><span>boards played by anyone</span></div>`
    + `<div class="stat ok"><b data-v="${four((s) => s.full)}">${stats[1].full}</b>`
    + '<span>cells at their own target</span></div>'
    + `<div class="stat bad"><b data-v="${four((s) => s.under)}">${stats[1].under}</b>`
    + '<span>under target</span></div>'
    + `<div class="stat bad"><b data-v="${four((s) => s.hole)}">${stats[1].hole}</b>`
    + '<span>holes a focused host feels</span></div>'
    + `<div class="stat"><b data-v="${four((s) => s.closed)}">${stats[1].closed}</b>`
    + '<span>closed by measurement</span></div>'
    + '</div>';
}

async function main() {
  const rows = readBoards();
  const played = await fetchPlayed();
  const cells = buildCells(rows);
  const targets = buildTargets(rows, played.set);
  const stats = statsFor(cells, targets);
  const matchSeeds = new Set(rows.filter((r) => r.lib === 'm').map((r) => matchRowKey(r.seed)));
  const playedCount = [...played.set].filter((k) => matchSeeds.has(k)).length;
  const template = fs.readFileSync(path.join(HERE, 'template.html'), 'utf8');
  const page = template
    .replace('<!--STATS-->', renderStats(rows, stats, playedCount))
    .replace('<!--PANELS-->', renderPanels(cells, targets));
  const out = argVal('--out', path.join(HERE, 'supply.html'));
  fs.writeFileSync(out, page);

  const nMatch = rows.filter((r) => r.lib === 'm').length;
  console.log(`${commas(nMatch)} match + ${commas(rows.length - nMatch)} climb`
    + ` = ${commas(rows.length)} boards, ${cells.size} occupied cells, ${playedCount} played`);
  const names = ['match/pooled', 'both/pooled', 'match/narrow', 'both/narrow'];
  stats.forEach((s, i) => console.log(
    `  ${names[i].padEnd(13)} full ${s.full}, under ${s.under}, holes ${s.hole},`
    + ` closed ${s.closed}, none ${s.none}`));
  console.log(`wrote ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => { console.error('supply-chart build failed:', err.message); process.exit(1); });
}

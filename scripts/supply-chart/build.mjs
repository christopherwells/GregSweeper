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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MATCH_DIR = path.join(ROOT, 'scripts', 'data', 'match-library');
const CLIMB_DIR = path.join(ROOT, 'scripts', 'data', 'climb-library');

/** Target depth per cell, his ruling: 20 unplayed boards. */
const TARGET = 20;

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
      rows.push({
        lib: 'm', shape: b.spec.shape,
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

/** The four toggle states, in the order the page's data-v attributes use. */
export function statsFor(cells) {
  const all = [...cells.values()];
  const views = [
    (v) => v.m, (v) => v.m + v.c, (v) => v.nm, (v) => v.nm + v.nc,
  ];
  return views.map((n) => ({
    at: all.filter((v) => n(v) >= TARGET).length,
    thin: all.filter((v) => n(v) > 0 && n(v) < TARGET).length,
    zero: all.filter((v) => n(v) === 0).length,
  }));
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const commas = (n) => n.toLocaleString('en-US');

function renderPanels(cells) {
  let out = '';
  for (const [dk, dl] of DENS) {
    for (const [tk, tl] of TIMES) {
      out += `<section class="panel"><h3><span class="d">${dl}</span>`
        + `<span class="sep">/</span><span class="t">${tl}</span></h3>`
        + '<div class="scroll"><table><thead><tr><th class="corner"></th>';
      for (const [, ml] of MODS) out += `<th class="gh"><span>${ml}</span></th>`;
      out += '</tr></thead><tbody>';
      for (const [sk, sl] of SHAPES) {
        out += `<tr><th scope="row">${sl}</th>`;
        for (const [mk, ml] of MODS) {
          const v = cells.get([sk, mk, dk, tk].join('|')) || { m: 0, c: 0, nm: 0, nc: 0 };
          const title = mk === '(plain)'
            ? `${sl} / no modifiers — match ${v.m}, climb ${v.c}, combined ${v.m + v.c}`
            : `${sl} / ${ml} — any set containing it: match ${v.m}, climb ${v.c},`
              + ` combined ${v.m + v.c} · only this modifier: match ${v.nm},`
              + ` climb ${v.nc}, combined ${v.nm + v.nc}`;
          out += `<td class="c" data-m="${v.m}" data-c="${v.c}" data-nm="${v.nm}"`
            + ` data-nc="${v.nc}" title="${esc(title)}"></td>`;
        }
        out += '</tr>';
      }
      out += '</tbody></table></div></section>';
    }
  }
  return out;
}

function renderStats(rows, stats) {
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
    + '<div class="stat"><b>81</b><span>played by anyone</span></div>'
    + `<div class="stat ok"><b data-v="${four((s) => s.at)}">${stats[1].at}</b>`
    + `<span>cells at ${TARGET} or more</span></div>`
    + `<div class="stat bad"><b data-v="${four((s) => s.thin)}">${stats[1].thin}</b>`
    + '<span>occupied but thin</span></div>'
    + `<div class="stat bad"><b data-v="${four((s) => s.zero)}">${stats[1].zero}</b>`
    + '<span>cells with nothing at all</span></div>'
    + '</div>';
}

function main() {
  const rows = readBoards();
  const cells = buildCells(rows);
  const stats = statsFor(cells);
  const template = fs.readFileSync(path.join(HERE, 'template.html'), 'utf8');
  const page = template
    .replace('<!--STATS-->', renderStats(rows, stats))
    .replace('<!--PANELS-->', renderPanels(cells));
  const out = argVal('--out', path.join(HERE, 'supply.html'));
  fs.writeFileSync(out, page);

  const nMatch = rows.filter((r) => r.lib === 'm').length;
  console.log(`${commas(nMatch)} match + ${commas(rows.length - nMatch)} climb`
    + ` = ${commas(rows.length)} boards, ${cells.size} occupied cells`);
  const names = ['match/pooled', 'both/pooled', 'match/narrow', 'both/narrow'];
  stats.forEach((s, i) => console.log(
    `  ${names[i].padEnd(13)} at target ${s.at}, thin ${s.thin}, empty ${s.zero}`));
  console.log(`wrote ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}

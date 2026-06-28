// Generator for the blueprint theme's architectural floor-plan backdrop.
// Emits a genuine top-view apartment plan (hatched walls, doors with swing
// arcs, furniture symbols, perimeter dimension lines) as an SVG, in two
// flavors: a dim board version (no dimension text, fills the board, lands in
// --bg-fog-art) and a title version (with dimension lines, tiles down the
// sheet, lands in --theme-backdrop). Run:
//   node scripts/gen-blueprint-plan.mjs
// Prints the two CSS-ready url("...") data-URIs (paste into blueprint.css) and
// writes scripts/_blueprint-preview.html (untracked; open to eyeball). Only
// the data-URIs ship — this tool is kept so the plan stays editable instead of
// hand-editing 9 KB of encoded path data.
import { writeFileSync } from 'node:fs';

const INK = '#dceeff';

// ── geometry helpers ──────────────────────────────────────────────
const P = (n) => Math.round(n * 10) / 10;

// A hatched wall band (a filled rect with 45° hatch + crisp outline) — the
// classic architectural wall. `segs` lets a wall carry door gaps.
function wallRect(x, y, w, h, op) {
  return `<rect x='${P(x)}' y='${P(y)}' width='${P(w)}' height='${P(h)}' fill='url(%23bpHatch)' stroke='${INK}' stroke-width='1' opacity='${op}'/>`;
}

// A door: a gap is assumed already left in the wall; draw the leaf + swing arc.
// (hx,hy) hinge, leaf length L, swept from angle a0 to a1 (degrees).
function door(hx, hy, L, a0, a1, op) {
  const r = (d) => (d * Math.PI) / 180;
  const x0 = hx + L * Math.cos(r(a0)), y0 = hy + L * Math.sin(r(a0));
  const x1 = hx + L * Math.cos(r(a1)), y1 = hy + L * Math.sin(r(a1));
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return (
    `<path d='M${P(hx)} ${P(hy)} L${P(x0)} ${P(y0)}' stroke='${INK}' stroke-width='1.2' fill='none' opacity='${op}'/>` +
    `<path d='M${P(x0)} ${P(y0)} A${P(L)} ${P(L)} 0 ${large} ${sweep} ${P(x1)} ${P(y1)}' stroke='${INK}' stroke-width='0.8' fill='none' opacity='${op * 0.8}' stroke-dasharray='3 3'/>`
  );
}

function rect(x, y, w, h, op, sw = 1, rx = 0) {
  return `<rect x='${P(x)}' y='${P(y)}' width='${P(w)}' height='${P(h)}' rx='${rx}' fill='none' stroke='${INK}' stroke-width='${sw}' opacity='${op}'/>`;
}
function line(x1, y1, x2, y2, op, sw = 1, dash = '') {
  return `<path d='M${P(x1)} ${P(y1)} L${P(x2)} ${P(y2)}' stroke='${INK}' stroke-width='${sw}' fill='none' opacity='${op}'${dash ? ` stroke-dasharray='${dash}'` : ''}/>`;
}
function circle(cx, cy, r, op, sw = 1) {
  return `<circle cx='${P(cx)}' cy='${P(cy)}' r='${P(r)}' fill='none' stroke='${INK}' stroke-width='${sw}' opacity='${op}'/>`;
}
function ellipse(cx, cy, rx, ry, op, sw = 1) {
  return `<ellipse cx='${P(cx)}' cy='${P(cy)}' rx='${P(rx)}' ry='${P(ry)}' fill='none' stroke='${INK}' stroke-width='${sw}' opacity='${op}'/>`;
}

// ── furniture symbols (top view) ──────────────────────────────────
function bed(x, y, w, h, op) {
  // frame, mattress inset, two pillows along the head (left edge), duvet fold
  let s = rect(x, y, w, h, op, 1.4);
  s += rect(x + 3, y + 3, w - 6, h - 6, op * 0.7, 0.8); // mattress
  s += rect(x + 5, y + 5, 16, h / 2 - 7, op * 0.8, 0.8); // pillow 1
  s += rect(x + 5, y + h / 2 + 2, 16, h / 2 - 7, op * 0.8, 0.8); // pillow 2
  s += line(x + 26, y + 4, x + 26, y + h - 4, op * 0.6, 0.7); // duvet edge
  return s;
}
function sofa(x, y, w, h, op) {
  // back along the top, seat, 3 cushion divisions, arms
  let s = rect(x, y, w, h, op, 1.4, 3);
  s += line(x, y + 9, x + w, y + 9, op * 0.7, 0.8); // back rail
  s += line(x + w / 3, y + 9, x + w / 3, y + h, op * 0.6, 0.7);
  s += line(x + (2 * w) / 3, y + 9, x + (2 * w) / 3, y + h, op * 0.6, 0.7);
  return s;
}
function armchair(x, y, s, op) {
  let g = rect(x, y, s, s, op, 1.2, 3);
  g += line(x, y + 7, x + s, y + 7, op * 0.6, 0.7);
  return g;
}
function diningTable(cx, cy, w, h, op) {
  // oval table + chairs around (2 per long side, 1 per short side)
  let g = ellipse(cx, cy, w / 2, h / 2, op, 1.4);
  const chair = (x, y) => rect(x - 7, y - 7, 14, 14, op * 0.8, 0.9, 2);
  g += chair(cx - w / 4, cy - h / 2 - 11);
  g += chair(cx + w / 4, cy - h / 2 - 11);
  g += chair(cx - w / 4, cy + h / 2 + 11);
  g += chair(cx + w / 4, cy + h / 2 + 11);
  g += chair(cx - w / 2 - 11, cy);
  g += chair(cx + w / 2 + 11, cy);
  return g;
}
function coffeeTable(x, y, w, h, op) {
  return rect(x, y, w, h, op, 1.2, 2);
}
function stove(x, y, s, op) {
  let g = rect(x, y, s, s, op, 1.2);
  const q = s / 2;
  g += circle(x + q * 0.55, y + q * 0.55, q * 0.32, op * 0.8, 0.8);
  g += circle(x + q * 1.45, y + q * 0.55, q * 0.32, op * 0.8, 0.8);
  g += circle(x + q * 0.55, y + q * 1.45, q * 0.32, op * 0.8, 0.8);
  g += circle(x + q * 1.45, y + q * 1.45, q * 0.32, op * 0.8, 0.8);
  return g;
}
function counter(x, y, w, h, op) {
  return rect(x, y, w, h, op * 0.85, 1);
}
function kitchenSink(x, y, w, h, op) {
  let g = rect(x, y, w, h, op, 1, 1);
  g += rect(x + 2, y + 2, w / 2 - 3, h - 4, op * 0.7, 0.7, 1);
  g += rect(x + w / 2 + 1, y + 2, w / 2 - 3, h - 4, op * 0.7, 0.7, 1);
  return g;
}
function bathtub(x, y, w, h, op) {
  let g = rect(x, y, w, h, op, 1.4, 6);
  g += rect(x + 4, y + 4, w - 8, h - 8, op * 0.7, 0.8, 5);
  g += circle(x + w - 9, y + h / 2, 1.6, op * 0.8, 0.8); // drain
  return g;
}
function toilet(cx, cy, op) {
  let g = rect(cx - 7, cy - 11, 14, 6, op, 1, 1); // tank
  g += ellipse(cx, cy + 2, 6.5, 8.5, op, 1); // bowl
  return g;
}
function lavSink(cx, cy, op) {
  let g = ellipse(cx, cy, 9, 7, op, 1.2);
  g += circle(cx, cy - 2, 1.4, op * 0.8, 0.8);
  return g;
}

// ── a dimension line (title only): extension lines, end arrows, span ──
function dim(x1, y1, x2, y2, off, op, label) {
  const horiz = y1 === y2;
  let g = '';
  const ax = horiz ? 0 : (off > 0 ? 1 : -1);
  const ay = horiz ? (off > 0 ? 1 : -1) : 0;
  const dx = horiz ? x1 : x1 + off, dy = horiz ? y1 + off : y1;
  const ex = horiz ? x2 : x2 + off, ey = horiz ? y2 + off : y2;
  // extension lines
  g += line(x1, y1, dx, dy, op * 0.6, 0.6);
  g += line(x2, y2, ex, ey, op * 0.6, 0.6);
  // dim line
  g += line(dx, dy, ex, ey, op, 0.8);
  // arrowheads (small)
  const arr = (px, py, dir) => {
    if (horiz) return `<path d='M${P(px)} ${P(py)} L${P(px + dir * 5)} ${P(py - 2.6)} L${P(px + dir * 5)} ${P(py + 2.6)} Z' fill='${INK}' opacity='${op}'/>`;
    return `<path d='M${P(px)} ${P(py)} L${P(px - 2.6)} ${P(py + dir * 5)} L${P(px + 2.6)} ${P(py + dir * 5)} Z' fill='${INK}' opacity='${op}'/>`;
  };
  g += arr(dx, dy, 1) + arr(ex, ey, -1);
  if (label) {
    const mx = (dx + ex) / 2, my = (dy + ey) / 2;
    const rot = horiz ? '' : ` transform='rotate(-90 ${P(mx)} ${P(my)})'`;
    g += `<text x='${P(mx)}' y='${P(my - 2)}' fill='${INK}' opacity='${op * 0.8}' font-family='monospace' font-size='9' text-anchor='middle'${rot}%3E${label}%3C/text%3E`;
  }
  return g;
}

// ── the plan body (building + rooms + furniture), shared by both flavors ──
// Building footprint inside [bx0,by0]..[bx1,by1]; wall thickness t.
function planBody({ bx0, by0, bx1, by1, t, op }) {
  const ix0 = bx0 + t, iy0 = by0 + t, ix1 = bx1 - t, iy1 = by1 - t;
  const vx = bx0 + (bx1 - bx0) * 0.46; // interior vertical wall (left|right split)
  const hy = by0 + (by1 - by0) * 0.52; // left side horizontal split (top|bottom)
  const lvx = bx0 + (bx1 - bx0) * 0.24; // bath|kitchen split on the left-top
  let g = '';

  // ── outer walls with two door gaps (front entry on bottom-right, in right room) ──
  const entryX0 = bx0 + (bx1 - bx0) * 0.62, entryW = 46;
  // top / left / right full; bottom split around the entry gap
  g += wallRect(bx0, by0, bx1 - bx0, t, op); // top
  g += wallRect(bx0, by1 - t, entryX0 - bx0, t, op); // bottom-left of entry
  g += wallRect(entryX0 + entryW, by1 - t, bx1 - (entryX0 + entryW), t, op); // bottom-right of entry
  g += wallRect(bx0, by0, t, by1 - by0, op); // left
  g += wallRect(bx1 - t, by0, t, by1 - by0, op); // right
  g += door(entryX0 + entryW, by1 - t, entryW - 6, 180, 250, op); // entry swing inward

  // ── interior vertical wall (with a door into the right room from the hall) ──
  const vDoorY = hy + 14;
  g += wallRect(vx, iy0, t, vDoorY - iy0, op);
  g += wallRect(vx, vDoorY + 44, t, iy1 - (vDoorY + 44), op);
  g += door(vx + t, vDoorY + 44, 40, 270, 340, op);

  // ── left-side horizontal wall (bath/kitchen above, bedroom below) ──
  const hGapX0 = ix0 + (vx - ix0) * 0.42;
  const hGapW = 36;
  g += wallRect(ix0, hy, hGapX0 - ix0, t, op);
  g += wallRect(hGapX0 + hGapW, hy, vx - (hGapX0 + hGapW), t, op);
  g += door(hGapX0 + hGapW, hy + t, 34, 180, 250, op);

  // ── bath|kitchen partition on the left-top ──
  g += wallRect(lvx, iy0, t, hy - iy0 - 36, op); // leaves an opening near the hall
  g += door(lvx + t, hy - 36, 30, 250, 320, op);

  // ── FURNITURE ──
  // Bedroom (left-bottom): bed head against left wall
  g += bed(ix0 + 6, hy + 24, 96, 70, op);
  // wardrobe along the bottom wall
  g += rect(ix0 + 6, iy1 - 16, 70, 12, op * 0.8, 0.9);

  // Living/Dining (right room)
  const rL = vx + t, rR = ix1, rT = iy0, rB = iy1;
  g += diningTable((rL + rR) / 2, rT + 46, 64, 40, op); // dining near the top
  g += sofa(rL + 14, rB - 40, rR - rL - 28, 34, op); // sofa along the bottom
  g += coffeeTable((rL + rR) / 2 - 28, rB - 92, 56, 30, op);
  g += armchair(rR - 30, rB - 96, 26, op);

  // Kitchen (left-top, right of the bath partition): L-counter + stove + sink
  const kL = lvx + t, kR = vx, kT = iy0;
  g += counter(kL + 3, kT + 3, kR - kL - 6, 14, op); // top run
  g += counter(kR - 17, kT + 3, 14, hy - kT - 40, op); // right run
  g += stove(kL + 8, kT + 4, 12, op);
  g += kitchenSink(kL + 30, kT + 4, 20, 12, op);

  // Bathroom (left-top-left): tub along top, toilet + sink below
  const bL = ix0, bR = lvx, bT = iy0;
  g += bathtub(bL + 5, bT + 5, bR - bL - 10, 22, op);
  g += toilet(bL + 16, bT + 44, op);
  g += lavSink(bR - 16, bT + 44, op);

  return g;
}

// ── assemble an SVG ───────────────────────────────────────────────
function defs() {
  return (
    `<defs>` +
    `<pattern id='bpHatch' width='6' height='6' patternUnits='userSpaceOnUse' patternTransform='rotate(45)'>` +
    `<line x1='0' y1='0' x2='0' y2='6' stroke='${INK}' stroke-width='0.8'/></pattern></defs>`
  );
}

function boardPlan() {
  // square-ish, dim, no dimension lines — fills the board; numbers must pop.
  const vb = { w: 300, h: 280 };
  const body = planBody({ bx0: 14, by0: 14, bx1: 286, by1: 266, t: 7, op: 0.4 });
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${vb.w} ${vb.h}' preserveAspectRatio='none'>` +
    defs() +
    `<g>${body}</g>` +
    `</svg>`
  );
}

function titlePlan() {
  // wider, with perimeter dimension lines + a couple of spans labeled; tiles
  // down the sheet (one complete plan per tile = drawings on a blueprint sheet).
  const vb = { w: 480, h: 360 };
  const bx0 = 44, by0 = 50, bx1 = 436, by1 = 310, t = 8;
  let dims = '';
  // top overall + one inner span
  dims += dim(bx0, by0, bx1, by0, -26, 0.42, '1144');
  dims += dim(bx0, by0, bx0 + (bx1 - bx0) * 0.46, by0, -14, 0.36, '503');
  // right overall + one inner span
  dims += dim(bx1, by0, bx1, by1, 26, 0.42, '750');
  dims += dim(bx1, by0 + (by1 - by0) * 0.52, bx1, by1, 14, 0.36, '336');
  const body = planBody({ bx0, by0, bx1, by1, t, op: 0.5 });
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${vb.w} ${vb.h}'>` +
    defs() +
    `<g>${dims}</g>` +
    `<g>${body}</g>` +
    `</svg>`
  );
}

// ── encode to a CSS url("data:...") (light encoding; single-quoted attrs) ──
function toDataUri(svg) {
  const enc = svg
    .replace(/\n/g, '')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E')
    .replace(/#/g, '%23');
  return `url("data:image/svg+xml,${enc}")`;
}

const board = toDataUri(boardPlan());
const title = toDataUri(titlePlan());

const grid =
  'repeating-linear-gradient(0deg,rgba(90,208,255,.09) 0 1px,transparent 1px 24px),' +
  'repeating-linear-gradient(90deg,rgba(90,208,255,.09) 0 1px,transparent 1px 24px)';

writeFileSync(
  new URL('./_blueprint-preview.html', import.meta.url),
  `<!doctype html><meta charset=utf8>
  <style>
    body { margin:0; background:#08203a; font-family:monospace; color:#9ec; }
    .row { display:flex; gap:24px; flex-wrap:wrap; padding:24px; }
    .board {
      width:420px; height:392px; background-color:#0a2540;
      background-image:${board},${grid};
      background-repeat:no-repeat,repeat,repeat;
      background-size:100% 100%,auto,auto;
    }
    .title {
      width:480px; height:600px; background:#08203a;
      background-image:${title};
      background-repeat:repeat-y; background-size:100% auto; background-position:top center;
    }
  </style>
  <div class=row>
    <div><div>BOARD plan (dim) — over navy + grid (= unrevealed cells)</div><div class=board></div></div>
    <div><div>TITLE plan (with dim lines) — repeat-y on navy</div><div class=title></div></div>
  </div>`
);

console.log('BOARD_FOG_ART:');
console.log(board);
console.log('\nTITLE_BACKDROP:');
console.log(title);
console.log('\nbytes board=', board.length, ' title=', title.length);

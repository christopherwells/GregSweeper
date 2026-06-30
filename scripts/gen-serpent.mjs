// Authoring tool for the cartography sea-serpent sprite.
//
// The serpent is an antique-chart "here be monsters" engraving: a horned dragon
// head with an open toothy jaw + a cream eye, a frilled neck, two scaled coils
// breaching a wavy waterline, and a webbed tail fin. It is the cartography
// theme's ambient effect (it surfaces + submerges over open-ocean fog).
//
// This file is the SINGLE SOURCE for the drawing. Run it to (a) write a big
// preview at scripts/_serpent-preview.html and (b) print the one-line
// SERPENT_SVG string to paste into src/ui/themeEffects.js:
//     node scripts/gen-serpent.mjs            # writes preview
//     node scripts/gen-serpent.mjs --print    # also prints SERPENT_SVG
//
// Local coords: waterline ~y=0, body above (negative y), head at the right.

import { writeFileSync } from 'node:fs';

const SEPIA = '#5c4020';
const CREAM = '#e9d9b2';
const P = (n) => Number(n.toFixed(2));

// The body spine (tail → head): two coils then a rising neck.
const SPINE = [[8, -2], [16, -12], [23, -1], [32, -12], [40, -2], [45, -8], [49, -15]];
const WATER = 0.5;       // waterline y
const HALF = 1.7;        // body half-thickness (frill roots just above this)
const FRILL_MAX = 6.4;   // tallest dorsal spine

// --- body curve: the same /6-tension Catmull-Rom-as-bezier the map used ---
function bezierCtrl(pts, i) {
  const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
  return [
    [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
    [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
  ];
}
function bodyPath(pts) {
  let d = `M${P(pts[0][0])} ${P(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [c1, c2] = bezierCtrl(pts, i);
    d += `C${P(c1[0])} ${P(c1[1])} ${P(c2[0])} ${P(c2[1])} ${P(pts[i + 1][0])} ${P(pts[i + 1][1])}`;
  }
  return d;
}
// Dense polyline of the EXACT body centerline (so the frill rides the real back).
function bodyDense(pts, perSeg = 40) {
  const out = [[pts[0][0], pts[0][1]]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p1 = pts[i], p2 = pts[i + 1];
    const [c1, c2] = bezierCtrl(pts, i);
    for (let j = 1; j <= perSeg; j++) {
      const t = j / perSeg, u = 1 - t;
      out.push([
        u * u * u * p1[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p2[0],
        u * u * u * p1[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p2[1],
      ]);
    }
  }
  return out;
}

// --- dorsal frill: a CONNECTED sawtooth rooted on the back, swept toward the
//     tail, tallest where the body rides highest above the waterline. One ridge,
//     evenly spaced — not scattered triangles. ---
function frillPath() {
  const dense = bodyDense(SPINE);
  const cum = [0];
  for (let i = 1; i < dense.length; i++) {
    const dx = dense[i][0] - dense[i - 1][0], dy = dense[i][1] - dense[i - 1][1];
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  const total = cum[cum.length - 1];
  // sample point + up-normal at arc length s
  const at = (s) => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const p = dense[i], q = dense[i - 1];
    let tx = p[0] - q[0], ty = p[1] - q[1];
    const m = Math.hypot(tx, ty) || 1; tx /= m; ty /= m;
    const n1 = [-ty, tx], n2 = [ty, -tx];
    return { pt: p, N: n1[1] < n2[1] ? n1 : n2 };
  };
  // a SINGLE fixed lean for every spine (up, a touch toward the tail) so the
  // frill reads as one deliberate comb, not normals fanning with the body slope
  const LEAN = (() => { const v = [-0.15, -1], m = Math.hypot(...v); return [v[0] / m, v[1] / m]; })();
  const ridgeAt = (s) => { const { pt, N } = at(s); return [pt[0] + N[0] * HALF, pt[1] + N[1] * HALF]; };
  const tipAt = (s) => {
    const r = ridgeAt(s), { pt } = at(s);
    const elev = Math.min(1, Math.max(0.3, (WATER - pt[1]) / 12)); // tall on crests
    const h = FRILL_MAX * elev;
    return [r[0] + LEAN[0] * h, r[1] + LEAN[1] * h];
  };
  // The frill rides only the BREACHING parts: contiguous runs where the body is
  // clearly above the waterline. Dips (underwater) and the bare tail/head get a
  // gap — like a real sea-serpent's dorsal fin on each coil.
  const CUTOFF = -5.6, STEP = total / 260, SPACING = 4.8;
  const segs = []; let cur = null;
  for (let s = 0; s <= total; s += STEP) {
    if (at(s).pt[1] < CUTOFF) { if (!cur) cur = { a: s, b: s }; cur.b = s; }
    else if (cur) { segs.push(cur); cur = null; }
  }
  if (cur) segs.push(cur);
  let d = '';
  for (const seg of segs) {
    const len = seg.b - seg.a;
    if (len < 3) continue;
    const n = Math.max(1, Math.round(len / SPACING)), g = len / n;
    const r0 = ridgeAt(seg.a);
    d += `M${P(r0[0])} ${P(r0[1])}`;
    for (let k = 0; k < n; k++) {
      const s0 = seg.a + g * k, tp = tipAt(s0 + g * 0.5), r1 = ridgeAt(s0 + g);
      d += `L${P(tp[0])} ${P(tp[1])}L${P(r1[0])} ${P(r1[1])}`;
    }
  }
  return d;
}

function serpentArt() {
  const sp = `stroke='${SEPIA}' fill='none' stroke-linecap='round' stroke-linejoin='round'`;
  return (
    // waterline (behind the body)
    `<path d='M-4 1 q3 -2.4 6 0 q3 2.4 6 0 q3 -2.4 6 0' ${sp} stroke-width='0.9' opacity='0.5'/>` +
    `<path d='M26 1 q3 -2.4 6 0 q3 2.4 6 0 q3 -2.4 6 0 q3 -2.4 6 0' ${sp} stroke-width='0.9' opacity='0.5'/>` +
    // tail: a stem + a webbed fan
    `<path d='M8 -2 q-4 0 -6 -7' ${sp} stroke-width='2.4'/>` +
    `<path d='M2 -9 l-3 -6 M2 -9 l1 -7 M2 -9 l5 -5 M2 -9 l6 -2' ${sp} stroke-width='1'/>` +
    `<path d='M-1 -15 q4 1 9 5' ${sp} stroke-width='0.8' opacity='0.7'/>` +
    // body tube (the two coils + neck)
    `<path d='${bodyPath(SPINE)}' ${sp} stroke-width='3.8'/>` +
    // connected dorsal frill + light scale hatching
    `<path d='${frillPath()}' ${sp} stroke-width='1'/>` +
    `<path d='M13 -9 l3 1 M18 -10 l3 1 M29 -9 l3 1 M34 -10 l3 1' ${sp} stroke-width='0.8' opacity='0.6'/>` +
    // HEAD (filled dragon head): cranium + snout
    `<path d='M47 -14 Q46 -20 50 -21 Q55 -24 60 -21 Q64 -19 62 -16 Q58 -16 55 -15.5 Q51 -14 47 -14 Z' fill='${SEPIA}'/>` +
    // lower jaw (open)
    `<path d='M50 -13 Q54 -11.5 60 -12.2 Q56 -10 51 -10.6 Q49 -11.2 50 -13 Z' fill='${SEPIA}'/>` +
    // teeth (cream) in the open mouth
    `<path d='M55 -15 l0.6 1.5 M58 -15 l0.5 1.5 M60.5 -15.3 l0.4 1.3' stroke='${CREAM}' stroke-width='0.7' fill='none' stroke-linecap='round'/>` +
    // eye (cream with a sepia pupil) + swept-back horns
    `<circle cx='51.5' cy='-18' r='1.2' fill='${CREAM}'/><circle cx='51.7' cy='-18' r='0.45' fill='${SEPIA}'/>` +
    `<path d='M50 -20 Q47 -25 49 -28 M53 -21 Q52 -26 55 -28' ${sp} stroke-width='1.3'/>`
  );
}

const SVG = `<svg viewBox='-10 -36 82 44' width='100%' height='100%' style='display:block;overflow:visible' xmlns='http://www.w3.org/2000/svg'>${serpentArt()}</svg>`;

writeFileSync(new URL('./_serpent-preview.html', import.meta.url),
  `<!doctype html><meta charset=utf8><style>
   body{margin:0;background:#6f9bb8;font-family:monospace;color:#26313a;padding:20px}
   .big{width:560px;height:300px;background:#5a86a8;border:1px solid #3a5}
   .small{width:110px;height:59px;background:#5a86a8;vertical-align:middle}
   .row{display:flex;gap:20px;align-items:center;flex-wrap:wrap}
  </style>
  <h3>SERPENT — big + at on-board size</h3>
  <div class=row>
   <div class=big>${SVG}</div>
   <div><div class=small>${SVG}</div><div class=small style="transform:scaleX(-1)">${SVG}</div></div>
  </div>`);

if (process.argv.includes('--print')) {
  console.log('SERPENT_SVG_START');
  console.log(SVG);
  console.log('SERPENT_SVG_END');
}
console.log('preview written');

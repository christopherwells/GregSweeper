// Generator for the cartography theme's aged coastal-map backdrop. Emulates a
// real antique chart (Christopher's reference): CALM open parchment, a soft
// WATERCOLOR-BLUE bay/gulf in layered washes, a clean single-stroke sepia
// coastline + a couple of rivers, a barrier island, and (title flavor only) a
// few faint hand-lettered place names. NO concentric echoes / scattered
// soundings / heavy compass / foxing overload — those made it busy.
//   node scripts/gen-cartography-map.mjs
// Prints the board (--bg-fog-art, label-free) + title (--theme-backdrop, with
// faint labels) data-URIs and writes scripts/_carto-preview.html. Only the
// data-URIs ship.
import { writeFileSync } from 'node:fs';

const INK = '236,42,32'; // placeholder, overwritten below
const SEPIA = '#5c4020';
const SEPIA_SOFT = '#6a4a26';
const VB = { w: 360, h: 300 };
const P = (n) => Math.round(n * 10) / 10;

// Catmull-Rom -> cubic bezier through the given points (open curve).
function smooth(pts) {
  if (pts.length < 2) return '';
  let d = `M${P(pts[0][0])} ${P(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${P(c1x)} ${P(c1y)} ${P(c2x)} ${P(c2y)} ${P(p2[0])} ${P(p2[1])}`;
  }
  return d;
}

// ── composition: land on the LEFT (open parchment), gulf on the RIGHT, with a
// bay biting in around mid-height — like the reference. ──
const coast = [
  [262, -6], [256, 28], [268, 58], [250, 92], [214, 116],
  [186, 150], [203, 188], [238, 212], [252, 246], [242, 282], [252, 306],
];
// the sea is the region to the RIGHT of the coastline (close along the right edge)
const seaPath = smooth(coast) + ` L${VB.w + 6} 306 L${VB.w + 6} -6 Z`;

const rivers = [
  [[-6, 86], [44, 98], [86, 92], [126, 118], [162, 138], [186, 150]],
  [[-6, 214], [52, 206], [104, 216], [152, 210], [206, 209], [238, 212]],
  // a short tributary joining river 1
  [[70, 150], [92, 132], [112, 124], [126, 118]],
];

// a thin barrier island offshore (like Galveston/Padre), sepia outline
const island = [
  [296, 150], [306, 176], [312, 206], [305, 232], [298, 236], [296, 210], [290, 180], [288, 154], [296, 150],
];

// faint place labels (title flavor only) — sparse, on the open land
const labels = [
  { x: 40, y: 60, t: 'Bastrop', s: 9 },
  { x: 96, y: 110, t: 'Columbus', s: 9 },
  { x: 60, y: 176, t: 'Gonzales', s: 9 },
  { x: 120, y: 232, t: 'Victoria', s: 9 },
  { x: 250, y: 96, t: 'Anáhuac', s: 8 },
  { x: 230, y: 250, t: 'Lamar', s: 8 },
];
const dots = [[88, 112], [54, 178], [112, 234], [243, 98], [224, 251], [33, 62]];

function watercolor() {
  // Layered soft washes clipped to the sea region: a shore→deep gradient, a
  // couple of blurred deep blobs offshore, and a soft light band hugging the
  // coast (shallows). All low-opacity for a painted, not flat, look.
  return (
    `<defs>` +
    `<clipPath id='sea'><path d='${seaPath}'/></clipPath>` +
    `<linearGradient id='depth' x1='0' y1='0' x2='1' y2='0.15'>` +
    `<stop offset='0' stop-color='rgba(126,182,216,0.36)'/>` +
    `<stop offset='0.5' stop-color='rgba(62,136,194,0.42)'/>` +
    `<stop offset='1' stop-color='rgba(32,96,164,0.48)'/>` +
    `</linearGradient>` +
    `<filter id='soft' x='-20%' y='-20%' width='140%' height='140%'><feGaussianBlur stdDeviation='6'/></filter>` +
    `<filter id='soft2' x='-30%' y='-30%' width='160%' height='160%'><feGaussianBlur stdDeviation='10'/></filter>` +
    `</defs>` +
    `<g clip-path='url(%23sea)'>` +
    `<rect x='0' y='0' width='${VB.w}' height='${VB.h}' fill='url(%23depth)'/>` +
    // deep washes offshore
    `<ellipse cx='330' cy='90' rx='70' ry='90' fill='rgba(26,90,160,0.26)' filter='url(%23soft2)'/>` +
    `<ellipse cx='320' cy='250' rx='80' ry='80' fill='rgba(32,98,166,0.24)' filter='url(%23soft2)'/>` +
    // shallows: a soft light band along the coast
    `<path d='${smooth(coast)}' fill='none' stroke='rgba(152,200,226,0.52)' stroke-width='14' filter='url(%23soft)'/>` +
    `</g>`
  );
}

function inkLayer(withLabels) {
  let s = '';
  // coastline — clean single sepia stroke
  s += `<path d='${smooth(coast)}' fill='none' stroke='${SEPIA}' stroke-width='1.4' opacity='0.85' stroke-linecap='round'/>`;
  // rivers — thin, with a faint blue centerline
  for (const r of rivers) {
    s += `<path d='${smooth(r)}' fill='none' stroke='${SEPIA}' stroke-width='1.1' opacity='0.6' stroke-linecap='round'/>`;
    s += `<path d='${smooth(r)}' fill='none' stroke='rgba(74,124,170,0.4)' stroke-width='0.5' opacity='0.7' stroke-linecap='round'/>`;
  }
  // barrier island — sepia outline, faint parchment fill so it reads as land
  s += `<path d='${smooth(island)}' fill='rgba(210,192,150,0.5)' stroke='${SEPIA}' stroke-width='1' opacity='0.7'/>`;
  // a small, restrained compass rose, upper-left in the gulf
  s += compass(312, 54, 17);
  if (withLabels) {
    for (const d of dots) s += `<circle cx='${d[0]}' cy='${d[1]}' r='1.5' fill='${SEPIA}' opacity='0.6'/>`;
    for (const l of labels) {
      s += `<text x='${l.x}' y='${l.y}' fill='${SEPIA_SOFT}' opacity='0.5' font-family='Georgia,serif' font-style='italic' font-size='${l.s}'>${l.t}</text>`;
    }
  }
  return s;
}

function compass(cx, cy, r) {
  const r2 = r * 0.42;
  // 4 long points (N/E/S/W) + 4 short, a center ring. North tipped in faded red.
  const pt = (ang, len, w) => {
    const a = (ang * Math.PI) / 180, a2 = ((ang + 90) * Math.PI) / 180;
    const tx = cx + Math.cos(a) * len, ty = cy + Math.sin(a) * len;
    const bx = cx + Math.cos(a2) * w, by = cy + Math.sin(a2) * w;
    const bx2 = cx - Math.cos(a2) * w, by2 = cy - Math.sin(a2) * w;
    return `M${P(bx)} ${P(by)} L${P(tx)} ${P(ty)} L${P(bx2)} ${P(by2)} Z`;
  };
  let g = `<g opacity='0.6'><circle cx='${cx}' cy='${cy}' r='${r}' fill='none' stroke='${SEPIA}' stroke-width='0.8'/>`;
  g += `<circle cx='${cx}' cy='${cy}' r='${r2}' fill='none' stroke='${SEPIA}' stroke-width='0.6'/>`;
  // diagonal short points
  for (const ang of [45, 135, 225, 315]) g += `<path d='${pt(ang, r * 0.7, 2)}' fill='${SEPIA_SOFT}' opacity='0.55'/>`;
  // E/S/W long points
  for (const ang of [0, 90, 180]) g += `<path d='${pt(ang, r, 2.4)}' fill='${SEPIA}'/>`;
  // North point, faded cinnabar
  g += `<path d='${pt(270, r, 2.4)}' fill='#8a3020'/>`;
  g += `</g>`;
  return g;
}

function svg(withLabels) {
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${VB.w} ${VB.h}' preserveAspectRatio='none'>` +
    watercolor() +
    inkLayer(withLabels) +
    `</svg>`
  );
}

function toDataUri(s) {
  return `url("data:image/svg+xml,${s.replace(/\n/g, '').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/#/g, '%23')}")`;
}

const board = toDataUri(svg(false));
const title = toDataUri(svg(true));

const grid =
  'repeating-linear-gradient(0deg,rgba(74,52,32,.04) 0 1px,transparent 1px 30px),' +
  'repeating-linear-gradient(90deg,rgba(74,52,32,.04) 0 1px,transparent 1px 30px)';
writeFileSync(new URL('./_carto-preview.html', import.meta.url),
  `<!doctype html><meta charset=utf8><style>
   body{margin:0;background:#c9b896;font-family:monospace;color:#4a3420}
   .row{display:flex;gap:24px;flex-wrap:wrap;padding:24px}
   .board{width:420px;height:392px;background-color:#b8a070;background-image:${board};background-repeat:no-repeat;background-size:100% 100%}
   .title{width:480px;height:620px;background:#c9b896;background-image:${title},${grid};background-repeat:repeat-y,repeat,repeat;background-size:100% auto,auto,auto;background-position:top center}
  </style>
  <div class=row>
   <div><div>BOARD (--bg-fog-art, no labels, stretched)</div><div class=board></div></div>
   <div><div>TITLE (--theme-backdrop, faint labels, repeat-y)</div><div class=title></div></div>
  </div>`);

console.log('BOARD_FOG_ART:'); console.log(board);
console.log('\nTITLE_BACKDROP:'); console.log(title);
console.log('\nbytes board=', board.length, ' title=', title.length);

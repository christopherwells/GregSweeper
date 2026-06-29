// Generator for the cartography theme's aged coastal-map backdrop. Emulates a
// real antique chart (Christopher's Texas Gulf Coast reference): CALM open
// parchment, a soft WATERCOLOR-BLUE gulf + bays in organic layered washes, a
// COMPLEX coastline — bays biting in, barrier islands with passes, headlands —
// clean sepia ink, a couple of rivers into the bays, a small compass rose.
// No place labels (Christopher cut them). One map for board + title.
//   node scripts/gen-cartography-map.mjs
// Prints the data-URI (used for both --bg-fog-art and --theme-backdrop) and
// writes scripts/_carto-preview.html. Only the data-URI ships.
import { writeFileSync } from 'node:fs';

const SEPIA = '#5c4020';
const VB = { w: 360, h: 300 };
const P = (n) => Math.round(n * 10) / 10;

// Catmull-Rom bezier segments through pts, assuming the pen is already at pts[0].
function curve(pts) {
  let d = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${P(c1x)} ${P(c1y)} ${P(c2x)} ${P(c2y)} ${P(p2[0])} ${P(p2[1])}`;
  }
  return d;
}
const smooth = (pts) => `M${P(pts[0][0])} ${P(pts[0][1])}` + curve(pts);

// A thin barrier-island ribbon: offset the (vertical-ish) centerline by ±hw in
// x, down one side and back up the other, closed.
function ribbon(pts, hw) {
  const right = pts.map(([x, y]) => [x + hw, y]);
  const left = pts.slice().reverse().map(([x, y]) => [x - hw, y]);
  return `M${P(right[0][0])} ${P(right[0][1])}` + curve(right) +
    ` L${P(left[0][0])} ${P(left[0][1])}` + curve(left) + ' Z';
}

// ── COMPLEX coastline: land left, gulf right, three bays biting in. ──
const coast = [
  [256, -6], [270, 22], [258, 42], [214, 58], [190, 82], [210, 104],
  [252, 120], [262, 138], [236, 156], [198, 180], [222, 202],
  [256, 220], [244, 242], [212, 258], [238, 280], [250, 306],
];
const seaPath = smooth(coast) + ` L${VB.w + 6} 306 L${VB.w + 6} -6 Z`;

// barrier islands guarding the bays, with passes (gaps) between them
const islands = [
  { c: [[296, 16], [304, 46], [307, 78], [302, 104]], hw: 5 },
  { c: [[300, 128], [308, 156], [310, 184], [305, 202]], hw: 5.2 },
  { c: [[296, 224], [304, 252], [308, 280], [303, 304]], hw: 5 },
];

// rivers from the land into each bay head
const rivers = [
  [[-6, 70], [44, 82], [92, 74], [136, 86], [170, 80], [190, 82]],
  [[-6, 200], [50, 193], [104, 203], [152, 186], [198, 180]],
  [[-6, 262], [60, 257], [130, 263], [182, 256], [212, 258]],
  [[96, 150], [116, 132], [134, 120], [150, 104], [162, 92]], // a tributary
];

function watercolor() {
  // Organic washes clipped to the sea: a medium base, lighter pools in the
  // bays, deeper pools out in the gulf — all soft-blurred so the water reads
  // painted, not flat, and with NO artificial light band along the shore.
  return (
    `<defs>` +
    `<clipPath id='sea'><path d='${seaPath}'/></clipPath>` +
    `<filter id='b1' x='-40%' y='-40%' width='180%' height='180%'><feGaussianBlur stdDeviation='11'/></filter>` +
    `<filter id='b2' x='-50%' y='-50%' width='200%' height='200%'><feGaussianBlur stdDeviation='17'/></filter>` +
    `</defs>` +
    `<g clip-path='url(%23sea)'>` +
    `<rect x='0' y='0' width='${VB.w}' height='${VB.h}' fill='rgba(60,134,192,0.40)'/>` +
    // deeper gulf pools (far right)
    `<ellipse cx='350' cy='70' rx='64' ry='90' fill='rgba(26,88,156,0.30)' filter='url(%23b2)'/>` +
    `<ellipse cx='352' cy='250' rx='70' ry='86' fill='rgba(28,90,158,0.28)' filter='url(%23b2)'/>` +
    `<ellipse cx='344' cy='160' rx='44' ry='60' fill='rgba(30,92,160,0.22)' filter='url(%23b2)'/>` +
    // lighter washes pooling in the bays
    `<ellipse cx='224' cy='84' rx='40' ry='30' fill='rgba(120,176,210,0.26)' filter='url(%23b1)'/>` +
    `<ellipse cx='220' cy='182' rx='38' ry='30' fill='rgba(120,176,210,0.24)' filter='url(%23b1)'/>` +
    `<ellipse cx='232' cy='262' rx='34' ry='26' fill='rgba(122,178,212,0.22)' filter='url(%23b1)'/>` +
    // a couple of mid mottles for granulation
    `<ellipse cx='292' cy='120' rx='30' ry='40' fill='rgba(74,142,196,0.16)' filter='url(%23b1)'/>` +
    `<ellipse cx='300' cy='210' rx='28' ry='36' fill='rgba(50,110,176,0.16)' filter='url(%23b1)'/>` +
    `</g>`
  );
}

function inkLayer() {
  let s = '';
  s += `<path d='${smooth(coast)}' fill='none' stroke='${SEPIA}' stroke-width='1.4' opacity='0.85' stroke-linecap='round'/>`;
  for (const r of rivers) {
    s += `<path d='${smooth(r)}' fill='none' stroke='${SEPIA}' stroke-width='1.1' opacity='0.58' stroke-linecap='round'/>`;
    s += `<path d='${smooth(r)}' fill='none' stroke='rgba(60,134,192,0.45)' stroke-width='0.5' opacity='0.7' stroke-linecap='round'/>`;
  }
  // barrier islands — parchment land in the blue, sepia outline
  for (const is of islands) {
    s += `<path d='${ribbon(is.c, is.hw)}' fill='rgba(212,194,152,0.62)' stroke='${SEPIA}' stroke-width='1' opacity='0.78'/>`;
  }
  s += compass(338, 116, 15);
  return s;
}

function compass(cx, cy, r) {
  const r2 = r * 0.42;
  const pt = (ang, len, w) => {
    const a = (ang * Math.PI) / 180, a2 = ((ang + 90) * Math.PI) / 180;
    const tx = cx + Math.cos(a) * len, ty = cy + Math.sin(a) * len;
    const bx = cx + Math.cos(a2) * w, by = cy + Math.sin(a2) * w;
    const bx2 = cx - Math.cos(a2) * w, by2 = cy - Math.sin(a2) * w;
    return `M${P(bx)} ${P(by)} L${P(tx)} ${P(ty)} L${P(bx2)} ${P(by2)} Z`;
  };
  let g = `<g opacity='0.55'><circle cx='${cx}' cy='${cy}' r='${r}' fill='none' stroke='${SEPIA}' stroke-width='0.8'/>`;
  g += `<circle cx='${cx}' cy='${cy}' r='${r2}' fill='none' stroke='${SEPIA}' stroke-width='0.6'/>`;
  for (const ang of [45, 135, 225, 315]) g += `<path d='${pt(ang, r * 0.7, 2)}' fill='%236a4a26' opacity='0.5'/>`;
  for (const ang of [0, 90, 180]) g += `<path d='${pt(ang, r, 2.4)}' fill='${SEPIA}'/>`;
  g += `<path d='${pt(270, r, 2.4)}' fill='%238a3020'/></g>`;
  return g;
}

function svg() {
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${VB.w} ${VB.h}' preserveAspectRatio='none'>` +
    watercolor() + inkLayer() + `</svg>`
  );
}

function toDataUri(s) {
  return `url("data:image/svg+xml,${s.replace(/\n/g, '').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/#/g, '%23')}")`;
}

const map = toDataUri(svg());
writeFileSync(new URL('./_carto-preview.html', import.meta.url),
  `<!doctype html><meta charset=utf8><style>
   body{margin:0;background:#c9b896;font-family:monospace;color:#4a3420}
   .row{display:flex;gap:24px;flex-wrap:wrap;padding:24px}
   .board{width:420px;height:392px;background-color:#b8a070;background-image:${map};background-repeat:no-repeat;background-size:100% 100%}
   .title{width:480px;height:620px;background:#c9b896;background-image:${map};background-repeat:repeat-y;background-size:100% auto;background-position:top center}
  </style>
  <div class=row>
   <div><div>BOARD (--bg-fog-art, stretched)</div><div class=board></div></div>
   <div><div>TITLE (--theme-backdrop, repeat-y)</div><div class=title></div></div>
  </div>`);

console.log('MAP:'); console.log(map);
console.log('\nbytes=', map.length);

// Generator for the cartography theme's backdrop: an antique CHART OF MOOREA
// and its neighbors, traced from REAL coastlines. Moorea sits centered; Tahiti
// (its big SE neighbor) and Maiao run off the edges at true relative scale —
// like a real sea chart. Styled in the theme idiom: cream volcanic islands +
// sepia coast, tropical TURQUOISE lagoons, dotted barrier reefs, and a compass
// rose in the bottom-right.
//
// Coastline geometry: © OpenStreetMap contributors, ODbL. Fetch the sources
// once (kept local/untracked, underscore-prefixed):
//   for q in Mo%CA%BBorea Tahiti Maiao; do curl -H "User-Agent: GregSweeper-dev (c.wells@bowdoin.edu)" \
//     "https://nominatim.openstreetmap.org/search?format=json&polygon_geojson=1&q=$q" -o "scripts/_<name>.json"; done
//   node scripts/gen-cartography-map.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const SEPIA = '#5c4020';
const VB = 360;
const ISLAND_FIT = 196;   // Moorea's longest dim in px (ocean margin for the cover-crop)
const P = (n) => Math.round(n * 10) / 10;

// ── geometry helpers ──
function rdp(points, eps) {
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const seg = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1e-9;
    return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L;
  };
  while (stack.length) {
    const [s, e] = stack.pop();
    let dmax = 0, idx = -1;
    for (let i = s + 1; i < e; i++) { const d = seg(points[i], points[s], points[e]); if (d > dmax) { dmax = d; idx = i; } }
    if (dmax > eps && idx !== -1) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return points.filter((_, i) => keep[i]);
}
function rdpClosed(points, eps) {
  let p = points.slice();
  if (p.length > 1 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]) p.pop();
  let far = 0, fd = -1;
  for (let i = 1; i < p.length; i++) { const d = (p[i][0] - p[0][0]) ** 2 + (p[i][1] - p[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const a = rdp(p.slice(0, far + 1), eps), b = rdp(p.slice(far).concat([p[0]]), eps);
  return a.concat(b.slice(1, -1));
}
const mean = (pts, i) => pts.reduce((s, p) => s + p[i], 0) / pts.length;
const poly = (p) => 'M' + p.map(([x, y]) => `${P(x)} ${P(y)}`).join(' L') + ' Z';
// Catmull-Rom smoothed open path (for the serpent body)
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

function loadRing(name) {
  const d = JSON.parse(readFileSync(new URL(`./_${name}.json`, import.meta.url), 'utf8'));
  const r = d.find((x) => x.geojson && /Polygon/.test(x.geojson.type)) || d[0];
  let ring = r.geojson.coordinates;
  while (typeof ring[0][0] !== 'number') ring = ring[0];
  return ring;
}

// ── shared projection: Moorea sets the scale (px per degree); cos-correct lon ──
const mRing = loadRing('moorea');
const lat0 = (Math.min(...mRing.map((p) => p[1])) + Math.max(...mRing.map((p) => p[1]))) / 2;
const kx = Math.cos((lat0 * Math.PI) / 180);
const proj = (ring) => ring.map(([lon, lat]) => [lon * kx, lat]);
const mP = proj(mRing);
const mxs = mP.map((p) => p[0]), mys = mP.map((p) => p[1]);
const mSpan = Math.max(Math.max(...mxs) - Math.min(...mxs), Math.max(...mys) - Math.min(...mys));
const S = ISLAND_FIT / mSpan;                 // px per projected degree
const mAnchor = [(Math.min(...mxs) + Math.max(...mxs)) / 2, (Math.min(...mys) + Math.max(...mys)) / 2];

// place an island's projected ring at (tx,ty) with size multiple mul (1 = real
// relative to Moorea), flipping y (north up)
function place(ring, anchor, tx, ty, mul, eps) {
  const px = ring.map((p) => [tx + (p[0] - anchor[0]) * S * mul, ty - (p[1] - anchor[1]) * S * mul]);
  return rdpClosed(px, eps);
}

const moorea = place(mP, mAnchor, VB / 2, VB / 2, 1, 0.6);
const tP = proj(loadRing('tahiti'));   const tA = [mean(tP, 0), mean(tP, 1)];
const aP = proj(loadRing('maiao'));    const aA = [mean(aP, 0), mean(aP, 1)];
// Tahiti: big, running off the top-right. Maiao: small, off the lower-left.
const tahiti = place(tP, tA, 452, -36, 0.82, 1.5);
const maiao = place(aP, aA, -8, 250, 1.0, 0.4);

// ── draw one island (lagoon + land + coast + reef) ──
function island(coast, peaks) {
  const cx = mean(coast, 0), cy = mean(coast, 1);
  const reef = coast.map(([x, y]) => [cx + (x - cx) * 1.16, cy + (y - cy) * 1.16]);
  let s = '';
  s += `<path d='${poly(reef)}' fill='rgba(96,200,206,0.62)'/>`;
  s += `<path d='${poly(reef)}' fill='none' stroke='rgba(150,224,224,0.5)' stroke-width='5' filter='url(%23bl)'/>`;
  s += `<path d='${poly(coast)}' fill='%23e9d9b2' stroke='${SEPIA}' stroke-width='1.4' stroke-linejoin='round'/>`;
  if (peaks) {
    s += `<circle cx='${P(cx)}' cy='${P(cy + 8)}' r='30' fill='none' stroke='${SEPIA}' stroke-width='0.6' opacity='0.3'/>`;
    s += `<circle cx='${P(cx)}' cy='${P(cy + 8)}' r='16' fill='none' stroke='${SEPIA}' stroke-width='0.6' opacity='0.35'/>`;
  }
  // reef dotted ring — masked to water only, so it never crosses the shoreline
  // (centroid-scaling pushes it over the land at the deep north bays otherwise)
  s += `<path d='${poly(reef)}' fill='none' stroke='${SEPIA}' stroke-width='1' stroke-dasharray='1.5 4' opacity='0.55' stroke-linecap='round' mask='url(%23sea)'/>`;
  return s;
}

// a "here be monsters" sea serpent in the antique-engraving idiom: a horned
// dragon head with an open toothy jaw rising on a frilled neck, two scaled
// coils breaching a wavy waterline, and a webbed tail fin. Sepia chart ink.
// Local coords: waterline ~y=0, body above, head at the right.
function serpentArt() {
  const sp = `stroke='${SEPIA}' fill='none' stroke-linecap='round' stroke-linejoin='round'`;
  const spine = [[8, -2], [16, -12], [23, -1], [32, -12], [40, -2], [45, -8], [49, -15]];
  const spk = (x, y, h) => `M${x - 2} ${y} L${x - 3} ${y - h} L${x + 2.5} ${y}`; // swept back
  const frill = [[13, -10, 5], [17, -11.5, 6.5], [20.5, -10, 5], [29, -10, 5], [33, -11.5, 6.5], [36.5, -10, 5], [43, -8, 4.5]].map((s) => spk(...s)).join(' ');
  return (
    // waterline (behind the body)
    `<path d='M-4 1 q3 -2.4 6 0 q3 2.4 6 0 q3 -2.4 6 0' ${sp} stroke-width='0.9' opacity='0.5'/>` +
    `<path d='M26 1 q3 -2.4 6 0 q3 2.4 6 0 q3 -2.4 6 0 q3 -2.4 6 0' ${sp} stroke-width='0.9' opacity='0.5'/>` +
    // tail: a stem + a webbed fan
    `<path d='M8 -2 q-4 0 -6 -7' ${sp} stroke-width='2.4'/>` +
    `<path d='M2 -9 l-3 -6 M2 -9 l1 -7 M2 -9 l5 -5 M2 -9 l6 -2' ${sp} stroke-width='1'/>` +
    `<path d='M-1 -15 q4 1 9 5' ${sp} stroke-width='0.8' opacity='0.7'/>` +
    // body tube (the two coils + neck)
    `<path d='${smooth(spine)}' ${sp} stroke-width='3.8'/>` +
    // swept-back dorsal frill + light scale hatching
    `<path d='${frill}' ${sp} stroke-width='1'/>` +
    `<path d='M13 -9 l3 1 M18 -10 l3 1 M29 -9 l3 1 M34 -10 l3 1' ${sp} stroke-width='0.8' opacity='0.6'/>` +
    // HEAD (filled dragon head): cranium + snout
    `<path d='M47 -14 Q46 -20 50 -21 Q55 -24 60 -21 Q64 -19 62 -16 Q58 -16 55 -15.5 Q51 -14 47 -14 Z' fill='${SEPIA}'/>` +
    // lower jaw (open)
    `<path d='M50 -13 Q54 -11.5 60 -12.2 Q56 -10 51 -10.6 Q49 -11.2 50 -13 Z' fill='${SEPIA}'/>` +
    // teeth (cream) in the open mouth
    `<path d='M55 -15 l0.6 1.5 M58 -15 l0.5 1.5 M60.5 -15.3 l0.4 1.3' stroke='%23e9d9b2' stroke-width='0.7' fill='none' stroke-linecap='round'/>` +
    // eye (cream with a sepia pupil) + swept-back horns
    `<circle cx='51.5' cy='-18' r='1.2' fill='%23e9d9b2'/><circle cx='51.7' cy='-18' r='0.45' fill='${SEPIA}'/>` +
    `<path d='M50 -20 Q47 -25 49 -28 M53 -21 Q52 -26 55 -28' ${sp} stroke-width='1.3'/>`
  );
}
function serpent(x, y, sc, flip) {
  const f = flip ? -1 : 1;
  return `<g transform='translate(${P(x)} ${P(y)}) scale(${P(sc * f)} ${P(sc)})' opacity='0.85'>${serpentArt()}</g>`;
}

function compass(cx, cy, r) {
  const pt = (ang, len, w) => {
    const a = (ang * Math.PI) / 180, a2 = ((ang + 90) * Math.PI) / 180;
    const tx = cx + Math.cos(a) * len, ty = cy + Math.sin(a) * len;
    const bx = cx + Math.cos(a2) * w, by = cy + Math.sin(a2) * w, bx2 = cx - Math.cos(a2) * w, by2 = cy - Math.sin(a2) * w;
    return `M${P(bx)} ${P(by)} L${P(tx)} ${P(ty)} L${P(bx2)} ${P(by2)} Z`;
  };
  // darker + a touch more present than before
  let g = `<g opacity='0.72'><circle cx='${cx}' cy='${cy}' r='${r}' fill='none' stroke='%234a3018' stroke-width='1'/>`;
  g += `<circle cx='${cx}' cy='${cy}' r='${P(r * 0.42)}' fill='none' stroke='%234a3018' stroke-width='0.7'/>`;
  for (const ang of [45, 135, 225, 315]) g += `<path d='${pt(ang, r * 0.7, 2.2)}' fill='%235c4020'/>`;
  for (const ang of [0, 90, 180]) g += `<path d='${pt(ang, r, 2.6)}' fill='%234a3018'/>`;
  g += `<path d='${pt(270, r, 2.6)}' fill='%237a2414'/></g>`;
  return g;
}

function svg() {
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${VB} ${VB}' preserveAspectRatio='xMidYMid slice'>` +
    `<defs><clipPath id='oc'><rect x='0' y='0' width='${VB}' height='${VB}'/></clipPath>` +
    `<filter id='bl' x='-30%' y='-30%' width='160%' height='160%'><feGaussianBlur stdDeviation='9'/></filter>` +
    // sea mask: white everywhere, black over every island's land — so the reef
    // (and any water-only mark) is clipped at the shoreline
    `<mask id='sea'><rect x='0' y='0' width='${VB}' height='${VB}' fill='white'/>` +
    `<path d='${poly(moorea)}' fill='black'/><path d='${poly(tahiti)}' fill='black'/><path d='${poly(maiao)}' fill='black'/></mask></defs>` +
    `<g clip-path='url(%23oc)'>` +
    `<rect x='0' y='0' width='${VB}' height='${VB}' fill='rgba(48,122,184,0.46)'/>` +
    `<ellipse cx='60' cy='150' rx='130' ry='150' fill='rgba(22,80,150,0.22)' filter='url(%23bl)'/>` +
    `<ellipse cx='300' cy='330' rx='120' ry='120' fill='rgba(22,80,150,0.22)' filter='url(%23bl)'/>` +
    `<ellipse cx='150' cy='70' rx='100' ry='90' fill='rgba(70,150,196,0.14)' filter='url(%23bl)'/>` +
    `</g>` +
    island(tahiti, false) +
    island(maiao, false) +
    island(moorea, true) +
    // sea serpents in open ocean (small but visible)
    serpent(26, 44, 0.66, false) +
    serpent(110, 324, 0.74, false) +
    compass(316, 318, 17) +
    `</svg>`
  );
}

const out = svg();
const dataUri = `url("data:image/svg+xml,${out.replace(/\n/g, '').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/#/g, '%23')}")`;

writeFileSync(new URL('./_carto-preview.html', import.meta.url),
  `<!doctype html><meta charset=utf8><style>
   body{margin:0;background:#c9b896;font-family:monospace;color:#4a3420}
   .row{display:flex;gap:24px;flex-wrap:wrap;padding:24px}
   .raw{width:360px;height:360px;background:#cbe2ee;background-image:${dataUri};background-repeat:no-repeat;background-size:contain;background-position:center}
   .board{width:392px;height:392px;background-color:#b8a070;background-image:${dataUri};background-repeat:no-repeat;background-size:cover;background-position:center}
   .title{width:430px;height:620px;background:#c9b896;background-image:${dataUri};background-repeat:no-repeat;background-size:cover;background-position:center}
   .serp{width:420px;height:240px;background:#5a86a8}
  </style>
  <div class=row>
   <div><div>SERPENT (big, on ocean blue)</div>
     <svg class=serp viewBox='-8 -34 78 42'>${serpentArt()}</svg></div>
   <div><div>RAW (full square)</div><div class=raw></div></div>
   <div><div>BOARD (cover)</div><div class=board></div></div>
   <div><div>TITLE (cover)</div><div class=title></div></div>
  </div>`);

console.log('coasts → moorea:', moorea.length, 'tahiti:', tahiti.length, 'maiao:', maiao.length);
console.log('MAP:'); console.log(dataUri);
console.log('bytes=', dataUri.length);

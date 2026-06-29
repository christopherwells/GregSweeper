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
  s += `<path d='${poly(reef)}' fill='none' stroke='${SEPIA}' stroke-width='1' stroke-dasharray='1.5 4' opacity='0.55' stroke-linecap='round'/>`;
  return s;
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
    `<filter id='bl' x='-30%' y='-30%' width='160%' height='160%'><feGaussianBlur stdDeviation='9'/></filter></defs>` +
    `<g clip-path='url(%23oc)'>` +
    `<rect x='0' y='0' width='${VB}' height='${VB}' fill='rgba(48,122,184,0.46)'/>` +
    `<ellipse cx='60' cy='150' rx='130' ry='150' fill='rgba(22,80,150,0.22)' filter='url(%23bl)'/>` +
    `<ellipse cx='300' cy='330' rx='120' ry='120' fill='rgba(22,80,150,0.22)' filter='url(%23bl)'/>` +
    `<ellipse cx='150' cy='70' rx='100' ry='90' fill='rgba(70,150,196,0.14)' filter='url(%23bl)'/>` +
    `</g>` +
    island(tahiti, false) +
    island(maiao, false) +
    island(moorea, true) +
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
  </style>
  <div class=row>
   <div><div>RAW (full square)</div><div class=raw></div></div>
   <div><div>BOARD (cover)</div><div class=board></div></div>
   <div><div>TITLE (cover)</div><div class=title></div></div>
  </div>`);

console.log('coasts → moorea:', moorea.length, 'tahiti:', tahiti.length, 'maiao:', maiao.length);
console.log('MAP:'); console.log(dataUri);
console.log('bytes=', dataUri.length);

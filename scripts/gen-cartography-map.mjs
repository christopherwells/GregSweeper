// Generator for the cartography theme's backdrop: an antique CHART OF MOOREA,
// traced from the island's REAL coastline. Renders it in the theme idiom —
// sepia coastline on a cream volcanic island, a tropical TURQUOISE lagoon ring,
// a barrier REEF (dotted sepia), the deeper OCEAN beyond, and a small compass
// rose. The two deep north bays (Cook's + Ōpūnohu) come straight from the real
// geometry.
//
// Coastline geometry: © OpenStreetMap contributors, ODbL. Fetch the source once
// (it's a ~2 MB file, kept local/untracked — underscore-prefixed):
//   curl -H "User-Agent: GregSweeper-dev (c.wells@bowdoin.edu)" \
//     "https://nominatim.openstreetmap.org/search?format=json&polygon_geojson=1&q=Mo%CA%BBorea" \
//     -o scripts/_moorea.json
// Then:  node scripts/gen-cartography-map.mjs
// Prints the data-URI (--bg-fog-art, reused by the title) + writes a preview.
import { readFileSync, writeFileSync } from 'node:fs';

const SEPIA = '#5c4020';
const VB = 360;           // square canvas
const ISLAND_FIT = 196;   // island longest dim fits this; ocean margin so the
                          // `cover` crop never clips the island on tall phones
const P = (n) => Math.round(n * 10) / 10;

// ── load + project the real coastline ──
const geo = JSON.parse(readFileSync(new URL('./_moorea.json', import.meta.url), 'utf8'));
let ring = geo[0].geojson.coordinates;            // Polygon → first (outer) ring
while (typeof ring[0][0] !== 'number') ring = ring[0]; // unwrap to [ [lon,lat], ... ]

// equirectangular with longitude cos-correction at Moorea's latitude
const lats = ring.map((p) => p[1]), lons = ring.map((p) => p[0]);
const latMid = (Math.min(...lats) + Math.max(...lats)) / 2;
const kx = Math.cos((latMid * Math.PI) / 180);
let pts = ring.map(([lon, lat]) => [lon * kx, lat]);
// bbox in projected space
let xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
let minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
const span = Math.max(maxX - minX, maxY - minY);
const scale = ISLAND_FIT / span;
const offX = (VB - (maxX - minX) * scale) / 2;
const offY = (VB - (maxY - minY) * scale) / 2;
// project to SVG coords (flip y: north = up = smaller svg-y)
pts = pts.map(([x, y]) => [offX + (x - minX) * scale, offY + (maxY - y) * scale]);

// ── Ramer–Douglas–Peucker simplification (iterative, keeps the bays) ──
function rdp(points, eps) {
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const seg = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.hypot(dx, dy) || 1e-9;
    return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L;
  };
  while (stack.length) {
    const [s, e] = stack.pop();
    let dmax = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = seg(points[i], points[s], points[e]);
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax > eps && idx !== -1) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return points.filter((_, i) => keep[i]);
}
// RDP on a CLOSED ring: drop the duplicate closing point, split the loop at the
// point farthest from pts[0], and RDP each arc (the naive ring breaks because
// the start==end base segment is degenerate).
function rdpClosed(points, eps) {
  let p = points.slice();
  if (p.length > 1 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]) p.pop();
  let far = 0, fd = -1;
  for (let i = 1; i < p.length; i++) {
    const d = (p[i][0] - p[0][0]) ** 2 + (p[i][1] - p[0][1]) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const a = rdp(p.slice(0, far + 1), eps);
  const b = rdp(p.slice(far).concat([p[0]]), eps);
  return a.concat(b.slice(1, -1));
}
let coast = rdpClosed(pts, 0.6);
console.log('raw pts:', pts.length, '→ simplified:', coast.length);

// polyline path
const poly = (p) => 'M' + p.map(([x, y]) => `${P(x)} ${P(y)}`).join(' L') + ' Z';

// reef ring: scale the coast outward from the island centroid (stylized barrier reef)
const cx = coast.reduce((s, p) => s + p[0], 0) / coast.length;
const cy = coast.reduce((s, p) => s + p[1], 0) / coast.length;
const reef = coast.map(([x, y]) => [cx + (x - cx) * 1.17, cy + (y - cy) * 1.17]);

function svg() {
  return (
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${VB} ${VB}' preserveAspectRatio='xMidYMid slice'>` +
    `<defs>` +
    `<clipPath id='ocean'><rect x='0' y='0' width='${VB}' height='${VB}'/></clipPath>` +
    `<filter id='bl' x='-30%' y='-30%' width='160%' height='160%'><feGaussianBlur stdDeviation='9'/></filter>` +
    `</defs>` +
    // OCEAN — soft watercolor blue over the whole sheet, with deeper mottles
    `<g clip-path='url(%23ocean)'>` +
    `<rect x='0' y='0' width='${VB}' height='${VB}' fill='rgba(48,122,184,0.46)'/>` +
    `<ellipse cx='64' cy='84' rx='130' ry='130' fill='rgba(22,80,150,0.22)' filter='url(%23bl)'/>` +
    `<ellipse cx='306' cy='312' rx='130' ry='130' fill='rgba(22,80,150,0.22)' filter='url(%23bl)'/>` +
    `<ellipse cx='320' cy='70' rx='90' ry='90' fill='rgba(70,150,196,0.16)' filter='url(%23bl)'/>` +
    `</g>` +
    // LAGOON — the famous tropical TURQUOISE inside the reef ring (reef poly,
    // island knocked out by drawing the land on top); a touch lighter at the
    // reef edge for the shallow-water glow.
    `<path d='${poly(reef)}' fill='rgba(96,200,206,0.62)'/>` +
    `<path d='${poly(reef)}' fill='none' stroke='rgba(150,224,224,0.5)' stroke-width='6' filter='url(%23bl)'/>` +
    // ISLAND — cream volcanic land + sepia coast
    `<path d='${poly(coast)}' fill='%23e9d9b2' stroke='${SEPIA}' stroke-width='1.4' stroke-linejoin='round'/>` +
    // faint interior relief: a couple of hill rings near the center (Mt Tohiea / Rotui)
    `<circle cx='${P(cx)}' cy='${P(cy + 8)}' r='30' fill='none' stroke='${SEPIA}' stroke-width='0.6' opacity='0.3'/>` +
    `<circle cx='${P(cx)}' cy='${P(cy + 8)}' r='16' fill='none' stroke='${SEPIA}' stroke-width='0.6' opacity='0.35'/>` +
    // REEF — dotted sepia ring just off the coast (the barrier reef)
    `<path d='${poly(reef)}' fill='none' stroke='${SEPIA}' stroke-width='1.1' stroke-dasharray='1.5 4' opacity='0.6' stroke-linecap='round'/>` +
    compass(54, 54, 16) +
    `</svg>`
  );
}

function compass(cx, cy, r) {
  const pt = (ang, len, w) => {
    const a = (ang * Math.PI) / 180, a2 = ((ang + 90) * Math.PI) / 180;
    const tx = cx + Math.cos(a) * len, ty = cy + Math.sin(a) * len;
    const bx = cx + Math.cos(a2) * w, by = cy + Math.sin(a2) * w;
    const bx2 = cx - Math.cos(a2) * w, by2 = cy - Math.sin(a2) * w;
    return `M${P(bx)} ${P(by)} L${P(tx)} ${P(ty)} L${P(bx2)} ${P(by2)} Z`;
  };
  let g = `<g opacity='0.5'><circle cx='${cx}' cy='${cy}' r='${r}' fill='none' stroke='${SEPIA}' stroke-width='0.8'/>`;
  for (const ang of [45, 135, 225, 315]) g += `<path d='${pt(ang, r * 0.7, 2)}' fill='%236a4a26' opacity='0.5'/>`;
  for (const ang of [0, 90, 180]) g += `<path d='${pt(ang, r, 2.3)}' fill='${SEPIA}'/>`;
  g += `<path d='${pt(270, r, 2.3)}' fill='%238a3020'/></g>`;
  return g;
}

const out = svg();
const dataUri = `url("data:image/svg+xml,${out.replace(/\n/g, '').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/#/g, '%23')}")`;

writeFileSync(new URL('./_carto-preview.html', import.meta.url),
  `<!doctype html><meta charset=utf8><style>
   body{margin:0;background:#c9b896;font-family:monospace;color:#4a3420}
   .row{display:flex;gap:24px;flex-wrap:wrap;padding:24px}
   .board{width:392px;height:392px;background-color:#b8a070;background-image:${dataUri};background-repeat:no-repeat;background-size:cover;background-position:center}
   .title{width:430px;height:620px;background:#c9b896;background-image:${dataUri};background-repeat:no-repeat;background-size:cover;background-position:center}
   .raw{width:360px;height:360px;background:#cbe2ee;background-image:${dataUri};background-repeat:no-repeat;background-size:contain;background-position:center}
  </style>
  <div class=row>
   <div><div>RAW (contain — true Moorea shape)</div><div class=raw></div></div>
   <div><div>BOARD (cover)</div><div class=board></div></div>
   <div><div>TITLE (cover)</div><div class=title></div></div>
  </div>`);

console.log('MAP:'); console.log(dataUri);
console.log('\nbytes=', dataUri.length);

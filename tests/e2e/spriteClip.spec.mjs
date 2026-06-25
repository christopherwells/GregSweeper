import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, relative } from 'path';

// Clip guard (the regression test for the 2026-06-25 re-frame). Sixteen Greg
// sprites — including the shipped a7b master — drew their clipboard/pencil a
// few units past the original 0 0 128 128 viewBox, so the art was cut at the
// frame. Christopher caught it twice by eye. This sweep measures every shipped
// sprite's STROKE-ACCURATE painted bounds (getBoundingClientRect mapped back
// to user units via the SVG's screen CTM, so transforms + stroke are included)
// against its viewBox and fails on any art that spills out. Needs a browser to
// measure real paint, so it lives in the e2e suite, not the node gate.
//
// Archived exploration candidates (greg/_exploration/) are excluded — they are
// not shipped and are not held to the frame contract.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPRITES = join(__dirname, '..', '..', 'assets', 'sprites');
const TOL = 0.5; // user units; a sub-unit overhang is anti-aliasing, not a clip

function collect(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === '_exploration') continue;
      collect(join(dir, e.name), acc);
    } else if (e.name.endsWith('.svg')) {
      acc.push(join(dir, e.name));
    }
  }
  return acc;
}

test('no shipped sprite SVG clips its own viewBox', async ({ page }) => {
  await page.setContent('<!doctype html><meta charset="utf8"><body style="margin:0"><div id="box" style="position:absolute;left:350px;top:350px"></div></body>');
  const files = collect(SPRITES);
  expect(files.length, 'expected to find sprite SVGs to sweep').toBeGreaterThan(50);
  const offenders = [];
  for (const f of files) {
    const svg = readFileSync(f, 'utf8');
    const res = await page.evaluate((t) => {
      const box = document.getElementById('box');
      box.innerHTML = t;
      const s = box.querySelector('svg');
      if (!s || !s.viewBox || !s.viewBox.baseVal) return null;
      const vb = s.viewBox.baseVal;
      s.setAttribute('width', vb.width);
      s.setAttribute('height', vb.height);
      s.style.overflow = 'visible';
      const ctm = s.getScreenCTM();
      if (!ctm) return null;
      const inv = ctm.inverse();
      const toU = (x, y) => { const p = s.createSVGPoint(); p.x = x; p.y = y; const u = p.matrixTransform(inv); return [u.x, u.y]; };
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      s.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon,text').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        const [x0, y0] = toU(r.left, r.top), [x1, y1] = toU(r.right, r.bottom);
        minX = Math.min(minX, x0, x1); maxX = Math.max(maxX, x0, x1);
        minY = Math.min(minY, y0, y1); maxY = Math.max(maxY, y0, y1);
      });
      return { vx: vb.x, vy: vb.y, vw: vb.width, vh: vb.height, minX, minY, maxX, maxY };
    }, svg);
    if (!res) continue;
    const clip = Math.max(
      res.vx - res.minX,
      res.vy - res.minY,
      res.maxX - (res.vx + res.vw),
      res.maxY - (res.vy + res.vh),
    );
    if (clip > TOL) offenders.push(`${relative(SPRITES, f).replace(/\\/g, '/')} clips ${clip.toFixed(1)}u`);
  }
  expect(offenders, `sprite art spilling past its viewBox (widen the viewBox):\n${offenders.join('\n')}`).toEqual([]);
});

// `scrolled` in the fit: the gate, and where the term is allowed to ride.
//
// The field says the board did not fit the view while it was played, and it
// exists to give the fit the one cost no row has ever carried: the time spent
// TRAVELLING a board rather than thinking about it. The marathon lane and the
// Challenge scroll opt-in exist to collect it.
//
// WHY THIS IS A SOURCE SCAN rather than a fixture run. The pipeline smoke
// replays the whole R script over a committed production sample, and no such
// sample can reach the POOLED path: the census on 2026-08-22 found 10 true
// rows against a threshold of 20, and all 10 come from 5 distinct boards
// played by 2 people. So the fixture can only ever exercise the held-out
// branch, and a green smoke would say nothing about the branch that matters.
// This is the same transient-regime problem the empty-coverage sort has, and
// it takes the same answer: pin the decision in the source until the data
// regime can reach it.
//
// Run: node --test test/scrollFitGate.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// NORMALIZED at the read. A Windows checkout carries CRLF, and every
// newline-anchored pattern below then matches nothing while still reporting a
// clean "not found" — a scan that cannot fail for the reason it claims. Found
// the hard way on 2026-08-22: these assertions passed on an LF working tree
// and failed the moment the file was checked out fresh.
const R = readFileSync(new URL('../scripts/refit-par-model.R', import.meta.url), 'utf8')
  .split('\r\n').join('\n');
test('the scroll gate mirrors the match gate: accumulate, then pool at the threshold', () => {
  const m = R.match(/SCROLL_FIT_THRESHOLD\s*<-\s*(\d+)/);
  assert.ok(m, 'SCROLL_FIT_THRESHOLD must exist');
  const scroll = Number(m[1]);
  const match = Number(R.match(/MATCH_FIT_THRESHOLD\s*<-\s*(\d+)/)[1]);
  assert.equal(scroll, match,
    'a row-level offset waits the same number of rows however it arose');

  // Held out ENTIRELY below the line, so no board coefficient moves on an
  // offset nobody has measured. These are also the largest boards in the
  // frame, so the cost would land on the size curve if it landed anywhere.
  assert.match(R, /pool_scroll\s*<-\s*n_scroll\s*>=\s*SCROLL_FIT_THRESHOLD/);
  assert.match(R, /if\s*\(!pool_scroll\)\s*\{[\s\S]{0,120}filter\(scrollPlay\s*==\s*0\)/,
    'below the threshold the rows must be filtered out, not merely unmodelled');
});

test('scrollPlay rides the SIGNED nlpar, never the bounded base block', () => {
  // The base block's lb = 0 is a real claim about BOARD FEATURES: par cannot
  // decrease in any of them. scrollPlay is not a board feature, it is a row
  // indicator whose sign nobody knows (travel makes a big board slower; a
  // board big enough to need scrolling is often sparse and quick per cell).
  // Bounded, the posterior would pile up at zero and the effect would leak
  // into the size curve.
  const devLine = R.match(/dev_cols\s*<-\s*c\(([\s\S]{0,400}?)\)\n/);
  assert.ok(devLine, 'dev_cols assignment not found');
  assert.match(devLine[1], /scrollPlay/, 'scrollPlay must be a dev (signed) column');

  // And it must NOT reach the bounded base block. BASE_MODEL_FEATURES is
  // DERIVED from COEF_TO_PREDICTOR (the shipped coefficient -> predictor map),
  // so that map is the thing to check: anything in it is a board feature
  // carrying lb = 0, and anything shipped to predictPar.
  const coefMap = R.match(/COEF_TO_PREDICTOR <- c\(([\s\S]*?)^\)/m);
  assert.ok(coefMap, 'COEF_TO_PREDICTOR not found');
  assert.ok(!/scrollPlay|scrolled/.test(coefMap[1]),
    'scrollPlay must never be a bounded base feature, nor ship to predictPar');
  // NON-VACUITY: that map must actually be populated, or the absence is free.
  assert.ok(coefMap[1].split(/\r?\n/).filter((l) => l.includes('=')).length > 5,
    'COEF_TO_PREDICTOR looks empty; the scan found the wrong block');

  // NON-VACUITY: the dev list must also carry the term this one was modelled
  // on, or the scan could be matching an empty or unrelated block.
  assert.match(devLine[1], /matchPlay/,
    'dev_cols should carry matchPlay too; if not, this scan found the wrong block');
});

test('the row parser reads `scrolled`, INCLUDING in the typed empty tibble', () => {
  // The empty-node branch returns a typed 0-row tibble, and bind_rows unions
  // columns: a field missing from that branch silently disappears whenever a
  // node comes back empty, which is the quiet-failure shape this file already
  // has form for.
  assert.match(R, /scrolled\s*=\s*map_lgl\(entry,\s*~\s*isTRUE\(\.x\$scrolled\)\)/,
    'the parser must extract scrolled from each row');
  const empty = R.slice(R.indexOf('parse_score_rows <- function'), R.indexOf('tibble(\n    date'));
  assert.match(empty, /scrolled\s*=\s*logical\(\)/,
    'the typed 0-row tibble must declare scrolled, or bind_rows drops it');
});

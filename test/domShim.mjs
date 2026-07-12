// Rich headless DOM shim for node tests that CALL into DOM-coupled modules
// (not just import them — that's importSmoke's lighter concern). Import this
// for its side effects BEFORE dynamically importing the module under test.
// Same proxy pattern as importSmoke/persistRoundTrip: every element property
// access returns a chainable no-op, so render helpers no-op instead of throw.

function stubStyle() {
  return new Proxy({ setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {} }, {
    get(t, p) { return p in t ? t[p] : ''; },
    set() { return true; },
  });
}

export function stubEl() {
  return new Proxy(function () {}, {
    get(_t, prop) {
      switch (prop) {
        case 'style': return stubStyle();
        case 'dataset': return {};
        case 'classList': return { add() {}, remove() {}, toggle() {}, replace() {}, contains() { return false; } };
        case 'children': case 'childNodes':
          // Array-like: length 0 for loops, a stub element for direct [idx]
          // access so per-cell render helpers can no-op through it.
          return new Proxy([], { get(t, p) { return p in t ? t[p] : stubEl(); } });
        case 'length': return 0;
        case 'value': case 'textContent': case 'innerHTML': case 'innerText':
        case 'className': case 'id': case 'tagName': case 'nodeName': return '';
        case 'parentNode': case 'parentElement': case 'nextSibling':
        case 'previousSibling': case 'firstChild': case 'lastChild': return null;
        case 'getContext': return () => stubEl();
        case 'getBoundingClientRect':
          return () => ({ x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 });
        case 'querySelector': case 'closest': return () => null;
        case 'querySelectorAll': case 'getElementsByClassName': case 'getElementsByTagName': return () => [];
        case 'then': return undefined;
        case Symbol.toPrimitive: return () => '';
        case Symbol.iterator: return [][Symbol.iterator].bind([]);
        default: return () => stubEl();
      }
    },
    apply() { return stubEl(); },
  });
}

if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    key: (i) => Array.from(store.keys())[i] ?? null,
    clear: () => store.clear(),
    get length() { return store.size; },
  };
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    documentElement: stubEl(), body: stubEl(), head: stubEl(),
    createElement: () => stubEl(), createElementNS: () => stubEl(),
    createDocumentFragment: () => stubEl(), createTextNode: () => stubEl(),
    getElementById: () => stubEl(), querySelector: () => stubEl(),
    querySelectorAll: () => [], getElementsByClassName: () => [], getElementsByTagName: () => [],
    addEventListener() {}, removeEventListener() {},
    cookie: '', visibilityState: 'visible', hidden: false,
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    location: { search: '', hostname: 'localhost', pathname: '/', href: 'http://localhost/', origin: 'http://localhost' },
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    devicePixelRatio: 1, innerWidth: 800, innerHeight: 600,
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
}
if (typeof globalThis.navigator === 'undefined') {
  globalThis.navigator = { userAgent: 'node', platform: 'node', maxTouchPoints: 0, language: 'en-US', onLine: true };
}
if (typeof globalThis.location === 'undefined') globalThis.location = globalThis.window.location;
if (typeof globalThis.requestAnimationFrame === 'undefined') globalThis.requestAnimationFrame = () => 0;
if (typeof globalThis.getComputedStyle === 'undefined') globalThis.getComputedStyle = () => stubStyle();
if (typeof globalThis.matchMedia === 'undefined') globalThis.matchMedia = globalThis.window.matchMedia;

// Small board builder matching the live cell shape the render/effects
// paths read.
export function makeStateBoard(rows, cols, mineCoords = []) {
  const mines = new Set(mineCoords.map(([r, c]) => `${r},${c}`));
  const board = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      row.push({
        row: r, col: c,
        isMine: mines.has(`${r},${c}`), adjacentMines: 0,
        isRevealed: false, isFlagged: false, isStrike: false,
        isLocked: false, isMystery: false,
      });
    }
    board.push(row);
  }
  return board;
}

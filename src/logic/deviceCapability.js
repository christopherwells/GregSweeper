// Device-capability probes for gating GPU-heavy frills.
//
// The per-frame theme particle effects (themeEffects.js) are cheap on a real
// GPU but stutter badly when the browser composites in SOFTWARE — integrated
// setups, a remote/VM session, or a GPU-driver fallback (which can hit even a
// strong card: a player on an RTX 2080 Ti whose Chrome had dropped to the
// "Microsoft Basic Render Driver" saw every modal and animation chug). We'd
// rather quietly drop the live particles for those users than have the game
// feel broken. The theme keeps its colors, sprites, and static backdrop.

// Pure: does this WebGL UNMASKED_RENDERER string name a software rasterizer?
// Conservative by design — an empty/unknown string (some browsers block the
// debug extension for privacy) returns false, so we only disable effects when
// we are SURE the renderer is software, never on a mere absence of info.
export function isSoftwareRenderer(rendererString) {
  return /swiftshader|basic render|software|llvmpipe/i.test(String(rendererString || ''));
}

// DOM probe, cached for the session (the renderer can't change mid-session).
// True when WebGL reports a software rasterizer OR there is no WebGL context at
// all (no GPU path). Safe to call anywhere; returns false outside a browser.
let _cached = null;
export function isSoftwareRendering() {
  if (_cached !== null) return _cached;
  try {
    if (typeof document === 'undefined') { _cached = false; return false; }
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) { _cached = true; return true; }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
    _cached = isSoftwareRenderer(renderer);
  } catch {
    _cached = true; // a thrown WebGL probe means no usable GPU path
  }
  return _cached;
}

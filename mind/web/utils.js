// Shared helpers: color/texture/geometry math. Pure functions only — no dependency on three.js instances.

export const SOURCE_COLORS = {
  session: 0x2dd4bf,
  arxiv: 0xa78bfa,
  rss: 0xfb923c,
  manual: 0xe5e7eb,
};
export const FALLBACK_SOURCE_COLOR = 0x94a3b8;
export const ACCENT_COLOR = 0xfbbf24;

export function sourceColor(sourceType) {
  return SOURCE_COLORS[sourceType] ?? FALLBACK_SOURCE_COLOR;
}

// Golden-angle rotation to produce visually even color spread regardless of cluster count.
export function clusterHue(index) {
  const hue = (index * 137.508) % 360;
  return hslToHex(hue, 0.62, 0.56);
}

export function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const R = Math.round((r + m) * 255);
  const G = Math.round((g + m) * 255);
  const B = Math.round((b + m) * 255);
  return (R << 16) | (G << 8) | B;
}

export function hexToCss(hex) {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Deterministic hash (FNV-1a variant) that folds a string into a 32-bit integer. Used as a seed instead of Math.random so position/size can be derived reproducibly.
export function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32 PRNG — takes the integer from hashSeed as a seed and generates a deterministic [0,1) random sequence.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Convenience helper to get a deterministic random function directly from a string seed (e.g. seededRandom(cluster.slug)).
export function seededRandom(seedStr) {
  return mulberry32(hashSeed(seedStr));
}

// Builds the midpoint control point of a gently bulging arc between two points (for three.QuadraticBezierCurve3).
export function arcMidpoint(a, b, bulge = 0.16) {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const mz = (a[2] + b[2]) / 2;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  // Cross with an arbitrary axis to get a direction perpendicular to the segment.
  let px = dy * 1 - dz * 0;
  let py = dz * 0 - dx * 1;
  let pz = dx * 0 - dy * 0;
  let pl = Math.sqrt(px * px + py * py + pz * pz);
  if (pl < 1e-4) {
    px = 1; py = 0; pz = 0;
    pl = 1;
  }
  const scale = (dist * bulge) / pl;
  return [mx + px * scale, my + py * scale, mz + pz * scale];
}

// Builds a radial-gradient canvas texture at runtime for use as a sprite glow (no external image requests).
export function makeGlowCanvas(hexColor, size = 128) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const r = (hexColor >> 16) & 0xff;
  const g = (hexColor >> 8) & 0xff;
  const b = hexColor & 0xff;
  const grd = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, `rgba(${r},${g},${b},0.95)`);
  grd.addColorStop(0.35, `rgba(${r},${g},${b},0.45)`);
  grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

export function formatOrigin(origin) {
  if (!origin) return '—';
  if (origin.length <= 64) return origin;
  return `…${origin.slice(-61)}`;
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

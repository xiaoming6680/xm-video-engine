// Global post-processing: bloom + halation, chromatic aberration, tone shoulder,
// film grain, vignette, fades/flash, retro and print looks (CRT, VHS, glitch, pixel/palette, Riso, paper).
// Operates on the composited HDR (linear) frame.
// Every look is off by default (DEFAULT_POST): a scene comes out as drawn until it asks for bloom, grain, a shoulder …
import * as THREE from 'three';
import { FSPass, makeRT, W, H, SCALE } from './gl';

/**
 * The tone shoulders (linear HDR -> 0..1 linear), shared with the engine's sampling error estimate.
 * shoulder(): per channel (pdoom's); shoulderMax(): by the brightest channel, keeping the hue.
 */
export const SHOULDER_GLSL = /* glsl */ `
vec3 shoulder(vec3 x) {
  // identity below k, smooth exponential shoulder above; very bright values desaturate toward white
  const float k = 0.72;
  vec3 y = mix(x, k + (1.0 - k) * (1.0 - exp(-(x - k) / (1.0 - k))), step(k, x));
  float over = max(max(x.r, x.g), x.b);
  return mix(y, vec3(1.0), smoothstep(2.0, 12.0, over) * 0.85);
}
vec3 shoulderMax(vec3 x) {
  // the same curve on the brightest channel, the others scaled with it: a hot pink stays pink instead of drifting
  // toward magenta (per channel, the bright channels flatten while the dim one keeps climbing); very bright values
  // still go to white, from 1x to 6x (参考 mg-styles-15 demos/07-liquid/js/shaders.js tonemap (MIT))
  const float k = 0.72;
  float m = max(max(x.r, x.g), x.b);
  if (m <= k) return x;
  float mt = k + (1.0 - k) * (1.0 - exp(-(m - k) / (1.0 - k)));
  return mix(x * (mt / m), vec3(mt), smoothstep(1.0, 6.0, m) * 0.85);
}`;

export interface PostParams {
  exposure: number;
  bloom: number; // bloom strength
  bloomThreshold: number; // linear luminance where bloom starts
  bloomKnee: number; // soft knee width
  bloomRadius: number; // 0..1 upsample spread
  halation: number; // red-orange film halation around highlights
  ca: number; // chromatic aberration in px at the frame edge
  grain: number; // grain amplitude (sRGB units), ~0.04-0.1
  vignette: number; // 0..1
  hud: number; // HUD opacity multiplier
  /** Corner credit opacity 0..1 (hud.ts). Off: the credit lives inside the scenes (docs/TREATMENT.md, 署名). */
  watermark: number;
  /** 0..1: the frame is light — the HUD switches to dark ink. */
  paper: number;
  fade: number; // fade to black 0..1
  flash: number; // additive bone-white flash 0..1+
  shake: [number, number]; // frame offset in px
  zoom: number; // frame zoom (1 = none), for punch-ins on hits
  invert: number; // 0..1 invert (ink <-> bone), applied before grain
  /** Fisheye (barrel) strength k, 0 = none. The scene must render a field widened to match: tan(fov'/2) =
   * tan(fov/2) * (1 + k * FISHEYE_R2) (see fisheyeFov) — then the middle keeps its size and the edges bend. */
  fisheye: number;
  /** Radial (zoom) blur toward the middle: the fraction of the radius smeared, 0 = none. */
  radial: number;
  /** 0..1 film grade of the picture (not the HUD): a little log contrast, cool shadows, warm highlights. */
  grade: number;
  /** 0..1 soft highlight roll-off (pdoom's filmic shoulder: above ~0.72 linear compresses, white lands near 242/255).
   * 0 = none: what the scene draws comes out as drawn, white is white. Scenes with glowing HDR values want ~1. */
  shoulder: number;
  /** How the shoulder compresses: 1 = by the brightest channel (keeps the hue: a hot pink or purple stays itself,
   *  white from ~1x to 6x), 0 = each channel on its own (pdoom's, PDOOM_LOOK: saturated highlights drift toward
   *  magenta / yellow), in between = a mix. */
  shoulderHue: number;
  // ---- retro / signal looks (all off by default; see docs/模块目录.md) ----
  /** CRT tube 0..1: curved glass, scanlines, RGB grille, flicker, a rounded black bezel. The HUD is on the glass too. */
  crt: number;
  /** CRT barrel curvature (0 = flat glass), scaled by crt. */
  crtCurve: number;
  /** CRT scanlines over the frame height (270 = one every 4 px at 1080). */
  crtLines: number;
  /** CRT power: 0 = on; 0 -> 1 switches it off (the picture squeezes into a bright line, then a dot that fades).
   *  Run it 1 -> 0 to switch the tube on. Works without crt (a flat screen switching off). */
  crtOff: number;
  /** CRT signal noise 0..1: snow, jittering rows, a rolling dark bar (an untuned or dying signal). */
  crtNoise: number;
  /** Digital glitch 0..1: displaced slices and blocks, torn rows, channel split, swapped channels. New pattern every frame. */
  glitch: number;
  /** Seed for the glitch pattern (two shots with the same frames but different seeds tear differently). */
  glitchSeed: number;
  /** Pixel-sort streaks 0..1: a few column bands smear down from a random row (the torn 3D box look). New every frame. */
  glitchSort: number;
  /** VHS tape 0..1: wobbling rows, a rolling tracking band, smeared and shifted chroma, head-switch noise at the bottom. */
  vhs: number;
  /** VHS red bleed 0..1: red trails to the right of saturated reds and pinks (~10 px). Works with or without vhs. */
  vhsBleed: number;
  /** VHS line tears 0..1: the share of frames on which a few whole rows (6–20 px bands) are shoved 8–40 px sideways.
   *  ~0.1 = now and then; 1 on a single frame = a tear on that hit. Works with or without vhs. */
  vhsTear: number;
  /** Impact frame 0..1: hard black and white on display luminance (bwThreshold). With invert: 1 it is the inverted kind. */
  bw: number;
  bwThreshold: number;
  /** Pixelate: block size in logical px (0 or 1 = off). Bloom stays smooth over the blocks (the Hi-bit look). */
  pixel: number;
  /** Colour levels per channel with 4x4 ordered dither per block (0 = off): 2–8 for 8-bit palettes. */
  pixelLevels: number;
  /** A fixed palette (up to 32 '#rrggbb'; empty = off): every pixel (every block with pixel) becomes one of these
   *  colours, the two nearest in OKLab picked by a 4x4 Bayer threshold. The colours come out exact (no 8-bit dither on
   *  top), unless grain, VHS or CRT are on as well (they act after it). Arrays don't pass through ?post=. */
  palette: string[];
  /** 0..1 how much the palette dithers between its two nearest colours (0 = flat posterize to the nearest). */
  paletteDither: number;
  /** 0..1 dark gaps between pixel blocks (dot-matrix LCD); needs pixel >= 3. */
  pixelGrid: number;
  /** Letterbox: the fraction of the frame height covered by the black bars (top + bottom), e.g. 0.25. */
  letterbox: number;
  /** CRT phosphor persistence 0..1 (0 = off): the fraction of a pixel's light left one 60 Hz refresh later (colour
   *  tubes ~0.3, a long green P1 ~0.6). A bright thing that moves leaves fading copies at the previous refreshes; a
   *  bright pixel that goes dark lags, a dark one lights at once; blue fades fastest. The engine renders the frame at
   *  t − 1/60, t − 2/60 … for it (Engine.render), so it stays a pure function of t (stateless scenes only). Works
   *  with or without crt. */
  phosphor: number;
  /** Riso print 0..1: the frame separated into spot inks, each a halftone screen at its own angle, mis-registered
   *  a little, printed on paper (the HUD stays clean). */
  riso: number;
  /** Riso halftone cell (logical px). */
  risoDot: number;
  /** Riso mis-registration between the ink layers (logical px). Animate it: apart between the hits, in register on
   *  the hit (risoDrift). */
  risoShift: number;
  /** Riso inks (RISO_INKS): 0 fluorescent pink + blue + yellow, 1 fluorescent pink + blue, 2 red + teal + yellow, 3 purple + fluorescent pink. */
  risoInks: number;
  /** Each Riso plate's mis-registration direction, times risoShift (px): ink 0, 1, 2. */
  risoPlates: [number, number][];
  /** Riso trap (logical px, 0 = none; ~2.5): every plate spreads this far, so mis-registered plates overlap at their
   *  edges instead of opening a line of bare paper. */
  risoTrap: number;
  /** Riso rough edges 0..1: the plates print through a fixed noise displacement (1 = 1.3 px + 0.35 px layers), so
   *  edges and dots are ragged like a real stencil. */
  risoRough: number;
  /** Riso ink density (1 = solid ink; 0.8 = thin ink, the paper shows through; overprints multiply either way). */
  risoDensity: number;
  /** 0..1 Riso without the screen: 0 = halftone dots everywhere (flat fills too), 1 = each plate prints its coverage
   *  as solid ink (flat fills flat, soft tones as thinner ink: the screen-printed poster look, with risoTrap and risoRough). */
  risoSolid: number;
  /** Paper texture 0..1+ (0 = off): a real paper scan (public/textures/paper001.jpg, high-passed) multiplied into the
   *  frame, more in the lights (1 ≈ 2.2 % deviation on white). The scene's init should `await loadPaper()`. */
  paperTex: number;
  /** How often the paper moves to another patch of the sheet, per second (12 = on twos; 0 = it stays put). */
  paperStep: number;
}

/** Riso ink sets (sRGB hex): the paper, then 2–3 inks. */
export const RISO_INKS: { paper: string; inks: string[] }[] = [
  { paper: '#F4EFE6', inks: ['#FF48B0', '#0078BF', '#FFE800'] },
  { paper: '#F4EFE6', inks: ['#FF48B0', '#0078BF'] },
  { paper: '#F2ECE0', inks: ['#F15060', '#00838A', '#FFE800'] },
  { paper: '#F4EFE6', inks: ['#765BA7', '#FF48B0'] },
];

export const DEFAULT_POST: PostParams = {
  exposure: 1,
  bloom: 0,
  bloomThreshold: 0.85,
  bloomKnee: 0.5,
  bloomRadius: 0.75,
  halation: 0,
  ca: 0,
  grain: 0,
  vignette: 0,
  hud: 1,
  watermark: 0,
  paper: 0,
  fade: 0,
  flash: 0,
  shake: [0, 0],
  zoom: 1,
  invert: 0,
  grade: 0,
  shoulder: 0,
  shoulderHue: 1,
  fisheye: 0,
  radial: 0,
  crt: 0,
  crtCurve: 0.12,
  crtLines: 270,
  crtOff: 0,
  crtNoise: 0,
  glitch: 0,
  glitchSeed: 0,
  glitchSort: 0,
  vhs: 0,
  vhsBleed: 0,
  vhsTear: 0,
  bw: 0,
  bwThreshold: 0.3,
  pixel: 0,
  pixelLevels: 0,
  pixelGrid: 0,
  palette: [],
  paletteDither: 1,
  letterbox: 0,
  phosphor: 0,
  riso: 0,
  risoDot: 7,
  risoShift: 3,
  risoInks: 0,
  risoPlates: [[1, 0.4], [-0.6, -0.8], [0.2, 1]],
  risoTrap: 0,
  risoRough: 0,
  risoDensity: 1,
  risoSolid: 0,
  paperTex: 0,
  paperStep: 12,
};

/** The old defaults (pdoom's film look: bloom, halation, fringes, grain, vignette, the highlight shoulder). Opt in per entry
 * (`{ …, post: PDOOM_LOOK }` in timeline.ts) or per scene (`return { ...PDOOM_LOOK, bloom: 0.8 }`); the effects library's demos use it. */
export const PDOOM_LOOK: Partial<PostParams> = { bloom: 0.55, halation: 0.25, ca: 1.2, grain: 0.055, vignette: 0.35, shoulder: 1, shoulderHue: 0 };

/** The numeric retro / print post parameters, passed through as float uniforms (uniform names = PostParams keys). */
const RETRO = ['crt', 'crtCurve', 'crtLines', 'crtOff', 'crtNoise', 'glitch', 'glitchSeed', 'glitchSort', 'vhs', 'vhsBleed', 'vhsTear', 'bw', 'bwThreshold', 'pixel', 'pixelLevels', 'pixelGrid', 'paletteDither', 'letterbox', 'riso', 'risoDot', 'risoShift', 'risoTrap', 'risoRough', 'risoDensity', 'risoSolid', 'paperStep'] as const;

/**
 * Riso registration that drifts and snaps, for risoShift (px): the plates come into register on each hit (`min`) and
 * drift apart until the next one (ease-in, up to `max`); before the first hit they are apart. `hits`: ascending times
 * (audio.downbeats, a section's accents). A pure function of t. (参考 mg-styles-15 demos/09-bauhaus/film.js registration (MIT))
 *   return { riso: 1, risoShift: risoDrift(f.t, this.ctx.audio.downbeats, 4) };
 */
export function risoDrift(t: number, hits: readonly number[], max = 3.5, min = 0.15): number {
  let i = -1;
  for (let lo = 0, hi = hits.length - 1; lo <= hi;) { const m = (lo + hi) >> 1; if (hits[m]! <= t) { i = m; lo = m + 1; } else hi = m - 1; }
  if (i < 0) return max;
  // after the last hit: the gap before it again (2 s with a single hit)
  const t0 = hits[i]!, t1 = hits[i + 1] ?? t0 + (i > 0 ? t0 - hits[i - 1]! : 2);
  const u = Math.min(1, (t - t0) / Math.max(t1 - t0, 1e-6));
  return min + (max - min) * u * u;
}

const hex3 = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);

/** At most this many palette colours (the shader's uniform arrays). */
export const PALETTE_MAX = 32;
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** OKLab (Björn Ottosson) of a linear sRGB colour; the shader's oklab() is the same. */
export function oklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
/** A palette as the shader wants it: the valid '#rrggbb' / '#rgb' entries (others skipped, at most PALETTE_MAX), sRGB 0..1 and OKLab. */
export function paletteSet(pal: unknown): { rgb: [number, number, number][]; lab: [number, number, number][] } {
  const rgb: [number, number, number][] = [];
  for (const h of Array.isArray(pal) ? pal : []) {
    if (typeof h !== 'string' || rgb.length >= PALETTE_MAX) continue;
    const x = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(h.trim())?.[1];
    if (!x) continue;
    const six = x.length === 3 ? [...x].map((c) => c + c).join('') : x;
    rgb.push(hex3(`#${six}`) as [number, number, number]);
  }
  return { rgb, lab: rgb.map((c) => oklab(srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]))) };
}

// ---- paper texture (paperTex) ----
/** The paper scan (CC0, public/textures/README.md). Only its left 90 % is used: the right edge has show-through marks. */
const PAPER_URL = 'textures/paper001.jpg', PAPER_CLEAN_W = 0.9;
/** Scan texels per logical px: 4096 over 2304 px, the scale mg-styles-15 demos/08-morph prints it at. */
const PAPER_K = 4096 / 2304;
/** High-pass radius (logical px): the scan's shading goes, its tooth and fibres stay. */
const PAPER_HP = 24;
/** The high-passed paper in the R8 texture: 128 + n * PAPER_Q, n in standard deviations (clamped at ±2.7). */
const PAPER_Q = 45;
interface PaperMap { tex: THREE.DataTexture; size: [number, number]; k: number; slack: [number, number]; rot: boolean }
let paper: PaperMap | null = null;
let paperLoad: Promise<boolean> | null = null;

/** Box blur (radius r texels, edges clamped) along rows then columns: running sums, O(n). */
function boxBlur(a: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(a.length), out = new Float32Array(a.length), n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let s = 0;
    for (let i = -r; i <= r; i++) s += a[o + Math.min(w - 1, Math.max(0, i))]!;
    for (let x = 0; x < w; x++) {
      tmp[o + x] = s / n;
      s += a[o + Math.min(w - 1, x + r + 1)]! - a[o + Math.max(0, x - r)]!;
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += tmp[Math.min(h - 1, Math.max(0, i)) * w + x]!;
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / n;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x]! - tmp[Math.max(0, y - r) * w + x]!;
    }
  }
  return out;
}
/** Luma of RGBA bytes, high-passed (minus a box blur of radius r): the paper's tooth around 0. */
export function paperHighPass(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, r: number): Float32Array {
  const L = new Float32Array(w * h);
  for (let i = 0; i < L.length; i++) L[i] = rgba[i * 4]! * 0.3 + rgba[i * 4 + 1]! * 0.59 + rgba[i * 4 + 2]! * 0.11;
  const lo = boxBlur(L, w, h, Math.max(1, Math.round(r)));
  for (let i = 0; i < L.length; i++) L[i]! -= lo[i]!;
  return L;
}
const stdDev = (a: Float32Array) => { let s = 0, q = 0; for (const v of a) { s += v; q += v * v; } const m = s / a.length; return Math.sqrt(Math.max(q / a.length - m * m, 1e-12)); };

/** The scan drawn at `d` x its size (the clean part), as RGBA bytes. */
function drawScan(img: ImageBitmap, sw: number, sh: number, d: number) {
  const w = Math.max(1, Math.round(sw * d)), h = Math.max(1, Math.round(sh * d));
  const cv = new OffscreenCanvas(w, h), c = cv.getContext('2d', { willReadFrequently: true })!;
  c.imageSmoothingQuality = 'high';
  c.drawImage(img, 0, 0, sw, sh, 0, 0, w, h);
  return { w, h, rgba: c.getImageData(0, 0, w, h).data };
}

function buildPaper(img: ImageBitmap): PaperMap {
  const sw = Math.floor(img.width * PAPER_CLEAN_W), sh = img.height;
  // a portrait frame on a landscape scan (or the other way) reads the sheet turned
  const rot = (H > W) !== (sh > sw), fw = rot ? H : W, fh = rot ? W : H;
  // scan texels per logical px: the reference scale, or less if the frame plus some room to move would not fit
  const k = Math.min(PAPER_K, (0.85 * sw) / fw, (0.85 * sh) / fh);
  // the texture: about one texel per physical px (the full scan at 4K)
  const d = Math.min(1, SCALE / k);
  const full = drawScan(img, sw, sh, d);
  const hp = paperHighPass(full.rgba, full.w, full.h, PAPER_HP * k * d);
  // normalised by the deviation at the logical scale (one texel per logical px, what 1x shows), so a 4K render
  // downscaled has the paper a 1x render has
  const d1 = Math.min(1, 1 / k);
  const sigma = d1 === d ? stdDev(hp) : (() => { const s = drawScan(img, sw, sh, d1); return stdDev(paperHighPass(s.rgba, s.w, s.h, PAPER_HP * k * d1)); })();
  const q = new Uint8Array(hp.length);
  for (let i = 0; i < q.length; i++) q[i] = Math.round(128 + Math.max(-2.7, Math.min(2.7, hp[i]! / sigma)) * PAPER_Q);
  const tex = new THREE.DataTexture(q, full.w, full.h, THREE.RedFormat, THREE.UnsignedByteType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1; // rows of any width
  tex.needsUpdate = true;
  const kt = k * d; // texture texels per logical px
  return { tex, size: [full.w, full.h], k: kt, slack: [Math.max(0, Math.floor(full.w - fw * kt - 1)), Math.max(0, Math.floor(full.h - fh * kt - 1))], rot };
}

/**
 * Load the paper scan for `paperTex` (once; later calls return the same promise). A scene that uses paperTex awaits
 * it in init(), so every frame has the paper; a frame that asks for it before it is loaded goes without (and starts
 * the load). Resolves false, with a warning, when the scan can't be loaded: the paper is then left out, nothing breaks.
 */
export function loadPaper(): Promise<boolean> {
  return (paperLoad ??= (async () => {
    try {
      const r = await fetch(PAPER_URL);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const img = await createImageBitmap(await r.blob());
      paper = buildPaper(img);
      img.close();
      return true;
    } catch (e) {
      console.warn(`post.paperTex: ${PAPER_URL} could not be loaded (${e}); the paper is left out`);
      return false;
    }
  })());
}
/**
 * A Riso ink set as shader uniforms: paper, inks (up to 3), and the matrix that turns a colour's optical density
 * over the paper (log(colour / paper), per channel) into each ink's coverage (a least-squares fit for 2 inks).
 */
function risoSet(k: number) {
  const set = RISO_INKS[Math.max(0, Math.min(RISO_INKS.length - 1, Math.round(k)))]!;
  const paper = hex3(set.paper);
  const inks = set.inks.map(hex3);
  // columns: each ink's density per channel
  const A = inks.map((c) => c.map((v, ch) => Math.log(Math.max(v, 0.02) / paper[ch]!)));
  const n = A.length;
  // M = (AᵀA)⁻¹Aᵀ  (n x 3), padded to 3 x 3
  const ata = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => A[i]!.reduce((s, v, ch) => s + v * A[j]![ch]!, 0)));
  const inv = invert(ata);
  const M = Array.from({ length: 3 }, (_, i) => Array.from({ length: 3 }, (_, ch) => i < n ? inv[i]!.reduce((s, v, j) => s + v * A[j]![ch]!, 0) : 0));
  const m3 = new THREE.Matrix3().set(...(M.flat() as [number, number, number, number, number, number, number, number, number]));
  const ink = (i: number) => new THREE.Vector3(...(inks[i] ?? paper));
  return { paper: new THREE.Vector3(...paper), ink0: ink(0), ink1: ink(1), ink2: ink(2), m: m3, n };
}
function invert(a: number[][]): number[][] {
  const n = a.length, m = a.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    [m[c], m[p]] = [m[p]!, m[c]!];
    const d = m[c]![c]! || 1e-9;
    for (let j = 0; j < 2 * n; j++) m[c]![j]! /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = m[r]![c]!; for (let j = 0; j < 2 * n; j++) m[r]![j]! -= f * m[c]![j]!; }
  }
  return m.map((r) => r.slice(n));
}

/** The frame's corner radius squared (the frame's height = 1, its width = the aspect). */
export const FISHEYE_R2 = (W / H / 2) ** 2 + 0.25;
/** The vertical fov to render at so that `fisheye: k` keeps the middle of the frame at `fov`. */
export const fisheyeFov = (fov: number, k: number) => (2 * Math.atan(Math.tan((fov * Math.PI) / 360) * (1 + k * FISHEYE_R2)) * 180) / Math.PI;

const MIPS = 7;

export class Post {
  private prefilter: FSPass;
  private down: FSPass;
  private up: FSPass;
  private final: FSPass;
  private mips: THREE.WebGLRenderTarget[] = [];
  private ups: THREE.WebGLRenderTarget[] = [];
  private risoKey = -1;
  private palKey = '';
  private paperWarned = false;

  constructor() {
    // the bloom pyramid stays at the logical resolution at every output scale (same radii, same look)
    let w = W >> 1, h = H >> 1;
    for (let i = 0; i < MIPS; i++) {
      this.mips.push(makeRT(Math.max(2, w), Math.max(2, h), { depthBuffer: false, pxScale: 1 }));
      this.ups.push(makeRT(Math.max(2, w), Math.max(2, h), { depthBuffer: false, pxScale: 1 }));
      w >>= 1; h >>= 1;
    }
    this.prefilter = new FSPass(/* glsl */ `
      uniform sampler2D src; uniform vec2 texel; uniform float threshold, knee;
      void main() {
        // 4-tap box downsample + soft threshold on luminance
        vec3 c = vec3(0.0);
${SCALE === 1 ? `        c += texture(src, vUv + texel * vec2(-1, -1)).rgb; c += texture(src, vUv + texel * vec2(1, -1)).rgb;
        c += texture(src, vUv + texel * vec2(-1, 1)).rgb;  c += texture(src, vUv + texel * vec2(1, 1)).rgb;
        c *= 0.25;` : `        // output scale > 1: the same 4x4-logical-px box from a SCALE x larger source, as 2x2-texel bilinear taps
        const int N = ${SCALE * 2};
        for (int j = 0; j < N; j++) for (int i = 0; i < N; i++)
          c += texture(src, vUv + texel * (vec2(float(i), float(j)) * 2.0 - float(N - 1)) / PX_SCALE).rgb;
        c /= float(N * N);`}
        c = min(c, vec3(40.0));
        float l = max(c.r, max(c.g, c.b));
        float rq = clamp(l - threshold + knee, 0.0, 2.0 * knee);
        rq = rq * rq / (4.0 * knee + 1e-5);
        float w = max(rq, l - threshold) / max(l, 1e-5);
        fragColor = vec4(c * w, 1.0);
      }`, { src: { value: null }, texel: { value: new THREE.Vector2() }, threshold: { value: 1 }, knee: { value: 0.5 } });
    this.down = new FSPass(/* glsl */ `
      uniform sampler2D src; uniform vec2 texel;
      void main() {
        // 13-tap downsample (Jimenez 2014)
        vec3 a = texture(src, vUv + texel * vec2(-2, -2)).rgb, b = texture(src, vUv + texel * vec2(0, -2)).rgb, c = texture(src, vUv + texel * vec2(2, -2)).rgb;
        vec3 d = texture(src, vUv + texel * vec2(-1, -1)).rgb, e = texture(src, vUv + texel * vec2(1, -1)).rgb;
        vec3 f = texture(src, vUv + texel * vec2(-2, 0)).rgb, g = texture(src, vUv).rgb, h = texture(src, vUv + texel * vec2(2, 0)).rgb;
        vec3 i = texture(src, vUv + texel * vec2(-1, 1)).rgb, j = texture(src, vUv + texel * vec2(1, 1)).rgb;
        vec3 k = texture(src, vUv + texel * vec2(-2, 2)).rgb, l = texture(src, vUv + texel * vec2(0, 2)).rgb, m = texture(src, vUv + texel * vec2(2, 2)).rgb;
        vec3 o = (d + e + i + j) * 0.125 + (a + b + g + f) * 0.03125 + (b + c + h + g) * 0.03125 + (f + g + l + k) * 0.03125 + (g + h + m + l) * 0.03125;
        fragColor = vec4(o, 1.0);
      }`, { src: { value: null }, texel: { value: new THREE.Vector2() } });
    this.up = new FSPass(/* glsl */ `
      uniform sampler2D src; uniform sampler2D prev; uniform vec2 texel; uniform float radius;
      void main() {
        // 9-tap tent upsample of the smaller level, added to this level
        vec2 o = texel * radius;
        vec3 s = texture(src, vUv - o).rgb + 2.0 * texture(src, vUv + vec2(0, -o.y)).rgb + texture(src, vUv + vec2(o.x, -o.y)).rgb
          + 2.0 * texture(src, vUv + vec2(-o.x, 0)).rgb + 4.0 * texture(src, vUv).rgb + 2.0 * texture(src, vUv + vec2(o.x, 0)).rgb
          + texture(src, vUv + vec2(-o.x, o.y)).rgb + 2.0 * texture(src, vUv + vec2(0, o.y)).rgb + texture(src, vUv + o).rgb;
        fragColor = vec4(texture(prev, vUv).rgb + s / 16.0, 1.0);
      }`, { src: { value: null }, prev: { value: null }, texel: { value: new THREE.Vector2() }, radius: { value: 1 } });
    this.final = new FSPass(/* glsl */ `
      uniform sampler2D src; uniform sampler2D bloomTex; uniform sampler2D haloTex; uniform sampler2D hudTex; uniform sampler2D zhTex;
      uniform float exposure, bloom, halation, ca, grain, vignette, hud, fade, flash, time, zoom, invert, zhOn, grade, fisheye, radial, shoulderK, shoulderHue;
      uniform float ${RETRO.join(', ')};
      uniform vec2 shake; uniform vec2 res;
      uniform vec3 risoPaper, risoInk0, risoInk1, risoInk2; uniform mat3 risoM; uniform float risoN; uniform vec2 risoOff0, risoOff1, risoOff2;
      uniform vec3 palRGB[${PALETTE_MAX}], palLab[${PALETTE_MAX}]; uniform float palN;
      uniform sampler2D paperMap; uniform float paperTex, paperK, paperRot; uniform vec2 paperSize, paperSlack;
      ${SHOULDER_GLSL}
      // ---- Riso: the display colour at u (bloom, no fringes), each ink's coverage, a halftone screen ----
      vec3 risoSample(vec2 u) {
        vec3 c = (texture(src, u).rgb + texture(bloomTex, u).rgb * bloom) * exposure;
        return toSRGB(sat(shoulder(c)));
      }
      vec3 risoCover(vec2 u) { return clamp(risoM * log(max(risoSample(u), vec3(0.02)) / risoPaper), 0.0, 1.0); }
      // plate i's coverage at u; with a trap the most within risoTrap px around it (two rings of taps): the plate
      // spreads, so mis-registered plates overlap instead of opening a gap (参考 mg-styles-15 demos/09-bauhaus/film.js (MIT))
      float risoPlate(vec2 u, int i) {
        vec3 cv = risoCover(u);
        float c = cv[i];
        if (risoTrap > 0.0) {
          for (int k = 0; k < 8; k++) {
            float a = float(k) * 0.785398;
            vec2 o = vec2(cos(a), sin(a)) * risoTrap / res, o2 = vec2(cos(a + 0.392699), sin(a + 0.392699)) * 0.5 * risoTrap / res;
            cv = risoCover(u + o); c = max(c, cv[i]);
            cv = risoCover(u + o2); c = max(c, cv[i]);
          }
        }
        return c;
      }
      float risoScreen(vec2 px, float ang, float c) {
        // round dots up to half coverage, then round holes (the dots merge into a solid with white dots in it)
        vec2 q = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * px / risoDot;
        float inv = step(0.5, c);
        vec2 f = fract(q + 0.5 * inv) - 0.5;
        float r = sqrt(mix(c, 1.0 - c, inv) / 3.14159);
        float d = length(f), aa = max(fwidth(d) * 0.8, 0.02);
        float m = 1.0 - smoothstep(r - aa, r + aa, d);
        return mix(m, 1.0 - m, inv);
      }
      float bayer4(vec2 p) {
        const float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
        ivec2 q = ivec2(mod(p, 4.0));
        return (m[q.x + q.y * 4] + 0.5) / 16.0;
      }
      vec3 toYIQ(vec3 c) { return vec3(dot(c, vec3(0.299, 0.587, 0.114)), dot(c, vec3(0.596, -0.274, -0.322)), dot(c, vec3(0.211, -0.523, 0.312))); }
      vec3 fromYIQ(vec3 y) { return vec3(y.x + 0.956 * y.y + 0.621 * y.z, y.x - 0.272 * y.y - 0.647 * y.z, y.x - 1.106 * y.y + 1.703 * y.z); }
      // OKLab of linear sRGB (Björn Ottosson), as oklab() in post.ts
      vec3 oklab(vec3 c) {
        vec3 l = pow(max(vec3(dot(c, vec3(0.4122214708, 0.5363325363, 0.0514459929)), dot(c, vec3(0.2119034982, 0.6806995451, 0.1073969566)),
          dot(c, vec3(0.0883024619, 0.2817188376, 0.6299787005))), 0.0), vec3(1.0 / 3.0));
        return vec3(dot(l, vec3(0.2104542553, 0.7936177850, -0.0040720468)), dot(l, vec3(1.9779984951, -2.4285922050, 0.4505937099)), dot(l, vec3(0.0259040371, 0.7827717662, -0.8086757660)));
      }
      void main() {
        // post runs once per output frame at the frame's time: per-frame randomness keys on this index
        float fi = floor(time * 60.0 + 0.5);
        vec2 asp = vec2(res.x / res.y, 1.0);
        // ---- the CRT glass: barrel curvature (screen -> tube coordinates), then the power-off squeeze ----
        bool tube = crt > 0.0 || crtOff > 0.0;
        vec2 glass = vUv;
        if (crt > 0.0) {
          vec2 d = (vUv - 0.5) * 2.0;
          d *= 1.0 + crtCurve * crt * d.yx * d.yx;
          glass = d * 0.5 + 0.5;
        }
        vec2 suv = glass;
        float offY = 1.0, offX = 1.0;
        if (crtOff > 0.0) {
          // the picture squeezes to a line first (0 .. 0.55), the line shrinks to a dot late (0.75 .. 0.97)
          offY = max(0.006, 1.0 - smoothstep(0.0, 0.55, crtOff));
          offX = max(0.004, 1.0 - smoothstep(0.75, 0.97, crtOff));
          suv = 0.5 + (suv - 0.5) / vec2(offX, offY);
        }
        // ---- the signal: glitch slices / blocks, VHS wobble and tracking band, CRT row jitter ----
        vec2 uv0 = suv;
        float rowPx = suv.y * res.y;
        bool swapCh = false, blackBlk = false;
        float gsplit = 0.0;
        if (glitch > 0.0) {
          float gs = fi + glitchSeed * 101.0;
          float bandH = mix(0.015, 0.11, hash11(gs * 3.1));
          float band = floor((suv.y + hash11(gs * 1.3)) / bandH);
          float r = hash12(vec2(band, gs));
          if (r < 0.42 * glitch) {
            uv0.x += (hash12(vec2(band * 1.7, gs + 3.0)) - 0.5) * 0.26 * glitch;
            gsplit = (hash12(vec2(band, gs + 5.0)) - 0.3) * 14.0 * glitch;
          }
          float row = floor(rowPx / 2.0);
          if (hash12(vec2(row, gs * 1.1)) < 0.05 * glitch) uv0.x += (hash12(vec2(row, gs + 9.0)) - 0.5) * 0.06;
          vec2 blk = floor(suv * vec2(5.0, 24.0) * (1.0 + floor(hash11(gs * 2.3) * 2.0)));   // wide strips
          float hb = hash12(blk + gs * 13.0);
          if (hb > 1.0 - 0.09 * glitch) {
            uv0 += (hash22(blk + gs) - 0.5) * vec2(0.2, 0.03) * glitch;
            swapCh = hash12(blk + gs * 7.0) < 0.3;
          }
          if (hb < 0.025 * glitch) blackBlk = true;
        }
        if (glitchSort > 0.0) {
          // pixel sort: in a few column bands everything below a random row repeats that row (vertical streaks)
          float gs = fi + glitchSeed * 101.0;
          float colB = floor(suv.x * mix(24.0, 70.0, hash11(gs * 0.7)));
          if (hash12(vec2(colB, gs * 1.9)) < 0.3 * glitchSort) {
            float y0 = hash12(vec2(colB * 3.3, gs));
            if (suv.y < y0) uv0.y = y0 + (uv0.y - suv.y) * 0.02;   // (y up: the streaks run down from y0)
          }
        }
        float vband = 0.0;
        if (vhs > 0.0) {
          uv0.x += sin(suv.y * 38.0 + fi * 0.21) * 0.0022 * vhs + (hash12(vec2(floor(rowPx / 2.0), fi)) - 0.5) * 0.004 * vhs;
          float by = fract(fi * 0.0075 + 0.15);
          vband = smoothstep(0.045, 0.0, abs(suv.y - by));
          uv0.x += vband * (hash12(vec2(floor(rowPx / 3.0), fi)) - 0.5) * 0.05 * vhs;
          if (suv.y < 0.035) uv0.x += (hash12(vec2(floor(rowPx), fi + 7.0)) - 0.3) * 0.04 * vhs; // head-switch tear
        }
        float tear = 0.0;
        if (vhsTear > 0.0 && hash11(fi * 0.917 + 3.7) < vhsTear) {
          // a torn frame: a few whole rows (bands 6-20 px tall) shoved sideways 8-40 px, their chroma lagging more
          // (参考 mg-styles-15 demos/10-synthwave/index.html (MIT))
          float gs = fi + 0.31;
          float gh = 6.0 + 14.0 * hash11(gs * 1.7 + 0.3);
          float gRow = floor((res.y - rowPx + hash11(gs) * 80.0) / gh);
          tear = step(0.82, hash12(vec2(gRow, gs)));
          uv0.x += tear * (hash12(vec2(gRow, gs + 5.0)) < 0.5 ? -1.0 : 1.0) * (8.0 + 32.0 * hash12(vec2(gRow, gs + 3.0))) / res.x;
        }
        if (crtNoise > 0.0) {
          uv0.x += (hash12(vec2(floor(rowPx / 2.0), fi + 17.0)) - 0.5) * 0.012 * crtNoise;
          uv0.y += (hash11(fi * 0.37) - 0.5) * 0.01 * crtNoise;
        }
        vec2 uv = (uv0 - 0.5) / zoom + 0.5 - shake / res;
        // fisheye: the scene rendered a wider field; the middle is drawn back to its size, the edges bend
        if (fisheye > 0.0) {
          vec2 asp = vec2(res.x / res.y, 1.0);
          vec2 d = (uv - 0.5) * asp;
          d *= (1.0 + fisheye * dot(d, d)) / (1.0 + fisheye * ${FISHEYE_R2.toFixed(5)});
          uv = d / asp + 0.5;
        }
        // pixelate: sample each block at its centre (the bloom below stays smooth)
        vec2 uvS = uv;
        if (pixel > 1.0) { vec2 cells = res / pixel; uvS = (floor(uv * cells) + 0.5) / cells; }
        vec2 dc = uv - 0.5;
        float r2 = dot(dc * vec2(res.x / res.y, 1.0), dc * vec2(res.x / res.y, 1.0));
        vec2 off = dc * r2 * ca / res.x * 4.0 + vec2(gsplit + 3.0 * vhs, 0.0) / res.x;
        vec3 col;
        if (radial > 0.0) {
          // a zoom blur toward the middle (the shock of a hit), the colour fringes riding along
          col = vec3(0.0);
          for (int i = 0; i < 14; i++) {
            vec2 u2 = 0.5 + dc * (1.0 - radial * float(i) / 13.0);
            col += vec3(texture(src, u2 + off).r, texture(src, u2).g, texture(src, u2 - off).b);
          }
          col /= 14.0;
        } else {
          col.r = texture(src, uvS + off).r;
          col.g = texture(src, uvS).g;
          col.b = texture(src, uvS - off).b;
        }
        if (swapCh) col = col.brg;
        if (blackBlk) col = C_INK * 0.5;
        if (vhs > 0.0) {
          // tape chroma: sharp luma, colour smeared to the right and a little late
          vec3 y = toYIQ(col);
          vec2 cc = vec2(0.0);
          for (int i = 0; i < 6; i++) cc += toYIQ(texture(src, uvS - vec2((float(i) * 2.0 + 2.0) * vhs + 4.0 * tear, 0.0) / res.x).rgb).yz;
          col = max(fromYIQ(vec3(y.x, mix(y.yz, cc / 6.0, vhs))), 0.0);
        }
        if (vhsBleed > 0.0) {
          // red bleed: the red of saturated reds and pinks trails to the right (参考 mg-styles-15 demos/10-synthwave/index.html (MIT))
          float rs = 0.0, rw = 0.0;
          for (int i = 1; i <= 6; i++) {
            float w = exp(-float(i) * 0.38);
            rs += texture(src, uvS - vec2(float(i) * 1.5 + 1.0 + 3.0 * tear, 0.0) / res.x).r * w; rw += w;
          }
          col.r = mix(col.r, max(col.r, rs / rw * 0.82), vhsBleed);
        }
        vec3 bl = texture(bloomTex, uv).rgb;
        vec3 ha = texture(haloTex, uv).rgb;
        col += bl * bloom;
        col += vec3(1.0, 0.18, 0.04) * luma(ha) * halation;
        col *= exposure;
        if (grade > 0.0) {
          vec3 gc = 0.18 * exp2(log2(max(col, 1e-5) / 0.18) * (1.0 + 0.14 * grade));
          float ll = luma(gc);
          vec3 tint = mix(vec3(0.93, 0.99, 1.08), vec3(1.06, 1.0, 0.91), smoothstep(0.03, 0.6, ll));
          gc *= mix(vec3(1.0), tint, grade);
          col = max(mix(vec3(ll), gc, 1.0 + 0.08 * grade), 0.0);
        }
        // HUD is composited in linear space before the shoulder so it gets grain & vignette too (on a CRT: on the glass)
        vec2 huv = tube ? suv : vUv;
        vec4 h = texture(hudTex, huv);
        col = mix(col, h.rgb / max(h.a, 1e-4), h.a * hud);
        // an optional full-frame Canvas2D overlay over the HUD (straight alpha)
        if (zhOn > 0.5 && !tube) { vec4 z = texture(zhTex, vUv); col = mix(col, z.rgb, z.a); }
        if (shoulderK > 0.0) {
          vec3 sc = shoulderHue >= 1.0 ? shoulderMax(col) : shoulderHue <= 0.0 ? shoulder(col) : mix(shoulder(col), shoulderMax(col), shoulderHue);
          col = mix(col, sc, shoulderK);
        }
        if (riso > 0.0) {
          // each ink sampled a little off (mis-registration), screened at its own angle, multiplied on the paper
          vec2 sh = vec2(risoShift) / res;
          // rough edges: the plates print through a noise displacement fixed on the paper (1.3 px + 0.35 px)
          vec2 rough = vec2(0.0);
          if (risoRough > 0.0) {
            vec2 q = FRAG_PX;
            rough = (vec2(snoise(q / 5.0), snoise(q / 5.0 + 17.3)) * 0.65 + vec2(snoise(q / 1.6 + 3.1), snoise(q / 1.6 + 8.7)) * 0.175) * risoRough;
          }
          vec2 rp = FRAG_PX + rough, ru = uv + rough / res;
          float c0 = risoPlate(ru + sh * risoOff0, 0), c1 = risoPlate(ru + sh * risoOff1, 1), c2 = risoPlate(ru + sh * risoOff2, 2);
          // ink texture: uneven coverage, fixed on the paper (gentler on solid ink, where it isn't broken up by dots)
          float tx = 0.6 * snoise(FRAG_PX * 0.05) * mix(1.0, 0.35, risoSolid);
          c0 *= 1.0 + 0.25 * tx; c1 *= 1.0 - 0.25 * tx; c2 *= 1.0 + 0.2 * tx;
          // the screen (dots), or with risoSolid the coverage itself as ink (09-bauhaus prints its plates solid)
          float m0 = risoScreen(rp, 0.2618, c0), m1 = risoScreen(rp + 1.7, 1.309, c1), m2 = risoScreen(rp + 3.1, 0.0, c2);
          if (risoSolid > 0.0) { m0 = mix(m0, sat(c0), risoSolid); m1 = mix(m1, sat(c1), risoSolid); m2 = mix(m2, sat(c2), risoSolid); }
          // overprints multiply (subtractive): col *= mix(1, ink / paper, coverage * density); thin ink lets the paper through
          vec3 pr = risoPaper;
          pr *= mix(vec3(1.0), risoInk0 / risoPaper, m0 * risoDensity);
          if (risoN > 1.5) pr *= mix(vec3(1.0), risoInk1 / risoPaper, m1 * risoDensity);
          if (risoN > 2.5) pr *= mix(vec3(1.0), risoInk2 / risoPaper, m2 * risoDensity);
          col = mix(col, toLinear(max(pr, 0.0)), riso * (1.0 - h.a * hud));
        }
        // impact frame: hard black and white (then invert makes it the negative kind)
        if (bw > 0.0) col = mix(col, vec3(step(bwThreshold, luma(col))), bw);
        col = mix(col, vec3(0.8515) - col * 0.84, invert); // ink<->bone in linear-ish space
        col += C_BONE * flash;
        // vignette
        float v = smoothstep(0.95, 0.25, length(dc * vec2(1.0, 0.8)));
        col *= mix(1.0, v, vignette);
        col *= (1.0 - fade);
        vec3 s = toSRGB(sat(col));
        if (paperTex > 0.0) {
          // printed on paper: the scan's high-passed tooth multiplied in, more in the lights; another patch of the
          // sheet every 1/paperStep s (参考 mg-styles-15 demos/08-morph/index.html (MIT))
          float ps = paperStep > 0.0 ? floor((fi + 0.5) * paperStep / 60.0) : 0.0;
          vec2 pp = (paperRot > 0.5 ? FRAG_PX.yx : FRAG_PX) * paperK + floor(hash22(vec2(ps, 5.3)) * paperSlack);
          float pn = (texture(paperMap, pp / paperSize).r * 255.0 - 128.0) / 45.0;
          s *= 1.0 + paperTex * 0.022 * pn * dot(s, vec3(1.0 / 3.0));
        }
        // palette levels with ordered dither, one threshold per pixel block
        if (pixelLevels > 1.0) {
          vec2 cell = pixel > 1.0 ? floor(uv * res / pixel) : floor(FRAG_PX);
          float L = pixelLevels - 1.0;
          s = floor(s * L + bayer4(cell)) / L;
        }
        if (palN > 0.5) {
          // a fixed palette: the two nearest colours in OKLab, the second where the colour's place between them is
          // past the block's Bayer threshold (参考 mg-styles-15 demos/20-pixel (MIT))
          vec3 q = oklab(toLinear(sat(s)));
          float d1 = 1e9, d2 = 1e9;
          int i1 = 0, i2 = 0;
          for (int i = 0; i < ${PALETTE_MAX}; i++) {
            if (float(i) >= palN) break;
            vec3 e = palLab[i] - q;
            float d = dot(e, e);
            if (d < d1) { d2 = d1; i2 = i1; d1 = d; i1 = i; } else if (d < d2) { d2 = d; i2 = i; }
          }
          vec3 pa = palLab[i1], ab = palLab[i2] - pa;
          float u = palN > 1.5 ? sat(dot(q - pa, ab) / max(dot(ab, ab), 1e-9)) : 0.0;
          vec2 cell = pixel > 1.0 ? floor(uv * res / pixel) : floor(FRAG_PX);
          s = u > 0.5 + (bayer4(cell) - 0.5) * paletteDither ? palRGB[i2] : palRGB[i1];
        }
        // dot-matrix gaps between the blocks
        if (pixel >= 3.0 && pixelGrid > 0.0) {
          vec2 fp = fract(uv * res / pixel), gw = vec2(1.15 / pixel);
          s *= 1.0 - pixelGrid * 0.85 * max(step(1.0 - gw.x, fp.x), step(1.0 - gw.y, fp.y));
        }
        // film grain: two scales, stronger in mid-tones
${SCALE === 1 ? `        float g1 = hash12(gl_FragCoord.xy + fract(time * 13.37) * 1000.0) - 0.5;
        float g2 = hash12(floor(gl_FragCoord.xy / 2.0) + fract(time * 7.13) * 1000.0) - 0.5;` : `        // output scale > 1: the fine grain is per physical px with its amplitude raised by PX_SCALE so its
        // power per logical px (what survives a downscale) matches 1x; the coarse grain keeps 2x2-logical-px cells
        float g1 = (hash12(gl_FragCoord.xy + fract(time * 13.37) * 1000.0) - 0.5) * PX_SCALE;
        float g2 = hash12(floor(FRAG_PX / 2.0) + fract(time * 7.13) * 1000.0) - 0.5;`}
        float lm = luma(s);
        float amt = grain * (0.55 + 1.2 * lm * (1.0 - lm));
        s += (g1 * 0.6 + g2 * 0.4) * amt;
        // dither to 8 bits: triangular (two hashes, ±1 level), so the noise doesn't swell and fade with the level and
        // gradients don't band (参考 mg-styles-15 demos/07-liquid/js/shaders.js (MIT)). Pure black and white (per
        // channel) stay exact, and so do the quantized looks (pixelLevels, palette)
        if (palN < 0.5 && pixelLevels <= 1.0) {
          float dn = (hash12(gl_FragCoord.xy * 1.37 + time) + hash12(gl_FragCoord.xy * 0.71 + vec2(time * 1.93, 41.7)) - 1.0) / 255.0;
          s += dn * step(vec3(1e-7), s) * step(s, vec3(1.0 - 1e-7));
        }
        // VHS tracking band: a rolling stripe of snow
        if (vhs > 0.0) {
          float nz = hash12(vec2(floor(FRAG_PX.x / 3.0), floor(FRAG_PX.y / 2.0)) + fi * 31.0);
          s = mix(s, vec3(nz), vband * 0.55 * vhs);
          s = mix(s, s * vec3(1.04, 0.95, 1.06), 0.5 * vhs);
        }
        // ---- the CRT surface: snow, scanlines, RGB grille, flicker, power line, bezel ----
        if (tube) {
          if (crtNoise > 0.0) {
            // a dying signal: colour drains, snow streaks along the lines
            s = mix(s, vec3(luma(s)), crtNoise * 0.75);
            float sn = hash12(vec2(floor(FRAG_PX.x / 6.0), floor(FRAG_PX.y / 2.0)) + fi * 91.7);
            s = mix(s, vec3(sn * 0.85), crtNoise * 0.5);
            s *= 1.0 - crtNoise * 0.35 * smoothstep(0.12, 0.0, abs(fract(glass.y - fi * 0.011) - 0.5) - 0.3);
          }
          float L = luma(sat(s));
          float ph = 0.5 - 0.5 * cos(TAU * glass.y * crtLines);
          s *= 1.0 - crt * 0.6 * ph * (1.0 - 0.55 * L);             // dark gaps, narrower on bright lines
          int gx = int(mod(floor(gl_FragCoord.x / max(PX_SCALE * 1.0, 1.0)), 3.0));
          vec3 grille = gx == 0 ? vec3(1.18, 0.9, 0.9) : gx == 1 ? vec3(0.9, 1.18, 0.9) : vec3(0.9, 0.9, 1.18);
          s *= mix(vec3(1.0), grille, crt * 0.35);
          s *= 1.0 + (hash11(fi * 0.73) - 0.5) * 0.03 * crt;      // flicker
          if (crtOff > 0.0) {
            // the squeezed picture glows toward white; outside it the glass is dark; the last dot fades
            bool inPic = abs(suv.x - 0.5) <= 0.5 && abs(suv.y - 0.5) <= 0.5;
            float hot = smoothstep(0.0, 0.5, crtOff);
            s = inPic ? mix(s, vec3(1.0, 0.98, 0.95), hot * 0.85) : s * 0.0;
            // the bright line (or dot) and its glow on the glass
            float dy = abs(glass.y - 0.5), dx = max(abs(glass.x - 0.5) - offX * 0.5, 0.0);
            float core = smoothstep(offY * 0.5 + 0.003, 0.0, dy) * smoothstep(0.004, 0.0, dx);
            float halo = exp(-dy * 60.0) * exp(-dx * 40.0);
            s += vec3(0.85, 0.92, 1.0) * (core * 0.8 + halo * 0.35) * hot;
            s *= 1.0 - smoothstep(0.9, 1.0, crtOff);
          }
          if (crt > 0.0) {
            // outside the curved glass: a black bezel with rounded corners
            vec2 q = (glass - 0.5) * asp;
            vec2 hb = 0.5 * asp - 0.004;
            float rr = 0.06;
            float dB = length(max(abs(q) - (hb - rr), 0.0)) - rr;
            s *= 1.0 - smoothstep(-0.002, 0.002, dB);
          }
        }
        // with a tube the Chinese overlay (subtitles) stays flat, outside the glass
        if (zhOn > 0.5 && tube) { vec4 z = texture(zhTex, vUv); s = mix(s, toSRGB(sat(shoulder(z.rgb))), z.a); }
        // letterbox bars (pure black, over everything)
        if (letterbox > 0.0 && abs(vUv.y - 0.5) > 0.5 - letterbox * 0.5) s = vec3(0.0);
        fragColor = vec4(sat(s), 1.0);
      }`, {
      src: { value: null }, bloomTex: { value: null }, haloTex: { value: null }, hudTex: { value: null }, zhTex: { value: null }, zhOn: { value: 0 },
      exposure: { value: 1 }, bloom: { value: 0 }, halation: { value: 0 }, ca: { value: 0 }, grain: { value: 0 },
      vignette: { value: 0 }, shoulderK: { value: 0 }, shoulderHue: { value: 1 }, hud: { value: 1 }, fade: { value: 0 }, flash: { value: 0 }, time: { value: 0 },
      zoom: { value: 1 }, invert: { value: 0 }, grade: { value: 0 }, fisheye: { value: 0 }, radial: { value: 0 }, shake: { value: new THREE.Vector2() }, res: { value: new THREE.Vector2(W, H) },
      ...Object.fromEntries(RETRO.map((k) => [k, { value: DEFAULT_POST[k] }])),
      risoPaper: { value: new THREE.Vector3() }, risoInk0: { value: new THREE.Vector3() }, risoInk1: { value: new THREE.Vector3() }, risoInk2: { value: new THREE.Vector3() },
      risoM: { value: new THREE.Matrix3() }, risoN: { value: 0 },
      risoOff0: { value: new THREE.Vector2() }, risoOff1: { value: new THREE.Vector2() }, risoOff2: { value: new THREE.Vector2() },
      palRGB: { value: Array.from({ length: PALETTE_MAX }, () => new THREE.Vector3()) }, palLab: { value: Array.from({ length: PALETTE_MAX }, () => new THREE.Vector3()) }, palN: { value: 0 },
      paperMap: { value: null }, paperTex: { value: 0 }, paperK: { value: 1 }, paperRot: { value: 0 }, paperSize: { value: new THREE.Vector2(1, 1) }, paperSlack: { value: new THREE.Vector2() },
    });
  }

  /** Apply the chain: src (HDR linear) -> out (sRGB 8-bit target or screen). `zh`: the Chinese lyric layer, if on. */
  render(renderer: THREE.WebGLRenderer, src: THREE.Texture, hud: THREE.Texture, out: THREE.WebGLRenderTarget | null, p: PostParams, time: number, zh: THREE.Texture | null = null) {
    // bloom pyramid
    this.prefilter.u.src!.value = src;
    (this.prefilter.u.texel!.value as THREE.Vector2).set(1 / W, 1 / H);
    this.prefilter.u.threshold!.value = p.bloomThreshold;
    this.prefilter.u.knee!.value = p.bloomKnee;
    this.prefilter.render(renderer, this.mips[0]!);
    for (let i = 1; i < MIPS; i++) {
      const s = this.mips[i - 1]!;
      this.down.u.src!.value = s.texture;
      (this.down.u.texel!.value as THREE.Vector2).set(1 / s.width, 1 / s.height);
      this.down.render(renderer, this.mips[i]!);
    }
    // upsample: ups[i] = mips[i] + up(ups[i+1])
    let prevTex = this.mips[MIPS - 1]!.texture;
    for (let i = MIPS - 2; i >= 0; i--) {
      const small = i === MIPS - 2 ? this.mips[MIPS - 1]! : this.ups[i + 1]!;
      this.up.u.src!.value = prevTex;
      this.up.u.prev!.value = this.mips[i]!.texture;
      (this.up.u.texel!.value as THREE.Vector2).set(1 / small.width, 1 / small.height);
      this.up.u.radius!.value = 0.5 + p.bloomRadius;
      this.up.render(renderer, this.ups[i]!);
      prevTex = this.ups[i]!.texture;
    }
    const f = this.final.u;
    f.src!.value = src;
    f.bloomTex!.value = this.ups[0]!.texture;
    f.haloTex!.value = this.ups[3]!.texture;
    f.hudTex!.value = hud;
    f.zhTex!.value = zh;
    f.zhOn!.value = zh ? 1 : 0;
    f.exposure!.value = p.exposure;
    f.bloom!.value = p.bloom / 3; // pyramid sums ~MIPS levels; normalize
    f.halation!.value = p.halation;
    f.ca!.value = p.ca;
    f.grain!.value = p.grain;
    f.vignette!.value = p.vignette;
    f.hud!.value = p.hud;
    f.fade!.value = p.fade;
    f.flash!.value = p.flash;
    f.time!.value = time;
    f.zoom!.value = p.zoom;
    f.invert!.value = p.invert;
    f.fisheye!.value = p.fisheye ?? 0;
    f.radial!.value = p.radial ?? 0;
    f.grade!.value = p.grade;
    f.shoulderK!.value = p.shoulder ?? 0;
    f.shoulderHue!.value = p.shoulderHue ?? DEFAULT_POST.shoulderHue;
    for (const k of RETRO) f[k]!.value = p[k] ?? DEFAULT_POST[k];
    if ((p.riso ?? 0) > 0) {
      const inks = p.risoInks ?? 0;
      if (inks !== this.risoKey) {
        const r = risoSet(inks);
        this.risoKey = inks;
        (f.risoPaper!.value as THREE.Vector3).copy(r.paper);
        (f.risoInk0!.value as THREE.Vector3).copy(r.ink0); (f.risoInk1!.value as THREE.Vector3).copy(r.ink1); (f.risoInk2!.value as THREE.Vector3).copy(r.ink2);
        (f.risoM!.value as THREE.Matrix3).copy(r.m);
        f.risoN!.value = r.n;
      }
      // each plate's mis-registration direction (a missing or malformed one keeps the default)
      const plates = Array.isArray(p.risoPlates) ? p.risoPlates : [];
      for (let i = 0; i < 3; i++) {
        const v = plates[i], d = DEFAULT_POST.risoPlates[i]!;
        const ok = Array.isArray(v) && Number.isFinite(v[0]) && Number.isFinite(v[1]);
        (f[`risoOff${i}`]!.value as THREE.Vector2).set(ok ? v[0] : d[0], ok ? v[1] : d[1]);
      }
    }
    // the palette's uniforms, rebuilt when it changes
    const palKey = Array.isArray(p.palette) ? p.palette.join(',') : '';
    if (palKey !== this.palKey) {
      const ps = paletteSet(p.palette);
      this.palKey = palKey;
      ps.rgb.forEach((c, i) => (f.palRGB!.value as THREE.Vector3[])[i]!.set(...c));
      ps.lab.forEach((c, i) => (f.palLab!.value as THREE.Vector3[])[i]!.set(...c));
      f.palN!.value = ps.rgb.length;
    }
    // the paper: only once the scan is in (a frame before that goes without it and starts the load)
    const pt = p.paperTex ?? 0;
    if (pt > 0 && !paper && !this.paperWarned) {
      this.paperWarned = true;
      void loadPaper().then((ok) => {
        if (ok) console.warn(`post.paperTex: a frame (t = ${time.toFixed(3)}) asked for the paper before the scan was in and went without; \`await loadPaper()\` (engine/post.ts) in the scene's init()`);
      });
    }
    f.paperTex!.value = paper ? pt : 0;
    if (paper && f.paperMap!.value !== paper.tex) {
      f.paperMap!.value = paper.tex;
      f.paperK!.value = paper.k;
      f.paperRot!.value = paper.rot ? 1 : 0;
      (f.paperSize!.value as THREE.Vector2).set(...paper.size);
      (f.paperSlack!.value as THREE.Vector2).set(...paper.slack);
    }
    (f.shake!.value as THREE.Vector2).set(p.shake[0], p.shake[1]);
    this.final.render(renderer, out);
  }
}

// Global post-processing: bloom + halation, chromatic aberration, tone shoulder,
// film grain, vignette, fades/flash. Operates on the composited HDR (linear) frame.
import * as THREE from 'three';
import { FSPass, makeRT, W, H, SCALE } from './gl';

/** The tone shoulder (linear HDR -> 0..1 linear), shared with the engine's sampling error estimate. */
export const SHOULDER_GLSL = /* glsl */ `
vec3 shoulder(vec3 x) {
  // identity below k, smooth exponential shoulder above; very bright values desaturate toward white
  const float k = 0.72;
  vec3 y = mix(x, k + (1.0 - k) * (1.0 - exp(-(x - k) / (1.0 - k))), step(k, x));
  float over = max(max(x.r, x.g), x.b);
  return mix(y, vec3(1.0), smoothstep(2.0, 12.0, over) * 0.85);
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
  /** Impact frame 0..1: hard black and white on display luminance (bwThreshold). With invert: 1 it is the inverted kind. */
  bw: number;
  bwThreshold: number;
  /** Pixelate: block size in logical px (0 or 1 = off). Bloom stays smooth over the blocks (the Hi-bit look). */
  pixel: number;
  /** Colour levels per channel with 4x4 ordered dither per block (0 = off): 2–8 for 8-bit palettes. */
  pixelLevels: number;
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
  /** Riso mis-registration between the ink layers (logical px). */
  risoShift: number;
  /** Riso inks (RISO_INKS): 0 fluorescent pink + blue + yellow, 1 fluorescent pink + blue, 2 red + teal + yellow, 3 purple + fluorescent pink. */
  risoInks: number;
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
  bloom: 0.55,
  bloomThreshold: 0.85,
  bloomKnee: 0.5,
  bloomRadius: 0.75,
  halation: 0.25,
  ca: 1.2,
  grain: 0.055,
  vignette: 0.35,
  hud: 1,
  watermark: 0,
  paper: 0,
  fade: 0,
  flash: 0,
  shake: [0, 0],
  zoom: 1,
  invert: 0,
  grade: 0,
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
  bw: 0,
  bwThreshold: 0.3,
  pixel: 0,
  pixelLevels: 0,
  pixelGrid: 0,
  letterbox: 0,
  phosphor: 0,
  riso: 0,
  risoDot: 7,
  risoShift: 3,
  risoInks: 0,
};

/** The retro post parameters (uniform names = PostParams keys). */
const RETRO = ['crt', 'crtCurve', 'crtLines', 'crtOff', 'crtNoise', 'glitch', 'glitchSeed', 'glitchSort', 'vhs', 'bw', 'bwThreshold', 'pixel', 'pixelLevels', 'pixelGrid', 'letterbox', 'riso', 'risoDot', 'risoShift'] as const;

const hex3 = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
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
      uniform float exposure, bloom, halation, ca, grain, vignette, hud, fade, flash, time, zoom, invert, zhOn, grade, fisheye, radial;
      uniform float ${RETRO.join(', ')};
      uniform vec2 shake; uniform vec2 res;
      uniform vec3 risoPaper, risoInk0, risoInk1, risoInk2; uniform mat3 risoM; uniform float risoN;
      ${SHOULDER_GLSL}
      // ---- Riso: the display colour at u (bloom, no fringes), each ink's coverage, a halftone screen ----
      vec3 risoSample(vec2 u) {
        vec3 c = (texture(src, u).rgb + texture(bloomTex, u).rgb * bloom) * exposure;
        return toSRGB(sat(shoulder(c)));
      }
      vec3 risoCover(vec2 u) { return clamp(risoM * log(max(risoSample(u), vec3(0.02)) / risoPaper), 0.0, 1.0); }
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
          for (int i = 0; i < 6; i++) cc += toYIQ(texture(src, uvS - vec2((float(i) * 2.0 + 2.0) * vhs, 0.0) / res.x).rgb).yz;
          col = max(fromYIQ(vec3(y.x, mix(y.yz, cc / 6.0, vhs))), 0.0);
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
        col = shoulder(col);
        if (riso > 0.0) {
          // each ink sampled a little off (mis-registration), screened at its own angle, multiplied on the paper
          vec2 sh = vec2(risoShift) / res;
          float c0 = risoCover(uv + sh * vec2(1.0, 0.4)).x, c1 = risoCover(uv + sh * vec2(-0.6, -0.8)).y, c2 = risoCover(uv + sh * vec2(0.2, 1.0)).z;
          // ink texture: uneven coverage, fixed on the paper
          float tx = 0.6 * snoise(FRAG_PX * 0.05);
          vec3 pr = risoPaper;
          pr *= mix(vec3(1.0), risoInk0 / risoPaper, risoScreen(FRAG_PX, 0.2618, c0 * (1.0 + 0.25 * tx)));
          if (risoN > 1.5) pr *= mix(vec3(1.0), risoInk1 / risoPaper, risoScreen(FRAG_PX + 1.7, 1.309, c1 * (1.0 - 0.25 * tx)));
          if (risoN > 2.5) pr *= mix(vec3(1.0), risoInk2 / risoPaper, risoScreen(FRAG_PX + 3.1, 0.0, c2 * (1.0 + 0.2 * tx)));
          col = mix(col, toLinear(pr), riso * (1.0 - h.a * hud));
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
        // palette levels with ordered dither, one threshold per pixel block
        if (pixelLevels > 1.0) {
          vec2 cell = pixel > 1.0 ? floor(uv * res / pixel) : floor(FRAG_PX);
          float L = pixelLevels - 1.0;
          s = floor(s * L + bayer4(cell)) / L;
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
        s += (hash12(gl_FragCoord.xy * 1.37 + time) - 0.5) / 255.0; // dither
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
      exposure: { value: 1 }, bloom: { value: 0.5 }, halation: { value: 0.2 }, ca: { value: 1 }, grain: { value: 0.05 },
      vignette: { value: 0.3 }, hud: { value: 1 }, fade: { value: 0 }, flash: { value: 0 }, time: { value: 0 },
      zoom: { value: 1 }, invert: { value: 0 }, grade: { value: 0 }, fisheye: { value: 0 }, radial: { value: 0 }, shake: { value: new THREE.Vector2() }, res: { value: new THREE.Vector2(W, H) },
      ...Object.fromEntries(RETRO.map((k) => [k, { value: DEFAULT_POST[k] }])),
      risoPaper: { value: new THREE.Vector3() }, risoInk0: { value: new THREE.Vector3() }, risoInk1: { value: new THREE.Vector3() }, risoInk2: { value: new THREE.Vector3() },
      risoM: { value: new THREE.Matrix3() }, risoN: { value: 0 },
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
    }
    (f.shake!.value as THREE.Vector2).set(p.shake[0], p.shake[1]);
    this.final.render(renderer, out);
  }
}

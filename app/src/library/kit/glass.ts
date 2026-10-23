// 玻璃拟态：极光（大块高斯色团慢慢漂）、透视平面上的磨砂卡片、按 7 个波长折射的液态玻璃透镜、玻璃质感的字。
// 输出只取决于 t（确定性）。
//
// 为什么要它：shaders 库的 Glass（WebGPU）色散只有 RGB 三路，也没有透视卡片和描边，拼不出“玻璃 UI 浮在极光上”
// 这种画面。这里照 CSS backdrop-filter 的配方做：背景先渲进一张图，降采样后做可分离高斯（σ30 逻辑 px），
// 卡片 pass 读它，饱和度 ×1.38、叠 8.5% 白，边缘 13px 内把背景往里拉 24px（玻璃厚边的折射），受光侧 1px 亮描边；
// 卡片是相机看过去的一块倾斜平面（逐像素求视线和平面的交点，解析圆角矩形 SDF），所以推镜头、转角度都是真透视。
// 透镜和玻璃字按 7 个波长加权折射（IOR 1.5、色散 0.25），倒角是指数 2.5 的超椭圆。
// 配方的加减（饱和、叠白、高光）在显示空间（sRGB 编码值）里算，和网页上的玻璃拟态一个样；进出都转回线性 HDR。
// 玻璃字放在浅色极光上对比度会很低（参考片评委量到约 1.7:1），GlassText 带深色底池和贴字暗晕，字才读得清。
// 模糊图都在逻辑分辨率的 1/4 上做，不随 SCALE 变：4K 下和 1080p 一样，只是边更清楚。
// 参考 mg-styles-15 demos/12-aurora-glass（MIT，Vincentwei1021）的 shaders.js / main.js，按本引擎的管线重写。
//
//   const aurora = new Aurora(), cards = new FrostCard(), lens = new GlassLens(), title = new GlassText();
//   aurora.render(r, rtA, f.t, { gain: 1 });
//   title.setMask(key, (c) => { /* 白字 */ }); title.render(r, rtA, rtB, { pool: {...}, opacity });   // key 不变就不重画不重传
//   cards.draw(r, rtB, { plane: plane([960, 540, 0], 2, 6), w: 660, h: 470, radius: 42 }, cam, look, content);
//   lens.render(r, rtB, out, { x, y, hx: 200, hy: 110 }, { on: 1, mag: 1.3 });   // 最后一步：rtB → out
import * as THREE from 'three';
import { FSPass, Layer2D, makeRT, W, H } from '../../engine/gl';
import { clamp } from '../../engine/util';

export type Vec3 = [number, number, number];

// ---------------------------------------------------------------- pure helpers (tests/glass.test.ts)

/** Max taps a blur pass takes (centre + pairs); a sigma needing more is truncated at 3 sigma of what fits. */
export const MAX_TAPS = 32;
export interface Taps { off: Float32Array; w: Float32Array; n: number }

/**
 * Gaussian weights for a separable blur with linear-sampled taps (two texels per fetch): `off[i]` (texels) and `w[i]`,
 * i < n; the pass samples the centre once and ±off[i] for i ≥ 1. The weights sum to 1 (centre + 2 × the rest).
 */
export function gaussTaps(sigma: number): Taps {
  const s = Math.max(sigma, 1e-3);
  const R = Math.min(2 * MAX_TAPS - 3, Math.max(1, Math.ceil(s * 3)));
  const g: number[] = [];
  let sum = 0;
  for (let i = 0; i <= R; i++) { const v = Math.exp(-(i * i) / (2 * s * s)); g.push(v); sum += i ? 2 * v : v; }
  const off = new Float32Array(MAX_TAPS), w = new Float32Array(MAX_TAPS);
  w[0] = g[0]! / sum;
  let n = 1;
  for (let i = 1; i <= R; i += 2) {
    const a = g[i]! / sum, b = i + 1 <= R ? g[i + 1]! / sum : 0, ab = a + b;
    off[n] = ab > 0 ? (i * a + (i + 1) * b) / ab : i;
    w[n] = ab;
    n++;
  }
  return { off, w, n };
}

/**
 * A closed, smooth loop through anchor points (Catmull-Rom as cubic Bézier), one lap every `period` s, starting
 * `phase` (0..1) of the way round: the drift path of an aurora blob. At phase 0 it is at pts[0] at t = 0, pts[1] at
 * t = period / n, …
 */
export function loopPath(pts: readonly (readonly [number, number])[], period: number, phase = 0): (t: number) => [number, number] {
  const n = pts.length;
  return (t: number) => {
    const u = ((((t / period + phase) % 1) + 1) % 1) * n;
    const i = Math.floor(u) % n, s = u - Math.floor(u);
    const p0 = pts[(i - 1 + n) % n]!, p1 = pts[i]!, p2 = pts[(i + 1) % n]!, p3 = pts[(i + 2) % n]!;
    const a = 1 - s;
    const at = (k: 0 | 1) => {
      const c1 = p1[k] + (p2[k] - p0[k]) / 6, c2 = p2[k] - (p3[k] - p1[k]) / 6;
      return a * a * a * p1[k] + 3 * a * a * s * c1 + 3 * a * s * s * c2 + s * s * s * p2[k];
    };
    return [at(0), at(1)];
  };
}

/**
 * The perspective camera the glass cards are seen through, in design px (y down, z into the screen). Its eye sits at
 * (W/2 + x, H/2 + y, z − f): z = 0 shows the z = 0 plane at 1:1, z > 0 dollies in. `f` is the focal length in px.
 */
export interface GlassCam { x: number; y: number; z: number; f: number }
export const glassCam = (x = 0, y = 0, z = 0, f = 2000): GlassCam => ({ x, y, z, f });
export const camEye = (c: GlassCam): Vec3 => [W / 2 + c.x, H / 2 + c.y, c.z - c.f];

/** Screen position (design px) of world point P, and its scale (screen px per world px; ≤ 0 behind the eye). */
export function project(P: Vec3, c: GlassCam): [x: number, y: number, s: number] {
  const O = camEye(c), dz = P[2] - O[2];
  return [W / 2 + (c.f * (P[0] - O[0])) / dz, H / 2 + (c.f * (P[1] - O[1])) / dz, c.f / dz];
}

/** A flat card in space: centre C and its local x (U), local y (V, down the card) and normal (N) axes. */
export interface Plane { C: Vec3; U: Vec3; V: Vec3; N: Vec3 }

/** Axes of a card turned rx, ry, rz degrees (R = Rz·Ry·Rx; rx > 0 tips the bottom edge away, ry > 0 swings the right edge toward the viewer). */
export function rotBasis(rx: number, ry: number, rz = 0): { U: Vec3; V: Vec3; N: Vec3 } {
  const d = Math.PI / 180, a = rx * d, b = ry * d, g = rz * d;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
  // columns of Rz·Ry·Rx
  const M = [
    [cg * cb, cg * sb * sa - sg * ca, cg * sb * ca + sg * sa],
    [sg * cb, sg * sb * sa + cg * ca, sg * sb * ca - cg * sa],
    [-sb, cb * sa, cb * ca],
  ];
  const col = (j: number): Vec3 => [M[0]![j]!, M[1]![j]!, M[2]![j]!];
  return { U: col(0), V: col(1), N: col(2) };
}

/** A card centred at C turned rx, ry, rz degrees. */
export function plane(C: Vec3, rx = 0, ry = 0, rz = 0): Plane { return { C: [...C], ...rotBasis(rx, ry, rz) }; }

/** World position of the card-local point (lx, ly) (px from the card's centre, y down the card). */
export function planePoint(p: Plane, lx: number, ly: number): Vec3 {
  return [p.C[0] + p.U[0] * lx + p.V[0] * ly, p.C[1] + p.U[1] * lx + p.V[1] * ly, p.C[2] + p.U[2] * lx + p.V[2] * ly];
}

/** Screen position and scale of a card-local point (what the card shader draws there). */
export const projectLocal = (p: Plane, lx: number, ly: number, c: GlassCam) => project(planePoint(p, lx, ly), c);

/**
 * The card-local point seen at screen position (x, y): the view ray through it meets the card's plane (the inverse of
 * projectLocal, and what the card shader does per pixel). null when the plane is edge-on or behind the eye.
 */
export function screenToPlane(x: number, y: number, p: Plane, c: GlassCam): [number, number] | null {
  const O = camEye(c), d: Vec3 = [x - W / 2, y - H / 2, c.f];
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const den = dot(d, p.N);
  if (Math.abs(den) < 1e-9) return null;
  const tt = dot([p.C[0] - O[0], p.C[1] - O[1], p.C[2] - O[2]], p.N) / den;
  if (tt <= 0) return null;
  const r: Vec3 = [O[0] + d[0] * tt - p.C[0], O[1] + d[1] * tt - p.C[1], O[2] + d[2] * tt - p.C[2]];
  return [dot(r, p.U), dot(r, p.V)];
}

/**
 * Turn a card's centre about a pivot: yaw (deg, about the vertical) then pitch (about the horizontal). Add `yaw` to the
 * card's ry and subtract `pitch` from its rx so it keeps facing the same way within the group (a slow orbit of a cluster
 * of cards: real parallax and a changing perspective on every pane).
 */
export function orbit(C: Vec3, yaw: number, pitch: number, pivot: Vec3): Vec3 {
  const d = Math.PI / 180, cy = Math.cos(yaw * d), sy = Math.sin(yaw * d), cp = Math.cos(pitch * d), sp = Math.sin(pitch * d);
  const dx = C[0] - pivot[0], dy = C[1] - pivot[1], dz = C[2] - pivot[2];
  const nx = cy * dx + sy * dz;
  let nz = -sy * dx + cy * dz;
  const ny = cp * dy - sp * nz;
  nz = sp * dy + cp * nz;
  return [pivot[0] + nx, pivot[1] + ny, pivot[2] + nz];
}

/**
 * Seven wavelength bands, violet → red, as RGB weights (each channel sums to 1): a refraction traced once per band at
 * its own index (ior + disp · k, k = +1 violet … −1 red) and summed with these weights splits white edges into spectra.
 */
export const SPECTRUM: readonly Vec3[] = [
  [0.0, 0.0, 0.3], [0.0, 0.1, 0.4], [0.0, 0.25, 0.25], [0.05, 0.35, 0.05], [0.25, 0.25, 0.0], [0.4, 0.05, 0.0], [0.3, 0.0, 0.0],
];

/** Height of a squircle bevel `x` (0 at the rim … 1 where the plateau starts) in: (1 − (1 − x)^e)^(1/e). */
export const bezelHeight = (x: number, e = 2.5) => Math.pow(1 - Math.pow(1 - clamp(x), e), 1 / e);

const hexRGB = (h: string): Vec3 => {
  const n = parseInt(h.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

// ---------------------------------------------------------------- GLSL shared by the passes

const f1 = (x: number) => x.toFixed(1);
const SPECTRUM_GLSL = `const vec3 G_SW[7] = vec3[7](${SPECTRUM.map((c) => `vec3(${c.map((v) => v.toFixed(2)).join(', ')})`).join(', ')});`;
const GLASS_GLSL = /* glsl */ `
const vec2 G_DS = vec2(${f1(W)}, ${f1(H)});
// design px (y down) of this fragment; only for passes drawn into a full-size target (makeRT(), out)
vec2 gDesign() { return vec2(FRAG_PX.x, G_DS.y - FRAG_PX.y); }
vec2 gUV(vec2 p) { return vec2(p.x / G_DS.x, 1.0 - p.y / G_DS.y); }
float gRBox(vec2 p, vec2 b, float r) { r = min(r, min(b.x, b.y)); vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
// the recipe's maths runs on display values (like CSS); in and out of the linear HDR pipeline here
vec3 gDisp(vec3 lin) { return toSRGB(max(lin, 0.0)); }
vec3 gLin(vec3 d) { return toLinear(max(d, 0.0)); }
${SPECTRUM_GLSL}`;

const CAM_GLSL = /* glsl */ `
uniform vec3 camO; uniform float camF;
// card-local px of the point the view ray through p meets on the plane; z = ray parameter (<= 0: behind the eye)
vec3 gPlane(vec2 p, vec3 C, vec3 U, vec3 V, vec3 N) {
  vec3 d = vec3(p.x - G_DS.x * 0.5, p.y - G_DS.y * 0.5, camF);
  float den = dot(d, N);
  float tt = abs(den) < 1e-6 ? -1.0 : dot(C - camO, N) / den;
  vec3 r = camO + d * tt - C;
  return vec3(dot(r, U), dot(r, V), tt);
}`;

const v3 = () => ({ value: new THREE.Vector3() });
const v2 = () => ({ value: new THREE.Vector2() });
const setV3 = (u: THREE.IUniform, v: readonly number[]) => (u.value as THREE.Vector3).set(v[0]!, v[1]!, v[2]!);
const setV2 = (u: THREE.IUniform, x: number, y: number) => (u.value as THREE.Vector2).set(x, y);

// ---------------------------------------------------------------- blur

/**
 * Downsample + separable Gaussian at 1/div of the LOGICAL canvas (not following SCALE: a soft image needs no more
 * resolution in 4K, and the look stays the same). One instance holds one result at a time: blur() returns its texture,
 * valid until the next call on the same instance.
 */
export class Frost {
  readonly w: number;
  readonly h: number;
  private a: THREE.WebGLRenderTarget;
  private b: THREE.WebGLRenderTarget;
  private down = new FSPass(/* glsl */ `
    uniform sampler2D src; uniform vec2 texel; uniform int n;
    void main() {
      // n x n bilinear taps on texel corners: an exact box over (2n)^2 source texels
      vec4 c = vec4(0.0);
      for (int j = 0; j < 8; j++) {
        if (j >= n) break;
        for (int i = 0; i < 8; i++) {
          if (i >= n) break;
          c += textureLod(src, vUv + texel * vec2(float(2 * i - n + 1), float(2 * j - n + 1)), 0.0);
        }
      }
      fragColor = c / float(n * n);
    }`, { src: { value: null }, texel: v2(), n: { value: 1 } });
  private pass = new FSPass(/* glsl */ `
    uniform sampler2D src; uniform vec2 dir; uniform float off[${MAX_TAPS}]; uniform float wt[${MAX_TAPS}]; uniform int n;
    void main() {
      vec4 c = textureLod(src, vUv, 0.0) * wt[0];
      for (int i = 1; i < ${MAX_TAPS}; i++) {
        if (i >= n) break;
        vec2 d = dir * off[i];
        c += (textureLod(src, vUv + d, 0.0) + textureLod(src, vUv - d, 0.0)) * wt[i];
      }
      fragColor = c;
    }`, { src: { value: null }, dir: v2(), off: { value: new Float32Array(MAX_TAPS) }, wt: { value: new Float32Array(MAX_TAPS) }, n: { value: 1 } });
  private tapCache = new Map<number, Taps>();

  constructor(readonly div = 4) {
    this.w = Math.max(1, Math.round(W / div));
    this.h = Math.max(1, Math.round(H / div));
    this.a = makeRT(this.w, this.h, { pxScale: 1, depthBuffer: false });
    this.b = makeRT(this.w, this.h, { pxScale: 1, depthBuffer: false });
  }

  /** Blur `src` (physical size srcW x srcH, any target or texture) by `sigma` LOGICAL px; all four channels. */
  blur(r: THREE.WebGLRenderer, src: THREE.Texture, srcW: number, srcH: number, sigma: number): THREE.Texture {
    const d = this.down.u;
    d.src!.value = src;
    setV2(d.texel!, 1 / srcW, 1 / srcH);
    d.n!.value = Math.max(1, Math.min(8, Math.round(srcW / this.w / 2)));
    this.down.render(r, this.a);
    const s = Math.round((sigma / this.div) * 100) / 100;
    if (s < 0.3) return this.a.texture;
    let taps = this.tapCache.get(s);
    if (!taps) { taps = gaussTaps(s); this.tapCache.set(s, taps); }
    const u = this.pass.u;
    u.off!.value = taps.off; u.wt!.value = taps.w; u.n!.value = taps.n;
    u.src!.value = this.a.texture; setV2(u.dir!, 1 / this.w, 0);
    this.pass.render(r, this.b);
    u.src!.value = this.b.texture; setV2(u.dir!, 0, 1 / this.h);
    this.pass.render(r, this.a);
    return this.a.texture;
  }

  /** Blur a full-size render target (makeRT() or the scene's `out`). */
  blurRT(r: THREE.WebGLRenderer, src: THREE.WebGLRenderTarget, sigma: number) { return this.blur(r, src.texture, src.width, src.height, sigma); }
}

// ---------------------------------------------------------------- aurora

/** One pool of light: colour (sRGB hex), Gaussian radii (design px), angle (deg), intensity, and where it drifts. */
export interface AuroraBlob { color: string; rx: number; ry: number; angle: number; intensity: number; path: (t: number) => [number, number] }

/** The reference's light field (1920 x 1080): violet, magenta, cyan, blue pools over deep indigo, 24–40 s drift loops. */
export const AURORA_BLOBS: AuroraBlob[] = [
  { color: '#7050FF', rx: 470, ry: 300, angle: 18, intensity: 1.15, path: loopPath([[600, 300], [780, 240], [840, 420], [560, 460]], 30, 0.05) },
  { color: '#B653F0', rx: 400, ry: 230, angle: -28, intensity: 0.9, path: loopPath([[1560, 170], [1720, 330], [1380, 360], [1300, 130]], 34, 0.6) },
  { color: '#34CFF0', rx: 360, ry: 260, angle: 32, intensity: 1.0, path: loopPath([[1500, 860], [1320, 700], [1160, 660], [1420, 980]], 26, 0.12) },
  { color: '#2F46F2', rx: 500, ry: 250, angle: -8, intensity: 0.95, path: loopPath([[820, 880], [560, 800], [700, 980], [1060, 920]], 36, 0.5) },
  { color: '#3320A8', rx: 560, ry: 380, angle: 0, intensity: 0.32, path: loopPath([[1020, 540], [1160, 470], [1080, 640], [880, 600]], 40, 0.3) },
  { color: '#8C8CFF', rx: 240, ry: 170, angle: 10, intensity: 0.45, path: loopPath([[1180, 420], [1060, 520], [900, 560], [1120, 360]], 24, 0.1) },
  { color: '#3036D8', rx: 460, ry: 210, angle: -6, intensity: 0.55, path: loopPath([[1180, 1090], [1320, 1040], [1060, 1010], [980, 1080]], 32, 0.2) },
];
const MAX_BLOBS = 8;

export interface AuroraOpts {
  /** Overall light level (1 = as designed; the reference blooms to ~1.17 on its drop). */
  gain?: number;
  /** Domain warp of the pools (px): the slow organic wobble of their edges. */
  warp?: number;
  /** Small drifting light motes (0..1), sharp enough that the frosted glass visibly blurs them. */
  motes?: number;
  /** >1 scales the field about the centre (a dolly in on the far background); parallax shifts it (design px). */
  zoom?: number;
  parallax?: readonly [number, number];
}

/**
 * A mesh-gradient light field: Gaussian pools of colour on a deep base, each drifting along its loop, their edges
 * slowly warped by noise; where pools overlap the light gets hotter, not muddier; faint vertical silk like an aurora
 * curtain. Fills `target` (linear HDR).
 */
export class Aurora {
  readonly pass = new FSPass(/* glsl */ `${GLASS_GLSL}
    uniform float t, gain, warp, motes, zoom; uniform int nBlob;
    uniform vec4 blob[${MAX_BLOBS}]; uniform vec2 blobE[${MAX_BLOBS}]; uniform vec3 blobC[${MAX_BLOBS}];
    uniform vec3 base; uniform vec2 par;
    void main() {
      vec2 p0 = gDesign();
      vec2 p = (p0 - G_DS * 0.5) / zoom + G_DS * 0.5 + par;
      vec2 q = p / G_DS.y;
      vec2 w = vec2(snoise(vec3(q * 0.9, t * 0.035)), snoise(vec3(q * 0.9 + vec2(5.2, 1.3), t * 0.035 + 11.0)));
      vec2 w2 = vec2(snoise(vec3(q * 2.1 + 3.1, t * 0.06)), snoise(vec3(q * 2.1 + 8.4, t * 0.06 + 4.0)));
      vec2 pw = p + w * warp + w2 * warp * 0.3;
      vec3 acc = vec3(0.0); float ws = 0.0;
      for (int i = 0; i < ${MAX_BLOBS}; i++) {
        if (i >= nBlob) break;
        vec2 d = pw - blob[i].xy;
        float ca = cos(blobE[i].y), sa = sin(blobE[i].y);
        d = vec2(ca * d.x + sa * d.y, -sa * d.x + ca * d.y) / vec2(blob[i].z, blobE[i].x);
        float g = exp(-dot(d, d)) * blob[i].w;
        acc += blobC[i] * g; ws += g;
      }
      vec3 mixc = acc / max(ws, 1e-4);
      float cov = pow(1.0 - exp(-ws * 1.5), 1.3);          // deep valleys between the pools of light
      vec3 col = mix(base, mixc, cov) + acc * 0.07;
      float core = smoothstep(0.75, 2.1, ws);             // overlapping pools get hot, not muddy
      col = mix(col, col * 1.22 + vec3(0.035, 0.03, 0.07), core * 0.55);
      col *= gain;
      float silk = snoise(vec3(p.x / 260.0 + w.x * 0.8, p.y / 1400.0, t * 0.05));
      col *= 1.0 + silk * 0.05 * cov;
      if (motes > 0.0) {
        vec3 m = vec3(0.0);
        for (int i = 0; i < 12; i++) {
          float fi = float(i);
          vec2 h = hash22(vec2(fi * 1.37 + 0.2, fi * 7.11 + 0.7));
          vec2 vel = (hash22(vec2(fi, 3.1)) - 0.5) * vec2(10.0, 6.0) + vec2(2.0, -3.0);   // <= 0.3 px a frame
          vec2 pos = h * (G_DS - 40.0) + 20.0 + vel * t;
          float sig = mix(3.0, 5.0, hash12(vec2(fi, 4.4)));
          float amp = mix(0.12, 0.25, hash12(vec2(fi, 5.5)));
          float tw = 0.8 + 0.2 * sin(t * (0.5 + hash12(vec2(fi, 2.2))) + fi * 2.1);
          float d = length(p - pos) * zoom;
          m += vec3(0.86, 0.9, 1.0) * exp(-d * d / (2.0 * sig * sig)) * amp * tw;
        }
        col += m * motes * (0.55 + 0.45 * cov);
      }
      fragColor = vec4(gLin(col), 1.0);
    }`, {
    t: { value: 0 }, gain: { value: 1 }, warp: { value: 150 }, motes: { value: 1 }, zoom: { value: 1 }, nBlob: { value: 0 },
    blob: { value: Array.from({ length: MAX_BLOBS }, () => new THREE.Vector4()) },
    blobE: { value: Array.from({ length: MAX_BLOBS }, () => new THREE.Vector2()) },
    blobC: { value: Array.from({ length: MAX_BLOBS }, () => new THREE.Vector3()) },
    base: v3(), par: v2(),
  });

  /** `blobs` positions and radii are in 1920 x 1080 px (scaled to the project's W x H); `base` is the colour between pools. */
  constructor(public blobs: AuroraBlob[] = AURORA_BLOBS, public base = '#040312') {}

  render(r: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, t: number, o: AuroraOpts = {}) {
    const u = this.pass.u, sx = W / 1920, sy = H / 1080;
    const n = Math.min(MAX_BLOBS, this.blobs.length);
    const B = u.blob!.value as THREE.Vector4[], E = u.blobE!.value as THREE.Vector2[], Cc = u.blobC!.value as THREE.Vector3[];
    for (let i = 0; i < n; i++) {
      const b = this.blobs[i]!, [x, y] = b.path(t);
      B[i]!.set(x * sx, y * sy, b.rx * sy, b.intensity);
      E[i]!.set(b.ry * sy, (b.angle * Math.PI) / 180 + 0.08 * Math.sin(t * 0.3 + i));
      Cc[i]!.set(...hexRGB(b.color));
    }
    u.nBlob!.value = n;
    u.t!.value = t;
    u.gain!.value = o.gain ?? 1;
    u.warp!.value = (o.warp ?? 150) * sy;
    u.motes!.value = o.motes ?? 1;
    u.zoom!.value = o.zoom ?? 1;
    setV2(u.par!, o.parallax?.[0] ?? 0, o.parallax?.[1] ?? 0);
    setV3(u.base!, hexRGB(this.base));
    this.pass.render(r, target);
  }
}

// ---------------------------------------------------------------- frosted cards

/** A card's shape in space: its plane, size and corner radius (design px). */
export interface GlassCard { plane: Plane; w: number; h: number; radius: number }

/** How a card looks this frame. Defaults are the reference's resting card. */
export interface CardLook {
  /** Overall presence 0..1. */
  opacity: number;
  /** UI content opacity, and mip bias for its texture (blurs the content as the pane leaves the focal plane). */
  contentA: number;
  lod: number;
  /** Soft edge (logical px): the pane passing through the focal plane. 0 = crisp. */
  defocus: number;
  /** Backdrop blur sigma (logical px); frost 0..1 scales the saturation and white fill. */
  blur: number;
  frost: number;
  /** Saturation of the frosted backdrop (1.38) and white fill (0.085), display units. */
  saturate: number;
  fill: number;
  /** Rim refraction: within `rimWidth` px of the edge the backdrop is pulled `rimPull` px inward. */
  rimWidth: number;
  rimPull: number;
  /** Toward the key light, 2D design space (y down): the lit bevel and the brighter stroke face it. */
  light: readonly [number, number];
  /** Broad diagonal sheen position (−1..1, moves with tilt) and a travelling catch-light [position, amplitude]. */
  sheen: number;
  glint: readonly [number, number];
  /** Lit-edge stroke boost (1 = the 1 px inner stroke as designed). */
  edge: number;
  /** Drop shadow cast on what is behind (0 = none; the reference uses 0.34) and how far down it falls (px). */
  shadow: number;
  shadowDrop: number;
}

export const CARD_LOOK: CardLook = {
  opacity: 1, contentA: 1, lod: 0, defocus: 0, blur: 30, frost: 1, saturate: 1.38, fill: 0.085, rimWidth: 13, rimPull: 24,
  light: [-0.55, -0.83], sheen: 0, glint: [0, 0], edge: 1, shadow: 0.34, shadowDrop: 34,
};

/** UI drawn on a card: a texture (premultiplied alpha, e.g. an atlas Layer2D) and the card's rect in it as UV [u0, vTop, du, dv]. */
export interface CardContent { tex: THREE.Texture; rect: readonly [number, number, number, number] }

/**
 * Frosted glass panes seen in perspective. Each draw() shades what is already in `target` (drop shadow), blurs it and
 * draws the pane over it, so panes drawn back to front frost the ones behind them. One instance draws any number of cards.
 */
export class FrostCard {
  private frost = new Frost(4);
  private shadowPass = new FSPass(/* glsl */ `${GLASS_GLSL}${CAM_GLSL}
    uniform vec3 C, U, V, N; uniform vec2 halfSize; uniform float rad, k, drop;
    void main() {
      vec2 p = gDesign();
      vec3 L = gPlane(p - vec2(0.0, drop), C, U, V, N);
      float sd = gRBox(L.xy, halfSize, rad);
      float sh = L.z > 0.0 ? (1.0 - smoothstep(-46.0, 84.0, sd)) * k : 0.0;
      // the reference darkens display values by (1 - sh): the same in linear light
      fragColor = vec4(0.0, 0.0, 0.0, 1.0 - pow(1.0 - sh, 2.2));
    }`, { camO: v3(), camF: { value: 2000 }, C: v3(), U: v3(), V: v3(), N: v3(), halfSize: v2(), rad: { value: 0 }, k: { value: 0 }, drop: { value: 34 } },
  { blending: THREE.CustomBlending, transparent: true });
  private pass = new FSPass(/* glsl */ `${GLASS_GLSL}${CAM_GLSL}
    uniform vec3 C, U, V, N; uniform vec2 halfSize; uniform float rad;
    uniform float opacity, contentA, lod, frost, defocus, satK, fill, rimW, rimPull, sheen, edge;
    uniform vec2 light, glint;
    uniform sampler2D blurTex, content; uniform vec4 cRect; uniform bool hasContent;
    void main() {
      vec2 p = gDesign();
      vec3 Lz = gPlane(p, C, U, V, N);
      if (Lz.z <= 0.0) discard;
      vec2 L = Lz.xy;
      float sd = gRBox(L, halfSize, rad);
      float pxw = max(fwidth(sd) * PX_SCALE, 1e-4);   // card px per logical screen px
      float sdS = sd / pxw;                            // signed distance in logical screen px
      float dw = max(defocus, 0.5 / PX_SCALE);
      float cov = clamp(0.5 - sdS / (2.0 * dw), 0.0, 1.0);
      if (cov <= 0.0) discard;
      // outward normal of the rounded box (card space), and its direction on screen
      float r = min(rad, min(halfSize.x, halfSize.y));
      vec2 qq = abs(L) - halfSize + r;
      vec2 g = qq.x > 0.0 && qq.y > 0.0 ? normalize(qq) : (qq.x > qq.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
      g *= sign(L + 1e-6);
      vec2 gs = normalize((g.x * U + g.y * V).xy + 1e-6);
      float inside = max(-sdS, 0.0);
      // thickness: the backdrop is pulled inward near the rim (the glass edge refracts)
      float rim = 1.0 - smoothstep(0.0, rimW, inside);
      vec2 offs = -gs * pow(rim, 1.3) * rimPull;
      vec3 bb = gDisp(textureLod(blurTex, gUV(p + offs), 0.0).rgb);
      // backdrop-filter: blur + saturate + a white fill
      float l = luma(bb);
      bb = max(mix(vec3(l), bb, 1.0 + (satK - 1.0) * frost), 0.0);
      vec3 col = bb * 1.02 + vec3(fill) * frost + vec3(0.012, 0.012, 0.03);
      // inner glow along the rim (the thickness catching light), stronger on the lit side
      float facing = clamp(dot(gs, light) * 0.5 + 0.5, 0.0, 1.0);
      col += (1.0 - smoothstep(0.0, 26.0, inside)) * (0.018 + 0.05 * facing * facing);
      // broad diagonal sheen (a soft box reflected), a travelling catch-light, top-left a touch brighter
      vec2 uvn = L / halfSize;
      float band = dot(uvn, vec2(0.8, 0.6));
      col += 0.045 * exp(-pow((band - sheen) / 0.45, 2.0));
      col += vec3(0.93, 0.95, 1.0) * glint.y * exp(-pow((band - glint.x) / 0.16, 2.0)) * (0.6 + 0.4 * smoothstep(0.0, 30.0, inside));
      col += 0.035 * (1.0 - clamp((uvn.y + uvn.x * 0.4 + 1.0) * 0.5, 0.0, 1.0));
      // UI content (premultiplied: the display round trip of the sRGB texture keeps premultiplied values exact)
      if (hasContent) {
        vec2 cuv = (L + halfSize) / (2.0 * halfSize);
        vec4 c = texture(content, vec2(cRect.x + cuv.x * cRect.z, cRect.y - cuv.y * cRect.w), lod);
        col = col * (1.0 - c.a * contentA) + gDisp(c.rgb) * contentA;
      }
      // 1 px inner highlight stroke, brighter on the lit edge
      float sw = 0.9 + max(defocus - 0.5, 0.0) * 1.5;
      float stroke = clamp(1.0 - abs(inside - sw) / sw, 0.0, 1.0) * (0.9 / sw);
      float sa = min(mix(0.14, 0.7, pow(facing, 1.6)) * edge, 0.95);
      col = mix(col, vec3(1.0), stroke * sa);
      fragColor = vec4(gLin(col), 1.0) * cov * opacity;
    }`, {
    camO: v3(), camF: { value: 2000 }, C: v3(), U: v3(), V: v3(), N: v3(), halfSize: v2(), rad: { value: 0 },
    opacity: { value: 1 }, contentA: { value: 1 }, lod: { value: 0 }, frost: { value: 1 }, defocus: { value: 0 }, satK: { value: 1.38 },
    fill: { value: 0.085 }, rimW: { value: 13 }, rimPull: { value: 24 }, sheen: { value: 0 }, edge: { value: 1 },
    light: v2(), glint: v2(), blurTex: { value: null }, content: { value: null }, cRect: { value: new THREE.Vector4(0, 1, 1, 1) }, hasContent: { value: false },
  }, { blending: THREE.CustomBlending, transparent: true });

  constructor() {
    const s = this.shadowPass.mat;   // multiply by (1 - a)
    s.blendEquation = THREE.AddEquation; s.blendSrc = THREE.ZeroFactor; s.blendDst = THREE.OneMinusSrcAlphaFactor;
    s.blendSrcAlpha = THREE.ZeroFactor; s.blendDstAlpha = THREE.OneFactor;
    const m = this.pass.mat;         // premultiplied over
    m.blendEquation = THREE.AddEquation; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
    m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  }

  private place(u: Record<string, THREE.IUniform>, card: GlassCard, cam: GlassCam) {
    setV3(u.camO!, camEye(cam)); u.camF!.value = cam.f;
    setV3(u.C!, card.plane.C); setV3(u.U!, card.plane.U); setV3(u.V!, card.plane.V); setV3(u.N!, card.plane.N);
    setV2(u.halfSize!, card.w / 2, card.h / 2); u.rad!.value = card.radius;
  }

  /** Shadow, frost and draw one card over `target` (a full-size makeRT()). */
  draw(r: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, card: GlassCard, cam: GlassCam, look: Partial<CardLook> = {}, content?: CardContent) {
    const k = { ...CARD_LOOK, ...look };
    if (k.opacity <= 0.001) return;
    if (k.shadow > 0) {
      const s = this.shadowPass.u;
      this.place(s, card, cam);
      s.k!.value = k.shadow * k.opacity; s.drop!.value = k.shadowDrop;
      this.shadowPass.render(r, target);
    }
    const u = this.pass.u;
    u.blurTex!.value = this.frost.blurRT(r, target, k.blur);
    this.place(u, card, cam);
    u.opacity!.value = k.opacity; u.contentA!.value = k.contentA; u.lod!.value = k.lod; u.frost!.value = k.frost;
    u.defocus!.value = k.defocus; u.satK!.value = k.saturate; u.fill!.value = k.fill; u.rimW!.value = k.rimWidth; u.rimPull!.value = k.rimPull;
    u.sheen!.value = k.sheen; u.edge!.value = k.edge;
    setV2(u.light!, k.light[0], k.light[1]); setV2(u.glint!, k.glint[0], k.glint[1]);
    u.hasContent!.value = !!content;
    u.content!.value = content?.tex ?? null;
    if (content) (u.cRect!.value as THREE.Vector4).set(...content.rect);
    this.pass.render(r, target);
  }
}

// ---------------------------------------------------------------- liquid glass lens

/** The lens outline: centre and half size (design px), corner radius (default min(hx, hy): a capsule), ring width (0 = solid). */
export interface LensShape { x: number; y: number; hx: number; hy: number; r?: number; ringW?: number }

export interface LensLook {
  /** Presence 0..1 (0 = the pass only copies the scene). */
  on: number;
  /** Bevel width (px; default min(hx, hy) · 0.55, at most 60) and slab depth (px; default bevel · 0.9). */
  bezel: number;
  depth: number;
  /** Refractive index and its spread over the seven bands (violet ior + disp … red ior − disp). */
  ior: number;
  disp: number;
  /** Magnification of the plateau, the cap on the bevel's displacement (px; default bevel · 0.85), and its direction. */
  mag: number;
  maxDisp: number;
  refrSign: number;
  /** Superellipse exponent of the bevel. */
  bzExp: number;
  /** Height above what is behind it 0..1 (a softer, further shadow and a caustic of gathered light). */
  lift: number;
  caustic: number;
  /** Travelling glint across the plateau (−1.8..1.8). */
  glint: number;
  /** Frost at the very rim, Fresnel reflection of the surroundings, rim glow, a bright lit ring edge (0..1). */
  frostRim: number;
  fres: number;
  rimGlow: number;
  ringLit: number;
  /** Key light direction (design space, y down; z toward the viewer). */
  light: readonly [number, number, number];
}

export const LENS_LOOK: LensLook = {
  on: 1, bezel: -1, depth: -1, ior: 1.5, disp: 0.25, mag: 1, maxDisp: -1, refrSign: -1, bzExp: 2.5, lift: 0, caustic: 0,
  glint: -2, frostRim: 0.1, fres: 0.25, rimGlow: 1, ringLit: 0, light: [-0.5, -0.78, 0.62],
};

/**
 * A slab of clear glass (rounded box or capsule, optionally an annulus) over the scene: a squircle bevel whose
 * normals refract the scene in seven wavelength bands (spectral fringes on every edge it crosses), a magnifying
 * plateau, Fresnel reflection, key and bounce speculars, a lit rim, a soft lifted shadow. Writes the whole frame:
 * `scene` → `target` (two different targets).
 */
export class GlassLens {
  private frost = new Frost(4);
  readonly pass = new FSPass(/* glsl */ `${GLASS_GLSL}
    uniform sampler2D scene, blurTex;
    uniform vec2 lc, lh; uniform float lr, on, bezel, depth, ior, disp, mag, maxDisp, refrSign, lift, glint;
    uniform float frostRim, rimGlow, ringLit, caustic, fres, bzExp, ringW;
    uniform vec3 light3;
    float lOuter(vec2 p) { return gRBox(p - lc, lh, lr); }
    float lSDF(vec2 p) { float d = lOuter(p); return ringW > 0.0 ? max(d, -d - ringW) : d; }
    float lHeight(vec2 p) { float x = clamp(-lSDF(p) / bezel, 0.0, 1.0); return pow(1.0 - pow(1.0 - x, bzExp), 1.0 / bzExp); }
    vec3 lScene(vec2 p) {
      vec3 c = gDisp(textureLod(scene, gUV(p), 0.0).rgb);
      float s = lSDF(p - vec2(0.0, 8.0 + 22.0 * lift));
      float soft = 8.0 + 30.0 * lift;
      float sh = (1.0 - smoothstep(-soft, soft * 1.8, s)) * (0.16 + 0.16 * lift) * on;
      float rr = min(lh.x, lh.y);
      float ca = smoothstep(-0.25 * rr, -0.85 * rr, s) * caustic * on;   // light gathered by the glass
      return c * (1.0 - sh) + c * ca;
    }
    void main() {
      vec2 p = gDesign();
      if (on <= 0.0) { fragColor = vec4(textureLod(scene, gUV(p), 0.0).rgb, 1.0); return; }
      vec3 base = lScene(p);
      float sd = lSDF(p);
      if (sd > 2.0) { fragColor = vec4(gLin(base), 1.0); return; }
      float e = 0.75;
      float hx = lHeight(p + vec2(e, 0.0)) - lHeight(p - vec2(e, 0.0));
      float hy = lHeight(p + vec2(0.0, e)) - lHeight(p - vec2(0.0, e));
      vec3 Nn = normalize(vec3(-hx / (2.0 * e) * depth, -hy / (2.0 * e) * depth, 1.0));
      vec2 gN = length(Nn.xy) > 1e-4 ? normalize(Nn.xy) : vec2(0.0);   // outward in the bevel
      float edgeX = clamp(-sd / bezel, 0.0, 1.0);                       // 0 at the rim .. 1 on the plateau
      // seven wavelength bands, each refracted at its own index
      vec3 I = vec3(0.0, 0.0, -1.0), acc = vec3(0.0);
      for (int i = 0; i < 7; i++) {
        float k = (3.0 - float(i)) / 3.0;                                // +1 violet .. -1 red
        vec3 R = refract(I, Nn, 1.0 / (ior + disp * k));
        vec2 dsp = R.xy / max(-R.z, 0.25) * depth;
        dsp *= min(1.0, maxDisp * (1.0 + 2.5 * disp * k) / max(length(dsp), 1e-3)) * refrSign;
        float mg = mag * (1.0 + disp * 0.04 * k);
        acc += lScene(lc + (p - lc) / mg + dsp) * G_SW[i];
      }
      vec3 col = acc;
      // a whisper of frost only at the very rim; a clear, bright body
      vec3 bl = gDisp(textureLod(blurTex, gUV(p - gN * 24.0), 0.0).rgb);
      col = mix(col, bl * 1.1 + 0.03, frostRim * pow(1.0 - edgeX, 3.0));
      col = mix(vec3(luma(col)), col, 1.08) * 1.035 + 0.01;
      // fresnel: the bevel reflects the surrounding light
      float Fr = pow(1.0 - Nn.z, 1.6);
      vec3 refl = gDisp(textureLod(blurTex, gUV(p + gN * 120.0), 0.0).rgb) * 1.35 + 0.1;
      col = mix(col, refl, clamp(Fr * fres, 0.0, 0.5));
      // specular: key light + a softer bounce from the opposite side
      vec3 Lk = normalize(light3), Lb = normalize(vec3(-light3.x, -light3.y, light3.z)), Vv = vec3(0.0, 0.0, 1.0);
      col += pow(max(dot(reflect(-Lk, Nn), Vv), 0.0), 18.0) * 0.75;
      col += vec3(0.85, 0.92, 1.0) * pow(max(dot(reflect(-Lb, Nn), Vv), 0.0), 26.0) * 0.28;
      // rim: a thin bright edge and a soft inner glow, brightest on the lit and bounce sides
      float facing = dot(gN, normalize(light3.xy));
      float lit = pow(max(facing, 0.0), 2.0) + 0.55 * pow(max(-facing, 0.0), 2.0);
      float line = clamp(1.0 - abs(-sd - 0.8), 0.0, 1.0);
      col = mix(col, vec3(1.0), line * (0.28 + 0.62 * lit));
      col += exp(sd / 5.0) * (0.05 + 0.14 * lit) * rimGlow;
      col = mix(col, vec3(1.0), ringLit * smoothstep(6.5, 3.0, -sd) * (0.55 + 0.45 * lit));
      col *= 1.0 - 0.08 * (1.0 - edgeX) * max(-facing, 0.0) * (1.0 - lit);   // the far side in shade: volume
      vec2 lp = (p - lc) / max(lh, vec2(1.0));
      col += exp(-pow((dot(lp, normalize(vec2(1.0, -0.4))) - glint) / 0.1, 2.0)) * edgeX * 0.05;
      float cov = clamp(0.5 - sd * PX_SCALE, 0.0, 1.0) * on;
      fragColor = vec4(gLin(mix(base, col, cov)), 1.0);
    }`, {
    scene: { value: null }, blurTex: { value: null }, lc: v2(), lh: v2(), lr: { value: 0 }, on: { value: 0 },
    bezel: { value: 20 }, depth: { value: 18 }, ior: { value: 1.5 }, disp: { value: 0.25 }, mag: { value: 1 }, maxDisp: { value: 17 },
    refrSign: { value: -1 }, lift: { value: 0 }, glint: { value: -2 }, frostRim: { value: 0.1 }, rimGlow: { value: 1 }, ringLit: { value: 0 },
    caustic: { value: 0 }, fres: { value: 0.25 }, bzExp: { value: 2.5 }, ringW: { value: 0 }, light3: v3(),
  });

  render(r: THREE.WebGLRenderer, scene: THREE.WebGLRenderTarget, target: THREE.WebGLRenderTarget, s: LensShape | null, look: Partial<LensLook> = {}) {
    const k = { ...LENS_LOOK, ...look }, u = this.pass.u;
    u.scene!.value = scene.texture;
    const on = s && s.hx > 0.5 && s.hy > 0.5 ? clamp(k.on) : 0;
    u.on!.value = on;
    if (on > 0 && s) {
      u.blurTex!.value = this.frost.blurRT(r, scene, 22);
      const ringW = s.ringW ?? 0;
      let bezel = k.bezel > 0 ? k.bezel : Math.min(Math.min(s.hx, s.hy) * 0.55, 60);
      if (ringW > 0) bezel = Math.min(bezel, ringW * 0.5);
      setV2(u.lc!, s.x, s.y); setV2(u.lh!, s.hx, s.hy); u.lr!.value = s.r ?? Math.min(s.hx, s.hy); u.ringW!.value = ringW;
      u.bezel!.value = bezel; u.depth!.value = k.depth > 0 ? k.depth : bezel * 0.9; u.maxDisp!.value = k.maxDisp > 0 ? k.maxDisp : bezel * 0.85;
      u.ior!.value = k.ior; u.disp!.value = k.disp; u.mag!.value = k.mag; u.refrSign!.value = k.refrSign; u.bzExp!.value = k.bzExp;
      u.lift!.value = k.lift; u.caustic!.value = k.caustic; u.glint!.value = k.glint; u.frostRim!.value = k.frostRim; u.fres!.value = k.fres;
      u.rimGlow!.value = k.rimGlow; u.ringLit!.value = k.ringLit;
      setV3(u.light3!, k.light);
    }
    this.pass.render(r, target);
  }
}

// ---------------------------------------------------------------- glass lettering

export interface GlassTextOpts {
  /** Toward the key light (design space, y down). */
  light: readonly [number, number];
  /** How far the body bends what is behind it (px at full slope); index and spread of the seven bands. */
  refr: number;
  ior: number;
  disp: number;
  /** Drop shadow [dx, dy, strength] outside the glass. */
  shadow: readonly [number, number, number];
  /** Frost/white lift of the body, gain of the refracted backdrop, saturation of it, gain of the lit rim. */
  lift: number;
  body: number;
  saturate: number;
  rim: number;
  /**
   * Contrast: a deep pool in the light behind the lockup (rounded rect, design px; k 0..1) and a dark halo hugging the
   * glyphs. Without them glass letters on a pale aurora sit near 1.7:1.
   */
  pool: { x: number; y: number; hw: number; hh: number; k: number; radius?: number; falloff?: number } | null;
  halo: number;
  /** A specular sweep across the letters: [position along the diagonal from `center` (px), width (px), amplitude]. */
  sweep: readonly [number, number, number];
  center: readonly [number, number];
  /**
   * Presence of the glass (and its shadow and halo) 0..1. Fade the lettering in with this, not with the mask's alpha:
   * a half-transparent mask makes a low, faceted bevel.
   */
  opacity: number;
  /** The lettering scaled by s about (cx, cy) (design px): a slow push on a held title without redrawing the mask. */
  zoom: readonly [number, number, number];
}

export const GLASS_TEXT: GlassTextOpts = {
  light: [-0.55, -0.83], refr: 30, ior: 1.5, disp: 0.25, shadow: [5, 11, 0.34], lift: 0.15, body: 1.16, saturate: 1.42, rim: 1.35,
  pool: null, halo: 0.34, sweep: [0, 70, 0], center: [W / 2, H / 2], opacity: 1, zoom: [W / 2, H / 2, 1],
};

/**
 * Frosted glass letters. Draw the lettering white into the mask with setMask() (a W x H Layer2D, alpha = glass), then
 * render(): a narrow blur of the mask is the bevel, a wide one the dome and the drop shadow; the body is the frosted
 * scene refracted in seven bands, with a lit rim, a specular edge line, a caustic on the far edge and an inner shade.
 * Writes the whole frame: `scene` → `target`. Draw other (flat) text over target afterwards.
 * A held title costs no upload or blur: the mask and its blurs are only redone when setMask's key changes.
 */
export class GlassText {
  /** The glass lettering (white; alpha is the glass), W x H logical. Draw it through setMask(). */
  readonly mask = new Layer2D();
  private maskKey: string | null = null;
  private dirty = true;

  /**
   * Draw the lettering: `draw` runs on the cleared mask only when `key` differs from the last call's. Make the key
   * capture everything the drawing depends on (and draw from the key's values, e.g. rounded offsets), so the output
   * stays a pure function of t whatever order sub-frames come in.
   */
  setMask(key: string, draw: (c: CanvasRenderingContext2D) => void) {
    if (key === this.maskKey) return;
    this.maskKey = key;
    this.mask.clear();
    draw(this.mask.ctx);
    this.dirty = true;
  }

  /** After drawing into `mask` yourself (not through setMask): re-upload and re-blur on the next render. */
  invalidate() { this.maskKey = null; this.dirty = true; }
  private narrow = new Frost(1);
  private wide = new Frost(4);
  private frosted = new Frost(4);
  readonly pass = new FSPass(/* glsl */ `${GLASS_GLSL}
    uniform sampler2D scene, frostTex, mask, mN, mW;
    uniform vec2 light, center; uniform float refr, ior, disp, lift, body, satK, rim, halo, opacity;
    uniform vec3 shadow, sweep, zoom; uniform vec4 pool; uniform vec3 poolK;
    // the mask and its blurs are sampled through the zoom (screen px -> mask px)
    float mA(sampler2D s, vec2 p) { return textureLod(s, gUV(zoom.xy + (p - zoom.xy) / zoom.z), 0.0).a; }
    void main() {
      vec2 p = gDesign();
      vec3 bg = gDisp(textureLod(scene, gUV(p), 0.0).rgb);
      float m = clamp(mA(mask, p), 0.0, 1.0), mo = m * opacity;
      // contrast: the light deepens behind the lockup (hue kept) and a soft dark halo hugs each glyph
      if (poolK.x > 0.0) {
        float sdp = gRBox(p - pool.xy, pool.zw, poolK.y);
        float pl = poolK.x * (1.0 - smoothstep(-0.3 * poolK.z, poolK.z, sdp));
        bg = mix(bg, bg * vec3(0.50, 0.47, 0.72) + vec3(0.004, 0.003, 0.018), pl);
        bg *= 1.0 - halo * opacity * poolK.x * clamp(mA(mW, p) * 2.2, 0.0, 1.0) * (1.0 - m);
      }
      // drop shadow (light from the top left falls down-right), soft and wide, only outside the glass
      float sh = mA(mW, p - shadow.xy), shN = mA(mN, p - shadow.xy * 0.45);
      bg *= 1.0 - shadow.z * opacity * clamp(sh * 0.75 + shN * 0.45, 0.0, 1.0) * (1.0 - m);
      if (mo <= 0.002) { fragColor = vec4(gLin(bg), 1.0); return; }
      // height field and slopes (design px)
      float e = 1.25, ew = 4.0;
      float hN = mA(mN, p);
      vec2 gN = vec2(mA(mN, p + vec2(e, 0.0)) - mA(mN, p - vec2(e, 0.0)), mA(mN, p + vec2(0.0, e)) - mA(mN, p - vec2(0.0, e))) / (2.0 * e);
      vec2 gW = vec2(mA(mW, p + vec2(ew, 0.0)) - mA(mW, p - vec2(ew, 0.0)), mA(mW, p + vec2(0.0, ew)) - mA(mW, p - vec2(0.0, ew))) / (2.0 * ew);
      vec3 Nn = normalize(vec3(-(gN * 7.5 + gW * 5.0), 1.0));
      float gl = length(gN);
      vec2 nd = gl > 1e-4 ? -gN / gl : vec2(0.0);                // outward direction of the nearest edge
      float bev = 1.0 - smoothstep(0.42, 0.97, hN);              // 1 at the edge .. 0 on the flat top
      float facing = dot(nd, normalize(light));                  // +1: the edge faces the light
      // body: the frosted scene bent through the glass, seven bands (spectral fringes along the bevels)
      vec3 I = vec3(0.0, 0.0, -1.0), fr = vec3(0.0);
      float k0 = 1.0 - 1.0 / ior;
      for (int i = 0; i < 7; i++) {
        float k = (3.0 - float(i)) / 3.0;
        vec3 R = refract(I, Nn, 1.0 / (ior + disp * k));
        vec2 d = R.xy / max(-R.z, 0.25) / k0;                    // ~ -N.xy at the middle band
        fr += gDisp(textureLod(frostTex, gUV(p + d * refr), 0.0).rgb) * G_SW[i];
      }
      fr = max(mix(vec3(luma(fr)), fr, satK), 0.0);
      vec3 col = fr * body + vec3(lift) + vec3(0.01, 0.012, 0.035);
      col += 0.07 * clamp(-Nn.y * 3.0, -1.0, 1.0);               // tops of the strokes catch the sky
      col *= 1.0 - 0.42 * pow(bev, 0.8) * pow(max(-facing, 0.0), 1.1);   // the far bevel refracts the dark underside
      col += bev * (0.07 + 0.55 * rim * pow(max(facing, 0.0), 1.7));      // the lit bevel reflects the key light
      float edgeBand = smoothstep(0.34, 0.5, hN) * (1.0 - smoothstep(0.5, 0.72, hN));
      col += vec3(1.0, 0.93, 0.86) * edgeBand * pow(max(-facing, 0.0), 2.0) * 0.42;   // caustic on the far edge
      col = mix(col, vec3(1.0), edgeBand * (0.22 + 0.7 * pow(max(facing, 0.0), 1.4)));   // specular edge line
      vec3 Lk = normalize(vec3(light, 0.9));
      col += pow(max(dot(reflect(-Lk, Nn), vec3(0.0, 0.0, 1.0)), 0.0), 24.0) * 0.55;
      if (sweep.z > 0.0) {
        float d = dot(p - center, normalize(vec2(0.86, 0.5))) - sweep.x;
        col += vec3(1.0, 0.98, 0.95) * sweep.z * exp(-d * d / (sweep.y * sweep.y)) * (0.35 + 0.65 * bev);
      }
      fragColor = vec4(gLin(mix(bg, col, mo)), 1.0);
    }`, {
    scene: { value: null }, frostTex: { value: null }, mask: { value: null }, mN: { value: null }, mW: { value: null },
    light: v2(), center: v2(), refr: { value: 30 }, ior: { value: 1.5 }, disp: { value: 0.25 }, lift: { value: 0.15 }, body: { value: 1.16 },
    satK: { value: 1.42 }, rim: { value: 1.35 }, halo: { value: 0.34 }, opacity: { value: 1 }, shadow: v3(), sweep: v3(), zoom: { value: new THREE.Vector3(W / 2, H / 2, 1) }, pool: { value: new THREE.Vector4() }, poolK: v3(),
  });

  render(r: THREE.WebGLRenderer, scene: THREE.WebGLRenderTarget, target: THREE.WebGLRenderTarget, o: Partial<GlassTextOpts> = {}) {
    const k = { ...GLASS_TEXT, ...o }, u = this.pass.u, cv = this.mask.canvas;
    if (this.dirty) {
      const mt = this.mask.upload();
      u.mask!.value = mt;
      u.mN!.value = this.narrow.blur(r, mt, cv.width, cv.height, 4.5);
      u.mW!.value = this.wide.blur(r, mt, cv.width, cv.height, 12);
      this.dirty = false;
    }
    u.scene!.value = scene.texture;
    u.frostTex!.value = this.frosted.blurRT(r, scene, 18);
    setV2(u.light!, k.light[0], k.light[1]); setV2(u.center!, k.center[0], k.center[1]);
    u.refr!.value = k.refr; u.ior!.value = k.ior; u.disp!.value = k.disp; u.lift!.value = k.lift; u.body!.value = k.body;
    u.satK!.value = k.saturate; u.rim!.value = k.rim; u.halo!.value = k.halo; u.opacity!.value = clamp(k.opacity);
    setV3(u.shadow!, k.shadow); setV3(u.sweep!, k.sweep); setV3(u.zoom!, k.zoom);
    const pl = k.pool;
    (u.pool!.value as THREE.Vector4).set(pl?.x ?? 0, pl?.y ?? 0, pl?.hw ?? 0, pl?.hh ?? 0);
    setV3(u.poolK!, [pl ? clamp(pl.k) : 0, pl?.radius ?? 170, pl?.falloff ?? 240]);
    this.pass.render(r, target);
  }
}

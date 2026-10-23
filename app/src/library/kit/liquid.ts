// 液态：融球、拉丝和果冻字标。输出只取决于 t（确定性）。
//
// 做什么：一组二维图元（椭圆液滴、两头粗细不同的线段、字形距离场）用 log-sum-exp 平滑并集融成一张距离场，
// 颜色和梯度跟着一起混；再从“离边缘多深”推出假高度和法线，着色成有厚度的液体：厚处色深、背光一侧透出亮边、
// 菲涅尔反射一个手写的影棚柔光箱。阴影、地面倒影、接触压暗都是把同一张场偏移后重采样；背景是深紫影棚，
// 也可以换成场景自己渲的纹理。
// 为什么：MV 里的“液体”多半是平面上鼓起来的果冻、糖浆：落下、融合、拉丝、断开、长成字。真流体模拟慢、不可控，
// 也做不到每帧只取决于 t；这里每个图元都是 t 的函数（下面的 fallingDrop / splash / hop / strand / drip 等），
// 导出时子帧按任意顺序渲都一样。
// 字形：Canvas2D 画字 → 距离变换 → 边角倒圆（表面张力，方角会在边缘露出中轴的折痕）→ 边缘 σ2、内部 σ5–11 两档
// 模糊按深度混合，去掉笔画中线上的脊，一个字一格存进半浮点图集（距离 + 梯度，一次取样就有连续的法线）。
// 限制：高度是假的（2.5D，只由离边缘多远决定），只适合正面机位：不能转镜头、不能从侧面看；倒影是沿一条地面线
// 镜像，所有东西都当作站在同一个深度上。字形场在 CPU 上算（init 里，一个字约 0.1 s），最多 8 个字。
// 高光压缩和抖色在这个 shader 里做（引擎后期默认全关）：高光按最大通道压，保住橙、粉、紫的色相；
// 三角分布抖色（每帧换一次，子帧之间不变）防深紫渐变的色带。场景再开引擎的 shoulder 就压了两遍，别开。
// 参考 mg-styles-15 demos/07-liquid（MIT，Vincentwei1021）：平滑并集、字形距离场的边缘 / 内部两档模糊、
// 高度公式 h = Hc·tanh(√(2Rx)/Hc)、着色和影棚、阴影倒影的重采样。
//
//   const word = buildWord('flow', F.archivo(100, 900), 400);       // init 里
//   const pass = new LiquidPass({ word });
//   const g = goo();
//   fallingDrop(g, t, { x: 700, tLand: 2, r: 50, u: 0.05, floor: 800 });
//   splash(g, t, { x: 700, tLand: 2, r: 50, u: 0.05, floor: 800, seed: 1 });
//   g.letters.push({ i: 0, x: 620, y: 660, u: 0.04 });               // 第 0 个字的墨迹中心放在 (620, 660)
//   pass.render(renderer, out, g, t, { floor: 800, horizon: 718 });
// 其他部件：hop（一滩跳进另一滩）、strand / recoil（拉丝和断后回弹）、drip（挂着、断开、滴落）、fling（甩出的小滴）、
// fizz（字里上升的气泡）；wordSD / bottomAt / letterToWorld 在 CPU 上查字形，找挂滴的位置、把字里的点换到画面上。
import * as THREE from 'three';
import { FSPass, SS_TAP, W, H } from '../../engine/gl';
import { font, layout } from '../../engine/type';
import { clamp, lerp, smoothstep, springStep, mulberry32, frameIdx, hexToLinear } from '../../engine/util';
import { signedDistance } from './edt';

// ---------------------------------------------------------------- primitives

/** An elliptic drop: centre, radius, colour u (0..1 along the palette), stretch `s` along angle `a` (rad; π/2 = vertical). */
export interface Ball { x: number; y: number; r: number; u: number; s?: number; a?: number }
/** A tapered capsule from a (radius ra) to b (radius rb): necks, threads, tendrils. */
export interface Seg { ax: number; ay: number; bx: number; by: number; ra: number; rb: number; u: number }
/**
 * Letter `i` of the WordSDF with its ink centre at (x, y). `sx`/`sy` scale and `a` (rad) rotate it about that centre;
 * `grow` (px) fattens it; `wob`/`wph` are a jelly warp's amplitude (px) and phase. `m` < 1 morphs it from the ellipse
 * `ell` [cx, cy, ax, ay] (born from a bead: 0 = the ellipse, 1 = the letter).
 */
export interface LetterPose { i: number; x: number; y: number; u: number; sx?: number; sy?: number; a?: number; grow?: number; wob?: number; wph?: number; m?: number; ell?: readonly [number, number, number, number] }
/** A carbonation bubble shown inside the liquid: centre, radius, opacity. */
export interface Bubble { x: number; y: number; r: number; a: number }
/** Everything liquid in one frame. Build a fresh one per render (goo()) and fill it with the helpers below. */
export interface Goo { balls: Ball[]; segs: Seg[]; letters: LetterPose[]; bubbles: Bubble[] }

export const goo = (): Goo => ({ balls: [], segs: [], letters: [], bubbles: [] });
/** Add a drop (skipped below 0.3 px). */
export function ball(g: Goo, x: number, y: number, r: number, u: number, s = 1, a = Math.PI / 2) {
  if (r > 0.3) g.balls.push({ x, y, r, u, s, a });
}
/** Add a tapered capsule (skipped when both ends are under 0.35 px). */
export function seg(g: Goo, ax: number, ay: number, bx: number, by: number, ra: number, rb: number, u: number) {
  if (Math.max(ra, rb) > 0.35) g.segs.push({ ax, ay, bx, by, ra, rb, u });
}

// ---------------------------------------------------------------- the field, on the CPU (tests, layout queries)

/**
 * Smooth minimum of signed distances by log-sum-exp: −ln Σ e^(−k·dᵢ) / k. Bodies further apart than a few 1/k stay
 * separate (it equals the plain min), closer ones grow a neck; two touching at the same distance sit ln 2 / k deeper.
 * The shader accumulates the same sum (stably, about the running minimum) and blends gradients and colours with the
 * same weights. k is in 1/px: 0.06 soupy … 0.1 tight.
 */
export function smoothMin(ds: readonly number[], k: number): number {
  let m = Infinity;
  for (const d of ds) m = Math.min(m, d);
  if (!Number.isFinite(m)) return m;
  let s = 0;
  for (const d of ds) s += Math.exp(-k * (d - m));
  return m - Math.log(s) / k;
}

/**
 * Fake height (px) of the liquid `depth` px inside its edge: a puddle's meniscus that rises like √(2R·x) (a drop of
 * curvature radius R) and saturates at Hc, so thick bodies are flat-topped instead of cones. The +0.6 px keeps the
 * rim from standing vertical (the outline would alias into a hard line).
 */
export function liquidHeight(depth: number, R = 95, Hc = 210): number {
  const h0 = Math.sqrt(2 * R * Math.max(depth, 0) + 2 * R * 0.6);
  return Hc * Math.tanh(h0 / Hc);
}

// ---------------------------------------------------------------- glyph distance fields

/**
 * Signed distance (px, negative inside) of a coverage map (0..1, row-major w x h). An edge texel of coverage a puts the
 * edge (a − 0.5) px past its centre, so anti-aliased glyphs give sub-pixel edges (kit/edt.ts, shared with sfx-shape.ts).
 */
export const signedField = (alpha: ArrayLike<number>, w: number, h: number): Float32Array => signedDistance(alpha, w, h, false);

/** Separable Gaussian blur (σ px, edges clamped). */
export function blurField(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3)), ker = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { const k = Math.exp(-(i * i) / (2 * sigma * sigma)); ker[i + r] = k; s += k; }
  for (let i = 0; i < ker.length; i++) ker[i]! /= s;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) { const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i; acc += src[row + xx]! * ker[i + r]!; }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) { const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i; acc += tmp[yy * w + x]! * ker[i + r]!; }
    out[y * w + x] = acc;
  }
  return out;
}

/**
 * One texel of a liquid glyph field from the edge-blurred distance `sharp` and the deep-blurred `soft`: the edge keeps
 * the sharp field (the silhouette stays true), deeper than ~3 px it slides to the soft one within ~20 px, so the ridge
 * along a stroke's centre line (where the true distance has a kink) is gone from the height field and the stroke reads
 * as one rounded tube. Outside, it never lies further than the sharp distance nor nearer than half of it.
 */
export function blendDepth(sharp: number, soft: number): number {
  if (sharp > 0) return Math.min(sharp, Math.max(soft, sharp * 0.5));
  const w = smoothstep(0, 1, (-sharp - 3) / 18);
  return sharp + (Math.min(Math.min(soft, 0), sharp * 0.2) - sharp) * w;
}

/**
 * The field of the shape grown by `by` px (negative shrinks it), re-measured as a true distance (not just d − by, whose
 * corners stay sharp): shrinking then growing by the same amount rounds outer corners (radius = the amount), growing
 * then shrinking fills inner ones.
 */
export function offsetField(d: Float32Array, w: number, h: number, by: number): Float32Array {
  const a = new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = clamp(0.5 - (d[i]! - by));
  return signedField(a, w, h);
}

/**
 * A glyph's liquid distance field from its coverage map: signed distance; inner corners filled and outer corners
 * rounded with radius `round` px (surface tension: a square corner would show its medial-axis crease right at the rim,
 * where the edge field is kept); clamped to ±lim; then blurred with σ `edge` at the rim and σ `deep` inside, blended by
 * depth (blendDepth). Features thinner than 2·round vanish.
 */
export function liquidField(alpha: ArrayLike<number>, w: number, h: number, o: { edge?: number; deep?: number; round?: number; lim?: number } = {}): Float32Array {
  const lim = o.lim ?? 160, rr = o.round ?? 0;
  let d = signedField(alpha, w, h);
  if (rr > 0) {
    d = offsetField(offsetField(d, w, h, -rr), w, h, rr);               // outer corners → arcs
    d = offsetField(offsetField(d, w, h, rr * 0.8), w, h, -rr * 0.8);   // inner corners filleted
  }
  for (let i = 0; i < d.length; i++) d[i] = clamp(d[i]!, -lim, lim);
  const sharp = blurField(d, w, h, o.edge ?? 2), soft = blurField(d, w, h, o.deep ?? 5);
  for (let i = 0; i < d.length; i++) d[i] = blendDepth(sharp[i]!, soft[i]!);
  return d;
}

/** One letter of a WordSDF. Word coordinates: px, origin at the pen start on the baseline, y down. */
export interface WordLetter {
  ch: string;
  /** Its cell in the atlas [x, y, w, h] (texels = px); the cell's top-left sits at `origin` in word coordinates. */
  tile: readonly [number, number, number, number];
  origin: readonly [number, number];
  /** Ink bounds [x0, y0, x1, y1] and ink centre (`home`) in word coordinates; `pivot`: the ink centre in the cell. */
  ink: readonly [number, number, number, number];
  home: readonly [number, number];
  pivot: readonly [number, number];
  /** The field (px, negative inside) over the cell, row-major. */
  field: Float32Array;
}
export interface WordSDF {
  text: string; size: number;
  letters: WordLetter[];
  /** Ink bounds of the whole word (word coordinates). */
  ink: readonly [number, number, number, number];
  /** RGBA half-float atlas: distance, its gradient (x, y), 0. */
  texture: THREE.DataTexture;
  atlas: readonly [number, number];
}

/** Most letters one WordSDF (and one LiquidPass) takes. */
export const MAX_LETTERS = 8;

/**
 * Liquid glyph fields of `text` set in `family` at `size` px (kerned as one run, plus `tracking` px), one atlas cell per
 * letter (up to MAX_LETTERS), for LiquidPass letters. `pad` (px) of field around the ink; `edge`/`deep` the two blurs
 * (2 and 5 px: σ deep 8–12 makes fatter, gummier strokes); `round` the corner radius (default 4 % of the size; 0 keeps
 * the font's corners). Call in init(): fonts must be loaded. The field is one texel per logical px at every output
 * scale: it is smoothed over ≥ 2 px, so a finer one would add nothing at 4K.
 */
export function buildWord(text: string, family: string, size: number, o: { tracking?: number; pad?: number; edge?: number; deep?: number; round?: number } = {}): WordSDF {
  const chars = Array.from(text).slice(0, MAX_LETTERS);
  const pad = o.pad ?? 110, lay = layout(chars.join(''), family, size, o.tracking ?? 0);
  const cv = document.createElement('canvas'), c = cv.getContext('2d', { willReadFrequently: true })!;
  c.font = font(family, size);
  const letters: WordLetter[] = [];
  let ax = 0, ah = 0;
  const wink = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!, gx = lay.glyphs[i]!.x, m = c.measureText(ch);
    const x0 = gx - m.actualBoundingBoxLeft, x1 = gx + m.actualBoundingBoxRight, y0 = -m.actualBoundingBoxAscent, y1 = m.actualBoundingBoxDescent;
    const ox = Math.floor(x0 - pad), oy = Math.floor(y0 - pad), w = Math.ceil(x1 + pad) - ox, h = Math.ceil(y1 + pad) - oy;
    cv.width = w; cv.height = h;
    c.font = font(family, size); c.fillStyle = '#fff'; c.textBaseline = 'alphabetic';
    c.fillText(ch, gx - ox, -oy);
    const px = c.getImageData(0, 0, w, h).data, a = new Float32Array(w * h);
    for (let j = 0; j < w * h; j++) a[j] = px[j * 4 + 3]! / 255;
    const field = liquidField(a, w, h, { edge: o.edge, deep: o.deep, round: o.round ?? size * 0.04 });
    const home: [number, number] = [(x0 + x1) / 2, (y0 + y1) / 2];
    letters.push({ ch, tile: [ax, 0, w, h], origin: [ox, oy], ink: [x0, y0, x1, y1], home, pivot: [home[0] - ox, home[1] - oy], field });
    ax += w + 2; ah = Math.max(ah, h);
    wink[0] = Math.min(wink[0]!, x0); wink[1] = Math.min(wink[1]!, y0); wink[2] = Math.max(wink[2]!, x1); wink[3] = Math.max(wink[3]!, y1);
  }
  // atlas: distance + its gradient (central differences), so one bilinear fetch gives a continuous normal
  const AW = Math.max(1, ax), AH = Math.max(1, ah), data = new Uint16Array(AW * AH * 4);
  const fill = THREE.DataUtils.toHalfFloat(200);
  for (let j = 0; j < AW * AH; j++) data[j * 4] = fill;
  for (const L of letters) {
    const [tx, , w, h] = L.tile, f = L.field;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, o4 = (y * AW + tx + x) * 4;
      const gx = (f[y * w + Math.min(w - 1, x + 1)]! - f[y * w + Math.max(0, x - 1)]!) * 0.5;
      const gy = (f[Math.min(h - 1, y + 1) * w + x]! - f[Math.max(0, y - 1) * w + x]!) * 0.5;
      data[o4] = THREE.DataUtils.toHalfFloat(f[i]!);
      data[o4 + 1] = THREE.DataUtils.toHalfFloat(gx);
      data[o4 + 2] = THREE.DataUtils.toHalfFloat(gy);
    }
  }
  const texture = new THREE.DataTexture(data, AW, AH, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { text: chars.join(''), size, letters, ink: [wink[0]!, wink[1]!, wink[2]!, wink[3]!], texture, atlas: [AW, AH] };
}

/** Letter i's field (px, negative inside) at word coordinates (x, y), bilinear; 200 outside its cell. */
export function wordSD(word: Pick<WordSDF, 'letters'>, i: number, x: number, y: number): number {
  const L = word.letters[i];
  if (!L) return 200;
  const [, , w, h] = L.tile, cx = x - L.origin[0] - 0.5, cy = y - L.origin[1] - 0.5;
  if (cx < 0 || cy < 0 || cx > w - 1 || cy > h - 1) return 200;
  const x0 = Math.min(w - 2, Math.floor(cx)), y0 = Math.min(h - 2, Math.floor(cy)), fx = cx - x0, fy = cy - y0, f = L.field;
  const a = f[y0 * w + x0]!, b = f[y0 * w + x0 + 1]!, c = f[(y0 + 1) * w + x0]!, d = f[(y0 + 1) * w + x0 + 1]!;
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}

/** Lowest ink (word y) of letter i in column x, scanning up from the ink bottom; null where the column has none. */
export function bottomAt(word: Pick<WordSDF, 'letters'>, i: number, x: number): number | null {
  const L = word.letters[i];
  if (!L) return null;
  for (let y = Math.ceil(L.ink[3]) + 2; y > L.ink[1]; y--) if (wordSD(word, i, x, y) < 0) return y;
  return null;
}

/** Where a point of letter i (word coordinates) is in the world under a pose (ignores the jelly warp). */
export function letterToWorld(word: Pick<WordSDF, 'letters'>, p: LetterPose, x: number, y: number): [number, number] {
  const L = word.letters[p.i]!, dx = (x - L.home[0]) * (p.sx ?? 1), dy = (y - L.home[1]) * (p.sy ?? 1);
  const c = Math.cos(p.a ?? 0), s = Math.sin(p.a ?? 0);
  return [p.x + c * dx - s * dy, p.y + s * dx + c * dy];
}

// ---------------------------------------------------------------- choreography (each a pure function of t)

/** Gravity of the falls, hops and drips (px/s², at a 1080-px frame). */
export const GRAVITY = 5000;

/**
 * Stretch of a puddle `tl` s after a drop hit the floor: the falling teardrop (1.3) squashes into a flat lens (`flat`,
 * 0.5 = twice as wide as tall) within a frame and rings down; the dip below the lens is halved (no pancake).
 */
export function puddleStretch(tl: number, flat = 0.5, damp = 0.5): number {
  const s = 1.3 + (flat - 1.3) * springStep(tl + 1 / 24, 6, damp);
  return s < flat ? flat - (flat - s) * 0.45 : s;
}

export interface DropOpts {
  x: number; tLand: number; r: number; u: number;
  /** Floor contact line (world y). */
  floor: number;
  /** Released from rest this high above the floor (px; default from above the frame top). */
  h?: number;
  /** Resting stretch of the puddle and the damping of its landing ring. */
  flat?: number; damp?: number;
}

/**
 * A drop falling onto the floor and lying there as a lens: stretched along its fall with a short tail while it drops
 * (from rest, released `h` px above the floor so it lands exactly at tLand), then puddleStretch. Returns the phase.
 */
export function fallingDrop(g: Goo, t: number, o: DropOpts): 'before' | 'fall' | 'puddle' {
  const h = o.h ?? o.floor + 3 * o.r, vL = Math.sqrt(2 * GRAVITY * h), tf = vL / GRAVITY;
  if (t < o.tLand - tf) return 'before';
  if (t < o.tLand) {
    const tau = o.tLand - t, v = vL - GRAVITY * tau, bottom = o.floor - (vL * tau - 0.5 * GRAVITY * tau * tau);
    const sv = 1 + 0.3 * clamp(v / 2500), cy = bottom - o.r * sv, lag = 0.03 * v;
    ball(g, o.x, cy, o.r, o.u, sv);
    ball(g, o.x, cy - o.r * sv * 0.9 - lag, o.r * 0.32, o.u, 1.3);
    seg(g, o.x, cy - o.r * 0.3, o.x, cy - o.r * sv * 0.9 - lag, o.r * 0.5, o.r * 0.18, o.u);
    return 'fall';
  }
  const sv = puddleStretch(t - o.tLand, o.flat, o.damp);
  ball(g, o.x, o.floor - o.r * sv + 1, o.r, o.u, sv);
  return 'puddle';
}

/** A ballistic droplet: launched at tEmit from (x0, y0) with velocity (vx, vy) (px/s, vy up), it lands on floor + fy. */
interface Droplet { x0: number; y0: number; vx: number; vy: number; r: number; u: number; tEmit: number; fy: number; tHit: number; xHit: number; life: number }
function droplet(x0: number, y0: number, vx: number, vy: number, r: number, u: number, tEmit: number, floor: number, fy: number, life: number): Droplet {
  const dy = floor + fy - r - y0, tf = (vy + Math.sqrt(vy * vy + 2 * GRAVITY * Math.max(0, dy))) / GRAVITY;
  return { x0, y0, vx, vy, r, u, tEmit, fy, tHit: tEmit + tf, xHit: x0 + vx * tf, life };
}
function drawDroplet(g: Goo, t: number, d: Droplet, floor: number) {
  if (t < d.tEmit) return;
  if (t < d.tHit) {
    const tt = t - d.tEmit, vy = -d.vy + GRAVITY * tt;
    ball(g, d.x0 + d.vx * tt, d.y0 - d.vy * tt + 0.5 * GRAVITY * tt * tt, d.r, d.u, 1 + Math.min(0.45, Math.hypot(d.vx, vy) / 5200), Math.atan2(vy, d.vx));
    return;
  }
  // a bead on the floor (squash and ring), melting into the floor after its life
  const tl = t - d.tHit, r = d.r * (1 - smoothstep(d.life, d.life + 0.12, tl));
  if (r < 0.5) return;
  const sv = 1.25 + (0.62 - 1.25) * springStep(tl, 7, 0.38);
  ball(g, d.xHit, floor + d.fy - r * sv + 0.5, r, d.u, sv);
}

/**
 * A droplet thrown at tEmit from (x0, y0) with velocity (vx, vy) (px/s, vy up): it flies (stretched along its motion),
 * lands on the floor (`fy` px nearer the camera, negative = further back) as a bead that rings down, and melts away
 * `life` s later. Launch it from inside a body and it reads as torn off it.
 */
export function fling(g: Goo, t: number, o: { x0: number; y0: number; vx: number; vy: number; r: number; u: number; tEmit: number; floor: number; fy?: number; life?: number }) {
  drawDroplet(g, t, droplet(o.x0, o.y0, o.vx, o.vy, o.r, o.u, o.tEmit, o.floor, o.fy ?? 0, o.life ?? 0.5), o.floor);
}

export interface SplashOpts extends DropOpts {
  seed: number;
  /** Crown tendrils (5; 7 for a big drop) and fine spray drops from the rim (2). */
  n?: number; spray?: number;
  /** How long the thrown beads lie on the floor before melting (s; each gets up to 60 % more). */
  life?: number;
  /** Throw speed scale and the colour spread of the beads (± in u). */
  power?: number; spread?: number;
}

/**
 * The crown of a drop hitting the floor at tLand (pair it with fallingDrop): tapered tendrils flung out of the splat
 * (the outer ones lean out, the middle stands up), each beading at the tip on a thinning neck and pinching off a
 * droplet 2–3 frames after impact while the stub recoils; plus a fine spray from the rim. The droplets fly, land as
 * beads and melt away. Seeded: the same seed draws the same splash at every t.
 */
export function splash(g: Goo, t: number, o: SplashOpts) {
  const tl = t - o.tLand;
  if (tl < 0) return;
  const R = mulberry32(o.seed), rr = (a: number, b: number) => a + (b - a) * R();
  const n = o.n ?? 5, pw = o.power ?? 1, sp = o.spread ?? 0.05, life = o.life ?? 0.5, TEN = 0.27;
  for (let k = 0; k < n; k++) {
    const c = (k / Math.max(1, n - 1)) * 2 - 1 + rr(-0.07, 0.07), ang = c * 0.95 + rr(-0.12, 0.12);
    const L = o.r * (0.9 + 0.5 * Math.abs(c)) * rr(0.72, 1.22), tDet = 0.07 + rr(0, 0.037) + 0.02 * Math.abs(c), rb = o.r * rr(0.1, 0.135) * rr(0.6, 1.4);
    const a2 = ang + rr(-0.21, 0.21), speed = rr(480, 760) * rr(0.75, 1.25) * pw, fy = rr(-24, 8), T = rr(0.2, 0.28) * pw;
    const du = rr(-sp, sp), lf = life * rr(1, 1.6);
    const dx = Math.sin(ang), dy = -Math.cos(ang);
    const tendril = (tt: number) => {
      const s = puddleStretch(tt, o.flat, o.damp), axx = o.r / s, ayy = o.r * s, cyy = o.floor - ayy + 1;
      const bx = o.x + c * axx * 0.46, by = cyy - ayy * Math.sqrt(Math.max(0, 1 - (c * 0.46) ** 2)) + ayy * 0.45;
      let len: number, pinch = 0, bead = 0;
      if (tt < tDet) { const q = tt / tDet; len = L * (1 - (1 - q) ** 3); pinch = smoothstep(0.45, 1, q); bead = 0.55 + 0.45 * q; }
      else { const q = 1 - springStep(tt - tDet, 5, 0.34); len = L * 0.62 * (q >= 0 ? q : -0.45 * q) * (1 - smoothstep(0.17, TEN, tt)); }
      return { bx, by, len, pinch, bead };
    };
    if (tl < TEN) {
      const { bx, by, len, pinch, bead } = tendril(tl);
      if (len >= 1) {
        const droop = 0.22 * len * Math.abs(dx);   // gravity bends the leaning ones into arcs
        const mx = bx + dx * len * 0.5, my = by + dy * len * 0.5 + droop * 0.25, tx = bx + dx * len, ty = by + dy * len + droop;
        const ra = o.r * 0.16 * (1 - 0.3 * Math.abs(c)), rm = lerp(ra * 0.55, ra * 0.42, pinch), rt = lerp(rm * 0.8, o.r * 0.035, pinch);
        seg(g, bx, by, mx, my, ra, rm, o.u); seg(g, mx, my, tx, ty, rm, rt, o.u);
        if (tl < tDet) ball(g, tx + dx * bead * rb * 0.8, ty + dy * bead * rb * 0.8, bead * rb, o.u, 1.12, ang - Math.PI / 2);
      }
    }
    // the tip bead flies off at detachment
    const s0 = tendril(tDet - 1e-4), droop0 = 0.22 * s0.len * Math.abs(dx);
    const x0 = s0.bx + dx * (s0.len + rb), y0 = s0.by + dy * (s0.len + rb) + droop0;
    const vy = (0.5 * GRAVITY * T * T - (o.floor + fy - rb - y0)) / T;
    drawDroplet(g, t, droplet(x0, y0, Math.sin(a2) * speed * 1.1, vy, rb, o.u + du, o.tLand + tDet, o.floor, fy, lf), o.floor);
  }
  for (let i = 0; i < (o.spray ?? 2); i++) {
    const side = i % 2 ? 1 : -1, x0 = o.x + side * o.r * rr(0.9, 1.4), vx = side * rr(320, 700) * pw, vy = rr(520, 950) * pw;
    const r = rr(3.5, 6.5), te = o.tLand + 0.067 + rr(0, 0.033), fy = rr(-24, 8), du = rr(-sp, sp), lf = life * rr(0.6, 1.2);
    drawDroplet(g, t, droplet(x0, o.floor - o.r * 0.55, vx, vy, r, o.u + du, te, o.floor, fy, lf), o.floor);
  }
}

export interface HopOpts {
  /** From the puddle at x0 to x1 (where it hits its host), on the floor. */
  x0: number; x1: number; floor: number; r: number; u: number;
  /** Arrival time; the flight takes `flight` s (0.34) after a 0.1 s squat. */
  tc: number; flight?: number;
  /** Resting stretch of the puddle (0.5). */
  flat?: number;
}

/**
 * A puddle hopping into a host body: squat, leap on a ballistic arc (a neck to the floor snapping at take-off,
 * stretched along its flight, flattening against the host on the way in), then sinking into it. Draws from 0.1 s
 * before take-off (draw the resting puddle yourself until then). Returns where its body is and how far it has merged
 * (`merged` 0 → 1 over the 0.15 s after tc): grow the host by that much of its volume (r_host² += merged·r²) so the
 * total stays constant.
 */
export function hop(g: Goo, t: number, o: HopOpts): { merged: number; x: number; y: number } {
  const T = o.flight ?? 0.34, tTake = o.tc - T, flat = o.flat ?? 0.5, side = Math.sign(o.x1 - o.x0) || 1;
  if (t < tTake - 0.1) return { merged: 0, x: o.x0, y: o.floor - o.r * flat };
  if (t < tTake) {
    const k = smoothstep(0, 1, (t - tTake + 0.1) / 0.1), sv = lerp(flat, 0.4, k), x = o.x0 + side * 8 * k, y = o.floor - o.r * sv + 1;
    ball(g, x, y, o.r, o.u, sv);
    return { merged: 0, x, y };
  }
  if (t < o.tc) {
    const tt = t - tTake, y0 = o.floor - o.r * 0.6, y1 = o.floor - o.r * 0.7;
    const x = lerp(o.x0, o.x1, tt / T), y = y0 + (y1 - y0) * (tt / T) - 0.5 * GRAVITY * tt * (T - tt);
    const vx = (o.x1 - o.x0) / T, vy = (y1 - y0) / T - 0.5 * GRAVITY * (T - 2 * tt);
    let sv = 1 + 0.26 * Math.min(1, Math.hypot(vx, vy) / 1400) + 0.35 * Math.exp(-tt / 0.05);
    sv = lerp(sv, 0.74, smoothstep(T - 0.06, T, tt));
    ball(g, x, y, o.r, o.u, sv, Math.atan2(vy, vx));
    if (tt < 0.09) { const k = tt / 0.09; seg(g, o.x0, o.floor - 6, lerp(o.x0, x, 0.5), lerp(o.floor - 6, y, 0.5), lerp(o.r * 0.5, 8, k), lerp(o.r * 0.4, 0.6, k), o.u); }
    return { merged: 0, x, y };
  }
  const tm = t - o.tc, k = smoothstep(0, 0.15, tm), x = o.x1 + side * 10 * k, y = o.floor - o.r * 0.7 * (1 - 0.4 * k);
  if (k < 1) ball(g, x, y, o.r * (1 - k), o.u, lerp(0.74, 0.5, k));
  return { merged: k, x, y };
}

/**
 * A thread between a (radius ra) and b (radius rb) necking in the middle as `k` goes 0 → 1 (at 1 it is a hair, about to
 * snap); the middle sags `sag` px. ua/ub colour each half.
 */
export function strand(g: Goo, ax: number, ay: number, bx: number, by: number, ra: number, rb: number, k: number, ua: number, ub = ua, sag = 6) {
  const rm = lerp(Math.min(ra, rb) * 0.85, 1, Math.pow(clamp(k), 0.6)), mx = (ax + bx) / 2, my = (ay + by) / 2 + sag * k;
  seg(g, ax, ay, mx, my, ra, rm, ua); seg(g, mx, my, bx, by, rm, rb, ub);
}

/**
 * The stub a snapped thread leaves on its body at (x, y), pointing along (dx, dy) (unit): it springs back from `len` px
 * with a small rebound bump and is gone in about 0.3 s. Draws nothing before tSnap or after it has settled.
 */
export function recoil(g: Goo, t: number, tSnap: number, x: number, y: number, dx: number, dy: number, len: number, r: number, u: number) {
  const tt = t - tSnap;
  if (tt < 0 || tt > 0.6) return;
  const k = springStep(tt, 6, 0.33), l = len * (1 - k) + 3 * (1 - smoothstep(0.3, 0.6, tt));
  if (l < 1) return;
  seg(g, x, y, x + dx * l, y + dy * l, r, Math.max(0.6, r * 0.3 + 3 * (1 - k)), u);
}

export interface DripOpts {
  /** Where it hangs from (the underside of a stroke) and the floor it falls onto. */
  x: number; y: number; floor: number; u: number;
  /** Starts swelling at tStart; lands at tLand (the snap time follows from the fall). */
  tStart: number; tLand: number;
  /** Bulb radius and how far below the attachment it hangs when it lets go (px). */
  r?: number; hang?: number;
  /** Neck radius at the attachment (20) and the length of the stub that springs back up after the snap (40). A pour
   * from above the frame: attach it off-screen, hang it far, a thin neck and a long stub (the stream retracts). */
  neck?: number; stub?: number;
  /** Stretch of the lens it lands as (0.42: a wide puddle; 0.7: a round bead that keeps clear of what is near). */
  flat?: number;
}

/**
 * A drip: a bulb swells under a stroke on a lengthening, thinning neck, snaps, falls (teardrop, its tail recoiling into
 * it), lands exactly at tLand as a small lens that ringing settles. Returns the snap time (for a jelly kick on the
 * body). Pair the landing with a floor ripple (LiquidView.ripple).
 */
export function drip(g: Goo, t: number, o: DripOpts): number {
  const r = o.r ?? 22, hang = o.hang ?? 76, vSnap = 240, ySnap = o.y + hang;
  const dy = o.floor - r * 1.1 - ySnap, tf = (-vSnap + Math.sqrt(vSnap * vSnap + 2 * GRAVITY * Math.max(1, dy))) / GRAVITY;
  const tSnap = o.tLand - tf;
  if (t < o.tStart) return tSnap;
  if (t < tSnap) {
    const k = clamp((t - o.tStart) / (tSnap - o.tStart)), kk = k * k * (1.6 - 0.6 * k);
    const by = lerp(o.y + 8, ySnap, kk), br = r * (0.35 + 0.65 * smoothstep(0, 0.55, k));
    const ny = lerp(o.y + 6, by - br * 0.9, 0.5), rn = lerp(Math.min(16, (o.neck ?? 20) * 0.8), 2.2, Math.pow(clamp((k - 0.35) / 0.65), 1.2));
    seg(g, o.x, o.y - 10, o.x, ny, o.neck ?? 20, rn, o.u);
    seg(g, o.x, ny, o.x, by - br * 0.5, rn, br * 0.7, o.u);
    ball(g, o.x, by, br, o.u, 1 + 0.18 * kk);
  } else if (t < o.tLand) {
    const tt = t - tSnap, y = ySnap + vSnap * tt + 0.5 * GRAVITY * tt * tt, v = vSnap + GRAVITY * tt;
    const sv = 1.12 + 0.2 * clamp(v / 1400), len = 30 * (1 - springStep(tt, 8, 0.45));
    ball(g, o.x, y, r, o.u, sv);
    if (len > 1) seg(g, o.x, y - r * sv - len, o.x, y - r * 0.6, 2, 8, o.u);
  } else {
    const tl = t - o.tLand, sv = 1.3 + ((o.flat ?? 0.42) - 1.3) * springStep(tl, 5.5, 0.4), rl = r * (1 + 0.1 * smoothstep(0, 0.3, tl));
    ball(g, o.x, o.floor - rl * sv + 0.5, rl, o.u, sv);
  }
  recoil(g, t, tSnap, o.x, o.y - 10, 0, 1, o.stub ?? 40, (o.neck ?? 20) * 0.9, o.u);
  return tSnap;
}

/**
 * Carbonation inside letter `pose.i`: `n` bubbles rising through the ink (each from a seeded spot, `speed` px/s, over
 * 40–110 px, fading in and out, gone where they would leave the stroke), carried by the letter's pose.
 */
export function fizz(g: Goo, t: number, word: Pick<WordSDF, 'letters'>, pose: LetterPose, o: { n?: number; seed?: number; speed?: number; r?: readonly [number, number]; alpha?: number } = {}) {
  const L = word.letters[pose.i];
  if (!L) return;
  const R = mulberry32((o.seed ?? 1) * 7919 + pose.i * 104729), rr = (a: number, b: number) => a + (b - a) * R();
  const [r0, r1] = o.r ?? [2.6, 5.2], sc = Math.sqrt((pose.sx ?? 1) * (pose.sy ?? 1));
  for (let k = 0; k < (o.n ?? 4); k++) {
    const r = rr(r0, r1), v = (o.speed ?? 22) * rr(0.7, 1.3), travel = rr(40, 110), ph = R(), sw = rr(0, 6.28);
    let x0 = 0, y0 = 0, ok = false;
    for (let tries = 0; tries < 40 && !ok; tries++) {
      x0 = rr(L.ink[0], L.ink[2]); y0 = rr(L.ink[1] + travel * 0.5, L.ink[3]);
      ok = wordSD(word, pose.i, x0, y0) < -(r + 7);
    }
    if (!ok) continue;
    const q = (t * v / travel + ph) % 1, x = x0 + 2.2 * Math.sin(t * 2.1 + sw), y = y0 - q * travel;
    const inside = smoothstep(-(r + 2), -(r + 7), wordSD(word, pose.i, x, y));
    const a = Math.sin(Math.PI * q) ** 0.6 * inside * (o.alpha ?? 1);
    if (a < 0.01) continue;
    const [wx, wy] = letterToWorld(word, pose, x, y);
    g.bubbles.push({ x: wx, y: wy, r: r * sc, a });
  }
}

// ---------------------------------------------------------------- look

/** Colour u ∈ [0, 1] runs along three stops (tangerine → hot pink → violet by default) at three thicknesses. */
export interface LiquidPalette { thin: readonly [string, string, string]; mid: readonly [string, string, string]; deep: readonly [string, string, string] }
export const CANDY: LiquidPalette = {
  thin: ['#ffbd4d', '#ff80a8', '#d685ff'],
  mid: ['#ff5c0f', '#ff1a70', '#8f1fff'],
  deep: ['#cc1a0a', '#9e054d', '#3d0a99'],
};
/** The studio: cyc wall from `top` to `horizon`, floor from `far` to `near`, a wide `spot` and a tighter `glow` behind the action. */
export interface LiquidStudio { top: string; horizon: string; far: string; near: string; spot: string; glow: string }
export const PLUM: LiquidStudio = { top: '#140619', horizon: '#3a1244', far: '#2e0d36', near: '#08020a', spot: '#5d1c60', glow: '#8a2860' };

export interface LiquidView {
  /** Camera: the world point at the frame centre, and zoom (world px → logical px). */
  x?: number; y?: number; zoom?: number;
  /** Smooth-union sharpness (1/px): 0.06 soupy, 0.08 default, 0.1 tight. */
  k?: number;
  /** Floor contact line and horizon (world y); floor ≤ 0: no floor (no reflection, contact darkening or ripples). */
  floor?: number; horizon?: number;
  /** Floor reflection (0..1) and contact darkening (0..1). */
  reflect?: number; contact?: number;
  /** Cast shadow: offset (px, light from the upper left), darkness, and the coloured light that leaks through. */
  shadow?: readonly [number, number, number, number];
  /** Key softbox centre in reflection space (−0.78, −0.95 = upper left); slide it to move the speculars. */
  key?: readonly [number, number];
  /** A glint band sweeping the shoulders: its position (px along x·0.8 − y·0.6) and strength. */
  glint?: readonly [number, number];
  /** Floor ripple rings: centre, age (s), strength. */
  ripple?: readonly [number, number, number, number];
  /** Centre and radii of the studio's spot (world px). */
  spot?: readonly [number, number, number, number];
  /** Studio light level (1), and the caustic web the liquid throws onto the cyc above the horizon (0 = off; 1–2). */
  set?: number; caustics?: number;
  /** The backdrop as a texture (screen space, linear) instead of the studio: the liquid, its shadow and reflection go over it. */
  under?: THREE.Texture | null;
  /** Hue-preserving highlight compression (1 = on) and the triangular dither in 8-bit steps (1 = ±1 step; 0 = off). */
  tone?: number; dither?: number;
}

const NB = 64, NS = 24, NL = MAX_LETTERS, NBUB = 24;

const FRAG = /* glsl */ `
#define NB ${NB}
#define NS ${NS}
#define NL ${NL}
#define NBUB ${NBUB}
uniform vec4 uView;                         // zoom, camera x, y, smooth-union k
uniform int uNB; uniform vec4 uB[NB]; uniform vec4 uBX[NB];     // ball: x y r u | stretch, angle
uniform int uNS; uniform vec4 uS[NS]; uniform vec4 uSX[NS];     // seg: ax ay bx by | ra rb u
uniform int uNL; uniform vec4 uL[NL]; uniform vec4 uLX[NL];     // letter: x y grow u | sx sy angle morph
uniform vec4 uLM[NL]; uniform vec4 uLT[NL]; uniform vec4 uLP[NL]; // morph ellipse | atlas cell | pivot, wobble, phase
uniform sampler2D uWord; uniform vec2 uWordSize;
uniform int uNBub; uniform vec4 uBub[NBUB];
uniform vec4 uFloor;                        // contact y, horizon y, reflection, contact darkening
uniform vec4 uShadow;                       // offset x, y, darkness, caustic
uniform vec4 uKey;                          // softbox x, y, glint position, glint amount
uniform vec4 uRip;                          // ripple x, y, age, amount
uniform vec4 uSpot;                         // spot centre x, y, radii
uniform vec3 uPal[9];                       // thin, mid, deep x 3 stops
uniform vec3 uSetC[6];                      // top, horizon, far, near, spot, glow
uniform float uSetGain, uUseSet, uFrame, uTone, uDither, uCaus, uT;
uniform sampler2D uSet;
uniform int ssTap;

float pow2(float x) { return x * x; }
float ss(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
vec3 pal3(int o, float u) { u = clamp(u, 0.0, 1.0); return u < 0.5 ? mix(uPal[o], uPal[o + 1], u * 2.0) : mix(uPal[o + 1], uPal[o + 2], u * 2.0 - 1.0); }
vec3 palThin(float u) { return pal3(0, u); }
vec3 palMid(float u) { return pal3(3, u); }
vec3 palDeep(float u) { return pal3(6, u); }

// ---- smooth union by log-sum-exp, about the running minimum (stable): distance, gradient and colour share the weights
struct Fld { float m; float s; vec2 g; float u; };
void fadd(inout Fld f, float d, vec2 g, float u, float k) {
  if (d < f.m) { float c = exp(-k * (f.m - d)); f.s = f.s * c + 1.0; f.g = f.g * c + g; f.u = f.u * c + u; f.m = d; }
  else { float w = exp(-k * (d - f.m)); f.s += w; f.g += w * g; f.u += w * u; }
}

// (distance, gradient, colour u) of the liquid at world point p
vec4 field(vec2 p) {
  Fld f = Fld(1e5, 0.0, vec2(0.0), 0.0);
  float k = uView.w, cut = 6.0 / k;
  for (int i = 0; i < NB; i++) {
    if (i >= uNB) break;
    vec4 b = uB[i]; vec4 bx = uBX[i];
    vec2 dp = p - b.xy;
    float ext = b.z * max(bx.x, 1.0 / bx.x) + cut;
    if (dot(dp, dp) > ext * ext) continue;
    float ca = cos(bx.y), sa = sin(bx.y);
    vec2 q = vec2(ca * dp.x + sa * dp.y, -sa * dp.x + ca * dp.y);
    float ax = b.z * bx.x, ay = b.z / bx.x;
    vec2 qa = q / vec2(ax * ax, ay * ay);
    vec2 gq = b.z * qa;
    fadd(f, 0.5 * b.z * (dot(q, qa) - 1.0), vec2(ca * gq.x - sa * gq.y, sa * gq.x + ca * gq.y), b.w, k);
  }
  for (int i = 0; i < NS; i++) {
    if (i >= uNS) break;
    vec4 s = uS[i]; vec4 sx = uSX[i];
    vec2 ba = s.zw - s.xy, pa = p - s.xy;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
    vec2 v = pa - ba * h;
    float r = max(mix(sx.x, sx.y, h), 0.3);
    if (dot(v, v) > (r + cut) * (r + cut)) continue;
    fadd(f, (dot(v, v) - r * r) / (2.0 * r), v / r, sx.z, k);
  }
  for (int i = 0; i < NL; i++) {
    if (i >= uNL) break;
    vec4 L = uL[i]; vec4 X = uLX[i]; vec4 T = uLT[i]; vec4 P = uLP[i]; vec4 M = uLM[i];
    vec2 dp = p - L.xy;
    float rad = 0.5 * length(T.zw) * max(X.x, X.y) + 0.5 * length(M.zw) + cut;
    if (dot(dp, dp) > rad * rad) continue;
    float ca = cos(X.z), sa = sin(X.z);
    vec2 q = vec2(ca * dp.x + sa * dp.y, -sa * dp.x + ca * dp.y) / X.xy;
    q.x += P.z * sin(q.y * 0.021 + P.w);                // jelly: a slow travelling warp
    q.y += P.z * 0.6 * sin(q.x * 0.017 + P.w * 1.3);
    vec2 tq = q + P.xy, cq = clamp(tq, vec2(1.0), T.zw - 1.0);
    vec4 sd = textureLod(uWord, (T.xy + cq) / uWordSize, 0.0);
    float sc = sqrt(X.x * X.y);
    float dl = (sd.r + length(tq - cq)) * sc - L.z;
    vec2 gq = sd.gb / X.xy;
    vec2 g = vec2(ca * gq.x - sa * gq.y, sa * gq.x + ca * gq.y) * sc;
    if (X.w < 0.999) {                                  // born from a bead: ellipse field -> glyph field
      vec2 eq = p - M.xy;
      float k0 = length(eq / M.zw), k1 = length(eq / (M.zw * M.zw));
      float de = k0 * (k0 - 1.0) / max(k1, 1e-5);
      vec2 ge = normalize(eq / (M.zw * M.zw) + 1e-6);
      float m = smoothstep(0.0, 1.0, X.w);
      dl = mix(de, dl, m); g = normalize(mix(ge, g, m) + 1e-6);
    }
    fadd(f, dl, g, L.w, k);
  }
  float s = max(f.s, 1e-30);
  return vec4(f.m - log(s) / k, f.g / s, f.u / s);
}

// ---- the studio the liquid reflects: dim plum, an overhead fill, warm floor bounce, a key softbox (~30x), three
// smaller panels and coloured grazing rims (r: reflected view ray, y down, z toward the camera)
float softRect(vec2 q, vec2 hs, float soft) {
  vec2 d = abs(q) - hs;
  return 1.0 - ss(-soft, soft, length(max(d, 0.0)) + min(max(d.x, d.y), 0.0));
}
vec3 env(vec3 r) {
  vec3 c = vec3(0.0032, 0.0002, 0.0047);
  float up = clamp(-r.y, 0.0, 1.0), dn = clamp(r.y, 0.0, 1.0);
  c += vec3(0.32, 0.13, 0.53) * 0.55 * up * up;
  c += vec3(1.0, 0.07, 0.08) * 0.32 * ss(0.2, 0.95, dn);
  vec2 q = r.xy / max(r.z, 0.06);
  vec2 kq = q - uKey.xy;
  c += vec3(1.0, 0.93, 0.85) * 30.0 * softRect(kq, vec2(0.60, 0.36), 0.10) * (0.75 + 0.25 * ss(0.36, -0.36, kq.y));
  c += vec3(1.0, 0.79, 0.89) * 12.0 * softRect(q - vec2(0.95, -1.25), vec2(0.20, 0.14), 0.07);
  c += vec3(1.0, 0.61, 0.83) * 14.0 * softRect(q - vec2(1.55, -0.05), vec2(0.07, 1.3), 0.04);
  c += vec3(1.0, 0.61, 0.46) * 4.0 * softRect(q - vec2(-1.7, 0.7), vec2(0.08, 0.45), 0.08);
  float gr = pow(1.0 - clamp(r.z, 0.0, 1.0), 4.0);
  vec2 rd = normalize(r.xy + 1e-5);
  c += gr * (vec3(1.0, 0.49, 0.46) * 1.1 * ss(0.2, -0.9, rd.x + rd.y) + vec3(1.0, 0.12, 0.46) * 0.9 * ss(0.5, 1.0, rd.x));
  return c;
}

// ---- shade a liquid sample F = (distance, gradient, u): linear HDR colour and coverage
vec4 shadeLiquid(vec2 p, vec4 F, bool mirror) {
  float D = F.x; vec2 gD = F.yz; float u = F.w;
  float gl = max(length(gD), 0.2);
  float cov = clamp(0.5 - D * uView.x * PX_SCALE / gl, 0.0, 1.0);   // edge AA in physical px
  if (cov <= 0.0) return vec4(0.0);
  const float R = 95.0, Hc = 210.0;
  float x = max(-D, 0.0);                                 // depth inside the edge
  float h0 = sqrt(2.0 * R * x + 2.0 * R * 0.6), th = tanh(h0 / Hc);
  vec2 gh = -(1.0 - th * th) * R / h0 * gD;              // height gradient: h = Hc tanh(sqrt(2Rx)/Hc)
  if (mirror) gh.y = -gh.y;
  vec3 n = normalize(vec3(-gh, 1.0));
  // body: thickness drives the hue (thin: light and warm, thick: deep and saturated)
  vec3 body = mix(palThin(u), palMid(u), ss(0.0, 5.0, x));
  body = mix(body, palDeep(u), ss(40.0, 260.0, x) * mix(0.55, 0.22, ss(200.0, 400.0, x)));
  vec3 L = normalize(vec3(-0.55, -0.7, 0.62));
  float side = 1.0 - n.z;
  vec3 col = body * (0.26 + 0.50 * (0.5 + 0.5 * dot(n, L))) * (0.50 + 0.50 * n.z);   // edges fall off: glossy, not rubbery
  // light focused through the body: a saturated crescent inside the rim, opposite the key
  float away = dot(normalize(n.xy + 1e-6), -normalize(L.xy));
  float trans = pow(max(away, 0.0), 1.2) * ss(0.10, 0.50, side) * (1.0 - 0.85 * ss(0.70, 1.0, side));
  col += (palMid(u) * 1.4 + palThin(u) * 0.3) * trans;
  col += palMid(u) * exp(-x / 3.0) * 0.22;              // thin translucent lip
  vec3 r = reflect(vec3(0.0, 0.0, -1.0), n);
  float fr = 0.04 + 0.96 * pow(1.0 - clamp(n.z, 0.0, 1.0), 5.0);   // Fresnel, F0 = 0.04
  col = col * (1.0 - fr) + env(r) * fr;
  col += vec3(1.0, 0.97, 0.94) * pow(max(dot(r, normalize(vec3(-0.46, -0.62, 0.64))), 0.0), 900.0) * 22.0;   // wet hotspot
  float gb = (p.x * 0.8 - p.y * 0.6) - uKey.z;          // glint band sweeping the shoulders
  col += vec3(1.0, 0.95, 0.98) * uKey.w * exp(-gb * gb / 2312.0) * ss(0.35, 0.75, side) * (1.0 - ss(0.9, 1.0, side)) * 1.1;
  return vec4(col, cov);
}

vec3 studio(vec2 p) {
  float hz = uFloor.y > 0.0 ? uFloor.y : ${H}.0 * 0.8;
  vec3 wall = mix(uSetC[0], uSetC[1], ss(0.0, hz, p.y));
  vec2 d = (p - uSpot.xy) / uSpot.zw;
  wall += uSetC[4] * 0.55 * exp(-dot(d, d) * 1.6);
  vec2 dh = (p - uSpot.xy - vec2(0.0, -30.0)) / (uSpot.zw * vec2(0.6, 0.5));
  wall += uSetC[5] * 0.3 * exp(-dot(dh, dh) * 2.2);
  vec3 fl = mix(uSetC[2], uSetC[3], pow(clamp((p.y - hz) / (${H}.0 - hz), 0.0, 1.0), 0.55));
  vec2 df = (p - vec2(uSpot.x, hz + 30.0)) / vec2(uSpot.z * 0.9, 150.0);
  fl += uSetC[4] * 0.30 * exp(-dot(df, df) * 1.5);
  float hx = (p.x - uSpot.x) / ${(W / 2 + 20).toFixed(1)}, hzc = hz - 42.0 * hx * hx;   // curved cyc: the junction bends up at the sides
  vec3 c = mix(wall, fl, ss(-85.0, 65.0, p.y - hzc));
  c += uSetC[1] * 0.12 * exp(-abs(p.y - hzc) / 34.0);     // a faint polished edge
  return c * uSetGain;
}

vec4 bubbles(vec2 p, float u) {
  vec3 bc = vec3(0.0); float ba = 0.0;
  for (int i = 0; i < NBUB; i++) {
    if (i >= uNBub) break;
    vec4 b = uBub[i];
    vec2 d = (p - b.xy) / b.z;
    float rr = length(d);
    if (rr > 1.6) continue;
    float rim = ss(0.55, 0.95, rr) * (1.0 - ss(0.95, 1.25, rr));
    vec2 e = d - vec2(-0.35, -0.38);
    float pip = exp(-dot(e, e) * 22.0);
    bc += (palThin(u) * 1.2 * rim + vec3(1.0, 0.97, 0.95) * pip * 2.4) * b.w;
    ba = max(ba, (0.55 * rim + pip) * b.w);
  }
  return vec4(bc, ba);
}

// hue-preserving shoulder on the largest channel; very bright highlights go to white
vec3 tone(vec3 x) {
  float m = max(max(x.r, x.g), x.b);
  const float k = 0.72;
  float mt = m < k ? m : k + (1.0 - k) * (1.0 - exp(-(m - k) / (1.0 - k)));
  vec3 c = x * (mt / max(m, 1e-5));
  return mix(c, vec3(mt), ss(1.0, 6.0, m) * 0.85);
}

void main() {
  // sub-pixel supersampling spread over the motion-blur sub-frames (one rotated-grid tap each; none in the preview)
  vec2 jit = ssTap < 0 ? vec2(0.0) : rgss(ssTap) / PX_SCALE;
  vec2 sp = vec2(FRAG_PX.x, ${H}.0 - FRAG_PX.y) + jit;   // logical screen px, y down
  vec2 p = (sp - vec2(${W / 2}.0, ${H / 2}.0)) / uView.x + uView.yz;
  vec4 F = field(p);
  vec3 col = uUseSet > 0.5 ? texture(uSet, vUv).rgb : studio(p);
  // cast shadow, with the coloured light that leaks through the body
  if (uCaus > 0.0) {                                    // caustics the liquid throws onto the cyc: a slow web above the horizon
    float hz = uFloor.y > 0.0 ? uFloor.y : ${H}.0 * 0.8, wy = hz - p.y;
    float reg = ss(-40.0, 50.0, wy) * exp(-max(wy, 0.0) / 200.0) * exp(-pow2((p.x - uSpot.x) / 820.0));
    if (reg > 0.002) {
      vec2 cq = vec2(p.x * 0.0046, (p.y - hz) * 0.0105);  // squashed cells: thrown at a grazing angle
      float c1 = snoise(cq + vec2(uT * 0.42, -uT * 0.33));
      float c2 = snoise(cq * 1.9 + vec2(c1 * 0.55, -c1 * 0.4) + vec2(-uT * 0.37, uT * 0.45));
      col += vec3(1.0, 0.32, 0.6) * pow(1.0 - abs(c2), 4.0) * (0.55 + 0.45 * c1) * reg * uCaus * 0.09 * uSetGain;
    }
  }
  if (uShadow.z > 0.0 || uShadow.w > 0.0) {
    vec4 Fs = field(p - uShadow.xy);
    col *= 1.0 - uShadow.z * ss(26.0, -34.0, Fs.x);
    col += (palMid(Fs.w) * 0.075 * ss(-8.0, -60.0, Fs.x) + palThin(Fs.w) * 0.05 * ss(-30.0, -110.0, Fs.x)) * uShadow.w * uSetGain;
  }
  float fy = uFloor.x;
  if (fy > 0.0) {
    vec2 rd = (p - uRip.xy) * vec2(1.0, 4.6);
    float rr = length(rd);
    if (uRip.w > 0.0 && p.y > uFloor.y) {               // ripple rings: specular on the polished floor
      float ring = 0.0;
      for (int k = 0; k < 2; k++) {
        float fk = uRip.z * 470.0 * (1.0 - 0.12 * float(k)) - float(k) * 22.0;
        float e = (rr - fk) / (2.6 + fk * 0.008);
        if (fk > 0.0) ring += exp(-e * e) * exp(-fk / 380.0) * (1.0 - 0.3 * float(k));
      }
      col += vec3(1.0, 0.40, 0.64) * ring * uRip.w * 0.55 * exp(-uRip.z * 2.2) * uSetGain;
    }
    float dy = p.y - fy;
    if (dy > 0.0 && dy < 170.0 && uFloor.z > 0.0) {      // reflection: the field mirrored about the contact line
      vec2 pm = vec2(p.x, fy - dy);
      if (uRip.w > 0.0) {
        float e = (rr - uRip.z * 470.0) / 50.0, w = exp(-e * e) * uRip.w * exp(-uRip.z * 1.6);
        pm += w * vec2(12.0 * sin(rr * 0.08), 9.0 * cos(rr * 0.08));
      }
      vec4 lm = shadeLiquid(pm, field(pm), true);
      col = mix(col, lm.rgb * 0.75, lm.a * exp(-dy / 80.0) * 0.5 * ss(170.0, 90.0, dy) * uFloor.z);
    }
    if (abs(dy) < 60.0 && uFloor.w > 0.0) {             // contact darkening where the liquid meets the floor
      vec4 Fc = field(vec2(p.x, fy - 3.0));
      col *= 1.0 - 0.65 * uFloor.w * ss(4.0, -10.0, Fc.x) * exp(-abs(dy) / 7.0);
    }
  }
  vec4 L = shadeLiquid(p, F, false);
  if (L.a > 0.0 && uNBub > 0) { vec4 bb = bubbles(p, F.w); L.rgb = L.rgb * (1.0 - 0.35 * bb.a) + bb.rgb * 0.8; }
  col = mix(col, L.rgb, L.a);
  col = mix(col, tone(col), uTone);
  if (uDither > 0.0) {                                  // triangular dither in 8-bit sRGB steps, fixed within a frame
    vec2 fc = gl_FragCoord.xy + mod(uFrame, 977.0) * vec2(37.0, 17.0);
    float nz = hash12(fc) + hash12(fc * 1.37 + 11.3) - 1.0;
    col = toLinear(max(toSRGB(max(col, 0.0)) + nz * uDither / 255.0, 0.0));
  }
  fragColor = vec4(col, 1.0);
}`;

const v4 = (n: number) => Array.from({ length: n }, () => new THREE.Vector4());
const lin = (hex: string) => new THREE.Vector3(...hexToLinear(hex));

/**
 * The liquid as one fullscreen pass into a linear HDR target: the studio (or `view.under`), the shadow, floor
 * reflection, contact darkening and ripples, then the liquid itself. Up to 64 balls, 24 segments, 8 letters and
 * 24 bubbles per frame (extras are dropped with a warning). Multi-sample exports supersample it for free (one
 * rotated-grid tap per sub-frame).
 */
export class LiquidPass {
  pass: FSPass;
  private warned = false;
  private blank = new THREE.DataTexture(new Uint16Array(4).fill(THREE.DataUtils.toHalfFloat(200)), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  constructor(public o: { word?: WordSDF; palette?: LiquidPalette; studio?: LiquidStudio } = {}) {
    const pal = o.palette ?? CANDY, st = o.studio ?? PLUM;
    this.blank.needsUpdate = true;
    this.pass = new FSPass(FRAG, {
      uView: { value: new THREE.Vector4(1, W / 2, H / 2, 0.08) },
      uNB: { value: 0 }, uB: { value: v4(NB) }, uBX: { value: v4(NB) },
      uNS: { value: 0 }, uS: { value: v4(NS) }, uSX: { value: v4(NS) },
      uNL: { value: 0 }, uL: { value: v4(NL) }, uLX: { value: v4(NL) }, uLM: { value: v4(NL) }, uLT: { value: v4(NL) }, uLP: { value: v4(NL) },
      uWord: { value: o.word?.texture ?? this.blank }, uWordSize: { value: new THREE.Vector2(...(o.word?.atlas ?? [1, 1])) },
      uNBub: { value: 0 }, uBub: { value: v4(NBUB) },
      uFloor: { value: new THREE.Vector4() }, uShadow: { value: new THREE.Vector4() }, uKey: { value: new THREE.Vector4() },
      uRip: { value: new THREE.Vector4() }, uSpot: { value: new THREE.Vector4() },
      uPal: { value: [...pal.thin, ...pal.mid, ...pal.deep].map(lin) },
      uSetC: { value: [st.top, st.horizon, st.far, st.near, st.spot, st.glow].map(lin) },
      uSetGain: { value: 1 }, uCaus: { value: 0 }, uT: { value: 0 }, uUseSet: { value: 0 }, uSet: { value: null }, uFrame: { value: 0 }, uTone: { value: 1 }, uDither: { value: 1 },
      ssTap: SS_TAP,
    });
  }

  render(renderer: THREE.WebGLRenderer, out: THREE.WebGLRenderTarget | null, g: Goo, t: number, view: LiquidView = {}) {
    const u = this.pass.u, word = this.o.word;
    const over = g.balls.length > NB || g.segs.length > NS || g.letters.length > NL || g.bubbles.length > NBUB;
    if (over && !this.warned) { this.warned = true; console.warn(`liquid: over the limit (${g.balls.length}/${NB} balls, ${g.segs.length}/${NS} segs, ${g.letters.length}/${NL} letters, ${g.bubbles.length}/${NBUB} bubbles): extras dropped`); }
    const B = u.uB!.value as THREE.Vector4[], BX = u.uBX!.value as THREE.Vector4[];
    const nb = Math.min(NB, g.balls.length);
    for (let i = 0; i < nb; i++) { const b = g.balls[i]!; B[i]!.set(b.x, b.y, b.r, b.u); BX[i]!.set(Math.max(0.05, b.s ?? 1), b.a ?? Math.PI / 2, 0, 0); }
    u.uNB!.value = nb;
    const S = u.uS!.value as THREE.Vector4[], SX = u.uSX!.value as THREE.Vector4[];
    const ns = Math.min(NS, g.segs.length);
    for (let i = 0; i < ns; i++) { const s = g.segs[i]!; S[i]!.set(s.ax, s.ay, s.bx, s.by); SX[i]!.set(s.ra, s.rb, s.u, 0); }
    u.uNS!.value = ns;
    const Lu = u.uL!.value as THREE.Vector4[], LX = u.uLX!.value as THREE.Vector4[], LM = u.uLM!.value as THREE.Vector4[];
    const LT = u.uLT!.value as THREE.Vector4[], LP = u.uLP!.value as THREE.Vector4[];
    let nl = 0;
    if (word) for (const l of g.letters) {
      const W0 = word.letters[l.i];
      if (!W0 || nl >= NL) continue;
      const m = l.m ?? 1, e = l.ell ?? [l.x, l.y, 1, 1];
      Lu[nl]!.set(l.x, l.y, l.grow ?? 0, l.u);
      LX[nl]!.set(Math.max(0.02, l.sx ?? 1), Math.max(0.02, l.sy ?? 1), l.a ?? 0, Math.max(1e-3, Math.min(1, m)));
      LM[nl]!.set(e[0], e[1], Math.max(0.5, e[2]), Math.max(0.5, e[3]));
      LT[nl]!.set(...W0.tile);
      LP[nl]!.set(W0.pivot[0], W0.pivot[1], l.wob ?? 0, l.wph ?? 0);
      nl++;
    }
    u.uNL!.value = nl;
    const Bb = u.uBub!.value as THREE.Vector4[], nbub = Math.min(NBUB, g.bubbles.length);
    for (let i = 0; i < nbub; i++) { const b = g.bubbles[i]!; Bb[i]!.set(b.x, b.y, b.r, b.a); }
    u.uNBub!.value = nbub;

    (u.uView!.value as THREE.Vector4).set(view.zoom ?? 1, view.x ?? W / 2, view.y ?? H / 2, view.k ?? 0.08);
    (u.uFloor!.value as THREE.Vector4).set(view.floor ?? 0, view.horizon ?? view.floor ?? 0, view.reflect ?? 1, view.contact ?? 1);
    const sh = view.shadow ?? [24, 32, 0.5, 1], key = view.key ?? [-0.78, -0.95], gl = view.glint ?? [-9999, 0];
    const rip = view.ripple ?? [0, 0, 0, 0], spot = view.spot ?? [W / 2, H * 0.46, 1050, 620];
    (u.uShadow!.value as THREE.Vector4).set(sh[0], sh[1], sh[2], sh[3]);
    (u.uKey!.value as THREE.Vector4).set(key[0], key[1], gl[0], gl[1]);
    (u.uRip!.value as THREE.Vector4).set(rip[0], rip[1], rip[2], rip[3]);
    (u.uSpot!.value as THREE.Vector4).set(spot[0], spot[1], spot[2], spot[3]);
    u.uSetGain!.value = view.set ?? 1;
    u.uCaus!.value = view.caustics ?? 0;
    u.uT!.value = t;
    u.uUseSet!.value = view.under ? 1 : 0;
    u.uSet!.value = view.under ?? null;
    u.uFrame!.value = frameIdx(t);
    u.uTone!.value = view.tone ?? 1;
    u.uDither!.value = view.dither ?? 1;
    this.pass.render(renderer, out);
  }

  dispose() { this.pass.mat.dispose(); this.blank.dispose(); this.o.word?.texture.dispose(); }
}

// 关键帧动画：数值 / 向量 / 颜色的关键帧，像 AE 的时间轴一样给属性打帧。输出只取决于 t（确定性）。
//
// 为什么要它：逐帧按随机数算状态（换色、重排、抖动）能凑够“运动量”，但画面里不是同一个东西在动，
// 看起来是一堆镜头拼的。图形动画的连贯来自：元素一直存在，属性沿着带缓动的曲线变，转场是同一个元素在变。
//
// 每个关键帧 [t, v, mode]，mode 管这一帧怎么过：
//   'auto'（默认） 平滑穿过：速度连续（Catmull-Rom 切线），连续的运动、甩镜、跟拍都用它
//   'ease'          在这一帧减速停住再出发（AE 的缓动，切线为 0）：落定、定格
//   'lin'           这一段匀速（到下一帧）
//   'hold'          停在这个值，到下一帧瞬间跳过去：换色、换字、开关
//   { in, out, speedIn, speedOut }  AE 图表编辑器的手柄：这一帧进来、出去两侧各自的影响（0–1，AE 的 influence ÷ 100）
//                   和速度（单位 / 秒，默认 0）。没写的一侧按 AE 的「缓动」：影响 1/3、速度 0。常用的写法在 K 里
// 第一帧和最后一帧的切线为 0（从静止起步、停到静止），想带着速度进出就在两头多打一帧。
// 'auto' 的切线可能冲过目标一点点（和 AE 的自动贝塞尔一样），要绝不过冲就在那一帧用 'ease'。
//
// AE 的利落感来自不对称的缓动，不是平滑：起步快（出去那侧影响很小）、落点长长地减速（进来那侧影响很大）。
// 全用 'auto' 的动作速度连续、处处圆滑，看着在「飘」，这是代码做的动效最常见的毛病。常用组合：
//   进场、落定（快出慢停）  [t0, a, K.go], [t1, b, K.land]
//   离场、蓄力（慢起快收）  [t0, a, K.windup], [t1, b, K.slam]
//   AE 默认缓动（F9）       K.easy
// 预览里按 G 打开曲线编辑器，可以直接拖关键帧和手柄（engine/tracks.ts 的 kfe）。
//
// 后半是 MG（扁平图形动画）的动作件，参考 mg-styles-15（Vincentwei1021，MIT）demos/01-flat-vector、02-line-art、
// 03-isometric、19-paperclip 的做法重写：
//   pop / kick / hops     弹出的挤压量由弹簧速度换算（快的时候拉长、回弹时压扁），到点强制归 1（放大镜头下不留亚像素漂移）；
//                         跳跃 = 起跳前压扁、空中沿速度拉长、落地一记衰减冲击
//   stagger               按到中心的距离 / 环数 + 角度错峰（一圈圈、顺时针地出现，比按序号错峰有空间感）
//   lerpZoom / kfz / zoomPath  缩放在对数空间插值（1→4 的一半是 2，速度感均匀）；两个视图之间平滑的缩放平移（van Wijk）
//   lead / holdClock      镜头领先：看目标“将要到”的位置（高斯加权），停顿前镜头时钟先减到 0、停顿后追上
//   monotone              单调样条：[时间, 进度] 关键点连成不过冲的曲线，同一个值重复两次 = 停顿
import { clamp, hash, lerp, TAU, type V2 } from './util';

/** AE 式的时间缓动手柄：影响 0–1（AE 的 influence ÷ 100），速度是单位 / 秒。没写的一侧 = 影响 1/3、速度 0（AE 的缓动）。 */
export interface KEase { in?: number; out?: number; speedIn?: number; speedOut?: number }
export type KMode = 'auto' | 'ease' | 'lin' | 'hold' | KEase;
export type Key<V> = readonly [t: number, v: V, mode?: KMode];

/** 常用的 AE 缓动写法，放在关键帧的第三项。 */
export const K = {
  /** AE 的缓动（F9）：两侧影响 33%、速度 0。 */
  easy: { in: 1 / 3, out: 1 / 3 } as KEase,
  /** 从这一帧猛地出发：出去那侧影响 5%（几乎不加速，一开始就快）。配下一帧的 land。 */
  go: { out: 0.05 } as KEase,
  /** 长长地减速落到这一帧：进来那侧影响 90%。 */
  land: { in: 0.9 } as KEase,
  /** 慢慢起步：出去那侧影响 90%（蓄力、离场的开头）。 */
  windup: { out: 0.9 } as KEase,
  /** 全速撞到这一帧：进来那侧影响 5%（砸下、重击、离场的结尾）。 */
  slam: { in: 0.05 } as KEase,
};
/** 自己给影响和速度：ae(进来的影响, 出去的影响, 进来的速度, 出去的速度)。 */
export const ae = (inf: number, outf: number, speedIn = 0, speedOut = 0): KEase => ({ in: inf, out: outf, speedIn, speedOut });

const isEase = (m: KMode | undefined): m is KEase => typeof m === 'object' && m !== null;

function seg<V>(t: number, keys: readonly Key<V>[]): number {
  // index i with keys[i].t <= t < keys[i+1].t (keys sorted by time)
  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (keys[mid]![0] <= t) lo = mid; else hi = mid; }
  return lo;
}

/** Tangent (value per second) at key i of a scalar track. */
function tangent(keys: readonly Key<number>[], i: number, get: (v: number) => number = (v) => v): number {
  const k = keys[i]!, mode = k[2] ?? 'auto';
  if (mode === 'ease' || mode === 'hold' || i === 0 || i === keys.length - 1) return 0;
  const a = keys[i - 1]!, b = keys[i + 1]!;
  if ((a[2] ?? 'auto') === 'hold') return 0; // arriving from a jump: start from rest
  return (get(b[1]) - get(a[1])) / Math.max(1e-6, b[0] - a[0]);
}

function hermite(p0: number, m0: number, p1: number, m1: number, u: number, dt: number) {
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * dt * m0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * dt * m1;
}

/**
 * The two handles of segment i (keys i → i+1) in AE's terms: [out influence, out speed, in influence, in speed].
 * 'auto' / 'ease' keys are AE's 1/3-influence handles with the Catmull-Rom / zero tangent as the speed (the same
 * curve as the cubic Hermite these modes always used).
 */
export function handles(keys: readonly Key<number>[], i: number): [number, number, number, number] {
  const a = keys[i]!, b = keys[i + 1]!, ma = a[2], mb = b[2];
  const oa = isEase(ma) ? clamp(ma.out ?? 1 / 3, 0, 1) : 1 / 3;
  const sa = isEase(ma) ? ma.speedOut ?? 0 : tangent(keys, i);
  const ib = isEase(mb) ? clamp(mb.in ?? 1 / 3, 0, 1) : 1 / 3;
  const sb = isEase(mb) ? mb.speedIn ?? 0 : tangent(keys, i + 1);
  return [oa, sa, ib, sb];
}

/** Value of a segment drawn as AE draws it: a cubic Bezier in (time, value) with handles of the given influence and speed. */
function bezierSeg(t0: number, v0: number, t1: number, v1: number, oa: number, sa: number, ib: number, sb: number, t: number) {
  const dt = t1 - t0, x = t - t0;
  const x1 = oa * dt, x2 = dt - ib * dt;                      // handle times (offsets from t0)
  const y1 = v0 + sa * oa * dt, y2 = v1 - sb * ib * dt;       // handle values
  // X(u) is monotonic for influences in [0, 1]: bisect for the u where X(u) = x
  let lo = 0, hi = 1, u = x / dt;
  for (let k = 0; k < 42; k++) {
    const w = 1 - u, X = 3 * w * w * u * x1 + 3 * w * u * u * x2 + u * u * u * dt;
    if (Math.abs(X - x) < 1e-9 * Math.max(1, dt)) break;
    if (X < x) lo = u; else hi = u;
    u = (lo + hi) / 2;
  }
  const w = 1 - u;
  return w * w * w * v0 + 3 * w * w * u * y1 + 3 * w * u * u * y2 + u * u * u * v1;
}

/** A scalar property at time t. */
export function kf(t: number, keys: readonly Key<number>[]): number {
  const n = keys.length;
  if (n === 0) return 0;
  if (t <= keys[0]![0] || n === 1) return keys[0]![1];
  if (t >= keys[n - 1]![0]) return keys[n - 1]![1];
  const i = seg(t, keys), a = keys[i]!, b = keys[i + 1]!;
  const mode = a[2] ?? 'auto';
  if (mode === 'hold') return a[1];
  const dt = b[0] - a[0], u = (t - a[0]) / dt;
  if (mode === 'lin') return lerp(a[1], b[1], u);
  const [oa, sa, ib, sb] = handles(keys, i);
  if (Math.abs(oa - 1 / 3) < 1e-9 && Math.abs(ib - 1 / 3) < 1e-9) return hermite(a[1], sa, b[1], sb, u, dt);
  return bezierSeg(a[0], a[1], b[0], b[1], oa, sa, ib, sb, t);
}

/** Speed (value per second) of a scalar track at t, as AE's speed graph shows it (central difference). */
export function kfSpeed(t: number, keys: readonly Key<number>[], h = 1 / 240): number {
  return (kf(t + h, keys) - kf(t - h, keys)) / (2 * h);
}

/** A vector property (position, scale pair, rgb …): every component on the same keys. */
export function kfv(t: number, keys: readonly Key<readonly number[]>[]): number[] {
  const n = keys.length;
  if (n === 0) return [];
  const dim = keys[0]![1].length;
  const out: number[] = [];
  for (let d = 0; d < dim; d++) out.push(kf(t, keys.map(([kt, v, m]) => [kt, v[d]!, m] as const)));
  return out;
}

/** Position keys as points: kfp(t, [[0, {x, y}], …]). */
export function kfp(t: number, keys: readonly Key<V2>[]): V2 {
  const [x, y] = kfv(t, keys.map(([kt, p, m]) => [kt, [p.x, p.y], m] as const));
  return { x: x!, y: y! };
}

const hex = (c: string): number[] => {
  const s = c.replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((ch) => ch + ch).join('') : s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toLin = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
const toSrgb = (v: number) => Math.round(255 * clamp(v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));

/** Colour keys ('#rrggbb'), mixed in linear light (no muddy midpoints). Default mode 'lin'; 'hold' to switch. */
export function kfc(t: number, keys: readonly Key<string>[]): string {
  const ks = keys.map(([kt, c, m]) => [kt, hex(c).map(toLin), m ?? 'lin'] as const);
  const v = kfv(t, ks);
  return `rgb(${toSrgb(v[0]!)},${toSrgb(v[1]!)},${toSrgb(v[2]!)})`;
}

/** Mix two '#rrggbb' colours in linear light. */
export function mixColor(a: string, b: string, u: number): string {
  const A = hex(a).map(toLin), B = hex(b).map(toLin);
  return `rgb(${A.map((x, i) => toSrgb(lerp(x, B[i]!, u))).join(',')})`;
}

/**
 * A looping track (run cycles, idle bobs): keys over phase 0..1, the curve wraps smoothly from the last key
 * back to the first (periodic Catmull-Rom). Keys at phases in [0, 1), sorted.
 */
export function kfLoop(phase: number, keys: readonly (readonly [p: number, v: number])[]): number {
  const n = keys.length;
  const p = phase - Math.floor(phase);
  let i = n - 1;
  for (let k = 0; k < n; k++) if (keys[k]![0] <= p) i = k;
  const at = (k: number) => {
    const j = ((k % n) + n) % n, wrap = Math.floor(k / n);
    return [keys[j]![0] + wrap, keys[j]![1]] as const;
  };
  const [t0, v0] = at(i), [t1, v1] = at(i + 1), [tm, vm] = at(i - 1), [t2, v2] = at(i + 2);
  const pp = p < t0 ? p + 1 : p;
  const dt = t1 - t0, u = (pp - t0) / dt;
  const m0 = (v1 - vm) / (t1 - tm), m1 = (v2 - v0) / (t2 - t0);
  return hermite(v0, m0, v1, m1, u, dt);
}

// ---------- AE 表达式里常用的两样：wiggle、loopOut ----------

/** Smooth 1D gradient noise, about −1..1, zero at integers' gradients' crossings (C2 quintic fade). */
function gnoise(x: number, seed: number): number {
  const i = Math.floor(x), f = x - i;
  const g0 = hash(i, seed, 7) * 2 - 1, g1 = hash(i + 1, seed, 7) * 2 - 1;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  return 2 * lerp(g0 * f, g1 * (f - 1), u);
}

/**
 * AE 的 wiggle(freq, amp)：每秒大约 freq 次、幅度 ±amp 的平滑随机摆动，只取决于 t 和 seed（同一个 seed 同一条线）。
 * octaves / ampMult 同 AE（多叠几层更碎的抖动，每层幅度乘 ampMult）。漂浮、手持晃动、电视一直轻轻漂都用它。
 */
export function wiggle(t: number, freq: number, amp: number, seed = 0, octaves = 1, ampMult = 0.5): number {
  let s = 0, a = 1, f = freq, norm = 0;
  for (let k = 0; k < Math.max(1, octaves); k++) { s += a * gnoise(t * f + k * 17.31, seed + k * 101); norm += a; a *= ampMult; f *= 2; }
  return (amp * s) / Math.max(1e-9, norm);
}
/** wiggle 的二维版：[x, y] 各自独立。 */
export function wiggle2(t: number, freq: number, amp: number | V2, seed = 0, octaves = 1): V2 {
  const [ax, ay] = typeof amp === 'number' ? [amp, amp] : [amp.x, amp.y];
  return { x: wiggle(t, freq, ax, seed * 2 + 1, octaves), y: wiggle(t, freq, ay, seed * 2 + 2, octaves) };
}

/**
 * AE 的 loopOut：关键帧放完以后怎么继续。'cycle' 从头再放；'pingpong' 倒着放回来；'offset' 每圈接着上一圈的终点累加
 * （一直往前走的步进、一圈圈转）；'continue' 按最后的速度一直走下去。t 在第一帧之前照常（停在第一帧的值）。
 */
export function loopOut(t: number, keys: readonly Key<number>[], mode: 'cycle' | 'pingpong' | 'offset' | 'continue' = 'cycle'): number {
  const n = keys.length;
  if (n < 2) return kf(t, keys);
  const t0 = keys[0]![0], t1 = keys[n - 1]![0], d = t1 - t0;
  if (t <= t1 || d <= 0) return kf(t, keys);
  if (mode === 'continue') return keys[n - 1]![1] + kfSpeed(t1 - 1e-4, keys) * (t - t1);
  const k = Math.floor((t - t0) / d), u = t - t0 - k * d;
  if (mode === 'pingpong') return kf(k % 2 ? t1 - u : t0 + u, keys);
  const v = kf(t0 + u, keys);
  return mode === 'offset' ? v + k * (keys[n - 1]![1] - keys[0]![1]) : v;
}

// ---------- easing curves for one-off moves: prog(t, a, b, E.out) ----------

/** CSS / AE-style cubic-bezier timing curve through (0,0) (x1,y1) (x2,y2) (1,1). */
export function bezier(x1: number, y1: number, x2: number, y2: number): (u: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (s: number) => ((ax * s + bx) * s + cx) * s;
  const Y = (s: number) => ((ay * s + by) * s + cy) * s;
  const dX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  return (u: number) => {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    let s = u;
    for (let k = 0; k < 6; k++) { const d = dX(s); if (Math.abs(d) < 1e-6) break; s -= (X(s) - u) / d; }
    s = clamp(s);
    if (Math.abs(X(s) - u) > 1e-4) { // Newton missed: bisect
      let lo = 0, hi = 1;
      for (let k = 0; k < 30; k++) { s = (lo + hi) / 2; if (X(s) < u) lo = s; else hi = s; }
    }
    return Y(s);
  };
}

/** Easing presets named after what they look like in motion design. */
export const E = {
  /** AE “easy ease” (33 % influence both sides). */
  ease: bezier(0.33, 0, 0.67, 1),
  /** Fast start, long soft landing: things arriving. */
  out: bezier(0.16, 1, 0.3, 1),
  /** Slow start, fast exit: things leaving, wind-ups. */
  in: bezier(0.7, 0, 0.84, 0),
  /** Snappy motion-design move: crawl, whip, settle (expo in-out). */
  snap: bezier(0.87, 0, 0.13, 1),
  /** Lands with a little overshoot. */
  back: bezier(0.34, 1.56, 0.64, 1),
  /** Shape morphs: holds the old shape, commits hard in the middle, settles into the new one (mg-styles 08). */
  morph: bezier(0.7, 0, 0.3, 1),
  linear: (u: number) => u,
};

/**
 * Spring settle from `from` to `to`, released at t0: overshoots and rings down. freq in Hz, damping 0..1.
 * Before t0 it holds `from`.
 */
export function spring(t: number, t0: number, from: number, to: number, freq = 3, damping = 0.4): number {
  if (t <= t0) return from;
  const x = t - t0, w = TAU * freq;
  const env = Math.exp(-damping * w * x) * Math.cos(w * Math.sqrt(Math.max(0, 1 - damping * damping)) * x);
  return to + (from - to) * env;
}

/**
 * Squash and stretch for a body with velocity (vx, vy) px/s: scale along the motion and across it, keeping area.
 * Returns { angle, along, across } for c.rotate(angle); c.scale(along, across); c.rotate(-angle).
 */
export function stretch(vx: number, vy: number, k = 0.00035, max = 0.6) {
  const v = Math.hypot(vx, vy), s = 1 + Math.min(max, v * k);
  return { angle: Math.atan2(vy, vx), along: s, across: 1 / Math.sqrt(s) };
}

/** Numerical velocity of any function of time (for squash, motion-aligned trails, facing direction). */
export function velocity<T extends number | V2>(f: (t: number) => T, t: number, h = 1 / 240): T {
  const a = f(t - h), b = f(t + h);
  if (typeof a === 'number') return (((b as number) - a) / (2 * h)) as T;
  const A = a as V2, B = b as V2;
  return { x: (B.x - A.x) / (2 * h), y: (B.y - A.y) / (2 * h) } as T;
}

// ---------- camera ----------

/**
 * A 2D camera: world point (x, y) is shown at the frame centre, zoomed and rotated. Apply with
 * `applyCamera(c, cam)` before drawing world-space things (save/restore around it).
 */
export interface Cam { x: number; y: number; zoom: number; rot: number }
export function applyCamera(c: CanvasRenderingContext2D, cam: Cam, w: number, h: number) {
  c.translate(w / 2, h / 2);
  c.rotate(cam.rot);
  c.scale(cam.zoom, cam.zoom);
  c.translate(-cam.x, -cam.y);
}
/** World → screen for a camera (for track() reports and screen-space overlays). */
export function toScreen(p: V2, cam: Cam, w: number, h: number): V2 {
  const dx = (p.x - cam.x) * cam.zoom, dy = (p.y - cam.y) * cam.zoom;
  const cs = Math.cos(cam.rot), sn = Math.sin(cam.rot);
  return { x: w / 2 + dx * cs - dy * sn, y: h / 2 + dx * sn + dy * cs };
}

/**
 * Follow a moving target with lag: the camera looks at where the target was `lag` s ago, averaged over a
 * short window, so it trails behind fast moves and catches up (a camera operator, not a rigid mount).
 */
export function follow(target: (t: number) => V2, t: number, lag = 0.12, window = 0.2, n = 8): V2 {
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) {
    const p = target(t - lag - (window * i) / (n - 1) + window / 2);
    x += p.x; y += p.y;
  }
  return { x: x / n, y: y / n };
}

// ---------- MG motion: spring pop with squash, hops, stagger (mg-styles-15 demos/01-flat-vector, 03-isometric, MIT) ----------

/** Damped spring step 0 → 1 released from rest (zero start velocity, unlike util springStep). freq Hz, damping ζ < 1. */
export function springRest(t: number, freq = 2, damping = 0.4): number {
  if (t <= 0) return 0;
  const w = TAU * freq, a = damping * w, b = w * Math.sqrt(Math.max(1e-9, 1 - damping * damping));
  return 1 - Math.exp(-a * t) * (Math.cos(b * t) + (a / b) * Math.sin(b * t));
}

/** Velocity (1/s) of springRest. */
export function springVel(t: number, freq = 2, damping = 0.4): number {
  if (t <= 0) return 0;
  const w = TAU * freq, a = damping * w, b = w * Math.sqrt(Math.max(1e-9, 1 - damping * damping));
  return Math.exp(-a * t) * ((w * w) / b) * Math.sin(b * t);
}

/**
 * Damped impulse at t0: 0 before and at t0, swings to about ±1 a quarter period later and rings down. A landing jolt
 * (`1 - 0.22 * kick(…)` on the height), a wobble, a camera bump.
 */
export function kick(t: number, t0: number, freq = 3, damping = 0.35): number {
  if (t <= t0) return 0;
  const w = TAU * freq, x = t - t0;
  return Math.exp(-damping * w * x) * Math.sin(w * Math.sqrt(Math.max(0, 1 - damping * damping)) * x);
}

export interface PopOpts {
  /** Spring frequency (Hz) and damping. */
  freq?: number;
  damping?: number;
  /** How much the spring's speed stretches it (0.12 ≈ 14 % taller at the fastest growth; 0 = uniform scale). */
  squash?: number;
  /** Seconds after t0 when the residual ringing is eased out to exactly 1 (from 0.7·pin): no sub-pixel drift under zoom. */
  pin?: number;
}

/**
 * Spring pop-in at t0: scale s 0 → 1 with overshoot, plus squash k from the spring's speed (stretched tall while it
 * grows fast, squashed on the rebound). Draw with c.scale(sx, sy): sx = s / (1 + k), sy = s · (1 + k). Before t0 s = 0.
 */
export function pop(t: number, t0: number, o: PopOpts = {}): { s: number; k: number; sx: number; sy: number } {
  const tt = t - t0, f = o.freq ?? 2.4, z = o.damping ?? 0.42, amt = o.squash ?? 0.12, pin = o.pin ?? 0.9;
  let s = springRest(tt, f, z);
  let k = clamp((springVel(tt, f, z) / (TAU * f)) * amt * 2, -0.3, 0.3);
  const q = clamp((tt - pin * 0.7) / (pin * 0.3)), w = q < 0.5 ? 2 * q * q : 1 - (-2 * q + 2) ** 2 / 2;
  s = lerp(s, 1, w); k = lerp(k, 0, w);
  return { s, k, sx: s / (1 + k), sy: s * (1 + k) };
}

/** One jump of a hops() chain: take off at t0, land at t1 on `to` (the body's resting centre). */
export interface HopLeg {
  to: V2;
  t0: number;
  t1: number;
  /** Apex above the higher end, px (exact when both ends are level). Default max(60, 0.4 · distance); 0 = a drop. */
  height?: number;
  /** Wind-up before take-off (s); overrides HopOpts.antic. 0 = no wind-up (a drop from off screen). */
  antic?: number;
}
export interface HopOpts {
  /** Half height of the body (px): on the ground it squashes onto its base instead of its centre. */
  r?: number;
  /** Wind-up (s) and how much it squashes (0.3 = 30 % lower, eased outQuad). */
  antic?: number;
  squash?: number;
  /** Landing: height jolt amount and its ringing (Hz, damping). */
  land?: number;
  freq?: number;
  damping?: number;
  /** In-air stretch along the velocity: `stretch` at `fast` px/s and above. */
  stretch?: number;
  fast?: number;
}
/**
 * A squash-and-stretch pose: draw at (x, y) with c.rotate(angle); c.scale(along, across); c.rotate(-angle) (applySquash),
 * so the body stretches along `angle` without turning. On the ground angle = −π/2 (along = height scale).
 */
export interface HopPose { x: number; y: number; angle: number; along: number; across: number; air: boolean }

/**
 * A body hopping from `start` through `legs`: before each take-off it squashes (outQuad), flies a parabola (gravity: a
 * quadratic Bézier at constant parameter speed) stretched along its velocity, and lands with a damped jolt
 * (kick 3.5 Hz, ζ 0.4) that is still ringing when the next wind-up starts. Legs in time order, not overlapping.
 */
export function hops(t: number, start: V2, legs: readonly HopLeg[], o: HopOpts = {}): HopPose {
  const r = o.r ?? 0, sq = o.squash ?? 0.3, ld = o.land ?? 0.22;
  let from = start, i = 0;
  while (i < legs.length && t >= legs[i]!.t1) { from = legs[i]!.to; i++; }
  const L = legs[i];
  if (L && t >= L.t0) {
    const dur = Math.max(1e-6, L.t1 - L.t0), u = (t - L.t0) / dur, P1 = L.to;
    const h = L.height ?? Math.max(60, 0.4 * Math.hypot(P1.x - from.x, P1.y - from.y));
    const C = { x: (from.x + P1.x) / 2, y: Math.min(from.y, P1.y) - 2 * h };
    const v = 1 - u;
    const x = v * v * from.x + 2 * v * u * C.x + u * u * P1.x, y = v * v * from.y + 2 * v * u * C.y + u * u * P1.y;
    const vx = (2 * v * (C.x - from.x) + 2 * u * (P1.x - C.x)) / dur, vy = (2 * v * (C.y - from.y) + 2 * u * (P1.y - C.y)) / dur;
    const st = 1 + clamp(Math.hypot(vx, vy) / (o.fast ?? 5000)) * (o.stretch ?? 0.22);
    return { x, y, angle: Math.atan2(vy, vx), along: st, across: 1 / st, air: true };
  }
  const antic = L ? L.antic ?? o.antic ?? 0.15 : 0;
  const q = antic > 0 && L ? clamp((t - (L.t0 - antic)) / antic) : 0, an = 1 - (1 - q) * (1 - q);
  const kk = i > 0 ? kick(t, legs[i - 1]!.t1, o.freq ?? 3.5, o.damping ?? 0.4) : 0;
  const sy = (1 - sq * an) * (1 - ld * kk), sx = (1 + 0.67 * sq * an) * (1 + 0.9 * ld * kk);
  return { x: from.x, y: from.y + r * (1 - sy), angle: -Math.PI / 2, along: sy, across: sx, air: false };
}

/** Apply a HopPose (or stretch()) about the current origin: translate(x, y) first. */
export function applySquash(c: CanvasRenderingContext2D, p: { angle: number; along: number; across: number }) {
  c.rotate(p.angle);
  c.scale(p.along, p.across);
  c.rotate(-p.angle);
}

export interface StaggerOpts {
  /** Continuous ripple: the delay grows 1 s per `speed` px from the centre (default 1000). Ignored when `ring` is set. */
  speed?: number;
  /** Rings `ring` px wide (round index); ring k waits k · gap s, or gap[k] when a list (extrapolated past its end). */
  ring?: number;
  gap?: number | readonly number[];
  /** 'round' distance or 'box' (square rings around a grid's centre cell). */
  metric?: 'round' | 'box';
  /** Extra delay over one clockwise turn around the centre (s), starting from angle `from` (rad, default straight up). */
  turn?: number;
  from?: number;
  /** Seeded random extra delay in [0, jitter) s. */
  jitter?: number;
  seed?: number;
}

/**
 * Stagger delay (s, ≥ 0) of an element at p rippling out from `centre`: by distance or ring, then clockwise around the
 * ring. `t0 + stagger(p, c, o)` is its own start time. 01-flat-vector: the skyline rises centre-out (|x − 960| / 960 ·
 * 0.4 s); 03-isometric: tiles land ring by ring, 0.07 s around each ring, ±0.01 s jitter.
 */
export function stagger(p: V2, centre: V2, o: StaggerOpts = {}): number {
  const dx = p.x - centre.x, dy = p.y - centre.y;
  const d = o.metric === 'box' ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.hypot(dx, dy);
  let delay: number;
  if (o.ring) {
    const k = Math.round(d / o.ring), g = o.gap ?? 0.08;
    if (typeof g === 'number') delay = k * g;
    else {
      const n = g.length, last = g[n - 1] ?? 0, step = n > 1 ? last - g[n - 2]! : 0.08;
      delay = k < n ? g[k]! : last + (k - n + 1) * step;
    }
  } else delay = d / (o.speed ?? 1000);
  if (o.turn && (dx || dy)) {
    const a = (Math.atan2(dy, dx) - (o.from ?? -Math.PI / 2)) / TAU;
    delay += (a - Math.floor(a)) * o.turn;
  }
  if (o.jitter) delay += hash(p.x, p.y, o.seed ?? 0) * o.jitter;
  return Math.max(0, delay);
}

// ---------- zoom in log space, smooth zoom-and-pan (mg-styles-15 demos/02-line-art, 19-paperclip, MIT) ----------

/** Zoom from z0 to z1 in log space: equal ratios in equal times (1 → 4 passes 2 halfway), a zoom that feels steady. */
export const lerpZoom = (z0: number, z1: number, u: number) => Math.exp(lerp(Math.log(z0), Math.log(z1), u));

/** Zoom keys (kf modes) interpolated in log space. */
export function kfz(t: number, keys: readonly Key<number>[]): number {
  return Math.exp(kf(t, keys.map(([kt, z, m]) => [kt, Math.log(Math.max(1e-9, z)), m] as const)));
}

/** A 2D view: world point (x, y) at the frame centre, `zoom` screen px per world px (Cam without rotation). */
export interface View { x: number; y: number; zoom: number }

/**
 * Smooth zoom-and-pan from view a to view b (van Wijk & Nuij 2003, d3.interpolateZoom): when the views are far apart it
 * pulls out, travels, and dives back in, keeping the perceived speed constant. u 0..1 → view (ease u yourself).
 * rho: how much it pulls out (√2 = d3's default; mg-styles 19 uses 0.85 for a fly, 1.25 for a pull-back);
 * span = screen width in px. `.duration` is the path's natural length in seconds at d3's default speed (to compare moves).
 */
export function zoomPath(a: View, b: View, rho = Math.SQRT2, span = 1920): ((u: number) => View) & { duration: number } {
  const w0 = span / a.zoom, w1 = span / b.zoom, dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
  const rho2 = rho * rho, rho4 = rho2 * rho2;
  let f: (u: number) => View, S: number;
  if (d2 < 1e-12) {
    S = Math.log(w1 / w0) / rho;
    f = (u) => ({ x: a.x + u * dx, y: a.y + u * dy, zoom: span / (w0 * Math.exp(rho * u * S)) });
  } else {
    const d1 = Math.sqrt(d2);
    const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1), b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1);
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0), r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
    S = (r1 - r0) / rho;
    const ch = Math.cosh(r0), sh = Math.sinh(r0);
    f = (u) => {
      const s = u * S, k = (w0 / (rho2 * d1)) * (ch * Math.tanh(rho * s + r0) - sh);
      return { x: a.x + k * dx, y: a.y + k * dy, zoom: span / ((w0 * ch) / Math.cosh(rho * s + r0)) };
    };
  }
  const g = (u: number) => (u <= 0 ? { ...a } : u >= 1 ? { ...b } : f(u));
  return Object.assign(g, { duration: (Math.abs(S) * rho) / Math.SQRT2 });
}

/**
 * Monotone cubic through (xs[i], ys[i]) (xs increasing): never overshoots between keys, and a repeated y is a flat hold
 * with eased entry and exit. startSlope scales the first key's slope (1.3: leaves a little faster); endSlope sets the
 * last one (0: comes to rest; default: the last segment's slope). Clamped outside the keys.
 */
export function monotone(xs: readonly number[], ys: readonly number[], startSlope = 1, endSlope?: number): (x: number) => number {
  const n = xs.length;
  if (n === 0) return () => 0;
  if (n === 1) return () => ys[0]!;
  const d: number[] = [], m: number[] = new Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1]! - ys[i]!) / Math.max(1e-9, xs[i + 1]! - xs[i]!);
  m[0] = d[0]! * startSlope;
  m[n - 1] = endSlope ?? d[n - 2]!;
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1]! * d[i]! <= 0) m[i] = 0;
    else {
      const h0 = xs[i]! - xs[i - 1]!, h1 = xs[i + 1]! - xs[i]!, w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
      m[i] = (w1 + w2) / (w1 / d[i - 1]! + w2 / d[i]!);
    }
  }
  return (x: number) => {
    if (x <= xs[0]!) return ys[0]!;
    if (x >= xs[n - 1]!) return ys[n - 1]!;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid]! <= x) lo = mid; else hi = mid; }
    return hermite(ys[lo]!, m[lo]!, ys[hi]!, m[hi]!, (x - xs[lo]!) / (xs[hi]! - xs[lo]!), xs[hi]! - xs[lo]!);
  };
}

// ---------- leading camera (mg-styles-15 demos/02-line-art, MIT) ----------

export interface LeadOpts {
  /** How far ahead (s) the window is centred, and its Gaussian width σ (s). */
  lead?: number;
  sigma?: number;
  /** Samples each side of the centre (window ±2.7σ). */
  n?: number;
}

/**
 * Camera that leads: looks at a Gaussian-weighted average of where the target is around `lead` s from now (σ 0.3 s), so it
 * sets off before the move and glides through it, instead of trailing like follow(). Feed it holdClock(t, holds) to keep
 * it from drifting on into the next move during a pause. Clamp `target` outside its own time range (it is sampled ±0.8 s).
 */
export function lead(target: (t: number) => V2, t: number, o: LeadOpts = {}): V2 {
  const ahead = o.lead ?? 0.08, sigma = o.sigma ?? 0.3, n = o.n ?? 16, step = (2.7 * sigma) / n;
  let x = 0, y = 0, ws = 0;
  for (let k = -n; k <= n; k++) {
    const dt = k * step, w = Math.exp(-(dt * dt) / (2 * sigma * sigma)), p = target(t + ahead + dt);
    x += p.x * w; y += p.y * w; ws += w;
  }
  return { x: x / ws, y: y / ws };
}

/**
 * A camera clock that pauses with the action: `ease` s before each hold [from, to] it slows to 0 (smoothstep), stays
 * stopped through it, then runs up to ~2.4× over `release` s and is exactly caught up (= t) when that ends. Holds in time
 * order, at least ease + release apart. Pure function of t.
 */
export function holdClock(t: number, holds: readonly (readonly [from: number, to: number])[], o: { ease?: number; release?: number } = {}): number {
  const ea = o.ease ?? 0.133, er = o.release ?? 0.5;
  let lag = 0;
  for (const [h0, h1] of holds) {
    const D = Math.max(0, h1 - h0), c = (2 * D + ea + er) / er;
    if (t <= h0 - ea || t >= h1 + er) continue;
    if (t < h0) { const q = (t - h0 + ea) / ea; lag += ea * (q ** 3 - q ** 4 / 2); }
    else if (t < h1) lag += ea / 2 + (t - h0);
    else {
      const q = (t - h1) / er;
      lag += ea / 2 + D + er * (q - (q ** 3 - q ** 4 / 2) - c * (q / 2 - Math.sin(TAU * q) / (2 * TAU)));
    }
  }
  return t - lag;
}

// ---------------------------------------------------------------- spatial path (AE's motion path)

/**
 * A spatial key: when, where (px; 2 or 3 numbers), how time eases through it (KMode, like kf), and optionally the
 * spatial handles relative to the point (AE's incoming / outgoing spatial tangents). Without handles the path is
 * AE's auto bezier through the points (a straight line between two keys); `linear: true` on the path makes corners.
 */
export interface PathKey { t: number; p: readonly number[]; mode?: KMode; in?: readonly number[]; out?: readonly number[] }

/**
 * Motion along a bezier path (AE's spatial interpolation with auto-orient): the position moves along the curve by
 * arc length, and the keys' modes shape the speed along it (kf over the distance travelled, so 'auto' keys pass
 * through at an even speed, K.go / K.land ease in and out). at(t) → { p, angle (deg, the direction of travel: what
 * AE's auto-orient turns a layer to; 0 = right, clockwise) }.
 *   const fly = motionPath([{ t: 0, p: [200, 800], mode: K.go }, { t: 1.2, p: [900, 300] }, { t: 2, p: [1600, 700], mode: K.land }]);
 *   { position: (t) => fly.at(t).p, rotation: (t) => fly.at(t).angle }
 */
export function motionPath(keys: readonly PathKey[], o: { linear?: boolean } = {}) {
  const n = keys.length, dim = Math.max(2, ...keys.map((k) => k.p.length));
  const P = keys.map((k) => Array.from({ length: dim }, (_, d) => k.p[d] ?? 0));
  const sub = (a: number[], b: number[]) => a.map((x, d) => x - b[d]!);
  const add = (a: number[], b: number[], s = 1) => a.map((x, d) => x + b[d]! * s);
  // the auto tangents (Catmull-Rom with the keys' spacing), a third of them as handles
  const T = P.map((p, i) => (n < 2 ? p.map(() => 0) : i === 0 ? sub(P[1]!, p) : i === n - 1 ? sub(p, P[n - 2]!) : sub(P[i + 1]!, P[i - 1]!).map((x) => x / 2)));
  const segs = Array.from({ length: Math.max(0, n - 1) }, (_, i) => {
    const a = P[i]!, b = P[i + 1]!;
    const h1 = o.linear ? a : keys[i]!.out ? add(a, Array.from({ length: dim }, (_, d) => keys[i]!.out![d] ?? 0)) : add(a, T[i]!, 1 / 3);
    const h2 = o.linear ? b : keys[i + 1]!.in ? add(b, Array.from({ length: dim }, (_, d) => keys[i + 1]!.in![d] ?? 0)) : add(b, T[i + 1]!, -1 / 3);
    const pt = (u: number) => { const v = 1 - u; return a.map((_, d) => v * v * v * a[d]! + 3 * v * v * u * h1[d]! + 3 * v * u * u * h2[d]! + u * u * u * b[d]!); };
    const tan = (u: number) => { const v = 1 - u; return a.map((_, d) => 3 * v * v * (h1[d]! - a[d]!) + 6 * v * u * (h2[d]! - h1[d]!) + 3 * u * u * (b[d]! - h2[d]!)); };
    // arc length table
    const N = 64, cum = new Float64Array(N + 1);
    let prev = pt(0);
    for (let k = 1; k <= N; k++) { const q = pt(k / N); cum[k] = cum[k - 1]! + Math.hypot(...sub(q, prev)); prev = q; }
    return { pt, tan, cum, len: cum[N]! };
  });
  const start = [0];
  for (const s of segs) start.push(start[start.length - 1]! + s.len);
  const dist = keys.map((k, i) => [k.t, start[i]!, k.mode] as Key<number>);
  const total = start[start.length - 1]!;
  return {
    length: total,
    at(t: number): { p: number[]; angle: number } {
      if (n === 0) return { p: [0, 0], angle: 0 };
      if (n === 1) return { p: P[0]!.slice(), angle: 0 };
      const D = Math.min(total, Math.max(0, kf(t, dist)));
      let i = 0;
      while (i < segs.length - 1 && D > start[i + 1]!) i++;
      const s = segs[i]!, local = D - start[i]!, N = s.cum.length - 1;
      let lo = 0, hi = N;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s.cum[m]! <= local) lo = m; else hi = m; }
      const span = s.cum[hi]! - s.cum[lo]!, u = (lo + (span > 0 ? (local - s.cum[lo]!) / span : 0)) / N;
      let d = s.tan(u);
      if (Math.hypot(...d) < 1e-9) d = s.tan(Math.min(1, Math.max(0, u + (u < 0.5 ? 1e-3 : -1e-3))));
      return { p: s.pt(u), angle: (Math.atan2(d[1]!, d[0]!) * 180) / Math.PI };
    },
  };
}

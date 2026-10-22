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
// 第一帧和最后一帧的切线为 0（从静止起步、停到静止），想带着速度进出就在两头多打一帧。
// 'auto' 的切线可能冲过目标一点点（和 AE 的自动贝塞尔一样），要绝不过冲就在那一帧用 'ease'。
import { clamp, lerp, TAU, type V2 } from '../../engine/util';

export type KMode = 'auto' | 'ease' | 'lin' | 'hold';
export type Key<V> = readonly [t: number, v: V, mode?: KMode];

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
  return hermite(a[1], tangent(keys, i), b[1], tangent(keys, i + 1), u, dt);
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

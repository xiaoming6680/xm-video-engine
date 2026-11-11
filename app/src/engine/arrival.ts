// 到达时间（engine/effects.ts 的 reveal 效果配它用）：给图层上每个像素一个「到达时间」（秒），到点才显示。线稿一条一条描出来、
// 字按笔顺写出来、颜色从一点一档一档往外亮开、黑条被擦掉，都是「每个像素什么时候到」这一件事，换的只是到达时间怎么算。
// 不替画面做决定：速度、先后、从哪里开始都由这支片定；默认值只是让它能动起来。
//
// 用法：
//   const ink = (c: CanvasRenderingContext2D) => { c.lineWidth = 6; c.stroke(houseOutline); };   // 也可以是 canvas、图片、ImageData
//   const map = arrivalTrace(600, 400, ink, { speed: 900, gap: 0.08 });     // 线稿：每段连着的线从一头描到另一头，一段接一段
//   { size: [600, 400], draw: …, effects: (t) => [{ type: 'reveal', map, t: t - 1.2 }] }   // 1.2 s 开始描
//
// 到达时间怎么算（都返回 ArrivalMap；秒，从 o.start（默认 0）起；Infinity = 永远不出现）：
//   arrivalStrokes(w, h, strokes, o)   按笔画：strokes 是 timeStrokes 排好时间的中心线（图层像素）。墨迹像素归最近的那一笔，按笔在
//                                      这一笔里走到的位置算时间；交叉处先写的那笔先占。o.radius 墨迹离中心线最远多少 px（12）、
//                                      o.ink 墨迹本身（不给 = 中心线两边 radius 内都算）、o.cross 后写的笔要近多少 px 才抢得走（radius / 2）
//   timeStrokes(strokes, o)            给笔画排时间：每笔 = 一串点（或 { points, t0, t1 } 自己定时间）。时长 = 长度 / speed（px/s，默认 700；
//                                      可以按笔给 (i) => 速度，前几笔慢一点）；两笔之间抬笔 = 距离 / lift（px/s，默认 2000），不少于
//                                      liftMin（0.06 s）；ease 一笔里的快慢（时间 0–1 → 走过的比例 0–1，单调，默认匀速）；o.start 第一笔落笔
//   penAt(timed, t, o)                 笔尖在 t 秒：{ x, y, down（在纸上）, height（离纸多高 px：抬笔走一道弧，o.lift 默认 24）, stroke（第几笔，
//                                      不在笔画上是 −1） }。和 arrivalStrokes 同一套时间，所以笔尖始终在正在出墨的地方。o.land 落笔前、
//                                      收笔后抬起花的时间（0.12 s）
//   arrivalTrace(w, h, ink, o)         没有笔画数据的线稿：按连着的一段一段，从一头沿着线走到另一头（沿线的距离 / speed，默认 600 px/s），
//                                      一段接一段（gap 0.06 s）。o.order 先后：'left'（默认，从左往右）| 'right' | 'top' | 'bottom' |
//                                      'big'（大的先）| 'together'（同时开始，像从各处长出来）；o.from 给几个起点（每段从离它们最近的点开始）；
//                                      o.speck 小于这么多像素的碎点（20）不单独排队，等最近的那段描完一起出现
//   arrivalDistance(w, h, from, o)     从一点、几点或一块区域（遮罩）往外推：距离 / speed（默认 1000 px/s；或 duration：最远处用多少秒）。
//                                      o.squash [sx, sy] 椭圆的波前（[1.6, 1] 横着宽）；o.within 只在这块区域里传，绕着走（沿区域内的距离，
//                                      这时不看 squash）
//   arrivalFrom(w, h, (x, y) => 秒)     自己写（像素中心 x + 0.5、y + 0.5）
//
// ArrivalMap：w、h、data（Float32Array，行优先、y 向下）；start / end 最早 / 最晚的有限时间（墨迹什么时候写完）、at(x, y)；
//   offset(秒)、stretch(倍数, 以哪个时刻为准 = 0)、min(另一张)（逐像素取早的：两种拼一起）、clip(遮罩)（遮罩外永远不出现）；
//   texture()：给 reveal 用的浮点纹理（懒建）；直接改了 data 要调 update()。
//
// 遮罩（ink、within、clip、from 给区域时）：Uint8Array（w × h，非 0 = 在里面）、ImageData、canvas、图片，或 (c) => 画（在一张
//   w × h 的透明 canvas 上按图层像素画）。按 alpha 取一半为界；整张图都不透明（白底黑线的扫描稿）时改按「够暗」取。
//   尺寸不是 w × h 的图会缩放到 w × h。
// 尺寸：按图层像素（w、h 用图层的 size）；reveal 按比例取，图层 res 2、4K 输出都不用重算。1920 × 1080 一张约 8 MB；建一次：笔画、距离
//   几十毫秒，线稿看像素数（百毫秒级）。放在场景的 init 里建，别每帧建。
// 时间：reveal 的 t 和这里同一个钟。用图层时间减开始的时刻；要一档一档地出（硬边分档的光）就给 t 套 stepT（engine/util.ts）。
import * as THREE from 'three';

export type Pt = readonly [number, number];
export type MaskSrc = Uint8Array | ImageData | HTMLCanvasElement | HTMLImageElement | ImageBitmap | ((c: CanvasRenderingContext2D) => void);

/** Per-pixel arrival times (seconds; Infinity = never), row-major with y down, in layer px. */
export class ArrivalMap {
  readonly data: Float32Array;
  private tex: THREE.DataTexture | null = null;
  private range: [number, number] | null = null;

  constructor(readonly w: number, readonly h: number, data?: Float32Array) {
    this.data = data ?? new Float32Array(w * h).fill(Infinity);
  }

  private stats(): [number, number] {
    if (!this.range) {
      let lo = Infinity, hi = -Infinity;
      for (const v of this.data) if (v !== Infinity) { if (v < lo) lo = v; if (v > hi) hi = v; }
      this.range = hi === -Infinity ? [0, 0] : [lo, hi];
    }
    return this.range;
  }
  /** The earliest / latest finite arrival (0 when nothing ever arrives). */
  get start() { return this.stats()[0]; }
  get end() { return this.stats()[1]; }

  at(x: number, y: number): number {
    const ix = Math.floor(x), iy = Math.floor(y);
    return ix < 0 || iy < 0 || ix >= this.w || iy >= this.h ? Infinity : this.data[iy * this.w + ix]!;
  }

  offset(dt: number) { for (let i = 0; i < this.data.length; i++) this.data[i]! += dt; return this.update(); }
  stretch(k: number, from = 0) { for (let i = 0; i < this.data.length; i++) { const v = this.data[i]!; if (v !== Infinity) this.data[i] = from + (v - from) * k; } return this.update(); }
  /** Earliest of the two, pixel by pixel (same size). */
  min(o: ArrivalMap) {
    if (o.w !== this.w || o.h !== this.h) throw new Error(`ArrivalMap.min: ${o.w}x${o.h} vs ${this.w}x${this.h}`);
    for (let i = 0; i < this.data.length; i++) this.data[i] = Math.min(this.data[i]!, o.data[i]!);
    return this.update();
  }
  /** Outside the mask: never. */
  clip(m: MaskSrc) {
    const k = readMask(this.w, this.h, m);
    for (let i = 0; i < this.data.length; i++) if (!k[i]) this.data[i] = Infinity;
    return this.update();
  }
  update() { if (this.tex) this.tex.needsUpdate = true; this.range = null; return this; }

  /** A float texture of the times (R32F, nearest), for the reveal effect. */
  texture(): THREE.DataTexture {
    if (!this.tex) {
      const t = new THREE.DataTexture(this.data, this.w, this.h, THREE.RedFormat, THREE.FloatType);
      t.magFilter = t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      this.tex = t;
    }
    return this.tex;
  }
  dispose() { this.tex?.dispose(); this.tex = null; }
}

// ---- masks --------------------------------------------------------------------------------------------------------------

function ctx2d(w: number, h: number): CanvasRenderingContext2D {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  return cv.getContext('2d', { willReadFrequently: true })!;
}

/** A mask source → w x h bytes, 1 = inside (alpha ≥ half; an all-opaque image: dark enough instead). */
export function readMask(w: number, h: number, src: MaskSrc): Uint8Array {
  if (src instanceof Uint8Array) {
    if (src.length !== w * h) throw new Error(`mask: ${src.length} bytes for ${w}x${h}`);
    return src;
  }
  let img: ImageData;
  if (typeof src === 'function') { const c = ctx2d(w, h); src(c); img = c.getImageData(0, 0, w, h); }
  else if (src instanceof ImageData && src.width === w && src.height === h) img = src;
  else {
    const c = ctx2d(w, h);
    if (src instanceof ImageData) { const t = ctx2d(src.width, src.height); t.putImageData(src, 0, 0); c.drawImage(t.canvas, 0, 0, w, h); }
    else c.drawImage(src, 0, 0, w, h);
    img = c.getImageData(0, 0, w, h);
  }
  const d = img.data, out = new Uint8Array(w * h);
  let opaque = true;
  for (let i = 0; i < out.length; i++) { const a = d[i * 4 + 3]!; out[i] = a >= 128 ? 1 : 0; if (a < 250) opaque = false; }
  if (opaque) for (let i = 0; i < out.length; i++) out[i] = 0.2126 * d[i * 4]! + 0.7152 * d[i * 4 + 1]! + 0.0722 * d[i * 4 + 2]! < 128 ? 1 : 0;
  return out;
}

// ---- strokes ------------------------------------------------------------------------------------------------------------

export interface Stroke { points: readonly Pt[]; t0?: number; t1?: number }
export interface TimedStroke {
  points: readonly Pt[];
  t0: number;
  t1: number;
  /** Arc length at each point, and the whole. */
  cum: Float64Array;
  len: number;
  /** Time fraction 0–1 → distance fraction 0–1, and back. */
  ease: (u: number) => number;
  inv: (p: number) => number;
}

export interface StrokeTiming {
  start?: number;
  speed?: number | ((i: number) => number);
  lift?: number;
  liftMin?: number;
  ease?: (u: number) => number;
}

function inverse(f: (u: number) => number): (p: number) => number {
  const N = 512, tab = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) tab[i] = Math.min(1, Math.max(0, f(i / N)));
  return (p) => {
    if (p <= tab[0]!) return 0;
    if (p >= tab[N]!) return 1;
    let lo = 0, hi = N;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tab[m]! <= p) lo = m; else hi = m; }
    const a = tab[lo]!, b = tab[hi]!;
    return (lo + (b > a ? (p - a) / (b - a) : 0)) / N;
  };
}

/** Times for a list of strokes: duration from length and speed, pen-up gaps from distance (see the notes at the top). */
export function timeStrokes(strokes: readonly (readonly Pt[] | Stroke)[], o: StrokeTiming = {}): TimedStroke[] {
  const speed = o.speed ?? 700, lift = o.lift ?? 2000, liftMin = o.liftMin ?? 0.06;
  const ease = o.ease ?? ((u: number) => u), inv = o.ease ? inverse(ease) : (p: number) => p;
  const out: TimedStroke[] = [];
  strokes.forEach((s, i) => {
    const st: Stroke = Array.isArray(s) ? { points: s as readonly Pt[] } : (s as Stroke);
    const pts = st.points;
    const cum = new Float64Array(Math.max(1, pts.length));
    for (let k = 1; k < pts.length; k++) cum[k] = cum[k - 1]! + Math.hypot(pts[k]![0] - pts[k - 1]![0], pts[k]![1] - pts[k - 1]![1]);
    const len = cum[cum.length - 1]!;
    const prev = out[i - 1];
    const gap = prev && pts.length ? Math.max(liftMin, Math.hypot(pts[0]![0] - prev.points[prev.points.length - 1]![0], pts[0]![1] - prev.points[prev.points.length - 1]![1]) / lift) : 0;
    const t0 = st.t0 ?? (prev ? prev.t1 + gap : o.start ?? 0);
    const v = typeof speed === 'function' ? speed(i) : speed;
    const t1 = st.t1 ?? t0 + Math.max(1e-3, len / Math.max(1e-6, v));
    out.push({ points: pts, t0, t1, cum, len, ease, inv });
  });
  return out;
}

function pointAlong(s: TimedStroke, d: number): [number, number] {
  const p = s.points, c = s.cum;
  if (p.length === 1 || d <= 0) return [p[0]![0], p[0]![1]];
  if (d >= s.len) return [p[p.length - 1]![0], p[p.length - 1]![1]];
  let lo = 0, hi = p.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m]! <= d) lo = m; else hi = m; }
  const k = c[hi]! > c[lo]! ? (d - c[lo]!) / (c[hi]! - c[lo]!) : 0;
  return [p[lo]![0] + (p[hi]![0] - p[lo]![0]) * k, p[lo]![1] + (p[hi]![1] - p[lo]![1]) * k];
}

export interface Pen { x: number; y: number; down: boolean; height: number; stroke: number }

/** Where the pen tip is at time t, on the same clock as arrivalStrokes (see the notes at the top). */
export function penAt(strokes: readonly TimedStroke[], t: number, o: { lift?: number; land?: number } = {}): Pen {
  const lift = o.lift ?? 24, land = o.land ?? 0.12;
  if (!strokes.length) return { x: 0, y: 0, down: false, height: lift, stroke: -1 };
  const first = strokes[0]!, last = strokes[strokes.length - 1]!;
  if (t < first.t0) { const [x, y] = pointAlong(first, 0); return { x, y, down: false, height: lift * Math.min(1, (first.t0 - t) / land), stroke: -1 }; }
  for (let i = 0; i < strokes.length; i++) {
    const s = strokes[i]!;
    if (t <= s.t1) {
      if (t >= s.t0) { const [x, y] = pointAlong(s, s.len * s.ease((t - s.t0) / Math.max(1e-6, s.t1 - s.t0))); return { x, y, down: true, height: 0, stroke: i }; }
      // in the air between the previous stroke and this one: straight over, eased, along an arc
      const p = strokes[i - 1]!, a = pointAlong(p, p.len), b = pointAlong(s, 0);
      const u = Math.min(1, Math.max(0, (t - p.t1) / Math.max(1e-6, s.t0 - p.t1))), e = u * u * (3 - 2 * u);
      return { x: a[0] + (b[0] - a[0]) * e, y: a[1] + (b[1] - a[1]) * e, down: false, height: lift * Math.sin(Math.PI * u), stroke: -1 };
    }
  }
  const [x, y] = pointAlong(last, last.len);
  return { x, y, down: false, height: lift * Math.min(1, (t - last.t1) / land), stroke: -1 };
}

/** Arrival along timed strokes: each ink pixel goes to the nearest stroke (earlier strokes keep crossings). */
export function arrivalStrokes(w: number, h: number, strokes: readonly TimedStroke[], o: { radius?: number; ink?: MaskSrc; cross?: number } = {}): ArrivalMap {
  const R = o.radius ?? 12, cross = o.cross ?? R / 2;
  const map = new ArrivalMap(w, h), out = map.data;
  const best = new Float32Array(w * h).fill(Infinity), owner = new Int32Array(w * h).fill(-1);
  strokes.forEach((s, k) => {
    const p = s.points, dur = s.t1 - s.t0;
    const visit = (ax: number, ay: number, bx: number, by: number, c0: number) => {
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - R)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + R));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by) - R)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + R));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5 - ax, py = y + 0.5 - ay;
        const u = L2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / L2)) : 0;
        const d = Math.hypot(px - u * dx, py - u * dy);
        if (d > R) continue;
        const i = y * w + x, own = owner[i]!;
        if (own === -1 || (own === k ? d < best[i]! : d < best[i]! - cross)) {
          best[i] = d; owner[i] = k;
          out[i] = s.t0 + dur * s.inv(s.len > 0 ? (c0 + u * L) / s.len : 1);
        }
      }
    };
    if (p.length === 1) visit(p[0]![0], p[0]![1], p[0]![0], p[0]![1], 0);
    for (let j = 0; j + 1 < p.length; j++) visit(p[j]![0], p[j]![1], p[j + 1]![0], p[j + 1]![1], s.cum[j]!);
  });
  if (o.ink) map.clip(o.ink);
  return map.update();
}

// ---- distances ----------------------------------------------------------------------------------------------------------

const INF = 1e20;
/** 1D squared distance transform (Felzenszwalb–Huttenlocher) with a weight on the axis: min_p f[p] + wt·(q − p)². */
function dt1(f: Float64Array, n: number, wt: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    if (f[q]! >= INF) continue;
    if (f[v[k]!]! >= INF) { v[k] = q; continue; }
    let s: number;
    for (;;) {
      const p = v[k]!;
      s = (f[q]! + wt * q * q - (f[p]! + wt * p * p)) / (2 * wt * (q - p));
      if (s <= z[k]! && k > 0) k--; else break;
    }
    if (s <= z[k]!) { v[k] = q; z[k + 1] = Infinity; continue; }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const p = v[k]!;
    d[q] = f[p]! >= INF ? INF : f[p]! + wt * (q - p) * (q - p);
  }
}

/** Exact euclidean distance (px) to the nearest seed, axes weighted 1/sx², 1/sy² (elliptical fronts). */
function edt(w: number, h: number, seed: Uint8Array, sx = 1, sy = 1): Float64Array {
  const g = new Float64Array(w * h), n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const wy = 1 / (sy * sy), wx = 1 / (sx * sx);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = seed[y * w + x] ? 0 : INF;
    dt1(f, h, wy, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y]!;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x]!;
    dt1(f, w, wx, d, v, z);
    for (let x = 0; x < w; x++) g[y * w + x] = Math.sqrt(d[x]!);
  }
  return g;
}

/**
 * Distances along the inside of `allowed` from the seeds (chamfer 5/7 steps, Dial's buckets), into `dist` (chamfer units:
 * divide by 5 for px). Only pixels reachable from a seed are written; returns the pixels visited and the farthest one.
 */
function geodesic(w: number, h: number, allowed: Uint8Array, seeds: readonly number[], dist: Int32Array): { seen: number[]; far: number } {
  const B = 8, buckets: number[][] = Array.from({ length: B }, () => []);
  const seen: number[] = [];
  let pending = 0, far = seeds[0] ?? -1, farD = -1;
  for (const s of seeds) if (allowed[s] && dist[s] !== 0) { dist[s] = 0; buckets[0]!.push(s); pending++; seen.push(s); }
  for (let cur = 0; pending > 0; cur++) {
    const q = buckets[cur % B]!;
    while (q.length) {
      const i = q.pop()!; pending--;
      if (dist[i] !== cur) continue;
      if (cur > farD) { farD = cur; far = i; }
      const x = i % w, y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!allowed[j]) continue;
        const nd = cur + (dx && dy ? 7 : 5);
        if (nd < dist[j]!) { if (dist[j] === 0x7fffffff) seen.push(j); dist[j] = nd; buckets[nd % B]!.push(j); pending++; }
      }
    }
  }
  return { seen, far };
}

const isPts = (x: unknown): x is readonly Pt[] => Array.isArray(x) && x.length > 0 && Array.isArray(x[0]);
const isPt = (x: unknown): x is Pt => Array.isArray(x) && x.length === 2 && typeof x[0] === 'number';

/** Arrival spreading out from points or a region (see the notes at the top). */
export function arrivalDistance(w: number, h: number, from: Pt | readonly Pt[] | MaskSrc, o: { speed?: number; duration?: number; start?: number; squash?: readonly [number, number]; within?: MaskSrc } = {}): ArrivalMap {
  const map = new ArrivalMap(w, h), out = map.data;
  const [sx, sy] = o.squash ?? [1, 1];
  const pts = isPt(from) ? [from] : isPts(from) ? from : null;
  let dist: Float64Array;
  if (o.within) {
    const allowed = readMask(w, h, o.within), seeds: number[] = [];
    if (pts) for (const [x, y] of pts) { const ix = Math.floor(x), iy = Math.floor(y); if (ix >= 0 && iy >= 0 && ix < w && iy < h) seeds.push(iy * w + ix); }
    else { const m = readMask(w, h, from as MaskSrc); for (let i = 0; i < m.length; i++) if (m[i]) seeds.push(i); }
    const d = new Int32Array(w * h).fill(0x7fffffff);
    geodesic(w, h, allowed, seeds, d);
    dist = new Float64Array(w * h);
    for (let i = 0; i < d.length; i++) dist[i] = d[i] === 0x7fffffff ? Infinity : d[i]! / 5;
  } else if (pts) {
    dist = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let m = Infinity;
      for (const [px, py] of pts) m = Math.min(m, Math.hypot((x + 0.5 - px) / sx, (y + 0.5 - py) / sy));
      dist[y * w + x] = m;
    }
  } else {
    dist = edt(w, h, readMask(w, h, from as MaskSrc), sx, sy);
    for (let i = 0; i < dist.length; i++) if (dist[i]! >= 1e9) dist[i] = Infinity;
  }
  let far = 0;
  for (const v of dist) if (v !== Infinity && v > far) far = v;
  const speed = o.duration ? Math.max(1e-6, far) / o.duration : o.speed ?? 1000, t0 = o.start ?? 0;
  for (let i = 0; i < out.length; i++) out[i] = dist[i] === Infinity ? Infinity : t0 + dist[i]! / speed;
  return map.update();
}

export type TraceOrder = 'left' | 'right' | 'top' | 'bottom' | 'big' | 'together';

/** Line art drawn along its lines, one connected piece after another (see the notes at the top). */
export function arrivalTrace(w: number, h: number, ink: MaskSrc, o: { speed?: number; gap?: number; start?: number; order?: TraceOrder; from?: readonly Pt[]; speck?: number } = {}): ArrivalMap {
  const m = readMask(w, h, ink), N = w * h;
  const speed = o.speed ?? 600, gap = o.gap ?? 0.06, order = o.order ?? 'left', speck = o.speck ?? 20;
  // connected pieces (8-neighbour)
  const comp = new Int32Array(N).fill(-1), pieces: number[][] = [];
  for (let i = 0; i < N; i++) {
    if (!m[i] || comp[i] !== -1) continue;
    const id = pieces.length, px: number[] = [i];
    comp[i] = id;
    for (let k = 0; k < px.length; k++) {
      const j = px[k]!, x = j % w, y = (j - x) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (m[q] && comp[q] === -1) { comp[q] = id; px.push(q); }
      }
    }
    pieces.push(px);
  }
  const dist = new Int32Array(N).fill(0x7fffffff);
  const reset = (seen: number[]) => { for (const j of seen) dist[j] = 0x7fffffff; };
  const key = (i: number) => {
    const x = i % w, y = (i - x) / w;
    return order === 'right' ? -x : order === 'top' ? y : order === 'bottom' ? -y : x;
  };
  // each big piece: where it starts (an end of its longest path, or the point nearest o.from) and how long it takes
  interface Run { id: number; start: number; k: number; size: number; t0: number; dur: number }
  const runs: Run[] = [];
  pieces.forEach((px, id) => {
    if (px.length < speck) return;
    let start: number;
    if (o.from?.length) {
      let bd = Infinity; start = px[0]!;
      for (const j of px) { const x = j % w + 0.5, y = (j - (j % w)) / w + 0.5; for (const [fx, fy] of o.from) { const d = (x - fx) ** 2 + (y - fy) ** 2; if (d < bd) { bd = d; start = j; } } }
    } else {
      let e = px[0]!;
      for (const j of px) if (key(j) < key(e)) e = j;
      const a = geodesic(w, h, m, [e], dist); reset(a.seen);
      const b = geodesic(w, h, m, [a.far], dist); reset(b.seen);
      start = key(a.far) <= key(b.far) ? a.far : b.far;
    }
    runs.push({ id, start, k: order === 'big' ? -px.length : key(start), size: px.length, t0: 0, dur: 0 });
  });
  runs.sort((a, b) => a.k - b.k);
  const map = new ArrivalMap(w, h), out = map.data;
  let cur = o.start ?? 0;
  for (const r of runs) {
    const g = geodesic(w, h, m, [r.start], dist);
    const t0 = order === 'together' ? o.start ?? 0 : cur;
    let far = 0;
    for (const j of g.seen) { const d = dist[j]! / 5; out[j] = t0 + d / speed; if (d > far) far = d; }
    reset(g.seen);
    r.t0 = t0; r.dur = far / speed;
    cur = t0 + r.dur + gap;
  }
  // specks: when the nearest traced piece is done (by bounding-box centre)
  if (runs.length) {
    const centre = (px: number[]) => { let sx = 0, sy = 0; for (const j of px) { sx += j % w; sy += (j - (j % w)) / w; } return [sx / px.length, sy / px.length]; };
    const rc = runs.map((r) => centre(pieces[r.id]!));
    pieces.forEach((px) => {
      if (px.length >= speck) return;
      const [cx, cy] = centre(px);
      let bi = 0, bd = Infinity;
      rc.forEach(([x, y], i) => { const d = (x! - cx!) ** 2 + (y! - cy!) ** 2; if (d < bd) { bd = d; bi = i; } });
      const t = runs[bi]!.t0 + runs[bi]!.dur;
      for (const j of px) out[j] = t;
    });
  }
  return map.update();
}

/** Arrival from a function of the pixel centre. */
export function arrivalFrom(w: number, h: number, fn: (x: number, y: number) => number): ArrivalMap {
  const map = new ArrivalMap(w, h), out = map.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = fn(x + 0.5, y + 0.5);
  return map.update();
}

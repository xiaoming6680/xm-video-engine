// 形状变形和路径动画（Canvas2D）。形状 = 若干条闭合轮廓（V2[]），字、圆、方块、SVG 素材都先变成这个格式。
//
//   变形：  morphShapes(A, B, u)  —— 一个点胀成圆、圆变成字母、字母变成色块。轮廓按弧长重采样、对齐起点和方向，
//           条数不一样时多出来的缩成一个点长出来 / 收回去
//   路径：  new PathWalk(pts)  —— 沿路径走（位置 + 切线角）、只画一段（修剪路径 trim）、按长度写出来
//   飘带：  ribbon(pts, w0, w1) —— 变宽度的描边多边形（围巾、拖尾、马克笔起收笔）
//   字形：  textShape(text, family, size)  —— 字的轮廓（type.ts 的 opentype 命令拍平）
//   SVG：   在 svg.ts（Illustrator 导出的素材读成同样的形状）
//
// 后半两件，参考 mg-styles-15（Vincentwei1021，MIT）demos/08-morph、02-line-art 的做法重写：
//   部件变形：parts() 把图标切成固定槽位（主体 240 点、洞 72 点、描边 8 条 × 24 点带线宽、阴影 60 点），没有的槽缩成一个
//           有意义的点（射线从太阳中心长出来）；SlotMorph 走 A → 圆 → B 两段，两边各自对齐到同一个圆，所以再不像的
//           两个形状也不会自交；描边错峰出发、被推到圆外；travel() 让它沿弧线走、沿速度方向保面积拉伸；
//           drawParts() 换色是形状内部的方向扫（新颜色从前进方向的前缘扫进来）。太快的点用 smearDisc 画解析拖影。
//           为什么：按面积配对 + 线性插值（Morph）在形状差得远时会翻折、打结，中间帧不成形
//   一笔画：OneLine —— 整片一条线。沿法线两档值噪声抖（植物抖、建筑直、logo 不抖），拐角处笔慢下来，
//           用 [时间, 标记] 卡点（单调样条，重复同一标记 = 停顿），刚画出的线最亮、1.5 s 内暗到 0.4。
//           为什么：PathWalk 匀速走，拐角和直线一样快，看起来是机器描的
import { clamp, lerp, TAU, type V2, polylineLengths, pointAtLength, smoothstep, noise1 } from '../../engine/util';
import { textPathCommands } from '../../engine/type';
import { E, bezier, monotone } from './anim';

export type Contour = V2[];
export type Shape = Contour[];

// ---------- path commands → polylines ----------

export type Cmd =
  | { type: 'M' | 'L'; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Z' };

/** Flatten absolute path commands (opentype.js / svg.ts) into contours; curves split by length (`tol` px per step). */
export function flatten(cmds: readonly Cmd[], tol = 4): Shape {
  const out: Shape = [];
  let cur: Contour = [];
  let px = 0, py = 0;
  const push = () => { if (cur.length > 1) out.push(cur); cur = []; };
  for (const c of cmds) {
    if (c.type === 'M') { push(); cur.push({ x: c.x, y: c.y }); px = c.x; py = c.y; }
    else if (c.type === 'L') { cur.push({ x: c.x, y: c.y }); px = c.x; py = c.y; }
    else if (c.type === 'Q') {
      const n = Math.max(2, Math.ceil((Math.hypot(c.x1 - px, c.y1 - py) + Math.hypot(c.x - c.x1, c.y - c.y1)) / tol));
      for (let i = 1; i <= n; i++) {
        const u = i / n, v = 1 - u;
        cur.push({ x: v * v * px + 2 * v * u * c.x1 + u * u * c.x, y: v * v * py + 2 * v * u * c.y1 + u * u * c.y });
      }
      px = c.x; py = c.y;
    } else if (c.type === 'C') {
      const L = Math.hypot(c.x1 - px, c.y1 - py) + Math.hypot(c.x2 - c.x1, c.y2 - c.y1) + Math.hypot(c.x - c.x2, c.y - c.y2);
      const n = Math.max(2, Math.ceil(L / tol));
      for (let i = 1; i <= n; i++) {
        const u = i / n, v = 1 - u;
        cur.push({
          x: v * v * v * px + 3 * v * v * u * c.x1 + 3 * v * u * u * c.x2 + u * u * u * c.x,
          y: v * v * v * py + 3 * v * v * u * c.y1 + 3 * v * u * u * c.y2 + u * u * u * c.y,
        });
      }
      px = c.x; py = c.y;
    } else if (c.type === 'Z') {
      push();
    }
  }
  push();
  // drop a closing duplicate of the first point
  for (const k of out) if (k.length > 2 && Math.hypot(k[0]!.x - k[k.length - 1]!.x, k[0]!.y - k[k.length - 1]!.y) < 0.01) k.pop();
  return out;
}

/** Outline of a string as contours, left/baseline at (x, y). */
export function textShape(text: string, family: string, size: number, x = 0, y = 0, tracking = 0, tol = 3): Shape {
  return flatten(textPathCommands(text, family, size, x, y, tracking) as Cmd[], tol);
}

// ---------- primitives ----------

export const circle = (cx: number, cy: number, r: number, n = 96): Contour =>
  Array.from({ length: n }, (_, i) => ({ x: cx + Math.cos(-Math.PI / 2 + (i * TAU) / n) * r, y: cy + Math.sin(-Math.PI / 2 + (i * TAU) / n) * r }));
export const rect = (x: number, y: number, w: number, h: number): Contour =>
  [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
export function star(cx: number, cy: number, r0: number, r1: number, points = 5): Contour {
  return Array.from({ length: points * 2 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / points, r = i % 2 ? r0 : r1;
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
  });
}

// ---------- measuring ----------

export function area(k: Contour): number {
  let a = 0;
  for (let i = 0; i < k.length; i++) { const p = k[i]!, q = k[(i + 1) % k.length]!; a += p.x * q.y - q.x * p.y; }
  return a / 2;
}
export function centroid(k: Contour): V2 {
  let x = 0, y = 0;
  for (const p of k) { x += p.x; y += p.y; }
  return { x: x / k.length, y: y / k.length };
}
export function bounds(s: Shape | Contour) {
  const pts = (Array.isArray(s[0]) ? (s as Shape).flat() : (s as Contour));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}
export const mapShape = (s: Shape, f: (p: V2) => V2): Shape => s.map((k) => k.map(f));
export const moveShape = (s: Shape, dx: number, dy: number, k = 1): Shape => mapShape(s, (p) => ({ x: p.x * k + dx, y: p.y * k + dy }));
/** Scale/place a shape so its bounding box is centred at (cx, cy) with height h. */
export function fitShape(s: Shape, cx: number, cy: number, h: number): Shape {
  const b = bounds(s), k = h / b.h;
  return mapShape(s, (p) => ({ x: cx + (p.x - b.cx) * k, y: cy + (p.y - b.cy) * k }));
}

// ---------- morphing ----------

/** n points evenly spaced by arc length along a closed contour (or an open polyline when closed = false). */
export function resample(k: Contour, n: number, closed = true): Contour {
  const pts = closed ? [...k, k[0]!] : k;
  const L = polylineLengths(pts), total = L[L.length - 1]!;
  const out: Contour = [];
  for (let i = 0; i < n; i++) {
    const p = pointAtLength(pts, L, closed ? (i / n) * total : (i / (n - 1)) * total);
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

/** Rotate / reverse `b` (same length as `a`) to start where it best lines up with `a` (least travel). */
export function align(a: Contour, b: Contour): Contour {
  const n = a.length;
  if (Math.sign(area(a)) !== Math.sign(area(b))) b = [...b].reverse();
  let best = 0, bestD = Infinity;
  const step = Math.max(1, Math.floor(n / 64));
  for (let s = 0; s < n; s += step) {
    let d = 0;
    for (let i = 0; i < n; i += step) { const p = a[i]!, q = b[(i + s) % n]!; d += (p.x - q.x) ** 2 + (p.y - q.y) ** 2; }
    if (d < bestD) { bestD = d; best = s; }
  }
  return b.map((_, i) => b[(i + best) % n]!);
}

export function morphContour(a: Contour, b: Contour, u: number): Contour {
  return a.map((p, i) => ({ x: lerp(p.x, b[i]!.x, u), y: lerp(p.y, b[i]!.y, u) }));
}

/**
 * Prepared morph between two shapes: contours paired largest-to-largest (by area), resampled to `n` points,
 * aligned. A contour with no partner grows from / shrinks to a point at its own centre.
 */
export class Morph {
  pairs: [Contour, Contour][] = [];
  constructor(A: Shape, B: Shape, n = 160) {
    const byArea = (s: Shape) => [...s].sort((x, y) => Math.abs(area(y)) - Math.abs(area(x)));
    const a = byArea(A), b = byArea(B);
    const m = Math.max(a.length, b.length);
    for (let i = 0; i < m; i++) {
      const ka = a[i], kb = b[i];
      const ra = ka ? resample(ka, n) : null, rb = kb ? resample(kb, n) : null;
      const pa = ra ?? rb!.map(() => centroid(rb!));
      const pb = rb ?? ra!.map(() => centroid(ra!));
      this.pairs.push([pa, ra && rb ? align(pa, pb) : pb]);
    }
  }
  at(u: number): Shape {
    return this.pairs.map(([a, b]) => morphContour(a, b, clamp(u)));
  }
}
/** One-off morph (prepare a Morph in init() when it runs every frame). */
export const morphShapes = (A: Shape, B: Shape, u: number, n = 160) => new Morph(A, B, n).at(u);

// ---------- drawing ----------

/** Fill a shape (even-odd: holes in letters stay holes). */
export function fillShape(c: CanvasRenderingContext2D, s: Shape, color?: string) {
  c.beginPath();
  for (const k of s) {
    if (!k.length) continue;
    c.moveTo(k[0]!.x, k[0]!.y);
    for (let i = 1; i < k.length; i++) c.lineTo(k[i]!.x, k[i]!.y);
    c.closePath();
  }
  if (color) c.fillStyle = color;
  c.fill('evenodd');
}
export function strokeShape(c: CanvasRenderingContext2D, s: Shape, color?: string, width?: number) {
  c.beginPath();
  for (const k of s) {
    if (!k.length) continue;
    c.moveTo(k[0]!.x, k[0]!.y);
    for (let i = 1; i < k.length; i++) c.lineTo(k[i]!.x, k[i]!.y);
    c.closePath();
  }
  if (color) c.strokeStyle = color;
  if (width) c.lineWidth = width;
  c.stroke();
}

// ---------- path animation ----------

/**
 * A walkable path (one or more open polylines laid end to end, e.g. a handwritten word's strokes).
 * Lengths are along the whole path; jumps between strokes cost nothing (the pen lifts).
 */
export class PathWalk {
  strokes: V2[][];
  lens: Float32Array[];
  starts: number[] = [];
  total = 0;
  constructor(strokes: V2[][] | V2[]) {
    this.strokes = (Array.isArray((strokes as V2[][])[0]) ? strokes : [strokes]) as V2[][];
    this.lens = this.strokes.map((s) => polylineLengths(s));
    for (const L of this.lens) { this.starts.push(this.total); this.total += L[L.length - 1] ?? 0; }
  }
  /** Position and tangent angle at arc length s along the whole path. */
  at(s: number): { x: number; y: number; angle: number; stroke: number } {
    s = clamp(s, 0, this.total);
    let i = this.strokes.length - 1;
    while (i > 0 && this.starts[i]! > s) i--;
    const p = pointAtLength(this.strokes[i]!, this.lens[i]!, s - this.starts[i]!);
    return { ...p, stroke: i };
  }
  /** The part of the path between lengths s0 and s1 (trim paths), as polylines. */
  slice(s0: number, s1: number): V2[][] {
    const out: V2[][] = [];
    s0 = clamp(s0, 0, this.total); s1 = clamp(s1, 0, this.total);
    if (s1 <= s0) return out;
    this.strokes.forEach((pts, i) => {
      const a = this.starts[i]!, L = this.lens[i]!, len = L[L.length - 1] ?? 0;
      const lo = Math.max(s0, a) - a, hi = Math.min(s1, a + len) - a;
      if (hi <= lo) return;
      const seg: V2[] = [pointAtLength(pts, L, lo)];
      for (let j = 0; j < pts.length; j++) if (L[j]! > lo && L[j]! < hi) seg.push(pts[j]!);
      seg.push(pointAtLength(pts, L, hi));
      out.push(seg.map((p) => ({ x: p.x, y: p.y })));
    });
    return out;
  }
  /** Stroke the part between s0 and s1 with the context's current stroke style. */
  draw(c: CanvasRenderingContext2D, s0: number, s1: number) {
    c.beginPath();
    for (const seg of this.slice(s0, s1)) {
      c.moveTo(seg[0]!.x, seg[0]!.y);
      for (let j = 1; j < seg.length; j++) c.lineTo(seg[j]!.x, seg[j]!.y);
    }
    c.stroke();
  }
}

/** A smooth curve through points (Catmull-Rom), sampled `per` points per span: hand-placed motion paths. */
export function smoothPath(pts: readonly V2[], per = 16, closed = false): V2[] {
  const out: V2[] = [];
  const n = pts.length;
  const P = (i: number) => (closed ? pts[((i % n) + n) % n]! : pts[clamp(i, 0, n - 1)]!);
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let k = 0; k < per; k++) {
      const u = k / per, u2 = u * u, u3 = u2 * u;
      out.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * u + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * u2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * u3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * u + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * u2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * u3),
      });
    }
  }
  if (!closed) out.push(pts[n - 1]!);
  return out;
}

/**
 * A variable-width stroke as a filled polygon: width goes from w0 at the first point to w1 at the last
 * (or follows `wf(u)`), round-ish caps. Scarves, motion trails, marker strokes that start fat and taper.
 */
export function ribbon(pts: readonly V2[], w0: number, w1 = w0, wf?: (u: number) => number): Contour {
  const n = pts.length;
  if (n < 2) return [];
  const L = polylineLengths(pts as V2[]), total = L[n - 1]! || 1;
  const left: V2[] = [], right: V2[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(n - 1, i + 1)]!;
    let tx = b.x - a.x, ty = b.y - a.y;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    const u = L[i]! / total, w = (wf ? wf(u) : lerp(w0, w1, u)) / 2;
    left.push({ x: pts[i]!.x - ty * w, y: pts[i]!.y + tx * w });
    right.push({ x: pts[i]!.x + ty * w, y: pts[i]!.y - tx * w });
  }
  return [...left, ...right.reverse()];
}

/** Draw a polyline (open). */
export function strokePoly(c: CanvasRenderingContext2D, pts: readonly V2[]) {
  if (pts.length < 2) return;
  c.beginPath();
  c.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i]!.x, pts[i]!.y);
  c.stroke();
}

// ---------- part-slot morph: icon → circle → icon (mg-styles-15 demos/08-morph, MIT) ----------

/** Slot sizes of a Parts icon: body / hole / shade points, stroke count and points per stroke. */
export const SLOTS = { body: 240, hole: 72, strokes: 8, stroke: 24, shade: 60 } as const;

/** An open stroke: centreline and line width (local px). w = 0: an empty slot parked at a point. */
export interface Line { pts: V2[]; w: number }

/** An icon cut into fixed slots, so any two icons morph part to part. Local coordinates, origin = the icon's centre. */
export interface Parts {
  body: Contour;
  hole: Contour;
  holeOn: boolean;
  strokes: Line[];
  shade: Contour;
  shadeOn: boolean;
}

export interface PartsSpec {
  body: Contour;
  /** A hole (a ring's counter, a pin's eye), or the point an absent one grows from. */
  hole?: Contour | V2;
  /** Up to 8 strokes; a point (or nothing) parks that slot there (rays grow out of a sun's centre, steam out of a cup). */
  strokes?: readonly (Line | V2 | null | undefined)[];
  /** A facet painted inside the body (a fold, a shadow side), or the point an absent one grows from. */
  shade?: Contour | V2;
  /** Where unspecified empty slots park (default: the body's centroid). */
  anchor?: V2;
}

const orient = (k: Contour): Contour => (area(k) < 0 ? [...k].reverse() : k);
const rep = (p: V2, n: number): Contour => Array.from({ length: n }, () => ({ x: p.x, y: p.y }));
const isPt = (x: unknown): x is V2 => !!x && !Array.isArray(x) && typeof (x as V2).x === 'number';
const lerpC = (a: Contour, b: Contour, u: number): Contour => a.map((p, i) => ({ x: lerp(p.x, b[i]!.x, u), y: lerp(p.y, b[i]!.y, u) }));
const shiftC = (k: Contour, s: number): Contour => k.map((_, i) => k[(i + s) % k.length]!);
const eio = bezier(0.45, 0, 0.55, 1);

/** Cut an icon into the fixed slots (resampled by arc length, all contours turning the same way). */
export function parts(s: PartsSpec): Parts {
  const body = orient(resample(s.body, SLOTS.body));
  const anchor = s.anchor ?? centroid(body);
  const hole = s.hole && !isPt(s.hole) ? orient(resample(s.hole, SLOTS.hole)) : rep(isPt(s.hole) ? s.hole : anchor, SLOTS.hole);
  const shade = s.shade && !isPt(s.shade) ? orient(resample(s.shade, SLOTS.shade)) : rep(isPt(s.shade) ? s.shade : anchor, SLOTS.shade);
  const strokes: Line[] = [];
  for (let k = 0; k < SLOTS.strokes; k++) {
    const x = s.strokes?.[k];
    if (x && !isPt(x) && x.pts.length > 1) strokes.push({ pts: resample(x.pts, SLOTS.stroke, false), w: x.w });
    else strokes.push({ pts: rep(isPt(x) ? x : anchor, SLOTS.stroke), w: 0 });
  }
  return { body, hole, holeOn: !!s.hole && !isPt(s.hole), strokes, shade, shadeOn: !!s.shade && !isPt(s.shade) };
}

/** Index shift of b (same length as a, same turning) that lines it up with a (least squared travel). */
export function bestShift(a: Contour, b: Contour): number {
  const n = a.length;
  let best = Infinity, bs = 0;
  for (let s = 0; s < n; s++) {
    let e = 0;
    for (let i = 0; i < n; i += 2) {
      const q = b[(i + s) % n]!, dx = a[i]!.x - q.x, dy = a[i]!.y - q.y;
      e += dx * dx + dy * dy;
      if (e >= best) break;
    }
    if (e < best) { best = e; bs = s; }
  }
  return bs;
}

export interface SlotMorphOpts {
  /** The circle both bodies pass through at u = 0.5 (local px). null: straight A → B (only for similar shapes).
   *  Default: centred between the two centroids, with the mean of their areas. */
  via?: { x: number; y: number; r: number } | null;
  /** Time curve (default E.morph = bez(.7, 0, .3, 1)). */
  ease?: (u: number) => number;
  /** The order strokes set off in (slot indices, default 0..7), each `lag` (fraction of the morph) after the last. */
  order?: readonly number[];
  lag?: number;
  /** Gap (px) the strokes keep outside the via circle as they pass it. */
  clear?: number;
}

/**
 * Morph between two Parts icons through a circle: the body goes A → circle by u = 0.5 and circle → B after, each half
 * aligned to the same circle on its own (no self-intersections however different A and B are); holes and the shade facet
 * shrink to their centre and regrow; strokes set off staggered, are pushed outside the circle on the way, and a stroke with
 * no partner shrinks and fades before the circle. at(u) takes LINEAR time u 0..1 (the ease is applied inside); pass live
 * (animated) states of A and B with the same slots to morph between moving icons.
 */
export class SlotMorph {
  readonly via: { x: number; y: number; r: number } | null;
  readonly ease: (u: number) => number;
  private Ca: Contour | null = null;
  private Cb: Contour | null = null;
  private sAB = 0;
  private sHole = 0;
  private order: readonly number[];
  private lag: number;
  private clear: number;
  constructor(readonly A: Parts, readonly B: Parts, o: SlotMorphOpts = {}) {
    this.ease = o.ease ?? E.morph;
    this.order = o.order ?? Array.from({ length: SLOTS.strokes }, (_, i) => i);
    this.lag = o.lag ?? 0.03;
    this.clear = o.clear ?? 18;
    if (o.via === null) this.via = null;
    else if (o.via) this.via = o.via;
    else {
      const ca = centroid(A.body), cb = centroid(B.body);
      this.via = { x: (ca.x + cb.x) / 2, y: (ca.y + cb.y) / 2, r: Math.sqrt((Math.abs(area(A.body)) + Math.abs(area(B.body))) / 2 / Math.PI) };
    }
    if (this.via) {
      const c = orient(circle(this.via.x, this.via.y, this.via.r, SLOTS.body));
      this.Ca = shiftC(c, bestShift(A.body, c));
      this.Cb = shiftC(c, bestShift(B.body, c));
    } else this.sAB = bestShift(A.body, B.body);
    this.sHole = bestShift(A.hole, B.hole);
  }

  at(u: number, A: Parts = this.A, B: Parts = this.B): Parts {
    const uu = clamp(u), E0 = this.ease, gA = E0(clamp(uu / 0.5)), gB = E0(clamp((uu - 0.5) / 0.5)), g = E0(uu);
    const via = this.via;
    const body = via ? (uu < 0.5 ? lerpC(A.body, this.Ca!, gA) : lerpC(this.Cb!, B.body, gB)) : lerpC(A.body, shiftC(B.body, this.sAB), g);
    let hole: Contour, holeOn: boolean;
    if (A.holeOn && B.holeOn && !via) { hole = lerpC(A.hole, shiftC(B.hole, this.sHole), g); holeOn = true; }
    else if (uu < 0.5) { hole = lerpC(A.hole, rep(centroid(A.hole), SLOTS.hole), clamp(gA / 0.6)); holeOn = A.holeOn; }
    else { hole = lerpC(rep(centroid(B.hole), SLOTS.hole), B.hole, clamp((gB - 0.4) / 0.6)); holeOn = B.holeOn; }
    const strokes = A.strokes.map((sa, k) => {
      const sb = B.strokes[k]!, off = Math.max(0, this.order.indexOf(k)) * this.lag;
      const gk = eio(clamp((uu - 0.06 - off) / 0.7));
      const dies = sb.w === 0 && sa.w > 0, wk = dies ? 1 - smoothstep(0.2, 0.48, uu) : 1;
      let pts: Contour;
      if (dies) {
        const md = sa.pts[SLOTS.stroke >> 1]!, f = 1 - 0.7 * smoothstep(0.05, 0.48, uu);
        pts = sa.pts.map((p) => ({ x: lerp(md.x, p.x, f), y: lerp(md.y, p.y, f) }));
      } else pts = lerpC(sa.pts, sb.pts, gk);
      if (via && !dies) {
        const s = Math.sin(Math.PI * uu), Rm = (via.r + lerp(sa.w, sb.w, gk) / 2 + this.clear) * Math.min(1, 1.6 * s);
        const mid = pts[SLOTS.stroke >> 1]!, sh = 1 - 0.55 * s;
        pts = pts.map((p) => {
          const q = { x: lerp(mid.x, p.x, sh), y: lerp(mid.y, p.y, sh) }, dx = q.x - via.x, dy = q.y - via.y, d = Math.hypot(dx, dy) || 1;
          return d < Rm ? { x: via.x + (dx / d) * Rm, y: via.y + (dy / d) * Rm } : q;
        });
      }
      return { pts, w: lerp(sa.w, sb.w, gk) * wk };
    });
    const shade = uu < 0.5 ? lerpC(A.shade, rep(centroid(A.shade), SLOTS.shade), clamp(gA / 0.5)) : lerpC(rep(centroid(B.shade), SLOTS.shade), B.shade, clamp((gB - 0.5) / 0.5));
    return { body, hole, holeOn, strokes, shade, shadeOn: uu < 0.5 ? A.shadeOn : B.shadeOn };
  }
}

/** 2D affine in canvas order [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (c.setTransform(...m)). */
export type Mat2D = [number, number, number, number, number, number];
export const mapPt = (m: Mat2D, p: V2): V2 => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

/** Where and how an icon sits: position, rotation, scale, an area-keeping stretch and an impact squash. */
export interface Place {
  x: number;
  y: number;
  rot?: number;
  scale?: number;
  /** Stretch k along `dir` (rad) and 1/k across it: area kept (1 = none). */
  stretch?: number;
  dir?: number;
  /** Impact squash q in the icon's own axes about `pivot` (local px, e.g. its base): (1 + q) wide, (1 − q) high. */
  squash?: number;
  pivot?: V2;
}

/** The matrix of a Place: squash about the pivot, then rotate and scale, then stretch along dir, then move. */
export function placeMatrix(p: Place): Mat2D {
  const sc = p.scale ?? 1, r = p.rot ?? 0, cr = Math.cos(r), sr = Math.sin(r);
  const R = [cr * sc, -sr * sc, sr * sc, cr * sc];
  const q = p.squash ?? 0, D = [1 + q, 0, 0, 1 - q];
  const k = p.stretch ?? 1, phi = p.dir ?? 0, cp = Math.cos(phi), sp = Math.sin(phi), ik = 1 / k;
  const Q = [cp * cp * k + sp * sp * ik, cp * sp * (k - ik), cp * sp * (k - ik), sp * sp * k + cp * cp * ik];
  const mul = (a: number[], b: number[]) => [a[0]! * b[0]! + a[1]! * b[2]!, a[0]! * b[1]! + a[1]! * b[3]!, a[2]! * b[0]! + a[3]! * b[2]!, a[2]! * b[1]! + a[3]! * b[3]!];
  const QR = mul(Q, R), A = mul(QR, D);
  const pv = p.pivot ?? { x: 0, y: 0 }, dpx = pv.x - D[0]! * pv.x, dpy = pv.y - D[3]! * pv.y;
  return [A[0]!, A[2]!, A[1]!, A[3]!, p.x + QR[0]! * dpx + QR[1]! * dpy, p.y + QR[2]! * dpx + QR[3]! * dpy];
}

export interface TravelOpts {
  /** Offset (px) of the arc's control point from the midpoint between the two places. */
  arc?: V2;
  /** Extra turn (rad) at the middle of the move, back to the blended rotation at the ends. */
  spin?: number;
  /** Peak stretch along the travel at the middle (0.12 → k = 1.12). */
  stretch?: number;
}

/**
 * Where a morphing icon is at eased progress g from place A to place B: along a quadratic Bézier arc (not a straight line),
 * stretched along its direction of travel keeping its area, rotation and scale blended. Squash/pivot are taken from the
 * nearer end (add impacts yourself).
 */
export function travel(g: number, A: Place, B: Place, o: TravelOpts = {}): Place {
  const C = { x: (A.x + B.x) / 2 + (o.arc?.x ?? 0), y: (A.y + B.y) / 2 + (o.arc?.y ?? 0) };
  const at = (u: number) => { const v = 1 - u; return { x: v * v * A.x + 2 * v * u * C.x + u * u * B.x, y: v * v * A.y + 2 * v * u * C.y + u * u * B.y }; };
  const p = at(g), p1 = at(Math.max(0, g - 0.02)), p2 = at(Math.min(1, g + 0.02));
  const dir = Math.hypot(p2.x - p1.x, p2.y - p1.y) > 0.5 ? Math.atan2(p2.y - p1.y, p2.x - p1.x) : Math.PI / 2;
  const s = Math.sin(Math.PI * clamp(g)), near = g < 0.5 ? A : B;
  return {
    x: p.x, y: p.y, dir,
    rot: lerp(A.rot ?? 0, B.rot ?? 0, g) + (o.spin ?? 0) * s,
    scale: lerp(A.scale ?? 1, B.scale ?? 1, g),
    stretch: 1 + (o.stretch ?? 0.12) * s,
    squash: near.squash, pivot: near.pivot,
  };
}

export interface PartsStyle {
  fill: string;
  /** Colour of the shade facet (drawn while shadeOn). */
  shade?: string;
  /** Stroke colour (default: fill). */
  stroke?: string;
  /** Colour change as a sweep inside the body: the colour `to` enters at the leading edge along `dir` (rad, usually the
   *  travel direction) and covers the body at p = 1 (eased inside). No dir: a disc growing from the icon's centre. */
  sweep?: { to: string; p: number; dir?: number };
}

const polyPath = (path: Path2D, P: readonly V2[]) => {
  path.moveTo(P[0]!.x, P[0]!.y);
  for (let i = 1; i < P.length; i++) path.lineTo(P[i]!.x, P[i]!.y);
  path.closePath();
};

/**
 * Draw Parts through a matrix (points are transformed, so stroke widths scale with the icon but never stretch): body with
 * its hole see-through (even-odd; holeOn false closes it), the sweep, the shade facet clipped to the body, then the strokes (round caps; a slot
 * shorter than its width fades out instead of showing as a round speck).
 */
export function drawParts(c: CanvasRenderingContext2D, P: Parts, m: Mat2D, st: PartsStyle) {
  const T = (p: V2) => mapPt(m, p);
  const body = P.body.map(T);
  const path = new Path2D();
  polyPath(path, body);
  if (P.holeOn) polyPath(path, P.hole.map(T));
  c.save();
  c.fillStyle = st.fill;
  c.fill(path, 'evenodd');
  const sw = st.sweep;
  if (sw && sw.p > 0) {
    c.save();
    c.clip(path, 'evenodd');
    c.fillStyle = sw.to;
    c.beginPath();
    const e = eio(clamp(sw.p));
    if (sw.dir == null) {
      const o = { x: m[4], y: m[5] };
      let R = 0;
      for (const q of body) R = Math.max(R, Math.hypot(q.x - o.x, q.y - o.y));
      c.arc(o.x, o.y, R * 1.03 * e, 0, TAU);
    } else {
      const nx = Math.cos(sw.dir), ny = Math.sin(sw.dir);
      let p0 = Infinity, p1 = -Infinity;
      for (const q of body) { const d = q.x * nx + q.y * ny; p0 = Math.min(p0, d); p1 = Math.max(p1, d); }
      const edge = p1 - (p1 - p0 + 4) * e, ox = nx * edge, oy = ny * edge, tx = -ny * 1e4, ty = nx * 1e4;
      c.moveTo(ox - tx, oy - ty); c.lineTo(ox + tx, oy + ty);
      c.lineTo(ox + tx + nx * 1e4, oy + ty + ny * 1e4); c.lineTo(ox - tx + nx * 1e4, oy - ty + ny * 1e4);
      c.closePath();
    }
    c.fill();
    c.restore();
  }
  if (P.shadeOn && st.shade) {
    const sp = new Path2D();
    polyPath(sp, P.shade.map(T));
    c.save();
    c.clip(path, 'evenodd');
    c.fillStyle = st.shade;
    c.fill(sp);
    c.restore();
  }
  c.restore();
  const k = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  c.save();
  c.lineCap = 'round'; c.lineJoin = 'round';
  c.strokeStyle = st.stroke ?? st.fill;
  for (const s of P.strokes) {
    const w = s.w * k;
    if (w < 0.6) continue;
    const Q = s.pts.map(T);
    let len = 0;
    for (let i = 1; i < Q.length; i++) len += Math.hypot(Q[i]!.x - Q[i - 1]!.x, Q[i]!.y - Q[i - 1]!.y);
    const al = smoothstep(0.7, 1.0, len / w);
    if (al <= 0.01) continue;
    c.globalAlpha = al;
    c.lineWidth = w;
    c.beginPath();
    c.moveTo(Q[0]!.x, Q[0]!.y);
    for (let i = 1; i < Q.length; i++) c.lineTo(Q[i]!.x, Q[i]!.y);
    c.stroke();
  }
  c.restore();
}

/**
 * Analytic motion blur of a disc of radius r that moves from a to b while the shutter is open: a capsule whose opacity
 * ramps up over the first 2r, holds 2r / length, and ramps down (a box shutter over the disc). Draw the fast thing with
 * shutterT(t, 0) positions at the shutter's ends, and it reads as a streak at any sample count. color '#rrggbb'.
 */
export function smearDisc(c: CanvasRenderingContext2D, a: V2, b: V2, r: number, color: string, alpha = 1) {
  const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const n = parseInt(color.replace('#', ''), 16), rgb = `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  c.save();
  if (L < 1.5) {
    c.globalAlpha *= alpha;
    c.fillStyle = color;
    c.beginPath(); c.arc(mx, my, r, 0, TAU); c.fill();
    c.restore();
    return;
  }
  const ux = dx / L, uy = dy / L, T = L + 2 * r, am = Math.min(1, (2 * r) / L) * alpha, o1 = Math.min(2 * r, L) / T, an = Math.atan2(dy, dx);
  const gr = c.createLinearGradient(mx - (ux * T) / 2, my - (uy * T) / 2, mx + (ux * T) / 2, my + (uy * T) / 2);
  gr.addColorStop(0, `rgba(${rgb},0)`); gr.addColorStop(o1, `rgba(${rgb},${am})`);
  gr.addColorStop(1 - o1, `rgba(${rgb},${am})`); gr.addColorStop(1, `rgba(${rgb},0)`);
  c.fillStyle = gr;
  c.beginPath();
  c.arc(a.x, a.y, r, an + Math.PI / 2, an + (3 * Math.PI) / 2);
  c.arc(b.x, b.y, r, an - Math.PI / 2, an + Math.PI / 2);
  c.closePath();
  c.fill();
  c.restore();
}

// ---------- one continuous line (mg-styles-15 demos/02-line-art, MIT) ----------

/** A named run of the one line (a polyline, absolute px). wobble: hand-drawn amplitude (px): plants ~0.4, buildings 0.05, logo 0. */
export interface LinePiece { name: string; pts: readonly V2[]; wobble?: number }

export interface OneLineOpts {
  /** Resample spacing (px). */
  step?: number;
  /** Wobble noise wavelengths along the line (px) and their weights. */
  waves?: readonly [number, number];
  mix?: readonly [number, number];
  /** px over which the wobble amplitude blends from piece to piece. */
  blend?: number;
  /** Pen slow-down in corners: τ grows by length × (1 + corner · density), density = turning (rad/px) averaged over
   *  a Gaussian of `cornerSigma` px, capped at `cornerCap`. */
  corner?: number;
  cornerSigma?: number;
  cornerCap?: number;
  seed?: number;
}

export interface LineStyle {
  /** Line width in the current canvas units (divide by the camera zoom for a constant width on screen). */
  width: number;
  /** Colour for a brightness b (1 = just drawn, down to the floor) on piece index `piece`. */
  color: (b: number, piece: number) => string;
  /** Brightness the line settles to (default 0.4), per piece if a function. */
  floor?: number | ((piece: number) => number);
  /** Age (s) at which the glow starts and finishes fading. */
  fade?: readonly [number, number];
  /** Samples per stroke call (one colour each). */
  chunk?: number;
  /** px from the line's start over which it grows from 35 % width (an ink tail); 0 = none. */
  taper?: number;
}

/**
 * The whole film as one continuous line. Pieces are laid end to end (a gap is bridged by a straight run); the line wobbles
 * along its normal with two octaves of value noise (17 px and 5.5 px wavelengths, amplitude per piece); the pen slows into
 * corners (τ = length × (1 + 9 · corner density)); timing(keys) maps [time, marker] keys through a monotone spline, a
 * repeated marker being a hold. Drawn with the freshest line brightest, fading to the floor over 1.5 s.
 */
export class OneLine {
  readonly n: number;
  readonly total: number;
  /** Wobbled centreline, arc length (unwobbled), piece index and corner-weighted length per sample. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly s: Float64Array;
  readonly piece: Uint16Array;
  readonly tau: Float64Array;
  readonly names: string[];
  readonly starts: number[] = [];
  readonly ends: number[] = [];
  /** [from, to] of every hold in the timing (a repeated marker): feed to holdClock. */
  holds: [number, number][] = [];
  tStart = 0;
  tEnd = 0;
  private clock: (t: number) => number = () => 0;
  private drawn: Float32Array;

  constructor(pieces: readonly LinePiece[], o: OneLineOpts = {}) {
    const step = o.step ?? 0.75;
    const X: number[] = [], Y: number[] = [], S: number[] = [], P: number[] = [];
    this.names = pieces.map((p) => p.name);
    let s0 = 0;
    pieces.forEach((pc, pi) => {
      const pts = [...pc.pts];
      const last = X.length ? { x: X[X.length - 1]!, y: Y[Y.length - 1]! } : null;
      if (last && Math.hypot(pts[0]!.x - last.x, pts[0]!.y - last.y) > 0.01) pts.unshift(last);
      const L = polylineLengths(pts), len = L[L.length - 1] ?? 0, n = Math.max(2, Math.ceil(len / step));
      this.starts.push(s0);
      for (let k = X.length ? 1 : 0; k <= n; k++) {
        const p = pointAtLength(pts, L, (len * k) / n);
        X.push(p.x); Y.push(p.y); S.push(s0 + (len * k) / n); P.push(pi);
      }
      s0 += len;
      this.ends.push(s0);
    });
    const N = (this.n = X.length);
    this.total = s0;
    this.s = Float64Array.from(S);
    this.piece = Uint16Array.from(P);
    // wobble amplitude per sample, blended across piece joins
    const amp0 = P.map((pi) => pieces[pi]!.wobble ?? 0), amp = new Float32Array(N), R = Math.max(1, Math.round((o.blend ?? 20) / step));
    for (let i = 0; i < N; i++) {
      let acc = 0, c = 0;
      for (let k = -R; k <= R; k += 2) { acc += amp0[clamp(i + k, 0, N - 1)]!; c++; }
      amp[i] = acc / c;
    }
    const [l0, l1] = o.waves ?? [17, 5.5], [m0, m1] = o.mix ?? [0.75, 0.45], seed = o.seed ?? 0;
    this.x = new Float32Array(N); this.y = new Float32Array(N);
    const ang = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const a = Math.max(0, i - 2), b = Math.min(N - 1, i + 2);
      let tx = X[b]! - X[a]!, ty = Y[b]! - Y[a]!;
      const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
      const w = amp[i]! * (m0 * noise1(S[i]! / l0, seed) + m1 * noise1(S[i]! / l1 + 300, seed + 1));
      this.x[i] = X[i]! - ty * w; this.y[i] = Y[i]! + tx * w;
      const a1 = Math.max(0, i - 1), b1 = Math.min(N - 1, i + 1);
      ang[i] = Math.atan2(Y[b1]! - Y[a1]!, X[b1]! - X[a1]!);
    }
    // corner density (rad per px, Gaussian-averaged) → corner-weighted length τ
    const turn = new Float32Array(N);
    for (let i = 1; i < N; i++) { let d = ang[i]! - ang[i - 1]!; d -= TAU * Math.round(d / TAU); turn[i] = Math.abs(d); }
    const sig = (o.cornerSigma ?? 7) / step, KR = Math.ceil(sig * 3), ker: number[] = [];
    for (let k = -KR; k <= KR; k++) ker.push(Math.exp(-(k * k) / (2 * sig * sig)));
    const ks = ker.reduce((a, b) => a + b, 0), kc = o.corner ?? 9, cap = o.cornerCap ?? 0.3;
    this.tau = new Float64Array(N);
    for (let i = 1; i < N; i++) {
      let acc = 0;
      for (let k = -KR; k <= KR; k++) { const j = i + k; if (j >= 0 && j < N) acc += turn[j]! * ker[k + KR]!; }
      const dens = acc / ks / step;
      this.tau[i] = this.tau[i - 1]! + (S[i]! - S[i - 1]!) * (1 + kc * Math.min(dens, cap));
    }
    this.drawn = new Float32Array(N).fill(Infinity);
  }

  /** Sample index at arc length s (the last sample at or before it). */
  index(s: number): number {
    let lo = 0, hi = this.n - 1;
    if (s >= this.s[hi]!) return hi;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.s[m]! <= s) lo = m; else hi = m; }
    return lo;
  }

  /** Arc length of a marker: 'name' = the piece's start, 'name>' = its end, 'name@0.4' = 40 % along it. */
  markerS(m: string): number {
    let name = m, f = 0;
    if (m.endsWith('>')) { name = m.slice(0, -1); f = 1; } else if (m.includes('@')) { const [a, b] = m.split('@'); name = a!; f = +b!; }
    const i = this.names.indexOf(name);
    if (i < 0) throw new Error(`OneLine: no piece named ${name}`);
    return lerp(this.starts[i]!, this.ends[i]!, f);
  }

  private tauAtS(s: number): number {
    const i = this.index(s), j = Math.min(this.n - 1, i + 1), d = this.s[j]! - this.s[i]!;
    return lerp(this.tau[i]!, this.tau[j]!, d > 0 ? clamp((s - this.s[i]!) / d) : 0);
  }
  private sAtTau(tau: number): number {
    const T = this.tau, N = this.n;
    if (tau <= 0) return 0;
    if (tau >= T[N - 1]!) return this.total;
    let lo = 0, hi = N - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m]! <= tau) lo = m; else hi = m; }
    return lerp(this.s[lo]!, this.s[hi]!, (tau - T[lo]!) / (T[hi]! - T[lo]! || 1));
  }

  /**
   * Time the drawing: [song time, marker] keys in time order. Between keys the pen runs at a corner-weighted speed along a
   * monotone spline (no backtracking); the same marker twice is a hold (the pen eases into it and out again). startSlope 1.3
   * leaves the first key a little faster; the pen comes to rest on the last one. Precomputes when each point is drawn.
   */
  timing(keys: readonly (readonly [t: number, marker: string])[], startSlope = 1.3): this {
    const xs = keys.map((k) => k[0]), ys = keys.map((k) => this.tauAtS(this.markerS(k[1])));
    this.clock = monotone(xs, ys, startSlope, 0);
    this.tStart = xs[0] ?? 0;
    this.tEnd = xs[xs.length - 1] ?? 0;
    this.holds = [];
    for (let i = 1; i < keys.length; i++) if (keys[i]![1] === keys[i - 1]![1]) this.holds.push([keys[i - 1]![0], keys[i]![0]]);
    this.drawn.fill(Infinity);
    let j = 0;
    const dt = 1 / 600;
    for (let k = 0; ; k++) {
      const t = this.tStart + k * dt, s = this.head(Math.min(t, this.tEnd));
      while (j < this.n && this.s[j]! <= s + 1e-6) this.drawn[j++] = Math.min(t, this.tEnd);
      if (t >= this.tEnd) break;
    }
    return this;
  }

  /** Arc length the pen has reached at time t. */
  head(t: number): number { return this.sAtTau(this.clock(t)); }

  /** The (wobbled) line at arc length s. */
  point(s: number): V2 {
    const i = this.index(s), j = Math.min(this.n - 1, i + 1), d = this.s[j]! - this.s[i]!, f = d > 0 ? clamp((s - this.s[i]!) / d) : 0;
    return { x: lerp(this.x[i]!, this.x[j]!, f), y: lerp(this.y[i]!, this.y[j]!, f) };
  }

  /** The pen tip at time t (held at the ends outside the timing). */
  tip(t: number): V2 { return this.point(this.head(clamp(t, this.tStart, this.tEnd))); }

  /** Time sample i is drawn (Infinity if never). */
  drawnAt(i: number): number { return this.drawn[i]!; }

  /** Brightness of sample i at time t: 1 just drawn, easing to `floor` between fade[0] and fade[1] s of age. */
  glow(i: number, t: number, floor = 0.4, fade: readonly [number, number] = [0.2, 1.5]): number {
    return floor + (1 - floor) * (1 - smoothstep(fade[0], fade[1], t - this.drawn[i]!));
  }

  /** Stroke the line drawn so far, in chunks coloured by brightness. */
  draw(c: CanvasRenderingContext2D, t: number, st: LineStyle) {
    const sHead = this.head(t), iHead = this.index(sHead), chunk = st.chunk ?? 12, taper = st.taper ?? 0;
    if (sHead <= 0) return;
    const head = this.point(sHead);
    c.save();
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (let i0 = 0; i0 <= iHead; i0 += chunk) {
      const i1 = Math.min(iHead, i0 + chunk), im = (i0 + i1) >> 1, pc = this.piece[im]!;
      const floor = typeof st.floor === 'function' ? st.floor(pc) : st.floor ?? 0.4;
      c.strokeStyle = st.color(this.glow(im, t, floor, st.fade), pc);
      c.lineWidth = st.width * (taper > 0 ? 0.35 + 0.65 * smoothstep(0, taper, this.s[im]!) : 1);
      c.beginPath();
      c.moveTo(this.x[i0]!, this.y[i0]!);
      for (let i = i0 + 1; i <= i1; i++) c.lineTo(this.x[i]!, this.y[i]!);
      if (i1 === iHead) c.lineTo(head.x, head.y);
      c.stroke();
    }
    c.restore();
  }
}

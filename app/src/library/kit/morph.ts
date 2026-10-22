// 形状变形和路径动画（Canvas2D）。形状 = 若干条闭合轮廓（V2[]），字、圆、方块、SVG 素材都先变成这个格式。
//
//   变形：  morphShapes(A, B, u)  —— 一个点胀成圆、圆变成字母、字母变成色块。轮廓按弧长重采样、对齐起点和方向，
//           条数不一样时多出来的缩成一个点长出来 / 收回去
//   路径：  new PathWalk(pts)  —— 沿路径走（位置 + 切线角）、只画一段（修剪路径 trim）、按长度写出来
//   飘带：  ribbon(pts, w0, w1) —— 变宽度的描边多边形（围巾、拖尾、马克笔起收笔）
//   字形：  textShape(text, family, size)  —— 字的轮廓（type.ts 的 opentype 命令拍平）
//   SVG：   在 svg.ts（Illustrator 导出的素材读成同样的形状）
import { clamp, lerp, TAU, type V2, polylineLengths, pointAtLength } from '../../engine/util';
import { textPathCommands } from '../../engine/type';

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

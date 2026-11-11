// 形状层（AE 的 Shape Layer），在 Canvas 2D 上画。一条形状的处理顺序和 AE 默认的叠放一样：
//   路径 →（路径变形 PathMorph）→ 路径抖动 wiggle → 描边生长 trim → 填充 fill、描边 stroke（虚线、渐细）→ 重复器 repeater
// 全部是传进来的 t 和参数的纯函数（抖动只读 t，没有随机数），起点、终点、偏移、份数直接拿 kf(t, …) 打关键帧再传进来。
// 坐标是当前画布变换下的局部单位（Layer2D 里就是逻辑像素）；先 c.translate / rotate / scale 摆好再画，线宽、虚线、渐变跟着变换走。
//
// ── 路径（Path：建一次，按画面尺度拍平并缓存，放大 / 4K 时自动细分得更密）──
//   new Path('M 10 10 h 80 a 20 20 0 0 1 20 20 …')   SVG path 字符串：M L H V C S Q T A Z，大小写（相对写法）都行，可以连写
//   rectPath(x, y, w, h, r = 0)                       矩形（左上角 + 宽高），r 圆角
//   ellipsePath(cx, cy, rx, ry = rx)                  椭圆，从正上方顺时针（描边生长从 12 点开始）
//   polygonPath(cx, cy, r, sides, { rot, round })     正多边形，第一个顶点朝上；round 圆角半径
//   starPath(cx, cy, outer, inner, points, { rot, round })   星形
//   polylinePath(pts, closed = false, round = 0)      折线（拐角可倒圆）
//   textPath(text, family, size, x, y, tracking)      字的轮廓（type.ts），可以描边生长、抖动、重复
//   new Path(cmds)                                    绝对坐标命令 { type: 'M'|'L'|'Q'|'C'|'Z', … }（和 opentype.js、kit/morph.ts 的 Cmd 同形）
//   几条路径算一个形状组：drawShape 传数组。path.flat(tol) 拿到拍平的折线（Sub[]：x、y、累计长度 s、closed、len）
//
// ── 画：drawShape(c, src, style, t) ──（返回描边生长后的折线段 Piece[]，可以拿来贴别的东西）
//   src      Path、拍平的 Flat（PathMorph.at() 的结果）或它们的数组
//   style.fill       '#rrggbb' / 任意 CSS 颜色，或渐变 { linear: [x0, y0, x1, y1], stops: [[0, '#…'], [1, '#…']] }
//                    / { radial: [cx, cy, r], stops }（局部坐标）；fillRule 'nonzero'（默认）| 'evenodd'（字的洞）
//   style.stroke     { color, width, cap = 'round', join = 'round', miterLimit = 4,
//                      dash: [实, 虚, …], dashOffset,          虚线（局部单位）。虚线钉在路径上：描边生长时虚线不滑动，
//                                                              改 dashOffset 才走（行军蚁）
//                      taper: { start, end, startWidth = 0, endWidth = 0, ease = 0, units = 'fraction' } }
//                    渐细（AE 描边的 Taper）：start / end 是起止渐细段的长度（默认按这一段可见描边的比例，units 'px' 按长度），
//                    startWidth / endWidth 是最细处占线宽的比例，ease 0 尖、1 圆头。按可见的那一段算，所以描边生长的笔头是尖的
//   style.strokeUnder  描边画在填充下面（默认描边在上）
//   style.trim       { start = 0, end = 1, offset = 0, mode = 'together' }  描边生长（Trim Paths）：start / end 0–1，
//                    start > end 自动对调；offset 单位是圈（1 = 绕一整圈，AE 的 360°），超出会绕回去，闭合路径绕过接缝是连着的一笔。
//                    mode：'together' 所有子路径首尾接成一条算（一条画完再画下一条，AE 的 Individually）；
//                          'each' 每条子路径各算各的、同时生长（AE 的 Simultaneously）
//                    填充也只填生长出来的那部分（和 AE 一样：生长一半的圆，填充是弓形）
//   style.wiggle     { amount, detail = 2, speed = 1, seed = 0, phase = 0, points = 'smooth' }  路径抖动（Wiggle Paths）：
//                    沿法线按梯度噪声位移 amount（局部单位），detail 每 100 单位长度几个起伏，speed 每秒变几次，
//                    points 'corner' 成锯齿折线（AE 的 Corner Points）。闭合路径的噪声首尾接得上
//   style.repeater   { copies, offset = 0, position: [dx, dy], rotation（弧度）, scale（每份的倍数，数或 [sx, sy]）,
//                      anchor: [x, y], startOpacity = 1, endOpacity = 1, order = 'above' }
//                    重复器：第 k 份 = 变换叠 k 次（位移 + 旋转出弧线和螺旋，和 AE 一样）。copies 可以是小数（最后一份按小数部分透明），
//                    offset 可以是小数（份数整体沿变换滑动，均匀缩放时是精确的连续变换）。order 'below' 后面的份压在下面
//   style.opacity    整体透明度；style.tol  拍平精度（屏幕像素，默认 0.2）
//
// ── 其他 ──
//   new PathMorph(A, B, { n })   路径变形：按弧长重采样、对齐起点和方向后插值；子路径按大小配对，多出来的从一点长出来 / 缩回去。
//                                .at(u) → Flat（u 线性 0–1，缓动自己加：E.morph(u)），传给 drawShape。
//                                形状差得很远（会翻折打结）时用效果库的 SlotMorph（library/kit/morph.ts，经过圆）
//   wigglePath(flat, wiggle, t, step) / trimPath(flat, trim)   单独用的抖动和生长（drawShape 里就是这两步）
//   pointAlong(flat, u)          整条路径（子路径接起来）上比例 u 处的位置和切线角：生长的笔头、沿路径走的东西
//   pathLength(flat)             总长
//
// 和 AE 不一样的地方：渐细描边的拐角和端点总是圆的（butt 端点除外）；路径抖动没有 Correlation；重复器的非均匀缩放
// 在小数 offset 上是近似的；没有 Merge Paths、Offset Paths、Pucker & Bloat、Round Corners 效果（圆角在建路径时给）。
// 性能：拍平按 0.2 屏幕像素的误差（Wang 公式）给每段曲线分段，结果按半个八度缓存；抖动、生长、虚线每帧现算，几千个点在 1 ms 内。
// 渐细描边画成填充多边形（每段一个四边形 + 拐角圆），比原生 stroke 慢，长路径（上万点）上会到几毫秒。
import { clamp, lerp, TAU, type V2 } from './util';
import { SCALE } from './scale';
import { textPathCommands } from './type';

// ---------------------------------------------------------------- path commands

/** Absolute path commands (same shape as opentype.js commands and library/kit/morph.ts Cmd). */
export type PathCmd =
  | { type: 'M' | 'L'; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Z' };

const ARGC: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** Parse an SVG path `d` into absolute M / L / Q / C / Z commands (H V S T converted, A split into cubics). */
export function parsePath(d: string): PathCmd[] {
  const toks = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: PathCmd[] = [];
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0;
  let lc: V2 | null = null, lq: V2 | null = null; // last cubic / quadratic control point (for S / T)
  const isCmd = (s: string | undefined) => !!s && /^[a-zA-Z]$/.test(s);
  let bad = false; // ran out of numbers (a truncated path): stop there
  const num = () => {
    if (i >= toks.length || isCmd(toks[i])) { bad = true; return 0; }
    return parseFloat(toks[i++]!);
  };
  // arc flags may be packed ("a10 10 0 0110 10"): one digit each
  const flag = () => {
    if (i >= toks.length || isCmd(toks[i])) { bad = true; return false; }
    const tk = toks[i]!;
    if (tk.length > 1 && (tk[0] === '0' || tk[0] === '1')) { toks[i] = tk.slice(1); return tk[0] === '1'; }
    i++;
    return parseFloat(tk) !== 0;
  };
  while (i < toks.length) {
    if (isCmd(toks[i])) cmd = toks[i++]!;
    else if (!cmd) { i++; continue; }
    const C = cmd.toUpperCase(), rel = cmd !== C;
    if (C === 'Z') {
      out.push({ type: 'Z' });
      x = sx; y = sy; lc = lq = null;
      if (!isCmd(toks[i])) i++; // stray numbers after Z
      continue;
    }
    if (ARGC[C] === undefined) { cmd = ''; continue; }
    if (i >= toks.length || isCmd(toks[i])) continue; // a command letter with no numbers
    const ox = rel ? x : 0, oy = rel ? y : 0, before = out.length;
    if (C === 'M') {
      x = ox + num(); y = oy + num(); sx = x; sy = y;
      out.push({ type: 'M', x, y });
      cmd = rel ? 'l' : 'L'; // further pairs are line-tos
      lc = lq = null;
    } else if (C === 'L') { x = ox + num(); y = oy + num(); out.push({ type: 'L', x, y }); lc = lq = null; }
    else if (C === 'H') { x = ox + num(); out.push({ type: 'L', x, y }); lc = lq = null; }
    else if (C === 'V') { y = oy + num(); out.push({ type: 'L', x, y }); lc = lq = null; }
    else if (C === 'C' || C === 'S') {
      let x1: number, y1: number;
      if (C === 'C') { x1 = ox + num(); y1 = oy + num(); }
      else { x1 = lc ? 2 * x - lc.x : x; y1 = lc ? 2 * y - lc.y : y; }
      const x2 = ox + num(), y2 = oy + num();
      x = ox + num(); y = oy + num();
      out.push({ type: 'C', x1, y1, x2, y2, x, y });
      lc = { x: x2, y: y2 }; lq = null;
    } else if (C === 'Q' || C === 'T') {
      let x1: number, y1: number;
      if (C === 'Q') { x1 = ox + num(); y1 = oy + num(); }
      else { x1 = lq ? 2 * x - lq.x : x; y1 = lq ? 2 * y - lq.y : y; }
      x = ox + num(); y = oy + num();
      out.push({ type: 'Q', x1, y1, x, y });
      lq = { x: x1, y: y1 }; lc = null;
    } else if (C === 'A') {
      const rx = num(), ry = num(), rot = num(), large = flag(), sweep = flag();
      const x2 = ox + num(), y2 = oy + num();
      if (!bad) out.push(...arcCubics(x, y, rx, ry, rot, large, sweep, x2, y2));
      x = x2; y = y2; lc = lq = null;
    }
    if (bad) { out.length = before; break; }
  }
  return out;
}

/** SVG elliptical arc (endpoint form) → cubic Béziers of at most 90° each. */
function arcCubics(x1: number, y1: number, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, x2: number, y2: number): PathCmd[] {
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx < 1e-9 || ry < 1e-9) return [{ type: 'L', x: x2, y: y2 }];
  const phi = (rotDeg * Math.PI) / 180, cs = Math.cos(phi), sn = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cs * dx + sn * dy, y1p = -sn * dx + cs * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const k = Math.sqrt(lam); rx *= k; ry *= k; }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / Math.max(1e-12, den)));
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
  const cx = cs * cxp - sn * cyp + (x1 + x2) / 2, cy = sn * cxp + cs * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dth > 0) dth -= TAU;
  else if (sweep && dth < 0) dth += TAU;
  const segs = Math.max(1, Math.ceil(Math.abs(dth) / (Math.PI / 2) - 1e-9)), del = dth / segs, k = (4 / 3) * Math.tan(del / 4);
  const P = (a: number): V2 => ({ x: cx + cs * rx * Math.cos(a) - sn * ry * Math.sin(a), y: cy + sn * rx * Math.cos(a) + cs * ry * Math.sin(a) });
  const D = (a: number): V2 => ({ x: -cs * rx * Math.sin(a) - sn * ry * Math.cos(a), y: -sn * rx * Math.sin(a) + cs * ry * Math.cos(a) });
  const out: PathCmd[] = [];
  for (let s = 0; s < segs; s++) {
    const a0 = th1 + s * del, a1 = a0 + del;
    const p0 = P(a0), p3 = s === segs - 1 ? { x: x2, y: y2 } : P(a1), d0 = D(a0), d1 = D(a1);
    out.push({ type: 'C', x1: p0.x + k * d0.x, y1: p0.y + k * d0.y, x2: p3.x - k * d1.x, y2: p3.y - k * d1.y, x: p3.x, y: p3.y });
  }
  return out;
}

// ---------------------------------------------------------------- flattening

/**
 * A flattened subpath. A closed one does not repeat its first point; `s` is the cumulative length at each point and,
 * when closed, one more entry: the length back round to the first point (`s.length` = n + 1). `len` = total length.
 */
export interface Sub { x: Float64Array; y: Float64Array; s: Float64Array; closed: boolean; len: number }
/** A flattened path: its subpaths in order. */
export type Flat = Sub[];

function makeSub(X: number[], Y: number[], closed: boolean): Sub | null {
  let n = X.length;
  if (closed && n > 1 && Math.abs(X[0]! - X[n - 1]!) < 1e-7 && Math.abs(Y[0]! - Y[n - 1]!) < 1e-7) { X.pop(); Y.pop(); n--; }
  if (n === 0) return null;
  const cl = closed && n > 2, cnt = cl ? n + 1 : n, s = new Float64Array(cnt);
  for (let i = 1; i < n; i++) s[i] = s[i - 1]! + Math.hypot(X[i]! - X[i - 1]!, Y[i]! - Y[i - 1]!);
  if (cl) s[n] = s[n - 1]! + Math.hypot(X[0]! - X[n - 1]!, Y[0]! - Y[n - 1]!);
  return { x: Float64Array.from(X), y: Float64Array.from(Y), s, closed: cl, len: s[cnt - 1]! };
}

/** Flatten absolute commands into polylines, each curve split by Wang's formula so it is within `tol` (local units). */
export function flattenPath(cmds: readonly PathCmd[], tol = 0.25): Flat {
  const out: Flat = [];
  let X: number[] = [], Y: number[] = [], px = 0, py = 0, sx = 0, sy = 0;
  const add = (x: number, y: number) => {
    const n = X.length;
    if (n && Math.abs(X[n - 1]! - x) < 1e-9 && Math.abs(Y[n - 1]! - y) < 1e-9) return;
    X.push(x); Y.push(y);
  };
  const end = (closed: boolean) => { const s = makeSub(X, Y, closed); if (s) out.push(s); X = []; Y = []; };
  const t = Math.max(1e-4, tol);
  for (const c of cmds) {
    if (c.type === 'M') { end(false); add(c.x, c.y); px = sx = c.x; py = sy = c.y; continue; }
    if (c.type === 'Z') { end(true); px = sx; py = sy; continue; }
    if (!X.length) add(px, py);
    if (c.type === 'L') add(c.x, c.y);
    else if (c.type === 'Q') {
      const M = Math.hypot(px - 2 * c.x1 + c.x, py - 2 * c.y1 + c.y);
      const n = Math.min(1024, Math.max(1, Math.ceil(Math.sqrt((0.25 * M) / t))));
      for (let k = 1; k <= n; k++) {
        const u = k / n, v = 1 - u;
        add(v * v * px + 2 * v * u * c.x1 + u * u * c.x, v * v * py + 2 * v * u * c.y1 + u * u * c.y);
      }
    } else if (c.type === 'C') {
      const M = Math.max(Math.hypot(px - 2 * c.x1 + c.x2, py - 2 * c.y1 + c.y2), Math.hypot(c.x1 - 2 * c.x2 + c.x, c.y1 - 2 * c.y2 + c.y));
      const n = Math.min(1024, Math.max(1, Math.ceil(Math.sqrt((0.75 * M) / t))));
      for (let k = 1; k <= n; k++) {
        const u = k / n, v = 1 - u, a = v * v * v, b = 3 * v * v * u, cc = 3 * v * u * u, d = u * u * u;
        add(a * px + b * c.x1 + cc * c.x2 + d * c.x, a * py + b * c.y1 + cc * c.y2 + d * c.y);
      }
    }
    px = c.x; py = c.y;
  }
  end(false);
  return out;
}

/** A path: commands built once, flattened lazily per tolerance (cached in half-octave steps). */
export class Path {
  readonly cmds: readonly PathCmd[];
  private cache = new Map<number, Flat>();
  constructor(src: string | readonly PathCmd[]) {
    this.cmds = typeof src === 'string' ? parsePath(src) : src;
  }
  /** Flattened within `tol` local units (cached). */
  flat(tol = 0.25): Flat {
    const k = Math.round(Math.log2(Math.max(1e-4, tol)) * 2);
    let f = this.cache.get(k);
    if (!f) {
      if (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value!);
      f = flattenPath(this.cmds, 2 ** (k / 2));
      this.cache.set(k, f);
    }
    return f;
  }
}

// ---------------------------------------------------------------- builders

/** Polygon / polyline with corners rounded by circular arcs of radius `round` (as cubics). */
function roundedPoly(pts: readonly V2[], closed: boolean, round: number): PathCmd[] {
  const n = pts.length, out: PathCmd[] = [];
  if (n === 0) return out;
  for (let i = 0; i < n; i++) {
    const V = pts[i]!, first = out.length === 0;
    const plain = () => out.push(first ? { type: 'M', x: V.x, y: V.y } : { type: 'L', x: V.x, y: V.y });
    if (round <= 0 || n < 3 || (!closed && (i === 0 || i === n - 1))) { plain(); continue; }
    const P = pts[(i - 1 + n) % n]!, N = pts[(i + 1) % n]!;
    const ux = P.x - V.x, uy = P.y - V.y, vx = N.x - V.x, vy = N.y - V.y, lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu < 1e-9 || lv < 1e-9) { plain(); continue; }
    const ax = ux / lu, ay = uy / lu, bx = vx / lv, by = vy / lv;
    const phi = Math.acos(clamp(ax * bx + ay * by, -1, 1)), th = Math.PI - phi; // interior angle, turn
    if (th < 1e-4 || phi < 1e-4) { plain(); continue; }
    let r = round, d = r / Math.tan(phi / 2);
    const dmax = Math.min(lu, lv) / 2;
    if (d > dmax) { d = dmax; r = d * Math.tan(phi / 2); }
    const h = (4 / 3) * Math.tan(th / 4) * r;
    const A = { x: V.x + ax * d, y: V.y + ay * d }, B = { x: V.x + bx * d, y: V.y + by * d };
    out.push(first ? { type: 'M', x: A.x, y: A.y } : { type: 'L', x: A.x, y: A.y });
    out.push({ type: 'C', x1: A.x - ax * h, y1: A.y - ay * h, x2: B.x - bx * h, y2: B.y - by * h, x: B.x, y: B.y });
  }
  if (closed) out.push({ type: 'Z' });
  return out;
}

/** Rectangle from its top-left corner, corners rounded by r. Starts at the top-left, clockwise. */
export function rectPath(x: number, y: number, w: number, h: number, r = 0): Path {
  return new Path(roundedPoly([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], true, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2)));
}

/** Ellipse: four cubics from the top, clockwise. */
export function ellipsePath(cx: number, cy: number, rx: number, ry = rx): Path {
  const k = 0.5522847498, kx = k * rx, ky = k * ry;
  return new Path([
    { type: 'M', x: cx, y: cy - ry },
    { type: 'C', x1: cx + kx, y1: cy - ry, x2: cx + rx, y2: cy - ky, x: cx + rx, y: cy },
    { type: 'C', x1: cx + rx, y1: cy + ky, x2: cx + kx, y2: cy + ry, x: cx, y: cy + ry },
    { type: 'C', x1: cx - kx, y1: cy + ry, x2: cx - rx, y2: cy + ky, x: cx - rx, y: cy },
    { type: 'C', x1: cx - rx, y1: cy - ky, x2: cx - kx, y2: cy - ry, x: cx, y: cy - ry },
    { type: 'Z' },
  ]);
}

/** Regular polygon, first vertex straight up (turned by rot, rad), corners rounded by `round`. */
export function polygonPath(cx: number, cy: number, r: number, sides: number, o: { rot?: number; round?: number } = {}): Path {
  const n = Math.max(3, Math.round(sides)), a0 = -Math.PI / 2 + (o.rot ?? 0);
  const pts = Array.from({ length: n }, (_, i) => ({ x: cx + Math.cos(a0 + (i * TAU) / n) * r, y: cy + Math.sin(a0 + (i * TAU) / n) * r }));
  return new Path(roundedPoly(pts, true, o.round ?? 0));
}

/** Star: `points` tips at radius outer, notches at inner; first tip straight up (turned by rot). */
export function starPath(cx: number, cy: number, outer: number, inner: number, points = 5, o: { rot?: number; round?: number } = {}): Path {
  const n = Math.max(2, Math.round(points)), a0 = -Math.PI / 2 + (o.rot ?? 0);
  const pts = Array.from({ length: n * 2 }, (_, i) => {
    const a = a0 + (i * Math.PI) / n, r = i % 2 ? inner : outer;
    return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
  });
  return new Path(roundedPoly(pts, true, o.round ?? 0));
}

/** Polyline through points (closed: back to the first), inner corners rounded by `round`. */
export function polylinePath(pts: readonly V2[], closed = false, round = 0): Path {
  return new Path(roundedPoly(pts, closed, round));
}

/** Outline of a string (type.ts), left / baseline at (x, y): stroke it, trim it, wiggle it like any path. */
export function textPath(text: string, family: string, size: number, x = 0, y = 0, tracking = 0): Path {
  return new Path(textPathCommands(text, family, size, x, y, tracking) as PathCmd[]);
}

// ---------------------------------------------------------------- measuring

const subN = (s: Sub) => s.x.length;

/** Index i with s[i] <= d < s[i + 1] (clamped to the last segment). */
function seg(sub: Sub, d: number): number {
  const S = sub.s;
  let lo = 0, hi = S.length - 1;
  if (hi <= 0) return 0;
  if (d >= S[hi]!) return hi - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m]! <= d) lo = m; else hi = m; }
  return lo;
}

/** Point, unit tangent at length d along a subpath (clamped). */
function pointOn(sub: Sub, d: number): { x: number; y: number; tx: number; ty: number } {
  const n = subN(sub);
  if (n === 1) return { x: sub.x[0]!, y: sub.y[0]!, tx: 1, ty: 0 };
  const i = seg(sub, clamp(d, 0, sub.len)), j = (i + 1) % n;
  const ax = sub.x[i]!, ay = sub.y[i]!, bx = sub.x[j]!, by = sub.y[j]!, L = sub.s[i + 1]! - sub.s[i]!;
  const u = L > 0 ? clamp((d - sub.s[i]!) / L) : 0, l = Math.hypot(bx - ax, by - ay) || 1;
  return { x: ax + (bx - ax) * u, y: ay + (by - ay) * u, tx: (bx - ax) / l, ty: (by - ay) / l };
}

/** Total length of a flattened path (all subpaths). */
export function pathLength(f: Flat): number {
  let L = 0;
  for (const s of f) L += s.len;
  return L;
}

/**
 * Position and tangent angle (rad) at fraction u of the whole path (subpaths laid end to end, as trim 'together').
 * u wraps (1.25 = 0.25) when `wrap`; otherwise clamped.
 */
export function pointAlong(f: Flat, u: number, wrap = false): { x: number; y: number; angle: number } {
  const T = pathLength(f);
  if (!f.length || T <= 0) return { x: f[0]?.x[0] ?? 0, y: f[0]?.y[0] ?? 0, angle: 0 };
  let d = (wrap ? u - Math.floor(u) : clamp(u)) * T;
  for (const s of f) {
    if (d <= s.len || s === f[f.length - 1]) { const p = pointOn(s, d); return { x: p.x, y: p.y, angle: Math.atan2(p.ty, p.tx) }; }
    d -= s.len;
  }
  return { x: 0, y: 0, angle: 0 };
}

const toFlat = (src: Path | Flat, tol: number): Flat => (src instanceof Path ? src.flat(tol) : src);

// ---------------------------------------------------------------- trim paths

export interface Trim {
  /** 0..1 along the path (swapped when start > end). */
  start?: number;
  end?: number;
  /** In turns: 1 = once round (AE's 360°); wraps. */
  offset?: number;
  /** 'together': subpaths laid end to end, trimmed as one; 'each': every subpath trimmed on its own, all at once. */
  mode?: 'together' | 'each';
}

/**
 * A visible run of the path after trimming: points, cumulative length from its start, closed (a whole closed subpath),
 * and `pos`: its start's position along the (unwrapped) path, which anchors dashes so they stay put while trimming.
 */
export interface Piece { x: number[]; y: number[]; s: number[]; closed: boolean; pos: number; len: number }

/** Points of a subpath between lengths x0 and x1 (0 <= x0 < x1 <= len) appended to X, Y. */
function extract(sub: Sub, x0: number, x1: number, X: number[], Y: number[]) {
  const n = subN(sub);
  const p0 = pointOn(sub, x0);
  pushPt(X, Y, p0.x, p0.y);
  let i = seg(sub, x0) + 1;
  while (i < sub.s.length && sub.s[i]! < x1) { pushPt(X, Y, sub.x[i % n]!, sub.y[i % n]!); i++; }
  const p1 = pointOn(sub, x1);
  pushPt(X, Y, p1.x, p1.y);
}
function pushPt(X: number[], Y: number[], x: number, y: number) {
  const n = X.length;
  if (n && Math.abs(X[n - 1]! - x) < 1e-9 && Math.abs(Y[n - 1]! - y) < 1e-9) return;
  X.push(x); Y.push(y);
}
function lengths(X: number[], Y: number[]): number[] {
  const s = [0];
  for (let i = 1; i < X.length; i++) s.push(s[i - 1]! + Math.hypot(X[i]! - X[i - 1]!, Y[i]! - Y[i - 1]!));
  return s;
}
function wholePiece(sub: Sub, pos: number): Piece {
  const X = Array.from(sub.x), Y = Array.from(sub.y);
  const s = Array.from(sub.s.subarray(0, X.length));
  return { x: X, y: Y, s, closed: sub.closed, pos, len: sub.len };
}

/** Covered runs of one subpath for the window [a, b] of a looped track of length T on which the subpath starts at S. */
function cover(sub: Sub, a: number, b: number, T: number, S: number, out: Piece[]) {
  const L = sub.len;
  if (L <= 1e-9 || T <= 1e-9) return;
  const iv: [number, number, number][] = [];
  const m0 = Math.floor((a - S - L) / T), m1 = Math.ceil((b - S) / T);
  for (let m = m0; m <= m1; m++) {
    const x0 = Math.max(0, a - S - m * T), x1 = Math.min(L, b - S - m * T);
    if (x1 - x0 > 1e-9) iv.push([x0, x1, S + m * T + x0]);
  }
  for (let k = 0; k < iv.length; k++) {
    const [x0, x1, pos] = iv[k]!;
    if (sub.closed && x0 <= 1e-9 && x1 >= L - 1e-9) { out.push(wholePiece(sub, pos)); continue; }
    const X: number[] = [], Y: number[] = [];
    extract(sub, x0, x1, X, Y);
    // a closed subpath trimmed across its seam: the next lap's run carries straight on
    const nx = iv[k + 1];
    if (sub.closed && nx && x1 >= L - 1e-9 && nx[0] <= 1e-9 && Math.abs(nx[2] - (pos + x1 - x0)) < 1e-6) {
      extract(sub, 0, nx[1], X, Y);
      k++;
    }
    if (X.length < 2) continue;
    const s = lengths(X, Y);
    out.push({ x: X, y: Y, s, closed: false, pos, len: s[s.length - 1]! });
  }
}

/** Trim a flattened path (no trim / full range: the whole path, closed subpaths stay closed). */
export function trimPath(f: Flat, tr?: Trim): Piece[] {
  const out: Piece[] = [];
  let s0 = tr?.start ?? 0, s1 = tr?.end ?? 1;
  if (s0 > s1) [s0, s1] = [s1, s0];
  const off = tr?.offset ?? 0;
  if (s0 <= 0 && s1 >= 1 && Math.abs(off) < 1e-12) { // untrimmed: closed subpaths stay closed
    let S = 0;
    for (const sub of f) { if (subN(sub) > 1) out.push(wholePiece(sub, S)); S += sub.len; }
    return out;
  }
  // a full lap with an offset still goes through the window, so dashes don't jump when the range fills up
  if (s1 - s0 > 1) s1 = s0 + 1;
  if (s1 - s0 <= 1e-9) return out;
  if ((tr?.mode ?? 'together') === 'each') {
    for (const sub of f) cover(sub, (s0 + off) * sub.len, (s1 + off) * sub.len, sub.len, 0, out);
  } else {
    const T = pathLength(f);
    let S = 0;
    for (const sub of f) { cover(sub, (s0 + off) * T, (s1 + off) * T, T, S, out); S += sub.len; }
  }
  return out;
}

// ---------------------------------------------------------------- wiggle paths

/** Integer hash of a lattice point (and seed). */
function hash4(x: number, y: number, z: number, s: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x2c1b3c6d) ^ Math.imul(s | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x297a2d39);
  h = Math.imul(h ^ (h >>> 13), 0x9e3779b1);
  return (h ^ (h >>> 16)) >>> 0;
}
const fade5 = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
/**
 * 3D gradient (Perlin) noise, about −1..1. Unlike value noise it keeps moving through the lattice points, so a wiggle
 * has no flat plateaus along the path and no stop-and-go in time.
 */
function gnoise3(x: number, y: number, z: number, seed: number): number {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z), fx = x - X, fy = y - Y, fz = z - Z;
  const g = (i: number, j: number, k: number) => {
    const h = hash4(X + i, Y + j, Z + k, seed) & 15, px = fx - i, py = fy - j, pz = fz - k;
    const u = h < 8 ? px : py, v = h < 4 ? py : h === 12 || h === 14 ? px : pz;
    return (h & 1 ? -u : u) + (h & 2 ? -v : v);
  };
  const u = fade5(fx), v = fade5(fy), w = fade5(fz);
  return lerp(
    lerp(lerp(g(0, 0, 0), g(1, 0, 0), u), lerp(g(0, 1, 0), g(1, 1, 0), u), v),
    lerp(lerp(g(0, 0, 1), g(1, 0, 1), u), lerp(g(0, 1, 1), g(1, 1, 1), u), v), w);
}

export interface Wiggle {
  /** Displacement along the normal (local units). */
  amount: number;
  /** Bumps per 100 units of length (AE Detail). */
  detail?: number;
  /** Changes per second (AE Wiggles/Second). */
  speed?: number;
  seed?: number;
  /** Time phase (s of noise). */
  phase?: number;
  /** 'smooth' (default) or 'corner': a jagged polyline through points `100 / detail / 2` apart. */
  points?: 'smooth' | 'corner';
}

/**
 * Wiggle Paths: every subpath resampled (every `step` units when smooth) and pushed along its normal by value noise of
 * (length, t · speed). Closed subpaths sample the noise round a circle, so it joins up at the seam. Pure in t.
 */
export function wigglePath(f: Flat, w: Wiggle, t: number, step = 2): Flat {
  const amt = w.amount, freq = Math.max(1e-4, (w.detail ?? 2) / 100), z = t * (w.speed ?? 1) + (w.phase ?? 0), seed = w.seed ?? 0;
  const corner = w.points === 'corner';
  const out: Flat = [];
  f.forEach((sub, si) => {
    const L = sub.len;
    if (L <= 1e-9 || subN(sub) < 2) { out.push(sub); return; }
    const sp = corner ? 0.5 / freq : Math.min(Math.max(0.05, step), 0.125 / freq);
    const m = Math.max(sub.closed ? 3 : 1, Math.round(L / sp));
    const cnt = sub.closed ? m : m + 1, X: number[] = [], Y: number[] = [];
    const R = (L * freq) / TAU, sd = Math.round(seed * 7919) + si * 131;
    const h = Math.min(sp, L / 8);
    for (let j = 0; j < cnt; j++) {
      const d = (j * L) / m;
      const p = pointOn(sub, d);
      // tangent from a short chord (smooths the flip at sharp corners a little)
      const da = sub.closed ? ((d - h) % L + L) % L : Math.max(0, d - h), db = sub.closed ? (d + h) % L : Math.min(L, d + h);
      const pa = pointOn(sub, da), pb = pointOn(sub, db);
      let tx = pb.x - pa.x, ty = pb.y - pa.y;
      const tl = Math.hypot(tx, ty);
      if (tl > 1e-9) { tx /= tl; ty /= tl; } else { tx = p.tx; ty = p.ty; }
      let nz: number;
      if (sub.closed) { const a = (d / L) * TAU; nz = gnoise3(R * Math.cos(a) + 50.5, R * Math.sin(a) + 50.5, z, sd); }
      else nz = gnoise3(d * freq, 0.5 + si * 3.7, z, sd);
      const k = amt * clamp(nz * 1.5, -1, 1);
      X.push(p.x - ty * k); Y.push(p.y + tx * k);
    }
    const s = makeSub(X, Y, sub.closed);
    if (s) out.push(s);
  });
  return out;
}

// ---------------------------------------------------------------- morph

/** Signed area of a closed point loop. */
function areaOf(X: ArrayLike<number>, Y: ArrayLike<number>): number {
  let a = 0;
  const n = X.length;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += X[i]! * Y[j]! - X[j]! * Y[i]!; }
  return a / 2;
}

/** n points spaced evenly by length (closed: round the loop, not repeating the start; open: both ends included). */
function resampleSub(sub: Sub, n: number, closed: boolean): [Float64Array, Float64Array] {
  const X = new Float64Array(n), Y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = pointOn(sub, closed ? (i / n) * sub.len : n > 1 ? (i / (n - 1)) * sub.len : 0);
    X[i] = p.x; Y[i] = p.y;
  }
  return [X, Y];
}

interface MorphPair { ax: Float64Array; ay: Float64Array; bx: Float64Array; by: Float64Array; closedA: boolean; closedB: boolean }

/**
 * Path morph: subpaths paired by size (largest with largest), each pair resampled by length to the same count, B's start
 * and direction lined up with A's (least travel); a subpath with no partner grows from / shrinks to its own centre.
 * at(u) interpolates linearly (u 0..1; ease it yourself) and returns a Flat for drawShape.
 */
export class PathMorph {
  private pairs: MorphPair[] = [];
  constructor(A: Path | Flat, B: Path | Flat, o: { n?: number; tol?: number } = {}) {
    const fa = toFlat(A, o.tol ?? 0.25).filter((s) => s.len > 1e-6), fb = toFlat(B, o.tol ?? 0.25).filter((s) => s.len > 1e-6);
    const size = (s: Sub) => (s.closed ? Math.sqrt(Math.abs(areaOf(s.x, s.y))) * 3.5 : s.len);
    const sa = [...fa].sort((p, q) => size(q) - size(p)), sb = [...fb].sort((p, q) => size(q) - size(p));
    for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
      const a = sa[i], b = sb[i];
      const ref = (a ?? b)!;
      const n = o.n ?? Math.round(clamp(Math.max(a?.len ?? 0, b?.len ?? 0) / 2, 48, 1500));
      const closed = (a ? a.closed : b!.closed) && (b ? b.closed : a!.closed);
      const [ax, ay] = a ? resampleSub(a, n, closed) : centre(b!, n);
      let [bx, by] = b ? resampleSub(b, n, closed) : centre(a!, n);
      if (a && b) [bx, by] = alignTo(ax, ay, bx, by, closed);
      this.pairs.push({ ax, ay, bx, by, closedA: a ? a.closed : ref.closed, closedB: b ? b.closed : ref.closed });
    }
  }
  at(u: number): Flat {
    const out: Flat = [];
    const k = clamp(u);
    for (const p of this.pairs) {
      const n = p.ax.length, X: number[] = new Array(n), Y: number[] = new Array(n);
      for (let i = 0; i < n; i++) { X[i] = lerp(p.ax[i]!, p.bx[i]!, k); Y[i] = lerp(p.ay[i]!, p.by[i]!, k); }
      const s = makeSub(X, Y, k < 0.5 ? p.closedA : p.closedB);
      if (s) out.push(s);
    }
    return out;
  }
}

function centre(s: Sub, n: number): [Float64Array, Float64Array] {
  let x = 0, y = 0;
  const m = subN(s);
  for (let i = 0; i < m; i++) { x += s.x[i]!; y += s.y[i]!; }
  return [new Float64Array(n).fill(x / m), new Float64Array(n).fill(y / m)];
}

/** B rotated (closed) or reversed to line up with A: same turning direction, least squared travel. */
function alignTo(ax: Float64Array, ay: Float64Array, bx: Float64Array, by: Float64Array, closed: boolean): [Float64Array, Float64Array] {
  const n = ax.length;
  const rev = (X: Float64Array) => Float64Array.from(X).reverse();
  if (!closed) {
    const d0 = Math.hypot(ax[0]! - bx[0]!, ay[0]! - by[0]!) + Math.hypot(ax[n - 1]! - bx[n - 1]!, ay[n - 1]! - by[n - 1]!);
    const d1 = Math.hypot(ax[0]! - bx[n - 1]!, ay[0]! - by[n - 1]!) + Math.hypot(ax[n - 1]! - bx[0]!, ay[n - 1]! - by[0]!);
    return d1 < d0 ? [rev(bx), rev(by)] : [bx, by];
  }
  if (Math.sign(areaOf(ax, ay)) !== Math.sign(areaOf(bx, by))) { bx = rev(bx); by = rev(by); }
  // coarse search, then refine around the best shift
  const err = (sh: number, stride: number) => {
    let e = 0;
    for (let i = 0; i < n; i += stride) { const j = (i + sh) % n, dx = ax[i]! - bx[j]!, dy = ay[i]! - by[j]!; e += dx * dx + dy * dy; }
    return e;
  };
  const st = Math.max(1, Math.floor(n / 96));
  let best = 0, be = Infinity;
  for (let sh = 0; sh < n; sh += st) { const e = err(sh, st); if (e < be) { be = e; best = sh; } }
  let b2 = best, e2 = Infinity;
  for (let sh = best - st; sh <= best + st; sh++) { const s = ((sh % n) + n) % n, e = err(s, 1); if (e < e2) { e2 = e; b2 = s; } }
  const X = new Float64Array(n), Y = new Float64Array(n);
  for (let i = 0; i < n; i++) { X[i] = bx[(i + b2) % n]!; Y[i] = by[(i + b2) % n]!; }
  return [X, Y];
}

// ---------------------------------------------------------------- paint

export type Gradient =
  | { linear: readonly [x0: number, y0: number, x1: number, y1: number]; stops: readonly (readonly [number, string])[] }
  | { radial: readonly [cx: number, cy: number, r: number]; stops: readonly (readonly [number, string])[] };
export type Paint = string | Gradient;

function paintOf(c: CanvasRenderingContext2D, p: Paint): string | CanvasGradient {
  if (typeof p === 'string') return p;
  let g: CanvasGradient;
  if ('linear' in p) g = c.createLinearGradient(p.linear[0], p.linear[1], p.linear[2], p.linear[3]);
  else g = c.createRadialGradient(p.radial[0], p.radial[1], 0, p.radial[0], p.radial[1], Math.max(1e-6, p.radial[2]));
  for (const [o, col] of p.stops) g.addColorStop(clamp(o), col);
  return g;
}

// ---------------------------------------------------------------- stroke geometry

export interface Taper {
  /** Length of the tapered start / end: a fraction of the visible run (default) or local units (units 'px'). */
  start?: number;
  end?: number;
  /** Width at the very start / end as a fraction of the stroke width (default 0: a point). */
  startWidth?: number;
  endWidth?: number;
  /** 0 = straight taper (pointed), 1 = rounded (a bullet nose). */
  ease?: number;
  units?: 'fraction' | 'px';
}

export interface StrokeStyle {
  color: Paint;
  width: number;
  cap?: CanvasLineCap;
  join?: CanvasLineJoin;
  miterLimit?: number;
  /** Dash pattern (local units, [on, off, …]); odd lengths repeat like Canvas. Anchored to the path. */
  dash?: readonly number[];
  dashOffset?: number;
  taper?: Taper;
  /** Stroke opacity (multiplies the shape's). */
  opacity?: number;
}

/** "On" runs [s0, s1] of a dash pattern over a run of length len whose start sits at pattern position `start`. */
function dashRuns(len: number, start: number, pat: readonly number[]): [number, number][] {
  const p = pat.length % 2 ? [...pat, ...pat] : [...pat];
  for (let i = 0; i < p.length; i++) p[i] = Math.max(0, p[i]!);
  const P = p.reduce((a, b) => a + b, 0);
  if (P <= 1e-9) return [[0, len]];
  // where in the pattern the run starts: element k, q into it (a zero-length "on" element at q = 0 is a dot right there)
  let q = ((start % P) + P) % P, k = 0;
  for (let g = 0; g < p.length; g++) {
    const e = p[k]!;
    if (q < e || (e === 0 && q <= 0)) break;
    q -= e;
    k = (k + 1) % p.length;
  }
  const out: [number, number][] = [];
  let s = 0, rem = Math.max(0, p[k]! - q), guard = 0;
  while (s <= len && guard++ < 100000) {
    const e = Math.min(len, s + rem);
    if (k % 2 === 0) out.push([s, e]);
    if (s + rem > len) break;
    s += rem;
    k = (k + 1) % p.length;
    rem = Math.max(0, p[k]!);
  }
  return out;
}

/** The part of a piece between s0 and s1 (a closed piece may wrap: s0 > s1 goes round through its start). */
function subRun(pc: Piece, s0: number, s1: number): { X: number[]; Y: number[]; S: number[] } {
  const X: number[] = [], Y: number[] = [], S: number[] = [];
  const at = (d: number) => {
    const s = pc.s, n = pc.x.length;
    let lo = 0, hi = n - 1;
    if (d >= s[hi]!) {
      if (!pc.closed) return { x: pc.x[hi]!, y: pc.y[hi]! };
      const L = pc.len - s[hi]!, u = L > 0 ? (d - s[hi]!) / L : 0;
      return { x: lerp(pc.x[hi]!, pc.x[0]!, u), y: lerp(pc.y[hi]!, pc.y[0]!, u) };
    }
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m]! <= d) lo = m; else hi = m; }
    const L = s[hi]! - s[lo]!, u = L > 0 ? (d - s[lo]!) / L : 0;
    return { x: lerp(pc.x[lo]!, pc.x[hi]!, u), y: lerp(pc.y[lo]!, pc.y[hi]!, u) };
  };
  const put = (x: number, y: number, d: number) => {
    const n = X.length;
    if (n && Math.abs(X[n - 1]! - x) < 1e-9 && Math.abs(Y[n - 1]! - y) < 1e-9) return;
    X.push(x); Y.push(y); S.push(d);
  };
  const span = (a: number, b: number, base: number) => {
    const p = at(a);
    put(p.x, p.y, base + a);
    for (let i = 0; i < pc.x.length; i++) if (pc.s[i]! > a && pc.s[i]! < b) put(pc.x[i]!, pc.y[i]!, base + pc.s[i]!);
    const q = at(b);
    put(q.x, q.y, base + b);
  };
  if (s1 >= s0) span(s0, s1, 0);
  else { span(s0, pc.len, 0); span(0, s1, pc.len); }
  return { X, Y, S };
}

function taperW(u: number, tp: Taper, len: number): number {
  const px = tp.units === 'px';
  const sl = px ? (tp.start ?? 0) / Math.max(1e-9, len) : tp.start ?? 0, el = px ? (tp.end ?? 0) / Math.max(1e-9, len) : tp.end ?? 0;
  const k = clamp(tp.ease ?? 0), sh = (x: number) => lerp(x, Math.sin((clamp(x) * Math.PI) / 2), k);
  let f = 1;
  if (sl > 1e-9 && u < sl) f = Math.min(f, lerp(tp.startWidth ?? 0, 1, sh(u / sl)));
  if (el > 1e-9 && u > 1 - el) f = Math.min(f, lerp(tp.endWidth ?? 0, 1, sh((1 - u) / el)));
  return Math.max(0, f);
}

/** A variable-width line as filled geometry: a quad per segment, a round join where it turns, caps. One winding. */
function addRibbon(path: Path2D, X: number[], Y: number[], Wd: number[], cap: CanvasLineCap, closed: boolean) {
  const n = X.length;
  if (n < 2) {
    if (n === 1 && cap !== 'butt' && Wd[0]! > 0) disc(path, X[0]!, Y[0]!, Wd[0]! / 2);
    return;
  }
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    let x0 = X[i]!, y0 = Y[i]!, x1 = X[j]!, y1 = Y[j]!;
    const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy);
    if (l < 1e-9) continue;
    const ux = dx / l, uy = dy / l, h0 = Wd[i]! / 2, h1 = Wd[j]! / 2;
    if (h0 <= 0 && h1 <= 0) continue;
    if (!closed && cap === 'square') {
      if (i === 0) { x0 -= ux * h0; y0 -= uy * h0; }
      if (j === n - 1) { x1 += ux * h1; y1 += uy * h1; }
    }
    // left normal (-uy, ux): this order has negative signed area for every direction, like disc()
    path.moveTo(x0 - uy * h0, y0 + ux * h0);
    path.lineTo(x1 - uy * h1, y1 + ux * h1);
    path.lineTo(x1 + uy * h1, y1 - ux * h1);
    path.lineTo(x0 + uy * h0, y0 - ux * h0);
    path.closePath();
  }
  // joins (round) wherever it turns, caps at the ends
  for (let i = 0; i < n; i++) {
    const h = Wd[i]! / 2;
    if (h <= 0.01) continue;
    const end = !closed && (i === 0 || i === n - 1);
    if (end) { if (cap === 'round') disc(path, X[i]!, Y[i]!, h); continue; }
    const a = (i - 1 + n) % n, b = (i + 1) % n;
    const ax = X[i]! - X[a]!, ay = Y[i]! - Y[a]!, bx = X[b]! - X[i]!, by = Y[b]! - Y[i]!;
    const cr = ax * by - ay * bx, dt = ax * bx + ay * by;
    if (Math.abs(Math.atan2(cr, dt)) * h > 0.15) disc(path, X[i]!, Y[i]!, h);
  }
}
function disc(path: Path2D, x: number, y: number, r: number) {
  path.moveTo(x + r, y);
  path.arc(x, y, r, 0, TAU, true);
  path.closePath();
}

/** Stroke geometry of the pieces: a path to stroke (constant width) or to fill (tapered). */
function strokeGeom(pieces: readonly Piece[], st: StrokeStyle): { path: Path2D; filled: boolean } {
  const path = new Path2D();
  const dash = st.dash && st.dash.some((d) => d > 0) ? st.dash : null;
  const tp = st.taper && ((st.taper.start ?? 0) > 0 || (st.taper.end ?? 0) > 0) ? st.taper : null;
  const cap = st.cap ?? 'round';
  for (const pc of pieces) {
    // runs to draw: the whole piece, or its dashes (a closed piece's dash across the start joins up)
    let runs: [number, number][] | null = null;
    if (dash) {
      runs = dashRuns(pc.len, pc.pos + (st.dashOffset ?? 0), dash);
      if (pc.closed && runs.length > 1 && runs[0]![0] <= 1e-9 && runs[runs.length - 1]![1] >= pc.len - 1e-9) {
        const last = runs.pop()!;
        runs[0] = [last[0], runs[0]![1]];
      }
    }
    if (!tp) {
      if (!runs) {
        path.moveTo(pc.x[0]!, pc.y[0]!);
        for (let i = 1; i < pc.x.length; i++) path.lineTo(pc.x[i]!, pc.y[i]!);
        if (pc.closed) path.closePath();
      } else for (const [a, b] of runs) {
        const r = subRun(pc, a, b);
        if (r.X.length < 2) { // a dot (zero-length dash): a hair of the path, so the cap shows, turned along the path
          const q = subRun(pc, Math.max(0, a - 5e-4), Math.min(pc.len, a + 5e-4));
          const x1 = q.X[q.X.length - 1]!, y1 = q.Y[q.Y.length - 1]!;
          path.moveTo(q.X[0]!, q.Y[0]!);
          if (q.X.length > 1) path.lineTo(x1, y1); else path.lineTo(x1 + 1e-3, y1);
          continue;
        }
        path.moveTo(r.X[0]!, r.Y[0]!);
        for (let i = 1; i < r.X.length; i++) path.lineTo(r.X[i]!, r.Y[i]!);
      }
      continue;
    }
    const w = st.width;
    const runList: [number, number][] = runs ?? [[0, pc.len]];
    for (const [a, b] of runList) {
      const whole = !runs && pc.closed;
      const r = whole ? { X: pc.x, Y: pc.y, S: pc.s } : subRun(pc, a, b);
      const L = pc.len || 1;
      // u along the piece (a dash wrapped round a closed piece's start continues from 0)
      const Wd = r.S.map((d) => { let u = d / L; if (u > 1 + 1e-9) u -= 1; return w * taperW(clamp(u), tp, pc.len); });
      addRibbon(path, r.X, r.Y, Wd, cap, whole);
    }
  }
  return { path, filled: !!tp };
}

function fillGeom(pieces: readonly Piece[]): Path2D {
  const path = new Path2D();
  for (const pc of pieces) {
    if (pc.x.length < 2) continue;
    path.moveTo(pc.x[0]!, pc.y[0]!);
    for (let i = 1; i < pc.x.length; i++) path.lineTo(pc.x[i]!, pc.y[i]!);
    path.closePath();
  }
  return path;
}

// ---------------------------------------------------------------- repeater

export interface Repeater {
  /** Number of copies (the original counts as one); a fraction fades the last copy. */
  copies: number;
  /** Shifts every copy along the transform (fractions slide smoothly). */
  offset?: number;
  /** Per-copy transform: move, turn (rad) and scale about `anchor` (local units), applied k times to copy k. */
  position?: readonly [number, number];
  rotation?: number;
  scale?: number | readonly [number, number];
  anchor?: readonly [number, number];
  /** Opacity of the first and the last copy (linear between). */
  startOpacity?: number;
  endOpacity?: number;
  /** 'above' (default): later copies on top; 'below': later copies underneath. */
  order?: 'above' | 'below';
}

type M2 = [number, number, number, number, number, number]; // canvas order a b c d e f
const mul = (A: M2, B: M2): M2 => [
  A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
  A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
];
function inv(A: M2): M2 {
  const det = A[0] * A[3] - A[1] * A[2] || 1e-12;
  const a = A[3] / det, b = -A[1] / det, c = -A[2] / det, d = A[0] / det;
  return [a, b, c, d, -(a * A[4] + c * A[5]), -(b * A[4] + d * A[5])];
}
/** One step of the repeater transform scaled to a fraction f of itself (move f·p, turn f·r, scale s^f). */
function repStep(r: Repeater, f: number): M2 {
  const [px, py] = r.position ?? [0, 0], [ax, ay] = r.anchor ?? [0, 0], rot = (r.rotation ?? 0) * f;
  const sc = r.scale ?? 1, sx = Math.pow(Math.max(1e-6, typeof sc === 'number' ? sc : sc[0]), f), sy = Math.pow(Math.max(1e-6, typeof sc === 'number' ? sc : sc[1]), f);
  const cs = Math.cos(rot), sn = Math.sin(rot);
  // T(p·f) · T(anchor) · R · S · T(-anchor)
  const a = cs * sx, b = sn * sx, c = -sn * sy, d = cs * sy;
  return [a, b, c, d, px * f + ax - (a * ax + c * ay), py * f + ay - (b * ax + d * ay)];
}
/** The repeater transform applied k times (k real). Uniform scale: exact (complex power); otherwise integer steps + a fraction. */
export function repeaterMatrix(r: Repeater, k: number): M2 {
  const sc = r.scale ?? 1, uni = typeof sc === 'number' || Math.abs(sc[0] - sc[1]) < 1e-9;
  if (uni) {
    const s = Math.max(1e-6, typeof sc === 'number' ? sc : sc[0]), th = r.rotation ?? 0;
    const [px, py] = r.position ?? [0, 0], [ax, ay] = r.anchor ?? [0, 0];
    // z → a z + b, a = s e^{iθ}, b = p + anchor − a·anchor;  k times: a^k z + b (1 − a^k) / (1 − a)
    const ar = s * Math.cos(th), ai = s * Math.sin(th);
    const br = px + ax - (ar * ax - ai * ay), bi = py + ay - (ar * ay + ai * ax);
    const sk = Math.pow(s, k), kr = sk * Math.cos(k * th), ki = sk * Math.sin(k * th);
    let tr: number, ti: number;
    const dr = 1 - ar, di = -ai, dd = dr * dr + di * di;
    if (dd < 1e-14) { tr = k * br; ti = k * bi; }
    else {
      const nr = 1 - kr, ni = -ki; // (1 − a^k) / (1 − a)
      const qr = (nr * dr + ni * di) / dd, qi = (ni * dr - nr * di) / dd;
      tr = br * qr - bi * qi; ti = br * qi + bi * qr;
    }
    return [kr, ki, -ki, kr, tr, ti];
  }
  const n = Math.floor(k), f = k - n;
  const step = repStep(r, 1), st = n >= 0 ? step : inv(step);
  let M: M2 = [1, 0, 0, 1, 0, 0];
  for (let i = 0; i < Math.abs(n); i++) M = mul(st, M);
  return f > 1e-9 ? mul(M, repStep(r, f)) : M;
}

// ---------------------------------------------------------------- draw

export interface ShapeStyle {
  fill?: Paint;
  fillRule?: CanvasFillRule;
  stroke?: StrokeStyle;
  /** Stroke under the fill (default: over). */
  strokeUnder?: boolean;
  trim?: Trim;
  wiggle?: Wiggle;
  repeater?: Repeater;
  opacity?: number;
  /** Flattening tolerance in screen px (default 0.2). */
  tol?: number;
}

/** Device px per local unit under the context's current transform (Layer2D: logical px × SCALE). */
function devScale(c: CanvasRenderingContext2D): number {
  const m = c.getTransform();
  return Math.max(1e-6, Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) * SCALE);
}

/**
 * Draw a shape: path(s) → wiggle → trim → fill and stroke → repeater (see the top of the file). Returns the trimmed
 * pieces (in the shape's own coordinates, before the repeater).
 */
export function drawShape(c: CanvasRenderingContext2D, src: Path | Flat | readonly (Path | Flat)[], st: ShapeStyle = {}, t = 0): Piece[] {
  const ds = devScale(c), tol = (st.tol ?? 0.2) / ds;
  let flat: Flat;
  if (src instanceof Path) flat = src.flat(tol);
  else if (src.length && (src[0] instanceof Path || Array.isArray(src[0]))) flat = (src as readonly (Path | Flat)[]).flatMap((s) => toFlat(s, tol));
  else flat = src as Flat;
  if (st.wiggle && st.wiggle.amount) flat = wigglePath(flat, st.wiggle, t, 1.5 / ds);
  const pieces = trimPath(flat, st.trim);
  if (!pieces.length) return pieces;
  const fp = st.fill ? fillGeom(pieces) : null;
  const sg = st.stroke && st.stroke.width > 0 ? strokeGeom(pieces, st.stroke) : null;
  const fillPaint = st.fill ? paintOf(c, st.fill) : null;
  const strokePaint = sg ? paintOf(c, st.stroke!.color) : null;
  const paint = () => {
    const doStroke = () => {
      if (!sg) return;
      const so = st.stroke!, a0 = c.globalAlpha;
      c.globalAlpha = a0 * (so.opacity ?? 1);
      if (sg.filled) { c.fillStyle = strokePaint!; c.fill(sg.path, 'nonzero'); }
      else {
        c.strokeStyle = strokePaint!;
        c.lineWidth = so.width;
        c.lineCap = so.cap ?? 'round';
        c.lineJoin = so.join ?? 'round';
        c.miterLimit = so.miterLimit ?? 4;
        c.setLineDash([]);
        c.stroke(sg.path);
      }
      c.globalAlpha = a0;
    };
    if (st.strokeUnder) doStroke();
    if (fp) { c.fillStyle = fillPaint!; c.fill(fp, st.fillRule ?? 'nonzero'); }
    if (!st.strokeUnder) doStroke();
  };
  c.save();
  c.globalAlpha *= clamp(st.opacity ?? 1);
  const R = st.repeater;
  if (R && R.copies > 0) {
    const n = Math.ceil(R.copies - 1e-9), frac = R.copies - (n - 1), base = c.globalAlpha;
    const so = R.startOpacity ?? 1, eo = R.endOpacity ?? 1;
    for (let q = 0; q < n; q++) {
      const i = R.order === 'below' ? n - 1 - q : q;
      let a = n > 1 ? lerp(so, eo, i / (n - 1)) : so;
      if (i === n - 1) a *= clamp(frac);
      if (a <= 1 / 512) continue;
      c.save();
      c.transform(...repeaterMatrix(R, i + (R.offset ?? 0)));
      c.globalAlpha = base * clamp(a);
      paint();
      c.restore();
    }
  } else paint();
  c.restore();
  return pieces;
}

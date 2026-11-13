// 形状层的路径运算（AE 形状层「添加」菜单里的那几个）：圆角、收缩和膨胀、扭转、锯齿、位移路径、合并路径。
// drawShape（engine/shape.ts）的 style.ops 按数组顺序做（像 AE 里从上往下），style.merge 合并几条路径的填充。也可以单独用：
//   flat = applyOps(path.flat(0.2), [{ type: 'roundCorners', radius: 12 }, { type: 'zigzag', size: 6, ridges: 40 }]);
//
//   roundCorners  radius：尖角（拐过 12° 以上的点）换成这个半径的圆弧；曲线上的点不动
//   puckerBloat   amount（−1…1，AE 的值 ÷ 100）：< 0 收缩（顶点往外、边往里凹，像星形），> 0 膨胀（顶点往里、边往外鼓）。
//                 按路径命令算（Path 来源才有命令；已经拍平的路径把每个点当顶点），中心是顶点的平均
//   twist         angle（度，顺时针为正）、center（默认路径包围盒中心）、radius（默认最远的点）：越靠中心转得越多
//   zigzag        size（px，起伏的高）、ridges 10（每条子路径几个起伏；闭合路径取整，首尾接得上）、points 'corner' | 'smooth'
//   offset        amount（px，> 0 往外扩、< 0 往里收）、join 'miter' | 'round' | 'bevel'、miterLimit 4：只对闭合的子路径；
//                 往里收得比窄处还多时会自交（AE 会清掉，这里不清）
//   merge（style.merge）'add' | 'subtract' | 'intersect' | 'exclude'：drawShape 传进来的几条路径，第一条和后面的依次合并
//                 （相加、减去、相交、排除重叠）。填充按像素合并；描边沿合并后的外轮廓（mergedOutline：各条路径上
//                 结果「一边在里、一边在外」的那几段，交点二分求出），虚线、渐细、描边生长照常
import type { Flat, PathCmd, Sub } from './shape';

type V2 = readonly [number, number];

export type PathOp =
  | { type: 'roundCorners'; radius: number }
  | { type: 'puckerBloat'; amount: number }
  | { type: 'twist'; angle: number; center?: V2; radius?: number }
  | { type: 'zigzag'; size: number; ridges?: number; points?: 'corner' | 'smooth' }
  | { type: 'offset'; amount: number; join?: 'miter' | 'round' | 'bevel'; miterLimit?: number };

export type MergeMode = 'add' | 'subtract' | 'intersect' | 'exclude';

function mkSub(X: number[], Y: number[], closed: boolean): Sub | null {
  let n = X.length;
  if (closed && n > 1 && Math.abs(X[0]! - X[n - 1]!) < 1e-7 && Math.abs(Y[0]! - Y[n - 1]!) < 1e-7) { X.pop(); Y.pop(); n--; }
  if (!n) return null;
  const cl = closed && n > 2, cnt = cl ? n + 1 : n, s = new Float64Array(cnt);
  for (let i = 1; i < n; i++) s[i] = s[i - 1]! + Math.hypot(X[i]! - X[i - 1]!, Y[i]! - Y[i - 1]!);
  if (cl) s[n] = s[n - 1]! + Math.hypot(X[0]! - X[n - 1]!, Y[0]! - Y[n - 1]!);
  return { x: Float64Array.from(X), y: Float64Array.from(Y), s, closed: cl, len: s[cnt - 1]! };
}

/** The point at arc length `d` along a subpath (wrapping round a closed one) and the unit tangent there. */
function along(sb: Sub, d: number): [number, number, number, number] {
  const n = sb.x.length, segs = sb.closed ? n : n - 1;
  if (segs < 1) return [sb.x[0]!, sb.y[0]!, 1, 0];
  if (sb.closed) d = ((d % sb.len) + sb.len) % sb.len; else d = Math.min(sb.len, Math.max(0, d));
  let lo = 0, hi = segs - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (sb.s[m]! <= d) lo = m; else hi = m - 1; }
  const i = lo, j = (i + 1) % n, L = sb.s[i + 1]! - sb.s[i]!, u = L > 0 ? (d - sb.s[i]!) / L : 0;
  const dx = sb.x[j]! - sb.x[i]!, dy = sb.y[j]! - sb.y[i]!, l = Math.hypot(dx, dy) || 1;
  return [sb.x[i]! + dx * u, sb.y[i]! + dy * u, dx / l, dy / l];
}

/** Twice the signed area (y down: > 0 = clockwise on screen). */
function area2(sb: Sub) {
  let a = 0;
  const n = sb.x.length;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += sb.x[i]! * sb.y[j]! - sb.x[j]! * sb.y[i]!; }
  return a;
}

function roundCorners(f: Flat, r: number): Flat {
  if (r <= 0) return f;
  return f.map((sb) => {
    const n = sb.x.length, X: number[] = [], Y: number[] = [];
    if (n < 3) return sb;
    for (let i = 0; i < n; i++) {
      const end = !sb.closed && (i === 0 || i === n - 1);
      const px = sb.x[(i - 1 + n) % n]!, py = sb.y[(i - 1 + n) % n]!, vx = sb.x[i]!, vy = sb.y[i]!, nx = sb.x[(i + 1) % n]!, ny = sb.y[(i + 1) % n]!;
      const ax = vx - px, ay = vy - py, bx = nx - vx, by = ny - vy, la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (end || la < 1e-9 || lb < 1e-9) { X.push(vx); Y.push(vy); continue; }
      const ux = ax / la, uy = ay / la, wx = bx / lb, wy = by / lb;
      const turn = Math.acos(Math.max(-1, Math.min(1, ux * wx + uy * wy)));
      if (turn < 0.21) { X.push(vx); Y.push(vy); continue; }
      // the corner's interior angle phi; cut back d along both edges, arc of radius re between the cut points
      const phi = Math.PI - turn, d = Math.min(r / Math.tan(phi / 2), la / 2, lb / 2), re = d * Math.tan(phi / 2);
      const p1x = vx - ux * d, p1y = vy - uy * d, p2x = vx + wx * d, p2y = vy + wy * d;
      const cr = ux * wy - uy * wx, sgn = cr > 0 ? 1 : -1;
      const cx = p1x - uy * re * sgn, cy = p1y + ux * re * sgn;
      const a0 = Math.atan2(p1y - cy, p1x - cx), a1 = Math.atan2(p2y - cy, p2x - cx);
      let da = a1 - a0; if (sgn > 0 && da < 0) da += 2 * Math.PI; if (sgn < 0 && da > 0) da -= 2 * Math.PI;
      const k = Math.max(2, Math.ceil(Math.abs(da) / 0.12));
      for (let q = 0; q <= k; q++) { const a = a0 + (da * q) / k; X.push(cx + Math.cos(a) * re); Y.push(cy + Math.sin(a) * re); }
    }
    return mkSub(X, Y, sb.closed) ?? sb;
  });
}

/** Pucker & bloat on commands (AE / Lottie): vertices move toward the centre by amount, control points away by amount. */
export function puckerCmds(cmds: readonly PathCmd[], amount: number): PathCmd[] {
  if (!amount) return cmds as PathCmd[];
  let sx = 0, sy = 0, n = 0;
  for (const c of cmds) if (c.type !== 'Z') { sx += c.x; sy += c.y; n++; }
  if (!n) return cmds as PathCmd[];
  const cx = sx / n, cy = sy / n;
  const v = (x: number, y: number): [number, number] => [x + (cx - x) * amount, y + (cy - y) * amount];
  const h = (x: number, y: number): [number, number] => [x - (cx - x) * amount, y - (cy - y) * amount];
  const out: PathCmd[] = [];
  let px = 0, py = 0, mx = 0, my = 0;
  for (const c of cmds) {
    if (c.type === 'M') { const [x, y] = v(c.x, c.y); out.push({ type: 'M', x, y }); px = mx = c.x; py = my = c.y; continue; }
    if (c.type === 'Z') {
      // the closing edge as a curve too
      if (Math.hypot(px - mx, py - my) > 1e-9) { const [a, b] = h(px, py), [e, f] = h(mx, my), [x, y] = v(mx, my); out.push({ type: 'C', x1: a, y1: b, x2: e, y2: f, x, y }); }
      out.push({ type: 'Z' }); px = mx; py = my; continue;
    }
    // straight edges: handles at the ends (a straight cubic), so they bow as the handles move
    const [x1, y1] = c.type === 'C' ? [c.x1, c.y1] : c.type === 'Q' ? [px + (2 / 3) * (c.x1 - px), py + (2 / 3) * (c.y1 - py)] : [px, py];
    const [x2, y2] = c.type === 'C' ? [c.x2, c.y2] : c.type === 'Q' ? [c.x + (2 / 3) * (c.x1 - c.x), c.y + (2 / 3) * (c.y1 - c.y)] : [c.x, c.y];
    const [a, b] = h(x1, y1), [e, f] = h(x2, y2), [x, y] = v(c.x, c.y);
    out.push({ type: 'C', x1: a, y1: b, x2: e, y2: f, x, y });
    px = c.x; py = c.y;
  }
  return out;
}

/** Points no more than `step` apart (so a twist can bend straight edges). */
function densify(sb: Sub, step: number): Sub {
  const n = sb.x.length, X: number[] = [], Y: number[] = [], segs = sb.closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n, L = Math.hypot(sb.x[j]! - sb.x[i]!, sb.y[j]! - sb.y[i]!), k = Math.max(1, Math.ceil(L / step));
    for (let q = 0; q < k; q++) { X.push(sb.x[i]! + ((sb.x[j]! - sb.x[i]!) * q) / k); Y.push(sb.y[i]! + ((sb.y[j]! - sb.y[i]!) * q) / k); }
  }
  if (!sb.closed) { X.push(sb.x[n - 1]!); Y.push(sb.y[n - 1]!); }
  return mkSub(X, Y, sb.closed) ?? sb;
}

function twist(f: Flat, o: Extract<PathOp, { type: 'twist' }>, tol: number): Flat {
  if (!o.angle) return f;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const sb of f) for (let i = 0; i < sb.x.length; i++) { x0 = Math.min(x0, sb.x[i]!); x1 = Math.max(x1, sb.x[i]!); y0 = Math.min(y0, sb.y[i]!); y1 = Math.max(y1, sb.y[i]!); }
  const [cx, cy] = o.center ?? [(x0 + x1) / 2, (y0 + y1) / 2];
  let R = o.radius ?? 0;
  if (!R) for (const sb of f) for (let i = 0; i < sb.x.length; i++) R = Math.max(R, Math.hypot(sb.x[i]! - cx, sb.y[i]! - cy));
  const A = (o.angle * Math.PI) / 180, step = Math.max(tol * 8, 1);
  return f.map((s0) => {
    const sb = densify(s0, step), X: number[] = [], Y: number[] = [];
    for (let i = 0; i < sb.x.length; i++) {
      const dx = sb.x[i]! - cx, dy = sb.y[i]! - cy, k = Math.max(0, 1 - Math.hypot(dx, dy) / Math.max(R, 1e-6)), a = A * k * k;
      X.push(cx + dx * Math.cos(a) - dy * Math.sin(a)); Y.push(cy + dx * Math.sin(a) + dy * Math.cos(a));
    }
    return mkSub(X, Y, sb.closed) ?? sb;
  });
}

function zigzag(f: Flat, o: Extract<PathOp, { type: 'zigzag' }>): Flat {
  if (!o.size) return f;
  const smooth = o.points === 'smooth';
  return f.map((sb) => {
    if (sb.len <= 0) return sb;
    const R = Math.max(1, sb.closed ? Math.round(o.ridges ?? 10) : (o.ridges ?? 10));
    const per = smooth ? 12 : 2, N = Math.ceil(R * per), X: number[] = [], Y: number[] = [];
    for (let k = 0; k <= (sb.closed ? N - 1 : N); k++) {
      const u = k / N, [x, y, tx, ty] = along(sb, u * sb.len);
      const w = smooth ? Math.sin(u * R * 2 * Math.PI) : (k % 2 === 0 ? 1 : -1);
      X.push(x - ty * o.size * w); Y.push(y + tx * o.size * w);
    }
    return mkSub(X, Y, sb.closed) ?? sb;
  });
}

function offset(f: Flat, o: Extract<PathOp, { type: 'offset' }>): Flat {
  const d = o.amount;
  if (!d) return f;
  const join = o.join ?? 'miter', lim = Math.max(1, o.miterLimit ?? 4);
  return f.map((sb) => {
    const n = sb.x.length;
    if (!sb.closed || n < 3) return sb;
    const s = area2(sb) > 0 ? 1 : -1;
    // the outward normal of edge i (i → i+1)
    const nrm = (i: number): [number, number] => {
      const j = (i + 1) % n, dx = sb.x[j]! - sb.x[i]!, dy = sb.y[j]! - sb.y[i]!, l = Math.hypot(dx, dy) || 1;
      return [(dy / l) * s, (-dx / l) * s];
    };
    const X: number[] = [], Y: number[] = [];
    for (let i = 0; i < n; i++) {
      const [ax, ay] = nrm((i - 1 + n) % n), [bx, by] = nrm(i), vx = sb.x[i]!, vy = sb.y[i]!;
      const dot = ax * bx + ay * by, cr = ax * by - ay * bx;
      // the gap opens on this side of the corner: join it; otherwise the edges overlap: their miter point
      const opens = cr * s * Math.sign(d) > 1e-6;
      if (opens && join === 'round') {
        const a0 = Math.atan2(ay, ax); let da = Math.atan2(by, bx) - a0;
        while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
        const k = Math.max(1, Math.ceil(Math.abs(da) / 0.15));
        for (let q = 0; q <= k; q++) { const a = a0 + (da * q) / k; X.push(vx + Math.cos(a) * d); Y.push(vy + Math.sin(a) * d); }
        continue;
      }
      const mx = ax + bx, my = ay + by, ml = 1 + dot, ratio = ml > 1e-9 ? Math.sqrt(2 / ml) : Infinity;
      if (opens ? join === 'miter' && ratio <= lim : ratio <= 50) { X.push(vx + (mx / ml) * d); Y.push(vy + (my / ml) * d); continue; }
      X.push(vx + ax * d, vx + bx * d); Y.push(vy + ay * d, vy + by * d);
    }
    return mkSub(X, Y, true) ?? sb;
  });
}

/** Apply path operators in order (puckerBloat on already-flat input treats every point as a vertex). */
export function applyOps(f: Flat, ops: readonly PathOp[] | undefined, tol = 0.2): Flat {
  if (!ops?.length) return f;
  for (const o of ops) {
    if (o.type === 'roundCorners') f = roundCorners(f, o.radius);
    else if (o.type === 'twist') f = twist(f, o, tol);
    else if (o.type === 'zigzag') f = zigzag(f, o);
    else if (o.type === 'offset') f = offset(f, o);
    else if (o.type === 'puckerBloat' && o.amount) {
      let sx = 0, sy = 0, n = 0;
      for (const sb of f) for (let i = 0; i < sb.x.length; i++) { sx += sb.x[i]!; sy += sb.y[i]!; n++; }
      const cx = sx / Math.max(1, n), cy = sy / Math.max(1, n), k = o.amount;
      f = f.map((sb) => mkSub(Array.from(sb.x, (x) => x + (cx - x) * k), Array.from(sb.y, (y) => y + (cy - y) * k), sb.closed) ?? sb);
    }
  }
  return f;
}

/** A flat as a Path2D (closed subpaths closed). */
export function flatPath2D(f: Flat): Path2D {
  const p = new Path2D();
  for (const sb of f) {
    if (!sb.x.length) continue;
    p.moveTo(sb.x[0]!, sb.y[0]!);
    for (let i = 1; i < sb.x.length; i++) p.lineTo(sb.x[i]!, sb.y[i]!);
    if (sb.closed) p.closePath();
  }
  return p;
}

let probe: CanvasRenderingContext2D | null = null;

/**
 * The outline of a merge (Merge Paths' result) as polylines: the parts of the sources' outlines where the merged
 * region is inside on one side and outside on the other. Membership is exact (each source's isPointInPath with the
 * fill rule, combined like the merge); along each edge it is sampled every `step` local units and the switches are
 * found by bisection, so the outline ends where the outlines cross. A run that goes all the way round stays closed.
 */
export function mergedOutline(groups: readonly Flat[], mode: MergeMode, rule: CanvasFillRule = 'nonzero', step = 4): Flat {
  if (!probe) { const cv = document.createElement('canvas'); cv.width = cv.height = 1; probe = cv.getContext('2d')!; }
  const pc = probe;
  pc.setTransform(1, 0, 0, 1, 0, 0);
  const paths = groups.map((g) => flatPath2D(g.map((sb) => (sb.closed ? sb : { ...sb, closed: true }))));
  const inside = (x: number, y: number) => {
    let r = pc.isPointInPath(paths[0]!, x, y, rule);
    for (let k = 1; k < paths.length; k++) {
      const v = pc.isPointInPath(paths[k]!, x, y, rule);
      r = mode === 'add' ? r || v : mode === 'subtract' ? r && !v : mode === 'intersect' ? r && v : r !== v;
    }
    return r;
  };
  const eps = Math.max(1e-3, step * 0.15);
  const out: Flat = [];
  for (const g of groups) for (const sb of g) {
    const n = sb.x.length;
    if (n < 2) continue;
    // sample points along the loop (every vertex, long edges split), each with "is this on the merged boundary"
    const X: number[] = [], Y: number[] = [], on: boolean[] = [];
    const edge = (i: number) => {
      const j = (i + 1) % n, ax = sb.x[i]!, ay = sb.y[i]!, bx = sb.x[j]!, by = sb.y[j]!, L = Math.hypot(bx - ax, by - ay);
      return { ax, ay, bx, by, L, tx: L > 0 ? (bx - ax) / L : 1, ty: L > 0 ? (by - ay) / L : 0 };
    };
    const onAt = (e: ReturnType<typeof edge>, u: number) => {
      const x = e.ax + (e.bx - e.ax) * u, y = e.ay + (e.by - e.ay) * u;
      return inside(x - e.ty * eps, y + e.tx * eps) !== inside(x + e.ty * eps, y - e.tx * eps);
    };
    // where along edge e (between u = lo, state !o, and u = hi, state o) the state switches: put both sides' points there
    const cut = (e: ReturnType<typeof edge>, lo: number, hi: number, o: boolean) => {
      for (let it = 0; it < 16; it++) { const m = (lo + hi) / 2; if (onAt(e, m) === o) hi = m; else lo = m; }
      const m = (lo + hi) / 2, x = e.ax + (e.bx - e.ax) * m, y = e.ay + (e.by - e.ay) * m;
      X.push(x, x); Y.push(y, y); on.push(!o, o);
    };
    let prev: { e: ReturnType<typeof edge>; u: number } | null = null;
    for (let i = 0; i < n; i++) {
      const e = edge(i);
      if (e.L < 1e-9) continue;
      const k = Math.max(1, Math.ceil(e.L / step));
      for (let q = 0; q < k; q++) {
        const u = (q + 0.5) / k, o = onAt(e, u);
        if (on.length && on[on.length - 1] !== o) {
          // the switch is on this edge before u, or (first sample of the edge) maybe at the end of the last edge
          if (q > 0) cut(e, (q - 0.5) / k, u, o);
          else if (onAt(e, 1e-6) === o && prev) cut(prev.e, prev.u, 1, o);
          else cut(e, 0, u, o);
        }
        if (q === 0) { X.push(e.ax); Y.push(e.ay); on.push(o); }
        X.push(e.ax + (e.bx - e.ax) * u); Y.push(e.ay + (e.by - e.ay) * u); on.push(o);
        prev = { e, u };
      }
    }
    // runs of "on" points become polylines; starting just after an "off" point, the run across the loop's start is whole
    const m = X.length;
    if (!m) continue;
    if (on.every(Boolean)) { const s = mkSub(X, Y, true); if (s) out.push(s); continue; }
    const s0 = on.findIndex((v) => !v);
    let RX: number[] = [], RY: number[] = [];
    const flush = () => { if (RX.length > 1) { const s = mkSub(RX, RY, false); if (s) out.push(s); } RX = []; RY = []; };
    for (let c = 1; c <= m; c++) {
      const i = (s0 + c) % m;
      if (on[i]) { RX.push(X[i]!); RY.push(Y[i]!); } else flush();
    }
    flush();
  }
  return chain(out, Math.max(step * 0.5, 1e-3));
}

/** Join open polylines whose ends meet (within `tol`; reversing as needed) into longer ones, closing loops. */
function chain(subs: Flat, tol: number): Flat {
  const open = subs.filter((s) => !s.closed).map((s) => ({ x: Array.from(s.x), y: Array.from(s.y) }));
  const done: Flat = subs.filter((s) => s.closed);
  const near = (ax: number, ay: number, bx: number, by: number) => Math.abs(ax - bx) <= tol && Math.abs(ay - by) <= tol;
  while (open.length) {
    const cur = open.pop()!;
    for (let grew = true; grew;) {
      grew = false;
      const ex = cur.x[cur.x.length - 1]!, ey = cur.y[cur.y.length - 1]!;
      if (cur.x.length > 2 && near(ex, ey, cur.x[0]!, cur.y[0]!)) break;
      for (let k = 0; k < open.length; k++) {
        const o = open[k]!, n = o.x.length;
        let add: [number[], number[]] | null = null;
        if (near(ex, ey, o.x[0]!, o.y[0]!)) add = [o.x.slice(1), o.y.slice(1)];
        else if (near(ex, ey, o.x[n - 1]!, o.y[n - 1]!)) add = [o.x.slice(0, -1).reverse(), o.y.slice(0, -1).reverse()];
        if (add) { cur.x.push(...add[0]); cur.y.push(...add[1]); open.splice(k, 1); grew = true; break; }
      }
    }
    const n = cur.x.length, closed = n > 2 && near(cur.x[n - 1]!, cur.y[n - 1]!, cur.x[0]!, cur.y[0]!);
    const s = mkSub(cur.x, cur.y, closed);
    if (s) done.push(s);
  }
  return done;
}

let scratch: HTMLCanvasElement | null = null;
const OPS: Record<MergeMode, GlobalCompositeOperation> = { add: 'source-over', subtract: 'destination-out', intersect: 'destination-in', exclude: 'xor' };

/** Fill the merge of `groups` (first, then each next by `mode`) with `paint`, in c's current transform and alpha. */
export function fillMerged(c: CanvasRenderingContext2D, groups: readonly Path2D[], mode: MergeMode, paint: string | CanvasGradient | CanvasPattern, rule: CanvasFillRule = 'nonzero') {
  if (!groups.length) return;
  const w = c.canvas.width, h = c.canvas.height;
  scratch ??= document.createElement('canvas');
  if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h; }
  const m = scratch.getContext('2d')!, T = c.getTransform();
  m.setTransform(1, 0, 0, 1, 0, 0); m.globalCompositeOperation = 'source-over'; m.clearRect(0, 0, w, h);
  m.setTransform(T);
  groups.forEach((g, i) => { m.globalCompositeOperation = i === 0 ? 'source-over' : OPS[mode]; m.fillStyle = '#fff'; m.fill(g, rule); });
  // the paint (gradients in local units) only where the mask is
  m.globalCompositeOperation = 'source-in';
  m.fillStyle = paint;
  const inv = T.inverse(), cs = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => inv.transformPoint({ x: x!, y: y! }));
  const xs = cs.map((p) => p.x), ys = cs.map((p) => p.y);
  m.fillRect(Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  m.globalCompositeOperation = 'source-over';
  c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.drawImage(scratch, 0, 0); c.restore();
}

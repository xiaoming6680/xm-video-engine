// 手绘感（手書き / tegaki）：纸上逐张手画的线。压力笔刷、线条沸腾、摄影表、填色错位、纸齿、特写补偿、smear 帧，
// 再加手绘 MV 常画的点缀（速度线、手画太阳、泪珠、名牌、墨点、手写歌词）。输出只取决于 t（确定性）。
//
// 为什么要它：代码画的线一眼假，毛病在三处——线宽恒定（真笔有起笔收笔、有轻重）；每个点各自随机抖（像电流；
// 真的“沸腾”是整张画重描一遍，相邻的点、相邻的线往同一个方向偏）；抖动每一步都是新的（真动画定格时只在几张画
// 之间循环）。下面的 ink* 笔刷参考 mg-styles-15 demos/05-cel-boil（MIT，Vincentwei1021）的 engine.js 重写：
//   · 沸腾 boil：世界坐标上的平滑噪声场（幅度约 2.2 px、尺度约 70 px）把线推开，每张画换一个场
//   · 笔刷 inkStroke：中心线展开成两端圆头的多边形；线宽 = 压力噪声 ±35% × 起笔 14 px / 收笔 26 px 锥度
//     （最细 0.25）× 背光一侧（右下）加粗 35%
//   · 闭合形 inkLoop：拆成 1–2 笔、接缝处过冲 2.5 px；直边 inkEdge 在角点出头约 7 px；
//     填色 inkFill 单独沸腾、整体错位 (-5, 4) px（手工上色没对准）；排线 inkHatch
//   · 摄影表 celDrawing：一拍一 / 二 / 四分段（util 的 stepT），沸腾在 4 张画之间循环，定格时 3 张
//   · 纸齿 paperTooth：纸纹 multiply 约 0.5 盖在墨线上，每张画换一次偏移（每张画是一张新纸）
//   · 特写补偿 closeUp：镜头推近时线宽、抖幅跟着缩小（1.86 倍时 ×0.59、×0.55），屏幕上的线粗不变
//   · smear 帧 smearShape：快动作最快的那一张拉长约 300%（或画 3 个残影），只出现一张
//   · 手写字：inkText 用单线字体一笔笔写出来，textLoops 把字体轮廓变成可描线、可填色的闭合线
//
//   const d = celDrawing(f.t, [[0, 12], [1.5, 30], [2, 12], [6, 6]]);  // 一拍二 → 一拍一 → 一拍二 → 定格
//   closeUp(cam.zoom);                                                   // 每帧先设（推近时线不变粗）
//   inkFill(c, shape, CEL.red, { seed: 10 + d.v });                      // 填色（错位、单独沸腾）
//   inkLoop(c, shape, { seed: 20 + d.v, w: 5 });                         // 描线
//   paperTooth(c, sheet, d.v);                                           // 最后盖纸齿（sheet = await loadPaper()）
//
// 速写墨线 sketchLine（If The Sun Burns Out 页面上的涂鸦：计分划、手画奖杯、准星、枪的轮廓）：比 inkStroke 轻，
// 逐张重新抖、每段一个笔压（0.7–1.6 倍）、长边转角出头、淡淡的第二笔，可按比例画出来；抖幅 jit 可调（细小的记号 1 px）。
// 旧的 penLine / penCircle / speedLines / penSun……是 Still_Shining v2.0 的样子（等宽线、逐点抖），保留原样；
// 新片用 ink* 系列。TG_FPS 从 8 改成 12：8 张 / 秒在 60 fps 下每张画交替停 7、8 帧，动作会顿。
// 单线字体按需加载：场景 init() 里 `await loadStrokeFonts()`（../engine/stroke）。
import { W, H, SCALE } from '../../engine/gl';
import type { Line } from '../../engine/lyrics';
import { textPathCommands } from '../../engine/type';
import { strokeText, drawStrokeText, writtenLength, type StrokeText } from '../engine/stroke';
import { clamp, hash, lerp, mod, noise1, noise2, shutterT, smoothstep, stepT } from '../../engine/util';
import { lineProgress } from './lyrics-kit';

/**
 * Drawings per second: 24 fps animation on twos. Must divide the export fps (it was 8, "on threes", which at 60 fps
 * holds the drawings 7 and 8 frames in turn: the motion limps).
 */
export const TG_FPS = 12;
/** The drawing step at time t (changes TG_FPS times a second; crisp: a frame shows one drawing, never two blended). */
export const tgStep = (t: number) => Math.floor(shutterT(t, 0) * TG_FPS + 1e-6);
/** Time quantized to the drawing step (motion on twos). */
export const tgTime = (t: number) => stepT(t, TG_FPS);

export const INK = '#16161c';
export const RED = '#d0202e';
export const BLUE = '#2a5bd7';
export const PAPER = '#f6f1e7';
/**
 * Hand-written Chinese face. Still_Shining used the user's 华文行楷 (STXingkai, commercial: add it per project via
 * src/config.ts EXTRA_FONTS); without it the text falls back to Noto Serif SC. An OFL brush face (Zhi Mang Xing,
 * Ma Shan Zheng, docs/archive/方法.md) works too: put the file in public/fonts and its family here.
 */
export const HAND_ZH = '"STXingkai", "NotoSerifSC-600"';

/** Deterministic jitter in [-1, 1] for an element on a drawing step. */
export const jit = (step: number, i: number, k = 0) => hash(step * 1.618 + k * 9.7, i * 3.3 + k) * 2 - 1;

let paperCanvas: HTMLCanvasElement | null = null;
/** Off-white paper with fibres and a faint tooth (made once). */
export function paper(): HTMLCanvasElement {
  if (paperCanvas) return paperCanvas;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d')!;
  x.fillStyle = PAPER;
  x.fillRect(0, 0, W, H);
  const img = x.getImageData(0, 0, W, H), d = img.data;
  for (let i = 0; i < W * H; i++) {
    const n = (hash(i % W, Math.floor(i / W)) - 0.5) * 10;
    d[i * 4] += n; d[i * 4 + 1] += n; d[i * 4 + 2] += n * 0.9;
  }
  x.putImageData(img, 0, 0);
  x.globalAlpha = 0.06;
  x.strokeStyle = '#8a7f6a';
  for (let i = 0; i < 600; i++) {
    const px = hash(i, 1) * W, py = hash(i, 2) * H, a = hash(i, 3) * Math.PI, l = 8 + 30 * hash(i, 4);
    x.lineWidth = 0.6;
    x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l); x.stroke();
  }
  // a soft darkening at the edges (scanned-page feel)
  const g = x.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(90,70,40,0.12)');
  x.globalAlpha = 1; x.fillStyle = g; x.fillRect(0, 0, W, H);
  paperCanvas = c;
  return c;
}

/** A pen line through points, wobbled per drawing step (re-drawn by hand every frame of the drawing). */
export function penLine(c: CanvasRenderingContext2D, pts: [number, number][], step: number, seed: number, w = 3, color = INK, wob = 2.2) {
  c.save();
  c.strokeStyle = color;
  c.lineWidth = w;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.beginPath();
  pts.forEach(([x, y], i) => {
    const px = x + jit(step, i, seed) * wob, py = y + jit(step, i + 50, seed) * wob;
    if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
  });
  c.stroke();
  c.restore();
}

/**
 * A quick ink line, lighter than inkStroke: the points jittered afresh every drawing (±jit / 2 px: the line boils, as
 * drawn on twos), drawn on to fraction k of its length; each segment has its own pen pressure (0.7–1.6 × w), segments
 * longer than 24 px overshoot their corner by 4 px, and a faint second pass (30 %, offset 1.2, −0.8) runs beside it, a
 * pen going over it twice. step: the drawing number (tgStep, or typewarp's drawing); the stroke colour is c's own.
 */
export function sketchLine(c: CanvasRenderingContext2D, pts: readonly (readonly [number, number])[], step: number,
  o: { k?: number; seed?: number; closed?: boolean; w?: number; jit?: number } = {}) {
  const k = o.k ?? 1, seed = o.seed ?? 0, w = o.w ?? 2.2, jit = o.jit ?? 2.4;
  if (k <= 0 || pts.length < 2) return;
  const P = o.closed ? [...pts, pts[0]!] : pts;
  const J = P.map(([x, y], i): [number, number] => [x + (hash(i, step, seed) - 0.5) * jit, y + (hash(i, step, seed + 1) - 0.5) * jit]);
  const L = J.slice(1).map((q, i) => Math.hypot(q[0] - J[i]![0], q[1] - J[i]![1])), total = L.reduce((a, b) => a + b, 0);
  for (const [a, dx, dy] of [[1, 0, 0], [0.3, 1.2, -0.8]] as const) {
    c.save(); c.globalAlpha *= a; c.lineJoin = 'round'; c.lineCap = 'round';
    let left = total * Math.min(1, k);
    for (let i = 1; i < J.length && left > 0; i++) {
      const l = L[i - 1]!, f = Math.min(1, left / Math.max(l, 1e-6));
      const ux = (J[i]![0] - J[i - 1]![0]) / Math.max(l, 1e-6), uy = (J[i]![1] - J[i - 1]![1]) / Math.max(l, 1e-6);
      const over = f >= 1 && l > 24 ? 4 : 0;
      c.lineWidth = w * (0.7 + 0.9 * hash(i, seed, 5));
      c.beginPath(); c.moveTo(J[i - 1]![0] + dx, J[i - 1]![1] + dy);
      c.lineTo(lerp(J[i - 1]![0], J[i]![0], f) + ux * over + dx, lerp(J[i - 1]![1], J[i]![1], f) + uy * over + dy); c.stroke();
      left -= l;
    }
    c.restore();
  }
}

/** A hand-drawn circle (slightly open, overshooting its start, wobbly). */
export function penCircle(c: CanvasRenderingContext2D, x: number, y: number, r: number, step: number, seed: number, w = 3, color = INK, turns = 1.08) {
  const pts: [number, number][] = [];
  const a0 = jit(0, 1, seed) * Math.PI;
  for (let i = 0; i <= 40; i++) {
    const a = a0 + (i / 40) * Math.PI * 2 * turns;
    const rr = r * (1 + 0.04 * Math.sin(a * 3 + seed) + 0.03 * jit(step, i, seed + 5));
    pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr]);
  }
  penLine(c, pts, step, seed, w, color, 0.8);
}

/**
 * Pen speed lines: strokes in lanes travelling along `dir` at `speed` px/s (smooth motion: they do not jump about
 * from step to step, which read as jitter); only their pen wobble follows the drawing step.
 */
export function speedLines(c: CanvasRenderingContext2D, dir: [number, number], step: number, n: number, color = INK, alpha = 0.55, clearR = 0, t = 0, speed = 1800) {
  const [dx, dy] = dir, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
  c.save();
  c.globalAlpha = alpha;
  for (let i = 0; i < n; i++) {
    const r1 = hash(i, 1), r2 = hash(i, 2), r3 = hash(i, 3);
    const tt = t * speed * (0.7 + 0.6 * r3);
    const wrap = (v: number, m: number) => ((v % m) + m) % m;
    const px = wrap(r1 * W + ux * tt, W + 400) - 200, py = wrap(r2 * H + uy * tt, H + 400) - 200;
    if (clearR > 0 && Math.hypot(px - W / 2, py - H / 2) < clearR) continue;
    const len = 80 + 260 * r3;
    penLine(c, [[px, py], [px + ux * len * 0.5, py + uy * len * 0.5], [px + ux * len, py + uy * len]], step, i, 1.5 + 2 * r3, color, 0.6);
  }
  c.restore();
}

/** A pen-drawn sun: a circle and uneven rays, slowly turning. */
export function penSun(c: CanvasRenderingContext2D, x: number, y: number, r: number, step: number, color = RED) {
  penCircle(c, x, y, r, step, 3, 4, color);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + step * 0.05;
    const r0 = r * 1.3, r1 = r * (1.7 + 0.35 * ((i % 2) ? 1 : 0.4) + 0.1 * jit(step, i, 4));
    penLine(c, [[x + Math.cos(a) * r0, y + Math.sin(a) * r0], [x + Math.cos(a) * r1, y + Math.sin(a) * r1]], step, i + 20, 3.5, color, 1.5);
  }
}

/** A tear bead, drawn: blue outline, a white highlight, a pale fill. */
export function penTear(c: CanvasRenderingContext2D, x: number, y: number, r: number, step: number, seed: number, a = 1) {
  if (r < 1 || a <= 0) return;
  c.save();
  c.globalAlpha = a;
  c.fillStyle = 'rgba(200,225,255,0.55)';
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  penCircle(c, x, y, r, step, seed, Math.max(1.5, r * 0.09), BLUE, 1.0);
  c.fillStyle = '#ffffff';
  c.beginPath(); c.ellipse(x - r * 0.35, y - r * 0.35, r * 0.22, r * 0.13, -0.6, 0, Math.PI * 2); c.fill();
  c.restore();
}

/** The name card, drawn: a wobbly white rectangle with a red band and the name written by hand. */
export function penCard(c: CanvasRenderingContext2D, x: number, y: number, w: number, rot: number, flip: number, name: string, step: number) {
  const h = w * 0.62, sx = Math.cos(flip);
  c.save();
  c.translate(x, y);
  c.rotate(rot);
  c.scale(Math.max(0.05, Math.abs(sx)), 1);
  c.fillStyle = '#ffffff';
  c.fillRect(-w / 2, -h / 2, w, h);
  c.fillStyle = RED;
  c.fillRect(-w / 2, -h / 2, w * 0.1, h);
  penLine(c, [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2], [-w / 2, -h / 2]], step, 7, Math.max(2, w * 0.012));
  if (sx > 0.3) {
    c.fillStyle = INK;
    c.font = `${w * 0.16}px ${HAND_ZH}`;
    c.textBaseline = 'middle';
    c.fillText(name, -w / 2 + w * 0.17, -h * 0.05);
  }
  c.restore();
}

/** An ink splash (impacts): blobs and flicks around a point, in the drawing step's shape. */
export function inkSplash(c: CanvasRenderingContext2D, x: number, y: number, r: number, step: number, color = RED, a = 1) {
  c.save();
  c.globalAlpha = a;
  c.fillStyle = color;
  for (let i = 0; i < 14; i++) {
    const ang = hash(i, 5) * Math.PI * 2, d = r * (0.3 + 0.9 * hash(i, 6)), s = r * (0.04 + 0.12 * hash(i, 7));
    c.beginPath(); c.arc(x + Math.cos(ang) * d + jit(step, i, 2) * 2, y + Math.sin(ang) * d + jit(step, i, 3) * 2, s, 0, Math.PI * 2); c.fill();
  }
  c.restore();
}

/**
 * Hand-lettered lyric: the English written by a pen (single-stroke script, each word while it is sung), the Chinese
 * in 华文行楷 below, each character appearing with the voice. Slightly tilted, re-jittered every drawing step.
 */
const stCache = new Map<string, StrokeText>();
export function handLyric(c: CanvasRenderingContext2D, L: Line, t: number, o: { x: number; y: number; size?: number; rot?: number; color?: string; zhColor?: string; maxWidth?: number; step: number }) {
  const size = o.size ?? 64;
  const key = `${L.i}:${size}`;
  let st = stCache.get(key);
  if (!st) { st = strokeText(L.text, 'hscript', size); stCache.set(key, st); }
  // char times from the word times
  const times: [number, number][] = [];
  let ci = 0;
  for (const w of L.words) {
    const n = Array.from(w.w).length;
    for (let k = 0; k < n; k++) times[ci + k] = [w.start + (k / n) * Math.min(0.25, w.end - w.start), w.start + ((k + 1) / n) * Math.min(0.25, w.end - w.start)];
    ci += n;
    times[ci] = [w.end, w.end];      // the space
    ci += 1;
  }
  const len = writtenLength(st, times, t);
  const maxW = o.maxWidth ?? 1300;
  const k = Math.min(1, maxW / st.width);
  c.save();
  c.translate(o.x, o.y);
  c.rotate(o.rot ?? -0.03);
  c.scale(k, k);
  c.strokeStyle = o.color ?? INK;
  c.lineWidth = size * 0.09;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  drawStrokeText(c, st, len);
  c.restore();
  if (L.zh) {
    const p = lineProgress(L, t);
    const chars = Array.from(L.zh);
    const zs = size * 0.72;
    c.save();
    c.translate(o.x, o.y + size * 0.95);
    c.rotate((o.rot ?? -0.03) * 0.6);
    c.font = `${zs}px ${HAND_ZH}`;
    c.fillStyle = o.zhColor ?? (o.color ?? INK);
    c.textBaseline = 'alphabetic';
    let x = 0;
    chars.forEach((ch, i) => {
      const cw = c.measureText(ch).width;
      const shown = clamp(p * chars.length - i);
      if (shown > 0) {
        c.globalAlpha = shown;
        const px = x, py = 0;
        c.lineWidth = zs * 0.035;
        c.strokeStyle = c.fillStyle as string;
        c.strokeText(ch, px, py);      // (华文行楷 is thin: a hairline stroke gives it the weight of a felt pen)
        c.fillText(ch, px, py);
      }
      x += cw;
    });
    c.restore();
  }
}

// ================================================================ the ink brush (05-cel-boil)

/** The cel palette of 05-cel-boil: warm sumi ink, tomato, marigold, cream paper, its highlight, a red pencil. */
export const CEL = { ink: '#1c1613', red: '#e5402b', yel: '#ffc425', cream: '#f4e9d0', hi: '#fff6e2', pencil: '#d9573f' } as const;

/** A drawing point [x, y, corner?]: corner 1 keeps a sharp corner where the spline would round it off. */
export type Pt = readonly [number, number, number?];
export type XY = [number, number];

/**
 * Close-up compensation read by every ink* call: line width and boil amplitude multipliers. Set it once per frame with
 * closeUp(zoom) before drawing (closeUp(1) resets), so a scene never inherits another's.
 */
export const BRUSH = { ink: 1, amp: 1 };

/**
 * Close-up compensation: with the camera pushed in `zoom` times, lines drawn in world px come out `zoom` times heavier
 * and boil `zoom` times wider. This thins them back towards the weight they were drawn at (as 05-cel-boil: ×0.59 width,
 * ×0.55 boil at 1.86×; a little of the zoom still shows, like a re-framed drawing). Pulled back (zoom ≤ 1): no change.
 */
export function closeUp(zoom: number): { ink: number; amp: number } {
  const z = Math.max(1, zoom);
  BRUSH.ink = z ** -0.85;
  BRUSH.amp = z ** -0.95;
  return BRUSH;
}

// ---- geometry

/** Centripetal Catmull-Rom point between p1 and p2 (no loops or cusps on uneven spacing). */
function crp(p0: Pt, p1: Pt, p2: Pt, p3: Pt, u: number): XY {
  const d = (p: Pt, q: Pt) => Math.sqrt(Math.hypot(q[0] - p[0], q[1] - p[1])) + 1e-4;
  const t1 = d(p0, p1), t2 = t1 + d(p1, p2), t3 = t2 + d(p2, p3);
  const tt = t1 + (t2 - t1) * u;
  const L = (a: Pt, b: Pt, ta: number, tb: number): XY => {
    const w = (tt - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
  };
  const A1 = L(p0, p1, 0, t1), A2 = L(p1, p2, t1, t2), A3 = L(p2, p3, t2, t3);
  return L(L(A1, A2, 0, t2), L(A2, A3, t1, t3), t1, t2);
}

/** A smooth curve through control points (centripetal Catmull-Rom), sampled every ~`step` px; corner points stay sharp. */
export function spline(P: readonly Pt[], closed = false, step = 5): XY[] {
  const n = P.length, out: XY[] = [];
  if (n < 2) return P.map((p) => [p[0], p[1]]);
  for (let i = 0, segs = closed ? n : n - 1; i < segs; i++) {
    const p1 = P[i]!, p2 = P[(i + 1) % n]!;
    let p0 = closed ? P[(i - 1 + n) % n]! : P[Math.max(0, i - 1)]!;
    let p3 = closed ? P[(i + 2) % n]! : P[Math.min(n - 1, i + 2)]!;
    if (p1[2]) p0 = p1;
    if (p2[2]) p3 = p2;
    const m = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 0; k < m; k++) out.push(crp(p0, p1, p2, p3, k / m));
  }
  if (!closed) out.push([P[n - 1]![0], P[n - 1]![1]]);
  return out;
}

/** Cumulative arc length at each point (closed: one more entry, the length back to the first point). */
export function arcLengths(pts: readonly Pt[], closed = false): number[] {
  const L = [0];
  for (let i = 1; i < pts.length; i++) L.push(L[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
  if (closed && pts.length > 1) L.push(L[L.length - 1]! + Math.hypot(pts[0]![0] - pts[pts.length - 1]![0], pts[0]![1] - pts[pts.length - 1]![1]));
  return L;
}

/** Evenly spaced points every ~`step` px along a polyline (closed: the last point does not repeat the first). */
export function resample(pts: readonly Pt[], step = 3.2, closed = false): XY[] {
  if (!pts.length) return [];
  const src = closed ? [...pts, pts[0]!] : pts;
  const L = arcLengths(src), tot = L[L.length - 1]!;
  if (tot < 1e-6) return [[src[0]![0], src[0]![1]]];
  const n = Math.max(2, Math.round(tot / step)), out: XY[] = [];
  let j = 1;
  for (let i = 0, N = closed ? n : n + 1; i < N; i++) {
    const s = (tot * i) / n;
    while (j < L.length - 1 && L[j]! < s) j++;
    const a = src[j - 1]!, b = src[j]!, u = (s - L[j - 1]!) / Math.max(1e-9, L[j]! - L[j - 1]!);
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
  }
  return out;
}

/** The first `frac` (0..1) of an open polyline by length (a stroke being drawn on). */
export function prefix(pts: readonly Pt[], frac: number): XY[] {
  if (frac >= 1) return pts.map((p) => [p[0], p[1]]);
  const L = arcLengths(pts), s = L[L.length - 1]! * Math.max(0, frac), out: XY[] = [[pts[0]![0], pts[0]![1]]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    if (L[i]! <= s) { out.push([b[0], b[1]]); continue; }
    const u = (s - L[i - 1]!) / Math.max(1e-9, L[i]! - L[i - 1]!);
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
    break;
  }
  return out;
}

/** Place unit-space points: scale (sx, sy), shear kx (x += kx·−y), rotate r, move to (x, y). Corner flags are kept. */
export function place(P: readonly Pt[], o: { x?: number; y?: number; r?: number; sx?: number; sy?: number; kx?: number }): Pt[] {
  const { x = 0, y = 0, r = 0, sx = 1, sy = 1, kx = 0 } = o, c = Math.cos(r), s = Math.sin(r);
  return P.map((p) => {
    const py = p[1] * sy, px = p[0] * sx - kx * py;
    return [x + px * c - py * s, y + px * s + py * c, p[2]];
  });
}

// ---- boil

/**
 * Line boil: points pushed along a smooth noise field in world space (features ~`scale` px, up to ±`amp` px × BRUSH.amp),
 * so neighbouring points — and neighbouring lines — shift the same way, like a drawing traced again a little off.
 * Not a per-point random jitter (that reads as electricity). `seed`: one field per drawing; cycle a few for a held shot.
 */
export function boil(pts: readonly Pt[], seed: number, amp = 2.2, scale = 70): XY[] {
  const a = amp * BRUSH.amp;
  if (!a) return pts.map((p) => [p[0], p[1]]);
  const s = seed * 1.618 + 0.25;
  return pts.map(([x, y]) => [x + a * noise2(x / scale, y / scale, s), y + a * noise2(x / scale + 41.3, y / scale - 17.9, s)]);
}

// ---- brush

export interface InkOpts {
  /** Seed of this line on this drawing: element seed + the drawing's boil variant (celDrawing().v). */
  seed?: number;
  /** Nib width (px, × BRUSH.ink). Default 6. */
  w?: number;
  color?: string;
  alpha?: number;
  /** Boil amplitude (px) and feature size (px). Default 2.2, 70. */
  amp?: number;
  scale?: number;
  /** Lengths (px) over which the pen presses in at the start and lifts at the end. Default 14, 26. */
  taperIn?: number;
  taperOut?: number;
  /** Thinnest width at the very ends, as a fraction of the nib. Default 0.25. */
  min?: number;
  /** Pressure variation along the stroke (±fraction). Default 0.35. */
  pressure?: number;
  /** Extra weight on the shadow side (outward normal facing away from the light). Default 0.35. */
  heavy?: number;
  /** Direction the shadow side faces (unit vector, y down): the light is upper left. Default [0.55, 0.83]. */
  light?: readonly [number, number];
  /** Round caps at the ends. Default true. */
  caps?: boolean;
  /** The points are already a dense polyline (no spline through them). */
  dense?: boolean;
  /** Spline sampling step (px) when not dense. Default 5. */
  step?: number;
}

/** Width (px) at arc length s of a stroke `tot` px long whose unit tangent is (tx, ty). */
export type WidthFn = (s: number, tot: number, tx: number, ty: number) => number;

/**
 * The hand-inked width profile: nib × pressure noise (±35 %, wandering over ~60 px, new each drawing) × press-in /
 * lift-off tapers (thinnest `min`) × heavier on the shadow side (the outward normal (ty, −tx) facing `light`).
 */
export function inkWidth(o: InkOpts = {}): WidthFn {
  const w = o.w ?? 6, seed = o.seed ?? 1, t0 = o.taperIn ?? 14, t1 = o.taperOut ?? 26, jit = o.pressure ?? 0.35;
  const min = o.min ?? 0.25, heavy = o.heavy ?? 0.35, [lx, ly] = o.light ?? [0.55, 0.83];
  return (s, tot, tx, ty) => {
    let k = 1 + jit * noise1(s / 60 + seed * 1.37, 7);
    k *= 1 + heavy * Math.max(0, ty * lx - tx * ly);
    const a = t0 > 0 ? smoothstep(0, t0, s) : 1, b = t1 > 0 ? smoothstep(0, t1, tot - s) : 1;
    k *= min + (1 - min) * Math.min(a, b);
    return w * k * BRUSH.ink;
  };
}

/** A centreline swept into a filled outline polygon of width wfn, with round caps (half discs) at both ends. */
export function strokeOutline(pts: readonly Pt[], wfn: WidthFn, caps = true): XY[] {
  const n = pts.length;
  if (n < 2) return [];
  const L = arcLengths(pts), tot = L[n - 1] || 1, Lp: XY[] = [], Rp: XY[] = [];
  let w0 = 0, wN = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(n - 1, i + 1)]!, p = pts[i]!;
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    const w = Math.max(0, wfn(L[i]!, tot, tx, ty)) / 2;
    if (i === 0) w0 = w;
    if (i === n - 1) wN = w;
    Lp.push([p[0] - ty * w, p[1] + tx * w]);
    Rp.push([p[0] + ty * w, p[1] - tx * w]);
  }
  const poly: XY[] = [...Lp];
  const cap = (p: Pt, a0: number, w: number) => {
    if (!caps || w < 0.3) return;
    for (let k = 1; k < 8; k++) { const a = a0 - (Math.PI * k) / 8; poly.push([p[0] + Math.cos(a) * w, p[1] + Math.sin(a) * w]); }
  };
  const e0 = pts[n - 2]!, e1 = pts[n - 1]!;
  cap(e1, Math.atan2(e1[1] - e0[1], e1[0] - e0[0]) + Math.PI / 2, wN); // round the end: left side → forward → right side
  for (let i = n - 1; i >= 0; i--) poly.push(Rp[i]!);
  const s0 = pts[0]!, s1 = pts[1]!;
  cap(s0, Math.atan2(s1[1] - s0[1], s1[0] - s0[0]) - Math.PI / 2, w0);
  return poly;
}

function fillPolys(c: CanvasRenderingContext2D, polys: readonly (readonly Pt[])[], color: string, alpha = 1, rule: CanvasFillRule = 'nonzero') {
  c.beginPath();
  for (const p of polys) {
    if (p.length < 3) continue;
    c.moveTo(p[0]![0], p[0]![1]);
    for (let i = 1; i < p.length; i++) c.lineTo(p[i]![0], p[i]![1]);
    c.closePath();
  }
  const a = c.globalAlpha;
  c.globalAlpha = a * alpha;
  c.fillStyle = color;
  c.fill(rule);
  c.globalAlpha = a;
}

/**
 * One pen stroke through control points (or a dense polyline with `dense`): splined, boiled, swept to the hand-inked
 * width with round caps and filled. Returns the boiled centreline.
 */
export function inkStroke(c: CanvasRenderingContext2D, P: readonly Pt[], o: InkOpts = {}): XY[] {
  if (P.length < 2) return [];
  const pts = boil(resample(o.dense ? P : spline(P, false, o.step ?? 5), 3.2), o.seed ?? 1, o.amp ?? 2.2, o.scale ?? 70);
  if (pts.length < 2) return pts;
  fillPolys(c, [strokeOutline(pts, inkWidth(o), o.caps ?? true)], o.color ?? CEL.ink, o.alpha ?? 1);
  return pts;
}

export interface LoopOpts extends InkOpts {
  /** Pen strokes the loop is inked in. Default: 1, or 2 when it is longer than 900 px. */
  splits?: number;
  /** How far (fraction of the loop) each stroke runs on past the next one's start, and how far it drifts off it (px). */
  overlap?: number;
  overshoot?: number;
}

/**
 * A closed outline inked by hand: boiled as a whole, then drawn in 1–2 tapered strokes that start at a different place
 * every drawing and run past the seam, drifting `overshoot` px off it. The shadow side is the same for either winding.
 */
export function inkLoop(c: CanvasRenderingContext2D, P: readonly Pt[], o: LoopOpts = {}): XY[] {
  const seed = o.seed ?? 1;
  const pts = boil(resample(o.dense ? P : spline(P, true, o.step ?? 5), 3.2, true), seed, o.amp ?? 2.2, o.scale ?? 70);
  const n = pts.length;
  if (n < 6) return pts;
  let A = 0;
  for (let i = 0; i < n; i++) { const p = pts[i]!, q = pts[(i + 1) % n]!; A += p[0] * q[1] - q[0] * p[1]; }
  const sgn = A > 0 ? 1 : -1; // y down: A > 0 runs clockwise on screen, its outward normal is (ty, −tx)
  const splits = o.splits ?? (n * 3.2 > 900 ? 2 : 1), overshoot = o.overshoot ?? 2.5;
  const ext = Math.max(2, Math.floor(n * (o.overlap ?? 0.05)));
  const s0 = Math.floor(hash(seed, 7) * n), cuts: number[] = [];
  for (let k = 0; k < splits; k++) cuts.push(Math.floor(s0 + (n * k) / splits + (hash(seed, 9, k) - 0.5) * n * 0.15));
  for (let k = 0; k < splits; k++) {
    const a = cuts[k]!, b = k + 1 < splits ? cuts[k + 1]! : cuts[0]! + n, seg: XY[] = [];
    for (let j = a; j <= b + ext; j++) {
      const p = pts[mod(j, n)]!;
      if (j <= b) { seg.push(p); continue; }
      const q = pts[mod(j + 1, n)]!, r = pts[mod(j - 1, n)]!;
      let tx = q[0] - r[0], ty = q[1] - r[1];
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;
      const off = ((j - b) / ext) * overshoot * sgn;
      seg.push([p[0] - ty * off, p[1] + tx * off]);
    }
    const wf = inkWidth({ ...o, seed: seed + k * 13, taperIn: o.taperIn ?? 10, taperOut: o.taperOut ?? 22 });
    const wf2: WidthFn = sgn > 0 ? wf : (s, tot, tx, ty) => wf(s, tot, -tx, -ty);
    fillPolys(c, [strokeOutline(seg, wf2, o.caps ?? true)], o.color ?? CEL.ink, o.alpha ?? 1);
  }
  return pts;
}

/** Colour-to-line registration offset of hand colouring (05-cel-boil scene.js REG): the paint lands (−5, 4) px off. */
export const REG: readonly [number, number] = [-5, 4];

export interface FillOpts {
  seed?: number;
  amp?: number;
  scale?: number;
  /** Registration offset (px, × BRUSH.amp). Default REG; [0, 0] for paint that sits on its line. */
  reg?: readonly [number, number];
  dense?: boolean;
  step?: number;
  alpha?: number;
  rule?: CanvasFillRule;
}

/**
 * Flat paint of a closed shape — or of several loops at once (a letter with its holes) — boiled on its own field (not
 * the line's) and shifted off register, like cel paint that never quite meets the ink. Returns the painted loops.
 */
export function inkFill(c: CanvasRenderingContext2D, shape: readonly Pt[] | readonly (readonly Pt[])[], color: string, o: FillOpts = {}): XY[][] {
  const loops = (typeof shape[0]?.[0] === 'number' ? [shape] : shape) as readonly (readonly Pt[])[];
  const [rx, ry] = o.reg ?? REG, k = BRUSH.amp;
  const out = loops.map((P) => {
    const d = resample(o.dense ? P : spline(P, true, o.step ?? 5), 4, true);
    return boil(d, (o.seed ?? 1) + 0.5, o.amp ?? 2.2, o.scale ?? 70).map(([x, y]): XY => [x + rx * k, y + ry * k]);
  });
  fillPolys(c, out, color, o.alpha ?? 1, o.rule ?? 'nonzero');
  return out;
}

/**
 * A ruled straight edge drawn freehand: overshooting both corners by ~`over` px (a different amount each drawing),
 * slightly bowed, tapering at both ends, no shadow-side weight.
 */
export function inkEdge(c: CanvasRenderingContext2D, a: Pt, b: Pt, o: InkOpts & { over?: number } = {}): XY[] {
  const seed = o.seed ?? 1, over = o.over ?? 7;
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
  const s0 = over * (0.4 + hash(seed, 1)), s1 = over * (0.4 + hash(seed, 2)), bow = (hash(seed, 3) - 0.5) * 2.5 * (L / 300);
  const A: Pt = [a[0] - ux * s0, a[1] - uy * s0], B: Pt = [b[0] + ux * s1, b[1] + uy * s1];
  const M: Pt = [(A[0] + B[0]) / 2 - uy * bow, (A[1] + B[1]) / 2 + ux * bow];
  return inkStroke(c, [A, M, B], { w: 6, taperIn: 12, taperOut: 16, pressure: 0.3, heavy: 0, amp: 1.8, min: 0.2, ...o, seed });
}

/** Hand hatching clipped to a closed shape: parallel tapered strokes `gap` px apart at `angle` (rad), unevenly spaced. */
export function inkHatch(c: CanvasRenderingContext2D, clip: readonly Pt[], o: InkOpts & { gap?: number; angle?: number; jitter?: number } = {}) {
  if (clip.length < 3) return;
  const seed = o.seed ?? 1, gap = o.gap ?? 14, ang = o.angle ?? -0.9, jitter = o.jitter ?? 0.35, w = o.w ?? 2.2;
  c.save();
  c.beginPath();
  c.moveTo(clip[0]![0], clip[0]![1]);
  for (const p of clip) c.lineTo(p[0], p[1]);
  c.closePath();
  c.clip();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of clip) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  const R = Math.hypot(x1 - x0, y1 - y0) / 2 + 10, mx = (x0 + x1) / 2, my = (y0 + y1) / 2, cs = Math.cos(ang), sn = Math.sin(ang);
  const margin = Math.max(o.taperIn ?? 8, o.taperOut ?? 8) + 2 * (o.amp ?? 1.6) + 4; // tapers end outside the clip
  for (let d = -R, k = 0; d <= R; d += gap, k++) {
    const off = d + (hash(seed, k) - 0.5) * gap * jitter, px = mx - sn * off, py = my + cs * off;
    // only the span of this line that crosses the shape (a long thin shadow would otherwise boil metres of hidden ink)
    let t0 = Infinity, t1 = -Infinity;
    for (let i = 0; i < clip.length; i++) {
      const a = clip[i]!, b = clip[(i + 1) % clip.length]!, ex = b[0] - a[0], ey = b[1] - a[1], den = cs * ey - sn * ex;
      if (Math.abs(den) < 1e-9) continue;
      const wx = a[0] - px, wy = a[1] - py, s = (wx * sn - wy * cs) / den;
      if (s < 0 || s > 1) continue;
      const t = (wx * ey - wy * ex) / den;
      t0 = Math.min(t0, t); t1 = Math.max(t1, t);
    }
    if (t0 > t1) continue;
    t0 -= margin; t1 += margin;
    inkStroke(c, [[px + cs * t0, py + sn * t0], [px + cs * t1, py + sn * t1]], {
      amp: 1.6, taperIn: 8, taperOut: 8, pressure: 0.3, heavy: 0, ...o, seed: seed * 31 + k, w: w * (0.8 + 0.4 * hash(seed, k, 2)),
    });
  }
  c.restore();
}

/**
 * Smear drawing: the trailing side of a (dense) closed shape dragged back along the motion (vx, vy) by `len` px while the
 * leading side stays — a teardrop about 300 % long for the one drawing where the motion is fastest. `power` shapes the
 * tail (1 blunt, 3 pointed). The drag is measured from the shape's centroid.
 */
export function smearShape(P: readonly Pt[], vx: number, vy: number, len: number, power = 2): Pt[] {
  if (!P.length) return [];
  let cx = 0, cy = 0;
  for (const p of P) { cx += p[0]; cy += p[1]; }
  cx /= P.length; cy /= P.length;
  const L = Math.hypot(vx, vy) || 1, ux = vx / L, uy = vy / L;
  return P.map((p) => {
    const dx = p[0] - cx, dy = p[1] - cy, d = Math.hypot(dx, dy) || 1;
    const k = len * Math.max(0, -(dx * ux + dy * uy) / d) ** power;
    return [p[0] - ux * k, p[1] - uy * k, p[2]];
  });
}

// ---- exposure sheet

/** Exposure sheet: [[from time, drawings per second], …] in time order. */
export type Sheet = readonly (readonly [from: number, rate: number])[];

export interface Drawing {
  /** The time this drawing is posed at (held: every frame of the drawing shows the same moment). */
  t: number;
  /** Drawings since the sheet began (a fresh boil field each: smears, sparks, one-off drawings). */
  id: number;
  /** Drawings per second at t. */
  rate: number;
  /** Boil variant for the lines that do not move: cycles 0..3, or 0..2 on a hold (seed them with element + v). */
  v: number;
  /** On a hold (rate ≤ holdRate). */
  hold: boolean;
}

/**
 * The drawing on screen at t under an exposure sheet (at 60 fps: on ones 30 or 20, on twos 12, a hold 6 — rates that
 * divide 60, see util stepT). Steps restart at each entry; before the first entry its rate applies. Crisp: a frame's
 * motion-blur sub-frames all see the same drawing. The boil loops over 4 drawings, 3 on a hold, like a hand-drawn
 * boil cycle (a new random field every step would crawl).
 */
export function celDrawing(t: number, sheet: Sheet, o: { holdRate?: number; loop?: number; holdLoop?: number } = {}): Drawing {
  const c = shutterT(t, 0);
  if (!sheet.length) {
    const id = Math.floor(c * TG_FPS + 1e-6);
    return { t: id / TG_FPS, id, rate: TG_FPS, v: mod(id, o.loop ?? 4), hold: false };
  }
  let i = 0;
  for (let k = 1; k < sheet.length; k++) if (c >= sheet[k]![0] - 1e-9) i = k;
  let id = 0;
  for (let k = 0; k < i; k++) id += Math.ceil((sheet[k + 1]![0] - sheet[k]![0]) * sheet[k]![1] - 1e-6);
  const [from, rate] = sheet[i]!, k = Math.floor((c - from) * rate + 1e-6);
  id += k;
  const hold = rate <= (o.holdRate ?? 8);
  return { t: from + k / rate, id, rate, v: mod(id, hold ? (o.holdLoop ?? 3) : (o.loop ?? 4)), hold };
}

// ---- paper

export interface PaperSheet {
  /** The paper (cream-tinted scan) at output resolution, W × H logical px. */
  base: HTMLCanvasElement;
  /** Grey high-contrast tooth, `pad` px bigger on every side, for the multiply pass. */
  tooth: HTMLCanvasElement;
  pad: number;
}

/**
 * Load a paper scan (default /textures/paper001.jpg, CC0) as a tinted base sheet and a tooth for paperTooth. Call in a
 * scene's init(). `tint`: the paper colour multiplied over the scan; `depth`: how dark the tooth's valleys go (0..1);
 * `grain`: scan px per logical px (finer tooth > 1).
 */
export async function loadPaper(o: { url?: string; tint?: string; depth?: number; pad?: number; grain?: number } = {}): Promise<PaperSheet> {
  const img = new Image();
  img.src = o.url ?? 'textures/paper001.jpg';
  await img.decode();
  const pad = o.pad ?? 120, S = SCALE, grain = o.grain ?? 1.4, depth = o.depth ?? 0.32;
  const canvas = (w: number, h: number) => { const cv = document.createElement('canvas'); cv.width = Math.round(w * S); cv.height = Math.round(h * S); return cv; };
  // scan region: `grain` scan px per logical px, as much as the scan has
  const crop = (w: number, h: number, ax: number, ay: number) => {
    const k = Math.min(grain, img.width / w, img.height / h), sw = w * k, sh = h * k;
    return [(img.width - sw) * ax, (img.height - sh) * ay, sw, sh] as const;
  };
  const base = canvas(W, H), b = base.getContext('2d')!;
  b.drawImage(img, ...crop(W, H, 0.5, 0.5), 0, 0, base.width, base.height);
  b.globalCompositeOperation = 'multiply';
  b.fillStyle = o.tint ?? CEL.cream;
  b.fillRect(0, 0, base.width, base.height);
  // a soft darkening at the edges (a sheet under the camera light)
  const g = b.createRadialGradient(base.width / 2, base.height / 2, base.height * 0.35, base.width / 2, base.height / 2, base.width * 0.72);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(225,212,190,1)');
  b.fillStyle = g;
  b.fillRect(0, 0, base.width, base.height);

  // tooth: another region of the scan, its fine relief stretched so the valleys reach 1 − depth (a warm grey: the
  // multiply darkens paint and paper towards umber, not towards grey)
  const tooth = canvas(W + 2 * pad, H + 2 * pad), x = tooth.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(img, ...crop(W + 2 * pad, H + 2 * pad, 0.15, 0.85), 0, 0, tooth.width, tooth.height);
  const im = x.getImageData(0, 0, tooth.width, tooth.height), d = im.data, n = tooth.width * tooth.height;
  let sum = 0, sq = 0;
  for (let i = 0; i < n; i++) { const l = d[i * 4]! * 0.3 + d[i * 4 + 1]! * 0.59 + d[i * 4 + 2]! * 0.11; sum += l; sq += l * l; }
  const mean = sum / n, sd = Math.sqrt(Math.max(1, sq / n - mean * mean));
  for (let i = 0; i < n; i++) {
    const l = d[i * 4]! * 0.3 + d[i * 4 + 1]! * 0.59 + d[i * 4 + 2]! * 0.11;
    const k = depth * clamp((mean + 0.8 * sd - l) / (4 * sd));
    d[i * 4] = 255 * (1 - k * 0.8); d[i * 4 + 1] = 255 * (1 - k * 0.92); d[i * 4 + 2] = 255 * (1 - k * 1.15); d[i * 4 + 3] = 255;
  }
  x.putImageData(im, 0, 0);
  return { base, tooth, pad };
}

/** The paper under everything (screen-fixed: a close-up is a drawing re-drawn bigger on the same paper). */
export function drawPaper(c: CanvasRenderingContext2D, sheet: PaperSheet) {
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
  c.drawImage(sheet.base, 0, 0, W, H);
  c.restore();
}

/**
 * Paper tooth over the ink and paint: the tooth multiplied in at `alpha` (~0.5), shifted to a new place on every
 * drawing `v` (each cel a new sheet), plus a few specks of scanner dust that change with it. Draw it last.
 */
export function paperTooth(c: CanvasRenderingContext2D, sheet: PaperSheet, v: number, alpha = 0.5, dust = 24) {
  const S = SCALE, ox = Math.floor(hash(v, 51) * 2 * sheet.pad), oy = Math.floor(hash(v, 52) * 2 * sheet.pad);
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'multiply';
  c.globalAlpha = alpha;
  c.drawImage(sheet.tooth, ox * S, oy * S, W * S, H * S, 0, 0, W, H);
  c.globalCompositeOperation = 'source-over';
  c.fillStyle = CEL.ink;
  for (let i = 0; i < dust; i++) {
    const r = 0.5 + 1.8 * hash(v, i, 3) ** 3;
    c.globalAlpha = 0.12 + 0.2 * hash(v, i, 4);
    c.beginPath();
    c.ellipse(hash(v, i, 1) * W, hash(v, i, 2) * H, r, r * (0.5 + 0.5 * hash(v, i, 5)), hash(v, i, 6) * 3, 0, Math.PI * 2);
    c.fill();
  }
  c.restore();
}

// ---- lettering

/**
 * A StrokeText (../engine/stroke, single-stroke fonts) written with the ink brush, the first `len` px of writing: every
 * pen stroke presses in and lifts off, boils on its own field; the one being written ends blunt (the pen is still down).
 * Draws at the current origin (left end of the baseline). Default nib: 7 % of the type size.
 */
export function inkText(c: CanvasRenderingContext2D, st: StrokeText, len = Infinity, o: InkOpts = {}) {
  const sz = st.size, seed = o.seed ?? 1;
  for (let i = 0; i < st.strokes.length; i++) {
    const s0 = st.startLen[i]!;
    if (s0 >= len) break;
    const pts = st.strokes[i]!, L = st.lens[i]!, remain = len - s0, partial = remain < L[L.length - 1]!;
    const P: Pt[] = [];
    for (let j = 0; j < pts.length; j++) {
      if (L[j]! <= remain) { P.push([pts[j]!.x, pts[j]!.y]); continue; }
      const a = pts[j - 1]!, b = pts[j]!, u = (remain - L[j - 1]!) / Math.max(1e-6, L[j]! - L[j - 1]!);
      P.push([a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u]);
      break;
    }
    if (P.length < 2) continue;
    inkStroke(c, P, {
      w: sz * 0.07, taperIn: sz * 0.06, amp: 1.2, scale: 40, heavy: 0, pressure: 0.3, min: 0.35, ...o,
      taperOut: partial ? 0 : (o.taperOut ?? sz * 0.12), dense: true, seed: seed * 97 + i,
    });
  }
}

/**
 * The outline of `text` in an engine font (type.ts; Chinese through its 思源 stand-in) as closed polylines — contours
 * and holes — at (x, baseline y), curves flattened every ~`step` px. Paint them with inkFill (all loops at once, so the
 * holes stay open) and ink each with inkLoop({ dense: true }) for hand-inked lettering.
 */
export function textLoops(text: string, family: string, size: number, x = 0, y = 0, step = 4): XY[][] {
  const loops: XY[][] = [];
  let cur: XY[] = [];
  const close = () => {
    if (cur.length > 1) { const a = cur[0]!, b = cur[cur.length - 1]!; if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.01) cur.pop(); }
    if (cur.length > 2) loops.push(cur);
    cur = [];
  };
  for (const m of textPathCommands(text, family, size, x, y)) {
    const p = cur[cur.length - 1];
    if (m.type === 'M') { close(); cur = [[m.x, m.y]]; }
    else if (m.type === 'L') cur.push([m.x, m.y]);
    else if (m.type === 'Q' && p) {
      const n = Math.max(2, Math.ceil((Math.hypot(m.x1 - p[0], m.y1 - p[1]) + Math.hypot(m.x - m.x1, m.y - m.y1)) / step));
      for (let k = 1; k <= n; k++) {
        const u = k / n, v = 1 - u;
        cur.push([v * v * p[0] + 2 * v * u * m.x1 + u * u * m.x, v * v * p[1] + 2 * v * u * m.y1 + u * u * m.y]);
      }
    } else if (m.type === 'C' && p) {
      const n = Math.max(2, Math.ceil((Math.hypot(m.x1 - p[0], m.y1 - p[1]) + Math.hypot(m.x2 - m.x1, m.y2 - m.y1) + Math.hypot(m.x - m.x2, m.y - m.y2)) / step));
      for (let k = 1; k <= n; k++) {
        const u = k / n, v = 1 - u;
        cur.push([
          v * v * v * p[0] + 3 * v * v * u * m.x1 + 3 * v * u * u * m.x2 + u * u * u * m.x,
          v * v * v * p[1] + 3 * v * v * u * m.y1 + 3 * v * u * u * m.y2 + u * u * u * m.y,
        ]);
      }
    } else if (m.type === 'Z') close();
  }
  close();
  return loops;
}

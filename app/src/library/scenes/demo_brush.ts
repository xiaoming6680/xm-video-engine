// 手绘线示例（?brush）：纸上一盒火柴。划火柴（一拍一：拉长的 smear 帧、三个残影帧各一张）→ 点着 → 火苗跳到火柴盒上
// 活过来（起跳 smear 一张、落地压扁）→ 镜头推近（特写补偿：屏幕上的线粗不变）→ 定格（一拍四，沸腾 3 张循环）→
// 切回全景，手写标题「手作 / hand made」。整段按摄影表以一拍二为主；填色错位、纸齿每张画换一次，右下角场记写着
// 当前几拍一张、第几张画。笔刷是 kit/tegaki.ts 的 ink* 系列；构图、火苗和星爆的形状参考 mg-styles-15
// demos/05-cel-boil（MIT，Vincentwei1021）。用来看部件和质感，从 0 秒开始，约 17 秒（测试歌 120 BPM，2 秒一小节）。
import type * as THREE from 'three';
import { Scene, type Cue, type Frame } from '../../engine/scene';
import { Layer2D, W, H } from '../../engine/gl';
import { layout } from '../../engine/type';
import { clamp, ease, hash, lerp, mod } from '../../engine/util';
import { loadStrokeFonts, strokeText, type StrokeFontName, type StrokeText } from '../engine/stroke';
import {
  BRUSH, CEL, REG, celDrawing, closeUp, drawPaper, inkEdge, inkFill, inkHatch, inkLoop, inkStroke, inkText, loadPaper,
  paperTooth, place, prefix, smearShape, spline, textLoops, type Drawing, type PaperSheet, type Pt, type Sheet, type XY,
} from '../kit/tegaki';

// ---------------------------------------------------------------- exposure sheet (scene seconds)
const SHEET: Sheet = [
  [0, 12],      // on twos: the match waits, rears back
  [1.45, 30],   // on ones: the strike (smear, multiples), sparks, the ignition burst
  [2.1, 12],    // twos: tossed upright, burning, comes alive
  [4.2, 30],    // ones: the hop (take-off smear, the arc, the landing squash)
  [4.7, 12],    // twos: settles, the camera pushes in
  [6.8, 6],     // a hold in the close-up: on fours, the boil cycles 3 drawings
  [10, 30],     // cut wide: the title pops on ones
  [10.3, 12],   // twos: the pen writes
  [12.5, 6],    // end hold
];

// ---------------------------------------------------------------- stage (world px = screen px in the wide shot)
const BOX = { x0: 520, x1: 1300, y1: 800, y2: 950, dx: 50, dy: -100 };
const STICK = 250;
const FOOT: XY = [1180, 765];              // where the match stands on the box top
const LAND: XY = [650, 768];               // where the flame lands
const BUBBLE = { x: 800, y: 300, rx: 330, ry: 168 };
const sharp = (P: readonly Pt[]): Pt[] => P.map((p) => [p[0], p[1], 1]);
const ellipse = (cx: number, cy: number, rx: number, ry: number, n = 28): Pt[] =>
  Array.from({ length: n }, (_, i) => [cx + rx * Math.cos((i / n) * Math.PI * 2), cy + ry * Math.sin((i / n) * Math.PI * 2)]);

// ---------------------------------------------------------------- shapes (unit space, after 05-cel-boil scene.js)
/** Flame silhouette: base centre at (0, 0), height 1 up (−y); tips are corners. `wild` loosens the licks. */
function flameUnit(seed: number, wild: number): Pt[] {
  const j = (k: number, a: number) => (hash(seed, k) - 0.5) * 2 * a;
  return [
    [0, 0], [0.3, -0.035], [0.43, -0.2], [0.415, -0.4],
    [0.3 + j(5, 0.03 + wild * 0.1), -(0.66 + j(1, 0.06 + wild * 0.3)), 1],
    [0.17, -0.55 + j(6, 0.04)],
    [j(3, 0.04 + wild * 0.2), -1 + j(4, 0.03 + wild * 0.12), 1],
    [-0.15, -0.6 + j(7, 0.04)],
    [-0.34 + j(8, 0.03 + wild * 0.1), -(0.76 + j(2, 0.06 + wild * 0.3)), 1],
    [-0.44, -0.46], [-0.44, -0.24], [-0.31, -0.04],
  ];
}
function innerUnit(seed: number, wild: number): Pt[] {
  const j = (k: number, a: number) => (hash(seed, k + 20) - 0.5) * 2 * a;
  return [[0, 0], [0.24, -0.04], [0.33, -0.18], [0.3, -0.36], [0.02 + j(1, 0.04 + wild * 0.1), -0.66 + j(2, 0.04), 1], [-0.3, -0.38], [-0.34, -0.18], [-0.24, -0.04]];
}
function starPts(n: number, rOut: number, rIn: number, seed: number, rot = 0, jit = 0.3): Pt[] {
  const P: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2 + (hash(seed, i, 1) - 0.5) * (Math.PI / n) * 0.6;
    const ro = rOut * (1 - jit + jit * 2 * hash(seed, i, 2));
    P.push([Math.cos(a) * ro, Math.sin(a) * ro, 1]);
    const b = a + Math.PI / n + (hash(seed, i, 3) - 0.5) * (Math.PI / n) * 0.3, ri = rIn * (0.85 + 0.3 * hash(seed, i, 4));
    P.push([Math.cos(b) * ri, Math.sin(b) * ri]);
  }
  return P;
}
function twinklePts(R: number, seed: number): Pt[] {
  const P: Pt[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2, r = R * (i % 2 ? 0.78 : 1) * (0.92 + 0.16 * hash(seed, i));
    P.push([Math.cos(a) * r, Math.sin(a) * r, 1]);
    P.push([Math.cos(a + Math.PI / 4) * R * 0.2, Math.sin(a + Math.PI / 4) * R * 0.2]);
  }
  return P;
}
/** A scalloped cloud: bumps between sharp cusps around an ellipse. */
function cloudPts(cx: number, cy: number, rx: number, ry: number, n: number, seed: number): Pt[] {
  const P: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, b = ((i + 0.5) / n) * Math.PI * 2, k = 1.05 + 0.04 * hash(seed, i);
    P.push([cx + rx * 0.95 * Math.cos(a), cy + ry * 0.95 * Math.sin(a), 1]);
    P.push([cx + rx * k * Math.cos(b), cy + ry * k * Math.sin(b)]);
  }
  return P;
}

// ---------------------------------------------------------------- the match
interface Match { hx: number; hy: number; a: number; bend: number; burnt: boolean }
/** Strike spacing on ones (fraction of the drag per drawing): slow in, a 200 px jump in the middle, slow out. */
const STRIKE = [0, 0.05, 0.18, 0.45, 0.72, 0.88, 0.96, 1];

/** The match at (held) scene time lt: head centre, direction head → butt (a), stick bow. */
function matchAt(lt: number): Match {
  const burnt = lt >= 4.2;
  if (lt < 1.0) return { hx: 640 + 1.5 * Math.sin(lt * 37), hy: 872, a: -2.2, bend: 0, burnt };
  if (lt < 1.45) {
    const u = ease.outCubic(clamp((lt - 1.0) / 0.4));
    return { hx: lerp(640, 575, u), hy: lerp(872, 852, u), a: lerp(-2.2, -2.45, u), bend: lerp(0, -22, u), burnt };
  }
  if (lt < 2.1) {
    const p = STRIKE[Math.min(STRIKE.length - 1, Math.round((lt - 1.45) * 30))]!;
    return { hx: lerp(575, 1250, p), hy: 878 - 6 * Math.sin(p * Math.PI), a: lerp(-2.35, -2.15, p), bend: 22 * (1 - p * 0.6), burnt };
  }
  const a0 = -2.15, a1 = -1.5 * Math.PI;
  if (lt < 2.7) { // tossed: turns about its middle, arcs up and comes down standing on the box
    const u = ease.inOutQuad(clamp((lt - 2.1) / 0.6)), a = lerp(a0, a1, u);
    const c0: XY = [1250 + 125 * Math.cos(a0), 878 + 125 * Math.sin(a0)], c1: XY = [FOOT[0], FOOT[1] - 125];
    const cx = lerp(c0[0], c1[0], u), cy = lerp(c0[1], c1[1], u) - 150 * Math.sin(Math.PI * u);
    return { hx: cx - 125 * Math.cos(a), hy: cy - 125 * Math.sin(a), a, bend: 8 * Math.sin(Math.PI * u), burnt };
  }
  const k = Math.floor((lt - 2.7) * 12 + 1e-6), wob = k < 3 ? [0.12, -0.06, 0.02][k]! : 0; // landing wobble about the foot
  const a = a1 + wob;
  return { hx: FOOT[0] - STICK * Math.cos(a), hy: FOOT[1] - STICK * Math.sin(a), a, bend: k < 3 ? [6, -3, 1][k]! : 0, burnt };
}
const ends = (m: Match): [XY, XY] => [[m.hx, m.hy], [m.hx + STICK * Math.cos(m.a), m.hy + STICK * Math.sin(m.a)]];
const matchXf = (P: readonly Pt[], m: Match) => place(P, { x: m.hx, y: m.hy, r: m.a - Math.PI / 2 });
const headPts = (m: Match) => matchXf(ellipse(0, -2, 22, 29, 26), m);

function drawStick(c: CanvasRenderingContext2D, m: Match, seed: number) {
  const L: Pt[] = [], R: Pt[] = [], cl: Pt[] = [];
  for (let i = 0; i <= 8; i++) {
    const u = i / 8, x = m.bend * Math.sin(Math.PI * u), y = 18 + (STICK - 18) * u, w = 10 + u * 1.8;
    L.push([x - w, y]); R.push([x + w, y]); cl.push([x + 3, y]);
  }
  const poly = matchXf([...L, ...R.reverse()].map((p, i, a) => (i === 0 || i === a.length - 1 || i === 8 || i === 9 ? [p[0], p[1], 1] : p)), m);
  inkFill(c, poly, CEL.hi, { seed, amp: 1.4, reg: [REG[0] * 0.7, REG[1] * 0.7] });
  inkStroke(c, matchXf(cl.slice(2, 7), m), { seed: seed + 1, w: 2.2, taperIn: 20, taperOut: 30, amp: 1.2, heavy: 0 });
  inkLoop(c, poly, { seed: seed + 2, w: 4.4, amp: 1.5, taperIn: 8, taperOut: 16, heavy: 0.3 });
}
function drawHead(c: CanvasRenderingContext2D, m: Match, seed: number, shape = headPts(m)) {
  inkFill(c, shape, m.burnt ? CEL.ink : CEL.red, { seed, amp: 1.4, reg: [REG[0] * 0.8, REG[1] * 0.8] });
  inkLoop(c, shape, { seed: seed + 1, w: 5.5, amp: 1.4, heavy: 0.4 });
  if (m.burnt) {
    const [e] = matchXf([[7, -14]], m);
    c.fillStyle = CEL.red;
    c.beginPath(); c.arc(e![0], e![1], 4.5, 0, Math.PI * 2); c.fill();
  } else inkStroke(c, matchXf([[-10, -13], [-5, -20]], m), { seed: seed + 5, w: 5, taperIn: 3, taperOut: 5, color: CEL.hi, amp: 0.8, heavy: 0 });
}

// ---------------------------------------------------------------- the flame spirit
interface Spirit {
  x: number; y: number; H: number; sx: number; sy: number; kx: number; r: number;
  /** Face: 0 none; eye size 0..1; mood: 0 calm, 1 happy; blink; look (unit offset of the pupils). */
  eyes: number; happy: boolean; blink: boolean; look: XY;
  /** Smear drawing: the motion to drag the trailing side back along, and how far. */
  smear?: { vx: number; vy: number; len: number };
}
function spiritXf(P: readonly Pt[], s: Spirit): Pt[] {
  const c = Math.cos(s.r), sn = Math.sin(s.r);
  return P.map(([x, y, cr]) => {
    const up = -y, X = x * s.H * s.sx + s.kx * up * s.H, Y = y * s.H * s.sy;
    return [s.x + X * c - Y * sn, s.y + X * sn + Y * c, cr];
  });
}
const HOP = { from: [1180, 527] as XY, h: 230, t0: 4.2, dur: 0.3 };
function hopAt(u: number): [XY, XY] { // position and velocity (per unit u) on the hop arc
  const x = lerp(HOP.from[0], LAND[0], u), y = lerp(HOP.from[1], LAND[1], u) - 4 * HOP.h * u * (1 - u);
  return [[x, y], [LAND[0] - HOP.from[0], LAND[1] - HOP.from[1] - 4 * HOP.h * (1 - 2 * u)]];
}

/** The flame at (held) scene time lt; null before it is lit. */
function spiritAt(lt: number, m: Match, mPrev: Match): Spirit | null {
  if (lt < 2.1) return null;
  const base: Spirit = { x: 0, y: 0, H: 165, sx: 1, sy: 1, kx: 0, r: 0, eyes: 0, happy: false, blink: false, look: [0, 0] };
  if (lt < 4.2) { // on the match head
    const grow = ease.outBack(clamp((lt - 2.1) / 0.5)), vx = (m.hx - mPrev.hx) * 12;
    const breathe = 0.03 * Math.sin(lt * 5.3);
    const s: Spirit = { ...base, x: m.hx, y: m.hy + 12, H: lerp(50, 165, grow), sx: 1 - breathe, sy: 1 + breathe, kx: clamp(-vx / 2500, -0.35, 0.35) };
    s.eyes = lt < 3.17 ? 0 : lt < 3.25 ? 0.6 : 1;
    s.blink = lt >= 3.75 && lt < 3.83;
    if (lt >= 4.0) { // anticipation: squash down before the jump
      const u = ease.outCubic(clamp((lt - 4.0) / 0.15));
      s.sy = lerp(1, 0.72, u); s.sx = lerp(1, 1.24, u); s.look = [-0.3, -0.3];
    }
    return s;
  }
  const u = (lt - HOP.t0) / HOP.dur;
  if (u < 1) { // airborne on ones
    const [p, v] = hopAt(u < 0.05 ? 0.1 : Math.min(1, u + 0.08)), sp = Math.hypot(v[0], v[1]);
    const s: Spirit = { ...base, x: p[0], y: p[1], sx: 0.88, sy: 1.18, r: clamp(Math.atan2(v[0], -v[1]) * 0.35, -0.5, 0.5), eyes: 1, look: [-0.4, 0.1] };
    if (u < 0.05) s.smear = { vx: v[0] / sp, vy: v[1] / sp, len: 2 * s.H * s.sy }; // the take-off drawing: 300 % long
    return s;
  }
  const s: Spirit = { ...base, x: LAND[0], y: LAND[1], eyes: 1 };
  const k = Math.round((lt - HOP.t0 - HOP.dur) * 30);
  const land = [[1.32, 0.66], [1.18, 0.8], [0.93, 1.1], [0.98, 1.03]][k];
  if (land && lt < 4.7) { s.sx = land[0]!; s.sy = land[1]!; }
  else { const b = 0.025 * Math.sin(lt * 4.4); s.sx = 1 - b; s.sy = 1 + b; }
  s.blink = (lt >= 5.33 && lt < 5.5) || (lt >= 11.2 && lt < 11.4);
  s.happy = (lt >= 6.6 && lt < 10) || lt >= 12.5;
  if (lt >= 6.8 && lt < 10) s.y -= 6 * mod(Math.round(lt * 6), 2); // a little bob on the hold
  if (lt >= 10.3 && lt < 12.5) s.look = [-0.5, -0.6]; // looks up at the title
  return s;
}

function drawSpirit(c: CanvasRenderingContext2D, s: Spirit, d: Drawing, seed: number) {
  const shape = 40 + (d.hold ? d.v : mod(d.id, 6)); // a 6-drawing flame cycle (3 on a hold)
  let outer: Pt[] = spline(spiritXf(flameUnit(shape, 0.12), s), true, 3);
  let inner: Pt[] = spline(spiritXf(innerUnit(shape, 0.12), s), true, 3);
  if (s.smear) {
    const { vx, vy, len } = s.smear;
    outer = smearShape(outer, vx, vy, len, 1.6);
    inner = smearShape(inner, vx, vy, len * 0.8, 1.6);
    for (let k = 0; k < 5; k++) { // speed lines left behind
      const off = (k - 2) * s.H * 0.13 + (hash(d.id, k) - 0.5) * 10, x = s.x - vy * off, y = s.y - s.H * 0.3 + vx * off;
      const L = s.H * (1.3 + 0.8 * hash(d.id, k, 2));
      inkStroke(c, [[x - vx * L * 1.6, y - vy * L * 1.6], [x - vx * L * 0.5, y - vy * L * 0.5]], { seed: d.id * 7 + k, w: 4, taperIn: 70, taperOut: 8, min: 0.05, heavy: 0 });
    }
  }
  inkFill(c, outer, CEL.red, { seed: seed + 1, amp: 1.6, dense: true });
  inkFill(c, inner, CEL.yel, { seed: seed + 2, amp: 1.6, dense: true, reg: [REG[0] * 0.8, REG[1] * 0.8] });
  if (!s.smear) inkStroke(c, spiritXf([[-0.2, -0.13], [-0.25, -0.26], [-0.21, -0.38]], s), { seed: seed + 3, w: s.H * 0.035, taperIn: 6, taperOut: 10, color: CEL.hi, amp: 1, heavy: 0 });
  inkLoop(c, outer, { seed: seed + 4, w: 5.5, amp: 1.6, dense: true, heavy: 0.4 });
  if (s.eyes > 0 && !s.smear) drawFace(c, s, seed + 10);
}

function drawFace(c: CanvasRenderingContext2D, s: Spirit, seed: number) {
  const ex = 0.12, ey = -0.3, rx = 0.05 * s.H * s.sx * s.eyes, ry = 0.072 * s.H * s.sy * s.eyes;
  for (const side of [-1, 1]) {
    const [p] = spiritXf([[side * ex, ey]], s), x = p![0], y = p![1];
    if (s.happy) { // ^ ^
      inkStroke(c, [[x - rx * 1.2, y + ry * 0.4], [x, y - ry * 0.6], [x + rx * 1.2, y + ry * 0.4]], { seed: seed + side, w: 5, taperIn: 3, taperOut: 3, min: 0.5, heavy: 0, amp: 0.8 });
    } else if (s.blink) {
      inkStroke(c, [[x - rx * 1.1, y + ry * 0.2], [x, y + ry * 0.45], [x + rx * 1.1, y + ry * 0.2]], { seed: seed + side, w: 4.5, taperIn: 3, taperOut: 3, min: 0.5, heavy: 0, amp: 0.8 });
    } else {
      const lx = x + s.look[0] * rx * 0.5, ly = y + s.look[1] * ry * 0.4;
      inkFill(c, ellipse(lx, ly, rx, ry, 18), CEL.ink, { seed: seed + side * 3, amp: 0.8, reg: [0, 0] });
      c.fillStyle = CEL.hi;
      c.beginPath(); c.arc(lx - rx * 0.3, ly - ry * 0.38, rx * 0.32, 0, Math.PI * 2); c.fill();
    }
  }
  const m = spiritXf(s.happy ? [[-0.07, -0.205], [0, -0.13], [0.07, -0.205]] : [[-0.05, -0.2], [0, -0.17], [0.05, -0.2]], s);
  if (s.happy) { // open smile
    const P = spline([m[0]!, [(m[0]![0] + m[2]![0]) / 2, m[0]![1] - 2], m[2]!, m[1]!], true, 3);
    inkFill(c, P, '#8c1d12', { seed: seed + 7, amp: 0.8, reg: [0, 0] });
    inkLoop(c, P, { seed: seed + 8, w: 3.6, amp: 0.8, heavy: 0, dense: true });
  } else inkStroke(c, m, { seed: seed + 7, w: 4.2, taperIn: 4, taperOut: 4, min: 0.4, heavy: 0, amp: 0.8 });
}

// ---------------------------------------------------------------- the matchbox
function drawBox(c: CanvasRenderingContext2D, v: number, scratch: number, label: { zh: XY[][]; en: StrokeText }) {
  const { x0, x1, y1, y2, dx, dy } = BOX;
  const a: Pt = [x0, y1], b: Pt = [x1, y1], cc: Pt = [x1 + dx, y1 + dy], d: Pt = [x0 + dx, y1 + dy], e: Pt = [x0, y2], g: Pt = [x1, y2], h: Pt = [x1 + dx, y2 + dy];
  // cast shadow, hatched (light from the upper left)
  inkHatch(c, [[x0 + 30, y2 - 2], [x1, y2 - 2], [x1 + dx, y2 + dy], [x1 + dx + 70, y2 + dy + 40], [x1 + 60, y2 + 34], [x0 + 60, y2 + 30]], { seed: 300 + v, gap: 13, angle: -0.95, w: 2.6, amp: 1.2 });
  inkFill(c, sharp([a, b, cc, d]), CEL.red, { seed: 310 + v, amp: 1.8 });
  inkFill(c, sharp([a, b, g, e]), CEL.yel, { seed: 320 + v, amp: 1.8 });
  inkFill(c, sharp([b, cc, h, g]), CEL.red, { seed: 330 + v, amp: 1.8 });
  inkHatch(c, [b, cc, h, g], { seed: 340 + v, gap: 11, angle: 1.15, w: 2.2, amp: 1 });
  // the striker band and its grit
  const band = sharp([[x0 + 22, y1 + 20], [x1 - 22, y1 + 20], [x1 - 22, y2 - 20], [x0 + 22, y2 - 20]]);
  inkFill(c, band, CEL.ink, { seed: 350 + v, amp: 1.4 });
  c.fillStyle = CEL.cream;
  for (let i = 0; i < 90; i++) {
    const x = lerp(x0 + 30, x1 - 30, hash(i, 3)) + (hash(i, v, 6) - 0.5) * 1.6, y = lerp(y1 + 26, y2 - 26, hash(i, 4)) + (hash(i, v, 7) - 0.5) * 1.6;
    c.beginPath(); c.arc(x, y, (0.9 + 1.4 * hash(i, 5)) * BRUSH.ink, 0, Math.PI * 2); c.fill();
  }
  if (scratch > 0) { // the strike's scratch across the band
    const ym = (y1 + y2) / 2;
    inkStroke(c, [[x0 + 60, ym + 2], [lerp(x0 + 60, x1 - 40, scratch * 0.5), ym - 3], [lerp(x0 + 60, x1 - 40, scratch), ym + 1]], { seed: 355 + v, w: 4.5, taperIn: 30, taperOut: 60, amp: 1, color: CEL.cream, heavy: 0 });
  }
  // the label on the top face, its lettering sheared onto it
  const LP = (u: number, w: number): Pt => [x0 + u * (x1 - x0) + w * dx, y1 + w * dy];
  const lab = sharp([LP(0.33, 0.2), LP(0.77, 0.2), LP(0.77, 0.82), LP(0.33, 0.82)]);
  inkFill(c, lab, CEL.hi, { seed: 360 + v, amp: 1.4, reg: [REG[0] * 0.6, REG[1] * 0.6] });
  c.save();
  const O = LP(0.33, 0.2), X = LP(0.77, 0.2), Y = LP(0.33, 0.82), bw = 560, bh = 100; // text box (0..bw, 0..bh), y up the face
  c.transform((X[0] - O[0]) / bw, (X[1] - O[1]) / bw, (Y[0] - O[0]) / bh, (Y[1] - O[1]) / bh, O[0], O[1]);
  c.translate((hash(v, 61) - 0.5) * 1.6, (hash(v, 62) - 0.5) * 1.6);
  inkFill(c, spline(place(flameUnit(3, 0.1), { x: 52, y: 4, sx: 72, sy: -84 }), true, 3), CEL.red, { seed: 363 + v, amp: 0.8, dense: true, reg: [0, 0] });
  c.scale(1, -1); // the text box's y runs up the face: letters stand on its front edge
  inkFill(c, label.zh, CEL.ink, { seed: 364 + v, amp: 0.9, scale: 30, dense: true, reg: [0, 0] });
  c.translate(300, -24);
  inkText(c, label.en, Infinity, { seed: 365 + v, w: 3.2, amp: 0.8 });
  c.restore();
  inkLoop(c, lab, { seed: 370 + v, w: 3.4, amp: 1.2, heavy: 0.2 });
  // edges, overshooting at the corners
  ([[a, b], [b, cc], [cc, d], [d, a], [a, e], [e, g], [g, b], [g, h], [h, cc]] as const).forEach(([p, q], i) => inkEdge(c, p, q, { seed: 380 + v * 20 + i, w: 5.2 }));
}

// ---------------------------------------------------------------- effects
function drawGlow(c: CanvasRenderingContext2D, x: number, y: number, r: number, a: number, d: Drawing) {
  if (a <= 0 || r <= 1) return;
  const f = 1 + 0.035 * (hash(d.id, 81) - 0.5);
  c.save();
  c.globalCompositeOperation = 'multiply';
  inkFill(c, ellipse(x, y, r * 1.25 * f, r * 1.2 * f, 40), '#fbf0c8', { seed: 90 + d.v, amp: 9, scale: 170, reg: [0, 0], alpha: a });
  inkFill(c, ellipse(x, y, r * f, r * 0.96 * f, 40), '#f9e3a0', { seed: 95 + d.v, amp: 8, scale: 150, reg: [0, 0], alpha: a });
  c.restore();
}
function drawSpark(c: CanvasRenderingContext2D, x: number, y: number, vx: number, vy: number, size: number, seed: number) {
  const sp = Math.hypot(vx, vy) || 1, len = size * (1.4 + Math.min(5, sp / 450)), r = size * 0.55;
  const P = place([[r, 0], [r * 0.7, r * 0.72], [0, r], [-len, 0, 1], [0, -r], [r * 0.7, -r * 0.72]], { x, y, r: Math.atan2(vy, vx) });
  const d = spline(P, true, 3);
  inkFill(c, d, CEL.yel, { seed, amp: 1.2, dense: true, reg: [REG[0] * 0.5, REG[1] * 0.5] });
  inkLoop(c, d, { seed: seed + 1, w: Math.max(2.2, size * 0.16), amp: 1, taperIn: 3, taperOut: 10, heavy: 0.2, dense: true });
}
function radialLines(c: CanvasRenderingContext2D, x: number, y: number, r0: number, r1: number, n: number, seed: number, w: number) {
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + (hash(seed, k) - 0.5) * 0.3, q0 = r0 * (0.9 + 0.2 * hash(seed, k, 2)), q1 = r1 * (0.8 + 0.3 * hash(seed, k, 3));
    inkStroke(c, [[x + Math.cos(a) * q0, y + Math.sin(a) * q0], [x + Math.cos(a) * q1, y + Math.sin(a) * q1]], { seed: seed * 7 + k, w, taperIn: 6, taperOut: 60, min: 0.05, heavy: 0, amp: 1 });
  }
}
function drawPuff(c: CanvasRenderingContext2D, x: number, y: number, r: number, seed: number) {
  const P: Pt[] = [];
  for (let i = 0; i < 5; i++) {
    const a = Math.PI + (i / 4) * Math.PI;
    P.push([x + Math.cos(a) * r * 1.2, y + Math.sin(a) * r * 0.8 + r * 0.3, 1]);
    const b = a + Math.PI / 8;
    if (i < 4) P.push([x + Math.cos(b) * r * 1.6, y + Math.sin(b) * r * 1.25 + r * 0.3]);
  }
  inkFill(c, P, CEL.hi, { seed, amp: 1, reg: [0, 0] });
  inkLoop(c, P, { seed: seed + 1, w: 3.4, amp: 1, heavy: 0 });
}
/** Smoke rising from the burnt head: two thin strands, swaying per drawing, curling at the top. */
function drawWisp(c: CanvasRenderingContext2D, x: number, y: number, grow: number, d: Drawing) {
  for (let k = 0; k < 2; k++) {
    const P: Pt[] = [];
    for (let i = 0; i <= 7; i++) {
      const u = i / 7, sway = Math.sin(u * 4.2 + k * 1.3 + (d.hold ? d.v : d.id) * 0.9) * 14 * u;
      P.push([x + 8 * k + sway + u * u * 70, y - u * 230 - k * 18]);
    }
    const top = P[P.length - 1]!, cr = 16 - 5 * k;
    for (let i = 1; i <= 6; i++) { const a = Math.PI + (i / 6) * Math.PI * 1.6; P.push([top[0] + cr + Math.cos(a) * cr, top[1] + Math.sin(a) * cr]); }
    const pts = prefix(spline(P, false, 4), grow);
    if (pts.length > 2) inkStroke(c, pts, { seed: 700 + k * 9 + d.v, w: 3 - k * 0.6, taperIn: 4, taperOut: 70, min: 0.08, heavy: 0, amp: 1.2, dense: true });
  }
}

// ---------------------------------------------------------------- the scene
/** Camera: world point (px, py) at screen (X, Y), zoom s (1 = the drawings' own size; closeUp compensates the rest). */
interface Cam { s: number; px: number; py: number; X: number; Y: number }
const SHOT: Record<'open' | 'wide' | 'close' | 'title', Cam> = {
  open: { s: 1.55, px: 900, py: 760, X: 960, Y: 560 },
  wide: { s: 1.15, px: 930, py: 640, X: 960, Y: 560 },
  close: { s: 2.1, px: 700, py: 690, X: 900, Y: 560 },
  title: { s: 1.1, px: 925, py: 560, X: 960, Y: 545 },
};

export default class DemoBrush extends Scene {
  layer = new Layer2D();
  paper!: PaperSheet;
  sheet: Sheet = SHEET;
  label!: { zh: XY[][]; en: StrokeText };
  title: { loops: XY[][]; cx: number; cy: number }[] = [];
  hand!: StrokeText;
  private st = new Map<string, StrokeText>();

  override async init() {
    const [paper] = await Promise.all([loadPaper(), loadStrokeFonts()]);
    this.paper = paper;
    this.sheet = SHEET.map(([a, r]) => [a + this.ctx.start, r] as const);
    // label lettering (y up the face: drawn flipped) and the title, outlined once
    this.label = { zh: textLoops('火柴', 'NotoSansSC-900', 62, 92, -24), en: strokeText('SAFETY MATCHES', 'readable', 26) };
    const fam = 'NotoSansSC-900', size = 150, lay = layout('手作', fam, size), x0 = BUBBLE.x - lay.width / 2, base = BUBBLE.y + 30;
    this.title = lay.glyphs.map((g) => ({ loops: textLoops(g.ch, fam, size, x0 + g.x, base), cx: x0 + g.x + g.w / 2, cy: base - size * 0.38 }));
    this.hand = strokeText('hand made', 'hscript', 80);
  }

  private text(s: string, font: StrokeFontName, size: number) {
    const k = `${font}:${size}:${s}`;
    let st = this.st.get(k);
    if (!st) { st = strokeText(s, font, size); this.st.set(k, st); }
    return st;
  }

  override cues(): Cue[] {
    const s = this.ctx.start;
    return [
      { t: s + 2, name: 'match ignites' }, { t: s + 4, name: 'flame crouches to jump', on: 'beat' },
      { t: s + 4.5, name: 'flame lands', on: 'beat' }, { t: s + 6, name: 'push in' }, { t: s + 10, name: 'cut wide, title pops' },
    ];
  }

  /** Shots: on the striker, cut wide on the toss, push in to the flame, cut wide for the title. */
  private camera(lt: number): Cam {
    if (lt < 2.1) return SHOT.open;
    if (lt >= 10) return SHOT.title;
    const u = ease.inOutCubic(clamp((lt - 6) / 0.8)), a = SHOT.wide, b = SHOT.close;
    return { s: lerp(a.s, b.s, u), px: lerp(a.px, b.px, u), py: lerp(a.py, b.py, u), X: lerp(a.X, b.X, u), Y: lerp(a.Y, b.Y, u) };
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const c = this.layer.ctx, start = this.ctx.start;
    const d = celDrawing(f.t, this.sheet), lt = d.t - start, v = d.v;
    const cam = this.camera(f.t - start); // the camera moves on every frame (60 fps), the drawings are held
    this.layer.clear();
    drawPaper(c, this.paper);

    closeUp(cam.s); // close-up compensation: the lines keep their drawn weight on screen
    c.save();
    c.translate(cam.X, cam.Y); c.scale(cam.s, cam.s); c.translate(-cam.px, -cam.py);

    const m = matchAt(lt), mPrev = matchAt(lt - 1 / 12), sp = spiritAt(lt, m, mPrev);
    // the light of the flame, multiplied into the paper
    if (lt >= 2.0) {
      const lit = ease.outCubic(clamp((lt - 2.0) / 0.4));
      const [gx, gy] = sp ? [sp.x, sp.y - sp.H * 0.45] : [m.hx, m.hy];
      drawGlow(c, gx, gy, lerp(200, 330, lit) * (lt < 2.1 ? 1.15 : 1), lit, d);
    }
    const strike = clamp((lt - 1.45) / 0.25);
    drawBox(c, v, lt >= 1.5 ? strike : 0, this.label);

    // ---- the match: the strike's smear and multiples drawings, otherwise the drawing itself
    const k = Math.round((lt - 1.45) * 30), seedM = 200 + v * 7;
    if (lt >= 1.45 && lt < 1.65 && (k === 3 || k === 4)) {
      const pv = matchAt(lt - 1 / 30), [H1, B1] = ends(m), [H0, B0] = ends(pv);
      if (k === 3) { // smear: the swept area streaked, the head stretched back ~300 % along its path
        inkFill(c, sharp([B0, H0, H1, B1]), CEL.hi, { seed: 330 + d.id, amp: 1.5 });
        for (let j = 0; j < 6; j++) {
          const u = 0.12 + j * 0.15 + hash(d.id, j) * 0.05;
          inkStroke(c, [[lerp(H0[0], B0[0], u), lerp(H0[1], B0[1], u)], [lerp(H1[0], B1[0], u), lerp(H1[1], B1[1], u)]], { seed: d.id * 3 + j, w: 3, taperIn: 60, taperOut: 12, min: 0.05, amp: 1.2, heavy: 0 });
        }
        drawStick(c, m, seedM);
        drawHead(c, m, seedM + 5, smearShape(spline(headPts(m), true, 3), H1[0] - H0[0], H1[1] - H0[1], Math.hypot(H1[0] - H0[0], H1[1] - H0[1]) * 1.1, 1.4));
      } else { // multiples: three drawn echoes between the last pose and this one
        for (let j = 0; j < 3; j++) {
          const u = 0.25 + j * 0.25, e: Match = { ...m, hx: lerp(pv.hx, m.hx, u), hy: lerp(pv.hy, m.hy, u), a: lerp(pv.a, m.a, u) };
          const [He, Be] = ends(e);
          inkStroke(c, [Be, He], { seed: d.id + 10 + j, w: 3.2, taperIn: 40, taperOut: 10, min: 0.1, amp: 1.2, heavy: 0 });
          drawHead(c, e, d.id * 5 + j * 2);
        }
        drawStick(c, m, seedM);
        drawHead(c, m, seedM + 5);
      }
    } else {
      drawStick(c, m, seedM);
      drawHead(c, m, seedM + 5);
    }
    // speed lines along the striker, and the phosphor spitting at the end of the drag
    if (lt >= 1.55 && lt < 2.0) {
      for (let j = 0; j < 4; j++) {
        const yy = m.hy - 24 + j * 16 + hash(d.id, j) * 5, xe = m.hx - 50 - hash(d.id, j, 2) * 40;
        inkStroke(c, [[xe - 240 - hash(d.id, j, 3) * 160, yy], [xe, yy]], { seed: d.id * 4 + j, w: 4.2, taperIn: 120, taperOut: 8, min: 0.05, heavy: 0, amp: 1.2, color: CEL.hi });
      }
    }
    if (lt >= 1.75 && lt < 2.0) {
      for (let j = 0; j < 5; j++) {
        const a = Math.PI + (j - 2) * 0.38 + (hash(d.id, j, 9) - 0.5) * 0.3, dd = 40 + 30 * hash(d.id, j, 4);
        drawSpark(c, m.hx + Math.cos(a) * dd, m.hy - 20 + Math.sin(a) * dd, Math.cos(a) * 700, Math.sin(a) * 700, 7, d.id * 11 + j);
      }
    }
    // the ignition burst (on ones, then it shrinks away on the first drawing on twos)
    if (lt >= 2.0 && lt < 2.18) {
      const u = clamp((lt - 2.0) / 0.15), R = lerp(150, 215, ease.outQuad(u)) * (lt >= 2.1 ? 0.7 : 1);
      if (lt < 2.07) radialLines(c, m.hx, m.hy, R * 1.12, R * 2.3, 13, 300 + d.id, 5);
      const P = spline(place(starPts(10, R, R * 0.45, 40 + d.id, d.id * 0.4), { x: m.hx, y: m.hy }), true, 4);
      inkFill(c, P, CEL.yel, { seed: 41 + d.id, amp: 1.5, dense: true });
      if (lt < 2.07) inkFill(c, spline(place(starPts(8, R * 0.5, R * 0.26, 45 + d.id, d.id * 0.4 + 0.3), { x: m.hx, y: m.hy }), true, 4), lt < 2.033 ? CEL.hi : CEL.red, { seed: 46 + d.id, amp: 1.5, dense: true });
      inkLoop(c, P, { seed: 47 + d.id, w: 6, amp: 1.5, heavy: 0.3, dense: true });
    }
    if (m.burnt) drawWisp(c, m.hx + 4, m.hy - 30, ease.outCubic(clamp((lt - 4.25) / 0.6)), d);

    // ---- the flame: a dotted pencil arc where it jumped, dust where it lands, then the flame itself
    if (lt >= 4.23 && lt < 5.2) {
      c.fillStyle = CEL.pencil;
      for (let j = 2; j < 20; j++) {
        const u = j / 20;
        if (u > (lt - HOP.t0) / HOP.dur + 0.05) break;
        const [p] = hopAt(u);
        c.globalAlpha = 0.85;
        c.beginPath(); c.arc(p[0] + (hash(j, v) - 0.5) * 2, p[1] - 70 + (hash(j, v, 2) - 0.5) * 2, 3.2, 0, Math.PI * 2); c.fill();
      }
      c.globalAlpha = 1;
    }
    if (lt >= 4.5 && lt < 4.65) {
      const q = lt < 4.55 ? 0 : 1;
      for (const sg of [-1, 1]) drawPuff(c, LAND[0] + sg * (95 + 22 * q), LAND[1] - 6 - 6 * q, (17 + 5 * q) * (q ? 0.8 : 1), 7700 + (sg + 1) * 3 + q + v * 10);
    }
    if (sp) drawSpirit(c, sp, d, 500 + v * 30);
    // twinkles in the close-up hold
    if (lt >= 7.0 && lt < 10) {
      const TW: [number, number, number][] = [[470, 540, 26], [850, 500, 20], [830, 690, 15], [480, 700, 13]];
      TW.forEach(([x, y, R], j) => {
        const on = lt >= 7.0 + j * 0.34, beat = mod(Math.round(lt * 6) + j, 3);
        if (!on) return;
        const P = spline(place(twinklePts(R * (beat === 0 ? 1.25 : 1), 900 + j * 5 + v), { x, y }), true, 3);
        inkFill(c, P, CEL.yel, { seed: 910 + j + v, amp: 1.2, dense: true, reg: [REG[0] * 0.6, REG[1] * 0.6] });
        inkLoop(c, P, { seed: 920 + j + v, w: Math.max(2.5, R * 0.12), amp: 1.2, taperIn: 4, taperOut: 8, heavy: 0.2, dense: true });
      });
    }
    // ---- the title: the bubble and each character pop on ones, then the pen writes
    if (lt >= 10) this.drawTitle(c, lt, d);
    c.restore();

    closeUp(1); // screen-space lettering below, and leave the brush as other scenes expect it
    this.drawSlate(c, d);
    paperTooth(c, this.paper, v, 0.5);
    this.ctx.comp.draw(this.ctx.renderer, this.layer.upload(), out, { mode: 'replace' });
  }

  private drawTitle(c: CanvasRenderingContext2D, lt: number, d: Drawing) {
    const v = d.v, pop = (t0: number) => {
      const k = Math.floor((lt - t0) * 30 + 1e-6);
      return k < 0 ? 0 : ([0.35, 0.85, 1.14, 1.06, 0.98][k] ?? 1);
    };
    const s = pop(10);
    if (s <= 0) return;
    const bub = place(cloudPts(0, 0, BUBBLE.rx, BUBBLE.ry, 13, 5), { x: BUBBLE.x, y: BUBBLE.y, sx: s, sy: s, r: -0.035 });
    inkFill(c, bub, CEL.red, { seed: 600 + v, amp: 2 });
    inkLoop(c, bub, { seed: 610 + v, w: 6.5, amp: 2, heavy: 0.4 });
    this.title.forEach((g, j) => {
      const k = pop(10.1 + j * 0.1);
      if (k <= 0) return;
      const loops = g.loops.map((L) => place(L.map(([x, y]): Pt => [x - g.cx, y - g.cy]), { x: g.cx, y: g.cy, sx: k, sy: k, r: j ? 0.05 : -0.06 }));
      inkFill(c, loops, CEL.yel, { seed: 620 + j * 10 + v, amp: 1.5, scale: 50, dense: true });
      for (const [i, L] of loops.entries()) inkLoop(c, L, { seed: 630 + j * 10 + i * 3 + v, w: 4.8, amp: 1.5, scale: 50, dense: true, heavy: 0.5, taperIn: 6, taperOut: 10 });
    });
    // "hand made", written with the pen (cream inside an ink edge), from 10.4 s over a second
    const st = this.hand, len = st.total * clamp((lt - 10.4) / 1.1);
    if (len > 0) {
      c.save();
      c.translate(BUBBLE.x - st.width / 2 + 10, BUBBLE.y + 112);
      c.rotate(-0.04);
      inkText(c, st, len, { seed: 640 + v, w: 12.5, color: CEL.ink, min: 0.5 });
      inkText(c, st, len, { seed: 640 + v, w: 6, color: CEL.hi, min: 0.4 });
      c.restore();
    }
  }

  /** Scene slate and the exposure counter, in red pencil on paper tabs (screen space, like the reference's). */
  private drawSlate(c: CanvasRenderingContext2D, d: Drawing) {
    const v = d.v, tab = (x0: number, y0: number, x1: number, y1: number, seed: number) =>
      inkFill(c, sharp([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]), CEL.hi, { seed, amp: 1.5, reg: [0, 0], alpha: 0.7 });
    tab(78, 64, 252, 134, 800 + v);
    c.save(); c.translate(102, 114); inkText(c, this.text('SC. 01', 'felix', 40), Infinity, { seed: 810 + v, color: CEL.pencil, w: 3.4 }); c.restore();
    tab(1640, 940, 1852, 1046, 820 + v);
    const on = this.text(`on ${Math.max(1, Math.round(24 / d.rate))}s`, 'felix', 26), no = this.text(`No. ${String(d.id + 1).padStart(3, '0')}`, 'felix', 42);
    c.save(); c.translate(1826 - on.width, 980); inkText(c, on, Infinity, { seed: 830 + v, color: CEL.pencil, w: 2.6 }); c.restore();
    c.save(); c.translate(1826 - no.width, 1028); inkText(c, no, Infinity, { seed: 840 + v, color: CEL.pencil, w: 3.6 }); c.restore();
  }
}

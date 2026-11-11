// MG 示例（?mg）：一段 17 秒的扁平图形小片「点 · 面 · 线」，把 kit/anim.ts 和 kit/morph.ts 的 MG 动作件串成一条连贯的动作：
//   点  网格点按环数 + 角度错峰弹出（stagger + pop）；主角红点从天而降（解析拖影 smearDisc），起跳压扁、空中拉长、落地一记冲击（hops），
//       每次落地网格按距离荡开
//   面  大跳落地时红点胀成太阳（SlotMorph 经过圆，射线错峰被推出圆外），再沿弧线跳到左边变成定位针（换色从前缘扫进去），
//       针尖着地、晃两下，蓝色从针里漫出来铺满画面，针眼留下当笔尖
//   线  一笔画出一排小房子（OneLine：植物抖、房子直、太阳不抖；拐角减速；屋顶处停一拍），镜头领先笔尖（lead + holdClock），
//       缩放在对数空间（kfz）；画完的圆胀成太阳
//   题  van Wijk 缩放平移（zoomPath）飞到片名，字错峰弹出，最后一个红点落成句号
// 逐元素快门：网格、图标停住时、字、色块边都用 shutterT(t, 0) 保持锐利；飞行的红点和跳跃 / 变形中的图标用真实 t（运动模糊），
// 镜头始终用真实 t。参考 mg-styles-15 demos/01-flat-vector、08-morph、02-line-art、19-paperclip、03-isometric（MIT）。
import type * as THREE from 'three';
import { Scene, type Cue, type Frame, type TrackPoint } from '../../engine/scene';
import { Layer2D, W, H } from '../../engine/gl';
import { F, font } from '../../engine/type';
import { clamp, lerp, prog, shutterT, TAU, type V2 } from '../../engine/util';
import {
  E, bezier, kick, pop, hops, applySquash, stagger, kfz, lerpZoom, zoomPath, lead, holdClock, mixColor, applyCamera, toScreen,
  type HopLeg, type View, type Key,
} from '../kit/anim';
import {
  parts, SlotMorph, placeMatrix, mapPt, travel, drawParts, smearDisc, OneLine, flatten, circle, type Parts, type Place, type LinePiece,
} from '../kit/morph';
import { parsePathD } from '../kit/svg';

// ---------------------------------------------------------------- palette (cream paper, ink, vermilion, ultramarine)
const PAPER = '#F2EDE3', INK = '#17161C', VERM = '#EE4B2B', ULTRA = '#2B3AD6', ULTRA_D = '#1D29A3';
const DOT = '#CFC6B6', TONE = '#E5DDCF', TONE_U = '#3746DD';
const LINE_HOT = '#FFFCF5', LINE_DIM = mixHex(ULTRA, PAPER, 0.62);
/** The export shutter (0.5 of a 60 fps frame) the analytic smears stand in for. */
const SH = 0.5 / 60;

function mixHex(a: string, b: string, u: number) {
  const m = mixColor(a, b, u).match(/\d+/g)!.map(Number);
  return '#' + m.map((v) => v.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- act 1: the dot on the grid
const GC = { x: 960, y: 520 }, GS = 120, R = 36;
const P1 = { x: GC.x - 3 * GS, y: GC.y }, P2 = { x: GC.x, y: GC.y };
const HERO0 = { x: P1.x, y: -90 };
const LEGS: HopLeg[] = [
  { to: P1, t0: 1.6, t1: 2.0, height: 0, antic: 0 },    // dropped in, lands on the downbeat
  { to: P2, t0: 2.55, t1: 3.0, height: 150 },
  { to: P2, t0: 3.45, t1: 4.0, height: 300, antic: 0.2 }, // the big one: lands on 4.0 and becomes the sun
];
const LANDS: [number, V2, number][] = [[2.0, P1, 1], [3.0, P2, 1], [4.0, P2, 1.7]];
const ACCENT: Record<string, 'ring' | 'plus' | 'pill' | 'half'> = { '-5,-2': 'ring', '4,-2': 'plus', '-2,2': 'pill', '4,2': 'half' };

// ---------------------------------------------------------------- act 2: icons (local px, origin = the icon's centre)
const SUN_C = { x: 960, y: 470 }, PIN_C = { x: 560, y: 440 }, PIN_TIP = 170, PIN_S = 1.15;
const path = (d: string, tol = 1.5) => flatten(parsePathD(d), tol)[0]!;
const ray = (deg: number, r0: number, r1: number, w: number) => {
  const a = (deg * Math.PI) / 180;
  return { pts: [{ x: Math.cos(a) * r0, y: Math.sin(a) * r0 }, { x: Math.cos(a) * r1, y: Math.sin(a) * r1 }], w };
};
function icons() {
  const dot = parts({ body: circle(0, 0, R, 96) });
  const sun = parts({ body: circle(0, 0, 118, 96), strokes: Array.from({ length: 8 }, (_, k) => ray(-90 + 45 * k, 160, 214, 20)) });
  // pin: a circle and the two tangents to its tip (rounded), the eye a circle, a fold facet on the lower right
  const ct = Math.acos(100 / PIN_TIP), tx = 100 * Math.sin(ct), ty = 100 * Math.cos(ct), k = 12 / Math.hypot(tx, PIN_TIP - ty);
  const ex = tx * k, ey = PIN_TIP - (PIN_TIP - ty) * k;
  const pin = parts({
    body: path(`M ${-ex} ${ey} L ${-tx} ${ty} A 100 100 0 1 1 ${tx} ${ty} L ${ex} ${ey} Q 0 ${PIN_TIP + 2} ${-ex} ${ey} Z`),
    hole: circle(0, 0, 36, 72),
    shade: [{ x: 0, y: PIN_TIP + 6 }, { x: tx + 6, y: ty - 4 }, { x: 0, y: 0 }],
  });
  return { dot, sun, pin };
}

// ---------------------------------------------------------------- act 3: the one line (world px; the pen starts in the pin's eye)
const SUN2 = { x: 1640, y: 484, r: 82 };
const LINE_D: [name: string, wobble: number, d: string][] = [
  ['drop', 0.3, 'M560,440 C560,530 563,602 578,627 C588,640 602,640 624,640'],
  ['ground0', 0.3, 'M624,640 L690,640'],
  ['sprout', 0.6, 'M690,640 C691,626 692,612 694,600 C708,598 730,592 744,572 C726,566 708,574 697,588 C699,576 700,566 700,556 '
    + 'C686,552 664,546 652,524 C672,518 690,528 700,542 C701,530 702,520 703,512 C706,498 716,488 732,485 C740,484 746,484 752,484'],
  ['roof', 0.06, 'M752,484 L905,484'],
  ['house', 0.05, 'M905,484 L905,640 L950,640'],
  ['tower', 0.05, 'M950,640 L992,640 L992,418 L1016,398 L1062,398 L1062,640'],
  ['arch', 0.05, 'M1062,640 L1100,640 L1100,560 A36,36 0 0 1 1172,560 L1172,640'],
  ['horizon', 0.15, 'M1172,640 L1380,640'],
  ['hill', 0.35, `M1380,640 C1440,640 1480,604 1530,590 C1565,580 1600,${SUN2.y + SUN2.r + 1} ${SUN2.x},${SUN2.y + SUN2.r}`],
  ['sun1', 0, `M${SUN2.x},${SUN2.y + SUN2.r} A${SUN2.r},${SUN2.r} 0 1 0 ${SUN2.x},${SUN2.y - SUN2.r}`],
  ['sun2', 0, `M${SUN2.x},${SUN2.y - SUN2.r} A${SUN2.r},${SUN2.r} 0 1 0 ${SUN2.x},${SUN2.y + SUN2.r}`],
];
// keys spaced by corner-weighted length (even pace; corners slow down by themselves), one hold on the roof's beat
const DRAW_KEYS: [number, string][] = [
  [8.2, 'drop'], [8.5, 'ground0'], [8.6, 'sprout'], [9.28, 'roof'], [9.5, 'roof>'], [9.75, 'roof>'], [10.0, 'house>'],
  [10.78, 'tower>'], [11.22, 'arch>'], [11.48, 'horizon>'], [11.84, 'sun1'], [12.5, 'sun2>'],
];
const ZOOM_KEYS: Key<number>[] = [[8.0, 1.02], [9.05, 1.8], [9.6, 1.66], [10.4, 1.35], [11.3, 1.2], [12.1, 1.35], [12.6, 1.55], [12.8, 1.6]];
/** The drawing's middle: the camera only partly follows the pen when it is zoomed out. */
const ANCHOR = { x: 1100, y: 540 };

// ---------------------------------------------------------------- act 4: title (world px, far to the right of the drawing)
const TT = { x: 3350, y: 540 };
const CHARS = ['点', '线', '面'], CH_X = [-250, 0, 250], CH_SIZE = 170, BASE = 60;
const FLY = { t0: 12.6, t1: 14.0 };
const STOP = { x: TT.x + 250 + 118, y: TT.y + BASE - 21, r: 21 };

const ACTS = [
  { t: 0.3, n: '01', zh: '点', en: 'DOT' },
  { t: 4.0, n: '02', zh: '面', en: 'PLANE' },
  { t: 8.0, n: '03', zh: '线', en: 'LINE' },
];

const EB = bezier(0.42, 0, 0.12, 1); // the flood: gathers, then floods out and slows
const EFLY = bezier(0.45, 0, 0.3, 1);
/** Radius (world px) of the ultramarine flood around the pin at t. */
const floodR = (t: number) => (t < 8.0 ? 0 : lerp(120, 2400, EB(prog(t, 8.0, 8.65))));

export default class DemoMg extends Scene {
  layer = new Layer2D();
  grid: { p: V2; i: number; j: number; t0: number; kind?: 'ring' | 'plus' | 'pill' | 'half' }[] = [];
  tgrid: { p: V2; t0: number }[] = [];
  I!: ReturnType<typeof icons>;
  m1!: SlotMorph;
  m2!: SlotMorph;
  line!: OneLine;
  /** The fly to the title, built on first use from the camera at FLY.t0 (a pure function of t, so cached safely). */
  private fly: ReturnType<typeof zoomPath> | null = null;

  override init() {
    for (let j = -3; j <= 3; j++) for (let i = -6; i <= 6; i++) {
      const p = { x: GC.x + i * GS, y: GC.y + j * GS };
      this.grid.push({ p, i, j, kind: ACCENT[`${i},${j}`], t0: 0.15 + stagger(p, GC, { ring: GS, gap: 0.075, metric: 'box', turn: 0.12, jitter: 0.03, seed: 7 }) });
    }
    for (let j = -4; j <= 4; j++) for (let i = -9; i <= 9; i++) {
      const p = { x: TT.x + i * GS, y: TT.y + j * GS };
      if (Math.abs(p.x - TT.x) < 520 && Math.abs(p.y - TT.y) < 200) continue; // keep the type clear
      this.tgrid.push({ p, t0: 14.0 + stagger(p, STOP, { speed: 2600, jitter: 0.04, seed: 3 }) });
    }
    this.I = icons();
    this.m1 = new SlotMorph(this.I.dot, this.I.sun, { via: { x: 0, y: 0, r: 118 }, order: [0, 1, 7, 2, 6, 3, 5, 4] });
    this.m2 = new SlotMorph(this.I.sun, this.I.pin, { via: { x: 0, y: 10, r: 104 } });
    const pieces: LinePiece[] = LINE_D.map(([name, wobble, d]) => ({ name, wobble, pts: path(d, 1) }));
    this.line = new OneLine(pieces, { step: 0.75, seed: 5 }).timing(DRAW_KEYS);
  }

  override cues(): Cue[] {
    return [
      { t: 2.0, name: 'dot lands' }, { t: 3.0, name: 'hop lands', on: 'beat' }, { t: 4.0, name: 'big hop lands, dot → sun' },
      { t: 5.0, name: 'sun formed', on: 'beat' }, { t: 6.5, name: 'pin lands', on: 'beat' }, { t: 8.0, name: 'flood from the pin' },
      { t: 9.5, name: 'pen holds at the roof', on: 'beat' }, { t: 12.5, name: 'circle closes', on: 'beat' }, { t: 14.0, name: 'title full stop lands' },
    ];
  }

  // ---------------------------------------------------------------- camera
  /** World view at t (real time: the camera always blurs with its own motion). */
  view(t: number): View {
    if (t < 8.0) return { x: 960, y: 540, zoom: lerpZoom(1, 1.02, prog(t, 0, 8, E.ease)) };
    if (t >= FLY.t0) {
      this.fly ??= zoomPath(this.view(FLY.t0 - 1e-6), { x: TT.x + 40, y: TT.y + 10, zoom: 1 });
      if (t < FLY.t1) return this.fly(EFLY(prog(t, FLY.t0, FLY.t1)));
      return { x: TT.x + 40, y: TT.y + 10, zoom: lerpZoom(1, 1.05, prog(t, FLY.t1, 17, E.ease)) };
    }
    const p = lead((s) => this.line.tip(s), holdClock(t, this.line.holds), { lead: 0.08, sigma: 0.3 });
    const w = E.ease(prog(t, 8.1, 9.15)), z = lerpZoom(1.02, kfz(t, ZOOM_KEYS), w);
    // close in: follow the pen; pulled out: drift between the drawing's middle and the pen (the skyline should not bob)
    const kx = lerp(0.45, 0.9, clamp((z - 1.1) / 0.8));
    const x = lerp(ANCHOR.x, p.x, kx), y = lerp(ANCHOR.y, p.y, 0.4);
    return { x: lerp(960, x, w), y: lerp(540, y, w), zoom: z };
  }

  override track(t: number): Record<string, TrackPoint> {
    const v = this.view(t), cam = { ...v, rot: 0 };
    let p: V2 | null = null;
    if (t >= 1.6 && t < 4.0) p = hops(t, HERO0, LEGS, { r: R });
    else if (t >= 4.0 && t < 8.2) p = this.iconPlace(t).place;
    else if (t >= 8.2 && t < 12.6) p = this.line.tip(t);
    else if (t >= 13.7) p = this.stopPos(t);
    return p ? { hero: { ...toScreen(p, cam, W, H), s: v.zoom } } : {};
  }

  // ---------------------------------------------------------------- render
  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const t = f.t, tc = shutterT(t, 0);
    const c = this.layer.ctx;
    this.layer.clear(PAPER);
    c.letterSpacing = '0px';
    const v = this.view(t), cam = { ...v, rot: 0 };

    // the flood: ultramarine spilling out of the pin (a flat colour edge: 6 % of the shutter, nearly crisp)
    const tf = shutterT(t, 0.06);
    if (tf >= 8.65) this.layer.clear(ULTRA);
    else if (tf >= 8.0) {
      const o = toScreen(PIN_C, cam, W, H);
      c.fillStyle = ULTRA;
      c.beginPath(); c.arc(o.x, o.y, floodR(tf) * v.zoom, 0, TAU); c.fill();
    }

    c.save();
    applyCamera(c, cam, W, H);
    if (tc < 4.7) this.drawGrid(c, tc);
    this.drawHero(c, t, tc);
    this.drawIcon(c, t, tc);
    if (t >= 8.0) this.drawLine(c, t, tc, v.zoom);
    if (t >= 12.9) this.drawTitle(c, tc);
    c.restore();

    this.drawCaption(c, tc, cam);
    this.ctx.comp.draw(this.ctx.renderer, this.layer.upload(), out, { mode: 'replace' });
  }

  // ---------------------------------------------------------------- act 1
  private drawGrid(c: CanvasRenderingContext2D, tc: number) {
    for (const g of this.grid) {
      const pp = pop(tc, g.t0, { freq: 3, damping: 0.45, squash: 0.18, pin: 0.75 });
      if (pp.s <= 0.001) continue;
      // every landing rings the grid: a ripple running out from the contact point
      let bump = 0;
      for (const [tl, L, amp] of LANDS) {
        const d = Math.hypot(g.p.x - L.x, g.p.y - L.y);
        bump += amp * kick(tc, tl + stagger(g.p, L, { speed: 1100 }), 4.5, 0.35) * Math.exp(-d / 380);
      }
      // gone after the big landing, from the impact out
      const ex = 1 - E.in(prog(tc, 4.08 + Math.hypot(g.p.x - P2.x, g.p.y - P2.y) / 1500, 4.36 + Math.hypot(g.p.x - P2.x, g.p.y - P2.y) / 1500));
      if (ex <= 0.001) continue;
      const k = 1 + 0.55 * bump;
      c.save();
      c.translate(g.p.x, g.p.y - 9 * bump);
      c.scale(pp.sx * k * ex, pp.sy * k * ex);
      if (g.kind) this.accent(c, g.kind);
      else { c.fillStyle = DOT; c.beginPath(); c.arc(0, 0, 6, 0, TAU); c.fill(); }
      c.restore();
    }
  }

  /** Tone-on-tone brand shapes sitting on a few grid points (as in 01-flat-vector's opening sky). */
  private accent(c: CanvasRenderingContext2D, kind: 'ring' | 'plus' | 'pill' | 'half') {
    c.fillStyle = TONE; c.strokeStyle = TONE; c.lineCap = 'round';
    c.beginPath();
    if (kind === 'ring') { c.lineWidth = 20; c.arc(0, 0, 54, 0, TAU); c.stroke(); }
    else if (kind === 'plus') { c.lineWidth = 18; c.moveTo(-30, 0); c.lineTo(30, 0); c.moveTo(0, -30); c.lineTo(0, 30); c.stroke(); }
    else if (kind === 'pill') { c.roundRect(-96, -30, 192, 60, 30); c.fill(); }
    else { c.moveTo(-70, 18); c.arc(0, 18, 70, Math.PI, TAU); c.closePath(); c.fill(); }
  }

  private drawHero(c: CanvasRenderingContext2D, t: number, tc: number) {
    if (tc < 1.6 || tc >= 4.0) return;
    let p = hops(tc, HERO0, LEGS, { r: R });
    const dropping = tc < 2.0;
    if (p.air && !dropping) p = hops(t, HERO0, LEGS, { r: R }); // in flight: the real shutter (motion blur)
    // contact shadow on the ground under it: smaller and fainter the higher it is
    const ground = GC.y + R + 2, hgt = Math.max(0, ground - (p.y + R)), k = clamp(1 - hgt / 520);
    c.fillStyle = `rgba(23,22,28,${0.11 * k * k})`;
    c.beginPath(); c.ellipse(p.x, ground, R * (0.5 + 0.6 * k) * (p.air ? 1 : p.across), 5 * (0.5 + 0.5 * k), 0, 0, TAU); c.fill();
    if (dropping) {
      // falling ~3000 px/s: drawn crisp at the shutter's two ends and smeared analytically between them
      const a = hops(tc - SH / 2, HERO0, LEGS, { r: R }), b = hops(Math.min(tc + SH / 2, 2.0 - 1e-6), HERO0, LEGS, { r: R });
      smearDisc(c, a, b, R, VERM);
      return;
    }
    c.save();
    c.translate(p.x, p.y);
    applySquash(c, p);
    c.fillStyle = VERM;
    c.beginPath(); c.arc(0, 0, R, 0, TAU); c.fill();
    c.restore();
  }

  // ---------------------------------------------------------------- act 2
  /** Rays turn a notch when the sun forms (pure in t). */
  private sunState(t: number): Parts {
    const a = (TAU / 16) * E.back(prog(t, 4.92, 5.3)) + (TAU / 16) * E.back(prog(t, 5.42, 5.75)), ca = Math.cos(a), sa = Math.sin(a);
    const s = this.I.sun;
    return { ...s, strokes: s.strokes.map((st) => ({ w: st.w, pts: st.pts.map((p) => ({ x: p.x * ca - p.y * sa, y: p.x * sa + p.y * ca })) })) };
  }

  /** The icon's parts, place and colours at t. */
  private iconPlace(t: number): { P: Parts; place: Place; fill: string; shade?: string; sweep?: { to: string; p: number; dir?: number } } {
    if (t < 5.0) {
      // the dot lands from the big hop and swells into the sun through the circle; the landing squash rides on top
      const u = clamp((t - 4.0) / 0.95), P = this.m1.at(u);
      let bottom = 0;
      for (const q of P.body) bottom = Math.max(bottom, q.y);
      const pl = travel(E.morph(u), { x: P2.x, y: P2.y }, { x: SUN_C.x, y: SUN_C.y }, { stretch: 0.05 });
      pl.squash = 0.24 * kick(t, 4.0, 3.5, 0.4) * (1 - u); pl.pivot = { x: 0, y: bottom };
      return { P, place: pl, fill: VERM };
    }
    if (t < 5.5) {
      const b = 1 + 0.035 * kick(t, 5.0, 2.6, 0.3);
      return { P: this.sunState(t), place: { ...SUN_C, scale: b }, fill: VERM };
    }
    if (t < 6.5) {
      // sun → pin: an arc to the left, a half turn of spin, stretched along the travel; blue sweeps in from the front
      const u = clamp((t - 5.5) / 1.0), g = E.morph(u);
      const P = this.m2.at(u, this.sunState(t), this.I.pin);
      const pl = travel(g, { ...SUN_C }, { ...PIN_C, scale: PIN_S }, { arc: { x: 60, y: -230 }, spin: -0.4, stretch: 0.14 });
      return { P, place: pl, fill: VERM, shade: ULTRA_D, sweep: { to: ULTRA, p: clamp((u - 0.1) / 0.42), dir: pl.dir } };
    }
    // the pin: lands on its tip (squash about the tip, wobbles about it), winds up before the flood
    const q = 0.24 * kick(t, 6.5, 3.2, 0.35) + 0.13 * E.ease(prog(t, 7.55, 7.97)) * (1 - prog(t, 7.97, 8.05)) - 0.06 * kick(t, 8.0, 4, 0.4);
    const rot = 0.13 * kick(t, 6.56, 2.2, 0.22);
    const tip = { x: 0, y: PIN_TIP }, cr = Math.cos(rot), sr = Math.sin(rot), s = PIN_S;
    const pl: Place = {
      x: PIN_C.x + s * (tip.x - (cr * tip.x - sr * tip.y)), y: PIN_C.y + s * (tip.y - (sr * tip.x + cr * tip.y)),
      rot, scale: s, squash: q, pivot: tip,
    };
    const shade = mixHex(ULTRA_D, ULTRA, prog(t, 8.0, 8.15));
    return { P: this.I.pin, place: pl, fill: ULTRA, shade };
  }

  private drawIcon(c: CanvasRenderingContext2D, t: number, tc: number) {
    if (tc < 4.0 || tc >= 8.35) return;
    const moving = (tc >= 5.5 && tc < 6.5) || (tc >= 4.0 && tc < 4.95);
    const tt = moving ? clamp(t, tc - 0.05, tc + 0.05) : tc; // travel & morph: the real shutter; holds: crisp
    // ground shadow and the landing rings under the pin
    if (tc >= 6.2 && tc < 8.0) {
      const k = prog(tc, 6.2, 6.5, E.out), gy = PIN_C.y + PIN_TIP * PIN_S + 3;
      c.fillStyle = `rgba(23,22,28,${0.1 * k})`;
      c.beginPath(); c.ellipse(PIN_C.x, gy, 52 * k, 8 * k, 0, 0, TAU); c.fill();
      for (const t0 of [6.5, 7.0, 7.5]) {
        const u = prog(tc, t0, t0 + 0.75);
        if (u <= 0 || u >= 1) continue;
        const r = lerp(28, 210, E.out(u));
        c.strokeStyle = `rgba(43,58,214,${0.5 * (1 - u) * (1 - u)})`; c.lineWidth = 3;
        c.beginPath(); c.ellipse(PIN_C.x, gy, r, r * 0.17, 0, 0, TAU); c.stroke();
      }
    }
    const ic = this.iconPlace(tt);
    if (tc < 8.0) drawParts(c, ic.P, placeMatrix(ic.place), { fill: ic.fill, shade: ic.shade, sweep: ic.sweep });
    else drawParts(c, { ...ic.P, holeOn: false }, placeMatrix(ic.place), { fill: ULTRA, shade: ic.shade });
    // after the flood the eye is what's left: a cream dot that tightens into the pen tip
    if (tc >= 8.0) {
      const m = placeMatrix(ic.place), o = mapPt(m, { x: 0, y: 0 });
      const r = lerp(36 * PIN_S, 5.5, E.snap(prog(tc, 8.02, 8.3)));
      c.fillStyle = PAPER;
      c.beginPath(); c.arc(o.x, o.y, r, 0, TAU); c.fill();
    }
  }

  // ---------------------------------------------------------------- act 3
  private drawLine(c: CanvasRenderingContext2D, t: number, tc: number, zoom: number) {
    const L = this.line;
    // the closed circle swells into a sun (a pop with squash), under the line
    if (tc >= 12.5) {
      const p = pop(tc, 12.5, { freq: 2.6, damping: 0.5, squash: 0, pin: 0.5 });
      c.fillStyle = VERM;
      c.beginPath(); c.arc(SUN2.x, SUN2.y, SUN2.r * p.s + 1, 0, TAU); c.fill(); // +1: tucked under the line
    }
    if (t >= L.tStart) {
      L.draw(c, t, {
        width: 3.4 / zoom,
        color: (b) => mixColor(LINE_DIM, LINE_HOT, clamp((b - 0.4) / 0.6)),
        floor: (pc) => (L.names[pc]!.startsWith('sun') ? 0.75 : 0.4),
        taper: 60,
      });
    }
    // the pen tip: a cream bead with a soft halo while it draws
    if (tc >= 8.3 && tc < 12.75) {
      const p = L.tip(t), on = 1 - prog(tc, 12.5, 12.75);
      const g = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, 26 / zoom);
      g.addColorStop(0, `rgba(255,252,245,${0.45 * on})`); g.addColorStop(1, 'rgba(255,252,245,0)');
      c.fillStyle = g; c.beginPath(); c.arc(p.x, p.y, 26 / zoom, 0, TAU); c.fill();
      c.fillStyle = LINE_HOT; c.globalAlpha = on;
      c.beginPath(); c.arc(p.x, p.y, 5.5 / zoom, 0, TAU); c.fill();
      c.globalAlpha = 1;
    }
  }

  // ---------------------------------------------------------------- title
  private stopPos(t: number): V2 & { angle: number; along: number; across: number; air: boolean } {
    return hops(t, { x: STOP.x, y: STOP.y - 760 }, [{ to: STOP, t0: 13.62, t1: 14.0, height: 0, antic: 0 }], { r: STOP.r });
  }

  private drawTitle(c: CanvasRenderingContext2D, tc: number) {
    // tone-on-tone grid, rippling out from where the full stop lands
    for (const g of this.tgrid) {
      const pp = pop(tc, g.t0, { freq: 3, damping: 0.5, squash: 0.15, pin: 0.7 });
      if (pp.s <= 0.001) continue;
      c.save(); c.translate(g.p.x, g.p.y); c.scale(pp.sx, pp.sy);
      c.fillStyle = TONE_U; c.beginPath(); c.arc(0, 0, 5, 0, TAU); c.fill();
      c.restore();
    }
    c.fillStyle = PAPER;
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    c.font = font(F.sans(700), CH_SIZE);
    CHARS.forEach((ch, i) => {
      const t0 = 13.2 + 0.11 * i, p = pop(tc, t0, { freq: 2.6, damping: 0.42, squash: 0.14, pin: 0.85 });
      if (p.s <= 0.001) return;
      const x = TT.x + CH_X[i]!, y = TT.y + BASE, d = Math.abs(STOP.x - x);
      const b = 1 + 0.07 * kick(tc, 14.0 + d / 1800, 3, 0.35); // the full stop's landing runs back through the word
      c.save();
      c.translate(x, y - CH_SIZE * 0.36);
      c.scale(p.sx * b, p.sy * b);
      c.fillText(ch, 0, CH_SIZE * 0.36);
      c.restore();
    });
    // subtitle
    const sa = prog(tc, 14.15, 14.55, E.out);
    if (sa > 0) {
      c.globalAlpha = 0.72 * sa;
      c.font = font(F.mono(500), 24);
      c.letterSpacing = '7px';
      c.fillText('DOT · LINE · PLANE', TT.x + 4, TT.y + 150 + 16 * (1 - sa));
      c.letterSpacing = '0px';
      c.globalAlpha = 1;
    }
    c.textAlign = 'left';
    // the full stop: dropped onto the baseline, smeared while it falls
    if (tc >= 13.62) {
      if (tc < 14.0) {
        const a = this.stopPos(tc - SH / 2), b = this.stopPos(Math.min(tc + SH / 2, 14.0 - 1e-6));
        smearDisc(c, a, b, STOP.r, VERM);
      } else {
        const p = this.stopPos(tc);
        c.save(); c.translate(p.x, p.y); applySquash(c, p);
        c.fillStyle = VERM; c.beginPath(); c.arc(0, 0, STOP.r, 0, TAU); c.fill();
        c.restore();
      }
    }
  }

  // ---------------------------------------------------------------- captions (screen space, crisp)
  private drawCaption(c: CanvasRenderingContext2D, tc: number, cam: View & { rot: number }) {
    const fade = 1 - prog(tc, 12.45, 12.75);
    if (fade <= 0 || tc < ACTS[0]!.t) return;
    // ink on the paper; where the flood has spread under it, the same caption again in cream
    const o = toScreen(PIN_C, cam, W, H), rr = floodR(tc) * cam.zoom;
    const covered = [[0, 900], [W, 900], [0, H], [W, H]].every(([x, y]) => Math.hypot(x! - o.x, y! - o.y) < rr);
    if (!covered) this.caption(c, tc, INK, fade);
    if (rr > 0) {
      c.save();
      c.beginPath(); c.arc(o.x, o.y, rr, 0, TAU); c.clip();
      this.caption(c, tc, PAPER, fade);
      c.restore();
    }
  }

  private caption(c: CanvasRenderingContext2D, tc: number, ink: string, fade: number) {
    const x = 96, y = 1004;
    let i = 0;
    for (let k = 0; k < ACTS.length; k++) if (tc >= ACTS[k]!.t) i = k;
    const p = clamp((tc - ACTS[i]!.t) / 0.4), e = E.morph(p);
    c.save();
    c.beginPath(); c.rect(x - 8, y - 38, 520, 50); c.clip();
    c.fillStyle = ink;
    const draw = (k: number, dy: number, al: number) => {
      if (al <= 0.001) return;
      const a = ACTS[k]!;
      c.globalAlpha = al * fade;
      c.font = font(F.mono(500), 18);
      c.fillText(a.n, x, y + dy - 3);
      c.globalAlpha = al * fade * 0.45;
      c.fillText('/03', x + 24, y + dy - 3);
      c.globalAlpha = al * fade;
      c.font = font(F.sans(600), 32);
      c.fillText(a.zh, x + 96, y + dy);
      c.globalAlpha = al * fade * 0.6;
      c.font = font(F.mono(500), 14);
      c.letterSpacing = '3px';
      c.fillText(a.en, x + 146, y + dy - 4);
      c.letterSpacing = '0px';
    };
    if (i === 0) draw(0, 44 * (1 - e), e);
    else if (p < 1) { draw(i - 1, -44 * e, 1 - e); draw(i, 44 * (1 - e), e); }
    else draw(i, 0, 1);
    c.restore();
    // progress: three dots, the current one a capsule
    const act = i === 0 ? 0 : i - 1 + e;
    c.save();
    c.fillStyle = ink;
    let xr = W - 96;
    for (let k = ACTS.length - 1; k >= 0; k--) {
      const wgt = Math.max(0, 1 - Math.abs(k - act)), len = 24 * E.morph(wgt), r = 4.5;
      c.globalAlpha = fade * (0.3 + 0.7 * wgt);
      c.beginPath(); c.arc(xr - len, y - 12, r, Math.PI / 2, (3 * Math.PI) / 2); c.arc(xr, y - 12, r, -Math.PI / 2, Math.PI / 2); c.closePath(); c.fill();
      xr -= len + 22;
    }
    c.restore();
  }
}

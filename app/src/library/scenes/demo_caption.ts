// 综艺花字和 HUD 字示例（?caption）：0–8 s 综艺花字，8–17 s 科幻 HUD，8 s 的强拍上硬切。
//   花字：五层字（hanazi：挤出 2 层、彩色描边、白描边、渐变填充、高光，整组一层软影子）、单字弹出 + 停住后摆
//   （popChar）、按拍跳（beatHop）、砸入（slamIn，落定那一帧关快门 hitT）、集中线和爆炸框每秒重画 12 次
//   （focusLines / burst）、盖章、闪光星；
//   HUD：亮度三档按段落切换引导视线（tier）、面板通电闪 4 帧（flick / fuiPanel）、标签和读数逐字乱码解码
//   （decode / rollDigits）、辉光 + 黑晕的字（glowText，线条的辉光先做，字后画，黑晕把字从线和网格里托出来）、
//   锁定那一帧关快门不糊（hitT）、锁定后从目标处一圈圈把青色换成琥珀色。
// 参考 mg-styles-15 demos/18-hanazi、demos/22-hud（Vincentwei1021，MIT）。中文字体只有思源黑体（没有圆体），花字用 900。
// 注意：kit 里按 stepT / shutterT 取时间的函数（boil、flick、decode、hitT）要传歌曲秒 f.t，不能传局部时间。
import type * as THREE from 'three';
import { Scene, type Cue, type Frame, type PostOverrides } from '../../engine/scene';
import { Layer2D, W, H, SCALE } from '../../engine/gl';
import { F, font } from '../../engine/type';
import { clamp, lerp, ease, mod, hash, mulberry32, fbm2, frameIdx, shutterT, TAU } from '../../engine/util';
import {
  hanazi, popChar, beatHop, slamIn, idleWiggle, popOut, damped, burst, focusLines, sparkle, ringText,
  type HanaziStyle, type HanaziChar,
} from '../kit/textfx';
import { tier, flick, decode, rollDigits, glowText, fuiPanel, hitT, type GlowOpts } from '../kit/termhud';

type Ctx = CanvasRenderingContext2D;
const DEG = Math.PI / 180;
const prog = (t: number, t0: number, d: number) => clamp((t - t0) / d);

// ---- 时间（相对场景开头，秒；测试歌 120 bpm，强拍每 2 s） ----
const SPLIT = 8;                                   // 花字 → HUD
const TITLE = [0.5, 0.625, 0.75, 0.875, 1.0];      // 今日份快乐 逐字弹出（十六分音符）
const HOPS = [2, 2.5, 3, 3.5];                     // 标题踩拍跳
const TAG = 2.0, SUB = 2.5;                        // 主题牌砸入、副标题逐帧弹出
const DROP = 4.0;                                  // 硬切到爆炸框 + 震惊砸入
const SHOUT = [4.0, 4.0 + 1 / 30, 4.0 + 2 / 30, 4.0 + 3 / 30];
const LINE2 = 5.0, STAMP = 6.0, REHIT = 7.0, OUT = 7.78;
const BOOT = 8.0, DATA = 9.0, SEARCH = 10.0, CAND = [10.5, 11.0, 11.5], CONVERGE = 11.5, LOCK = 12.0, RESOLVE = 14.0, UPLINK = 15.0;

// ---- 花字样式 ----
const TITLE_ST: HanaziStyle = {
  family: F.sans(900), size: 190, white: 14, outer: 13, outerColor: '#FF3D7F', ext: 18, extColor: '#A3124F', gloss: 0.55,
  fillStops: [[0, '#FFFBD6'], [0.42, '#FFE23A'], [1, '#FF9A1F']],
};
const SUB_ST: HanaziStyle = { family: F.sans(900), size: 78, outer: 10, outerColor: '#1E2A78', ext: 9, extColor: '#0E1440', fill: '#FFFFFF', shadow: { dy: 8, sigma: 7 } };
const SHOUT_ST: HanaziStyle = {
  family: F.sans(900), size: 236, white: 13, outer: 13, outerColor: '#1A1030', ext: 18, extX: 6, extColor: '#1A1030', skew: -8 * DEG, gloss: 0.45,
  fillStops: [[0, '#FF8A8A'], [0.5, '#FF1E3C'], [1, '#C4001E']],
};
const LINE2_ST: HanaziStyle = { family: F.sans(900), size: 74, outer: 10, outerColor: '#16B9F0', ext: 9, extColor: '#0F2A6B', fill: '#FFFFFF', shadow: { dy: 8, sigma: 7 } };

// ---- HUD 墨色：青（搜索）、琥珀（锁定后）、白热（锁定那一帧） ----
interface Pal { ink: string; dim: string; deep: string; hot: string }
const CYAN: Pal = { ink: '#00E5FF', dim: '#138C9E', deep: '#0E3A42', hot: '#E8FEFF' };
const AMBER: Pal = { ink: '#FF9A2E', dim: '#A8641A', deep: '#47290C', hot: '#FFF1DC' };
const WHITE: Pal = { ink: '#FFFFFF', dim: '#BDF6FF', deep: '#3B6E76', hot: '#FFFFFF' };
const MONO = (px: number, wt = 500) => font(F.mono(wt), px);
const ZH = (px: number, wt = 400) => font(F.sans(wt), px);

const CX = 960, CY = 540, R = 300;                 // 瞄准镜
const TGT = { x: 88, y: -74 };                      // 目标在锁定那一刻相对镜心的位置
const DOT = 10;

/** Impact shake of the 花字 layer: a decaying wobble after t0 (x, y px; r rad). */
function kick(t: number, t0: number, A: number, k = 8, f = 12): [number, number, number] {
  const u = t - t0;
  if (u < 0 || u > 1.5) return [0, 0, 0];
  const e = A * Math.exp(-k * u);
  return [e * Math.sin(TAU * f * u), e * 0.8 * Math.cos(TAU * f * 0.83 * u + 0.7), e * 0.0005 * Math.sin(TAU * f * 0.6 * u)];
}

/** A static canvas w × h (logical px) at k device px per px, drawn once. */
function canvasOf(w: number, h: number, k: number, draw: (c: Ctx) => void): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(w * k); cv.height = Math.ceil(h * k);
  const c = cv.getContext('2d')!;
  c.scale(k, k); draw(c);
  return cv;
}

/** The red rubber stamp, drawn once at 1.5× resolution with speckled ink (knocked-out specks). */
function makeStamp(): HTMLCanvasElement {
  const r = 150, size = 2 * r + 24, k = SCALE * 1.5;
  const cv = document.createElement('canvas');
  cv.width = cv.height = Math.ceil(size * k);
  const c = cv.getContext('2d')!;
  c.scale(k, k); c.translate(size / 2, size / 2);
  c.fillStyle = '#E8283C'; c.beginPath(); c.arc(0, 0, r, 0, TAU); c.fill();
  c.strokeStyle = '#FFF4F0'; c.lineWidth = 5; c.beginPath(); c.arc(0, 0, r - 19, 0, TAU); c.stroke();
  c.lineWidth = 3; c.beginPath(); c.arc(0, 0, r - 56, 0, TAU); c.stroke();
  const ring = font(F.archivo(100, 900), 27), label = 'VARIETY  DAILY';
  c.font = ring;
  const tw = [...label].reduce((s, g) => s + c.measureText(g).width + 3, 0);
  ringText(c, ring, label, { x: 0, y: 0, r: r - 37, start: -Math.PI / 2 - tw / (2 * (r - 37)), tracking: 3, fill: '#FFF4F0' });
  for (const a of [Math.PI, 0]) sparkle(c, Math.cos(a) * (r - 37), Math.sin(a) * (r - 37) + 4, 11, { fill: '#FFF4F0', glow: null });
  c.fillStyle = '#FFF4F0'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.font = font(F.sans(900), 52); c.fillText('名场面', 0, -16);
  c.font = font(F.sans(900), 34); c.letterSpacing = '10px'; c.fillText('认证', 5, 38); c.letterSpacing = '0px';
  // worn ink: specks and a few dry streaks knocked out
  const rnd = mulberry32(85);
  c.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 340; i++) {
    const a = rnd() * TAU, d = Math.sqrt(rnd()) * r, s = 0.5 + rnd() * rnd() * 3.2;
    c.globalAlpha = 0.5 + rnd() * 0.5; c.beginPath(); c.arc(Math.cos(a) * d, Math.sin(a) * d, s, 0, TAU); c.fill();
  }
  c.lineCap = 'round';
  for (let i = 0; i < 7; i++) {
    const y = (rnd() - 0.5) * 2 * r, x = (rnd() - 0.5) * r;
    c.globalAlpha = 0.35; c.lineWidth = 1 + rnd() * 2.5; c.beginPath(); c.moveTo(x - 40 - rnd() * 60, y); c.lineTo(x + 40 + rnd() * 60, y + (rnd() - 0.5) * 8); c.stroke();
  }
  return cv;
}

export default class DemoCaption extends Scene {
  layer = new Layer2D();
  /** The HUD lines' glow: a quarter-resolution copy (glowSrc), blurred into its own small texture, added on the GPU. */
  glow = new Layer2D(W, H, SCALE / 4);
  glowSrc = new Layer2D(W, H, SCALE / 4);
  /** The HUD's static background (gradient, half resolution) and hex grid (full), uploaded once, composited on the GPU. */
  hudPlain = new Layer2D(W, H, SCALE / 2);
  hudHex = new Layer2D();
  stamp: HTMLCanvasElement | null = null;
  /** Static overlays of the 花字 boards, made once at half resolution. */
  bg: Record<'candy' | 'sunCore', HTMLCanvasElement> | null = null;
  /** The dot map's grid inside the scope (offsets from its centre). */
  dots: { x: number; y: number }[] = [];
  dotMemo = { tf: NaN, on: new Float32Array(0) };

  override init() {
    this.stamp = makeStamp();
    this.bg = {
      candy: canvasOf(W, H, 0.5, (c) => {
        const g = c.createRadialGradient(W / 2, H * 0.48, 0, W / 2, H * 0.48, W * 0.5);
        g.addColorStop(0, 'rgba(255,255,255,0.6)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g; c.fillRect(0, 0, W, H);
      }),
      sunCore: canvasOf(W, H, 0.5, (c) => {
        const g = c.createRadialGradient(CX, 470, 0, CX, 470, 700);
        g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.55, 'rgba(255,246,192,0.35)'); g.addColorStop(1, 'rgba(255,246,192,0)');
        c.fillStyle = g; c.fillRect(0, 0, W, H);
      }),
    };
    {
      const c = this.hudPlain.ctx, g = c.createRadialGradient(CX, CY, 0, CX, CY, 1150);
      g.addColorStop(0, '#062029'); g.addColorStop(1, '#01080B');
      c.fillStyle = g; c.fillRect(0, 0, W, H);
      this.hudPlain.upload();
    }
    {
      const c = this.hudHex.ctx, rh = 26, hx = rh * Math.sqrt(3);
      c.strokeStyle = 'rgba(40,120,135,0.10)'; c.lineWidth = 1; c.beginPath();
      for (let row = -1, y = -rh * 1.5; y < H + rh * 2; row++, y = row * rh * 1.5) {
        for (let x = (row % 2 ? hx / 2 : 0) - hx; x < W + hx; x += hx) {
          for (let k = 0; k < 6; k++) { const a = (k * 60 + 30) * DEG, px = x + Math.cos(a) * rh, py = y + Math.sin(a) * rh; if (k) c.lineTo(px, py); else c.moveTo(px, py); }
          c.closePath();
        }
      }
      c.stroke();
      this.hudHex.upload();
    }
    for (let y = -R + DOT / 2; y < R; y += DOT) for (let x = -R + DOT / 2; x < R; x += DOT) if (x * x + y * y < (R - 6) ** 2) this.dots.push({ x, y });
    this.dotMemo.on = new Float32Array(this.dots.length);
  }

  private T(x: number) { return this.ctx.start + x; }

  override cues(): Cue[] {
    const T = (x: number) => this.T(x);
    return [
      ...TITLE.map((x, i) => ({ t: T(x), name: `title char ${i + 1} pops`, on: 'beat' })),
      { t: T(TAG), name: 'theme tag slams' },
      { t: T(DROP), name: 'cut: burst + shout slam' },
      { t: T(STAMP), name: 'stamp slams' },
      { t: T(SPLIT), name: 'cut to HUD' },
      { t: T(SEARCH), name: 'signal detected' },
      { t: T(LOCK), name: 'target locked (closed shutter)' },
      { t: T(RESOLVE), name: 'resolve' },
    ];
  }

  render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    const t = f.t;
    this.layer.clear();
    let post: PostOverrides;
    if (t < this.T(SPLIT)) {
      post = this.variety(this.layer.ctx, t);
      this.ctx.comp.draw(this.ctx.renderer, this.layer.upload(), out, { mode: 'replace' });
    } else post = this.hud(t, out);
    return post;
  }

  // ===================================================================================================================
  // 花字（0–8 s）

  private variety(c: Ctx, t: number): PostOverrides {
    const T = (x: number) => this.T(x);
    if (t < T(DROP)) this.candyBoard(c, t); else this.sunburst(c, t);
    if (t < T(DROP)) this.titleShot(c, t); else this.shoutShot(c, t);
    this.badge(c, t);
    // the cut to the burst flashes for two frames
    const fr = frameIdx(t) - frameIdx(T(DROP));
    return { flash: fr === 0 ? 0.45 : fr === 1 ? 0.12 : 0, vignette: t < T(DROP) ? 0.3 : 0.35 };
  }

  /** Shot 1's board: cyan candy stripes drifting, a soft white glow, confetti (the vignette is the post's). */
  private candyBoard(c: Ctx, t: number) {
    c.fillStyle = '#2CCBF2'; c.fillRect(0, 0, W, H);
    c.save();
    c.translate(W / 2, H / 2); c.rotate(-35 * DEG);
    const per = 96, off = mod(t * 36, per), ext = Math.hypot(W, H) / 2 + per;
    c.fillStyle = '#56D8F6';
    for (let x = -ext - per + off; x < ext; x += per) c.fillRect(x, -ext, per / 2, 2 * ext);
    c.restore();
    c.drawImage(this.bg!.candy, 0, 0, W, H);
    const rnd = mulberry32(77), cols = ['#FFE14D', '#FF7FC8', '#FFFFFF'];
    for (let i = 0; i < 30; i++) {
      const x = rnd() * W, y = rnd() * H, r = 5 + rnd() * 9, ph = rnd() * TAU;
      c.globalAlpha = 0.85; c.fillStyle = cols[i % 3]!;
      c.beginPath(); c.arc(x, y + 6 * Math.sin(TAU * 0.4 * t + ph), r, 0, TAU); c.fill();
    }
    c.globalAlpha = 1;
  }

  /** Shot 2's board: yellow with pink rays turning, a white core, then the boiling focus lines. */
  private sunburst(c: Ctx, t: number) {
    const T = (x: number) => this.T(x), ox = CX, oy = 470;
    c.fillStyle = '#FFD23F'; c.fillRect(0, 0, W, H);
    c.save();
    c.translate(ox, oy); c.rotate((8 + (t - T(DROP)) * 14) * DEG);
    c.fillStyle = '#FF6FA5'; c.beginPath();
    const n = 22, L = 2400;
    for (let i = 0; i < n; i++) { const a0 = (i / n) * TAU, a1 = a0 + Math.PI / n; c.moveTo(0, 0); c.lineTo(Math.cos(a0) * L, Math.sin(a0) * L); c.lineTo(Math.cos(a1) * L, Math.sin(a1) * L); c.closePath(); }
    c.fill();
    c.restore();
    c.drawImage(this.bg!.sunCore, 0, 0, W, H);
    const u = t - T(DROP), po = popOut(t, T(OUT) + 0.04);
    if (po > 0) focusLines(c, t, ox, oy + 40, { rIn: [430, 640], rOut: 1500, aspect: 0.58, n: 132, alpha: (0.95 - 0.25 * clamp(u / 0.6)) * Math.min(1, po), width: [0.004, 0.016] });
  }

  /** Shot 1: the title pops letter by letter, hops on the beats; the theme tag slams, the subtitle pops, sparkles. */
  private titleShot(c: Ctx, t: number) {
    const T = (x: number) => this.T(x);
    // sparkles around the title
    const SP: [number, number, number, number][] = [[420, 330, 40, 0.8], [1540, 360, 30, 0.867], [1500, 760, 44, 0.933], [430, 770, 26, 1.0], [1010, 236, 20, 1.067], [1700, 560, 18, 1.13]];
    for (const [x, y, r, t0] of SP) {
      const u = t - T(t0);
      if (u < 0) continue;
      sparkle(c, x, y, r * damped(u, 0.4, 26) * (0.8 + 0.2 * Math.sin(TAU * 1.8 * t + x)), { rot: (u * 40 + x) * DEG, fill: '#FFFFFF', stroke: '#FFD23F', strokeW: 3.5 });
    }
    // 今日份快乐
    const size = TITLE_ST.size, step = 186, y0 = 545, dy = [6, -16, 10, -12, 4], rot = [-7, 4, -3, 6, -5];
    const chars: HanaziChar[] = [...'今日份快乐'].map((ch, i) => {
      const x = CX + (i - 2) * step;
      const p = popChar(t, T(TITLE[i]!), { drop: 90, r0: (i % 2 ? 16 : -16) * DEG, wig: 2.2 * DEG, bob: 4, phase: x * 0.013 });
      const hop = beatHop(t, HOPS.map(T), { delay: (i * 2) / 30, height: 40 });
      return { ch, x, y: y0 + dy[i]! + p.dy + hop.dy + 0.35 * size * hop.sq, rot: rot[i]! * DEG + p.rot, s: p.s * (1 + hop.sq), sy: p.s * (1 - hop.sq), alpha: p.visible ? 1 : 0 };
    });
    hanazi(c, chars, TITLE_ST);
    // theme tag slams in on the downbeat (closed shutter on its hit frame)
    const tt = hitT(t, [T(TAG)]), sl = slamIn(tt, T(TAG), { from: 1.7, amp: 0.06, rot0: -8 * DEG });
    if (sl.visible) {
      const id = idleWiggle(t, T(TAG), { wig: 1.5 * DEG, bob: 2, hz: 0.9 });
      c.save();
      c.globalAlpha = sl.a;
      c.translate(560, 352 + id.dy); c.rotate(-5 * DEG + sl.rot + id.rot); c.scale(sl.s, sl.s);
      c.fillStyle = '#0E1440'; c.beginPath(); c.roundRect(-128 + 8, -36 + 9, 256, 72, 36); c.fill();
      c.fillStyle = '#FF3D7F'; c.strokeStyle = '#1E2A78'; c.lineWidth = 7; c.beginPath(); c.roundRect(-128, -36, 256, 72, 36); c.fill(); c.stroke();
      c.fillStyle = '#FFFFFF'; c.font = font(F.sans(900), 40); c.textAlign = 'center'; c.textBaseline = 'middle'; c.letterSpacing = '6px';
      c.fillText('本期主题', 3, 2);
      c.restore();
    }
    // subtitle: one character a frame (30 fps), a stiffer spring
    const sub = [...'元气满满的一天'], sstep = 84, sy = 772;
    const sc: HanaziChar[] = sub.map((ch, i) => {
      const x = CX + (i - (sub.length - 1) / 2) * sstep, p = popChar(t, T(SUB) + i / 30, { zeta: 0.6, omega: 28, wig: 1.2 * DEG, bob: 2, phase: x * 0.013 });
      return { ch, x, y: sy + (i % 2 ? -5 : 5) + p.dy, rot: p.rot, s: p.s, alpha: p.visible ? 1 : 0 };
    });
    c.save(); c.translate(CX, sy); c.rotate(-2.5 * DEG); c.translate(-CX, -sy);
    hanazi(c, sc, SUB_ST);
    c.restore();
  }

  /** Shot 2: burst + 震惊！！ slam on the cut, a subline pops, the stamp slams, a re-hit, then everything pops out. */
  private shoutShot(c: Ctx, t: number) {
    const T = (x: number) => this.T(x);
    const k = [kick(t, T(DROP), 26, 7, 11), kick(t, T(STAMP), 12, 10, 13), kick(t, T(REHIT), 16, 9, 13)];
    const sx = k.reduce((s, v) => s + v[0], 0) * 0.6, sy = k.reduce((s, v) => s + v[1], 0) * 0.6;
    c.save();
    c.translate(sx, sy);
    // the burst springs open (two frames early), pulses on the re-hit, pops out at the end
    const u = t - T(DROP), rb = t >= T(REHIT) ? 1 + 0.1 * Math.exp(-(t - T(REHIT)) * 12) : 1, po = popOut(t, T(OUT));
    const bs = damped(u + 2 / 30, 0.42, 24) * rb * po;
    if (bs > 0) burst(c, t, CX, 535, { rx: 560, ry: 250, n: 17, s: bs, rot: (-4 + 1.2 * Math.sin(t * 7)) * DEG, strokeW: 11 });
    // 震惊！！ — each character slams on its own frame, then sways; the !! hop on the re-hit
    const xs = [725, 965, 1150, 1235], ys = [12, -10, -22, -34], rr = [-7, -3, 6, 12], r0 = [-14, 10, 16, 18];
    const chars: HanaziChar[] = [...'震惊！！'].map((ch, i) => {
      const th = T(SHOUT[i]!), sl = slamIn(hitT(t, [th]), th, { from: 1.9, rot0: r0[i]! * DEG });
      const id = idleWiggle(t, th, { wig: 2.4 * DEG, bob: 3, hz: 1.6, phase: xs[i]! * 0.013 });
      const hop = i >= 2 ? beatHop(t, [T(REHIT), T(REHIT + 0.5)], { delay: (i - 2) / 30, height: 34 }) : { dy: 0, sq: 0 };
      const s = sl.s * id.s * popOut(t, T(OUT) + i / 60);
      return { ch, x: xs[i]!, y: 545 + ys[i]! + id.dy + hop.dy + 0.3 * SHOUT_ST.size * hop.sq, rot: rr[i]! * DEG + sl.rot + id.rot, s: s * (1 + hop.sq), sy: s * (1 - hop.sq), alpha: sl.visible ? sl.a : 0 };
    });
    hanazi(c, chars, SHOUT_ST);
    // the subline pops one character a frame, rotated a little
    const line = [...'这也太好看了吧？！'], step = 76, ly = 905;
    const lc: HanaziChar[] = line.map((ch, i) => {
      const x = CX + (i - (line.length - 1) / 2) * step - (i >= 7 ? (i - 6) * 14 : 0);
      const p = popChar(t, T(LINE2) + i / 30, { zeta: 0.6, omega: 28, wig: 1.2 * DEG, bob: 2, phase: x * 0.013, t1: T(OUT) + 0.02 });
      return { ch, x, y: ly + (i % 2 ? -5 : 5) + p.dy, rot: p.rot, s: p.s, alpha: p.visible ? 1 : 0 };
    });
    c.save(); c.translate(CX, ly); c.rotate(-3 * DEG); c.translate(-CX, -ly);
    hanazi(c, lc, LINE2_ST);
    c.restore();
    // the stamp: 2.5× → 1 in 0.13 s, its hit frame crisp
    const ts = T(STAMP), st = slamIn(hitT(t, [ts]), ts, { from: 2.5, dur: 0.13, amp: 0.09, rot0: -10 * DEG });
    const sp = st.s * popOut(t, T(OUT) + 0.05);
    if (st.visible && sp > 0 && this.stamp) {
      const cv = this.stamp, d = cv.width / (SCALE * 1.5);
      c.save();
      c.globalAlpha = st.a * 0.96;
      c.translate(1590, 270); c.rotate(-14 * DEG + st.rot + 0.8 * DEG * Math.sin(t * 2.2)); c.scale(sp, sp);
      c.shadowColor = 'rgba(60,10,30,0.35)'; c.shadowBlur = 14; c.shadowOffsetY = 8;
      c.drawImage(cv, -d / 2, -d / 2, d, d);
      c.restore();
    }
    // sparkles flung out on the drop
    const SP: [number, number, number, number][] = [[280, 250, 38, 4.08], [1650, 820, 32, 4.12], [260, 820, 28, 4.16], [1380, 180, 22, 4.2], [520, 150, 20, 4.24]];
    for (const [x, y, r, t0] of SP) {
      const v = t - T(t0);
      if (v < 0) continue;
      sparkle(c, x, y, r * damped(v, 0.4, 26) * (0.78 + 0.22 * Math.sin(TAU * 1.6 * t + y)) * popOut(t, T(OUT)), { rot: (v * 50 + y) * DEG, fill: '#FFFFFF', stroke: '#FF3D7F', strokeW: 3.5, glow: '#FFFFFF' });
    }
    c.restore();
  }

  /** The programme badge (top left), dropping in at the start and bobbing. */
  private badge(c: Ctx, t: number) {
    const u = t - this.T(0.05);
    if (u < 0) return;
    const s = damped(u, 0.5, 20), bob = 2 * Math.sin(t * 2.4), rot = 0.6 * DEG * Math.sin(t * 1.7);
    c.save();
    c.translate(70, 44 + bob); c.rotate(rot); c.scale(s, s);
    c.lineJoin = 'round';
    c.fillStyle = '#FFE14D'; c.strokeStyle = '#1E2A78'; c.lineWidth = 6;
    c.beginPath(); c.moveTo(24, 18); c.lineTo(42, -12); c.lineTo(62, 18); c.closePath(); c.moveTo(158, 18); c.lineTo(178, -12); c.lineTo(196, 18); c.closePath(); c.fill(); c.stroke();
    c.beginPath(); c.roundRect(0, 8, 220, 78, 28); c.fill(); c.stroke();
    c.fillStyle = '#1E2A78'; c.font = font(F.sans(900), 42); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('元气日报', 110, 49);
    c.translate(232, 30); c.rotate(8 * DEG);
    c.fillStyle = '#FF3D7F'; c.lineWidth = 5; c.beginPath(); c.roundRect(0, 0, 98, 44, 13); c.fill(); c.stroke();
    c.fillStyle = '#FFFFFF'; c.font = font(F.archivo(100, 900), 25); c.fillText('EP.07', 49, 24);
    c.restore();
  }

  // ===================================================================================================================
  // HUD（8–17 s）：线条先画在透明底上 → 模糊一份当辉光叠回去 → 背景垫在下面 → 字最后画（黑晕压在发光的线上）

  private hud(t: number, out: THREE.WebGLRenderTarget): PostOverrides {
    const T = (x: number) => this.T(x), c = this.layer.ctx, { comp, renderer } = this.ctx;
    const hitFrame = frameIdx(shutterT(t, 0)) === frameIdx(T(LOCK));
    // re-ink: after the lock a wave from the target turns cyan into amber
    const wave = t >= T(LOCK) ? ease.outCubic(prog(t, T(LOCK), 0.9)) * 1500 : -1, wx = CX + TGT.x, wy = CY + TGT.y;
    const passes = (draw: (pal: Pal) => void) => {
      if (hitFrame) { draw(WHITE); return; }
      if (wave < 0) { draw(CYAN); return; }
      if (wave >= 1499) { draw(AMBER); return; }
      c.save(); c.beginPath(); c.rect(0, 0, W, H); c.arc(wx, wy, wave, 0, TAU); c.clip('evenodd'); draw(CYAN); c.restore();
      c.save(); c.beginPath(); c.arc(wx, wy, wave, 0, TAU); c.clip(); draw(AMBER); c.restore();
    };
    // 1. lines and marks on a transparent canvas
    passes((pal) => this.drawHud(c, t, 'geo', pal));
    if (wave > 0 && wave < 1499) {
      c.save(); c.globalAlpha = 0.8 * (1 - wave / 1500); c.strokeStyle = AMBER.hot; c.lineWidth = 2;
      c.beginPath(); c.arc(wx, wy, wave, 0, TAU); c.stroke(); c.restore();
    }
    // 2. their glow: a quarter-resolution copy, blurred (two radii) into the glow texture
    this.glowSrc.clear(); this.glowSrc.ctx.drawImage(this.layer.canvas, 0, 0, W, H);
    const g = this.glow.ctx;
    this.glow.clear();
    g.globalCompositeOperation = 'lighter';
    g.filter = 'blur(3px)'; g.globalAlpha = 0.9; g.drawImage(this.glowSrc.canvas, 0, 0, W, H);
    g.filter = 'blur(10px)'; g.globalAlpha = 0.8; g.drawImage(this.glowSrc.canvas, 0, 0, W, H);
    g.filter = 'none';
    // 3. the type on top of the lines, with its halo and glow
    passes((pal) => this.drawHud(c, t, 'txt', pal));
    // 4. on the GPU: background (black on the hit frame), the hex grid fading in, the glow added, lines and type over it
    comp.draw(renderer, this.hudPlain.texture, out, { mode: 'replace', tint: hitFrame ? [0, 0, 0] : [1, 1, 1] });
    const hex = ease.outCubic(prog(t, T(BOOT + 0.1), 1.2));
    if (hex > 0 && !hitFrame) comp.draw(renderer, this.hudHex.texture, out, { mode: 'normal', opacity: hex });
    comp.draw(renderer, this.glow.upload(), out, { mode: 'add', opacity: 0.75 });
    comp.draw(renderer, this.layer.upload(), out, { mode: 'normal' });
    return { grain: 0.025, vignette: 0.25 };
  }

  /** The whole HUD for one pass ('geo' = lines, marks, dots; 'txt' = type) in one palette. */
  private drawHud(c: Ctx, t: number, pass: 'geo' | 'txt', pal: Pal) {
    const T = (x: number) => this.T(x), tf = shutterT(t, 0), geo = pass === 'geo', txt = pass === 'txt';
    let GA = 1;
    const tierAt = (keys: [number, number][]) => tier(t, keys.map(([k, v]) => [T(k), v] as [number, number]));
    const st = (col: string, w = 1, a = 1) => { c.strokeStyle = col; c.lineWidth = w; c.globalAlpha = clamp(a) * GA; };
    const fl = (col: string, a = 1) => { c.fillStyle = col; c.globalAlpha = clamp(a) * GA; };
    const L = (x0: number, y0: number, x1: number, y1: number, p = 1) => { if (!geo || p <= 0) return; p = Math.min(p, 1); c.beginPath(); c.moveTo(x0, y0); c.lineTo(x0 + (x1 - x0) * p, y0 + (y1 - y0) * p); c.stroke(); };
    const ARC = (x: number, y: number, r: number, a0: number, a1: number, p = 1) => { if (!geo || p <= 0.0005) return; c.beginPath(); c.arc(x, y, r, a0, a0 + (a1 - a0) * Math.min(p, 1)); c.stroke(); };
    const TX = (s: string, x: number, y: number, fnt: string, o: GlowOpts = {}) => {
      if (!txt || !s) return 0;
      c.save(); c.globalAlpha = 1;
      const w = glowText(c, fnt, s, x, y, { color: pal.ink, ...o, alpha: (o.alpha ?? 1) * GA });
      c.restore();
      return w;
    };
    const TW = (s: string, fnt: string, tr = 0) => { c.save(); c.font = fnt; c.letterSpacing = `${tr}px`; const w = c.measureText(s).width - tr; c.restore(); return w; };
    const panel = (t0: number, x: number, y: number, w: number, h: number, idx: string, label: string, cn: string) =>
      fuiPanel(c, t, T(t0), x, y, w, h, { idx, label, cn, color: pal.ink, dim: pal.dim, alpha: GA, pass });
    c.save();

    // ---- frame corners, top bar ----
    GA = 1;
    const pc = ease.outExpo(prog(t, T(BOOT + 0.03), 0.2));
    if (pc > 0) {
      st(pal.ink, 1.5, 0.9); const m = 40, a = 34 * pc;
      for (const [x, y, sx, sy] of [[m, m, 1, 1], [W - m, m, -1, 1], [W - m, H - m, -1, -1], [m, H - m, 1, -1]] as const) if (geo) { c.beginPath(); c.moveTo(x, y + sy * a); c.lineTo(x, y); c.lineTo(x + sx * a, y); c.stroke(); }
      st(pal.dim, 1, pc); L(CX - 10, m + 0.5, CX + 10, m + 0.5); L(CX - 10, H - m - 0.5, CX + 10, H - m - 0.5); L(m + 0.5, CY - 10, m + 0.5, CY + 10); L(W - m - 0.5, CY - 10, W - m - 0.5, CY + 10);
    }
    GA = tierAt([[8, 1], [12.2, 0.6]]);
    const ta = flick(t, T(BOOT + 0.14));
    if (ta) {
      const y = 82;
      st(pal.ink, 1.5, ta);
      if (geo) { c.beginPath(); for (let i = 0; i < 6; i++) { const an = (i * 60 + 30) * DEG; c.lineTo(108 + 11 * Math.cos(an), y - 7 + 11 * Math.sin(an)); } c.closePath(); c.stroke(); }
      L(103, y - 1, 113, y - 13);
      const w1 = TX('AURORA-7', 130, y, MONO(21, 600), { alpha: ta, tracking: 3, color: pal.hot });
      TX('极光七号 · 轨道光学系统', 130 + (w1 || TW('AURORA-7', MONO(21, 600), 3)) + 18, y - 1, ZH(15), { color: pal.dim, alpha: ta, tracking: 2, glow: 0.3 });
      // UTC clock (frame time: crisp digits)
      const secs = 7.18 + (tf - T(BOOT)), clock = `UTC 03:14:${(Math.floor(secs) % 60).toString().padStart(2, '0')}.${Math.floor((secs % 1) * 100).toString().padStart(2, '0')}`;
      TX(clock, W - 108, y, MONO(15, 500), { align: 'right', alpha: ta, tracking: 1 });
      if (Math.floor(tf * 2) % 2 === 0) { fl('#FF2A1F', ta); if (geo) { c.beginPath(); c.arc(W - 108 - TW(clock, MONO(15, 500), 1) - 16, y - 5, 4, 0, TAU); c.fill(); } }
      st(pal.deep, 1, ta); L(96, y + 14.5, W - 96, y + 14.5, ease.outCubic(prog(t, T(BOOT + 0.2), 0.6)));
      // mode pill: decodes on each change
      const modes: [number, string, string][] = [[BOOT + 0.3, 'BOOT SEQUENCE', '启动序列'], [SEARCH, 'SEARCH', '搜索中'], [LOCK + 1 / 60, 'TARGET LOCKED', '目标锁定']];
      let mi = 0; for (let i = 0; i < modes.length; i++) if (tf >= T(modes[i]![0])) mi = i;
      const [m0, ml, mc] = modes[mi]!, locked = mi === 2;
      if (tf >= T(m0)) {
        GA = 1;
        const pw = 330, px = CX - pw / 2, py = 54;
        st(locked ? pal.hot : pal.ink, 1.2, 0.9); if (geo) { c.beginPath(); c.roundRect(px, py, pw, 30, 15); c.stroke(); }
        if (locked && geo) { fl(pal.ink, 0.22); c.beginPath(); c.roundRect(px, py, pw, 30, 15); c.fill(); }
        const lab = decode(t, T(m0), ml, { id: 900 + mi, dur: 0.25 });
        const lw = TW(ml, MONO(14, 600), 2.5), cw = TW(mc, ZH(14, 500), 2), gap = 14, x0 = CX - (lw + gap + cw) / 2;
        TX(lab, x0, py + 20, MONO(14, 600), { tracking: 2.5, color: locked ? pal.hot : pal.ink, halo: 0.3 });
        TX(mc, x0 + lw + gap, py + 20, ZH(14, 500), { tracking: 2, color: locked ? pal.hot : pal.dim, halo: 0.3, alpha: ease.outCubic(prog(t, T(m0) + 0.1, 0.3)) });
      }
    }

    // ---- the scope ----
    this.scope(c, t, tf, pass, pal, (k) => { GA = k; }, { st, fl, L, ARC, TX, TW });
    GA = 1;

    // ---- left column: boot log, the range readout, telemetry, mini radar ----
    const lx = 96, cw = 300;
    GA = tierAt([[8, 1], [10, 0.6], [12, 0.3], [14, 0.6]]);
    if (panel(BOOT + 0.36, lx, 136, cw, 238, '01', 'SYS BOOT', '系统自检')) {
      const LOG: [string, string][] = [['OPTIC CORE v4.2.1', 'OK'], ['CRYO FPA 4096² · 77K', 'OK'], ['GYRO ALIGN Δ0.0003°', 'OK'], ['ORBIT LEO 512 KM', 'OK'], ['UPLINK QKD-7 9.6G', 'OK'], ['SIG DB 14 220 PROF', 'OK']];
      const lt = [0.42, 0.66, 0.9, 1.14, 1.38, 1.62].map((v) => T(BOOT + v)), y = 172, lh = 23, fnt = MONO(13.5, 400), cps = 110;
      LOG.forEach(([s, ok], i) => {
        const n = Math.max(0, Math.floor((tf - lt[i]!) * cps + 1e-6)), ty = [...s].slice(0, n).join('');
        if (!ty) return;
        TX('>', lx + 8, y + i * lh, fnt, { color: pal.dim });
        TX(ty, lx + 24, y + i * lh, fnt, { alpha: 0.95 });
        const done = lt[i]! + [...s].length / cps;
        if (tf >= done) {
          const w = TW(s, fnt);
          if (geo) { c.setLineDash([1, 4]); st(pal.dim, 1, 0.7); L(Math.round(lx + 30 + w), y + i * lh - 3.5, lx + cw - 42, y + i * lh - 3.5); c.setLineDash([]); }
          TX(`[${ok}]`, lx + cw - 4, y + i * lh, MONO(13.5, 600), { align: 'right', alpha: flick(t, done + 0.03) });
        } else if (geo) { fl(pal.ink, 1); c.fillRect(lx + 25 + TW(ty, fnt), y + i * lh - 11, 8, 13); }
      });
      const extra: [number, string, 'ink' | 'hot'][] = [[BOOT + 1.98, '> SEARCH MODE ENGAGED', 'ink'], [SEARCH + 0.6, '! SIGNAL · BRG 041°', 'hot'], [LOCK + 0.1, '■ TGT-03 LOCKED', 'hot']];
      extra.forEach(([t0, s, col], j) => {
        const n = Math.max(0, Math.floor((tf - T(t0)) * 120 + 1e-6)), ty = [...s].slice(0, n).join('');
        if (!ty) return;
        const yy = y + (6 + j) * lh, last = j === 2 || tf < T(extra[j + 1]![0]);
        TX(ty, lx + 8, yy, MONO(13.5, 600), { color: pal[col], alpha: j === 1 && tf < T(LOCK) ? (Math.floor((tf - T(t0)) * 8) % 2 === 0 ? 1 : 0.5) : 1 });
        if (last && Math.floor(tf * 5) % 2 === 0 && geo) { fl(pal.ink, 1); c.fillRect(lx + 11 + TW(ty, MONO(13.5, 600)), yy - 11, 8, 13); }
      });
    }
    // RNG: the typographic anchor; after the lock it becomes the effective range and plunges with the dive
    GA = tierAt([[8, 0.6], [9, 1], [10, 0.6], [12, 1], [14, 0.85]]);
    const ra = flick(t, T(BOOT + 0.6));
    if (ra) {
      const yb = 432, dive = tf >= T(LOCK) + 1 / 120, z = this.zAt(tf), mag = Math.exp(Math.log(22) * z);
      const lab = dive ? 'EFF RNG' : 'SLANT RNG';
      TX(decode(t, dive ? T(LOCK) + 1 / 60 : T(BOOT + 0.6), lab, { id: 61 + (dive ? 1 : 0), dur: 0.2 }), lx, yb, MONO(14, 600), { tracking: 3, alpha: ra });
      TX(dive ? '等效距离' : '斜距', lx + cw, yb, ZH(14, 500), { align: 'right', color: pal.dim, alpha: ra, tracking: 2 });
      st(pal.ink, 1, 0.85 * ra); L(lx, yb + 9.5, lx + cw, yb + 9.5); if (geo) { fl(pal.ink, ra); c.fillRect(lx, yb + 8, 18, 3); }
      const rng = lerp(1712.6, 1648.3, ease.inOutCubic(prog(tf, T(DATA), 4.0))), val = dive ? rng / mag : rng;
      const fin = val.toFixed(1).padStart(6, '0'), s = tf < T(DATA) ? null : rollDigits(t, T(DATA), fin, 7, 0.25);
      TX(s ?? '----.-', lx - 4, yb + 88, MONO(66, 500), { color: s ? pal.hot : pal.dim, alpha: ra * (s ? 1 : 0.7), tracking: 1, glow: 0.7, glowR: 6 });
      TX('KM', lx + cw, yb + 90, MONO(20, 600), { align: 'right', alpha: ra, tracking: 2 });
      const on = Math.round(z * 30);
      if (geo) for (let i = 0; i < 30; i++) { fl(i < on ? (i === on - 1 ? pal.hot : pal.ink) : pal.deep, i < on ? 1 : 0.9); c.fillRect(lx + i * 10, yb + 106, 7, i < on ? 6 : 4); }
      TX(`MAG ×${mag.toFixed(1)}`, lx, yb + 140, MONO(16, 600), { color: dive ? pal.hot : pal.ink, alpha: ra });
      TX(`FOV ${(12.4 / mag).toFixed(2)}°`, lx + cw, yb + 140, MONO(16, 500), { align: 'right', alpha: ra * 0.85 });
    }
    GA = tierAt([[8, 0.6], [9.2, 1], [10, 0.6], [12, 0.3], [14, 0.6]]);
    if (panel(BOOT + 0.5, lx, 620, cw, 178, '02', 'NAV TELEMETRY', '导航遥测')) {
      const rows: [string, number, number, number, string][] = [
        ['AZM', 41.07 + 0.4 * Math.sin(tf * 0.7), 3, 2, '°'], ['ELV', 12.4 + 0.2 * Math.sin(tf * 0.5 + 1), 2, 2, '°'], ['ALT', 512.08 + 0.02 * Math.sin(tf * 3), 3, 2, 'KM'],
        ['VEL', 7.612 + 0.001 * Math.floor(hash(frameIdx(tf) >> 3, 5) * 4), 1, 3, 'KM/S'],
        ['SNR', tf < T(SEARCH) ? 11.4 + hash(frameIdx(tf) >> 3, 9) * 0.6 : lerp(11.4, 41.2, ease.outCubic(prog(tf, T(SEARCH), 0.6))), 2, 1, 'dB'],
      ];
      rows.forEach(([lab, v, n, d, unit], i) => {
        const yy = 660 + i * 29, t0 = T(DATA + 0.2 + i * 0.1);
        TX(lab, lx + 8, yy, MONO(13, 600), { color: pal.dim, tracking: 2.5 });
        const fin = v.toFixed(d).padStart(n + d + 1, '0'), s = tf < t0 ? null : rollDigits(t, t0, fin, 30 + i, 0.15 + 0.05 * (i % 3));
        TX(s ?? fin.replace(/[0-9]/g, '-'), lx + 156, yy + 1, MONO(17, 500), { align: 'right', color: s ? pal.hot : pal.dim, alpha: s ? 1 : 0.6 });
        TX(unit, lx + 162, yy, MONO(12, 500), { color: pal.dim });
        const m = clamp(0.25 + 0.6 * hash(i, 1) + 0.08 * Math.sin(tf * (2 + i) + i)), mp = ease.outCubic(prog(t, t0 + 0.1, 0.4));
        st(pal.deep, 4, 1); L(lx + 212, yy - 5, lx + cw - 6, yy - 5); st(pal.ink, 4, 0.9); L(lx + 212, yy - 5, lx + 212 + (cw - 218) * m * mp, yy - 5);
        if (i < 4) { st(pal.deep, 1, 0.9); L(lx + 8, yy + 10.5, lx + cw - 6, yy + 10.5, mp); }
      });
    }
    GA = tierAt([[8, 0.3], [10, 0.6], [12, 0.3], [14, 0.45]]);
    if (panel(BOOT + 0.62, lx, 840, cw, 168, '03', 'RDR · MINIMAP', '雷达')) this.miniRadar(c, t, tf, pass, pal, lx, cw, GA);

    // ---- right column: signal analysis, candidates, spectrum, data link ----
    const rx = W - 96 - cw;
    GA = tierAt([[8, 0.6], [10, 1], [11.4, 0.6], [12, 0.3], [14, 0.6]]);
    if (panel(BOOT + 0.45, rx, 136, cw, 206, '04', 'SIGNAL ANALYSIS', '信号分析')) {
      this.spark(c, t, tf, pass, pal, rx + 6, 190, cw - 12, 48, 3, T(DATA + 0.3), 'SIG PWR', 'dBm', -92, 40, GA);
      this.spark(c, t, tf, pass, pal, rx + 6, 290, cw - 12, 48, 8, T(DATA + 0.5), 'COHERENCE', '%', 0, 100, GA);
    }
    GA = tierAt([[8, 0.6], [10.4, 1], [12, 0.6], [14, 0.3]]);
    if (panel(BOOT + 0.55, rx, 396, cw, 232, '05', 'CANDIDATES', '候选目标')) {
      const CND: [string, string, string, number][] = [['CND-01', 'VEGA', '70°30′S 020°00′E', 0.231], ['CND-02', 'LYRA', '66°18′S 110°30′E', 0.418], ['CND-03', 'ORION', '77°32′S 167°09′E', 0.997]];
      CND.forEach(([id, code, ll, mm], i) => {
        const t0 = T(CAND[i]!), yy = 438 + i * 64, match = i === 2;
        if (tf < t0) {
          TX(id, rx + 8, yy, MONO(13.5, 500), { color: pal.dim, alpha: 0.7 });
          TX(Math.floor(tf * 3) % 2 ? 'AWAITING' : 'AWAITING_', rx + cw - 4, yy, MONO(13.5, 500), { color: pal.dim, align: 'right', alpha: 0.7 });
          st(pal.deep, 1, 1); L(rx + 8, yy + 30.5, rx + cw - 6, yy + 30.5);
          return;
        }
        const a = flick(t, t0);
        TX(decode(t, t0, id, { id: 400 + i, dur: 0.2 }), rx + 8, yy, MONO(13.5, 600), { color: match ? pal.hot : pal.ink, alpha: a });
        TX(decode(t, t0, code, { id: 410 + i, dur: 0.3 }), rx + 84, yy, MONO(15, 700), { alpha: a, tracking: 2 });
        TX(decode(t, t0 + 0.05, ll, { id: 420 + i, dur: 0.3, keep: /[°′.]/ }), rx + 8, yy + 21, MONO(13, 400), { color: pal.dim, alpha: a });
        const mp = ease.outCubic(prog(tf, t0, 0.3)), pct = `${(mm * 100 * mp).toFixed(1)}%`;
        const res = tf < t0 + 0.28 ? pct : match ? `MATCH ${pct}` : 'NO MATCH';
        TX(res, rx + cw - 4, yy, MONO(15, 600), { align: 'right', color: match ? pal.hot : pal.dim, alpha: match && tf < T(LOCK) ? (Math.floor(tf * 10) % 2 ? 0.4 : 1) : a });
        st(pal.deep, 3, 1); L(rx + 8, yy + 32, rx + cw - 6, yy + 32); st(match ? pal.ink : pal.dim, 3, 1); L(rx + 8, yy + 32, rx + 8 + (cw - 14) * mm * mp, yy + 32);
        if (!match && tf > t0 + 0.28) { st(pal.dim, 1, 0.9); L(rx + 8, yy - 5.5, rx + 66, yy - 5.5); }
      });
    }
    GA = tierAt([[8, 0.3], [10, 1], [10.4, 0.6], [12, 0.3], [14, 0.45]]);
    if (panel(BOOT + 0.65, rx, 670, cw, 186, '06', 'SPECTRUM', '频谱')) {
      const n = 28, bw = (cw - 12) / n, p = ease.outCubic(prog(t, T(BOOT + 0.75), 0.6)), pk = 18, sig = tf > T(SEARCH), j = Math.floor(tf * 15);
      if (geo) for (let i = 0; i < n; i++) {
        let v = (0.15 + 0.5 * hash(i, j, 3) ** 2 + 0.2 * Math.sin(i * 0.5 + tf * 2) ** 2) * p;
        if (sig && Math.abs(i - pk) < 3) v = Math.max(v, (0.95 - Math.abs(i - pk) * 0.22) * (0.85 + 0.15 * hash(i, j)));
        const ns = Math.round(22 * clamp(v)), peak = i === pk && sig;
        for (let q = 0; q < ns; q++) { fl(peak ? pal.hot : q > 15 ? pal.ink : pal.dim, peak ? 0.95 : q > 15 ? 0.75 : 0.8); c.fillRect(rx + 6 + i * bw, 836 - q * 4.4, bw - 3, 2.6); }
        fl(pal.deep, 1); c.fillRect(rx + 6 + i * bw, 840, bw - 3, 2);
      }
      if (sig) {
        const px = rx + 6 + pk * bw + bw / 2, a = flick(t, T(SEARCH));
        if (geo) { fl(pal.hot, a); c.beginPath(); c.moveTo(px - 5, 728); c.lineTo(px + 5, 728); c.lineTo(px, 736); c.closePath(); c.fill(); }
        TX('8.412 GHz', px, 722, MONO(13, 600), { align: 'center', color: pal.hot, alpha: a });
      }
    }
    GA = tierAt([[8, 0.35], [UPLINK, 1], [UPLINK + 0.8, 0.6]]);
    const fa = flick(t, T(BOOT + 0.8));
    if (fa) {
      TX('DATA LINK · QKD-7', rx, 902, MONO(13, 600), { color: pal.dim, alpha: fa, tracking: 2 });
      st(pal.deep, 1, fa); L(rx, 911.5, rx + cw, 911.5);
      const row = Math.floor((tf - T(BOOT + 0.8)) * 5);
      for (let k = 0; k < 4; k++) {
        const r = row - 3 + k; if (r < 0) continue;
        const s = Array.from({ length: 8 }, (_, q) => Math.floor(hash(r, q, 41) * 256).toString(16).toUpperCase().padStart(2, '0')).join(' ');
        TX(decode(t, T(BOOT + 0.8) + r / 5, s, { id: 600 + r, dur: 0.12 }), rx, 934 + k * 19, MONO(12.5, 400), { color: k === 3 ? pal.ink : pal.dim, alpha: fa * (0.5 + 0.17 * k) });
      }
      if (tf >= T(UPLINK)) {
        const ua = flick(t, T(UPLINK));
        st(pal.hot, 1.2, ua); if (geo) { c.strokeRect(rx + cw - 116, 1004, 116, 26); }
        TX(decode(t, T(UPLINK), 'UPLINK OK', { id: 777, dur: 0.2 }), rx + cw - 58, 1022, MONO(13, 700), { align: 'center', color: pal.hot, alpha: ua, tracking: 2 });
      }
    }

    // ---- bottom centre: what the scope is looking at ----
    GA = tierAt([[8, 0.6], [12, 1], [14, 0.85]]);
    if (tf >= T(BOOT + 1)) {
      const y = 1004;
      if (tf < T(LOCK + 0.3)) {
        const a = flick(t, T(BOOT + 1));
        TX(tf < T(SEARCH) ? 'CALIBRATING' : 'SCANNING', CX, y, MONO(15, 600), { align: 'center', alpha: a * (Math.floor(tf * 3) % 2 ? 0.55 : 1), tracking: 4 });
      } else {
        const t0 = T(LOCK + 0.3);
        TX(decode(t, t0, 'S77°32′14″  E167°09′41″', { id: 808, dur: 0.35, keep: /[°′″]/ }), CX, y + 4, MONO(26, 600), { align: 'center', color: pal.hot, tracking: 2, glow: 0.7 });
        TX('TGT-03 · 目标坐标', CX, y - 30, ZH(13, 500), { align: 'center', color: pal.dim, alpha: ease.outCubic(prog(t, t0 + 0.15, 0.3)), tracking: 3 });
      }
    }
    c.restore();
  }

  /** Dive after the lock: 0 → 1 over 1.45 s (magnification and the pan onto the target). */
  private zAt(t: number) { return t < this.T(LOCK) ? 0 : ease.outCubic(prog(t, this.T(LOCK), 1.45)); }

  /** Dot-map brightness for every grid dot at frame time tf (memoised: the scope is drawn in two passes). */
  private dotField(tf: number) {
    const memo = this.dotMemo;
    if (memo.tf === tf) return memo.on;
    const T = (x: number) => this.T(x), z = this.zAt(tf), zoom = Math.exp(Math.log(6) * z);
    // the map drifts until the lock holds it; the dive pans the target into the centre
    const drift = (u: number) => ({ x: (u - T(BOOT)) * 7, y: (u - T(BOOT)) * 2.5 });
    const dl = drift(Math.min(tf, T(LOCK))), wT = { x: TGT.x + drift(T(LOCK)).x, y: TGT.y + drift(T(LOCK)).y };
    const vx = lerp(dl.x, wT.x, z), vy = lerp(dl.y, wT.y, z);
    for (let i = 0; i < this.dots.length; i++) {
      const d = this.dots[i]!, wx = vx + d.x / zoom, wy = vy + d.y / zoom;
      const v = fbm2(wx * 0.0062 + 3.1, wy * 0.0062 - 1.7, 4, 11);
      // coast bright, land interior medium, sea a faint grid
      memo.on[i] = v > 0.06 ? 0.45 + 0.55 * Math.exp(-(((v - 0.06) / 0.07) ** 2)) : v > 0 ? 0.14 : 0.05;
    }
    memo.tf = tf;
    return memo.on;
  }

  /** The scope: dot map, rings, ticks, sweep, blips, converging brackets, the lock banner. */
  private scope(c: Ctx, t: number, tf: number, pass: 'geo' | 'txt', pal: Pal, setGA: (k: number) => void, h: {
    st: (col: string, w?: number, a?: number) => void; fl: (col: string, a?: number) => void;
    L: (x0: number, y0: number, x1: number, y1: number, p?: number) => void; ARC: (x: number, y: number, r: number, a0: number, a1: number, p?: number) => void;
    TX: (s: string, x: number, y: number, fnt: string, o?: GlowOpts) => number; TW: (s: string, fnt: string, tr?: number) => number;
  }) {
    const T = (x: number) => this.T(x), geo = pass === 'geo', { st, fl, L, ARC, TX } = h;
    // focus pull: the scope drops to 45 % while the candidates are read, back to full on the lock
    const keys: [number, number][] = [[T(8), 1], [T(10.4), 0.7], [T(CONVERGE - 0.1), 0.45], [T(LOCK), 1], [T(RESOLVE), 0.85]];
    const ga = tier(t, keys);
    setGA(ga);
    const p0 = ease.outCubic(prog(t, T(BOOT + 0.2), 0.7));
    if (p0 <= 0) return;
    // dot map
    if (geo) {
      const on = this.dotField(tf), rev = ease.outCubic(prog(t, T(BOOT + 0.5), 1.0)) * R;
      c.fillStyle = pal.ink;
      for (let i = 0; i < this.dots.length; i++) {
        const d = this.dots[i]!;
        if (d.x * d.x + d.y * d.y > rev * rev) continue;
        c.globalAlpha = on[i]! * ga;
        c.fillRect(CX + d.x - 1.2, CY + d.y - 1.2, 2.4, 2.4);
      }
    }
    // rings and cross
    st(pal.ink, 1.5, 0.95); ARC(CX, CY, R + 18, -Math.PI / 2, Math.PI * 1.5, p0);
    st(pal.deep, 1, 1); ARC(CX, CY, R * 0.36, 0, TAU, p0); ARC(CX, CY, R * 0.72, 0, TAU, p0);
    st(pal.deep, 1, 1); L(CX - R, CY + 0.5, CX + R, CY + 0.5, p0); L(CX + 0.5, CY - R, CX + 0.5, CY + R, p0);
    // tick ring
    if (geo) {
      for (let i = 0; i < 120; i++) {
        if (i / 120 > p0) break;
        const a = (i * 3 - 90) * DEG, big = i % 10 === 0, l = big ? 14 : 6;
        st(big ? pal.ink : pal.dim, 1, 1); L(CX + Math.cos(a) * (R + 30), CY + Math.sin(a) * (R + 30), CX + Math.cos(a) * (R + 30 + l), CY + Math.sin(a) * (R + 30 + l));
      }
      // segmented outer arcs turning, a dashed counter-ring
      const rot = (t - T(BOOT)) * 6 * DEG, p1 = ease.outCubic(prog(t, T(BOOT + 0.45), 0.6));
      st(pal.ink, 5, 0.9);
      for (let k = 0; k < 4; k++) ARC(CX, CY, R + 62, rot + k * Math.PI / 2 + 0.12, rot + k * Math.PI / 2 + 0.12 + 0.9 * p1);
      c.setLineDash([2, 9]); st(pal.dim, 1.5, 0.9); ARC(CX, CY, R + 80, -rot * 1.6, -rot * 1.6 + TAU * p1); c.setLineDash([]);
    }
    const lab = ['000', '030', '060', '090', '120', '150', '180', '210', '240', '270', '300', '330'];
    const bannerUp = t >= T(LOCK) - 0.1;
    if (p0 > 0.6) lab.forEach((s, i) => { if (bannerUp && i % 6 === 3) return; const a = (i * 30 - 90) * DEG; TX(s, CX + Math.cos(a) * (R + 104), CY + Math.sin(a) * (R + 104) + 5, MONO(12, 500), { align: 'center', color: pal.dim, alpha: (p0 - 0.6) / 0.4, glow: 0.2 }); });
    // radar sweep (from the signal on)
    if (geo && t >= T(SEARCH) && tf < T(LOCK)) {
      const a = -Math.PI / 2 + (t - T(SEARCH)) * Math.PI, wedge = 1.0;
      const g = c.createConicGradient(a - wedge, CX, CY);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(wedge / TAU, pal.ink); g.addColorStop(wedge / TAU + 0.001, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.globalAlpha = 0.28 * ga; c.fillStyle = g; c.beginPath(); c.arc(CX, CY, R, 0, TAU); c.fill();
      st(pal.hot, 1.5, 0.9); L(CX, CY, CX + Math.cos(a) * R, CY + Math.sin(a) * R);
    }
    // blips: the three candidates ride the drifting map; the target's lands in the centre with the dive
    const z = this.zAt(tf), zoom = Math.exp(Math.log(6) * z);
    const drift = (u: number) => ({ x: (u - T(BOOT)) * 7, y: (u - T(BOOT)) * 2.5 });
    const dl = drift(Math.min(tf, T(LOCK))), dL = drift(T(LOCK));
    const vx = lerp(dl.x, TGT.x + dL.x, z), vy = lerp(dl.y, TGT.y + dL.y, z);
    const BL = [{ x: -150, y: 96 }, { x: 170, y: 130 }, TGT];
    BL.forEach((b, i) => {
      const t0 = T(CAND[i]!) - 0.25;
      if (tf < t0) return;
      const sx = CX + (b.x + dL.x - vx) * zoom, sy = CY + (b.y + dL.y - vy) * zoom, tgt = i === 2;
      if (Math.hypot(sx - CX, sy - CY) > R - 4) return;
      const a = flick(t, t0) * (tgt ? 1 : tf > T(LOCK) ? 0.35 : 0.8);
      if (geo) { fl(tgt ? pal.hot : pal.ink, a); c.fillRect(sx - 3, sy - 3, 6, 6); if (tgt && tf < T(LOCK)) { st(pal.hot, 1.2, a * (0.55 + 0.45 * Math.cos((tf - t0) * 12))); c.strokeRect(sx - 8.5, sy - 8.5, 17, 17); } }
      if (!tgt || tf < T(LOCK)) TX(`CND-0${i + 1}`, sx + 12, sy - 8, MONO(12, 600), { color: tgt ? pal.hot : pal.ink, alpha: a });
    });
    // brackets converge on the target and snap shut on the lock (closed shutter on that frame)
    const tb = hitT(t, [T(LOCK)]);
    if (tb >= T(CONVERGE)) {
      // on the target (which rides the map, frame time) — its size snaps on tb
      const bx = CX + (TGT.x + dL.x - vx) * zoom, by = CY + (TGT.y + dL.y - vy) * zoom;
      const k = ease.inCubic(prog(tb, T(CONVERGE), T(LOCK) - T(CONVERGE)));
      let hs = lerp(170, 34, k);
      if (tb >= T(LOCK)) hs = 34 * (1 + 0.35 * Math.exp(-(tb - T(LOCK)) * 14) * Math.cos((tb - T(LOCK)) * 40));
      const col = tb >= T(LOCK) ? pal.hot : pal.ink, arm = 14;
      setGA(1);
      st(col, 2.2, 1);
      if (geo) {
        c.lineCap = 'square';
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) { const x = bx + sx * hs, y = by + sy * hs; c.beginPath(); c.moveTo(x, y - sy * arm); c.lineTo(x, y); c.lineTo(x - sx * arm, y); c.stroke(); }
        c.lineCap = 'butt';
        if (tb >= T(LOCK)) { st(col, 1.2, 0.9); L(bx - 7, by, bx + 7, by); L(bx, by - 7, bx, by + 7); }
      }
      if (tb < T(LOCK)) TX(`${(hs * 2).toFixed(0).padStart(3, '0')} PX`, bx + hs + 8, by + hs, MONO(11, 500), { color: pal.ink, alpha: 0.8 });
    }
    // the lock banner: slams in on the beat, its impact frame crisp
    const sl = slamIn(tb, T(LOCK), { from: 1.3, dur: 0.1, amp: 0.05 });
    if (sl.visible) {
      setGA(1);
      const bw = 470, bh = 52, yb = CY;
      c.save();
      c.translate(CX, yb); c.scale(sl.s, sl.s); c.translate(-CX, -yb);
      c.globalAlpha = sl.a;
      if (geo) {
        // a dark band knocks the map back; hazard ticks at both ends; double rules
        c.fillStyle = 'rgba(2,8,10,0.72)'; c.fillRect(CX - bw, yb - bh, 2 * bw, 2 * bh);
        st(pal.hot, 1.5, sl.a); L(CX - bw, yb - bh + 0.5, CX + bw, yb - bh + 0.5); L(CX - bw, yb + bh - 0.5, CX + bw, yb + bh - 0.5);
        st(pal.ink, 1, 0.6 * sl.a); L(CX - bw + 10, yb - bh + 6.5, CX + bw - 10, yb - bh + 6.5); L(CX - bw + 10, yb + bh - 6.5, CX + bw - 10, yb + bh - 6.5);
        fl(pal.ink, 0.9 * sl.a);
        for (const s of [-1, 1]) for (let i = 0; i < 6; i++) { const x = CX + s * (bw - 12 - i * 13); c.beginPath(); c.moveTo(x, yb - bh + 12); c.lineTo(x + 6 * s, yb - bh + 12); c.lineTo(x + 6 * s - 10 * s, yb + bh - 12); c.lineTo(x - 10 * s, yb + bh - 12); c.closePath(); c.fill(); }
      }
      TX('目标锁定', CX - 66, yb + 20, ZH(56, 700), { align: 'right', color: pal.hot, alpha: sl.a, glow: 0.8, glowR: 7, tracking: 4 });
      TX('TARGET', CX + 66, yb - 14, MONO(15, 600), { color: pal.dim, alpha: sl.a, tracking: 6 });
      TX('LOCKED', CX + 64, yb + 26, MONO(44, 600), { color: pal.hot, alpha: sl.a, glow: 0.8, glowR: 7, tracking: 6 });
      TX(decode(t, T(LOCK + 0.15), 'ALERT 03 · CONF 99.7%', { id: 830, dur: 0.3, keep: /[.%]/ }), CX - 70, yb + 42, MONO(11, 500), { align: 'right', color: pal.ink, alpha: sl.a * 0.9, tracking: 2 });
      c.restore();
    }
  }

  /** A small radar in panel 03: rings, a sweep, three contacts listed. */
  private miniRadar(c: Ctx, t: number, tf: number, pass: 'geo' | 'txt', pal: Pal, x: number, w: number, GA: number) {
    const T = (v: number) => this.T(v), rx = x + 62, ry = 930, Rr = 48, geo = pass === 'geo';
    const p = ease.outCubic(prog(t, T(BOOT + 0.7), 0.6));
    c.save();
    if (geo) {
      c.globalAlpha = 0.9 * GA; c.strokeStyle = pal.dim; c.lineWidth = 1;
      for (const k of [1 / 3, 2 / 3, 1]) { c.beginPath(); c.arc(rx, ry, Rr * k, -Math.PI / 2, -Math.PI / 2 + TAU * p); c.stroke(); }
      c.strokeStyle = pal.deep; c.beginPath(); c.moveTo(rx - Rr, ry + 0.5); c.lineTo(rx + Rr, ry + 0.5); c.moveTo(rx + 0.5, ry - Rr); c.lineTo(rx + 0.5, ry + Rr); c.stroke();
      const a = -Math.PI / 2 + (t - T(BOOT)) * Math.PI;
      const g = c.createConicGradient(a - 1.1, rx, ry);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1.1 / TAU, pal.ink); g.addColorStop(1.1 / TAU + 0.001, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.globalAlpha = 0.3 * GA * p; c.fillStyle = g; c.beginPath(); c.arc(rx, ry, Rr, 0, TAU); c.fill();
      c.globalAlpha = 0.9 * GA * p; c.strokeStyle = pal.hot; c.lineWidth = 1.5; c.beginPath(); c.moveTo(rx, ry); c.lineTo(rx + Math.cos(a) * Rr, ry + Math.sin(a) * Rr); c.stroke();
      [[41, 0.34], [128, 0.7], [251, 0.55]].forEach(([b, r], i) => {
        const ba = (b! - 90) * DEG, since = mod(a - ba, TAU) / Math.PI, I = Math.exp(-since * 1.6) * p;
        c.globalAlpha = I * GA; c.fillStyle = i === 0 && tf > T(SEARCH) ? pal.hot : pal.ink; c.fillRect(rx + Math.cos(ba) * Rr * r! - 2, ry + Math.sin(ba) * Rr * r! - 2, 4, 4);
      });
    } else {
      const fnt = MONO(12, 500);
      [['B-1 041° 0.34', 0], ['B-2 128° 0.70', 1], ['B-3 251° 0.55', 2]].forEach(([s, i]) => {
        const a = flick(t, T(BOOT + 0.9 + (i as number) * 0.15));
        glowText(c, fnt, s as string, x + w - 4, 900 + (i as number) * 20, { align: 'right', color: i === 0 && tf > T(SEARCH) ? pal.hot : pal.ink, alpha: a * GA });
      });
      glowText(c, MONO(12, 600), 'CONTACTS', x + w - 4, 878, { align: 'right', color: pal.dim, alpha: p * GA, tracking: 2 });
    }
    c.restore();
  }

  /** A scrolling sparkline with its label and rolling reading. */
  private spark(c: Ctx, t: number, tf: number, pass: 'geo' | 'txt', pal: Pal, x: number, y: number, w: number, h: number, seed: number, t0: number, lab: string, unit: string, base: number, amp: number, GA: number) {
    // drawn in on frame time: the reading comes from the line's end, so it must be one value per frame
    const p = ease.inOutCubic(prog(tf, t0, 0.7));
    if (p <= 0) return;
    const T = (v: number) => this.T(v), N = 90, win = 3.0, pts: [number, number][] = [];
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      if (u > p) break;
      const ts = tf - (1 - u) * win, j = Math.floor(ts * 20);
      let v = 0.45 + 0.18 * Math.sin(ts * 3.1 + seed) + 0.12 * Math.sin(ts * 7.7 + seed * 2) + 0.14 * (hash(seed, j) - 0.5);
      if (ts > T(SEARCH)) v += 0.42 * Math.exp(-(ts - T(SEARCH)) * 1.2) + 0.12;
      if (ts > T(LOCK)) v = 0.8 + 0.07 * Math.sin(ts * 9 + seed) + 0.05 * (hash(seed, j, 2) - 0.5);
      pts.push([x + u * w, y + h - clamp(v, 0.02, 0.98) * h]);
    }
    const [ex, ey] = pts[pts.length - 1]!;
    c.save();
    if (pass === 'geo') {
      c.globalAlpha = GA; c.strokeStyle = pal.deep; c.lineWidth = 1;
      for (let k = 0; k <= 2; k++) { c.beginPath(); c.moveTo(x, y + (h * k) / 2 + 0.5); c.lineTo(x + w, y + (h * k) / 2 + 0.5); c.stroke(); }
      c.beginPath(); pts.forEach(([a, b], i) => (i ? c.lineTo(a, b) : c.moveTo(a, b)));
      c.strokeStyle = pal.ink; c.lineWidth = 1.4; c.stroke();
      c.lineTo(ex, y + h); c.lineTo(x, y + h); c.closePath(); c.globalAlpha = 0.1 * GA; c.fillStyle = pal.ink; c.fill();
      c.globalAlpha = GA; c.fillStyle = pal.hot; c.fillRect(ex - 2, ey - 2, 4, 4);
    } else {
      const v = base + amp * (1 - (ey - y) / h);
      glowText(c, MONO(13, 600), lab, x, y - 9, { color: pal.dim, alpha: GA, tracking: 2 });
      glowText(c, MONO(15, 600), `${rollDigits(t, t0, v.toFixed(1), seed, 0.15)} ${unit}`, x + w, y - 9, { align: 'right', color: pal.hot, alpha: GA });
    }
    c.restore();
  }
}

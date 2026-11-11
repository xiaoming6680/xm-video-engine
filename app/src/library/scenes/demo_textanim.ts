// 文字动画器示例（?textanim）：8 秒一循环，四拍，每拍一个主句 + 一两行小字，把 engine/textanim.ts 的主要功能都动一遍：
//   01  逐字错峰进场（cascade + E.back 过冲：位移、缩放、旋转、模糊、透明），小字用上坡范围从左往右显出、字距收拢、过渡区染色；
//       下坡范围从左往右扫走；小字随机顺序消失
//   02  两行按行进场（by 'line'，倾斜 + 位移），三角范围像浪一样扫过两行（缩放、上移、换色，缓入缓出高低），随机顺序逐字熄灭
//       （square、smooth 0）；说明行是打字机
//   03  按词（中文按分词）弹出、整词为中心（group 'word'）、按序号选最后两个词换色；乱码解码（scramble + 上坡范围）；
//       数字像老虎机一样滚到位（charOffset）
//   04  抖动选择器和范围相交（intersect）：范围的量做包络，抖动只在包络里；英文按词抖、各词相关 0.5；从两边往中间缩走
// 字都用 shutterT(t, 0)（不被运动模糊糊掉，乱码每帧只换一次）。底部说明行本身也是文字动画器画的。
import type * as THREE from 'three';
import { Scene, type Frame } from '../../engine/scene';
import { Layer2D, W } from '../../engine/gl';
import { F, font } from '../../engine/type';
import { prog, shutterT, TAU } from '../../engine/util';
import { E, kf } from '../../engine/anim';
import { TextBlock, range, wiggly, cascade, type TextAnimator } from '../../engine/textanim';

const LOOP = 8;
const BG = '#111218', INK = '#F3EEE4', DIM = '#8C877C', ACC = '#FF5A36', BLUE = '#5B6BFF';

const BEATS = [
  { t: 0, n: '01', zh: '逐字错峰 · 范围显出', en: 'cascade · range rampUp / rampDown · random out' },
  { t: 2, n: '02', zh: '按行进场 · 三角范围 · 乱序熄灭', en: 'by line · range triangle · ease high / low · random' },
  { t: 4, n: '03', zh: '按词 · 乱码解码 · 换字', en: 'by word · scramble · charOffset · units index' },
  { t: 6, n: '04', zh: '抖动选择器 × 范围', en: 'wiggly ∩ range · correlation · skew' },
];

export default class DemoTextAnim extends Scene {
  layer = new Layer2D();
  // beat 1
  t1 = new TextBlock('文字动画器', { family: F.sans(900), size: 210, align: 'center', valign: 'middle', tracking: 6 });
  s1 = new TextBlock('TEXT ANIMATOR · RANGE SELECTOR', { family: F.mono(500), size: 30, align: 'center', valign: 'middle', tracking: 8 });
  // beat 2
  t2 = new TextBlock('RANGE\nSELECTOR', { family: F.sans(900), size: 190, align: 'center', valign: 'middle', lineHeight: 0.95 });
  s2 = new TextBlock('shape: triangle   easeHigh 0.5   easeLow 0.5', { family: F.mono(400), size: 26, align: 'center', valign: 'middle', tracking: 2 });
  // beat 3
  t3 = new TextBlock('按词出现的歌词排版', { family: F.sans(700), size: 128, align: 'center', valign: 'middle', tracking: 4 });
  d3 = new TextBlock('DECODE  0x2F·SIGNAL', { family: F.mono(600), size: 58, align: 'center', valign: 'middle', tracking: 6 });
  n3 = new TextBlock('2026.11.08  —  00:42:17', { family: F.mono(500), size: 38, align: 'center', valign: 'middle', tracking: 4 });
  // beat 4
  t4 = new TextBlock('抖动选择器', { family: F.sans(900), size: 190, align: 'center', valign: 'middle', tracking: 4 });
  s4 = new TextBlock('WIGGLY  SELECTOR  MEETS  RANGE', { family: F.sans(700), size: 56, align: 'center', valign: 'middle', tracking: 6 });
  // chrome
  caps = BEATS.map((b) => ({
    n: new TextBlock(b.n, { family: F.mono(600), size: 20 }),
    zh: new TextBlock(b.zh, { family: F.sans(600), size: 28 }),
    en: new TextBlock(b.en, { family: F.mono(400), size: 15, tracking: 1.5 }),
  }));

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const t = shutterT(f.t, 0) % LOOP; // crisp type; the demo loops every 8 s
    const c = this.layer.ctx;
    this.layer.clear(BG);
    this.frame(c, t);
    if (t < 2.05) this.beat1(c, t);
    if (t >= 1.95 && t < 4.05) this.beat2(c, t);
    if (t >= 3.95 && t < 6.05) this.beat3(c, t);
    if (t >= 5.95) this.beat4(c, t);
    this.caption(c, t);
    this.ctx.comp.draw(this.ctx.renderer, this.layer.upload(), out, { mode: 'replace' });
  }

  // ---------------------------------------------------------------- 01
  private beat1(c: CanvasRenderingContext2D, t: number) {
    const cx = W / 2;
    const exit: TextAnimator = {
      select: range({ end: 0.35, offset: kf(t, [[1.5, -0.35], [1.98, 1]]), shape: 'rampDown', easeHigh: 0.6 }),
      position: [0, -130], scale: [1, 1.5], opacity: 0, blur: 18,
    };
    this.t1.draw(c, cx, 470, t, [
      { select: cascade({ t0: 0.08, each: 0.085, dur: 0.85, ease: E.back }), position: [0, 170], scale: 0.2, rotation: -0.9, opacity: 0, blur: 28 },
      exit,
    ], { fill: INK });
    this.s1.draw(c, cx, 650, t, [
      // the reveal runs left to right: chars still to come are spread out, transparent, and the ramp itself is tinted
      { select: range({ end: 0.3, offset: kf(t, [[0.45, -0.3], [1.3, 1]]), shape: 'rampUp' }), opacity: 0, tracking: 14 },
      { select: range({ end: 0.3, offset: kf(t, [[0.45, -0.3], [1.3, 1]]), shape: 'triangle' }), fill: ACC },
      { select: cascade({ t0: 1.5, each: 0.008, dur: 0.25, ease: E.in, out: true, from: 'random', seed: 2 }), opacity: 0, position: [0, 18] },
    ], { fill: DIM });
  }

  // ---------------------------------------------------------------- 02
  private beat2(c: CanvasRenderingContext2D, t: number) {
    const cx = W / 2;
    const wave = kf(t, [[2.55, -0.32], [3.5, 1.0]]);
    this.t2.draw(c, cx, 470, t, [
      { select: cascade({ by: 'line', t0: 2.0, each: 0.16, dur: 0.6, ease: E.out }), position: [-460, 0], skew: 0.55, opacity: 0, blur: 10 },
      { select: range({ end: 0.32, offset: wave, shape: 'triangle', easeHigh: 0.5, easeLow: 0.5 }), scale: 1.38, position: [0, -30], fill: ACC },
      { select: range({ end: kf(t, [[3.55, 0], [3.98, 1]]), random: true, seed: 5, smooth: 0 }), opacity: 0 },
    ], { fill: INK, group: 'char' });
    // typewriter: the chars from `start` on are not typed yet (square, smooth 0: a char is there or not)
    this.s2.draw(c, cx, 730, t, [
      { select: range({ start: kf(t, [[2.4, 0, 'lin'], [3.1, 1]]), smooth: 0 }), opacity: 0 },
      { select: cascade({ t0: 3.55, each: 0.005, dur: 0.18, out: true, from: 'end' }), opacity: 0 },
    ], { fill: DIM });
    // the cursor
    // the cursor sits before the first char not typed yet (a char shows once the range start passes its centre)
    const typed = kf(t, [[2.4, 0, 'lin'], [3.1, 1]]), L = this.s2.layout, n = L.glyphs.length;
    if (t >= 2.3 && t < 3.6 && Math.floor(t * 4) % 2 === 0) {
      const i = Math.max(0, Math.min(n, Math.ceil(typed * n - 0.5))), g = L.glyphs[Math.min(n - 1, i)]!;
      c.fillStyle = ACC;
      c.fillRect(cx + (i < n ? g.x - 2 : g.x + g.w + 4), 730 + g.y - 22, 3, 28);
    }
  }

  // ---------------------------------------------------------------- 03
  private beat3(c: CanvasRenderingContext2D, t: number) {
    const cx = W / 2, nw = this.t3.count('word');
    this.t3.draw(c, cx, 410, t, [
      { select: cascade({ by: 'word', t0: 4.0, each: 0.15, dur: 0.6, ease: E.back }), scale: 0, opacity: 0 },
      // the last two words (units 'index': start / end count words), tinted once they are in
      { select: range({ by: 'word', units: 'index', start: nw - 2, end: nw, amount: prog(t, 4.9, 5.2, E.out) }), fill: ACC, position: [0, -8] },
      { select: cascade({ by: 'word', t0: 5.45, each: 0.05, dur: 0.3, ease: E.in, out: true, from: 'end' }), position: [0, 50], opacity: 0, blur: 10 },
    ], { fill: INK, group: 'word' });
    this.d3.draw(c, cx, 610, t, [
      { select: range({ start: kf(t, [[4.15, 0], [4.55, 1]]), smooth: 0 }), opacity: 0 },
      // decoded from the left: the ramp's right side is still noise (and tinted)
      { select: range({ end: 0.22, offset: kf(t, [[4.35, -0.22], [5.25, 1]]), shape: 'rampUp' }), scramble: true, fill: ACC },
      { select: cascade({ t0: 5.5, each: 0.01, dur: 0.25, out: true, from: 'random', seed: 9 }), opacity: 0, scramble: true },
    ], { fill: INK });
    this.n3.draw(c, cx, 720, t, [
      { select: range({ start: kf(t, [[4.3, 0], [4.6, 1]]), smooth: 0 }), opacity: 0 },
      // slot machine: digits under the ramp roll, the ones still to come sit 9 places off
      { select: range({ end: 0.35, offset: kf(t, [[4.5, -0.35], [5.35, 1]]), shape: 'rampUp' }), charOffset: 9, fill: BLUE },
      { select: cascade({ t0: 5.5, each: 0.008, dur: 0.25, out: true, from: 'start' }), opacity: 0, position: [0, 14] },
    ], { fill: DIM });
  }

  // ---------------------------------------------------------------- 04
  private beat4(c: CanvasRenderingContext2D, t: number) {
    const cx = W / 2;
    const env = kf(t, [[6.45, 0], [6.8, 1], [7.3, 1], [7.55, 0]]);
    const exit = cascade({ t0: 7.45, each: 0.05, dur: 0.42, ease: E.in, out: true, from: 'edges' });
    this.t4.draw(c, cx, 450, t, [
      { select: cascade({ t0: 6.0, each: 0.07, dur: 0.6, ease: E.out, from: 'center' }), scale: [1, 0], opacity: 0 },
      // range ∩ wiggly: the range's amount is the envelope, the wiggle (−1..1) only acts inside it
      { select: [range({ amount: env }), wiggly({ min: -1, max: 1, speed: 3, seed: 4 })], position: [0, -46], rotation: 0.32 },
      { select: [range({ amount: env }), wiggly({ speed: 2, seed: 8 })], fill: ACC },
      { select: exit, scale: 0.2, blur: 22, opacity: 0 },
    ], { fill: INK });
    this.s4.draw(c, cx, 640, t, [
      { select: cascade({ by: 'word', t0: 6.15, each: 0.08, dur: 0.5, ease: E.out }), position: [0, 40], opacity: 0 },
      { select: [range({ amount: env }), wiggly({ by: 'word', min: -1, max: 1, speed: 2.5, correlation: 0.5, seed: 2 })], skew: 0.45, position: [0, 16] },
      { select: cascade({ by: 'word', t0: 7.45, each: 0.05, dur: 0.4, ease: E.in, out: true, from: 'edges' }), opacity: 0, blur: 10 },
    ], { fill: DIM, group: 'word' });
  }

  // ---------------------------------------------------------------- frame and captions
  private frame(c: CanvasRenderingContext2D, t: number) {
    c.save();
    c.font = font(F.mono(500), 15);
    c.letterSpacing = '3px';
    c.fillStyle = DIM;
    c.fillText('TEXTANIM', 96, 92);
    c.globalAlpha = 0.55;
    c.fillText('engine/textanim.ts', 96, 116);
    c.letterSpacing = '0px';
    c.globalAlpha = 0.18;
    c.fillStyle = INK;
    c.fillRect(96, 132, W - 192, 1);
    c.fillRect(96, 948, W - 192, 1);
    // loop progress: four beats, the current one filling
    c.globalAlpha = 1;
    for (let k = 0; k < 4; k++) {
      const x = W - 96 - (3 - k) * 52 - 40, p = prog(t, k * 2, k * 2 + 2);
      c.fillStyle = 'rgba(243,238,228,0.18)';
      c.fillRect(x, 1004, 40, 3);
      c.fillStyle = ACC;
      c.fillRect(x, 1004, 40 * p, 3);
    }
    c.restore();
  }

  private caption(c: CanvasRenderingContext2D, t: number) {
    const k = Math.min(3, Math.floor(t / 2)), b = BEATS[k]!, cp = this.caps[k]!, t0 = b.t;
    // in: a char every 18 ms; out: the whole line gone by the end of the beat (stagger spread over 0.12 s)
    const anim = (d: number, n: number): TextAnimator[] => [
      { select: cascade({ t0: t0 + 0.1 + d, each: 0.018, dur: 0.4, ease: E.out }), position: [0, 16], opacity: 0 },
      { select: cascade({ t0: t0 + 1.7, each: 0.12 / Math.max(1, n), dur: 0.15, ease: E.in, out: true }), opacity: 0 },
    ];
    cp.n.draw(c, 96, 1012, t, anim(0, cp.n.count('char')), { fill: ACC });
    cp.zh.draw(c, 146, 1014, t, anim(0.05, cp.zh.count('char')), { fill: INK });
    cp.en.draw(c, 146 + cp.zh.layout.width + 22, 1010, t, anim(0.12, cp.en.count('char')), { fill: DIM });
    // a small rotating tick next to the progress bar keeps the loop's clock visible
    c.save();
    c.translate(W - 96 - 4 * 52 - 18, 1005);
    c.rotate((t / LOOP) * TAU);
    c.fillStyle = DIM;
    c.fillRect(-1, -9, 2, 9);
    c.restore();
  }
}

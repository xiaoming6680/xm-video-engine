// 到达时间和换张的示例（?reveal）：engine/arrival.ts + effects.ts 的 reveal，engine/swap.ts。四格，从 0 秒开始约 4.5 秒做完。
// 用来看部件，不是画面标准。
//   1 写字：「木」四笔按笔顺写出（timeStrokes 排时间、arrivalStrokes、刚写的一段染红：reveal 的 front），铅笔是两张图的换张
//     （落笔 / 抬笔两张图大小、角度都不一样，按笔尖锚点对齐），笔尖跟着 penAt 走，抬笔时笔和影子分开
//   2 线稿：没有笔画数据的一张线稿，arrivalTrace 按连着的一段一段从左往右描（每段从一头走到另一头）
//   3 光：从中间一点往外，椭圆的波前（squash），stepT 15 一档一档硬边；先亮一档浅色、0.12 s 后才是本色；
//     2.4 s 起一条之字形笔画把黑条擦掉（reveal invert）
//   4 换张：同样四张跑步图（每张画布大小、人在画布里的位置都不一样），上面按腰的锚点对齐，下面按图中心摆（会跳）；
//     Swap.seq 每 1/8 s 一张，对齐到 1/15 s 的格子；两个都开 smear：换张不算运动，只拉真的位移
import * as THREE from 'three';
import { Scene, type Frame } from '../../engine/scene';
import { Comp, type Layer } from '../../engine/layers';
import { Fx } from '../../engine/effects';
import { Layer2D } from '../../engine/gl';
import { F, font } from '../../engine/type';
import { stepT } from '../../engine/util';
import { arrivalDistance, arrivalStrokes, arrivalTrace, penAt, timeStrokes, type Pt } from '../../engine/arrival';
import { Swap } from '../../engine/swap';

const CW = 900, CH = 470;
const cellAt = (i: number): [number, number] => [40 + (i % 2) * 940 + CW / 2, 60 + Math.floor(i / 2) * 500 + CH / 2];
const INK = '#1d1b22', PAPER = '#f4efe6', TXT = '#e8e6e3', DIM = '#8a8794';

function label(zh: string, en: string): Layer {
  return {
    name: 'label', motionBlur: false, size: [CW, 64], position: [CW / 2, 32], draw: (c) => {
      c.fillStyle = '#0e0d12'; c.fillRect(0, 0, CW, 64);
      c.font = font(F.sans(700), 21); c.fillStyle = TXT; c.fillText(zh, 18, 30);
      c.font = font(F.mono(400), 13); c.fillStyle = DIM; c.fillText(en, 18, 52);
    },
  };
}

/** A canvas texture of a cell-sized drawing, drawn once. */
function plate(draw: (c: CanvasRenderingContext2D) => void, w = CW, h = CH): THREE.Texture {
  const l = new Layer2D(w, h);
  l.clear();
  draw(l.ctx);
  return l.upload();
}

/** A pencil on its own canvas: tip at `tip`, pointing along `deg` (0 = right, clockwise), canvas w x h. */
function pencil(w: number, h: number, tip: Pt, deg: number, pressed: boolean): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d')!;
  const a = (deg * Math.PI) / 180, d = [Math.cos(a), Math.sin(a)], n = [-d[1]!, d[0]!];
  const at = (s: number, o: number): [number, number] => [tip[0] + d[0]! * s + n[0]! * o, tip[1] + d[1]! * s + n[1]! * o];
  const quad = (s0: number, s1: number, r0: number, r1: number, col: string) => {
    c.fillStyle = col; c.beginPath();
    c.moveTo(...at(s0, -r0)); c.lineTo(...at(s1, -r1)); c.lineTo(...at(s1, r1)); c.lineTo(...at(s0, r0)); c.closePath(); c.fill();
  };
  quad(0, 12, 0.5, 4, '#2b2b30');
  quad(12, 42, 4, 13, '#e9c48f');
  quad(42, 250, 13, 13, '#f2c230');
  quad(42, 250, 4, 4, '#d9a91c');
  quad(250, 272, 14, 14, '#b9b9c0');
  quad(272, 300, 13, 13, '#e88a9a');
  if (pressed) { c.fillStyle = 'rgba(29,27,34,0.55)'; c.beginPath(); c.arc(tip[0], tip[1], 4, 0, 7); c.fill(); }
  return cv;
}

/** A running figure on its own canvas (w x h) with the hip at `hip`; leg / arm angles in degrees from straight down, + forward. */
function runner(w: number, h: number, hip: Pt, legs: readonly [number, number, number, number]): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d')!;
  c.lineCap = 'round'; c.lineJoin = 'round';
  const seg = (p: Pt, deg: number, len: number): Pt => [p[0] + Math.sin((deg * Math.PI) / 180) * len, p[1] + Math.cos((deg * Math.PI) / 180) * len];
  const limb = (p: Pt, a: number, b: number, l: number, col: string, wdt: number) => {
    const k = seg(p, a, l), f = seg(k, b, l);
    c.strokeStyle = col; c.lineWidth = wdt; c.beginPath(); c.moveTo(p[0], p[1]); c.lineTo(k[0], k[1]); c.lineTo(f[0], f[1]); c.stroke();
  };
  const [lt, ls, rt, rs] = legs;
  const neck = seg(hip, 180 - 12, 92), sh = seg(hip, 180 - 12, 80);
  limb(sh, -lt * 0.9, -lt * 0.9 + 70, 46, '#9b98a6', 12);   // far arm
  limb(hip, rt, rs, 68, '#9b98a6', 14);                     // far leg
  c.strokeStyle = INK; c.lineWidth = 16; c.beginPath(); c.moveTo(hip[0], hip[1]); c.lineTo(neck[0], neck[1]); c.stroke();
  c.fillStyle = INK; c.beginPath(); c.arc(...seg(neck, 180 - 12, 24), 22, 0, 7); c.fill();
  limb(hip, lt, ls, 68, INK, 15);                           // near leg
  limb(sh, -rt * 0.9, -rt * 0.9 + 70, 46, INK, 12);         // near arm
  return cv;
}

export default class DemoReveal extends Scene {
  fx = new Fx();
  top = new Comp(this.ctx, { bg: '#0e0d12', fx: this.fx });

  override init() {
    const fx = this.fx;
    const cell = () => new Comp(this.ctx, { w: CW, h: CH, bg: '#1a1920', fx });
    const paper: Layer = { name: 'paper', solid: PAPER, size: [CW, CH], position: [CW / 2, CH / 2] };

    // 1 writing: four strokes of 木, the ink revealed along them, a two-drawing pencil on the pen tip
    const O: Pt = [270, 80];
    const S = (pts: readonly Pt[]): Pt[] => pts.map(([x, y]) => [O[0] + x, O[1] + y]);
    const strokes = [
      S([[40, 118], [180, 110], [320, 104]]),
      S([[180, 18], [181, 180], [182, 350]]),
      S([[172, 126], [140, 198], [90, 262], [28, 310]]),
      S([[190, 126], [226, 198], [276, 258], [338, 300]]),
    ];
    const width = [(u: number) => 10 + 3 * Math.sin(Math.PI * u), (u: number) => 12 - 2 * u, (u: number) => 12 * (1 - 0.7 * u), (u: number) => 8 + 6 * u];
    const timed = timeStrokes(strokes, { start: 0.6, speed: (i) => (i === 0 ? 420 : 560), lift: 1600, liftMin: 0.12, ease: (u) => 0.5 - 0.5 * Math.cos(Math.PI * u) });
    const inkTex = plate((c) => {
      c.fillStyle = INK;
      timed.forEach((s, k) => {
        for (let d = 0; d <= s.len; d += 1.5) {
          const p = s.points, cum = s.cum;
          let j = 0; while (j + 2 < p.length && cum[j + 1]! < d) j++;
          const u = (d - cum[j]!) / Math.max(1e-6, cum[j + 1]! - cum[j]!);
          c.beginPath(); c.arc(p[j]![0] + (p[j + 1]![0] - p[j]![0]) * u, p[j]![1] + (p[j + 1]![1] - p[j]![1]) * u, width[k]!(d / s.len), 0, 7); c.fill();
        }
      });
    });
    // cross 4：撇、捺起笔压在竖上，后写的笔近 4 px 就把那里的墨拿回去（默认 radius / 2 会让竖先占走一小块）
    const inkMap = arrivalStrokes(CW, CH, timed, { radius: 16, cross: 4 });
    const pen = new Swap(this.ctx, [
      { src: pencil(260, 300, [24, 280], -52, true), anchor: [24, 280] },
      { src: pencil(320, 250, [30, 230], -40, false), anchor: [30, 230] },
    ], { frame: (t) => (penAt(timed, t).down ? 0 : 1) });
    const c1 = cell();
    c1.layers = [
      paper,
      { name: 'ink', texture: inkTex, size: [CW, CH], position: [CW / 2, CH / 2], effects: (t) => [{ type: 'reveal', map: inkMap, t, soft: 0.015, front: '#d81b3c', frontTime: 0.35 }] },
      { name: 'pen shadow', ...pen.layer(), opacity: 0.22, effects: [{ type: 'fill', color: '#000000' }], position: (t) => { const p = penAt(timed, t); return [p.x + 6 + p.height * 1.1, p.y + 4 + p.height * 0.5]; } },
      { name: 'pen', ...pen.layer(), position: (t) => { const p = penAt(timed, t); return [p.x, p.y - p.height * 0.7]; } },
      label('1 写字：按笔画到达，笔尖跟着写；铅笔是两张图换张', 'timeStrokes · arrivalStrokes · reveal front · penAt · Swap(frame: down ? 0 : 1)'),
    ];

    // 2 line art traced piece by piece
    const art = (c: CanvasRenderingContext2D) => {
      c.strokeStyle = INK; c.lineWidth = 7; c.lineCap = 'round'; c.lineJoin = 'round';
      const path = (pts: readonly Pt[], close = false) => { c.beginPath(); c.moveTo(pts[0]![0], pts[0]![1]); for (const p of pts.slice(1)) c.lineTo(p[0], p[1]); if (close) c.closePath(); c.stroke(); };
      path([[40, 420], [170, 250], [250, 330], [340, 210], [470, 400]]);                 // hills
      path([[520, 420], [520, 270], [640, 190], [760, 270], [760, 420]], false);          // house
      path([[600, 420], [600, 340], [660, 340], [660, 420]]);                              // door
      c.beginPath(); c.arc(300, 150, 42, 0, 7); c.stroke();                               // sun
      for (let k = 0; k < 8; k++) { const a = (k * Math.PI) / 4; path([[300 + Math.cos(a) * 60, 150 + Math.sin(a) * 60], [300 + Math.cos(a) * 84, 150 + Math.sin(a) * 84]]); }
      c.beginPath(); c.arc(110, 140, 26, Math.PI, 0); c.arc(150, 128, 32, Math.PI, 0); c.arc(190, 140, 24, Math.PI, 0); c.stroke();   // cloud
      path([[480, 432], [860, 432]]);                                                      // ground
    };
    const artTex = plate(art), artMap = arrivalTrace(CW, CH, art, { speed: 900, gap: 0.05, start: 0.5 });
    const c2 = cell();
    c2.layers = [
      paper,
      { name: 'art', texture: artTex, size: [CW, CH], position: [CW / 2, CH / 2], effects: (t) => [{ type: 'reveal', map: artMap, t, soft: 0.02 }] },
      label('2 线稿：没有笔画数据，按连着的一段一段从左往右描', "arrivalTrace(order: 'left', speed: 900, gap: 0.05)"),
    ];

    // 3 light spreading out in hard steps (a pale step first), then a black bar wiped off along a zigzag stroke
    const poster = plate((c) => {
      c.fillStyle = '#ff7a3d'; c.beginPath(); c.arc(450, 250, 150, 0, 7); c.fill();
      c.fillStyle = '#ffd23f'; c.beginPath(); c.arc(450, 250, 95, 0, 7); c.fill();
      c.fillStyle = '#2a4bff'; for (let k = 0; k < 6; k++) c.fillRect(0, 300 + k * 30, CW, 14);
      c.fillStyle = INK; c.font = font(F.sans(900), 96); c.textAlign = 'center'; c.fillText('REVEAL', 450, 290);
    });
    const lightMap = arrivalDistance(CW, CH, [450, 250], { squash: [1.7, 1], duration: 1.1 });
    // the bar's map is in the bar's own px (600 x 110): a zigzag over it, rows 35 px apart, 30 px either side
    const wipe = timeStrokes([[[10, 20], [590, 20], [10, 55], [590, 55], [10, 90], [590, 90]]], { start: 2.4, speed: 2600 });
    const barMap = arrivalStrokes(600, 110, wipe, { radius: 30 });
    const c3 = cell();
    c3.layers = [
      { name: 'night', solid: '#16224a', size: [CW, CH], position: [CW / 2, CH / 2] },
      { name: 'pale step', solid: '#bfeeff', size: [CW, CH], position: [CW / 2, CH / 2], effects: (t) => [{ type: 'reveal', map: lightMap, t: stepT(t, 15) - 0.4 }] },
      { name: 'colour', texture: poster, size: [CW, CH], position: [CW / 2, CH / 2], effects: (t) => [{ type: 'reveal', map: lightMap, t: stepT(t, 15) - 0.52 }] },
      { name: 'bar', solid: '#0b0b0f', size: [600, 110], position: [CW / 2, 250], in: 2.0, effects: (t) => [{ type: 'reveal', map: barMap, t, invert: true }] },
      label('3 光：从一点往外，椭圆波前，一档一档硬边（先浅色、后本色）；黑条沿笔画擦掉', 'arrivalDistance(squash: [1.7, 1]) · stepT(t, 15) · reveal invert'),
    ];

    // 4 the same four drawings, misregistered on purpose: aligned by the hip anchor vs placed by the image centre
    const poses: [number, number, number, number][] = [[35, 15, -25, -80], [12, -5, -8, -100], [-25, -80, 35, 15], [-8, -100, 12, -5]];
    const drawings = poses.map((p, i) => {
      const w = 260 + 60 * ((i * 3) % 4), h = 320 + 70 * ((i * 2) % 3), hip: Pt = [90 + 50 * ((i * 3) % 4), 130 + 60 * ((i * 2) % 3)];
      return { src: runner(w, h, hip, p), hip };
    });
    const keys = Swap.seq(0, [0, 1, 2, 3], 0.125, { until: 120 });
    const aligned = new Swap(this.ctx, drawings.map((d) => ({ src: d.src, anchor: d.hip })), { keys, fps: 15 });
    const loose = new Swap(this.ctx, drawings.map((d) => ({ src: d.src })), { keys, fps: 15 });
    const xAt = (t: number) => 90 + ((t * 170) % 720);
    const c4 = cell();
    c4.layers = [
      paper,
      { name: 'ground', motionBlur: false, draw: (c) => {
        c.strokeStyle = '#c9c2b4'; c.lineWidth = 3;
        for (const y of [250, 440]) { c.beginPath(); c.moveTo(20, y); c.lineTo(CW - 20, y); c.stroke(); }
        c.font = font(F.sans(700), 18); c.fillStyle = INK; c.fillText('锚点对齐（腰）', 24, 96); c.fillText('不对齐（按图中心摆）', 24, 286);
      } },
      { name: 'aligned', ...aligned.layer(), scale: 0.5, smear: 1, position: (t) => [xAt(t), 182] },
      { name: 'loose', ...loose.layer(), scale: 0.5, smear: 1, position: (t) => [xAt(t), 360] },
      label('4 换张：四张图画布大小、人在图里的位置都不一样', 'Swap(anchor: hip) vs no anchor · Swap.seq(0, [0, 1, 2, 3], 1/8) · fps 15'),
    ];

    this.top.layers = [c1, c2, c3, c4].map((c, i): Layer => ({ name: `cell${i + 1}`, comp: c, position: cellAt(i) }));
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) { this.top.render(f.t, out); }
}

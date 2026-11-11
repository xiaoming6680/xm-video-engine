// ?ref=typewarp：字的变形和手绘墨线（kit/typewarp.ts、kit/tegaki.ts 的 sketchLine），照 If The Sun Burns Out（VCT '26
// 粉丝动效复刻）的做法，一拍二（每秒 15 张画）。看接线和取值，不是画面标准。
//   0.0–2.0  ARRIVE 横拉竖压进场、停住慢慢放大，飞两张（拉丝、第一张红青分色）落到右上压扁回弹；LANDS 随后跟进；
//            底下一排是 streak 的 k = 0.25 / 0.5 / 0.75 / 1（沿运动方向拉 1.6、垂直压 0.7）
//   2.0–4.0  BEND 一拍一受击：长弯 + 两三条宽带错位（红色影子层同一个种子，一起弯），其余张不动；
//            墨线逐张抖：计分划一拍添一笔、圈字、准星
import type * as THREE from 'three';
import { Scene, type Frame } from '../../engine/scene';
import { Layer2D, W, H } from '../../engine/gl';
import { F, font } from '../../engine/type';
import { arrive, bendTear, drawing, streak, tinted, wordCanvas, TW_RATE } from '../kit/typewarp';
import { sketchLine } from '../kit/tegaki';
import { clamp, stepT, TAU } from '../../engine/util';

const DARK = '#0c0705', INK = '#f2efe8', RED = '#d4281c', OCHRE = '#c9772a';
const WORD = (px: number) => font(F.archivo(75, 900), px);
const TB = 2.0;

export default class RefTypewarp extends Scene {
  layer = new Layer2D();
  words = new Map<string, HTMLCanvasElement>();

  private word(text: string, px: number, color = INK) {
    const k = `${text}|${px}|${color}`;
    let cv = this.words.get(k);
    if (!cv) { cv = wordCanvas(text, WORD(px), color, px); this.words.set(k, cv); }
    return cv;
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    // decisions (the cut, the hits, the tally) by the drawing's time: every sub-frame of a frame sees one layout
    const { renderer, comp } = this.ctx, c = this.layer.ctx, t0 = this.ctx.start, T = stepT(f.t, TW_RATE) - t0, d = drawing(f.t);
    this.layer.clear(DARK);
    if (T < TB - 1e-6) this.shotA(c, f.t, t0, d);
    else this.shotB(c, T - TB, d);
    comp.draw(renderer, this.layer.upload(), out, { mode: 'replace' });
    return { bloom: 0.08, grain: 0.04, vignette: 0.15, ca: 0, halation: 0 };
  }

  private shotA(c: CanvasRenderingContext2D, t: number, t0: number, d: number) {
    // an ochre block the words land on
    c.fillStyle = OCHRE; c.fillRect(W * 0.56, H * 0.12, W * 0.36, H * 0.34);
    arrive(c, this.word('ARRIVE', 300), t, { t0: t0 + 0.2, hold: t0 + 0.2 + 0.8, from: [W * 0.38, H * 0.42, 0.85], to: [W * 0.74, H * 0.24, 0.42], seed: 5 });
    arrive(c, this.word('LANDS', 300), t, { t0: t0 + 1.13, from: [W * 0.34, H * 0.52, 0.8], to: [W * 0.74, H * 0.36, 0.38], seed: 9 });
    // streak at four amounts, trailing left (moving right)
    [0.25, 0.5, 0.75, 1].forEach((k, i) => {
      streak(c, this.word('STREAK', 120), W * (0.14 + i * 0.24), H * 0.82, 0.7, k, -1, 20 + i, d);
      c.font = font(F.mono(500), 18); c.fillStyle = INK; c.globalAlpha = 0.6; c.textAlign = 'center';
      c.fillText(`k ${k}`, W * (0.14 + i * 0.24), H * 0.93); c.globalAlpha = 1;
    });
  }

  private shotB(c: CanvasRenderingContext2D, T: number, d: number) {
    // a hit on every beat (0.4 s here): the hit's drawing and the next bend and tear, the rest are whole
    const since = Math.floor((T % 0.4) * TW_RATE + 1e-6), hit = since < 2, beats = Math.floor(T / 0.4);
    const cv = this.word('BEND', 420), x = W * 0.12, y = H * 0.18;
    bendTear(c, tinted(cv, RED), x + 18, y + 6, 1, 1, hit ? 36 : 0, hit ? 110 : 0, 40 + beats, d);
    bendTear(c, cv, x, y, 1, 1, hit ? 36 : 0, hit ? 110 : 0, 40 + beats, d);
    // ink doodles, boiling every drawing
    c.strokeStyle = INK;
    const n = Math.min(10, beats + 1);
    for (let i = 0; i < n; i++) {
      const g = Math.floor(i / 5), j = i % 5, gx = W * 0.62 + g * 70, by = H * 0.74;
      if (j < 4) sketchLine(c, [[gx + j * 11, by], [gx + j * 11 + 2, by + 34]], d, { seed: 220 + i, w: 2.6, jit: 1 });
      else sketchLine(c, [[gx - 8, by + 26], [gx + 44, by + 6]], d, { seed: 220 + i, w: 2.6, jit: 1 });
    }
    const ring = Array.from({ length: 24 }, (_, i): [number, number] => [W * 0.3 + Math.cos((i / 24) * TAU) * 420, H * 0.42 + Math.sin((i / 24) * TAU) * 190]);
    c.strokeStyle = RED;
    sketchLine(c, ring, d, { k: clamp((T - 0.2) / 0.8), seed: 70, closed: true, w: 3 });
    c.strokeStyle = INK;
    const cx = W * 0.82, cy = H * 0.3;
    sketchLine(c, Array.from({ length: 24 }, (_, i): [number, number] => [cx + Math.cos((i / 24) * TAU) * 34, cy + Math.sin((i / 24) * TAU) * 34]), d, { seed: 120, closed: true, w: 1.8 });
    ([[[0, -50], [0, -20]], [[0, 20], [0, 50]], [[-50, 0], [-20, 0]], [[20, 0], [50, 0]]] as [number, number][][])
      .forEach((seg, i) => sketchLine(c, seg.map(([a, b]): [number, number] => [cx + a, cy + b]), d, { seed: 121 + i, w: 1.8 }));
  }
}

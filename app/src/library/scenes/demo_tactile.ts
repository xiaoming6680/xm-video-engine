// 实物感示例（?tactile）：贴纸一张张拍到桌面上（kit/tactile.ts slap），影子随抬起高度变远、变虚、变淡；
// 最后一张被拿起来悬着，和平放的对比。用来看部件，不是画面标准。
import type * as THREE from 'three';
import { Scene, type Cue, type Frame } from '../../engine/scene';
import { Layer2D, W, H } from '../../engine/gl';
import { F, font } from '../../engine/type';
import { slap, drawLifted, liftShadow } from '../kit/tactile';
import { kf } from '../kit/anim';

const PAPER = '#efe8da', INK = '#1d1a16';
const CARDS = [
  { x: 0.24, y: 0.36, w: 300, h: 210, color: '#e4572e', label: '01', rest: -0.06 },
  { x: 0.52, y: 0.32, w: 260, h: 260, color: '#2e86ab', label: '02', rest: 0.04 },
  { x: 0.76, y: 0.40, w: 280, h: 200, color: '#f2c14e', label: '03', rest: -0.03 },
  { x: 0.36, y: 0.70, w: 340, h: 180, color: '#3b8b5a', label: '04', rest: 0.05 },
];

/** A sticker: the card's shape with a white die-cut border, painted once so the whole thing casts one shadow. */
function sticker(w: number, h: number, color: string, label: string) {
  const b = 12, cv = document.createElement('canvas');
  cv.width = w + 2 * b; cv.height = h + 2 * b;
  const c = cv.getContext('2d')!;
  c.fillStyle = '#fbfaf6';
  c.beginPath(); c.roundRect(0, 0, cv.width, cv.height, 22); c.fill();
  c.fillStyle = color;
  c.beginPath(); c.roundRect(b, b, w, h, 14); c.fill();
  c.fillStyle = INK;
  c.font = font(F.sans(800), Math.round(h * 0.42));
  c.textBaseline = 'middle';
  c.fillText(label, b + w * 0.1, b + h * 0.52);
  return cv;
}

export default class DemoTactile extends Scene {
  layer = new Layer2D();
  cards: HTMLCanvasElement[] = [];

  override init() {
    this.cards = CARDS.map((k) => sticker(k.w, k.h, k.color, k.label));
  }

  /** Card i lands 0.6 s apart from 0.8 s into the scene. */
  private land(i: number) { return this.ctx.start + 0.8 + 0.6 * i; }

  override cues(): Cue[] {
    return CARDS.map((_, i) => ({ t: this.land(i), name: `card ${i + 1} lands` }));
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const c = this.layer.ctx;
    this.layer.clear();
    c.fillStyle = PAPER;
    c.fillRect(0, 0, W, H);
    c.fillStyle = INK;
    c.font = font(F.sans(600), 28);
    c.fillText('liftShadow · slap', W * 0.05, H * 0.08);

    CARDS.forEach((k, i) => {
      const cv = this.cards[i]!;
      const p = slap(f.t, this.land(i), { rest: k.rest, rot: i % 2 ? -0.12 : 0.12, from: [0, -H * 0.05] });
      // the last card is picked up again after a beat and held, to compare with the ones lying flat
      if (i === CARDS.length - 1) {
        const up = kf(f.t, [[this.land(i) + 1.2, 0], [this.land(i) + 1.8, 0.8, 'ease']]);
        p.lift = Math.max(p.lift, up); p.scale *= 1 + 0.12 * up; p.y -= 18 * up;
      }
      drawLifted(c, p, (c) => c.drawImage(cv, -cv.width / 2, -cv.height / 2), W * k.x, H * k.y);
    });

    // legend: the shadow at lift 0, 0.5, 1
    c.font = font(F.mono(400), 18);
    [0, 0.5, 1].forEach((l, j) => {
      const [dx, dy, blur, a] = liftShadow(l);
      c.fillStyle = INK;
      c.fillText(`lift ${l}: offset ${dx.toFixed(0)},${dy.toFixed(0)}  blur ${blur.toFixed(0)}  alpha ${a.toFixed(2)}`, W * 0.62, H * (0.82 + 0.04 * j));
    });

    this.ctx.comp.draw(this.ctx.renderer, this.layer.upload(), out, { mode: 'replace' });
  }
}

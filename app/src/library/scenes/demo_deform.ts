// 操控点和碎裂示例（?deform）：effects.ts 的 puppet（engine/puppet.ts）、shatter（engine/shatter.ts）。用来看部件，不是画面标准。
//   左上  一个小人：两脚钉住，右手钉子画圈挥手，头的钉子轻轻点头，左手跟着摆（ARAP，身体不拉伸）
//   右上  一行字：每个字母底下一个钉子，钉子按正弦波上下走，字一个个弯起来
//   左下  玻璃碎裂：每 3 秒从左边一点炸开一次，碎片有厚度、翻转受光
//   右下  放射状碎裂：冲击点附近碎得细，裂纹以 700 px/s 往外传，侧面是浅灰
import type * as THREE from 'three';
import { Scene, type Frame } from '../../engine/scene';
import { Comp, type Layer } from '../../engine/layers';
import { Fx } from '../../engine/effects';
import { F, font } from '../../engine/type';

const PW = 900, PH = 470, GAP = 30;
const at = (i: number): [number, number] => [(1920 - 2 * PW - GAP) / 2 + (i % 2) * (PW + GAP) + PW / 2, 70 + Math.floor(i / 2) * (PH + GAP) + PH / 2];
const INK = '#e8e6e3', DIM = '#8a8794';

function figure(c: CanvasRenderingContext2D) {
  const limb = (x: number, y: number, w: number, h: number, col: string) => { c.fillStyle = col; c.beginPath(); c.roundRect(x, y, w, h, Math.min(w, h) / 2); c.fill(); };
  limb(410, 225, 34, 170, '#3b5bdb'); limb(456, 225, 34, 170, '#3b5bdb');           // legs
  limb(395, 110, 110, 135, '#e8590c');                                            // torso
  limb(300, 120, 110, 30, '#f2c3a0'); limb(490, 120, 110, 30, '#f2c3a0');           // arms
  c.fillStyle = '#f2c3a0'; c.beginPath(); c.arc(450, 70, 42, 0, 7); c.fill();       // head
  c.fillStyle = '#1a1820'; c.beginPath(); c.arc(436, 66, 5, 0, 7); c.arc(464, 66, 5, 0, 7); c.fill();
}

function pic(c: CanvasRenderingContext2D, _t: number, [w, h]: readonly [number, number]) {
  const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#1b2a6b'); g.addColorStop(0.6, '#d9608a'); g.addColorStop(1, '#f6b06b');
  c.fillStyle = g; c.fillRect(0, 0, w, h);
  c.strokeStyle = 'rgba(255,255,255,0.3)'; c.lineWidth = 2;
  for (let x = 0; x <= w; x += 40) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
  for (let y = 0; y <= h; y += 40) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  c.fillStyle = '#ffffff'; c.font = font(F.sans(900), 150); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('GLASS', w / 2, h / 2);
}

export default class DemoDeform extends Scene {
  fx = new Fx();
  comp = new Comp(this.ctx, { bg: '#0e0d12', fx: this.fx });

  override init() {
    const panel = (i: number, zh: string, en: string): Layer[] => {
      const [x, y] = at(i);
      return [
        { name: `bg${i}`, solid: '#1b1a22', size: [PW, PH], position: [x, y], cache: 'static', motionBlur: false },
        { name: `lb${i}`, size: [PW, 40], position: [x, y + PH / 2 + 18], cache: 'static', motionBlur: false, draw: (c) => {
          c.font = font(F.sans(700), 17); c.fillStyle = INK; c.textBaseline = 'middle'; c.fillText(zh, 0, 20);
          const w = c.measureText(zh).width; c.font = font(F.mono(400), 13); c.fillStyle = DIM; c.fillText(en, w + 12, 20);
        } },
      ];
    };
    const word = 'PUPPET', letterX = (k: number) => 150 + k * 120;
    this.comp.layers = [
      ...panel(0, '操控点 · 小人', 'puppet: feet pinned, the right hand waves'), ...panel(1, '操控点 · 字', 'puppet: one pin per letter on a travelling wave'),
      ...panel(2, '碎裂 · 玻璃', 'shatter glass, depth 8'), ...panel(3, '碎裂 · 放射', 'shatter radial, break front 700 px/s'),
      { name: 'fig', size: [PW, PH], position: at(0), draw: figure, effects: (t) => [{
        type: 'puppet', id: 'figure', mesh: 10, pins: [
          { at: [427, 385], to: [427, 385] }, { at: [473, 385], to: [473, 385] },                                   // feet
          { at: [450, 70], to: [450 + 12 * Math.sin(t * 2), 70 + 6 * Math.sin(t * 4)] },                          // head
          { at: [590, 135], to: [560 + 60 * Math.cos(t * 3), 60 + 60 * Math.sin(t * 3)] },                        // right hand
          { at: [310, 135], to: [310, 135 + 40 * Math.sin(t * 3 + 1)] },                                          // left hand
        ],
      }] },
      { name: 'word', size: [PW, PH], position: at(1), draw: (c) => {
        c.fillStyle = '#ffb347'; c.font = font(F.sans(900), 150); c.textBaseline = 'alphabetic';
        [...word].forEach((ch, k) => { c.textAlign = 'center'; c.fillText(ch, letterX(k) + 15, 300); });
      }, effects: (t) => [{ type: 'puppet', id: 'word', mesh: 8, pins: [...word].flatMap((_, k) => [
        { at: [letterX(k) + 15, 290] as [number, number], to: [letterX(k) + 15, 290 + 60 * Math.sin(t * 3 - k * 0.7)] as [number, number] },
        { at: [letterX(k) + 15, 200] as [number, number], to: [letterX(k) + 15 + 25 * Math.cos(t * 3 - k * 0.7), 200 + 60 * Math.sin(t * 3 - k * 0.7 + 0.4)] as [number, number] },
      ]) }] },
      { name: 'glass', size: [PW, PH], position: at(2), draw: pic, effects: (t) => [{ type: 'shatter', time: (t % 3) - 0.4, pattern: 'glass', pieces: 90, center: [260, 235], depth: 8, seed: 3, pad: 0 }] },
      { name: 'radial', size: [PW, PH], position: at(3), draw: pic, effects: (t) => [{ type: 'shatter', time: (t % 3) - 0.4, pattern: 'radial', pieces: 160, center: [450, 235], strength: 700, front: 700, depth: 10, sideColor: '#d8d4cc', seed: 5, pad: 0 }] },
    ];
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) { this.comp.render(f.t, out); }
}

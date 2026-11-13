// 粒子示例（?particles）：engine/particles.ts，六格。用来看部件，不是画面标准。
//   1 喷泉：点发射器朝上、重力、拉长（streak）、颜色随寿命从白到橙到暗红
//   2 火花爆发：第 0.5 / 2 / 3.5 秒各爆一批，空气阻力让它们很快停下，拖长条
//   3 雪尘：顶上一条盒子发射器往下飘，湍流让它们晃，from 为负 = 开场就是满的
//   4 字散成粒子：第 1 秒字消失，同一刻从字的像素放出 6000 颗（canvasPoints，颜色取字的颜色），往右上飘散
//   5 3D：球面发射器 + 绕着转的摄像机，近大远小、穿过画面
//   6 圆盘边上升起的环和星芒，大小和透明度随寿命变，色相随机
import type * as THREE from 'three';
import { Scene, type Frame } from '../../engine/scene';
import { Comp, type Layer } from '../../engine/layers';
import { Fx } from '../../engine/effects';
import { Particles, canvasPoints } from '../../engine/particles';
import { F, font } from '../../engine/type';

const CW = 600, CH = 460;
const cellAt = (i: number): [number, number] => [30 + (i % 3) * 630 + CW / 2, 96 + Math.floor(i / 3) * 500 + CH / 2];
const INK = '#e8e6e3', DIM = '#8a8794';

function label(zh: string, en: string): Layer {
  return { name: 'label', motionBlur: false, cache: 'static', draw: (c) => {
    c.fillStyle = 'rgba(14,13,18,0.82)'; c.fillRect(0, 0, CW, 64);
    c.font = font(F.sans(700), 22); c.fillStyle = INK; c.fillText(zh, 18, 32);
    c.font = font(F.mono(400), 14); c.fillStyle = DIM; c.fillText(en, 18, 52);
  } };
}

export default class DemoParticles extends Scene {
  fx = new Fx();
  top = new Comp(this.ctx, { bg: '#0e0d12', fx: this.fx });
  cells: Comp[] = [];
  systems: Particles[] = [];

  override init() {
    const fx = this.fx;
    const cell = (o: ConstructorParameters<typeof Comp>[1] = {}) => new Comp(this.ctx, { w: CW, h: CH, bg: '#16151c', fx, ...o });
    const ps = (o: ConstructorParameters<typeof Particles>[0]) => { const p = new Particles(o); this.systems.push(p); return p; };

    const c1 = cell();
    const fountain = ps({ emitter: { position: [CW / 2, CH - 40] }, rate: 260, from: -2, velocity: 620, velocityRandom: 0.25, direction: [0, -1, 0], spread: 16,
      gravity: 980, life: 1.5, size: 7, color: ['#ffffff', '#ffb347', '#a8201a'], shape: 'glow', streak: 0.6, seed: 1 });
    c1.layers = [{ name: 'p', three: fountain.source(c1.space), mode: 'add' }, label('喷泉 · 重力 · 拉长', 'point emitter, gravity, streak, colour over life')];

    const c2 = cell();
    const sparks = ps({ emitter: { position: [CW / 2, CH / 2 + 30] }, rate: 0, bursts: [{ t: 0.5, count: 500 }, { t: 2, count: 500 }, { t: 3.5, count: 500 }],
      velocity: 900, velocityRandom: 0.8, drag: 3, gravity: 200, life: 1.3, lifeRandom: 0.5, size: 4, shape: 'dot', streak: 1.5,
      color: ['#ffffff', '#ffd27a', '#ff4a1c'], seed: 2 });
    c2.layers = [{ name: 'p', three: sparks.source(c2.space), mode: 'add' }, label('火花爆发 · 空气阻力', 'bursts, drag, streak')];

    const c3 = cell();
    const snow = ps({ emitter: { type: 'box', position: [CW / 2, -20], size: [CW * 1.2, 10, 0] }, rate: 90, from: -8, velocity: 70, velocityRandom: 0.3,
      direction: [0, 1, 0], spread: 10, flat: true, turbulence: 70, turbulenceScale: 140, turbulenceSpeed: 0.4, life: 7, size: 5, sizeRandom: 0.6,
      shape: 'dot', feather: 0.5, opacity: 0.85, opacityOverLife: [0, 1, 1, 1, 0], color: '#dfe8ff', seed: 3, blend: 'normal' });
    c3.layers = [{ name: 'p', three: snow.source(c3.space) }, label('雪尘 · 湍流 · 预热', 'box emitter, turbulence, from < 0')];

    const c4 = cell();
    const TXT = (c: CanvasRenderingContext2D) => { c.font = font(F.sans(900), 150); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#ff5a8a'; c.fillText('粒子', CW / 2, CH / 2 + 20); c.fillStyle = '#ffd27a'; c.fillRect(CW / 2 - 150, CH / 2 + 110, 300, 14); };
    const pts = canvasPoints([CW, CH], TXT, 6000, { seed: 4 });
    const dust = ps({ emitter: { type: 'points', ...pts }, rate: 0, bursts: [{ t: 1, count: 6000 }], velocity: 60, velocityRandom: 0.9, direction: [1, -0.4, 0], spread: 50,
      turbulence: 90, turbulenceScale: 120, life: 3, lifeRandom: 0.4, size: 3, sizeRandom: 0.4, shape: 'square', feather: 0.3, opacityOverLife: [1, 1, 0], seed: 4, blend: 'normal' });
    c4.layers = [
      { name: 'text', motionBlur: false, cache: 'static', opacity: (t) => (t < 1 ? 1 : 0), draw: (c) => TXT(c) },
      { name: 'p', three: dust.source(c4.space) },
      label('字散成粒子', 'canvasPoints → points emitter, burst'),
    ];

    const c5 = cell({ camera: (t) => { const a = t * 0.5, R = 900; return { position: [CW / 2 + Math.sin(a) * R, CH / 2 - 120, Math.cos(a) * -R], pointOfInterest: [CW / 2, CH / 2, 0] }; } });
    const orb = ps({ emitter: { type: 'sphere', position: [CW / 2, CH / 2, 0], size: 170, surface: true }, rate: 500, from: -4, velocity: 25, life: 4,
      size: 7, color: ['#9fe7ff', '#4b7bff', '#3a1a7a'], shape: 'glow', seed: 5 });
    c5.layers = [{ name: 'p', three: orb.source(c5.space), mode: 'add' }, label('3D · 球面发射 · 摄像机绕转', 'sphere surface, comp camera')];

    const c6 = cell();
    const rings = ps({ emitter: { type: 'disc', position: [CW / 2, CH - 60], size: 160, surface: true, rotation: 0 }, rate: 40, from: -3, velocity: 90,
      direction: [0, -1, 0], spread: 8, flat: true, life: 3, size: 26, sizeOverLife: [0.3, 1.4], opacityOverLife: [0, 1, 0], shape: 'ring', feather: 0.15,
      color: '#7ad7ff', hueRandom: 60, spin: 0, seed: 6 });
    const stars = ps({ emitter: { type: 'disc', position: [CW / 2, CH / 2], size: 220 }, rate: 30, from: -2, velocity: 10, life: 2, size: 34,
      sizeOverLife: [0, 1, 0], opacityOverLife: [0, 1, 0], shape: 'star', spin: 40, spinRandom: 60, color: '#fff3c4', seed: 7 });
    c6.layers = [{ name: 'r', three: rings.source(c6.space), mode: 'add' }, { name: 's', three: stars.source(c6.space), mode: 'add' }, label('环 · 星芒 · 随寿命变', 'disc emitter, ring / star, size & opacity over life, hue random')];

    this.cells = [c1, c2, c3, c4, c5, c6];
    this.top.layers = [
      { name: 'title', motionBlur: false, cache: 'static', draw: (c) => {
        c.font = font(F.sans(800), 30); c.fillStyle = INK; c.fillText('粒子 Particles', 30, 58);
        c.font = font(F.mono(400), 16); c.fillStyle = DIM; c.fillText('engine/particles.ts', 270, 58);
      } },
      ...this.cells.map((comp, i): Layer => ({ name: `cell${i}`, comp, position: cellAt(i) })),
    ];
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    this.top.render(f.t, out);
  }

  override dispose() {
    for (const p of this.systems) p.dispose();
    for (const c of this.cells) c.dispose();
    this.top.dispose();
    this.fx.dispose();
  }
}

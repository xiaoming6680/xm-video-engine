// 图层示例（?layers）：engine/layers.ts 的 Comp 和 engine/effects.ts 的效果。六格各是一个嵌套的 Comp，从 0 秒开始约 6 秒做完动作。
// 用来看部件，不是画面标准。
//   1 3D 图层：三张卡片站在透视地面上，摄像机匀速后拉（景深：离焦平面远的光斑糊），中间那张 1.0–1.6 s 绕 Y 轴翻过去
//   2 父子 + 空对象：左边一组跟着空对象平滑转，右边一组的空对象 fps 12（一顿一顿）；每组一张开运动模糊、一张关、一张 smear（按速度拉糊，
//     不靠子帧；一顿一顿的那组是拉出来的「残像帧」）；底下小点 wiggle 漂
//   3 蒙版：羽化椭圆（扩展一呼一吸）减去一颗星
//   4 效果：字砸进来（fps 30 逐帧：160% 带横向拉丝 → 125% → 100% → 96% → 100%），红色硬投影；3 s 块状故障 + 色分离；4 s 发光
//   5 调整层 + 轨道遮罩：左半一块半调网点调整层从左往右扫开；右边流动条纹用字当亮度遮罩
//   6 回声 + 时间重映射：球带 6 层残影；两个同样的小钟，下面那个 2 s 冻结 1 s 再四分之一速
// 时间线另有一条效果条（library/demos.ts）：5 s 的切点前三帧换色、拉丝、冲白，切后一帧反相，一帧模糊带横向震屏。
// 缓存：地面 cache 'static'（只画一次），小钟 cache 'frame'（每帧画一次、位置照样按子帧摆），fps / 关运动模糊的层自动复用。
// 第 4 格 2.0 s 那一帧用 transform 效果把字往右撞 24 px。
import type * as THREE from 'three';
import { Scene, type Frame } from '../../engine/scene';
import { Comp, type Layer } from '../../engine/layers';
import { Fx } from '../../engine/effects';
import { K, kf, wiggle2 } from '../../engine/anim';
import { ellipsePath, starPath } from '../../engine/shape';
import { F, font } from '../../engine/type';

const CW = 600, CH = 460;
const cellAt = (i: number): [number, number] => [30 + (i % 3) * 630 + CW / 2, 96 + Math.floor(i / 3) * 500 + CH / 2];
const INK = '#e8e6e3', DIM = '#8a8794', RED = '#e4001c';

function label(zh: string, en: string): Layer {
  return {
    name: 'label', motionBlur: false, draw: (c) => {
      c.fillStyle = 'rgba(14,13,18,0.82)'; c.fillRect(0, 0, CW, 70);
      c.font = font(F.sans(700), 22); c.fillStyle = INK; c.fillText(zh, 18, 34);
      c.font = font(F.mono(400), 14); c.fillStyle = DIM; c.fillText(en, 18, 56);
    },
  };
}

function card(text: string, bg: string, fg = '#111'): Layer['draw'] {
  return (c, _t, [w, h]) => {
    c.fillStyle = bg; c.beginPath(); c.roundRect(0, 0, w, h, 10); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = 2; c.strokeRect(10, 10, w - 20, h - 20);
    c.fillStyle = fg; c.font = font(F.sans(900), h * 0.42); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, w / 2, h / 2 + 2);
  };
}

export default class DemoLayers extends Scene {
  fx = new Fx();
  top = new Comp(this.ctx, { bg: '#0e0d12', fx: this.fx });
  cells: Comp[] = [];

  override init() {
    const fx = this.fx;
    const cell = (o: ConstructorParameters<typeof Comp>[1] = {}) => new Comp(this.ctx, { w: CW, h: CH, bg: '#1a1920', fx, ...o });

    // 1 3D layers, camera pull-back, depth of field, a flip
    const c1 = cell({ camera: (t) => ({ position: [CW / 2, CH / 2 - 40, -833 - 60 * t], dof: { focus: 833 + 60 * t, radius: 28 } }) });
    c1.layers = [
      { name: 'floor', threeD: true, cache: 'static', size: [1400, 1000], position: [CW / 2, 330, 250], rotationX: 78, draw: (c, _t, [w, h]) => {
        c.fillStyle = '#25232c'; c.fillRect(0, 0, w, h);
        c.strokeStyle = '#3d3a48'; c.lineWidth = 3;
        for (let x = 0; x <= w; x += 100) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
        for (let y = 0; y <= h; y += 100) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
      } },
      { name: 'left', threeD: true, size: [170, 120], position: [150, 250, 80], rotationY: -35, draw: card('L', '#f2c9d4') },
      { name: 'mid', threeD: true, size: [170, 120], position: [CW / 2, 250, 0], rotationY: (t) => kf(t, [[1.0, 0, K.go], [1.6, 180, K.land]]), draw: card('F', '#f8efe9') },
      { name: 'right', threeD: true, size: [170, 120], position: [450, 250, 80], rotationY: 35, draw: card('R', '#c9d8f2') },
      { name: 'bokeh', threeD: true, size: [140, 140], position: [470, 120, -420], draw: (c) => {
        c.fillStyle = 'rgba(255,190,90,0.85)'; c.beginPath(); c.arc(70, 70, 60, 0, 7); c.fill();
      } },
      label('3D 图层 · 摄像机后拉 · 景深', 'threeD, camera, dof, rotationY'),
    ];

    // 2 parenting, nulls, posterize time on the parent, the motion blur switch, wiggle
    const spin = (t: number) => kf(t, [[0.4, 0, K.easy], [3.4, 360, K.easy]]);
    const c2 = cell();
    const child = (parent: string, x: number, mb: boolean, col: string): Layer =>
      ({ parent, position: [x, 0], size: [104, 64], motionBlur: mb, draw: card(mb ? 'MB' : 'off', col) });
    c2.layers = [
      { name: 'rigA', position: [160, 235], rotation: spin },
      { name: 'rigB', position: [440, 235], rotation: spin, fps: 12 },
      child('rigA', 95, true, '#f2c9d4'), child('rigA', -95, false, '#f8efe9'),
      child('rigB', 95, true, '#f2c9d4'), child('rigB', -95, false, '#f8efe9'),
      ...(['rigA', 'rigB'] as const).map((parent): Layer => ({ parent, position: [0, 95], size: [104, 64], smear: 1.5, draw: card('SM', '#c9d8f2') })),
      { name: 'dot', size: [24, 24], position: (t) => { const w = wiggle2(t, 1.2, 40, 3); return [300 + w.x, 390 + w.y * 0.5]; }, draw: (c) => { c.fillStyle = RED; c.beginPath(); c.arc(12, 12, 10, 0, 7); c.fill(); } },
      { name: 'cap', motionBlur: false, draw: (c) => { c.font = font(F.mono(400), 14); c.fillStyle = DIM; c.textAlign = 'center'; c.fillText('30 fps', 160, 445); c.fillText('parent fps 12', 440, 445); } },
      label('父子 · 空对象 · fps · 运动模糊开关', 'parent, null, fps, motionBlur, wiggle'),
    ];

    // 3 masks
    const c3 = cell();
    c3.layers = [
      { name: 'art', draw: (c, t, [w, h]) => {
        const g = c.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#f2c9d4'); g.addColorStop(0.5, '#e4001c'); g.addColorStop(1, '#2b1d4a');
        c.fillStyle = g; c.fillRect(0, 0, w, h);
        c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 6;
        for (let x = -h; x < w; x += 28) { c.beginPath(); c.moveTo(x + (t * 40) % 28, 0); c.lineTo(x + h + (t * 40) % 28, h); c.stroke(); }
      }, masks: [
        { path: ellipsePath(CW / 2, 250, 200, 150), feather: 50, expansion: (t) => 30 * Math.sin(t * 2) },
        { path: starPath(CW / 2, 250, 95, 42, 5, { rot: -Math.PI / 2 }), mode: 'subtract', feather: 3 },
      ] },
      label('蒙版 · 羽化 · 扩展 · 相减', 'masks: feather, expansion, subtract'),
    ];

    // 4 effects: a per-frame slam with a hard shadow, then glitch, then glow
    const T0 = 0.8;
    const fr = (t: number) => Math.round((t - T0) * 30);
    const c4 = cell();
    c4.layers = [
      { name: 'hit', fps: 30, size: [520, 260], position: [CW / 2, 250],
        opacity: (t) => (fr(t) < 0 ? 0 : 1),
        scale: (t) => [1.6, 1.25, 1.0, 0.96][fr(t)] ?? 1,
        draw: (c, _t, [w, h]) => { c.fillStyle = '#fff'; c.font = font(F.sans(900), 210); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('HIT', w / 2, h / 2 + 8); },
        effects: (t) => {
          const k = fr(t);
          return [
            { type: 'dropShadow', offset: [12, 12], color: RED },
            k === 0 && { type: 'directionalBlur', angle: 0, length: 140 },
            t > 3 && t < 3.4 && { type: 'blockGlitch', amount: 60, block: [0, 18], density: 0.35, seed: k, rgb: 8 },
            t > 3 && t < 3.4 && { type: 'rgbSplit', offset: [6, 0] },
            t > 4 && { type: 'glow', threshold: 0.5, radius: 18, intensity: Math.min(1.5, (t - 4) * 2), color: '#ff5a7a' },
            k === 36 && { type: 'transform', position: [24, 0] },
          ];
        } },
      label('效果 · 逐帧砸入 · 硬投影 · 故障 · 发光', 'effects: dropShadow, directionalBlur, blockGlitch, glow'),
    ];

    // 5 adjustment layer with a mask, luma track matte
    const c5 = cell();
    c5.layers = [
      { name: 'photo', draw: (c, t, [w, h]) => {
        c.fillStyle = '#d9d2cf'; c.fillRect(0, 0, w, h);
        for (let i = 0; i < 6; i++) {
          const g = c.createRadialGradient(80 + i * 90, 240 + 60 * Math.sin(i * 1.7 + t), 0, 80 + i * 90, 240 + 60 * Math.sin(i * 1.7 + t), 110);
          g.addColorStop(0, i % 2 ? '#1c1a24' : '#7a2236'); g.addColorStop(1, 'rgba(0,0,0,0)');
          c.fillStyle = g; c.fillRect(0, 0, w, h);
        }
      } },
      { name: 'tone', adjustment: true, effects: [{ type: 'halftone', size: 9, angle: 45, ink: '#7a0020', paper: '#f8efe9' }],
        masks: [{ path: (t) => `M0 70 H${Math.max(1, Math.min(300, (t - 0.5) * 220))} V${CH} H0 Z` }] },
      { name: 'flow', position: [450, 260], size: [280, 300], matte: { layer: 'word', mode: 'luma' }, draw: (c, t, [w, h]) => {
        for (let y = -40; y < h + 40; y += 20) { c.fillStyle = (Math.floor(y / 20) % 2) ? '#e4001c' : '#ffd36b'; c.fillRect(0, y + (t * 60) % 40, w, 20); }
      } },
      { name: 'word', motionBlur: false, draw: (c) => { c.fillStyle = '#fff'; c.font = font(F.sans(900), 120); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('MA', 450, 210); c.fillText('TTE', 450, 320); } },
      label('调整层 · 蒙版限定 · 亮度遮罩', 'adjustment, masks, matte: luma'),
    ];

    // 6 echo, time remap of a nested comp
    const clock = new Comp(this.ctx, { w: 160, h: 160, fx });
    clock.layers = [{ name: 'face', draw: (c, t) => {
      c.fillStyle = '#f8efe9'; c.beginPath(); c.arc(80, 80, 72, 0, 7); c.fill();
      c.strokeStyle = '#111'; c.lineWidth = 6; c.lineCap = 'round';
      const a = t * Math.PI; c.beginPath(); c.moveTo(80, 80); c.lineTo(80 + 56 * Math.sin(a), 80 - 56 * Math.cos(a)); c.stroke();
      c.fillStyle = '#111'; c.font = font(F.mono(500), 16); c.textAlign = 'center'; c.fillText(t.toFixed(2), 80, 128);
    } }];
    const c6 = cell();
    c6.layers = [
      { name: 'ball', size: [56, 56], echo: { count: 6, delay: 0.035, decay: 0.62 },
        position: (t) => [70 + 220 * (0.5 - 0.5 * Math.cos(t * 1.3)), 410 - 290 * Math.abs(Math.sin(t * 2.6))],
        draw: (c) => { c.fillStyle = RED; c.beginPath(); c.arc(28, 28, 26, 0, 7); c.fill(); } },
      { name: 'clockA', comp: clock, position: [450, 150], cache: 'frame' },
      { name: 'clockB', comp: clock, position: [450, 340], cache: 'frame', time: (t) => (t < 2 ? t : t < 3 ? 2 : 2 + (t - 3) * 0.25) },
      { name: 'cap', motionBlur: false, draw: (c) => { c.font = font(F.mono(400), 14); c.fillStyle = DIM; c.textAlign = 'left'; c.fillText('1x', 540, 155); c.fillText('remap', 532, 345); } },
      label('回声 · 时间重映射（嵌套 Comp）', 'echo, time remap, nested comp'),
    ];

    this.cells = [c1, c2, c3, c4, c5, c6];
    this.top.layers = [
      { name: 'title', motionBlur: false, draw: (c) => {
        c.font = font(F.sans(800), 30); c.fillStyle = INK; c.fillText('图层 Comp · 效果栈', 30, 58);
        c.font = font(F.mono(400), 16); c.fillStyle = DIM; c.fillText('engine/layers.ts  engine/effects.ts', 330, 58);
      } },
      ...this.cells.map((comp, i): Layer => ({ name: `cell${i}`, comp, position: cellAt(i) })),
    ];
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    this.top.render(f.t, out);
  }

  override dispose() {
    for (const c of this.cells) c.dispose();
    this.top.dispose();
    this.fx.dispose();
  }
}

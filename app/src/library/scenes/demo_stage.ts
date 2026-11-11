// 2.5D 舞台示例（?stage）：AE 式的 3D 图层摆进空间、视频图层贴在面上、摄像机推着走带视差。用来看部件，不是画面标准。
//   - 地面：一张平躺的 3D 图层（红条纹）；三扇窗是嵌套合成（标题栏 + 视频素材）当 3D 图层，左右两扇朝里斜，底边陷进地面 30 px：
//     地面按像素挡住陷进去的那截（3D 图层互挡，engine/layers.ts）
//   - 左前方两张交叉的卡片：互相穿过去，交线两边各露各的
//   - 右上的电视：faceCamera 始终正对摄像机；屏幕是画歪的四边形，视频用 cornerPin 钉在四个角上，跟着电视走（父子）
//   - 远处的大字放在 z = 1800，scale = comp.depthScale(1800)：和放在 z = 0 时一样大，摄像机动时视差更小
//   - 前景一朵虚焦的花（离摄像机很近，摄像机 dof 糊掉；depthWrite: false 不挡别人）
//   - 中间那扇窗是折叠变换（collapse）：窗里的视频在窗面后 160 px、深色背板 170 px，窗框在面上，红色圆标在窗面前 140 px、伸出窗框；
//     摄像机横移时窗里有视差，圆标伸到窗外也不被裁
// 视频是 tools/footage.py --test demo 抽的测试片，没有就画占位卡。?stage=flat 关掉逐像素互挡和折叠（intersect: false、collapse: false），
// 对比旧的整层排序和拍平的嵌套合成。
import type * as THREE from 'three';
import { Scene, type Frame } from '../../engine/scene';
import { Comp, type Layer } from '../../engine/layers';
import { loadFootage, type Plate } from '../../engine/plate';
import { F, font } from '../../engine/type';

/** ?stage=flat: the old whole-layer sorting (intersect: false) and flat nested comps (no collapse), to compare. */
const FLAT = typeof location !== 'undefined' && new URLSearchParams(location.search).get('stage') === 'flat';
const CREAM = '#efe7dc', RED = '#d7193a', INK = '#1d1a20';
const FLOOR_Y = 820;

export default class DemoStage extends Scene {
  comp = new Comp(this.ctx, {
    bg: CREAM,
    intersect: !FLAT,
    camera: (t) => ({
      position: [960 + 300 * Math.sin(t * 0.4), 420, -2500 + 70 * t],
      pointOfInterest: [960, 600, 400],
      dof: { focus: 2900 - 70 * t, radius: 26 },
    }),
  });
  clip: Plate | null = null;

  override async init() {
    try { this.clip = await loadFootage(this.ctx.renderer, '/assets/footage/demo', { outside: 'loop' }); } catch (e) { console.warn(String(e)); }
    const video = (w: number, h: number, start: number): Layer => this.clip
      ? { name: 'video', footage: this.clip, start: -start, scale: Math.max(w / this.clip.width, h / this.clip.height), position: [w / 2, h / 2] }
      : { name: 'video', size: [w, h], draw: (c) => { c.fillStyle = '#3a3440'; c.fillRect(0, 0, w, h); c.font = font(F.mono(500), 26); c.fillStyle = '#fff'; c.fillText('python tools/footage.py --test demo', 20, h / 2); } };

    // a window: title bar + footage, as a nested comp
    const chrome = (g: CanvasRenderingContext2D) => {
      g.fillStyle = RED; g.fillRect(0, 0, 720, 46);
      g.fillStyle = '#fbf6ef'; for (let i = 0; i < 3; i++) { g.beginPath(); g.arc(670 - i * 34, 23, 9, 0, Math.PI * 2); g.fill(); }
      g.strokeStyle = RED; g.lineWidth = 8; g.strokeRect(4, 4, 712, 512);
      g.fillStyle = '#fbf6ef'; g.fillRect(0, 46, 18, 474); g.fillRect(702, 46, 18, 474); g.fillRect(0, 502, 720, 18);
    };
    const win = (start: number) => {
      const c = new Comp(this.ctx, { w: 720, h: 520, bg: '#fbf6ef' });
      c.layers = [{ ...video(684, 450, start), name: 'well', position: [360, 290] }, { name: 'chrome', draw: chrome }];
      return c;
    };
    // the collapsed one: a box with depth — the video set back, the frame on the plane, a badge sticking out in front
    const deepWin = (start: number) => {
      const c = new Comp(this.ctx, { w: 720, h: 520 });
      c.layers = [
        { name: 'back', threeD: true, size: [780, 520], position: [360, 290, 170], solid: '#2b2530' },
        { ...video(684, 450, start), name: 'deep', threeD: true, position: [360, 290, 160] },
        { name: 'chrome', draw: chrome },
        { name: 'badge', threeD: true, size: [260, 260], position: [650, 70, -140], rotation: 12, draw: (g, _t, [w]) => {
          g.fillStyle = RED; g.beginPath(); g.arc(w / 2, w / 2, w / 2 - 4, 0, Math.PI * 2); g.fill();
          g.fillStyle = CREAM; g.font = font(F.sans(800), 54); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('POP', w / 2, w / 2 + 4);
        } },
      ];
      return c;
    };

    const tvW = 600, tvH = 460;
    const screenQuad = [[78, 64], [498, 92], [486, 352], [88, 384]] as const;
    const S = this.comp;
    this.comp.layers = [
      // far: giant letters, kept at their z = 0 size
      { name: 'giant', threeD: true, size: [2400, 700], position: [960, 380, 1800], scale: S.depthScale(1800), cache: 'static', draw: (c, _t, [w, h]) => {
        c.font = font(F.serif(600), h * 0.95); c.fillStyle = 'rgba(215,25,58,0.16)'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText('STAGE', w / 2, h / 2 + 30);
      } },
      { name: 'floor', threeD: true, size: [3600, 2600], position: [960, FLOOR_Y, 700], rotationX: 90, cache: 'static', draw: (c, _t, [w, h]) => {
        c.fillStyle = '#f6efe6'; c.fillRect(0, 0, w, h);
        c.fillStyle = RED; for (let y = 300; y < h; y += 120) c.fillRect(300, y, w - 600, 46);
      } },
      ...[[380, 520, 28, 0], [960, 320, 0, 1.3], [1540, 520, -28, 2.6]].map(([x, z, ry, st], i): Layer => ({
        name: `win${i}`, threeD: true, comp: i === 1 ? deepWin(st!) : win(st!), collapse: i === 1 && !FLAT,
        anchor: [360, 520], position: [x!, FLOOR_Y + 30, z!], rotationY: ry!, rotationX: -4,
      })),
      // two cards crossing each other
      { name: 'crossA', threeD: true, size: [420, 300], position: [300, 640, -120], rotationY: 38, draw: (c, _t, [w, h]) => { c.fillStyle = INK; c.fillRect(0, 0, w, h); c.fillStyle = CREAM; c.font = font(F.sans(800), 64); c.fillText('A', 30, 90); } },
      { name: 'crossB', threeD: true, size: [420, 300], position: [300, 640, -120], rotationY: -38, draw: (c, _t, [w, h]) => { c.fillStyle = RED; c.fillRect(0, 0, w, h); c.fillStyle = CREAM; c.font = font(F.sans(800), 64); c.fillText('B', w - 80, 90); } },
      // a TV that always faces the camera; the video pinned into its crooked screen
      { name: 'tv', threeD: true, faceCamera: true, size: [tvW, tvH], position: (t) => [1560, 330 + (Math.floor(t * 2) % 2 ? 0 : 6), 900], draw: (c) => {
        c.fillStyle = '#f4c9cf'; c.beginPath(); c.roundRect(10, 10, tvW - 20, tvH - 20, 36); c.fill();
        c.strokeStyle = RED; c.lineWidth = 8; c.stroke();
        c.fillStyle = INK; c.beginPath(); screenQuad.forEach(([x, y], k) => (k ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.fill();
        c.fillStyle = RED; c.beginPath(); c.arc(540, 200, 16, 0, Math.PI * 2); c.arc(540, 260, 16, 0, Math.PI * 2); c.fill();
      } },
      { ...video(1280, 720, 0.7), name: 'tvVideo', parent: 'tv', cornerPin: screenQuad.map((p) => [...p]), position: undefined, scale: undefined },
      // a defocused flower right in front of the camera
      { name: 'flower', threeD: true, depthWrite: false, size: [700, 700], position: [560, 360, -1350], cache: 'static', draw: (c, _t, [w]) => {
        c.fillStyle = RED;
        for (let k = 0; k < 7; k++) { const a = (k / 7) * Math.PI * 2; c.beginPath(); c.ellipse(w / 2 + Math.cos(a) * 150, w / 2 + Math.sin(a) * 150, 170, 95, a, 0, Math.PI * 2); c.fill(); }
        c.fillStyle = '#7a0a1e'; c.beginPath(); c.arc(w / 2, w / 2, 110, 0, Math.PI * 2); c.fill();
      } },
      { name: 'hud', motionBlur: false, draw: (c, t) => {
        c.fillStyle = 'rgba(29,26,32,0.85)'; c.fillRect(0, 0, 1040, 84);
        c.font = font(F.sans(700), 24); c.fillStyle = '#fff'; c.fillText('?stage  2.5D：3D 图层逐像素互挡 · 四角钉 · 朝向摄像机 · depthScale · 视频图层', 20, 36);
        c.font = font(F.mono(400), 16); c.fillStyle = '#c9c2cf'; c.fillText(`t ${t.toFixed(2)}s   ${this.clip ? '' : '没有素材'}`, 20, 66);
      } },
    ];
  }

  override prepare(t: number, t0: number, t1: number) { return this.comp.prepare(t, t0, t1); }

  render(f: Frame, out: THREE.WebGLRenderTarget) { this.comp.render(f.t, out); }

  override dispose() { this.comp.dispose(); this.clip?.dispose(); }
}

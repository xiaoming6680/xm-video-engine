// 3D 摄像机反求示例（?camtrack）：tools/camtrack.py 反求的摄像机当合成摄像机（engine/track.ts 的 camera），实拍（这里是合成的纹理房间）
// 铺满画面，3D 图层、粒子贴进它的空间：一张牌子立在地上、一面小旗插在反求出的一个点上、地上冒火花。镜头动，它们应该跟画面粘在一起。
// 先在引擎根目录准备素材和反求（素材不进 git）：
//   python tools/camtrack.py --test camtest
//   python tools/camtrack.py assets/footage/camtest --comp 1920x1080 --ground 0,250,640,360 --at 1
import type * as THREE from 'three';
import { Scene, type Frame } from '../../engine/scene';
import { Comp, type Layer } from '../../engine/layers';
import { Fx } from '../../engine/effects';
import { loadFootage, type Plate } from '../../engine/plate';
import { loadTrack, type Track } from '../../engine/track';
import { Particles } from '../../engine/particles';
import { F, font } from '../../engine/type';
import { W, H } from '../../engine/gl';

export default class DemoCamtrack extends Scene {
  fx = new Fx();
  comp = new Comp(this.ctx, { bg: '#0e0d12', fx: this.fx });
  clip: Plate | null = null;
  cam: Track | null = null;
  sparks: Particles | null = null;

  override async init() {
    const r = this.ctx.renderer;
    try {
      this.clip = await loadFootage(r, '/assets/footage/camtest', { outside: 'hold' });
      this.cam = await loadTrack('/assets/footage/camtest/track_camera.json');
    } catch {
      this.comp.layers = [{ name: 'msg', draw: (c) => {
        c.font = font(F.sans(700), 30); c.fillStyle = '#e8e6e3'; c.textAlign = 'center';
        c.fillText('先跑 python tools/camtrack.py --test camtest，再反求（见 demo_camtrack.ts 开头）', W / 2, H / 2);
      } }];
      return;
    }
    const cam = this.cam, gy = cam.groundY ?? H / 2 + 200;
    // a spot on the floor in front of the first camera: the solved points near the ground, the one nearest the middle
    const floor = cam.points.filter((p) => Math.abs(p[1] - gy) < 6).sort((a, b) => Math.abs(a[0] - W / 2) + Math.abs(a[2] - 900) - (Math.abs(b[0] - W / 2) + Math.abs(b[2] - 900)));
    const spot = floor[0] ?? [W / 2, gy, 900];
    const pole = cam.points.filter((p) => p[2] > 1500 && p[2] < 3000)[0] ?? [W / 2 + 300, gy - 300, 2000];
    this.comp.o.camera = (t) => cam.camera(t);
    this.sparks = new Particles({ emitter: { position: [spot[0] + 260, gy, spot[2] + 150] }, rate: 120, from: -2, velocity: 520, direction: [0, -1, 0], spread: 18,
      gravity: 900, life: 1.2, size: 5, color: ['#fff3c4', '#ff7a2a', '#7a1020'], streak: 0.6, seed: 2 });
    const scale = W / (this.clip.width || 640);
    this.comp.layers = [
      { name: 'plate', footage: this.clip, scale, position: [W / 2, H / 2], motionBlur: false },
      // a sign standing on the floor (its bottom edge at the ground's height)
      { name: 'sign', threeD: true, size: [360, 240], anchor: [180, 240], position: [spot[0], gy, spot[2]], rotationY: -20, draw: (c, _t, [w, h]) => {
        c.fillStyle = '#ffd43b'; c.beginPath(); c.roundRect(0, 0, w, h - 40, 16); c.fill();
        c.fillStyle = '#1a1820'; c.fillRect(w / 2 - 8, h - 40, 16, 40);
        c.font = font(F.sans(900), 84); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('TRACK', w / 2, (h - 40) / 2);
      } },
      // a flag on a solved point
      { name: 'flag', threeD: true, faceCamera: true, size: [160, 220], anchor: [6, 220], position: [pole[0], pole[1], pole[2]], draw: (c) => {
        c.fillStyle = '#e8e6e3'; c.fillRect(0, 0, 12, 220);
        c.fillStyle = '#ff2d6f'; c.beginPath(); c.moveTo(12, 6); c.lineTo(160, 46); c.lineTo(12, 86); c.fill();
      } },
      { name: 'sparks', three: this.sparks.source(this.comp.space), mode: 'add' },
      { name: 'label', motionBlur: false, cache: 'static', draw: (c) => {
        c.fillStyle = 'rgba(14,13,18,0.75)'; c.fillRect(0, 0, W, 64);
        c.font = font(F.sans(800), 26); c.fillStyle = '#e8e6e3'; c.fillText('3D 摄像机反求', 30, 42);
        c.font = font(F.mono(400), 15); c.fillStyle = '#b8b5c0'; c.fillText(`tools/camtrack.py → track.camera(t)  ·  ${cam.points.length} 点  ·  视角 ${(cam.data as { fov?: number }).fov ?? '?'}°  ·  重投影 ${(cam.data as { rms?: number }).rms ?? '?'} px`, 250, 42);
      } },
    ];
  }

  override prepare(t: number, t0: number, t1: number) { return this.comp.prepare(t, t0, t1); }
  render(f: Frame, out: THREE.WebGLRenderTarget) { this.comp.render(f.t, out); }
}

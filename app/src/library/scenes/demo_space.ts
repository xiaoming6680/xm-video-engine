// 一台摄像机示例（?space）：合成的 3D 图层、three.js 场景、导入的 GLB、视频素材在同一个空间里，用同一台摄像机。
// 用来看部件，不是画面标准。
//   - three 图层：地面、六根柱子、示例模型 public/models/demo_totem.glb（tools/blender/demo_model.py 导出，Draco 压缩，
//     两段动画 Sway / Spin 按时间摆）、阴影
//   - 3D 图层（engine/layers.ts）：一行大字立在模型后面，贴地的一圈刻度环，一块放视频素材的屏幕（tools/footage.py --test demo
//     抽的测试片，循环），都按米摆（comp.space.point），被柱子和模型挡住；右边一张小牌 depthTest: false，不被挡
//   - 摄像机：按米写的 CamPath（world.ts），合成用 space.camera 换过来，three 图层自动跟着
//   - 2D 图层：左上说明；橙色圈 = 用合成摄像机的算法（space.ts projectComp）投出的模型环心，应当套住 three 渲出来的环
import * as THREE from 'three';
import { Scene, type Frame } from '../../engine/scene';
import { Comp, type Layer } from '../../engine/layers';
import { Space, projectComp } from '../../engine/space';
import { CamPath, canvasTex, roomEnvironment, setupRenderer } from '../../engine/world';
import { loadModel, type Model } from '../../engine/model';
import { loadFootage, type Plate } from '../../engine/plate';
import { F, font } from '../../engine/type';
import { W, H } from '../../engine/gl';

const BG = '#121018', INK = '#efe9df', ORANGE = '#ff7a40';

export default class DemoSpace extends Scene {
  S = new Space(W, H, { ppm: 100 });
  path = new CamPath([
    { t: 0, p: [-6.5, 1.3, 9.0], at: [0, 1.6, -1], fov: 38 },
    { t: 3, p: [-1.6, 0.7, 6.4], at: [0, 1.8, -1], fov: 40 },
    { t: 6, p: [3.9, 1.9, 6.0], at: [0, 1.5, -2], fov: 36 },
    { t: 9, p: [5.6, 3.3, 2.4], at: [-1, 1.2, -3], fov: 34 },
  ]);
  comp = new Comp(this.ctx, { bg: BG, space: this.S, camera: (t) => this.S.camera(this.path.at(t)) });
  world = new THREE.Scene();
  model: Model | null = null;
  clip: Plate | null = null;
  ringAt = new THREE.Vector3(0, 3, 0);

  override async init() {
    const r = this.ctx.renderer, S = this.S;
    setupRenderer(r);
    const w = this.world;
    w.fog = new THREE.Fog(new THREE.Color(BG), 14, 40);
    w.environment = roomEnvironment(r);
    w.environmentIntensity = 0.25;
    w.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a1410, 0.5));
    const sun = new THREE.DirectionalLight(0xffe2c4, 2.4);
    sun.position.set(4, 8, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 0.5, far: 30 });
    sun.shadow.bias = -0.0005;
    w.add(sun);

    const grid = canvasTex(512, 512, (c, cw, ch) => {
      c.fillStyle = '#26232c'; c.fillRect(0, 0, cw, ch);
      c.strokeStyle = '#3a3644'; c.lineWidth = 3;
      c.strokeRect(0, 0, cw, ch);
    }, { repeat: [30, 30] });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ map: grid, roughness: 0.9 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    w.add(ground);
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x8c8696, roughness: 0.55, metalness: 0.1 });
    for (const [x, z] of [[-2.3, 1.6], [2.5, 0.9], [-1.0, -3.4], [3.4, -3.6], [-4.1, -1.4], [0.9, 3.4]] as const) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.5, 4, 0.5), pillarMat);
      p.position.set(x, 2, z);
      p.castShadow = p.receiveShadow = true;
      w.add(p);
    }
    try {
      this.model = (await loadModel('/models/demo_totem.glb')).fit({ height: 3.4 }).shadows();
      w.add(this.model.root);
    } catch (e) { console.warn(String(e)); }
    try {
      this.clip = await loadFootage(r, '/assets/footage/demo', { outside: 'loop' });
    } catch (e) { console.warn(String(e)); }

    const word = (c: CanvasRenderingContext2D, _t: number, [cw, ch]: readonly [number, number]) => {
      c.font = font(F.serif(600), ch * 0.9); c.fillStyle = INK; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('ONE CAMERA', cw / 2, ch / 2 + ch * 0.06);
    };
    const ring = (c: CanvasRenderingContext2D, _t: number, [cw]: readonly [number, number]) => {
      const R = cw / 2;
      c.strokeStyle = ORANGE; c.lineWidth = 6;
      c.beginPath(); c.arc(R, R, R - 10, 0, Math.PI * 2); c.stroke();
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * Math.PI * 2, l = i % 6 === 0 ? 46 : 20;
        c.lineWidth = i % 6 === 0 ? 6 : 3;
        c.beginPath(); c.moveTo(R + Math.cos(a) * (R - 14), R + Math.sin(a) * (R - 14)); c.lineTo(R + Math.cos(a) * (R - 14 - l), R + Math.sin(a) * (R - 14 - l)); c.stroke();
      }
    };
    const screen: Layer = this.clip
      ? { name: 'screen', threeD: true, footage: this.clip, position: S.point([-2.7, 1.7, -5.8]), scale: S.px(3.6) / this.clip.width, rotationY: -12 }
      : { name: 'screen', threeD: true, size: [1280, 720], position: S.point([-2.7, 1.7, -5.8]), scale: S.px(3.6) / 1280, rotationY: -12, draw: (c, _t, [cw, ch]) => {
        c.fillStyle = '#2b2733'; c.fillRect(0, 0, cw, ch);
        c.font = font(F.mono(500), 44); c.fillStyle = INK; c.textAlign = 'center';
        c.fillText('no footage: python tools/footage.py --test demo', cw / 2, ch / 2);
      } };

    this.comp.layers = [
      { name: 'world', three: { scene: w, update: (t) => this.pose(t) } },
      { name: 'ring', threeD: true, size: [600, 600], position: S.point([0, 0.01, 0]), rotationX: 90, rotation: (t) => t * 12, draw: ring, cache: 'static' },
      { name: 'word', threeD: true, size: [1800, 300], position: S.point([0, 1.15, -2.2]), scale: S.px(7.2) / 1800, draw: word, cache: 'static' },
      screen,
      { name: 'tag', threeD: true, depthTest: false, size: [520, 120], position: S.point([4.2, 2.6, -4.6]), scale: S.px(2.0) / 520, cache: 'static', draw: (c, _t, [cw, ch]) => {
        c.fillStyle = ORANGE; c.fillRect(0, 0, cw, ch);
        c.font = font(F.mono(600), 52); c.fillStyle = '#1a1410'; c.textBaseline = 'middle'; c.fillText('depthTest: false', 24, ch / 2);
      } },
      { name: 'hud', motionBlur: false, draw: (c, t) => this.hud(c, t) },
    ];
  }

  /** Pose the model for time t and remember where its ring is (world m). */
  private pose(t: number) {
    const m = this.model;
    if (!m) return;
    m.pose([{ clip: 'Sway', t }, { clip: 'Spin', t }]);
    m.find('Ring')?.getWorldPosition(this.ringAt);
  }

  private hud(c: CanvasRenderingContext2D, t: number) {
    c.fillStyle = 'rgba(14,13,18,0.8)'; c.fillRect(0, 0, 900, 92);
    c.font = font(F.sans(700), 26); c.fillStyle = INK; c.fillText('?space  3D 图层 + three.js + GLB + 视频素材，同一台摄像机', 22, 40);
    c.font = font(F.mono(400), 17); c.fillStyle = '#a7a2b0';
    c.fillText(`t ${t.toFixed(2)}s   橙圈 = 合成摄像机投出的模型环心   ${this.model ? '' : '没有模型 '}${this.clip ? '' : '没有素材'}`, 22, 72);
    // where the comp camera puts the ring's centre: it should sit on the ring three rendered
    const p = projectComp(this.S.camera(this.path.at(t)), W, H, this.S.point(this.ringAt));
    if (p) {
      c.strokeStyle = ORANGE; c.lineWidth = 2.5;
      c.beginPath(); c.arc(p.x, p.y, 16, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.moveTo(p.x - 26, p.y); c.lineTo(p.x - 8, p.y); c.moveTo(p.x + 8, p.y); c.lineTo(p.x + 26, p.y); c.stroke();
    }
  }

  override prepare(t: number, t0: number, t1: number) { return this.comp.prepare(t, t0, t1); }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    this.comp.render(f.t, out);
  }

  override dispose() { this.comp.dispose(); this.clip?.dispose(); }
}

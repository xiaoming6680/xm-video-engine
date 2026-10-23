// 3D 示例场景：three.js 场景渲染进引擎的 HDR 目标（world.ts setupRenderer）、相机路径（CamPath，时间参数化、速度连续）、
// 景深（kit3d.ts GBuf + DofPass）、软阴影（softSun）、跟着底鼓动的物体。导出多采样时网格边缘自动抗锯齿（gl.ts jitterRenders）。用来确认 3D 管线能跑，新项目可以删掉。
import * as THREE from 'three';
import { Scene, type Frame } from '../engine/scene';
import { W, H } from '../engine/gl';
import { CamPath, setCam, setupRenderer, softSun } from '../engine/world';
import { GBuf, DofPass } from '../engine/kit3d';
import { HEX, LIN } from '../engine/palette';
import { mulberry32 } from '../engine/util';

const N = 7; // N x N columns
const GAP = 2.0;
const MID = (N * N - 1) / 2;

export default class Demo3D extends Scene {
  scene = new THREE.Scene();
  cam = new THREE.PerspectiveCamera(40, W / H, 0.1, 200);
  g = new GBuf();
  dof = new DofPass();
  cols!: THREE.InstancedMesh;
  phase: number[] = [];
  path!: CamPath;
  sun = new THREE.DirectionalLight(0xffffff, 2.2);
  m = new THREE.Matrix4();

  override init() {
    setupRenderer(this.ctx.renderer);
    const [r, g, b] = LIN.ink;
    this.scene.background = new THREE.Color(r, g, b);
    this.scene.fog = new THREE.Fog(this.scene.background as THREE.Color, 18, 60);
    const sun = this.sun;
    sun.position.set(-8, 14, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 50 });
    this.scene.add(sun, new THREE.HemisphereLight(0xdfe4ec, 0x1a1a1e, 0.8));

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x2a2a2f, roughness: 0.9 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // the columns: white, the middle one in the signal colour
    this.cols = new THREE.InstancedMesh(new THREE.BoxGeometry(0.8, 1, 0.8), new THREE.MeshStandardMaterial({ roughness: 0.55 }), N * N);
    this.cols.castShadow = this.cols.receiveShadow = true;
    const white = new THREE.Color(0xe8e8ec), signal = new THREE.Color(HEX.signal);
    const rnd = mulberry32(7);
    for (let i = 0; i < N * N; i++) {
      this.phase.push(rnd());
      this.cols.setColorAt(i, i === MID ? signal : white);
    }
    this.scene.add(this.cols);

    // the camera: from high and wide down to a low three-quarter view over the entry
    const { start, end } = this.ctx;
    this.path = new CamPath([
      { t: start, p: [14, 10, 16], at: [0, 1, 0], fov: 36 },
      { t: end, p: [-9, 4.5, 11], at: [0, 1.6, 0], fov: 30 },
    ]);
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    // heights: a slow wave across the grid, plus every kick running outward from the middle
    for (let i = 0; i < N * N; i++) {
      const x = ((i % N) - (N - 1) / 2) * GAP, z = (Math.floor(i / N) - (N - 1) / 2) * GAP;
      const d = Math.hypot(x, z);
      const h = 0.4 + 1.4 * (0.5 + 0.5 * Math.sin(f.t * 1.3 - d * 0.5 + this.phase[i]! * 2)) + 2.2 * f.a.kick * Math.exp(-d * 0.3) + (i === MID ? 1.5 : 0);
      this.m.makeScale(1, h, 1).setPosition(x, h / 2, z);
      this.cols.setMatrixAt(i, this.m);
    }
    this.cols.instanceMatrix.needsUpdate = true;

    softSun(this.sun, 0.04);
    setCam(this.cam, this.path.at(f.t));
    this.g.render(this.ctx.renderer, this.scene, this.cam, this.scene.background as THREE.Color);
    this.dof.focus = this.cam.position.distanceTo(new THREE.Vector3(0, 1, 0));
    this.dof.aperture = 30;
    this.dof.render(this.ctx.renderer, this.g.color, this.g.rt.depthTexture!, this.cam, out);
  }
}

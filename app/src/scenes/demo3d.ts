// 3D 示例场景：低多边形地形（terrain.ts）+ 体素字（voxel.ts）+ 相机路径（world.ts CamPath）+ 景深（kit3d.ts）。
// 用来确认 3D 模块能跑，新项目可以删掉。镜头每个强拍推近一点，景深焦点跟着字走。
import * as THREE from 'three';
import { Scene, type Frame } from '../engine/scene';
import { W, H } from '../engine/gl';
import { lowPolyTerrain } from '../engine/terrain';
import { VoxelGrid, buildVoxels, textCells } from '../engine/voxel';
import { CamPath, setCam, setupRenderer } from '../engine/world';
import { GBuf, DofPass } from '../engine/kit3d';
import { LIN } from '../engine/palette';
import { F, font } from '../engine/type';

const hgt = (x: number, z: number) => 1.6 * Math.sin(x * 0.18) * Math.cos(z * 0.15) + 0.8 * Math.sin(x * 0.05 + z * 0.07);

export default class Demo3D extends Scene {
  scene = new THREE.Scene();
  cam = new THREE.PerspectiveCamera(40, W / H, 0.1, 400);
  g = new GBuf();
  dof = new DofPass();
  path!: CamPath;

  override init() {
    setupRenderer(this.ctx.renderer);
    const [r, g, b] = LIN.ink;
    this.scene.background = new THREE.Color(r * 2, g * 2, b * 2.6);
    this.scene.fog = new THREE.Fog(this.scene.background as THREE.Color, 30, 120);
    const sun = new THREE.DirectionalLight(0xfff1e0, 2.6);
    sun.position.set(-20, 30, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 120 });
    this.scene.add(sun, new THREE.HemisphereLight(0x8ea2c8, 0x2a2018, 0.9));

    const geo = lowPolyTerrain({ x0: -80, z0: -80, x1: 80, z1: 40, res: 64, h: hgt,
      color: (_x, y, _z, slope) => new THREE.Color().setHSL(0.08, 0.25, 0.18 + 0.05 * y + 0.1 * (1 - slope)) });
    const terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 }));
    terrain.receiveShadow = true;
    this.scene.add(terrain);

    // voxel letters standing on the ground at the origin
    const cells = textCells('XM', font(F.archivo(100, 900), 32), 32);
    const size = 0.12, depth = 8;
    const umax = Math.max(...cells.map((c) => c.u)) + 1;
    const grid = VoxelGrid.cover(size, [-umax * size / 2, hgt(0, 0), -1], [umax * size / 2, hgt(0, 0) + 12, -1 + depth * size]);
    for (const c of cells) for (let k = 0; k < depth; k++) grid.set(c.u, c.v, k, 1);
    const vox = buildVoxels(grid, [{ hex: 0 }, { hex: 0xff4d12 }], null, { castShadow: true });
    this.scene.add(vox);

    // the camera: a slow push from wide to medium over the entry, the focus on the letters
    const { start, end } = this.ctx;
    this.path = new CamPath([
      { t: start, p: [-14, 6, 26], at: [0, hgt(0, 0) + 3, 0], fov: 40 },
      { t: end, p: [6, 4, 13], at: [0, hgt(0, 0) + 3, 0], fov: 34 },
    ]);
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const pose = this.path.at(f.t);
    // a small push-in on every kick (decays): the camera answers the drums
    pose.fov -= 1.2 * f.a.kick;
    setCam(this.cam, pose);
    this.g.render(this.ctx.renderer, this.scene, this.cam, this.scene.background as THREE.Color);
    this.dof.focus = this.cam.position.distanceTo(new THREE.Vector3(0, hgt(0, 0) + 3, 0));
    this.dof.aperture = 30;
    this.dof.render(this.ctx.renderer, this.g.color, this.g.rt.depthTexture!, this.cam, out);
    return { bloom: 0.6, vignette: 0.3 };
  }
}

// 一台摄像机（合成 ⇄ three.js ⇄ Blender）：合成（engine/layers.ts 的 Comp）按 AE 的规矩用像素、y 向下、z 往屏幕里，
// three.js 和 Blender 的 cam.json 用米、y 向上、相机朝自己的 −z 看。Space 在两边换算，所以 3D 图层、three 场景、
// Blender 序列帧可以摆在同一个空间里、用同一台摄像机：
//
//   comp = new Comp(this.ctx, { space: { ppm: 100 } });              // 1 米 = 100 合成像素；世界原点在合成中心、z = 0（origin 可改）
//   const S = comp.space;
//   path = new CamPath([{ t: 0, p: [0, 1.6, 8], at: [0, 1, 0] }, …]);  // 摄像机照旧按米写（world.ts 的 CamPath / ShotRig）
//   comp.o.camera = (t) => S.camera(path.at(t));                      // 合成的摄像机 = 这条路径（也可以 S.camera(threeCam)）
//   { name: 'title', threeD: true, position: S.point([0, 2.4, -3]), scale: S.px(0.004), draw: … }   // 字立在世界里 (0, 2.4, −3) 米
//   { name: 'world', three: { scene } }                               // three 场景当图层：自动用这台摄像机渲（layers.ts）
//   S.toThree(cam, threeCam)                                          // 反过来：合成的摄像机 → three 相机（自己渲 three 时）
//   plate.applyCamera(threeCam, t); comp.o.camera = S.camera(threeCam) // Blender 的 cam.json → three → 合成
//
// 换算：世界点 = diag(1, −1, −1) · (合成点 − origin) / ppm（绕 x 轴转 180° 再缩放，左右手不变）。
// 合成的 zoom（AE 的「缩放」，焦距的像素数）和 three 的竖直视角：zoom = (h / 2) / tan(fov / 2)；宽高比 = 合成的 w / h。
// 合成摄像机的朝向可以是 pointOfInterest、rotation [rx, ry, rz]（AE 的方向角）或 quaternion（合成空间的四元数，S.camera 给的就是这个）。
import * as THREE from 'three';
import type { CamPose } from './world';

type Vec = readonly number[];
export type V3 = [number, number, number];

/** The comp camera (engine/layers.ts Camera): AE units, see there. */
export interface Camera {
  zoom?: number;
  position?: Vec;
  pointOfInterest?: Vec;
  /** AE orientation [x, y, z] in degrees. */
  rotation?: Vec;
  /** Orientation as a quaternion [x, y, z, w] in comp space (camera axes: right, down, forward); wins over the others. */
  quaternion?: Vec;
  dof?: { focus?: number; radius: number };
}

export interface SpaceOpts {
  /** Comp px per metre (default 100). */
  ppm?: number;
  /** The comp point (px) that is the world origin (default the comp's centre at z = 0). */
  origin?: Vec;
}

const DEG = Math.PI / 180;

/** AE's default zoom for a comp w px wide (a 50 mm lens): 2666.67 px at 1920. */
export const defaultZoom = (w: number) => (2666.67 * w) / 1920;

/**
 * Where a comp camera is and how it is turned, in comp px: position P, rotation R (columns = the camera's right, down and
 * forward axes) and zoom. Comp's projection: X = Rᵀ(p − P), screen = (zoom·X/Z + w/2, zoom·Y/Z + h/2).
 */
export function cameraPose(cam: Camera, w: number, h: number): { P: THREE.Vector3; R: THREE.Matrix4; zoom: number } {
  const zoom = cam.zoom ?? defaultZoom(w);
  const pos = cam.position ?? [w / 2, h / 2, -zoom];
  const P = new THREE.Vector3(pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? -zoom);
  const R = new THREE.Matrix4();
  if (cam.quaternion) {
    const q = cam.quaternion;
    R.makeRotationFromQuaternion(new THREE.Quaternion(q[0] ?? 0, q[1] ?? 0, q[2] ?? 0, q[3] ?? 1).normalize());
  } else if (cam.pointOfInterest) {
    const poi = new THREE.Vector3(cam.pointOfInterest[0] ?? 0, cam.pointOfInterest[1] ?? 0, cam.pointOfInterest[2] ?? 0);
    const z = poi.sub(P).normalize();
    const x = new THREE.Vector3(0, 1, 0).cross(z);
    if (x.lengthSq() < 1e-9) x.set(1, 0, 0); else x.normalize();
    const y = z.clone().cross(x);
    R.makeBasis(x, y, z);
  } else if (cam.rotation) {
    const [rx, ry, rz] = cam.rotation;
    R.makeRotationX(-(rx ?? 0) * DEG).multiply(new THREE.Matrix4().makeRotationY(-(ry ?? 0) * DEG)).multiply(new THREE.Matrix4().makeRotationZ((rz ?? 0) * DEG));
  }
  return { P, R, zoom };
}

/** Comp point (px) → screen px through a comp camera, and its depth Z along the view axis (px); null behind the camera. */
export function projectComp(cam: Camera, w: number, h: number, p: Vec): { x: number; y: number; z: number } | null {
  const { P, R, zoom } = cameraPose(cam, w, h);
  const X = new THREE.Vector3(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0).sub(P).applyMatrix4(R.clone().transpose());
  if (X.z <= 1e-6) return null;
  return { x: (zoom * X.x) / X.z + w / 2, y: (zoom * X.y) / X.z + h / 2, z: X.z };
}

/** Comp quaternion ⇄ three quaternion: conjugating by the 180° turn about x flips the y and z parts (both ways). */
const flipQ = (q: { x: number; y: number; z: number; w: number }) => new THREE.Quaternion(q.x, -q.y, -q.z, q.w);

export class Space {
  readonly ppm: number;
  readonly origin: V3;
  constructor(readonly w: number, readonly h: number, o: SpaceOpts = {}) {
    this.ppm = o.ppm ?? 100;
    this.origin = [o.origin?.[0] ?? w / 2, o.origin?.[1] ?? h / 2, o.origin?.[2] ?? 0];
  }

  /** Metres → comp px (a size, a distance, a 3D layer's scale for an object n m tall: px(n) / its height in px). */
  px(m: number) { return m * this.ppm; }

  /** World point (m, y up) → comp point (px, y down): a 3D layer's position. */
  point(p: Vec | THREE.Vector3): V3 {
    const [x, y, z] = p instanceof THREE.Vector3 ? [p.x, p.y, p.z] : [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
    return [x * this.ppm + this.origin[0], -y * this.ppm + this.origin[1], -z * this.ppm + this.origin[2]];
  }

  /** Comp point (px) → world point (m). */
  toWorld(p: Vec): THREE.Vector3 {
    return new THREE.Vector3(((p[0] ?? 0) - this.origin[0]) / this.ppm, -((p[1] ?? 0) - this.origin[1]) / this.ppm, -((p[2] ?? 0) - this.origin[2]) / this.ppm);
  }

  /**
   * A three camera (its world position and orientation, effective vertical fov) or a CamPath / ShotRig pose
   * ({ p, at, roll, fov }, as world.ts setCam points a camera) → the comp camera. `dof` is passed through (comp px).
   */
  camera(src: THREE.PerspectiveCamera | CamPose, dof?: Camera['dof']): Camera {
    let cam: THREE.PerspectiveCamera;
    if ((src as THREE.PerspectiveCamera).isPerspectiveCamera) cam = src as THREE.PerspectiveCamera;
    else {
      const pose = src as CamPose;
      cam = scratch;
      cam.position.copy(pose.p);
      cam.up.set(0, 1, 0);
      cam.lookAt(pose.at);
      if (pose.roll) cam.rotateZ(-pose.roll);
      cam.fov = pose.fov; cam.zoom = 1;
      cam.updateMatrixWorld(true);
    }
    cam.updateMatrixWorld(true);
    const p = cam.getWorldPosition(new THREE.Vector3()), q = flipQ(cam.getWorldQuaternion(new THREE.Quaternion()));
    const zoom = this.h / 2 / Math.tan((cam.getEffectiveFOV() * DEG) / 2);
    return { zoom, position: this.point(p), quaternion: [q.x, q.y, q.z, q.w], ...(dof ? { dof } : {}) };
  }

  /**
   * Put a three camera where the comp camera is (position, orientation, vertical fov, aspect w / h; near / far in metres
   * when given). Returns the camera (matrices updated).
   */
  toThree(cam: Camera, out: THREE.PerspectiveCamera = new THREE.PerspectiveCamera(), near?: number, far?: number): THREE.PerspectiveCamera {
    const { P, R, zoom } = cameraPose(cam, this.w, this.h);
    out.position.copy(this.toWorld([P.x, P.y, P.z]));
    out.quaternion.copy(flipQ(new THREE.Quaternion().setFromRotationMatrix(R)));
    out.up.set(0, 1, 0);
    const fov = (2 * Math.atan(this.h / 2 / zoom)) / DEG, aspect = this.w / this.h;
    if (out.fov !== fov || out.aspect !== aspect || out.zoom !== 1 || (near !== undefined && out.near !== near) || (far !== undefined && out.far !== far)) {
      out.fov = fov; out.aspect = aspect; out.zoom = 1;
      if (near !== undefined) out.near = near;
      if (far !== undefined) out.far = far;
      out.updateProjectionMatrix();
    }
    out.updateMatrixWorld(true);
    return out;
  }
}

const scratch = new THREE.PerspectiveCamera();

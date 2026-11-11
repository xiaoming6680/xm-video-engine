// 一台摄像机（engine/space.ts）的换算测试：合成像素 ⇄ 米、three 相机 ⇄ 合成摄像机，投到画面上的位置两边一致：bun test tests/space.test.ts
import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { Space, cameraPose, projectComp } from '../src/engine/space';
import { setCam } from '../src/engine/world';
import { clipTime } from '../src/engine/model';

const W = 1920, H = 1080;
const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);
let seed = 7;
const rnd = (a = -1, b = 1) => { seed = (seed * 16807) % 2147483647; return a + ((seed / 2147483647) * (b - a)); };

/** Screen px of a world point through a three camera (y down, like the comp). */
function threeScreen(cam: THREE.PerspectiveCamera, p: THREE.Vector3) {
  const v = p.clone().project(cam);
  return { x: (v.x * 0.5 + 0.5) * W, y: (1 - (v.y * 0.5 + 0.5)) * H, z: v.z };
}

function randomCam() {
  const cam = new THREE.PerspectiveCamera(rnd(20, 70), W / H, 0.1, 500);
  setCam(cam, { p: new THREE.Vector3(rnd(-8, 8), rnd(0.2, 6), rnd(-8, 8)), at: new THREE.Vector3(rnd(-2, 2), rnd(0, 3), rnd(-2, 2)), roll: rnd(-0.6, 0.6), fov: cam.fov });
  return cam;
}

test('point / toWorld round trip and axes', () => {
  const S = new Space(W, H, { ppm: 100 });
  expect(S.point([0, 0, 0])).toEqual([960, 540, 0]);
  expect(S.point([1, 2, 3])).toEqual([1060, 340, -300]);   // y up → y down, +z (towards the viewer) → −z
  const w = S.toWorld(S.point([0.3, -1.7, 4.2]));
  near(w.x, 0.3); near(w.y, -1.7); near(w.z, 4.2);
  const T = new Space(W, H, { ppm: 50, origin: [100, 200, 300] });
  expect(T.point([0, 0, 0])).toEqual([100, 200, 300]);
  near(T.px(2), 100);
});

test('a three camera and its comp camera put every point at the same screen px', () => {
  const S = new Space(W, H, { ppm: 87 });
  for (let k = 0; k < 40; k++) {
    const cam = randomCam(), cc = S.camera(cam);
    for (let i = 0; i < 10; i++) {
      const p = new THREE.Vector3(rnd(-5, 5), rnd(0, 4), rnd(-5, 5));
      const a = threeScreen(cam, p), b = projectComp(cc, W, H, S.point(p));
      if (a.z > 1 || a.z < -1) { expect(b === null || b.z < 0.1 * S.ppm || b.z > 500 * S.ppm).toBe(true); continue; }
      expect(b).not.toBeNull();
      near(a.x, b!.x, 1e-6 * W * 50); near(a.y, b!.y, 1e-6 * H * 50);
      // depth along the view axis: the comp's Z is the camera-space distance in px
      const ze = p.clone().applyMatrix4(cam.matrixWorldInverse).z;
      near(-ze * S.ppm, b!.z, 1e-6 * Math.abs(b!.z) + 1e-6);
    }
  }
});

test('toThree inverts camera(): same position, orientation and fov', () => {
  const S = new Space(W, H, { ppm: 100 });
  for (let k = 0; k < 20; k++) {
    const cam = randomCam(), back = S.toThree(S.camera(cam));
    near(back.position.distanceTo(cam.position), 0, 1e-9);
    expect(Math.abs(back.quaternion.dot(cam.quaternion))).toBeGreaterThan(1 - 1e-9);
    near(back.fov, cam.fov, 1e-9);
    near(back.aspect, W / H, 1e-12);
  }
});

test('AE-style comp cameras (point of interest, orientation) project the same through toThree', () => {
  const S = new Space(W, H, { ppm: 100 });
  const cams = [
    {},
    { zoom: 1800, position: [700, 300, -1600], pointOfInterest: [1000, 600, 200] },
    { zoom: 3000, position: [1200, 800, -2200], rotation: [12, -25, 8] },
  ];
  for (const cc of cams) {
    const cam = S.toThree(cc);
    for (let i = 0; i < 20; i++) {
      const px = [rnd(0, W), rnd(0, H), rnd(-600, 900)];
      const a = projectComp(cc, W, H, px), b = threeScreen(cam, S.toWorld(px));
      if (!a) continue;
      near(a.x, b.x, 1e-6 * W * 50); near(a.y, b.y, 1e-6 * H * 50);
    }
  }
});

test('a CamPath pose converts like setCam points a camera', () => {
  const S = new Space(W, H);
  const pose = { p: new THREE.Vector3(3, 2, 7), at: new THREE.Vector3(-1, 1, 0), roll: 0.3, fov: 42 };
  const cam = new THREE.PerspectiveCamera(42, W / H, 0.1, 100);
  setCam(cam, pose);
  const a = S.camera(pose), b = S.camera(cam);
  for (let i = 0; i < 3; i++) near(a.position![i]!, b.position![i]!, 1e-9);
  for (let i = 0; i < 4; i++) near(Math.abs(a.quaternion![i]!), Math.abs(b.quaternion![i]!), 1e-9);
  near(a.zoom!, b.zoom!, 1e-9);
  // the default comp camera looks straight into the screen from −zoom
  const d = cameraPose({}, W, H);
  near(d.P.z, -d.zoom); expect(d.R.equals(new THREE.Matrix4())).toBe(true);
});

test('clipTime: repeat, once, pingpong', () => {
  near(clipTime(2.5, 2), 0.5);
  near(clipTime(-0.5, 2), 1.5);
  near(clipTime(5, 2, 'once'), 2 - 1e-6);
  near(clipTime(-1, 2, 'once'), 0);
  near(clipTime(2.5, 2, 'pingpong'), 1.5);
  near(clipTime(4.5, 2, 'pingpong'), 0.5);
  expect(clipTime(3, 0)).toBe(0);
});

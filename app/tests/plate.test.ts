// 序列帧（kit/plate.ts）的纯函数测试：帧号模板、时间 → 帧号、铺满方式和相机换算、相机 JSON：bun test tests/plate.test.ts
import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { fitCamera, fitScale, frameUrl, parseCameras, plateFrame, plateIndex, plateNumber } from '../src/library/kit/plate';

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

test('frameUrl: # runs and printf patterns', () => {
  expect(frameUrl('/refs/shot/####.png', 7)).toBe('/refs/shot/0007.png');
  expect(frameUrl('/refs/shot/f_#.exr', 123)).toBe('/refs/shot/f_123.exr');
  expect(frameUrl('/refs/shot/img.%04d.jpg', 42)).toBe('/refs/shot/img.0042.jpg');
  expect(frameUrl('/refs/shot/%d.png', 42)).toBe('/refs/shot/42.png');
  expect(frameUrl('/refs/shot/##.png', 1234)).toBe('/refs/shot/1234.png'); // wider than the run: not cut
  expect(() => frameUrl('/refs/shot/still.png', 1)).toThrow();
});

test('plateFrame: a frame holds from its own time until the next one', () => {
  const o = { fps: 30, first: 1, last: 90 };
  expect(plateFrame(0, o)).toBe(1);
  expect(plateFrame(1 / 30 - 1e-4, o)).toBe(1);
  // exactly on a frame boundary, as the export computes it (n * (1/60)): no float slip back to the previous frame
  for (let n = 0; n < 180; n++) expect(plateFrame(n * (1 / 60), o)).toBe(Math.min(90, 1 + Math.floor(n / 2)));
  // 24 fps sequence at 60 fps output: 2-3 pulldown
  const p = { fps: 24, first: 0, last: 1000 };
  expect([0, 1, 2, 3, 4, 5].map((n) => plateFrame(n / 60, p))).toEqual([0, 0, 0, 1, 1, 2]);
});

test('plateFrame: start time, speed, outside', () => {
  const o = { fps: 30, first: 10, last: 19, at: 2 };
  expect(plateFrame(2, o)).toBe(10);
  expect(plateFrame(1.5, o)).toBe(10); // hold the first before the start
  expect(plateFrame(9, o)).toBe(19); // hold the last after the end
  expect(plateFrame(1.99, { ...o, outside: 'none' })).toBeNull();
  expect(plateFrame(2 + 10 / 30, { ...o, outside: 'none' })).toBeNull();
  expect(plateFrame(2 + 10 / 30, { ...o, outside: 'loop' })).toBe(10);
  expect(plateFrame(2 - 1 / 30, { ...o, outside: 'loop' })).toBe(19); // loops backwards too
  expect(plateFrame(2 + 4 / 30, { ...o, speed: 0.5 })).toBe(12);
  expect(plateIndex(2 + 4 / 30, o)).toBe(4);
  expect(plateNumber(3, { fps: 30, first: 5, last: 4 })).toBeNull(); // empty sequence
});

test('fitScale: cover crops, contain letterboxes, stretch fills', () => {
  expect(fitScale(16 / 9, 16 / 9)).toEqual([1, 1]);
  const [cx, cy] = fitScale(2.39, 16 / 9, 'cover');
  near(cx, 2.39 / (16 / 9)); near(cy, 1);
  const [kx, ky] = fitScale(2.39, 16 / 9, 'contain');
  near(kx, 1); near(ky, 16 / 9 / 2.39);
  const [tx, ty] = fitScale(1, 16 / 9, 'cover'); // a square plate: full width, top and bottom cropped
  near(tx, 1); near(ty, 16 / 9);
  expect(fitScale(1, 16 / 9, 'stretch')).toEqual([1, 1]);
});

test('fitCamera: the view through the frame matches the plate as fitted', () => {
  const fa = 16 / 9;
  // same aspect: unchanged
  const same = fitCamera(40, fa, [1, 1]);
  near(same.fov, 40); near(same.aspect, fa);
  // a wider plate covered: full height shows, the sides are cropped → same vertical fov, the frame's aspect
  const cover = fitCamera(40, 2.39, fitScale(2.39, fa, 'cover'));
  near(cover.fov, 40); near(cover.aspect, fa);
  // letterboxed: the plate fills only part of the height → the frame sees more vertically
  const s = fitScale(2.39, fa, 'contain'), box = fitCamera(40, 2.39, s);
  near(Math.tan((box.fov * Math.PI) / 360) * s[1], Math.tan((40 * Math.PI) / 360)); near(box.aspect, fa);
  // stretched: the camera takes the plate's aspect
  near(fitCamera(40, 2.39, [1, 1]).aspect, 2.39);
});

test('parseCameras: frame numbers, defaults, Blender axes', () => {
  const m = parseCameras({ fov: 35, frames: [{ p: [1, 2, 3], q: [0, 0, 0, 1] }, { f: 9, p: [0, 0, 0], at: [0, 0, -1], fov: 50 }] }, 1);
  expect(m.get(1)!.p).toEqual([1, 2, 3]);
  expect(m.get(1)!.fov).toBe(35);
  expect(m.get(9)!.fov).toBe(50);
  expect(m.has(2)).toBe(false);
  // Blender: a camera with no rotation looks down −Z (at the floor); in three's Y-up world that is −Y. Positions (x, y, z) → (x, z, −y).
  const b = parseCameras({ axes: 'blender', first: 0, frames: [{ p: [1, 2, 3], q: [0, 0, 0, 1], points: { ball: [4, 5, 6] } }] }).get(0)!;
  expect(b.p).toEqual([1, 3, -2]);
  expect(b.points!.ball).toEqual([4, 6, -5]);
  const look = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(...b.q!));
  near(look.x, 0); near(look.y, -1); near(look.z, 0);
  // Blender camera turned 90° about X looks along Blender +Y (horizontal, "front" view's depth axis) → three −Z
  const h = Math.SQRT1_2;
  const f = parseCameras({ axes: 'blender', frames: [{ p: [0, 0, 0], q: [h, 0, 0, h] }] }).get(1)!;
  const v = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(...f.q!));
  near(v.x, 0); near(v.y, 0); near(v.z, -1);
});

test('parseCameras: tools/blender/render.py cam.json projects points where Blender does', () => {
  // q and fov as render.py writes them (lib.cam_quat: to_track_quat('-Z', 'Y') plus roll; lib.vfov with sensor_fit
  // HORIZONTAL); uv = Blender's world_to_camera_view of the point (0.3, 0.1, 0.6) at 1920x1080, y flipped to top-down
  const cases = [
    { p: [-2.7, -11.2, 2.55], q: [0.634673, -0.082183, -0.098675, 0.762037], fov: 25.917896, uv: [0.50236, 0.463914] },
    { p: [1.0, -3.0, 0.5], q: [0.769955, 0.035233, 0.154989, 0.617986], fov: 22.895193, uv: [0.551837, 0.919415] }, // (roll 0.2)
  ];
  const m = parseCameras({ fps: 60, first: 300, axes: 'blender', frames: cases.map((c, i) => ({ f: 300 + i, p: c.p, q: c.q, fov: c.fov, points: { x: [0.3, 0.1, 0.6] } })) });
  cases.forEach((c, i) => {
    const r = m.get(300 + i)!;
    const cam = new THREE.PerspectiveCamera(r.fov, 16 / 9, 0.05, 200);
    cam.position.set(...r.p);
    cam.quaternion.set(...r.q!);
    cam.updateMatrixWorld(true);
    const v = new THREE.Vector3(...r.points!.x!).project(cam);
    near(v.x * 0.5 + 0.5, c.uv[0]!, 2e-5);
    near(0.5 - v.y * 0.5, c.uv[1]!, 2e-5);
  });
});

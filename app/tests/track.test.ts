// 跟踪数据贴到图层（engine/track.ts）：按帧停住 / 插值、四角、稳定的图层变换：bun test tests/track.test.ts
import { expect, test } from 'bun:test';
import { Track } from '../src/engine/track';

const near = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

const pts = new Track({ type: 'point', fps: 10, first: 1, size: [100, 100], frames: 3, points: { p0: [[0, 0, 1], [10, 20, 0.9], [20, 40, 0.1]] } });

test('a point holds per frame like the footage, smooth interpolates, both clamp at the ends', () => {
  expect(pts.point('p0', 0.15)).toEqual([10, 20]);
  expect(pts.point('p0', 0.1999)).toEqual([10, 20]);
  expect(pts.point('p0', -1)).toEqual([0, 0]);
  expect(pts.point('p0', 9)).toEqual([20, 40]);
  const sm = new Track(pts.data, { smooth: true });
  const p = sm.point('p0', 0.15); near(p[0], 15, 1e-9); near(p[1], 30, 1e-9);
  near(pts.confidence('p0', 0.25), 0.1);
  expect(() => pts.point('nope', 0)).toThrow();
});

test('planar corners per frame; the stabilized layer transform puts the frame centre where the correction says', () => {
  const pl = new Track({ type: 'planar', fps: 10, first: 1, size: [100, 100], frames: 2, corners: [[[0, 0], [10, 0], [10, 10], [0, 10]], [[1, 1], [11, 1], [11, 11], [1, 11]]], conf: [1, 0.9] });
  expect(pl.corners(0.1)[2]).toEqual([11, 11]);
  const st = new Track({ type: 'stabilize', fps: 10, first: 1, size: [200, 100], frames: 2, xform: [[0, 0, 0, 1], [4, -2, 1.5, 1.02]], center: [100, 50] });
  const L = st.stabilized((t) => t, { zoom: 1.1 });
  expect(L.anchor).toEqual([100, 50]);
  const p = L.position(0.1); near(p[0], 100 + 4 * 1.1); near(p[1], 50 - 2 * 1.1);
  near(L.rotation(0.1), 1.5); near(L.scale(0.1), 1.02 * 1.1);
});

test('a solved camera: held per frame, a missing frame borrows the nearest, smooth blends the short way round', () => {
  const s = Math.SQRT1_2;
  const cam = new Track({ type: 'camera', fps: 10, first: 1, size: [100, 100], frames: 3, zoom: 500,
    cameras: [[0, 0, -500, 0, 0, 0, 1], null, [10, 0, -500, 0, s, 0, s]] });
  const c0 = cam.camera(0.05);
  expect(c0.position).toEqual([0, 0, -500]); expect(c0.zoom).toBe(500);
  // frame 1 has no solve: the nearest solved frame (0 before 2 at equal distance)
  expect(cam.camera(0.15).position).toEqual([0, 0, -500]);
  const sm = new Track(cam.data, { smooth: true });
  // between frame 1 (→ frame 0's) and frame 2, halfway: position halfway, quaternion normalised
  const h = sm.camera(0.15);
  near(h.position![0]!, 5, 1e-9);
  near(Math.hypot(...(h.quaternion as number[])), 1, 1e-9);
  // the other sign of the same rotation blends the short way (no flip through 180°)
  const neg = new Track({ ...cam.data, cameras: [[0, 0, -500, 0, 0, 0, 1], [0, 0, -500, 0, 0, 0, -1], [0, 0, -500, 0, 0, 0, -1]] }, { smooth: true });
  const q = neg.camera(0.05).quaternion as number[];
  near(Math.abs(q[3]!), 1, 1e-9);
});

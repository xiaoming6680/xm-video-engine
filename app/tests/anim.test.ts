// 关键帧层、变形 / 路径、SVG 路径解析、角色绑定的纯函数测试：bun test tests/anim.test.ts
import { expect, test } from 'bun:test';
import { kf, kfv, kfc, kfLoop, bezier, E, spring } from '../src/library/kit/anim';
import { flatten, resample, Morph, PathWalk, circle, rect, area, ribbon, smoothPath, bounds } from '../src/library/kit/morph';
import { parsePathD } from '../src/library/kit/svg';
import { runPose, POSES, joints, blendPose } from '../src/library/kit/rig';

const near = (a: number, b: number, eps = 1e-3) => expect(Math.abs(a - b)).toBeLessThan(eps);

test('kf hits its keys and holds outside', () => {
  const k = [[0, 0], [1, 10], [2, 0]] as const;
  near(kf(-1, k), 0); near(kf(0, k), 0); near(kf(1, k), 10); near(kf(2, k), 0); near(kf(5, k), 0);
});

test("kf 'auto' keeps speed through a key, 'ease' stops there", () => {
  const h = 1e-3;
  const auto = [[0, 0, 'auto'], [1, 10, 'auto'], [2, 20, 'auto']] as const;
  const v = (k: any, t: number) => (kf(t + h, k) - kf(t - h, k)) / (2 * h);
  near(v(auto, 1), 10, 0.05); // passes through the middle key at full speed
  const ease = [[0, 0], [1, 10, 'ease'], [2, 20]] as const;
  near(v(ease, 1), 0, 0.05); // comes to rest on it
  // speed is continuous across the key either way
  near(v(auto, 1 - 0.01), v(auto, 1 + 0.01), 0.5);
});

test("kf 'hold' jumps, 'lin' is linear", () => {
  const k = [[0, 0, 'hold'], [1, 5, 'lin'], [2, 15]] as const;
  near(kf(0.99, k), 0); near(kf(1.0, k), 5); near(kf(1.5, k), 10);
});

test('kfv and kfc', () => {
  const v = kfv(0.5, [[0, [0, 100]], [1, [10, 200]]]);
  near(v[0]!, 5, 1e-6); near(v[1]!, 150, 1e-6);
  expect(kfc(0, [[0, '#ff0000'], [1, '#0000ff']])).toBe('rgb(255,0,0)');
  expect(kfc(1, [[0, '#ff0000'], [1, '#0000ff']])).toBe('rgb(0,0,255)');
});

test('kfLoop wraps smoothly', () => {
  const k = [[0, 0], [0.25, 1], [0.5, 0], [0.75, -1]] as const;
  near(kfLoop(0, k), 0); near(kfLoop(1, k), 0); near(kfLoop(0.25, k), 1);
  near(kfLoop(0.999, k), kfLoop(-0.001, k), 1e-6);
});

test('bezier easing and spring', () => {
  const f = bezier(0.42, 0, 0.58, 1);
  near(f(0), 0); near(f(1), 1); near(f(0.5), 0.5, 1e-3);
  expect(E.out(0.2)).toBeGreaterThan(0.5); // fast start
  near(spring(0, 0, 0, 1), 0); near(spring(5, 0, 0, 1), 1, 1e-3);
});

test('flatten + resample + morph', () => {
  const sq = flatten([{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 10, y: 0 }, { type: 'L', x: 10, y: 10 }, { type: 'L', x: 0, y: 10 }, { type: 'Z' }]);
  expect(sq.length).toBe(1);
  near(Math.abs(area(sq[0]!)), 100);
  const r = resample(sq[0]!, 40);
  expect(r.length).toBe(40);
  const m = new Morph([circle(0, 0, 50, 64)], [rect(-10, -10, 20, 20), rect(30, 30, 5, 5)], 80);
  expect(m.at(0).length).toBe(2);
  near(Math.abs(area(m.at(0)[0]!)), Math.PI * 2500, 120); // still the circle
  near(Math.abs(area(m.at(1)[0]!)), 400, 2);               // the big square
  near(Math.abs(area(m.at(0)[1]!)), 0, 1e-6);              // the extra one grows from a point
});

test('PathWalk positions and slices', () => {
  const w = new PathWalk([[{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 0, y: 5 }, { x: 0, y: 15 }]]);
  near(w.total, 20);
  const p = w.at(15);
  near(p.x, 0); near(p.y, 10); expect(p.stroke).toBe(1);
  const s = w.slice(5, 12);
  expect(s.length).toBe(2);
  near(s[0]![0]!.x, 5); near(s[1]![s[1]!.length - 1]!.y, 7);
});

test('ribbon and smoothPath', () => {
  const rb = ribbon([{ x: 0, y: 0 }, { x: 100, y: 0 }], 10, 2);
  const b = bounds(rb);
  near(b.h, 10, 1e-6);
  const sp = smoothPath([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }], 8);
  expect(sp.length).toBe(17);
  near(sp[8]!.x, 10); near(sp[8]!.y, 10);
});

test('parsePathD: relative, shorthand and arcs', () => {
  const c = parsePathD('m10 10 h20 v20 h-20 z');
  expect(c.map((x) => x.type).join('')).toBe('MLLLZ');
  const s = flatten(parsePathD('M0 0 C10 0 10 10 0 10 S-10 20 0 20'), 1);
  expect(s[0]!.length).toBeGreaterThan(10);
  const a = flatten(parsePathD('M-50 0 A50 50 0 1 0 50 0 A50 50 0 1 0 -50 0 Z'), 1);
  near(Math.abs(area(a[0]!)), Math.PI * 2500, 60);
  const packed = parsePathD('M0 0a10 10 0 0110 10'); // packed arc flags
  expect(packed.length).toBeGreaterThan(1);
});

test('rig: run cycle loops, contact poses land the foot', () => {
  const a = runPose(0), b = runPose(1);
  for (const k of Object.keys(a) as (keyof typeof a)[]) near(a[k], b[k], 1e-6);
  const j = joints(runPose(0), 100);
  expect(j.footA.x).toBeGreaterThan(0);       // front foot ahead of the hip on contact
  expect(j.head.y).toBeLessThan(j.hip.y);      // head above the hip
  const mid = blendPose(POSES.crouch, POSES.launch, 0.5);
  near(mid.lean, (POSES.crouch.lean + POSES.launch.lean) / 2);
});

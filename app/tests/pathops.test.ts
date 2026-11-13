// 路径运算（engine/pathops.ts）和空间运动路径（engine/anim.ts motionPath）的纯函数测试：bun test tests/pathops.test.ts
import { expect, test } from 'bun:test';
import { applyOps, puckerCmds } from '../src/engine/pathops';
import { motionPath, K } from '../src/engine/anim';
import type { Flat, Sub } from '../src/engine/shape';

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

function sub(pts: [number, number][], closed = true): Sub {
  const x = Float64Array.from(pts.map((p) => p[0])), y = Float64Array.from(pts.map((p) => p[1])), n = pts.length;
  const s = new Float64Array(closed ? n + 1 : n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1]! + Math.hypot(x[i]! - x[i - 1]!, y[i]! - y[i - 1]!);
  if (closed) s[n] = s[n - 1]! + Math.hypot(x[0]! - x[n - 1]!, y[0]! - y[n - 1]!);
  return { x, y, s, closed, len: s[s.length - 1]! };
}
const area = (f: Flat) => f.reduce((A, sb) => { let a = 0; const n = sb.x.length; for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += sb.x[i]! * sb.y[j]! - sb.x[j]! * sb.y[i]!; } return A + Math.abs(a) / 2; }, 0);
const square: Flat = [sub([[0, 0], [100, 0], [100, 100], [0, 100]])];

test('offset: miter grows the square by the amount on every side, round adds quarter circles, negative shrinks', () => {
  near(area(applyOps(square, [{ type: 'offset', amount: 10 }])), 120 * 120, 1e-6);
  near(area(applyOps(square, [{ type: 'offset', amount: 10, join: 'round' }])), 100 * 100 + 4 * 100 * 10 + Math.PI * 100, 2);
  near(area(applyOps(square, [{ type: 'offset', amount: -10 }])), 80 * 80, 1e-6);
  // the other winding gives the same result
  const ccw: Flat = [sub([[0, 0], [0, 100], [100, 100], [100, 0]])];
  near(area(applyOps(ccw, [{ type: 'offset', amount: 10 }])), 120 * 120, 1e-6);
});

test('roundCorners cuts each corner to a circular arc; curves (small turns) stay', () => {
  near(area(applyOps(square, [{ type: 'roundCorners', radius: 10 }])), 100 * 100 - (4 - Math.PI) * 100, 1);
  const circle: Flat = [sub(Array.from({ length: 90 }, (_, i) => [50 + 40 * Math.cos(i / 90 * 2 * Math.PI), 50 + 40 * Math.sin(i / 90 * 2 * Math.PI)] as [number, number]))];
  expect(applyOps(circle, [{ type: 'roundCorners', radius: 10 }])[0]!.x.length).toBe(90);
});

test('zigzag on a closed path closes with whole ridges and alternates sides; twist keeps the centre and the far points', () => {
  const z = applyOps(square, [{ type: 'zigzag', size: 5, ridges: 8 }])[0]!;
  expect(z.closed).toBe(true); expect(z.x.length).toBe(16);
  const tw = applyOps(square, [{ type: 'twist', angle: 90 }])[0]!;
  // the corners are the farthest points: they do not turn
  near(tw.x[0]!, 0, 1e-9); near(tw.y[0]!, 0, 1e-9);
  expect(tw.x.length).toBeGreaterThan(4);
});

test('pucker & bloat: vertices toward the centre and handles away (bloat), the reverse for pucker', () => {
  const cmds = [{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 100, y: 0 }, { type: 'L', x: 100, y: 100 }, { type: 'L', x: 0, y: 100 }, { type: 'Z' }] as const;
  const b = puckerCmds(cmds, 0.5);
  // the centre is the mean of the vertices M, L, L, L: (50, 50)
  expect(b[0]).toEqual({ type: 'M', x: 25, y: 25 });
  const c1 = b[1] as { type: 'C'; x1: number; y1: number; x: number; y: number };
  expect(c1.type).toBe('C'); expect([c1.x, c1.y]).toEqual([75, 25]); expect([c1.x1, c1.y1]).toEqual([-25, -25]);
  expect(puckerCmds(cmds, 0)).toBe(cmds as never);
});

test('motionPath: linear speed between two keys is even; it passes through a middle key at its time; angle follows travel', () => {
  const line = motionPath([{ t: 0, p: [0, 0], mode: 'lin' }, { t: 2, p: [200, 0] }]);
  near(line.length, 200, 1e-6);
  near(line.at(1).p[0]!, 100, 1e-6); near(line.at(1).angle, 0, 1e-6);
  near(line.at(-1).p[0]!, 0); near(line.at(9).p[0]!, 200);
  const arc = motionPath([{ t: 0, p: [0, 0], mode: K.go }, { t: 1, p: [100, 100] }, { t: 2, p: [200, 0, 50], mode: K.land }]);
  const m = arc.at(1).p;
  near(m[0]!, 100, 1e-6); near(m[1]!, 100, 1e-6);
  // going down-right at the start (y down: angle between 0 and 90), up-right at the end
  const a0 = arc.at(0.05).angle, a1 = arc.at(1.95).angle;
  expect(a0).toBeGreaterThan(0); expect(a0).toBeLessThan(90);
  expect(a1).toBeLessThan(0); expect(a1).toBeGreaterThan(-90);
  // handles given: the curve leaves along the out handle
  const h = motionPath([{ t: 0, p: [0, 0], out: [0, 100], mode: 'lin' }, { t: 1, p: [100, 0], in: [0, 100] }]);
  near(h.at(0.001).angle, 90, 2);
});

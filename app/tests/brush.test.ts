// 手绘笔刷（沸腾、线宽、闭合形、摄影表、特写补偿、smear）的纯函数测试：bun test tests/brush.test.ts
import { expect, test } from 'bun:test';
import {
  arcLengths, boil, BRUSH, celDrawing, closeUp, inkWidth, place, prefix, resample, smearShape, spline, strokeOutline,
  tgStep, tgTime, TG_FPS, type Pt,
} from '../src/library/kit/tegaki';
import { SUBFRAME } from '../src/engine/subframe';

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

test('TG_FPS divides 60: every drawing is held the same number of frames, and crisp inside a frame', () => {
  expect(60 % TG_FPS).toBe(0);
  const holds = new Map<number, number>();
  for (let f = 0; f < 120; f++) { const s = tgStep(f / 60); holds.set(s, (holds.get(s) ?? 0) + 1); }
  for (const n of holds.values()) expect(n).toBe(60 / TG_FPS);
  near(tgTime(0.49), 5 / 12);
  // a sub-frame just past a drawing change still sees the drawing of its frame
  SUBFRAME.frame = 10 / 60;
  try { expect(tgStep(10 / 60 + 0.0015)).toBe(tgStep(10 / 60 - 0.0015)); } finally { SUBFRAME.frame = NaN; }
});

test('spline passes through its control points and keeps corners sharp', () => {
  const P: Pt[] = [[0, 0], [100, 0, 1], [100, 100]];
  const s = spline(P, false, 5);
  expect(s[0]).toEqual([0, 0]);
  expect(s[s.length - 1]).toEqual([100, 100]);
  expect(s.some(([x, y]) => Math.hypot(x - 100, y) < 1e-6)).toBe(true); // through the corner
  // with the corner flag both legs stay straight lines
  for (const [x, y] of s) expect(Math.min(Math.abs(y), Math.abs(x - 100))).toBeLessThan(1e-6);
});

test('resample spaces points evenly; prefix cuts by length', () => {
  const r = resample([[0, 0], [100, 0]], 10);
  expect(r.length).toBe(11);
  for (let i = 1; i < r.length; i++) near(r[i]![0] - r[i - 1]![0], 10);
  const sq = resample([[0, 0], [100, 0], [100, 100], [0, 100]], 10, true);
  expect(sq.length).toBe(40); // perimeter 400, closed: no repeated first point
  const L = arcLengths(prefix([[0, 0], [100, 0], [100, 100]], 0.75));
  near(L[L.length - 1]!, 150);
});

test('boil: a smooth field — neighbours move together, far points independently, within amp', () => {
  closeUp(1);
  const pts: Pt[] = [];
  for (let i = 0; i < 400; i++) pts.push([i * 2.5, 300 + i * 0.3]);
  const b = boil(pts, 3, 2.2, 70);
  const d = b.map(([x, y], i) => [x - pts[i]![0], y - pts[i]![1]] as const);
  for (const [dx, dy] of d) { expect(Math.abs(dx)).toBeLessThanOrEqual(2.2); expect(Math.abs(dy)).toBeLessThanOrEqual(2.2); }
  // adjacent points (2.5 px apart) differ by a small fraction of the amplitude: it does not crawl point by point
  let adj = 0, far = 0;
  for (let i = 1; i < d.length; i++) adj = Math.max(adj, Math.hypot(d[i]![0] - d[i - 1]![0], d[i]![1] - d[i - 1]![1]));
  expect(adj).toBeLessThan(0.5);
  for (let i = 0; i + 120 < d.length; i++) far = Math.max(far, Math.hypot(d[i]![0] - d[i + 120]![0], d[i]![1] - d[i + 120]![1]));
  expect(far).toBeGreaterThan(1);
  // the same drawing boils the same way; the next drawing differently
  expect(boil(pts, 3)).toEqual(b);
  const b2 = boil(pts, 4);
  expect(b2.some(([x], i) => Math.abs(x - b[i]![0]) > 0.5)).toBe(true);
  // close-up compensation shrinks the amplitude
  closeUp(2);
  const bz = boil(pts, 3);
  for (let i = 0; i < pts.length; i++) near(bz[i]![0] - pts[i]![0], d[i]![0] * 2 ** -0.95, 1e-9);
  closeUp(1);
});

test('inkWidth: tapers to min at both ends, pressure within ±35 %, heavier on the shadow side', () => {
  closeUp(1);
  const wf = inkWidth({ w: 10, pressure: 0, heavy: 0 });
  near(wf(0, 200, 1, 0), 2.5); // press-in: 0.25 of the nib
  near(wf(200, 200, 1, 0), 2.5);
  near(wf(100, 200, 1, 0), 10);
  near(wf(7, 200, 1, 0), 2.5 + 7.5 * 0.5); // half way up the 14 px press-in
  const wp = inkWidth({ w: 10, heavy: 0 });
  for (let s = 30; s < 170; s += 3) { expect(wp(s, 200, 1, 0)).toBeGreaterThanOrEqual(6.5 - 1e-9); expect(wp(s, 200, 1, 0)).toBeLessThanOrEqual(13.5 + 1e-9); }
  const wh = inkWidth({ w: 10, pressure: 0 });
  // a stroke running right (outward normal up, towards the light) vs left (normal down: the shadow side)
  near(wh(100, 200, 1, 0), 10);
  near(wh(100, 200, -1, 0), 10 * (1 + 0.35 * 0.83));
  closeUp(1.857);
  near(BRUSH.ink, 0.59, 0.01); near(BRUSH.amp, 0.555, 0.01); // 05-cel-boil's close-up: ×0.58 line, ×0.55 boil
  near(wf(100, 200, 1, 0), 10 * BRUSH.ink);
  closeUp(0.5);
  expect(BRUSH).toEqual({ ink: 1, amp: 1 }); // pulled back: unchanged
});

test('strokeOutline: the outline is as wide as the width function, with round caps', () => {
  const pts = resample([[0, 0], [100, 0]], 5);
  const poly = strokeOutline(pts, () => 8);
  let y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity;
  for (const [x, y] of poly) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
  near(y1 - y0, 8); near(x0, -4, 0.1); near(x1, 104, 0.1); // the caps reach half the width past each end
  expect(strokeOutline(pts, () => 8, false).length).toBe(pts.length * 2);
});

test('celDrawing: ids run on across the sheet, the boil loops 4 drawings (3 on a hold), crisp in a frame', () => {
  const sheet = [[0, 12], [1, 30], [1.5, 6]] as const;
  const a = celDrawing(0.95, sheet);
  expect(a.id).toBe(11); near(a.t, 11 / 12); expect(a.rate).toBe(12); expect(a.v).toBe(3); expect(a.hold).toBe(false);
  const b = celDrawing(1.0, sheet);
  expect(b.id).toBe(12); near(b.t, 1); expect(b.rate).toBe(30);
  const c = celDrawing(1.5, sheet);
  expect(c.id).toBe(12 + 15); expect(c.hold).toBe(true);
  // on the hold the variant cycles 0,1,2
  const vs = [0, 1, 2, 3, 4, 5].map((k) => celDrawing(1.5 + k / 6 + 0.01, sheet).v);
  expect(new Set(vs).size).toBe(3);
  expect(vs[3]).toBe(vs[0]);
  // on twos the variant takes 4 values and comes round again
  const v2 = [0, 1, 2, 3, 4].map((k) => celDrawing(k / 12 + 0.01, sheet).v);
  expect(new Set(v2).size).toBe(4); expect(v2[4]).toBe(v2[0]);
  // every frame of a drawing on twos is the same drawing; the drawings change every 5 frames
  const ids = Array.from({ length: 20 }, (_, f) => celDrawing(f / 60, sheet).id);
  expect(ids).toEqual(ids.map((_, f) => Math.floor(f / 5)));
  // before the first entry its rate applies
  expect(celDrawing(-0.1, sheet).id).toBe(-2);
  SUBFRAME.frame = 1;
  try { expect(celDrawing(1.003, sheet).id).toBe(celDrawing(0.997, sheet).id); } finally { SUBFRAME.frame = NaN; }
});

test('smearShape: the trailing side is dragged back by len, the leading side stays', () => {
  const circle: Pt[] = Array.from({ length: 36 }, (_, i) => [Math.cos((i / 36) * Math.PI * 2) * 10, Math.sin((i / 36) * Math.PI * 2) * 10]);
  const s = smearShape(circle, 1, 0, 30); // moving right
  near(s[0]![0], 10); near(s[0]![1], 0); // the front point (angle 0) stays
  near(s[18]![0], -40); // the back point (angle π) is dragged 30 px back
  let x0 = Infinity, x1 = -Infinity;
  for (const p of s) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); }
  near((x1 - x0) / 20, 2.5); // 250 % of its length (len 3 × the diameter → 400 %)
  const s3 = smearShape(circle, 1, 0, 60);
  near((Math.max(...s3.map((p) => p[0])) - Math.min(...s3.map((p) => p[0]))) / 20, 4);
});

test('place: scale, shear, rotate, move; keeps corner flags', () => {
  const p = place([[1, -1, 1]], { x: 10, y: 20, sx: 2, sy: 3, r: Math.PI / 2 });
  near(p[0]![0], 10 + 3); near(p[0]![1], 20 + 2); expect(p[0]![2]).toBe(1);
});

// 纸片拼贴（engine/paper.ts「拼贴」一节）的纯函数测试：bun test tests/paper.test.ts
import { expect, test } from 'bun:test';
import {
  polyArea, offsetPoly, simplifyPoly, scissorPoints, circlePts, rectPts, tornEdge, tearShape, edt, dilateMask, erodeMask,
  traceContours, screenSpot, screenInk, boil, pastePose, stepsSince, rostrum, type Pt,
} from '../src/library/engine/paper';

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);
/** Distance from p to segment ab. */
const segDist = (p: Pt, a: Pt, b: Pt) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const u = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dy);
};
const polyDist = (p: Pt, poly: Pt[]) => Math.min(...poly.map((a, i) => segDist(p, a, poly[(i + 1) % poly.length]!)));
/** A square's outline sampled every 1 px, clockwise from (5, 0). */
const denseSquare = (): Pt[] => {
  const out: Pt[] = [];
  for (let x = 5; x < 100; x++) out.push([x, 0]);
  for (let y = 0; y < 100; y++) out.push([100, y]);
  for (let x = 100; x > 0; x--) out.push([x, 100]);
  for (let y = 100; y > 0; y--) out.push([0, y]);
  for (let x = 0; x < 5; x++) out.push([x, 0]);
  return out;
};

test('polyArea: positive clockwise on screen, negative counter-clockwise', () => {
  near(polyArea(rectPts(0, 0, 10, 20)), 200);
  near(polyArea(rectPts(0, 0, 10, 20).reverse()), -200);
});

test('offsetPoly: a square grows by d on every side, either orientation', () => {
  for (const sq of [rectPts(0, 0, 100, 100), rectPts(0, 0, 100, 100).reverse()]) {
    const o = offsetPoly(sq, 5);
    const xs = o.map((p) => p[0]), ys = o.map((p) => p[1]);
    near(Math.min(...xs), -5); near(Math.max(...xs), 105); near(Math.min(...ys), -5); near(Math.max(...ys), 105);
  }
  near(polyArea(offsetPoly(rectPts(0, 0, 100, 100), -10)), 80 * 80, 1e-6);
});

test('simplifyPoly: a densely sampled square comes back as its four corners', () => {
  const s = simplifyPoly(denseSquare(), 0.5);
  expect(s.length).toBe(4);
  for (const c of [[0, 0], [100, 0], [100, 100], [0, 100]] as Pt[]) expect(s.some((p) => p[0] === c[0] && p[1] === c[1])).toBe(true);
});

test('simplifyPoly: every original point stays within eps; a circle becomes long facets', () => {
  const circ = circlePts(0, 0, 300);
  const s = simplifyPoly(circ, 2);
  expect(s.length).toBeGreaterThan(8);
  expect(s.length).toBeLessThan(40); // facets ~ sqrt(8 R eps) ≈ 70 px on a 1885 px circumference
  for (const p of circ) expect(polyDist(p, s)).toBeLessThanOrEqual(2 + 1e-9);
});

test('scissorPoints: pushed out by the rim, straight facets, deterministic, seeded', () => {
  const o = { rim: 6, seed: 3 };
  const a = scissorPoints(circlePts(0, 0, 200), o), b = scissorPoints(circlePts(0, 0, 200), o), c = scissorPoints(circlePts(0, 0, 200), { ...o, seed: 4 });
  expect(a).toEqual(b);
  expect(a).not.toEqual(c);
  expect(a.length).toBeLessThan(60);
  // every corner near radius 206: eps (4.2) + wobble (3.4) + jitter (0.7 per axis) of slack
  for (const p of a) expect(Math.abs(Math.hypot(p[0], p[1]) - 206)).toBeLessThan(4.2 + 3.4 + 1.1);
  // facets of uneven length (the wobble), not a regular polygon
  const L = a.map((p, i) => Math.hypot(a[(i + 1) % a.length]![0] - p[0], a[(i + 1) % a.length]![1] - p[1]));
  expect(Math.max(...L) / Math.min(...L)).toBeGreaterThan(1.5);
  // no wobble, no jitter, no rim: a rectangle stays exact
  expect(scissorPoints(rectPts(0, 0, 50, 30), { wobble: 0, jitter: 0 })).toEqual(rectPts(0, 0, 50, 30));
});

test('tornEdge: ends pinned, bounded, rough, deterministic', () => {
  const e = tornEdge([0, 0], [600, 0], { amp: 8, seed: 5 });
  expect(e[0]).toEqual([0, 0]); expect(e[e.length - 1]).toEqual([600, 0]);
  const ys = e.map((p) => p[1]);
  expect(Math.max(...ys.map(Math.abs))).toBeLessThan(8 * 2.6); // octave weights sum to 1.87, plus fine noise
  expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(8); // it does tear
  for (let i = 1; i < e.length; i++) expect(e[i]![0]).toBeGreaterThan(e[i - 1]![0]); // never folds back along x
  expect(tornEdge([0, 0], [600, 0], { amp: 8, seed: 5 })).toEqual(e);
});

test('tearShape: straight edges stay straight, torn edges get rims and fibres outside', () => {
  const sq = rectPts(0, 0, 300, 200);
  const t = tearShape(sq, { edges: [true, false, false, false], rim: 6, seed: 2 });
  expect(t.rims.length).toBe(1);
  expect(t.fibres.length).toBeGreaterThan(0);
  // the three straight edges keep their corners exactly; the torn top edge stays near y = 0
  for (const c of [sq[1], sq[2], sq[3]]) expect(t.outline.some((p) => p[0] === c![0] && p[1] === c![1])).toBe(true);
  for (const p of t.outline) if (p[1] < 100) expect(Math.abs(p[1])).toBeLessThan(25);
  // the rim lies outside (above) the top edge
  const rimY = t.rims[0]!.map((p) => p[1]);
  expect(Math.min(...rimY)).toBeLessThan(Math.min(...t.outline.map((p) => p[1])));
  const all = tearShape(sq, { rim: 0 });
  expect(all.rims.length).toBe(0);
  expect(all.outline.length).toBeGreaterThan(200);
});

test('edt / dilate / erode: a dot grows into a disc and back', () => {
  const w = 21, h = 21, m = new Uint8Array(w * h);
  m[10 * w + 10] = 1;
  const d = edt(m, w, h);
  near(d[10 * w + 10]!, 0); near(d[10 * w + 13]!, 9); near(d[13 * w + 14]!, 25);
  const g = dilateMask(m, w, h, 2);
  expect(g.reduce((a, b) => a + b, 0)).toBe(13); // lattice points within radius 2
  const back = erodeMask(g, w, h, 2);
  expect(back.reduce((a, b) => a + b, 0)).toBe(1);
  expect(back[10 * w + 10]).toBe(1);
});

test('traceContours: outer boundary of each blob, clockwise, small blobs dropped', () => {
  const w = 30, h = 20, m = new Uint8Array(w * h);
  for (let y = 2; y < 8; y++) for (let x = 3; x < 13; x++) m[y * w + x] = 1; // 10 x 6 block
  for (let y = 12; y < 14; y++) for (let x = 20; x < 22; x++) m[y * w + x] = 1; // 2 x 2 speck
  const all = traceContours(m, w, h);
  expect(all.length).toBe(2);
  const [blk] = traceContours(m, w, h, 10);
  expect(traceContours(m, w, h, 10).length).toBe(1);
  expect(blk!.length).toBe(2 * (10 + 6) - 4); // each boundary pixel once
  expect(polyArea(blk!)).toBeGreaterThan(0);
  expect(simplifyPoly(blk!, 0.5).length).toBe(4);
  const xs = blk!.map((p) => p[0]), ys = blk!.map((p) => p[1]);
  expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([3.5, 12.5, 2.5, 7.5]);
  // a ring: only its outer boundary
  const r = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const d = Math.hypot(x - 15, y - 10); if (d <= 8 && d >= 4) r[y * w + x] = 1; }
  const [ring] = traceContours(r, w, h);
  for (const p of ring!) expect(Math.hypot(p[0] - 15.5, p[1] - 10.5)).toBeGreaterThan(6);
});

test('halftone screen: ink coverage tracks the tone', () => {
  const cover = (cov: number) => {
    let s = 0, n = 0;
    for (let y = 0; y < 65; y++) for (let x = 0; x < 65; x++) { s += screenInk(cov, screenSpot(x + 0.5, y + 0.5, 6.5, 45), 1.6 / 6.5); n++; }
    return s / n;
  };
  expect(cover(0)).toBeLessThan(0.03);
  expect(cover(1)).toBeGreaterThan(0.97);
  expect(Math.abs(cover(0.5) - 0.5)).toBeLessThan(0.06);
  expect(cover(0.25)).toBeLessThan(cover(0.5));
  expect(cover(0.75)).toBeGreaterThan(cover(0.5));
  near(screenSpot(0, 0, 6.5, 45), 1); // dots centred on the lattice
});

test('boil: 2 px at 12 fps moving, 1.1 px at 6 fps resting, held between steps', () => {
  for (let i = 0; i < 50; i++) {
    const t = i * 0.037;
    const m = boil(t, 4, true), r = boil(t, 4, false);
    expect(Math.abs(m[0])).toBeLessThanOrEqual(2); expect(Math.abs(m[1])).toBeLessThanOrEqual(2);
    expect(Math.abs(r[0])).toBeLessThanOrEqual(1.1); expect(Math.abs(r[1])).toBeLessThanOrEqual(1.1);
  }
  expect(boil(1.0, 4, true)).toEqual(boil(1.0 + 1 / 12 - 1e-3, 4, true));
  expect(boil(1.0, 4, true)).not.toEqual(boil(1.0 + 1 / 12 + 1e-3, 4, true));
  expect(boil(1.0, 4, false)).toEqual(boil(1.0 + 1 / 6 - 1e-3, 4, false));
});

test('pastePose: falls 3 steps, lands on the step nearest t0, squash .972 then 1.01, then rests', () => {
  const t0 = 1.03; // lands on the step at 1.0 (12 fps)
  expect(pastePose(0.74, t0).visible).toBe(false);
  const f = pastePose(0.75, t0);
  expect(f.visible).toBe(true); expect(f.k).toBe(-3); near(f.lift, 1, 1e-3); expect(f.moving).toBe(true);
  expect(pastePose(0.84, t0).k).toBe(-2);
  const land = pastePose(1.0, t0);
  expect(land.k).toBe(0); near(land.lift, 0); near(land.scale, 0.972, 1e-3);
  near(pastePose(1.0 + 1 / 12, t0).scale, 1.0086, 1e-3);
  const rest = pastePose(3, t0);
  expect(rest.moving).toBe(false); near(rest.scale, 1, 1e-3);
  expect(Math.hypot(rest.x, rest.y)).toBeLessThanOrEqual(1.1 * Math.SQRT2 + 1e-9);
  // stop motion: the pose is held for the whole step
  expect(pastePose(0.84, t0)).toEqual(pastePose(0.84 + 0.07, t0));
  expect(stepsSince(1.2, t0)).toBe(2);
  expect(stepsSince(0.99, t0)).toBe(-1);
});

test('rostrum: keyed, stepped at 6 fps, kicked per 12 fps step, never past max', () => {
  const keys = [{ t: 0, z: 1 }, { t: 2, z: 1.04 }];
  near(rostrum(0, keys).z, 1); near(rostrum(2, keys).z, 1.04); near(rostrum(9, keys).z, 1.04);
  expect(rostrum(1.0, keys)).toEqual(rostrum(1.0 + 1 / 6 - 1e-3, keys));
  expect(rostrum(1.0, keys).z).toBeLessThan(rostrum(1.0 + 1 / 6 + 1e-3, keys).z);
  const kicks = [{ t: 2, z: [0.05, 0.01], x: [10, -4] }];
  near(rostrum(2, keys, { kicks }).z, 1.06); // 1.09 capped
  near(rostrum(2, keys, { kicks }).x, 10);
  near(rostrum(2 + 1 / 12, keys, { kicks }).x, -4);
  near(rostrum(2 + 2 / 12, keys, { kicks }).x, 0);
  near(rostrum(1.9, keys, { kicks }).x, 0);
});

// 玻璃拟态部件的纯函数测试：bun test tests/glass.test.ts
import { expect, test } from 'bun:test';
import { W, H } from '../src/engine/gl';
import {
  bezelHeight, camEye, gaussTaps, glassCam, loopPath, MAX_TAPS, orbit, plane, planePoint, project, projectLocal, rotBasis,
  screenToPlane, SPECTRUM, type Vec3,
} from '../src/library/kit/glass';

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.sqrt(dot(a, a));

test('gaussTaps: weights sum to 1, offsets grow, capped at MAX_TAPS', () => {
  for (const s of [0.5, 2, 7.5, 15, 40]) {
    const { off, w, n } = gaussTaps(s);
    let sum = w[0]!;
    for (let i = 1; i < n; i++) sum += 2 * w[i]!;
    near(sum, 1, 1e-5);
    expect(n).toBeLessThanOrEqual(MAX_TAPS);
    for (let i = 2; i < n; i++) expect(off[i]!).toBeGreaterThan(off[i - 1]!);
    // each pair sits between its two texels
    for (let i = 1; i < n; i++) { expect(off[i]!).toBeGreaterThanOrEqual(2 * i - 1); expect(off[i]!).toBeLessThanOrEqual(2 * i); }
  }
  // sigma 7.5 (30 logical px at quarter res): R = 23 → 12 pairs + centre
  expect(gaussTaps(7.5).n).toBe(13);
});

test('loopPath: through the anchors, closed and smooth', () => {
  const pts = [[0, 0], [100, 0], [100, 100], [0, 100]] as const;
  const p = loopPath(pts, 8);
  pts.forEach((q, i) => { const [x, y] = p(i * 2); near(x, q[0], 1e-9); near(y, q[1], 1e-9); });
  const [a, b] = [p(0.3), p(8.3)];
  near(a[0], b[0], 1e-9); near(a[1], b[1], 1e-9);
  // velocity continuous through an anchor
  const v = (t: number, d: number) => { const [x0, y0] = p(t - d), [x1, y1] = p(t); return [(x1 - x0) / d, (y1 - y0) / d]; };
  const vin = v(2, 1e-4), vout = v(2 + 1e-4, 1e-4);
  near(vin[0]!, vout[0]!, 0.05); near(vin[1]!, vout[1]!, 0.05);
  // phase shifts the start
  const q = loopPath(pts, 8, 0.25)(0);
  near(q[0], 100); near(q[1], 0);
});

test('rotBasis: orthonormal, right-handed, identity at rest', () => {
  const r0 = rotBasis(0, 0, 0);
  const eq = (a: Vec3, b: Vec3) => a.forEach((v, i) => near(v, b[i]!));
  eq(r0.U, [1, 0, 0]); eq(r0.V, [0, 1, 0]); eq(r0.N, [0, 0, 1]);
  // rx > 0: the bottom edge (down the card) goes away; ry > 0: the right edge comes toward the viewer
  expect(rotBasis(10, 0).V[2]).toBeGreaterThan(0); expect(rotBasis(0, 10).U[2]).toBeLessThan(0);
  const { U, V, N } = rotBasis(12, -27, 5);
  near(len(U), 1); near(len(V), 1); near(len(N), 1);
  near(dot(U, V), 0); near(dot(V, N), 0); near(dot(U, N), 0);
  // U x V = N
  near(U[1] * V[2] - U[2] * V[1], N[0]); near(U[2] * V[0] - U[0] * V[2], N[1]); near(U[0] * V[1] - U[1] * V[0], N[2]);
});

test('project: the z = 0 plane at 1:1 with the camera at rest; dolly in magnifies about the centre', () => {
  const c = glassCam();
  const [x, y, s] = project([300, 200, 0], c);
  near(x, 300); near(y, 200); near(s, 1);
  const [x2, , s2] = project([W / 2 + 100, H / 2, 0], glassCam(0, 0, 400));
  near(s2, 2000 / 1600); near(x2, W / 2 + 125);
  expect(camEye(glassCam(10, -5, 300))).toEqual([W / 2 + 10, H / 2 - 5, -1700]);
});

test('screenToPlane inverts projectLocal (what the card shader does per pixel)', () => {
  const cam = glassCam(-30, 60, 450);
  const p = plane([1090, 500, 120], 6, -14, 3);
  for (const [lx, ly] of [[0, 0], [-310, 200], [250, -180], [33.3, 77.7]] as const) {
    const [x, y] = projectLocal(p, lx, ly, cam);
    const back = screenToPlane(x, y, p, cam)!;
    near(back[0], lx, 1e-6); near(back[1], ly, 1e-6);
  }
  // behind the eye: no hit
  expect(screenToPlane(960, 540, plane([960, 540, -2500]), glassCam())).toBeNull();
  const w = planePoint(p, 10, 0);
  near(w[0] - p.C[0], 10 * p.U[0]); near(w[2] - p.C[2], 10 * p.U[2]);
});

test('orbit: keeps the distance to the pivot; yaw turns about the vertical', () => {
  const piv: Vec3 = [960, 540, 80], C: Vec3 = [1260, 400, 0];
  const r = orbit(C, 20, -6, piv);
  near(len([r[0] - piv[0], r[1] - piv[1], r[2] - piv[2]]), len([C[0] - piv[0], C[1] - piv[1], C[2] - piv[2]]), 1e-9);
  const y = orbit(C, 90, 0, piv);
  near(y[1], C[1], 1e-9); near(y[0], piv[0] + (C[2] - piv[2]), 1e-9); near(y[2], piv[2] - (C[0] - piv[0]), 1e-9);
  expect(orbit(C, 0, 0, piv)).toEqual(C);
});

test('SPECTRUM: seven bands, every channel sums to 1 (white stays white)', () => {
  expect(SPECTRUM.length).toBe(7);
  for (let k = 0; k < 3; k++) near(SPECTRUM.reduce((s, c) => s + c[k as 0 | 1 | 2], 0), 1, 1e-9);
  expect(SPECTRUM[0]![2]).toBeGreaterThan(SPECTRUM[0]![0]); // violet first
  expect(SPECTRUM[6]![0]).toBeGreaterThan(SPECTRUM[6]![2]); // red last
});

test('bezelHeight: 0 at the rim, 1 on the plateau, monotone, steep at the rim', () => {
  near(bezelHeight(0), 0); near(bezelHeight(1), 1); near(bezelHeight(2), 1); near(bezelHeight(-1), 0);
  let prev = 0;
  for (let i = 1; i <= 20; i++) { const h = bezelHeight(i / 20); expect(h).toBeGreaterThan(prev); prev = h; }
  expect(bezelHeight(0.1)).toBeGreaterThan(0.4); // squircle: most of the height in the first tenth
});

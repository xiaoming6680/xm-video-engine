// 操控点的 ARAP 求解（engine/puppet.ts PuppetMesh）：钉子到位、边长基本不变、分开的块网格也分开、不动就是原样：bun test tests/puppet.test.ts
import { expect, test } from 'bun:test';
import { PuppetMesh } from '../src/engine/puppet';

/** A grid of cells (nx x ny) with the given cells opaque. */
function grid(nx: number, ny: number, on: (x: number, y: number) => boolean) {
  const a = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) a[y * nx + x] = on(x, y) ? 1 : 0;
  return a;
}
const step = 10;
// a bar 200 x 40 px in a 26 x 10 cell field
const bar = new PuppetMesh(grid(26, 10, (x, y) => x >= 3 && x < 23 && y >= 3 && y < 7), 26, 10, step);

test('no move: every vertex stays where it was', () => {
  const U = bar.solve([{ at: [40, 50], to: [40, 50] }, { at: [220, 50], to: [220, 50] }]);
  let worst = 0;
  for (let i = 0; i < U.length; i++) worst = Math.max(worst, Math.abs(U[i]! - bar.X[i]!));
  expect(worst).toBeLessThan(1e-6);
});

test('the pins land where they are told, and the bar bends without stretching', () => {
  const pins = [{ at: [40, 50], to: [40, 50] }, { at: [130, 50], to: [130, 50] }, { at: [220, 50], to: [200, -10] }] as const;
  const U = bar.solve(pins, 12);
  // where a pin's rest point ends up: interpolate the moved mesh at it (a pin on a vertex is that vertex)
  const at = (x: number, y: number) => { let best = 0, bd = Infinity; for (let i = 0; i < bar.n; i++) { const d = Math.hypot(bar.X[i * 2]! - x, bar.X[i * 2 + 1]! - y); if (d < bd) { bd = d; best = i; } } return [U[best * 2]!, U[best * 2 + 1]!]; };
  for (const p of pins) { const q = at(p.at[0], p.at[1]); expect(Math.hypot(q[0]! - p.to[0], q[1]! - p.to[1])).toBeLessThan(1.5); }
  // edge lengths: a rigid bend keeps them; on average within a few percent
  let sum = 0, cnt = 0;
  const T = bar.tris;
  for (let t = 0; t < T.length; t += 3) for (let k = 0; k < 3; k++) {
    const i = T[t + k]!, j = T[t + (k + 1) % 3]!;
    const l0 = Math.hypot(bar.X[i * 2]! - bar.X[j * 2]!, bar.X[i * 2 + 1]! - bar.X[j * 2 + 1]!), l1 = Math.hypot(U[i * 2]! - U[j * 2]!, U[i * 2 + 1]! - U[j * 2 + 1]!);
    sum += Math.abs(l1 / l0 - 1); cnt++;
  }
  expect(sum / cnt).toBeLessThan(0.06);
  // same pins, same answer (frames render in any order)
  expect(Array.from(bar.solve(pins, 12))).toEqual(Array.from(U));
});

test('moving every pin by the same amount moves the shape rigidly', () => {
  const U = bar.solve([{ at: [40, 50], to: [140, 80] }, { at: [220, 50], to: [320, 80] }], 8);
  let worst = 0;
  for (let i = 0; i < bar.n; i++) worst = Math.max(worst, Math.hypot(U[i * 2]! - bar.X[i * 2]! - 100, U[i * 2 + 1]! - bar.X[i * 2 + 1]! - 30));
  expect(worst).toBeLessThan(0.5);
});

test('two blobs apart make two meshes: pulling one leaves the other alone', () => {
  const two = new PuppetMesh(grid(30, 10, (x, y) => y >= 3 && y < 7 && ((x >= 2 && x < 10) || (x >= 18 && x < 26))), 30, 10, step);
  const U = two.solve([{ at: [60, 50], to: [60, 0] }, { at: [220, 50], to: [220, 50] }], 8);
  let far = 0;
  for (let i = 0; i < two.n; i++) if (two.X[i * 2]! > 170) far = Math.max(far, Math.hypot(U[i * 2]! - two.X[i * 2]!, U[i * 2 + 1]! - two.X[i * 2 + 1]!));
  expect(far).toBeLessThan(0.5);
});

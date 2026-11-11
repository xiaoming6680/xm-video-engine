// 后期参数的纯函数：调色板解析和 OKLab、Riso 错版漂移、纸纹高通、默认值不改画面：bun test tests/post.test.ts
import { expect, test } from 'bun:test';
import { DEFAULT_POST, PDOOM_LOOK, PALETTE_MAX, oklab, paletteSet, paperHighPass, risoDrift } from '../src/engine/post';

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

test('the new looks are off by default; PDOOM_LOOK keeps the per-channel shoulder', () => {
  const p = DEFAULT_POST;
  for (const k of ['vhsBleed', 'vhsTear', 'risoTrap', 'risoRough', 'risoSolid', 'paperTex'] as const) expect(p[k]).toBe(0);
  expect(p.palette).toEqual([]);
  expect(p.risoDensity).toBe(1);
  expect(p.risoPlates).toEqual([[1, 0.4], [-0.6, -0.8], [0.2, 1]]); // the directions the riso pass always used
  expect(p.shoulderHue).toBe(1);
  expect(PDOOM_LOOK.shoulderHue).toBe(0);
});

test('oklab: white is L 1, black 0, greys have no chroma', () => {
  const w = oklab(1, 1, 1), k = oklab(0, 0, 0), g = oklab(0.2, 0.2, 0.2);
  near(w[0], 1, 1e-4); near(w[1], 0, 1e-4); near(w[2], 0, 1e-4);
  near(k[0], 0); near(g[1], 0, 1e-4); near(g[2], 0, 1e-4);
  // a known value: linear sRGB red
  const r = oklab(1, 0, 0);
  near(r[0], 0.6279554, 1e-4); near(r[1], 0.2248631, 1e-4); near(r[2], 0.1258463, 1e-4);
});

test('paletteSet: valid colours only, #rgb expands, at most PALETTE_MAX, anything else is an empty palette', () => {
  const s = paletteSet(['#ff0000', '#0f0', 'nope', 12, ' #0000FF ']);
  expect(s.rgb).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  expect(s.lab.length).toBe(3);
  expect(paletteSet(Array.from({ length: 40 }, () => '#123456')).rgb.length).toBe(PALETTE_MAX);
  expect(paletteSet(NaN).rgb.length).toBe(0); // what ?post=palette:x leaves
  expect(paletteSet(undefined).rgb.length).toBe(0);
});

test('risoDrift: in register on the hit, apart before the next, apart before the first', () => {
  const hits = [1, 2, 3];
  expect(risoDrift(0.5, hits, 4, 0.2)).toBe(4);
  near(risoDrift(1, hits, 4, 0.2), 0.2);
  near(risoDrift(2, hits, 4, 0.2), 0.2);
  near(risoDrift(1.5, hits, 4, 0.2), 0.2 + 3.8 * 0.25); // ease-in
  expect(risoDrift(1.999, hits, 4, 0.2)).toBeGreaterThan(3.9);
  near(risoDrift(3.5, hits, 4, 0.2), 0.2 + 3.8 * 0.25); // after the last: the last gap again
  near(risoDrift(10, hits, 4, 0.2), 4);
  expect(risoDrift(1, [], 4)).toBe(4);
});

test('paperHighPass: removes a slope and keeps the tooth', () => {
  const w = 64, h = 48, rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = 100 + x + ((x * 7 + y * 13) % 5 === 0 ? 20 : 0); // a ramp plus sparse specks
    rgba.set([v, v, v, 255], (y * w + x) * 4);
  }
  const hp = paperHighPass(rgba, w, h, 4);
  // away from the edges the ramp is gone: the mean is ~0 and the specks stand out
  let s = 0, n = 0, specks = 0;
  for (let y = 8; y < h - 8; y++) for (let x = 8; x < w - 8; x++) { const v = hp[y * w + x]!; s += v; n++; if (v > 10) specks++; }
  near(s / n, 0, 0.5);
  expect(specks).toBeGreaterThan(n * 0.15);
});

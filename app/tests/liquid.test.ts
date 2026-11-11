// 液态（kit/liquid.ts）纯函数测试：平滑并集、高度、字形距离场、编排部件的确定性和落点。bun test tests/liquid.test.ts
import { expect, test } from 'bun:test';
import {
  smoothMin, liquidHeight, signedField, blurField, blendDepth, liquidField, offsetField, wordSD, bottomAt, letterToWorld,
  puddleStretch, fallingDrop, splash, hop, strand, drip, fizz, fling, goo, GRAVITY, type WordLetter,
} from '../src/library/kit/liquid';

const near = (a: number, b: number, eps = 1e-3) => expect(Math.abs(a - b)).toBeLessThan(eps);

/** Coverage of a disc (4x4 supersampled), w x h. */
function disc(w: number, h: number, cx: number, cy: number, r: number) {
  const a = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c = 0;
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if ((x + (i + 0.5) / 4 - cx) ** 2 + (y + (j + 0.5) / 4 - cy) ** 2 < r * r) c++;
    a[y * w + x] = c / 16;
  }
  return a;
}
/** Coverage of an axis-aligned rectangle [x0, x1) x [y0, y1) (integer edges). */
function rect(w: number, h: number, x0: number, y0: number, x1: number, y1: number) {
  const a = new Float32Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) a[y * w + x] = 1;
  return a;
}

test('smoothMin: plain min when far apart, ln2/k deeper when equal, never above the min', () => {
  near(smoothMin([0, 200], 0.08), 0, 1e-5);
  near(smoothMin([10, 10], 0.1), 10 - Math.log(2) / 0.1, 1e-9);
  for (const ds of [[3, 7], [-5, 2, 9], [40, 41, 39]]) expect(smoothMin(ds, 0.08)).toBeLessThanOrEqual(Math.min(...ds));
  // sharper k → closer to the plain min
  expect(Math.abs(smoothMin([5, 8], 0.1) - 5)).toBeLessThan(Math.abs(smoothMin([5, 8], 0.06) - 5));
  expect(smoothMin([], 0.1)).toBe(Infinity);
});

test('liquidHeight: low rim, rises like a meniscus, saturates at Hc', () => {
  near(liquidHeight(0), 210 * Math.tanh(Math.sqrt(2 * 95 * 0.6) / 210));
  expect(liquidHeight(-5)).toBe(liquidHeight(0));
  let prev = 0;
  for (const d of [0, 1, 4, 16, 64, 256, 1024]) { const h = liquidHeight(d); expect(h).toBeGreaterThan(prev); prev = h; }
  expect(liquidHeight(1e6)).toBeLessThanOrEqual(210);
  expect(liquidHeight(2000)).toBeGreaterThan(200);
});

test('signedField: a disc measures its own distance to within half a px, negative inside', () => {
  const w = 64, h = 64, r = 20, a = disc(w, h, 32, 32, r), d = signedField(a, w, h);
  for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
    const want = Math.hypot(x + 0.5 - 32, y + 0.5 - 32) - r;
    expect(Math.abs(d[y * w + x]! - want)).toBeLessThan(0.75);
  }
  near(d[32 * w + 32]!, Math.hypot(0.5, 0.5) - r, 0.75);
});

test('blurField keeps a constant and its mass', () => {
  const w = 30, h = 20, c = new Float32Array(w * h).fill(3), b = blurField(c, w, h, 4);
  for (const v of b) near(v, 3, 1e-4);
  const imp = new Float32Array(w * h); imp[10 * w + 15] = 1;
  const s = blurField(imp, w, h, 2).reduce((a, v) => a + v, 0);
  near(s, 1, 1e-4);
});

test('blendDepth: edge kept, deep interior follows the smooth field, outside never further than sharp', () => {
  near(blendDepth(-1, -40), -1, 1e-9);           // at the rim: the sharp field
  near(blendDepth(-30, -22), -22, 1e-9);         // deep: the soft one
  expect(blendDepth(10, 30)).toBe(10);
  expect(blendDepth(10, 2)).toBe(5);             // outside: no nearer than half the sharp distance
});

test('liquidField: no ridge along a stroke centre, silhouette kept', () => {
  // a 60 px wide bar: the true distance has a kink (second difference 2) on its centre line
  const w = 120, h = 200, a = rect(w, h, 30, 20, 90, 180), sharp = signedField(a, w, h), f = liquidField(a, w, h, { edge: 2, deep: 10 });
  const row = 100, c = 60;
  const kink = (g: Float32Array) => { let m = 0; for (let x = c - 3; x <= c + 3; x++) m = Math.max(m, Math.abs(g[row * w + x - 1]! - 2 * g[row * w + x]! + g[row * w + x + 1]!)); return m; };
  expect(kink(sharp)).toBeGreaterThan(0.9);
  expect(kink(f)).toBeLessThan(0.2);
  // the edge (zero crossing) stays within half a px of the true one
  const zc = (g: Float32Array) => { for (let x = 0; x < w - 1; x++) { const p = g[row * w + x]!, q = g[row * w + x + 1]!; if (p > 0 && q <= 0) return x + 0.5 + p / (p - q); } return NaN; };
  near(zc(f), 30, 0.5);
});

test('offsetField + round: outer corners become arcs of the given radius, straight edges stay put', () => {
  const w = 120, h = 120, a = rect(w, h, 20, 20, 100, 100), d = signedField(a, w, h);
  const grown = offsetField(d, w, h, 5);
  near(grown[60 * w + 10]!, d[60 * w + 10]! - 5, 0.6);   // the same shape 5 px bigger
  const r = 16, rr = offsetField(offsetField(d, w, h, -r), w, h, r);
  // the corner pixel was 1 px inside the square; rounded, it is now outside the arc
  expect(d[20 * w + 20]!).toBeLessThan(0);
  const cornerD = Math.hypot(20.5 - (20 + r), 20.5 - (20 + r)) - r;
  near(rr[20 * w + 20]!, cornerD, 1.2);   // (unrounded it would be −0.5)
  near(rr[60 * w + 20]!, d[60 * w + 20]!, 0.6);          // mid-edge unchanged
  // liquidField's round option rounds (and only rounds)
  const f = liquidField(a, w, h, { round: r, edge: 1, deep: 1 });
  expect(f[22 * w + 22]!).toBeGreaterThan(0);
  expect(f[60 * w + 60]!).toBeLessThan(-30);
});

// a one-letter "word": a 40 x 100 bar with its ink centre at the origin, cell padded by 30
function fakeWord() {
  const pad = 30, iw = 40, ih = 100, w = iw + 2 * pad, h = ih + 2 * pad, a = rect(w, h, pad, pad, pad + iw, pad + ih);
  const L: WordLetter = { ch: 'l', tile: [0, 0, w, h], origin: [-iw / 2 - pad, -ih / 2 - pad], ink: [-iw / 2, -ih / 2, iw / 2, ih / 2], home: [0, 0], pivot: [pad + iw / 2, pad + ih / 2], field: liquidField(a, w, h) };
  return { letters: [L] };
}

test('wordSD / bottomAt / letterToWorld agree with the letter they describe', () => {
  const wd = fakeWord();
  expect(wordSD(wd, 0, 0, 0)).toBeLessThan(-10);
  expect(wordSD(wd, 0, 30, 0)).toBeGreaterThan(5);
  expect(wordSD(wd, 0, 500, 0)).toBe(200);
  expect(wordSD(wd, 3, 0, 0)).toBe(200);
  const b = bottomAt(wd, 0, 0)!;
  expect(Math.abs(b - 50)).toBeLessThanOrEqual(1.5);
  expect(bottomAt(wd, 0, 40)).toBeNull();
  const [x, y] = letterToWorld(wd, { i: 0, x: 500, y: 300, u: 0, sx: 2, sy: 0.5, a: 0 }, 10, 20);
  near(x, 520); near(y, 310);
  const [x2, y2] = letterToWorld(wd, { i: 0, x: 0, y: 0, u: 0, a: Math.PI / 2 }, 10, 0);
  near(x2, 0); near(y2, 10);
});

test('puddleStretch: squashes from the falling teardrop to the lens, never far below it', () => {
  expect(puddleStretch(0)).toBeLessThan(0.7);
  near(puddleStretch(5), 0.5, 1e-3);
  for (let t = 0; t < 2; t += 0.01) expect(puddleStretch(t)).toBeGreaterThan(0.5 - 0.2);
});

test('fallingDrop: hidden before release, touches the floor exactly at tLand, deterministic', () => {
  const o = { x: 300, tLand: 2, r: 40, u: 0.3, floor: 800 };
  expect(fallingDrop(goo(), 0, o)).toBe('before');
  const g = goo();
  expect(fallingDrop(g, 2 - 1e-4, o)).toBe('fall');
  const b = g.balls[0]!;
  near(b.y + b.r * b.s!, 800, 1);                 // its bottom on the floor
  const g2 = goo();
  expect(fallingDrop(g2, 2.5, o)).toBe('puddle');
  const p = g2.balls[0]!;
  near(p.y + p.r * p.s!, 801, 0.01);              // the lens rests on the contact line
  const h = 800 + 120, tf = Math.sqrt(2 * h / GRAVITY);
  expect(fallingDrop(goo(), 2 - tf - 1e-3, o)).toBe('before');
  expect(fallingDrop(goo(), 2 - tf + 1e-3, o)).toBe('fall');
});

test('splash: same seed, same splash at any t; a different seed differs; nothing before impact', () => {
  const o = { x: 600, tLand: 1, r: 50, u: 0.5, floor: 800, seed: 7, n: 6, spray: 3 };
  expect(goo().balls.length).toBe(0);
  const g0 = goo(); splash(g0, 0.99, o);
  expect(g0.balls.length + g0.segs.length).toBe(0);
  for (const t of [1.05, 1.2, 1.5]) {
    const a = goo(), b = goo(), c = goo();
    splash(a, t, o); splash(b, t, o); splash(c, t, { ...o, seed: 8 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  }
  // all thrown droplets have melted a while after landing
  const late = goo(); splash(late, 4, o);
  expect(late.balls.length + late.segs.length).toBe(0);
});

test('fling: lands on the floor at the time its launch asks for', () => {
  const T = 0.3, y0 = 600, vy = (0.5 * GRAVITY * T * T - (800 - 5 - y0)) / T;
  const g = goo(); fling(g, 1 + T + 0.2, { x0: 100, y0, vx: 200, vy, r: 5, u: 0, tEmit: 1, floor: 800, life: 1 });
  const b = g.balls[0]!;
  near(b.x, 100 + 200 * T, 0.5);
  expect(b.y + b.r * b.s!).toBeGreaterThan(799);
});

test('hop: merged goes 0 → 1 after the arrival, and the body travels from x0 to x1', () => {
  const o = { x0: 400, x1: 900, floor: 800, r: 40, u: 0.2, tc: 3 };
  expect(hop(goo(), 2, o).merged).toBe(0);
  const mid = hop(goo(), 3 - 0.17, o);
  expect(mid.x).toBeGreaterThan(500); expect(mid.x).toBeLessThan(800);
  expect(mid.y).toBeLessThan(800 - 40);           // in the air
  expect(hop(goo(), 3.05, o).merged).toBeGreaterThan(0);
  expect(hop(goo(), 3.5, o).merged).toBe(1);
  const g = goo(); hop(g, 3.5, o);
  expect(g.balls.length).toBe(0);                 // gone into its host
});

test('strand thins to a hair as k → 1', () => {
  const a = goo(), b = goo();
  strand(a, 0, 0, 100, 0, 20, 20, 0, 0.5); strand(b, 0, 0, 100, 0, 20, 20, 1, 0.5);
  expect(a.segs[0]!.rb).toBeCloseTo(17, 5);
  expect(b.segs[0]!.rb).toBeCloseTo(1, 5);
});

test('drip: swells, snaps, then lands on the floor at tLand', () => {
  const o = { x: 500, y: 400, floor: 800, u: 0.4, tStart: 1, tLand: 3, r: 16 };
  const tSnap = drip(goo(), 0, o);
  expect(tSnap).toBeGreaterThan(1); expect(tSnap).toBeLessThan(3);
  const g = goo(); drip(g, 3.8, { ...o, flat: 0.7 });
  const p = g.balls[0]!;
  near(p.y + p.r * p.s!, 800.5, 0.01);
  const pre = goo(); drip(pre, 3 - 1e-4, o);
  const f = pre.balls[0]!;
  expect(f.y + f.r * f.s!).toBeGreaterThan(780);
});

test('fizz: bubbles stay inside the ink and are deterministic', () => {
  const wd = fakeWord(), pose = { i: 0, x: 0, y: 0, u: 0.5 };
  for (const t of [0.3, 1.7, 4.2]) {
    const a = goo(), b = goo();
    fizz(a, t, wd, pose, { n: 6, seed: 3 }); fizz(b, t, wd, pose, { n: 6, seed: 3 });
    expect(a.bubbles).toEqual(b.bubbles);
    for (const q of a.bubbles) expect(wordSD(wd, 0, q.x, q.y)).toBeLessThan(-q.r);
  }
});

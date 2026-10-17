// bun test (from app/): the signed distance transform behind library/kit/sfx-shape.ts
import { expect, test } from 'bun:test';
import { signedDistance, fieldFromCoverage } from '../src/library/kit/sfx-shape';

function rng(seed: number) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

test('binary shapes: exact against brute force', () => {
  const r = rng(7);
  for (let trial = 0; trial < 20; trial++) {
    const w = 8 + Math.floor(r() * 40), h = 8 + Math.floor(r() * 40);
    const a = new Float32Array(w * h);
    // a few random blobs
    for (let b = 0; b < 3; b++) {
      const cx = r() * w, cy = r() * h, rad = 1 + r() * Math.min(w, h) / 3;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x - cx) ** 2 + (y - cy) ** 2 < rad * rad) a[y * w + x] = 1;
    }
    const d = signedDistance(a, w, h, false);
    const ins: [number, number][] = [], out: [number, number][] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) (a[y * w + x] ? ins : out).push([x, y]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const inside = a[y * w + x] === 1;
      const set = inside ? out : ins;
      let best = Infinity;
      for (const [px, py] of set) best = Math.min(best, (px - x) ** 2 + (py - y) ** 2);
      const want = set.length ? (inside ? -Math.sqrt(best) : Math.sqrt(best)) : (inside ? -Math.sqrt(1e20) : Math.sqrt(1e20));
      if (set.length) expect(Math.abs(d[y * w + x]! - want)).toBeLessThan(1e-4);
    }
  }
});

test('anti-aliased circle, no supersampling: within 0.6 texel near the edge', () => {
  const N = 128, cx = 61.3, cy = 66.8, R = 37.4, S = 8;
  const a = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let c = 0;
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const px = x + (i + 0.5) / S, py = y + (j + 0.5) / S;
      if ((px - cx) ** 2 + (py - cy) ** 2 < R * R) c++;
    }
    a[y * N + x] = c / (S * S);
  }
  const d = signedDistance(a, N, N, false);
  let worst = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const truth = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - R;
    if (Math.abs(truth) < 6) worst = Math.max(worst, Math.abs(d[y * N + x]! - truth));
  }
  console.log(`worst error near the edge: ${worst.toFixed(3)} texel`);
  expect(worst).toBeLessThan(0.6);
});

test('supersampled field (fieldFromCoverage, 4x): within 0.15 texel of a circle near the edge', () => {
  const n = 128, ss = 4, N = n * ss, cx = 0.479, cy = 0.522, R = 0.29; // field units
  const a = new Float32Array(N * N), S = 4;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let c = 0;
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const px = (x + (i + 0.5) / S) / N, py = (y + (j + 0.5) / S) / N;
      if ((px - cx) ** 2 + (py - cy) ** 2 < R * R) c++;
    }
    a[y * N + x] = c / (S * S);
  }
  const f = fieldFromCoverage(a, n, ss);
  let worst = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const truth = Math.hypot((x + 0.5) / n - cx, (y + 0.5) / n - cy) - R;
    if (Math.abs(truth) < 6 / n) worst = Math.max(worst, Math.abs(f[y * n + x]! - truth) * n);
  }
  console.log(`supersampled: worst error near the edge ${worst.toFixed(3)} texel`);
  expect(worst).toBeLessThan(0.15);
});

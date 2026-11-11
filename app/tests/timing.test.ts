// 逐元素快门、按拍步进的时间、摄影表、手放抖动：bun test tests/timing.test.ts
import { expect, test } from 'bun:test';
import { shutterT, stepT, exposure, handJitter } from '../src/engine/util';
import { SUBFRAME } from '../src/engine/subframe';

const near = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

test('shutterT: crisp elements ignore the sub-frame spread', () => {
  near(shutterT(1.234), 1.234); // preview: unchanged
  SUBFRAME.frame = 2;
  try {
    near(shutterT(2.004, 0), 2); near(shutterT(2.004, 1), 2.004); near(shutterT(2.004, 0.5), 2.002);
  } finally { SUBFRAME.frame = NaN; }
});

test('stepT holds each drawing for whole frames at a rate that divides 60', () => {
  const held = Array.from({ length: 30 }, (_, i) => stepT(i / 60, 12));
  // every drawing lasts exactly 5 frames
  for (let i = 0; i < 30; i++) near(held[i]!, Math.floor(i / 5) / 12);
  near(stepT(1.05, 12, 1), 1); near(stepT(1.09, 12, 1), 1.0833333333333333, 1e-9);
});

test('exposure: on ones, then twos, restarting at each entry', () => {
  const sheet = [[0, 30], [1, 12]] as const;
  near(exposure(-0.5, sheet), -0.5);
  near(exposure(0.05, sheet), 1 / 30);
  near(exposure(1.0, sheet), 1); near(exposure(1.08, sheet), 1); near(exposure(1.09, sheet), 1 + 1 / 12);
});

test('handJitter: steady within a step, new at the next, within amp', () => {
  const a = handJitter(0.51, 6, 2, 7), b = handJitter(0.6, 6, 2, 7), c = handJitter(0.67, 6, 2, 7);
  expect(a).toEqual(b); expect(c).not.toEqual(b);
  for (const v of [...a, ...c]) expect(Math.abs(v)).toBeLessThanOrEqual(2);
});

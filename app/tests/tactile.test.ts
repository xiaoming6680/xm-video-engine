// 实物感（影子随抬起高度、拍落余振）的纯函数测试：bun test tests/tactile.test.ts
import { expect, test } from 'bun:test';
import { liftShadow, slap } from '../src/library/kit/tactile';

const near = (a: number, b: number, eps = 1e-3) => expect(Math.abs(a - b)).toBeLessThan(eps);

test('liftShadow: the higher, the further, softer and fainter', () => {
  const lo = liftShadow(0), hi = liftShadow(1);
  expect(lo).toEqual([3, 5, 6, 0.26]);
  expect(hi[0]).toBeGreaterThan(lo[0]); expect(hi[1]).toBeGreaterThan(lo[1]);
  expect(hi[2]).toBeGreaterThan(lo[2]); expect(hi[3]).toBeLessThan(lo[3]);
  expect(liftShadow(-1)).toEqual(lo); // never below the table
});

test('slap: absent, falls from the camera, lands, rings down', () => {
  expect(slap(0.99, 1.2).visible).toBe(false);
  const enter = slap(1.0, 1.2);
  near(enter.scale, 1.3); near(enter.lift, 1); near(enter.rot, 0.1);
  // accelerating: less than half way down at half the fall
  expect(slap(1.1, 1.2).lift).toBeGreaterThan(0.5);
  const land = slap(1.2, 1.2);
  near(land.lift, 0); near(land.scale, 0.972); // squashed on impact
  near(slap(1.2 + 1 / 9, 1.2).scale, 1.0092, 5e-4); // rebound half a ring later
  near(slap(2.5, 1.2).scale, 1, 1e-4); near(slap(2.5, 1.2).rot, 0, 1e-4);
});

test('slap: continuous through the landing', () => {
  const a = slap(1.2 - 1e-4, 1.2), b = slap(1.2, 1.2);
  near(a.lift, b.lift, 2e-3); near(a.rot, b.rot, 2e-3);
});

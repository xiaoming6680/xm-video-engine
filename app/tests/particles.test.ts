// 粒子的出生时刻（engine/particles.ts birthTimes）：数量、范围、爆发、确定性：bun test tests/particles.test.ts
import { expect, test } from 'bun:test';
import { birthTimes } from '../src/engine/particles';

test('a steady rate gives rate × duration births inside the window, sorted, the same every time', () => {
  const b = birthTimes({ rate: 50, from: 1, to: 3, seed: 2 });
  expect(b.length).toBe(100);
  expect(b[0]!).toBeGreaterThanOrEqual(1); expect(b[b.length - 1]!).toBeLessThan(3);
  for (let i = 1; i < b.length; i++) expect(b[i]!).toBeGreaterThanOrEqual(b[i - 1]!);
  expect(birthTimes({ rate: 50, from: 1, to: 3, seed: 2 })).toEqual(b);
  expect(birthTimes({ rate: 50, from: 1, to: 3, seed: 3 })).not.toEqual(b);
});

test('a rate curve follows its integral; bursts add their count at their time; max caps the total', () => {
  // 0 for the first second, 200/s for the next: about 200 births, none before 1 s
  const b = birthTimes({ rate: (t) => (t < 1 ? 0 : 200), from: 0, to: 2 });
  expect(Math.abs(b.length - 200)).toBeLessThanOrEqual(2);
  expect(b[0]!).toBeGreaterThanOrEqual(1 - 1 / 240);
  const k = birthTimes({ rate: 0, bursts: [{ t: 0.5, count: 30 }, { t: 2, count: 10 }] });
  expect(k.length).toBe(40);
  expect(k.filter((t) => Math.abs(t - 0.5) < 1e-3).length).toBe(30);
  const capped = birthTimes({ rate: 1000, from: 0, to: 10, max: 500 });
  expect(capped.length).toBe(500);
});

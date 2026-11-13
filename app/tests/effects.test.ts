// 效果栈的纯函数测试（engine/effects.ts）：曲线表、带点参数随留边平移、留边：bun test tests/effects.test.ts
import { expect, test } from 'bun:test';
import { curveTable, effectPad, shiftEffect, type Effect } from '../src/engine/effects';

const near = (a: number, b: number, eps = 1e-4) => expect(Math.abs(a - b)).toBeLessThan(eps);

test('curves: no points is the identity, the ends default to [0, 0] and [1, 1]', () => {
  const id = curveTable(undefined);
  for (const i of [0, 64, 128, 200, 255]) near(id[i]!, i / 255);
  // a lifted black point given explicitly stays; the white end is added
  const lift = curveTable([[0, 0.2]]);
  near(lift[0]!, 0.2); near(lift[255]!, 1);
});

test('curves: passes through its points, monotone points give a monotone table without overshoot', () => {
  const pts = [[0.25, 0.1], [0.5, 0.5], [0.75, 0.9]] as const;
  const t = curveTable(pts, 1025);
  for (const [x, y] of pts) near(t[Math.round(x * 1024)]!, y, 1e-3);
  for (let i = 1; i < t.length; i++) expect(t[i]!).toBeGreaterThanOrEqual(t[i - 1]! - 1e-6);
  // a flat stretch stays flat (no bump between two equal values)
  const flat = curveTable([[0.3, 0.4], [0.7, 0.4]], 1001);
  for (let i = 300; i <= 700; i++) near(flat[i]!, 0.4, 1e-6);
  // out-of-range outputs clamp
  const hi = curveTable([[0.5, 1.4]]);
  expect(Math.max(...hi)).toBeLessThanOrEqual(1);
});

test('shiftEffect moves the points (centres, a flare source) and leaves offsets alone', () => {
  const tw = shiftEffect({ type: 'twirl', angle: 90, center: [10, 20] }, 5, 7) as Extract<Effect, { type: 'twirl' }>;
  expect(tw.center).toEqual([15, 27]);
  const fl = shiftEffect({ type: 'lensFlare', position: [1, 2], center: [3, 4] }, 10, 10) as Extract<Effect, { type: 'lensFlare' }>;
  expect(fl.position).toEqual([11, 12]); expect(fl.center).toEqual([13, 14]);
  // transform.position is an offset: only the anchor moves
  const tr = shiftEffect({ type: 'transform', position: [30, 0], anchor: [50, 50] }, 4, 4) as Extract<Effect, { type: 'transform' }>;
  expect(tr.position).toEqual([30, 0]); expect(tr.anchor).toEqual([54, 54]);
  // no centre given: the effect keeps using the content centre, nothing to move
  const bu = shiftEffect({ type: 'bulge', amount: 0.5 }, 9, 9);
  expect(bu).toEqual({ type: 'bulge', amount: 0.5 });
  const blur: Effect = { type: 'blur', radius: 3 };
  expect(shiftEffect(blur, 1, 1)).toBe(blur);
});

test('effectPad: glows and moves get room, light rays scale with the layer, colour effects need none', () => {
  expect(effectPad({ type: 'outerGlow', size: 20 })).toBe(30);
  expect(effectPad({ type: 'bend', amount: -40 })).toBe(40);
  near(effectPad({ type: 'displacementMap', map: null as never, amount: 10 }), 10 * Math.SQRT2);
  expect(effectPad({ type: 'meshWarp', grid: [[[0, 0], [3, 4]], [[0, 0], [0, 0]]] })).toBe(5);
  expect(effectPad({ type: 'lightRays', length: 0.5 })).toBe(0);
  near(effectPad({ type: 'lightRays', length: 0.5 }, [300, 400]), 250);
  expect(effectPad({ type: 'curves', rgb: [[0.5, 0.6]] })).toBe(0);
  expect(effectPad({ type: 'linearWipe', completion: 0.5 })).toBe(0);
});

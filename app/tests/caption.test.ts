// 综艺花字动作和 FUI 字的纯函数测试：bun test tests/caption.test.ts
import { expect, test } from 'bun:test';
import { damped, popChar, popOut, idleWiggle, beatHop, slamIn, boil, burstPoints, focusQuads } from '../src/library/kit/textfx';
import { tier, TIER, flick, decode, rollDigits, hitT } from '../src/library/kit/termhud';
import { SUBFRAME } from '../src/engine/subframe';

const near = (a: number, b: number, eps = 1e-3) => expect(Math.abs(a - b)).toBeLessThan(eps);
/** Pretend the engine is averaging the frame at time f (as Engine.render does), run fn, restore. */
function inFrame<T>(f: number, fn: () => T): T {
  const prev = SUBFRAME.frame;
  SUBFRAME.frame = f;
  try { return fn(); } finally { SUBFRAME.frame = prev; }
}

test('damped: from rest, peaks 1.15 at frame 5 (30 fps), settles', () => {
  expect(damped(0)).toBe(0);
  expect(damped(-1)).toBe(0);
  near(damped(5 / 30), 1.15, 0.005);
  // the peak: higher than the frames either side
  expect(damped(5 / 30)).toBeGreaterThan(damped(4 / 30));
  expect(damped(5 / 30)).toBeGreaterThan(damped(6 / 30));
  near(damped(8 / 30), 1, 0.02);
  near(damped(2), 1, 1e-4);
  // starts at rest: tiny after a tiny step (no kink)
  expect(damped(1e-3)).toBeLessThan(1e-3);
});

test('popChar: absent before, springs in from nothing, drop and turn settle, idles, pops out', () => {
  expect(popChar(0.99, 1).visible).toBe(false);
  const p0 = popChar(1, 1, { drop: 90, r0: 0.28 });
  expect(p0.visible).toBe(true);
  near(p0.s, 0); near(p0.dy, -90); near(p0.rot, 0.28);
  near(popChar(1 + 5 / 30, 1).s, 1.15, 0.01);
  // settled: scale ~1, drop and turn gone, only the idle sway left (≤ 1.8° and ≤ 3 px, breathing ≤ 1.2 %)
  for (const t of [2, 2.3, 2.71, 3.4]) {
    const p = popChar(t, 1, { drop: 90, r0: 0.28 });
    expect(Math.abs(p.rot)).toBeLessThanOrEqual((1.8 * Math.PI) / 180 + 1e-3);
    expect(Math.abs(p.dy)).toBeLessThanOrEqual(3 + 0.05);
    near(p.s, 1, 0.013);
  }
  // pop-out at t1: swells, then gone after 0.17 s
  expect(popChar(3 + 0.03, 1, { t1: 3 }).s).toBeGreaterThan(popChar(2.99, 1, { t1: 3 }).s);
  expect(popChar(3.2, 1, { t1: 3 }).visible).toBe(false);
});

test('popOut: 1 → 1.12 → 0 over 0.17 s', () => {
  expect(popOut(0.9, 1)).toBe(1);
  near(popOut(1 + 0.3 * 0.17, 1), 1.12);
  near(popOut(1 + 0.1699, 1), 0, 0.005);
  near(popOut(1.17, 1), 0, 1e-9);
  expect(popOut(1.2, 1)).toBe(0);
});

test('idleWiggle: still right after landing, then sways at 1.15 Hz', () => {
  const a = idleWiggle(1.1, 1);
  near(a.rot, 0, 1e-12); near(a.dy, 0, 1e-12); expect(a.s).toBe(1);
  // a full period later the sway repeats
  const p = idleWiggle(3, 1), q = idleWiggle(3 + 1 / 1.15, 1);
  near(p.rot, q.rot, 1e-6); near(p.dy, q.dy, 1e-6);
});

test('beatHop: crouch before the beat, airborne after, lands with a squash, still between hops', () => {
  const beat = 2;
  expect(beatHop(beat - 0.035, [beat]).sq).toBeGreaterThan(0); // anticipation squash
  near(beatHop(beat + 0.12, [beat], { height: 40 }).dy, -40, 0.5); // apex half way through 0.24 s of air
  expect(beatHop(beat + 0.24, [beat]).sq).toBeGreaterThan(0.1); // landing squash
  const rest = beatHop(beat + 0.6, [beat]);
  near(rest.dy, 0, 1e-12); near(rest.sq, 0, 1e-12);
  // the stagger shifts the whole hop
  near(beatHop(beat + 0.12 + 0.1, [beat], { delay: 0.1 }).dy, beatHop(beat + 0.12, [beat]).dy, 1e-9);
});

test('slamIn: falls 1.9× → 1× in 0.1 s (inQuad), squashes to 0.92 on the hit, rings down', () => {
  expect(slamIn(0.89, 1).visible).toBe(false);
  const enter = slamIn(0.9, 1);
  expect(enter.visible).toBe(true); near(enter.s, 1.9); near(enter.a, 0);
  near(slamIn(0.95, 1).s, 1.9 - 0.9 * 0.25); // accelerating: a quarter of the way at half time
  near(slamIn(1 - 1e-6, 1).s, 1, 1e-4);
  near(slamIn(1, 1).s, 0.92); // the deliberate jump on the impact frame
  near(slamIn(1 + Math.PI / 44, 1).s, 1 + 0.08 * Math.exp(-16 * Math.PI / 44)); // half a ring later: over 1
  near(slamIn(2, 1).s, 1, 1e-4);
  near(slamIn(0.95, 1, { rot0: 0.2 }).rot, 0.1);
});

test('boil: 12 drawings a second, looping, held over a frame’s whole shutter', () => {
  expect(boil(0)).toBe(0);
  expect(boil(1 / 12 + 1e-4)).toBe(1);
  expect(boil(1, 12)).toBe(12);
  expect(boil(1, 12, 3)).toBe(0);
  expect(boil(1 + 1 / 12 + 1e-4, 12, 3)).toBe(1);
  // inside a motion-blurred frame every sub-frame shows the drawing of the frame's own time
  inFrame(1 / 12 - 1 / 600, () => {
    expect(boil(1 / 12 - 1 / 600 - 0.003)).toBe(boil(1 / 12 - 1 / 600 + 0.003));
  });
});

test('burstPoints / focusQuads: seeded, same seed same drawing, new seed new drawing', () => {
  const a = burstPoints(400, 200, 15, 7), b = burstPoints(400, 200, 15, 7), c = burstPoints(400, 200, 15, 8);
  expect(a.length).toBe(30);
  expect(a).toEqual(b);
  expect(a).not.toEqual(c);
  // spikes out, notches in
  const r = (i: number) => Math.hypot(a[i]!.x / 400, a[i]!.y / 200);
  for (let i = 0; i < 30; i += 2) expect(r(i)).toBeGreaterThan(r(i + 1));
  const q = focusQuads(3, { n: 50, rIn: [100, 200], rOut: 900, aspect: 1 });
  expect(q.length).toBe(50);
  for (const [tip, b1, b2] of q) {
    const ri = Math.hypot(tip.x, tip.y);
    expect(ri).toBeGreaterThanOrEqual(100 - 1e-6); expect(ri).toBeLessThanOrEqual(200 + 1e-6);
    near(Math.hypot(b1.x, b1.y), 900, 1e-6); near(Math.hypot(b2.x, b2.y), 900, 1e-6);
  }
  expect(focusQuads(3, { n: 50 })).toEqual(focusQuads(3, { n: 50 }));
});

test('tier: holds the first level, eases through each switch over ±0.12 s', () => {
  const keys = [[0, TIER.mid], [2, TIER.hi], [4, TIER.lo]] as const;
  expect(tier(-5, keys)).toBe(TIER.mid);
  near(tier(1.8, keys), TIER.mid, 1e-9);
  near(tier(2, keys), (TIER.mid + TIER.hi) / 2, 1e-9);
  near(tier(2.2, keys), TIER.hi, 1e-9);
  near(tier(9, keys), TIER.lo, 1e-9);
  expect(tier(1, [])).toBe(1);
});

test('flick: 0, then 0.7 0.1 1 0.45, then on', () => {
  expect(flick(0.99, 1)).toBe(0);
  expect([0, 1, 2, 3].map((k) => flick(1 + (k + 0.5) / 30, 1))).toEqual([0.7, 0.1, 1, 0.45]);
  expect(flick(1.2, 1)).toBe(1);
});

test('decode: empty before, same length while scrambling, resolved chars stay, the text at the end', () => {
  const s = 'SIGNAL ANALYSIS';
  expect(decode(0.99, 1, s)).toBe('');
  expect(decode(1 + 1 / 6, 1, s)).toBe(s);
  let prev = '';
  for (let k = 0; k < 5; k++) {
    const d = decode(1 + (k + 0.5) / 30, 1, s, { id: 4, glyphs: '#' });
    expect([...d].length).toBe([...s].length);
    expect(d[6]).toBe(' '); // spaces never scramble
    // a character that has resolved stays resolved ('#' = still scrambled)
    if (prev) for (let i = 0; i < s.length; i++) if (prev[i] !== '#') expect(d[i]).toBe(s[i]);
    prev = d;
  }
  // deterministic, and labels with other ids scramble differently
  expect(decode(1.05, 1, s, { id: 4 })).toBe(decode(1.05, 1, s, { id: 4 }));
  expect(decode(1.01, 1, s, { id: 4 })).not.toBe(decode(1.01, 1, s, { id: 5 }));
  // order 1: strictly left to right
  const lr = decode(1 + 0.5 / 6, 1, 'ABCDEFGHIJ', { order: 1, glyphs: '#' });
  expect(lr).toMatch(/^[A-J]*#*$/);
});

test('rollDigits: only the digits roll; points, signs and units stay', () => {
  const r = rollDigits(1.05, 1, '-0350.5 KM', 3, 0.2);
  expect(r.length).toBe(10);
  expect(r[0]).toBe('-'); expect(r[5]).toBe('.'); expect(r.slice(7)).toBe(' KM');
  expect(r).toMatch(/^-\d{4}\.\d KM$/);
  expect(rollDigits(1.3, 1, '-0350.5 KM', 3, 0.2)).toBe('-0350.5 KM');
});

test('hitT: the impact frame is one instant; other frames keep their shutter', () => {
  // outside a multi-sample render: pass-through
  expect(hitT(12.004, [12])).toBe(12.004);
  inFrame(12, () => {
    expect(hitT(12.003, [12])).toBe(12);
    expect(hitT(11.997, [12])).toBe(12);
  });
  inFrame(12 + 1 / 60, () => {
    expect(hitT(12 + 1 / 60 + 0.002, [12])).toBe(12 + 1 / 60 + 0.002);
  });
});

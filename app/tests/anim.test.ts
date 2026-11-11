// 关键帧层、变形 / 路径、SVG 路径解析、角色绑定的纯函数测试：bun test tests/anim.test.ts
import { expect, test } from 'bun:test';
import {
  kf, kfv, kfc, kfLoop, bezier, E, spring, springRest, springVel, kick, pop, hops, stagger, lerpZoom, kfz, zoomPath, monotone, lead, holdClock,
} from '../src/library/kit/anim';
import {
  flatten, resample, Morph, PathWalk, circle, rect, area, ribbon, smoothPath, bounds, parts, SlotMorph, SLOTS, placeMatrix, mapPt, travel, OneLine,
  centroid,
} from '../src/library/kit/morph';
import { parsePathD } from '../src/library/kit/svg';
import { runPose, walkPose, POSES, AGE_BUILD, joints, blendPose, neckAt, type Pose, type Joints } from '../src/library/kit/rig';

const near = (a: number, b: number, eps = 1e-3) => expect(Math.abs(a - b)).toBeLessThan(eps);

test('kf hits its keys and holds outside', () => {
  const k = [[0, 0], [1, 10], [2, 0]] as const;
  near(kf(-1, k), 0); near(kf(0, k), 0); near(kf(1, k), 10); near(kf(2, k), 0); near(kf(5, k), 0);
});

test("kf 'auto' keeps speed through a key, 'ease' stops there", () => {
  const h = 1e-3;
  const auto = [[0, 0, 'auto'], [1, 10, 'auto'], [2, 20, 'auto']] as const;
  const v = (k: any, t: number) => (kf(t + h, k) - kf(t - h, k)) / (2 * h);
  near(v(auto, 1), 10, 0.05); // passes through the middle key at full speed
  const ease = [[0, 0], [1, 10, 'ease'], [2, 20]] as const;
  near(v(ease, 1), 0, 0.05); // comes to rest on it
  // speed is continuous across the key either way
  near(v(auto, 1 - 0.01), v(auto, 1 + 0.01), 0.5);
});

test("kf 'hold' jumps, 'lin' is linear", () => {
  const k = [[0, 0, 'hold'], [1, 5, 'lin'], [2, 15]] as const;
  near(kf(0.99, k), 0); near(kf(1.0, k), 5); near(kf(1.5, k), 10);
});

test('kfv and kfc', () => {
  const v = kfv(0.5, [[0, [0, 100]], [1, [10, 200]]]);
  near(v[0]!, 5, 1e-6); near(v[1]!, 150, 1e-6);
  expect(kfc(0, [[0, '#ff0000'], [1, '#0000ff']])).toBe('rgb(255,0,0)');
  expect(kfc(1, [[0, '#ff0000'], [1, '#0000ff']])).toBe('rgb(0,0,255)');
});

test('kfLoop wraps smoothly', () => {
  const k = [[0, 0], [0.25, 1], [0.5, 0], [0.75, -1]] as const;
  near(kfLoop(0, k), 0); near(kfLoop(1, k), 0); near(kfLoop(0.25, k), 1);
  near(kfLoop(0.999, k), kfLoop(-0.001, k), 1e-6);
});

test('bezier easing and spring', () => {
  const f = bezier(0.42, 0, 0.58, 1);
  near(f(0), 0); near(f(1), 1); near(f(0.5), 0.5, 1e-3);
  expect(E.out(0.2)).toBeGreaterThan(0.5); // fast start
  near(spring(0, 0, 0, 1), 0); near(spring(5, 0, 0, 1), 1, 1e-3);
});

test('flatten + resample + morph', () => {
  const sq = flatten([{ type: 'M', x: 0, y: 0 }, { type: 'L', x: 10, y: 0 }, { type: 'L', x: 10, y: 10 }, { type: 'L', x: 0, y: 10 }, { type: 'Z' }]);
  expect(sq.length).toBe(1);
  near(Math.abs(area(sq[0]!)), 100);
  const r = resample(sq[0]!, 40);
  expect(r.length).toBe(40);
  const m = new Morph([circle(0, 0, 50, 64)], [rect(-10, -10, 20, 20), rect(30, 30, 5, 5)], 80);
  expect(m.at(0).length).toBe(2);
  near(Math.abs(area(m.at(0)[0]!)), Math.PI * 2500, 120); // still the circle
  near(Math.abs(area(m.at(1)[0]!)), 400, 2);               // the big square
  near(Math.abs(area(m.at(0)[1]!)), 0, 1e-6);              // the extra one grows from a point
});

test('PathWalk positions and slices', () => {
  const w = new PathWalk([[{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 0, y: 5 }, { x: 0, y: 15 }]]);
  near(w.total, 20);
  const p = w.at(15);
  near(p.x, 0); near(p.y, 10); expect(p.stroke).toBe(1);
  const s = w.slice(5, 12);
  expect(s.length).toBe(2);
  near(s[0]![0]!.x, 5); near(s[1]![s[1]!.length - 1]!.y, 7);
});

test('ribbon and smoothPath', () => {
  const rb = ribbon([{ x: 0, y: 0 }, { x: 100, y: 0 }], 10, 2);
  const b = bounds(rb);
  near(b.h, 10, 1e-6);
  const sp = smoothPath([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }], 8);
  expect(sp.length).toBe(17);
  near(sp[8]!.x, 10); near(sp[8]!.y, 10);
});

test('parsePathD: relative, shorthand and arcs', () => {
  const c = parsePathD('m10 10 h20 v20 h-20 z');
  expect(c.map((x) => x.type).join('')).toBe('MLLLZ');
  const s = flatten(parsePathD('M0 0 C10 0 10 10 0 10 S-10 20 0 20'), 1);
  expect(s[0]!.length).toBeGreaterThan(10);
  const a = flatten(parsePathD('M-50 0 A50 50 0 1 0 50 0 A50 50 0 1 0 -50 0 Z'), 1);
  near(Math.abs(area(a[0]!)), Math.PI * 2500, 60);
  const packed = parsePathD('M0 0a10 10 0 0110 10'); // packed arc flags
  expect(packed.length).toBeGreaterThan(1);
});

test('rig: run cycle loops, contact poses land the foot', () => {
  const a = runPose(0), b = runPose(1);
  for (const k of Object.keys(a) as (keyof typeof a)[]) near(a[k], b[k], 1e-6);
  const j = joints(runPose(0), 100);
  expect(j.footA.x).toBeGreaterThan(0);       // front foot ahead of the hip on contact
  expect(j.head.y).toBeLessThan(j.hip.y);      // head above the hip
  const mid = blendPose(POSES.crouch, POSES.launch, 0.5);
  near(mid.lean, (POSES.crouch.lean + POSES.launch.lean) / 2);
});

test('rig: walk cycle loops, mirrors at half, never leaves the ground', () => {
  const a = walkPose(0), b = walkPose(1), h = walkPose(0.5);
  for (const k of Object.keys(a) as (keyof Pose)[]) near(a[k], b[k], 1e-6);
  near(h.hipA, a.hipB, 1e-6); near(h.shA, a.shB, 1e-6); // the second step is the first one mirrored
  // the lower foot hardly rises over the cycle (always one foot down); a sprint has flight
  const lowFootRange = (f: (u: number) => Pose) => {
    const ys = Array.from({ length: 80 }, (_, i) => { const j = joints(f(i / 80), 100); return Math.max(j.footA.y, j.footB.y); });
    return Math.max(...ys) - Math.min(...ys);
  };
  expect(lowFootRange(walkPose)).toBeLessThan(6);
  expect(lowFootRange(runPose)).toBeGreaterThan(15);
});

test('rig: hand-set poses read as named', () => {
  const up = joints(POSES.reachUp, 100);
  expect(up.handA.y).toBeLessThan(up.head.y - up.headR);        // hand above the head
  const bh = joints(POSES.behind, 100);
  expect(bh.handA.x).toBeLessThan(0); expect(bh.handB.x).toBeLessThan(0); // hands behind the back
  const ph = joints(POSES.phone, 100);
  expect(ph.handA.x).toBeGreaterThan(10); expect(ph.handA.y).toBeLessThan(ph.hip.y); // held up in front
  expect(ph.head.x).toBeGreaterThan(joints(POSES.stand, 100).head.x); // looking down at it
  const sit = joints(POSES.sit, 100);
  near(sit.kneeA.y, sit.hip.y, 5);                               // thigh level with the seat
  const tall = (j: Joints) => Math.max(j.footA.y, j.footB.y) - (j.head.y - j.headR);
  expect(tall(joints(POSES.curl, 100))).toBeLessThan(tall(joints(POSES.stand, 100)) * 0.6); // curled up small
  expect(joints(POSES.slump, 100).head.x).toBeGreaterThan(joints(POSES.stand, 100).head.x);
});

test('rig: build defaults to the original adult, ages change proportions', () => {
  // no build = AGE_BUILD.adult = the original rig: straight back, neck 0.33·s from the hip
  const p = runPose(0.3), a = joints(p, 100), b = joints(p, 100, AGE_BUILD.adult);
  near(a.neck.x, Math.sin(p.lean) * 33, 1e-9); near(a.neck.y, p.drop * 100 - Math.cos(p.lean) * 33, 1e-9);
  near(a.mid!.x, (a.hip.x + a.neck.x) / 2, 1e-9); near(a.mid!.y, (a.hip.y + a.neck.y) / 2, 1e-9);
  for (const k of ['head', 'handA', 'footB'] as const) { near(a[k].x, b[k].x, 1e-9); near(a[k].y, b[k].y, 1e-9); }
  const tall = (j: Joints) => Math.max(j.footA.y, j.footB.y) - (j.head.y - j.headR);
  const ad = joints(POSES.stand, 100), kid = joints(POSES.stand, 100, AGE_BUILD.child), baby = joints(POSES.stand, 100, AGE_BUILD.baby);
  expect(tall(baby)).toBeLessThan(tall(kid)); expect(tall(kid)).toBeLessThan(tall(ad));
  expect(baby.headR / tall(baby)).toBeGreaterThan((1.5 * ad.headR) / tall(ad)); // big head for the body
  // an old body stoops: the upper back bends further forward than the lower, the head ends up well ahead
  const old = joints(POSES.stand, 100, AGE_BUILD.old);
  const ang = (from: { x: number; y: number }, to: { x: number; y: number }) => Math.atan2(to.x - from.x, from.y - to.y);
  expect(ang(old.mid!, old.neck) - ang(old.hip, old.mid!)).toBeGreaterThan(0.3);
  expect(old.head.x - ad.head.x).toBeGreaterThan(10);
  const n = neckAt(10, 20, 100, POSES.stand, { build: AGE_BUILD.old });
  near(n.x, 10 + old.neck.x); near(n.y, 20 + old.neck.y);
});

// ---------- MG motion ----------

test('springRest starts at rest, springVel is its derivative, kick rings down', () => {
  near(springRest(0), 0); near(springRest(5), 1, 1e-4);
  const h = 1e-4;
  for (const t of [0.05, 0.2, 0.6]) near((springRest(t + h) - springRest(t - h)) / (2 * h), springVel(t), 1e-3);
  near((springRest(2 * h) - springRest(h)) / h, 0, 0.05); // zero velocity at release (util springStep does not have this)
  near(kick(1, 1), 0); near(kick(0.5, 1), 0);
  expect(kick(1 + 1 / (4 * 3), 1, 3, 0.35)).toBeGreaterThan(0.4); // swings out a quarter period later
  near(kick(4, 1), 0, 1e-3);
});

test('pop: grows tall while fast, pinned to exactly 1 after `pin`', () => {
  expect(pop(0.9, 1).s).toBe(0);
  const fast = pop(1.05, 1);
  expect(fast.sy).toBeGreaterThan(fast.sx); // stretched along the growth
  const done = pop(1 + 0.9, 1, { pin: 0.9 });
  expect(done.s).toBe(1); expect(done.k).toBe(0); expect(done.sx).toBe(1);
  expect(pop(3, 1).sy).toBe(1);
  expect(pop(1.3, 1, { squash: 0 }).k).toBe(0);
});

test('hops: wind-up squash, parabola with apex, landing jolt, ends on target', () => {
  const A = { x: 0, y: 0 }, B = { x: 300, y: 0 };
  const legs = [{ to: B, t0: 1, t1: 1.5, height: 120 }];
  const rest = hops(0.5, A, legs, { r: 30 });
  near(rest.x, 0); near(rest.y, 0); near(rest.along, 1); expect(rest.air).toBe(false);
  const wound = hops(0.999, A, legs, { r: 30 });
  expect(wound.along).toBeLessThan(0.72); expect(wound.across).toBeGreaterThan(1.15);
  near(wound.y, 30 * (1 - wound.along)); // squashed onto its base
  const mid = hops(1.25, A, legs);
  expect(mid.air).toBe(true); near(mid.x, 150); near(mid.y, -120); near(mid.angle, 0); // apex: only moving sideways
  near(mid.along, 1 + (600 / 5000) * 0.22); // stretch from the horizontal speed alone
  const rising = hops(1.1, A, legs);
  expect(rising.along).toBeGreaterThan(mid.along); near(rising.along * rising.across, 1, 1e-9); // faster: longer, area kept
  expect(rising.angle).toBeLessThan(-0.5); // pointing up along the climb
  const landed = hops(1.5 + 0.0575, A, legs);
  near(landed.x, 300); near(landed.along, 1 - 0.22 * 0.552, 0.01); // landing squash peaks ~58 ms in (kick 3.5 Hz, ζ 0.4)
  near(hops(3, A, legs).along, 1, 1e-3);
  // a drop (height 0): accelerating straight down
  const drop = [{ to: { x: 0, y: 500 }, t0: 0, t1: 1, height: 0, antic: 0 }];
  near(hops(0.5, { x: 0, y: -100 }, drop).y, -100 + 0.25 * 600); near(hops(0.5, { x: 0, y: -100 }, drop).x, 0);
});

test('stagger: by distance, by ring, clockwise around, seeded jitter', () => {
  const c = { x: 0, y: 0 };
  near(stagger(c, c), 0);
  near(stagger({ x: 500, y: 0 }, c, { speed: 1000 }), 0.5);
  near(stagger({ x: 100, y: 90 }, c, { ring: 100, gap: 0.1, metric: 'box' }), 0.1);
  near(stagger({ x: 200, y: -100 }, c, { ring: 100, gap: [0, 0.2, 0.3], metric: 'box' }), 0.3);
  near(stagger({ x: 400, y: 0 }, c, { ring: 100, gap: [0, 0.2, 0.3], metric: 'box' }), 0.5); // extrapolated
  const top = stagger({ x: 0, y: -100 }, c, { ring: 100, gap: 0, turn: 1 }), right = stagger({ x: 100, y: 0 }, c, { ring: 100, gap: 0, turn: 1 });
  near(top, 0); near(right, 0.25); // clockwise on screen from straight up
  const j = stagger({ x: 30, y: 40 }, c, { speed: 1e9, jitter: 0.02, seed: 3 });
  expect(j).toBeGreaterThanOrEqual(0); expect(j).toBeLessThan(0.02);
  expect(stagger({ x: 30, y: 40 }, c, { speed: 1e9, jitter: 0.02, seed: 3 })).toBe(j);
});

test('zoom in log space and the van Wijk zoom path', () => {
  near(lerpZoom(1, 4, 0.5), 2); near(kfz(0.5, [[0, 1], [1, 4, 'lin']]), 2);
  const a = { x: 0, y: 0, zoom: 2 }, b = { x: 6000, y: 1000, zoom: 1.5 };
  const p = zoomPath(a, b, 1.25);
  const p0 = p(0), p1 = p(1);
  near(p0.x, 0); near(p0.zoom, 2); near(p1.x, 6000); near(p1.y, 1000); near(p1.zoom, 1.5);
  near(p(1e-6).zoom, 2, 1e-3); near(p(1 - 1e-6).x, 6000, 0.05); // continuous at the ends
  expect(p(0.5).zoom).toBeLessThan(0.6); // pulls well out on the way
  expect(zoomPath(a, b, 0.85)(0.5).zoom).toBeGreaterThan(p(0.5).zoom); // lower rho pulls out less
  // pan along the line between the centres, monotonic
  let prev = -1;
  for (let u = 0; u <= 1; u += 0.05) { const v = p(u); expect(v.x).toBeGreaterThanOrEqual(prev - 1e-6); prev = v.x; near(v.y / 1000, v.x / 6000, 1e-6); }
  // same centre: a pure zoom, steady in log space
  const z = zoomPath({ x: 5, y: 5, zoom: 1 }, { x: 5, y: 5, zoom: 4 });
  near(z(0.5).zoom, 2, 1e-6); near(z(0.5).x, 5);
  expect(p.duration).toBeGreaterThan(0);
});

test('monotone spline: through the keys, no overshoot, repeated value holds', () => {
  const f = monotone([0, 1, 2, 3, 4], [0, 10, 10, 30, 31], 1.3, 0);
  near(f(0), 0); near(f(1), 10); near(f(3), 30); near(f(4), 31); near(f(-1), 0); near(f(9), 31);
  near(f(1.5), 10); // hold
  let prev = -Infinity;
  for (let x = 0; x <= 4; x += 0.01) { const v = f(x); expect(v).toBeGreaterThanOrEqual(prev - 1e-9); prev = v; }
  for (let x = 3; x <= 4; x += 0.01) expect(f(x)).toBeLessThanOrEqual(31 + 1e-9);
  const h = 1e-4;
  near((f(4) - f(4 - h)) / h, 0, 0.01); // comes to rest on the last key
});

test('lead looks ahead (not behind); holdClock pauses and catches up', () => {
  const target = (t: number) => ({ x: 100 * t, y: 0 });
  near(lead(target, 2, { lead: 0.08 }).x, 208, 1e-6); // constant speed: exactly lead s ahead
  const bend = (t: number) => ({ x: 100 * Math.max(0, t), y: 0 });
  expect(lead(bend, -0.1).x).toBeGreaterThan(0); // starts moving before the target does
  const holds = [[2, 2.5]] as const;
  near(holdClock(1, holds), 1); near(holdClock(5, holds), 5);
  const atHold = holdClock(2, holds);
  near(holdClock(2.3, holds), atHold, 1e-9); // stopped through the hold
  near(holdClock(2.5 + 0.5, holds), 3, 1e-9); // caught up exactly when the release ends
  let prev = -Infinity;
  for (let t = 1.5; t < 3.2; t += 0.002) { const c = holdClock(t, holds); expect(c).toBeGreaterThanOrEqual(prev - 1e-9); prev = c; }
  // slows to a stop before the hold: speed just before it is ~0
  near((holdClock(2, holds) - holdClock(2 - 0.005, holds)) / 0.005, 0, 0.01);
});

// ---------- slot morph ----------

const sunParts = () => parts({
  body: circle(0, 0, 100, 64),
  strokes: Array.from({ length: 8 }, (_, k) => {
    const a = -Math.PI / 2 + (k * Math.PI) / 4;
    return { pts: [{ x: Math.cos(a) * 130, y: Math.sin(a) * 130 }, { x: Math.cos(a) * 170, y: Math.sin(a) * 170 }], w: 16 };
  }),
});
const ringParts = () => parts({ body: rect(-120, -60, 240, 120), hole: circle(0, 0, 30, 32), shade: rect(0, -60, 120, 120) });

test('parts: fixed slots, empty slots parked at a point', () => {
  const s = sunParts(), r = ringParts();
  expect(s.body.length).toBe(SLOTS.body); expect(s.hole.length).toBe(SLOTS.hole); expect(s.shade.length).toBe(SLOTS.shade);
  expect(s.strokes.length).toBe(SLOTS.strokes); expect(s.strokes[3]!.pts.length).toBe(SLOTS.stroke);
  expect(area(s.body)).toBeGreaterThan(0); expect(area(r.hole)).toBeGreaterThan(0);
  expect(s.holeOn).toBe(false); expect(r.holeOn).toBe(true); expect(r.shadeOn).toBe(true);
  expect(r.strokes[0]!.w).toBe(0); near(r.strokes[0]!.pts[5]!.x, 0); near(r.strokes[0]!.pts[5]!.y, 0);
  const pin = parts({ body: circle(0, 0, 50), strokes: [{ x: 7, y: 9 }] });
  near(pin.strokes[0]!.pts[0]!.x, 7); near(pin.strokes[0]!.pts[0]!.y, 9); // a meaningful point
});

test('SlotMorph: A → circle → B, no folding on the way', () => {
  const A = sunParts(), B = ringParts();
  const m = new SlotMorph(A, B, { via: { x: 0, y: 0, r: 90 } });
  const a0 = m.at(0), a1 = m.at(1), mid = m.at(0.5);
  near(Math.abs(area(a0.body)), Math.abs(area(A.body)), 1); near(Math.abs(area(a1.body)), 240 * 120, 30);
  for (const p of mid.body) near(Math.hypot(p.x, p.y), 90, 1e-6); // exactly the circle at the middle
  near(mid.body.length, SLOTS.body);
  for (let u = 0; u <= 1; u += 0.05) expect(area(m.at(u).body)).toBeGreaterThan(0); // never turned inside out
  // strokes are pushed outside the circle while it passes, and the sun's rays (no partner) are gone by the middle
  for (const s of m.at(0.3).strokes) if (s.w > 0) for (const p of s.pts) expect(Math.hypot(p.x, p.y)).toBeGreaterThan(90 - 1e-6);
  for (const s of mid.strokes) expect(s.w).toBe(0);
  expect(mid.holeOn).toBe(true); near(Math.abs(area(mid.hole)), 0, 1e-6); // the hole regrows from its centre
  near(Math.abs(area(a1.hole)), Math.abs(area(B.hole)), 1e-3);
  // rays grow back out of the centre when morphing the other way
  const back = new SlotMorph(B, A).at(1);
  near(back.strokes[2]!.w, 16); near(centroid(back.strokes[2]!.pts).x, 150, 1);
  // the old Morph is untouched
  expect(new Morph([circle(0, 0, 50, 64)], [rect(-10, -10, 20, 20)], 80).at(1).length).toBe(1);
});

test('placeMatrix: area-keeping stretch, squash about the pivot; travel follows an arc', () => {
  const m = placeMatrix({ x: 10, y: 20, scale: 2, rot: 0.4, stretch: 1.3, dir: 0.7 });
  near(Math.abs(m[0] * m[3] - m[1] * m[2]), 4, 1e-9); // only the scale changes the area
  const q = placeMatrix({ x: 0, y: 0, squash: 0.2, pivot: { x: 0, y: 50 } });
  const pv = mapPt(q, { x: 0, y: 50 });
  near(pv.x, 0); near(pv.y, 50); // the base stays on the ground
  near(mapPt(q, { x: 10, y: 0 }).x, 12);
  const A = { x: 0, y: 0, scale: 1 }, B = { x: 400, y: 0, scale: 2 };
  const t0 = travel(0, A, B, { arc: { x: 0, y: -100 } }), tm = travel(0.5, A, B, { arc: { x: 0, y: -100 }, stretch: 0.12 });
  near(t0.x, 0); near(t0.stretch!, 1); near(tm.x, 200); near(tm.y, -50); near(tm.stretch!, 1.12); near(tm.scale!, 1.5);
  near(tm.dir!, 0, 1e-6); // moving sideways at the top of the arc
});

// ---------- one line ----------

test('OneLine: markers, timing with holds, pen slows into corners, glow fades', () => {
  const line = new OneLine([
    { name: 'run', pts: [{ x: 0, y: 0 }, { x: 400, y: 0 }] },
    { name: 'zig', pts: [{ x: 400, y: 0 }, { x: 420, y: -20 }, { x: 440, y: 0 }, { x: 460, y: -20 }, { x: 480, y: 0 }] },
    { name: 'run2', pts: [{ x: 480, y: 0 }, { x: 900, y: 0 }] },
  ], { step: 0.5 });
  near(line.total, 400 + 4 * Math.hypot(20, 20) + 420, 1e-3);
  near(line.markerS('zig'), 400); near(line.markerS('zig>'), 400 + 4 * Math.hypot(20, 20), 1e-3); near(line.markerS('run@0.5'), 200);
  for (let i = 0; i < line.n; i += 97) near(line.y[i]!, line.piece[i] === 1 ? line.y[i]! : 0, 1e-6); // no wobble: on the line
  line.timing([[0, 'run'], [1, 'run>'], [1.5, 'run>'], [3, 'run2>']]);
  expect(line.holds).toEqual([[1, 1.5]]);
  near(line.head(0), 0); near(line.head(1), 400, 0.5); near(line.head(1.3), 400, 0.5); near(line.head(3), line.total, 0.5);
  near(line.tip(1.2).x, 400, 1);
  // speed through the zigzag (corner-weighted) is lower than on the straight run after it
  const speed = (s: number) => {
    let lo = 1.5, hi = 3;
    for (let k = 0; k < 50; k++) { const m = (lo + hi) / 2; if (line.head(m) < s) lo = m; else hi = m; }
    return (line.head(lo + 0.002) - line.head(lo - 0.002)) / 0.004;
  };
  expect(speed(line.markerS('zig@0.5'))).toBeLessThan(speed(line.markerS('run2@0.2')) * 0.7);
  const i = line.index(200);
  expect(line.drawnAt(i)).toBeLessThan(0.5); // leaves the first key faster (startSlope 1.3)
  near(line.head(line.drawnAt(i)), line.s[i]!, 1);
  near(line.glow(i, line.drawnAt(i)), 1); near(line.glow(i, line.drawnAt(i) + 2), 0.4);
  const wob = new OneLine([{ name: 'plant', pts: [{ x: 0, y: 0 }, { x: 300, y: 0 }], wobble: 2 }]);
  expect(Math.max(...Array.from(wob.y, Math.abs))).toBeGreaterThan(0.3);
  expect(Math.max(...Array.from(wob.y, Math.abs))).toBeLessThan(2 * 1.2 + 1e-6);
});

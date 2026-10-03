// An FPV flight low over terrain (from Falling_Again; the user: 可以贴地超高速飞行；为了防止穿模摄像机运动太生硬).
// The ground is a height function (x, z) -> y passed in as `ground` / `h` (Falling_Again: its dunes). The camera rides a
// smooth line instead of being pushed out of the sand frame by frame: the route's ground is sampled every metre,
// a look-ahead max over it plus a clearance gives a safe height, and a Gaussian along the route smooths that into a
// line that starts climbing BEFORE a crest and dives into the trough after it, the way a pilot flies. Speed comes
// from a time profile (so the music can ramp it); the view leads along the line; roll follows the turn rate; the fov
// opens with speed.
import * as THREE from 'three';
/** Ground height at (x, z), world units. */
export type HeightFn = (x: number, z: number) => number;
const flat: HeightFn = () => 0;
import { clamp, lerp } from '../engine/util';
import type { CamPose } from '../engine/world';

export class FpvLine {
  /** Samples every DS metres: position and arclength. */
  private P: THREE.Vector3[] = [];
  readonly DS = 1;
  length = 0;
  constructor(way: [number, number][], o: { ground?: HeightFn; clear?: number; ahead?: number; behind?: number; lateral?: number; sigma?: number; lift?: (s: number) => number } = {}) {
    const duneH = o.ground ?? flat;
    const clear = o.clear ?? 3, ahead = o.ahead ?? 40, behind = o.behind ?? 12, lat = o.lateral ?? 3, sigma = o.sigma ?? 14;
    const curve = new THREE.CatmullRomCurve3(way.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
    const L = curve.getLength();
    const n = Math.max(2, Math.ceil(L / this.DS));
    const xz: THREE.Vector3[] = [], g: number[] = [];
    for (let i = 0; i <= n; i++) {
      const p = curve.getPointAt(i / n);
      const tan = curve.getTangentAt(i / n);
      const side = new THREE.Vector3(-tan.z, 0, tan.x);
      xz.push(p);
      g.push(Math.max(duneH(p.x, p.z), duneH(p.x + side.x * lat, p.z + side.z * lat), duneH(p.x - side.x * lat, p.z - side.z * lat)));
    }
    // safe height: the highest ground a little behind to well ahead, plus the clearance (and any planned lift)
    const safe = g.map((_, i) => {
      let m = -1e9;
      for (let k = Math.max(0, i - behind); k <= Math.min(n, i + ahead); k++) m = Math.max(m, g[k]!);
      return m + clear + (o.lift ? o.lift(i * (L / n)) : 0);
    });
    // smooth it along the route, then make sure smoothing never dipped it into the sand
    const sm = (a: number[], s: number) => {
      const r = Math.ceil(s * 3), w = Array.from({ length: 2 * r + 1 }, (_, k) => Math.exp(-((k - r) ** 2) / (2 * s * s)));
      return a.map((_, i) => { let acc = 0, ws = 0; for (let k = -r; k <= r; k++) { const j = Math.min(n, Math.max(0, i + k)); acc += a[j]! * w[k + r]!; ws += w[k + r]!; } return acc / ws; });
    };
    let y = sm(safe, sigma);
    for (let pass = 0; pass < 3; pass++) {
      y = y.map((v, i) => Math.max(v, g[i]! + clear * 0.75));
      y = sm(y, sigma * 0.5);
    }
    this.P = xz.map((p, i) => new THREE.Vector3(p.x, y[i]!, p.z));
    this.length = L;
  }
  at(s: number) {
    const x = clamp(s, 0, this.length) / this.length * (this.P.length - 1);
    const i = Math.min(this.P.length - 2, Math.floor(x));
    return this.P[i]!.clone().lerp(this.P[i + 1]!, x - i);
  }
  /** Unit direction of travel at s (over a few metres). */
  dir(s: number) { return this.at(s + 3).sub(this.at(s - 3)).normalize(); }
  /** Heading (rad, around +y) at s. */
  heading(s: number) { const d = this.dir(s); return Math.atan2(d.x, -d.z); }
}

/** A flight along a line: speed keys (time, m/s) integrated into distance; the pose leads along the line. */
export class Flight {
  private tab: { t: number; s: number }[] = [];
  constructor(public line: FpvLine, private speed: [number, number][], public t0: number, public t1: number, private o: { s0?: number; fov?: [number, number]; rollGain?: number; lookDown?: number } = {}) {
    let s = o.s0 ?? 0;
    for (let t = t0; t <= t1 + 0.5; t += 1 / 240) { this.tab.push({ t, s }); s += this.v(t) / 240; }
  }
  v(t: number) {
    const k = this.speed;
    if (t <= k[0]![0]) return k[0]![1];
    for (let i = 0; i < k.length - 1; i++) if (t < k[i + 1]![0]) { const u = (t - k[i]![0]) / (k[i + 1]![0] - k[i]![0]); const e = u * u * (3 - 2 * u); return lerp(k[i]![1], k[i + 1]![1], e); }
    return k[k.length - 1]![1];
  }
  s(t: number) {
    const tb = this.tab, x = (clamp(t, this.t0, this.t1 + 0.49) - this.t0) * 240, i = Math.min(tb.length - 2, Math.floor(x));
    return lerp(tb[i]!.s, tb[i + 1]!.s, x - i);
  }
  pose(t: number): CamPose {
    const s = this.s(t), v = this.v(t), L = this.line;
    const p = L.at(s);
    const lead = 14 + v * 0.32;
    const at = L.at(s + lead);
    at.y -= this.o.lookDown ?? 1.5;
    // bank into the turn: the turn rate (heading change per second) times a gain, clamped
    const yawRate = (L.heading(s + v * 0.15) - L.heading(s - v * 0.15)) / 0.3;
    // (positive roll = bank right: the right side of the horizon rises)
    const roll = clamp(yawRate * (this.o.rollGain ?? 0.35), -0.45, 0.45);
    const [f0, f1] = this.o.fov ?? [70, 96];
    const fov = lerp(f0, f1, clamp((v - 40) / 140));
    return { p, at, roll, fov };
  }
  /** World point `ahead` metres down the line from where the camera is at t, `lat` metres to its right, on the sand. */
  pointFrom(t: number, ahead: number, lat: number) {
    const s = this.s(t) + ahead, p = this.line.at(s), d = this.line.dir(s);
    const x = p.x - d.z * lat, z = p.z + d.x * lat;
    return { x, z };
  }
}

/**
 * A route that keeps to the troughs (the "gap shoot": dune walls rising on both sides, sky above). From `start`,
 * heading `heading` (rad, 0 = -z, positive = toward +x), every `step` metres it tries turns within +-maxTurn and
 * takes the one whose ground ahead (25, 50, 80 m) is lowest, pulled back toward the goal heading so it doesn't wander
 * off (`goal(d)`: a goal that changes along the way, to steer a long route round; `h`: the ground it reads, e.g. without
 * a feature the route must cross rather than avoid). Returns waypoints every `every` metres for an FpvLine.
 */
export function troughWay(start: [number, number], heading: number, length: number, o: { step?: number; maxTurn?: number; pull?: number; every?: number; bias?: number; goal?: (d: number) => number; h?: (x: number, z: number) => number } = {}): [number, number][] {
  const step = o.step ?? 6, maxTurn = o.maxTurn ?? 0.09, pull = o.pull ?? 0.9, every = o.every ?? 30, bias = o.bias ?? 0;
  const gH = o.h ?? flat;
  let [x, z] = start, h = heading;
  let goal = heading;
  const out: [number, number][] = [[x, z]];
  let since = 0;
  for (let d = 0; d < length; d += step) {
    if (o.goal) goal = o.goal(d);
    let best = h, bestC = Infinity;
    for (let k = -6; k <= 6; k++) {
      const hh = h + (k / 6) * maxTurn;
      const dx = Math.sin(hh), dz = -Math.cos(hh);
      let c = 0;
      for (const a of [25, 50, 80]) c += gH(x + dx * a, z + dz * a);
      c = c / 3 + pull * 40 * Math.abs(hh - goal) + bias * (hh - goal) * 40;
      if (c < bestC) { bestC = c; best = hh; }
    }
    h = best;
    x += Math.sin(h) * step; z -= Math.cos(h) * step;
    since += step;
    if (since >= every) { out.push([x, z]); since = 0; }
  }
  return out;
}

/** An orbit round `c`: angle a0 -> a1 (rad, 0 = +x, counter-clockwise from above), radius r0 -> r1, height (over the
 * highest sand on that circle) y0 -> y1, eased in/out; looks at c raised by `lookUp`, banked into the turn. */
export function orbitPose(t: number, o: { t0: number; t1: number; c: [number, number]; a0: number; a1: number; r0: number; r1: number; y0: number; y1: number; lookUp?: number; fov?: number; bank?: number; ground?: HeightFn }): CamPose {
  const duneH = o.ground ?? flat;
  const u = clamp((t - o.t0) / (o.t1 - o.t0));
  const e = u * u * (3 - 2 * u);
  const a = lerp(o.a0, o.a1, u), r = lerp(o.r0, o.r1, e);
  const x = o.c[0] + Math.cos(a) * r, z = o.c[1] + Math.sin(a) * r;
  let gmax = -1e9;
  for (let k = 0; k < 24; k++) { const b = a + ((k - 12) / 12) * 0.35; gmax = Math.max(gmax, duneH(o.c[0] + Math.cos(b) * r, o.c[1] + Math.sin(b) * r)); }
  const y = gmax + lerp(o.y0, o.y1, e);
  const gc = duneH(o.c[0], o.c[1]);
  const dir = Math.sign(o.a1 - o.a0) || 1;
  return {
    p: new THREE.Vector3(x, y, z),
    at: new THREE.Vector3(o.c[0], gc + (o.lookUp ?? 10), o.c[1]),
    roll: -dir * (o.bank ?? 0.22),
    fov: o.fov ?? 78,
  };
}

// 液态示例（?liquid）：第一滴从画面上方倒下来、拉成丝断开，四滴落在深紫影棚的地面上溅开；三滩跳进中间那滩融成一团，
// 被压成一排珠子，在强拍上弹成果冻字标（默认 "flow"，?liquid=drop 换成别的 2–8 个拉丁字母），字之间的黏丝拉断；
// 之后字随强拍果冻晃、气泡上升、头顶落一滴被吸进去、横笔下面挂的一滴断开落地激起波纹。倒影、接触压暗、投影都开着。
// kit/liquid.ts 的部件全用到了。动作都对在拍子上（timeOfBeat），换歌也跟着拍走；测试歌 120 BPM 时整段约 15 秒。
import type * as THREE from 'three';
import { Scene, type Cue, type Frame } from '../../engine/scene';
import { W } from '../../engine/gl';
import { F, measure } from '../../engine/type';
import { clamp, lerp, smoothstep, springStep, mulberry32, TAU } from '../../engine/util';
import { kf, kfp } from '../kit/anim';
import {
  LiquidPass, buildWord, goo, ball, fallingDrop, splash, hop, strand, recoil, drip, fizz, fling, bottomAt, wordSD,
  letterToWorld, puddleStretch, type WordSDF, type LetterPose,
} from '../kit/liquid';

const FY = 800, HOR = 724, MX = W / 2, SLOT = 0.55;
// four drops: x, radius, colour; the first is poured from above the frame, the last (the biggest) lands in the middle
const DROPS = [
  { x: 655, r: 50, u: 0.05, beat: 2, seed: 11 },
  { x: 1255, r: 44, u: 0.9, beat: 4, seed: 22 },
  { x: 395, r: 40, u: 0.3, beat: 5, seed: 33 },
  { x: MX + 6, r: 68, u: 0.6, beat: 8, seed: 44 },
];
// the three side puddles hop into the middle one, a beat apart; the last trails a bead on a thread that snaps
const HOPS = [{ who: 0, beat: 10 }, { who: 2, beat: 11 }, { who: 1, beat: 12 }];

/** Damped wobble after an event: 0 before, then sin(2π f t) decaying with time constant `tau`. */
const wob = (t: number, f: number, tau: number) => (t <= 0 ? 0 : Math.exp(-t / tau) * Math.sin(TAU * f * t));

export default class DemoLiquid extends Scene {
  private pass!: LiquidPass;
  private word!: WordSDF;
  private b0 = 0;
  /** Word placement: letter i's ink centre at rest, its ink bottom, colour, bead slot and bead half-width. */
  private home: { x: number; y: number; bot: number; u: number; slot: number; bx: number; hx: number }[] = [];
  private bridges: { i: number; y: number; xa: number; xb: number }[] = [];
  /** Where the drip hangs: letter, word coordinates, and its x in the world at rest (the ripple's centre). */
  private dripAt: { i: number; x: number; y: number; wx: number; r: number } | null = null;
  private target = 2;

  /** Song time of beat n counted from the scene's first beat. */
  private bt(n: number) { return this.ctx.audio.timeOfBeat(this.b0 + n); }

  override init() {
    this.b0 = Math.round(this.ctx.audio.beatAt(this.ctx.start));
    const q = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('liquid');
    const text = q && /^[A-Za-z]{2,8}$/.test(q) ? q : 'flow';
    const fam = F.archivo(100, 900), size = Math.round(clamp((880 / measure(text, fam, 100)) * 100, 160, 440));
    const word = (this.word = buildWord(text, fam, size, { tracking: size * 0.07, edge: 2.5, deep: 11 }));
    this.pass = new LiquidPass({ word });
    // the word stands on the floor: its lowest ink 3 px into the contact line, centred
    const ox = MX - (word.ink[0] + word.ink[2]) / 2, oy = FY + 3 - word.ink[3], n = word.letters.length;
    this.home = word.letters.map((L, i) => ({ x: ox + L.home[0], y: oy + L.home[1], bot: oy + L.ink[3], u: n > 1 ? lerp(0.04, 0.88, i / (n - 1)) : 0.5, slot: 0, bx: 0, hx: 0 }));
    for (const h of this.home) h.slot = MX + (h.x - MX) * SLOT;
    // beads tile the bar: each spans the midpoints to its neighbours (the end ones mirror their inner half)
    this.home.forEach((h, i) => {
      const a = i > 0 ? (this.home[i - 1]!.slot + h.slot) / 2 : NaN, b = i < n - 1 ? (h.slot + this.home[i + 1]!.slot) / 2 : NaN;
      const l = Number.isNaN(a) ? h.slot - (b - h.slot) : a, r = Number.isNaN(b) ? h.slot + (h.slot - a) : b;
      h.bx = (l + r) / 2; h.hx = Math.min(70, ((r - l) / 2) * 0.97);
    });
    // gooey bridges between neighbours, low in the letters (word coordinates)
    const yb = -size * 0.17;
    const edge = (i: number, right: boolean) => {
      const L = word.letters[i]!;
      if (right) { for (let x = Math.round(L.ink[2]); x > L.ink[0]; x--) if (wordSD(word, i, x, yb) < -6) return x; return L.ink[2]; }
      for (let x = Math.round(L.ink[0]); x < L.ink[2]; x++) if (wordSD(word, i, x, yb) < -6) return x;
      return L.ink[0];
    };
    for (let i = 0; i < n - 1; i++) this.bridges.push({ i, y: yb, xa: edge(i, true) - 14, xb: edge(i + 1, false) + 14 });
    // the drip hangs from an overhang (a stroke with free air under it: f's bar, r's arm): the spot with the most room
    // around the fall (no ink of any letter within `room` px of the column, from under the stroke to the floor)
    const inkNear = (x: number, y0: number, room: number) => {
      for (let j = 0; j < n; j++) for (let y = y0; y < word.ink[3]; y += 4) for (let dx = -room; dx <= room; dx += 4) if (wordSD(word, j, x + dx, y) < 0) return true;
      return false;
    };
    let best = 0;
    word.letters.forEach((L, i) => {
      for (let x = Math.ceil(L.ink[0]) + 6; x < L.ink[2] - 6; x += 3) {
        const b = bottomAt(word, i, x);
        if (b === null || word.ink[3] - b < 90 || bottomAt(word, i, x - 6) === null || bottomAt(word, i, x + 6) === null) continue;
        let room = 0;
        while (room < 60 && !inkNear(x, b + 14, room + 4)) room += 4;
        if (room >= 24 && room >= best) { best = room; this.dripAt = { i, x, y: b, wx: ox + x, r: clamp((room - 14) / 1.25, 8, 16) }; }
      }
    });
    // the extra drop falls onto the middle letter
    this.target = Math.min(n - 1, Math.floor(n / 2));
  }

  private get tSnap() { return this.bt(16); }

  override cues(): Cue[] {
    const c: Cue[] = DROPS.map((d, i) => ({ t: this.bt(d.beat), name: `drop ${i + 1} lands`, on: 'beat' }));
    HOPS.forEach((h) => c.push({ t: this.bt(h.beat), name: `puddle ${h.who + 1} merges`, on: 'beat' }));
    c.push({ t: this.tSnap, name: 'letters snap out of the beads' }, { t: this.bt(24), name: 'drop lands on the word' });
    if (this.dripAt) c.push({ t: this.bt(28), name: 'drip lands' });
    return c;
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const t = f.t, g = goo(), bt = (n: number) => this.bt(n), tSnap = this.tSnap;
    // ---- the four drops: fall (the first poured), splash, lie as puddles until they hop
    DROPS.forEach((d, i) => {
      const tLand = bt(d.beat), hp = HOPS.find((h) => h.who === i);
      const o = { x: d.x, tLand, r: d.r, u: d.u, floor: FY };
      if (i === 0 && t < tLand) drip(g, t, { x: d.x, y: -70, floor: FY, u: d.u, tStart: this.ctx.start - 0.1, tLand, r: d.r, hang: 330, neck: 13, stub: 290 });
      else if (i === 3) { if (t < tLand) fallingDrop(g, t, o); }
      else if (!hp || t < bt(hp.beat) - 0.44) fallingDrop(g, t, o);
      splash(g, t, { ...o, seed: d.seed, n: i === 3 ? 7 : 5, spray: i === 3 ? 3 : 2, power: i === 3 ? 1.15 : 1, life: 0.55 });
    });
    // ---- hops into the middle mass; it grows by what has merged (volume kept)
    let r2 = DROPS[3]!.r ** 2, wobble = 0;
    const massHalf = () => Math.sqrt(r2) / 0.5;
    HOPS.forEach((h, k) => {
      const d = DROPS[h.who]!, tc = bt(h.beat), side = Math.sign(d.x - MX), x1 = MX + side * massHalf() * 0.55;
      if (t < tc - 0.44) return;
      const o = { x0: d.x, x1, floor: FY, r: d.r, u: d.u, tc };
      const p = hop(g, t, o);
      r2 += p.merged * d.r ** 2;
      wobble += 0.16 * wob(t - tc, 3.6, 0.2);
      if (k === 2) {   // a trailing bead on a thread: stretched over the first part of the flight, then it snaps
        const rb = d.r * 0.36, b = hop(g, t, { ...o, x0: d.x + side * d.r * 1.3, r: rb, tc: tc + 0.1, u: d.u + 0.04 });
        r2 += b.merged * rb * rb;
        const tTake = tc - 0.34, tBreak = tTake + 0.2;
        if (t > tTake && t < tBreak) strand(g, p.x, p.y, b.x, b.y, d.r * 0.45, rb * 0.8, smoothstep(tTake, tBreak, t), d.u, d.u + 0.04, 10);
        recoil(g, t, tBreak, p.x + side * d.r * 0.5, p.y, side, 0, d.r * 0.8, d.r * 0.3, d.u);
      }
    });
    // ---- the mass: lands as the big drop's puddle, swallows the hoppers, gathers, then spreads into a row of beads
    const d4 = DROPS[3]!, tL4 = bt(d4.beat), tBar = bt(14), tBead = bt(15), tPinch = bt(15.4), n = this.home.length;
    const spread = smoothstep(tBar, tBead, t), e = 1 - (1 - spread) ** 2;
    if (t >= tL4 && t < tBead) {
      const r = Math.sqrt(r2), gather = smoothstep(bt(12.6), bt(13.8), t);
      let sv = puddleStretch(t - tL4) + wobble + 0.2 * gather + 0.06 * wob(t - bt(12.6), 2.2, 0.5);
      sv = lerp(sv, 0.4, e);
      const rm = r * (1 - e * 0.9);
      ball(g, MX, FY - rm * sv + 1, rm, lerp(d4.u, 0.5, gather), sv);
    }
    // beads: out of the mass to the slots, then they pinch apart (necks) and become letters on the snap
    const vyP = 58, beadCy = FY - vyP * 0.92;
    if (t >= tBar && t < tSnap + 0.1) {
      const pinch = smoothstep(tPinch, tSnap, t), k2 = lerp(1.03, 0.95, pinch);
      this.home.forEach((h, i) => {
        const x = MX + (h.bx - MX) * e, hx = h.hx * k2 * lerp(0.35, 1, e), vy = vyP * lerp(0.82, 1.06, pinch) * lerp(0.6, 1, e);
        const m = t < tSnap ? 0 : clamp(((t - tSnap) * 30 - 0.6 * i + 1.5) / 2);
        if (m >= 1) return;
        ball(g, x, FY - vy * 0.92, Math.sqrt(hx * vy), lerp(0.5, h.u, smoothstep(tBar, tBead, t)), Math.sqrt(hx / vy), 0);
      });
    }
    // ---- letters
    const poses: LetterPose[] = [];
    if (t >= tSnap) {
      const ts = t - tSnap, word = this.word;
      const hits: [number, number, number][] = [[bt(20), 0.045, 1], [bt(24), 0.08, 0], [bt(28), 0.045, -1]];
      this.home.forEach((h, i) => {
        const m = clamp((ts * 30 - 0.6 * i + 1.5) / 2), P = springStep(ts, 4, 0.35);
        const gs = lerp(SLOT, 1, P <= 1 ? P : 1 + 0.25 * (P - 1)), x = MX + (h.x - MX) * lerp(SLOT, 1, P);
        const sq = m * smoothstep(0, 1, (P - 0.95) / 0.36);
        let jelly = 0;
        for (const [tk, ak, dir] of hits) {
          const order = dir > 0 ? i : dir < 0 ? n - 1 - i : Math.abs(i - this.target);
          jelly += ak * wob(t - tk - order * 0.045, 3.4, 0.22);
        }
        const breathe = 0.018 * Math.sin(TAU * 0.5 * (t - tSnap) - i * 1.3) * smoothstep(tSnap + 0.8, tSnap + 2, t);
        const sx = gs * (1 + 0.12 * sq + jelly + breathe), sy = gs * (1 - 0.08 * sq + breathe - jelly * 0.7);
        const L = word.letters[i]!;
        const y = h.bot - (L.ink[3] - L.home[1]) * sy;   // standing on the floor: scale about the foot
        const pose: LetterPose = {
          i, x, y, u: h.u, sx, sy, m: Math.max(1e-3, m),
          a: 0.012 * wob(ts, 2.4, 0.4) * (i % 2 ? 1 : -1),
          grow: 3 * (1 - smoothstep(0, 0.15, ts)) + 4 * smoothstep(bt(24), bt(24) + 0.3, t) * Math.exp(-Math.max(0, t - bt(24) - 0.3) / 0.8) * (i === this.target ? 1 : 0),
          wob: 3.2 * Math.exp(-ts / 0.35) + 0.7, wph: t * 6 + i * 1.7,
          ell: [h.bx, beadCy, h.hx * (1 + 0.4 * m), vyP * 1.06 * (1 + 0.4 * m)],
        };
        poses.push(pose);
        g.letters.push(pose);
      });
      // bridges between neighbours stretch as the word unfolds and snap left to right; the stubs spring back
      for (const b of this.bridges) {
        const pa = poses[b.i]!, pb = poses[b.i + 1]!, tBr = tSnap + 0.06 + 0.035 * b.i;
        const A = letterToWorld(word, pa, b.xa, b.y), B = letterToWorld(word, pb, b.xb, b.y), rb = 17 * Math.sqrt(pa.sx! * pa.sy!);
        if (t < tBr) strand(g, A[0], A[1], B[0], B[1], rb, rb, smoothstep(tSnap, tBr, t), pa.u, pb.u, 8);
        const dx = B[0] - A[0], len = Math.hypot(dx, B[1] - A[1]) || 1;
        recoil(g, t, tBr, A[0], A[1], dx / len, (B[1] - A[1]) / len, len * 0.42, rb * 0.8, pa.u);
        recoil(g, t, tBr, B[0], B[1], -dx / len, -(B[1] - A[1]) / len, len * 0.42, rb * 0.8, pb.u);
      }
      // droplets torn off on the snap
      const R = mulberry32(77);
      for (let k = 0; k < 10; k++) {
        const i = k % n, h = this.home[i]!, side = h.x < MX ? (R() < 0.8 ? -1 : 1) : (R() < 0.8 ? 1 : -1);
        const x0 = MX + (h.x - MX) * SLOT + (R() - 0.5) * 60, y0 = FY - 40 - R() * 90, T = 0.27 + R() * 0.2;
        const vy = (0.5 * 5000 * T * T - (FY - y0)) / T;
        fling(g, t, { x0, y0, vx: side * (260 + R() * 700), vy, r: 4 + R() * 6, u: h.u, tEmit: tSnap + 0.03 + R() * 0.04, floor: FY, fy: -20 + R() * 26, life: 0.35 });
      }
      // carbonation
      const fz = smoothstep(tSnap + 0.5, tSnap + 1.5, t);
      if (fz > 0) for (const p of poses) fizz(g, t, word, p, { n: Math.max(2, Math.floor(18 / n)), seed: 5, alpha: fz, r: [3.5, 7] });
      // a drop falls onto the middle letter and is swallowed
      const tp = poses[this.target]!, top = this.topOf(this.target, tp), tO = bt(24), rO = 24;
      if (t < tO) fallingDrop(g, t, { x: tp.x - 8, tLand: tO, r: rO, u: lerp(tp.u, 0.95, 0.4), floor: top + rO * 0.9 });
      else if (t < tO + 0.4) {   // splats into a lens on the letter's crown and sinks in
        const tl = t - tO, k = smoothstep(0.02, 0.38, tl), sv = puddleStretch(tl, 0.55, 0.45), r = rO * (1 - k);
        ball(g, tp.x - 8, top + rO * 0.9 - r * sv - 6 * k, r, lerp(lerp(tp.u, 0.95, 0.4), tp.u, k), sv);
      }
      // the drip under the overhang with the most room
      if (this.dripAt) {
        const dp = poses[this.dripAt.i]!, [ax, ay] = letterToWorld(word, dp, this.dripAt.x, this.dripAt.y);
        drip(g, t, { x: ax, y: ay - 2, floor: FY, u: dp.u, tStart: bt(25), tLand: bt(28), r: this.dripAt.r, hang: 60, neck: Math.min(13, this.dripAt.r * 1.1), flat: 0.88 });
      }
    }

    // ---- camera, light, ripple
    const t0 = this.ctx.start, zoom = kf(t, [[t0, 1.0], [bt(7), 1.03], [bt(12), 1.1], [bt(15), 1.1], [bt(17.2), 1.0, 'ease'], [bt(34), 1.055]]);
    const cam = kfp(t, [[t0, { x: MX, y: 560 }], [bt(8), { x: MX, y: 600 }], [bt(12), { x: MX, y: 680 }], [bt(15), { x: MX, y: 680 }], [bt(17.2), { x: MX, y: 610 }, 'ease'], [bt(34), { x: MX, y: 630 }]]);
    const tg = bt(18), glint = t > tg && t < tg + 1 ? lerp(-300, 1300, smoothstep(tg, tg + 0.9, t)) : -9999;
    const tDl = bt(28), ripple: [number, number, number, number] = this.dripAt && t > tDl ? [this.dripAt.wx, FY, t - tDl, 1] : [0, 0, 0, 0];
    this.pass.render(this.ctx.renderer, out, g, t, {
      x: cam.x, y: cam.y, zoom,
      k: t < tSnap ? lerp(0.09, 0.065, smoothstep(tBar - 0.4, tBar, t)) : lerp(0.065, 0.1, smoothstep(tSnap, tSnap + 0.25, t)),   // gooier while it is one mass
      floor: FY, horizon: HOR,
      key: [lerp(-0.78, -0.6, smoothstep(tSnap, tSnap + 7, t)), -0.95], glint: [glint, 0.55], ripple,
      spot: [MX, 470, 1050, 620], caustics: 0.75 * smoothstep(tSnap + 0.3, tSnap + 1.5, t) * (1 + (t > tDl ? 0.9 * Math.exp(-(t - tDl) / 0.45) : 0)),
    });
    return { bloom: 0.2, vignette: 0.3, grain: 0.03 };
  }

  /** Top of letter i's ink above its centre column, in the world. */
  private topOf(i: number, p: LetterPose) {
    const L = this.word.letters[i]!, x = L.home[0] - 8 / (p.sx ?? 1);
    let y = L.ink[1] - 2;
    while (y < L.ink[3] && wordSD(this.word, i, x, y) > 0) y++;
    return letterToWorld(this.word, p, x, y)[1];
  }
}


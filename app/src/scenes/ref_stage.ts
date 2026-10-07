// ?ref=stage: the bad-time-mv look (guiguisocute/bad-time-mv; docs/复刻配方.md) with our own content: a pixel world on
// kit/pixelstage.ts filmed by a 3D camera — the arena drawn by a pen the camera follows, a tilted wide shot with glowing
// pixel cannons firing beams, an inverted black-and-white impact frame, a push-in until the world's pixels show as a
// dot matrix, a VHS rewind under letterbox bars, a beam turned on the camera to white.
// (The reference has no licence: only its techniques are used, written anew; no characters, UI or text of it.)
import type * as THREE from 'three';
import { Scene, type Frame } from '../engine/scene';
import { W, H } from '../engine/gl';
import { font } from '../engine/type';
import { PixelStage } from '../kit/pixelstage';
import { ease, prog, keys, hash, clamp } from '../engine/util';

type Ctx = CanvasRenderingContext2D;
const WW = 960, WH = 540;
const PEN = 0.6, WIDE = 0.6, FIRE = 1.0, HIT = 1.4, PUSH = 1.5, REW = 2.3, BEAM = 3.1, END = 4.0;
const PIX = (px: number) => font('PressStart2P', px);

/** The arena rectangle by world time. */
const box = (t: number) => ({ x0: keys(t, [[0, 330], [1.5, 330], [2.0, 380, ease.inOutCubic]]), x1: keys(t, [[0, 630], [1.5, 630], [2.0, 580, ease.inOutCubic]]), y0: 200, y1: 360 });
/** The player's position by world time: dodging on the beat. */
const player = (t: number) => ({ x: 480 + keys(t, [[0, 0], [0.9, 0], [0.98, -60, ease.outCubic], [1.3, -60], [1.38, 40, ease.outCubic], [1.8, 40], [1.9, -20, ease.outCubic]]), y: 300 + keys(t, [[0, 0], [1.1, 0], [1.18, -34, ease.outCubic], [1.6, -34], [1.7, 20, ease.outCubic]]) });

export default class RefStage extends Scene {
  st = new PixelStage(WW, WH);

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const T = f.lt;
    // VHS rewind: the world runs backward over the last stretch, faster and faster
    const rew = T >= REW && T < BEAM;
    const t = rew ? REW - ease.inQuad(prog(T, REW, BEAM)) * (REW - 0.9) : T;
    this.draw(t, T);
    // the camera
    const pen = this.pen(t);
    const cam = T < PEN
      ? { x: pen.x, y: pen.y + 20, zoom: 2.2, roll: 0.1 - 0.15 * T, pitch: -0.32, yaw: 0.25 - 0.3 * T }
      : T < PUSH
        ? { x: 480, y: keys(T, [[PEN, 250], [HIT, 268]]), zoom: keys(T, [[PEN, 1.0], [HIT, 1.12]]), roll: keys(T, [[PEN, -0.06], [HIT, 0.04]]), pitch: keys(T, [[PEN, -0.22], [HIT, -0.12]]), yaw: keys(T, [[PEN, 0.12], [HIT, -0.08]]) }
        : T < REW
          ? (() => { const p = player(t), k = ease.inOutCubic(prog(T, PUSH, PUSH + 0.35)); return { x: 480 + (p.x - 480) * k, y: 268 + (p.y - 268) * k, zoom: 1.12 + 3.4 * k, roll: 0.04 - 0.1 * k, pitch: -0.12 + 0.06 * k, yaw: -0.08 }; })()
          : T < BEAM
            ? { x: 480, y: 262, zoom: 1.05, roll: -0.03, pitch: -0.18, yaw: 0.06 }
            : { x: 480 + 80 * ease.inCubic(prog(T, BEAM, END)), y: 262, zoom: 1.05 + 1.2 * ease.inCubic(prog(T, BEAM, END)), roll: -0.03 - 0.25 * ease.inCubic(prog(T, BEAM, END)), pitch: -0.18, yaw: 0.06 + 0.5 * ease.inCubic(prog(T, BEAM, END)) };
    const k = T >= PUSH && T < REW ? prog(T, PUSH + 0.2, PUSH + 0.4) : 0;
    this.st.render(this.ctx.renderer, out, cam, { t: T, glow: 1.6, grid: 0.9 * k, voidAmt: 1, voidStep: 14, voidColor: [0.05, 0.06, 0.12], voidDepth: 260 });
    // impact frame on the hit, a short shake after it
    // impact: one colour-inverted frame, then hard black-and-white inverted ones (no bloom: crisp lines)
    const inv1 = T >= HIT && T < HIT + 0.025, hit = T >= HIT + 0.025 && T < HIT + 0.08, sh = T > HIT && T < HIT + 0.3 ? Math.sin(T * 120) * 14 * Math.exp(-(T - HIT) * 12) : 0;
    const white = ease.inQuad(prog(T, END - 0.35, END));
    return {
      bloom: hit || inv1 ? 0 : T >= PUSH && T < REW ? 0.45 : 0.8, bloomThreshold: 0.75, bloomRadius: 0.75, halation: 0, grain: 0.02, vignette: 0.35,
      ca: 2.2 + (T >= PUSH && T < REW ? 3 : 0) + (rew ? 4 : 0) + (inv1 ? 14 : 0), bw: hit ? 1 : 0, invert: hit || inv1 ? 1 : 0, bwThreshold: 0.5,
      shake: [sh, sh * 0.5] as [number, number], vhs: rew ? 0.9 : 0, letterbox: rew ? 0.2 * ease.outCubic(prog(T, REW, REW + 0.1)) : 0, flash: 2.5 * white,
    };
  }

  /** The pen drawing the arena (0..PEN): a point running round the rectangle. */
  private pen(t: number) {
    const b = box(t), per = 2 * (b.x1 - b.x0 + b.y1 - b.y0), s = clamp(t / PEN) * per, w = b.x1 - b.x0, h = b.y1 - b.y0;
    if (s < w) return { x: b.x0 + s, y: b.y0, s, per };
    if (s < w + h) return { x: b.x1, y: b.y0 + s - w, s, per };
    if (s < 2 * w + h) return { x: b.x1 - (s - w - h), y: b.y1, s, per };
    return { x: b.x0, y: b.y1 - (s - 2 * w - h), s, per };
  }

  /** Draw the world at world time t into both layers (colour + glow). T is the real time (for flicker). */
  private draw(t: number, T: number) {
    const st = this.st, w = st.world.ctx, e = st.emi.ctx;
    st.world.clear(); st.emi.clear();
    const both = (fn: (c: Ctx, glow: boolean) => void) => { fn(w, false); fn(e, true); };
    const b = box(t);
    // ---- the boss: a pixel kaomoji figure above the arena (white outline, 2-px pixels) ----
    const bob = Math.round(Math.sin(t * 6) * 1.5);
    w.fillStyle = '#FFFFFF';
    const P = (x: number, y: number, ww = 1, hh = 1) => w.fillRect(480 - 60 + x * 3, 62 + bob + y * 3, ww * 3, hh * 3);
    for (let x = 6; x < 34; x++) { P(x, 0); P(x, 18); } for (let y = 0; y < 19; y++) { P(5, y); P(34, y); }   // head box
    P(12, 7, 3, 3); P(25, 7, 3, 3); P(17, 12, 1, 2); P(18, 14, 2, 1); P(20, 12, 1, 2); P(21, 14, 2, 1); P(23, 12, 1, 2);   // •ω•
    for (let x = 10; x < 30; x++) P(x, 22); for (let y = 22; y < 34; y++) { P(9, y); P(30, y); }   // shoulders and body
    P(3, 24, 6, 1); P(31, 24, 6, 1); P(2, 25, 1, 4); P(37, 25, 1, 4);                               // arms
    // ---- the arena: drawn by the pen, then whole ----
    const pen = this.pen(t), drawn = t < PEN ? pen.s : 1e9;
    both((c, glow) => {
      c.fillStyle = glow ? 'rgba(255,255,255,0.9)' : '#FFFFFF';
      const L = 4, ww = b.x1 - b.x0, hh = b.y1 - b.y0;
      const seg = (s0: number, len: number, fn: (a: number, l: number) => void) => { const l = clamp(drawn - s0, 0, len); if (l > 0) fn(0, l); };
      seg(0, ww, (_, l) => c.fillRect(b.x0, b.y0 - L / 2, l, L));
      seg(ww, hh, (_, l) => c.fillRect(b.x1 - L / 2, b.y0, L, l));
      seg(ww + hh, ww, (_, l) => c.fillRect(b.x1 - l, b.y1 - L / 2, l, L));
      seg(2 * ww + hh, hh, (_, l) => c.fillRect(b.x0 - L / 2, b.y1 - l, L, l));
      if (t < PEN) { c.fillStyle = '#FFFFFF'; c.fillRect(pen.x - 4, pen.y - 4, 8, 8); }
    });
    // ---- bars rising from the floor on the beat ----
    for (let i = 0; i < 6; i++) {
      const t0 = 0.7 + i * 0.2; if (t < t0 || t > t0 + 0.45) continue;
      const x = b.x0 + 30 + ((i * 97) % (b.x1 - b.x0 - 60)), up = ease.outBack(prog(t, t0, t0 + 0.08)) * (1 - prog(t, t0 + 0.3, t0 + 0.45)), hgt = 40 + 60 * hash(i, 4);
      both((c, glow) => { c.fillStyle = glow ? 'rgba(255,255,255,0.7)' : '#FFFFFF'; c.fillRect(x - 3, b.y1 - hgt * up, 6, hgt * up); c.fillRect(x - 6, b.y1 - hgt * up, 12, 6); });
    }
    // ---- cannons: blocky [ω] heads either side, a beam across the arena when they fire ----
    if (t > WIDE + 0.1) {
      const open = ease.outBack(prog(t, WIDE + 0.1, WIDE + 0.3));
      for (const [cx, dir] of [[150, 1], [810, -1]] as const) {
        const cy = 270 + Math.sin(t * 3 + cx) * 4;
        both((c, glow) => {
          c.save(); c.translate(cx, cy); c.scale(open * dir, open);
          c.fillStyle = glow ? 'rgba(200,240,255,0.8)' : '#E8F6FF';
          c.fillRect(-40, -34, 80, 8); c.fillRect(-40, 26, 80, 8); c.fillRect(-40, -34, 8, 68); c.fillRect(32, -34, 8, 22); c.fillRect(32, 12, 8, 22);
          c.fillRect(-20, -14, 10, 10); c.fillRect(4, -14, 10, 10);
          c.restore();
        });
      }
      const beamOn = t >= FIRE && t < FIRE + 0.5, bw = beamOn ? 26 * ease.outBack(prog(t, FIRE, FIRE + 0.06)) * (1 - prog(t, FIRE + 0.35, FIRE + 0.5)) : 0;
      if (bw > 0) both((c, glow) => { c.fillStyle = glow ? 'rgba(210,245,255,1)' : '#FFFFFF'; c.fillRect(190, 300 - bw / 2, 580, bw); c.fillStyle = glow ? 'rgba(120,200,255,0.6)' : 'rgba(255,255,255,0.4)'; c.fillRect(190, 300 - bw, 580, bw * 2); });
    }
    // ---- the player ----
    const p = player(t);
    both((c) => { c.fillStyle = '#4FE3FF'; c.beginPath(); c.moveTo(p.x, p.y - 7); c.lineTo(p.x + 7, p.y); c.lineTo(p.x, p.y + 7); c.lineTo(p.x - 7, p.y); c.closePath(); c.fill(); });
    // ---- the HUD (part of the world: it tilts with it) ----
    w.font = PIX(14); w.fillStyle = '#FFFFFF'; w.textBaseline = 'middle';
    w.fillText('SMILE', 150, 404); w.fillText('LV 7', 290, 404); w.fillText('HP', 390, 404);
    const hp = t < HIT ? 1 : 0.82;
    w.fillStyle = '#F7E018'; w.fillRect(430, 396, 150 * hp, 18); w.fillStyle = '#E8202A'; w.fillRect(430 + 150 * hp, 396, 150 * (1 - hp), 18);
    w.fillStyle = '#FFFFFF'; w.fillText(`${Math.round(52 * hp)} / 52`, 600, 404);
    w.strokeStyle = '#FF8A20'; w.lineWidth = 3; w.font = PIX(14); w.fillStyle = '#FF8A20';
    ['RUN', 'PARTY', 'SAVE', 'QUIT'].forEach((s, i) => { w.strokeRect(150 + i * 170, 432, 140, 40); w.fillText(s, 150 + i * 170 + 70 - w.measureText(s).width / 2, 453); });
    // ---- the last beam: from the right cannon, swinging onto the camera ----
    if (T >= BEAM) {
      const a = ease.inCubic(prog(T, BEAM, END)), bw = 30 + 260 * a;
      both((c, glow) => { c.save(); c.translate(810, 270); c.rotate(Math.PI + 0.6 * (1 - a)); c.fillStyle = glow ? 'rgba(220,248,255,1)' : '#FFFFFF'; c.fillRect(0, -bw / 2, 1400, bw); c.restore(); });
    }
    void hash; void T;
  }
}

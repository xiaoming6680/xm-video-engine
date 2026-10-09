// ?ref=crash: frame-matched re-creation of the kaomoji.exe crash (its 88.0–96.0 s; docs/复刻配方.md): on a CRT the
// face (a grid of orange @) sits in a dark pill over rows of @ in colour bands, gets dizzy (>ω<) then dies (×ω×); the
// bands bend into rounded rings; the signal decays to grey scanlines; a blue crash screen; the tube switches off to a
// line; a red neon ring with the dead face, it shrinks to a dot and comes back.
// Local seconds T = f.lt match the reference from 88.0 s. All wording is our own.
import type * as THREE from 'three';
import { Scene, type Frame } from '../engine/scene';
import { Layer2D, W, H, makeRT, clearRT } from '../engine/gl';
import { F, font } from '../engine/type';
import { Ascii } from '../engine/ascii';
import { ease, prog, keys, mulberry32 } from '../engine/util';

type Ctx = CanvasRenderingContext2D;
const RED = '#F04A3C';
const DIZZY = 0.4, DEAD = 0.8, RINGS = 0.9, DECAY = 2.6, BSOD = 4.8, REMOVED = 6.4, OFF = 6.9, NEON = 7.4, DOT = 7.72, BACK = 8.3;
const CX = W / 2, CY = H * 0.47;

/** A four-point sparkle. */
function sparkle(c: Ctx, x: number, y: number, r: number, a = 1) {
  c.save(); c.globalAlpha = a; c.fillStyle = '#FFFFFF';
  c.beginPath(); c.moveTo(x - r, y); c.lineTo(x, y - r * 0.1); c.lineTo(x + r, y); c.lineTo(x, y + r * 0.1); c.closePath(); c.fill();
  c.beginPath(); c.moveTo(x, y - r); c.lineTo(x + r * 0.1, y); c.lineTo(x, y + r); c.lineTo(x - r * 0.1, y); c.closePath(); c.fill();
  c.restore();
}

/** A fake QR-like block pattern (not a real code). */
function qr(c: Ctx, x: number, y: number, s: number) {
  c.fillStyle = '#F2F2F2'; c.fillRect(x, y, s, s);
  const n = 21, q = (s - 12) / n, rnd = mulberry32(5);
  c.fillStyle = '#111';
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (rnd() < 0.45) c.fillRect(x + 6 + i * q, y + 6 + j * q, q, q);
  for (const [i, j] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
    c.fillStyle = '#111'; c.fillRect(x + 6 + i! * q, y + 6 + j! * q, 7 * q, 7 * q);
    c.fillStyle = '#F2F2F2'; c.fillRect(x + 6 + (i! + 1) * q, y + 6 + (j! + 1) * q, 5 * q, 5 * q);
    c.fillStyle = '#111'; c.fillRect(x + 6 + (i! + 2) * q, y + 6 + (j! + 2) * q, 3 * q, 3 * q);
  }
}

export default class RefCrash extends Scene {
  pic = new Layer2D();
  ui = new Layer2D();
  rtA = makeRT();
  rtB = makeRT();
  asc!: Ascii;

  override init() { this.asc = new Ascii({ chars: ' @' }); }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const T = f.lt;
    if (T < BSOD) return this.tube(f, out);
    if (T < NEON) return this.bsod(f, out);
    return this.neon(f, out);
  }

  // 88.0–92.8: the @-grid tube
  private tube(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp } = this.ctx, T = f.lt, c = this.pic.ctx;
    const decay = prog(T, DECAY, BSOD - 0.2), grey = (col: [number, number, number]) => col.map((v) => Math.round(v + (150 - v) * decay * 0.85)) as [number, number, number];
    const rgb = (k: [number, number, number], a = 1) => `rgba(${grey(k).join(',')},${a})`;
    // ---- the background picture: colour bands, then rounded rings ----
    this.pic.clear('#000');
    const ringsP = ease.inOutCubic(prog(T, RINGS, RINGS + 0.3));
    if (ringsP < 1) {
      const bands: [number, number, number][] = T < 0.45 ? [[90, 130, 200], [150, 200, 120], [220, 110, 110]] : [[210, 110, 120], [150, 140, 220], [110, 200, 150]];
      bands.forEach((col, i) => { c.fillStyle = rgb(col, 1 - ringsP); c.fillRect((i * W) / 3, 0, W / 3 + 1, H); });
    }
    if (ringsP > 0) {
      const cols: [number, number, number][] = [[230, 90, 160], [90, 210, 190], [120, 230, 150], [90, 150, 230], [200, 110, 200]];
      const pulse = (T * 0.9) % 1;
      for (let k = 14; k >= 0; k--) {
        const s = (k + pulse) * 62;
        c.fillStyle = rgb(cols[(k + Math.floor(T * 0.9)) % cols.length]!, ringsP);
        c.beginPath(); c.roundRect(CX - W * 0.27 - s, CY - H * 0.2 - s * 0.6, W * 0.54 + 2 * s, H * 0.4 + 1.2 * s, H * 0.2 + s * 0.6); c.fill();
      }
    }
    // decay: rows drop out in blocks
    if (decay > 0) { const rr = mulberry32(Math.round(T * 12)); c.fillStyle = '#000'; for (let i = 0; i < 40 * decay; i++) c.fillRect(rr() * W, rr() * H, 60 + rr() * 300, 14 + rr() * 30); }
    clearRT(renderer, this.rtA, [0, 0, 0]);
    comp.draw(renderer, this.pic.upload(), this.rtA, { mode: 'replace' });
    this.asc.render(renderer, this.rtA.texture, out, { cell: 14, mode: 'color', boost: 0.85, threshold: 0.03, dither: 0 });
    // ---- the pill and the face (a grid of orange @, added over the pill) ----
    const shrink = ease.inOutCubic(prog(T, DECAY + 0.6, BSOD - 0.3)), fs = 1 - 0.3 * shrink;
    const u = this.ui.ctx; this.ui.clear();
    const pb = prog(T, DECAY + 0.9, BSOD - 0.6);
    u.fillStyle = `rgb(${Math.round(42 - 6 * pb)},${Math.round(36 + 40 * pb)},${Math.round(72 + 150 * pb)})`; u.beginPath(); u.roundRect(CX - W * 0.28 * fs, CY - H * 0.21 * fs, W * 0.56 * fs, H * 0.42 * fs, H * 0.21 * fs); u.fill();
    if (pb > 0) {
      // corrupted blue blocks with hex in them
      const rb = mulberry32(Math.floor(T * 6)); u.font = font(F.mono(700), 18);
      for (let i = 0; i < 9 * pb; i++) { const x = rb() * W * 0.9, y = rb() * H * 0.9, w = 60 + rb() * 120; u.fillStyle = 'rgba(60,90,220,0.85)'; u.fillRect(x, y, w, 26); u.fillStyle = '#C8D4FF'; u.fillText('40 40 40', x + 6, y + 19); }
    }
    comp.draw(renderer, this.ui.upload(), out);
    this.pic.clear('#000');
    const face = T < DIZZY ? '(•ω•)' : T < DEAD ? '(>ω<)' : '(×ω×)';
    c.font = font(F.archivo(100, 900), H * 0.42 * fs); c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#F6A85A'; if (shrink < 0.5) c.fillText(face, CX, CY + 4);
    clearRT(renderer, this.rtA, [0, 0, 0]);
    comp.draw(renderer, this.pic.upload(), this.rtA, { mode: 'replace' });
    this.asc.render(renderer, this.rtA.texture, this.rtB, { cell: shrink > 0.5 ? 6 : 11, mode: 'color', boost: 1.7, threshold: 0.05, dither: 0 });
    comp.draw(renderer, this.rtB.texture, out, { mode: 'add', premult: false });
    if (shrink >= 0.5) {
      this.ui.clear(); const uu = this.ui.ctx;
      uu.save(); uu.font = font(F.archivo(100, 900), H * 0.42 * fs); uu.textAlign = 'center'; uu.textBaseline = 'middle';
      uu.shadowColor = 'rgba(255,150,60,0.8)'; uu.shadowBlur = 16; uu.fillStyle = '#F6A040'; uu.fillText(face, CX, CY + 4); uu.restore();
      comp.draw(renderer, this.ui.upload(), out);
    }
    // ---- sparkles, the corner readout ----
    this.ui.clear();
    const rnd = mulberry32(7);
    if (T > RINGS) for (let i = 0; i < 7; i++) { const x = rnd() * W, y = rnd() * H, tw = Math.max(0, Math.sin(T * 6 + i * 2.3)); sparkle(u, x, y, 30 * tw, 1 - decay); }
    u.font = font(F.mono(500), 18); u.fillStyle = 'rgba(240,120,110,0.9)';
    u.fillText(T < RINGS ? `fps ${(36 - T * 8).toFixed(1)} · dropped ${28 + Math.floor(T * 20)}` : T < DECAY ? 'fps 8.0 · not responding' : 'camera 0.0 fps · dropping frames', 40, H * 0.955);
    comp.draw(renderer, this.ui.upload(), out);
    const tear = [1.75, 1.95, 2.35].some((g) => T > g && T < g + 0.06) ? 0.3 : 0;
    return { crt: 1, crtCurve: 0.05, crtLines: 160, crtNoise: 0.6 * decay, bloom: 0.7, bloomThreshold: 0.55, halation: 0.15, ca: 2.2, glitch: tear, glitchSeed: Math.floor(T * 10), vignette: 0.55, grain: 0.04 };
  }

  // 92.8–95.4: the blue crash screen, then the tube switches off
  private bsod(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp } = this.ctx, T = f.lt, c = this.ui.ctx;
    this.ui.clear('#2747D0');
    const g = c.createRadialGradient(CX, CY, 0, CX, CY, W * 0.6); g.addColorStop(0, 'rgba(70,110,255,0.5)'); g.addColorStop(1, 'rgba(10,20,90,0.6)');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    const show = (t0: number) => T >= t0;
    if (T < BSOD + 0.2) {
      // the first frames: a torn bar of hex
      const rr = mulberry32(Math.floor(T * 30));
      for (let i = 0; i < 8; i++) { c.fillStyle = `rgba(${200 + rr() * 55},${120 + rr() * 80},${80 + rr() * 60},0.85)`; c.fillRect(W * 0.3 + rr() * 200, H * 0.4 + i * 6, 300 + rr() * 300, 5); }
      c.font = font(F.mono(700), 34); c.fillStyle = '#F2A85A'; c.fillText('66 28 74 29 20 3D', W * 0.47, H * 0.43);
    }
    if (show(BSOD + 0.2)) {
      const scroll = -H * 0.2 * ease.inOutCubic(prog(T, REMOVED - 0.15, REMOVED));
      c.save(); c.translate(0, scroll);
      // the dead face, glowing orange
      c.save(); c.font = font(F.archivo(100, 900), 200); c.textBaseline = 'alphabetic';
      c.shadowColor = 'rgba(255,150,60,0.9)'; c.shadowBlur = 30; c.fillStyle = '#F7962E';
      const wink = T > 6.2 && T < 6.3 ? '(×ω•)' : '(×ω×)';
      c.fillText(wink, W * 0.09, H * 0.43); c.restore();
      c.font = font(F.archivo(100, 400), 44); c.fillStyle = '#F2F4FF'; c.fillText('frame.exe rendered a little too hard.', W * 0.09, H * 0.51);
      c.font = font(F.mono(500), 34); c.strokeStyle = '#F2F4FF'; c.lineWidth = 2;
      const sf = 'Segmentation fault (core dumped)'; c.strokeRect(W * 0.09 - 8, H * 0.54, c.measureText(sf).width + 16, 46); c.fillText(sf, W * 0.09, H * 0.574);
      if (T < REMOVED) {
        c.font = font(F.mono(700), 52); c.fillStyle = '#F2F4FF'; const l = 'bloom overflowed: 65504 nits'; c.fillText(l, W * 0.09, H * 0.65);
        const bx = W * 0.09 + c.measureText(l).width + 24; c.fillStyle = '#18276A'; c.fillRect(bx, H * 0.61, 190, 56);
        c.fillStyle = RED; c.font = font(F.archivo(100, 800), 40); c.fillText('(￣▽￣)', bx + 12, H * 0.648);
      } else {
        c.font = font(F.mono(700), 52); c.fillStyle = RED; c.fillRect(W * 0.09 - 6, H * 0.6, 290, 64);
        c.fillStyle = '#FFFFFF'; c.fillText('[QA]', W * 0.09, H * 0.65); c.fillText('frame flagged', W * 0.09 + 310, H * 0.65);
        c.strokeStyle = RED; c.lineWidth = 7; c.beginPath(); c.moveTo(W * 0.09 + 790, H * 0.635); c.lineTo(W * 0.09 + 810, H * 0.655); c.lineTo(W * 0.09 + 840, H * 0.6); c.stroke();
      }
      // saving friends
      const pct = Math.min(100, Math.round(21 + (T - BSOD) * 40));
      c.font = font(F.mono(600), 30); c.fillStyle = '#E8ECFF'; c.fillText('flushing frames [', W * 0.09, H * 0.75);
      const bx = W * 0.09 + c.measureText('flushing frames [').width; c.fillStyle = '#E8ECFF'; c.fillRect(bx + 4, H * 0.725, 160 * pct / 100, 30);
      c.fillText(`]  ${pct}%`, bx + 172, H * 0.75);
      qr(c, W * 0.09, H * 0.78, 185);
      c.font = font(F.mono(400), 22); c.fillStyle = 'rgba(220,226,255,0.85)';
      ['culprit   66 2E 74 20 3D 3D 20 4E 61 4E', 'scan for the seams report', 'questions? run tools/qa/seams.py'].forEach((s, i) => c.fillText(s, W * 0.2, H * 0.81 + i * 30));
      // a stack trace top right
      c.font = font(F.mono(400), 17); c.fillStyle = 'rgba(200,215,255,0.75)';
      const tr = ['0x7ffd1e60  66 28 74 29 20 3d', '#0 bloom()        post.ts:57', '#1 composite()    gl.ts:37', '#2 render(f)      scene.ts:29', '#3 sample(•ω•)    engine.ts:22', '#4 motionBlur()   engine.ts:16', '#5 post(riso)     post.ts:14', '#6 timeline()     timeline.ts:10', '#7 main()         render.ts:05', '[FAIL] cuecheck: next downbeat', '63/63 bars · 150 bpm · frames left: 1'];
      c.restore();
      tr.forEach((s, i) => c.fillText(s, W * 0.66, H * 0.16 + i * 22));
      if (T >= REMOVED) {
        // the guard's red tick over the face, in corner brackets
        c.save(); c.translate(0, scroll); const fx = W * 0.09, fy = H * 0.3;
        c.strokeStyle = RED; c.lineWidth = 4; for (const [x, y, dx, dy] of [[fx - 20, fy - 30, 1, 1], [fx + 560, fy - 30, -1, 1], [fx - 20, fy + 190, 1, -1], [fx + 560, fy + 190, -1, -1]] as const) { c.beginPath(); c.moveTo(x, y + dy * 30); c.lineTo(x, y); c.lineTo(x + dx * 30, y); c.stroke(); }
        const tp = prog(T, REMOVED, REMOVED + 0.12); c.lineWidth = 14; c.lineCap = 'round'; c.beginPath(); c.moveTo(fx + 180, fy + 90); c.lineTo(fx + 180 + 60 * Math.min(1, tp * 2), fy + 90 + 60 * Math.min(1, tp * 2)); if (tp > 0.5) c.lineTo(fx + 240 + 140 * (tp - 0.5) * 2, fy + 150 - 200 * (tp - 0.5) * 2); c.stroke();
        c.restore();
      }
    }
    // the tube switching off: content dims behind a bright line
    const off = prog(T, OFF, OFF + 0.15);
    comp.draw(renderer, this.ui.upload(), out, { mode: 'replace', opacity: 1 - 0.985 * off });   // (opacity is linear: 0.015 ≈ 15 % perceived)
    if (off > 0) {
      this.pic.clear();
      const p = this.pic.ctx;
      const lw = W * 0.96, y = H * 0.47;
      const lg = p.createLinearGradient(0, y - 30, 0, y + 30); lg.addColorStop(0, 'rgba(200,210,255,0)'); lg.addColorStop(0.5, `rgba(230,236,255,${off})`); lg.addColorStop(1, 'rgba(200,210,255,0)');
      p.fillStyle = lg; p.fillRect(CX - lw / 2, y - 30, lw, 60); p.fillStyle = `rgba(255,255,255,${off})`; p.fillRect(CX - lw / 2, y - 2, lw, 4);
      p.font = font(F.mono(700), 46); p.textAlign = 'center';
      p.fillStyle = RED; p.fillRect(CX - 420, y + 50, 240, 60); p.fillStyle = '#FFF'; p.fillText('[QA]', CX - 300, y + 95);
      p.fillText('frame flagged ✓', CX + 60, y + 95);

      comp.draw(renderer, this.pic.upload(), out);
    }
    return { crt: 1, crtCurve: 0.05, crtLines: 200, bloom: 0.6, bloomThreshold: 0.7, ca: 2, vignette: 0.5, grain: 0.04, glitch: T < BSOD + 0.2 ? 0.4 : 0, glitchSeed: 3 };
  }

  // 95.4–96.0: the red neon ring
  private neon(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp } = this.ctx, T = f.lt, c = this.ui.ctx;
    this.ui.clear('#050407');
    const r = keys(T, [[NEON, H * 0.24], [DOT - 0.05, H * 0.24], [DOT + 0.12, H * 0.1, ease.inCubic], [BACK, H * 0.1], [8.6, H * 0.3, ease.outBack]]);
    c.save(); c.shadowColor = 'rgba(255,60,40,0.9)'; c.shadowBlur = 40;
    c.fillStyle = '#100808'; c.beginPath(); c.arc(CX, CY, r, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#FF5A3C'; c.lineWidth = 8; c.stroke();
    if (T > DOT && T < BACK) for (let k = 1; k < 4; k++) { c.globalAlpha = 0.4 / k; c.beginPath(); c.arc(CX, CY, r * (1 + k * 1.2), 0, Math.PI * 2); c.stroke(); }
    c.globalAlpha = 1; c.restore();
    if (r > H * 0.16) {
      c.save(); c.font = font(F.archivo(100, 900), r * 0.62); c.textAlign = 'center'; c.textBaseline = 'middle';
      c.shadowColor = 'rgba(255,170,60,0.8)'; c.shadowBlur = 20; c.fillStyle = '#F7B23A';
      c.fillText(T >= BACK ? '(•ω•)' : '(×ω×)', CX, CY + 4); c.restore();
    } else { c.save(); c.font = font(F.archivo(100, 900), r * 1.1); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#F7A23A'; c.fillText('ω', CX, CY); c.fillStyle = '#FFE8D8'; c.beginPath(); c.arc(CX, CY - r * 0.1, r * 0.22, 0, Math.PI * 2); c.fill(); c.restore(); }
    if (T < DOT) {
      c.font = font(F.mono(700), 46); c.textAlign = 'center'; c.fillStyle = `rgba(255,255,255,${T > DOT ? 0.5 : 1})`;
      const a = 'next downbeat at frame ', wa = c.measureText(a).width, wb = c.measureText('5784').width; c.textAlign = 'left';
      c.fillText(a, CX - (wa + wb) / 2, H * 0.9); c.fillStyle = '#F7C24A'; c.fillText('5784', CX - (wa + wb) / 2 + wa, H * 0.9);
    }
    comp.draw(renderer, this.ui.upload(), out, { mode: 'replace' });
    return { bloom: 0.9, bloomThreshold: 0.6, ca: 1.5, vignette: 0.5, grain: 0.04, crt: 0.6, crtCurve: 0.1 };
  }
}

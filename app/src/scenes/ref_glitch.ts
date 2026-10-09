// ?ref=glitch: frame-matched re-creation of the kaomoji.exe "threats" burst (its 25.3–26.95 s; docs/复刻配方.md):
// the cross flare shrinks to a dot, CMY rings, a white halftone burst with the mis-registered face, then the face is
// a yellow box made of stacked rainbow cards in a storm of confetti (kaomoji cards, splats, stars); the threat count
// multiplies by 7; a glitched scale label tears in; the box splits into strips; a yellow splash.
// Local seconds T = f.lt match the reference from 25.3 s.
import type * as THREE from 'three';
import { Scene, type Frame } from '../engine/scene';
import { Layer2D, W, H } from '../engine/gl';
import { F, font } from '../engine/type';
import { ease, prog, keys, mulberry32, hash } from '../engine/util';

type Ctx = CanvasRenderingContext2D;
const PURPLE = '#3E2450', PINK = '#EE5C9A', BLUE = '#2E8FC0', CREAM = '#F6E9D6', YELLOW = '#F6D23C', INK = '#21183A', RED = '#EE4A36', ORANGE = '#F7A43A';
const CX = W / 2, CY = H * 0.47;
const DOT = 0.1, RINGS = 0.2, FACE = 0.3, BOX = 0.4, LABEL = 0.8, SPLIT = 1.3, SPLASH = 1.55;
const STRIPES = ['#F06A9A', '#3EA6D8', '#F6D23C', '#F6E9D6', '#5BC88A', '#F7A43A'];

/** Halftone dots over a rectangle in `col` (dot size `k` of the cell). */
function dots(c: Ctx, x: number, y: number, w: number, h: number, col: string, step = 9, k = 0.3) {
  c.fillStyle = col;
  for (let yy = y; yy < y + h; yy += step) for (let xx = x + ((yy - y) / step % 2 ? step / 2 : 0); xx < x + w; xx += step) { c.beginPath(); c.arc(xx, yy, step * k, 0, Math.PI * 2); c.fill(); }
}

/** The face in thick dark letters, with pink / blue / yellow mis-registered copies behind (riso print). */
function risoFace(c: Ctx, x: number, y: number, px: number, a = 1) {
  c.save(); c.globalAlpha = a; c.font = font(F.archivo(100, 800), px); c.textAlign = 'center'; c.textBaseline = 'middle';
  for (const [dx, dy, col] of [[-px * 0.05, -px * 0.03, YELLOW], [px * 0.04, px * 0.035, PINK], [-px * 0.02, px * 0.02, BLUE]] as const) { c.fillStyle = col; c.fillText('(•ω•)', x + dx, y + dy); }
  c.fillStyle = INK; c.fillText('(•ω•)', x, y);
  c.restore();
}

interface Bit { x: number; y: number; z: number; vx: number; vy: number; rot: number; w: number; kind: number; born: number; s: number }

export default class RefGlitch extends Scene {
  layer = new Layer2D();
  bits: Bit[] = [];

  override init() {
    const rnd = mulberry32(31);
    for (let i = 0; i < 760; i++) {
      // confetti thrown out of the box: born in waves as the count multiplies
      const a = rnd() * Math.PI * 2, r = 0.1 + rnd() ** 0.6 * 0.95;
      this.bits.push({ x: CX + Math.cos(a) * W * 0.55 * r, y: CY + Math.sin(a) * H * 0.62 * r, z: rnd(), vx: Math.cos(a) * (30 + rnd() * 120), vy: Math.sin(a) * (30 + rnd() * 100), rot: rnd() * 6, w: (rnd() - 0.5) * 4, kind: Math.floor(rnd() * 7), born: BOX + (i < 120 ? 0 : i < 400 ? 0.1 : 0.2) + rnd() * 0.06, s: 0.45 + rnd() * rnd() * 1.6 });
    }
    this.bits.sort((a, b) => a.z - b.z);
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp } = this.ctx, T = f.lt, c = this.layer.ctx;
    let post: Record<string, unknown> = {};
    if (T < FACE) post = this.space(c, T);
    else if (T < BOX) post = this.burst(c, T);
    else post = this.storm(c, T);
    comp.draw(renderer, this.layer.upload(), out, { mode: 'replace' });
    return { bloom: 0.25, bloomThreshold: 0.95, grain: 0.06, vignette: 0.22, halation: 0, ca: 1.6, ...post };
  }

  // 25.3–25.6: the cross shrinks to a dot; CMY rings open round it
  private space(c: Ctx, T: number) {
    this.layer.clear('#0C0A16');
    const rnd = mulberry32(4); c.fillStyle = 'rgba(220,200,255,0.35)'; for (let i = 0; i < 1200; i++) c.fillRect(rnd() * W, rnd() * H, 2, 2);
    if (T < DOT) {
      const s = 1 - prog(T, 0, DOT) * 0.8;
      c.fillStyle = '#FFF6EA'; c.fillRect(CX - 60 * s, CY - 2, 120 * s, 4); c.fillRect(CX - 2, CY - 60 * s, 4, 120 * s);
    }
    const g = c.createRadialGradient(CX, CY, 0, CX, CY, 26); g.addColorStop(0, 'rgba(255,240,210,1)'); g.addColorStop(1, 'rgba(255,240,210,0)');
    c.fillStyle = g; c.beginPath(); c.arc(CX, CY, 26, 0, Math.PI * 2); c.fill();
    if (T >= RINGS) {
      const p = ease.outCubic(prog(T, RINGS - 0.08, FACE)), R = H * (0.3 + 0.62 * p);
      c.lineWidth = 4;
      for (const [dx, dy, col] of [[-30, 10, '#E8E04A'], [24, -12, '#F06AB0'], [8, 22, '#3EB8E8']] as const) { c.strokeStyle = col; c.beginPath(); c.arc(CX + dx * p, CY + dy * p, R, 0, Math.PI * 2); c.stroke(); }
    }
    return { bloom: 0.6 };
  }

  // 25.6: the white halftone burst with the riso face
  private burst(c: Ctx, T: number) {
    this.layer.clear('#FBF5EA');
    // halftone edges: pink / blue dots growing toward the frame edge
    const rnd = mulberry32(8);
    for (let yy = 0; yy < H; yy += 11) for (let xx = (yy / 11) % 2 ? 5.5 : 0; xx < W; xx += 11) {
      const d = Math.hypot((xx - CX) / W, (yy - CY) / H) + 0.05 * (hash(xx, yy) - 0.5);
      if (d < 0.36) continue;
      c.fillStyle = hash(Math.floor(xx / 90), Math.floor(yy / 90)) < 0.5 ? PINK : BLUE;
      c.beginPath(); c.arc(xx, yy, Math.min(5.5, (d - 0.36) * 28), 0, Math.PI * 2); c.fill();
    }
    void rnd;
    c.globalAlpha = 1;
    risoFace(c, CX, CY, H * 0.42);
    this.count(c, 1);
    return {};
  }

  // 25.7–26.95: the box in the confetti storm
  private storm(c: Ctx, T: number) {
    this.layer.clear(PURPLE);
    dots(c, 0, 0, W, H, '#6A3A72', 10, 0.26);
    const u = T - BOX, n = T < BOX + 0.1 ? 7 : T < BOX + 0.2 ? 49 : T < SPLASH ? 343 : 2400;
    // far confetti, then the box, then near confetti
    const draw = (near: boolean) => {
      for (const b of this.bits) {
        if (T < b.born || (b.z > 0.9) !== near) continue;
        const e = T - b.born, x = b.x + b.vx * e * (1 + b.z), y = b.y + b.vy * e * (1 + b.z), s = b.s * (0.6 + 0.8 * b.z) * (0.6 + 0.4 * ease.outBack(Math.min(1, e / 0.08)));
        this.bit(c, x, y, b.rot + b.w * e, s, b.kind, b);
      }
    };
    draw(false);
    if (T < SPLASH) this.box(c, T, u);
    draw(true);
    if (T >= LABEL) this.label(c, T);
    if (T >= SPLASH) {
      // the yellow splash: a ragged yellow blob filling the right of the frame, halftone, a blue eye shape
      const q = ease.outCubic(prog(T, SPLASH, SPLASH + 0.08)), bx = W * 0.66, by = H * 0.62, R = H * 0.75 * q;
      const rr = mulberry32(12);
      c.fillStyle = YELLOW; c.beginPath();
      for (let i = 0; i <= 80; i++) { const a = (i / 80) * Math.PI * 2, r = R * (0.82 + 0.3 * rr()); c.lineTo(bx + Math.cos(a) * r, by + Math.sin(a) * r); }
      c.closePath(); c.fill();
      c.save(); c.clip(); dots(c, bx - R * 1.2, by - R * 1.2, R * 2.4, R * 2.4, 'rgba(200,120,30,0.7)', 9, 0.3); c.restore();
      c.save(); c.translate(bx + R * 0.1, by - R * 0.15); c.rotate(-0.5);
      c.fillStyle = BLUE; c.beginPath(); c.ellipse(0, 0, 90 * q, 48 * q, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = CREAM; c.beginPath(); c.moveTo(-30 * q, 0); c.lineTo(14 * q, -14 * q); c.lineTo(10 * q, 14 * q); c.closePath(); c.fill();
      c.restore();
    }
    this.count(c, n);
    // glitch on the label and the split
    const g = (T > LABEL && T < LABEL + 0.25) ? 0.35 : (T > SPLIT - 0.05 && T < SPLIT + 0.1) ? 0.5 : 0;
    return { glitch: g, glitchSeed: Math.floor(T * 20), ca: 2 + 4 * g };
  }

  /** The yellow box: a stack of cards (rainbow edges) turning in 3D; the face printed on the front. */
  private box(c: Ctx, T: number, u: number) {
    const pop = ease.outBack(prog(T, BOX, BOX + 0.1));
    const yaw = keys(T, [[BOX, -0.35], [0.9, -0.28], [1.1, 0.05, ease.inOutCubic], [SPLIT, 0.5, ease.inOutCubic], [SPLASH, 0.75]]);
    const bw = W * 0.44 * pop, bh = H * 0.42 * pop, depth = 26, step = 8;
    const cx = CX + W * 0.02 - u * 60, cy = CY - H * 0.02;
    const split = prog(T, SPLIT - 0.25, SPLIT);
    c.save(); c.translate(cx, cy); c.rotate(-0.08); c.translate(-cx, -cy);
    if (split > 0) {
      // edge-on: the card stack seen from the side, a wall of vertical rainbow strips
      const sw = bw * (0.9 + 0.2 * split), rr = mulberry32(3);
      let x = cx - sw / 2;
      while (x < cx + sw / 2) { const w = 4 + rr() * 16, hh = bh * (0.92 + 0.12 * rr()); c.fillStyle = STRIPES[Math.floor(rr() * STRIPES.length)]!; c.fillRect(x, cy - hh / 2 + (rr() - 0.5) * 20, w, hh); x += w + (rr() < 0.2 ? 3 : 0); }
      c.restore();
      return;
    }
    // cards behind: shifted by yaw (sideways) and down
    for (let k = depth; k >= 1; k--) {
      const ox = Math.sin(yaw) * k * step * 1.8 - k * step * 0.5, oy = k * step * 0.45;
      const sx = Math.cos(yaw) * (1 - k * 0.004);
      c.save(); c.translate(cx + ox, cy + oy); c.scale(sx, 1);
      if (split > 0) c.translate(((k * 37) % 11 - 5) * split * 26, 0);
      c.fillStyle = STRIPES[k % STRIPES.length]!; c.fillRect(-bw / 2, -bh / 2, bw, bh);
      c.restore();
    }
    // the front card
    c.save(); c.translate(cx, cy); c.scale(Math.cos(yaw), 1);
    c.fillStyle = YELLOW; c.fillRect(-bw / 2, -bh / 2, bw, bh);
    dots(c, -bw / 2, -bh / 2, bw, bh, 'rgba(200,140,30,0.5)', 9, 0.18);
    if (split < 0.5) {
      c.font = font(F.archivo(100, 800), bh * 0.5); c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillStyle = 'rgba(255,255,255,0.75)'; c.fillText('(•ω•)', 0, bh * 0.05);
      c.fillStyle = INK; for (let i = 0; i < 4; i++) c.fillRect(-bw * 0.06 + i * 12, -bh * 0.32, 6, 26);
    }
    c.restore();
    c.restore();
  }

  /** One piece of confetti. */
  private bit(c: Ctx, x: number, y: number, rot: number, s: number, kind: number, b: Bit) {
    c.save(); c.translate(x, y); c.rotate(rot); c.scale(s, s);
    const h = hash(b.x, b.y);
    switch (kind) {
      case 0: case 1: { // pink splat
        c.fillStyle = PINK; c.beginPath();
        for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2, r = 18 + 12 * hash(h, i); c.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
        c.closePath(); c.fill(); break;
      }
      case 2: { // blue card with a white glyph
        c.fillStyle = BLUE; c.fillRect(-26, -22, 52, 44);
        c.fillStyle = CREAM; c.font = font(F.archivo(100, 800), 30); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(['☆', 'A', 'Ⅶ', '♡', '▽'][Math.floor(h * 5)]!, 0, 2); break;
      }
      case 3: { // cream card with halftone and a pink glyph
        c.fillStyle = CREAM; c.fillRect(-24, -24, 48, 48); dots(c, -24, -24, 48, 48, 'rgba(240,150,90,0.6)', 7, 0.2);
        c.fillStyle = PINK; c.font = font(F.archivo(100, 800), 28); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(['ω', 'O', '♡', '◡'][Math.floor(h * 4)]!, 0, 2); break;
      }
      case 4: { // pink card with a kaomoji mouth
        c.fillStyle = PINK; c.fillRect(-30, -24, 60, 48); c.strokeStyle = CREAM; c.lineWidth = 4; c.beginPath(); c.arc(0, -4, 12, 0.2, Math.PI - 0.2); c.stroke(); break;
      }
      case 5: { // cream stick
        c.fillStyle = CREAM; c.fillRect(-36, -4, 72, 8); c.fillStyle = PINK; c.fillRect(-36, -4, 12, 8); break;
      }
      default: { // small blue triangle / star
        c.fillStyle = h < 0.5 ? BLUE : '#7FD3F0'; c.beginPath(); c.moveTo(0, -16); c.lineTo(14, 12); c.lineTo(-14, 12); c.closePath(); c.fill();
      }
    }
    c.restore();
  }

  /** The torn scale label: white blocks of "10⁻⁷ m" that resolve into the text. */
  private label(c: Ctx, T: number) {
    const p = prog(T, LABEL, LABEL + 0.35), x = T >= SPLASH ? W * 0.24 : CX - W * 0.08, y = T >= SPLASH ? H * 0.15 : H * 0.2;
    c.save(); c.font = font(F.archivo(100, 900), 270); c.textAlign = 'center'; c.textBaseline = 'middle';
    if (p >= 1) { c.fillStyle = PINK; c.fillText('10⁻⁷ m', x + 7, y + 9); c.fillStyle = '#F8EFE2'; c.fillText('10⁻⁷ m', x, y); c.restore(); return; }
    // torn: the text clipped into random slices, shifted, with white blocks
    const rnd = mulberry32(Math.floor(T * 30));
    for (let i = 0; i < 14; i++) {
      const sy = y - 100 + i * 15, sh = 15, dx = (rnd() - 0.5) * 260 * (1 - p);
      c.save(); c.beginPath(); c.rect(x - 500, sy, 1000, sh); c.clip();
      if (rnd() < 0.3 + 0.6 * p) { c.fillStyle = '#FFFFFF'; c.fillText('10⁻⁷ m', x + dx, y); }
      c.restore();
      if (rnd() < 0.3 * (1 - p)) { c.fillStyle = '#FFFFFF'; c.fillRect(x - 450 + rnd() * 900, sy, 30 + rnd() * 80, sh); }
    }
    c.restore();
  }

  /** "343 FLAGS" bottom-left: orange number, red word, dark outline. */
  private count(c: Ctx, n: number) {
    const num = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n), word = n === 1 ? ' FLAG' : ' FLAGS';
    c.save(); c.font = font(F.archivo(100, 900), 128); c.textBaseline = 'alphabetic'; c.lineJoin = 'round';
    const x = 30, y = H * 0.95, nw = c.measureText(num).width;
    c.lineWidth = 18; c.strokeStyle = INK; c.strokeText(num, x, y); c.strokeText(word, x + nw, y);
    c.fillStyle = ORANGE; c.fillText(num, x, y); c.fillStyle = RED; c.fillText(word, x + nw, y);
    c.restore();
  }
}

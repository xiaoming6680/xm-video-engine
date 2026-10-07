// ?ref=droste: frame-matched re-creation of the kaomoji.exe frame tunnel and light-speed jump (its 22.2–25.4 s;
// docs/复刻配方.md): a sun on cream paper, an ornate frame pops round it, frames stack outward, each a little turned
// and mis-registered, while the camera pulls back (a tunnel of frames); a flare line; the jump to light speed (streaks
// and glyphs smeared outward, a swirl); a pink frame of stars closes in, the sun shrinks to a point, a cross flare.
// Local seconds T = f.lt match the reference from 22.2 s.
import type * as THREE from 'three';
import { Scene, type Frame } from '../engine/scene';
import { Layer2D, W, H } from '../engine/gl';
import { F, font } from '../engine/type';
import { ease, prog, keys, mulberry32, hash } from '../engine/util';

type Ctx = CanvasRenderingContext2D;
const CREAM = '#F3EEE6', PAPER = '#DCD0C7', SUNY = '#F4DD82', SUNO = '#F16946', NAVY = '#1F1A3A';
const CX = W / 2, CY = H * 0.5;
const POP = 0.2, STACK = 0.55, FLARE = 1.4, JUMP = 1.8, SWIRL = 2.2, CLOSE = 2.7, CROSS = 3.0;

/** One ornate frame: a band between an outer and an inner rectangle, lace of sine lines in mis-registered inks. */
function frameBand(c: Ctx, w: number, h: number, band: number, inks: string[], seed: number, kaomoji: boolean) {
  const rnd = mulberry32(seed);
  // the band's ground
  c.fillStyle = inks[0]!; c.fillRect(-w / 2, -h / 2, w, h);
  inks.slice(1).forEach((ink, k) => {
    const dx = (k - 1) * 3, dy = (1 - k) * 2;
    c.strokeStyle = ink; c.lineWidth = 2;
    c.strokeRect(-w / 2 + 6 + dx, -h / 2 + 6 + dy, w - 12, h - 12);
    c.strokeRect(-w / 2 + band - 8 + dx, -h / 2 + band - 8 + dy, w - 2 * band + 16, h - 2 * band + 16);
    // lace: two sine lines running round the band
    c.lineWidth = 1.4;
    for (const ph of [0, Math.PI]) {
      c.beginPath();
      const per = 2 * (w + h - 4 * band * 0.55), N = Math.floor(per / 3);
      for (let i = 0; i <= N; i++) {
        const sAlong = (i / N) * per, m = band * 0.55, ww = w - 2 * m, hh = h - 2 * m;
        let px: number, py: number, nx: number, ny: number;
        if (sAlong < ww) { px = -ww / 2 + sAlong; py = -hh / 2; nx = 0; ny = 1; }
        else if (sAlong < ww + hh) { px = ww / 2; py = -hh / 2 + sAlong - ww; nx = 1; ny = 0; }
        else if (sAlong < 2 * ww + hh) { px = ww / 2 - (sAlong - ww - hh); py = hh / 2; nx = 0; ny = 1; }
        else { px = -ww / 2; py = hh / 2 - (sAlong - 2 * ww - hh); nx = 1; ny = 0; }
        const o = Math.sin(sAlong * 0.09 + ph + seed) * band * 0.22;
        if (i === 0) c.moveTo(px + nx * o + dx, py + ny * o + dy); else c.lineTo(px + nx * o + dx, py + ny * o + dy);
      }
      c.stroke();
    }
  });
  if (kaomoji) {
    c.fillStyle = inks[2]!; c.font = font(F.mono(500), Math.max(8, band * 0.16)); c.textBaseline = 'middle';
    const faces = ['(•ω•)', '(ω)', '(•ᴗ•)', '(•o•)'];
    for (let x = -w / 2 + 20; x < w / 2 - 40; x += band * 0.9) { c.fillText(faces[Math.floor(rnd() * 4)]!, x, -h / 2 + band * 0.12); c.fillText(faces[Math.floor(rnd() * 4)]!, x, h / 2 - band * 0.12); }
  }
  // the window
  c.clearRect(-w / 2 + band, -h / 2 + band, w - 2 * band, h - 2 * band);
}

export default class RefDroste extends Scene {
  layer = new Layer2D();
  frames: HTMLCanvasElement[] = [];

  override init() {
    // a few frame designs, pre-drawn (each stacked frame reuses one, scaled)
    const sets = [['#B9909F', '#E8495C', '#2B6CB0', '#2A1E3C'], ['#8E2335', '#F07090', '#1F1A3A', '#E8C060'], ['#2A2550', '#F2A0B8', '#E8495C', '#C8C0D8'], ['#9A4A6A', '#FFFFFF', '#203E7A', '#5A1E3A'], ['#C2505A', '#1F1A3A', '#F2C0D0', '#3A6FB8'], ['#5A2A4A', '#E86A8A', '#E8E0D0', '#2B6CB0']];
    for (let k = 0; k < 6; k++) {
      const cv = document.createElement('canvas'); cv.width = 1300; cv.height = 860;
      const c = cv.getContext('2d')!; c.translate(650, 430);
      frameBand(c, 1240, 800, k === 0 ? 120 : 70, sets[k]!, k * 17 + 3, k === 0);
      // print noise over the band (the reference's frames are grainy, moire-like)
      const rnd = mulberry32(k + 40);
      for (let i = 0; i < 9000; i++) { const x = (rnd() - 0.5) * 1240, y = (rnd() - 0.5) * 800; if (Math.abs(x) < 620 - (k === 0 ? 120 : 70) && Math.abs(y) < 400 - (k === 0 ? 120 : 70)) continue; c.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.35)' : 'rgba(20,10,30,0.35)'; c.fillRect(x, y, 2, 2); }
      this.frames.push(cv);
    }
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp } = this.ctx, T = f.lt, c = this.layer.ctx;
    let post: Record<string, unknown> = {};
    if (T < JUMP) post = this.tunnel(c, T);
    else if (T < CLOSE) post = this.jump(c, T);
    else post = this.close(c, T);
    comp.draw(renderer, this.layer.upload(), out, { mode: 'replace' });
    return { bloom: 0.5, bloomThreshold: 0.92, grain: 0.06, vignette: 0.25, halation: 0.1, ca: 2.2, ...post };
  }

  private sun(c: Ctx, r: number, hot: number) {
    if (hot > 0) {
      const g = c.createRadialGradient(CX, CY, r * 0.5, CX, CY, r * 2.2);
      g.addColorStop(0, `rgba(255,220,170,${0.55 * hot})`); g.addColorStop(1, 'rgba(255,200,150,0)');
      c.fillStyle = g; c.beginPath(); c.arc(CX, CY, r * 2.2, 0, Math.PI * 2); c.fill();
    }
    c.fillStyle = SUNY; c.beginPath(); c.arc(CX, CY, r, 0, Math.PI * 2); c.fill();
    c.fillStyle = SUNO; c.beginPath(); c.arc(CX, CY, r * 0.6, 0, Math.PI * 2); c.fill();
    if (hot > 0) { c.fillStyle = '#FFF9F2'; c.beginPath(); c.arc(CX, CY, r * 0.6 * (0.2 + 0.6 * hot), 0, Math.PI * 2); c.fill(); }
  }

  private flare(c: Ctx, len: number, a = 1) {
    if (len <= 0) return;
    const g = c.createLinearGradient(CX - len, 0, CX + len, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.2, `rgba(255,255,255,${a})`); g.addColorStop(0.8, `rgba(255,255,255,${a})`); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(CX - len, CY - 3, len * 2, 6);
    c.fillStyle = `rgba(255,240,230,${0.25 * a})`; c.fillRect(CX - len, CY - 10, len * 2, 20);
  }

  // 22.2–24.0: the frame tunnel
  private tunnel(c: Ctx, T: number) {
    this.layer.clear(T < POP ? CREAM : PAPER);
    // halftone paper
    if (T >= POP) { c.fillStyle = 'rgba(150,110,140,0.35)'; for (let y = 0; y < H; y += 9) for (let x = (y / 9) % 2 ? 4.5 : 0; x < W; x += 9) { c.beginPath(); c.arc(x, y, 1.6, 0, Math.PI * 2); c.fill(); } }
    if (T < POP) {
      // the previous shot's blue halftone sweeping away along the bottom
      const sw = ease.inCubic(prog(T, 0, POP));
      c.fillStyle = '#5A86C0'; c.beginPath(); c.moveTo(-50, H); c.quadraticCurveTo(W * 0.5, H * (0.78 + sw * 0.4), W * (1.1 + sw), H * (0.9 - sw * 0.3)); c.lineTo(W * 1.2, H * 1.1); c.lineTo(-50, H * 1.1); c.fill();
      this.sun(c, H * 0.16, 0);
      return {};
    }
    // the stack: frame k sits outside frame k-1 (scale 1/0.9 per step), turned a little more each step, born one by one
    const zoom = keys(T, [[POP, 1.0], [STACK, 0.95, ease.linear], [1.1, 0.76, ease.inOutQuad], [JUMP, 0.66, ease.linear]]);
    const n = 30, born = (k: number) => POP + (k === 0 ? 0 : 0.25 + k * 0.03);
    const winW = W * 0.44, s = 1 / 0.935;
    for (let k = n - 1; k >= 0; k--) {
      if (T < born(k)) continue;
      const pop = ease.outBack(prog(T, born(k), born(k) + 0.08));
      const sc = zoom * Math.pow(s, k) * (k === 0 ? 0.92 + 0.08 * pop : 1.06 - 0.06 * pop);
      const fw = winW / (1 - 240 / 1240) * sc;
      if (fw > W * 4) continue;
      c.save(); c.translate(CX, CY); c.rotate((k % 2 ? 1 : -1) * Math.min(0.09, 0.012 * k) * (0.6 + 0.4 * Math.sin(T * 2 + k)) + (k === 0 ? -0.02 : 0)); c.globalAlpha = Math.min(1, pop * 1.5);
      c.drawImage(this.frames[k === 0 ? 0 : 1 + ((k * 7) % 5)]!, -fw / 2, -fw * (860 / 1300) / 2, fw, fw * (860 / 1300));
      c.restore();
    }
    // the window: cream with the sun
    const ww = winW * Math.max(zoom, 0.9) * 0.95, wh = ww * (560 / 1000);
    c.save(); c.translate(CX, CY); c.rotate(-0.02);
    c.fillStyle = CREAM; c.fillRect(-ww / 2, -wh / 2, ww, wh);
    c.lineWidth = 3; c.strokeStyle = '#2B6CB0'; c.strokeRect(-ww / 2 + 8, -wh / 2 + 8, ww - 16, wh - 16);
    c.strokeStyle = '#E8495C'; c.strokeRect(-ww / 2 + 4, -wh / 2 + 12, ww - 16, wh - 16);
    c.restore();
    c.save(); c.beginPath(); c.rect(CX - ww / 2, CY - wh / 2, ww, wh); c.clip();
    this.sun(c, H * 0.16, 0);
    if (T > 0.6) { c.strokeStyle = '#5A6FA8'; c.lineWidth = 3; c.beginPath(); c.arc(CX, CY, H * 0.172, 0, Math.PI * 2); c.stroke(); }
    c.restore();
    this.flare(c, W * 0.22 * ease.outCubic(prog(T, FLARE, FLARE + 0.12)));
    // the print's noise over the tunnel (the reference is grainy and moire-like)
    const nr = mulberry32(Math.round(T * 30)); c.globalAlpha = 0.5 * prog(T, STACK, 1.0);
    for (let i = 0; i < 6000; i++) { c.fillStyle = nr() < 0.5 ? 'rgba(255,240,240,0.5)' : 'rgba(60,10,40,0.5)'; c.fillRect(nr() * W, nr() * H, 3, 2); }
    c.globalAlpha = 1;
    return { ca: 2.5 + 3 * prog(T, STACK, JUMP), grade: 0.3, grain: 0.09 };
  }

  // 24.0–24.9: light speed
  private jump(c: Ctx, T: number) {
    const u = T - JUMP, swirl = prog(T, SWIRL, SWIRL + 0.15);
    this.layer.clear('#2A1636');
    // a purple glow in the middle (the far end of the tunnel)
    const g = c.createRadialGradient(CX, CY, 0, CX, CY, H * 0.6);
    g.addColorStop(0, 'rgba(150,90,200,0.75)'); g.addColorStop(1, 'rgba(60,20,70,0)');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    // halftone hexagons either side
    for (const [x, col] of [[W * 0.12, 'rgba(90,110,200,0.55)'], [W * 0.88, 'rgba(200,70,150,0.6)'], [W * 0.36, 'rgba(240,160,60,0.5)']] as const) {
      const r = x === W * 0.36 ? 50 : 140;
      c.save(); c.beginPath(); for (let k = 0; k < 6; k++) c.lineTo(x + Math.cos(k * 1.047 + 0.52) * r, CY + Math.sin(k * 1.047 + 0.52) * r); c.closePath(); c.clip();
      c.fillStyle = col; for (let yy = CY - r; yy < CY + r; yy += 10) for (let xx = x - r; xx < x + r; xx += 10) { c.beginPath(); c.arc(xx, yy, 3.4, 0, Math.PI * 2); c.fill(); }
      c.restore();
    }
    // streaks: lines and glyphs thrown outward; after the swirl they bend round the centre
    const rnd = mulberry32(11), cols = ['#7FE0FF', '#FF7FB0', '#FFFFFF', '#FFFFFF', '#F0C070'];
    const glyphs = ['(•ω•)', '(@ω@)', '▽', '(°o°)', 'ω', '◎◎', '(•ᴗ•)'];
    c.lineCap = 'round';
    for (let i = 0; i < 560; i++) {
      const a0 = rnd() * Math.PI * 2, d0 = rnd(), sp = 0.8 + rnd() * 1.6, col = cols[i % cols.length]!, isG = i % 3 === 0;
      const d = ((d0 + u * sp) % 1), r = H * (0.12 + 1.3 * d * d), len = H * (0.05 + 0.35 * d * d) * (1 - swirl * 0.4);
      const a = a0 + swirl * (0.6 * d + u * 0.8);
      const x0 = CX + Math.cos(a) * r * 1.5, y0 = CY + Math.sin(a) * r;
      if (isG && d > 0.25) {
        c.save(); c.translate(x0, y0); c.rotate(a);
        c.font = font(F.archivo(100, 800), 18 + 46 * d); c.textAlign = 'center'; c.textBaseline = 'middle';
        for (let k = 0; k < 6; k++) { c.globalAlpha = 0.5 * (1 - k / 6); c.fillStyle = '#F4F0FF'; c.fillText(glyphs[i % glyphs.length]!, -k * len * 0.12, 0); }
        c.restore();
      } else {
        const a2 = a - swirl * 0.25;
        c.strokeStyle = col; c.globalAlpha = 0.3 + 0.7 * d; c.lineWidth = 1 + 2.5 * d;
        c.beginPath(); c.moveTo(x0, y0); c.lineTo(x0 + Math.cos(a2) * len * 1.5, y0 + Math.sin(a2) * len); c.stroke();
      }
    }
    c.globalAlpha = 1;
    this.sun(c, H * 0.15, 1);
    this.flare(c, W * 0.38);
    return { radial: 0.12 * (1 - swirl), bloom: 0.7, bloomThreshold: 0.85 };
  }

  // 24.9–25.4: a pink frame of stars closes in, the sun shrinks to a point, the cross flare
  private close(c: Ctx, T: number) {
    if (T >= CROSS) {
      this.layer.clear('#0A0A1E');
      const g = c.createRadialGradient(CX, CY, 0, CX, CY, H * 0.7);
      g.addColorStop(0, 'rgba(40,40,110,0.8)'); g.addColorStop(1, 'rgba(10,10,30,0)');
      c.fillStyle = g; c.fillRect(0, 0, W, H);
      const dust = mulberry32(21); c.fillStyle = 'rgba(220,210,255,0.55)';
      for (let i = 0; i < 900; i++) c.fillRect(dust() * W, dust() * H, 2, 2);
      const s = T < CROSS + 0.08 ? 1 : 0.22, a = 1 - prog(T, CROSS + 0.15, CROSS + 0.4) * 0.6;
      const gl = c.createRadialGradient(CX, CY, 0, CX, CY, H * 0.2 * s); gl.addColorStop(0, `rgba(255,240,220,${0.5 * a})`); gl.addColorStop(1, 'rgba(255,240,220,0)');
      c.fillStyle = gl; c.fillRect(CX - H * 0.2, CY - H * 0.2, H * 0.4, H * 0.4);
      for (const [w, alpha] of [[12, 0.3 * a], [5, a]] as const) {
        c.fillStyle = `rgba(255,248,240,${alpha})`;
        c.fillRect(CX - W * 0.21 * s, CY - w / 2, W * 0.42 * s, w); c.fillRect(CX - w / 2, CY - H * 0.26 * s, w, H * 0.52 * s);
      }
      return { bloom: 0.9, bloomThreshold: 0.8 };
    }
    this.layer.clear('#2A2630');
    for (const [x, col] of [[W * 0.1, 'rgba(90,110,200,0.5)'], [W * 0.9, 'rgba(200,70,150,0.6)']] as const) {
      c.save(); c.beginPath(); for (let k = 0; k < 6; k++) c.lineTo(x + Math.cos(k * 1.047 + 0.52) * 150, CY + Math.sin(k * 1.047 + 0.52) * 150); c.closePath(); c.clip();
      c.fillStyle = col; for (let yy = CY - 150; yy < CY + 150; yy += 10) for (let xx = x - 150; xx < x + 150; xx += 10) { c.beginPath(); c.arc(xx, yy, 3.4, 0, Math.PI * 2); c.fill(); }
      c.restore();
    }
    // the portrait frame: pale pink lace round a starfield
    const p = ease.outCubic(prog(T, CLOSE, CLOSE + 0.12));
    const fh = H * (1.5 - 0.4 * p), fw = fh * 0.95;
    c.save(); c.translate(CX, CY); c.rotate(0.05);
    c.fillStyle = '#EED6E0'; c.fillRect(-fw / 2, -fh / 2, fw, fh);
    const lr = mulberry32(9);
    for (let i = 0; i < 2600; i++) { c.fillStyle = lr() < 0.5 ? 'rgba(255,255,255,0.8)' : 'rgba(220,120,160,0.45)'; c.fillRect((lr() - 0.5) * fw, (lr() - 0.5) * fh, 3, 3); }
    c.strokeStyle = 'rgba(240,120,160,0.8)'; c.lineWidth = 3;
    for (let k = 0; k < 4; k++) c.strokeRect(-fw * 0.32 - k * 10, -fh * 0.45 - k * 8, fw * 0.64 + k * 20, fh * 0.9 + k * 16);
    c.strokeStyle = 'rgba(120,200,230,0.7)'; c.strokeRect(-fw * 0.31, -fh * 0.44, fw * 0.62, fh * 0.88);
    const iw = fw * 0.6, ih = fh * 0.86;
    c.fillStyle = '#12102C'; c.fillRect(-iw / 2, -ih / 2, iw, ih);
    const rnd = mulberry32(5); c.fillStyle = '#FFFFFF';
    for (let i = 0; i < 220; i++) { const x = (rnd() - 0.5) * iw, y = (rnd() - 0.5) * ih; c.globalAlpha = 0.3 + 0.7 * hash(i, Math.round(T * 30)); c.fillRect(x, y, 2, 2); }
    c.globalAlpha = 1;
    c.restore();
    const r = H * 0.1 * (1 - ease.outCubic(prog(T, CLOSE, CROSS - 0.05)) * 0.82);
    c.strokeStyle = '#F0E6C0'; c.lineWidth = 3; c.beginPath(); c.arc(CX, CY, r * 1.3, 0, Math.PI * 2); c.stroke();
    this.sun(c, r, 1);
    this.flare(c, W * 0.37);
    return { ca: 3, bloom: 0.6 };
  }
}

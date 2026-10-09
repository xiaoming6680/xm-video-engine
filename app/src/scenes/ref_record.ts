// ?ref=record: frame-matched re-creation of the kaomoji.exe record (its 39.9–41.5 s; docs/复刻配方.md): a vinyl of fine
// grooves and halftone dot bands (their colour swaps on the beat), a pink label with the face, three rings of kaomoji on
// the tangent turning against each other, a dotted sheen, halftone BOOMs, red scan glitches, then it shrinks away.
// Local seconds T = f.lt match the reference from 39.9 s. Wording is our own.
import type * as THREE from 'three';
import { Scene, type Frame } from '../engine/scene';
import { Layer2D, W, H } from '../engine/gl';
import { F, font } from '../engine/type';
import { ease, prog, keys, mulberry32 } from '../engine/util';

type Ctx = CanvasRenderingContext2D;
const NAVY = '#0E0D21', PINK = '#F2489B', ORANGE = '#F0B048', CREAM = '#FBF4E4', INK = '#120E1C';
const CYAN = '#3DA9D6', DOTPINK = '#E8559A', SKY = '#2FB0E8';
const CX = W / 2, CY = H * 0.47, RW = Math.round(H * 1.9);

/** Text on a circle, glyphs on the tangent (tops outward); per-glyph colours via `colour(i, ch)`. */
function ring(c: Ctx, text: string, r: number, px: number, start: number, colour: (ch: string) => string, outline: number, count = 0) {
  c.save(); c.font = font(F.archivo(100, 800), px); c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
  const gs = [...text], ws = gs.map((g) => c.measureText(g).width), total = ws.reduce((a, b) => a + b, 0);
  // `count`: that many copies spaced evenly round the circle (gaps between them); 0 = as many as fit, packed
  const reps = count || Math.max(1, Math.floor((2 * Math.PI * r) / total)), spread = count ? 1 : (2 * Math.PI * r) / (total * reps);
  const gap = count ? (2 * Math.PI * r - total * reps) / reps : 0;
  let s = 0;
  for (let k = 0; k < reps; k++) { if (k) s += gap; gs.forEach((g, i) => {
    const w = ws[i]! * spread, a = start + (s + w / 2) / r; s += w;
    if (g === ' ') return;
    c.save(); c.translate(CX + Math.cos(a) * r, CY + Math.sin(a) * r); c.rotate(a + Math.PI / 2);
    c.strokeStyle = INK; c.lineWidth = outline; c.strokeText(g, 2, 3); c.strokeText(g, 0, 0);
    c.fillStyle = colour(g); c.fillText(g, 0, 0);
    c.restore();
  }); }
  c.restore();
}

/** A band of halftone dots between r0 and r1 (dots biggest in the band's middle). */
function halftone(c: Ctx, r0: number, r1: number, col: string, step = 13, rot = 0) {
  c.fillStyle = col;
  for (let r = r0 + step / 2; r < r1; r += step) {
    const u = (r - r0) / (r1 - r0), size = step * 0.24 * Math.sin(Math.PI * u) + 0.5;
    const n = Math.floor((2 * Math.PI * r) / step);
    for (let i = 0; i < n; i++) { const a = rot + (i / n) * Math.PI * 2; c.beginPath(); c.arc(CX + Math.cos(a) * r, CY + Math.sin(a) * r, size, 0, Math.PI * 2); c.fill(); }
  }
}

/** Halftone BOOM: dots inside the letters, dark outline, a blue offset shadow. */
function boom(c: Ctx, x: number, y: number, px: number, rot: number, fill: string, dots: string, shadow: string, p: number) {
  if (p <= 0) return;
  const s = ease.outBack(Math.min(1, p * 1.6));
  c.save(); c.translate(x, y); c.rotate(rot); c.scale(s, s);
  c.font = font(F.archivo(112.5, 900), px); c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
  c.fillStyle = shadow; c.fillText('BOOM', 10, 12);
  c.strokeStyle = INK; c.lineWidth = px * 0.09; c.strokeText('BOOM', 0, 0);
  c.fillStyle = fill; c.fillText('BOOM', 0, 0);
  c.save(); c.globalCompositeOperation = 'source-atop';
  c.fillStyle = dots;
  for (let yy = -px * 0.6; yy < px * 0.6; yy += 11) for (let xx = -px * 1.6; xx < px * 1.6; xx += 11) { c.beginPath(); c.arc(xx + (yy % 22 ? 5.5 : 0), yy, 3.6, 0, Math.PI * 2); c.fill(); }
  c.restore();
  c.restore();
}

export default class RefRecord extends Scene {
  layer = new Layer2D();
  // the whole record (radius 0.92H) needs a canvas taller than the frame
  rec = new Layer2D(RW, RW);

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp } = this.ctx, T = f.lt, c = this.layer.ctx;
    const end = prog(T, 1.38, 1.5);
    this.layer.clear(T < 0.08 ? SKY : end > 0 ? '#FDF0DB' : NAVY);
    if (end > 0) {
      // the paper behind: pink halftone dots
      c.fillStyle = '#EC6F98';
      for (let y = 0; y < H; y += 18) for (let x = (y / 18) % 2 ? 9 : 0; x < W; x += 18) { c.beginPath(); c.arc(x, y, 5.2, 0, Math.PI * 2); c.fill(); }
    }
    // the record (drawn on its own layer, then placed: scale in from the previous shot, out at the end)
    this.drawRecord(T);
    const sc = keys(T, [[0, 0.95], [0.06, 1.0, ease.outCubic], [1.32, 1.02], [1.38, 1.08, ease.outQuad], [1.45, 0.72, ease.inOutCubic], [1.6, 0.42, ease.inOutCubic]]);
    const rot = T < 0.06 ? (0.06 - T) * 3 : 0;
    c.save(); c.translate(CX, CY); c.rotate(rot); c.scale(sc, sc); c.translate(-CX, -CY);
    c.drawImage(this.rec.canvas, CX - RW / 2, CY - RW / 2, RW, RW);
    c.restore();
    if (end < 0.5) this.overlay(c, T);
    comp.draw(renderer, this.layer.upload(), out, { mode: 'replace' });
    const glitch = [0.9, 1.0, 1.1].some((g) => T > g - 0.02 && T < g + 0.03) ? 0.18 : 0;
    return { bloom: 0.15, bloomThreshold: 1.1, grain: 0.05, vignette: 0.25, ca: 1.4 + 6 * glitch, glitch, glitchSeed: Math.floor(T * 10), halation: 0 };
  }

  private drawRecord(T: number) {
    const c = this.rec.ctx; this.rec.clear();
    c.save(); c.translate(RW / 2 - CX, RW / 2 - CY); c.beginPath(); c.arc(CX, CY, H * 0.92, 0, Math.PI * 2); c.clip();
    c.fillStyle = NAVY; c.fillRect(-W, -H, 3 * W, 3 * H);
    const beat = Math.floor((T - 0.1) / 0.3), swap = beat % 2 === 1;
    // halftone bands (inner one swaps cyan / pink on the beat), white dust far out
    halftone(c, H * 0.255, H * 0.45, swap ? DOTPINK : CYAN, 11, T * 0.3);
    halftone(c, H * 0.62, H * 0.9, swap ? CYAN : DOTPINK, 11, -T * 0.2);
    halftone(c, H * 0.95, H * 1.3, 'rgba(235,235,250,0.85)', 12, T * 0.1);
    // grooves
    c.strokeStyle = 'rgba(205,205,235,0.32)'; c.lineWidth = 1.3;
    for (let r = H * 0.25; r < H * 1.35; r += 13) { c.beginPath(); c.arc(CX, CY, r, 0, Math.PI * 2); c.stroke(); }
    c.strokeStyle = 'rgba(10,8,20,0.9)'; c.lineWidth = 16;
    for (const r of [H * 0.47, H * 0.6, H * 0.93]) { c.beginPath(); c.arc(CX, CY, r, 0, Math.PI * 2); c.stroke(); }
    // the outer zone: dark grey sectors (seen when the record is small)
    for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2 + T * 0.1; c.fillStyle = k % 2 ? 'rgba(70,70,82,0.55)' : 'rgba(40,40,52,0.55)'; c.beginPath(); c.arc(CX, CY, H * 0.92, a, a + Math.PI / 6); c.arc(CX, CY, H * 0.6, a + Math.PI / 6, a, true); c.closePath(); c.fill(); }
    // the label
    c.fillStyle = '#000'; c.beginPath(); c.arc(CX, CY, H * 0.245, 0, Math.PI * 2); c.fill();
    c.fillStyle = PINK; c.beginPath(); c.arc(CX, CY, H * 0.21, 0, Math.PI * 2); c.fill();
    const bytes = '66 28 74 29 · 66 28 74 29 · 20 3D 20 · ';
    c.save(); c.font = font(F.mono(500), 15); c.fillStyle = 'rgba(70,10,40,0.75)'; c.textAlign = 'center'; c.textBaseline = 'middle';
    const n = bytes.length * 2;
    for (let i = 0; i < n; i++) { const a = T * 0.5 + (i / n) * Math.PI * 2; c.save(); c.translate(CX + Math.cos(a) * H * 0.19, CY + Math.sin(a) * H * 0.19); c.rotate(a + Math.PI / 2); c.fillText(bytes[i % bytes.length]!, 0, 0); c.restore(); }
    c.restore();
    // the face on the label: orange, a cream outline, a dark offset shadow
    c.save(); c.font = font(F.archivo(100, 800), H * 0.225); c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
    const fy = CY + H * 0.005;
    c.fillStyle = INK; c.strokeStyle = INK; c.lineWidth = 16; c.strokeText('(•ω•)', CX + 6, fy + 8); c.fillText('(•ω•)', CX + 6, fy + 8);
    c.strokeStyle = CREAM; c.lineWidth = 12; c.strokeText('(•ω•)', CX, fy);
    c.fillStyle = ORANGE; c.fillText('(•ω•)', CX, fy);
    c.restore();
    // rings of kaomoji on the tangent
    const accent = (ch: string) => ('mwω'.includes(ch) ? ORANGE : CREAM);
    const ring1 = beat % 2 ? '(nwn)   (umu)' : '(umu)   (umu)';
    ring(c, ring1, H * 0.33, H * 0.072, T * 0.55, accent, 7, 4);
    ring(c, '\\(=✿ω✿=)/ ', H * 0.545, H * 0.05, -T * 0.35, accent, 5);
    ring(c, 'v(\'ω\')v', H * 0.8, H * 0.05, T * 0.22, accent, 5, 9);
    // the dotted sheen across the record
    c.save(); c.translate(CX, CY); c.rotate(-0.78 + T * 0.05);
    c.beginPath(); c.rect(-H * 1.4, -H * 0.045, H * 2.8, H * 0.09); c.clip();
    c.fillStyle = 'rgba(255,255,255,0.4)';
    for (let x = -H * 1.4; x < H * 1.4; x += 8) for (let y = -H * 0.05; y < H * 0.05; y += 8) { c.beginPath(); c.arc(x + (y % 16 ? 4 : 0), y, 2.4, 0, Math.PI * 2); c.fill(); }
    c.restore();
    c.restore();
    this.rec.upload();
  }

  /** Over the record: BOOMs, the red scan glitch lines, the monitor panel. */
  private overlay(c: Ctx, T: number) {
    boom(c, W * 0.5, H * 0.06, 150, -0.04, '#F06AAE', '#FFC0E0', '#3A5BB0', prog(T, 0.08, 0.2) * (1 - prog(T, 0.36, 0.42)));
    boom(c, W * 0.55, H * 0.98, 170, -0.3, '#33A6E0', '#B7E8FF', '#2A2A6A', prog(T, 0.88, 1.0) * (1 - prog(T, 1.16, 1.22)));
    // red scan lines (40.8, 40.9, 41.0)
    for (const [t0, y] of [[0.9, H * 0.04], [1.0, H * 0.47], [1.1, H * 0.86]] as const) {
      if (T < t0 - 0.03 || T > t0 + 0.05) continue;
      const g = c.createLinearGradient(0, y - 22, 0, y + 22);
      g.addColorStop(0, 'rgba(230,40,50,0)'); g.addColorStop(0.5, 'rgba(240,60,70,0.85)'); g.addColorStop(1, 'rgba(230,40,50,0)');
      c.fillStyle = g; c.fillRect(0, y - 22, W, 44);
    }
    if (T > 0.5) {
      const x = 50, y = H * 0.9, w = 500, h = 120;
      c.fillStyle = 'rgba(8,10,24,0.88)'; c.fillRect(x, y, w, h);
      c.strokeStyle = 'rgba(190,200,220,0.7)'; c.lineWidth = 2; c.strokeRect(x + 6, y + 6, w - 12, h - 12);
      c.font = font(F.mono(500), 20); c.textBaseline = 'middle';
      c.fillStyle = '#0B0C18'; c.fillRect(x + 20, y - 2, 300, 16); c.fillStyle = '#C9D2E0'; c.fillText('frame.exe :: render monitor', x + 24, y + 6);
      const rnd = mulberry32(Math.floor(T * 8));
      c.fillStyle = '#5BE38C'; c.fillText('frames   ∞', x + 22, y + 38);
      c.fillStyle = '#F0B048'; c.fillText('memory', x + 22, y + 66); c.fillText(`${'@'.repeat(19)}# ${97 + Math.floor(rnd() * 3)}%`, x + 132, y + 66);
      c.fillText('cpu', x + 22, y + 94); c.fillText(`${'@'.repeat(20)} 100%`, x + 132, y + 94);
    }
  }
}

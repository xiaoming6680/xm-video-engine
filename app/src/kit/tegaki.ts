// The tegaki (手書き) look (from Still_Shining v2.0): drawings held on 8 fps with line boil, on paper, lettered by
// hand; the code adds the accents a hand-drawn MV would draw on top: scribbled speed lines, a pen-drawn sun, tear
// beads, the name card, ink splashes — all re-drawn (jittered) on every drawing step, like the drawings.
import { W, H } from '../engine/gl';
import type { Line } from '../engine/lyrics';
import { strokeText, drawStrokeText, writtenLength, type StrokeText } from '../engine/stroke';
import { clamp, hash } from '../engine/util';
import { lineProgress } from './lyrics-kit';

/** Drawings per second (held "on threes" at 24 fps). */
export const TG_FPS = 8;
/** The drawing step at time t (changes TG_FPS times a second). */
export const tgStep = (t: number) => Math.floor(t * TG_FPS + 1e-6);
/** Time quantized to the drawing step (motion "on threes"). */
export const tgTime = (t: number) => tgStep(t) / TG_FPS;

export const INK = '#16161c';
export const RED = '#d0202e';
export const BLUE = '#2a5bd7';
export const PAPER = '#f6f1e7';
/**
 * Hand-written Chinese face. Still_Shining used the user's 华文行楷 (STXingkai, commercial: add it per project via
 * src/config.ts EXTRA_FONTS); without it the text falls back to Noto Serif SC. An OFL brush face (Zhi Mang Xing,
 * Ma Shan Zheng, docs/方法.md) works too: put the file in public/fonts and its family here.
 */
export const HAND_ZH = '"STXingkai", "NotoSerifSC-600"';

/** Deterministic jitter in [-1, 1] for an element on a drawing step. */
export const jit = (step: number, i: number, k = 0) => hash(step * 1.618 + k * 9.7, i * 3.3 + k) * 2 - 1;

let paperCanvas: HTMLCanvasElement | null = null;
/** Off-white paper with fibres and a faint tooth (made once). */
export function paper(): HTMLCanvasElement {
  if (paperCanvas) return paperCanvas;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d')!;
  x.fillStyle = PAPER;
  x.fillRect(0, 0, W, H);
  const img = x.getImageData(0, 0, W, H), d = img.data;
  for (let i = 0; i < W * H; i++) {
    const n = (hash(i % W, Math.floor(i / W)) - 0.5) * 10;
    d[i * 4] += n; d[i * 4 + 1] += n; d[i * 4 + 2] += n * 0.9;
  }
  x.putImageData(img, 0, 0);
  x.globalAlpha = 0.06;
  x.strokeStyle = '#8a7f6a';
  for (let i = 0; i < 600; i++) {
    const px = hash(i, 1) * W, py = hash(i, 2) * H, a = hash(i, 3) * Math.PI, l = 8 + 30 * hash(i, 4);
    x.lineWidth = 0.6;
    x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l); x.stroke();
  }
  // a soft darkening at the edges (scanned-page feel)
  const g = x.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(90,70,40,0.12)');
  x.globalAlpha = 1; x.fillStyle = g; x.fillRect(0, 0, W, H);
  paperCanvas = c;
  return c;
}

/** A pen line through points, wobbled per drawing step (re-drawn by hand every frame of the drawing). */
export function penLine(c: CanvasRenderingContext2D, pts: [number, number][], step: number, seed: number, w = 3, color = INK, wob = 2.2) {
  c.save();
  c.strokeStyle = color;
  c.lineWidth = w;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.beginPath();
  pts.forEach(([x, y], i) => {
    const px = x + jit(step, i, seed) * wob, py = y + jit(step, i + 50, seed) * wob;
    if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
  });
  c.stroke();
  c.restore();
}

/** A hand-drawn circle (slightly open, overshooting its start, wobbly). */
export function penCircle(c: CanvasRenderingContext2D, x: number, y: number, r: number, step: number, seed: number, w = 3, color = INK, turns = 1.08) {
  const pts: [number, number][] = [];
  const a0 = jit(0, 1, seed) * Math.PI;
  for (let i = 0; i <= 40; i++) {
    const a = a0 + (i / 40) * Math.PI * 2 * turns;
    const rr = r * (1 + 0.04 * Math.sin(a * 3 + seed) + 0.03 * jit(step, i, seed + 5));
    pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr]);
  }
  penLine(c, pts, step, seed, w, color, 0.8);
}

/**
 * Pen speed lines: strokes in lanes travelling along `dir` at `speed` px/s (smooth motion: they do not jump about
 * from step to step, which read as jitter); only their pen wobble follows the drawing step.
 */
export function speedLines(c: CanvasRenderingContext2D, dir: [number, number], step: number, n: number, color = INK, alpha = 0.55, clearR = 0, t = 0, speed = 1800) {
  const [dx, dy] = dir, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
  c.save();
  c.globalAlpha = alpha;
  for (let i = 0; i < n; i++) {
    const r1 = hash(i, 1), r2 = hash(i, 2), r3 = hash(i, 3);
    const tt = t * speed * (0.7 + 0.6 * r3);
    const wrap = (v: number, m: number) => ((v % m) + m) % m;
    const px = wrap(r1 * W + ux * tt, W + 400) - 200, py = wrap(r2 * H + uy * tt, H + 400) - 200;
    if (clearR > 0 && Math.hypot(px - W / 2, py - H / 2) < clearR) continue;
    const len = 80 + 260 * r3;
    penLine(c, [[px, py], [px + ux * len * 0.5, py + uy * len * 0.5], [px + ux * len, py + uy * len]], step, i, 1.5 + 2 * r3, color, 0.6);
  }
  c.restore();
}

/** A pen-drawn sun: a circle and uneven rays, slowly turning. */
export function penSun(c: CanvasRenderingContext2D, x: number, y: number, r: number, step: number, color = RED) {
  penCircle(c, x, y, r, step, 3, 4, color);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + step * 0.05;
    const r0 = r * 1.3, r1 = r * (1.7 + 0.35 * ((i % 2) ? 1 : 0.4) + 0.1 * jit(step, i, 4));
    penLine(c, [[x + Math.cos(a) * r0, y + Math.sin(a) * r0], [x + Math.cos(a) * r1, y + Math.sin(a) * r1]], step, i + 20, 3.5, color, 1.5);
  }
}

/** A tear bead, drawn: blue outline, a white highlight, a pale fill. */
export function penTear(c: CanvasRenderingContext2D, x: number, y: number, r: number, step: number, seed: number, a = 1) {
  if (r < 1 || a <= 0) return;
  c.save();
  c.globalAlpha = a;
  c.fillStyle = 'rgba(200,225,255,0.55)';
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  penCircle(c, x, y, r, step, seed, Math.max(1.5, r * 0.09), BLUE, 1.0);
  c.fillStyle = '#ffffff';
  c.beginPath(); c.ellipse(x - r * 0.35, y - r * 0.35, r * 0.22, r * 0.13, -0.6, 0, Math.PI * 2); c.fill();
  c.restore();
}

/** The name card, drawn: a wobbly white rectangle with a red band and the name written by hand. */
export function penCard(c: CanvasRenderingContext2D, x: number, y: number, w: number, rot: number, flip: number, name: string, step: number) {
  const h = w * 0.62, sx = Math.cos(flip);
  c.save();
  c.translate(x, y);
  c.rotate(rot);
  c.scale(Math.max(0.05, Math.abs(sx)), 1);
  c.fillStyle = '#ffffff';
  c.fillRect(-w / 2, -h / 2, w, h);
  c.fillStyle = RED;
  c.fillRect(-w / 2, -h / 2, w * 0.1, h);
  penLine(c, [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2], [-w / 2, -h / 2]], step, 7, Math.max(2, w * 0.012));
  if (sx > 0.3) {
    c.fillStyle = INK;
    c.font = `${w * 0.16}px ${HAND_ZH}`;
    c.textBaseline = 'middle';
    c.fillText(name, -w / 2 + w * 0.17, -h * 0.05);
  }
  c.restore();
}

/** An ink splash (impacts): blobs and flicks around a point, in the drawing step's shape. */
export function inkSplash(c: CanvasRenderingContext2D, x: number, y: number, r: number, step: number, color = RED, a = 1) {
  c.save();
  c.globalAlpha = a;
  c.fillStyle = color;
  for (let i = 0; i < 14; i++) {
    const ang = hash(i, 5) * Math.PI * 2, d = r * (0.3 + 0.9 * hash(i, 6)), s = r * (0.04 + 0.12 * hash(i, 7));
    c.beginPath(); c.arc(x + Math.cos(ang) * d + jit(step, i, 2) * 2, y + Math.sin(ang) * d + jit(step, i, 3) * 2, s, 0, Math.PI * 2); c.fill();
  }
  c.restore();
}

/**
 * Hand-lettered lyric: the English written by a pen (single-stroke script, each word while it is sung), the Chinese
 * in 华文行楷 below, each character appearing with the voice. Slightly tilted, re-jittered every drawing step.
 */
const stCache = new Map<string, StrokeText>();
export function handLyric(c: CanvasRenderingContext2D, L: Line, t: number, o: { x: number; y: number; size?: number; rot?: number; color?: string; zhColor?: string; maxWidth?: number; step: number }) {
  const size = o.size ?? 64;
  const key = `${L.i}:${size}`;
  let st = stCache.get(key);
  if (!st) { st = strokeText(L.text, 'hscript', size); stCache.set(key, st); }
  // char times from the word times
  const times: [number, number][] = [];
  let ci = 0;
  for (const w of L.words) {
    const n = Array.from(w.w).length;
    for (let k = 0; k < n; k++) times[ci + k] = [w.start + (k / n) * Math.min(0.25, w.end - w.start), w.start + ((k + 1) / n) * Math.min(0.25, w.end - w.start)];
    ci += n;
    times[ci] = [w.end, w.end];      // the space
    ci += 1;
  }
  const len = writtenLength(st, times, t);
  const maxW = o.maxWidth ?? 1300;
  const k = Math.min(1, maxW / st.width);
  c.save();
  c.translate(o.x, o.y);
  c.rotate(o.rot ?? -0.03);
  c.scale(k, k);
  c.strokeStyle = o.color ?? INK;
  c.lineWidth = size * 0.09;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  drawStrokeText(c, st, len);
  c.restore();
  if (L.zh) {
    const p = lineProgress(L, t);
    const chars = Array.from(L.zh);
    const zs = size * 0.72;
    c.save();
    c.translate(o.x, o.y + size * 0.95);
    c.rotate((o.rot ?? -0.03) * 0.6);
    c.font = `${zs}px ${HAND_ZH}`;
    c.fillStyle = o.zhColor ?? (o.color ?? INK);
    c.textBaseline = 'alphabetic';
    let x = 0;
    chars.forEach((ch, i) => {
      const cw = c.measureText(ch).width;
      const shown = clamp(p * chars.length - i);
      if (shown > 0) {
        c.globalAlpha = shown;
        const px = x, py = 0;
        c.lineWidth = zs * 0.035;
        c.strokeStyle = c.fillStyle as string;
        c.strokeText(ch, px, py);      // (华文行楷 is thin: a hairline stroke gives it the weight of a felt pen)
        c.fillText(ch, px, py);
      }
      x += cw;
    });
    c.restore();
  }
}

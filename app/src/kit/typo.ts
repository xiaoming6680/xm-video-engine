// The lyric-typography look (from Still_Shining v3.0): giant condensed caps as windows onto a painting (outside
// them flat colour), small sung type, Chinese in 思源黑体 Heavy. A TypoFrame holds the three layers of a shot:
//   pic   the painting (HDR target) — what shows inside the letters;
//   pic2  (optional) a second painting for outside the letters, dimmed by ghost2 and tinted;
//   mask  the window letters (white on transparent), drawn under the shot's camera;
//   over  everything drawn normally on top (small type, the Chinese, lines, the sun disk, the cursor).
import * as THREE from 'three';
import { FSPass, Layer2D, W, H, makeRT } from '../engine/gl';
import type { Line, Word } from '../engine/lyrics';
import { clamp, ease } from '../engine/util';
import { lineProgress } from './lyrics-kit';

export const DISPLAY = 'Archivo-620-900';        // the cover's condensed black caps
export const TEXT = 'Archivo-1000-500';
export const LIGHT = 'Archivo-1000-300';
export const ZHH = 'NotoSansSC-900';
export const ZHM = 'NotoSansSC-500';

let mc: CanvasRenderingContext2D | null = null;
const m = () => (mc ??= document.createElement('canvas').getContext('2d')!);

export interface Glyph { ch: string; x: number; w: number }
export interface Run { text: string; family: string; size: number; cap: number; width: number; glyphs: Glyph[] }

/** Lay out caps so their cap height is `cap` px; tracking in em. Glyphs carry kerned x positions. */
export function run(text: string, cap: number, family = DISPLAY, tracking = 0): Run {
  const c = m();
  c.font = `100px "${family}"`;
  const capAt100 = c.measureText('H').actualBoundingBoxAscent || 72;
  const size = (cap / capAt100) * 100;
  c.font = `${size}px "${family}"`;
  const chars = Array.from(text);
  const glyphs: Glyph[] = [];
  let prefix = '';
  chars.forEach((ch, i) => {
    prefix += ch;
    const w = c.measureText(ch).width;
    glyphs.push({ ch, x: c.measureText(prefix).width - w + i * tracking * size, w });
  });
  const width = chars.length ? glyphs[glyphs.length - 1]!.x + glyphs[glyphs.length - 1]!.w : 0;
  return { text, family, size, cap, width, glyphs };
}

/** Cap height that makes `text` exactly `width` px wide. */
export function capToFit(text: string, width: number, family = DISPLAY, tracking = 0) {
  const r = run(text, 100, family, tracking);
  return (100 * width) / Math.max(1, r.width);
}

export interface GlyphT { dx?: number; dy?: number; rot?: number; sx?: number; sy?: number; a?: number }

/** Draw a run with its left baseline at (x, y); `per(i)` transforms each glyph about its centre (mid cap height). */
export function drawRun(c: CanvasRenderingContext2D, r: Run, x: number, y: number, per?: (i: number, g: Glyph) => GlyphT | null, stroke = 0) {
  c.font = `${r.size}px "${r.family}"`;
  c.textBaseline = 'alphabetic';
  c.textAlign = 'left';
  r.glyphs.forEach((g, i) => {
    const t = per ? per(i, g) : {};
    if (t === null) return;
    const a = t.a ?? 1;
    if (a <= 0.001) return;
    c.save();
    c.globalAlpha *= a;
    const cx = x + g.x + g.w / 2 + (t.dx ?? 0), cy = y - r.cap / 2 + (t.dy ?? 0);
    c.translate(cx, cy);
    if (t.rot) c.rotate(t.rot);
    c.scale(t.sx ?? 1, t.sy ?? 1);
    if (stroke > 0) { c.lineWidth = stroke; c.strokeText(g.ch, -g.w / 2, r.cap / 2); }
    else c.fillText(g.ch, -g.w / 2, r.cap / 2);
    c.restore();
  });
}

/** A key word's entrance at its onset t0: scale overshoot (1.18 → 1) and a fade over ~60 ms. */
export function slam(t: number, t0: number, k = 0.18, dur = 0.22): { s: number; a: number } {
  if (t < t0) return { s: 1 + k, a: 0 };
  const u = clamp((t - t0) / dur);
  return { s: 1 + k * (1 - ease.outCubic(u)) - 0.03 * Math.sin(u * Math.PI), a: clamp((t - t0) / 0.06) };
}

/** First word of the line matching re (or word i). */
export function kw(L: Line, re: RegExp, i = 0): Word {
  return L.words.find((w) => re.test(w.w)) ?? L.words[Math.min(i, L.words.length - 1)]!;
}
export const bareUp = (w: Word) => w.w.replace(/[^\p{L}\p{N}'’]/gu, '').toUpperCase();

/** The small sung line (words light on their onsets; unsung ahead faint). Returns the width. */
export function smallLine(c: CanvasRenderingContext2D, L: Line, t: number, x: number, y: number, o: { size?: number; family?: string; color?: string; align?: 'left' | 'center' | 'right'; from?: number; to?: number; ahead?: number; upper?: boolean; tracking?: number } = {}) {
  const size = o.size ?? 34, fam = o.family ?? TEXT;
  const words = L.words.slice(o.from ?? 0, o.to ?? L.words.length);
  c.font = `${size}px "${fam}"`;
  c.textBaseline = 'alphabetic';
  c.textAlign = 'left';
  c.letterSpacing = `${(o.tracking ?? 0.04) * size}px`;
  const txt = (w: Word) => (o.upper ? w.w.toUpperCase() : w.w);
  const space = c.measureText(' ').width;
  const total = words.reduce((s, w) => s + c.measureText(txt(w)).width, 0) + space * Math.max(0, words.length - 1);
  let px = o.align === 'center' ? x - total / 2 : o.align === 'right' ? x - total : x;
  for (const w of words) {
    const a = t >= w.start ? 1 : (o.ahead ?? 0.22) * clamp(1 + (t - w.start) / 0.5);
    c.globalAlpha = a;
    c.fillStyle = o.color ?? '#ffffff';
    c.fillText(txt(w), px, y);
    px += c.measureText(txt(w)).width + space;
  }
  c.globalAlpha = 1;
  c.letterSpacing = '0px';
  return total;
}

/** The Chinese line, character by character with the voice, in 思源黑体. */
export function zhLine(c: CanvasRenderingContext2D, L: Line, t: number, x: number, y: number, o: { size?: number; family?: string; color?: string; align?: 'left' | 'center' | 'right'; tracking?: number; vertical?: boolean } = {}) {
  if (!L.zh) return;
  const size = o.size ?? 40;
  const chars = Array.from(L.zh);
  const p = lineProgress(L, t) * chars.length;
  c.font = `${size}px "${o.family ?? ZHH}"`;
  c.textBaseline = 'alphabetic';
  c.textAlign = 'left';
  c.fillStyle = o.color ?? '#ffffff';
  const tr = (o.tracking ?? 0.08) * size;
  if (o.vertical) {
    chars.forEach((ch, i) => {
      const a = clamp(p - i);
      if (a <= 0) return;
      c.globalAlpha = a;
      c.fillText(ch, x - size / 2, y + i * (size + tr));
    });
    c.globalAlpha = 1;
    return;
  }
  const widths = chars.map((ch) => c.measureText(ch).width);
  const total = widths.reduce((s, w) => s + w + tr, -tr);
  let px = o.align === 'center' ? x - total / 2 : o.align === 'right' ? x - total : x;
  chars.forEach((ch, i) => {
    const a = clamp(p - i);
    if (a > 0) { c.globalAlpha = a; c.fillText(ch, px, y + (1 - ease.outCubic(a)) * size * 0.25); }
    px += widths[i]! + tr;
  });
  c.globalAlpha = 1;
}

/** sRGB hex -> THREE.Color (linear). */
const col = (hex: string) => new THREE.Color(hex);

/** The three layers of a shot and their composite. */
export class TypoFrame {
  mask = new Layer2D();
  over = new Layer2D();
  pic = makeRT(W, H);
  pic2 = makeRT(W, H);
  pass = new FSPass(/* glsl */ `
    uniform sampler2D pic, mask, pic2; uniform vec3 bgTop, bgBot, tint2; uniform float ghost, ghost2, gain, lift, grey, keepRed, open, inv;
    void main() {
      vec3 p = texture(pic, vUv).rgb;
      float a = max(texture(mask, vUv).a, open);
      vec3 bg = mix(bgBot, bgTop, vUv.y);
      vec3 inside = p * gain + lift;
      vec3 outside = bg + p * ghost + texture(pic2, vUv).rgb * tint2 * ghost2;
      vec3 c = mix(outside, inside, a);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float red = clamp((c.r - max(c.g, c.b)) / max(c.r, 1e-4) * 2.5 - 0.6, 0.0, 1.0) * keepRed;
      c = mix(c, vec3(l), grey * (1.0 - red));
      c = mix(c, vec3(1.0) - c, inv);
      fragColor = vec4(c, 1.0);
    }`, {
    pic: { value: null }, mask: { value: null }, pic2: { value: null }, tint2: { value: new THREE.Vector3(1, 1, 1) }, ghost2: { value: 0 }, bgTop: { value: new THREE.Color() }, bgBot: { value: new THREE.Color() },
    ghost: { value: 0 }, gain: { value: 1.25 }, lift: { value: 0.02 }, grey: { value: 0 }, keepRed: { value: 1 }, open: { value: 0 }, inv: { value: 0 },
  });
  begin() {
    this.mask.clear();
    this.over.clear();
    return { m: this.mask.ctx, o: this.over.ctx };
  }
  compose(renderer: THREE.WebGLRenderer, comp: { draw: (r: THREE.WebGLRenderer, t: THREE.Texture, o: THREE.WebGLRenderTarget) => void }, out: THREE.WebGLRenderTarget,
    s: { top: string; bot?: string; ghost?: number; ghost2?: number; tint2?: [number, number, number]; gain?: number; lift?: number; grey?: number; keepRed?: number; open?: number; inv?: number }) {
    const u = this.pass.u;
    u.pic!.value = this.pic.texture;
    u.mask!.value = this.mask.upload();
    u.pic2!.value = this.pic2.texture;
    u.ghost2!.value = s.ghost2 ?? 0;
    (u.tint2!.value as THREE.Vector3).set(...(s.tint2 ?? [1, 1, 1]));
    (u.bgTop!.value as THREE.Color).copy(col(s.top));
    (u.bgBot!.value as THREE.Color).copy(col(s.bot ?? s.top));
    u.ghost!.value = s.ghost ?? 0;
    u.gain!.value = s.gain ?? 1.25;
    u.lift!.value = s.lift ?? 0.02;
    u.grey!.value = s.grey ?? 0;
    u.keepRed!.value = s.keepRed ?? 1;
    u.open!.value = s.open ?? 0;
    u.inv!.value = s.inv ?? 0;
    this.pass.render(renderer, out);
    comp.draw(renderer, this.over.upload(), out);
  }
}

/** Apply a 2D camera to a context: zoom/rotate about (cx, cy) on screen, then pan. */
export function camera(c: CanvasRenderingContext2D, o: { zoom?: number; rot?: number; x?: number; y?: number; cx?: number; cy?: number }) {
  const cx = o.cx ?? W / 2, cy = o.cy ?? H / 2;
  c.translate(cx + (o.x ?? 0), cy + (o.y ?? 0));
  if (o.rot) c.rotate(o.rot);
  const z = o.zoom ?? 1;
  c.scale(z, z);
  c.translate(-cx, -cy);
}

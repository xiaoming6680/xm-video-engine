// Lyric typography and small scene helpers (from Still_Shining's scenes_old/_kit.ts): English word by word with the
// voice, Chinese revealed character by character in step with it (Line.zh), a standard bottom line, a post look,
// hit pumps, tear drops, sparkles, key cycling.
import { VIDEO_START } from '../config';
import { W, H } from '../engine/gl';
import type { Line, Lyrics } from '../engine/lyrics';
import type { PostOverrides } from '../engine/scene';
import { clamp, ease, hash, lerp } from '../engine/util';

/** Video time of song time t. */
export const vt = (t: number) => t - VIDEO_START;

/** Base post look: crisp anime frames, little grain, soft bloom on the light only. */
export const POST: PostOverrides = { bloom: 0.45, bloomThreshold: 0.9, halation: 0.08, ca: 0.5, grain: 0.02, vignette: 0.18, grade: 0 };

export const EN = (w: number) => `${w}px "Archivo-620-900"`;
export const EN_LIGHT = (w: number) => `${w}px "Archivo-750-300"`;
// (Still_Shining used the user's PingFang here; the base engine ships Noto Sans SC, OFL)
export const ZH = (w: number) => `${w}px "NotoSansSC-900"`;
export const ZH_MED = (w: number) => `${w}px "NotoSansSC-500"`;

/** Strip punctuation for display words used as graphics ("reflection," -> "REFLECTION"). */
export const bare = (s: string) => s.replace(/[^\p{L}\p{N}'’]/gu, '');

/** How far through its line the voice is (0..1, by sung characters). */
export function lineProgress(L: Line, t: number) {
  let sung = 0, total = 0;
  for (const w of L.words) {
    const n = w.w.length;
    total += n;
    if (t >= w.end) sung += n;
    else if (t > w.start) sung += n * clamp((t - w.start) / Math.max(0.05, w.end - w.start));
  }
  return total ? sung / total : 0;
}

export interface LineStyle {
  x: number;
  y: number;
  size: number;
  align?: 'left' | 'center' | 'right';
  maxWidth?: number;
  /** Words from..to (exclusive) only. */
  from?: number;
  to?: number;
  color?: string;
  /** Alpha of words not sung yet (0 = they appear on their onset). */
  ahead?: number;
  /** Each word drifts by this (px/s) after it is sung (tears float up …). */
  drift?: [number, number];
  /** Pop on the onset: scale overshoot. */
  pop?: number;
  upper?: boolean;
  /** Chinese below (or at zhY) — revealed char by char with the line's progress. */
  zh?: boolean;
  zhSize?: number;
  zhY?: number;
  zhX?: number;
  zhAlign?: 'left' | 'center' | 'right';
  shadow?: string;
  opacity?: number;
  /** Anchor the block by its bottom (the Chinese baseline, or the last English row): y is then ignored. */
  bottom?: number;
  /** A soft dark pool behind the block (alpha), so the white type reads on bright skies too. */
  scrim?: number;
}

/** Draw a lyric line synced to the voice (words light on their onsets, the Chinese follows the progress). */
export function drawLine(c: CanvasRenderingContext2D, L: Line, t: number, s: LineStyle) {
  const a0 = s.opacity ?? 1;
  if (a0 <= 0.001) return;
  const words = L.words.slice(s.from ?? 0, s.to ?? L.words.length);
  c.save();
  c.font = EN(s.size);
  c.textBaseline = 'alphabetic';
  if (s.shadow) { c.shadowColor = s.shadow; c.shadowBlur = s.size * 0.35; }
  const space = c.measureText(' ').width;
  const maxW = s.maxWidth ?? 1e9;
  // lay out in rows
  const rows: { w: (typeof words)[number]; x: number; width: number }[][] = [[]];
  let x = 0;
  for (const w of words) {
    const txt = s.upper ? w.w.toUpperCase() : w.w;
    const width = c.measureText(txt).width;
    if (x > 0 && x + width > maxW) { rows.push([]); x = 0; }
    rows[rows.length - 1]!.push({ w, x, width });
    x += width + space;
  }
  const lh = s.size * 1.08;
  const zs0 = s.zhSize ?? s.size * 0.62;
  const y0 = s.bottom !== undefined ? s.bottom - (s.zh && L.zh ? zs0 * 1.45 : 0) - (rows.length - 1) * lh : s.y;
  if (s.scrim) {
    const bw = Math.max(...rows.map((r) => (r.length ? r[r.length - 1]!.x + r[r.length - 1]!.width : 0)), 300);
    const top = y0 - s.size, bot = y0 + (rows.length - 1) * lh + (s.zh && L.zh ? zs0 * 1.6 : s.size * 0.3);
    const cx = s.align === 'center' ? s.x : s.align === 'right' ? s.x - bw / 2 : s.x + bw / 2, cy = (top + bot) / 2;
    const rx = bw / 2 + 220, ry = (bot - top) / 2 + 120;
    c.save();
    c.shadowBlur = 0;
    c.translate(cx, cy);
    c.scale(rx / ry, 1);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, ry);
    g.addColorStop(0, `rgba(8,16,48,${s.scrim * a0})`);
    g.addColorStop(0.6, `rgba(8,16,48,${s.scrim * 0.6 * a0})`);
    g.addColorStop(1, 'rgba(8,16,48,0)');
    c.fillStyle = g;
    c.fillRect(-ry, -ry, ry * 2, ry * 2);
    c.restore();
  }
  rows.forEach((row, ri) => {
    const rowW = row.length ? row[row.length - 1]!.x + row[row.length - 1]!.width : 0;
    const x0 = s.align === 'center' ? s.x - rowW / 2 : s.align === 'right' ? s.x - rowW : s.x;
    for (const it of row) {
      const w = it.w;
      const age = t - w.start;
      let a = age >= 0 ? 1 : (s.ahead ?? 0.22) * clamp(1 + age / 0.4);
      if (a <= 0.001) continue;
      const pop = s.pop ?? 0.18;
      const k = age >= 0 ? 1 + pop * Math.exp(-age / 0.07) * Math.cos(age * 40) : 1;
      const dx = age > 0 && s.drift ? s.drift[0] * age : 0;
      const dy = age > 0 && s.drift ? s.drift[1] * age : 0;
      const txt = s.upper ? w.w.toUpperCase() : w.w;
      c.save();
      c.globalAlpha = a * a0;
      c.fillStyle = s.color ?? '#ffffff';
      const cx = x0 + it.x + it.width / 2 + dx, cy = y0 + ri * lh + dy;
      c.translate(cx, cy);
      c.scale(k, k);
      c.fillText(txt, -it.width / 2, 0);
      c.restore();
    }
  });
  if (s.zh && L.zh) {
    const p = lineProgress(L, t);
    const chars = [...L.zh];
    const n = Math.ceil(chars.length * p);
    const zs = s.zhSize ?? s.size * 0.62;
    c.font = ZH(zs);
    const zy = s.zhY ?? y0 + (rows.length - 1) * lh + zs * 1.45;
    const full = c.measureText(L.zh).width;
    const zx0 = (s.zhX ?? s.x) - ((s.zhAlign ?? s.align) === 'center' ? full / 2 : (s.zhAlign ?? s.align) === 'right' ? full : 0);
    let zx = zx0;
    const per = 0.07; // each character rises in over 70 ms of line progress
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!;
      const cw = c.measureText(ch).width;
      const fi = clamp((p * chars.length - i) / Math.max(1, chars.length * per));
      if (i < n && fi > 0) {
        c.save();
        c.globalAlpha = a0 * ease.outCubic(fi);
        c.fillStyle = s.color ?? '#ffffff';
        c.fillText(ch, zx, zy + (1 - ease.outCubic(fi)) * zs * 0.35);
        c.restore();
      }
      zx += cw;
    }
  }
  c.restore();
}

/**
 * A tear drop: a clear bead with a cool rim, a white specular and, inside, a tiny upside-down sun (the refraction
 * of the light below). `blur` 0..1 softens it (out of focus).
 */
export function drawTear(c: CanvasRenderingContext2D, x: number, y: number, r: number, a = 1, blur = 0) {
  if (r < 0.5 || a <= 0.002) return;
  c.save();
  c.globalAlpha = a;
  if (blur > 0) c.filter = `blur(${(blur * r * 0.35).toFixed(2)}px)`;
  const g = c.createRadialGradient(x - r * 0.2, y - r * 0.25, r * 0.1, x, y, r);
  g.addColorStop(0, 'rgba(230,245,255,0.16)');
  g.addColorStop(0.68, 'rgba(160,205,255,0.28)');
  g.addColorStop(0.9, 'rgba(225,242,255,0.95)');
  g.addColorStop(1, 'rgba(210,235,255,0)');
  c.fillStyle = g;
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
  // a thin cool edge so the bead reads on skin as well as on sky
  c.strokeStyle = 'rgba(40,80,160,0.35)';
  c.lineWidth = Math.max(0.8, r * 0.05);
  c.beginPath();
  c.arc(x, y, r * 0.97, 0, Math.PI * 2);
  c.stroke();
  // inner sun (refracted, near the bottom), and the specular highlight near the top
  const sg = c.createRadialGradient(x + r * 0.08, y + r * 0.42, 0, x + r * 0.08, y + r * 0.42, r * 0.38);
  sg.addColorStop(0, 'rgba(255,250,235,1)');
  sg.addColorStop(0.35, 'rgba(255,214,170,0.75)');
  sg.addColorStop(1, 'rgba(255,190,160,0)');
  c.fillStyle = sg;
  c.beginPath();
  c.arc(x + r * 0.08, y + r * 0.42, r * 0.38, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = 'rgba(255,255,255,0.95)';
  c.beginPath();
  c.ellipse(x - r * 0.32, y - r * 0.38, r * 0.2, r * 0.12, -0.6, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

/** The line on screen at t: from just before its pickup until the next line's pickup (or a moment after it ends). */
export function currentLine(ly: Lyrics, t: number, lead = 0.3, tail = 0.6): Line | null {
  let cur: Line | null = null;
  for (const L of ly.lines) if (t >= L.start - lead) cur = L;
  if (cur && t > cur.end + tail) return null;
  return cur;
}

/** The standard lyric placement (lower left, bilingual), the same in every shot so a line never jumps at a cut. */
export const STD: Omit<LineStyle, 'x' | 'y' | 'size'> & { x: number; y: number; size: number } = {
  x: 90, y: H - 150, bottom: H - 58, size: 58, maxWidth: Math.min(1150, W - 180), ahead: 0.25, zh: true, zhSize: 50, shadow: 'rgba(0,10,40,0.7)', scrim: 0.42,
};

/** Draw whatever line is current in the standard placement (style overrides merge in). */
export function drawStd(c: CanvasRenderingContext2D, ly: Lyrics, t: number, o: Partial<LineStyle> = {}) {
  const L = currentLine(ly, t);
  if (L) drawLine(c, L, t, { ...STD, ...o });
}

/**
 * The drum pump (TREATMENT 三): every kick and snare of the drum & bass nudges the frame (a small push-in and a
 * shake), so the picture breathes with the beat. Merged into a scene's own post overrides (its hits multiply in).
 */
export function pump(audio: { hit: (k: string, t: number, hl?: number) => number }, t: number, post: PostOverrides, k = 1): PostOverrides {
  const kick = audio.hit('kick', t, 0.07), snare = audio.hit('snare', t, 0.09);
  const fi = Math.round(t * 60);
  const z = 1 + k * (0.016 * kick + 0.011 * snare);
  const sh: [number, number] = [k * 4 * snare * Math.sin(fi * 2.1), k * 3.5 * (snare + 0.6 * kick) * Math.cos(fi * 1.7)];
  const own = post.shake ?? [0, 0];
  return { ...post, zoom: (post.zoom ?? 1) * z, shake: [own[0] + sh[0], own[1] + sh[1]] };
}

/** Rotate screen point (x, y) by `r` about the frame centre (the camera roll). */
export function rotAbout(x: number, y: number, r: number, cx = W / 2, cy = H / 2): [number, number] {
  const c = Math.cos(r), s = Math.sin(r), dx = x - cx, dy = y - cy;
  return [cx + c * dx - s * dy, cy + s * dx + c * dy];
}

/** A thin four-point anime sparkle. */
export function sparkle(c: CanvasRenderingContext2D, x: number, y: number, r: number, a: number) {
  c.save();
  c.globalAlpha = a;
  c.translate(x, y);
  c.fillStyle = '#ffffff';
  c.shadowColor = 'rgba(255,230,210,0.9)';
  c.shadowBlur = r * 0.5;
  c.beginPath();
  const w = r * 0.09;
  c.moveTo(0, -r); c.quadraticCurveTo(w, -w, r, 0); c.quadraticCurveTo(w, w, 0, r); c.quadraticCurveTo(-w, w, -r, 0); c.quadraticCurveTo(-w, -w, 0, -r);
  c.fill();
  c.restore();
}

/** Deterministic per-index random in [0, 1). */
export const rnd = (i: number, k = 0) => hash(i * 7.31 + k * 13.7, k * 3.1 + 1.7);
export { lerp, clamp, ease };
export type { Lyrics };

/**
 * Limited animation (TREATMENT v1.1): a sequence of key drawings held on the animator's beat ("on twos/threes"),
 * with a one-frame smear into the next drawing (both drawn, the incoming one stretched along the motion).
 * keys: [time (s, local), drawing index]; returns what to draw at local time lt.
 */
export function keyAt(keys: [number, number][], lt: number, smear = 1 / 30): { a: number; b: number; k: number } {
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1]![0] <= lt) i++;
  const cur = keys[i]!;
  const nxt = keys[i + 1];
  if (nxt && nxt[0] - lt < smear) return { a: cur[1], b: nxt[1], k: 1 - (nxt[0] - lt) / smear };
  return { a: cur[1], b: cur[1], k: 0 };
}

/** Regular key timing: drawings cycle every `step` seconds (e.g. a half beat), starting at t0. */
export function cycleKeys(n: number, step: number, dur: number, t0 = 0, order?: number[]): [number, number][] {
  const out: [number, number][] = [];
  const seq = order ?? Array.from({ length: n }, (_, i) => i);
  for (let t = t0, i = 0; t < dur + step; t += step, i++) out.push([t, seq[i % seq.length]!]);
  return out;
}

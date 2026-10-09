// Narrative HUD pieces for Canvas2D layers: the interface that tells the story in kaomoji.exe (bar plates, terminal
// pop-ups typing commands, the party-monitor panel, labelled call-outs, comic captions, rolling counters, reticles).
// Everything is a pure function of the time you pass in: typing, blinking and counting are computed, not stepped.
//   plate       "06/63" block (+ a small sub-line)              metaLine   "E2 80 A2 · 150 bpm · 4/4 · swiss grid"
//   caption     comic narration box                              callout    leader line + label box + tag, reveals with p
//   panel       title bar, rows of label + segmented bar + value, log lines
//   termWindow  pop-up terminal: lines typed at a rate from their start time, blinking block cursor
//   odometer    rolling digits (the last digit rolls between values)      fmtBig  1,724,783,546 / 9.9×10²⁰ / int32 wrap
//   reticle     ring with ticks and gaps (targeting, the DEFENDER scope)  barText "▮▮▮▮▯▯▯ 64%"
import { F, font } from '../engine/type';
import { frameIdx, clamp, ease } from '../engine/util';

type Ctx = CanvasRenderingContext2D;
const MONO = (px: number, wt = 500) => font(F.mono(wt), px);

/** Characters of `text` typed by time t (started at t0, `cps` characters per second). */
export const typed = (text: string, t: number, t0: number, cps = 30) => [...text].slice(0, Math.max(0, Math.floor((t - t0) * cps))).join('');
/** On/off at `hz`, constant over a frame's shutter (frameIdx). */
export const blink = (t: number, hz = 2) => Math.floor((frameIdx(t) / 60) * hz * 2) % 2 === 0;

const SUP: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻' };
/** Big numbers the way the HUD shows them: grouped (1,724,783,546), scientific (9.9×10²⁰) above `sciFrom`, or int32 wrap. */
export function fmtBig(v: number, o: { sciFrom?: number; int32?: boolean; sep?: string } = {}) {
  if (!isFinite(v)) return '∞';
  if (o.int32) v = (Math.trunc(v) | 0);
  if (Math.abs(v) >= (o.sciFrom ?? 1e15)) {
    const e = Math.floor(Math.log10(Math.abs(v))), m = v / 10 ** e;
    return `${m.toFixed(1)}×10${[...String(e)].map((d) => SUP[d] ?? d).join('')}`;
  }
  return Math.trunc(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, o.sep ?? ',');
}

export interface Box { x: number; y: number; w: number; h: number }

/** "06/63" plate (right-aligned at x when align = 'right'). Returns its box. */
export function plate(c: Ctx, x: number, y: number, text: string, o: { sub?: string; size?: number; bg?: string; fg?: string; align?: 'left' | 'right' } = {}): Box {
  const s = o.size ?? 26;
  c.save();
  c.font = font(F.archivo(100, 900), s);
  const w = c.measureText(text).width + s * 0.7, h = s * (o.sub ? 1.75 : 1.3);
  const bx = o.align === 'right' ? x - w : x;
  c.fillStyle = o.bg ?? 'rgba(40,40,44,0.92)';
  c.beginPath(); c.roundRect(bx, y, w, h, s * 0.18); c.fill();
  c.fillStyle = o.fg ?? '#F4F1EA'; c.textBaseline = 'middle'; c.textAlign = 'center';
  c.fillText(text, bx + w / 2, y + s * 0.66);
  if (o.sub) { c.font = MONO(s * 0.32); c.globalAlpha = 0.7; c.fillText(o.sub, bx + w / 2, y + s * 1.36); }
  c.restore();
  return { x: bx, y, w, h };
}

/** A line of small metadata joined by " · " (bottom corners). */
export function metaLine(c: Ctx, x: number, y: number, parts: string[], o: { size?: number; color?: string; align?: CanvasTextAlign } = {}) {
  c.save();
  c.font = MONO(o.size ?? 13, 400); c.fillStyle = o.color ?? 'rgba(120,118,112,0.9)'; c.textAlign = o.align ?? 'right'; c.textBaseline = 'alphabetic';
  c.fillText(parts.join('  ·  '), x, y);
  c.restore();
}

/** Comic narration caption ("MEANWHILE, AT THE BAR..."). */
export function caption(c: Ctx, x: number, y: number, text: string, o: { size?: number; bg?: string; fg?: string; tilt?: number; p?: number } = {}): Box {
  const s = o.size ?? 24, p = o.p ?? 1;
  c.save();
  c.translate(x, y); c.rotate(o.tilt ?? -0.02);
  c.font = font(F.archivo(87.5, 900), s);
  const w = c.measureText(text).width + s * 1.2, h = s * 1.7;
  c.fillStyle = '#141018'; c.fillRect(4, 4, w * p, h);
  c.fillStyle = o.bg ?? '#F7D44C'; c.fillRect(0, 0, w * p, h);
  c.lineWidth = 2.5; c.strokeStyle = '#141018'; c.strokeRect(0, 0, w * p, h);
  c.beginPath(); c.rect(0, 0, w * p, h); c.clip();
  c.fillStyle = o.fg ?? '#141018'; c.textBaseline = 'middle'; c.fillText(text, s * 0.6, h / 2);
  c.restore();
  return { x, y, w, h };
}

/** Leader line from an anchor to a label box with a tag ("bracket.L flipped ✓ #A2"); p 0..1 draws it in. */
export function callout(c: Ctx, o: { ax: number; ay: number; x: number; y: number; text: string; tag?: string; p?: number; size?: number; color?: string; dashed?: boolean }) {
  const p = clamp(o.p ?? 1), s = o.size ?? 15, col = o.color ?? '#E8412C';
  if (p <= 0) return;
  const lp = ease.outCubic(clamp(p * 2)), bp = clamp(p * 2 - 1);
  c.save();
  c.strokeStyle = '#141018'; c.lineWidth = 1.5;
  if (o.dashed) c.setLineDash([5, 4]);
  c.beginPath(); c.moveTo(o.ax, o.ay); c.lineTo(o.ax + (o.x - o.ax) * lp, o.ay + (o.y - o.ay) * lp); c.stroke();
  c.setLineDash([]);
  c.fillStyle = '#141018'; c.beginPath(); c.arc(o.ax, o.ay, 3.5, 0, Math.PI * 2); c.fill();
  if (bp > 0) {
    c.font = MONO(s, 500);
    const txt = [...o.text].slice(0, Math.ceil([...o.text].length * bp)).join('');
    const tw = c.measureText(o.text).width;
    c.font = MONO(s * 0.8, 700);
    const gw = o.tag ? c.measureText(o.tag).width + s * 0.8 : 0;
    c.font = MONO(s, 500);
    const w = tw + s * 1.2 + (o.tag ? gw + s * 0.5 : 0), h = s * 1.7;
    c.fillStyle = '#FFFFFF'; c.fillRect(o.x, o.y - h / 2, w, h);
    c.strokeRect(o.x, o.y - h / 2, w, h);
    c.fillStyle = col; c.textBaseline = 'middle'; c.fillText(txt, o.x + s * 0.6, o.y + 1);
    if (o.tag) {
      c.font = MONO(s * 0.8, 700);
      c.fillStyle = '#141018'; c.fillRect(o.x + w - gw - 3, o.y - h / 2 + 3, gw, h - 6);
      c.fillStyle = '#FFFFFF'; c.fillText(o.tag, o.x + w - gw - 3 + s * 0.4, o.y + 1);
    }
  }
  c.restore();
}

/** "▮▮▮▮▮▯▯▯ 64%" style bar as text. */
export const barText = (v: number, n = 16, on = '▮', off = '-') => on.repeat(Math.round(clamp(v) * n)) + off.repeat(n - Math.round(clamp(v) * n));

export interface PanelRow { label: string; v: number; text?: string; color?: string }
/** The monitor panel: title bar, label + segmented bar + value rows, then log lines. */
export function panel(c: Ctx, x: number, y: number, w: number, o: { title: string; rows: PanelRow[]; log?: { text: string; color?: string }[]; size?: number; alpha?: number }): Box {
  const s = o.size ?? 13, lh = s * 1.5, h = s * 1.9 + (o.rows.length + (o.log?.length ?? 0)) * lh + s * 0.6;
  c.save();
  c.globalAlpha = o.alpha ?? 1;
  c.fillStyle = 'rgba(10,14,16,0.86)'; c.fillRect(x, y, w, h);
  c.strokeStyle = 'rgba(150,170,160,0.6)'; c.lineWidth = 1; c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  c.font = MONO(s, 500); c.textBaseline = 'middle';
  c.fillStyle = 'rgba(200,220,210,0.9)'; c.fillText(o.title, x + s * 0.6, y + s * 0.95);
  c.fillRect(x + s * 0.6 + c.measureText(o.title).width + s * 0.6, y + s * 0.9, w - c.measureText(o.title).width - s * 2, 1);
  let yy = y + s * 1.9 + lh / 2;
  const bx = x + s * 6.5, bw = w - s * 11;
  for (const r of o.rows) {
    c.fillStyle = r.color ?? '#5BE38C'; c.fillText(r.label, x + s * 0.6, yy);
    const segs = 20, on = Math.round(clamp(r.v) * segs), sw = bw / segs;
    for (let i = 0; i < segs; i++) { c.fillStyle = i < on ? (r.color ?? '#5BE38C') : 'rgba(255,255,255,0.12)'; c.fillRect(bx + i * sw, yy - s * 0.3, sw - 1.5, s * 0.6); }
    c.fillStyle = 'rgba(230,235,230,0.9)'; c.textAlign = 'right'; c.fillText(r.text ?? `${Math.round(r.v * 100)}%`, x + w - s * 0.6, yy); c.textAlign = 'left';
    yy += lh;
  }
  for (const l of o.log ?? []) { c.fillStyle = l.color ?? '#E8412C'; c.fillText(l.text, x + s * 0.6, yy); yy += lh; }
  c.restore();
  return { x, y, w, h };
}

export interface TermLine { t: number; text: string; color?: string; size?: number; cps?: number; prompt?: string }
/** A pop-up terminal: each line types from its start time; the cursor blinks after the last typed character. */
export function termWindow(c: Ctx, x: number, y: number, w: number, h: number, t: number, o: { title?: string; lines: TermLine[]; size?: number; open?: number }) {
  const s = o.size ?? 16, op = ease.outBack(clamp(o.open ?? 1));
  if (op <= 0) return;
  c.save();
  c.translate(x + w / 2, y + h / 2); c.scale(1, Math.max(0.02, op)); c.translate(-w / 2, -h / 2);
  c.fillStyle = 'rgba(8,10,12,0.94)'; c.fillRect(0, 0, w, h);
  c.strokeStyle = 'rgba(220,230,225,0.75)'; c.lineWidth = 1.5; c.strokeRect(3, 3, w - 6, h - 6);
  c.font = MONO(s * 0.7, 500); c.textBaseline = 'middle';
  c.fillStyle = 'rgba(200,215,210,0.8)'; c.fillText(o.title ?? 'frame.exe', s * 0.7, s * 0.75);
  c.beginPath(); c.rect(0, s * 1.3, w, h - s * 1.3); c.clip();
  // lines that have started, the last ones kept in view
  const shown = o.lines.filter((l) => t >= l.t);
  let yy = s * 1.5, cx = 0, cy = 0;
  const heights = shown.map((l) => (l.size ?? s) * 1.45), total = heights.reduce((a, b) => a + b, 0), room = h - s * 1.8;
  if (total > room) yy -= total - room;
  shown.forEach((l, i) => {
    const sz = l.size ?? s, txt = (l.prompt ?? '') + typed(l.text, t, l.t, l.cps ?? 40);
    c.font = MONO(sz, sz > s ? 600 : 500); c.fillStyle = l.color ?? '#E6ECE8';
    c.fillText(txt, s * 0.7, yy + heights[i]! / 2);
    cx = s * 0.7 + c.measureText(txt).width + 3; cy = yy + heights[i]! / 2;
    yy += heights[i]!;
  });
  if (shown.length && blink(t)) { c.fillStyle = '#E6ECE8'; c.fillRect(cx, cy - s * 0.55, s * 0.55, s * 1.1); }
  c.restore();
}

/** Rolling digits: `v` may be fractional; the ones digit rolls toward the next value (an odometer). */
export function odometer(c: Ctx, x: number, y: number, v: number, o: { digits?: number; size?: number; color?: string; family?: string; group?: boolean } = {}) {
  const s = o.size ?? 40, n = o.digits ?? 6, iv = Math.floor(v), fr = v - iv;
  c.save();
  c.font = font(o.family ?? F.mono(700), s); c.fillStyle = o.color ?? '#F7A934'; c.textBaseline = 'middle';
  const cw = c.measureText('0').width;
  let str = String(iv).padStart(n, '0'), nxt = String(iv + 1).padStart(n, '0');
  c.beginPath(); c.rect(x, y - s * 0.62, cw * (n + 2), s * 1.24); c.clip();
  let xx = x;
  for (let i = 0; i < str.length; i++) {
    if (o.group && i > 0 && (str.length - i) % 3 === 0) { c.fillText(',', xx, y); xx += cw * 0.6; }
    const a = str[i]!, b = nxt[i]!, roll = a !== b ? ease.inOutCubic(fr) : 0;
    c.fillText(a, xx, y - roll * s * 1.1);
    if (roll > 0) c.fillText(b, xx, y + (1 - roll) * s * 1.1);
    xx += cw;
  }
  c.restore();
}

/** Targeting ring: ticks round a circle, gaps at the four quarters, turning by `rot`. */
export function reticle(c: Ctx, x: number, y: number, r: number, o: { rot?: number; color?: string; ticks?: number; width?: number; gaps?: number } = {}) {
  const col = o.color ?? '#E8412C', n = o.ticks ?? 72, g = o.gaps ?? 4;
  c.save();
  c.translate(x, y); c.rotate(o.rot ?? 0);
  c.strokeStyle = col; c.lineWidth = o.width ?? 2;
  for (let k = 0; k < g; k++) { const a0 = (k / g) * Math.PI * 2 + 0.18, a1 = ((k + 1) / g) * Math.PI * 2 - 0.18; c.beginPath(); c.arc(0, 0, r, a0, a1); c.stroke(); }
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, L = i % 6 === 0 ? r * 0.08 : r * 0.035;
    c.beginPath(); c.moveTo(Math.cos(a) * r, Math.sin(a) * r); c.lineTo(Math.cos(a) * (r - L), Math.sin(a) * (r - L)); c.stroke();
  }
  for (let k = 0; k < g; k++) { const a = (k / g) * Math.PI * 2; c.beginPath(); c.moveTo(Math.cos(a) * r * 1.12, Math.sin(a) * r * 1.12); c.lineTo(Math.cos(a) * r * 0.86, Math.sin(a) * r * 0.86); c.stroke(); }
  c.restore();
}

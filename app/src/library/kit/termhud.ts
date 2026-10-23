// 讲故事的界面部件（Canvas2D 图层）：kaomoji.exe 里的小节牌、弹出终端、队伍监控面板、标注、漫画旁白框、滚动计数、
// 瞄准环；以及科幻 HUD（FUI）的字和面板。全是传进来的 t 的纯函数：打字、闪烁、计数都是算出来的，不是一帧帧累加的。
//
// 为什么要 FUI 这一套：HUD 画面元素多，全都一样亮就是一墙噪点，眼睛不知道看哪。参考片的办法：
//   · 亮度分三档（100 / 60 / 30 %），“正在说话”的那块最亮，别的退到 60 %，背景 30 %，按段落切换，引着视线走；
//   · 字在泛光之后单独合成：自己带 1.5 / 3 px 的辉光，再在背景上压一圈 0.6 的黑晕，字从发光的线和网格里被托出来；
//   · 标签和数字出现时逐字乱码解码，面板通电时闪 4 帧；
//   · 重击那一帧快门关上（整帧取同一瞬间），那个瞬间是清楚的一张，而不是一团糊。
// 参考 mg-styles-15 demos/22-hud（hud.js、post.js；Vincentwei1021，MIT）。泛光后的文字层我们先用 Canvas2D 做：
// glowText 的黑晕 = 一道粗黑描边，辉光 = 同色的 shadowBlur。
//
//   plate       "06/63" 小节牌（+ 小字副行）                   metaLine   "E2 80 A2 · 150 bpm · 4/4 · swiss grid"
//   caption     漫画旁白框                                      callout    引线 + 标签框 + 标记，随 p 画出
//   panel       标题栏 + 一行行“标签 + 分段条 + 数值” + 日志
//   termWindow  弹出终端：每行从自己的起始时间按速率打出，块状光标闪烁
//   odometer    滚动数字（个位在两值之间滚）                    fmtBig  1,724,783,546 / 9.9×10²⁰ / int32 回绕
//   reticle     带刻度和缺口的瞄准环                            barText "▮▮▮▮▯▯▯ 64%"
//   ── FUI ──
//   tier / TIER 亮度分档随时间切换（每次切换在 ±0.12 s 里过渡）
//   flick       通电闪烁：0.7、0.1、1、0.45 四帧后常亮（按 stepT，不糊）
//   decode      逐字乱码解码（标签用字母符号，rollDigits 只滚数字）；每个字解开后就不再变
//   glowText    辉光 + 黑晕的字
//   fuiPanel    FUI 面板框：编号、解码标签、中文副标、画出来的标题线、左竖线、角标
//   hitT        重击帧关快门：在 hits 里任一时刻所在的那一帧，返回这一帧的单一时刻（shutterT(t, 0)）
import { F, font } from '../../engine/type';
import { frameIdx, clamp, ease, lerp, smoothstep, hash, shutterT } from '../../engine/util';

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

// ---------------------------------------------------------------------------------------------------------------------
// FUI（科幻 HUD）：亮度分档、通电闪烁、乱码解码、辉光黑晕字、面板框、重击帧。

/** The reference's cyan ink: lines and type, dimmed labels, the deep tone of empty tracks, white-hot highlights, the black. */
export const FUI = { cyan: '#00E5FF', dim: '#0B7C8C', deep: '#0E3A42', hot: '#E8FEFF', ink: '#020A0D' } as const;

/** Brightness tiers: the element the story is on, the rest of the interface, the background. */
export const TIER = { hi: 1, mid: 0.6, lo: 0.3 } as const;

/**
 * An element's brightness over time from keys [time, level] (in time order; levels usually TIER.hi / mid / lo). The
 * first key's level holds before it; each later key switches over ±`blend` s around its time. Multiply the element's
 * alpha by it, so the eye goes to whatever is at 100 %.
 */
export function tier(t: number, keys: readonly (readonly [time: number, level: number])[], blend = 0.12): number {
  if (keys.length === 0) return 1;
  let v = keys[0]![1];
  for (let i = 1; i < keys.length; i++) v = lerp(v, keys[i]![1], smoothstep(keys[i]![0] - blend, keys[i]![0] + blend, t));
  return v;
}

const FLICK = [0.7, 0.1, 1, 0.45];
/**
 * Power-in flicker of an element switched on at t0: 0 before, then 0.7, 0.1, 1, 0.45 for one drawing each (`rate` a
 * second, 30 = the reference's frames), then 1. Crisp: constant over a frame's shutter.
 */
export function flick(t: number, t0: number, rate = 30): number {
  const c = shutterT(t, 0);
  if (c < t0) return 0;
  const f = Math.floor((c - t0) * rate + 1e-6);
  return f >= FLICK.length ? 1 : FLICK[f]!;
}

/** Glyphs a scrambled label cycles through (no I / O / Q: they read as digits). */
export const SCRAMBLE = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789#%&/<>';

export interface DecodeOpts {
  /** Seconds until every character has resolved (5 frames at 30 fps). */
  dur?: number;
  /** New random glyphs a second (30; pick a rate that divides 60). */
  rate?: number;
  /** Glyphs the unresolved characters show. */
  glyphs?: string;
  /** 0 = characters resolve in random order, 1 = strictly left to right. */
  order?: number;
  /** Characters that never scramble (whitespace never does). */
  keep?: RegExp;
  /** Seed: give each label its own, or labels decoding together scramble alike. */
  id?: number;
}

/**
 * A label decoding from t0: '' before, random glyphs that resolve character by character over `dur` (each stays once
 * it has resolved), then the text. Length never changes (mono type does not jitter). Crisp: one state per frame.
 */
export function decode(t: number, t0: number, text: string, o: DecodeOpts = {}): string {
  const c = shutterT(t, 0);
  if (c < t0) return '';
  const dur = o.dur ?? 1 / 6;
  if (c - t0 >= dur) return text;
  const chars = [...text], n = chars.length, id = o.id ?? 0, gl = [...(o.glyphs ?? SCRAMBLE)], ord = clamp(o.order ?? 0.3);
  const step = Math.floor((c - t0) * (o.rate ?? 30) + 1e-6), p = (c - t0) / dur;
  let out = '';
  for (let i = 0; i < n; i++) {
    const ch = chars[i]!;
    if (/\s/.test(ch) || o.keep?.test(ch)) { out += ch; continue; }
    // when this character resolves (0..0.9 of dur): part random, part its place in the line
    const at = 0.9 * lerp(hash(id, i, 17), n > 1 ? i / (n - 1) : 0, ord);
    out += p >= at ? ch : gl[Math.floor(hash(id, i, step, 9) * gl.length)]!;
  }
  return out;
}

/** Digits of a reading rolling in (decode on the digits only: signs, points, units stay put). */
export const rollDigits = (t: number, t0: number, text: string, id = 0, dur = 0.2) =>
  decode(t, t0, text, { id, dur, glyphs: '0123456789', keep: /[^0-9]/ });

function withAlpha(col: string, a: number): string {
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(col.trim());
  if (h) {
    const s = h[1]!.length === 3 ? h[1]!.split('').map((x) => x + x).join('') : h[1]!, n = parseInt(s, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const m = /^rgba?\(([^)]+)\)$/i.exec(col.trim());
  if (m) { const [r, g, b] = m[1]!.split(',').map((x) => x.trim()); return `rgba(${r},${g},${b},${a})`; }
  return col;
}

export interface GlowOpts {
  color?: string;
  /** Strength of the glow (0..1, 0.6) in `glowColor` (the type's colour), its blur (px, 4 ≈ the reference's 1.5 / 3 px taps). */
  glow?: number;
  glowColor?: string;
  glowR?: number;
  /** How much the background darkens within `haloW` px of the glyphs (0.6 over 3 px); 0 = no halo. */
  halo?: number;
  haloW?: number;
  /** Opacity (the brightness tier); multiplies the context's own. */
  alpha?: number;
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
  /** Letter spacing (px). */
  tracking?: number;
}

/**
 * HUD type that reads over glowing lines and grids: a dark halo knocked into the background round the glyphs, then the
 * crisp glyphs with a soft glow of their own colour. Draw it after the lines (and after any glow pass over them).
 * Returns the advance width.
 */
export function glowText(c: Ctx, fnt: string, text: string, x: number, y: number, o: GlowOpts = {}): number {
  if (!text) return 0;
  const ga = c.globalAlpha * (o.alpha ?? 1), col = o.color ?? FUI.cyan;
  c.save();
  c.font = fnt; c.textAlign = o.align ?? 'left'; c.textBaseline = o.baseline ?? 'alphabetic';
  c.letterSpacing = `${o.tracking ?? 0}px`;
  const w = c.measureText(text).width - (o.tracking ?? 0);
  if (ga > 0.002) {
    const halo = o.halo ?? 0.6, hw = o.haloW ?? 3;
    if (halo > 0) {
      c.globalAlpha = ga * halo; c.lineJoin = 'round'; c.strokeStyle = '#000'; c.fillStyle = '#000'; c.lineWidth = 2 * hw;
      c.strokeText(text, x, y); c.fillText(text, x, y);
    }
    c.globalAlpha = ga; c.fillStyle = col;
    const g = o.glow ?? 0.6;
    if (g > 0) { c.shadowColor = withAlpha(o.glowColor ?? col, clamp(g)); c.shadowBlur = o.glowR ?? 4; }
    c.fillText(text, x, y);
  }
  c.restore();
  return w;
}

export interface FuiPanelOpts {
  /** "01", the label (decodes as the panel powers on), its Chinese subtitle (right-aligned, dim). */
  idx?: string;
  label: string;
  cn?: string;
  /** Seed for the label's scramble (default: from the position). */
  id?: number;
  /** Ink, dim ink, and the brightness tier. */
  color?: string;
  dim?: string;
  alpha?: number;
  /** Label size (px). */
  size?: number;
  /** Only the lines ('geo': before a glow pass over them), only the type ('txt'), or both. */
  pass?: 'geo' | 'txt' | 'both';
}

/**
 * FUI panel chrome switched on at t0: header (index, decoding label, Chinese subtitle), a header rule that draws across
 * with an accent bar, a left rule growing down, closing corner ticks and three status squares. The panel's content is
 * yours (below y + 16). Returns the power-in flicker (0 = not on yet: skip the content).
 */
export function fuiPanel(c: Ctx, t: number, t0: number, x: number, y: number, w: number, h: number, o: FuiPanelOpts): number {
  const p = ease.outCubic(clamp((t - t0) / 0.5));
  if (p <= 0) return 0;
  const a = flick(t, t0), ga = o.alpha ?? 1, col = o.color ?? FUI.cyan, dim = o.dim ?? FUI.dim, s = o.size ?? 14, pass = o.pass ?? 'both';
  if (pass !== 'geo') {
    c.save(); c.globalAlpha *= ga;
    if (o.idx) glowText(c, font(F.mono(500), s - 1), o.idx, x, y, { color: dim, alpha: a, glow: 0.3 });
    glowText(c, font(F.mono(600), s), decode(t, t0, o.label, { id: o.id ?? x * 7 + y }), x + s * 1.7, y, { color: col, alpha: a, tracking: s * 0.18 });
    if (o.cn) glowText(c, font(F.sans(400), s), o.cn, x + w, y, { color: dim, alpha: a * ease.outCubic(clamp((t - t0 - 0.12) / 0.3)), align: 'right', tracking: s * 0.1, glow: 0.3 });
    c.restore();
  }
  if (pass !== 'txt') {
    const line = (x0: number, y0: number, x1: number, y1: number, k = 1) => { if (k <= 0) return; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x0 + (x1 - x0) * Math.min(1, k), y0 + (y1 - y0) * Math.min(1, k)); c.stroke(); };
    c.save();
    const A = c.globalAlpha * ga;
    c.lineWidth = 1;
    c.globalAlpha = A * 0.85; c.strokeStyle = col; line(x, y + 9.5, x + w, y + 9.5, p);
    c.globalAlpha = A; c.fillStyle = col; c.fillRect(x, y + 8, 18 * p, 3);
    c.globalAlpha = A * 0.8; c.strokeStyle = dim; line(x + 0.5, y + 16, x + 0.5, y + h, ease.outCubic(clamp((t - t0 - 0.1) / 0.5)));
    const q = ease.outCubic(clamp((t - t0 - 0.3) / 0.3));
    if (q > 0) {
      c.globalAlpha = A * 0.9 * q;
      line(x + 0.5, y + h + 0.5, x + 12, y + h + 0.5); line(x + w - 12, y + h + 0.5, x + w, y + h + 0.5); line(x + w - 0.5, y + h - 12, x + w - 0.5, y + h + 0.5);
      c.fillStyle = dim; for (let i = 0; i < 3; i++) c.fillRect(x + w - 6 - i * 7, y + 14, 4, 4);
    }
    c.restore();
  }
  return a;
}

/**
 * Closed shutter on impact frames: on the frame (60 fps grid, frameIdx) of any time in `hits`, every sub-frame gets that
 * frame's own instant (shutterT(t, 0)), so the hit is one crisp state; elsewhere t is passed through (normal blur).
 * Feed it to whatever should land sharp on the beat: the banner slamming in, the brackets snapping shut.
 */
export function hitT(t: number, hits: readonly number[]): number {
  const f = shutterT(t, 0), k = frameIdx(f);
  for (const h of hits) if (frameIdx(h) === k) return f;
  return t;
}

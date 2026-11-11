// 文字动画器（AE 的 Text Animator + Range Selector），在 Canvas 2D 上逐字画。歌词动态排版、片名、字幕的进出场都可以用它。
//
// 和 AE 一样的概念：
//   一段字先排好版（TextBlock：中英文混排、多行 \n、字号、字距、行距、对齐；排版只算一次，之后每帧只算动画）。
//   一个动画器（TextAnimator）= 选择器（select）+ 一组属性。属性写的是「完全选中时」的样子，选中量 0 = 原样，1 = 属性值，
//   中间按比例（位置、旋转、模糊、字距加上去；缩放、透明度从 1 走向属性值；颜色在线性光里混）。几个动画器按顺序叠加。
//   选择器给每个单位（字 / 词 / 行）一个选中量：
//     range(o)     范围选择器（Range Selector）
//     wiggly(o)    抖动选择器（Wiggly Selector）：每个单位按噪声取值
//     cascade(o)   逐个错峰：第 k 个单位晚 k · each 秒，dur 秒内选中量从 1 走到 0（缓动可以过冲，E.back 让字弹一下）
//     函数         (g, L, t) => 选中量，自己算（AE 的 Expression Selector）
//   一个动画器可以给几个选择器（数组），按各自的 mode 合起来：'add' 加、'sub' 减、'intersect' 乘、'min'、'max'、'diff' 差的绝对值；
//   第一个不看 mode。不给 select 就是全选。
// 全部是 t 的纯函数：起点、终点、偏移拿 kf(t, …) 打关键帧再传进来；抖动和乱码只读传进来的 t。
// 字、平面元素传 shutterT(f.t, 0)（不被运动模糊糊掉，乱码每帧只换一次）；想让飞过去的字带拖影就传 f.t。
//
// 用法：
//   const title = new TextBlock('文字动画器\nText Animator', { family: F.sans(700), size: 140, align: 'center', valign: 'middle' });
//   // render()：
//   const tc = shutterT(f.t, 0);
//   title.draw(c, W / 2, H / 2, tc, [
//     { select: cascade({ t0: 0.2, each: 0.06, dur: 0.6, ease: E.back }), position: [0, 80], scale: 0.4, opacity: 0, blur: 12 },
//     { select: range({ end: 0.3, offset: kf(tc, [[1.5, -0.3], [2.2, 1]]), shape: 'rampDown' }), position: [0, -60], opacity: 0 },
//   ], { fill: '#f2ede3' });
//
// ── 排版 new TextBlock(text, style) ── 字体要先载入（场景 init() 之后用；建在字段里也行，第一次画时才排）
//   style.family      引擎字体名（F.sans(700)、F.mono(500)、F.serif() …），中文自动落到思源
//   style.size        字号 px
//   style.tracking    字距 px（每两个字之间额外加），默认 0
//   style.lineHeight  行距（字号的倍数），默认 1.2
//   style.align       'left' | 'center' | 'right'：(x, y) 是每行的左端 / 中点 / 右端，默认 'left'
//   style.valign      (x, y) 在竖直方向对哪儿：'first' 第一行基线（默认）| 'top' 字顶 | 'middle' 整块中间 | 'bottom' 字底 | 'last' 末行基线
//   style.pivot       每个字旋转、缩放的中心在基线上方多高（字号的倍数），默认 0.36（中文和大写字母的视觉中心）
//   style.vertical    竖排：每行变成一列，从上往下排、列从右往左（第一列最右，列距 = lineHeight × size，字距照样加）。
//                     这时 align 管每列在竖直方向的对齐（'left' 顶、'center' 中、'right' 底），valign 管整块在水平方向：
//                     'first'（默认）第一列的中线在 x、'middle' 整块居中、'last' 最后一列的中线在 x。字一律立着排，标点不挪位
//   单位：'char' 字（中文一个字一个；空格不算）、'word' 词（英文按空格；中文按浏览器的分词词典，标点跟着前一个词）、'line' 行
//   .layout → { glyphs（每个字：ch、x 左边、y 基线、w 宽、line 行号、char / word / lineUnit 三种单位里的序号，空格是 -1）,
//              lines, count: { char, word, line }, top, bottom, left, right, width, height }（相对 (x, y)）
//   .count(unit)      单位数        .states(t, animators, paint)  每个字算好的状态（自己画、贴粒子、接形状层用）
//   .draw(c, x, y, t, animators = [], paint = {})
//   paint：{ fill = '#ffffff'（null 不填）, stroke, strokeWidth, strokeOver = false（描边默认在填充下面）, opacity = 1,
//           group = 'char', path, pathOffset = 0 }  group 是缩放 / 旋转 / 倾斜的中心按什么算（AE 的 Anchor Point Grouping）：
//           'char' 每个字自己、'word' 整个词、'line' 整行、'all' 整块（按 pivot 高度）
//           fill 也可以是 CanvasPattern / CanvasGradient（字里的网纹、渐变；这时动画器的 fill 不起作用，图案跟着每个字走）
//           path：沿路径排字（shape.ts 的 Path 或 Flat；路径坐标相对 draw 的 (x, y)，传 0, 0 就是画布坐标）。排好的横向位置变成沿路径的距离：块的 x = 0
//           落在路径上 pathOffset px 处（给它打帧，字就沿路径跑），每个字按自己中心那点的切线转；多行时后面的行往路径的法线方向挪。
//           闭合路径绕回。states() 返回的还是排版坐标，只有 draw() 沿路径画
//
// ── 动画器 TextAnimator ──（属性都可选，值是完全选中时的样子）
//   select       选择器或数组（见上）
//   position     [dx, dy] px            scale      倍数（数或 [sx, sy]，1 = 不变）     rotation   弧度
//   skew         倾斜弧度（正 = 上端往右，像斜体）      skewAxis   倾斜方向（弧度，0 = 水平）
//   opacity      0–1                    blur       高斯模糊半径 px（逐字 filter，见性能）
//   tracking     px：每个选中的字后面多出的距离，后面的字跟着挪；居中 / 右对齐的行会重新对齐（AE 的 Tracking Amount）
//   fill / stroke  目标颜色（'#rrggbb'、'#rgb'、'rgb()'、'rgba()'），在线性光里从 paint 的颜色混过去   strokeWidth  加的描边宽
//   charOffset   换字：按选中量偏移字符（A→B→C，数字在 0–9 里转，大小写不变；中文在 SCRAMBLE_ZH 常用字表里转）
//   scramble     乱码：true（按字的种类换：大写、小写、数字、中文各用各的字表）或一个字符串（只用这些字）。
//                选中量就是这个字这一帧是乱码的概率：1 全乱，0 原字，ramp 的过渡区一闪一闪地解开
//   scrambleRate 每秒换几次（默认 20；取能整除 60 的数：30、20、15、12、10、6，换字才落在帧之间）     seed  乱码种子
//
// ── 选择器参数 ──
//   range({ start = 0, end = 1, offset = 0, units = 'percent', shape = 'square', easeHigh = 0, easeLow = 0, smooth = 1,
//           random = false, seed = 0, by = 'char', amount = 1, mode = 'add' })
//     start / end / offset   0–1（units 'index' 时按单位个数），start > end 自动对调；偏移把整段一起挪，不绕回
//     shape                  'square' 方形 | 'rampUp' 上坡（起点前 0、终点后 1）| 'rampDown' 下坡 | 'triangle' 三角 | 'round' 圆 | 'smooth' 平滑
//                            每个单位取它占的那一小段上的平均值，所以范围动起来时选中量是连续的，不会一格一格跳
//     easeHigh / easeLow     -1–1（AE 的 Ease High / Ease Low ÷ 100）：正数 = 在 1 / 0 附近变化放慢（更柔），负数 = 更急
//     smooth                 只对 square：0 = 一个字要么全选要么不选（打字机），1 = 边上的字按覆盖比例（默认）
//     random / seed          按种子打乱单位顺序（AE 的 Randomize Order）
//     by                     'char' | 'word' | 'line'        amount  选中量再乘的系数（-1–1，AE 的 Amount）
//   wiggly({ min = 0, max = 1, speed = 2, correlation = 0, phase = 0, seed = 0, by = 'char', mode = 'intersect' })
//     每个单位一条噪声，值在 min–max 之间，speed 每秒起伏几次；correlation 0 各抖各的，1 全都一起抖；phase 时间相位。
//     默认 mode 'intersect'：放在 range 后面就是「范围里的字才抖」（AE 默认 min / max 是 -100% / 100%，这里默认 0–1）
//   cascade({ t0, each = 0.05, dur = 0.5, ease = E.out, from = 'start', seed = 0, out = false, by = 'char', mode = 'add' })
//     第 k 个单位在 t0 + k · each 出发，dur 秒内选中量 1 → 0（进场：属性写成还没进来时的样子）；out: true 反过来 0 → 1（出场）。
//     from：'start' 从头 | 'end' 从尾 | 'center' 从中间往两边 | 'edges' 从两边往中间 | 'random' 按种子乱序
//
// 性能：排版只在第一次画时算（同一段字、同一套样式全局缓存）。每帧每个字一次 save / restore + fillText；
//   模糊用逐字的 Canvas filter（每个模糊的字单独开一层离屏；实测 210 px 的字 blur ≤ 28：1080p 每个约 0.2 ms，
//   4K（--scale 2）每个约 1.4 ms。几十个字同时大模糊时注意帧时间；模糊 < 0.05 px 时不开）。整段示例 1080p 每帧约 10 ms。
// 限制：只按 \n 换行，不自动折行；逐字画没有连字（ligature），字偶距保留；竖排时字都立着、标点不挪位。
import { font } from './type';
import { clamp, lerp, hash, mulberry32 } from './util';
import { E } from './anim';
import { Path, pathLength, pointAlong, type Flat } from './shape';

export type TextUnit = 'char' | 'word' | 'line';
export type TextAlign = 'left' | 'center' | 'right';
export type TextVAlign = 'first' | 'top' | 'middle' | 'bottom' | 'last';

export interface TextStyle {
  family: string;
  size: number;
  tracking?: number;
  lineHeight?: number;
  align?: TextAlign;
  valign?: TextVAlign;
  pivot?: number;
  vertical?: boolean;
}

/** One laid-out glyph (grapheme). x: left edge, y: baseline, relative to the block's (x, y). */
export interface TGlyph {
  ch: string;
  /** Index among all glyphs (spaces included, line breaks not). */
  i: number;
  x: number;
  y: number;
  w: number;
  line: number;
  /** Index in each kind of unit (-1 for whitespace; lineUnit skips blank lines). */
  char: number;
  word: number;
  lineUnit: number;
  space: boolean;
}

export interface TLine { y: number; x: number; width: number; from: number; to: number }

export interface TLayout {
  text: string;
  style: Required<TextStyle>;
  glyphs: TGlyph[];
  lines: TLine[];
  count: Record<TextUnit, number>;
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------- layout

let mctx: CanvasRenderingContext2D | null = null;
const measureCtx = () => (mctx ??= document.createElement('canvas').getContext('2d')!);
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
let WORDS: Intl.Segmenter | null = null;
const isSpace = (s: string) => /^\s+$/u.test(s);
const layoutCache = new Map<string, TLayout>();

/** Lay out text once (cached globally by text + style). Fonts must be loaded; until they are, nothing is cached. */
export function layoutText(text: string, style: TextStyle): TLayout { return layoutImpl(text, style)[0]; }

function layoutImpl(text: string, style: TextStyle): [TLayout, boolean] {
  const st: Required<TextStyle> = { tracking: 0, lineHeight: 1.2, align: 'left', valign: 'first', pivot: 0.36, vertical: false, ...style };
  const key = JSON.stringify([text, st.family, st.size, st.tracking, st.lineHeight, st.align, st.valign, st.pivot, st.vertical]);
  const hit = layoutCache.get(key);
  if (hit) return [hit, true];
  const c = measureCtx(), css = font(st.family, st.size);
  c.font = css;
  const ready = typeof document === 'undefined' || !document.fonts || document.fonts.check(css, text.replace(/\s+/g, '') || 'M');
  const capTop = c.measureText('H中').actualBoundingBoxAscent || st.size * 0.8;
  const desc = c.measureText('gjpy中').actualBoundingBoxDescent || st.size * 0.2;
  const lh = st.lineHeight * st.size, tr = st.tracking;
  WORDS ??= new Intl.Segmenter('zh', { granularity: 'word' });
  const glyphs: TGlyph[] = [], lines: TLine[] = [];
  let charN = 0, wordN = 0, lineN = 0;
  text.split('\n').forEach((line, li) => {
    // words by UTF-16 offset: word-like segments are words; punctuation joins the word before it (or the next, at the start)
    const wordOf = new Int32Array(line.length).fill(-1);
    let last = -1, pend: { index: number; segment: string }[] = [];
    const mark = (sg: { index: number; segment: string }, id: number) => { for (let k = sg.index; k < sg.index + sg.segment.length; k++) wordOf[k] = id; };
    for (const sg of WORDS!.segment(line)) {
      if (isSpace(sg.segment)) { last = -1; continue; }
      if (sg.isWordLike) { const id = wordN++; for (const p of pend) mark(p, id); pend = []; mark(sg, id); last = id; }
      else if (last >= 0) mark(sg, last);
      else pend.push(sg);
    }
    if (pend.length) { const id = wordN++; for (const p of pend) mark(p, id); }
    const gs = [...GRAPHEMES.segment(line)];
    const from = glyphs.length, ink = gs.some((g) => !isSpace(g.segment)), lu = ink ? lineN++ : -1;
    let prefix = '';
    gs.forEach((g, k) => {
      prefix += g.segment;
      const w = c.measureText(g.segment).width;
      const sp = isSpace(g.segment);
      // glyph k ends where text[0..k] ends: the kern between it and the one before moves it (type.ts layout())
      glyphs.push({ ch: g.segment, i: glyphs.length, x: c.measureText(prefix).width - w + k * tr, y: li * lh, w, line: li, char: sp ? -1 : charN++, word: sp ? -1 : wordOf[g.index]!, lineUnit: sp ? -1 : lu, space: sp });
    });
    const width = gs.length ? c.measureText(line).width + (gs.length - 1) * tr : 0;
    const x0 = st.align === 'center' ? -width / 2 : st.align === 'right' ? -width : 0;
    for (let k = from; k < glyphs.length; k++) glyphs[k]!.x += x0;
    lines.push({ y: li * lh, x: x0, width, from, to: glyphs.length });
  });
  if (st.vertical) return finishVertical(text, st, glyphs, lines, { char: charN, word: wordN, line: lineN }, capTop, key, ready);
  const lastBase = (lines.length - 1) * lh;
  let top = -capTop, bottom = lastBase + desc, dy = 0;
  if (st.valign === 'top') dy = capTop;
  else if (st.valign === 'middle') dy = -(top + bottom) / 2;
  else if (st.valign === 'bottom') dy = -bottom;
  else if (st.valign === 'last') dy = -lastBase;
  for (const g of glyphs) g.y += dy;
  for (const l of lines) l.y += dy;
  top += dy; bottom += dy;
  let left = Infinity, right = -Infinity;
  for (const l of lines) if (l.width > 0) { left = Math.min(left, l.x); right = Math.max(right, l.x + l.width); }
  if (left > right) left = right = 0;
  const L: TLayout = { text, style: st, glyphs, lines, count: { char: charN, word: wordN, line: lineN }, top, bottom, left, right, width: right - left, height: bottom - top };
  if (ready) {
    if (layoutCache.size > 512) layoutCache.delete(layoutCache.keys().next().value!);
    layoutCache.set(key, L);
  }
  return [L, ready];
}

/**
 * Vertical setting: every line a column, glyphs top to bottom (each centred on the column, the same advance for all:
 * size + tracking; a space half that), columns right to left lineHeight x size apart. align runs along the column
 * (left = top, center, right = bottom), valign across (first column / middle / last column on x).
 */
function finishVertical(text: string, st: Required<TextStyle>, glyphs: TGlyph[], hlines: TLine[], count: Record<TextUnit, number>, capTop: number, key: string, ready: boolean): [TLayout, boolean] {
  const lh = st.lineHeight * st.size, adv = st.size + st.tracking;
  const lines: TLine[] = [];
  let top = Infinity, bottom = -Infinity;
  hlines.forEach((hl, li) => {
    const cx = -li * lh;
    let y = 0;
    const ys: number[] = [];
    for (let i = hl.from; i < hl.to; i++) { ys.push(y); y += glyphs[i]!.space ? adv / 2 : adv; }
    const len = Math.max(0, y - st.tracking);
    const y0 = st.align === 'center' ? -len / 2 : st.align === 'right' ? -len : 0;
    for (let i = hl.from; i < hl.to; i++) {
      const g = glyphs[i]!;
      g.x = cx - g.w / 2;
      // baseline so the cap height sits centred in the glyph's size x size cell
      g.y = y0 + ys[i - hl.from]! + (st.size + capTop) / 2;
    }
    lines.push({ x: cx, y: y0, width: len, from: hl.from, to: hl.to });
    if (len > 0) { top = Math.min(top, y0); bottom = Math.max(bottom, y0 + len); }
  });
  if (top > bottom) top = bottom = 0;
  const n = lines.length;
  let dx = 0;
  if (st.valign === 'middle') dx = ((n - 1) * lh) / 2;
  else if (st.valign === 'last' || st.valign === 'bottom') dx = (n - 1) * lh;
  for (const g of glyphs) g.x += dx;
  for (const l of lines) l.x += dx;
  const left = -(n - 1) * lh + dx - st.size / 2, right = dx + st.size / 2;
  const L: TLayout = { text, style: st, glyphs, lines, count, top, bottom, left, right, width: right - left, height: bottom - top };
  if (ready) {
    if (layoutCache.size > 512) layoutCache.delete(layoutCache.keys().next().value!);
    layoutCache.set(key, L);
  }
  return [L, ready];
}

// ---------------------------------------------------------------- selectors

export type RangeShape = 'square' | 'rampUp' | 'rampDown' | 'triangle' | 'round' | 'smooth';
export type SelMode = 'add' | 'sub' | 'intersect' | 'min' | 'max' | 'diff';

interface SelBase {
  /** Unit the selector counts in (default 'char'). */
  by?: TextUnit;
  /** How it combines with the selectors before it in the same animator (the first one's mode is ignored). */
  mode?: SelMode;
  /** Multiplies the value (AE Amount, -1..1). */
  amount?: number;
}
export interface RangeOpts extends SelBase {
  start?: number;
  end?: number;
  offset?: number;
  units?: 'percent' | 'index';
  shape?: RangeShape;
  easeHigh?: number;
  easeLow?: number;
  smooth?: number;
  random?: boolean;
  seed?: number;
}
export interface WigglyOpts extends SelBase {
  min?: number;
  max?: number;
  speed?: number;
  correlation?: number;
  phase?: number;
  seed?: number;
}
export interface CascadeOpts extends SelBase {
  t0: number;
  each?: number;
  dur?: number;
  ease?: (u: number) => number;
  from?: 'start' | 'end' | 'center' | 'edges' | 'random';
  seed?: number;
  out?: boolean;
}
export type SelectorFn = (g: TGlyph, L: TLayout, t: number) => number;
export type Selector = (RangeOpts & { kind: 'range' }) | (WigglyOpts & { kind: 'wiggly' }) | (CascadeOpts & { kind: 'cascade' }) | SelectorFn;

/** Range Selector (see the top of the file). */
export const range = (o: RangeOpts = {}): Selector => ({ kind: 'range', ...o });
/** Wiggly Selector: per-unit noise in [min, max] (default 0..1), mode 'intersect' by default. */
export const wiggly = (o: WigglyOpts = {}): Selector => ({ kind: 'wiggly', mode: 'intersect', ...o });
/** Staggered per-unit progress: 1 → 0 over dur, unit k starting k · each after t0 (out: 0 → 1). */
export const cascade = (o: CascadeOpts): Selector => ({ kind: 'cascade', ...o });

const permCache = new Map<string, Int32Array>();
/** Seeded shuffle of 0..n-1: rank of each unit. */
function perm(n: number, seed: number): Int32Array {
  const k = `${n}:${seed}`;
  let p = permCache.get(k);
  if (!p) {
    p = new Int32Array(n);
    for (let i = 0; i < n; i++) p[i] = i;
    const rnd = mulberry32((seed * 2654435761) ^ 0x9e3779b9);
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const tmp = p[i]!; p[i] = p[j]!; p[j] = tmp; }
    if (permCache.size > 256) permCache.delete(permCache.keys().next().value!);
    permCache.set(k, p);
  }
  return p;
}

/** ∫ from s to p of the range shape (s..e the range, absolute 0..1 units): averages over a unit are exact and continuous. */
function shapeInt(shape: RangeShape, s: number, e: number, p: number): number {
  const d = Math.max(1e-9, e - s), u = (p - s) / d;
  switch (shape) {
    case 'square': return clamp(p - s, 0, e - s);
    case 'rampUp': return u <= 0 ? 0 : u >= 1 ? d / 2 + (p - e) : (d * u * u) / 2;
    case 'rampDown': return u <= 0 ? p - s : u >= 1 ? d / 2 : d * (u - (u * u) / 2);
    case 'triangle': return u <= 0 ? 0 : u <= 0.5 ? d * u * u : u <= 1 ? d * (2 * u - u * u - 0.5) : d / 2;
    case 'round': {
      if (u <= 0) return 0;
      if (u >= 1) return (d * Math.PI) / 4;
      const x = 2 * u - 1;
      return (d * (x * Math.sqrt(1 - x * x) + Math.asin(x) + Math.PI / 2)) / 4;
    }
    case 'smooth': return u <= 0 ? 0 : u >= 1 ? d / 2 : d * (u / 2 - Math.sin(2 * Math.PI * u) / (4 * Math.PI));
  }
}

/** AE Ease High / Ease Low on a 0..1 value: a cubic with slope 1 − easeLow at 0 and 1 − easeHigh at 1. */
function easeHL(v: number, hi: number, lo: number): number {
  if (!hi && !lo) return v;
  const x = clamp(v), m0 = 1 - clamp(lo, -1, 1), m1 = 1 - clamp(hi, -1, 1), x2 = x * x, x3 = x2 * x;
  return (x3 - 2 * x2 + x) * m0 + (-2 * x3 + 3 * x2) + (x3 - x2) * m1;
}

function rangeUnits(r: RangeOpts, n: number): Float32Array {
  const out = new Float32Array(n);
  if (n === 0) return out;
  let s = r.start ?? 0, e = r.end ?? 1, o = r.offset ?? 0;
  if (r.units === 'index') { s /= n; e /= n; o /= n; }
  if (s > e) [s, e] = [e, s];
  s += o; e += o;
  const shape = r.shape ?? 'square', P = r.random ? perm(n, r.seed ?? 0) : null, sm = clamp(r.smooth ?? 1);
  for (let i = 0; i < n; i++) {
    const k = P ? P[i]! : i, a = k / n, b = (k + 1) / n;
    let v = (shapeInt(shape, s, e, b) - shapeInt(shape, s, e, a)) * n;
    if (shape === 'square' && sm < 1) { const m = (a + b) / 2; v = lerp(m >= s && m < e ? 1 : 0, v, sm); }
    out[i] = easeHL(clamp(v), r.easeHigh ?? 0, r.easeLow ?? 0);
  }
  return out;
}

/**
 * Smooth 1D noise, about −1..1: two octaves of gradient noise (no stop-and-go at the lattice points like value noise,
 * and the second octave keeps it from passing through 0 on a regular beat).
 */
function wnoise(x: number, seed: number): number {
  const g = (xx: number, s: number) => {
    const X = Math.floor(xx), f = xx - X, u = f * f * f * (f * (f * 6 - 15) + 10);
    const a = (hash(X, s, 3) * 2 - 1) * f, b = (hash(X + 1, s, 3) * 2 - 1) * (f - 1);
    return (a + (b - a) * u) * 2;
  };
  return 0.75 * g(x, seed) + 0.4 * g(x * 2.03 + 17.3, seed + 101);
}

function wigglyUnits(w: WigglyOpts, n: number, t: number): Float32Array {
  const out = new Float32Array(n), z = t * (w.speed ?? 2) + (w.phase ?? 0), seed = w.seed ?? 0, corr = clamp(w.correlation ?? 0);
  const shared = wnoise(z, seed * 977 - 13);
  const lo = w.min ?? 0, hi = w.max ?? 1;
  for (let i = 0; i < n; i++) {
    // soft-clipped so the values spread over the whole range (sd ≈ 0.5 of the half-range) without sitting on the ends
    const v = Math.tanh(lerp(wnoise(z + i * 0.618, seed * 977 + i * 7 + 1), shared, corr) * 2.2);
    out[i] = lerp(lo, hi, (v + 1) / 2);
  }
  return out;
}

function cascadeUnits(o: CascadeOpts, n: number, t: number): Float32Array {
  const out = new Float32Array(n), each = o.each ?? 0.05, dur = Math.max(1e-6, o.dur ?? 0.5), ease = o.ease ?? E.out, mid = (n - 1) / 2;
  const P = o.from === 'random' ? perm(n, o.seed ?? 0) : null;
  for (let i = 0; i < n; i++) {
    const k = o.from === 'end' ? n - 1 - i : o.from === 'center' ? Math.abs(i - mid) : o.from === 'edges' ? mid - Math.abs(i - mid) : P ? P[i]! : i;
    const e = ease(clamp((t - o.t0 - k * each) / dur));
    out[i] = o.out ? e : 1 - e;
  }
  return out;
}

const unitOf = (g: TGlyph, by: TextUnit) => (by === 'char' ? g.char : by === 'word' ? g.word : g.lineUnit);

function combine(mode: SelMode, a: number, b: number): number {
  switch (mode) {
    case 'add': return a + b;
    case 'sub': return a - b;
    case 'intersect': return a * b;
    case 'min': return Math.min(a, b);
    case 'max': return Math.max(a, b);
    case 'diff': return Math.abs(a - b);
  }
}

/**
 * Selection amount of every glyph (index = TGlyph.i) for one animator's selectors at t. Whitespace takes the amount of
 * the glyph before it on its line (or after it, at the start), so tracking opens up spaces too.
 */
export function selectAmounts(sel: Selector | readonly Selector[] | undefined, L: TLayout, t: number): Float32Array {
  const G = L.glyphs, N = G.length, acc = new Float32Array(N);
  if (!sel || (Array.isArray(sel) && sel.length === 0)) return acc.fill(1);
  const list = (Array.isArray(sel) ? sel : [sel]) as readonly Selector[];
  const cur = new Float32Array(N);
  list.forEach((s, k) => {
    if (typeof s === 'function') { for (const g of G) cur[g.i] = g.space ? NaN : s(g, L, t); }
    else {
      const by = s.by ?? 'char', n = L.count[by], amt = s.amount ?? 1;
      const u = s.kind === 'range' ? rangeUnits(s, n) : s.kind === 'wiggly' ? wigglyUnits(s, n, t) : cascadeUnits(s, n, t);
      for (const g of G) { const ix = unitOf(g, by); cur[g.i] = ix < 0 ? NaN : u[ix]! * amt; }
    }
    const mode: SelMode = typeof s === 'function' ? 'add' : s.mode ?? 'add';
    for (let i = 0; i < N; i++) acc[i] = k === 0 ? cur[i]! : combine(mode, acc[i]!, cur[i]!);
  });
  for (const l of L.lines) {
    let prev = NaN;
    for (let i = l.from; i < l.to; i++) { if (Number.isNaN(acc[i]!)) acc[i] = prev; else prev = acc[i]!; }
    let next = NaN;
    for (let i = l.to - 1; i >= l.from; i--) { if (Number.isNaN(acc[i]!)) acc[i] = next; else next = acc[i]!; }
    for (let i = l.from; i < l.to; i++) if (Number.isNaN(acc[i]!)) acc[i] = 0;
  }
  return acc;
}

// ---------------------------------------------------------------- animators and states

export interface TextAnimator {
  select?: Selector | readonly Selector[];
  position?: readonly [number, number];
  scale?: number | readonly [number, number];
  rotation?: number;
  skew?: number;
  skewAxis?: number;
  opacity?: number;
  blur?: number;
  tracking?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  charOffset?: number;
  scramble?: boolean | string;
  scrambleRate?: number;
  seed?: number;
}

export interface TextPaint {
  fill?: string | CanvasPattern | CanvasGradient | null;
  stroke?: string;
  strokeWidth?: number;
  strokeOver?: boolean;
  opacity?: number;
  group?: 'char' | 'word' | 'line' | 'all';
  /** Set the text along this path (see the top of the file). */
  path?: Path | Flat;
  /** Where the block's x = 0 sits along the path, px. */
  pathOffset?: number;
}

/** A glyph ready to draw: (x, y) its centre on the baseline after tracking, (px, py) the pivot, then the animated values. */
export interface GlyphState {
  g: TGlyph;
  ch: string;
  x: number;
  y: number;
  px: number;
  py: number;
  dx: number;
  dy: number;
  sx: number;
  sy: number;
  rot: number;
  skew: number;
  skewAxis: number;
  alpha: number;
  blur: number;
  fill: string | CanvasPattern | CanvasGradient | null;
  stroke: string | null;
  strokeWidth: number;
}

// colours: parsed once, mixed in linear light
type RGBA = [number, number, number, number];
const colCache = new Map<string, RGBA | null>();
const toLin = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
const toSrgb = (v: number) => Math.round(255 * clamp(v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
function parseColor(s: string): RGBA | null {
  let c = colCache.get(s);
  if (c !== undefined) return c;
  c = null;
  const str = s.trim();
  let m: RegExpExecArray | null;
  if ((m = /^#([0-9a-f]{3,8})$/i.exec(str))) {
    let h = m[1]!;
    if (h.length === 3 || h.length === 4) h = h.split('').map((x) => x + x).join('');
    if (h.length === 6 || h.length === 8) {
      const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
      c = [toLin(n(0)), toLin(n(2)), toLin(n(4)), h.length === 8 ? n(6) / 255 : 1];
    }
  } else if ((m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(str))) {
    const a = m[4] ? (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])) : 1;
    c = [toLin(+m[1]!), toLin(+m[2]!), toLin(+m[3]!), a];
  }
  colCache.set(s, c);
  return c;
}
const colStr = (c: RGBA) => `rgba(${toSrgb(c[0])},${toSrgb(c[1])},${toSrgb(c[2])},${+c[3].toFixed(4)})`;
function mixInto(base: RGBA | null, target: string, a: number): RGBA | null {
  const B = parseColor(target);
  if (!B || !base) return base;
  const k = clamp(a);
  return [lerp(base[0], B[0], k), lerp(base[1], B[1], k), lerp(base[2], B[2], k), lerp(base[3], B[3], k)];
}

/** Common Chinese characters a Chinese glyph scrambles / rolls through (all in GB2312; make_fonts_zh.py picks them up). */
export const SCRAMBLE_ZH = '的一是不了人我在有他这中大来上个国到说们为子和你地出道也时年得就那要下以生会自着去之过家学对可她里后小么心多天而能好都然没日于起还发成事只作当想看文无开手十用主行方又如前所本见经头面公同三已老从动两长知民样现分将外但身些与高意进把法此实回二理美点月明其种声全工己话儿者向情部正名定女问力机给等几很业最间新什打便位因重被走电四第门相次东';
const SC_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ', SC_LOWER = 'abcdefghijkmnopqrstuvwxyz', SC_DIGIT = '0123456789', SC_SYM = '#$%&*+=<>/?!@';
const AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', az = 'abcdefghijklmnopqrstuvwxyz';
const HAN = /\p{Script=Han}/u;
const ZH_INDEX = new Map(Array.from(SCRAMBLE_ZH).map((ch, i) => [ch, i]));
const ZH_CHARS = Array.from(SCRAMBLE_ZH);

/** Character set a glyph scrambles through, by its kind (null: it stays). */
function scrambleSet(ch: string): string | null {
  if (/^[A-Z]$/.test(ch)) return SC_UPPER;
  if (/^[a-z]$/.test(ch)) return SC_LOWER;
  if (/^[0-9]$/.test(ch)) return SC_DIGIT;
  if (HAN.test(ch)) return SCRAMBLE_ZH;
  if (/^[!-~]$/.test(ch)) return SC_SYM;
  return null;
}

/** Character ch shifted by k within its kind (A–Z, a–z, 0–9, the common-Chinese table); others unchanged. */
export function shiftChar(ch: string, k: number): string {
  if (!k) return ch;
  const roll = (set: string, i: number) => set[(((i + k) % set.length) + set.length) % set.length]!;
  if (/^[A-Z]$/.test(ch)) return roll(AZ, AZ.indexOf(ch));
  if (/^[a-z]$/.test(ch)) return roll(az, az.indexOf(ch));
  if (/^[0-9]$/.test(ch)) return roll(SC_DIGIT, +ch);
  if (HAN.test(ch)) {
    const i = ZH_INDEX.get(ch) ?? Math.floor(hash(ch.codePointAt(0)!) * ZH_CHARS.length);
    return ZH_CHARS[(((i + k) % ZH_CHARS.length) + ZH_CHARS.length) % ZH_CHARS.length]!;
  }
  return ch;
}

/**
 * A block of animated text: laid out once (lazily, on first use), then states() / draw() per frame.
 * See the top of the file for the style, animators and selectors.
 */
export class TextBlock {
  private L: TLayout | null = null;
  constructor(readonly text: string, readonly style: TextStyle) {}

  get layout(): TLayout {
    if (this.L) return this.L;
    const [L, ready] = layoutImpl(this.text, this.style);
    if (ready) this.L = L; // kept once the fonts were there
    return L;
  }
  count(unit: TextUnit): number { return this.layout.count[unit]; }

  /** Every glyph's state at t (whitespace included, flagged g.space). */
  states(t: number, anims: readonly TextAnimator[] = [], paint: TextPaint = {}): GlyphState[] {
    const L = this.layout, G = L.glyphs, N = G.length, st = L.style;
    const dx = new Float32Array(N), dy = new Float32Array(N), sx = new Float32Array(N).fill(1), sy = new Float32Array(N).fill(1);
    const rot = new Float32Array(N), skew = new Float32Array(N), skewAx = new Float32Array(N), alpha = new Float32Array(N).fill(1);
    const blur = new Float32Array(N), trk = new Float32Array(N), off = new Float32Array(N), sw = new Float32Array(N).fill(paint.strokeWidth ?? 0);
    const chars: string[] = G.map((g) => g.ch);
    const baseFill = paint.fill === undefined ? '#ffffff' : paint.fill;
    let fills: (RGBA | null)[] | null = null, strokes: (RGBA | null)[] | null = null;
    for (const A of anims) {
      const a = selectAmounts(A.select, L, t);
      const [px, py] = A.position ?? [0, 0];
      const sc = A.scale, scx = sc === undefined ? 1 : typeof sc === 'number' ? sc : sc[0], scy = sc === undefined ? 1 : typeof sc === 'number' ? sc : sc[1];
      const step = A.scramble ? Math.round(t * (A.scrambleRate ?? 20) + 1e-6) : 0;
      if (A.fill && !fills) fills = G.map(() => (typeof baseFill === 'string' ? parseColor(baseFill) : null));
      if (A.stroke && !strokes) strokes = G.map(() => (paint.stroke ? parseColor(paint.stroke) : null));
      for (let i = 0; i < N; i++) {
        const k = a[i]!;
        if (k === 0) continue;
        if (px || py) { dx[i] += k * px; dy[i] += k * py; }
        if (sc !== undefined) { sx[i] *= lerp(1, scx, k); sy[i] *= lerp(1, scy, k); }
        if (A.rotation) rot[i] += k * A.rotation;
        if (A.skew) { skew[i] += k * A.skew; if (A.skewAxis !== undefined) skewAx[i] = A.skewAxis; }
        if (A.opacity !== undefined) alpha[i] *= lerp(1, A.opacity, k);
        if (A.blur) blur[i] += k * A.blur;
        if (A.tracking) trk[i] += k * A.tracking;
        if (A.strokeWidth) sw[i] += k * A.strokeWidth;
        if (A.fill && fills) fills[i] = mixInto(fills[i]!, A.fill, k);
        if (A.stroke && strokes) strokes[i] = mixInto(strokes[i]!, A.stroke, k);
        if (A.charOffset) off[i] += k * A.charOffset;
        if (A.scramble && !G[i]!.space && hash(i, step, A.seed ?? 0, 7) < k) {
          const set = typeof A.scramble === 'string' ? A.scramble : scrambleSet(G[i]!.ch);
          if (set) { const arr = Array.from(set); chars[i] = arr[Math.floor(hash(i, step, A.seed ?? 0, 11) * arr.length)]!; }
        }
      }
    }
    // tracking: each glyph's extra advance pushes the ones after it (down the column when vertical); lines re-align
    const shift = new Float32Array(N), vert = !!st.vertical;
    for (const l of L.lines) {
      let cum = 0;
      for (let i = l.from; i < l.to; i++) { shift[i] = cum; if (i < l.to - 1) cum += trk[i]!; }
      const fix = st.align === 'center' ? -cum / 2 : st.align === 'right' ? -cum : 0;
      for (let i = l.from; i < l.to; i++) shift[i] += fix;
    }
    // pivots (anchor point grouping)
    const grp = paint.group ?? 'char', ph = st.pivot * st.size;
    const gx = new Map<number, [number, number]>();
    if (grp !== 'char') {
      for (const g of G) {
        if (g.space) continue;
        const id = grp === 'word' ? g.word : grp === 'line' ? g.lineUnit : 0, b = gx.get(id);
        // the group's extent along the text direction: x across a line, the glyph centres down a column
        const a0 = vert ? g.y + shift[g.i]! - ph : g.x + shift[g.i]!, a1 = vert ? a0 : a0 + g.w;
        if (b) { b[0] = Math.min(b[0], a0); b[1] = Math.max(b[1], a1); } else gx.set(id, [a0, a1]);
      }
    }
    const out: GlyphState[] = [];
    for (const g of G) {
      const i = g.i, x = g.x + (vert ? 0 : shift[i]!) + g.w / 2, y = g.y + (vert ? shift[i]! : 0);
      let pxv = x, pyv = y - ph;
      if (grp !== 'char' && !g.space) {
        const b = gx.get(grp === 'word' ? g.word : grp === 'line' ? g.lineUnit : 0)!;
        if (vert) pyv = (b[0] + b[1]) / 2; else pxv = (b[0] + b[1]) / 2;
        if (grp === 'all') { pyv = (L.top + L.bottom) / 2; if (vert) pxv = (L.left + L.right) / 2; }
      }
      const ch = off[i] ? shiftChar(chars[i]!, Math.round(off[i]!)) : chars[i]!;
      out.push({
        g, ch, x, y, px: pxv, py: pyv, dx: dx[i]!, dy: dy[i]!, sx: sx[i]!, sy: sy[i]!, rot: rot[i]!, skew: skew[i]!, skewAxis: skewAx[i]!,
        alpha: clamp(alpha[i]!), blur: Math.max(0, blur[i]!),
        fill: fills ? (fills[i] ? colStr(fills[i]!) : baseFill) : baseFill,
        stroke: strokes ? (strokes[i] ? colStr(strokes[i]!) : paint.stroke ?? null) : paint.stroke ?? null,
        strokeWidth: Math.max(0, sw[i]!),
      });
    }
    return out;
  }

  /** Draw at (x, y) (see style.align / valign) in the context's current transform. */
  draw(c: CanvasRenderingContext2D, x: number, y: number, t: number, anims: readonly TextAnimator[] = [], paint: TextPaint = {}): GlyphState[] {
    const S = this.states(t, anims, paint), L = this.layout;
    c.save();
    c.translate(x, y);
    c.font = font(L.style.family, L.style.size);
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    c.letterSpacing = '0px';
    c.lineJoin = 'round';
    const base = c.globalAlpha * clamp(paint.opacity ?? 1);
    const flat = paint.path ? (paint.path instanceof Path ? paint.path.flat(0.5) : paint.path) : null;
    const plen = flat ? pathLength(flat) : 0, closed = !!flat?.[0]?.closed;
    for (const s of S) {
      if (s.g.space) continue;
      const al = base * s.alpha;
      if (al < 1 / 512 || Math.abs(s.sx * s.sy) < 1e-6) continue;
      c.save();
      if (flat && plen > 0) {
        // the glyph's centre x becomes a distance along the path; its own frame turns with the tangent there
        // past the ends of an open path the glyphs carry on along the end tangents (they don't pile up on the end point)
        const d = (paint.pathOffset ?? 0) + s.x, P = pointAlong(flat, d / plen, closed);
        if (!closed && (d < 0 || d > plen)) { const ex = d < 0 ? d : d - plen; P.x += Math.cos(P.angle) * ex; P.y += Math.sin(P.angle) * ex; }
        c.translate(P.x, P.y);
        c.rotate(P.angle);
        c.translate(-s.x, 0);
      }
      c.globalAlpha = al;
      c.translate(s.px + s.dx, s.py + s.dy);
      if (s.rot) c.rotate(s.rot);
      if (s.skew) {
        if (s.skewAxis) c.rotate(s.skewAxis);
        c.transform(1, 0, -Math.tan(clamp(s.skew, -1.5, 1.5)), 1, 0, 0);
        if (s.skewAxis) c.rotate(-s.skewAxis);
      }
      if (s.sx !== 1 || s.sy !== 1) c.scale(s.sx, s.sy);
      c.translate(-s.px, -s.py);
      if (s.blur > 0.05) c.filter = `blur(${s.blur.toFixed(2)}px)`;
      const stroke = () => { if (s.stroke && s.strokeWidth > 0) { c.strokeStyle = s.stroke; c.lineWidth = s.strokeWidth; c.strokeText(s.ch, s.x, s.y); } };
      if (!paint.strokeOver) stroke();
      if (s.fill) { c.fillStyle = s.fill; c.fillText(s.ch, s.x, s.y); }
      if (paint.strokeOver) stroke();
      c.restore();
    }
    c.restore();
    return S;
  }
}

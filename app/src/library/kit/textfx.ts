// 展示字效果（Canvas2D 图层）：唱片环形字、贴纸字、彩虹挤出，以及综艺花字和它的动作。
//
// 为什么要花字这一套：综艺 / 短视频的字幕是“贴”在画面上的实物——挤出的厚度、彩色描边、白描边、渐变填充、
// 顶上一抹高光，底下一层软影子把它从照片上托起来；出场是一个字一个字弹出来、砸下来，停住以后还在轻轻晃。
// 原来只有 stickerText（描边 + 硬投影），平、死，像印在背景上。
// 花字的五层、弹簧和砸入参数参考 mg-styles-15 demos/18-hanazi（Vincentwei1021，MIT）。
//
//   ringText     环形字，每个字贴着切线；`fill360` 把它重复铺满一圈
//   pathText     沿折线排字（util.ts polylineLengths / pointAtLength）
//   stickerText  填充 + 粗圆角描边 + 实心偏移投影（孟菲斯贴纸字）
//   stackText    彩虹叠层挤出（kaomoji 的 (ง•̀ω•́)ง），`vanish` 时向灭点缩小
//   crackText    字面上从一点裂开的裂纹
//   ── 综艺花字 ──
//   hanazi       一组花字：挤出 2 层 → 彩色描边 → 白描边 → 渐变填充 → 高光，整组一层软影子（dy 12、σ 11）
//   hanaziGlyph  单个字的五层（不带影子），自己摆变换时用
//   popChar      单字弹出：弹簧 ζ0.517 ω22（0.17 s 即 30 fps 第 5 帧冲到 1.15），可掉落、旋入，停住后 1.15 Hz 摆 1.8°；t1 弹走
//   idleWiggle   停住后的摆动 / 上下浮 / 呼吸（popChar 用的那段，砸入的字也可以加）
//   beatHop      按拍子跳一下：起跳前压扁、抛物线、落地压扁再回弹
//   slamIn       砸入：3 帧 inQuad 从大缩到 1，落定那一下压到 0.92，再 cos(44t)·e^-16t 余振
//   popOut       弹走：先胀到 1.12 再缩没（0.17 s）
//   boil         手绘抖动的张号：每秒换 `rate` 张（12），`cycle` 张循环；按 stepT 取，不糊
//   burst / burstPoints        爆炸框（锯齿星形 + 后面一层错开的底色），每秒换 12 次种子
//   focusLines / focusQuads    集中线（从内椭圆往外的细三角），每秒换 12 次种子
//   sparkle      四角星闪光
// 字体传 CSS 字体串（type.ts font(F.sans(900), px)）；花字传引擎字体名 + 字号（每个字可以有自己的字号）。
// 除了显式传进来的 t，没有任何时间状态（确定性）。
import { mulberry32, polylineLengths, pointAtLength, clamp, lerp, ease, mod, stepT, TAU, type V2 } from '../../engine/util';
import { scaleContext2D, SCALE } from '../../engine/gl';
import { font as cssFont } from '../../engine/type';

const SEG = new Intl.Segmenter('ja', { granularity: 'grapheme' });
export const graphemes = (s: string) => [...SEG.segment(s)].map((g) => g.segment);

type Ctx = CanvasRenderingContext2D;
export interface Ink { fill?: string; stroke?: string; strokeW?: number }

function ink(c: Ctx, ch: string, x: number, y: number, o: Ink) {
  if (o.stroke && o.strokeW) { c.lineJoin = 'round'; c.lineWidth = o.strokeW; c.strokeStyle = o.stroke; c.strokeText(ch, x, y); }
  if (o.fill) { c.fillStyle = o.fill; c.fillText(ch, x, y); }
}

export interface RingOpts extends Ink {
  x: number; y: number; r: number;
  /** Angle of the first glyph's centre (radians; 0 = right, π/2 = bottom: screen y is down). Clockwise. */
  start?: number;
  /** Extra space between glyphs (px). */
  tracking?: number;
  /** Repeat the text (joined by `sep`) round the whole circle, spread evenly. */
  fill360?: boolean;
  sep?: string;
  /** Glyph tops toward the centre instead of away from it. */
  inward?: boolean;
  /** Shift of the glyphs off the circle (px, + = outward); the circle runs through the glyphs' middle by default. */
  baselineShift?: number;
}

/** Text around a circle (clockwise from `start`). Returns the arc length used (px). */
export function ringText(c: Ctx, font: string, text: string, o: RingOpts) {
  c.save();
  c.font = font; c.textAlign = 'center'; c.textBaseline = 'middle';
  let gs = graphemes(text);
  const tr = o.tracking ?? 0, circ = 2 * Math.PI * o.r;
  if (o.fill360) {
    const unit = graphemes(text + (o.sep ?? '  '));
    const uw = unit.reduce((s, g) => s + c.measureText(g).width + tr, 0);
    const k = Math.max(1, Math.round(circ / uw));
    gs = Array.from({ length: k }, () => unit).flat();
  }
  const ws = gs.map((g) => c.measureText(g).width + tr);
  const total = ws.reduce((a, b) => a + b, 0);
  const spread = o.fill360 ? circ / total : 1;
  let s = 0;
  const r = o.r + (o.baselineShift ?? 0);
  for (let i = 0; i < gs.length; i++) {
    const w = ws[i]! * spread, a = (o.start ?? -Math.PI / 2) + (s + w / 2) / o.r;
    s += w;
    if (gs[i] === ' ') continue;
    c.save();
    c.translate(o.x + Math.cos(a) * r, o.y + Math.sin(a) * r);
    c.rotate(a + (o.inward ? -Math.PI / 2 : Math.PI / 2));
    ink(c, gs[i]!, 0, 0, o);
    c.restore();
  }
  c.restore();
  return s;
}

/** Text along a polyline, starting `offset` px along it (glyphs on the tangent). */
export function pathText(c: Ctx, font: string, text: string, pts: V2[], o: Ink & { offset?: number; tracking?: number } = {}) {
  c.save();
  c.font = font; c.textAlign = 'center'; c.textBaseline = 'middle';
  const L = polylineLengths(pts);
  let s = o.offset ?? 0;
  for (const g of graphemes(text)) {
    const w = c.measureText(g).width + (o.tracking ?? 0);
    const p = pointAtLength(pts, L, s + w / 2);
    s += w;
    if (g === ' ' || s > L[L.length - 1]! + w) continue;
    c.save(); c.translate(p.x, p.y); c.rotate(p.angle); ink(c, g, 0, 0, o); c.restore();
  }
  c.restore();
}

export interface StickerOpts {
  fill: string;
  outline?: string;
  outlineW?: number;
  /** Solid offset shadow (drawn as a second, outlined copy). */
  shadow?: { dx: number; dy: number; color: string };
  align?: CanvasTextAlign;
}

/** Fill + thick round outline + offset shadow. */
export function stickerText(c: Ctx, font: string, text: string, x: number, y: number, o: StickerOpts) {
  c.save();
  c.font = font; c.textAlign = o.align ?? 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
  const ow = o.outlineW ?? 10, oc = o.outline ?? '#141018';
  if (o.shadow) {
    c.lineWidth = ow; c.strokeStyle = o.shadow.color; c.fillStyle = o.shadow.color;
    c.strokeText(text, x + o.shadow.dx, y + o.shadow.dy); c.fillText(text, x + o.shadow.dx, y + o.shadow.dy);
  }
  c.lineWidth = ow; c.strokeStyle = oc; c.strokeText(text, x, y);
  c.fillStyle = o.fill; c.fillText(text, x, y);
  c.restore();
}

export interface StackOpts {
  /** Number of copies behind the face. */
  layers?: number;
  /** Shift per copy (px) when there is no vanishing point. */
  dx?: number; dy?: number;
  /** Vanishing point: copies slide toward it and shrink; `depth` = how far the last copy gets (0..1). */
  vanish?: V2;
  depth?: number;
  /** Colours of the copies, cycling from the face backward. */
  colors?: string[];
  /** Each copy's own outline (the dark lines between the colour bands). */
  layerOutline?: string;
  layerOutlineW?: number;
  /** Copies drawn as outlines only (echo trails) instead of solid. */
  hollow?: boolean;
  /** Solid copies are also stroked this wide in their own colour (match the face's outlineW for continuous bands). */
  bandW?: number;
  /** Opacity falloff toward the back copies (0 = none, 1 = the last copy is invisible). */
  fade?: number;
  /** The face on top. */
  face?: StickerOpts | null;
  align?: CanvasTextAlign;
}

export const RAINBOW = ['#5BD6A0', '#F25C54', '#F7C948', '#F3E9D2', '#3EC1D3', '#9B7BEA'];

/** Rainbow stacked extrusion / echo trail. */
export function stackText(c: Ctx, font: string, text: string, x: number, y: number, o: StackOpts = {}) {
  const n = o.layers ?? 12, cols = o.colors ?? RAINBOW, depth = o.depth ?? 0.25;
  c.save();
  c.font = font; c.textAlign = o.align ?? 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
  for (let i = n; i >= 1; i--) {
    const k = i / n;
    let px = x + (o.dx ?? -5) * i, py = y + (o.dy ?? 7) * i, sc = 1;
    if (o.vanish) { const f = k * depth; px = x + (o.vanish.x - x) * f; py = y + (o.vanish.y - y) * f; sc = 1 - f; }
    c.save();
    c.globalAlpha = 1 - (o.fade ?? 0) * k;
    c.translate(px, py); c.scale(sc, sc);
    const col = cols[(i - 1) % cols.length]!;
    if (o.layerOutlineW) { c.lineWidth = o.layerOutlineW / sc; c.strokeStyle = o.layerOutline ?? '#141018'; c.strokeText(text, 0, 0); }
    if (o.hollow) { c.lineWidth = Math.max(2, (o.layerOutlineW ?? 6) * 0.6) / sc; c.strokeStyle = col; c.strokeText(text, 0, 0); }
    else {
      // a solid copy as fat as the face's outline, so the bands read as one striped extrusion
      if (o.bandW) { c.lineWidth = o.bandW / sc; c.strokeStyle = col; c.strokeText(text, 0, 0); }
      c.fillStyle = col; c.fillText(text, 0, 0);
    }
    c.restore();
  }
  c.restore();
  if (o.face !== null) stickerText(c, font, text, x, y, o.face ?? { fill: '#F7A934', outline: '#141018', outlineW: 9, align: o.align });
}

let scratch: { cv: HTMLCanvasElement; c: Ctx } | null = null;
/** The face (sticker style) with cracks: lines from a point inside it to beyond its edge, clipped to the letters. */
export function crackText(c: Ctx, font: string, text: string, x: number, y: number, o: StickerOpts & { from?: V2; n?: number; seed?: number; crack?: string; crackW?: number; crackEdge?: string }) {
  stickerText(c, font, text, x, y, o);
  // the cracks go on a scratch layer, are cut to the letters (destination-in), then laid over the face. (Not
  // source-in per line: in Chrome each source-in draw clears everything outside its own stroke.)
  c.save(); c.font = font;
  const m = c.measureText(text), w = Math.ceil(m.width + 40), h = Math.ceil((m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) + 40);
  c.restore();
  if (!scratch || scratch.cv.width < w * SCALE || scratch.cv.height < h * SCALE) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(w * SCALE, scratch?.cv.width ?? 0); cv.height = Math.max(h * SCALE, scratch?.cv.height ?? 0);
    scratch = { cv, c: scaleContext2D(cv.getContext('2d')!, SCALE) };
  }
  const s = scratch.c, ox = x - w / 2, oy = y - h / 2;
  s.setTransform(1, 0, 0, 1, 0, 0); s.globalCompositeOperation = 'source-over'; s.clearRect(0, 0, scratch.cv.width, scratch.cv.height);
  const rnd = mulberry32(o.seed ?? 7), from = o.from ?? { x: 0, y: 0 }, n = o.n ?? 14, R = Math.max(w, h);
  const paths: Path2D[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.5, p = new Path2D();
    let px = w / 2 + from.x, py = h / 2 + from.y;
    p.moveTo(px, py);
    for (let k = 0; k < 4; k++) { const st = R * (0.12 + 0.2 * rnd()), b = a + (rnd() - 0.5) * 0.7; px += Math.cos(b) * st; py += Math.sin(b) * st; p.lineTo(px, py); }
    paths.push(p);
  }
  // a dark edge under each light crack line
  const cw = o.crackW ?? 3;
  s.lineCap = 'round'; s.lineJoin = 'round';
  s.strokeStyle = o.crackEdge ?? '#141018'; s.lineWidth = cw + 3; for (const p of paths) s.stroke(p);
  s.strokeStyle = o.crack ?? '#FFF6E8'; s.lineWidth = cw; for (const p of paths) s.stroke(p);
  s.globalCompositeOperation = 'destination-in';
  s.font = font; s.textAlign = o.align ?? 'center'; s.textBaseline = 'middle';
  s.fillStyle = '#fff'; s.fillText(text, w / 2, h / 2);
  s.globalCompositeOperation = 'source-over';
  c.drawImage(scratch.cv, 0, 0, w * SCALE, h * SCALE, ox, oy, w, h);
}

// ---------------------------------------------------------------------------------------------------------------------
// 综艺花字：五层字 + 整组软影子。层的顺序和宽度照 18-hanazi 的 HZ()：挤出两份（ext、ext/2，和两道描边一样粗，
// 连成一块厚底）→ 彩色外描边 → 白描边 → 渐变填充 → 白色高光（顶上 gloss 不透明度，到 46 % 高度归零）。
// 影子是整组字的并集投下的一层（字和字之间不互相投影，重叠处也不加深），所以先把轮廓画进低分辨率草稿再一次模糊贴上。

/** Gradient stops [offset 0..1, css colour], top to bottom. */
export type Stops = readonly (readonly [offset: number, color: string])[];

export interface HanaziShadow {
  /** Offset (px, in the group's space: it does not turn with the glyphs), blur σ (px), colour and opacity. */
  dx?: number; dy?: number; sigma?: number; color?: string; alpha?: number;
}
/** The soft drop shadow of the reference: straight down 12 px, σ 11, deep plum at 0.36. */
export const HANAZI_SHADOW: Required<HanaziShadow> = { dx: 0, dy: 12, sigma: 11, color: '#1a0a28', alpha: 0.36 };

export interface HanaziStyle {
  /** Engine font family (F.sans(900): Archivo Black with 思源黑体 Heavy behind it for Chinese) and the base size (px). */
  family: string;
  size: number;
  /** Extrusion depth (px) straight down, and across (`extX`); two copies at full and half depth. 0 = none. */
  ext?: number;
  extX?: number;
  extColor?: string;
  /** Coloured outer stroke and white inner stroke, each this many px outside the glyph edge. */
  outer?: number;
  outerColor?: string;
  white?: number;
  whiteColor?: string;
  /** The face: a flat colour, or vertical gradient stops over the glyph box (`fillStops` wins). */
  fill?: string;
  fillStops?: Stops;
  /** Gloss: white at this opacity at the top of the glyph box, gone by `glossEnd` (0.46) of its height. 0 = none. */
  gloss?: number;
  glossEnd?: number;
  /** The glyph box the gradients span, in em from the middle baseline (default [-0.45, 0.45]: CJK ink). */
  box?: readonly [top: number, bottom: number];
  /** Soft shadow under the group (HANAZI_SHADOW by default; null = none). */
  shadow?: HanaziShadow | null;
  /** Italic lean in radians (−0.14 ≈ SVG skewX(−8): tops lean right). */
  skew?: number;
  /**
   * hanazi() draws each character from a bitmap made once per character / style / size (at 2× the output resolution,
   * 1.25× at 4K): re-stroking the four wide outlines every frame costs ~10 ms a character in software. false = vector
   * every frame (a character blown far past 2× its size).
   */
  cache?: boolean;
}

/** One character of a 花字 group, placed and posed (popChar / slamIn give s, dy, rot). */
export interface HanaziChar {
  ch: string;
  x: number;
  y: number;
  /** Rotation (rad), scale (and a separate vertical scale for squash), opacity. s = 0 or alpha = 0: not drawn. */
  rot?: number;
  s?: number;
  sy?: number;
  alpha?: number;
  /** This character's own size (strokes and extrusion scale with it) and face. */
  size?: number;
  fill?: string;
  fillStops?: Stops;
}

function vgrad(c: Ctx, top: number, bot: number, stops: Stops) {
  const g = c.createLinearGradient(0, top, 0, bot);
  for (const [o, col] of stops) g.addColorStop(clamp(o), col);
  return g;
}

/**
 * One 花字 character at the origin (centred on the middle baseline), all five layers, no shadow. Apply your own
 * transform first; `hanazi()` does that for a group and adds the shadow.
 */
export function hanaziGlyph(c: Ctx, ch: string, st: HanaziStyle, o: { size?: number; fill?: string; fillStops?: Stops } = {}) {
  const size = o.size ?? st.size, k = size / st.size;
  const white = (st.white ?? 0) * k, outer = (st.outer ?? 0) * k, fat = 2 * (white + outer);
  c.save();
  c.font = cssFont(st.family, size); c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round'; c.lineCap = 'round';
  if (st.skew) c.transform(1, 0, Math.tan(st.skew), 1, 0, 0);
  const solid = (col: string, w: number, x: number, y: number) => {
    c.fillStyle = col; c.strokeStyle = col;
    if (w > 0) { c.lineWidth = w; c.strokeText(ch, x, y); }
    c.fillText(ch, x, y);
  };
  if (st.ext) { const ec = st.extColor ?? '#1A1030', ex = (st.extX ?? 0) * k, ey = st.ext * k; solid(ec, fat, ex, ey); solid(ec, fat, ex / 2, ey / 2); }
  if (outer > 0) solid(st.outerColor ?? '#FF3D7F', fat, 0, 0);
  if (white > 0) solid(st.whiteColor ?? '#FFFFFF', 2 * white, 0, 0);
  const [b0, b1] = st.box ?? [-0.45, 0.45], top = b0 * size, bot = b1 * size;
  const stops = o.fillStops ?? (o.fill ? undefined : st.fillStops);
  c.fillStyle = stops ? vgrad(c, top, bot, stops) : (o.fill ?? st.fill ?? '#FFE14D');
  c.fillText(ch, 0, 0);
  if (st.gloss) {
    c.fillStyle = vgrad(c, top, bot, [[0, `rgba(255,255,255,${st.gloss})`], [st.glossEnd ?? 0.46, 'rgba(255,255,255,0)'], [1, 'rgba(255,255,255,0)']]);
    c.fillText(ch, 0, 0);
  }
  c.restore();
}

/** The silhouette a glyph's shadow is cast from: the extrusion and the outer stroke, one solid colour. */
function hanaziSilhouette(c: Ctx, ch: string, st: HanaziStyle, size: number) {
  const k = size / st.size, fat = 2 * ((st.white ?? 0) + (st.outer ?? 0)) * k;
  c.font = cssFont(st.family, size); c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round'; c.lineCap = 'round';
  if (st.skew) c.transform(1, 0, Math.tan(st.skew), 1, 0, 0);
  c.lineWidth = fat;
  const one = (x: number, y: number) => { if (fat > 0) c.strokeText(ch, x, y); c.fillText(ch, x, y); };
  one(0, 0);
  if (st.ext) { const ex = (st.extX ?? 0) * k, ey = st.ext * k; one(ex, ey); one(ex / 2, ey / 2); }
}

// 位图缓存：同一个字、同一套样式、同一个字号只描一次（五层字的粗描边很贵），之后每帧一次 drawImage。
// 影子的轮廓也缓存（低分辨率），模糊在低分辨率草稿里做完再放大贴上。
interface Sprite { cv: HTMLCanvasElement; ox: number; oy: number; w: number; h: number }
const sprites = new Map<string, Sprite>();
const SPRITES_MAX = 96;
let measureCtx: Ctx | null = null;

/** A glyph's layers (or its silhouette) drawn once at `res` device px per px, centred where the glyph's origin is. */
function sprite(kind: 'face' | 'shadow', ch: string, st: HanaziStyle, o: { size?: number; fill?: string; fillStops?: Stops }, res: number, color = ''): Sprite {
  const size = o.size ?? st.size, k = size / st.size;
  const key = JSON.stringify([kind, ch, size, res, color, st.family, st.ext, st.extX, st.extColor, st.outer, st.outerColor, st.white, st.whiteColor,
    st.fill, st.fillStops, st.gloss, st.glossEnd, st.box, st.skew, o.fill, o.fillStops]);
  const hit = sprites.get(key);
  if (hit) { sprites.delete(key); sprites.set(key, hit); return hit; }
  // the ink box (centred, middle baseline), leaned by the skew, fattened by the strokes, stretched by the extrusion
  const fnt = cssFont(st.family, size);
  measureCtx ??= document.createElement('canvas').getContext('2d')!;
  measureCtx.font = fnt; measureCtx.textAlign = 'center'; measureCtx.textBaseline = 'middle';
  const m = measureCtx.measureText(ch), sk = Math.abs(Math.tan(st.skew ?? 0)), lean = sk * Math.max(m.actualBoundingBoxAscent, m.actualBoundingBoxDescent);
  const pad = ((st.white ?? 0) + (st.outer ?? 0)) * k + 3, ex = (st.extX ?? 0) * k, ey = (st.ext ?? 0) * k;
  const X0 = -m.actualBoundingBoxLeft - lean - pad + Math.min(0, ex), X1 = m.actualBoundingBoxRight + lean + pad + Math.max(0, ex);
  const Y0 = -m.actualBoundingBoxAscent - pad + Math.min(0, ey), Y1 = m.actualBoundingBoxDescent + pad + Math.max(0, ey);
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.ceil((X1 - X0) * res)); cv.height = Math.max(1, Math.ceil((Y1 - Y0) * res));
  const g = cv.getContext('2d')!;
  g.setTransform(res, 0, 0, res, -X0 * res, -Y0 * res);
  if (kind === 'face') hanaziGlyph(g, ch, st, o);
  else { g.fillStyle = color; g.strokeStyle = color; hanaziSilhouette(g, ch, st, size); }
  const s: Sprite = { cv, ox: -X0, oy: -Y0, w: X1 - X0, h: Y1 - Y0 };
  sprites.set(key, s);
  if (sprites.size > SPRITES_MAX) sprites.delete(sprites.keys().next().value!);
  return s;
}

let shadeA: { cv: HTMLCanvasElement; c: Ctx } | null = null, shadeB: { cv: HTMLCanvasElement; c: Ctx } | null = null;
function scratchAtLeast(s: { cv: HTMLCanvasElement; c: Ctx } | null, w: number, h: number) {
  if (s && s.cv.width >= w && s.cv.height >= h) return s;
  const cv = document.createElement('canvas');
  cv.width = Math.max(w, s?.cv.width ?? 0); cv.height = Math.max(h, s?.cv.height ?? 0);
  return { cv, c: cv.getContext('2d')! };
}
const visibleChar = (g: HanaziChar) => (g.alpha ?? 1) > 0.001 && Math.abs(g.s ?? 1) > 1e-4 && Math.abs(g.sy ?? g.s ?? 1) > 1e-4;

/** The group's shadow: every silhouette into a low-res scratch (their union), blurred there, laid onto c once. */
function hanaziShadow(c: Ctx, chars: readonly HanaziChar[], st: HanaziStyle, sh: Required<HanaziShadow>) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const g of chars) {
    if (!visibleChar(g)) continue;
    const size = g.size ?? st.size, k = size / st.size, s = Math.max(Math.abs(g.s ?? 1), Math.abs(g.sy ?? g.s ?? 1));
    const r = (size * (0.8 + Math.abs(Math.tan(st.skew ?? 0)) * 0.5) + ((st.white ?? 0) + (st.outer ?? 0) + Math.hypot(st.ext ?? 0, st.extX ?? 0)) * k) * s;
    x0 = Math.min(x0, g.x - r); x1 = Math.max(x1, g.x + r); y0 = Math.min(y0, g.y - r); y1 = Math.max(y1, g.y + r);
  }
  if (!(x1 > x0 && y1 > y0)) return;
  // the shadow is blurred by σ px: a scratch at ~4/σ px per px is plenty (σ 11 → about a third of the resolution)
  const res = Math.min(1, 4 / Math.max(1, sh.sigma)), pad = Math.ceil(3 * sh.sigma * res);
  const pw = Math.ceil((x1 - x0) * res) + 2 * pad, ph = Math.ceil((y1 - y0) * res) + 2 * pad;
  shadeA = scratchAtLeast(shadeA, pw, ph); shadeB = scratchAtLeast(shadeB, pw, ph);
  const a = shadeA.c, b = shadeB.c;
  a.setTransform(1, 0, 0, 1, 0, 0); a.globalAlpha = 1; a.clearRect(0, 0, pw + 1, ph + 1);
  for (const g of chars) {
    if (!visibleChar(g)) continue;
    const sp = sprite('shadow', g.ch, st, { size: g.size }, res, sh.color);
    a.setTransform(res, 0, 0, res, (g.x - x0) * res + pad, (g.y - y0) * res + pad);
    a.rotate(g.rot ?? 0); a.scale(g.s ?? 1, g.sy ?? g.s ?? 1);
    a.globalAlpha = clamp(g.alpha ?? 1);
    a.drawImage(sp.cv, -sp.ox, -sp.oy, sp.w, sp.h);
  }
  b.setTransform(1, 0, 0, 1, 0, 0); b.globalAlpha = 1; b.clearRect(0, 0, pw + 1, ph + 1);
  b.filter = `blur(${sh.sigma * res}px)`; b.drawImage(shadeA.cv, 0, 0, pw, ph, 0, 0, pw, ph); b.filter = 'none';
  c.save();
  c.globalAlpha *= sh.alpha;
  c.drawImage(shadeB.cv, 0, 0, pw, ph, x0 + sh.dx - pad / res, y0 + sh.dy - pad / res, pw / res, ph / res);
  c.restore();
}

/**
 * A group of 花字 characters: the group's soft shadow first (one blurred union, in the space of c's current transform),
 * then each character's five layers in order (later ones overlap earlier ones, like stickers). Characters come from a
 * bitmap cache (HanaziStyle.cache).
 */
export function hanazi(c: Ctx, chars: readonly HanaziChar[], st: HanaziStyle) {
  const sh = st.shadow === null ? null : { ...HANAZI_SHADOW, ...(st.shadow ?? {}) };
  if (sh && sh.alpha > 0) hanaziShadow(c, chars, st, sh);
  const res = SCALE * (SCALE >= 2 ? 1.25 : 2);
  for (const g of chars) {
    if (!visibleChar(g)) continue;
    c.save();
    c.globalAlpha *= clamp(g.alpha ?? 1);
    c.translate(g.x, g.y); c.rotate(g.rot ?? 0); c.scale(g.s ?? 1, g.sy ?? g.s ?? 1);
    if (st.cache === false) hanaziGlyph(c, g.ch, st, g);
    else { const sp = sprite('face', g.ch, st, g, res); c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'low'; c.drawImage(sp.cv, -sp.ox, -sp.oy, sp.w, sp.h); }
    c.restore();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 字的动作：弹出、停住后的晃、按拍跳、砸入、弹走。全是 t 的纯函数；返回值直接喂给 HanaziChar（s / dy / rot）。

/**
 * Damped spring step 0 → 1 from rest (ζ < 1, ω rad/s), the velocity-matched form: no kink at t = 0.
 * ζ 0.517, ω 22 peaks at 1.15 after 0.167 s (frame 5 at 30 fps) and is within 1 % by frame 8.
 */
export function damped(t: number, zeta = 0.517, omega = 22): number {
  if (t <= 0) return 0;
  const z = Math.min(zeta, 0.999), wd = omega * Math.sqrt(1 - z * z);
  return 1 - Math.exp(-z * omega * t) * (Math.cos(wd * t) + (z * omega / wd) * Math.sin(wd * t));
}

export interface IdleOpts {
  /** Wiggle amplitude (rad, 1.8° default), bob (px), breathing scale (fraction) and their rate (Hz; breathing at twice it). */
  wig?: number;
  bob?: number;
  breath?: number;
  hz?: number;
  /** Each character its own phase (the reference: x · 0.013), so a row does not sway in lockstep. */
  phase?: number;
}

/**
 * The life a settled character keeps: a slow wiggle, a bob and a breath, fading in from `since` + 0.22 s over 0.35 s.
 * Driven by absolute t, so characters that landed at different times still sway together. dy: + = down.
 */
export function idleWiggle(t: number, since: number, o: IdleOpts = {}): { dy: number; rot: number; s: number } {
  const hold = clamp((t - since - 0.22) / 0.35), hz = o.hz ?? 1.15, ph = o.phase ?? 0;
  return {
    rot: hold * (o.wig ?? (1.8 * Math.PI) / 180) * Math.sin(TAU * hz * t + ph),
    dy: hold * (o.bob ?? 3) * Math.sin(TAU * hz * t + ph + 1.9),
    s: 1 + hold * (o.breath ?? 0.012) * Math.sin(TAU * hz * 2 * t + ph * 1.7),
  };
}

export interface PopOpts extends IdleOpts {
  /** Spring of the scale (0 → 1.15 → 1). */
  zeta?: number;
  omega?: number;
  /** Falls in from `drop` px above and turns in from `r0` rad, each on its own softer spring (title: 90 px, ±16°). */
  drop?: number;
  r0?: number;
  /** Pops out at t1 (popOut): swells, then shrinks to nothing in 0.17 s. */
  t1?: number;
}
export interface CharPose { visible: boolean; s: number; dy: number; rot: number }

/** A character popping in at t0 (spring scale from nothing, optional drop and turn), then idling; out at t1. */
export function popChar(t: number, t0: number, o: PopOpts = {}): CharPose {
  const u = t - t0;
  if (u < 0) return { visible: false, s: 0, dy: 0, rot: 0 };
  const idle = idleWiggle(t, t0, o);
  let s = damped(u, o.zeta ?? 0.517, o.omega ?? 22) * idle.s;
  const dy = -(o.drop ?? 0) * (1 - damped(u, 0.55, 20)) + idle.dy;
  const rot = (o.r0 ?? 0) * (1 - damped(u, 0.45, 18)) + idle.rot;
  if (o.t1 !== undefined) { const m = popOut(t, o.t1); if (m <= 0) return { visible: false, s: 0, dy, rot }; s *= m; }
  return { visible: true, s, dy, rot };
}

/** Scale multiplier of a pop-out at t1: 1, swells to 1.12 over the first 30 % of `dur`, then shrinks to 0. */
export function popOut(t: number, t1: number, dur = 0.17): number {
  if (t < t1) return 1;
  const k = (t - t1) / dur;
  if (k >= 1) return 0;
  return k < 0.3 ? 1 + 0.12 * ease.outQuad(k / 0.3) : 1.12 * (1 - ease.inCubic((k - 0.3) / 0.7));
}

/**
 * Hop on each beat (a title bouncing to the music): squashes 70 ms before the beat, flies a parabola `height` px high
 * for `air` s, lands squashed and rings out. `delay` staggers the characters (the reference: i · 2 frames at 30 fps).
 * Returns dy (up is negative) and sq: draw with scale (1 + sq, 1 − sq) and push down by about 0.35 · size · sq to keep
 * the feet planted.
 */
export function beatHop(t: number, beats: readonly number[], o: { delay?: number; height?: number; air?: number; amount?: number } = {}): { dy: number; sq: number } {
  const air = o.air ?? 0.24, hgt = o.height ?? 40, d = o.delay ?? 0, a = o.amount ?? 1;
  let hy = 0, sq = 0;
  for (const b of beats) {
    const u = t - b - d;
    if (u > -0.07 && u < 0) sq += 0.11 * (u + 0.07) / 0.07;
    else if (u >= 0 && u < air) { const k = u / air; hy += hgt * 4 * k * (1 - k); sq += (k < 0.15 ? 0.11 * (1 - k / 0.15) : 0) - 0.07 * Math.sin(Math.PI * k); }
    else if (u >= air && u < air + 0.16) { const w = (u - air) / 0.16; sq += 0.13 * Math.exp(-w * 3) * Math.cos(w * 7.5); }
  }
  return { dy: -hy, sq: sq * a };
}

export interface SlamOpts {
  /** Scale it starts at, and how long it takes to come down (0.1 s = 3 frames at 30 fps, inQuad: accelerating). */
  from?: number;
  dur?: number;
  /** The impact: squashed to 1 − amp on the hit, ringing cos(omega·t)·e^(−decay·t). */
  amp?: number;
  decay?: number;
  omega?: number;
  /** Turns in from this angle (rad) while it falls. */
  rot0?: number;
}
export interface SlamPose { visible: boolean; s: number; a: number; rot: number }

/**
 * Slammed down so that it hits at t0 (the beat): from `dur` before, it falls from `from`× to 1× accelerating and fades in
 * fast; on the hit it is squashed to 1 − amp (a deliberate jump: the frame of impact) and rings down. Not there before.
 */
export function slamIn(t: number, t0: number, o: SlamOpts = {}): SlamPose {
  const dur = o.dur ?? 0.1, from = o.from ?? 1.9, r0 = o.rot0 ?? 0;
  const u = t - (t0 - dur);
  if (u < 0) return { visible: false, s: from, a: 0, rot: r0 };
  if (t < t0) { const k = u / dur; return { visible: true, s: lerp(from, 1, k * k), a: clamp(k * 2.5), rot: r0 * (1 - k) }; }
  const w = t - t0;
  return { visible: true, s: 1 - (o.amp ?? 0.08) * Math.exp(-(o.decay ?? 16) * w) * Math.cos((o.omega ?? 44) * w), a: 1, rot: 0 };
}

// ---------------------------------------------------------------------------------------------------------------------
// 爆炸框、集中线：手绘漫画的“沸腾”——同一张图每秒重画 12 次，每次线条位置略有不同（换种子），循环 3 张。
// 按 stepT 取张号，一张图在它的 5 帧里完全不变，不会被运动模糊糊成一团。

/**
 * Which drawing a boiling (hand-redrawn) graphic shows at t: `rate` new drawings a second (12 = on twos at 24 fps; pick a
 * rate that divides 60), looping over `cycle` drawings (0 = a new one every time). Crisp: constant over a frame's shutter.
 */
export function boil(t: number, rate = 12, cycle = 0): number {
  const k = Math.round(stepT(t, rate) * rate);
  return cycle > 0 ? mod(k, cycle) : k;
}

/** Corners of a jagged burst centred on the origin: `n` spikes (2n points, out / in), seeded hand wobble. */
export function burstPoints(rx: number, ry: number, n = 15, seed = 1, spike = 0.3): V2[] {
  const R = mulberry32(seed), pts: V2[] = [];
  for (let i = 0; i < 2 * n; i++) {
    const a = (i / (2 * n)) * TAU + (R() - 0.5) * 0.09, out = i % 2 === 0;
    const k = out ? 1 + (R() - 0.45) * 0.26 : 1 - spike + (R() - 0.5) * 0.07;
    pts.push({ x: Math.cos(a) * rx * k, y: Math.sin(a) * ry * k });
  }
  return pts;
}

export interface BurstOpts {
  rx: number;
  ry: number;
  n?: number;
  spike?: number;
  /** Fill, outline and its width (px). */
  fill?: string;
  stroke?: string;
  strokeW?: number;
  /** A second burst behind, a little bigger and offset (a printed mis-register); null = none. */
  back?: { fill?: string; dx?: number; dy?: number; grow?: number } | null;
  /** Scale and rotation (rad) about the centre. */
  s?: number;
  rot?: number;
  /** Boil: drawings a second, looping over `cycle`; `seed` picks the family of drawings. */
  rate?: number;
  cycle?: number;
  seed?: number;
}

/** The comic explosion frame behind a shout, boiling at 12 drawings a second. */
export function burst(c: Ctx, t: number, x: number, y: number, o: BurstOpts) {
  const s = o.s ?? 1;
  if (Math.abs(s) < 1e-4) return;
  const k = boil(t, o.rate ?? 12, o.cycle ?? 3), seed = (o.seed ?? 100) + k * 7919, n = o.n ?? 15, sp = o.spike ?? 0.3;
  const poly = (pts: V2[]) => { c.beginPath(); pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y))); c.closePath(); };
  c.save();
  c.translate(x, y); c.rotate(o.rot ?? 0); c.scale(s, s);
  c.lineJoin = 'round'; c.strokeStyle = o.stroke ?? '#1A1030';
  if (o.back !== null) {
    const b = o.back ?? {}, g = b.grow ?? 20;
    poly(burstPoints(o.rx + g, o.ry + g * 0.75, n, seed + 100, sp).map((p) => ({ x: p.x + (b.dx ?? 16), y: p.y + (b.dy ?? 18) })));
    c.fillStyle = b.fill ?? '#FF3D7F'; c.fill();
    c.lineWidth = (o.strokeW ?? 10) * 0.9; c.stroke();
  }
  poly(burstPoints(o.rx, o.ry, n, seed, sp));
  c.fillStyle = o.fill ?? '#FFF15A'; c.fill();
  c.lineWidth = o.strokeW ?? 10; c.stroke();
  c.restore();
}

export interface FocusOpts {
  /** Number of lines; the clear zone's inner radius range (px, each line its own); how far out they reach. */
  n?: number;
  rIn?: readonly [number, number];
  rOut?: number;
  /** Angular half-width of a line at the outer end (rad, range). */
  width?: readonly [number, number];
  /** Vertical scale of the pattern (1.18 on a portrait frame; < 1 for landscape). */
  aspect?: number;
}

/** The focus-line wedges (manga speed lines toward a point) as triangles around the origin: tip inside, base outside. */
export function focusQuads(seed: number, o: FocusOpts = {}): [V2, V2, V2][] {
  const R = mulberry32(seed), n = o.n ?? 120, [ri0, ri1] = o.rIn ?? [470, 730], ro = o.rOut ?? 1600, [w0, w1] = o.width ?? [0.0035, 0.0145], asp = o.aspect ?? 1.18;
  const p = (a: number, r: number): V2 => ({ x: Math.cos(a) * r, y: Math.sin(a) * r * asp });
  const out: [V2, V2, V2][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + (R() - 0.5) * (TAU / n) * 0.9, w = w0 + R() * (w1 - w0), ri = ri0 + R() * (ri1 - ri0);
    out.push([p(a, ri), p(a - w, ro), p(a + w, ro)]);
  }
  return out;
}

/** Focus lines around (cx, cy), boiling at 12 drawings a second (3-drawing loop). */
export function focusLines(c: Ctx, t: number, cx: number, cy: number, o: FocusOpts & { color?: string; alpha?: number; rate?: number; cycle?: number; seed?: number } = {}) {
  const k = boil(t, o.rate ?? 12, o.cycle ?? 3), tris = focusQuads((o.seed ?? 300) + k * 7919, o);
  c.save();
  c.globalAlpha *= o.alpha ?? 0.92; c.fillStyle = o.color ?? '#FFFFFF';
  c.beginPath();
  for (const [a, b, d] of tris) { c.moveTo(cx + a.x, cy + a.y); c.lineTo(cx + b.x, cy + b.y); c.lineTo(cx + d.x, cy + d.y); c.closePath(); }
  c.fill();
  c.restore();
}

/** A four-point sparkle (✦) of radius r at (x, y), turned by rot; `glow` adds a soft halo in that colour (null = none). */
export function sparkle(c: Ctx, x: number, y: number, r: number, o: { rot?: number; fill?: string; stroke?: string; strokeW?: number; glow?: string | null } = {}) {
  if (r <= 0) return;
  const k = r * 0.16;
  c.save();
  c.translate(x, y); c.rotate(o.rot ?? 0);
  c.beginPath();
  c.moveTo(0, -r); c.quadraticCurveTo(k, -k, r, 0); c.quadraticCurveTo(k, k, 0, r); c.quadraticCurveTo(-k, k, -r, 0); c.quadraticCurveTo(-k, -k, 0, -r);
  c.closePath();
  if (o.glow !== null) { c.shadowColor = o.glow ?? '#FFE14D'; c.shadowBlur = Math.max(6, r * 0.5); }
  c.fillStyle = o.fill ?? '#FFFFFF'; c.fill();
  c.shadowColor = 'transparent'; c.shadowBlur = 0;
  if (o.stroke !== undefined || o.strokeW) { c.lineJoin = 'round'; c.lineWidth = o.strokeW ?? 3.5; c.strokeStyle = o.stroke ?? '#FFD23F'; c.stroke(); }
  c.restore();
}

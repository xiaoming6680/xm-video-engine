// Display-type effects for Canvas2D layers (kaomoji.exe's sticker letters, record rings, rainbow extrusions):
//   ringText     text set around a circle, each glyph on the tangent; `fill360` repeats it round the whole ring
//   pathText     text along a polyline (util.ts polylineLengths / pointAtLength)
//   stickerText  fill + thick round outline + a solid offset shadow (Memphis sticker letters)
//   stackText    rainbow stacked extrusion: copies behind the face, each step shifted (and shrunk toward a vanishing
//                point when `vanish` is set), colours cycling — the (ง•̀ω•́)ง look; `gap` > 0 spaces them into echoes
//   crackText    the face with cracks running out from a point inside it (the "broken parts" of the repair scene)
// All take a CSS font string (type.ts font(F.archivo(…), px)) and draw at baseline-centre (x, y) unless noted.
// Glyph clusters (combining marks in ง•̀ω•́) stay together (Intl.Segmenter). Deterministic: no time inside.
import { mulberry32, polylineLengths, pointAtLength, type V2 } from '../engine/util';
import { scaleContext2D, SCALE } from '../engine/gl';

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

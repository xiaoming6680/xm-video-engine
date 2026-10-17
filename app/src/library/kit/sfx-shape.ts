// Custom shapes for the shaders library's shape effects (Chrome, Glass, Neon, LiquidMetal, Frost, … — any component
// with a `shapeSdfUrl` prop): a signed distance field of text or of anything drawn on a canvas, in the library's
// SVG-SDF format, as a blob URL. Use it as `shapeSdfUrl` (flat), and with `shapeType: 'svgExtrude3D'` for an
// extruded solid; await fx.ready() after setting it (the library loads the URL asynchronously).
//
//   const url = sdfText('基础引擎', { font: font(F.archivo(125, 900), 200) });
//   new Sfx(renderer, [{ type: 'Chrome', props: { shapeSdfUrl: url, scale: 2.2 } }]);
//
// The field (the library's convention, kit/sdf.ts + sdf3d.ts): SVG_SDF_SIZE² texels covering the shape's local
// square [-0.5, 0.5]² (1 unit = the canvas height at the component's `scale` 1), top row first, distances in units of
// the field's width, negative inside, stored as Uint16 over [-1, 1] (the "compact" .bin).
// Distances: exact Euclidean (Felzenszwalb–Huttenlocher), the anti-aliased edge placed to a sub-texel (an edge
// texel of coverage a is a half-texel band moved by a − 0.5).
import { SVG_SDF_SIZE } from '../vendor/shaders/gpu/kit/sdf';

/** One-dimensional squared Euclidean distance transform of f (n samples) into d (lower envelope of parabolas). */
function edt1d(f: Float64Array, d: Float64Array, v: Int32Array, z: Float64Array, n: number) {
  let k = 0;
  v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    // where the parabola from q overtakes the last one of the envelope; drop the ones it hides
    let r = v[k]!;
    let s = (f[q]! + q * q - (f[r]! + r * r)) / (2 * q - 2 * r);
    while (s <= z[k]!) {
      k--;
      r = v[k]!;
      s = (f[q]! + q * q - (f[r]! + r * r)) / (2 * q - 2 * r);
    }
    k++;
    v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const r = v[k]!;
    d[q] = (q - r) * (q - r) + f[r]!;
  }
}

/** 2D squared EDT in place (columns, then rows). */
function edt2d(g: Float64Array, w: number, h: number) {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x]!;
    edt1d(f, d, v, z, h);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y]!;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x]!;
    edt1d(f, d, v, z, w);
    for (let x = 0; x < w; x++) g[y * w + x] = d[x]!;
  }
}

/**
 * Signed distance (texels, negative inside) of a coverage map `alpha` (0..1, w x h). Covered texels are inside;
 * partly covered ones place the edge inside them.
 */
export function signedDistance(alpha: Float32Array | Uint8ClampedArray, w: number, h: number, scale255 = alpha instanceof Uint8ClampedArray): Float32Array {
  const BIG = 1e20;
  const outer = new Float64Array(w * h), inner = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = scale255 ? alpha[i]! / 255 : alpha[i]!;
    if (a >= 1) { outer[i] = 0; inner[i] = BIG; }
    else if (a <= 0) { outer[i] = BIG; inner[i] = 0; }
    else { outer[i] = Math.max(0, 0.5 - a) ** 2; inner[i] = Math.max(0, a - 0.5) ** 2; }
  }
  edt2d(outer, w, h);
  edt2d(inner, w, h);
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.sqrt(outer[i]!) - Math.sqrt(inner[i]!);
  return out;
}

/**
 * A field of `n` x `n` texels from a coverage map rendered `ss` times larger (alpha, top row first): the signed
 * distance of the fine map (edges placed by coverage), sampled at the coarse texel centres, in units of the
 * field's width. Supersampling takes the edge-placement error (about half a texel) down by `ss`.
 */
export function fieldFromCoverage(alpha: Float32Array, n: number, ss: number): Float32Array {
  const N = n * ss;
  const d = signedDistance(alpha, N, N, false);
  const out = new Float32Array(n * n);
  const h = ss / 2; // a coarse centre sits between fine texels h-1 and h
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const fx = x * ss + h - 1, fy = y * ss + h - 1;
    const v = ss === 1 ? d[y * N + x]! : (d[fy * N + fx]! + d[fy * N + fx + 1]! + d[(fy + 1) * N + fx]! + d[(fy + 1) * N + fx + 1]!) / 4;
    out[y * n + x] = v / N;
  }
  return out;
}

/** The library's compact .bin (Uint16 over [-1, 1]) of a field in field-width units, as a blob URL. */
function binURL(field: Float32Array) {
  const u = new Uint16Array(field.length);
  for (let i = 0; i < field.length; i++) u[i] = Math.round((Math.max(-1, Math.min(1, field[i]!)) + 1) * 32767.5);
  return URL.createObjectURL(new Blob([u.buffer], { type: 'application/octet-stream' }));
}

/** Supersampling of the coverage raster (the field is SVG_SDF_SIZE², 1024² here; the raster SS times that). */
const SS = 2;

/**
 * A shape drawn by `draw` on the field canvas (any colour; coverage = alpha), in field pixels (`size` x `size`):
 * the field's centre is the shape's centre, its width 1 shape unit.
 */
export function sdfShape(draw: (c: CanvasRenderingContext2D, size: number) => void): string {
  const N = SVG_SDF_SIZE, M = N * SS;
  const c = document.createElement('canvas');
  c.width = M; c.height = M;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.scale(SS, SS);
  x.fillStyle = '#fff'; x.strokeStyle = '#fff';
  draw(x, N);
  const px = x.getImageData(0, 0, M, M).data;
  const a = new Float32Array(M * M);
  for (let i = 0; i < M * M; i++) a[i] = px[i * 4 + 3]! / 255;
  return binURL(fieldFromCoverage(a, N, SS));
}

export interface FitOptions {
  /** Empty margin on each side, as a fraction of the field (room for bevels, glows, blur). Default 0.06. */
  padding?: number;
}

/** Any image (its alpha), scaled to fit the field (aspect kept, centred). */
export function sdfImage(src: CanvasImageSource & { width: number; height: number }, opts: FitOptions = {}): string {
  const pad = opts.padding ?? 0.06;
  // the content's alpha bounds
  const w = src.width, h = src.height;
  const t = document.createElement('canvas'); t.width = w; t.height = h;
  const tx = t.getContext('2d', { willReadFrequently: true })!;
  tx.drawImage(src, 0, 0);
  const px = tx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3]! > 0) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (x1 < 0) throw new Error('sdfImage: the image is empty (no alpha)');
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  return sdfShape((c, N) => {
    const k = (N * (1 - 2 * pad)) / Math.max(bw, bh);
    c.imageSmoothingQuality = 'high';
    c.drawImage(t, x0, y0, bw, bh, (N - bw * k) / 2, (N - bh * k) / 2, bw * k, bh * k);
  });
}

export interface TextShapeOptions extends FitOptions {
  /** A Canvas2D font, e.g. font(F.archivo(125, 900), 200) (the size only sets the raster's detail). */
  font: string;
  /** Extra tracking (px at the given font size). */
  letterSpacing?: number;
  /** Line gap for multi-line text ('\n'), as a multiple of the font size. Default 1.1. */
  lineHeight?: number;
}

/**
 * Text as a shape, fitted to the field. Rasterised large and scaled into the field. Lines split on '\n'.
 * Returns { url, aspect } — aspect = width / height of the text block (the shape's footprint is
 * the field's width or height, whichever the block fills).
 */
export function sdfText(text: string, opts: TextShapeOptions): { url: string; aspect: number } {
  const lines = text.split('\n');
  const m = document.createElement('canvas').getContext('2d')!;
  m.font = opts.font;
  if (opts.letterSpacing) m.letterSpacing = `${opts.letterSpacing}px`;
  const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(opts.font)?.[1] ?? '100');
  const lh = (opts.lineHeight ?? 1.1) * size;
  const ws = lines.map((l) => m.measureText(l));
  const asc = Math.max(...ws.map((w) => w.actualBoundingBoxAscent)), desc = Math.max(...ws.map((w) => w.actualBoundingBoxDescent));
  const W = Math.ceil(Math.max(...ws.map((w) => w.actualBoundingBoxLeft + w.actualBoundingBoxRight))) + 8;
  const H = Math.ceil(asc + desc + lh * (lines.length - 1)) + 8;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d')!;
  x.font = opts.font;
  if (opts.letterSpacing) x.letterSpacing = `${opts.letterSpacing}px`;
  x.fillStyle = '#fff';
  x.textBaseline = 'alphabetic';
  lines.forEach((l, i) => {
    const w = ws[i]!;
    const lw = w.actualBoundingBoxLeft + w.actualBoundingBoxRight;
    x.fillText(l, 4 + (W - 8 - lw) / 2 + w.actualBoundingBoxLeft, 4 + asc + i * lh);
  });
  return { url: sdfImage(c, opts), aspect: W / H };
}

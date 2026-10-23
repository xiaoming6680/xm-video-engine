// 精确欧氏距离变换（Felzenszwalb–Huttenlocher）：覆盖图 → 有符号距离场。
// sfx-shape.ts（shaders 库的自定义形状）和 liquid.ts（字形距离场）共用；单独一个文件，用的场景不会被拖进 shaders 库。

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
 * Signed distance (texels, negative inside) of a coverage map `alpha` (0..1, row-major w x h; a Uint8ClampedArray is
 * read as 0..255). Covered texels are inside; an edge texel of coverage a puts the edge (a − 0.5) texels past its
 * centre, so anti-aliased shapes give sub-texel edges.
 */
export function signedDistance(alpha: ArrayLike<number>, w: number, h: number, scale255 = alpha instanceof Uint8ClampedArray): Float32Array {
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

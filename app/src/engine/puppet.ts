// 操控点（AE 的 Puppet Pin）：按图层的 alpha 铺一张三角网格（只铺在有内容的地方，分开的肢体网格也分开），在图上钉几个点，
// 把点拖到别处，整张图尽量「刚性」地跟着弯（ARAP：每个三角形尽量只转不变形）。effects.ts 的 { type: 'puppet', … } 用它。
//
// 每帧都从同一个起点（按钉子的位移反距离加权挪一遍）做固定次数的迭代，所以结果只取决于钉子这一帧的位置，任何一帧都能单独渲。
// 网格按 id（或尺寸 + 钉子的原位）缓存：图层内容的形状变了要换 id。
import * as THREE from 'three';
import { FSPass } from './gl';

type V2 = readonly [number, number];

export interface PuppetPin { at: V2; to: V2 }

/** A mesh over the opaque cells of an alpha grid, with its ARAP system for a set of pins. */
export class PuppetMesh {
  readonly X: Float64Array;              // rest positions (x, y interleaved), content px
  readonly tris: Uint32Array;
  readonly n: number;
  private rows: { j: number[]; w: number[] }[];   // the cotangent Laplacian, by row
  private triW: Float64Array;            // per triangle: the three edge weights (opposite each corner)
  private pins: { tri: number; b: [number, number, number] }[] = [];
  private pinKey = '';
  private diag = new Float64Array(0);
  private W = 0;
  private lambda = 0;

  /**
   * alpha: nx x ny cells (row-major, 0–1), each `step` px; a cell is in when any of its samples is above `th`. In cells
   * grow by one cell so the edge pixels are covered.
   */
  constructor(alpha: Float32Array, nx: number, ny: number, step: number, th = 0.04) {
    const inC = new Uint8Array(nx * ny);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      let on = false;
      for (let dy = -1; dy <= 1 && !on; dy++) for (let dx = -1; dx <= 1 && !on; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < nx && yy < ny && alpha[yy * nx + xx]! > th) on = true;
      }
      inC[y * nx + x] = on ? 1 : 0;
    }
    const vid = new Int32Array((nx + 1) * (ny + 1)).fill(-1), X: number[] = [], T: number[] = [];
    const v = (x: number, y: number) => {
      const k = y * (nx + 1) + x;
      if (vid[k]! < 0) { vid[k] = X.length / 2; X.push(x * step, y * step); }
      return vid[k]!;
    };
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      if (!inC[y * nx + x]) continue;
      const a = v(x, y), b = v(x + 1, y), c = v(x + 1, y + 1), d = v(x, y + 1);
      // alternate the diagonal so the mesh has no preferred direction
      if ((x + y) % 2) T.push(a, b, c, a, c, d); else T.push(a, b, d, b, c, d);
    }
    this.X = Float64Array.from(X);
    this.tris = Uint32Array.from(T);
    this.n = X.length / 2;
    this.triW = new Float64Array(T.length);
    const rows = Array.from({ length: this.n }, () => new Map<number, number>());
    const P = this.X;
    for (let t = 0; t < T.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        // weight of the edge opposite corner k: half the cotangent of the angle at k
        const o = T[t + k]!, i = T[t + (k + 1) % 3]!, j = T[t + (k + 2) % 3]!;
        const ux = P[i * 2]! - P[o * 2]!, uy = P[i * 2 + 1]! - P[o * 2 + 1]!, wx = P[j * 2]! - P[o * 2]!, wy = P[j * 2 + 1]! - P[o * 2 + 1]!;
        const cot = (ux * wx + uy * wy) / Math.max(1e-12, Math.abs(ux * wy - uy * wx));
        const w = Math.max(0, 0.5 * cot);
        this.triW[t + k] = w;
        for (const [p, q] of [[i, j], [j, i]] as const) { const r = rows[p]!; r.set(q, (r.get(q) ?? 0) - w); r.set(p, (r.get(p) ?? 0) + w); }
      }
    }
    this.rows = rows.map((r) => ({ j: [...r.keys()], w: [...r.values()] }));
  }

  private comp: Int32Array | null = null;
  /** Each vertex's connected piece of mesh (union-find over the triangles). */
  private components(): Int32Array {
    if (this.comp) return this.comp;
    const par = Int32Array.from({ length: this.n }, (_, i) => i);
    const find = (i: number): number => { while (par[i] !== i) { par[i] = par[par[i]!]!; i = par[i]!; } return i; };
    const T = this.tris;
    for (let t = 0; t < T.length; t += 3) { const a = find(T[t]!); par[find(T[t + 1]!)] = a; par[find(T[t + 2]!)] = a; }
    this.comp = Int32Array.from({ length: this.n }, (_, i) => find(i));
    return this.comp;
  }

  /** Which triangle holds the rest point (barycentric), or the nearest vertex. */
  private locate(p: V2): { tri: number; b: [number, number, number] } {
    const T = this.tris, P = this.X;
    for (let t = 0; t < T.length; t += 3) {
      const a = T[t]!, b = T[t + 1]!, c = T[t + 2]!;
      const ax = P[a * 2]!, ay = P[a * 2 + 1]!, bx = P[b * 2]!, by = P[b * 2 + 1]!, cx = P[c * 2]!, cy = P[c * 2 + 1]!;
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(d) < 1e-12) continue;
      const l1 = ((by - cy) * (p[0] - cx) + (cx - bx) * (p[1] - cy)) / d, l2 = ((cy - ay) * (p[0] - cx) + (ax - cx) * (p[1] - cy)) / d, l3 = 1 - l1 - l2;
      if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) return { tri: t, b: [l1, l2, l3] };
    }
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.n; i++) { const d = Math.hypot(P[i * 2]! - p[0], P[i * 2 + 1]! - p[1]); if (d < bd) { bd = d; best = i; } }
    for (let t = 0; t < T.length; t += 3) for (let k = 0; k < 3; k++) if (T[t + k] === best) { const b: [number, number, number] = [0, 0, 0]; b[k] = 1; return { tri: t, b }; }
    return { tri: 0, b: [1, 0, 0] };
  }

  private setPins(pins: readonly PuppetPin[]) {
    const key = JSON.stringify(pins.map((p) => p.at));
    if (key === this.pinKey) return;
    this.pinKey = key;
    this.pins = pins.map((p) => this.locate(p.at));
    // pins much stiffer than the mesh; a whisper of "stay where the first guess put you" keeps unpinned pieces in place
    let mean = 0;
    for (const r of this.rows) for (let k = 0; k < r.j.length; k++) if (r.w[k]! > 0) mean += r.w[k]!;
    mean /= Math.max(1, this.n);
    this.W = 1000 * Math.max(mean, 1e-3);
    this.lambda = 1e-4 * Math.max(mean, 1e-3);
    this.diag = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) { const r = this.rows[i]!; this.diag[i] = (r.w[r.j.indexOf(i)] ?? 0) + this.lambda; }
    for (const p of this.pins) for (let k = 0; k < 3; k++) { const i = this.tris[p.tri + k]!; this.diag[i] = this.diag[i]! + this.W * p.b[k]! * p.b[k]!; }
  }

  /** y = A x for the system A = L + W Σ b bᵀ + λ I (one coordinate). */
  private mul(x: Float64Array, y: Float64Array) {
    for (let i = 0; i < this.n; i++) { const r = this.rows[i]!; let s = this.lambda * x[i]!; for (let k = 0; k < r.j.length; k++) s += r.w[k]! * x[r.j[k]!]!; y[i] = s; }
    for (const p of this.pins) {
      const t = p.tri, a = this.tris[t]!, b = this.tris[t + 1]!, c = this.tris[t + 2]!;
      const v = p.b[0] * x[a]! + p.b[1] * x[b]! + p.b[2] * x[c]!;
      y[a] = y[a]! + this.W * p.b[0] * v; y[b] = y[b]! + this.W * p.b[1] * v; y[c] = y[c]! + this.W * p.b[2] * v;
    }
  }

  /** Jacobi-preconditioned conjugate gradients from x (in place). */
  private cg(rhs: Float64Array, x: Float64Array, iters: number) {
    const n = this.n, r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), Ap = new Float64Array(n);
    this.mul(x, Ap);
    let rz = 0, r0 = 0;
    for (let i = 0; i < n; i++) { r[i] = rhs[i]! - Ap[i]!; z[i] = r[i]! / this.diag[i]!; p[i] = z[i]!; rz += r[i]! * z[i]!; r0 += rhs[i]! * rhs[i]!; }
    for (let it = 0; it < iters; it++) {
      this.mul(p, Ap);
      let pAp = 0;
      for (let i = 0; i < n; i++) pAp += p[i]! * Ap[i]!;
      if (Math.abs(pAp) < 1e-30) break;
      const al = rz / pAp;
      let rr = 0, rz2 = 0;
      for (let i = 0; i < n; i++) { x[i] = x[i]! + al * p[i]!; r[i] = r[i]! - al * Ap[i]!; rr += r[i]! * r[i]!; }
      if (rr <= 1e-16 * Math.max(r0, 1e-30)) break;
      for (let i = 0; i < n; i++) { z[i] = r[i]! / this.diag[i]!; rz2 += r[i]! * z[i]!; }
      const be = rz2 / rz;
      rz = rz2;
      for (let i = 0; i < n; i++) p[i] = z[i]! + be * p[i]!;
    }
  }

  /** The deformed vertex positions (x, y interleaved, content px) for the pins moved to their `to`. */
  solve(pins: readonly PuppetPin[], iterations = 8): Float64Array {
    const n = this.n, X = this.X, T = this.tris;
    const U = Float64Array.from(X);
    if (!pins.length || !n) return U;
    this.setPins(pins);
    // first guess: every vertex moved by the moves of the pins on its own piece of mesh, weighted by inverse squared
    // distance (a piece with no pin stays put; pins never pull across a gap)
    const comp = this.components();
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0, sw = 0;
      pins.forEach((p, q) => {
        if (comp[this.tris[this.pins[q]!.tri]!] !== comp[i]) return;
        const d2 = (X[i * 2]! - p.at[0]) ** 2 + (X[i * 2 + 1]! - p.at[1]) ** 2 + 1, w = 1 / d2;
        sx += w * (p.to[0] - p.at[0]); sy += w * (p.to[1] - p.at[1]); sw += w;
      });
      if (sw > 0) { U[i * 2] = X[i * 2]! + sx / sw; U[i * 2 + 1] = X[i * 2 + 1]! + sy / sw; }
    }
    const U0 = Float64Array.from(U);
    const ux = new Float64Array(n), uy = new Float64Array(n), bx = new Float64Array(n), by = new Float64Array(n);
    for (let i = 0; i < n; i++) { ux[i] = U[i * 2]!; uy[i] = U[i * 2 + 1]!; }
    for (let it = 0; it < iterations; it++) {
      bx.fill(0); by.fill(0);
      for (let t = 0; t < T.length; t += 3) {
        // local: the rotation that best maps the rest triangle's edges onto the current ones
        let m00 = 0, m01 = 0, m10 = 0, m11 = 0;
        for (let k = 0; k < 3; k++) {
          const w = this.triW[t + k]!, i = T[t + (k + 1) % 3]!, j = T[t + (k + 2) % 3]!;
          const ex = X[i * 2]! - X[j * 2]!, ey = X[i * 2 + 1]! - X[j * 2 + 1]!, fx = ux[i]! - ux[j]!, fy = uy[i]! - uy[j]!;
          m00 += w * fx * ex; m01 += w * fx * ey; m10 += w * fy * ex; m11 += w * fy * ey;
        }
        const th = Math.atan2(m10 - m01, m00 + m11), c = Math.cos(th), s = Math.sin(th);
        for (let k = 0; k < 3; k++) {
          const w = this.triW[t + k]!, i = T[t + (k + 1) % 3]!, j = T[t + (k + 2) % 3]!;
          const ex = X[i * 2]! - X[j * 2]!, ey = X[i * 2 + 1]! - X[j * 2 + 1]!, rx = w * (c * ex - s * ey), ry = w * (s * ex + c * ey);
          bx[i] = bx[i]! + rx; by[i] = by[i]! + ry; bx[j] = bx[j]! - rx; by[j] = by[j]! - ry;
        }
      }
      // global: the positions closest to those rotated edges, the pins and the first guess
      for (let q = 0; q < pins.length; q++) {
        const p = this.pins[q]!, y = pins[q]!.to;
        for (let k = 0; k < 3; k++) { const i = T[p.tri + k]!; bx[i] = bx[i]! + this.W * p.b[k]! * y[0]; by[i] = by[i]! + this.W * p.b[k]! * y[1]; }
      }
      for (let i = 0; i < n; i++) { bx[i] = bx[i]! + this.lambda * U0[i * 2]!; by[i] = by[i]! + this.lambda * U0[i * 2 + 1]!; }
      this.cg(bx, ux, 60);
      this.cg(by, uy, 60);
    }
    for (let i = 0; i < n; i++) { U[i * 2] = ux[i]!; U[i * 2 + 1] = uy[i]!; }
    return U;
  }
}

// ---------------------------------------------------------------- drawing it

const PVERT = `precision highp float;
  in vec2 position; in vec2 rest;
  uniform vec2 uBuf, uOff;
  out vec2 vUv;
  void main() {
    vUv = vec2((rest.x + uOff.x) / uBuf.x, 1.0 - (rest.y + uOff.y) / uBuf.y);
    vec2 q = (position + uOff) / uBuf;
    gl_Position = vec4(q.x * 2.0 - 1.0, 1.0 - q.y * 2.0, 0.0, 1.0);
  }`;
const PFRAG = `precision highp float;
  in vec2 vUv; uniform sampler2D uSrc; layout(location = 0) out vec4 outColor;
  void main() { outColor = texture(uSrc, vUv); }`;

export interface PuppetParams { pins: readonly PuppetPin[]; mesh?: number; id?: string; iterations?: number }

/** Renders layers bent by puppet pins (see the notes at the top). One per Fx. */
export class Puppet {
  private meshes = new Map<string, { m: PuppetMesh; geo: THREE.BufferGeometry }>();
  private read: FSPass | null = null;
  private readRT: THREE.WebGLRenderTarget | null = null;
  private mat: THREE.RawShaderMaterial | null = null;
  private scene = new THREE.Scene();
  private obj: THREE.Mesh | null = null;
  private cam = new THREE.Camera();
  private rt: THREE.WebGLRenderTarget | null = null;

  /** The mesh for this layer: its content's alpha read back once on a step-px grid. */
  private meshFor(r: THREE.WebGLRenderer, src: THREE.Texture, inner: THREE.Vector4, w: number, h: number, p: PuppetParams) {
    const step = Math.max(2, p.mesh ?? 12), key = p.id ?? `${w}x${h}@${step}|${JSON.stringify(p.pins.map((q) => q.at))}`;
    const hit = this.meshes.get(key);
    if (hit) return hit;
    const nx = Math.max(1, Math.ceil(w / step)), ny = Math.max(1, Math.ceil(h / step)), S = 4, RW = nx * S, RH = ny * S;
    this.read ??= new FSPass(`uniform sampler2D src; uniform vec4 rc; void main() { fragColor = texture(src, rc.xy + vUv * rc.zw); }`, { src: { value: null }, rc: { value: new THREE.Vector4() } });
    if (!this.readRT || this.readRT.width !== RW || this.readRT.height !== RH) { this.readRT?.dispose(); this.readRT = new THREE.WebGLRenderTarget(RW, RH, { depthBuffer: false }); }
    // (the cells span nx·step ≥ w: the read covers that much of the content, the rest reads as outside)
    const rc = new THREE.Vector4(inner.x, inner.y + inner.w - inner.w * (ny * step) / h, inner.z * (nx * step) / w, inner.w * (ny * step) / h);
    this.read.u.src!.value = src; (this.read.u.rc!.value as THREE.Vector4).copy(rc);
    const prev = r.getRenderTarget();
    this.read.render(r, this.readRT);
    const px = new Uint8Array(RW * RH * 4);
    r.readRenderTargetPixels(this.readRT, 0, 0, RW, RH, px);
    r.setRenderTarget(prev);
    const alpha = new Float32Array(nx * ny);
    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) {
      const cy = ny - 1 - Math.floor(y / S), cx = Math.floor(x / S), a = px[(y * RW + x) * 4 + 3]! / 255;
      if (a > alpha[cy * nx + cx]!) alpha[cy * nx + cx] = a;
    }
    const m = new PuppetMesh(alpha, nx, ny, step);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m.n * 2), 2));
    geo.setAttribute('rest', new THREE.BufferAttribute(Float32Array.from(m.X), 2));
    geo.setIndex(new THREE.BufferAttribute(m.tris, 1));
    // (2D positions: three cannot size it, and nothing culls it)
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    const rec = { m, geo };
    if (this.meshes.size > 16) { const [k0, v0] = this.meshes.entries().next().value as [string, { geo: THREE.BufferGeometry }]; v0.geo.dispose(); this.meshes.delete(k0); }
    this.meshes.set(key, rec);
    return rec;
  }

  /** Draw `src` (W x H physical, pxs per logical px) bent by the pins (content px) into its own target, returned. */
  render(r: THREE.WebGLRenderer, src: THREE.Texture, W: number, H: number, pxs: number, rect: readonly number[], inner: THREE.Vector4, p: PuppetParams) {
    const { m, geo } = this.meshFor(r, src, inner, rect[2]!, rect[3]!, p);
    const U = m.solve(p.pins, p.iterations ?? 8);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    (pos.array as Float32Array).set(U);
    pos.needsUpdate = true;
    this.mat ??= new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: PVERT, fragmentShader: PFRAG, side: THREE.DoubleSide, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      uniforms: { uBuf: { value: new THREE.Vector2() }, uOff: { value: new THREE.Vector2() }, uSrc: { value: null } },
    });
    if (!this.obj) { this.obj = new THREE.Mesh(geo, this.mat); this.obj.frustumCulled = false; this.scene.add(this.obj); }
    this.obj.geometry = geo;
    (this.mat.uniforms.uBuf!.value as THREE.Vector2).set(W / pxs, H / pxs);
    (this.mat.uniforms.uOff!.value as THREE.Vector2).set(rect[0]!, rect[1]!);
    this.mat.uniforms.uSrc!.value = src;
    if (!this.rt || this.rt.width !== W || this.rt.height !== H) {
      this.rt?.dispose();
      this.rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    }
    const prev = r.getRenderTarget(), ac = r.autoClear, cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    r.setRenderTarget(this.rt); r.setClearColor(0x000000, 0); r.clear(true, false, false);
    r.autoClear = false;
    r.render(this.scene, this.cam);
    r.autoClear = ac; r.setClearColor(cc, ca); r.setRenderTarget(prev);
    return this.rt;
  }

  dispose() { for (const v of this.meshes.values()) v.geo.dispose(); this.mat?.dispose(); this.rt?.dispose(); this.readRT?.dispose(); this.read?.mat.dispose(); }
}

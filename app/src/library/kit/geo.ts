// Geometry helpers for the code-built world: primitives with a per-vertex albedo colour, merged into one mesh per
// material (a street of houses is a handful of draw calls).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type RGB = THREE.Color | string | number;
const C = (c: RGB) => (c instanceof THREE.Color ? c : new THREE.Color(c));

/** A transform from position, Euler rotation (rad) and scale. */
export function T(p: [number, number, number] = [0, 0, 0], r: [number, number, number] = [0, 0, 0], s: [number, number, number] = [1, 1, 1]) {
  return new THREE.Matrix4().compose(new THREE.Vector3(...p), new THREE.Quaternion().setFromEuler(new THREE.Euler(...r, 'YXZ')), new THREE.Vector3(...s));
}

/** Collects coloured geometry and merges it (all parts get position, normal, uv, color; indexed). */
export class Batch {
  parts: THREE.BufferGeometry[] = [];
  /** Material id for the shader's surface pattern (core.ts MAT) for the following add() calls. */
  mat = 0;
  add(g: THREE.BufferGeometry, color: RGB, m?: THREE.Matrix4, mat = this.mat) {
    let geo = g.index ? g : g.setIndex([...Array(g.attributes.position!.count).keys()]);
    geo = geo.clone();
    if (m) geo.applyMatrix4(m);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position!.count * 2), 2));
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
    if (geo.attributes.uv!.itemSize !== 2) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position!.count * 2), 2));
    const c = C(color), n = geo.attributes.position!.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
    geo.setAttribute('aMat', new THREE.BufferAttribute(new Float32Array(n).fill(mat), 1));
    this.parts.push(geo);
    return this;
  }
  box(w: number, h: number, d: number, color: RGB, m?: THREE.Matrix4) { return this.add(new THREE.BoxGeometry(w, h, d), color, m); }
  /** Box standing on y = 0 at (x, z) (centre of the footprint), rotated by ry about its own centre. */
  block(x: number, z: number, w: number, h: number, d: number, color: RGB, y = 0, ry = 0) {
    return this.box(w, h, d, color, T([x, y + h / 2, z], [0, ry, 0]));
  }
  cyl(rTop: number, rBot: number, h: number, color: RGB, m?: THREE.Matrix4, seg = 12) {
    return this.add(new THREE.CylinderGeometry(rTop, rBot, h, seg, 1), color, m);
  }
  plane(w: number, h: number, color: RGB, m?: THREE.Matrix4) { return this.add(new THREE.PlaneGeometry(w, h), color, m); }
  /** Run `f` with material id `m` for its add() calls. */
  with(m: number, f: () => void) { const p = this.mat; this.mat = m; f(); this.mat = p; return this; }
  get empty() { return this.parts.length === 0; }
  mesh(mat: THREE.Material) {
    const g = mergeGeometries(this.parts, false)!;
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    return m;
  }
}

/** Points along a hanging wire between a and b, sagging by `sag` m at the middle (parabola ~ catenary). */
export function catenary(a: THREE.Vector3, b: THREE.Vector3, sag: number, n = 20) {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const p = a.clone().lerp(b, u);
    p.y -= sag * 4 * u * (1 - u);
    pts.push(p);
  }
  return pts;
}

/** Seeded random in [0, 1). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Terrain builders for the non-voxel worlds (docs/TREATMENT.md, 画面语言: each game in its own rendering language,
// blocks as the thread between them).
//
//  lowPolyTerrain   a jittered grid, flat-shaded, one colour per triangle (和平精英: the faceted island).
//  terraceTerrain   the "sand table": a heightfield cut into slabs of thickness dh. The field is linear on every
//                   triangle of the grid, so each slab's outline is an exact straight-edged contour (no stair
//                   steps): flat tops at the slab heights, vertical walls along the contours (三角洲行动).
//  regionMesh       a flat surface at height y over the part of the grid where a test field is >= 0 (water).
import * as THREE from 'three';
import { hash } from './util';

export type HFn = (x: number, z: number) => number;

interface Grid { x0: number; z0: number; x1: number; z1: number; res: number }

function gridVerts(o: Grid, jitter = 0, seed = 1) {
  const nx = o.res, nz = Math.max(1, Math.round((o.res * (o.z1 - o.z0)) / (o.x1 - o.x0)));
  const dx = (o.x1 - o.x0) / nx, dz = (o.z1 - o.z0) / nz;
  const X = new Float32Array((nx + 1) * (nz + 1)), Z = new Float32Array((nx + 1) * (nz + 1));
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
    const edge = i === 0 || j === 0 || i === nx || j === nz, k = j * (nx + 1) + i;
    X[k] = o.x0 + i * dx + (edge ? 0 : (hash(i, j, seed) - 0.5) * jitter * dx);
    Z[k] = o.z0 + j * dz + (edge ? 0 : (hash(j, i, seed + 1) - 0.5) * jitter * dz);
  }
  /** The two triangles of cell (i, j) as vertex indices (diagonal alternates for an even facet pattern). */
  const tris = (i: number, j: number): [number, number, number][] => {
    const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
    return (i + j) & 1 ? [[a, c, b], [b, c, d]] : [[a, c, d], [a, d, b]];
  };
  return { nx, nz, X, Z, tris };
}

/** Low-poly terrain: flat shaded, `color(x, y, z, slope)` per triangle (slope 0 = flat, 1 = vertical). */
export function lowPolyTerrain(o: Grid & { h: HFn; color: (x: number, y: number, z: number, slope: number) => THREE.Color; jitter?: number; seed?: number }) {
  const g = gridVerts(o, o.jitter ?? 0.7, o.seed ?? 1);
  const Y = new Float32Array(g.X.length);
  for (let k = 0; k < Y.length; k++) Y[k] = o.h(g.X[k]!, g.Z[k]!);
  const pos: number[] = [], col: number[] = [];
  const A = new THREE.Vector3(), B = new THREE.Vector3(), Cc = new THREE.Vector3(), n = new THREE.Vector3();
  for (let j = 0; j < g.nz; j++) for (let i = 0; i < g.nx; i++) for (const t of g.tris(i, j)) {
    A.set(g.X[t[0]]!, Y[t[0]]!, g.Z[t[0]]!); B.set(g.X[t[1]]!, Y[t[1]]!, g.Z[t[1]]!); Cc.set(g.X[t[2]]!, Y[t[2]]!, g.Z[t[2]]!);
    n.subVectors(B, A).cross(Cc.clone().sub(A)).normalize();
    if (n.y < 0) { n.negate(); pos.push(A.x, A.y, A.z, Cc.x, Cc.y, Cc.z, B.x, B.y, B.z); } else pos.push(A.x, A.y, A.z, B.x, B.y, B.z, Cc.x, Cc.y, Cc.z);
    const c = o.color((A.x + B.x + Cc.x) / 3, (A.y + B.y + Cc.y) / 3, (A.z + B.z + Cc.z) / 3, 1 - n.y);
    for (let v = 0; v < 3; v++) col.push(c.r, c.g, c.b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals(); // non-indexed: one normal per triangle (flat)
  return geo;
}

type PV = { x: number; z: number; f: number };
/** Sutherland–Hodgman: keep the part of a convex polygon where (f - c) * sgn >= 0 (f linear along the edges). */
function clip(poly: PV[], c: number, sgn: 1 | -1): PV[] {
  const out: PV[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const da = (a.f - c) * sgn, db = (b.f - c) * sgn;
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) { const u = da / (da - db); out.push({ x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, f: c }); }
  }
  return out;
}

/**
 * The sand table. Slab k holds the ground where k*dh <= h < (k+1)*dh, its top at y = k*dh*vy + y0. `top(k, x, z)` and
 * `wall(k, x, z)` colour a slab's top and the wall rising to it. Returns one geometry (vertex colours, explicit
 * normals). `keep(x, z)` (optional) drops triangles outside the table.
 */
export function terraceTerrain(o: Grid & { h: HFn; dh: number; vy?: number; y0?: number; top: (k: number, x: number, z: number) => THREE.Color; wall: (k: number, x: number, z: number) => THREE.Color; kMin?: number }) {
  const g = gridVerts(o, 0);
  const F = new Float32Array(g.X.length);
  for (let k = 0; k < F.length; k++) F[k] = o.h(g.X[k]!, g.Z[k]!);
  const vy = o.vy ?? 1, y0 = o.y0 ?? 0, kMin = o.kMin ?? -1e9, dh = o.dh;
  const Y = (k: number) => y0 + Math.max(k, kMin) * dh * vy;
  const pos: number[] = [], nor: number[] = [], col: number[] = [];
  const pushTri = (a: number[], b: number[], c: number[], n: number[], cl: THREE.Color) => {
    pos.push(...a, ...b, ...c); for (let v = 0; v < 3; v++) { nor.push(...n); col.push(cl.r, cl.g, cl.b); }
  };
  for (let j = 0; j < g.nz; j++) for (let i = 0; i < g.nx; i++) for (const t of g.tris(i, j)) {
    const tri: PV[] = t.map((k) => ({ x: g.X[k]!, z: g.Z[k]!, f: F[k]! }));
    const fmin = Math.min(tri[0]!.f, tri[1]!.f, tri[2]!.f), fmax = Math.max(tri[0]!.f, tri[1]!.f, tri[2]!.f);
    const k0 = Math.max(Math.floor(fmin / dh), kMin), k1 = Math.max(Math.floor(fmax / dh), kMin);
    // winding so that tops face up: triangles come as (a, c, ...) with z increasing -> check sign
    for (let k = k0; k <= k1; k++) {
      let p = tri;
      if (k > kMin) p = clip(p, k * dh, 1);
      p = clip(p, (k + 1) * dh, -1);
      if (p.length < 3) continue;
      const cx = p.reduce((s, v) => s + v.x, 0) / p.length, cz = p.reduce((s, v) => s + v.z, 0) / p.length;
      const cl = o.top(k, cx, cz), y = Y(k);
      for (let v = 1; v + 1 < p.length; v++) {
        const a = p[0]!, b = p[v]!, c = p[v + 1]!;
        // up-facing: (b - a) x (c - a) must have +y
        const cr = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
        if (cr >= 0) pushTri([a.x, y, a.z], [b.x, y, b.z], [c.x, y, c.z], [0, 1, 0], cl);
        else pushTri([a.x, y, a.z], [c.x, y, c.z], [b.x, y, b.z], [0, 1, 0], cl);
      }
    }
    // walls along each contour level crossing this triangle
    for (let k = Math.max(k0 + 1, kMin + 1); k <= k1; k++) {
      const L = k * dh, pts: PV[] = [];
      for (let e = 0; e < 3; e++) {
        const a = tri[e]!, b = tri[(e + 1) % 3]!;
        if ((a.f >= L) !== (b.f >= L)) { const u = (L - a.f) / (b.f - a.f); pts.push({ x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u, f: L }); }
      }
      if (pts.length !== 2) continue;
      // outward (downhill) direction: -grad f of the linear triangle
      const [A, B, C] = tri as [PV, PV, PV];
      const e1x = B.x - A.x, e1z = B.z - A.z, e2x = C.x - A.x, e2z = C.z - A.z, df1 = B.f - A.f, df2 = C.f - A.f;
      const det = e1x * e2z - e2x * e1z;
      if (Math.abs(det) < 1e-12) continue;
      const gx = (df1 * e2z - df2 * e1z) / det, gz = (e1x * df2 - e2x * df1) / det;
      const gl = Math.hypot(gx, gz) || 1, nx = -gx / gl, nz = -gz / gl;
      let [P, Q] = pts as [PV, PV];
      const dx = Q.x - P.x, dz = Q.z - P.z;
      if (-dz * nx + dx * nz < 0) [P, Q] = [Q, P];
      const ylo = Y(k - 1), yhi = Y(k), cl = o.wall(k, (P.x + Q.x) / 2, (P.z + Q.z) / 2), n = [nx, 0, nz];
      pushTri([P.x, ylo, P.z], [Q.x, ylo, Q.z], [Q.x, yhi, Q.z], n, cl);
      pushTri([P.x, ylo, P.z], [Q.x, yhi, Q.z], [P.x, yhi, P.z], n, cl);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return geo;
}

/** A flat surface at height y where test(x, z) >= 0 (contour-exact edges on the grid). */
export function regionMesh(o: Grid & { test: HFn; y: number }) {
  const g = gridVerts(o, 0);
  const F = new Float32Array(g.X.length);
  for (let k = 0; k < F.length; k++) F[k] = o.test(g.X[k]!, g.Z[k]!);
  const pos: number[] = [];
  for (let j = 0; j < g.nz; j++) for (let i = 0; i < g.nx; i++) for (const t of g.tris(i, j)) {
    const p = clip(t.map((k) => ({ x: g.X[k]!, z: g.Z[k]!, f: F[k]! })), 0, 1);
    for (let v = 1; v + 1 < p.length; v++) {
      const a = p[0]!, b = p[v]!, c = p[v + 1]!;
      const cr = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
      if (cr >= 0) pos.push(a.x, o.y, a.z, b.x, o.y, b.z, c.x, o.y, c.z); else pos.push(a.x, o.y, a.z, c.x, o.y, c.z, b.x, o.y, b.z);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

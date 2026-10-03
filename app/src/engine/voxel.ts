// Voxels: every world of the video is rebuilt from blocks (docs/TREATMENT.md, 方块重建).
//
//  VoxelGrid     a dense grid (palette indices) filled with boxes / shapes in metres or voxel coordinates.
//  buildVoxels   the grid's exposed voxels as ONE InstancedMesh: per-voxel colour (palette + seeded jitter),
//                Minecraft-style smooth ambient occlusion baked per face corner (the classic "voxel AO": side1,
//                side2, corner -> 0..3, packed 2 bits per corner into 3 floats), and a GPU animation per voxel
//                driven by song time (uTime): assemble in (fly from an offset, pop, overshoot) and fly out
//                (velocity + gravity + tumble, shrink). Everything is a pure function of time: export-safe.
//  The same shader patch is applied to the shadow depth material, so voxels in flight cast correct shadows.
import * as THREE from 'three';
import { hash } from './util';

export type V3 = [number, number, number];

/** A palette entry: base colour (sRGB hex) and per-voxel brightness jitter (0..1). Index 0 = empty. */
export interface PalEntry { hex: number; jitter?: number; emissive?: number }

export class VoxelGrid {
  data: Uint16Array;
  constructor(public size: number, public origin: V3, public nx: number, public ny: number, public nz: number) {
    this.data = new Uint16Array(nx * ny * nz);
  }
  /** Grid covering a box in metres [min, max) at voxel size `size`. */
  static cover(size: number, min: V3, max: V3) {
    return new VoxelGrid(size, min, Math.ceil((max[0] - min[0]) / size), Math.ceil((max[1] - min[1]) / size), Math.ceil((max[2] - min[2]) / size));
  }
  idx(x: number, y: number, z: number) { return (y * this.nz + z) * this.nx + x; }
  inside(x: number, y: number, z: number) { return x >= 0 && y >= 0 && z >= 0 && x < this.nx && y < this.ny && z < this.nz; }
  get(x: number, y: number, z: number) { return this.inside(x, y, z) ? this.data[this.idx(x, y, z)]! : 0; }
  set(x: number, y: number, z: number, c: number) { if (this.inside(x, y, z)) this.data[this.idx(x, y, z)] = c; }
  /** Voxel coordinate of a metre coordinate on an axis. */
  vx(m: number) { return Math.floor((m - this.origin[0]) / this.size + 1e-6); }
  vy(m: number) { return Math.floor((m - this.origin[1]) / this.size + 1e-6); }
  vz(m: number) { return Math.floor((m - this.origin[2]) / this.size + 1e-6); }
  /** Centre (metres) of voxel (x, y, z). */
  centre(x: number, y: number, z: number): V3 {
    const s = this.size;
    return [this.origin[0] + (x + 0.5) * s, this.origin[1] + (y + 0.5) * s, this.origin[2] + (z + 0.5) * s];
  }
  /** Fill voxels whose centres lie in the metre box [x0,x1) x [y0,y1) x [z0,z1) (corners in any order). c may depend on the voxel. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: number | ((x: number, y: number, z: number) => number)) {
    const [ax, bx] = x0 < x1 ? [x0, x1] : [x1, x0], [ay, by] = y0 < y1 ? [y0, y1] : [y1, y0], [az, bz] = z0 < z1 ? [z0, z1] : [z1, z0];
    const s = this.size;
    const i0 = Math.max(0, Math.round((ax - this.origin[0]) / s)), i1 = Math.min(this.nx, Math.round((bx - this.origin[0]) / s));
    const j0 = Math.max(0, Math.round((ay - this.origin[1]) / s)), j1 = Math.min(this.ny, Math.round((by - this.origin[1]) / s));
    const k0 = Math.max(0, Math.round((az - this.origin[2]) / s)), k1 = Math.min(this.nz, Math.round((bz - this.origin[2]) / s));
    for (let y = j0; y < j1; y++) for (let z = k0; z < k1; z++) for (let x = i0; x < i1; x++) {
      const v = typeof c === 'number' ? c : c(x, y, z);
      this.data[this.idx(x, y, z)] = v;
    }
  }
  /** Fill voxels whose centre satisfies inside(pMetres). */
  shape(min: V3, max: V3, inside: (p: V3, x: number, y: number, z: number) => number) {
    const i0 = Math.max(0, this.vx(min[0])), i1 = Math.min(this.nx - 1, this.vx(max[0]));
    const j0 = Math.max(0, this.vy(min[1])), j1 = Math.min(this.ny - 1, this.vy(max[1]));
    const k0 = Math.max(0, this.vz(min[2])), k1 = Math.min(this.nz - 1, this.vz(max[2]));
    for (let y = j0; y <= j1; y++) for (let z = k0; z <= k1; z++) for (let x = i0; x <= i1; x++) {
      const v = inside(this.centre(x, y, z), x, y, z);
      if (v >= 0) this.data[this.idx(x, y, z)] = v;
    }
  }
}

/** Per-voxel animation. Times are song seconds. */
export interface VoxAnim {
  /** Assemble in at tIn over durIn, flying from `from` (metres, relative to its place). Omit tIn: always there. */
  tIn?: number; durIn?: number; from?: V3;
  /** Fly out at tOut: velocity (m/s) + gravity, tumbling, shrinking to nothing over durOut. */
  tOut?: number; durOut?: number; vel?: V3; spin?: number;
}

export interface VoxelMeshOpts {
  /** Unlit colours (lamps, glowing letters): colour values > 1 bloom. No AO. */
  unlit?: boolean;
  roughness?: number;
  /** Darkest AO level (MC uses ~0.5). */
  aoMin?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
  seed?: number;
  /** World y of the floor flying-out voxels land on (default: none). */
  floor?: number;
  /** Edge darkening of each block face (0 = none). */
  bevel?: number;
  /**
   * Engraved look (pdoom's copper-plate language): the lit colour is turned into world-space hatching — bone lines on
   * ink, thicker where brighter (walls: horizontal courses, floors: diagonal); colours that read as signal red stay
   * signal. `spacing` = line period in metres. `grid: false` (small things: figures, props) hatches the tops too
   * (diagonally) instead of drawing the floor grid, which would leave a small top blank.
   */
  engrave?: { spacing: number; gain?: number; ink: [number, number, number]; bone: [number, number, number]; signal: [number, number, number]; redLight?: boolean; grid?: boolean };
}

/** Defaults merged into every buildVoxels call (a scene can switch the whole voxel look, soldiers included). */
export const voxelDefaults: Partial<VoxelMeshOpts> = {};

const FACES = [
  { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] }, { n: [-1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] }, { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, { n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0] },
] as const;

/** Shader patch: AO decode + the per-voxel animation (shared by the colour and the depth materials). */
function patchVertex(shader: { vertexShader: string; uniforms: Record<string, THREE.IUniform> }, uTime: THREE.IUniform<number>, withAO: boolean, uFloor: THREE.IUniform<number>, size: number) {
  shader.uniforms.uTime = uTime;
  shader.uniforms.uFloor = uFloor;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>
      uniform float uTime; uniform float uFloor;
      attribute vec3 aAO; attribute vec4 aIn; attribute vec4 aOut; attribute vec3 aVel;
      ${withAO ? 'varying float vAO; varying vec3 vLoc; varying vec3 vNrm;' : ''}
      vec3 vRot(vec3 p, vec3 k, float a) { float c = cos(a), s = sin(a); return p * c + cross(k, p) * s + k * dot(k, p) * (1.0 - c); }
      float vScale; vec3 vOff; vec3 vAxis; float vAng;
      void voxAnim() {
        // aIn = (t0, dur, from.x, from.z); aOut = (t1, dur1, spin seed, from.y); aVel = out velocity
        float t0 = aIn.x, dur = max(aIn.y, 1e-3);
        float p = clamp((uTime - t0) / dur, 0.0, 1.0);
        float q = p - 1.0;
        float e = 1.0 + 2.70158 * q * q * q + 1.70158 * q * q; // outBack
        vScale = uTime < t0 ? 0.0 : smoothstep(0.0, 0.22, p);
        vOff = vec3(aIn.z, aOut.w, aIn.w) * (1.0 - e);
        vAxis = vec3(0.0, 1.0, 0.0); vAng = 0.0;
        float to = uTime - aOut.x;
        if (to > 0.0) {
          vOff += aVel * to + vec3(0.0, -9.8, 0.0) * 0.5 * to * to;
          // land on the floor instead of falling through it (and skid)
          float iy = instanceMatrix[3].y, lo = uFloor + ${(size / 2).toFixed(4)} - iy;
          if (vOff.y < lo) { vOff.y = lo; vOff.xz *= 0.9; }
          vScale *= 1.0 - smoothstep(0.0, max(aOut.y, 1e-3), to);
          vAxis = normalize(vec3(sin(aOut.z * 12.9898), cos(aOut.z * 78.233), sin(aOut.z * 37.719) + 0.3));
          vAng = to * (4.0 + 6.0 * fract(aOut.z * 3.17)) * sign(fract(aOut.z * 7.1) - 0.5);
        }
      }`)
    .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
      voxAnim();
      objectNormal = vRot(objectNormal, vAxis, vAng);`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      ${withAO ? `
      {
        vec3 an = abs(normal);
        int f = an.x > 0.5 ? (normal.x > 0.0 ? 0 : 1) : an.y > 0.5 ? (normal.y > 0.0 ? 2 : 3) : (normal.z > 0.0 ? 4 : 5);
        vec2 uv2 = f < 2 ? position.yz : (f < 4 ? position.xz : position.xy);
        int c = (uv2.x > 0.0 ? 1 : 0) + (uv2.y > 0.0 ? 2 : 0);
        float packed = f < 2 ? aAO.x : (f < 4 ? aAO.y : aAO.z);
        float sh = float((f - (f / 2) * 2) * 8 + c * 2);
        vAO = mod(floor(packed / exp2(sh) + 0.001), 4.0) / 3.0;
        vLoc = position / ${size.toFixed(5)}; vNrm = normal;
      }` : 'voxAnim();'}
      transformed = vRot(transformed, vAxis, vAng) * vScale + vOff;`);
}

/**
 * The grid's exposed voxels as an InstancedMesh (see file header). `anim(x, y, z, centre, palIndex)` may return the
 * voxel's animation (or null: always there). Returns the mesh; set `mesh.userData.uTime.value = songTime` each frame
 * (or use `setVoxelTime`).
 */
export function buildVoxels(grid: VoxelGrid, pal: PalEntry[], anim: ((x: number, y: number, z: number, c: V3, p: number) => VoxAnim | null) | null, o0: VoxelMeshOpts = {}) {
  const o: VoxelMeshOpts = { ...voxelDefaults, ...o0 };
  const s = grid.size;
  const occ = (x: number, y: number, z: number) => grid.get(x, y, z) !== 0 ? 1 : 0;
  // collect exposed voxels
  const list: number[] = [];
  for (let y = 0; y < grid.ny; y++) for (let z = 0; z < grid.nz; z++) for (let x = 0; x < grid.nx; x++) {
    if (!grid.data[grid.idx(x, y, z)]) continue;
    if (occ(x + 1, y, z) && occ(x - 1, y, z) && occ(x, y + 1, z) && occ(x, y - 1, z) && occ(x, y, z + 1) && occ(x, y, z - 1)) continue;
    list.push(x, y, z);
  }
  const n = list.length / 3;
  const geo = new THREE.BoxGeometry(s, s, s);
  const aAO = new Float32Array(n * 3), aIn = new Float32Array(n * 4), aOut = new Float32Array(n * 4), aVel = new Float32Array(n * 3);
  const mat: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial = o.unlit ? new THREE.MeshBasicMaterial() : new THREE.MeshStandardMaterial({ roughness: o.roughness ?? 0.9, metalness: 0 });
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  const m4 = new THREE.Matrix4(), col = new THREE.Color();
  const seed = o.seed ?? 1;
  const emissiveList: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = list[i * 3]!, y = list[i * 3 + 1]!, z = list[i * 3 + 2]!;
    const p = grid.get(x, y, z), e = pal[p]!;
    const c = grid.centre(x, y, z);
    m4.makeTranslation(c[0], c[1], c[2]);
    mesh.setMatrixAt(i, m4);
    const j = (hash(x, y, z, seed) - 0.5) * 2 * (e.jitter ?? 0.06);
    col.setHex(e.hex).multiplyScalar(1 + j);
    if (e.emissive) { col.multiplyScalar(e.emissive); emissiveList.push(i); }
    mesh.setColorAt(i, col);
    // AO per face corner
    const packs = [0, 0, 0];
    FACES.forEach((F, f) => {
      const qx = x + F.n[0], qy = y + F.n[1], qz = z + F.n[2];
      for (let cI = 0; cI < 4; cI++) {
        const su = cI & 1 ? 1 : -1, sv = cI & 2 ? 1 : -1;
        const s1 = occ(qx + su * F.u[0], qy + su * F.u[1], qz + su * F.u[2]);
        const s2 = occ(qx + sv * F.v[0], qy + sv * F.v[1], qz + sv * F.v[2]);
        const cc = occ(qx + su * F.u[0] + sv * F.v[0], qy + su * F.u[1] + sv * F.v[1], qz + su * F.u[2] + sv * F.v[2]);
        const ao = s1 && s2 ? 0 : 3 - (s1 + s2 + cc);
        packs[f >> 1]! += ao * Math.pow(2, (f & 1) * 8 + cI * 2);
      }
    });
    aAO.set(packs, i * 3);
    const a = anim ? anim(x, y, z, c, p) : null;
    const from = a?.from ?? [0, 0, 0];
    aIn.set([a?.tIn ?? -1e6, a?.durIn ?? 0.3, from[0], from[2]], i * 4);
    aOut.set([a?.tOut ?? 1e6, a?.durOut ?? 0.6, a?.spin ?? hash(x, z, y, seed + 3), from[1]], i * 4);
    aVel.set(a?.vel ?? [0, 0, 0], i * 3);
  }
  geo.setAttribute('aAO', new THREE.InstancedBufferAttribute(aAO, 3));
  geo.setAttribute('aIn', new THREE.InstancedBufferAttribute(aIn, 4));
  geo.setAttribute('aOut', new THREE.InstancedBufferAttribute(aOut, 4));
  geo.setAttribute('aVel', new THREE.InstancedBufferAttribute(aVel, 3));
  const uTime: THREE.IUniform<number> = { value: 0 };
  const aoMin = o.aoMin ?? 0.42;
  const uFloor: THREE.IUniform<number> = { value: o.floor ?? -1e6 };
  const E = o.engrave, v3 = (c: [number, number, number]) => `vec3(${c.map((x) => x.toFixed(4)).join(',')})`;
  mat.onBeforeCompile = o.unlit ? (sh) => patchVertex(sh as any, uTime, false, uFloor, s) : (sh) => {
    patchVertex(sh as any, uTime, true, uFloor, s);
    if (E) {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWP; varying vec3 vWN;')
        .replace('#include <project_vertex>', `vWP = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
          vWN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
          #include <project_vertex>`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWP; varying vec3 vWN;')
        .replace('#include <opaque_fragment>', `#include <opaque_fragment>
          {
            float L = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
            // lines lit mostly by red light (a signal-red lamp) are cut in the signal
            float redL = ${E.redLight ? 'smoothstep(0.45, 0.8, (gl_FragColor.r - max(gl_FragColor.g, gl_FragColor.b)) / max(gl_FragColor.r, 1e-3))' : '0.0'};
            vec3 lineCol = mix(${v3(E.bone)}, ${v3(E.signal)} * 0.75, redL);
            vec3 an = abs(vWN), col;
            if (${E.grid === false ? 'false' : 'an.y > 0.6'}) {
              // floors: a hairline grid on the slab module (pdoom's grid floors), brighter where lit
              vec2 q = vWP.xz / ${(E.spacing * 4.5).toFixed(4)};
              vec2 gd = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), vec2(1e-4));
              float line = 1.0 - min(min(gd.x, gd.y) / 0.9, 1.0);
              line *= 1.0 - smoothstep(0.15, 0.45, max(fwidth(q).x, fwidth(q).y));
              col = ${v3(E.ink)} + lineCol * line * clamp(0.1 + L * ${(E.gain ?? 1).toFixed(3)} * 0.9, 0.0, 0.85);
            } else {
              // walls: horizontal courses, thicker where brighter (the engraver's tone)
              float coord = (an.y > 0.6 ? (vWP.x + vWP.z) * 0.7071 : vWP.y) / ${E.spacing.toFixed(4)};
              float hw = 0.5 * clamp(pow(max(L, 0.0) * ${(E.gain ?? 1).toFixed(3)}, 1.35), 0.0, 0.6);
              float d = abs(fract(coord) - 0.5), aa = fwidth(coord) * 0.9;
              float line = 1.0 - smoothstep(hw - aa, hw + aa, d);
              line = mix(line, hw * 2.0, smoothstep(0.22, 0.5, aa)); // too dense to resolve: the average tone
              col = ${v3(E.ink)} + lineCol * line * (0.55 + 0.45 * clamp(L, 0.0, 1.0));
            }
            if (engBase.r > 0.3 && engBase.g < 0.1 && engBase.b < 0.1) col = ${v3(E.signal)} * (0.55 + 0.9 * clamp(L, 0.0, 1.0));
            gl_FragColor.rgb = col;
          }`);
    }
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAO; varying vec3 vLoc; varying vec3 vNrm;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 engBase = diffuseColor.rgb;
        diffuseColor.rgb *= mix(${aoMin.toFixed(3)}, 1.0, vAO * vAO * 0.35 + vAO * 0.65);
        // block edges: a thin darker bevel on every face reads each block as a crafted piece
        vec3 an = abs(vNrm); vec2 fc = an.x > 0.5 ? vLoc.yz : (an.y > 0.5 ? vLoc.xz : vLoc.xy);
        float ed = max(abs(fc.x), abs(fc.y));
        diffuseColor.rgb *= 1.0 - ${(E ? 0 : o.bevel ?? 0.14).toFixed(3)} * smoothstep(0.40, 0.5, ed);`);
  };
  mat.customProgramCacheKey = () => `vox-${o.unlit ? 'unlit' : aoMin}-${s}-${o.bevel ?? 0.14}-${E ? JSON.stringify(E) : ''}`;
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (sh) => patchVertex(sh as any, uTime, false, uFloor, s);
  depth.customProgramCacheKey = () => `vox-depth-${s}`;
  mesh.customDepthMaterial = depth;
  // the outline pre-pass material (world.ts Outline): normals, with the same per-voxel animation
  const nmat = new THREE.MeshNormalMaterial();
  nmat.onBeforeCompile = (sh) => patchVertex(sh as any, uTime, false, uFloor, s);
  nmat.customProgramCacheKey = () => `vox-normal-${s}`;
  mesh.userData.normalMat = nmat;
  mesh.castShadow = o.castShadow ?? true;
  mesh.receiveShadow = o.receiveShadow ?? true;
  mesh.frustumCulled = false;
  mesh.userData.uTime = uTime;
  mesh.userData.uFloor = uFloor;
  mesh.userData.count = n;
  return mesh;
}

/** Set the song time on every voxel mesh under `root`. */
export function setVoxelTime(root: THREE.Object3D, t: number) {
  root.traverse((o) => { const u = o.userData?.uTime as THREE.IUniform<number> | undefined; if (u) u.value = t; });
}

/**
 * Rasterize text into a thin voxel slab lying on a wall plane: returns voxel cells (u right, v up) of the glyphs,
 * `px` voxels per em. Used to emboss lyric words into walls.
 */
export function textCells(text: string, fontCss: string, px: number): { u: number; v: number }[] {
  const cv = document.createElement('canvas');
  const c = cv.getContext('2d', { willReadFrequently: true })!;
  c.font = fontCss.replace(/\d+px/, `${px}px`);
  const w = Math.ceil(c.measureText(text).width) + 4, h = Math.ceil(px * 1.3);
  cv.width = w; cv.height = h;
  c.font = fontCss.replace(/\d+px/, `${px}px`);
  c.fillStyle = '#fff'; c.textBaseline = 'alphabetic';
  c.fillText(text, 2, Math.round(px * 1.0));
  const d = c.getImageData(0, 0, w, h).data, out: { u: number; v: number }[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3]! > 110) out.push({ u: x, v: h - 1 - y });
  return out;
}

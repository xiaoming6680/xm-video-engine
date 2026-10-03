// 3D toolkit shared by the game-world scenes: time-keyed camera paths with continuous velocity (the "one long
// take" of docs/TREATMENT.md depends on it: a camera must leave one world at the speed the next one picks up),
// seeded procedural canvas textures, and a standard render into the engine's HDR target.
import * as THREE from 'three';
import { clamp, ease, lerp, mulberry32 } from './util';

// ------------------------------------------------------------------ camera paths
export type V3 = [number, number, number];

export interface CamKey {
  /** Song time (s). */
  t: number;
  p: V3;
  /** Look-at target. */
  at: V3;
  /** Roll (rad, positive = clockwise on screen). */
  roll?: number;
  /** Vertical field of view (deg). */
  fov?: number;
  /** Zero velocity at this key (a hold / a hard stop before a move). */
  stop?: boolean;
}

export interface CamPose { p: THREE.Vector3; at: THREE.Vector3; roll: number; fov: number }

/**
 * Time-parameterized cubic Hermite through the keys: the tangent at key i is (x[i+1] - x[i-1]) / (t[i+1] - t[i-1])
 * (zero at `stop` keys and at the ends), so position, target, roll and fov are C1 in TIME — the camera never
 * jumps in speed at a key. Before the first / after the last key the path continues with the end velocity when
 * `extrapolate` is set (so a camera can keep flying through a handover), else it holds.
 */
export class CamPath {
  private k: CamKey[];
  constructor(keys: CamKey[], private extrapolate = false) {
    this.k = [...keys].sort((a, b) => a.t - b.t);
  }
  private chan(i: number, f: (k: CamKey) => number): [number, number] {
    const k = this.k, n = k.length, x = f(k[i]!);
    if (k[i]!.stop || n < 2) return [x, 0];
    const a = k[Math.max(0, i - 1)]!, b = k[Math.min(n - 1, i + 1)]!;
    if (a === b) return [x, 0];
    // ends: one-sided difference (keeps the speed through a handover instead of easing to a stop)
    return [x, (f(b) - f(a)) / (b.t - a.t)];
  }
  private scalar(t: number, f: (k: CamKey) => number): number {
    const k = this.k, n = k.length;
    if (n === 1) return f(k[0]!);
    if (t <= k[0]!.t) { const [x, v] = this.chan(0, f); return this.extrapolate ? x + v * (t - k[0]!.t) : x; }
    if (t >= k[n - 1]!.t) { const [x, v] = this.chan(n - 1, f); return this.extrapolate ? x + v * (t - k[n - 1]!.t) : x; }
    let i = 0;
    while (i < n - 2 && t > k[i + 1]!.t) i++;
    const [x0, v0] = this.chan(i, f), [x1, v1] = this.chan(i + 1, f);
    const h = k[i + 1]!.t - k[i]!.t, u = (t - k[i]!.t) / h;
    const u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * x0 + (u3 - 2 * u2 + u) * h * v0 + (-2 * u3 + 3 * u2) * x1 + (u3 - u2) * h * v1;
  }
  at(t: number): CamPose {
    const s = (f: (k: CamKey) => number) => this.scalar(t, f);
    return {
      p: new THREE.Vector3(s((k) => k.p[0]), s((k) => k.p[1]), s((k) => k.p[2])),
      at: new THREE.Vector3(s((k) => k.at[0]), s((k) => k.at[1]), s((k) => k.at[2])),
      roll: s((k) => k.roll ?? 0),
      fov: s((k) => k.fov ?? 50),
    };
  }
  /** World-space velocity of the camera position at t (finite difference). */
  velocity(t: number, h = 1 / 240) { return this.at(t + h).p.sub(this.at(t - h).p).multiplyScalar(1 / (2 * h)); }
}

/** Point a camera: position, look-at, roll about the view axis, fov; `up` is world +Y. */
export function setCam(cam: THREE.PerspectiveCamera, pose: CamPose, shake: V3 = [0, 0, 0]) {
  cam.position.copy(pose.p);
  cam.up.set(0, 1, 0);
  cam.lookAt(pose.at);
  if (pose.roll) cam.rotateZ(-pose.roll);
  if (shake[0] || shake[1] || shake[2]) { cam.rotateY(shake[0]); cam.rotateX(shake[1]); cam.rotateZ(shake[2]); }
  if (cam.fov !== pose.fov) { cam.fov = pose.fov; cam.updateProjectionMatrix(); }
  cam.updateMatrixWorld(true);
}

/** Handheld drift: smooth pseudo-random yaw/pitch/roll (rad) from time, amplitude `amp`, rate `hz`. */
export function handheld(t: number, amp = 0.004, hz = 0.35, seed = 1): V3 {
  const n = (s: number) => Math.sin(t * hz * 6.283 * (1 + 0.13 * s) + s * 1.7) * 0.6 + Math.sin(t * hz * 6.283 * (2.31 + 0.07 * s) + s * 4.1) * 0.4;
  return [n(seed) * amp, n(seed + 3) * amp * 0.7, n(seed + 7) * amp * 0.4];
}

// ------------------------------------------------------------------ rendering
export function setupRenderer(r: THREE.WebGLRenderer) {
  if (!r.shadowMap.enabled) {
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap; // (r186: PCFSoft was folded into PCF; soften with light.shadow.radius)
  }
}

/** Render a scene into the engine's HDR target (linear, no tone mapping: post does that). */
export function renderInto(r: THREE.WebGLRenderer, scene: THREE.Scene, cam: THREE.Camera, out: THREE.WebGLRenderTarget, clear: THREE.Color | null = new THREE.Color(0, 0, 0)) {
  r.setRenderTarget(out);
  if (clear) { r.setClearColor(clear, 1); r.clear(true, true, true); }
  r.render(scene, cam);
}

/** Project a world point to frame UV (0..1, y up) with the camera; z > 1 = behind. */
export function toUV(p: THREE.Vector3, cam: THREE.Camera) {
  const v = p.clone().project(cam);
  return { x: v.x * 0.5 + 0.5, y: v.y * 0.5 + 0.5, z: v.z };
}

// ------------------------------------------------------------------ procedural textures
/**
 * A canvas texture drawn once by `draw(ctx, w, h, rnd)` with a seeded random. sRGB colour data by default
 * (pass srgb=false for roughness / normal / height data).
 */
export function canvasTex(w: number, h: number, draw: (c: CanvasRenderingContext2D, w: number, h: number, rnd: () => number) => void,
  o: { srgb?: boolean; repeat?: [number, number]; seed?: number; nearest?: boolean; aniso?: number } = {}) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d', { willReadFrequently: true })!;
  draw(c, w, h, mulberry32(o.seed ?? 1));
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = o.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  if (o.repeat) tex.repeat.set(o.repeat[0], o.repeat[1]);
  if (o.nearest) { tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestMipmapNearestFilter; }
  tex.anisotropy = o.aniso ?? 8;
  tex.needsUpdate = true;
  return tex;
}

/** Tileable value noise on a canvas grid (periodic in `period` cells): returns f(x, y) in 0..1 for x, y in 0..1. */
export function tileNoise(period: number, rnd: () => number) {
  const g = Array.from({ length: period * period }, () => rnd());
  const at = (i: number, j: number) => g[((j % period) + period) % period * period + (((i % period) + period) % period)]!;
  const sm = (x: number) => x * x * (3 - 2 * x);
  return (x: number, y: number) => {
    const fx = x * period, fy = y * period, i = Math.floor(fx), j = Math.floor(fy), u = sm(fx - i), v = sm(fy - j);
    return lerp(lerp(at(i, j), at(i + 1, j), u), lerp(at(i, j + 1), at(i + 1, j + 1), u), v);
  };
}

/** Fractal tileable noise (octaves of tileNoise with doubling periods). */
export function tileFbm(base: number, octaves: number, rnd: () => number) {
  const ns = Array.from({ length: octaves }, (_, i) => tileNoise(base << i, rnd));
  return (x: number, y: number) => {
    let s = 0, a = 0.5, n = 0;
    for (const f of ns) { s += a * f(x, y); n += a; a *= 0.5; }
    return s / n;
  };
}

/** Fill a canvas pixel by pixel: f(u, v) -> [r, g, b] (0..255). */
export function paintPixels(c: CanvasRenderingContext2D, w: number, h: number, f: (u: number, v: number, x: number, y: number) => [number, number, number]) {
  const img = c.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = f(x / w, y / h, x, y), o = (y * w + x) * 4;
    img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
  }
  c.putImageData(img, 0, 0);
}

// ------------------------------------------------------------------ beat helpers
/** 0..1 impulse envelope after an event at t0: fast attack (a s), exponential decay with half-life hl. */
export const hitEnv = (t: number, t0: number, hl = 0.1, a = 0.012) =>
  t < t0 ? 0 : t < t0 + a ? (t - t0) / a : Math.pow(0.5, (t - t0 - a) / hl);

/** Eased progress through [a, b] with a named easing. */
export const through = (t: number, a: number, b: number, e: keyof typeof ease = 'inOutCubic') => ease[e](clamp((t - a) / (b - a)));

// ------------------------------------------------------------------ ambient occlusion + environment
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { makeRT, W as LW, H as LH, SCALE } from './gl';

/**
 * Renders a scene with ground-truth ambient occlusion (three's GTAOPass: normal/depth pre-pass, GTAO, Poisson
 * denoise, multiplied into the lit frame). Contact shadows in corners, under objects and in gaps are most of what
 * makes a CG room read as a space. The lit frame keeps its alpha (portal holes survive).
 */
export class AORender {
  private lit = makeRT();
  pass: GTAOPass;
  constructor(scene: THREE.Scene, cam: THREE.PerspectiveCamera, ao: Partial<{ radius: number; distanceExponent: number; thickness: number; scale: number; samples: number; distanceFallOff: number; screenSpaceRadius: boolean }> = {}, intensity = 1) {
    this.pass = new GTAOPass(scene, cam, LW * SCALE, LH * SCALE);
    this.pass.output = GTAOPass.OUTPUT.Default;
    this.pass.blendIntensity = intensity;
    this.pass.updateGtaoMaterial({ radius: 0.25, distanceExponent: 1.5, thickness: 1, scale: 1, samples: 16, distanceFallOff: 1, screenSpaceRadius: false, ...ao });
    this.pass.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, rings: 2, samples: 16 });
  }
  render(r: THREE.WebGLRenderer, scene: THREE.Scene, cam: THREE.Camera, out: THREE.WebGLRenderTarget, clear: THREE.Color = new THREE.Color(0, 0, 0)) {
    renderInto(r, scene, cam, this.lit, clear);
    this.pass.render(r, out, this.lit, 0, false); // (Pass.render: deltaTime, maskActive unused here)
  }
}

let envTex: THREE.Texture | null = null;
/** A neutral studio-room environment map (PMREM) for reflections; set scene.environmentIntensity to taste. */
export function roomEnvironment(r: THREE.WebGLRenderer) {
  if (!envTex) {
    const pm = new THREE.PMREMGenerator(r);
    envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    pm.dispose();
  }
  return envTex;
}

// ------------------------------------------------------------------ hairline wireframes (hidden-line)
import { LineBatch } from './lines';

interface WireSrc { obj: THREE.Object3D; local: Float32Array; rgb: [number, number, number]; width: number; alpha: number; dynamic: boolean; world?: Float32Array }

/**
 * Hairline wireframe of scene objects: feature edges (EdgesGeometry, crease angle `threshold`) drawn as anti-aliased
 * capsules (pdoom's LineBatch), depth-tested against the solid pass so hidden lines drop out, faded with distance
 * (atmospheric depth: far lines dimmer and thinner). Static objects are transformed once; dynamic ones every frame.
 * Draw the solids first with `polygonOffset` pushing them back (see `inkMaterial`) so coplanar edges win.
 */
export class Wire {
  batch: LineBatch;
  private srcs: WireSrc[] = [];
  constructor(capacity = 120000, blend: 'normal' | 'max' | 'add' = 'normal') {
    this.batch = new LineBatch(capacity, { screen2D: false, blend, depthTest: true });
  }
  /** Add every mesh under `obj` (instanced meshes expand per instance). */
  add(obj: THREE.Object3D, rgb: [number, number, number], o: { width?: number; alpha?: number; threshold?: number; dynamic?: boolean; maxLen?: number } = {}) {
    obj.updateMatrixWorld(true);
    obj.traverse((m) => {
      const mesh = m as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const eg = new THREE.EdgesGeometry(mesh.geometry, o.threshold ?? 25);
      const pos = eg.getAttribute('position') as THREE.BufferAttribute;
      const local = subdivide(pos.array as ArrayLike<number>, o.maxLen ?? 1.0);
      eg.dispose();
      const inst = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh) : null;
      const n = inst ? inst.count : 1;
      for (let k = 0; k < n; k++) {
        const holder = new THREE.Object3D();
        if (inst) {
          // freeze the instance transform under the mesh
          const im = new THREE.Matrix4(); inst.getMatrixAt(k, im);
          holder.matrixAutoUpdate = false; holder.matrix.copy(im); mesh.add(holder); holder.updateMatrixWorld(true);
        }
        const src: WireSrc = { obj: inst ? holder : mesh, local, rgb, width: o.width ?? 1.1, alpha: o.alpha ?? 1, dynamic: !!o.dynamic };
        if (!src.dynamic) src.world = this.xform(src);
        this.srcs.push(src);
      }
    });
  }
  private xform(s: WireSrc) {
    const m = s.obj.matrixWorld.elements, L = s.local, out = new Float32Array(L.length);
    for (let i = 0; i < L.length; i += 3) {
      const x = L[i]!, y = L[i + 1]!, z = L[i + 2]!;
      out[i] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
      out[i + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      out[i + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    }
    return out;
  }
  /**
   * Draw into `out` (after the solid pass). fade: lines at distance d get brightness/alpha scaled by
   * 1 - smoothstep(near, far, d) * (1 - min); `gain` multiplies all colours (linear, >1 blooms).
   */
  render(r: THREE.WebGLRenderer, out: THREE.WebGLRenderTarget, cam: THREE.Camera, fade = { near: 6, far: 70, min: 0.12 }, gain = 1) {
    const b = this.batch, cp = cam.getWorldPosition(new THREE.Vector3());
    b.clear();
    for (const s of this.srcs) {
      if (!s.obj.visible && s.dynamic) continue;
      let vis = true;
      for (let p: THREE.Object3D | null = s.obj; p; p = p.parent) if (!p.visible) { vis = false; break; }
      if (!vis) continue;
      if (s.dynamic) { s.obj.updateMatrixWorld(true); s.world = this.xform(s); }
      const P = s.world!;
      for (let i = 0; i < P.length; i += 6) {
        const mx = (P[i]! + P[i + 3]!) / 2 - cp.x, my = (P[i + 1]! + P[i + 4]!) / 2 - cp.y, mz = (P[i + 2]! + P[i + 5]!) / 2 - cp.z;
        const d = Math.sqrt(mx * mx + my * my + mz * mz);
        const u = Math.min(1, Math.max(0, (d - fade.near) / (fade.far - fade.near)));
        const k = 1 - u * u * (3 - 2 * u) * (1 - fade.min);
        b.seg(P[i]!, P[i + 1]!, P[i + 2]!, P[i + 3]!, P[i + 4]!, P[i + 5]!, s.width * (0.7 + 0.3 * k), s.rgb[0] * k * gain, s.rgb[1] * k * gain, s.rgb[2] * k * gain, s.alpha * (0.35 + 0.65 * k));
      }
    }
    b.render(r, out, cam);
  }
}

/**
 * Split segments (flat xyz pairs) longer than maxLen into pieces: LineBatch drops a whole segment when either end is
 * behind the camera, so a long wall edge would vanish as we walk past its start.
 */
function subdivide(a: ArrayLike<number>, maxLen: number) {
  const out: number[] = [];
  for (let i = 0; i < a.length; i += 6) {
    const ax = a[i]!, ay = a[i + 1]!, az = a[i + 2]!, bx = a[i + 3]!, by = a[i + 4]!, bz = a[i + 5]!;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay, bz - az) / maxLen));
    for (let k = 0; k < n; k++) {
      const u0 = k / n, u1 = (k + 1) / n;
      out.push(ax + (bx - ax) * u0, ay + (by - ay) * u0, az + (bz - az) * u0, ax + (bx - ax) * u1, ay + (by - ay) * u1, az + (bz - az) * u1);
    }
  }
  return new Float32Array(out);
}

/** Solid-pass material for hidden-line wireframes: pushed back in depth so the edges drawn on it win. */
export function inkMaterial(color: THREE.ColorRepresentation = 0x0a0a0b, lit = false) {
  const o = { color, polygonOffset: true, polygonOffsetFactor: 1.5, polygonOffsetUnits: 2 };
  return lit ? new THREE.MeshStandardMaterial({ ...o, roughness: 0.95 }) : new THREE.MeshBasicMaterial(o);
}

// ------------------------------------------------------------------ screen-space outlines
import { FSPass } from './gl';

/**
 * Silhouette + crease lines from a normal/depth pre-pass (every object, curved or not, gets an outline; occlusion is
 * implicit). Lines are drawn over `out` with depth fade. Objects on layer 1 are left out of the pre-pass (decals,
 * glows, sprites): enable layer 1 on the main camera to still render them.
 */
export class Outline {
  private rt: THREE.WebGLRenderTarget;
  private nm = new THREE.MeshNormalMaterial();
  private pass: FSPass;
  constructor() {
    const dt = new THREE.DepthTexture(LW * SCALE, LH * SCALE);
    dt.type = THREE.FloatType;
    this.rt = new THREE.WebGLRenderTarget(LW * SCALE, LH * SCALE, { type: THREE.HalfFloatType, depthTexture: dt, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.pass = new FSPass(/* glsl */ `
      uniform sampler2D tN, tD; uniform vec2 px; uniform float near, far, w, dThr, nThr; uniform vec3 col; uniform vec3 fade;
      float lin(float z) { float n = near, f = far; return (2.0 * n * f) / (f + n - (z * 2.0 - 1.0) * (f - n)); }
      void main() {
        float d0 = lin(texture(tD, vUv).r);
        vec3 n0 = texture(tN, vUv).rgb * 2.0 - 1.0;
        float de = 0.0, ne = 0.0;
        for (int i = 0; i < 8; i++) {
          float a = float(i) * 0.7853982;
          vec2 o = vec2(cos(a), sin(a)) * px * w;
          float d = lin(texture(tD, vUv + o).r);
          vec3 n = texture(tN, vUv + o).rgb * 2.0 - 1.0;
          // depth: only the NEAR side of a silhouette draws (the far side would double the line)
          de = max(de, (d - d0) / d0);
          ne = max(ne, 1.0 - dot(n0, n));
        }
        float e = max(smoothstep(dThr, dThr * 2.5, de), smoothstep(nThr, nThr * 2.0, ne));
        if (d0 > far * 0.98) e = 0.0;
        float k = 1.0 - smoothstep(fade.x, fade.y, d0) * (1.0 - fade.z);
        fragColor = vec4(col * e * k, e * k);
      }`, {
      tN: { value: this.rt.texture }, tD: { value: dt }, px: { value: new THREE.Vector2(1 / (LW * SCALE), 1 / (LH * SCALE)) },
      near: { value: 0.1 }, far: { value: 100 }, w: { value: 1.2 * SCALE }, dThr: { value: 0.02 }, nThr: { value: 0.25 },
      col: { value: new THREE.Vector3(1, 1, 1) }, fade: { value: new THREE.Vector3(5, 60, 0.15) },
    }, { blending: THREE.CustomBlending, transparent: true });
    const m = this.pass.mat;
    m.blendEquation = THREE.AddEquation; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
  }
  /** Pre-pass + lines over `out`. rgb: linear line colour; fade: [near, far, min] distance fade. */
  render(r: THREE.WebGLRenderer, scene: THREE.Scene, cam: THREE.PerspectiveCamera, out: THREE.WebGLRenderTarget,
    o: { rgb?: [number, number, number]; width?: number; depth?: number; crease?: number; fade?: [number, number, number] } = {}) {
    const bg = scene.background, fog = scene.fog, mask = cam.layers.mask;
    // per-mesh normal materials (animated voxels bring their own, voxel.ts), the plain one otherwise
    const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
    scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { swapped.push([m, m.material]); m.material = (m.userData.normalMat as THREE.Material) ?? this.nm; } });
    scene.background = null; scene.fog = null; cam.layers.set(0);
    r.setRenderTarget(this.rt); r.setClearColor(0x8080ff, 1); r.clear(true, true, true);
    r.render(scene, cam);
    for (const [m, mat] of swapped) m.material = mat;
    scene.background = bg; scene.fog = fog; cam.layers.mask = mask;
    const u = this.pass.u;
    u.near!.value = cam.near; u.far!.value = cam.far;
    u.w!.value = (o.width ?? 1.2) * SCALE;
    u.dThr!.value = o.depth ?? 0.02; u.nThr!.value = o.crease ?? 0.25;
    (u.col!.value as THREE.Vector3).set(...(o.rgb ?? [1, 1, 1]));
    (u.fade!.value as THREE.Vector3).set(...(o.fade ?? [5, 60, 0.15]));
    this.pass.render(r, out);
  }
}

// ------------------------------------------------------------------ shot rig: snappy, beat-timed camera moves
/**
 * A camera key for ShotRig. Orientation is yaw/pitch (rad): yaw 0 looks along -z, positive yaw turns right (to +x);
 * pitch positive looks up. Give `at` instead to aim at a point. `ease` shapes the move that ENDS at this key
 * (outExpo = a snap that lands hard, inOutCubic = a smooth move, linear = constant drift, inExpo = accelerate into it).
 */
export interface RigKey {
  t: number; p: V3; at?: V3; yaw?: number; pitch?: number; roll?: number; fov?: number;
  ease?: keyof typeof ease;
  /** Force the turn into this key the long way round or a given way: +1 = turn right (yaw up), -1 = left. */
  turn?: 1 | -1;
}

/**
 * Camera from keys, each segment eased on its own (so a move can snap on a beat and hold, unlike CamPath's smooth
 * spline). Yaw is unwrapped key to key (a key may add whole turns to force a direction). Position is continuous:
 * no cuts, but velocity may jump — that's the snap. Yaws are unwrapped to the nearest turn unless a key says `turn`.
 */
export class ShotRig {
  private k: (RigKey & { yaw: number; pitch: number })[];
  constructor(keys: RigKey[]) {
    const ks = [...keys].sort((a, b) => a.t - b.t);
    let prevYaw = 0;
    this.k = ks.map((k, i) => {
      let yaw = k.yaw, pitch = k.pitch;
      if (k.at) {
        const dx = k.at[0] - k.p[0], dy = k.at[1] - k.p[1], dz = k.at[2] - k.p[2];
        yaw = Math.atan2(dx, -dz);
        pitch = Math.atan2(dy, Math.hypot(dx, dz));
      }
      yaw = yaw ?? prevYaw; pitch = pitch ?? 0;
      if (i > 0) { // unwrap to the nearest equivalent of the previous yaw, or turn the way the key asks
        let d = yaw - prevYaw;
        d = d - Math.PI * 2 * Math.round(d / (Math.PI * 2));
        if (k.turn === 1 && d < 0) d += Math.PI * 2;
        if (k.turn === -1 && d > 0) d -= Math.PI * 2;
        yaw = prevYaw + d;
      }
      prevYaw = yaw;
      return { ...k, yaw, pitch };
    });
  }
  at(t: number): CamPose {
    const k = this.k, n = k.length;
    let a = k[0]!, b = k[0]!, u = 0;
    if (t <= k[0]!.t) { a = b = k[0]!; }
    else if (t >= k[n - 1]!.t) { a = b = k[n - 1]!; }
    else {
      let i = 0;
      while (i < n - 2 && t > k[i + 1]!.t) i++;
      a = k[i]!; b = k[i + 1]!;
      u = ease[b.ease ?? 'inOutCubic']((t - a.t) / (b.t - a.t));
    }
    const L = (x: number, y: number) => x + (y - x) * u;
    const p = new THREE.Vector3(L(a.p[0], b.p[0]), L(a.p[1], b.p[1]), L(a.p[2], b.p[2]));
    const yaw = L(a.yaw, b.yaw), pitch = L(a.pitch, b.pitch);
    const f = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    return { p, at: p.clone().add(f), roll: L(a.roll ?? 0, b.roll ?? 0), fov: L(a.fov ?? 70, b.fov ?? 70) };
  }
}

// 碎裂（AE 的 Shatter）：图层裂成碎片，被冲击点炸开、按重力落下、各自翻转，碎片有厚度（侧面）、受光。effects.ts 的
// { type: 'shatter', … } 用它，参数和默认值写在 effects.ts 开头。
//
// 碎片的形状建一次（按图案、块数、种子、厚度、图层尺寸缓存）：glass 随机 Voronoi、radial 冲击点附近碎得细、bricks 砖、
// squares 方格、triangles 三角。每块的速度、转轴、转速、开裂时刻在建的时候按种子定好，之后任何时刻都是闭式解
// （位置 = 起点 + 速度·t + ½·重力·t²，转角 = 转速·t），所以任何一帧都能单独渲，子帧运动模糊照常。
import * as THREE from 'three';
import { mulberry32 } from './util';

type V2 = readonly [number, number];
export type ShatterPattern = 'glass' | 'radial' | 'bricks' | 'squares' | 'triangles';

export interface ShatterParams {
  /** Seconds since the impact (≤ 0: whole). */
  time: number;
  pattern?: ShatterPattern;
  /** About how many pieces (default 80). */
  pieces?: number;
  /** Impact point (content px; default the centre). */
  center: V2;
  /** Pieces whose centre is farther than this (px) stay put (default: all break). */
  radius?: number;
  /** Outward speed at the impact (px/s, default 900); falls off toward the radius. */
  strength?: number;
  /** Toward the camera share of the speed (0–1, default 0.4). */
  pop?: number;
  /** px/s², down (default 1500). */
  gravity?: number;
  /** Turn speed (deg/s, default 360). */
  spin?: number;
  /** Speed of the break front from the impact (px/s; 0 = everything at once, default 0). */
  front?: number;
  /** Thickness (px, default 6). */
  depth?: number;
  seed?: number;
  /** Eye distance (px, default 1600). */
  perspective?: number;
  /** How much the turning pieces are shaded by a light from the upper left (0–1, default 0.6). */
  light?: number;
  /** Side colour (CSS; default: the piece's own colour, darker). */
  sideColor?: [number, number, number] | null;
}

interface Built { geo: THREE.BufferGeometry; key: string }

/** Convex polygon clipped by the half-plane n·x ≤ d (Sutherland–Hodgman). */
function clip(poly: number[][], nx: number, ny: number, d: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const da = nx * a[0]! + ny * a[1]! - d, db = nx * b[0]! + ny * b[1]! - d;
    if (da <= 0) out.push(a);
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) { const u = da / (da - db); out.push([a[0]! + (b[0]! - a[0]!) * u, a[1]! + (b[1]! - a[1]!) * u]); }
  }
  return out;
}

/** The pieces as convex polygons over a w x h rect. */
export function shatterPolygons(pattern: ShatterPattern, n: number, w: number, h: number, seed: number, center: V2): number[][][] {
  const rnd = mulberry32((seed * 9301 + 49297) >>> 0);
  const rect = [[0, 0], [w, 0], [w, h], [0, h]];
  if (pattern === 'glass' || pattern === 'radial') {
    const sites: number[][] = [];
    const R = Math.hypot(w, h);
    for (let i = 0; i < n; i++) {
      if (pattern === 'radial') {
        // density falling with the distance from the impact: radius ~ u², angle uniform
        const u = rnd(), a = rnd() * Math.PI * 2, r = u * u * R * 0.75 + 2;
        const x = center[0] + Math.cos(a) * r, y = center[1] + Math.sin(a) * r;
        if (x > 0 && y > 0 && x < w && y < h) sites.push([x, y]); else i--;
      } else sites.push([rnd() * w, rnd() * h]);
    }
    return sites.map((s, i) => {
      let poly = rect.map((p) => p.slice());
      const others = sites.map((o, j) => ({ o, j, d: Math.hypot(o[0]! - s[0]!, o[1]! - s[1]!) })).filter((x) => x.j !== i).sort((a, b) => a.d - b.d);
      for (const { o, d } of others) {
        // farther than twice the cell's reach: cannot cut it any more
        const reach = Math.max(...poly.map((p) => Math.hypot(p[0]! - s[0]!, p[1]! - s[1]!)));
        if (d > 2 * reach) break;
        const nx = o[0]! - s[0]!, ny = o[1]! - s[1]!, mx = (o[0]! + s[0]!) / 2, my = (o[1]! + s[1]!) / 2;
        poly = clip(poly, nx, ny, nx * mx + ny * my);
        if (poly.length < 3) break;
      }
      return poly;
    }).filter((p) => p.length >= 3);
  }
  // grids: about n cells with the rect's aspect
  const cols = Math.max(1, Math.round(Math.sqrt((n * w) / h))), rows = Math.max(1, Math.round(n / cols));
  const cw = w / cols, ch = h / rows, out: number[][][] = [];
  for (let r = 0; r < rows; r++) {
    const off = pattern === 'bricks' && r % 2 ? cw / 2 : 0;
    for (let c = -1; c <= cols; c++) {
      const x0 = Math.max(0, c * cw + off), x1 = Math.min(w, (c + 1) * cw + off);
      if (x1 - x0 < 1e-6) continue;
      const y0 = r * ch, y1 = (r + 1) * ch;
      if (pattern === 'triangles') {
        const flip = (r + c) % 2 === 0;
        out.push(flip ? [[x0, y0], [x1, y0], [x1, y1]] : [[x0, y0], [x1, y0], [x0, y1]]);
        out.push(flip ? [[x0, y0], [x1, y1], [x0, y1]] : [[x1, y0], [x1, y1], [x0, y1]]);
      } else out.push([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
    }
  }
  return out;
}

const VERT = /* glsl */ `
  in vec3 position; in vec3 normal; in vec3 aC; in vec3 aV; in vec4 aAx; in float aDelay; in float aKind;
  uniform mat4 projectionMatrix; uniform float uT, uG, uD, uLight; uniform vec2 uBuf, uOff;
  out vec2 vUv; out float vShade; out float vKind;
  mat3 rotAxis(vec3 a, float t) { float c = cos(t), s = sin(t), k = 1.0 - c;
    return mat3(c + a.x * a.x * k, a.y * a.x * k + a.z * s, a.z * a.x * k - a.y * s,
                a.x * a.y * k - a.z * s, c + a.y * a.y * k, a.z * a.y * k + a.x * s,
                a.x * a.z * k + a.y * s, a.y * a.z * k - a.x * s, c + a.z * a.z * k); }
  void main() {
    vec3 p = position, n = normal;
    float a = uT - aDelay;
    if (aDelay < 1e8 && a > 0.0) {
      mat3 R = rotAxis(aAx.xyz, aAx.w * a);
      p = aC + R * (position - aC) + aV * a + vec3(0.0, 0.5 * uG * a * a, 0.0);
      n = R * normal;
    }
    vUv = vec2((position.x + uOff.x) / uBuf.x, 1.0 - (position.y + uOff.y) / uBuf.y);
    vec3 L = normalize(vec3(-0.45, -0.6, -1.0));
    float rest = dot(vec3(0.0, 0.0, -1.0), L);
    vShade = aKind > 1.5 ? 0.55 : mix(1.0, clamp(abs(dot(n, L)) / rest, 0.25, 1.15), uLight);
    vKind = aKind;
    // perspective about the buffer's centre (the z = 0 plane 1:1), y down
    vec2 q = p.xy + uOff, c = uBuf * 0.5;
    float w = (uD + p.z) / uD;
    gl_Position = vec4((c.x * w + q.x - c.x) / c.x - w, w - (c.y * w + q.y - c.y) / c.y, clamp(p.z / 20000.0, -0.99, 0.99) * w, w);
  }
`;
const FRAG = /* glsl */ `
  precision highp float;
  in vec2 vUv; in float vShade; in float vKind;
  uniform sampler2D uSrc; uniform bool uSide; uniform vec3 uSideCol;
  layout(location = 0) out vec4 outColor;
  void main() {
    vec4 c = texture(uSrc, vUv);
    if (c.a < 0.004) discard;
    if (vKind > 1.5 && uSide) c.rgb = uSideCol * c.a;
    outColor = vec4(c.rgb * vShade, c.a);
  }
`;

/** Renders the shattered layer (see the notes at the top). One per Fx. */
export class Shatter {
  private built: Built | null = null;
  private mat: THREE.RawShaderMaterial | null = null;
  private scene = new THREE.Scene();
  private mesh: THREE.Mesh | null = null;
  private cam = new THREE.Camera();
  private rt: THREE.WebGLRenderTarget | null = null;

  /** Geometry for these pieces (content px; z: front 0, back depth), with every piece's motion baked in. */
  private build(p: ShatterParams, w: number, h: number) {
    const pattern = p.pattern ?? 'glass', n = Math.max(1, Math.round(p.pieces ?? 80)), seed = p.seed ?? 0, depth = Math.max(0, p.depth ?? 6);
    const radius = p.radius ?? Infinity, strength = p.strength ?? 900, pop = p.pop ?? 0.4, spin = ((p.spin ?? 360) * Math.PI) / 180, front = p.front ?? 0;
    const key = JSON.stringify([pattern, n, seed, depth, w, h, p.center, radius, strength, pop, spin, front]);
    if (this.built?.key === key) return this.built.geo;
    this.built?.geo.dispose();
    const polys = shatterPolygons(pattern, n, w, h, seed, p.center);
    const rnd = mulberry32((seed * 7919 + 104729) >>> 0);
    const P: number[] = [], N: number[] = [], C: number[] = [], V: number[] = [], A: number[] = [], D: number[] = [], K: number[] = [];
    const R = Math.hypot(w, h);
    for (const poly of polys) {
      let cx = 0, cy = 0;
      for (const q of poly) { cx += q[0]!; cy += q[1]!; }
      cx /= poly.length; cy /= poly.length;
      const dx = cx - p.center[0], dy = cy - p.center[1], dist = Math.hypot(dx, dy);
      const breaks = dist <= radius;
      // speed: out from the impact, falling off with the distance, some toward the camera, some scatter
      const fall = Number.isFinite(radius) ? Math.max(0, 1 - dist / radius) : Math.max(0.15, 1 - dist / R);
      const ux = dist > 1e-6 ? dx / dist : 0, uy = dist > 1e-6 ? dy / dist : 0, sp = strength * (0.35 + 0.65 * Math.sqrt(fall)) * (0.7 + 0.6 * rnd());
      const vx = ux * sp * (1 - pop) + (rnd() - 0.5) * sp * 0.3, vy = uy * sp * (1 - pop) + (rnd() - 0.5) * sp * 0.3, vz = -sp * pop * (0.5 + rnd());
      let ax = rnd() - 0.5, ay = rnd() - 0.5, az = (rnd() - 0.5) * 0.6;
      const al = Math.hypot(ax, ay, az) || 1; ax /= al; ay /= al; az /= al;
      const w0 = spin * (0.4 + rnd()) * (rnd() < 0.5 ? -1 : 1);
      const delay = breaks ? (front > 0 ? dist / front : 0) : 1e9;
      const zc = depth / 2;
      const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number, kind: number) => {
        P.push(x, y, z); N.push(nx, ny, nz); C.push(cx, cy, zc); V.push(vx, vy, vz); A.push(ax, ay, az, w0); D.push(delay); K.push(kind);
      };
      // a hair bigger while whole, so neighbours meet without cracks
      const grow = (q: number[]) => [q[0]! + (q[0]! - cx) * 0.004, q[1]! + (q[1]! - cy) * 0.004];
      for (let i = 1; i + 1 < poly.length; i++) {
        const a = grow(poly[0]!), b = grow(poly[i]!), c = grow(poly[i + 1]!);
        push(a[0]!, a[1]!, 0, 0, 0, -1, 0); push(b[0]!, b[1]!, 0, 0, 0, -1, 0); push(c[0]!, c[1]!, 0, 0, 0, -1, 0);
        if (depth > 0) { push(a[0]!, a[1]!, depth, 0, 0, 1, 1); push(c[0]!, c[1]!, depth, 0, 0, 1, 1); push(b[0]!, b[1]!, depth, 0, 0, 1, 1); }
      }
      if (depth > 0) for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!, b = poly[(i + 1) % poly.length]!, ex = b[0]! - a[0]!, ey = b[1]! - a[1]!, l = Math.hypot(ex, ey) || 1;
        const nx = ey / l, ny = -ex / l;
        push(a[0]!, a[1]!, 0, nx, ny, 0, 2); push(b[0]!, b[1]!, 0, nx, ny, 0, 2); push(b[0]!, b[1]!, depth, nx, ny, 0, 2);
        push(a[0]!, a[1]!, 0, nx, ny, 0, 2); push(b[0]!, b[1]!, depth, nx, ny, 0, 2); push(a[0]!, a[1]!, depth, nx, ny, 0, 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('aC', new THREE.Float32BufferAttribute(C, 3));
    g.setAttribute('aV', new THREE.Float32BufferAttribute(V, 3));
    g.setAttribute('aAx', new THREE.Float32BufferAttribute(A, 4));
    g.setAttribute('aDelay', new THREE.Float32BufferAttribute(D, 1));
    g.setAttribute('aKind', new THREE.Float32BufferAttribute(K, 1));
    this.built = { geo: g, key };
    return g;
  }

  /**
   * Draw `src` (a W x H physical target's texture, pxs physical px per logical px) shattered into `dst`; `rect` is the
   * content rect inside the buffer, logical px [x, y, w, h].
   */
  render(r: THREE.WebGLRenderer, src: THREE.Texture, dst: THREE.WebGLRenderTarget, W: number, H: number, pxs: number, rect: readonly number[], p: ShatterParams) {
    const geo = this.build(p, rect[2]!, rect[3]!);
    this.mat ??= new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide, depthTest: true, depthWrite: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      uniforms: {
        projectionMatrix: { value: new THREE.Matrix4() }, uT: { value: 0 }, uG: { value: 0 }, uD: { value: 1600 }, uLight: { value: 0.6 },
        uBuf: { value: new THREE.Vector2() }, uOff: { value: new THREE.Vector2() }, uSrc: { value: null }, uSide: { value: false }, uSideCol: { value: new THREE.Vector3() },
      },
    });
    if (!this.mesh) { this.mesh = new THREE.Mesh(geo, this.mat); this.mesh.frustumCulled = false; this.scene.add(this.mesh); }
    this.mesh.geometry = geo;
    const u = this.mat.uniforms;
    u.uT!.value = p.time; u.uG!.value = p.gravity ?? 1500; u.uD!.value = Math.max(100, p.perspective ?? 1600); u.uLight!.value = p.light ?? 0.6;
    (u.uBuf!.value as THREE.Vector2).set(W / pxs, H / pxs); (u.uOff!.value as THREE.Vector2).set(rect[0]!, rect[1]!);
    u.uSrc!.value = src; u.uSide!.value = !!p.sideColor; if (p.sideColor) (u.uSideCol!.value as THREE.Vector3).set(...p.sideColor);
    if (!this.rt || this.rt.width !== W || this.rt.height !== H) {
      this.rt?.dispose();
      this.rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    }
    const prev = r.getRenderTarget(), ac = r.autoClear, cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    r.setRenderTarget(this.rt); r.setClearColor(0x000000, 0); r.clear(true, true, false);
    r.autoClear = false;
    r.render(this.scene, this.cam);
    r.autoClear = ac; r.setClearColor(cc, ca); r.setRenderTarget(prev);
    return this.rt;
  }

  dispose() { this.built?.geo.dispose(); this.mat?.dispose(); this.rt?.dispose(); }
}

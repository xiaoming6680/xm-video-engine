// 粒子（AE 的 Trapcode Particular / CC Particle World）：发射器按出生率或爆发放出粒子，每颗有初速度、寿命、重力、空气阻力、
// 湍流，大小 / 透明度 / 颜色随寿命变，形状是光点、圆点、方块、环、星芒或一张贴图，可以沿运动方向拉长。
// 不替画面做决定：参数给多少做多少。
//
// 每颗粒子的出生时刻、出生位置、初速度在建的时候按 seed 算好；之后任何时刻的状态都是闭式解（重力 + 阻力的解析解，湍流是
// 按位置和时间取的噪声场），所以任何一帧都能单独渲、顺序随意，子帧运动模糊、--from 只渲一段都和整段渲一样。
//
// 单位和 AE 一样：合成像素，x 向右、y 向下、z 往屏幕里；速度 px/s，重力 px/s²。粒子在合成的 3D 空间里，跟合成的摄像机走：
//   sparks = new Particles({ emitter: { position: [960, 700] }, rate: 200, velocity: 600, direction: [0, -1, 0], spread: 25,
//                            gravity: 900, life: 1.6, size: 6, color: ['#fff3c4', '#ff7a2a', '#7a1020'], shape: 'glow', streak: 1 });
//   comp.layers = [ …, { name: 'sparks', three: sparks.source(comp.space), mode: 'add' } ];   // 发光的粒子层一般用 'add' / 'screen'
// 自己的 three 场景里用：sparks.place(space) 摆好坐标换算，scene.add(sparks.mesh)，每帧 sparks.update(t)。
//
// 发射（时间都是来源时间，秒）
//   rate 60（每秒几颗，或 (t) => 每秒几颗，可以打关键帧）、from 0 / to 10（发射的时间段）、bursts [{ t, count }]（一瞬间放一批）、
//   max 50000（总数上限）、seed 0
// 发射器 emitter
//   type 'point' | 'box' | 'sphere' | 'disc' | 'line' | 'points'；position（合成像素，或 (t) => 位置，出生那一刻在哪就从哪出；
//   points 类型默认 [0, 0, 0] = 不偏移）；size（box [w, h, d]，sphere / disc 半径，line 长度）；rotation（度，box / disc / line 在 xy 面里转）；
//   surface（sphere / disc / box 只从表面 / 边上出）；points、colors：'points' 类型从这些点出（合成像素），colors 是每个点的显示色 0–1
//   （canvasPoints() 从字或画布的像素取，做「字散成粒子」）
// 运动
//   velocity 200（px/s）、velocityRandom 0.5、direction（不给 = 从发射器中心往外，点发射器四面八方）、spread（度，方向锥的半角：
//   给了 direction 默认 20，没给默认 0）、flat false（true = 只在 xy 面里飞）、inherit 0（继承发射器自己移动的速度，0–1）、
//   gravity 0（px/s²，数 = 往下；或 [x, y, z]）、drag 0（空气阻力，1/s：越大越快停下）、
//   turbulence 0（湍流位移 px）、turbulenceScale 200（噪声尺度 px）、turbulenceSpeed 0.5（场变化快慢）
// 寿命和外观
//   life 2（秒）、lifeRandom 0.3、size 8（px，在 z = 0 默认摄像机下就是屏幕像素）、sizeRandom 0.3、sizeOverLife [1]、
//   opacity 1、opacityRandom 0、opacityOverLife [1, 1, 1, 1, 0]（随寿命均匀铺开的值，最多 8 个；默认最后一段淡出）、
//   color '#ffffff'（一个颜色，或 stops：随寿命从第一个走到最后一个）、hueRandom 0（± 度）、
//   shape 'glow' | 'dot' | 'square' | 'ring' | 'star'、sprite（贴图纹理，给了就不看 shape）、feather 0.1（dot / square / ring 的边软）、
//   spin 0、spinRandom 0（度 / 秒，转贴图和方块）、streak 0（沿屏幕上的运动拉长：1 ≈ 30 fps 下一帧走的距离）、
//   blend 'add' | 'normal'（粒子之间怎么叠；整层怎么叠到合成上看图层的 mode）
import * as THREE from 'three';
import { mulberry32 } from './util';
import { W, H } from './gl';
import type { Space } from './space';
import type { ThreeSource } from './layers';

type Vec = readonly number[];
type V3 = [number, number, number];
type Col = string;
type Stops = readonly (Col | readonly [number, Col])[];

export interface Emitter {
  type?: 'point' | 'box' | 'sphere' | 'disc' | 'line' | 'points';
  position?: Vec | ((t: number) => Vec);
  size?: number | Vec;
  rotation?: number;
  surface?: boolean;
  points?: readonly Vec[];
  colors?: readonly Vec[];
}

export interface ParticleOpts {
  emitter?: Emitter;
  rate?: number | ((t: number) => number);
  from?: number;
  to?: number;
  bursts?: readonly { t: number; count: number }[];
  max?: number;
  seed?: number;
  velocity?: number;
  velocityRandom?: number;
  direction?: Vec;
  spread?: number;
  flat?: boolean;
  inherit?: number;
  gravity?: number | Vec;
  drag?: number;
  turbulence?: number;
  turbulenceScale?: number;
  turbulenceSpeed?: number;
  life?: number;
  lifeRandom?: number;
  size?: number;
  sizeRandom?: number;
  sizeOverLife?: readonly number[];
  opacity?: number;
  opacityRandom?: number;
  opacityOverLife?: readonly number[];
  color?: Col | Stops;
  hueRandom?: number;
  shape?: 'glow' | 'dot' | 'square' | 'ring' | 'star';
  sprite?: THREE.Texture;
  feather?: number;
  spin?: number;
  spinRandom?: number;
  streak?: number;
  blend?: 'add' | 'normal';
}

const SHAPES = { glow: 0, dot: 1, square: 2, ring: 3, star: 4 } as const;
const DEG = Math.PI / 180;

const tmpC = new THREE.Color();
const disp = (css: string): V3 => { tmpC.setStyle(css); const o = { r: 0, g: 0, b: 0 }; tmpC.getRGB(o, THREE.SRGBColorSpace); return [o.r, o.g, o.b]; };

/** Piecewise-linear values over life → 8 floats + count. */
function overLife(v: readonly number[] | undefined, d: readonly number[]) {
  const a = (v?.length ? v : d).slice(0, 8);
  return { vals: Array.from({ length: 8 }, (_, i) => a[Math.min(i, a.length - 1)]!), n: a.length };
}

/** Birth times: steady rate (or a rate curve) over [from, to), plus bursts; sorted, at most `max`. */
export function birthTimes(o: Pick<ParticleOpts, 'rate' | 'from' | 'to' | 'bursts' | 'max' | 'seed'>): number[] {
  const rnd = mulberry32(((o.seed ?? 0) * 7919 + 17) >>> 0);
  const from = o.from ?? 0, to = o.to ?? 10, rate = o.rate ?? 60, out: number[] = [];
  const max = o.max ?? 50000;
  if (typeof rate === 'number') {
    if (rate > 0) for (let i = 0; out.length <= max; i++) { const b = from + (i + rnd()) / rate; if (b >= to) break; out.push(b); }
  } else {
    const dt = 1 / 240;
    let acc = rnd();
    for (let t = from; t < to && out.length <= max; t += dt) {
      acc += Math.max(0, rate(t)) * dt;
      while (acc >= 1 && out.length <= max) { out.push(t + dt * rnd()); acc -= 1; }
    }
  }
  for (const b of o.bursts ?? []) for (let k = 0; k < b.count && out.length <= max; k++) out.push(b.t + 1e-5 * (k / Math.max(1, b.count)));
  out.sort((a, b) => a - b);
  if (out.length > max) { console.warn(`particles: more than ${max} births, keeping the first ${max} (raise max)`); out.length = max; }
  return out;
}

/** Pixels of a canvas drawing as emitter points (comp px) and their display colours: text or a shape breaking into particles. */
export function canvasPoints(size: readonly [number, number], draw: (c: CanvasRenderingContext2D) => void, n: number,
  o: { at?: Vec; seed?: number; threshold?: number } = {}): { points: V3[]; colors: V3[] } {
  const [w, h] = [Math.max(1, Math.round(size[0])), Math.max(1, Math.round(size[1]))];
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const c = cv.getContext('2d', { willReadFrequently: true })!;
  draw(c);
  const img = c.getImageData(0, 0, w, h).data, th = Math.round((o.threshold ?? 0.5) * 255);
  const on: number[] = [];
  for (let i = 0; i < w * h; i++) if (img[i * 4 + 3]! > th) on.push(i);
  const rnd = mulberry32(((o.seed ?? 0) * 104729 + 3) >>> 0), ax = o.at?.[0] ?? 0, ay = o.at?.[1] ?? 0, az = o.at?.[2] ?? 0;
  const points: V3[] = [], colors: V3[] = [];
  if (!on.length) return { points, colors };
  for (let k = 0; k < n; k++) {
    const i = on[Math.floor(rnd() * on.length)]!, a = img[i * 4 + 3]! / 255;
    points.push([ax + (i % w) + rnd(), ay + Math.floor(i / w) + rnd(), az]);
    colors.push([img[i * 4]! / 255 / a, img[i * 4 + 1]! / 255 / a, img[i * 4 + 2]! / 255 / a].map((x) => Math.min(1, x)) as V3);
  }
  return { points, colors };
}

const VERT = /* glsl */ `
  in vec3 aP0; in vec3 aV0; in vec2 aBL; in vec4 aRnd; in vec3 aCol;
  uniform float uT, uDrag, uTurb, uTurbScale, uTurbSpeed, uSize, uOpacity, uStreak, uPpm, uHue;
  uniform vec3 uGrav; uniform bool uFlat;
  uniform float uSizeOL[8]; uniform int uSizeN; uniform float uOpOL[8]; uniform int uOpN;
  uniform vec3 cols[8]; uniform float pos[8]; uniform int ns;
  out vec2 vC; out vec4 vColor;
  float h31(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float vnoise(vec3 p) { vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(h31(i), h31(i + vec3(1, 0, 0)), f.x), mix(h31(i + vec3(0, 1, 0)), h31(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(h31(i + vec3(0, 0, 1)), h31(i + vec3(1, 0, 1)), f.x), mix(h31(i + vec3(0, 1, 1)), h31(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
  float fbm2(vec3 p) { return vnoise(p) * 0.65 + vnoise(p * 2.03 + 7.7) * 0.35; }
  float olSize(float u) { if (uSizeN <= 1) return uSizeOL[0]; float x = u * float(uSizeN - 1); int i = int(min(floor(x), float(uSizeN - 2)));
    return mix(uSizeOL[i], uSizeOL[i + 1], x - float(i)); }
  float olOp(float u) { if (uOpN <= 1) return uOpOL[0]; float x = u * float(uOpN - 1); int i = int(min(floor(x), float(uOpN - 2)));
    return mix(uOpOL[i], uOpOL[i + 1], x - float(i)); }
  vec3 ramp(float l) { if (l <= pos[0]) return cols[0]; vec3 m = cols[0];
    for (int i = 1; i < 8; i++) { if (i >= ns) break; if (l >= pos[i]) { m = cols[i]; continue; }
      return mix(cols[i - 1], cols[i], clamp((l - pos[i - 1]) / max(pos[i] - pos[i - 1], 1e-5), 0.0, 1.0)); }
    return m; }
  vec3 hueRot(vec3 c, float a) { // YIQ rotation
    mat3 toY = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
    mat3 toR = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
    vec3 y = toY * c; float cs = cos(a), sn = sin(a); y.yz = vec2(cs * y.y - sn * y.z, sn * y.y + cs * y.z); return clamp(toR * y, 0.0, 1.0); }
  vec3 lin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
  vec3 posAt(float a) {
    float f, h;
    if (uDrag > 1e-4) { float e = exp(-uDrag * a); f = (1.0 - e) / uDrag; h = (a - f) / uDrag; } else { f = a; h = 0.5 * a * a; }
    vec3 p = aP0 + aV0 * f + uGrav * h;
    if (uTurb > 0.0) {
      vec3 q = p / uTurbScale; float s = uT * uTurbSpeed;
      vec3 d = vec3(fbm2(vec3(q.xy, s)), fbm2(vec3(q.yz + 17.3, s + 3.1)), fbm2(vec3(q.zx + 43.9, s + 7.4))) * 2.0 - 1.0;
      if (uFlat) d.z = 0.0;
      p += d * uTurb * smoothstep(0.0, 0.6, a);
    }
    return p;
  }
  void main() {
    float age = uT - aBL.x, life = aBL.y;
    if (age < 0.0 || age >= life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vColor = vec4(0.0); vC = vec2(0.0); return; }
    float u = age / life;
    vec4 mv = modelViewMatrix * vec4(posAt(age), 1.0);
    float sz = uSize * aRnd.x * max(olSize(u), 0.0) / uPpm;
    vec2 c = position.xy, off;
    vec2 dv = vec2(0.0);
    if (uStreak > 0.0) { vec4 m0 = modelViewMatrix * vec4(posAt(max(age - 1.0 / 30.0, 0.0)), 1.0); dv = (mv.xy - m0.xy) * uStreak; }
    float L = length(dv);
    if (L > 1e-6) { vec2 al = dv / L, pe = vec2(-al.y, al.x); off = al * c.x * (sz + L) + pe * c.y * sz - dv * 0.5; }
    else { float r = aRnd.z * age + aRnd.w * 6.2831853, cs = cos(r), sn = sin(r); off = vec2(cs * c.x - sn * c.y, sn * c.x + cs * c.y) * sz; }
    mv.xy += off;
    gl_Position = projectionMatrix * mv;
    vC = c;
    vec3 col = ramp(u) * aCol;
    if (uHue != 0.0) col = hueRot(col, uHue * (fract(aRnd.w * 13.37) * 2.0 - 1.0));
    vColor = vec4(lin(col), clamp(uOpacity * aRnd.y * olOp(u), 0.0, 1.0));
  }
`;

const FRAG = /* glsl */ `
  in vec2 vC; in vec4 vColor; layout(location = 0) out vec4 outColor;
  uniform int uShape; uniform float uFeather; uniform bool uHasSprite; uniform sampler2D uSprite;
  void main() {
    if (vColor.a <= 0.0) discard;
    float r = length(vC) * 2.0, f = max(uFeather, 0.02), a;
    vec3 rgb = vColor.rgb;
    if (uHasSprite) { vec4 s = texture(uSprite, vC + 0.5); a = s.a; rgb *= mix(s.rgb / 12.92, pow((s.rgb + 0.055) / 1.055, vec3(2.4)), step(0.04045, s.rgb)); }
    else if (uShape == 0) a = exp(-r * r * 4.0) * (1.0 - smoothstep(0.8, 1.0, r));
    else if (uShape == 1) a = 1.0 - smoothstep(1.0 - f, 1.0, r);
    else if (uShape == 2) a = 1.0 - smoothstep(1.0 - f, 1.0, max(abs(vC.x), abs(vC.y)) * 2.0);
    else if (uShape == 3) a = (1.0 - smoothstep(1.0 - f, 1.0, r)) * smoothstep(0.62 - f, 0.62, r);
    else a = (max(exp(-abs(vC.x) * 30.0), exp(-abs(vC.y) * 30.0)) * 0.8 + exp(-r * r * 12.0)) * (1.0 - smoothstep(0.5, 1.0, r));
    a *= vColor.a;
    if (a <= 0.0) discard;
    outColor = vec4(rgb * a, a);
  }
`;

/** A particle system (see the notes at the top). Build once (in init()), then update(t) or use source(space) as a layer. */
export class Particles {
  readonly mesh: THREE.Mesh;
  readonly scene = new THREE.Scene();
  readonly count: number;
  private mat: THREE.ShaderMaterial;

  constructor(readonly o: ParticleOpts = {}) {
    const births = birthTimes(o);
    const n = births.length;
    this.count = n;
    const em = o.emitter ?? {}, type = em.type ?? 'point';
    const posAt = (t: number): V3 => {
      const p = typeof em.position === 'function' ? em.position(t) : em.position;
      const d = type === 'points' ? [0, 0, 0] : [W / 2, H / 2, 0];
      return [p?.[0] ?? d[0]!, p?.[1] ?? d[1]!, p?.[2] ?? d[2]!];
    };
    const sz = em.size, rot = (em.rotation ?? 0) * DEG, cr = Math.cos(rot), sr = Math.sin(rot);
    const rnd = mulberry32(((o.seed ?? 0) * 2654435761 + 99991) >>> 0);
    const sphereDir = (): V3 => {
      if (o.flat) { const a = rnd() * Math.PI * 2; return [Math.cos(a), Math.sin(a), 0]; }
      const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - z * z);
      return [s * Math.cos(a), s * Math.sin(a), z];
    };
    const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]); return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : sphereDir(); };
    // a direction within `spread` degrees of d
    const cone = (d: V3, spread: number): V3 => {
      if (spread <= 0) return d;
      if (o.flat) { const a = Math.atan2(d[1], d[0]) + (rnd() * 2 - 1) * spread * DEG; return [Math.cos(a), Math.sin(a), 0]; }
      const ct = 1 - rnd() * (1 - Math.cos(Math.min(180, spread) * DEG)), st = Math.sqrt(Math.max(0, 1 - ct * ct)), ph = rnd() * Math.PI * 2;
      const up: V3 = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const a = norm([d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]]);
      const b: V3 = [d[1] * a[2] - d[2] * a[1], d[2] * a[0] - d[0] * a[2], d[0] * a[1] - d[1] * a[0]];
      return [0, 1, 2].map((k) => d[k]! * ct + (a[k]! * Math.cos(ph) + b[k]! * Math.sin(ph)) * st) as V3;
    };
    const local = (): { p: V3; col?: Vec } => {
      const xy = (x: number, y: number, z: number): V3 => [x * cr - y * sr, x * sr + y * cr, z];
      const surf = !!em.surface;
      switch (type) {
        case 'box': {
          const [bw, bh, bd] = typeof sz === 'number' ? [sz, sz, sz] : [sz?.[0] ?? 100, sz?.[1] ?? 100, sz?.[2] ?? 0];
          const q: V3 = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
          if (surf) { const k = Math.floor(rnd() * (bd > 0 ? 3 : 2)); q[k] = rnd() < 0.5 ? -0.5 : 0.5; }
          return { p: xy(q[0] * bw, q[1] * bh, q[2] * bd) };
        }
        case 'sphere': { const R = typeof sz === 'number' ? sz : sz?.[0] ?? 100, d = sphereDir(), k = surf ? 1 : Math.cbrt(rnd()); return { p: [d[0] * R * k, d[1] * R * k, d[2] * R * k] }; }
        case 'disc': { const R = typeof sz === 'number' ? sz : sz?.[0] ?? 100, a = rnd() * Math.PI * 2, k = surf ? 1 : Math.sqrt(rnd()); return { p: xy(Math.cos(a) * R * k, Math.sin(a) * R * k, 0) }; }
        case 'line': { const L = typeof sz === 'number' ? sz : sz?.[0] ?? 200; return { p: xy((rnd() - 0.5) * L, 0, 0) }; }
        case 'points': {
          const pts = em.points ?? [];
          if (!pts.length) return { p: [0, 0, 0] };
          const i = Math.floor(rnd() * pts.length), q = pts[i]!;
          return { p: [q[0] ?? 0, q[1] ?? 0, q[2] ?? 0], col: em.colors?.[i] };
        }
        default: return { p: [0, 0, 0] };
      }
    };
    const grav: V3 = typeof o.gravity === 'number' ? [0, o.gravity, 0] : [o.gravity?.[0] ?? 0, o.gravity?.[1] ?? 0, o.gravity?.[2] ?? 0];
    const dir = o.direction ? norm([o.direction[0] ?? 0, o.direction[1] ?? 0, o.direction[2] ?? 0]) : null;
    const spread = o.spread ?? (dir ? 20 : 0);
    const P0 = new Float32Array(n * 3), V0 = new Float32Array(n * 3), BL = new Float32Array(n * 2), RN = new Float32Array(n * 4), CO = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const b = births[i]!, e = posAt(b), l = local();
      const p: V3 = [e[0] + l.p[0], e[1] + l.p[1], e[2] + l.p[2]];
      let d: V3 = dir ?? (type === 'point' || type === 'points' ? sphereDir() : norm(o.flat ? [l.p[0], l.p[1], 0] : l.p));
      d = cone(d, spread);
      const sp = Math.max(0, (o.velocity ?? 200) * (1 + (o.velocityRandom ?? 0.5) * (rnd() * 2 - 1)));
      let v: V3 = [d[0] * sp, d[1] * sp, d[2] * sp];
      if (o.inherit) { const e1 = posAt(b + 1e-3), k = o.inherit / 1e-3; v = [v[0] + (e1[0] - e[0]) * k, v[1] + (e1[1] - e[1]) * k, v[2] + (e1[2] - e[2]) * k]; }
      if (o.flat) v[2] = 0;
      P0.set(p, i * 3); V0.set(v, i * 3);
      BL.set([b, Math.max(0.01, (o.life ?? 2) * (1 + (o.lifeRandom ?? 0.3) * (rnd() * 2 - 1)))], i * 2);
      RN.set([Math.max(0, 1 + (o.sizeRandom ?? 0.3) * (rnd() * 2 - 1)), 1 - (o.opacityRandom ?? 0) * rnd(),
        ((o.spin ?? 0) + (o.spinRandom ?? 0) * (rnd() * 2 - 1)) * DEG, rnd()], i * 4);
      CO.set(l.col ? [l.col[0] ?? 1, l.col[1] ?? 1, l.col[2] ?? 1] : [1, 1, 1], i * 3);
    }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.setAttribute('aP0', new THREE.InstancedBufferAttribute(P0, 3));
    g.setAttribute('aV0', new THREE.InstancedBufferAttribute(V0, 3));
    g.setAttribute('aBL', new THREE.InstancedBufferAttribute(BL, 2));
    g.setAttribute('aRnd', new THREE.InstancedBufferAttribute(RN, 4));
    g.setAttribute('aCol', new THREE.InstancedBufferAttribute(CO, 3));
    g.instanceCount = n;
    const col = o.color ?? '#ffffff', stops = typeof col === 'string' ? [col] : col;
    const st = stops.slice(0, 8).map((s, i, all) => (typeof s === 'string' ? [all.length > 1 ? i / (all.length - 1) : 0, s] : s) as readonly [number, string]);
    const so = overLife(o.sizeOverLife, [1]), oo = overLife(o.opacityOverLife, [1, 1, 1, 1, 0]);
    const add = (o.blend ?? 'add') === 'add';
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: add ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      uniforms: {
        uT: { value: 0 }, uDrag: { value: Math.max(0, o.drag ?? 0) }, uTurb: { value: Math.max(0, o.turbulence ?? 0) },
        uTurbScale: { value: Math.max(1, o.turbulenceScale ?? 200) }, uTurbSpeed: { value: o.turbulenceSpeed ?? 0.5 },
        uSize: { value: o.size ?? 8 }, uOpacity: { value: o.opacity ?? 1 }, uStreak: { value: Math.max(0, o.streak ?? 0) },
        uPpm: { value: 100 }, uHue: { value: (o.hueRandom ?? 0) * DEG }, uGrav: { value: new THREE.Vector3(...grav) }, uFlat: { value: !!o.flat },
        uSizeOL: { value: so.vals }, uSizeN: { value: so.n }, uOpOL: { value: oo.vals }, uOpN: { value: oo.n },
        cols: { value: Array.from({ length: 8 }, (_, i) => new THREE.Vector3(...disp(st[Math.min(i, st.length - 1)]![1]))) },
        pos: { value: Array.from({ length: 8 }, (_, i) => st[Math.min(i, st.length - 1)]![0]) }, ns: { value: st.length },
        uShape: { value: SHAPES[o.shape ?? 'glow'] }, uFeather: { value: o.feather ?? 0.1 },
        uHasSprite: { value: !!o.sprite }, uSprite: { value: o.sprite ?? null },
      },
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.scene.add(this.mesh);
  }

  /** Put the comp-px particles into three's metres for this space (a layer's source() does it for you). */
  place(space: Space) {
    const [ox, oy, oz] = space.origin, k = 1 / space.ppm;
    this.mesh.matrix.makeScale(k, -k, -k).multiply(new THREE.Matrix4().makeTranslation(-ox, -oy, -oz));
    this.mesh.matrixWorldNeedsUpdate = true;
    this.mat.uniforms.uPpm!.value = space.ppm;
    return this;
  }

  /** Pose for source time t. */
  update(t: number) { this.mat.uniforms.uT!.value = t; }

  /** As a layer: { name, three: particles.source(comp.space), mode: 'add' }. */
  source(space: Space): ThreeSource {
    this.place(space);
    return { scene: this.scene, update: (t) => this.update(t), occlude: false };
  }

  dispose() { this.mesh.geometry.dispose(); this.mat.dispose(); }
}

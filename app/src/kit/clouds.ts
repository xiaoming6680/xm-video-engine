// A cloud slab (from Still_Shining v10, 云海): broken cumulus between two heights, raymarched per pixel at half
// resolution, to be laid over a rendered world (premultiplied: comp.draw(..., { mode: 'normal', premult: false })).
// Shapes from tileable Perlin-Worley noise (Schneider, "The Real-time Volumetric Cloudscapes of Horizon Zero Dawn",
// SIGGRAPH 2015): a coverage field says where clouds are, the shape noise carves them, a finer Worley noise erodes
// their edges (wispy bases, billowing tops). Light: a short march toward the sun (self-shadowing), three octaves of
// approximate multiple scattering, a two-lobe phase (silver linings looking into the sun), deep scattering so the
// inside of a cloud is bright, ambient from above and below, and the haze between the camera and the cloud. The ray
// start is jittered per pixel and sub-frame: the motion-blur average (render-par --samples auto) removes the noise;
// single-sample stills look grainy (use --samples 8+).
// Units: the field is built in metres (cumulus ~0.5-2 km); `scale` = world units per metre for other worlds.
// Cost: ~7 ms per sub-frame at 1080x1920 (half-res march), nothing when coverage is 0.
//   const clouds = new Clouds(); clouds.init(renderer);                       // bakes two noise volumes (~0.1 s)
//   if (clouds.render(renderer, cam, { ...CLOUDS_DEFAULT, cov: 0.5 }, cloudLight(sunDir, 3, 1, 0.9), t, f.t * 13.7))
//     comp.draw(renderer, clouds.rt.texture, worldRT, { mode: 'normal', premult: false });
// Still_Shining's ss_main.ts (cloudAt) shows a coverage schedule, a cloud placed on a falling character's path
// (`bump`) and mist on the character inside it.
import * as THREE from 'three';
import { FSPass, makeRT, W, H } from '../engine/gl';

const SHAPE = 128, DETAIL = 32;

// ------------------------------------------------------------------ the noise volumes (made once on the GPU)
const NOISE_FRAG = /* glsl */ `
uniform float uRes, uTiles;
uniform int uMode;
vec3 h33(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}
float worley(vec3 p, float per) {
  vec3 id = floor(p), f = fract(p);
  float d = 1.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(x, y, z);
    vec3 r = o + h33(mod(id + o, per)) - f;
    d = min(d, dot(r, r));
  }
  return sqrt(d);
}
vec3 g33(vec3 c) { return normalize(h33(c) * 2.0 - 1.0 + 1e-4); }
float perlin(vec3 p, float per) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(g33(mod(i, per)), f);
  float n100 = dot(g33(mod(i + vec3(1, 0, 0), per)), f - vec3(1, 0, 0));
  float n010 = dot(g33(mod(i + vec3(0, 1, 0), per)), f - vec3(0, 1, 0));
  float n110 = dot(g33(mod(i + vec3(1, 1, 0), per)), f - vec3(1, 1, 0));
  float n001 = dot(g33(mod(i + vec3(0, 0, 1), per)), f - vec3(0, 0, 1));
  float n101 = dot(g33(mod(i + vec3(1, 0, 1), per)), f - vec3(1, 0, 1));
  float n011 = dot(g33(mod(i + vec3(0, 1, 1), per)), f - vec3(0, 1, 1));
  float n111 = dot(g33(mod(i + vec3(1, 1, 1), per)), f - vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float wfbm(vec3 v, float per) { return worley(v * per, per) * 0.625 + worley(v * per * 2.0, per * 2.0) * 0.25 + worley(v * per * 4.0, per * 4.0) * 0.125; }
void main() {
  vec2 px = floor(gl_FragCoord.xy);
  float tile = floor(px.x / uRes) + floor(px.y / uRes) * uTiles;
  vec3 v = (vec3(mod(px.x, uRes), mod(px.y, uRes), tile) + 0.5) / uRes;
  if (uMode == 0) {
    float pf = 0.0, a = 1.0, fr = 4.0, nrm = 0.0;
    for (int i = 0; i < 4; i++) { pf += a * perlin(v * fr, fr); nrm += a; a *= 0.5; fr *= 2.0; }
    pf = clamp(pf / nrm * 0.75 + 0.5, 0.0, 1.0);
    float w1 = 1.0 - wfbm(v, 4.0), w2 = 1.0 - wfbm(v, 8.0), w3 = 1.0 - wfbm(v, 16.0);
    fragColor = vec4(clamp(remap(pf, w1 - 1.0, 1.0, 0.0, 1.0), 0.0, 1.0), w1, w2, w3);
  } else {
    fragColor = vec4(1.0 - wfbm(v, 2.0), 1.0 - wfbm(v, 4.0), 1.0 - wfbm(v, 8.0), 1.0);
  }
}`;

/** Bake a tileable noise volume (res^3, RGBA8) on the GPU through a 2D atlas of its slices, read back into a 3D texture. */
function bakeVolume(renderer: THREE.WebGLRenderer, res: number, mode: number) {
  const tiles = Math.ceil(Math.sqrt(res));
  const rows = Math.ceil(res / tiles);
  const rt = new THREE.WebGLRenderTarget(res * tiles, res * rows, { type: THREE.UnsignedByteType, depthBuffer: false });
  const pass = new FSPass(NOISE_FRAG, { uRes: { value: res }, uTiles: { value: tiles }, uMode: { value: mode } });
  pass.render(renderer, rt);
  const atlas = new Uint8Array(rt.width * rt.height * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, atlas);
  rt.dispose();
  const vol = new Uint8Array(res * res * res * 4);
  for (let z = 0; z < res; z++) {
    const tx = (z % tiles) * res, ty = Math.floor(z / tiles) * res;
    for (let y = 0; y < res; y++) {
      const src = ((ty + y) * rt.width + tx) * 4, dst = (z * res * res + y * res) * 4;
      vol.set(atlas.subarray(src, src + res * 4), dst);
    }
  }
  const tex = new THREE.Data3DTexture(vol, res, res, res);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------------ the march
const MARCH_FRAG = /* glsl */ `
precision highp sampler3D;
uniform mat4 uInvVP;
uniform sampler3D uShape, uDetail;
uniform float uCov, uDens, uCB, uCT, uSeed, uT, uStepsK;
uniform vec4 uBump;                 // where she falls through: x, z, radius (m), extra coverage
uniform vec3 uSunCol, uAmbTop, uAmbBot;
uniform vec2 uWind;                 // drift (m/s)
uniform vec3 uSunDir, uCam, uFogCol;  // toward the sun (unit); camera (world units); the haze colour
uniform float uFogD, uScale;          // haze density (1/m); world units per metre
float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5)); }
float transmit(vec3 p) { return exp(-distance(uCam, p) / uScale * uFogD); }
vec3 fogCol(vec3 d) { return uFogCol; }

float weather(vec2 xz) {
  vec2 q = (xz + uWind * uT) / 21000.0;
  float a = texture(uShape, vec3(q, 0.21)).r, b = texture(uShape, vec3(q * 2.7 + 0.31, 0.63)).g;
  float n = a * 0.7 + b * 0.45;
  // (at coverage 0 the noise alone still peaks into a few clouds: none, so a bump stands alone in a clear sky)
  float c = uCov > 0.001 ? smoothstep(1.02 - uCov, 1.28 - uCov * 0.8, n) : 0.0;
  vec2 d = xz - uBump.xy;
  return max(c, uBump.w * exp(-dot(d, d) / (uBump.z * uBump.z)));
}
float density(vec3 p, float lod) {
  float h = (p.y - uCB) / (uCT - uCB);
  if (h <= 0.0 || h >= 1.0) return 0.0;
  float cov = weather(p.xz);
  if (cov < 0.02) return 0.0;
  // cumulus: a flat, soft base; a rounded top that stands higher where the coverage is denser
  float top = mix(0.42, 1.0, cov);
  float prof = smoothstep(0.0, 0.08, h) * (1.0 - smoothstep(top * 0.72, top, h));
  vec3 sp = (p + vec3(uWind.x, 0.0, uWind.y) * uT) / 2400.0;
  vec4 n = texture(uShape, sp);
  float low = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  float base = remap(n.r, low - 1.0, 1.0, 0.0, 1.0) * prof;
  base = clamp(remap(base, 1.0 - cov, 1.0, 0.0, 1.0), 0.0, 1.0) * cov;
  if (base <= 0.0 || lod > 0.5) return base;
  vec3 dn = texture(uDetail, p / 300.0 + vec3(0.013, -0.021, 0.008) * uT).rgb;
  float hf = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
  // (the texture holds inverted Worley: high = the middle of a billow) eroding where it is high frays the base
  // into wisps; eroding where it is low, higher up, leaves the billows standing (cauliflower tops)
  hf = mix(hf, 1.0 - hf, clamp(h * 3.0, 0.0, 1.0));
  return clamp(remap(base, hf * 0.55, 1.0, 0.0, 1.0), 0.0, 1.0);
}
float toSun(vec3 p) {
  float od = 0.0, st = 28.0;
  vec3 q = p;
  for (int i = 0; i < 6; i++) { q += uSunDir * st; od += density(q, 1.0) * st; st *= 1.75; }
  return od;
}
void main() {
  vec4 a = uInvVP * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rd = normalize(a.xyz / a.w - uCam);
  vec3 cam = uCam / uScale;         // (the field is in metres)
  float tA = 0.0, tB = 0.0;
  if (abs(rd.y) > 1e-5) {
    float t0 = (uCB - cam.y) / rd.y, t1 = (uCT - cam.y) / rd.y;
    tA = max(min(t0, t1), 0.0); tB = max(t0, t1);
  } else if (cam.y > uCB && cam.y < uCT) { tA = 0.0; tB = 1e9; }
  tB = min(tB, 42000.0);
  if (tB <= tA || (uCov <= 0.001 && uBump.w <= 0.001)) { fragColor = vec4(0.0); return; }
  float n = floor(mix(40.0, 72.0, uStepsK));
  float dt = max((tB - tA) / n, 12.0);
  float j = hash12(gl_FragCoord.xy + fract(uSeed * 7.31) * 113.0);
  float t = tA + dt * j;
  float cs = dot(rd, uSunDir);
  vec3 col = vec3(0.0);
  float T = 1.0, dsum = 0.0, wsum = 0.0;
  for (int i = 0; i < 96; i++) {
    if (t > tB || T < 0.008) break;
    vec3 p = cam + rd * t;
    float lod = dt > 220.0 ? 1.0 : 0.0;
    float d = density(p, lod);
    if (d > 0.003) {
      float sig = d * uDens;
      float od = toSun(p) * uDens;
      float h = (p.y - uCB) / (uCT - uCB);
      // three octaves of multiple scattering (Wrenninge): each softer, less attenuated, less forward
      vec3 S = vec3(0.0);
      float ka = 1.0, kb = 1.0, kc = 1.0;
      for (int o = 0; o < 3; o++) {
        float ph = mix(hg(cs, 0.75 * kc), hg(cs, -0.25 * kc), 0.3) * 12.566;
        S += kb * ph * exp(-od * ka);
        ka *= 0.25; kb *= 0.42; kc *= 0.5;
      }
      // powder: the inside of a cloud is darker where light has not yet scattered (the sunlit rims glow)
      float powder = 1.0 - 0.7 * exp(-sig * 200.0);
      vec3 L = uSunCol * S * powder + mix(uAmbBot, uAmbTop, smoothstep(0.05, 0.95, h));
      // light that has wandered deep inside: a cloud is bright white within, not dark (inside the cloud she falls through)
      L += mix(uSunCol, vec3(luma(uSunCol)), 0.55) * 0.34 * exp(-od * 0.004);
      float Ts = exp(-sig * dt);
      col += T * L * (1.0 - Ts);
      wsum += T * (1.0 - Ts); dsum += T * (1.0 - Ts) * t;
      T *= Ts;
    }
    t += dt;
  }
  if (T > 0.999) { fragColor = vec4(0.0); return; }
  // the haze between us and the clouds (the same air the cities sink into)
  float tm = dsum / max(wsum, 1e-5);
  float tr = transmit((cam + rd * tm) * uScale);
  col = col * tr + fogCol(rd) * (1.0 - T) * (1.0 - tr);
  fragColor = vec4(col, 1.0 - T);
}`;

export interface CloudLook {
  /** 0 = no clouds .. 1 = overcast; ~0.5 = broken cumulus. */
  cov: number;
  /** Extinction per unit density (1/m): ~0.12 gives crisp cumulus edges. */
  dens: number;
  /** The slab (m). */
  base: number;
  top: number;
  /** One cloud forced somewhere (e.g. on a character's path): x, z (m), radius (m), coverage there (0..1). */
  bump: [number, number, number, number];
  /** 0..1: more march steps (close views inside a cloud). */
  steps?: number;
}

export const CLOUDS_DEFAULT: CloudLook = { cov: 0.55, dens: 0.12, base: 2250, top: 2950, bump: [0, 0, 1000, 0], steps: 0.4 };

/** The light on the clouds (linear colours). */
export interface CloudLight {
  /** Toward the sun (unit, world). */
  sunDir: THREE.Vector3;
  /** Sunlight on the clouds (HDR, ~2.6 at full strength). */
  sun: THREE.Color;
  /** Ambient from above (the sky) and from below (the ground / a city's glow at night). */
  ambTop: THREE.Color;
  ambBot: THREE.Color;
  /** The haze between camera and cloud: colour and density (1/m, ~1e-5 .. 1e-4). */
  fog: THREE.Color;
  fogDensity: number;
}

/**
 * A ready light from the sun's elevation (deg), strength (0..1) and the day (0 night .. 1 day): white-gold high,
 * orange-pink at the horizon, red under it (lighting cloud bases from below), gone under -3 deg; the sky's blue from
 * above by day; a sodium city glow from below by night (`city`, 0..1).
 */
export function cloudLight(sunDir: THREE.Vector3, elevDeg: number, strength: number, day: number, city = 1, fog = new THREE.Color(0.18, 0.24, 0.42), fogDensity = 2e-5): CloudLight {
  const e = elevDeg;
  const warm = THREE.MathUtils.clamp((6 - e) / 7, 0, 1);
  const below = THREE.MathUtils.clamp(-e / 2, 0, 1);
  const k = THREE.MathUtils.clamp((e + 3.2) / 3.2, 0, 1) ** 1.5 * Math.min(1, strength);
  const d = THREE.MathUtils.clamp(day, 0, 1);
  return {
    sunDir: sunDir.clone().normalize(),
    sun: new THREE.Color(1.0, 0.86 - 0.3 * warm - 0.16 * below, 0.72 - 0.42 * warm - 0.12 * below).multiplyScalar(2.6 * k),
    ambTop: new THREE.Color(0.045, 0.085, 0.24).multiplyScalar(0.2 + 1.1 * d),
    ambBot: new THREE.Color(0.05, 0.06, 0.12).multiplyScalar(0.3 + 0.9 * d).add(new THREE.Color(0.42, 0.24, 0.1).multiplyScalar(0.22 * city * (1 - d))),
    fog, fogDensity,
  };
}

export class Clouds {
  rt = makeRT(W / 2, H / 2, { depthBuffer: false });
  /** World units per metre (the field is built in metres). */
  scale = 1;
  private shape: THREE.Data3DTexture | null = null;
  private detail: THREE.Data3DTexture | null = null;
  private invVP = new THREE.Matrix4();
  private pass = new FSPass(MARCH_FRAG, {
    uInvVP: { value: this.invVP }, uShape: { value: null }, uDetail: { value: null },
    uCov: { value: 0.5 }, uDens: { value: 0.04 }, uCB: { value: 2250 }, uCT: { value: 2950 }, uSeed: { value: 0 }, uT: { value: 0 }, uStepsK: { value: 0.4 },
    uBump: { value: new THREE.Vector4() }, uSunCol: { value: new THREE.Vector3() }, uAmbTop: { value: new THREE.Vector3() }, uAmbBot: { value: new THREE.Vector3() },
    uWind: { value: new THREE.Vector2(6, -3) },
    uSunDir: { value: new THREE.Vector3(0, 0.05, -1) }, uCam: { value: new THREE.Vector3() }, uFogCol: { value: new THREE.Vector3() },
    uFogD: { value: 2e-5 }, uScale: { value: 1 },
  });

  /** Bake the two noise volumes (once). */
  init(renderer: THREE.WebGLRenderer) {
    this.shape = bakeVolume(renderer, SHAPE, 0);
    this.detail = bakeVolume(renderer, DETAIL, 1);
    this.pass.u.uShape!.value = this.shape;
    this.pass.u.uDetail!.value = this.detail;
  }

  /**
   * March the clouds for camera `cam` into this.rt (premultiplied colour, alpha = cover). `t`: time for the drift
   * (s); `seed`: changes per sub-frame (e.g. f.t * 13.7). Returns false (nothing drawn) when there are no clouds.
   */
  render(renderer: THREE.WebGLRenderer, cam: THREE.PerspectiveCamera, c: CloudLook, l: CloudLight, t: number, seed: number) {
    if (c.cov <= 0.001 && c.bump[3] <= 0.001) return false;
    const u = this.pass.u;
    cam.updateMatrixWorld(true);
    this.invVP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert();
    u.uCov!.value = c.cov; u.uDens!.value = c.dens; u.uCB!.value = c.base; u.uCT!.value = c.top;
    u.uSeed!.value = seed; u.uT!.value = t; u.uStepsK!.value = c.steps ?? 0.4; u.uScale!.value = this.scale;
    (u.uBump!.value as THREE.Vector4).set(...c.bump);
    (u.uSunDir!.value as THREE.Vector3).copy(l.sunDir).normalize();
    (u.uCam!.value as THREE.Vector3).copy(cam.getWorldPosition(new THREE.Vector3()));
    (u.uSunCol!.value as THREE.Vector3).set(l.sun.r, l.sun.g, l.sun.b);
    (u.uAmbTop!.value as THREE.Vector3).set(l.ambTop.r, l.ambTop.g, l.ambTop.b);
    (u.uAmbBot!.value as THREE.Vector3).set(l.ambBot.r, l.ambBot.g, l.ambBot.b);
    (u.uFogCol!.value as THREE.Vector3).set(l.fog.r, l.fog.g, l.fog.b);
    u.uFogD!.value = l.fogDensity;
    this.pass.render(renderer, this.rt);
    return true;
  }
}

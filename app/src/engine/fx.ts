// Full-screen 2D effects (from Still_Shining): sky gradient, a sun with a thin star, airflow streaks, letters
// used as windows into the picture, a grade, focus lines, relight, puddle reflections, blit. All colours linear.
// Colours and amounts are parameters; PAL is Still_Shining's palette, kept only as an example.
import * as THREE from 'three';
import { FSPass, Layer2D, W, H, makeRT } from './gl';

/** sRGB hex -> linear rgb. */
export function lin(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  const f = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}

/** Example palette (Still_Shining: cobalt, ultramarine, sky cyan, peach dawn, crimson). Projects define their own. */
export const PAL = {
  night: lin('#050c2a'),
  ultra: lin('#0b1f66'),
  cobalt: lin('#1b3fa0'),
  sky: lin('#8fd6ff'),
  pale: lin('#d8f0ff'),
  peach: lin('#f2b8a8'),
  gold: lin('#ffd59a'),
  white: [1, 1, 1] as [number, number, number],
  crimson: lin('#d0202e'),
};

const v3 = (c: [number, number, number]) => new THREE.Vector3(...c);

export interface SkyOpts {
  /** Colours from the zenith to the horizon band. */
  top: [number, number, number];
  mid: [number, number, number];
  horizon: [number, number, number];
  /** A point on the horizon line (screen px) and the frame's roll (radians): the horizon is perpendicular to "up". */
  hx: number;
  hy: number;
  roll?: number;
  /** Below the horizon (when no city covers it). */
  below?: [number, number, number];
  /** Thickness of the bright horizon band (px). */
  band?: number;
  /** Mirror: the lower half is the upper half reflected (the cover's two cities share one sky). */
  mirror?: boolean;
  /** Stars 0..1. */
  stars?: number;
  t?: number;
}

/** Vertical sky gradient with a bright horizon band, optional stars. Overwrites the target. */
export class Sky {
  pass = new FSPass(/* glsl */ `
    uniform vec3 top, mid, hor, below; uniform vec2 h; uniform float roll, band, stars, mirror, t;
    void main() {
      vec2 p = vUv * vec2(${W}.0, ${H}.0); p.y = ${H}.0 - p.y;           // screen px, y down
      vec2 up = vec2(sin(roll), -cos(roll));
      float d = dot(p - h, up);                                          // px above the horizon
      if (mirror > 0.5) d = abs(d);
      vec3 c;
      if (d >= 0.0) {
        float k = clamp(d / ${H}.0, 0.0, 1.0);
        c = mix(hor, mid, smoothstep(0.0, 0.22, k));
        c = mix(c, top, smoothstep(0.18, 0.95, k));
      } else {
        c = mix(hor, below, smoothstep(0.0, 120.0, -d));
      }
      // the bright band hugs the horizon on both sides (no step where the sky meets what is below it)
      c += hor * 1.6 * exp(-abs(d) / max(band * (d >= 0.0 ? 1.0 : 0.5), 1.0));
      // stars: sparse, hashed on a rotating grid so they turn with the frame
      if (stars > 0.0) {
        vec2 q = vec2(dot(p - h, vec2(up.y, -up.x)), d) / 3.0;
        vec2 cell = floor(q), f = fract(q) - 0.5;
        float r = hash12(cell);
        float s = step(0.9965, r) * smoothstep(0.32, 0.0, length(f)) * smoothstep(80.0, 400.0, d);
        c += vec3(0.8, 0.9, 1.0) * s * stars * (0.6 + 0.4 * sin(t * 3.0 + r * 50.0));
      }
      fragColor = vec4(c, 1.0);
    }`, {
    top: { value: new THREE.Vector3() }, mid: { value: new THREE.Vector3() }, hor: { value: new THREE.Vector3() }, below: { value: new THREE.Vector3() },
    h: { value: new THREE.Vector2() }, roll: { value: 0 }, band: { value: 30 }, stars: { value: 0 }, mirror: { value: 0 }, t: { value: 0 },
  });
  render(renderer: THREE.WebGLRenderer, out: THREE.WebGLRenderTarget, o: SkyOpts) {
    const u = this.pass.u;
    (u.top!.value as THREE.Vector3).set(...o.top);
    (u.mid!.value as THREE.Vector3).set(...o.mid);
    (u.hor!.value as THREE.Vector3).set(...o.horizon);
    (u.below!.value as THREE.Vector3).set(...(o.below ?? o.mid));
    (u.h!.value as THREE.Vector2).set(o.hx, o.hy);
    u.roll!.value = o.roll ?? 0;
    u.band!.value = o.band ?? 30;
    u.stars!.value = o.stars ?? 0;
    u.mirror!.value = o.mirror ? 1 : 0;
    u.t!.value = o.t ?? 0;
    this.pass.render(renderer, out);
  }
}

export interface SunOpts {
  x: number;
  y: number;
  /** Core radius (px) and overall strength. */
  r?: number;
  k?: number;
  /** Star: number of ray pairs, their length (px), rotation. */
  rays?: number;
  len?: number;
  rot?: number;
  /** Colour of the glow (the core is white). */
  color?: [number, number, number];
}

/** The cover's sun: a white-hot core, a soft glow, and a thin crisp star. Additive. */
export class Sun {
  pass = new FSPass(/* glsl */ `
    uniform vec2 c; uniform float r, k, rays, len, rot; uniform vec3 col;
    void main() {
      vec2 p = vUv * vec2(${W}.0, ${H}.0); p.y = ${H}.0 - p.y;
      vec2 d = p - c;
      float L = length(d);
      float core = smoothstep(r, r * 0.55, L);
      float glow = exp(-L / (r * 3.0)) * 0.9 + exp(-L / (r * 14.0)) * 0.35;
      float a = atan(d.y, d.x) - rot;
      float star = 0.0;
      if (rays > 0.0) {
        float m = abs(cos(a * rays));                       // 2*rays spikes
        float thin = pow(m, 900.0) + 0.35 * pow(abs(cos(a * rays + 1.5708 / rays)), 2400.0);
        star = thin * exp(-L / len) * smoothstep(r * 0.4, r * 1.2, L) * 2.2;
      }
      vec3 o = vec3(1.0) * core * 6.0 + col * (glow + star);
      fragColor = vec4(o * k, 0.0);
    }`, { c: { value: new THREE.Vector2() }, r: { value: 12 }, k: { value: 1 }, rays: { value: 4 }, len: { value: 300 }, rot: { value: 0 }, col: { value: new THREE.Vector3(1, 0.9, 0.8) } },
  { blending: THREE.AdditiveBlending, transparent: true });
  render(renderer: THREE.WebGLRenderer, out: THREE.WebGLRenderTarget, o: SunOpts) {
    const u = this.pass.u;
    (u.c!.value as THREE.Vector2).set(o.x, o.y);
    u.r!.value = o.r ?? 12;
    u.k!.value = o.k ?? 1;
    u.rays!.value = o.rays ?? 4;
    u.len!.value = o.len ?? 300;
    u.rot!.value = o.rot ?? 0.12;
    (u.col!.value as THREE.Vector3).set(...(o.color ?? [1, 0.88, 0.75]));
    this.pass.render(renderer, out);
  }
}

export interface StreakOpts {
  /** Direction the streaks travel on screen (unit-ish), speed px/s, length px. */
  dir: [number, number];
  speed: number;
  len?: number;
  /** Lane spacing px (density), opacity, colour, time. */
  lane?: number;
  k?: number;
  color?: [number, number, number];
  t: number;
  /** Keep the centre clear (0..1 radius fraction): a focus line look. */
  clear?: number;
  seed?: number;
}

/** Airflow streaks (流線): thin bright dashes in lanes moving along `dir`. Additive. */
export class Streaks {
  pass = new FSPass(/* glsl */ `
    uniform vec2 dir; uniform float speed, len, lane, k, t, clearR, seed; uniform vec3 col;
    void main() {
      vec2 p = vUv * vec2(${W}.0, ${H}.0); p.y = ${H}.0 - p.y;
      vec2 D = normalize(dir), N = vec2(-D.y, D.x);
      float along = dot(p, D), across = dot(p, N);
      float li = floor(across / lane);
      float r1 = hash12(vec2(li, seed)), r2 = hash12(vec2(li, seed + 7.1)), r3 = hash12(vec2(li, seed + 3.3));
      if (r1 < 0.55) { fragColor = vec4(0.0); return; }
      float off = (across - (li + 0.5) * lane) / (0.6 + 1.6 * r2);
      float w = exp(-off * off * 1.6);
      float period = len * (2.5 + 5.0 * r3);
      float s = mod(along - t * speed * (0.6 + 0.8 * r2) + r1 * 5000.0, period);
      float seg = smoothstep(0.0, len * 0.15, s) * smoothstep(len, len * 0.35, s);
      vec2 c = p - vec2(${W / 2}.0, ${H / 2}.0);
      float cl = clearR > 0.0 ? smoothstep(clearR * ${H / 2}.0, clearR * ${H / 2}.0 * 1.6, length(c)) : 1.0;
      fragColor = vec4(col * w * seg * k * cl * (0.5 + 0.5 * r3), 0.0);
    }`, { dir: { value: new THREE.Vector2(0, -1) }, speed: { value: 1000 }, len: { value: 160 }, lane: { value: 9 }, k: { value: 0.4 }, t: { value: 0 }, clearR: { value: 0 }, seed: { value: 0 }, col: { value: new THREE.Vector3(0.8, 0.9, 1) } },
  { blending: THREE.AdditiveBlending, transparent: true });
  render(renderer: THREE.WebGLRenderer, out: THREE.WebGLRenderTarget, o: StreakOpts) {
    const u = this.pass.u;
    (u.dir!.value as THREE.Vector2).set(...o.dir);
    u.speed!.value = o.speed;
    u.len!.value = o.len ?? 160;
    u.lane!.value = o.lane ?? 9;
    u.k!.value = o.k ?? 0.4;
    u.t!.value = o.t;
    u.clearR!.value = o.clear ?? 0;
    u.seed!.value = o.seed ?? 0;
    (u.col!.value as THREE.Vector3).set(...(o.color ?? [0.8, 0.9, 1]));
    this.pass.render(renderer, out);
  }
}

/**
 * Letters as windows: give `src` (the composed picture) and a mask layer (white glyphs on transparent), get the
 * picture with the letters lifted (brighter, washed toward `tint`, default pale cyan) and the rest dimmed.
 */
export class WindowLetters {
  mask = new Layer2D();
  pass = new FSPass(/* glsl */ `
    uniform sampler2D src, m; uniform float k, lift, gain, dim; uniform vec3 tint;
    // inside: the same picture brighter and pushed toward saturated sky blue plus a cyan glow (the cover's letters
    // are vivid blue going white at the horizon, never grey); outside: darker, deeper blue
    void main() {
      vec3 c = texture(src, vUv).rgb;
      float a = texture(m, vUv).a * k;
      vec3 inside = c * gain * vec3(0.72, 0.95, 1.25) + lift * tint;
      vec3 outside = c * mix(1.0, dim, k) * mix(vec3(1.0), vec3(0.78, 0.88, 1.0), k);
      fragColor = vec4(mix(outside, inside, a), 1.0);
    }`, { src: { value: null }, m: { value: null }, k: { value: 1 }, lift: { value: 0.16 }, gain: { value: 1.9 }, dim: { value: 0.55 }, tint: { value: new THREE.Vector3(0.3, 0.68, 1.0) } });
  render(renderer: THREE.WebGLRenderer, src: THREE.Texture, out: THREE.WebGLRenderTarget, k = 1, o: { lift?: number; gain?: number; dim?: number } = {}) {
    const u = this.pass.u;
    u.src!.value = src;
    u.m!.value = this.mask.texture;
    u.k!.value = k;
    u.lift!.value = o.lift ?? 0.16;
    u.gain!.value = o.gain ?? 1.9;
    u.dim!.value = o.dim ?? 0.55;
    this.pass.render(renderer, out);
  }
}

/** A scratch HDR target per scene (compose layers here, then filter into `out`). */
export const scratch = () => makeRT(W, H, { depthBuffer: false });
export { v3 };

/**
 * Grade a composed picture into `out`: saturation with an edge-in wipe (C6: the world goes grey from the frame
 * edges inward) that spares the red of Teto's hair, plus exposure and a tint.
 */
export class Grade {
  pass = new FSPass(/* glsl */ `
    uniform sampler2D src; uniform float satur, keepRed, wipe, exposure; uniform vec3 tint;
    void main() {
      vec3 c = texture(src, vUv).rgb * exposure;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float red = clamp((c.r - max(c.g, c.b)) / max(c.r, 1e-4) * 2.5 - 0.6, 0.0, 1.0) * keepRed;
      vec2 q = (vUv - 0.5) * vec2(${W / H}, 1.0);
      float r = length(q) / 1.02;                                // 0 centre .. ~1 corners
      float inGrey = smoothstep(wipe - 0.12, wipe + 0.02, r);    // wipe 1.1 -> -0.2: grey sweeps inward
      float g = (1.0 - satur) * inGrey * (1.0 - red);
      c = mix(c, vec3(l) * tint, g);
      fragColor = vec4(c, 1.0);
    }`, { src: { value: null }, satur: { value: 1 }, keepRed: { value: 1 }, wipe: { value: -1 }, exposure: { value: 1 }, tint: { value: new THREE.Vector3(1, 1, 1) } });
  render(renderer: THREE.WebGLRenderer, src: THREE.Texture, out: THREE.WebGLRenderTarget, o: { sat?: number; keepRed?: number; wipe?: number; exposure?: number; tint?: [number, number, number] }) {
    const u = this.pass.u;
    u.src!.value = src;
    u.satur!.value = o.sat ?? 1;
    u.keepRed!.value = o.keepRed ?? 0;
    u.wipe!.value = o.wipe ?? -1;
    u.exposure!.value = o.exposure ?? 1;
    (u.tint!.value as THREE.Vector3).set(...(o.tint ?? [1, 1, 1]));
    this.pass.render(renderer, out);
  }
}

/** Focus lines (集中線) rushing outward from a centre: radial lanes of thin dashes. Additive. */
export class Radial {
  pass = new FSPass(/* glsl */ `
    uniform vec2 c; uniform float n, speed, len, k, t, inner; uniform vec3 col;
    void main() {
      vec2 p = vUv * vec2(${W}.0, ${H}.0); p.y = ${H}.0 - p.y;
      vec2 d = p - c;
      float r = length(d);
      float a = atan(d.y, d.x) / 6.2831853 + 0.5;
      float lane = floor(a * n);
      float h1 = hash12(vec2(lane, 3.7)), h2 = hash12(vec2(lane, 9.1));
      if (h1 < 0.45) { fragColor = vec4(0.0); return; }
      float off = abs(fract(a * n) - 0.5) * 2.0;
      float w = smoothstep(0.35 + 0.4 * h2, 0.0, off);
      float period = len * (2.0 + 4.0 * h2);
      float s = mod(r - t * speed * (0.7 + 0.6 * h1) + h1 * 3000.0, period);
      float seg = smoothstep(0.0, len * 0.2, s) * smoothstep(len, len * 0.4, s);
      float fadeIn = smoothstep(inner, inner * 1.8, r);
      fragColor = vec4(col * w * seg * fadeIn * k * (0.4 + 0.6 * h2), 0.0);
    }`, { c: { value: new THREE.Vector2(W / 2, H / 2) }, n: { value: 220 }, speed: { value: 2000 }, len: { value: 260 }, k: { value: 0.5 }, t: { value: 0 }, inner: { value: 200 }, col: { value: new THREE.Vector3(1, 0.95, 0.9) } },
  { blending: THREE.AdditiveBlending, transparent: true });
  render(renderer: THREE.WebGLRenderer, out: THREE.WebGLRenderTarget, o: { x: number; y: number; t: number; k?: number; speed?: number; len?: number; n?: number; inner?: number; color?: [number, number, number] }) {
    const u = this.pass.u;
    (u.c!.value as THREE.Vector2).set(o.x, o.y);
    u.t!.value = o.t;
    u.k!.value = o.k ?? 0.5;
    u.speed!.value = o.speed ?? 2000;
    u.len!.value = o.len ?? 260;
    u.n!.value = o.n ?? 220;
    u.inner!.value = o.inner ?? 200;
    (u.col!.value as THREE.Vector3).set(...(o.color ?? [1, 0.95, 0.9]));
    this.pass.render(renderer, out);
  }
}

/**
 * The relight (C9): picture `on` replaces picture `off` inside a growing ring around a centre, block by block (a
 * cellular edge, like districts coming back), with a warm glow riding the wave front. Writes `out`.
 */
export class Relight {
  pass = new FSPass(/* glsl */ `
    uniform sampler2D a, b; uniform vec2 c; uniform float R, cell, glow;
    void main() {
      vec2 p = vUv * vec2(${W}.0, ${H}.0); p.y = ${H}.0 - p.y;
      vec3 off = texture(a, vUv).rgb, on = texture(b, vUv).rgb;
      vec2 g = floor(p / cell);
      float jitter = (hash12(g) - 0.5) * cell * 3.0;
      float d = length(p - c) + jitter;
      float m = step(d, R);
      float front = exp(-abs(d - R) / (cell * 1.5)) * step(0.0, R);
      vec3 col = mix(off, on, m) + vec3(1.0, 0.7, 0.4) * front * glow * (0.4 + 0.6 * m);
      fragColor = vec4(col, 1.0);
    }`, { a: { value: null }, b: { value: null }, c: { value: new THREE.Vector2() }, R: { value: -1 }, cell: { value: 26 }, glow: { value: 0.6 } });
  render(renderer: THREE.WebGLRenderer, off: THREE.Texture, on: THREE.Texture, out: THREE.WebGLRenderTarget, o: { x: number; y: number; R: number; cell?: number; glow?: number }) {
    const u = this.pass.u;
    u.a!.value = off;
    u.b!.value = on;
    (u.c!.value as THREE.Vector2).set(o.x, o.y);
    u.R!.value = o.R;
    u.cell!.value = o.cell ?? 26;
    u.glow!.value = o.glow ?? 0.6;
    this.pass.render(renderer, out);
  }
}

/**
 * A puddle on the ground (C21): inside an ellipse, the frame above it mirrored about the ground line (screen-space
 * reflection of `src`), darkened and tinted by the sky, with ripple rings from drops. Blends over `out`.
 */
export class Puddle {
  pass = new FSPass(/* glsl */ `
    uniform sampler2D src; uniform vec2 c, r; uniform float y0, t; uniform vec4 drops[6];
    void main() {
      vec2 p = vUv * vec2(${W}.0, ${H}.0); p.y = ${H}.0 - p.y;
      vec2 q = (p - c) / r;
      float m = 1.0 - smoothstep(0.82, 1.0, length(q + 0.08 * vec2(sin(q.y * 7.0), cos(q.x * 5.0))));
      if (m <= 0.0) { fragColor = vec4(0.0); return; }
      vec2 off = vec2(0.0);
      for (int i = 0; i < 6; i++) {
        vec4 d = drops[i];                       // xy: centre px, z: birth time, w: strength
        float age = t - d.z;
        if (age < 0.0 || age > 1.6 || d.w <= 0.0) continue;
        vec2 dv = (p - d.xy) * vec2(1.0, 3.2);
        float rr = length(dv);
        float ring = sin((rr - age * 260.0) * 0.12) * exp(-age * 2.2) * smoothstep(age * 260.0 + 60.0, age * 260.0 - 10.0, rr);
        off += normalize(dv + 1e-3) * ring * 6.0 * d.w;
      }
      vec2 sp = vec2(p.x + off.x, 2.0 * y0 - p.y + off.y * 3.0);
      vec3 col = texture(src, vec2(sp.x / ${W}.0, 1.0 - sp.y / ${H}.0)).rgb * vec3(0.72, 0.8, 0.95);
      fragColor = vec4(col * m, m);
    }`, { src: { value: null }, c: { value: new THREE.Vector2() }, r: { value: new THREE.Vector2(300, 60) }, y0: { value: 800 }, t: { value: 0 }, drops: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) } },
  { blending: THREE.CustomBlending, transparent: true });
  constructor() {
    const m = this.pass.mat;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
  }
  render(renderer: THREE.WebGLRenderer, src: THREE.Texture, out: THREE.WebGLRenderTarget, o: { x: number; y: number; rx: number; ry: number; y0: number; t: number; drops: [number, number, number, number][] }) {
    const u = this.pass.u;
    u.src!.value = src;
    (u.c!.value as THREE.Vector2).set(o.x, o.y);
    (u.r!.value as THREE.Vector2).set(o.rx, o.ry);
    u.y0!.value = o.y0;
    u.t!.value = o.t;
    const ds = u.drops!.value as THREE.Vector4[];
    for (let i = 0; i < 6; i++) ds[i]!.set(...(o.drops[i] ?? [0, 0, 0, 0]));
    this.pass.render(renderer, out);
  }
}

/** Copy a texture into a target (overwrite). */
export class Blit {
  pass = new FSPass(`uniform sampler2D src; void main(){ fragColor = texture(src, vUv); }`, { src: { value: null } });
  render(renderer: THREE.WebGLRenderer, src: THREE.Texture, out: THREE.WebGLRenderTarget) { this.pass.u.src!.value = src; this.pass.render(renderer, out); }
}

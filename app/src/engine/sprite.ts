// 2D multiplane layers for cut-out sprites (from Still_Shining): transparent PNGs (e.g. Codex images cleaned by
// tools/clean_alpha.py) drawn as textured meshes in logical px, with
//   * a bendable mesh: a masked region (hair, cloth, a flag: `mask` in loadTex, default = saturated red pixels,
//     made for Teto's twintails) sways in the wind and streams against the motion, farther from its root more
//     (follow-through), plus an optional whole-sprite wobble;
//   * per-layer grading: exposure, tint, saturation that can keep the reds (`keepRed`), fog toward a
//     colour (aerial depth), mip-bias blur (depth of field);
//   * a 2D camera (Cam2D) that projects layers at different depths for parallax.
// Output is premultiplied linear colour blended over the target (One, OneMinusSrcAlpha).
import * as THREE from 'three';
import { W, H } from './gl';

export interface Tex {
  url: string;
  tex: THREE.Texture;
  /** Image size in px. */
  w: number;
  h: number;
  /** Low-res deform mask (loadTex `mask`; default: saturated red), sampled in the vertex shader. */
  hair: THREE.DataTexture;
  /** Lowest opaque row (v, 0..1 from the top): where her soles are in a standing drawing — anchor with ay: footV. */
  footV: number;
}

const texCache = new Map<string, Promise<Tex>>();

/** Per-pixel deform weight 0..1 from straight (non-premultiplied) r, g, b in 0..1. */
export type MaskFn = (r: number, g: number, b: number) => number;
/** Default mask: red-dominant, saturated pixels (Teto's twintails in Still_Shining). */
export const redMask: MaskFn = (r, g, b) => (r > 0.22 && r > g * 1.9 && r > b * 1.5 ? Math.min(1, (r - Math.max(g, b)) * 3) : 0);
/** No deforming region (the whole sprite stays rigid; `wobble` still works). */
export const noMask: MaskFn = () => 0;

/**
 * Load an image (url relative to the app root, e.g. 'assets/clean/ch_fall.png') as a mipmapped sRGB texture.
 * `mask` picks the region that sways (hair, cloth…); textures are cached per url + mask.
 */
export function loadTex(url: string, mask: MaskFn = redMask): Promise<Tex> {
  const key = mask === redMask ? url : `${url}#${mask.name || mask.toString()}`;
  let p = texCache.get(key);
  if (!p) {
    p = (async () => {
      const img = new Image();
      img.src = url;
      await img.decode();
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = false;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = 8;
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      return { url, tex, w: img.naturalWidth, h: img.naturalHeight, hair: hairMask(img, mask), footV: lowestRow(img) };
    })();
    texCache.set(key, p);
  }
  return p;
}

/** The lowest row with solid alpha (scanned at 256 px wide), as v. */
function lowestRow(img: HTMLImageElement) {
  const mw = 256, mh = Math.max(8, Math.round((256 * img.naturalHeight) / img.naturalWidth));
  const c = document.createElement('canvas');
  c.width = mw; c.height = mh;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(img, 0, 0, mw, mh);
  const d = x.getImageData(0, 0, mw, mh).data;
  for (let y = mh - 1; y >= 0; y--) {
    let n = 0;
    for (let i = 0; i < mw; i++) if (d[(y * mw + i) * 4 + 3]! > 128) n++;
    if (n >= 2) return (y + 1) / mh;
  }
  return 1;
}

/** The deform mask (`mask` per pixel, times alpha; limit it further with `region`), blurred, 96 px wide. */
function hairMask(img: HTMLImageElement, mask: MaskFn) {
  const mw = 96, mh = Math.max(8, Math.round((96 * img.naturalHeight) / img.naturalWidth));
  const c = document.createElement('canvas');
  c.width = mw; c.height = mh;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(img, 0, 0, mw, mh);
  const d = x.getImageData(0, 0, mw, mh).data;
  let m = new Float32Array(mw * mh);
  for (let i = 0; i < mw * mh; i++) {
    const r = d[i * 4]! / 255, g = d[i * 4 + 1]! / 255, b = d[i * 4 + 2]! / 255, a = d[i * 4 + 3]! / 255;
    m[i] = mask(r, g, b) * a;
  }
  for (let pass = 0; pass < 2; pass++) { // 3x3 box blur twice
    const o = new Float32Array(mw * mh);
    for (let y = 0; y < mh; y++) for (let xx = 0; xx < mw; xx++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, x2 = xx + dx;
        if (yy < 0 || yy >= mh || x2 < 0 || x2 >= mw) continue;
        s += m[yy * mw + x2]!; n++;
      }
      o[y * mw + xx] = s / n;
    }
    m = o;
  }
  const u8 = new Uint8Array(mw * mh);
  for (let i = 0; i < u8.length; i++) u8[i] = Math.round(Math.min(1, m[i]! * 1.6) * 255);
  const t = new THREE.DataTexture(u8, mw, mh, THREE.RedFormat, THREE.UnsignedByteType);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

export interface DrawOpts {
  /** Screen position (logical px) of the anchor. */
  x: number;
  y: number;
  /** Drawn px per image px. */
  scale?: number;
  /** Extra non-uniform scale (squash & stretch; negative flips). */
  sx?: number;
  sy?: number;
  /** Rotation (radians, clockwise on screen). */
  rot?: number;
  /** Anchor in image uv (0..1, y down). */
  ax?: number;
  ay?: number;
  opacity?: number;
  exposure?: number;
  tint?: [number, number, number];
  /** 1 = full colour, 0 = grey. */
  sat?: number;
  /** 0..1: the hair's red ignores `sat` (C6: the world goes grey, Teto's hair stays red). */
  keepRed?: number;
  /** Fog colour (linear) and amount. */
  fog?: [number, number, number, number];
  /** Mip LOD bias: soft focus (0 sharp, 1..4 progressively blurrier). */
  blur?: number;
  /** Additive light (linear rgb) on the sprite's own pixels, e.g. a flash on the subject only. */
  add?: [number, number, number];
  // ------------------------------------------------- mesh deformation (in image px)
  /** Time for the sway. */
  t?: number;
  /** Steady push of the hair (image px at full weight): the airflow, opposite to the motion. */
  wind?: [number, number];
  /** Oscillation across the wind (image px) and its frequency (Hz). */
  wave?: number;
  freq?: number;
  /** Root of the hair in uv (the head): displacement grows with distance from it. */
  pivot?: [number, number];
  /** Ellipse (centre uv, radii uv) limiting the hair deformation (keeps the red tie / boots still). */
  region?: [number, number, number, number];
  /** Whole-sprite wobble amplitude (image px). */
  wobble?: number;
  /** Line boil (tegaki): a fine random warp (image px) that changes with `boilSeed` (step it on the drawing beat). */
  boil?: number;
  boilSeed?: number;
}

const VERT = /* glsl */ `
precision highp float;
in vec3 position;
uniform mat3 uM;
uniform vec2 uSize;
uniform vec2 uScreen;
uniform sampler2D uHair;
uniform float uT, uWave, uFreq, uWobble, uBoil, uBoilSeed;
uniform vec2 uWind, uPivot;
uniform vec4 uRegion;
out vec2 vUv;
void main() {
  vec2 uv = position.xy;
  float w = texture(uHair, uv).r;
  if (uRegion.z > 0.0) w *= 1.0 - smoothstep(0.75, 1.0, length((uv - uRegion.xy) / uRegion.zw));
  float dist = length((uv - uPivot) * uSize) / max(uSize.x, uSize.y);
  float fall = smoothstep(0.02, 0.45, dist);
  float ph = uT * 6.2831853 * uFreq - dist * 10.0;
  float wl = length(uWind);
  vec2 dir = wl > 1e-4 ? uWind / wl : vec2(0.0, -1.0);
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 d = w * fall * (uWind * (0.8 + 0.2 * sin(ph * 0.53 + 1.3)) + perp * uWave * sin(ph));
  d += uWobble * vec2(sin(uT * 1.9 + uv.y * 5.0), cos(uT * 1.5 + uv.x * 4.0));
  if (uBoil > 0.0) {
    float s = uBoilSeed * 7.31;
    d += uBoil * vec2(sin(uv.x * 23.0 + uv.y * 17.0 + s) + 0.5 * sin(uv.y * 41.0 - s * 1.7),
                      cos(uv.y * 21.0 - uv.x * 19.0 + s * 1.3) + 0.5 * cos(uv.x * 37.0 + s * 0.6));
  }
  vec3 sp = uM * vec3(uv * uSize + d, 1.0);
  vec2 clip = sp.xy / uScreen * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vUv = uv;
}`;

const FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uOpacity, uExposure, uSat, uKeepRed, uBias;
uniform vec3 uTint, uAdd;
uniform vec4 uFog;
out vec4 fragColor;
void main() {
  vec4 c = texture(uTex, vUv, uBias);
  vec3 rgb = c.rgb;
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  float red = clamp((rgb.r - max(rgb.g, rgb.b)) * 6.0, 0.0, 1.0) * uKeepRed;
  rgb = mix(vec3(l), rgb, max(uSat, red));
  rgb = rgb * uTint * uExposure + uAdd;
  rgb = mix(rgb, uFog.rgb, uFog.a);
  fragColor = vec4(rgb * c.a, c.a) * uOpacity;
}`;

const geoms = new Map<number, THREE.BufferGeometry>();
function grid(n: number) {
  let g = geoms.get(n);
  if (!g) {
    const pos: number[] = [], idx: number[] = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.push(i / n, j / n, 0);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    geoms.set(n, g);
  }
  return g;
}

const DUMMY_CAM = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

/** One drawable cut-out. Several draws per frame are fine (uniforms are set per draw). */
export class Sprite {
  mat: THREE.RawShaderMaterial;
  scene = new THREE.Scene();
  constructor(public t: Tex, seg = 48) {
    this.mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uM: { value: new THREE.Matrix3() }, uSize: { value: new THREE.Vector2(t.w, t.h) }, uScreen: { value: new THREE.Vector2(W, H) },
        uHair: { value: t.hair }, uT: { value: 0 }, uWave: { value: 0 }, uFreq: { value: 1 }, uWobble: { value: 0 }, uBoil: { value: 0 }, uBoilSeed: { value: 0 },
        uWind: { value: new THREE.Vector2() }, uPivot: { value: new THREE.Vector2(0.5, 0.3) }, uRegion: { value: new THREE.Vector4() },
        uTex: { value: t.tex }, uOpacity: { value: 1 }, uExposure: { value: 1 }, uSat: { value: 1 }, uKeepRed: { value: 0 }, uBias: { value: 0 },
        uTint: { value: new THREE.Vector3(1, 1, 1) }, uAdd: { value: new THREE.Vector3() }, uFog: { value: new THREE.Vector4() },
      },
      depthTest: false, depthWrite: false, transparent: true, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    const mesh = new THREE.Mesh(grid(seg), this.mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }
  get w() { return this.t.w; }
  get h() { return this.t.h; }

  /** Screen position of image uv (u, v) under the same placement as draw(o) (ignores the mesh sway). */
  toScreen(o: DrawOpts, u: number, v: number): [number, number] {
    const s = o.scale ?? 1, sx = s * (o.sx ?? 1), sy = s * (o.sy ?? 1), r = o.rot ?? 0;
    const lx = (u - (o.ax ?? 0.5)) * this.t.w * sx, ly = (v - (o.ay ?? 0.5)) * this.t.h * sy;
    const c = Math.cos(r), sn = Math.sin(r);
    return [o.x + c * lx - sn * ly, o.y + sn * lx + c * ly];
  }

  draw(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null, o: DrawOpts) {
    const u = this.mat.uniforms;
    const s = o.scale ?? 1, sx = s * (o.sx ?? 1), sy = s * (o.sy ?? 1), r = o.rot ?? 0;
    const ax = (o.ax ?? 0.5) * this.t.w, ay = (o.ay ?? 0.5) * this.t.h;
    const c = Math.cos(r), sn = Math.sin(r);
    // screen = T(x,y) R(r) S(sx,sy) T(-ax,-ay) · local
    const a11 = c * sx, a12 = -sn * sy, a21 = sn * sx, a22 = c * sy;
    const tx = o.x - (a11 * ax + a12 * ay), ty = o.y - (a21 * ax + a22 * ay);
    (u.uM!.value as THREE.Matrix3).set(a11, a12, tx, a21, a22, ty, 0, 0, 1);
    u.uT!.value = o.t ?? 0;
    u.uWave!.value = o.wave ?? 0;
    u.uFreq!.value = o.freq ?? 1;
    u.uWobble!.value = o.wobble ?? 0;
    u.uBoil!.value = o.boil ?? 0;
    u.uBoilSeed!.value = o.boilSeed ?? 0;
    (u.uWind!.value as THREE.Vector2).set(o.wind?.[0] ?? 0, o.wind?.[1] ?? 0);
    (u.uPivot!.value as THREE.Vector2).set(o.pivot?.[0] ?? 0.5, o.pivot?.[1] ?? 0.3);
    (u.uRegion!.value as THREE.Vector4).set(...(o.region ?? [0, 0, 0, 0]));
    u.uOpacity!.value = o.opacity ?? 1;
    u.uExposure!.value = o.exposure ?? 1;
    u.uSat!.value = o.sat ?? 1;
    u.uKeepRed!.value = o.keepRed ?? 0;
    u.uBias!.value = o.blur ?? 0;
    (u.uTint!.value as THREE.Vector3).set(...(o.tint ?? [1, 1, 1]));
    (u.uAdd!.value as THREE.Vector3).set(...(o.add ?? [0, 0, 0]));
    (u.uFog!.value as THREE.Vector4).set(...(o.fog ?? [0, 0, 0, 0]));
    renderer.setRenderTarget(target);
    renderer.render(this.scene, DUMMY_CAM);
  }
}

/**
 * 2D camera over a layered world. A layer at depth z moves and scales by zoom / z (z = 1: the focal plane, where
 * world px = screen px at zoom 1; far layers z > 1 move less, near layers z < 1 more). rot spins the frame.
 */
export class Cam2D {
  x = 0;
  y = 0;
  zoom = 1;
  rot = 0;
  set(x: number, y: number, zoom = 1, rot = 0) { this.x = x; this.y = y; this.zoom = zoom; this.rot = rot; return this; }
  /** Screen position and scale of world point (wx, wy) on depth z. */
  project(wx: number, wy: number, z = 1): { x: number; y: number; s: number; rot: number } {
    const s = this.zoom / z;
    const dx = (wx - this.x) * s, dy = (wy - this.y) * s;
    const c = Math.cos(this.rot), sn = Math.sin(this.rot);
    return { x: W / 2 + c * dx - sn * dy, y: H / 2 + sn * dx + c * dy, s, rot: this.rot };
  }
}

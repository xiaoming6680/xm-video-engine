// 预渲染序列帧（plate）当画面：Blender、AE 或别的渲染器出的 PNG / JPG / EXR 序列按歌曲时间取帧，引擎的 2D / 3D 层叠在上面，
// 运动模糊和后期照常走。
//
// 为什么要它：写实的光影、布料、流体这些在网页里实时做不了也不值得做，交给离线渲染器出帧，引擎只管叠字、叠图形、卡点和后期。
// 思路来自 mg-styles-15（MIT）的 demos/04-3d-render：Blender 渲序列帧，网页只叠字和颗粒。
// 卡点：Scene.render 是同步的，整段预载又放不下（1080p 一帧解码后 8 MB，半浮点 EXR 16 MB），所以逐帧预取：
// Scene.prepare(t) 在渲这一帧之前把要用的帧解码、上传成纹理（导出时引擎等它，预览不等、先显示上一张），
// 顺着时间方向多读几帧，LRU 只留几张。
// 序列帧自带运动模糊：一帧之内所有子帧用同一张（shutterT(t, 0)），引擎自己画的东西照常按子帧糊。
// 可选每帧相机 JSON（位置、朝向、fov，可附带物体位置），叠 3D 时用 applyCamera 让引擎的相机和渲染器的对上。
// 序列放在开发服务器服务的目录里（audio、data、assets、refs，见 vite.config.ts）；大序列别进 git。
//
//   class Shot extends PlateScene {                                         // 或时间线 params.plate 直接给参数
//     protected override plateOptions() { return { src: '/assets/plates/shot1/####.png', fps: 24, last: 120, at: this.ctx.start, camera: '/assets/plates/shot1/camera.json' }; }
//     protected override overlay(f: Frame, out: THREE.WebGLRenderTarget) { this.plate.applyCamera(this.cam, f.t); renderInto(this.ctx.renderer, this.world, this.cam, out, null); }
//   }
import * as THREE from 'three';
import { Scene, type Frame, type PostOverrides } from '../../engine/scene';
import { W, H, SUBFRAME, clearRT, type BlendMode, type Compositor } from '../../engine/gl';
import { shutterT } from '../../engine/util';

type V3 = [number, number, number];

/** How the plate fills the frame: crop to fill ('cover'), fit whole with bars ('contain'), or distort ('stretch'). */
export type PlateFit = 'cover' | 'contain' | 'stretch';

export interface PlateOptions {
  /**
   * Frame URL template: a run of '#' is the zero-padded frame number ('/refs/shot1/####.png'), or printf '%04d' / '%d'.
   * PNG and JPG decode with createImageBitmap (sRGB unless `linear`), .exr with three's EXRLoader (half float, linear).
   */
  src: string;
  /** The sequence's frame rate. */
  fps: number;
  /** First and last frame numbers on disk (inclusive). first defaults to 1 (Blender's default start). */
  first?: number;
  last: number;
  /** Song time at which frame `first` shows (default 0; PlateScene uses the entry's start). */
  at?: number;
  /** Playback speed (0.5 = half speed, each frame held twice as long). */
  speed?: number;
  /** Before the first / after the last frame: hold the end frame (default), loop the sequence, or draw nothing. */
  outside?: 'hold' | 'loop' | 'none';
  /** Per-element shutter for picking frames: 0 (default) = one frame for all of an export frame's sub-frames (the
   *  sequence carries its own motion blur); 1 = each sub-frame picks its own (a high-fps sequence rendered sharp). */
  shutter?: number;
  /** How the frames fill the W x H frame (default 'cover'); applyCamera matches it. */
  fit?: PlateFit;
  /** 8-bit images hold linear values, not sRGB (data passes). EXR is always linear. */
  linear?: boolean;
  /** Colour is premultiplied by alpha (default: EXR yes, PNG / JPG no). */
  premultiplied?: boolean;
  /** Decoded frames kept (LRU, default 8) and frames read ahead in the direction time moves (default 2). */
  cache?: number;
  ahead?: number;
  /** URL of the per-frame camera JSON (see PlateCam). */
  camera?: string;
}

/**
 * One frame's camera from the camera JSON: `{ fps?, first?, fov?, axes?, frames: [{ f?, p, q? | at?, up?, fov?, near?,
 * far?, points? }] }`. `f` is the frame number (default: first + index). Three.js conventions (Y up, the camera looks
 * down its −Z, `q` a quaternion [x, y, z, w], `fov` vertical degrees); `"axes": "blender"` takes Blender's Z-up world
 * instead (positions as Blender shows them, `q` from matrix_world, still [x, y, z, w]) and converts. `points`: world
 * positions of things in the shot at that frame (empties, a tracked object), for overlays that stick to them.
 */
export interface PlateCam {
  p: V3;
  q?: [number, number, number, number];
  at?: V3;
  up?: V3;
  fov?: number;
  near?: number;
  far?: number;
  points?: Record<string, V3>;
}

// ------------------------------------------------------------------ pure helpers (tests/plate.test.ts)

/** The URL of frame `n`: the template's '#' run or printf %d / %0Nd replaced by the number. */
export function frameUrl(src: string, n: number): string {
  const hash = /#+/.exec(src);
  if (hash) return src.slice(0, hash.index) + String(n).padStart(hash[0].length, '0') + src.slice(hash.index + hash[0].length);
  const pf = /%(0?)(\d*)d/.exec(src);
  if (pf) return src.slice(0, pf.index) + String(n).padStart(pf[1] ? +(pf[2] || 0) : 0, '0') + src.slice(pf.index + pf[0].length);
  throw new Error(`plate: no frame number in '${src}' (use #### or %04d)`);
}

export type PlateTiming = Pick<PlateOptions, 'fps' | 'first' | 'last' | 'at' | 'speed' | 'outside'>;

/** Frames since `first` at time x, unbounded (the stepped clock: a frame holds from its time until the next one's). */
export function plateIndex(x: number, o: PlateTiming): number {
  return Math.floor((x - (o.at ?? 0)) * o.fps * (o.speed ?? 1) + 1e-6);
}

/** Frame number for an index from plateIndex, after `outside` (null: none shown). */
export function plateNumber(i: number, o: PlateTiming): number | null {
  const first = o.first ?? 1, count = o.last - first + 1;
  if (count <= 0) return null;
  if (i >= 0 && i < count) return first + i;
  const out = o.outside ?? 'hold';
  if (out === 'none') return null;
  if (out === 'loop') return first + (((i % count) + count) % count);
  return i < 0 ? first : o.last;
}

/** The frame number shown at time x (no shutter applied: pass shutterT(t, …) for the time inside a render). */
export function plateFrame(x: number, o: PlateTiming): number | null {
  return plateNumber(plateIndex(x, o), o);
}

/**
 * How much of the frame the plate spans, [sx, sy] (fractions of W and H; above 1 = cropped). `pa` / `fa`: the
 * plate's and the frame's aspect (width / height).
 */
export function fitScale(pa: number, fa: number, fit: PlateFit = 'cover'): [number, number] {
  if (fit === 'stretch' || !(pa > 0) || Math.abs(pa - fa) < 1e-9) return [1, 1];
  const wider = pa > fa;
  if (fit === 'cover') return wider ? [pa / fa, 1] : [1, fa / pa];
  return wider ? [1, fa / pa] : [pa / fa, 1];
}

/**
 * The engine camera's vertical fov (deg) and aspect that line up with a plate shot at `fov` (vertical deg), drawn with
 * fitScale's [sx, sy]: the plate's view, cropped or letterboxed the same way.
 */
export function fitCamera(fov: number, pa: number, s: [number, number]): { fov: number; aspect: number } {
  const T = Math.tan((fov * Math.PI) / 360);
  return { fov: (2 * Math.atan(T / s[1]) * 180) / Math.PI, aspect: (pa * s[1]) / s[0] };
}

// Blender's Z-up world to three's Y-up one: a −90° turn about X, (x, y, z) → (x, z, −y)
const Q_BLENDER = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const fromBlender = (v: V3): V3 => [v[0], v[2], -v[1]];

/** The camera JSON as frame number → PlateCam, in three.js conventions (see PlateCam). */
export function parseCameras(json: any, first = 1): Map<number, PlateCam> {
  const out = new Map<number, PlateCam>();
  const blender = json?.axes === 'blender', f0 = json?.first ?? first;
  (json?.frames ?? []).forEach((r: any, i: number) => {
    let c: PlateCam = { p: r.p, q: r.q, at: r.at, up: r.up, fov: r.fov ?? json.fov, near: r.near, far: r.far, points: r.points };
    if (blender) {
      const q = c.q ? new THREE.Quaternion(...c.q).premultiply(Q_BLENDER) : null;
      c = {
        ...c, p: fromBlender(c.p), q: q ? [q.x, q.y, q.z, q.w] : undefined, at: c.at && fromBlender(c.at), up: c.up ? fromBlender(c.up) : c.at ? [0, 1, 0] : undefined,
        points: c.points && Object.fromEntries(Object.entries(c.points).map(([k, v]) => [k, fromBlender(v)])),
      };
    }
    out.set(r.f ?? f0 + i, c);
  });
  return out;
}

// ------------------------------------------------------------------ the plate

interface Slot {
  n: number;
  tex: THREE.Texture | null;
  /** Settled (loaded or failed). */
  done: boolean;
  failed: boolean;
  promise: Promise<void>;
}

/** Release a frame: the GPU texture and its decoded bitmap. */
function free(tex: THREE.Texture | null) {
  if (!tex) return;
  tex.dispose();
  (tex.userData.bitmap as ImageBitmap | undefined)?.close();
}

let exrLoader: Promise<{ parse(b: ArrayBuffer): { data?: ArrayBufferView; width?: number; height?: number; format?: THREE.PixelFormat; type?: THREE.TextureDataType } }> | null = null;

/**
 * An image sequence as textures by song time. Call prepare() before rendering a frame (Scene.prepare, which the engine
 * awaits on export), then draw() or texture() in render(); camera() / applyCamera() give the per-frame camera.
 */
export class Plate {
  readonly o: PlateOptions & { first: number; at: number; fit: PlateFit };
  /** Frame size (px) once one has loaded (0 before). */
  width = 0;
  height = 0;
  /** Frames that failed to load (missing files, bad data), for a scene to report. */
  failed = new Set<number>();
  private cache = new Map<number, Slot>();
  private cams: Map<number, PlateCam> | null = null;
  /** The last frame drawn: the preview's stand-in while the next one loads (never evicted). */
  private shown: Slot | null = null;
  private lastI = NaN;
  private dir = 1;
  private warned = false;
  private disposed = false;

  constructor(private renderer: THREE.WebGLRenderer, opts: PlateOptions) {
    this.o = { ...opts, first: opts.first ?? 1, at: opts.at ?? 0, fit: opts.fit ?? 'cover' };
    frameUrl(this.o.src, this.o.first); // fail early on a template without a frame number
  }

  /** Loads the camera JSON, if any. */
  async init() {
    if (!this.o.camera) return;
    const r = await fetch(this.o.camera);
    if (!r.ok || /text\/html/.test(r.headers.get('content-type') ?? '')) throw new Error(`plate camera: ${this.o.camera} not found`);
    this.cams = parseCameras(await r.json(), this.o.first);
  }

  /** The frame number shown at song time t (inside a render, through the plate's shutter). */
  frameAt(t: number): number | null {
    return plateFrame(shutterT(t, this.o.shutter ?? 0), this.o);
  }

  /**
   * Load the frames for an export frame at t whose sub-frames span t0..t1 (Scene.prepare's arguments; the preview passes
   * t0 = t1 = t), plus a few ahead. Resolves when the needed ones are there; nothing to wait for → undefined.
   */
  prepare(t: number, t0 = t, t1 = t): Promise<void> | undefined {
    if (this.disposed) return;
    const a = this.o.shutter ?? 0;
    // (the sub-frame times as the plate sees them: shutterT with the frame at t)
    const i0 = plateIndex(t + (t0 - t) * a, this.o), i1 = plateIndex(t + (t1 - t) * a, this.o);
    if (i0 > this.lastI) this.dir = 1;
    else if (i0 < this.lastI) this.dir = -1;
    this.lastI = i0;
    const need = new Set<number>();
    for (let i = i0; i <= i1; i++) { const n = plateNumber(i, this.o); if (n !== null) need.add(n); }
    // read ahead first, so the frames needed now are the most recently used
    const ahead = this.o.ahead ?? 2;
    for (let k = 1; k <= ahead; k++) {
      const n = plateNumber(this.dir > 0 ? i1 + k : i0 - k, this.o);
      if (n !== null && !need.has(n)) this.slot(n);
    }
    const wait = [...need].map((n) => this.slot(n)).filter((s) => !s.done).map((s) => s.promise);
    this.evict(need);
    return wait.length ? Promise.all(wait).then(() => {}) : undefined;
  }

  /**
   * The texture shown at t, or null (outside with 'none', a frame that failed, nothing loaded yet). A frame still
   * loading (the preview does not wait) gives the last one drawn.
   */
  texture(t: number): THREE.Texture | null {
    const n = this.frameAt(t);
    if (n === null) return null;
    let s = this.cache.get(n);
    if (!s) { s = this.slot(n); this.evict(new Set([n])); } // (nobody called prepare: still bounded)
    if (s.done) {
      this.touch(s);
      if (s.failed) return null;
      this.shown = s;
      return s.tex;
    }
    if (!Number.isNaN(SUBFRAME.frame) && !this.warned) {
      this.warned = true;
      console.warn(`plate: frame ${n} was not loaded before the render (forward Scene.prepare to Plate.prepare)`);
    }
    return this.shown?.tex ?? null;
  }

  /** Draw the frame for t over `out` ('normal' blend: the plate's alpha shows what is under it). False: nothing drawn. */
  draw(comp: Compositor, out: THREE.WebGLRenderTarget, t: number, o: { opacity?: number; mode?: BlendMode; fit?: PlateFit } = {}) {
    const tex = this.texture(t);
    if (!tex) return false;
    const [sx, sy] = fitScale(this.aspect, W / H, o.fit ?? this.o.fit);
    const pre = this.o.premultiplied ?? (tex as THREE.DataTexture).isDataTexture === true;
    comp.draw(this.renderer, tex, out, { mode: o.mode ?? 'normal', opacity: o.opacity ?? 1, scale: [1 / sx, 1 / sy], premult: !pre });
    return true;
  }

  /** The camera record of the frame shown at t (null: no camera JSON, or no record for that frame). */
  camera(t: number): PlateCam | null {
    const n = this.frameAt(t);
    return n === null ? null : this.cams?.get(n) ?? null;
  }

  /**
   * Put a three.js camera where the plate's camera was for the frame shown at t, with the fov and aspect that match how
   * draw() fits the plate (cropped by 'cover', letterboxed by 'contain'). False: no record for that frame.
   */
  applyCamera(cam: THREE.PerspectiveCamera, t: number, fit: PlateFit = this.o.fit): boolean {
    const c = this.camera(t);
    if (!c) return false;
    cam.position.set(...c.p);
    if (c.q) cam.quaternion.set(...c.q);
    else if (c.at) { cam.up.set(...(c.up ?? [0, 1, 0])); cam.lookAt(...c.at); }
    // (no fov in the JSON: the camera's own, as it was before the first fit)
    const fov = c.fov ?? (cam.userData.plateFov ??= cam.fov);
    const v = fitCamera(fov, this.aspect, fitScale(this.aspect, W / H, fit));
    cam.fov = v.fov;
    cam.aspect = v.aspect;
    if (c.near) cam.near = c.near;
    if (c.far) cam.far = c.far;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    return true;
  }

  /** The plate's aspect (width / height): the frames', or the frame's until one has loaded. */
  get aspect() { return this.width > 0 ? this.width / this.height : W / H; }

  dispose() {
    this.disposed = true;
    for (const s of this.cache.values()) free(s.tex);
    this.cache.clear();
    this.shown = null;
  }

  private touch(s: Slot) { this.cache.delete(s.n); this.cache.set(s.n, s); }

  /** The cache slot for frame n, starting its load if it has none. */
  private slot(n: number): Slot {
    const old = this.cache.get(n);
    if (old) { this.touch(old); return old; }
    const s: Slot = { n, tex: null, done: false, failed: false, promise: Promise.resolve() };
    const url = frameUrl(this.o.src, n);
    s.promise = this.decode(url).then(
      (tex) => {
        if (this.disposed) { free(tex); return; }
        s.tex = tex;
        if (!this.width) { this.width = (tex.image as { width: number }).width; this.height = (tex.image as { height: number }).height; }
      },
      (err) => { s.failed = true; this.failed.add(n); console.error(`plate: frame ${n} (${url}): ${err}`); },
    ).finally(() => { s.done = true; });
    this.cache.set(n, s);
    return s;
  }

  /** Drop the least recently used settled frames beyond the cache size, never one needed now or the one on screen. */
  private evict(keep: Set<number>) {
    const cap = Math.max(this.o.cache ?? 8, keep.size + 2 * (this.o.ahead ?? 2) + 2);
    for (const s of this.cache.values()) {
      if (this.cache.size <= cap) break;
      if (!s.done || keep.has(s.n) || s === this.shown) continue;
      this.cache.delete(s.n);
      free(s.tex);
    }
  }

  /** Fetch, decode and upload one frame (the upload happens here, not in the middle of a render). */
  private async decode(url: string): Promise<THREE.Texture> {
    const res = await fetch(url);
    // (a dev server may answer a missing file with its index page)
    if (!res.ok || /text\/html/.test(res.headers.get('content-type') ?? '')) throw new Error(`not found (HTTP ${res.status})`);
    let tex: THREE.Texture;
    if (/\.exr(\?|$)/i.test(url)) {
      exrLoader ??= import('three/examples/jsm/loaders/EXRLoader.js').then((m) => new m.EXRLoader().setDataType(THREE.HalfFloatType));
      const d = (await exrLoader).parse(await res.arrayBuffer());
      // (EXRLoader writes rows bottom-up: no flip needed)
      tex = new THREE.DataTexture(d.data as Uint16Array, d.width!, d.height!, d.format ?? THREE.RGBAFormat, d.type ?? THREE.HalfFloatType);
      tex.colorSpace = THREE.LinearSRGBColorSpace;
      // free the CPU copy once it is on the GPU
      tex.onUpdate = () => { (tex.image as { data: unknown }).data = null; };
    } else {
      // flipped while decoding (WebGL's flipY does not apply to ImageBitmaps); raw values, no colour management
      const bmp = await createImageBitmap(await res.blob(), { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      tex = new THREE.Texture(bmp);
      tex.colorSpace = this.o.linear ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
      tex.premultiplyAlpha = false;
      tex.userData.bitmap = bmp; // (closed when the frame leaves the cache)
    }
    tex.flipY = false;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    if (!this.disposed) this.renderer.initTexture(tex);
    return tex;
  }
}

// ------------------------------------------------------------------ the plate as a scene

/**
 * A timeline entry that is a plate. The options come from plateOptions(): by default the entry's `params.plate`, with
 * `at` = the entry's start, so a project scene file can be one line —
 * `export { PlateScene as default } from '../library/kit/plate';` — and the timeline gives
 * `{ params: { plate: { src: '/refs/shot1/####.png', fps: 24, last: 120 } } }`. Subclass it and override overlay() to
 * draw over the plate (2D layers; 3D through `this.plate.applyCamera(cam, f.t)`).
 */
export class PlateScene extends Scene {
  plate!: Plate;
  /** Linear colour under the plate (shows through its alpha and the bars of 'contain'). */
  background: V3 = [0, 0, 0];

  protected plateOptions(): PlateOptions {
    const p = this.ctx.params.plate as PlateOptions | undefined;
    if (!p) throw new Error(`${this.ctx.id}: PlateScene needs params.plate ({ src, fps, last, … }) or a plateOptions() override`);
    return { at: this.ctx.start, ...p };
  }

  override async init() {
    this.plate = new Plate(this.ctx.renderer, this.plateOptions());
    await this.plate.init();
  }

  override prepare(t: number, t0: number, t1: number) { return this.plate.prepare(t, t0, t1); }

  render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides | void {
    clearRT(this.ctx.renderer, out, this.background);
    this.plate.draw(this.ctx.comp, out, f.t);
    return this.overlay(f, out);
  }

  /** Draw over the plate (out already holds it). Return post overrides like render(). */
  protected overlay(_f: Frame, _out: THREE.WebGLRenderTarget): PostOverrides | void {}

  override dispose() { this.plate?.dispose(); }
}

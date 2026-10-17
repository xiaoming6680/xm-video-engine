// Shader effects (Sfx): the shaders library (shader-effects-inc/shaders, MIT; vendored unchanged but for marked
// patches in src/library/vendor/shaders, see its VENDOR.md) as an engine layer — its 200 WebGPU components: gradients, noise,
// glass, chrome, light, distortions, transitions, blurs, simulations. A layer list is the library's preset JSON
// (what shaders.com exports), rendered on the browser's real WebGPU and handed back as an engine texture:
//
//   const fx = new Sfx(ctx.renderer, [{ type: 'PagePeel', props: { amount: 0.3 }, children: [
//     { type: 'EngineTexture', props: { source: 'scene' } } ] }]);
//   await fx.init();                       // in Scene.init (device, pipelines, async loads)
//   fx.input('scene', sceneRT);            // engine pixels for the EngineTexture layers (RT, Layer2D, canvas, image)
//   fx.set('peel', { amount: k });         // any prop, any frame (give the layer an `id`)
//   fx.render(f.lt, out);                  // the effect at time t (seconds), linear HDR, straight alpha, into `out`
//
// Time: a stateless list (most components) is a pure function of the t passed to render(); frames can come in any
// order (seeks, adaptive motion-blur sub-frames). A list with a simulation (compute feedback: Smoke, InkFlow,
// ReactionDiffusion, particles…; `stateful`) steps at a fixed `rate` (60/s) from its last reset: the scene that owns
// it must be `stateful` and call fx.reset() from its reset() (the engine then fast-forwards it after seeks).
// Pixels: the WebGPU canvas is rgba16float (no 8-bit step, values above 1 kept); EngineTexture inputs go through the
// engine canvas' half-float drawing buffer (engine.ts) — GPU to GPU, no readback.
// Pointer-driven components get a scripted pointer (setPointer); real mouse events are ignored.
import * as THREE from 'three';
import { FSPass, W, H, SCALE } from '../../engine/gl';
import { shaderRendererGPU, createGpuUniformsMap, rootPassthrough, resolveBoundingBox } from '../vendor/shaders/index';
import { getAllShaders } from '../vendor/shaders/registry';
import type { GpuShaderDefinition } from '../vendor/shaders/gpu/contract';
import type { NodeMetadata, PropDriver, BlendMode, ToneMappingMode } from '../vendor/shaders/types';
import type { GpuUniformsMap } from '../vendor/shaders/gpu/index';
import { xmPendingCount } from '../vendor/shaders/gpu/xmPending';
import { xmForceDesktopQuality } from '../vendor/shaders/utilities/device';
import { EngineTexture, bindInputSink, type InputTexture } from './sfx-input';

/** One layer of an Sfx list: the library's preset component JSON. */
export interface SfxLayer {
  type: string;
  /** Needed to set() its props later; otherwise an id is made from the type. */
  id?: string;
  /** Component props, plus the layer props blendMode, opacity, visible, transform, boundingBox, maskSource, maskType. */
  props?: Record<string, unknown>;
  children?: SfxLayer[];
}

/** Pixels for an EngineTexture input. */
export type SfxSource =
  | THREE.WebGLRenderTarget
  | THREE.Texture
  | HTMLCanvasElement
  | OffscreenCanvas
  | ImageBitmap
  | HTMLImageElement
  | { canvas: HTMLCanvasElement };

export interface SfxOptions {
  /** Logical size (default: the project's W x H); props given in px are relative to it. */
  w?: number;
  h?: number;
  /** Backing px per logical px (default SCALE). */
  scale?: number;
  /**
   * How colour props are read: 'srgb' (default; '#ff0000' is the red of every other engine module) or 'p3-linear'
   * (the library's own default, i.e. what the shaders.com editor shows: Display-P3 numbers on an sRGB canvas).
   */
  colorSpace?: 'srgb' | 'p3-linear';
  /** The library's tone-mapping tail (default 'linear' = none; the engine's post does the tone mapping). */
  toneMapping?: ToneMappingMode;
  /** Force stateful (true) or stateless (false); default: stateful when a layer is a simulation component. */
  stateful?: boolean;
  /** Simulation steps per second of a stateful list (default 60). */
  rate?: number;
  /**
   * Your own components (the library's `defineShader` from `vendor/shaders/std`: WGSL or its primitives), usable by name
   * in this list next to the library's.
   */
  components?: GpuShaderDefinition[];
  /** (tests only) the WebGPU canvas format; default rgba16float. */
  canvasFormat?: 'rgba16float' | 'bgra8unorm' | 'rgba8unorm';
  /** (tests only) pass NaN / Inf through instead of making them transparent black, so a test can see them. */
  keepNonFinite?: boolean;
}

const METADATA_PROPS = new Set(['opacity', 'blendMode', 'visible', 'transform', 'boundingBox', 'maskSource', 'maskType', 'flow', 'absolute']);

/**
 * Components that keep state between frames: every component the library declares a 'simulation', plus these
 * (found by scripts/sfx-test.ts `history`: a frame rendered after a run of earlier frames with a moving pointer
 * differs from the same frame rendered fresh).
 */
const STATEFUL_EXTRA = new Set<string>(['CursorRipples', 'GridDistortion', 'Irradiance', 'KeyFrames', 'Liquify', 'Surface3D']);

function isPropDriver(v: unknown): v is PropDriver {
  if (typeof v !== 'object' || v === null || !('type' in v)) return false;
  const t = (v as { type?: unknown }).type;
  return t === 'map' || t === 'mouse' || t === 'mouse-position' || t === 'auto-animate';
}

// the library reads colour props in ONE page-wide colour space (a module global set at initialize): every Sfx on the
// page must agree
let PAGE_COLOR_SPACE: 'srgb' | 'p3-linear' | null = null;

let REGISTRY: Map<string, GpuShaderDefinition> | null = null;
/** Every component by name (deprecated names included) and EngineTexture. */
export function sfxComponents(): Map<string, GpuShaderDefinition> {
  if (!REGISTRY) {
    REGISTRY = new Map();
    for (const s of getAllShaders()) {
      const def = s.definition as GpuShaderDefinition;
      REGISTRY.set(def.name, def);
      for (const old of (def as { deprecatedNames?: string[] }).deprecatedNames ?? []) REGISTRY.set(old, def);
    }
    REGISTRY.set('EngineTexture', EngineTexture as GpuShaderDefinition);
  }
  return REGISTRY;
}

/** A prop driven by the pointer through a spring (the library integrates it over dt). */
const isPointerDriver = (v: unknown) => isPropDriver(v) && (v.type === 'mouse' || v.type === 'mouse-position');

/**
 * Whether a layer list keeps state between frames: a simulation component, a component whose picture integrates dt
 * (STATEFUL_EXTRA), or a prop driven by the pointer (mouse / mouse-position drivers are springs over dt).
 */
export function sfxStateful(layers: SfxLayer[], extra: GpuShaderDefinition[] = []): boolean {
  const reg = new Map(sfxComponents());
  for (const d of extra) reg.set(d.name, d);
  return layers.some((l) => {
    const d = reg.get(l.type);
    if (d && ((d as { xmRole?: string }).xmRole === 'simulation' || STATEFUL_EXTRA.has(d.name))) return true;
    if (Object.values(l.props ?? {}).some(isPointerDriver)) return true;
    return sfxStateful(l.children ?? [], extra);
  });
}

let devicePromise: Promise<{ device: GPUDevice; adapter: GPUAdapter }> | null = null;
/** The page's one WebGPU device for every Sfx (all adapter features, like the library's createSharedDevice). */
export function sfxDevice() {
  // one quality on every machine: never the library's phone path (a touchscreen laptop, a small preview window)
  xmForceDesktopQuality();
  devicePromise ??= (async () => {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (!gpu) throw new Error('Sfx: this browser has no WebGPU (navigator.gpu); library/kit/sfx.ts needs Edge/Chrome with WebGPU');
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('Sfx: WebGPU has no adapter');
    const device = await adapter.requestDevice({ requiredFeatures: [...adapter.features] as GPUFeatureName[] });
    device.lost.then((i) => console.error(`Sfx: WebGPU device lost (${i.reason}): ${i.message}`));
    return { device, adapter };
  })();
  return devicePromise;
}

const ENC_GLSL = /* glsl */ `
uniform sampler2D src;
float enc(float l) { l = max(l, 0.0); return l <= 0.0031308 ? l * 12.92 : 1.055 * pow(l, 1.0 / 2.4) - 0.055; }
void main() {
  vec4 c = texture(src, vUv);
  fragColor = vec4(enc(c.r), enc(c.g), enc(c.b), clamp(c.a, 0.0, 1.0));
}`;
// the library's canvas: premultiplied, sRGB-encoded (its linearToSrgb, which keeps values below 0 linear); uploaded
// raw (UNPACK_PREMULTIPLY_ALPHA) with its top row first. Alpha is clamped to 0..1 before un-premultiplying, as an
// 8-bit canvas stores it: the library's additive highlights (a glass rim) can leave alpha above 1, and there the
// premultiplied colour is the colour shown (dividing by alpha > 1 would darken it).
// A non-finite texel (a NaN from some shader) becomes transparent black: one NaN would otherwise spread through the
// engine's bloom into a black disc. (The comparison form, not isnan(), which fast-math may drop — as engine.ts's accum.)
const DEC_GLSL = (guard: boolean) => /* glsl */ `
uniform sampler2D src;
float dec(float s) { return s <= 0.04045 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4); }
void main() {
  vec4 c = texture(src, vec2(vUv.x, 1.0 - vUv.y));
  ${guard ? 'if (!(abs(c.r) <= 6e4 && abs(c.g) <= 6e4 && abs(c.b) <= 6e4 && abs(c.a) <= 6e4)) c = vec4(0.0);' : ''}
  float a = clamp(c.a, 0.0, 1.0);
  vec3 s = a > 0.0 ? c.rgb / a : vec3(0.0);
  fragColor = vec4(dec(s.r), dec(s.g), dec(s.b), a);
}`;

interface Entry { def: GpuShaderDefinition; layer: SfxLayer; maps: Record<string, PropDriver> }

type Renderer = ReturnType<typeof shaderRendererGPU>;

export class Sfx {
  /** The WebGPU canvas (offscreen, never in the page). */
  readonly canvas = document.createElement('canvas');
  readonly w: number;
  readonly h: number;
  readonly scale: number;
  readonly stateful: boolean;
  readonly rate: number;
  /** Output: linear HDR, straight alpha (render() draws here unless given another target). */
  readonly rt: THREE.WebGLRenderTarget;
  private r: Renderer | null = null;
  private device: GPUDevice | null = null;
  private entries = new Map<string, Entry>();
  private custom = new Map<string, GpuShaderDefinition>();
  private inputs = new Map<string, SfxSource>();
  private enc = new FSPass(ENC_GLSL, { src: { value: null } });
  private dec: FSPass;
  private glTex: WebGLTexture | null = null;
  private outTex: THREE.ExternalTexture | null = null;
  private haveFrame = false;
  /** stateful: the simulation step on screen (null: reset, nothing simulated yet) */
  private step: number | null = null;
  private warned = new Set<string>();
  private errs: string[] = [];
  private ids = 0;
  /** (ready() renders before the scene binds its inputs: no unbound-input warning then) */
  private quiet = false;

  constructor(private renderer: THREE.WebGLRenderer, private layers: SfxLayer[], opts: SfxOptions = {}) {
    this.w = opts.w ?? W;
    this.h = opts.h ?? H;
    this.scale = opts.scale ?? SCALE;
    this.rate = opts.rate ?? 60;
    this.colorSpace = opts.colorSpace ?? 'srgb';
    if (PAGE_COLOR_SPACE && PAGE_COLOR_SPACE !== this.colorSpace) throw new Error(`Sfx: colorSpace '${this.colorSpace}' on a page whose Sfx use '${PAGE_COLOR_SPACE}' (the library has one page-wide colour space)`);
    PAGE_COLOR_SPACE = this.colorSpace;
    this.toneMapping = opts.toneMapping ?? 'linear';
    this.canvasFormat = opts.canvasFormat ?? 'rgba16float';
    for (const d of opts.components ?? []) this.custom.set(d.name, d);
    this.stateful = opts.stateful ?? sfxStateful(layers, opts.components);
    this.dec = new FSPass(DEC_GLSL(!opts.keepNonFinite), { src: { value: null } });
    this.rt = new THREE.WebGLRenderTarget(Math.round(this.w * this.scale), Math.round(this.h * this.scale), {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false,
    });
  }
  private colorSpace: 'srgb' | 'p3-linear';
  private toneMapping: ToneMappingMode;
  private canvasFormat: GPUTextureFormat;

  /** Backing size in px. */
  get pw() { return Math.round(this.w * this.scale); }
  get ph() { return Math.round(this.h * this.scale); }

  /** Create the WebGPU renderer and the layers, and wait for their async loads (images, fonts, SDF shapes). */
  async init() {
    const { device, adapter } = await sfxDevice();
    this.device = device;
    this.canvas.width = this.pw;
    this.canvas.height = this.ph;
    bindInputSink(this.canvas, { fill: (name, tex) => this.fill(name, tex) });
    const r = shaderRendererGPU();
    let unavailable: string | null = null;
    r.setOnUnavailable((reason) => { unavailable = reason; });
    await r.initialize({
      canvas: this.canvas,
      observeElement: false,
      gpu: { device, adapter },
      colorSpace: this.colorSpace,
      toneMapping: this.toneMapping,
      canvasFormat: this.canvasFormat,
      fixedSize: { width: this.w, height: this.h, pixelRatio: this.scale },
    });
    if (unavailable || r.getFailureReason()) throw new Error(`Sfx: the WebGPU renderer did not start (${unavailable ?? r.getFailureReason()})`);
    this.r = r;
    // a parked pointer (no cursor) until setPointer: and from here on window mouse events are ignored
    r.setPointer(-10, -10, false);
    const rootId = 'sfx-root';
    r.registerNode(rootId, rootPassthrough.fragment, null, null, {}, rootPassthrough);
    this.layers.forEach((l, i) => this.register(l, rootId, i));
    // GL side: the texture the WebGPU canvas is uploaded into
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    this.glTex = gl.createTexture();
    this.renderer.state.bindTexture(gl.TEXTURE_2D, this.glTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.outTex = new THREE.ExternalTexture(this.glTex);
    await this.ready();
    return this;
  }

  /**
   * Wait until no async load is in flight (images, SDF shapes, fonts; page-wide) and the composition is built, then
   * render once more (a finished load uploads in the next frame). Call after changing a url / shape / font prop.
   */
  async ready(timeoutMs = 30000) {
    const r = this.need();
    const t0 = performance.now();
    this.quiet = true;
    try {
      for (;;) {
        r.setClock(0);
        r.renderNow(0);
        if (xmPendingCount() === 0 && r.isSettled()) break;
        if (performance.now() - t0 > timeoutMs) throw new Error(`Sfx: still loading after ${timeoutMs} ms (${xmPendingCount()} loads in flight)`);
        await new Promise((res) => setTimeout(res, 15));
      }
      r.renderNow(0);
    } finally {
      this.quiet = false;
    }
    this.haveFrame = false;
    // (its frames stepped the simulations: they restart, as after init)
    if (this.stateful && this.r) this.reset();
  }

  private need(): Renderer {
    if (!this.r) throw new Error('Sfx: call (and await) init() first');
    return this.r;
  }

  private register(l: SfxLayer, parentId: string, order: number) {
    const def = this.custom.get(l.type) ?? sfxComponents().get(l.type);
    if (!def) throw new Error(`Sfx: unknown component '${l.type}'`);
    const id = l.id ?? `${l.type}_${this.ids++}`;
    if (this.entries.has(id)) throw new Error(`Sfx: two layers with id '${id}'`);
    const maps: Record<string, PropDriver> = {};
    for (const [k, v] of Object.entries(l.props ?? {})) {
      if (METADATA_PROPS.has(k)) continue;
      if (!Object.prototype.hasOwnProperty.call(def.props, k)) throw new Error(`Sfx: ${l.type} has no prop '${k}'`);
      if (isPropDriver(v)) maps[k] = v;
    }
    const complete = Object.fromEntries(Object.entries(def.props).map(([k, cfg]) => {
      const v = l.props?.[k] !== undefined ? l.props[k] : (cfg as { default: unknown }).default;
      return [k, isPropDriver(v) ? (cfg as { default: unknown }).default : v];
    }));
    const uniforms: GpuUniformsMap = createGpuUniformsMap(def, complete, id);
    const p = l.props ?? {};
    const metadata: NodeMetadata = {
      blendMode: (p.blendMode as BlendMode) || 'normal',
      opacity: p.opacity as number | undefined,
      visible: p.visible as boolean | undefined,
      renderOrder: order,
      id,
      maps: Object.keys(maps).length ? { ...maps } : undefined,
      mask: p.maskSource ? { source: p.maskSource as string, type: (p.maskType ?? 'alpha') } as NodeMetadata['mask'] : undefined,
      transform: p.transform ? { offsetX: 0, offsetY: 0, rotation: 0, scale: 1, anchorX: 0.5, anchorY: 0.5, edges: 'transparent', ...(p.transform as object) } as NodeMetadata['transform'] : undefined,
      boundingBox: resolveBoundingBox(p.boundingBox as never),
      flow: p.flow as NodeMetadata['flow'],
      absolute: p.absolute as NodeMetadata['absolute'],
    };
    this.need().registerNode(id, def.fragment, parentId, metadata, uniforms, def);
    this.entries.set(id, { def, layer: l, maps });
    (l.children ?? []).forEach((c, i) => this.register(c, id, i));
  }

  /** Layer ids, in registration order. */
  get layerIds() { return [...this.entries.keys()]; }

  /** Set props of layer `id` (component props, prop drivers, or layer props). Takes effect on the next render(). */
  set(id: string, props: Record<string, unknown>) {
    const r = this.need();
    const e = this.entries.get(id);
    if (!e) throw new Error(`Sfx: no layer '${id}' (layers: ${this.layerIds.join(', ')})`);
    const live = (e.layer.props ??= {});
    for (const [k, v] of Object.entries(props)) {
      if (k === 'maskType') continue;
      if (METADATA_PROPS.has(k)) {
        if (k === 'maskSource') r.updateNodeMetadata(id, { mask: v ? { source: v as string, type: (props.maskType ?? live.maskType ?? 'alpha') as never } : undefined });
        else if (k === 'boundingBox') r.updateNodeMetadata(id, { boundingBox: resolveBoundingBox(v as never) });
        else if (k === 'transform') r.updateNodeMetadata(id, { transform: v ? { offsetX: 0, offsetY: 0, rotation: 0, scale: 1, anchorX: 0.5, anchorY: 0.5, edges: 'transparent', ...(v as object) } as NodeMetadata['transform'] : undefined });
        else r.updateNodeMetadata(id, { [k]: v } as Partial<NodeMetadata>);
      } else {
        if (!Object.prototype.hasOwnProperty.call(e.def.props, k)) throw new Error(`Sfx: ${e.layer.type} has no prop '${k}'`);
        if (isPropDriver(v)) {
          if (isPointerDriver(v) && !this.stateful) throw new Error(`Sfx.set: a ${v.type} driver on ${id}.${k} integrates over time; it needs a stateful list (new Sfx(…, { stateful: true }))`);
          e.maps[k] = v;
          r.updateNodeMetadata(id, { maps: { ...e.maps } });
        } else {
          if (k in e.maps) {
            delete e.maps[k];
            r.updateNodeMetadata(id, { maps: Object.keys(e.maps).length ? { ...e.maps } : undefined });
          }
          r.updateUniformValue(id, k, v);
        }
      }
      live[k] = v;
    }
    if ('maskType' in props) live.maskType = props.maskType;
  }

  /** Bind the pixels of the EngineTexture layers whose `source` is `name` (rebind each frame if it changes). */
  input(name: string, src: SfxSource) {
    this.inputs.set(name, src);
  }

  /** The scripted pointer for pointer-driven components: x, y in 0..1 from the top-left; `active` = pressed / over. */
  setPointer(x: number, y: number, active = true) {
    this.need().setPointer(x, y, active);
  }

  /** Restart the simulations (stateful lists): call from the owning scene's reset(). */
  reset() {
    this.need().resetState();
    this.step = null;
    this.haveFrame = false;
  }

  /** Errors the library reported (validation, render, failed loads) since the last call, and this host's warnings. */
  errors(): string[] {
    this.drainErrors();
    const out = this.errs;
    this.errs = [];
    return out;
  }

  /** Move the library's new errors into this host's list, printing each (render.ts shows the page's console errors). */
  private drainErrors() {
    const r = this.r;
    if (!r) return;
    const e = r.getErrors();
    if (!e.length) return;
    r.clearErrors();
    for (const m of e) console.error(`Sfx: ${m}`);
    this.errs.push(...e);
    if (this.errs.length > 200) this.errs.splice(0, this.errs.length - 200);
  }

  private warn(key: string, msg: string) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.errs.push(msg);
    console.warn(`Sfx: ${msg}`);
  }

  /**
   * Render the list at time `t` (seconds: song time f.t or the scene's local f.lt, as the layers were tuned) into
   * `out` (default this.rt): linear HDR, straight alpha. Returns out's texture.
   */
  render(t: number, out: THREE.WebGLRenderTarget = this.rt): THREE.Texture {
    const r = this.need();
    if (!Number.isFinite(t)) throw new Error(`Sfx.render: t must be finite, got ${t}`);
    let drew = false;
    if (!this.stateful) {
      r.setClock(t);
      r.renderNow(0);
      // a compile-time prop change shows from the next frame (swap-when-ready): draw until it is on screen
      for (let i = 0; i < 4 && !r.isSettled(); i++) r.renderNow(0);
      drew = true;
    } else {
      const dt = 1 / this.rate;
      const target = Math.floor(t * this.rate + 1e-6);
      if (this.step !== null && target < this.step) {
        this.warn('back', `stateful list went back in time (t=${t.toFixed(3)}) without reset(): restarted there (make the scene stateful and call fx.reset() from its reset())`);
        this.reset();
      }
      if (this.step === null) {
        // a fresh start: the first frame seeds the simulations (dt 0)
        this.step = target;
        r.setClock(target * dt);
        r.renderNow(0);
        drew = true;
      } else {
        const n = target - this.step;
        if (n > 10 * this.rate) this.warn('jump', `stateful list jumped ${(n / this.rate).toFixed(1)} s ahead: simulating every step (slow); seeks should reset()`);
        for (let k = this.step + 1; k <= target; k++) {
          r.setClock((k - 1) * dt);
          r.renderNow(dt);
          drew = true;
        }
        this.step = target;
      }
      for (let i = 0; i < 4 && !r.isSettled(); i++) { r.renderNow(0); drew = true; }
    }
    if (xmPendingCount() > 0) this.warn('pending', 'an async load (image / SDF shape / font) is in flight while rendering: await fx.ready() after changing such props');
    this.drainErrors();
    if (drew || !this.haveFrame) this.upload();
    this.haveFrame = true;
    this.dec.u.src!.value = this.outTex;
    this.dec.render(this.renderer, out);
    return out.texture;
  }

  /**
   * Copy the WebGPU canvas into the GL texture: in this task, right after the submit (the read waits for the GPU).
   * Pixel-store state goes through three's state cache: a raw gl.pixelStorei would leave three believing an old
   * value, and its next texture upload (a Layer2D's flipY) would skip setting it and come out upside down.
   */
  private upload() {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const st = this.renderer.state;
    st.bindTexture(gl.TEXTURE_2D, this.glTex!);
    st.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    st.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    st.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, this.canvas);
  }

  /** EngineTexture input `name` → `tex` (InputSink): called by the library before each frame's passes. */
  private fill(name: string, tex: InputTexture) {
    const src = this.inputs.get(name);
    if (!src) { if (!this.quiet) this.warn(`input:${name}`, `EngineTexture input '${name}' is not bound (fx.input('${name}', …))`); return; }
    const device = this.device!;
    const el = 'canvas' in src && src.canvas instanceof HTMLCanvasElement && !(src instanceof THREE.Texture) ? src.canvas : src;
    if (el instanceof HTMLCanvasElement || el instanceof OffscreenCanvas || el instanceof ImageBitmap || el instanceof HTMLImageElement) {
      // an sRGB image (a Layer2D, a 2D canvas, a picture): straight to WebGPU
      // (8-bit, as the library's ImageTexture holds an image)
      const w = el instanceof HTMLImageElement ? el.naturalWidth : el.width, h = el instanceof HTMLImageElement ? el.naturalHeight : el.height;
      const t = tex.ensure(w, h, 'rgba8unorm');
      if (!t) return;
      device.queue.copyExternalImageToTexture({ source: el, flipY: false }, { texture: t.unwrap(), premultipliedAlpha: false }, [w, h]);
      tex.written();
      return;
    }
    // a GL texture (render target): through the engine canvas, extended-sRGB encoded, alpha kept
    const t = src instanceof THREE.WebGLRenderTarget ? src.texture : (src as THREE.Texture);
    const img = t.image as { width?: number; height?: number } | undefined;
    const w = src instanceof THREE.WebGLRenderTarget ? src.width : img?.width ?? 0, h = src instanceof THREE.WebGLRenderTarget ? src.height : img?.height ?? 0;
    if (!w || !h) { this.warn(`size:${name}`, `EngineTexture input '${name}' has no size`); return; }
    const cv = this.renderer.domElement;
    if (w > cv.width || h > cv.height) { this.warn(`big:${name}`, `EngineTexture input '${name}' (${w}x${h}) is larger than the engine canvas (${cv.width}x${cv.height})`); return; }
    const gl = this.renderer.getContext() as WebGL2RenderingContext & { drawingBufferFormat?: number };
    if (gl.drawingBufferFormat !== undefined && gl.drawingBufferFormat !== gl.RGBA16F) this.warn('dbf', 'the engine canvas is not half-float (engine.ts drawingBufferStorage): inputs lose HDR');
    const dst = tex.ensure(w, h, 'rgba16float');
    if (!dst) return;
    const vp = this.renderer.getViewport(new THREE.Vector4());
    this.renderer.setViewport(0, 0, w, h);
    this.enc.u.src!.value = t;
    this.enc.render(this.renderer, null);
    this.renderer.setViewport(vp);
    // GL's bottom-left viewport is the bottom rows of the canvas, whose origin is top-left
    device.queue.copyExternalImageToTexture({ source: cv, origin: { x: 0, y: cv.height - h }, flipY: false }, { texture: dst.unwrap(), premultipliedAlpha: true }, [w, h]);
    tex.written();
  }

  dispose() {
    try { this.r?.cleanup(); } catch { /* noop */ }
    this.r = null;
    const gl = this.renderer.getContext();
    if (this.glTex) gl.deleteTexture(this.glTex);
    this.glTex = null;
    this.rt.dispose();
    this.enc.mat.dispose();
    this.dec.mat.dispose();
  }
}

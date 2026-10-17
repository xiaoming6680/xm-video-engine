// Test bench for library/kit/sfx.ts (sfxtest.html, driven by scripts/sfx-test.ts; not part of the app).
//   parity:      a layer list through the library's own offline path (createRendererFromJSON: its registration,
//                its frame-locked clock, its 8-bit canvas) vs through Sfx (this engine's host: setClock, the float
//                canvas, the GL upload and decode), same frames, compared per pixel in 8-bit sRGB
//   determinism: a stateless list rendered at t directly vs after other times; a stateful one, the same step
//                sequence twice (with reset in between)
//   stepping:    t = 1 rendered directly vs reached in 1/60 steps with a moving pointer (finds components that keep
//                state or integrate dt, which must be treated as stateful); history: the older, weaker form of it
//   sweep:       every select option, boolean and slider end of every prop: errors, NaN / Inf
//   perf:        ms per fx.render (30 frames, one GL sync)
//   inputPaths:  an EngineTexture fed the same card as a 2D canvas vs as an engine render target (the GL path);
//                hdrInput (values above 1 survive), nanGuard (NaN becomes transparent black), stateCoherence
//                (three.js's pixel-store cache stays right around Sfx renders), inputVsImage (EngineTexture ≡
//                ImageTexture)
//   smoke:       frames at several times: errors, NaN / Inf, coverage, timing
//   diagnostics, by hand (scripts/sfx-test.ts --call <fn> --spec '<json>'): refDeterminism (the library against
//                itself), shapeCalib / textShape (library/kit/sfx-shape.ts), orientProbe / orientProbe2 (the GL input path's
//                orientation and freshness under the engine's call patterns)
import * as THREE from 'three';
import { makeRenderer, FSPass, PW, PH, W, H } from '../engine/gl';
import { Sfx, sfxComponents, sfxStateful, type SfxLayer } from './kit/sfx';
import { createRendererFromJSON } from './vendor/shaders/presetRenderer';
import { xmPendingCount } from './vendor/shaders/gpu/xmPending';
import { sdfShape, sdfText } from './kit/sfx-shape';
import { defineShader, wgsl } from './vendor/shaders/std/index';
import type { GpuShaderDefinition } from './vendor/shaders/gpu/contract';
import { loadFonts } from '../engine/type';

const canvas = document.getElementById('c') as HTMLCanvasElement;
canvas.width = PW;
canvas.height = PH;
const renderer = makeRenderer(canvas);
const gl = renderer.getContext() as WebGL2RenderingContext;
const q = new URLSearchParams(location.search);
const COLOR_SPACE = (q.get('cs') ?? 'p3-linear') as 'srgb' | 'p3-linear';

// ---------------------------------------------------------------- the test card (sRGB, opaque)
const card = document.createElement('canvas');
card.width = PW; card.height = PH;
{
  const c = card.getContext('2d')!;
  const g = c.createLinearGradient(0, 0, PW, PH);
  g.addColorStop(0, '#12233f'); g.addColorStop(0.5, '#d2482a'); g.addColorStop(1, '#f2e6c8');
  c.fillStyle = g; c.fillRect(0, 0, PW, PH);
  c.strokeStyle = 'rgba(255,255,255,0.8)'; c.lineWidth = Math.max(1, PW / 640);
  for (let x = 0; x <= PW; x += PW / 16) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, PH); c.stroke(); }
  for (let y = 0; y <= PH; y += PH / 9) { c.beginPath(); c.moveTo(0, y); c.lineTo(PW, y); c.stroke(); }
  c.fillStyle = '#2bd4a0'; c.beginPath(); c.arc(PW * 0.3, PH * 0.45, PH * 0.18, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#ffffff'; c.font = `bold ${Math.round(PH * 0.16)}px sans-serif`; c.fillText('SFX 测试', PW * 0.5, PH * 0.6);
  c.fillStyle = '#000'; c.fillRect(PW * 0.05, PH * 0.8, PW * 0.2, PH * 0.1);
}
let cardUrl = '';
async function cardURL() {
  if (!cardUrl) cardUrl = URL.createObjectURL(await new Promise<Blob>((res) => card.toBlob((b) => res(b!), 'image/png')));
  return cardUrl;
}
// the same card as an engine render target (linear half float): the GL input path
const cardRT = new THREE.WebGLRenderTarget(PW, PH, { type: THREE.HalfFloatType, depthBuffer: false });
{
  const tex = new THREE.CanvasTexture(card);
  tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = true; tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter;
  new FSPass(`uniform sampler2D src; void main(){ fragColor = texture(src, vUv); }`, { src: { value: tex } }).render(renderer, cardRT);
}

// ---------------------------------------------------------------- helpers
const enc8 = (l: number) => {
  const v = l <= 0 ? 0 : l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
};
/** An Sfx output (linear half float, straight alpha) as top-down 8-bit sRGB RGBA; its NaN / Inf count, max value. */
function readSfx(fx: Sfx): { px: Uint8ClampedArray; bad: number; maxLin: number } {
  const w = fx.rt.width, h = fx.rt.height, f = new Float32Array(w * h * 4);
  renderer.setRenderTarget(fx.rt);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, f);
  renderer.setRenderTarget(null);
  const px = new Uint8ClampedArray(w * h * 4);
  let bad = 0, maxLin = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((h - 1 - y) * w + x) * 4, o = (y * w + x) * 4;
    for (let k = 0; k < 4; k++) if (!Number.isFinite(f[i + k]!)) bad++;
    for (let k = 0; k < 3; k++) { px[o + k] = enc8(f[i + k]!); maxLin = Math.max(maxLin, f[i + k]!); }
    px[o + 3] = Math.max(0, Math.min(255, Math.round(f[i + 3]! * 255)));
  }
  return { px, bad, maxLin };
}
const ref2d = document.createElement('canvas');
/** A canvas' pixels, top-down 8-bit straight RGBA. */
function readCanvas(c: HTMLCanvasElement, w: number, h: number): Uint8ClampedArray {
  ref2d.width = w; ref2d.height = h;
  const x = ref2d.getContext('2d', { willReadFrequently: true })!;
  x.clearRect(0, 0, w, h);
  x.drawImage(c, 0, 0, w, h);
  return x.getImageData(0, 0, w, h).data;
}
/** 8-bit RGBA compare: colour where both are mostly opaque; alpha everywhere. */
function compare(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  let max = 0, sum = 0, n = 0, over2 = 0, over8 = 0, amax = 0, worst = -1;
  for (let i = 0; i < a.length; i += 4) {
    amax = Math.max(amax, Math.abs(a[i + 3]! - b[i + 3]!));
    if (a[i + 3]! < 128 || b[i + 3]! < 128) continue;
    const d = Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!));
    if (d > max) worst = i;
    max = Math.max(max, d); sum += d; n++; if (d > 2) over2++; if (d > 8) over8++;
  }
  const at = worst >= 0 ? { x: (worst / 4) % PW, y: Math.floor(worst / 4 / PW), a: Array.from(a.slice(worst, worst + 4)), b: Array.from(b.slice(worst, worst + 4)) } : null;
  return { max, mean: n ? sum / n : 0, over2: n ? over2 / n : 0, over8: n ? over8 / n : 0, alphaMax: amax, opaque: n / (a.length / 4), worst: at };
}
function stats(px: Uint8ClampedArray) {
  let cover = 0, lum = 0, minL = 255, maxL = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3]! > 8) cover++;
    const l = (px[i]! + px[i + 1]! + px[i + 2]!) / 3; lum += l; minL = Math.min(minL, l); maxL = Math.max(maxL, l);
  }
  const n = px.length / 4;
  return { cover: cover / n, lum: lum / n, range: maxL - minL };
}
/** A small PNG (data URL) of 8-bit RGBA pixels over a checkerboard; `gain` > 1 amplifies (difference images). */
function thumb(px: Uint8ClampedArray, w: number, h: number, tw = 384, gain = 1): string {
  const src = document.createElement('canvas'); src.width = w; src.height = h;
  const d = new ImageData(new Uint8ClampedArray(px), w, h);
  if (gain !== 1) for (let i = 0; i < d.data.length; i += 4) { for (let k = 0; k < 3; k++) d.data[i + k] = Math.min(255, d.data[i + k]! * gain); d.data[i + 3] = 255; }
  src.getContext('2d')!.putImageData(d, 0, 0);
  const th = Math.round(h * tw / w), t = document.createElement('canvas'); t.width = tw; t.height = th;
  const c = t.getContext('2d')!;
  for (let y = 0; y < th; y += 8) for (let x = 0; x < tw; x += 8) { c.fillStyle = ((x + y) / 8) % 2 ? '#666' : '#999'; c.fillRect(x, y, 8, 8); }
  c.drawImage(src, 0, 0, tw, th);
  return t.toDataURL('image/png');
}
function diffPx(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  const o = new Uint8ClampedArray(a.length);
  for (let i = 0; i < a.length; i += 4) { for (let k = 0; k < 3; k++) o[i + k] = Math.abs(a[i + k]! - b[i + k]!); o[i + 3] = 255; }
  return o;
}
async function settleLoads(timeout = 20000) {
  const t0 = performance.now();
  while (xmPendingCount() > 0) {
    if (performance.now() - t0 > timeout) throw new Error(`loads still in flight after ${timeout} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const maxDiff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!)); return m; };

function takesChild(name: string) {
  const d = sfxComponents().get(name);
  if (!d) throw new Error(`no component ${name}`);
  return !!(d.requiresChild || d.requiresRTT || d.acceptsOptionalChild);
}
/**
 * The two layer lists of a test: through the library and through Sfx. A filter's child: the card — ImageTexture
 * (library) vs EngineTexture (Sfx) — for stateless lists; for stateful ones a Checkerboard generator on both sides
 * (an image loads asynchronously, and the frames that wait for it would already step the library's simulations).
 */
/**
 * Props a component needs to run without the network: local media and the engine's own fonts (the library's defaults
 * point at shaders.com sample media and Google Fonts, which the test blocks).
 */
async function localProps(name: string): Promise<Record<string, unknown>> {
  if (name === 'EngineTexture') return { source: 'card' };
  if (name === 'ImageTexture') return { url: await cardURL() };
  if (name === 'Text') return { fontFamily: 'Archivo-1000-700' };
  if (name === 'Ascii') return { fontFamily: 'Plex-400' };
  return {};
}
async function lists(name: string, props: Record<string, unknown>, stateful: boolean) {
  props = { ...(await localProps(name)), ...props };
  const child = takesChild(name);
  const url = await cardURL();
  const gen = { type: 'Checkerboard', id: 'img', props: {} };
  const ref = [{ type: name, id: 'fx', props, children: child ? [stateful ? gen : { type: 'ImageTexture', id: 'img', props: { url } }] : undefined }];
  const ours: SfxLayer[] = [{ type: name, id: 'fx', props, children: child ? [stateful ? gen : { type: 'EngineTexture', id: 'img', props: { source: 'card' } }] : undefined }];
  return { ref, ours };
}
function isStateful(name: string, props: Record<string, unknown>) {
  return sfxStateful([{ type: name, props }]);
}

// ---------------------------------------------------------------- tests
/**
 * Stateless: frames at `times` (seconds; the library accumulates the deltas, Sfx sets each t). Stateful: sim steps
 * (round(t * 60)), the first frame seeding with dt 0, then 1/60 per step, from a fresh start on both sides.
 */
async function parity(spec: { name: string; props?: Record<string, unknown>; times?: number[]; thumbs?: boolean; input?: 'canvas' | 'rt'; canvasFormat?: 'rgba16float' | 'bgra8unorm' }) {
  const props = spec.props ?? {};
  const stateful = isStateful(spec.name, props);
  const { ref, ours } = await lists(spec.name, props, stateful);
  const out: Record<string, unknown> = { name: spec.name, props, stateful };
  const times = spec.times ?? (stateful ? [0, 10 / 60, 45 / 60] : [0, 0.73, 2.4]);
  const fx = new Sfx(renderer, ours, { keepNonFinite: true, colorSpace: COLOR_SPACE, canvasFormat: spec.canvasFormat });
  fx.input('card', spec.input === 'rt' ? cardRT : card);
  await fx.init();
  // the reference: the library's own offline path, on a page canvas PW x PH at DPR 1 (the viewport must be as large)
  const rc = document.createElement('canvas');
  Object.assign(rc.style, { width: `${PW}px`, height: `${PH}px`, position: 'absolute', left: '0', top: '0' });
  document.body.appendChild(rc);
  const rr = createRendererFromJSON({ components: ref as never });
  const refErr: string[] = [];
  rr.setOnUnavailable((r) => refErr.push(`unavailable: ${r}`));
  await rr.initialize(rc);
  if (!stateful) {
    // its ImageTexture loads after the first frame, and shows from the frame after the load
    await rr.renderFrame({ deltaSeconds: 0 });
    await settleLoads();
    await rr.renderFrame({ deltaSeconds: 0 });
  } else fx.reset();
  const res: unknown[] = [];
  let refT = 0, k0 = 0, kOurs = 0;
  for (const t of times) {
    // the reference's frame(s), read in this task (right after the submit)
    if (!stateful) {
      rr.renderFrame({ deltaSeconds: t - refT, waitForGpu: false }).catch((e) => refErr.push(String(e)));
      refT = t;
    } else {
      const step = Math.round(t * 60);
      for (let k = k0; k <= step; k++) rr.renderFrame({ deltaSeconds: k === 0 ? 0 : 1 / 60, waitForGpu: false }).catch((e) => refErr.push(String(e)));
      k0 = step + 1;
    }
    const refPx = readCanvas(rc, PW, PH);
    const a = performance.now();
    if (stateful) for (let k = kOurs; k <= Math.round(t * 60); k++) fx.render(k / 60); // every step, as the library did
    else fx.render(t);
    if (stateful) kOurs = Math.round(t * 60) + 1;
    const ms = performance.now() - a;
    const o = readSfx(fx);
    const r: Record<string, unknown> = { frame: stateful ? `step ${Math.round(t * 60)}` : `t=${t}`, ...compare(refPx, o.px), nan: o.bad, maxLin: o.maxLin, ms, refStats: stats(refPx), oursStats: stats(o.px) };
    if (spec.thumbs) { r.refThumb = thumb(refPx, PW, PH); r.oursThumb = thumb(o.px, PW, PH); r.diffThumb = thumb(diffPx(refPx, o.px), PW, PH, 384, 8); }
    res.push(r);
  }
  out.frames = res;
  out.errors = [...fx.errors(), ...refErr, ...(rr.getFailureReason() ? [`ref failed: ${rr.getFailureReason()}`] : [])];
  fx.dispose();
  rr.dispose();
  rc.remove();
  return out;
}

/** The library against itself: the same step sequence through two fresh createRendererFromJSON renderers. */
async function refDeterminism(spec: { name: string; props?: Record<string, unknown>; steps?: number }) {
  const props = spec.props ?? {};
  const { ref } = await lists(spec.name, props, true);
  const out: Uint8ClampedArray[] = [];
  for (let run = 0; run < 2; run++) {
    const rc = document.createElement('canvas');
    Object.assign(rc.style, { width: `${PW}px`, height: `${PH}px`, position: 'absolute', left: '0', top: '0' });
    document.body.appendChild(rc);
    const rr = createRendererFromJSON({ components: ref as never });
    await rr.initialize(rc);
    for (let k = 0; k <= (spec.steps ?? 40); k++) rr.renderFrame({ deltaSeconds: k === 0 ? 0 : 1 / 60, waitForGpu: false });
    out.push(readCanvas(rc, PW, PH));
    rr.dispose(); rc.remove();
  }
  return { name: spec.name, maxDiff: maxDiff(out[0]!, out[1]!) };
}

async function determinism(spec: { name: string; props?: Record<string, unknown> }) {
  const props = spec.props ?? {};
  const { ours } = await lists(spec.name, props, isStateful(spec.name, props));
  const fx = new Sfx(renderer, ours, { keepNonFinite: true, colorSpace: COLOR_SPACE });
  fx.input('card', card);
  await fx.init();
  let m: number, detail: string;
  if (!fx.stateful) {
    fx.render(2.0); const a = readSfx(fx).px;
    for (const t of [0.3, 5.0, 1.1, 2.0 + 1 / 240]) fx.render(t);
    fx.render(2.0); const b = readSfx(fx).px;
    m = maxDiff(a, b); detail = `t=2.0 direct vs after other times: max diff ${m}`;
  } else {
    const run = () => { fx.reset(); for (let k = 0; k <= 40; k++) { fx.setPointer(...pointerAt(k / 60), true); fx.render(k / 60); } return readSfx(fx).px; };
    const a = run(), b = run();
    m = maxDiff(a, b); detail = `41 steps twice (reset between): max diff ${m}`;
  }
  const errors = fx.errors();
  fx.dispose();
  return { name: spec.name, stateful: fx.stateful, ok: m === 0, maxDiff: m, detail, errors };
}

/** A pointer path (0..1, top-left origin) for pointer-driven components: a circle, one turn per second. */
const pointerAt = (t: number): [number, number] => [0.5 + 0.3 * Math.cos(2 * Math.PI * t), 0.5 + 0.3 * Math.sin(2 * Math.PI * t)];

/**
 * Does a frame depend on the frames before it? The list forced stateless: t = 1 after a run of frames from 0 with
 * the pointer moving, vs t = 1 rendered fresh (pointer already at its end). Differs → the component keeps state.
 */
async function history(spec: { name: string; props?: Record<string, unknown> }) {
  const { ours } = await lists(spec.name, spec.props ?? {}, false);
  const px: Uint8ClampedArray[] = [];
  const errors: string[] = [];
  for (const run of [0, 1]) {
    const fx = new Sfx(renderer, ours, { keepNonFinite: true, colorSpace: COLOR_SPACE, stateful: false });
    fx.input('card', card);
    await fx.init();
    const ts = run === 0 ? Array.from({ length: 31 }, (_, k) => k / 30) : [1];
    for (const t of ts) { fx.setPointer(...pointerAt(t), true); fx.render(t); }
    px.push(readSfx(fx).px);
    errors.push(...fx.errors());
    fx.dispose();
  }
  const m = maxDiff(px[0]!, px[1]!);
  return { name: spec.name, declaredStateful: isStateful(spec.name, spec.props ?? {}), historyDependent: m > 1, maxDiff: m, errors };
}

/**
 * library/kit/sfx-shape.ts against the library's analytic shapes: a shape effect over the analytic circle (shape JSON) vs over
 * the same circle drawn into an SDF (shapeSdfUrl). Same convention → the same picture (up to the field's sampling).
 */
async function shapeCalib(spec: { name: string; radius?: number; thumbs?: boolean; props?: Record<string, unknown> }) {
  const r = spec.radius ?? 0.3;
  const url = sdfShape((c, n) => { c.beginPath(); c.arc(n / 2, n / 2, r * n, 0, Math.PI * 2); c.fill(); });
  const variants: Record<string, unknown>[] = [
    { shape: JSON.stringify({ type: 'circleSDF', radius: r }), shapeType: 'circleSDF' },
    { shapeSdfUrl: url, shapeType: '' },
  ];
  const px: Uint8ClampedArray[] = [];
  const errors: string[] = [];
  for (const v of variants) {
    const fx = new Sfx(renderer, [{ type: spec.name, props: { ...(spec.props ?? {}), ...v } }], { keepNonFinite: true, colorSpace: COLOR_SPACE });
    await fx.init();
    fx.render(0.5);
    px.push(readSfx(fx).px);
    errors.push(...fx.errors());
    fx.dispose();
  }
  const out: Record<string, unknown> = { name: spec.name, ...compare(px[0]!, px[1]!), errors };
  if (spec.thumbs) { out.analyticThumb = thumb(px[0]!, PW, PH); out.sdfThumb = thumb(px[1]!, PW, PH); out.diffThumb = thumb(diffPx(px[0]!, px[1]!), PW, PH, 384, 8); }
  return out;
}

/** A text shape (library/kit/sfx-shape.ts sdfText) through a shape effect: a picture to look at. */
async function textShape(spec: { name: string; text?: string; font?: string; props?: Record<string, unknown> }) {
  const { url, aspect } = sdfText(spec.text ?? 'XM 基础引擎', { font: spec.font ?? `900 220px sans-serif` });
  const fx = new Sfx(renderer, [{ type: spec.name, props: { shapeSdfUrl: url, scale: 1.6, ...(spec.props ?? {}) } }], { keepNonFinite: true, colorSpace: COLOR_SPACE });
  await fx.init();
  fx.render(1.0);
  const o = readSfx(fx);
  const errors = fx.errors();
  fx.dispose();
  return { name: spec.name, aspect, nan: o.bad, ...stats(o.px), thumb: thumb(o.px, PW, PH, 960), errors };
}

/**
 * Does stepping matter? t = 1 rendered directly (the stateless path: clocks set, dt 0) vs reached in 1/60 steps from 0
 * (the stateful path) with the pointer moving. A component whose picture integrates dt (waves, springs, trails) or
 * keeps state differs, and must be treated as stateful.
 */
async function stepping(spec: { name: string; props?: Record<string, unknown> }) {
  const { ours } = await lists(spec.name, spec.props ?? {}, false);
  const px: Uint8ClampedArray[] = [];
  const errors: string[] = [];
  for (const stateful of [false, true]) {
    const fx = new Sfx(renderer, ours, { keepNonFinite: true, colorSpace: COLOR_SPACE, stateful });
    fx.input('card', card);
    await fx.init();
    const ts = stateful ? Array.from({ length: 61 }, (_, k) => k / 60) : [1];
    for (const t of ts) { fx.setPointer(...pointerAt(t), true); fx.render(t); }
    px.push(readSfx(fx).px);
    errors.push(...fx.errors());
    fx.dispose();
  }
  const m = maxDiff(px[0]!, px[1]!);
  return { name: spec.name, declaredStateful: isStateful(spec.name, spec.props ?? {}), stepDependent: m > 1, maxDiff: m, errors };
}

/**
 * Every prop through its range on one list: each option of a select, the other value of a boolean, the min and the
 * max of a slider (compile-time variants recompile; the rest are uniform writes). Each variant: a frame, its errors,
 * NaN / Inf, then the prop back to its default.
 */
async function sweep(spec: { name: string }) {
  const def = sfxComponents().get(spec.name)!;
  const stateful = isStateful(spec.name, {});
  const { ours } = await lists(spec.name, {}, false);
  const fx = new Sfx(renderer, ours, { keepNonFinite: true, colorSpace: COLOR_SPACE });
  fx.input('card', cardRT);
  await fx.init();
  const bad: string[] = [];
  let n = 0;
  const frame = async (label: string) => {
    await fx.ready();
    if (stateful) { fx.reset(); for (let k = 0; k <= 6; k++) fx.render(k / 60); } else fx.render(0.7);
    const o = readSfx(fx);
    const errs = fx.errors();
    if (o.bad || errs.length) bad.push(`${label}: ${o.bad ? `${o.bad} NaN/Inf ` : ''}${errs.join(' | ').slice(0, 300)}`);
    n++;
  };
  await frame('defaults');
  for (const [k, c] of Object.entries(def.props)) {
    const cfg = c as { default: unknown; ui?: { type?: string | string[]; options?: { value: unknown }[]; min?: number; max?: number } };
    const types = ([] as string[]).concat(cfg.ui?.type ?? []);
    const vals: unknown[] = [];
    if (cfg.ui?.options?.length) for (const o of cfg.ui.options) { if (o.value !== cfg.default) vals.push(o.value); }
    else if (typeof cfg.default === 'boolean') vals.push(!cfg.default);
    else if (types.includes('range') && typeof cfg.ui?.min === 'number' && typeof cfg.ui?.max === 'number') vals.push(cfg.ui.min, cfg.ui.max);
    for (const v of vals) {
      try { fx.set('fx', { [k]: v }); await frame(`${k}=${JSON.stringify(v)}`); }
      catch (e) { bad.push(`${k}=${JSON.stringify(v)}: threw ${String((e as Error).message ?? e).slice(0, 200)}`); }
    }
    if (vals.length) { try { fx.set('fx', { [k]: cfg.default }); } catch { /* reported above */ } }
  }
  fx.dispose();
  return { name: spec.name, variants: n, bad };
}

/** HDR through the GL input path: a render target filled with values above 1 and near 0 comes out of EngineTexture unchanged. */
async function hdrInput() {
  const rt = new THREE.WebGLRenderTarget(PW, PH, { type: THREE.HalfFloatType, depthBuffer: false });
  const want = [3.0, 0.5, 0.0015, 1];
  renderer.setRenderTarget(rt);
  renderer.setClearColor(new THREE.Color().setRGB(want[0]!, want[1]!, want[2]!, THREE.LinearSRGBColorSpace), want[3]);
  renderer.clear();
  renderer.setRenderTarget(null);
  renderer.setClearColor(0x000000, 0);
  const fx = new Sfx(renderer, [{ type: 'EngineTexture', props: { source: 'hdr' } }], { keepNonFinite: true, colorSpace: COLOR_SPACE });
  fx.input('hdr', rt);
  await fx.init();
  fx.render(0.5);
  const w = fx.rt.width, h = fx.rt.height, f = new Float32Array(w * h * 4);
  renderer.setRenderTarget(fx.rt);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, f);
  renderer.setRenderTarget(null);
  const i = (Math.floor(h / 2) * w + Math.floor(w / 2)) * 4;
  const got = [f[i]!, f[i + 1]!, f[i + 2]!, f[i + 3]!];
  const rel = got.map((v, k) => Math.abs(v - want[k]!) / Math.max(want[k]!, 1e-3));
  const errors = fx.errors();
  fx.dispose(); rt.dispose();
  return { want, got, maxRelErr: Math.max(...rel), ok: Math.max(...rel) < 0.01, errors };
}

/** EngineTexture (the card as a canvas) vs the library's ImageTexture (the same card as a PNG URL), optionally under a filter. */
async function inputVsImage(spec: { filter?: string; props?: Record<string, unknown> }) {
  const url = await cardURL();
  const px: Uint8ClampedArray[] = [];
  const errors: string[] = [];
  for (const leaf of [{ type: 'EngineTexture', props: { source: 'card' } }, { type: 'ImageTexture', props: { url } }]) {
    const layers: SfxLayer[] = spec.filter ? [{ type: spec.filter, props: spec.props ?? {}, children: [leaf] }] : [leaf];
    const fx = new Sfx(renderer, layers, { keepNonFinite: true, colorSpace: COLOR_SPACE });
    fx.input('card', card);
    await fx.init();
    fx.render(0.5);
    px.push(readSfx(fx).px);
    errors.push(...fx.errors());
    fx.dispose();
  }
  return { filter: spec.filter ?? '-', ...compare(px[0]!, px[1]!), errors };
}

/**
 * Cost of fx.render alone: `frames` consecutive frames (stateless: t advancing by 1/60; stateful: one step each) after
 * a warm-up, then one GL sync (a 1-pixel read). ms per frame, at this page's scale (?scale=2: 4K).
 */
async function perf(spec: { name: string; frames?: number; props?: Record<string, unknown> }) {
  const n = spec.frames ?? 30;
  const { ours } = await lists(spec.name, spec.props ?? {}, false);
  const fx = new Sfx(renderer, ours, { keepNonFinite: true, colorSpace: COLOR_SPACE });
  fx.input('card', cardRT);
  await fx.init();
  const px = new Float32Array(4);
  const sync = () => { renderer.setRenderTarget(fx.rt); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px); renderer.setRenderTarget(null); };
  for (let k = 0; k < 5; k++) fx.render(k / 60);
  sync();
  const t0 = performance.now();
  for (let k = 5; k < 5 + n; k++) fx.render(k / 60);
  sync();
  const ms = (performance.now() - t0) / n;
  const errors = fx.errors();
  fx.dispose();
  return { name: spec.name, size: [PW, PH], msPerFrame: ms, errors };
}

/** A custom component (defineShader + WGSL) that paints NaN on its left half: the host must turn it into transparent black. */
async function nanGuard() {
  const Nan = defineShader({
    name: 'XmNanTest',
    props: {},
    paint: wgsl`
      let n = log(-1.0 - uv.x);
      if (uv.x < 0.5) { return vec4f(n, n, n, 1.0); }
      return vec4f(0.2, 0.4, 0.8, 1.0);
    `,
  } as never) as unknown as GpuShaderDefinition;
  const out: Record<string, unknown> = {};
  for (const keep of [true, false]) {
    const fx = new Sfx(renderer, [{ type: 'XmNanTest' }], { colorSpace: COLOR_SPACE, components: [Nan], keepNonFinite: keep });
    await fx.init();
    fx.render(0.5);
    const o = readSfx(fx);
    out[keep ? 'raw' : 'guarded'] = { nan: o.bad, ...stats(o.px) };
    out[keep ? 'rawErrors' : 'guardedErrors'] = fx.errors();
    fx.dispose();
  }
  return out;
}

/**
 * The GL input path's orientation and freshness under the engine's real call patterns: an RT painted top-red /
 * bottom-blue (and a second one green / yellow) through EngineTexture, read back as the top and bottom colour, after
 * (A) one render, (B) four in one task, (C) renders across task boundaries, (D) a blit to the canvas and a task
 * boundary between, (E) the two inputs alternating in one task, (F) after an async PBO read of another target.
 */
async function orientProbe() {
  const mk = (top: [number, number, number], bottom: [number, number, number]) => {
    const rt = new THREE.WebGLRenderTarget(PW, PH, { type: THREE.HalfFloatType, depthBuffer: false });
    const p = new FSPass(`uniform vec3 a, b; void main(){ fragColor = vec4(vUv.y > 0.5 ? a : b, 1.0); }`,
      { a: { value: new THREE.Vector3(...top) }, b: { value: new THREE.Vector3(...bottom) } });
    p.render(renderer, rt);
    return rt;
  };
  const rtA = mk([1, 0, 0], [0, 0, 1]), rtB = mk([0, 1, 0], [1, 1, 0]);
  const fx = new Sfx(renderer, [{ type: 'EngineTexture', props: { source: 'p' } }], { keepNonFinite: true, colorSpace: COLOR_SPACE });
  fx.input('p', rtA);
  await fx.init();
  const look = () => {
    const w = fx.rt.width, h = fx.rt.height, f = new Float32Array(4);
    renderer.setRenderTarget(fx.rt);
    gl.readPixels(Math.floor(w / 2), h - 2, 1, 1, gl.RGBA, gl.FLOAT, f);   // GL row h-2 = image top
    const top = Array.from(f.slice(0, 3)).map((v) => Math.round(v));
    gl.readPixels(Math.floor(w / 2), 1, 1, 1, gl.RGBA, gl.FLOAT, f);
    const bottom = Array.from(f.slice(0, 3)).map((v) => Math.round(v));
    renderer.setRenderTarget(null);
    return `${top.join('')}/${bottom.join('')}`;   // want A: 100/001, B: 010/110
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const blit = new FSPass(`void main(){ fragColor = vec4(0.3, 0.3, 0.3, 1.0); }`, {});
  const out: Record<string, string> = {};
  fx.input('p', rtA); fx.render(0.1); out.A_once = look();
  for (let k = 0; k < 4; k++) fx.render(0.2 + k * 0.01); out.B_fourInTask = look();
  for (let k = 0; k < 3; k++) { await tick(); fx.render(0.3 + k * 0.01); } out.C_acrossTasks = look();
  for (let k = 0; k < 3; k++) { blit.render(renderer, null); await tick(); fx.render(0.4 + k * 0.01); } out.D_blitThenTask = look();
  fx.input('p', rtB); fx.render(0.5); out.E1_switchToB = look();
  fx.input('p', rtA); fx.render(0.51); out.E2_backToA = look();
  fx.input('p', rtB); fx.render(0.52); out.E3_B = look();
  // (F) the export loop: render, then an async PBO read of another target, then the next frame
  const buf = new Uint8Array(PW * PH * 4), fin = new THREE.WebGLRenderTarget(PW, PH, { depthBuffer: false });
  for (let k = 0; k < 3; k++) {
    fx.input('p', rtA); fx.render(0.6 + k * 0.01);
    await renderer.readRenderTargetPixelsAsync(fin, 0, 0, PW, PH, buf);
  }
  out.F_afterAsyncRead = look();
  for (let k = 0; k < 4; k++) { fx.input('p', k % 2 ? rtB : rtA); fx.render(0.7 + k * 0.01); }
  out.G_alternatingLastB = look();
  const errors = fx.errors();
  fx.dispose(); rtA.dispose(); rtB.dispose(); fin.dispose();
  return { ...out, errors };
}

/** The showcase's shape: one Sfx without inputs, then one with TWO EngineTextures in the same list, frame after frame. */
async function orientProbe2(spec: { subframes?: number; asyncRead?: boolean; frames?: number; amount?: number }) {
  const mk = (top: [number, number, number], bottom: [number, number, number]) => {
    const rt = new THREE.WebGLRenderTarget(PW, PH, { type: THREE.HalfFloatType, depthBuffer: false });
    new FSPass(`uniform vec3 a, b; void main(){ fragColor = vec4(vUv.y > 0.5 ? a : b, 1.0); }`,
      { a: { value: new THREE.Vector3(...top) }, b: { value: new THREE.Vector3(...bottom) } }).render(renderer, rt);
    return rt;
  };
  const rtOld = mk([1, 0, 0], [0, 0, 1]), rtNew = mk([0, 1, 0], [1, 1, 0]);
  const other = new Sfx(renderer, [{ type: 'LinearGradient' }], { keepNonFinite: true, colorSpace: COLOR_SPACE });
  // old on the left half, new on the right half (two EngineTextures, one list)
  // the showcase's list: 'new' underneath, 'old' as the page; amount 0 = the page flat (all 'old'), 1 = peeled off (all 'new')
  const two = new Sfx(renderer, [
    { type: 'EngineTexture', props: { source: 'new' } },
    { type: 'PagePeel', id: 'peel', props: { amount: spec.amount ?? 0 }, children: [{ type: 'EngineTexture', props: { source: 'old' } }] },
  ], { keepNonFinite: true, colorSpace: COLOR_SPACE });
  await other.init(); await two.init();
  const read = (x: number, y: number) => { const f = new Float32Array(4); renderer.setRenderTarget(two.rt); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, f); renderer.setRenderTarget(null); return Array.from(f.slice(0, 3)).map((v) => Math.round(v)).join(''); };
  const W2 = two.rt.width, H2 = two.rt.height;
  const look = () => `${read(W2 / 4, H2 - 2)}/${read(W2 / 4, 1)}`;
  const buf = new Uint8Array(PW * PH * 4), fin = new THREE.WebGLRenderTarget(PW, PH, { depthBuffer: false });
  const seen: string[] = [];
  for (let fr = 0; fr < (spec.frames ?? 6); fr++) {
    for (let k = 0; k < (spec.subframes ?? 1); k++) {
      const t = fr / 60 + k / 240;
      other.render(t);
      two.input('old', rtOld); two.input('new', rtNew);
      two.render(t);
      seen.push(`f${fr}.${k} ${look()}`);
    }
    if (spec.asyncRead) await renderer.readRenderTargetPixelsAsync(fin, 0, 0, PW, PH, buf);
    else await new Promise((r) => setTimeout(r, 0));
  }
  const errors = [...other.errors(), ...two.errors()];
  other.dispose(); two.dispose(); rtOld.dispose(); rtNew.dispose(); fin.dispose();
  return { want: (spec.amount ?? 0) >= 1 ? 'new 010/110' : 'old 100/001', seen, errors };
}

/**
 * The host must leave three.js's GL state cache coherent: a flipY canvas texture (as a Layer2D) uploaded after an Sfx
 * render must still come out upright. Each round: redraw the canvas, upload it, draw it to a target, read top and
 * bottom; an Sfx render (its upload sets pixel-store state) between rounds.
 */
async function stateCoherence() {
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
  const c = cv.getContext('2d')!;
  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = true; tex.generateMipmaps = false; tex.minFilter = THREE.NearestFilter; tex.magFilter = THREE.NearestFilter;
  const rt = new THREE.WebGLRenderTarget(64, 64, { type: THREE.HalfFloatType, depthBuffer: false });
  const draw = new FSPass(`uniform sampler2D src; void main(){ fragColor = texture(src, vUv); }`, { src: { value: tex } });
  const fx = new Sfx(renderer, [{ type: 'EngineTexture', props: { source: 'p' } }, { type: 'LinearGradient', props: { opacity: 0.5 } }], { keepNonFinite: true, colorSpace: COLOR_SPACE });
  fx.input('p', cardRT);
  await fx.init();
  const rounds: string[] = [];
  for (let k = 0; k < 4; k++) {
    c.fillStyle = k % 2 ? '#00ff00' : '#ff0000'; c.fillRect(0, 0, 64, 32);   // top half
    c.fillStyle = '#0000ff'; c.fillRect(0, 32, 64, 32);                     // bottom half
    tex.needsUpdate = true;
    draw.render(renderer, rt);
    const f = new Float32Array(4);
    renderer.setRenderTarget(rt);
    gl.readPixels(32, 60, 1, 1, gl.RGBA, gl.FLOAT, f); const top = Array.from(f.slice(0, 3)).map((v) => Math.round(v)).join('');
    gl.readPixels(32, 3, 1, 1, gl.RGBA, gl.FLOAT, f); const bottom = Array.from(f.slice(0, 3)).map((v) => Math.round(v)).join('');
    renderer.setRenderTarget(null);
    rounds.push(`${top}/${bottom}`);
    fx.render(k * 0.1);
  }
  const want = ['100/001', '010/001', '100/001', '010/001'];
  const errors = fx.errors();
  fx.dispose(); rt.dispose(); tex.dispose();
  return { ok: rounds.every((r, i) => r === want[i]), rounds, want, errors };
}

async function inputPaths(spec: { name: string; props?: Record<string, unknown> }) {
  const props = spec.props ?? {};
  const { ours } = await lists(spec.name, props, false);
  const res: Uint8ClampedArray[] = [];
  const errors: string[] = [];
  for (const src of [card, cardRT] as const) {
    const fx = new Sfx(renderer, ours, { keepNonFinite: true, colorSpace: COLOR_SPACE });
    fx.input('card', src);
    await fx.init();
    if (fx.stateful) { fx.reset(); for (let k = 0; k <= 10; k++) fx.render(k / 60); } else fx.render(1.3);
    res.push(readSfx(fx).px);
    errors.push(...fx.errors());
    fx.dispose();
  }
  return { name: spec.name, ...compare(res[0]!, res[1]!), errors };
}

async function smoke(spec: { name: string; props?: Record<string, unknown>; times?: number[] }) {
  const props = spec.props ?? {};
  const { ours } = await lists(spec.name, props, false);
  const t0 = performance.now();
  const fx = new Sfx(renderer, ours, { keepNonFinite: true, colorSpace: COLOR_SPACE });
  fx.input('card', cardRT);
  await fx.init();
  const initMs = performance.now() - t0;
  const frames: unknown[] = [];
  const times = spec.times ?? [0, 0.5, 1.7, 3.3];
  if (fx.stateful) fx.reset();
  for (const t of times) {
    const a = performance.now();
    fx.render(t);
    const o = readSfx(fx);
    frames.push({ t, ms: performance.now() - a, nan: o.bad, maxLin: o.maxLin, ...stats(o.px) });
  }
  const errors = fx.errors();
  fx.dispose();
  return { name: spec.name, props, stateful: fx.stateful, initMs, frames, errors };
}

/** The catalog src/library/sfx组件.md is generated from: every component's description, flags and prop names. */
function catalog() {
  const out: unknown[] = [];
  for (const [key, d] of sfxComponents()) {
    if (key !== d.name) continue;
    out.push({
      name: d.name, category: d.category ?? '', description: d.description ?? '', role: (d as { xmRole?: string }).xmRole ?? '',
      takesChild: takesChild(d.name), stateful: isStateful(d.name, {}), usesPointer: !!d.usesPointer,
      props: Object.keys(d.props), compileTime: Object.entries(d.props).filter(([, c]) => (c as { compileTime?: boolean }).compileTime).map(([k]) => k),
    });
  }
  return out;
}

/** Every component: name, category, role, flags, props (default, options of selects, compileTime). */
function list() {
  const out: unknown[] = [];
  for (const [key, d] of sfxComponents()) {
    if (key !== d.name) continue;
    const props = Object.entries(d.props).map(([k, c]) => {
      const cfg = c as { default: unknown; compileTime?: boolean; ui?: { type?: unknown; options?: { value: unknown }[] } };
      return { name: k, default: cfg.default, compileTime: !!cfg.compileTime, ui: cfg.ui?.type, options: cfg.ui?.options?.map((o) => o.value) };
    });
    out.push({ name: d.name, category: d.category, role: (d as { xmRole?: string }).xmRole, species: (d as { species?: string }).species, takesChild: takesChild(d.name), usesPointer: !!d.usesPointer, stateful: isStateful(d.name, {}), props });
  }
  return out;
}

await loadFonts();
declare global { interface Window { __sfxtest: any } }
window.__sfxtest = { list, catalog, perf, hdrInput, nanGuard, orientProbe, orientProbe2, stateCoherence, refDeterminism, inputVsImage, parity, determinism, history, stepping, sweep, inputPaths, smoke, shapeCalib, textShape, ready: true, size: [W, H, PW, PH] };

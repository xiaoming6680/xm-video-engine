// The engine: owns the renderer, loads scenes for the timeline, renders any song time
// deterministically (with preroll for stateful scenes), composites transitions, HUD, post.
import * as THREE from 'three';
import { AudioData } from './audio';
import { Lyrics } from './lyrics';
import { Compositor, FSPass, W, H, PW, PH, SCALE, SS_TAP, SUBFRAME, makeRT, clearRT, makeRenderer } from './gl';
import { DEFAULT_POST, Post, SHOULDER_GLSL, loadPaper, type PostParams } from './post';
import { Hud } from './hud';
import type { Cue, Frame, Scene, SceneClass, SceneCtx, PostOverrides, TrackPoint } from './scene';
import { loadFonts } from './type';
import { glyphScope } from './glyphcheck';
import { kfe, trackScope } from './tracks';
import { Fx, type Edge, type EffectList } from './effects';
import { Comp, type Layer } from './layers';
import type { Key } from './anim';

/**
 * Where the song's files live: `?song=<dir>` (render.ts --song) reads <dir>/song.wav, audio.json, events.json and
 * lyrics.json instead of audio/song.wav and data/ (a reference film's music in refs/, or trying another song).
 */
export const SONG_DIR = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('song') : null;

export interface TimelineEntry {
  id: string;
  /**
   * Lazy module loader; the module's default export is the Scene class. Leave it out for an effect clip (see `effects`).
   */
  load?: () => Promise<{ default: SceneClass }>;
  /**
   * Effect clip (no `load`): an adjustment layer on the timeline, over whatever scenes are on screen, across cuts.
   * Called every frame in the window with the song time and the time since `start`; returns an effect stack
   * (engine/effects.ts) applied to the composited frame before post. Its `post` overrides apply while it is on screen
   * too (after the scenes' own). Clips apply in timeline order. E.g. two red frames and a smear before a cut:
   *   { id: 'cut3-flash', start: cut - 3 / 30, end: cut, effects: (t) => frameFrom(t, cut) === -2
   *       ? [{ type: 'gradientMap', stops: ['#580420', '#c1a1ad'] }] : [{ type: 'directionalBlur', length: 900 }] }
   */
  effects?: (t: number, lt: number) => EffectList;
  /** What an effect clip's effects see outside the frame (default 'clamp': edge pixels repeat). */
  edge?: Edge;
  /**
   * Transition from the previous entry into this one over their overlap, instead of the crossfade: both pictures handed
   * over as layers (engine/layers.ts), placed however the function says. Called every frame (every sub-frame on
   * export) of the overlap with the song time and `x` = { from, to: the two whole frames as textures, lt: time since
   * this entry's start, dur: the overlap, p: lt / dur }; returns the layers, bottom first, e.g.
   *   transition: (t, x) => [{ texture: x.to }, { texture: x.from, scale: 1 - x.p, rotation: -20 * x.p }]
   * Properties written as functions of the time (`rotation: (tt) => …`) also feed motion blur, smear and the curve
   * readers; plain numbers work too. Whatever the layers leave uncovered is black.
   */
  transition?: (t: number, x: TransitionFrames) => readonly Layer[];
  start: number;
  end: number;
  /**
   * Default post overrides for this entry (the scene's own overrides win), or a function of the song time and the time
   * since `start` (a shake on one frame of an effect clip, a flash that decays).
   */
  post?: PostOverrides | ((t: number, lt: number) => PostOverrides);
  /** Free-form params handed to the scene as ctx.params. */
  params?: Record<string, any>;
  /** Cap on adaptive motion-blur sub-frames while this entry is on screen (for noise that converges slowly). */
  maxSamples?: number;
  /**
   * Time remap (AE's time remapping on a precomp): keyframes from song time to the time the scene sees, e.g.
   * [[s, s], [s + 1, s + 0.25, K.land], [s + 3, s + 3]] slows the first second to a quarter and catches up.
   * The scene gets the remapped time as f.t (and lt, p, beat, audio sample follow it). An editable track named
   * '时间重映射' in the curve editor (G). Not for stateful scenes.
   */
  remap?: Key<number>[];
}

/** What a TimelineEntry.transition gets each frame. */
export interface TransitionFrames { from: THREE.Texture; to: THREE.Texture; lt: number; dur: number; p: number }

interface Loaded { entry: TimelineEntry; scene: Scene | null; error?: string; lastT: number }

/** An entry's post overrides at song time t. */
const entryPost = (e: TimelineEntry, t: number): PostOverrides => (typeof e.post === 'function' ? e.post(t, t - e.start) : e.post ?? {});

/**
 * Per-frame adaptive motion-blur sampling (see Engine.render): the sub-frame count steps through
 * 4, 12, 36, 108, 324 … from `min` up to at most `max` (both rounded to that series) until the frame's
 * estimated remaining sampling error is below `tol` 8-bit levels everywhere (worst 2x2-logical-px block).
 */
export interface AdaptiveSampling { min: number; max: number; tol: number }

/**
 * Shutter offsets (-0.5..0.5) of an adaptive run's sub-frames in rendering order: 4 evenly spread, then
 * each step splits every interval in three, adding a sub-frame either side of each old one. Every
 * prefix of 4·3^l is then evenly spread and centred on the frame's time, and so is each step's new set:
 * comparing the new set's average with the old one's measures sampling error, not a shift in time
 * (with doublings the new half sits half a step later, and any motion at all would read as error).
 */
function ternaryOffsets(steps: number) {
  const u = [0, 1, 2, 3].map((i) => (i + 0.5) / 4 - 0.5);
  for (let l = 0, n = 4; l < steps; l++, n *= 3)
    for (let m = 0; m < n; m++) u.push((3 * m + 0.5) / (3 * n) - 0.5, (3 * m + 2.5) / (3 * n) - 0.5);
  return u;
}

export class Engine {
  renderer: THREE.WebGLRenderer;
  ctx!: SceneCtx;
  audio!: AudioData;
  lyrics!: Lyrics;
  hud!: Hud;
  post!: Post;
  comp = new Compositor();
  loaded = new Map<string, Loaded>();
  private rts = [makeRT(), makeRT(), makeRT()];
  private mixRT = makeRT(W, H, { depthBuffer: false });
  // TimelineEntry.transition: a comp of the two pictures, into one of two targets (never the one it reads)
  private transComp: Comp | null = null;
  private transRT = [makeRT(W, H, { depthBuffer: false }), makeRT(W, H, { depthBuffer: false })];
  // effect clips (TimelineEntry.effects): their runner and two targets to ping-pong through
  private clipFx = new Fx();
  private clipRT = [makeRT(W, H, { depthBuffer: false }), makeRT(W, H, { depthBuffer: false })];
  // motion-blur sub-frame sums (float: up to hundreds of sub-frames), their average, and the error estimate
  private sumRT = makeRT(W, H, { depthBuffer: false, type: THREE.FloatType });
  private newRT = makeRT(W, H, { depthBuffer: false, type: THREE.FloatType });
  private avgRT = makeRT(W, H, { depthBuffer: false });
  private errRT: THREE.WebGLRenderTarget;
  private maxRT: THREE.WebGLRenderTarget;
  private errPass: FSPass;
  private maxPass: FSPass;
  private errBuf: Float32Array;
  /** Sub-frames used for the last rendered frame, and its estimated sampling error after each step. */
  lastSamples = 1;
  lastErrors: number[] = [];
  private finalRT = new THREE.WebGLRenderTarget(PW, PH, { type: THREE.UnsignedByteType, depthBuffer: false });
  // phosphor persistence (post.phosphor): the frame and the decaying earlier refreshes, max-combined
  private persist = [makeRT(W, H, { depthBuffer: false }), makeRT(W, H, { depthBuffer: false })];
  private persistPass: FSPass;
  private persistWarned = false;
  private blit: FSPass;
  private xfade: FSPass;
  private accum: FSPass;
  private lastT = -1;
  lastPost: PostParams = { ...DEFAULT_POST };
  errors: string[] = [];
  /** Suppress the HUD (the corner credit) — used for stills and covers. */
  hudOff = false;
  /** Draw the animatic slate (?animatic): bar number, shot id, section and beat squares in a corner. */
  slate = false;
  /** Post parameters from the URL (?post=k:v,…) that override the scenes' own. */
  private urlPost: Partial<PostParams> = {};

  timeline: TimelineEntry[] = [];

  constructor(public canvas: HTMLCanvasElement, private makeTimeline: (lyrics: Lyrics, audio: AudioData) => TimelineEntry[]) {
    this.renderer = makeRenderer(canvas);
    this.renderer.autoClear = false;
    // (alpha 1: the canvas has an alpha channel, see gl.ts makeRenderer)
    this.blit = new FSPass(`uniform sampler2D src; void main(){ fragColor = vec4(texture(src, vUv).rgb, 1.0); }`, { src: { value: null } });
    this.xfade = new FSPass(`uniform sampler2D a; uniform sampler2D b; uniform float k;
      void main(){ fragColor = mix(texture(a, vUv), texture(b, vUv), k); }`, { a: { value: null }, b: { value: null }, k: { value: 0 } });
    // adds a sub-frame to a sum; a non-finite pixel (a stray NaN from some shader in one sub-frame out of
    // hundreds) is dropped, or it would poison the average and bloom into a disc
    this.accum = new FSPass(`uniform sampler2D src;
      void main() {
        vec4 c = texture(src, vUv);
        bool ok = abs(c.r) <= 6e4 && abs(c.g) <= 6e4 && abs(c.b) <= 6e4 && abs(c.a) <= 6e4;
        fragColor = ok ? c : vec4(0.0);
      }`, { src: { value: null } }, { blending: THREE.CustomBlending, transparent: true });
    this.persistPass = new FSPass(`uniform sampler2D a; uniform sampler2D b; uniform vec3 w;
      void main(){ fragColor = vec4(max(texture(a, vUv).rgb, texture(b, vUv).rgb * w), 1.0); }`, { a: { value: null }, b: { value: null }, w: { value: new THREE.Vector3() } });
    const am = this.accum.mat;
    am.blendEquation = THREE.AddEquation;
    am.blendSrc = THREE.OneFactor; am.blendDst = THREE.OneFactor;
    am.blendSrcAlpha = THREE.ZeroFactor; am.blendDstAlpha = THREE.OneFactor;
    // sampling error: per block of B x B physical px (2x2 logical), how far the displayed average moves when a
    // step's new sub-frames (2n, summed in b) are merged with the n before them (summed in a): 2/3 of the gap
    const B = 2 * SCALE, ew = Math.ceil(PW / B), eh = Math.ceil(PH / B), R = 16;
    const small = { depthBuffer: false, type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, pxScale: 1 } as const;
    this.errRT = makeRT(ew, eh, small);
    this.maxRT = makeRT(Math.ceil(ew / R), Math.ceil(eh / R), small);
    this.errBuf = new Float32Array(this.maxRT.width * this.maxRT.height * 4);
    this.errPass = new FSPass(/* glsl */ `
      uniform sampler2D a; uniform sampler2D b; uniform float invA, invB;
      ${SHOULDER_GLSL}
      vec3 disp(vec3 x) { return toSRGB(sat(shoulder(max(x, 0.0)))); }
      void main() {
        ivec2 p0 = ivec2(gl_FragCoord.xy) * ${B}, lim = ivec2(${PW - 1}, ${PH - 1});
        vec3 sa = vec3(0.0), sb = vec3(0.0);
        for (int y = 0; y < ${B}; y++) for (int x = 0; x < ${B}; x++) {
          ivec2 p = min(p0 + ivec2(x, y), lim);
          sa += texelFetch(a, p, 0).rgb; sb += texelFetch(b, p, 0).rgb;
        }
        vec3 e = abs(disp(sa * (invA / ${B * B}.0)) - disp(sb * (invB / ${B * B}.0)));
        fragColor = vec4(170.0 * max(e.r, max(e.g, e.b)), 0.0, 0.0, 1.0);
      }`, { a: { value: null }, b: { value: null }, invA: { value: 1 }, invB: { value: 1 } });
    this.maxPass = new FSPass(/* glsl */ `
      uniform sampler2D e;
      void main() {
        ivec2 p0 = ivec2(gl_FragCoord.xy) * ${R};
        float m = 0.0;
        for (int y = 0; y < ${R}; y++) for (int x = 0; x < ${R}; x++) {
          ivec2 p = p0 + ivec2(x, y);
          if (p.x < ${ew} && p.y < ${eh}) m = max(m, texelFetch(e, p, 0).r);
        }
        fragColor = vec4(m, 0.0, 0.0, 1.0);
      }`, { e: { value: null } });
  }

  async init(only?: (e: TimelineEntry) => boolean) {
    const dir = SONG_DIR ? `${SONG_DIR.replace(/\/$/, '')}/` : undefined;
    [this.audio, this.lyrics] = await Promise.all([AudioData.load(dir), Lyrics.load(dir), loadFonts()]) as [AudioData, Lyrics, void];
    // ?beatcheck: the beat-check film instead of the project's timeline (docs/音乐分析.md);
    // ?animatic: the project's timeline with a slate (bar number, shot id, section) on every frame
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
    this.timeline = q?.has('beatcheck')
      ? [{ id: 'beatcheck', load: () => import('./beatcheck'), start: 0, end: this.audio.duration }]
      : this.makeTimeline(this.lyrics, this.audio);
    this.slate = !!q?.has('animatic');
    // ?post=riso:1,risoInks:1 — post parameters over every scene's own (trying a look on any scene)
    for (const kv of (q?.get('post') ?? '').split(',').filter(Boolean)) {
      const [k, v] = kv.split(':');
      if (k && v !== undefined && k in DEFAULT_POST) (this.urlPost as any)[k] = +v;
    }
    this.ctx = { renderer: this.renderer, audio: this.audio, lyrics: this.lyrics, comp: this.comp, W, H, id: '', params: {}, start: 0, end: 0 };
    this.post = new Post();
    // the paper scan takes a few hundred ms: load it before the first frame when the timeline or ?post= asks for it
    // (a scene that returns paperTex itself awaits loadPaper() in its own init)
    if ((this.urlPost.paperTex ?? 0) > 0 || this.timeline.some((e) => typeof e.post === 'function' || (e.post?.paperTex ?? 0) > 0)) await loadPaper();
    this.hud = new Hud();
    // with a filter (stills of chosen scenes) the others leave the timeline, so they don't composite as placeholders
    if (only) this.timeline = this.timeline.filter(only);
    await Promise.all(this.timeline.map((e) => this.loadEntry(e)));
  }

  private async loadEntry(e: TimelineEntry) {
    const rec: Loaded = { entry: e, scene: null, lastT: -1 };
    this.loaded.set(e.id, rec);
    if (!e.load) return; // an effect clip: nothing to load
    glyphScope.id = `${e.id} (init)`;
    try {
      const mod = await e.load();
      const s = new mod.default({ ...this.ctx, id: e.id, params: e.params ?? {}, start: e.start, end: e.end });
      await s.init();
      rec.scene = s;
    } catch (err) {
      rec.error = String((err as Error)?.stack ?? err);
      this.errors.push(`[${e.id}] ${rec.error}`);
      console.error(`scene ${e.id} failed`, err);
    }
  }

  /** Hot-swap a scene module (used by Vite HMR in preview). */
  async reload(id: string) {
    const e = this.timeline.find((x) => x.id === id);
    if (!e) return;
    this.loaded.get(id)?.scene?.dispose();
    await this.loadEntry(e);
    this.lastT = -1;
  }

  /** The song's length, or the timeline's end if it runs longer (a reference re-creation timed to another film). */
  get duration() { return Math.max(this.audio.duration, ...this.timeline.map((e) => e.end)); }

  /**
   * Every loaded scene's cues (Scene.cues), plus a 'cut' cue at each timeline entry's start (meant to land on a
   * beat), in time order. Exported by render.ts `cues` for tools/qa/cuecheck.py.
   */
  cues(): (Cue & { scene: string })[] {
    const out: (Cue & { scene: string })[] = [];
    for (const e of this.timeline) {
      if (e.start > 0.001 && e.load) out.push({ t: e.start, name: `cut → ${e.id}`, on: 'beat', scene: e.id });
      const s = this.loaded.get(e.id)?.scene;
      if (s) for (const c of s.cues()) out.push({ ...c, scene: e.id });
    }
    return out.sort((a, b) => a.t - b.t);
  }

  /**
   * Where the active scenes' tracked elements are at t (Scene.track), keyed `entry/name`. Exported per frame by
   * render.ts `track` for tools/qa/trackcheck.py.
   */
  track(t: number): Record<string, TrackPoint> {
    const out: Record<string, TrackPoint> = {};
    for (const e of this.timeline) {
      if (t < e.start || t >= e.end) continue;
      const s = this.loaded.get(e.id)?.scene;
      trackScope.id = e.id; trackScope.t = t;
      if (s) for (const [k, v] of Object.entries(s.track(e.remap ? kfe(t, '时间重映射', e.remap) : t))) out[`${e.id}/${k}`] = v;
    }
    return out;
  }

  /**
   * Let the scenes load what the frame at t needs before it renders (Scene.prepare): every scene on screen anywhere
   * in the frame's shutter (dt x shutter around t, as render() spreads its sub-frames; just t for one sample) gets
   * the frame time and that span, clipped to its window. Resolves when they all have loaded, or null when none had
   * anything to wait for: render right away (callers that may not await, like render.ts sheet, keep working). The
   * export awaits it before every render() with the same dt, samples and shutter; the preview fires it without waiting.
   * A scene whose prepare fails is logged, not fatal: its render() draws what it has.
   */
  prepare(t: number, dt = 1 / 60, samples: number | AdaptiveSampling = 1, shutter = 0.5): Promise<void> | null {
    const w = samples === 1 ? 0 : dt * shutter;
    // (sub-frame times are clamped at 0 in render())
    const t0 = Math.max(0, t - w / 2), t1 = Math.max(0, t + w / 2);
    const waits: Promise<void>[] = [];
    for (const e of this.timeline) {
      if (t1 < e.start || t0 >= e.end) continue;
      const s = this.loaded.get(e.id)?.scene;
      if (!s) continue;
      const fail = (err: unknown) => console.error(`scene ${e.id} prepare error`, err);
      try {
        const p = s.prepare(t, Math.max(t0, e.start), Math.min(t1, e.end));
        if (p) waits.push(p.catch(fail));
      } catch (err) { fail(err); }
    }
    return waits.length ? Promise.all(waits).then(() => {}) : null;
  }

  private frameFor(e: TimelineEntry, ts: number, dt: number, seeked: boolean, preroll: boolean, under: THREE.Texture | null, tin: number, tout: number): Frame {
    // draggable tracks (kfe) in this scene are named after the entry and placed on the song's time (tracks.ts)
    trackScope.id = e.id; trackScope.t = ts;
    const t = e.remap ? kfe(ts, '时间重映射', e.remap) : ts;
    const beat = this.audio.beatAt(t), bar = this.audio.barAt(t);
    return {
      t, dt, lt: t - e.start, p: (t - e.start) / (e.end - e.start), start: e.start, end: e.end, seeked, preroll,
      beat, bar, beatPhase: beat - Math.floor(beat), barPhase: bar - Math.floor(bar),
      a: this.audio.sample(t), under, tin, tout,
    };
  }

  /**
   * Render song time t. `dt` is the nominal frame step (1/fps). A non-sequential t counts as a
   * seek: stateful scenes are reset and fast-forwarded.
   *
   * Motion blur (offline export; the preview uses 1 sample): `samples` > 1 renders that many sub-frames
   * spread evenly over `shutter` x dt around t and averages them before post-processing, which gives real
   * motion blur plus temporal anti-aliasing. With an AdaptiveSampling the count is chosen per frame:
   * sub-frames are added in nested steps (4, 12, 36 … each set evenly spread over the shutter, see
   * ternaryOffsets) until the estimated remaining error is below `tol` levels. Stepped copies of a moving
   * edge shrink as 1/count, so when a step changes the frame by e, what is left is about e/2
   * (e·(1/3 + 1/9 + …)). A still frame stops at 3 x min; a whip pan goes on until its streaks are
   * continuous instead of stepped copies.
   * Returns the number of sub-frames used.
   */
  render(t: number, dt = 1 / 60, toScreen = true, samples: number | AdaptiveSampling = 1, shutter = 0.5): number {
    const r = this.renderer;
    const seeked = this.lastT < 0 || t < this.lastT - 1e-6 || t - this.lastT > Math.max(0.25, dt * 4);
    this.lastT = t;
    let outTex: THREE.Texture;
    let post: PostParams = { ...DEFAULT_POST };
    let n = 1;
    if (samples === 1) {
      SS_TAP.value = -1;
      ({ outTex, post } = this.composite(t, dt, seeked));
    } else {
      const adaptive = typeof samples !== 'number';
      let maxAdaptive = adaptive ? samples.max : 0;
      if (adaptive) {
        // sub-frames are rendered out of time order: fine for pure functions of t, not for scenes that integrate state
        const w = dt * shutter;
        const on = this.timeline.filter((e) => t + w / 2 >= e.start && t - w / 2 < e.end);
        const st = on.find((e) => this.loaded.get(e.id)?.scene?.stateful);
        if (st) throw new Error(`adaptive sampling needs stateless scenes; '${st.id}' is stateful (use a fixed --samples)`);
        for (const e of on) if (e.maxSamples) maxAdaptive = Math.min(maxAdaptive, e.maxSamples);
      }
      // shaders that supersample share their 4 taps across the sub-frames when every set holds a multiple
      // of 4 (rotated by k/4 so a tap doesn't always land in the same part of the shutter)
      const cycle = adaptive || samples % 4 === 0;
      // post parameters (shake, flash, zoom, fades, the HUD's paper mode) are read at one point of the shutter,
      // 1/8 of it after t: where the video was tuned (4 sub-frames, the third) and a point every adaptive set
      // includes. (A flash that starts between t and there shows at its peak on this frame, not one frame on.)
      const POST_U = 0.125;
      let nearest = Infinity;
      // sub-frame k at shutter offset u (-0.5..0.5), summed into `into`; `step` = the sub-frame spacing
      const sub = (k: number, u: number, into: THREE.WebGLRenderTarget, step: number) => {
        SS_TAP.value = cycle ? (k + (k >> 2)) % 4 : -1;
        SUBFRAME.k = k;
        SUBFRAME.s = cycle ? u + 0.5 : -1;
        // (clamped at 0: before the song no scene is active, and frame 0 would come out half black)
        SUBFRAME.t = Math.max(0, t + dt * shutter * u);
        const res = this.composite(SUBFRAME.t, step, seeked && k === 0);
        this.accum.u.src!.value = res.outTex;
        this.accum.render(r, into);
        const d = Math.abs(u - POST_U);
        if (d < nearest - 1e-9 || (d < nearest + 1e-9 && u > POST_U)) { nearest = d; post = res.post; }
      };
      clearRT(r, this.sumRT, [0, 0, 0], 0);
      SUBFRAME.frame = t;
      try {
        if (!adaptive) {
          n = samples;
          for (let k = 0; k < n; k++) sub(k, (k + 0.5) / n - 0.5, this.sumRT, dt / n);
        } else {
          const lg3 = (x: number) => Math.log(x / 4) / Math.log(3);
          const lo = Math.max(0, Math.round(lg3(samples.min))), hi = Math.max(lo, Math.floor(lg3(maxAdaptive) + 1e-9));
          const u = ternaryOffsets(hi);
          n = 4 * 3 ** lo;
          this.lastErrors = [];
          for (let k = 0; k < n; k++) sub(k, u[k]!, this.sumRT, dt / n);
          for (let l = lo; l < hi; l++) {
            clearRT(r, this.newRT, [0, 0, 0], 0);
            for (let k = n; k < 3 * n; k++) sub(k, u[k]!, this.newRT, dt / (3 * n));
            const err = this.sampleError(n) / 2;
            this.lastErrors.push(err);
            this.comp.draw(r, this.newRT.texture, this.sumRT, { mode: 'add', opacity: 1, premult: false });
            n *= 3;
            if (err < samples.tol) break;
          }
        }
      } finally {
        // a scene that throws must not leave the sub-frame state half set (the next frame would read it)
        SS_TAP.value = -1;
        SUBFRAME.k = SUBFRAME.s = -1;
        SUBFRAME.frame = SUBFRAME.t = NaN;
      }
      this.comp.draw(r, this.sumRT.texture, this.avgRT, { mode: 'replace', opacity: 1 / n, premult: false });
      outTex = this.avgRT.texture;
    }
    this.lastSamples = n;
    if ((post.phosphor ?? 0) > 0) outTex = this.phosphor(t, outTex, post.phosphor);
    const hudTex = this.hud.draw(t, { opacity: this.hudOff ? 0 : post.hud, watermark: post.watermark, paper: post.paper, slate: this.slate ? this.slateAt(t) : null });
    this.post.render(r, outTex, hudTex, this.finalRT, post, t);
    this.lastPost = post;
    if (toScreen) {
      this.blit.u.src!.value = this.finalRT.texture;
      this.blit.render(r, null);
    }
    return n;
  }

  /**
   * CRT phosphor persistence (post.phosphor = p): the light of the refreshes before this one is still fading on the
   * glass. The frame is rendered again at t − k/60 (one sample each) and combined as max(frame, p^k · earlier
   * frame): static things stay as they are, a bright thing that moves leaves fading copies, a bright pixel turning
   * dark lags. Blue fades faster (p^1.6k). Still a pure function of t; skipped with stateful scenes on screen.
   */
  private phosphor(t: number, cur: THREE.Texture, p: number): THREE.Texture {
    const r = this.renderer, q = Math.min(p, 0.9);
    const on = this.timeline.filter((e) => t >= e.start - 0.1 && t < e.end);
    if (on.some((e) => this.loaded.get(e.id)?.scene?.stateful)) {
      if (!this.persistWarned) console.warn('phosphor persistence skipped: a stateful scene is on screen');
      this.persistWarned = true;
      return cur;
    }
    const K = Math.min(6, Math.ceil(Math.log(0.03) / Math.log(q)));
    this.blit.u.src!.value = cur;
    this.blit.render(r, this.persist[0]!);
    let a = 0;
    SS_TAP.value = -1;
    for (let k = 1; k <= K; k++) {
      const g = this.composite(Math.max(0, t - k / 60), 1 / 60, false).outTex;
      const w = q ** k;
      this.persistPass.u.a!.value = this.persist[a]!.texture;
      this.persistPass.u.b!.value = g;
      (this.persistPass.u.w!.value as THREE.Vector3).set(w, w, q ** (1.6 * k));
      this.persistPass.render(r, this.persist[1 - a]!);
      a = 1 - a;
    }
    return this.persist[a]!.texture;
  }

  /**
   * How far the displayed frame (8-bit levels, worst block) moves when the 2n sub-frames summed in newRT
   * are merged with the n summed in sumRT. Stepped copies of a fast edge differ between the two
   * interleaved sets; a converged streak does not.
   */
  private sampleError(n: number) {
    const r = this.renderer;
    this.errPass.u.a!.value = this.sumRT.texture;
    this.errPass.u.b!.value = this.newRT.texture;
    this.errPass.u.invA!.value = 1 / n;
    this.errPass.u.invB!.value = 1 / (2 * n);
    this.errPass.render(r, this.errRT);
    this.maxPass.u.e!.value = this.errRT.texture;
    this.maxPass.render(r, this.maxRT);
    r.readRenderTargetPixels(this.maxRT, 0, 0, this.maxRT.width, this.maxRT.height, this.errBuf);
    let m = 0;
    for (let i = 0; i < this.errBuf.length; i += 4) m = Math.max(m, this.errBuf[i]!);
    return m;
  }

  /**
   * Render and composite all scenes active at t into an HDR texture (no post). `dt` is the step handed to
   * scenes (the frame step, or the sub-frame spacing); `seeked` says time jumped before this call.
   */
  private composite(t: number, dt: number, seeked: boolean): { outTex: THREE.Texture; post: PostParams } {
    const r = this.renderer;

    // which entries are on is decided by the frame's own time: in a multi-sample render every sub-frame of a frame sees
    // the same scenes, so a hard cut on a frame stays a cut instead of a half-and-half dissolve (AE: a layer starts on a
    // frame). Each scene still gets the sub-frame's time, kept inside its own window.
    const tf = Number.isNaN(SUBFRAME.frame) ? t : SUBFRAME.frame;
    const on = this.timeline.filter((e) => tf >= e.start && tf < e.end);
    const active = on.filter((e) => e.load).sort((a, b) => a.start - b.start);
    let post: PostParams = { ...DEFAULT_POST };
    let under: THREE.Texture | null = null;
    let outTex: THREE.Texture | null = null;

    active.forEach((e, idx) => {
      const rec = this.loaded.get(e.id);
      const rt = this.rts[idx % this.rts.length]!;
      const prev = active[idx - 1], next = active[idx + 1];
      const tin = prev ? Math.min(1, (t - e.start) / Math.max(1e-3, prev.end - e.start)) : 1;
      const tout = next ? Math.max(0, (t - next.start) / Math.max(1e-3, e.end - next.start)) : 0;
      if (!rec?.scene) {
        clearRT(r, rt, [0.25, 0.0, 0.0]);
        under = rt.texture; outTex = rt.texture;
        return;
      }
      const s = rec.scene;
      const ts = Math.min(Math.max(t, e.start), e.end - 1e-6);
      // (sub-frames of one frame may step back within its shutter: not a seek)
      const sceneSeeked = seeked || rec.lastT < 0 || Math.abs(t - rec.lastT) > 0.25;
      if (s.stateful && sceneSeeked) {
        s.reset();
        const from = Math.max(e.start, t - s.prerollMax);
        const step = 1 / 60;
        let first = true;
        for (let pt = from; pt < t - step * 0.5; pt += step) {
          s.render(this.frameFor(e, pt, first ? 0 : step, first, true, null, 1, 0), rt);
          first = false;
        }
      }
      let ov: PostOverrides | void = undefined;
      glyphScope.id = e.id; glyphScope.t = t;
      try {
        ov = s.render(this.frameFor(e, ts, sceneSeeked ? 0 : dt, sceneSeeked && !s.stateful, false, idx > 0 ? under : null, tin, tout), rt);
      } catch (err) {
        console.error(`scene ${e.id} render error`, err);
        clearRT(r, rt, [0.25, 0.0, 0.0]);
      }
      rec.lastT = t;
      post = { ...post, ...entryPost(e, t), ...(ov ?? {}), ...this.urlPost };
      if (idx > 0 && !s.handlesTransition && under && e.transition) {
        const dur = Math.max(1e-3, prev!.end - e.start), lt = t - e.start;
        const target = this.transRT.find((x) => x.texture !== under)!;
        this.transComp ??= new Comp({ renderer: r, comp: this.comp }, { bg: '#000000' });
        try {
          this.transComp.render(t, target, e.transition(t, { from: under, to: rt.texture, lt, dur, p: Math.min(1, Math.max(0, lt / dur)) }));
          outTex = target.texture;
        } catch (err) {
          console.error(`transition into ${e.id} error`, err);
          outTex = rt.texture;
        }
      } else if (idx > 0 && !s.handlesTransition && under) {
        // default: crossfade from the previous scene over the overlap
        this.xfade.u.a!.value = under;
        this.xfade.u.b!.value = rt.texture;
        this.xfade.u.k!.value = tin;
        this.xfade.render(r, this.mixRT);
        outTex = this.mixRT.texture;
      } else outTex = rt.texture;
      under = outTex;
    });

    if (!outTex) { clearRT(r, this.rts[0]!, [0, 0, 0]); outTex = this.rts[0]!.texture; }
    // effect clips: adjustment layers over the whole frame, across cuts
    let k = 0;
    for (const e of on) {
      if (e.load) continue;
      post = { ...post, ...entryPost(e, t), ...this.urlPost };
      const list = e.effects?.(t, t - e.start) ?? [];
      if (!list.some(Boolean)) continue;
      const dst = this.clipRT[k]!;
      try {
        this.clipFx.run(r, outTex, dst, list, { pxs: SCALE, edge: e.edge ?? 'clamp' });
        outTex = dst.texture;
        k ^= 1;
      } catch (err) { console.error(`effect clip ${e.id} error`, err); }
    }
    return { outTex: outTex as THREE.Texture, post };
  }

  /** What the animatic slate shows at t. */
  private slateAt(t: number) {
    const bar = this.audio.barAt(t), bars = Math.max(1, Math.round(this.audio.barAt(this.duration)));
    const on = this.timeline.filter((e) => t >= e.start && t < e.end);
    return {
      bar: `${String(Math.floor(bar) + 1).padStart(2, '0')}/${bars}`,
      line: `${on.map((e) => e.id).join(' + ') || '—'} · ${this.audio.section(t)?.name ?? ''} · ${t.toFixed(2)}s`,
      beat: Math.floor((bar - Math.floor(bar)) * 4 + 1e-6),
    };
  }

  /** RGBA8 pixels of the last rendered frame (bottom-up rows), PW x PH. */
  readPixels(buf?: Uint8Array) {
    const out = buf ?? new Uint8Array(PW * PH * 4);
    this.renderer.readRenderTargetPixels(this.finalRT, 0, 0, PW, PH, out);
    return out;
  }

  /**
   * Same pixels as readPixels(), read through a pixel-pack buffer and a fence instead of a blocking
   * readPixels: several times faster in Chrome (~15 ms instead of ~40 ms at 1080p, ~150 ms at 4K).
   */
  async readPixelsAsync(buf?: Uint8Array) {
    const out = buf ?? new Uint8Array(PW * PH * 4);
    await this.renderer.readRenderTargetPixelsAsync(this.finalRT, 0, 0, PW, PH, out);
    return out;
  }
}

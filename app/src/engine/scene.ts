// Scene API. A scene owns a time window of the song and renders HDR linear colour
// into the render target it is given. Everything must be a deterministic function of
// time (plus internal state advanced only through render() calls, see `stateful`).
import type * as THREE from 'three';
import type { AudioData, AudioSample } from './audio';
import type { Lyrics } from './lyrics';
import type { Compositor } from './gl';
import type { PostParams } from './post';

export interface SceneCtx {
  renderer: THREE.WebGLRenderer;
  audio: AudioData;
  lyrics: Lyrics;
  comp: Compositor;
  W: number;
  H: number;
  /** Timeline entry id and its free-form params (lets one scene module serve several entries). */
  id: string;
  params: Record<string, any>;
  /** Entry window (song seconds). */
  start: number;
  end: number;
}

export interface Frame {
  /** Song time (s). */
  t: number;
  /** Time since the previous rendered frame (1/fps on export; 0 after a seek). */
  dt: number;
  /** Local time since this scene's start, and 0..1 progress through its window. */
  lt: number;
  p: number;
  start: number;
  end: number;
  /** True when time jumped (scrub/seek) — stateful scenes should reset. */
  seeked: boolean;
  /** True while the engine fast-forwards a stateful scene after a seek (skip non-essential work). */
  preroll: boolean;
  /** Continuous beat/bar indices from the analysed grid, and their fractional phases. */
  beat: number;
  bar: number;
  beatPhase: number;
  barPhase: number;
  /** Audio features at t (envelopes 0..1 and decaying hit pulses). */
  a: AudioSample;
  /**
   * When this scene overlaps the previous one (a transition), the previous scene's
   * output texture for this frame; otherwise null. Scenes that set
   * `handlesTransition = true` composite it themselves.
   */
  under: THREE.Texture | null;
  /** 0..1 progress through the overlap with the previous scene (1 when not overlapping). */
  tin: number;
  /** 0..1 progress through the overlap with the next scene (0 when not overlapping). */
  tout: number;
}

export type PostOverrides = Partial<PostParams>;

/**
 * A moment the scene times to the music: a cut, a hit, a landing. Collected by Engine.cues() and checked by
 * tools/qa/cuecheck.py against the analysis (how many ms off the beat / event it is meant to land on).
 */
export interface Cue {
  /** Song time of the action (s). */
  t: number;
  /** What happens, for the report (e.g. 'title slam', 'ball lands'). */
  name: string;
  /** What it should land on: 'beat', 'downbeat' (default) or a sound-event type ('kick', 'snare', 'clap', …). */
  on?: string;
  /** A sound effect for tools/audio/sfx_mix.py --cues: a synth call ('hit', 'whoosh', 'pop(pitch=1.2)', …) or a wav path. */
  sfx?: string;
}

/**
 * Where one of the scene's main elements is on screen (logical px), for continuity checks: render.ts `track`
 * samples every frame, tools/qa/trackcheck.py finds jumps, stalls and hand-offs that don't connect.
 * `s` scale (any unit, compared frame to frame), `r` rotation (rad).
 */
export interface TrackPoint { x: number; y: number; s?: number; r?: number }

export abstract class Scene {
  /** If true, the engine fast-forwards (calls render with preroll=true) after seeks. */
  stateful = false;
  /** Max seconds of history the engine re-simulates when seeking into a stateful scene. */
  prerollMax = 6;
  /** If true, this scene composites `f.under` itself during its incoming transition. */
  handlesTransition = false;

  constructor(protected ctx: SceneCtx) {}

  /** Cues this scene times to the music (see Cue). Called after init(); return [] if none. */
  cues(): Cue[] { return []; }

  /** Main elements' screen positions at t (see TrackPoint), keyed by a stable name. Return {} if none. */
  track(_t: number): Record<string, TrackPoint> { return {}; }

  /** Load/create resources. Called once before first render. */
  init(): Promise<void> | void {}

  /**
   * Per-frame async loading (Engine.prepare), for what is too big to hold for the whole scene: a pre-rendered image
   * sequence, video frames. Load whatever render() needs at song times t0..t1 — the frame's shutter, so every
   * sub-frame is covered (t0 = t1 = t for one sample); `t` is the frame's own time. Return a promise when there is
   * something to wait for, nothing when it is all there. The export awaits it before rendering the frame (and may
   * call it ahead, for the next frame, while this one renders); the preview does not wait: render() stays synchronous
   * and must draw something sensible meanwhile (the last image it had). Must be cheap when called again for the
   * same frame. Not called for a stateful scene's preroll or the phosphor refreshes.
   */
  prepare(_t: number, _t0: number, _t1: number): Promise<void> | void {}

  /** Reset internal state (called on seeks for stateful scenes). */
  reset(): void {}

  /** Render into `out` (HalfFloat, linear HDR). Must fully overwrite/clear it. Return post-processing overrides. */
  abstract render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides | void;

  dispose(): void {}
}

export type SceneClass = new (ctx: SceneCtx) => Scene;

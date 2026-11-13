// 跟踪数据（tools/track.py 算的点、平面、稳定）贴到图层上。坐标是素材的像素 = 素材图层的图层像素，所以跟着走的图层
// 设成素材层的子层：素材层怎么移动、缩放，它都贴着。时间是素材的来源时间（素材层的 0 秒 = 第一帧），和素材一样按帧停住
// （素材一帧一帧换，贴上去的东西也一帧一帧跟，不会在两帧之间滑）；smooth: true 改成两帧之间插值。
//
//   clip = await loadFootage(r, '/assets/footage/street');
//   trk  = await loadTrack('/assets/footage/street/track_point.json');
//   scr  = await loadTrack('/assets/footage/street/track_planar.json');
//   stab = await loadTrack('/assets/footage/street/track_stabilize.json');
//   comp.layers = [
//     { name: 'plate', footage: clip, start: S, ...stab.stabilized((t) => t - S, { zoom: 1.08 }) },   // 稳定：抵消手抖，放大 8% 盖住边
//     { name: 'tag', parent: 'plate', position: (t) => trk.point('p0', t - S), draw: … },             // 点跟踪：标签钉在人身上
//     { name: 'screen', parent: 'plate', cornerPin: (t) => scr.corners(t - S), draw: … },            // 平面跟踪：画面贴进屏幕
//   ];
//   trk.confidence('p0', t - S)  这一帧的可信度（0–1，低就是跟丢了，自己决定淡出还是不管）
//
// 3D 摄像机反求（tools/camtrack.py）：合成的摄像机就用它，3D 图层、粒子、灯光、three 场景就贴在实拍画面的空间里
//   cam = await loadTrack('/assets/footage/street/track_camera.json');
//   comp = new Comp(ctx, { camera: (t) => cam.camera(t - S) });        // 素材层照常铺满（2D，不跟摄像机）
//   cam.points        反求出来的三维点（合成像素）：挑一个当 3D 图层的 position，东西就钉在那个位置
//   cam.groundY       给了 --ground 时地面的 y：{ threeD: true, rotationX: 90, position: [x, cam.groundY, z] } 就是贴地的一层
// 合成尺寸要和反求时的 --comp 一致（默认和素材一样大）；素材层缩放到正好铺满合成。
import type { Camera } from './space';

type V2 = [number, number];

interface TrackJSON {
  type: 'point' | 'planar' | 'stabilize' | 'camera';
  fps: number;
  first: number;
  size: [number, number];
  frames: number;
  points?: Record<string, [number, number, number][]>;
  corners?: [number, number][][];
  conf?: number[];
  xform?: [number, number, number, number][];
  center?: [number, number];
  comp?: [number, number];
  zoom?: number;
  cameras?: ([number, number, number, number, number, number, number] | null)[];
  cloud?: [number, number, number][];
  ground?: { y: number };
}

export class Track {
  constructor(readonly data: TrackJSON, readonly o: { smooth?: boolean } = {}) {}

  get fps() { return this.data.fps; }
  get frames() { return this.data.frames; }

  /** Frame index (0-based, fractional when smooth) at source time t, clamped to the tracked frames. */
  private idx(t: number): [number, number, number] {
    const n = this.data.frames, x = Math.min(n - 1, Math.max(0, t * this.data.fps));
    if (!this.o.smooth) { const i = Math.min(n - 1, Math.floor(x + 1e-6)); return [i, i, 0]; }
    const i = Math.floor(x);
    return [i, Math.min(n - 1, i + 1), x - i];
  }

  /** A tracked point (source px) at source time t. */
  point(name: string, t: number): V2 {
    const p = this.data.points?.[name];
    if (!p) throw new Error(`track: no point "${name}" (have ${Object.keys(this.data.points ?? {}).join(', ')})`);
    const [i, j, u] = this.idx(t), a = p[i]!, b = p[j]!;
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
  }

  /** A point's confidence (0–1) at source time t; for a planar track, the region's. */
  confidence(name: string | null, t: number): number {
    const [i] = this.idx(t);
    if (name) return this.data.points?.[name]?.[i]?.[2] ?? 0;
    return this.data.conf?.[i] ?? 0;
  }

  /** The planar track's four corners (top-left, top-right, bottom-right, bottom-left; source px) at source time t: a layer's cornerPin. */
  corners(t: number): [V2, V2, V2, V2] {
    const c = this.data.corners;
    if (!c) throw new Error('track: not a planar track');
    const [i, j, u] = this.idx(t);
    return [0, 1, 2, 3].map((k) => [c[i]![k]![0] + (c[j]![k]![0] - c[i]![k]![0]) * u, c[i]![k]![1] + (c[j]![k]![1] - c[i]![k]![1]) * u]) as [V2, V2, V2, V2];
  }

  /** The stabilizing correction at source time t: shift (px), rotation (deg) and scale about the frame centre. */
  correction(t: number): { shift: V2; rotation: number; scale: number } {
    const x = this.data.xform;
    if (!x) throw new Error('track: not a stabilize track');
    const [i, j, u] = this.idx(t), a = x[i]!, b = x[j]!;
    const m = (k: number) => a[k]! + (b[k]! - a[k]!) * u;
    return { shift: [m(0), m(1)], rotation: m(2), scale: m(3) };
  }

  /**
   * The solved camera at source time t (tools/camtrack.py) as a comp camera (comp px, AE's convention). A frame the solve
   * could not place takes the nearest one that it could.
   */
  camera(t: number): Camera {
    const cs = this.data.cameras;
    if (!cs) throw new Error('track: not a camera track');
    const near = (i: number) => {
      for (let d = 0; d < cs.length; d++) { const a = cs[i - d], b = cs[i + d]; if (a) return a; if (b) return b; }
      throw new Error('track: no solved camera');
    };
    const [i, j, u] = this.idx(t), a = near(i), b = near(j);
    const p = [0, 1, 2].map((k) => a[k]! + (b[k]! - a[k]!) * u);
    // quaternion: the shorter way round, normalised lerp (frames are close)
    const s = a[3] * b[3] + a[4] * b[4] + a[5] * b[5] + a[6] * b[6] < 0 ? -1 : 1;
    const q = [3, 4, 5, 6].map((k) => a[k]! + (s * b[k]! - a[k]!) * u), ql = Math.hypot(...q) || 1;
    return { position: p, quaternion: q.map((v) => v / ql), zoom: this.data.zoom };
  }
  /** The solve's 3D points (comp px). */
  get points(): readonly (readonly [number, number, number])[] { return this.data.cloud ?? []; }
  /** The ground's height in comp px (when the solve was given --ground). */
  get groundY(): number | undefined { return this.data.ground?.y; }

  /**
   * The footage layer's transform that applies the stabilization (anchor at the frame centre): spread it into the layer.
   * `src(t)`: the layer's comp time → footage source time; `at`: where the frame centre sits in the comp (default the
   * comp position the layer would have anyway, [w/2, h/2] of the footage); `zoom`: extra scale to hide the edges.
   */
  stabilized(src: (t: number) => number = (t) => t, o: { at?: V2; zoom?: number } = {}) {
    const [w, h] = this.data.size, c = this.data.center ?? [w / 2, h / 2], at = o.at ?? c, z = o.zoom ?? 1;
    return {
      anchor: c as V2,
      position: (t: number): V2 => { const k = this.correction(src(t)); return [at[0] + k.shift[0] * z, at[1] + k.shift[1] * z]; },
      rotation: (t: number) => this.correction(src(t)).rotation,
      scale: (t: number) => this.correction(src(t)).scale * z,
    };
  }
}

/** Load a track JSON written by tools/track.py (served under the app, e.g. /assets/footage/<name>/track_<id>.json). */
export async function loadTrack(url: string, o: { smooth?: boolean } = {}): Promise<Track> {
  const r = await fetch(url);
  if (!r.ok || /text\/html/.test(r.headers.get('content-type') ?? '')) throw new Error(`track: ${url} not found (python tools/track.py …)`);
  return new Track((await r.json()) as TrackJSON, o);
}

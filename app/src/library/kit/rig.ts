// 象形小人的绑定：关节角度当关键帧，姿势之间平滑插值；跑步循环、起跳 / 腾空 / 落地都是设计过的关键姿势，
// 不是正弦摆动。外加一条围巾：它就是脖子在过去一小段时间里走过的路径（再被风吹一点），所以跟随、甩尾都是自动的，
// 也只取决于 t。
//
//   const pose = runPose(beatPhase / 2)              // 两拍一个循环：脚步踩在拍上（走路用 walkPose）
//   const p2 = blendPose(pose, POSES.crouch, w)      // 往预备姿势混
//   drawFigure(c, x, y, size, pose, { color, gap })  // (x, y) 是胯
//   drawFigure(c, x, y, size, pose, { color, build: AGE_BUILD.old })  // 按年龄的身体比例（小孩大头短腿、老人驼背）
//   const j = joints(pose, size)                      // 关节位置（围巾挂在 j.neck，镜头跟 j.hip …）
//
// 角度约定：0 = 竖直向下，正 = 朝前（脸朝 +x）。膝 / 肘是相对弯曲量（膝往后弯为正，肘往前弯为正）。
import { lerp, TAU, type V2 } from '../../engine/util';
import { kfLoop } from './anim';
import { ribbon } from './morph';

export interface Pose {
  /** Torso lean forward (rad). */
  lean: number;
  /** Hip lift (fraction of size, + = down): the body dips on contact and rises in flight. */
  drop: number;
  /** Leg A (near side): thigh angle, knee bend. Leg B (far side). */
  hipA: number; kneeA: number; hipB: number; kneeB: number;
  /** Arm A (near side): upper arm angle, elbow bend. Arm B (far side). */
  shA: number; elA: number; shB: number; elB: number;
  /** Head tilt (rad, + = chin down). */
  head: number;
}
const KEYS: (keyof Pose)[] = ['lean', 'drop', 'hipA', 'kneeA', 'hipB', 'kneeB', 'shA', 'elA', 'shB', 'elB', 'head'];

export const blendPose = (a: Pose, b: Pose, u: number): Pose =>
  Object.fromEntries(KEYS.map((k) => [k, lerp(a[k], b[k], u)])) as unknown as Pose;
const mirror = (p: Pose): Pose => ({ ...p, hipA: p.hipB, kneeA: p.kneeB, hipB: p.hipA, kneeB: p.kneeA, shA: p.shB, elA: p.elB, shB: p.shA, elB: p.elA });

// One step of a sprint (leg A forward); the second step is the mirror. Phases over the full cycle 0..1.
const STEP: [number, Pose][] = [
  // contact: front heel down, back leg trailing off the toe
  [0.0, { lean: 0.2, drop: 0.0, hipA: 0.62, kneeA: 0.12, hipB: -0.5, kneeB: 0.95, shA: -0.85, elA: 1.35, shB: 0.95, elB: 1.75, head: 0.05 }],
  // down: weight on the front leg, knee absorbs, body lowest
  [0.11, { lean: 0.26, drop: 0.05, hipA: 0.28, kneeA: 0.62, hipB: -0.15, kneeB: 1.75, shA: -0.45, elA: 1.45, shB: 0.55, elB: 1.65, head: 0.08 }],
  // passing: back leg swings through tucked high
  [0.24, { lean: 0.24, drop: 0.015, hipA: -0.12, kneeA: 0.25, hipB: 0.45, kneeB: 2.05, shA: 0.05, elA: 1.5, shB: -0.05, elB: 1.5, head: 0.04 }],
  // push-off / flight: stance leg extended behind, knee drive up front, body highest
  [0.37, { lean: 0.2, drop: -0.055, hipA: -0.65, kneeA: 0.2, hipB: 0.95, kneeB: 1.25, shA: 0.9, elA: 1.7, shB: -0.9, elB: 1.3, head: 0.0 }],
];
const CYCLE: [number, Pose][] = [...STEP, ...STEP.map(([p, q]) => [p + 0.5, mirror(q)] as [number, Pose])];

/** Sprint pose at cycle phase 0..1 (one cycle = two steps; contact at 0 and 0.5). */
export function runPose(phase: number): Pose {
  return Object.fromEntries(KEYS.map((k) => [k, kfLoop(phase, CYCLE.map(([p, q]) => [p, q[k]] as const))])) as unknown as Pose;
}

// A walk: always one foot down, small bob, arms swing low.
const WSTEP: [number, Pose][] = [
  [0.0, { lean: 0.06, drop: 0.012, hipA: 0.36, kneeA: 0.05, hipB: -0.3, kneeB: 0.3, shA: -0.35, elA: 0.35, shB: 0.35, elB: 0.45, head: 0.02 }],
  [0.14, { lean: 0.07, drop: 0.025, hipA: 0.2, kneeA: 0.2, hipB: -0.12, kneeB: 0.7, shA: -0.2, elA: 0.35, shB: 0.2, elB: 0.4, head: 0.03 }],
  [0.27, { lean: 0.06, drop: 0.0, hipA: -0.02, kneeA: 0.04, hipB: 0.12, kneeB: 0.85, shA: 0.0, elA: 0.3, shB: 0.0, elB: 0.3, head: 0.02 }],
  [0.39, { lean: 0.06, drop: -0.008, hipA: -0.25, kneeA: 0.08, hipB: 0.32, kneeB: 0.35, shA: 0.3, elA: 0.4, shB: -0.3, elB: 0.35, head: 0.02 }],
];
const WCYCLE: [number, Pose][] = [...WSTEP, ...WSTEP.map(([p, q]) => [p + 0.5, mirror(q)] as [number, Pose])];
/** Walking pose at cycle phase 0..1 (one cycle = two steps). */
export function walkPose(phase: number): Pose {
  return Object.fromEntries(KEYS.map((k) => [k, kfLoop(phase, WCYCLE.map(([p, q]) => [p, q[k]] as const))])) as unknown as Pose;
}

/** Hand-set poses for jumps, landings and holds. */
export const POSES = {
  stand: { lean: 0.02, drop: 0, hipA: 0.08, kneeA: 0.05, hipB: -0.08, kneeB: 0.05, shA: 0.1, elA: 0.2, shB: -0.1, elB: 0.2, head: 0 },
  /** Wind-up before a jump: deep crouch, arms swung back. */
  crouch: { lean: 0.55, drop: 0.16, hipA: 1.15, kneeA: 1.9, hipB: 0.9, kneeB: 1.7, shA: -1.3, elA: 0.5, shB: -1.1, elB: 0.6, head: 0.15 },
  /** Take-off: whole body a straight line, arms thrown forward-up. */
  launch: { lean: 0.12, drop: -0.04, hipA: -0.35, kneeA: 0.05, hipB: 0.55, kneeB: 0.9, shA: 2.5, elA: 0.3, shB: 2.2, elB: 0.4, head: -0.15 },
  /** Top of the jump: knees tucked, arms out. */
  tuck: { lean: 0.35, drop: -0.02, hipA: 1.35, kneeA: 2.1, hipB: 1.05, kneeB: 2.2, shA: 1.6, elA: 0.9, shB: 1.2, elB: 1.1, head: 0.1 },
  /** Reaching down for the ground. */
  reach: { lean: 0.1, drop: -0.03, hipA: 0.5, kneeA: 0.25, hipB: 0.15, kneeB: 0.5, shA: 1.9, elA: 0.4, shB: 1.4, elB: 0.6, head: -0.05 },
  /** Landing: absorb, arms forward for balance. */
  land: { lean: 0.45, drop: 0.13, hipA: 0.95, kneeA: 1.6, hipB: 0.7, kneeB: 1.45, shA: 1.1, elA: 0.7, shB: 0.8, elB: 0.8, head: 0.12 },
  /** Curled up small (a newborn, or someone hugging their knees). */
  curl: { lean: 0.9, drop: 0.18, hipA: 1.9, kneeA: 2.5, hipB: 1.7, kneeB: 2.45, shA: 1.2, elA: 1.6, shB: 1.0, elB: 1.7, head: 0.5 },
  /** Reaching straight up for something just out of reach, on tiptoe. */
  reachUp: { lean: -0.05, drop: -0.04, hipA: 0.05, kneeA: 0.0, hipB: -0.12, kneeB: 0.25, shA: 2.95, elA: 0.05, shB: 2.4, elB: 0.25, head: -0.35 },
  /** Hands hidden behind the back, weight on one leg. */
  behind: { lean: -0.04, drop: 0.0, hipA: 0.1, kneeA: 0.15, hipB: -0.08, kneeB: 0.05, shA: -0.55, elA: -0.9, shB: -0.5, elB: -0.85, head: 0.12 },
  /** Looking down at something held in both hands. */
  phone: { lean: 0.08, drop: 0.0, hipA: 0.06, kneeA: 0.05, hipB: -0.06, kneeB: 0.05, shA: 0.25, elA: 1.65, shB: 0.15, elB: 1.75, head: 0.55 },
  /** Sitting on a chair (seat at hip height), hands on the knees. */
  sit: { lean: 0.05, drop: 0.0, hipA: 1.5, kneeA: 1.5, hipB: 1.45, kneeB: 1.5, shA: 0.75, elA: 0.55, shB: 0.65, elB: 0.6, head: 0.25 },
  /** Standing still, shoulders dropped. */
  slump: { lean: 0.1, drop: 0.01, hipA: 0.05, kneeA: 0.08, hipB: -0.05, kneeB: 0.06, shA: -0.05, elA: 0.1, shB: 0.05, elB: 0.12, head: 0.4 },
} satisfies Record<string, Pose>;

/** Body proportions (1 = the default adult): a child has a big head and short limbs, an old body stoops. */
export interface Build { head?: number; torso?: number; leg?: number; arm?: number; stoop?: number }
export const AGE_BUILD = {
  baby: { head: 1.55, torso: 0.62, leg: 0.5, arm: 0.6 },
  child: { head: 1.35, torso: 0.75, leg: 0.72, arm: 0.78 },
  teen: { head: 1.08, torso: 0.95, leg: 0.97, arm: 0.97 },
  adult: {},
  middle: { head: 1.0, torso: 1.0, leg: 0.98, arm: 1.0, stoop: 0.12 },
  old: { head: 1.02, torso: 0.92, leg: 0.9, arm: 0.95, stoop: 0.45 },
} satisfies Record<string, Build>;

export interface Joints {
  hip: V2; neck: V2; head: V2; headR: number;
  kneeA: V2; footA: V2; kneeB: V2; footB: V2;
  elbowA: V2; handA: V2; elbowB: V2; handB: V2;
  /** Middle of the back (a stooped spine bends here). */
  mid?: V2;
}

/** Joint positions for a pose at figure size `s` (≈ head-to-foot height), hip at the origin, facing +x. */
export function joints(p: Pose, s: number, b: Build = {}): Joints {
  const T = b.torso ?? 1, Lg = b.leg ?? 1, A = b.arm ?? 1, Hd = b.head ?? 1, st = b.stoop ?? 0;
  const dir = (th: number, L: number): V2 => ({ x: Math.sin(th) * L * s, y: Math.cos(th) * L * s });
  const add = (a: V2, c: V2): V2 => ({ x: a.x + c.x, y: a.y + c.y });
  const hip: V2 = { x: 0, y: p.drop * s };
  // a stooped back: the upper torso bends further forward than the lower
  const lean = p.lean + st * 0.5;
  const mid = add(hip, { x: Math.sin(lean) * 0.165 * T * s, y: -Math.cos(lean) * 0.165 * T * s });
  const neck = add(mid, { x: Math.sin(lean + st) * 0.165 * T * s, y: -Math.cos(lean + st) * 0.165 * T * s });
  const head = add(neck, { x: Math.sin(lean + st * 0.6 + p.head) * 0.15 * Hd * s, y: -Math.cos(lean + st * 0.6 + p.head) * 0.15 * Hd * s });
  const kneeA = add(hip, dir(p.hipA, 0.25 * Lg)), footA = add(kneeA, dir(p.hipA - p.kneeA, 0.25 * Lg));
  const kneeB = add(hip, dir(p.hipB, 0.25 * Lg)), footB = add(kneeB, dir(p.hipB - p.kneeB, 0.25 * Lg));
  const sh = add(neck, { x: -Math.sin(lean) * 0.03 * s, y: Math.cos(lean) * 0.03 * s });
  const elbowA = add(sh, dir(p.shA, 0.18 * A)), handA = add(elbowA, dir(p.shA + p.elA, 0.16 * A));
  const elbowB = add(sh, dir(p.shB, 0.18 * A)), handB = add(elbowB, dir(p.shB + p.elB, 0.16 * A));
  return { hip, neck, head, headR: 0.1 * Hd * s, kneeA, footA, kneeB, footB, elbowA, handA, elbowB, handB, mid };
}

export interface FigureStyle {
  color: string;
  /** Colour of the thin cut between the near limbs and the body (the background); none = solid silhouette. */
  gap?: string;
  /** Face -x instead of +x. */
  flip?: boolean;
  /** Rotation of the whole figure about the hip (rad): running along a slope / a loop. */
  rot?: number;
  /** Limb thickness as a fraction of size. */
  limb?: number;
  /** Body proportions (AGE_BUILD). */
  build?: Build;
}

/** Draw the figure with its hip at (x, y). */
export function drawFigure(c: CanvasRenderingContext2D, x: number, y: number, s: number, p: Pose, st: FigureStyle) {
  const j = joints(p, s, st.build);
  const w = (st.limb ?? 0.1) * s;
  c.save();
  c.translate(x, y);
  if (st.rot) c.rotate(st.rot);
  if (st.flip) c.scale(-1, 1);
  c.lineCap = 'round';
  c.lineJoin = 'round';
  const line = (pts: V2[], width: number, color: string) => {
    c.strokeStyle = color;
    c.lineWidth = width;
    c.beginPath();
    c.moveTo(pts[0]!.x, pts[0]!.y);
    for (const q of pts.slice(1)) c.lineTo(q.x, q.y);
    c.stroke();
  };
  // the cut starts a little way down the limb so hip and shoulder stay whole
  const cut = (a: V2, b: V2, e: V2): V2[] => [{ x: lerp(a.x, b.x, 0.45), y: lerp(a.y, b.y, 0.45) }, b, e];
  line([j.neck, j.elbowB, j.handB], w, st.color);
  line([j.hip, j.kneeB, j.footB], w, st.color);
  line(j.mid ? [j.hip, j.mid, j.neck] : [j.hip, j.neck], w * 1.45, st.color);
  c.fillStyle = st.color;
  c.beginPath();
  c.arc(j.head.x, j.head.y, j.headR, 0, TAU);
  c.fill();
  if (st.gap) line(cut(j.hip, j.kneeA, j.footA), w + 0.045 * s, st.gap);
  line([j.hip, j.kneeA, j.footA], w, st.color);
  if (st.gap) line(cut(j.neck, j.elbowA, j.handA), w + 0.045 * s, st.gap);
  line([j.neck, j.elbowA, j.handA], w, st.color);
  c.restore();
}

/** Neck position in the parent space for a figure drawn at (x, y) with these settings. */
export function neckAt(x: number, y: number, s: number, p: Pose, st: Pick<FigureStyle, 'flip' | 'rot' | 'build'> = {}): V2 {
  const n = joints(p, s, st.build).neck;
  const nx = st.flip ? -n.x : n.x, r = st.rot ?? 0;
  return { x: x + nx * Math.cos(r) - n.y * Math.sin(r), y: y + nx * Math.sin(r) + n.y * Math.cos(r) };
}

/**
 * The scarf: the path the neck took over the last `span` seconds (`neckWorld(t)` must be a pure function of
 * time), blown back by `wind` (px/s, world) with a travelling flutter. Returns the ribbon polygon, fat at
 * the neck, tapering to the tail.
 */
export function scarf(neckWorld: (t: number) => V2, t: number, size: number, o: { span?: number; n?: number; wind?: V2; flutter?: number } = {}): V2[] {
  const span = o.span ?? 0.28, n = o.n ?? 22, wind = o.wind ?? { x: -260, y: -40 }, fl = o.flutter ?? 0.05;
  const pts: V2[] = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1), back = u * span;
    const p = neckWorld(t - back);
    const wave = Math.sin(t * 22 - u * 7) * fl * size * u;
    pts.push({ x: p.x + wind.x * back, y: p.y + wind.y * back + wave });
  }
  return ribbon(pts, 0.075 * size, 0.02 * size);
}

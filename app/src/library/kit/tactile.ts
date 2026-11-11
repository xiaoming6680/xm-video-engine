// 实物感：纸片、贴纸、卡片像真东西一样被拿起、拍到台面上、投下影子。输出只取决于 t（确定性）。
//
// 为什么要它：纸片剧场被说“劣质感”，一个原因是影子烘死在图层里（偏移、模糊永远一样），东西看起来是印在背景上的。
// 真东西离台面越高，影子离得越远、越虚、越淡；落下来那一下会被压扁一点再弹回。
// 参数取自 mg-styles-15（Vincentwei1021，MIT）拼贴和贴纸科普两支片的做法。
//
//   const p = slap(t, 3.2);                         // 3.2 s 拍到台面上
//   if (p.visible) drawLifted(c, p, (c) => c.drawImage(img, -img.width / 2, -img.height / 2), x, y);
//   cut(c, path, fill, liftShadow(0.3));            // paper.ts 的纸片：抬起 0.3 的影子
import { clamp, lerp, TAU } from '../../engine/util';

export interface ShadowOpts {
  /** Shadow offset (px) lying flat on the table, and how much further it falls at lift 1 (light from the upper left). */
  rest?: readonly [number, number];
  reach?: readonly [number, number];
  /** Blur (px) at lift 0 and its growth at lift 1. */
  blur?: readonly [number, number];
  /** Opacity at lift 0 and its change at lift 1 (higher = fainter). */
  alpha?: readonly [number, number];
}

/**
 * The drop shadow of a flat thing `lift` above the table (0 = lying on it, 1 = held up near the camera), as
 * [dx, dy, blur, alpha] — the shadow tuple of paper.ts `cut()`. Further, softer and fainter as it rises.
 */
export function liftShadow(lift: number, o: ShadowOpts = {}): [number, number, number, number] {
  const l = Math.max(0, lift);
  const [rx, ry] = o.rest ?? [3, 5], [kx, ky] = o.reach ?? [24, 34], [b0, b1] = o.blur ?? [6, 34], [a0, a1] = o.alpha ?? [0.26, -0.08];
  return [rx + kx * l, ry + ky * l, b0 + b1 * l, clamp(a0 + a1 * l, 0, 1)];
}

export interface Pose { visible: boolean; x: number; y: number; scale: number; rot: number; lift: number }
export interface SlapOpts {
  /** Fall time (s) before t0: it drops from the camera onto the table, accelerating (no ease-out: it is thrown). */
  dur?: number;
  /** Scale and rotation (rad) when it enters, lifted up at the camera; offset (px) it travels from. */
  scale?: number;
  rot?: number;
  from?: readonly [number, number];
  /** Rotation it lands at. */
  rest?: number;
  /** The impact: squashed by `squash` on landing, then rings at `freq` Hz decaying at `decay` 1/s (.972 → 1.01 → 1). */
  squash?: number;
  freq?: number;
  decay?: number;
}

/**
 * Slapped onto the table at t0: before t0 − dur it is not there; then it falls from lift 1 (big, tilted, its shadow far
 * and soft) to lift 0 (accelerating), and on impact squashes and rings down. Draw with drawLifted.
 */
export function slap(t: number, t0: number, o: SlapOpts = {}): Pose {
  const dur = o.dur ?? 0.2, s0 = o.scale ?? 1.3, r0 = o.rot ?? 0.1, rest = o.rest ?? 0, [fx, fy] = o.from ?? [0, 0];
  if (t < t0 - dur) return { visible: false, x: fx, y: fy, scale: s0, rot: rest + r0, lift: 1 };
  if (t < t0) {
    const e = ((t - (t0 - dur)) / dur) ** 2;
    return { visible: true, x: lerp(fx, 0, e), y: lerp(fy, 0, e), scale: lerp(s0, 1, e), rot: rest + r0 * (1 - e), lift: 1 - e };
  }
  const x = t - t0, ring = Math.exp(-(o.decay ?? 10) * x) * Math.cos(TAU * (o.freq ?? 4.5) * x);
  // the rotation carries a little of its fall into the landing and rocks back
  const rock = r0 * 0.12 * Math.exp(-(o.decay ?? 10) * x) * Math.sin(TAU * (o.freq ?? 4.5) * x);
  return { visible: true, x: 0, y: 0, scale: 1 - (o.squash ?? 0.028) * ring, rot: rest + rock, lift: 0 };
}

/**
 * Draw a lifted thing at (x, y) + its pose offset, with a lift-dependent shadow. `draw` paints it centred on the origin
 * in ONE call (an image or a single path): Canvas2D casts a shadow per call, so something built from several shapes
 * would shade itself — paint those into an offscreen canvas first. The shadow stays put in screen space as the thing
 * turns (the light does not rotate with it) and scales with the current transform (camera zoom).
 */
export function drawLifted(c: CanvasRenderingContext2D, p: Pose, draw: (c: CanvasRenderingContext2D) => void, x = 0, y = 0, o: ShadowOpts = {}) {
  if (!p.visible) return;
  const m = c.getTransform(), k = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  const [dx, dy, blur, a] = liftShadow(p.lift, o);
  c.save();
  c.translate(x + p.x, y + p.y);
  c.rotate(p.rot);
  c.scale(p.scale, p.scale);
  c.shadowOffsetX = dx * k; c.shadowOffsetY = dy * k; c.shadowBlur = blur * k; c.shadowColor = `rgba(20,14,8,${a})`;
  draw(c);
  c.restore();
}

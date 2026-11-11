// 换张（有限动画、拼图动态）：同一个角色 / 道具的几张关键图，按时间一张换一张。每张标一个锚点（踩地的脚、腰、手腕、笔尖），
// 换张时锚点落在同一个地方，人不跳；再标第二个锚点，就连方向、大小一起对上（手腕 → 笔尖：换手势时笔尖和手腕都不动）。
// 不替画面做决定：几拍一张、停多久、什么时候换由这支片定。
//
// 用法：
//   const run = new Swap(this.ctx, [
//     { src: img0, anchor: [212, 980] },                  // 图片 / canvas / ImageBitmap / 纹理；anchor 按这张图的像素（默认图中心）
//     { src: img1, anchor: [230, 975] }, …
//   ], { keys: Swap.seq(2.0, [0, 1, 2, 3], beat / 4, { until: 6 }) });
//   comp.layers = [{ name: 'girl', ...run.layer(), position: (t) => [x(t), 900], scale: 0.6 }];   // position = 锚点落在哪
//   // 一个 Swap 可以给几个图层用（同一张图再叠一层当影子：{ ...run.layer(), effects: [{ type: 'fill', color: '#000' }], … }）
//
// 选项：
//   keys      [[时间, 第几张], …]：从这个时间起换成这一张（图层时间，就是图层 draw / render 拿到的 t；第一个时间之前是第一张）
//   frame     (t) => 第几张：自己算（给了就不看 keys；t 已经是这一帧的时间）
//   minHold   每张至少停几秒：离上一次换张不到这么久的换张跳过（换得太碎看着闪就加）
//   fps       换张对齐到 1/fps 秒的格子（手绘层按 15、12 一格；不给 = 不对齐）
//   ref       哪一张当标准（默认 0）：所有图按它的锚点、方向、大小摆
//   fit       有第二个锚点时怎么对：'turnScale'（默认，转 + 缩）| 'turn'（只转）| 'move'（只对第一个锚点）
// 每张图：
//   src       同一张图可以在几处出现（[a, b, a, c] 那样排）
//   anchor    锚点（这张图的像素）；toward  第二个锚点
//   scale     这张图自己先缩放多少（不同分辨率生成的图统一成同一个「米 / 像素」）
// 方法：
//   layer()            { render, size, anchor }：展开进一个 Layer，图层的变换、效果、蒙版、运动模糊照常写；图层的 anchor 是标准锚点
//   index(t)           这一帧放第几张。同一帧的子帧拿到同一张：一个快门里不会印出两张
//   aim(from, to)      { position, rotation, scale }：让标准的那一对锚点落到 from、to（笔尖跟着笔画走、手腕跟着一条平滑的路径）；
//                      展开进图层：{ ...run.layer(), ...run.aim(tip, wrist) }，属性要随时间变就写成 (t) => run.aim(…).rotation
//   Swap.seq(start, frames, hold, o)   生成 keys：从 start 起依次放 frames（第几张的数组），每张停 hold 秒（数；数组按顺序取，
//                      用完了一直用最后一个；或 (i) => 秒）；o.loop 整组放几遍（默认 1），o.until 一直循环到这个时间
//
// 运动模糊和 smear：换张不算运动。图层的变换在换张时是连续的，跳的只是图层里面那张图，所以 smear 只拉真的位移。
// 图片按直通 alpha 处理（渲染目标的纹理按预乘）；缩小显示时用 mipmap，不闪。
import * as THREE from 'three';
import type { Compositor } from './gl';
import type { Layer } from './layers';
import { shutterT } from './util';

type Pt = readonly [number, number];
export type SwapSrc = HTMLImageElement | HTMLCanvasElement | ImageBitmap | THREE.Texture;
export interface SwapFrame { src: SwapSrc; anchor?: Pt; toward?: Pt; scale?: number }
export interface SwapOpts {
  keys?: readonly (readonly [time: number, frame: number])[];
  frame?: (t: number) => number;
  minHold?: number;
  fps?: number;
  ref?: number;
  fit?: 'turnScale' | 'turn' | 'move';
}

interface Item { tex: THREE.Texture; premult: boolean; size: [number, number]; m: number[] }

const imgSize = (s: SwapSrc): [number, number] => {
  const im = (s instanceof THREE.Texture ? s.image : s) as { naturalWidth?: number; width?: number; naturalHeight?: number; height?: number; videoWidth?: number; videoHeight?: number };
  return [im.naturalWidth || im.videoWidth || im.width || 1, im.naturalHeight || im.videoHeight || im.height || 1];
};

export class Swap {
  /** The layer's size (every aligned frame fits) and where the reference anchor sits in it. */
  readonly size: [number, number];
  readonly anchor: [number, number];
  private items: Item[];
  private keys: [number, number][];
  private refVec: [number, number] | null;

  constructor(private host: { comp: Compositor }, frames: readonly SwapFrame[], private o: SwapOpts = {}) {
    if (!frames.length) throw new Error('Swap: no frames');
    const fit = o.fit ?? 'turnScale';
    const refF = frames[Math.min(frames.length - 1, Math.max(0, o.ref ?? 0))]!;
    const rs = imgSize(refF.src), ra = refF.anchor ?? [rs[0] / 2, rs[1] / 2], rsc = refF.scale ?? 1;
    this.refVec = refF.toward ? [(refF.toward[0] - ra[0]) * rsc, (refF.toward[1] - ra[1]) * rsc] : null;
    // each frame: image px → pose px (reference anchor at the origin), then the union box
    const pose = frames.map((f) => {
      const sz = imgSize(f.src), a = f.anchor ?? [sz[0] / 2, sz[1] / 2];
      let s = f.scale ?? 1, th = 0;
      if (this.refVec && f.toward && fit !== 'move') {
        const vx = f.toward[0] - a[0], vy = f.toward[1] - a[1];
        th = Math.atan2(this.refVec[1], this.refVec[0]) - Math.atan2(vy, vx);
        if (fit === 'turnScale') s = Math.hypot(this.refVec[0], this.refVec[1]) / Math.max(1e-6, Math.hypot(vx, vy));
      }
      const c = Math.cos(th) * s, n = Math.sin(th) * s;
      // [x', y'] = R·S·([x, y] − a)
      return { sz, m: [c, -n, -(c * a[0] - n * a[1]), n, c, -(n * a[0] + c * a[1])] };
    });
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pose) for (const [x, y] of [[0, 0], [p.sz[0], 0], [0, p.sz[1]], [p.sz[0], p.sz[1]]] as const) {
      const X = p.m[0]! * x + p.m[1]! * y + p.m[2]!, Y = p.m[3]! * x + p.m[4]! * y + p.m[5]!;
      x0 = Math.min(x0, X); y0 = Math.min(y0, Y); x1 = Math.max(x1, X); y1 = Math.max(y1, Y);
    }
    const pad = 2, ox = pad - Math.floor(x0), oy = pad - Math.floor(y0);
    this.anchor = [ox, oy];
    this.size = [Math.ceil(x1) + ox + pad, Math.ceil(y1) + oy + pad];
    const made = new Map<SwapSrc, THREE.Texture>();
    this.items = frames.map((f, i) => {
      const p = pose[i]!;
      let tex = f.src instanceof THREE.Texture ? f.src : made.get(f.src);
      if (!tex) {
        let img: HTMLImageElement | HTMLCanvasElement = f.src as HTMLImageElement | HTMLCanvasElement;
        if (typeof ImageBitmap !== 'undefined' && f.src instanceof ImageBitmap) {
          // WebGL's flipY does not apply to ImageBitmaps: go through a canvas
          const cv = document.createElement('canvas');
          cv.width = f.src.width; cv.height = f.src.height;
          cv.getContext('2d')!.drawImage(f.src, 0, 0);
          img = cv;
        }
        tex = new THREE.Texture(img);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        made.set(f.src, tex);
      }
      const m = p.m;
      return { tex, premult: !tex.isRenderTargetTexture, size: p.sz, m: [m[0]!, m[1]!, m[2]! + ox, m[3]!, m[4]!, m[5]! + oy, 0, 0, 1] };
    });
    // the swap times: sorted, on the fps grid, repeats dropped, too-soon swaps skipped
    const n = this.items.length, g = o.fps && o.fps > 0 ? o.fps : 0, hold = Math.max(0, o.minHold ?? 0);
    const ks = [...(o.keys ?? [])].map(([t, k]) => [g ? Math.round(t * g) / g : t, Math.min(n - 1, Math.max(0, Math.round(k)))] as [number, number]).sort((a, b) => a[0] - b[0]);
    this.keys = [];
    for (const k of ks) {
      const last = this.keys[this.keys.length - 1];
      if (last && (k[1] === last[1] || k[0] - last[0] < hold - 1e-6)) continue;
      this.keys.push(k);
    }
  }

  /** The frame shown at time t (the frame's own time: every sub-frame of a frame gets the same picture). */
  index(t: number): number {
    const c = shutterT(t, 0), n = this.items.length;
    if (this.o.frame) return Math.min(n - 1, Math.max(0, Math.round(this.o.frame(c))));
    const k = this.keys;
    if (!k.length) return 0;
    if (c < k[0]![0]) return k[0]![1];
    let lo = 0, hi = k.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (k[m]![0] <= c + 1e-9) lo = m; else hi = m - 1; }
    return k[lo]![1];
  }

  /** Spread into a Layer: the render source, its size, and the reference anchor as the layer's anchor. */
  layer(): Pick<Layer, 'render' | 'size' | 'anchor'> {
    return { render: (r, out, t) => this.draw(r, out, t), size: this.size, anchor: this.anchor };
  }

  /** Put the reference pair of anchors on `from` and `to`: the layer's position, rotation (degrees) and scale. */
  aim(from: Pt, to: Pt): { position: [number, number]; rotation: number; scale: number } {
    const position: [number, number] = [from[0], from[1]];
    if (!this.refVec) return { position, rotation: 0, scale: 1 };
    const dx = to[0] - from[0], dy = to[1] - from[1];
    const rotation = ((Math.atan2(dy, dx) - Math.atan2(this.refVec[1], this.refVec[0])) * 180) / Math.PI;
    return { position, rotation, scale: Math.hypot(dx, dy) / Math.max(1e-6, Math.hypot(this.refVec[0], this.refVec[1])) };
  }

  private draw(r: THREE.WebGLRenderer, out: THREE.WebGLRenderTarget, t: number) {
    const it = this.items[this.index(t)]!;
    this.host.comp.draw(r, it.tex, out, { premult: it.premult, transform: { matrix: it.m, size: it.size } });
  }

  /** Keys for a sequence: `frames` one after another from `start`, each held `hold` seconds. */
  static seq(start: number, frames: readonly number[], hold: number | readonly number[] | ((i: number) => number), o: { loop?: number; until?: number } = {}): [number, number][] {
    const out: [number, number][] = [];
    if (!frames.length) return out;
    const hd = (i: number) => (typeof hold === 'number' ? hold : typeof hold === 'function' ? hold(i) : hold[Math.min(i, hold.length - 1)] ?? 0.1);
    const total = o.until === undefined ? frames.length * Math.max(1, o.loop ?? 1) : Infinity;
    let t = start;
    for (let i = 0; i < total && i < 100000; i++) {
      if (o.until !== undefined && t >= o.until - 1e-9) break;
      out.push([t, frames[i % frames.length]!]);
      t += Math.max(1e-4, hd(i));
    }
    return out;
  }

  dispose() { for (const it of new Set(this.items.map((x) => x.tex))) if (!it.isRenderTargetTexture) it.dispose(); }
}

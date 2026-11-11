// 形状层示例（?shape）：8 秒一循环的一张「形状层」海报，engine/shape.ts 的主要功能同时在动：
//   中间   路径变形 星 → 圆 → 心 → 圆角方 → 星（PathMorph，渐变填充 + 描边），外面一圈胶囊是重复器（份数从 0 长到 24、
//          offset 让整圈转、首尾透明度渐变成彗尾），再外面一条金色弧是描边生长 + 渐细（起点终点一起走，offset 绕圈），
//          最外圈是点状虚线（零长度虚线 + 圆端点）描边生长出来，之后行军蚁一样走（dashOffset），虚线钉在路径上不随生长滑动
//   左上   字的轮廓（textPath）按「各算各的」(each) 同时描出来，再填色
//   左下   三条子路径（SVG 相对命令 q t h a v l、C S）按「一起算」(together) 一条接一条写出来，渐细笔头，笔尖一个点（pointAlong 也行，
//          这里直接取返回的最后一段的末点）
//   右上   路径抖动：圆角矩形描边（smooth）、填色的星（抖成软糖）；中间一条锯齿（corner）、一条平滑抖动线
//   右下   重复器：六边形按比例缩小 + 转一点叠 7 层，offset 慢慢走成隧道
// 平面图形都用 shutterT(t, 0)（不被运动模糊糊掉）。参数都在下面，想看哪个改哪个。
import type * as THREE from 'three';
import { Scene, type Frame } from '../../engine/scene';
import { Layer2D, W } from '../../engine/gl';
import { F, font } from '../../engine/type';
import { clamp, prog, shutterT, TAU } from '../../engine/util';
import { E, kf } from '../../engine/anim';
import {
  Path, PathMorph, drawShape, ellipsePath, rectPath, starPath, polygonPath, polylinePath, textPath, type Gradient,
} from '../../engine/shape';

const LOOP = 8;
const PAPER = '#F1ECE2', INK = '#17161D', VERM = '#EE4B2B', ULTRA = '#2B3AD6', GOLD = '#E3A12F', MUTE = '#8E877A';
const C = { x: 960, y: 520 };

// a heart, centred on 0,0 (absolute C commands)
const HEART = 'M 0 128 C -46 92 -152 30 -152 -42 C -152 -102 -104 -142 -54 -142 C -22 -142 0 -122 0 -96 C 0 -122 22 -142 54 -142 C 104 -142 152 -102 152 -42 C 152 30 46 92 0 128 Z';
// three strokes written one after another (relative commands, a shorthand quad chain, arcs, a smooth cubic)
const SCRIBBLE = [
  'M 120 640 q 60 -84 120 0 t 120 0 t 120 0 t 120 0',
  'M 130 740 h 120 a 40 40 0 0 1 80 0 v 34 a 26 26 0 1 0 52 0 l 70 -46 l 70 46',
  'M 140 846 C 220 786, 300 906, 380 846 S 520 786, 600 846',
].join(' ');

export default class DemoShape extends Scene {
  layer = new Layer2D();
  morphs: PathMorph[] = [];
  word!: Path;
  scribble = new Path(SCRIBBLE);
  capsule = rectPath(-7, -226, 14, 36, 7);
  orbit = ellipsePath(0, 0, 330);
  comet = ellipsePath(0, 0, 270);
  wRect = rectPath(1600 - 175, 255 - 92, 350, 184, 26);
  wStar = starPath(1600, 255, 62, 28, 5, { round: 5 });
  zig = polylinePath([{ x: 1430, y: 488 }, { x: 1770, y: 488 }]);
  wave = polylinePath([{ x: 1430, y: 548 }, { x: 1770, y: 548 }]);
  hex = polygonPath(1600, 815, 104, 6, { round: 10 });

  override init() {
    const shapes = [
      starPath(0, 0, 160, 72, 5, { round: 8 }),
      ellipsePath(0, 0, 140),
      new Path(HEART),
      rectPath(-128, -128, 256, 256, 44),
    ];
    this.morphs = shapes.map((s, i) => new PathMorph(s, shapes[(i + 1) % shapes.length]!, { n: 360 }));
    this.word = textPath('Trim', F.sans(900), 200, 112, 330);
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const t = shutterT(f.t, 0) % LOOP;
    const c = this.layer.ctx;
    this.layer.clear(PAPER);
    this.centre(c, t);
    this.left(c, t);
    this.right(c, t);
    this.labels(c, t);
    this.ctx.comp.draw(this.ctx.renderer, this.layer.upload(), out, { mode: 'replace' });
  }

  // ---------------------------------------------------------------- centre: morph, repeater ring, comet, dotted orbit
  private centre(c: CanvasRenderingContext2D, t: number) {
    c.save();
    c.translate(C.x, C.y);
    // morph: hold 1.1 s, change over 0.8 s, every 2 s round the four shapes (the loop ends on the star it starts with)
    const k = Math.floor(t / 2) % 4, u = E.morph(prog(t - k * 2, 1.1, 1.9));
    const grad: Gradient = { linear: [-160, -160, 160, 160], stops: [[0, ULTRA], [1, VERM]] };
    drawShape(c, this.morphs[k]!.at(u), { fill: grad, stroke: { color: INK, width: 4, join: 'round' } }, t);

    // repeater ring: 24 capsules round the centre, the count grows in and out, offset turns the ring
    const copies = kf(t, [[0.15, 0], [1.3, 24], [7.0, 24], [7.85, 0]]);
    if (copies > 0) drawShape(c, this.capsule, {
      fill: INK,
      repeater: { copies, rotation: TAU / 24, offset: t * 2.5, startOpacity: 1, endOpacity: 0.08 },
    }, t);

    // comet: start and end run round together (offset in turns), tapered both ends
    const len = kf(t, [[0.5, 0], [1.6, 0.3], [6.8, 0.3], [7.7, 0]]);
    if (len > 0.001) drawShape(c, this.comet, {
      trim: { start: 0, end: len, offset: t * 0.32 },
      stroke: { color: GOLD, width: 10, taper: { start: 0.85, end: 0.08, ease: 0.4 } },
    }, t);

    // dotted orbit: drawn on, then the dots march; the dots stay put on the path while it grows
    const grow = E.out(prog(t, 0.3, 1.9)), gone = E.in(prog(t, 7.0, 7.85));
    if (grow > gone) drawShape(c, this.orbit, {
      trim: { start: gone, end: grow },
      stroke: { color: INK, width: 5, dash: [0, 15], dashOffset: -Math.max(0, t - 2) * 24, cap: 'round' },
    }, t);
    c.restore();
  }

  // ---------------------------------------------------------------- left: trim each (type outline), trim together (strokes)
  private left(c: CanvasRenderingContext2D, t: number) {
    // outline of the word: every contour at once (each), then the fill comes up under it
    const e1 = E.ease(prog(t, 0.2, 1.6)), s1 = E.ease(prog(t, 6.9, 7.7));
    const fillA = prog(t, 1.45, 2.0) * (1 - prog(t, 6.75, 7.1));
    if (fillA > 0) drawShape(c, this.word, { fill: VERM, opacity: fillA }, t);
    if (e1 > s1) drawShape(c, this.word, { trim: { start: s1, end: e1, mode: 'each' }, stroke: { color: INK, width: 3 } }, t);

    // three strokes, one after another (together), a brush taper on the moving tip
    const e2 = E.ease(prog(t, 0.6, 3.3)), s2 = E.ease(prog(t, 6.6, 7.8));
    if (e2 > s2) {
      const pieces = drawShape(c, this.scribble, {
        trim: { start: s2, end: e2, mode: 'together' },
        stroke: { color: ULTRA, width: 11, taper: { start: 0.12, end: 0.25, startWidth: 0.3, units: 'fraction' } },
      }, t);
      const last = pieces[pieces.length - 1];
      if (last && e2 < 1) {
        const x = last.x[last.x.length - 1]!, y = last.y[last.y.length - 1]!;
        c.fillStyle = VERM;
        c.beginPath(); c.arc(x, y, 7, 0, TAU); c.fill();
      }
    }
  }

  // ---------------------------------------------------------------- right: wiggle paths, repeater tunnel
  private right(c: CanvasRenderingContext2D, t: number) {
    const amp = kf(t, [[0.4, 0], [1.6, 6], [3.5, 18], [5.5, 8], [7.4, 0]]);
    const d1 = E.ease(prog(t, 0.25, 1.3)), o1 = E.ease(prog(t, 7.0, 7.7));
    if (d1 > o1) {
      drawShape(c, this.wRect, { trim: { start: o1, end: d1 }, stroke: { color: INK, width: 3.5 }, wiggle: { amount: amp, detail: 2.2, speed: 1.4, seed: 3 } }, t);
      const s = clamp(d1 * 1.2) * (1 - o1);
      c.save();
      c.translate(1600, 255); c.scale(s, s); c.translate(-1600, -255);
      drawShape(c, this.wStar, { fill: VERM, wiggle: { amount: amp * 0.5, detail: 5, speed: 2, seed: 9 } }, t);
      c.restore();
    }
    const d2 = E.ease(prog(t, 0.5, 1.4)), o2 = E.ease(prog(t, 7.05, 7.75));
    if (d2 > o2) {
      drawShape(c, this.zig, { trim: { start: o2, end: d2 }, stroke: { color: VERM, width: 4, cap: 'butt', join: 'miter' }, wiggle: { amount: 4 + amp, detail: 7, speed: 3, points: 'corner', seed: 1 } }, t);
      drawShape(c, this.wave, { trim: { start: o2, end: d2 }, stroke: { color: INK, width: 3 }, wiggle: { amount: 3 + amp * 0.7, detail: 2.5, speed: 1.2, seed: 6 } }, t);
    }
    // tunnel: 7 hexagons, each 0.78 of the last and turned a little, sliding (offset) towards the viewer
    const d3 = E.out(prog(t, 0.6, 1.8)), o3 = E.in(prog(t, 7.0, 7.8));
    if (d3 > o3) drawShape(c, this.hex, {
      trim: { start: o3, end: d3, offset: 0.25 },
      stroke: { color: ULTRA, width: 3 },
      repeater: { copies: 7, scale: 0.78, rotation: 0.17, anchor: [1600, 815], offset: -kf(t, [[1.0, 0], [7.4, 1.2]]), startOpacity: 1, endOpacity: 0.12 },
    }, t);
  }

  // ---------------------------------------------------------------- labels
  private labels(c: CanvasRenderingContext2D, t: number) {
    const a = prog(t, 0.1, 0.6) * (1 - prog(t, 7.5, 7.9));
    if (a <= 0) return;
    c.save();
    c.globalAlpha = a;
    c.font = font(F.mono(500), 15);
    c.letterSpacing = '3px';
    c.fillStyle = MUTE;
    c.fillText('TRIM PATHS · EACH', 112, 112);
    c.fillText('TRIM · TOGETHER · TAPER', 112, 560);
    c.fillText('WIGGLE PATHS · SMOOTH', 1430, 112);
    c.fillText('CORNER / SMOOTH', 1430, 448);
    c.fillText('REPEATER · SCALE · ROTATE', 1430, 618);
    c.textAlign = 'center';
    c.fillText('PATH MORPH · REPEATER · TAPERED TRIM · DOTTED DASH', C.x, 930);
    c.textAlign = 'left';
    c.fillStyle = INK;
    c.fillText('SHAPE LAYER', 112, 1004);
    c.fillStyle = MUTE;
    c.fillText('engine/shape.ts', 112 + 190, 1004);
    c.letterSpacing = '0px';
    c.fillStyle = 'rgba(23,22,29,0.16)';
    c.fillRect(W - 112 - 200, 999, 200, 3);
    c.fillStyle = VERM;
    c.fillRect(W - 112 - 200, 999, 200 * (t / LOOP), 3);
    c.restore();
  }
}

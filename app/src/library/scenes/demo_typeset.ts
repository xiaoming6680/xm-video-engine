// 排字示例（?typeset）：engine/textanim.ts 的竖排、沿路径排字、字里填图案，放在 engine/layers.ts 的图层里加硬投影。
// 用来看部件，不是画面标准。从 0 秒开始约 4 秒做完动作，之后循环慢动。
//   左   竖排两列：逐字从上方掉进来（第 1 帧拉长带模糊，第 2 帧到位），字里斜线网纹，图层加红色硬投影
//   中   沿圆排字：一圈字跟着 pathOffset 转；下面一行沿正弦线跑过去
//   右   竖排单列居中，字距（tracking 动画器）一呼一吸
import type * as THREE from 'three';
import { Scene, type Frame } from '../../engine/scene';
import { Comp } from '../../engine/layers';
import { Fx } from '../../engine/effects';
import { kf, K } from '../../engine/anim';
import { ellipsePath, polylinePath } from '../../engine/shape';
import { TextBlock, cascade } from '../../engine/textanim';
import { F, font } from '../../engine/type';

const INK = '#f8efe9', RED = '#e4001c', DIM = '#8a8794';

/** A diagonal hatch: white with fine dark-red lines (the pattern moves with each glyph). */
function hatch(c: CanvasRenderingContext2D): CanvasPattern {
  const p = document.createElement('canvas');
  p.width = p.height = 12;
  const g = p.getContext('2d')!;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 12, 12);
  g.strokeStyle = 'rgba(120,0,24,0.55)'; g.lineWidth = 2;
  for (const o of [-12, 0, 12]) { g.beginPath(); g.moveTo(o, 12); g.lineTo(o + 12, 0); g.stroke(); }
  return c.createPattern(p, 'repeat')!;
}

export default class DemoTypeset extends Scene {
  fx = new Fx();
  comp = new Comp(this.ctx, { bg: '#16151b', fx: this.fx });
  cols = new TextBlock('竖排的歌词\n一列一列掉下来', { family: F.sans(900), size: 96, vertical: true, lineHeight: 1.25, tracking: 4 });
  ring = new TextBlock('ALONG A CIRCLE · 沿着圆排的字 · ', { family: F.sans(800), size: 40, align: 'center', tracking: 2 });
  wave = new TextBlock('THE WAVE CARRIES THE LINE', { family: F.mono(600), size: 34, align: 'center', tracking: 3 });
  breathe = new TextBlock('字距一呼一吸', { family: F.sans(800), size: 64, vertical: true, align: 'center' });
  private pat: CanvasPattern | null = null;

  override init() {
    const circle = ellipsePath(0, 0, 210, 210);
    const wavePts = Array.from({ length: 61 }, (_, i) => ({ x: -420 + i * 14, y: 46 * Math.sin(i * 0.32) }));
    const waveLine = polylinePath(wavePts);
    this.comp.layers = [
      { name: 'title', motionBlur: false, draw: (c) => {
        c.font = font(F.sans(800), 30); c.fillStyle = INK; c.fillText('排字 · 竖排 · 沿路径 · 字里填图案', 40, 60);
        c.font = font(F.mono(400), 16); c.fillStyle = DIM; c.fillText('TextStyle.vertical   TextPaint.path / pathOffset   fill: CanvasPattern', 40, 88);
      } },
      // left: vertical columns dropping in, character by character (fps 30: one frame stretched, then in place)
      { name: 'cols', fps: 30, size: [420, 900], position: [320, 570], cache: 'frame',
        effects: [{ type: 'dropShadow', offset: [8, 8], color: RED }],
        draw: (c, t, [w]) => {
          this.pat ??= hatch(c);
          // each glyph: hidden until its turn; its first frame 60 px high, 150 % tall and soft; the next frame in place
          const step = (u: number) => (u < 0.5 ? 0 : 1);
          this.cols.draw(c, w - 90, 40, t, [
            { select: cascade({ t0: 0.3, each: 0.1, dur: 1 / 60, ease: step }), opacity: 0 },
            { select: cascade({ t0: 0.3, each: 0.1, dur: 2 / 30, ease: step }), position: [0, -60], scale: [1, 1.5], blur: 6 },
          ], { fill: this.pat });
        } },
      // middle: text around a circle, and along a sine
      { name: 'ring', size: [700, 900], position: [960, 560], draw: (c, t) => {
        c.strokeStyle = 'rgba(255,255,255,0.12)'; c.lineWidth = 2;
        c.beginPath(); c.arc(350, 330, 210, 0, Math.PI * 2); c.stroke();
        this.ring.draw(c, 350, 330, t, [], { fill: INK, path: circle, pathOffset: kf(t, [[0, 0, 'lin'], [8, 1320, 'lin']]) });
        c.strokeStyle = 'rgba(255,255,255,0.12)';
        c.save(); c.translate(350, 720); c.beginPath(); wavePts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y))); c.stroke(); c.restore();
        this.wave.draw(c, 350, 720, t, [], { fill: RED, path: waveLine, pathOffset: kf(t, [[0.5, -300, K.go], [3.5, 430, K.land]]) });
      } },
      // right: one centred column, its tracking breathing
      { name: 'breathe', size: [300, 900], position: [1600, 560], draw: (c, t) => {
        const k = 0.5 - 0.5 * Math.cos(t * 2);
        this.breathe.draw(c, 150, 450, t, [{ tracking: 40 * k }], { fill: INK });
        c.fillStyle = DIM; c.font = font(F.mono(400), 14); c.textAlign = 'center'; c.fillText(`tracking ${(40 * k).toFixed(0)}`, 150, 880);
      } },
    ];
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    this.comp.render(f.t, out);
  }

  override dispose() {
    this.comp.dispose();
    this.fx.dispose();
  }
}

// 路径运算和运动路径示例（?pathops）：engine/pathops.ts（drawShape 的 style.ops / style.merge）、engine/anim.ts 的 motionPath。
// 上排同一个星形 / 方块做不同运算（数值按 4 秒来回走），中排四种合并，下排一个箭头沿贝塞尔路径飞、自动朝向。用来看部件，不是画面标准。
import type * as THREE from 'three';
import { Scene, type Frame } from '../../engine/scene';
import { Comp, type Layer } from '../../engine/layers';
import { Fx } from '../../engine/effects';
import { drawShape, ellipsePath, rectPath, starPath, Path } from '../../engine/shape';
import { K, motionPath } from '../../engine/anim';
import type { MergeMode, PathOp } from '../../engine/pathops';
import { F, font } from '../../engine/type';
import { W } from '../../engine/gl';

const INK = '#e8e6e3', DIM = '#8a8794';
const pp = (t: number) => 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 4);
const TILE = 220, GAP = 14, X0 = (W - (8 * TILE + 7 * GAP)) / 2;

export default class DemoPathops extends Scene {
  fx = new Fx();
  comp = new Comp(this.ctx, { bg: '#0e0d12', fx: this.fx });

  override init() {
    const star = starPath(0, 0, 80, 40, 5, { rot: -Math.PI / 2 }), box = rectPath(-70, -70, 140, 140);
    const ops: { zh: string; en: string; src: Path; ops: (t: number) => PathOp[] }[] = [
      { zh: '原形', en: 'none', src: star, ops: () => [] },
      { zh: '圆角', en: 'roundCorners', src: star, ops: (t) => [{ type: 'roundCorners', radius: 2 + 22 * pp(t) }] },
      { zh: '收缩', en: 'puckerBloat −', src: box, ops: (t) => [{ type: 'puckerBloat', amount: -0.4 * pp(t) }] },
      { zh: '膨胀', en: 'puckerBloat +', src: star, ops: (t) => [{ type: 'puckerBloat', amount: 0.5 * pp(t) }] },
      { zh: '扭转', en: 'twist', src: box, ops: (t) => [{ type: 'twist', angle: 180 * pp(t) }] },
      { zh: '锯齿', en: 'zigzag corner', src: box, ops: (t) => [{ type: 'zigzag', size: 8 * pp(t), ridges: 24 }] },
      { zh: '波浪', en: 'zigzag smooth', src: ellipsePath(0, 0, 70), ops: (t) => [{ type: 'zigzag', size: 10 * pp(t), ridges: 12, points: 'smooth' }] },
      { zh: '位移路径', en: 'offset round', src: star, ops: (t) => [{ type: 'offset', amount: -14 + 30 * pp(t), join: 'round' }] },
    ];
    const merges: MergeMode[] = ['add', 'subtract', 'intersect', 'exclude'];
    const fly = motionPath([
      { t: 0, p: [180, 900], mode: K.go }, { t: 1.4, p: [700, 760] }, { t: 2.6, p: [1200, 960] }, { t: 4, p: [1740, 790], mode: K.land },
    ]);
    const layers: Layer[] = [];
    ops.forEach((o, i) => {
      const x = X0 + i * (TILE + GAP);
      layers.push({ name: `op${i}`, size: [TILE, TILE], position: [x + TILE / 2, 120 + TILE / 2], motionBlur: false, draw: (c, t) => {
        c.fillStyle = '#1b1a22'; c.fillRect(0, 0, TILE, TILE);
        c.translate(TILE / 2, TILE / 2);
        drawShape(c, o.src, { fill: '#ffb347', stroke: { color: '#fff', width: 2 }, ops: o.ops(t) }, t);
      } });
    });
    merges.forEach((m, i) => {
      const x = X0 + (i * 2) * (TILE + GAP);
      layers.push({ name: `m${i}`, size: [TILE * 2 + GAP, TILE], position: [x + TILE + GAP / 2, 120 + TILE + 70 + TILE / 2], motionBlur: false, draw: (c, t) => {
        c.fillStyle = '#1b1a22'; c.fillRect(0, 0, TILE * 2 + GAP, TILE);
        c.translate((TILE * 2 + GAP) / 2, TILE / 2);
        const d = 30 + 40 * pp(t);
        drawShape(c, [ellipsePath(-d, 0, 75), rectPath(d - 70, -60, 140, 120), ellipsePath(0, 0, 22)], { fill: { linear: [-150, 0, 150, 0], stops: [[0, '#4b7bff'], [1, '#ff2d6f']] }, stroke: { color: '#fff', width: 4, dash: [18, 8] }, merge: m }, t);
      } });
    });
    layers.push({ name: 'route', motionBlur: false, cache: 'static', draw: (c) => {
      c.strokeStyle = 'rgba(255,255,255,0.25)'; c.lineWidth = 2; c.setLineDash([6, 8]); c.beginPath();
      for (let k = 0; k <= 200; k++) { const p = fly.at((k / 200) * 4).p; if (k) c.lineTo(p[0]!, p[1]!); else c.moveTo(p[0]!, p[1]!); }
      c.stroke(); c.setLineDash([]);
    } });
    layers.push({ name: 'arrow', size: [90, 50], position: (t) => fly.at(t).p as [number, number], rotation: (t) => fly.at(t).angle, draw: (c) => {
      drawShape(c, new Path('M 0 10 L 60 10 L 60 0 L 90 25 L 60 50 L 60 40 L 0 40 Z'), { fill: '#7ad7ff' });
    } });
    layers.push({ name: 'labels', motionBlur: false, cache: 'static', draw: (c) => {
      c.font = font(F.sans(800), 26); c.fillStyle = INK; c.fillText('路径运算 · 合并路径 · 运动路径', X0, 70);
      c.font = font(F.mono(400), 14); c.fillStyle = DIM; c.fillText('engine/pathops.ts  anim.ts motionPath', X0 + 420, 70);
      ops.forEach((o, i) => { const x = X0 + i * (TILE + GAP); c.font = font(F.sans(700), 15); c.fillStyle = INK; c.fillText(o.zh, x, 120 + TILE + 22); c.font = font(F.mono(400), 12); c.fillStyle = DIM; c.fillText(o.en, x + 70, 120 + TILE + 22); });
      merges.forEach((m, i) => { const x = X0 + (i * 2) * (TILE + GAP); c.font = font(F.sans(700), 15); c.fillStyle = INK; c.fillText(`合并 ${m}`, x, 120 + 2 * TILE + 92); });
      c.font = font(F.sans(700), 15); c.fillStyle = INK; c.fillText('运动路径 + 自动朝向（K.go → K.land）', X0, 1040);
    } });
    this.comp.layers = layers;
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) { this.comp.render(f.t, out); }
}

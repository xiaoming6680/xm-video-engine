// 灯光和投影示例（?lights）：Comp 的 lights（AE 的灯光层）和图层的 material（AE 的材质选项）。地面上站着几张卡片和一行 3D 字，
// 一盏暖色聚光灯绕着转（投软影子），一盏冷色平行光从侧面补（不投影），加一点环境光。右边那张卡片开了高光。
// ?lights=point 换成卡片中间的一盏点光源（影子往四周投）。
// 用来看部件，不是画面标准。
import type * as THREE from 'three';
import { Scene, type Frame } from '../../engine/scene';
import { Comp, type Layer, type Light } from '../../engine/layers';
import { Fx } from '../../engine/effects';
import { F, font } from '../../engine/type';

const FLOOR_Y = 820;
// ?lights=point：一盏点光源挂在卡片中间，影子往四周投（六面影子图）
const POINT = typeof location !== 'undefined' && new URLSearchParams(location.search).get('lights') === 'point';

function card(text: string, bg: string): Layer['draw'] {
  return (c, _t, [w, h]) => {
    c.fillStyle = bg; c.beginPath(); c.roundRect(0, 0, w, h, 18); c.fill();
    c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(24, h - 70, w - 48, 8);
    c.fillStyle = '#1a1820'; c.font = font(F.sans(900), w * 0.42); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, w / 2, h * 0.42);
  };
}

export default class DemoLights extends Scene {
  fx = new Fx();
  comp = new Comp(this.ctx, {
    bg: '#0b0a0f', fx: this.fx,
    camera: (t) => ({ position: [960 + 300 * Math.sin(t * 0.25), 300, -1900], pointOfInterest: [960, 700, 700] }),
    lights: (t): Light[] => POINT ? [
      { type: 'ambient', color: '#9fb4ff', intensity: 0.12 },
      { type: 'point', color: '#ffe2b8', intensity: 1.8, position: [960 + 160 * Math.sin(t * 0.9), 560, 760 + 120 * Math.cos(t * 0.9)],
        falloff: 'inverse', radius: 700, shadows: true, shadowDiffusion: 6 },
    ] : [
      { type: 'ambient', color: '#9fb4ff', intensity: 0.18 },
      { type: 'spot', color: '#ffd9a8', intensity: 1.6, position: [960 + 900 * Math.sin(t * 0.8), 120, 500 - 900 * Math.cos(t * 0.8)], target: [960, FLOOR_Y, 800],
        cone: 80, feather: 0.5, falloff: 'smooth', radius: 1400, distance: 1400, shadows: true, shadowDiffusion: 10, shadowDarkness: 0.9 },
      { type: 'parallel', color: '#7aa8ff', intensity: 0.35, position: [2600, 400, 200], target: [960, FLOOR_Y, 500] },
    ],
  });

  override init() {
    const floor: Layer = { name: 'floor', threeD: true, cache: 'static', size: [3600, 3000], position: [960, FLOOR_Y, 700], rotationX: 90, draw: (c, _t, [w, h]) => {
      c.fillStyle = '#d8d2c8'; c.fillRect(0, 0, w, h);
      c.strokeStyle = '#b9b2a6'; c.lineWidth = 4;
      for (let x = 0; x <= w; x += 150) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
      for (let y = 0; y <= h; y += 150) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    } };
    const stand = (name: string, x: number, z: number, ry: number, text: string, bg: string, spec = 0): Layer => ({
      name, threeD: true, size: [260, 360], anchor: [130, 360], position: [x, FLOOR_Y, z], rotationY: ry, cache: 'static',
      material: { castsShadows: true, specular: spec, shininess: 0.6 }, draw: card(text, bg),
    });
    const title: Layer = { name: 'title', threeD: true, size: [900, 200], anchor: [450, 200], position: [960, FLOOR_Y, 380], cache: 'static',
      material: { castsShadows: true }, draw: (c, _t, [w, h]) => {
        c.fillStyle = '#ff5a3c'; c.font = font(F.sans(900), 180); c.textAlign = 'center'; c.textBaseline = 'bottom'; c.fillText('LIGHTS', w / 2, h);
      } };
    const label: Layer = { name: 'label', motionBlur: false, cache: 'static', draw: (c) => {
      c.font = font(F.sans(800), 26); c.fillStyle = '#e8e6e3'; c.fillText('灯光 · 投影 · 材质', 40, 60);
      c.font = font(F.mono(400), 14); c.fillStyle = '#8a8794'; c.fillText('CompOpts.lights, Layer.material (engine/layers.ts)', 290, 60);
    } };
    this.comp.layers = [floor, stand('a', 560, 900, 25, 'A', '#f2c9d4'), stand('b', 960, 1050, 0, 'B', '#c9d8f2'), stand('c', 1360, 900, -25, 'C', '#f8efe9', 0.8), title, label];
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) { this.comp.render(f.t, out); }
}

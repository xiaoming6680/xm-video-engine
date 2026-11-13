// 效果栈示例（?effects）：engine/effects.ts 里 AE 式的扭曲、转场、调色、图层样式、光，一格一个，参数按 4 秒来回走
// （第 2 秒最满，第 0 / 4 秒回到原样）。用来看部件，不是画面标准。
//   第 1 行  扭曲：凸起、球面化、旋转扭曲、水波、极坐标、弯曲
//   第 2 行  镜头畸变、网格变形、置换图、多级发光（deep）、光线、镜头光晕
//   第 3 行  转场：线性擦除、径向擦除、光圈擦除、百叶窗、块溶解、渐变擦除
//   第 4 行  调色：曲线、色彩平衡、亮度对比度、保留颜色、渐变叠加、漏光
//   第 5 行  图层样式（透明的字和牌子）：内阴影、内发光、外发光、斜面
//   第 6 行  抠像：色度抠像（绿幕）、亮度抠像、蒙版收缩扩展；翻页、卡片擦除（背面是一张蓝图）；最后一格是没加效果的原图
// ?effects=smoke：每种效果（连老的）各一小格、参数取中间值，渲一帧就把所有着色器都编译一遍；控制台有 Shader Error /
// program not valid 就是哪个效果坏了（改 effects.ts 之后跑一下：bun scripts/render.ts stills --t 1 --query effects=smoke）
import * as THREE from 'three';
import { Scene, type Frame } from '../../engine/scene';
import { Comp, type Layer } from '../../engine/layers';
import { Fx, type Effect, type EffectList } from '../../engine/effects';
import { F, font } from '../../engine/type';
import { W, H } from '../../engine/gl';

const TW = 250, TH = 140, GX = 18, LBL = 26, GY = 10;
const X0 = (W - (6 * TW + 5 * GX)) / 2, Y0 = (H - (6 * (TH + LBL) + 5 * GY)) / 2;
const at = (i: number): [number, number] => [X0 + (i % 6) * (TW + GX) + TW / 2, Y0 + Math.floor(i / 6) * (TH + LBL + GY) + TH / 2];
const INK = '#e8e6e3', DIM = '#8a8794';

/** 0 → 1 → 0 over 4 s (full at 2 s). */
const pp = (t: number) => 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 4);

/** An opaque picture with lines to see the distortions: sky, a hot sun, a grid, a red bar, hills, white letters. */
function pic(c: CanvasRenderingContext2D, _t: number, [w, h]: readonly [number, number]) {
  const g = c.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#1b2a6b'); g.addColorStop(0.6, '#d9608a'); g.addColorStop(1, '#f6b06b');
  c.fillStyle = g; c.fillRect(0, 0, w, h);
  c.strokeStyle = 'rgba(255,255,255,0.28)'; c.lineWidth = 1.5;
  for (let x = 0; x <= w; x += 24) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
  for (let y = 0; y <= h; y += 24) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  const s = c.createRadialGradient(w * 0.72, h * 0.34, 0, w * 0.72, h * 0.34, 34); s.addColorStop(0, '#ffffff'); s.addColorStop(0.5, '#fff1b8'); s.addColorStop(1, 'rgba(255,220,150,0)');
  c.fillStyle = s; c.beginPath(); c.arc(w * 0.72, h * 0.34, 34, 0, 7); c.fill();
  c.fillStyle = '#e4001c'; c.fillRect(18, h * 0.58, w * 0.34, 14);
  c.fillStyle = '#2a1640'; c.beginPath(); c.moveTo(0, h); c.lineTo(0, h * 0.78); c.quadraticCurveTo(w * 0.3, h * 0.6, w * 0.55, h * 0.8); c.quadraticCurveTo(w * 0.8, h * 0.66, w, h * 0.74); c.lineTo(w, h); c.fill();
  c.fillStyle = '#ffffff'; c.font = font(F.sans(900), 64); c.textBaseline = 'middle'; c.fillText('AE', 24, h * 0.33);
}

/** Transparent: bold letters and a rounded badge (for the layer styles). */
function cut(c: CanvasRenderingContext2D, _t: number, [w, h]: readonly [number, number]) {
  c.fillStyle = '#f2c9d4'; c.beginPath(); c.roundRect(w * 0.56, h * 0.22, w * 0.34, h * 0.56, 18); c.fill();
  c.fillStyle = '#4b7bff'; c.beginPath(); c.arc(w * 0.73, h * 0.5, h * 0.16, 0, 7); c.fill();
  c.fillStyle = '#ffb347'; c.font = font(F.sans(900), 104); c.textBaseline = 'middle'; c.fillText('Aa', 16, h * 0.53);
}

/** A green-screen shot: a figure on #00b140, with a green spill fringe on its edge. */
function gs(c: CanvasRenderingContext2D, _t: number, [w, h]: readonly [number, number]) {
  c.fillStyle = '#00b140'; c.fillRect(0, 0, w, h);
  c.fillStyle = '#d9483b'; c.beginPath(); c.ellipse(w / 2, h * 0.95, w * 0.2, h * 0.42, 0, Math.PI, 0); c.fill();
  c.fillStyle = '#f2c3a0'; c.beginPath(); c.arc(w / 2, h * 0.36, h * 0.17, 0, 7); c.fill();
  c.strokeStyle = 'rgba(70,190,90,0.7)'; c.lineWidth = 3;
  c.beginPath(); c.arc(w / 2, h * 0.36, h * 0.17, 0, 7); c.stroke();
  c.beginPath(); c.ellipse(w / 2, h * 0.95, w * 0.2, h * 0.42, 0, Math.PI, 0); c.stroke();
  c.fillStyle = '#ffffff'; c.font = font(F.sans(900), 22); c.textAlign = 'center'; c.fillText('KEY', w / 2, h * 0.82);
}

interface Cell { zh: string; en: string; art?: typeof pic; fx?: (t: number) => EffectList }

export default class DemoEffects extends Scene {
  fx = new Fx();
  comp = new Comp(this.ctx, { bg: '#0e0d12', fx: this.fx });
  map!: THREE.CanvasTexture;
  backTex!: THREE.CanvasTexture;

  override init() {
    // the displacement map: soft rings (grey = no move)
    const cv = document.createElement('canvas'); cv.width = cv.height = 256;
    const g = cv.getContext('2d')!;
    for (let r = 181; r > 0; r -= 2) { const v = 128 + 110 * Math.sin(r / 9); g.fillStyle = `rgb(${v},${255 - v},128)`; g.beginPath(); g.arc(128, 128, r, 0, 7); g.fill(); }
    this.map = new THREE.CanvasTexture(cv);
    // the back page / next picture for the page turn and the card wipe
    const bv = document.createElement('canvas'); bv.width = 500; bv.height = 280;
    const b = bv.getContext('2d')!;
    const bg = b.createLinearGradient(0, 0, 500, 280); bg.addColorStop(0, '#16325c'); bg.addColorStop(1, '#3fa7d6');
    b.fillStyle = bg; b.fillRect(0, 0, 500, 280);
    b.fillStyle = '#ffffff'; b.font = font(F.sans(900), 90); b.textAlign = 'center'; b.textBaseline = 'middle'; b.fillText('BACK', 250, 140);
    this.backTex = new THREE.CanvasTexture(bv);

    const cells: Cell[] = [
      { zh: '凸起', en: 'bulge', fx: (t) => [{ type: 'bulge', amount: 0.6 * pp(t) }] },
      { zh: '球面化', en: 'spherize', fx: (t) => [{ type: 'spherize', amount: pp(t) }] },
      { zh: '旋转扭曲', en: 'twirl', fx: (t) => [{ type: 'twirl', angle: 240 * pp(t) }] },
      { zh: '水波', en: 'ripple', fx: (t) => [{ type: 'ripple', amplitude: 7 * pp(t), wavelength: 26, phase: t * 1.5, radius: 150 }] },
      { zh: '极坐标', en: 'polar', fx: (t) => [{ type: 'polar', amount: pp(t) }] },
      { zh: '弯曲', en: 'bend', fx: (t) => [{ type: 'bend', amount: 40 * pp(t) }] },

      { zh: '镜头畸变', en: 'lensDistort', fx: (t) => [{ type: 'lensDistort', amount: 0.8 * pp(t) }] },
      { zh: '网格变形', en: 'meshWarp', fx: (t) => [{ type: 'meshWarp', grid: [
        [[0, 0], [0, 0], [0, 0]],
        [[0, 0], [50 * pp(t), -30 * pp(t)], [0, 0]],
        [[0, 0], [0, 0], [0, 0]],
      ] }] },
      { zh: '置换图', en: 'displacementMap', fx: (t) => [{ type: 'displacementMap', map: this.map, amount: 18 * pp(t) }] },
      { zh: '多级发光', en: 'glow deep', fx: (t) => [{ type: 'glow', threshold: 0.55, radius: 50, intensity: 1.4 * pp(t), deep: true }] },
      { zh: '光线', en: 'lightRays', fx: (t) => [{ type: 'lightRays', center: [TW * 0.72, TH * 0.34], length: 0.5 * pp(t), intensity: 1.5, threshold: 0.6 }] },
      { zh: '镜头光晕', en: 'lensFlare', fx: (t) => [{ type: 'lensFlare', position: [TW * (0.15 + 0.5 * pp(t)), TH * 0.3], brightness: 1 }] },

      { zh: '线性擦除', en: 'linearWipe', fx: (t) => [{ type: 'linearWipe', completion: pp(t), angle: 30, feather: 24 }] },
      { zh: '径向擦除', en: 'radialWipe', fx: (t) => [{ type: 'radialWipe', completion: pp(t), feather: 12 }] },
      { zh: '光圈擦除', en: 'irisWipe', fx: (t) => [{ type: 'irisWipe', completion: pp(t), sides: 6, feather: 6 }] },
      { zh: '百叶窗', en: 'venetianBlinds', fx: (t) => [{ type: 'venetianBlinds', completion: pp(t), angle: 90, width: 22, feather: 3 }] },
      { zh: '块溶解', en: 'blockDissolve', fx: (t) => [{ type: 'blockDissolve', completion: pp(t), block: 14, soft: 0.2 }] },
      { zh: '渐变擦除', en: 'gradientWipe', fx: (t) => [{ type: 'gradientWipe', completion: pp(t), soft: 0.15 }] },

      { zh: '曲线', en: 'curves', fx: (t) => { const k = pp(t); return [{ type: 'curves', rgb: [[0.25, 0.25 - 0.15 * k], [0.75, 0.75 + 0.15 * k]], b: [[0.5, 0.5 + 0.2 * k]] }]; } },
      { zh: '色彩平衡', en: 'colorBalance', fx: (t) => { const k = pp(t); return [{ type: 'colorBalance', shadows: [-0.3 * k, 0, 0.5 * k], highlights: [0.3 * k, 0.15 * k, -0.4 * k] }]; } },
      { zh: '亮度对比度', en: 'brightnessContrast', fx: (t) => [{ type: 'brightnessContrast', contrast: 0.6 * pp(t), brightness: -0.08 * pp(t) }] },
      { zh: '保留颜色', en: 'leaveColor', fx: (t) => [{ type: 'leaveColor', color: '#e4001c', amount: pp(t) }] },
      { zh: '渐变叠加', en: 'gradientOverlay', fx: (t) => [{ type: 'gradientOverlay', stops: ['#ff2d6f', '#2b6cff'], angle: 45, mode: 'overlay', opacity: pp(t) }] },
      { zh: '漏光', en: 'lightLeak', fx: (t) => [{ type: 'lightLeak', amount: 0.2 + pp(t), evolution: t }] },

      { zh: '内阴影', en: 'innerShadow', art: cut, fx: (t) => [{ type: 'innerShadow', offset: [6 * pp(t), 6 * pp(t)], softness: 6, opacity: 0.85 }] },
      { zh: '内发光', en: 'innerGlow', art: cut, fx: (t) => [{ type: 'innerGlow', color: '#fff4c8', size: 4 + 16 * pp(t), opacity: 0.9 }] },
      { zh: '外发光', en: 'outerGlow', art: cut, fx: (t) => [{ type: 'outerGlow', color: '#ff2d6f', size: 4 + 30 * pp(t), spread: 0.1 }] },
      { zh: '斜面', en: 'bevel', art: cut, fx: (t) => [{ type: 'bevel', size: 12, depth: 0.3 + 1.5 * pp(t), light: -135 + 90 * Math.sin(t) }] },

      { zh: '色度抠像', en: 'chromaKey', art: gs, fx: (t) => [{ type: 'chromaKey', color: '#00b140', despill: pp(t), tolerance: 0.3, soft: 0.2 }] },
      { zh: '亮度抠像', en: 'lumaKey', fx: (t) => [{ type: 'lumaKey', level: 0.05 + 0.3 * pp(t), soft: 0.1 }] },
      { zh: '蒙版收缩扩展', en: 'matteChoke', art: cut, fx: (t) => [{ type: 'matteChoke', amount: -8 + 16 * pp(t), soft: 1 }] },
      { zh: '翻页', en: 'pageTurn', fx: (t) => [{ type: 'pageTurn', completion: pp(t), radius: 28, back: this.backTex, backOpacity: 0.85 }] },
      { zh: '卡片擦除', en: 'cardWipe', fx: (t) => [{ type: 'cardWipe', completion: pp(t), rows: 4, columns: 6, width: 0.6, random: 0.25, back: this.backTex, perspective: 900 }] },
      { zh: '原图', en: 'no effect' },
    ];

    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('effects') === 'smoke') { this.smoke(); return; }
    const layers: Layer[] = [];
    cells.forEach((cell, i) => {
      const [x, y] = at(i);
      layers.push({ name: `bg${i}`, solid: '#23212b', size: [TW, TH], position: [x, y], cache: 'static', motionBlur: false });
      layers.push({ name: `art${i}`, size: [TW, TH], position: [x, y], motionBlur: false, draw: cell.art ?? pic, effects: (t) => (cell.fx ? cell.fx(t) : []) as Effect[] });
    });
    layers.push({ name: 'labels', cache: 'static', motionBlur: false, draw: (c) => {
      cells.forEach((cell, i) => {
        const [x, y] = at(i), ly = y + TH / 2 + 18;
        c.textBaseline = 'alphabetic';
        c.font = font(F.sans(700), 15); c.fillStyle = INK; c.fillText(cell.zh, x - TW / 2, ly);
        const zw = c.measureText(cell.zh).width;
        c.font = font(F.mono(400), 12); c.fillStyle = DIM; c.fillText(cell.en, x - TW / 2 + zw + 10, ly);
      });
    } });
    this.comp.layers = layers;
  }

  /** Every effect type once (mid settings) in small tiles: one frame compiles every shader. */
  private smoke() {
    const m = this.map, b = this.backTex;
    const list: Effect[] = [
      { type: 'blur', radius: 4 }, { type: 'directionalBlur', length: 30 }, { type: 'radialBlur', amount: 0.2 }, { type: 'radialBlur', kind: 'spin', amount: 10 },
      { type: 'gradientMap', stops: ['#102040', '#ffd27a'] }, { type: 'fill', color: '#ff2d6f', opacity: 0.5 }, { type: 'levels', inBlack: 0.1, gamma: 1.3 },
      { type: 'hueSat', hue: 90, saturation: 0.5, lightness: 0.1 }, { type: 'invert' }, { type: 'threshold', level: 0.5, soft: 0.1 }, { type: 'posterize', levels: 4 },
      { type: 'exposure', stops: 1 }, { type: 'mosaic', size: 8 }, { type: 'glow', radius: 10 }, { type: 'glow', radius: 10, deep: true }, { type: 'halftone', size: 6 },
      { type: 'noise', amount: 0.2 }, { type: 'transform', rotation: 10, scale: 0.9 }, { type: 'offset', shift: [30, 0] }, { type: 'tile', extend: 10 },
      { type: 'displace', amount: 10 }, { type: 'wave', amplitude: 5 }, { type: 'blockGlitch', amount: 10, rgb: 3 }, { type: 'rgbSplit' },
      { type: 'dropShadow', softness: 3 }, { type: 'stroke', color: '#fff', width: 3 }, { type: 'reveal', map: m, t: 0.5, soft: 0.2, front: '#fff' },
      { type: 'bulge', amount: 0.5 }, { type: 'spherize' }, { type: 'twirl', angle: 120 }, { type: 'ripple', amplitude: 4 }, { type: 'polar', amount: 0.5 },
      { type: 'bend', amount: 15 }, { type: 'lensDistort', amount: 0.4 }, { type: 'meshWarp', grid: [[[0, 0], [0, 0]], [[0, 0], [15, -10]]] },
      { type: 'displacementMap', map: m, amount: 8 }, { type: 'puppet', id: 'smoke', mesh: 10, pins: [{ at: [30, 30], to: [30, 30] }, { at: [150, 70], to: [160, 50] }] },
      { type: 'shatter', time: 0.15, pieces: 30, pad: 0 }, { type: 'linearWipe', completion: 0.5, feather: 10 }, { type: 'radialWipe', completion: 0.5 },
      { type: 'irisWipe', completion: 0.5, sides: 5 }, { type: 'venetianBlinds', completion: 0.5, width: 16 }, { type: 'blockDissolve', completion: 0.5 },
      { type: 'gradientWipe', completion: 0.5, soft: 0.1 }, { type: 'gradientWipe', completion: 0.5, map: m }, { type: 'pageTurn', completion: 0.4, radius: 15, back: b },
      { type: 'cardWipe', completion: 0.5, rows: 3, columns: 4, back: b }, { type: 'curves', rgb: [[0.25, 0.15], [0.75, 0.85]] }, { type: 'colorBalance', shadows: [0, 0, 0.4], preserveLuminosity: true },
      { type: 'brightnessContrast', contrast: 0.4 }, { type: 'leaveColor', color: '#e4001c' }, { type: 'innerShadow', softness: 3 }, { type: 'innerGlow', size: 8 },
      { type: 'outerGlow', size: 10 }, { type: 'bevel', size: 8 }, { type: 'gradientOverlay', stops: ['#ff2d6f', '#2b6cff'], kind: 'radial', mode: 'screen' },
      { type: 'chromaKey', color: '#00b140' }, { type: 'lumaKey', level: 0.3 }, { type: 'matteChoke', amount: 3, soft: 1 }, { type: 'lightRays', length: 0.3, threshold: 0.6, color: '#ffd27a' },
      { type: 'lensFlare', position: [130, 40] }, { type: 'lightLeak', amount: 1 },
      { type: 'custom', frag: 'vec4 effect(vec2 uv, vec2 p) { vec4 c = samp(uv); return vec4(c.gbr, c.a); }' },
    ];
    const TWs = 176, THs = 99, cols = 10;
    this.comp.layers = list.map((e, i): Layer => ({
      name: `s${i}`, size: [TWs, THs], position: [30 + (i % cols) * (TWs + 10) + TWs / 2, 30 + Math.floor(i / cols) * (THs + 30) + THs / 2],
      motionBlur: false, draw: e.type === 'chromaKey' ? gs : e.type === 'innerShadow' || e.type === 'innerGlow' || e.type === 'outerGlow' || e.type === 'bevel' || e.type === 'matteChoke' || e.type === 'puppet' ? cut : pic,
      effects: [e],
    }));
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    this.comp.render(f.t, out);
  }
}

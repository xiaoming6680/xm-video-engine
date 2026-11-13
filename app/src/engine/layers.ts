// 图层（AE 的合成和图层面板）：一个 Comp 管一叠图层，每层有自己的来源、入出点、图层时间、变换（含 3D 和父子）、
// 蒙版、效果栈、混合模式、轨道遮罩、运动模糊开关。不替画面做决定：什么都不写的图层就是原样摆在中间。
// 场景照旧可以一笔一笔自己画；需要「按层想」时用它，两种可以混着用（图层的 render 来源里照样能自己画）。
//
// 用法：
//   comp = new Comp(this.ctx, { bg: '#f4efe6', start: this.ctx.start });   // start：图层时间从这个歌曲秒算 0（默认 0 = 歌曲秒）
//   comp.layers = [                                                         // 数组前面的在下面（画家顺序，和 AE 面板相反）
//     { name: 'rig', position: (t) => [960, 540 + kf(t, drop)], rotation: (t) => kfe(t, '整组转', spin) },   // 空对象（没有来源）
//     { name: 'card', parent: 'rig', size: [600, 400], draw: (c, t) => { … }, effects: [{ type: 'dropShadow', offset: [8, 8], color: '#e4001c' }] },
//     { name: 'title', in: 1.2, out: 3, draw: (c, t) => …, fps: 12 },     // 1.2–3 秒出现，12 fps 一顿一顿
//     { name: 'flash', adjustment: true, in: 2.9, out: 2.97, effects: [{ type: 'gradientMap', stops: ['#580420', '#c1a1ad'] }] },
//   ];
//   render(f, out) { this.comp.render(f.t, out); }                          // 传歌曲秒 f.t（不是 f.lt）
//
// 图层的属性（都可选）：
//   来源（选一个；都没有 = 空对象，只给子层当父级）
//     draw(c, t, size)   Canvas 2D，按图层像素画（size 默认整幅）。t 是来源时间（见「时间」）
//     render(r, out, t)  往图层自己的渲染目标里画（已清成透明，预乘 alpha；Precomp 的写法）
//     texture            纹理或 (t) => 纹理；Layer2D / 图片 / 视频是直通 alpha，渲染目标的纹理自动按预乘处理（premultiplied 可改）
//     solid              纯色 CSS 颜色；comp  嵌套一个 Comp（预合成）
//     collapse: true     折叠变换（AE 的 Collapse Transformations，给 3D 的 comp 图层用）：嵌套合成不先拍成一张平面，里面的图层
//                        直接摆进这个合成的空间——变换 = 这层的变换 × 里面那层的，用外面的摄像机、和外面的 3D 图层一起排序、逐像素互挡，
//                        摄像机一动里面的层也有视差；里面的 2D 图层贴在这层的平面上，里面的摄像机和底色不用。这层的不透明度乘到里面每层，
//                        入出点、start / time / fps 照常管里面的时间；可以一层套一层地折。这层带 effects / masks / matte / extrude 时
//                        和 AE 一样只能拍平（照普通嵌套画，控制台提示一次）；里面的 three 层、调整层折叠时跳过
//     footage            序列帧或视频素材（engine/plate.ts 的 Plate / loadFootage）：按来源时间取帧（start、time 照常管），
//                        尺寸 = 帧的像素（1920 的素材在 1920 的合成里正好铺满）；场景的 prepare 要转给 comp.prepare(t, t0, t1)
//     three              three.js 场景：{ scene, update?(t, cam), render?(r, out, cam, t), near?, far?, occlude? }。铺满整幅，
//                        用合成的摄像机渲（Comp 的 space 换算成米，engine/space.ts），所以和 3D 图层在同一个空间里。
//                        它上面的 3D 图层按深度被它的物体挡住（occlude: false 关掉；某个 3D 图层 depthTest: false 不被挡）。
//                        update 在渲之前摆动画（t 是来源时间，cam 已经摆好）；render 给了就自己渲（AO、描边、多 pass），
//                        挡字的深度另渲一遍 scene 得到。three 层放在要被挡的 3D 图层下面；它自己的变换只挪那张图，挪了挡字会对不上
//     adjustment: true   调整层：把效果加在它下面已经叠好的画面上（整幅；masks / matte / opacity 限定范围和强度）
//   size [w, h] 图层逻辑尺寸；res 分辨率倍数（字要放大到 160% 不糊就给 2，像 AE 的连续栅格化）
//   时间
//     in / out           入出点（comp 时间，秒）；start  来源的 0 秒在 comp 的哪里（默认 0）
//     time(t)            时间重映射：comp 时间 → 来源时间（给了就不看 start）；冻结 time: () => 3，慢放 (t) => t * 0.5
//     fps                色调分离时间：这一层按这个帧率一顿一顿（变换、效果参数、来源全跟着），从 in 点起算
//     motionBlur         false = 这层不拖影（字、平面元素），数字 = 快门比例（0.5 = 半个快门），默认 true
//     smear              按速度拉糊：这层在画面里移动、旋转、缩放多快，就沿运动方向拉多长（拉丝、旋转模糊、缩放模糊）。
//                        拖影 = 每秒的运动 × smear / 30：1 ≈ 30 fps 下一整帧走的距离，0.5 ≈ 180° 快门，3 就是夸张的甩。
//                        长度只看这个数，不靠导出的子帧（--samples 1 也有拖影）；开了它这层不再按子帧摆位置，不会糊两遍。
//                        只算这层自己的变换（含父层和摄像机），画在里面的东西自己动不算
//     echo               { count, delay（秒）, decay = 0.5, mode }：残影，前几帧的这一层叠在后面（AE 的 Echo）
//     cache              图层内容（来源 + 蒙版 + 效果）什么时候可以不重画，只重新摆位置：
//                        不写 = 这层在一帧里不会变时（fps 步进、motionBlur: false）自动复用，步进的层一步只画一次；
//                        'frame' = 每帧只按这一帧的时间画一次，位置、旋转照样按子帧摆（移动照样拖影，内容本身不糊），
//                        层多、效果重、导出采样多时最省；'static' = 只画一次（背景、不变的卡片）；false = 每次都重画
//   变换（数，或 (t) => 数；t 是这层的 comp 时间，fps 步进后的）
//     position [x, y] 或 [x, y, z]（默认 comp 中心）、anchor（默认图层中心）、scale（数或 [sx, sy(, sz)]）、rotation（度，顺时针）、
//     opacity 0–1、tint 线性颜色乘数
//     threeD: true       3D 图层：z、rotationX（正值上边往里倒）、rotationY（正值右边往里倒）生效，过 comp 的摄像机透视。
//                        3D 图层之间按像素互相挡（站在地面上的卡片、交叉的两张面），和 AE 一样；Comp 的 intersect: false 退回整层按远近排，
//                        某层 depthWrite: false 不挡别人（光晕、烟这类半透明的）、depthTest: false 不被挡
//     faceCamera: true   3D 图层始终正对摄像机（AE 的「朝向摄像机」），rotationX / Y 不再管用，rotation 照样在面内转；父层别带旋转
//     cornerPin          四角钉（AE 的 Corner Pin）：[左上, 右上, 右下, 左下] 四个点，图层按透视贴上去。点在父层的像素里（没有父层就是
//                        合成像素），父层动它跟着动（父层是 3D 也行：贴在父层那张面上，和父层一样按深度挡和被挡）。钉了以后自己的
//                        position / scale / rotation 不管用；可以是 (t) => 四个点
//     parent             父层的名字：跟着父层的变换走（父层可以是空对象）
//   合成
//     mode               混合模式（gl.ts 合成器那一节）；matte  { layer: 名字, mode: 'alpha' | 'alphaInv' | 'luma' | 'lumaInv' }
//                        当遮罩的层自动不显示（visible: true 可强制显示）
//     masks              [{ path, mode = 'add' | 'subtract' | 'intersect' | 'difference', feather, expansion, opacity, invert }]
//                        path 是 shape.ts 的 Path、Path2D 或 SVG 路径字符串，按图层像素；feather 羽化 px，expansion 扩展（负数收缩）
//     effects            效果栈（engine/effects.ts），可以是 (t) => 列表；先蒙版、后效果、再变换，和 AE 一样。
//                        效果里的点（radialBlur 的 center、transform 的 anchor）按图层像素给
//     edge               效果取到图层外面时：'none' 透明（默认）、'clamp'、'wrap'、'mirror'
//     visible: false     不画（还能当父层、遮罩）
//     extrude            厚度：{ depth（沿图层自己的 z 往后挤多深，3D 图层用）, offset（[dx, dy] 沿图层平面挤，2D 也能用）, color（侧面颜色，
//                        默认黑）, colorBack（最后面的颜色，给了就从 color 渐变过去）, steps（叠几层，默认按长度自动） }。
//                        不打光的平涂侧面（白面红侧那种立体字、有厚度的卡片）：同一层的剪影沿厚度方向叠一串，3D 图层转身就露出侧面
// Comp 的参数：w、h（默认整幅）、bg（默认透明）、start、res、camera、motionBlur（各层默认）、sort3D（默认 true：相邻的 3D 层按远近排）、
//   space（{ ppm（1 米多少像素，默认 100）, origin } 或一个 Space：合成像素和 three 的米怎么换算，comp.space）、
//   intersect（默认 true：3D 图层按像素互相挡；false = 只按中心远近整层排，旧行为）。
//   comp.depthScale(z, t) 给出放到深度 z 的图层要放大多少倍才和 z = 0 时在画面上一样大（往后推做视差、又不想它变小）
// 二维镜头（推拉摇移、整幅转）：建一个空对象（没有来源的图层），别的层都 parent 到它，镜头动就是给它打帧；
//   要甩镜拖影给子层 smear。真要透视再用 3D 图层和摄像机。
//   camera   { zoom（默认 2666.7 × w / 1920，AE 的 50 mm）, position（默认 [w/2, h/2, −zoom]）, pointOfInterest、rotation [rx, ry, rz]
//            或 quaternion, dof: { focus（离摄像机的距离，默认 zoom）, radius（离焦外每一个 zoom 距离的模糊 px） } }，也可以是 (t) => 摄像机。
//            按米写的摄像机（CamPath、three 相机、Blender 的 cam.json）用 space.camera(…) 换过来（engine/space.ts）
//
// 时间怎么算：传进来的是歌曲秒，减 start 是 comp 时间。每层先按 motionBlur 决定这层在快门里取哪个时间（shutterT），fps 再把它
// 按步截断；变换和效果参数拿这个时间算；来源拿 time(t) 或 t − start。嵌套的 comp 照样这样往下传，所以里面的层运动模糊也对。
//
// 坐标：逻辑像素，y 向下，z 往屏幕里；角度顺时针为正。2D 图层不看摄像机；3D 图层在 z = 0、默认摄像机下和 2D 一样大。
// 性能：没有效果、蒙版的 Canvas / 纹理 / 纯色层直接一次合成；有效果的层多一张图层大小的渲染目标和每个效果的 pass。
import * as THREE from 'three';
import { FSPass, Layer2D, SCALE, W as CW, H as CH, clearRT, makeRT, rtScale, setRtScale, type BlendMode, type Compositor, type Lighting, type LightGPU, type MatteMode, type ShadowMap } from './gl';
import { Fx, effectPad, linear, shiftEffect, type Edge, type Effect, type EffectList } from './effects';
import { Path } from './shape';
import { shutterT } from './util';
import { Space, cameraPose, defaultZoom, projectComp, type Camera, type SpaceOpts } from './space';
import type { Plate } from './plate';

export type { Camera } from './space';

export type Prop<T> = T | ((t: number) => T);
type Vec = readonly number[];

export interface Mask {
  path: Prop<Path | Path2D | string>;
  mode?: 'add' | 'subtract' | 'intersect' | 'difference';
  feather?: Prop<number>;
  expansion?: Prop<number>;
  opacity?: Prop<number>;
  invert?: boolean;
}

export interface Echo { count: number; delay: number; decay?: number; mode?: BlendMode }

export interface Layer {
  name?: string;
  draw?: (c: CanvasRenderingContext2D, t: number, size: readonly [number, number]) => void;
  render?: (renderer: THREE.WebGLRenderer, out: THREE.WebGLRenderTarget, t: number) => void;
  texture?: Prop<THREE.Texture | null>;
  premultiplied?: boolean;
  solid?: string;
  comp?: Comp;
  footage?: Plate;
  /** With `comp` and threeD: draw the nested comp's layers straight into this comp's space (AE's Collapse Transformations). */
  collapse?: boolean;
  three?: ThreeSource;
  /** A 3D layer is hidden behind nearer 3D layers and three geometry unless this is false. */
  depthTest?: boolean;
  /** A 3D layer hides the 3D layers behind it per pixel unless this is false (glows, smoke: let them through). */
  depthWrite?: boolean;
  /** A 3D layer always faces the camera (AE's Orient Towards Camera). */
  faceCamera?: boolean;
  /** Corner pin: [top-left, top-right, bottom-right, bottom-left] in the parent's px (comp px without a parent). */
  cornerPin?: Prop<readonly (readonly number[])[]>;
  adjustment?: boolean;
  size?: readonly [number, number];
  res?: number;
  in?: number;
  out?: number;
  start?: number;
  time?: (t: number) => number;
  fps?: number;
  motionBlur?: boolean | number;
  echo?: Echo;
  position?: Prop<Vec>;
  anchor?: Prop<Vec>;
  scale?: Prop<number | Vec>;
  rotation?: Prop<number>;
  rotationX?: Prop<number>;
  rotationY?: Prop<number>;
  opacity?: Prop<number>;
  tint?: Prop<[number, number, number]>;
  threeD?: boolean;
  parent?: string;
  mode?: BlendMode;
  matte?: { layer: string; mode?: MatteMode };
  masks?: readonly Mask[];
  effects?: Prop<EffectList>;
  edge?: Edge;
  visible?: boolean;
  cache?: boolean | 'frame' | 'static';
  smear?: number;
  extrude?: Extrude;
  /** How a 3D layer takes the comp's lights (CompOpts.lights): AE's Material Options. */
  material?: Material;
}

/**
 * A light (AE's light layer), comp px: type 'ambient' | 'parallel' | 'point' | 'spot'; color '#fff'; intensity 1;
 * position (default up-left in front of the comp) and target (point of interest, default the comp's centre at z 0);
 * cone 90 / feather 0.5 (spot); falloff 'none' | 'smooth' | 'inverse' with radius 500 / distance 500;
 * shadows (the layers with material.castsShadows cast them; a point light renders six cube faces), shadowDarkness 1,
 * shadowDiffusion 0 (px), shadowSize (the map's px: 2048, a point light's faces 1024).
 */
export interface Light {
  type: 'ambient' | 'parallel' | 'point' | 'spot';
  color?: string;
  intensity?: number;
  position?: Vec;
  target?: Vec;
  cone?: number;
  feather?: number;
  falloff?: 'none' | 'smooth' | 'inverse';
  radius?: number;
  distance?: number;
  shadows?: boolean;
  shadowDarkness?: number;
  shadowDiffusion?: number;
  shadowSize?: number;
}
/** AE's Material Options: acceptsLights true, castsShadows false, acceptsShadows true; ambient 1, diffuse 1, specular 0, shininess 0.3. */
export interface Material {
  acceptsLights?: boolean;
  castsShadows?: boolean;
  acceptsShadows?: boolean;
  ambient?: number;
  diffuse?: number;
  specular?: number;
  shininess?: number;
}

export interface Extrude { depth?: number; offset?: readonly [number, number]; color?: string; colorBack?: string; steps?: number }

/** Layer.three: a three.js scene rendered through the comp's camera (see the notes at the top). */
export interface ThreeSource {
  scene: THREE.Scene | ((t: number) => THREE.Scene);
  /** Pose things for source time t before the render; `cam` is already where the comp camera is. */
  update?: (t: number, cam: THREE.PerspectiveCamera) => void;
  /** Render it yourself into `out` (cleared to transparent, has a depth buffer) instead of renderer.render(scene, cam). */
  render?: (renderer: THREE.WebGLRenderer, out: THREE.WebGLRenderTarget, cam: THREE.PerspectiveCamera, t: number) => void;
  /** Clip planes in metres (default 0.05, 2000). */
  near?: number;
  far?: number;
  /** 3D layers above this one are hidden behind its geometry (default true). */
  occlude?: boolean;
}

export interface CompOpts {
  w?: number;
  h?: number;
  bg?: string | null;
  start?: number;
  res?: number;
  camera?: Prop<Camera>;
  motionBlur?: boolean | number;
  sort3D?: boolean;
  /** Lights for the 3D layers (AE's light layers): a list, or (t) => a list. */
  lights?: Prop<readonly Light[]>;
  /** How comp px map to three's metres (Layer.three, comp.space). */
  space?: Space | SpaceOpts;
  /** 3D layers hide each other per pixel (default true); false: whole layers by their centre's distance only. */
  intersect?: boolean;
  /** Share another comp's effect runner and its scratch targets (nested comps do this by themselves). */
  fx?: Fx;
}

interface Host { renderer: THREE.WebGLRenderer; comp: Compositor }

const ev = <T>(p: Prop<T> | undefined, t: number, d: T): T => (p === undefined ? d : typeof p === 'function' ? (p as (t: number) => T)(t) : p);
const DEG = Math.PI / 180;

let white: THREE.DataTexture | null = null;
function whiteTex() {
  if (!white) {
    white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    white.colorSpace = THREE.SRGBColorSpace;
    white.needsUpdate = true;
  }
  return white;
}

/** Give a render target a float depth texture (three layers: their depth hides 3D layers). */
function withDepth(rt: THREE.WebGLRenderTarget) {
  const d = new THREE.DepthTexture(rt.width, rt.height, THREE.FloatType);
  d.minFilter = d.magFilter = THREE.NearestFilter;
  rt.depthTexture = d;
  return rt;
}

/**
 * Layer px → the quad [top-left, top-right, bottom-right, bottom-left] for a w x h layer (3x3 row-major): Heckbert's
 * square-to-quad mapping, scaled to the layer's px. Null when the quad is degenerate.
 */
export function quadHomography(w: number, h: number, q: readonly (readonly number[])[]): number[] | null {
  const [x0, y0] = [q[0]![0] ?? 0, q[0]![1] ?? 0], [x1, y1] = [q[1]![0] ?? 0, q[1]![1] ?? 0];
  const [x2, y2] = [q[2]![0] ?? 0, q[2]![1] ?? 0], [x3, y3] = [q[3]![0] ?? 0, q[3]![1] ?? 0];
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  let g = 0, k = 0;
  if (Math.abs(dx3) > 1e-12 || Math.abs(dy3) > 1e-12) {
    if (Math.abs(den) < 1e-12) return null;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    k = (dx1 * dy3 - dx3 * dy1) / den;
  }
  const a = x1 - x0 + g * x1, b = x3 - x0 + k * x3, d = y1 - y0 + g * y1, e = y3 - y0 + k * y3;
  if (!(w > 0 && h > 0) || Math.abs(a * e - b * d) < 1e-12) return null;
  return [a / w, b / h, x0, d / w, e / h, y0, g / w, k / h, 1];
}

/** 3x3 row-major product A·B. */
function mul3(A: readonly number[], B: readonly number[]): number[] {
  const o = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = A[i * 3]! * B[j]! + A[i * 3 + 1]! * B[3 + j]! + A[i * 3 + 2]! * B[6 + j]!;
  return o;
}

/** Depth-only material for a three layer's occlusion pass after a custom render. */
const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });

/** shape.ts Path / SVG string / Path2D → Path2D. */
export function toPath2D(p: Path | Path2D | string): Path2D {
  if (typeof p === 'string') return new Path2D(p);
  if (!(p instanceof Path)) return p;
  const o = new Path2D();
  for (const c of p.cmds) {
    if (c.type === 'M') o.moveTo(c.x, c.y);
    else if (c.type === 'L') o.lineTo(c.x, c.y);
    else if (c.type === 'Q') o.quadraticCurveTo(c.x1, c.y1, c.x, c.y);
    else if (c.type === 'C') o.bezierCurveTo(c.x1, c.y1, c.x2, c.y2, c.x, c.y);
    else o.closePath();
  }
  return o;
}

/** A collapsed comp's place in the comp that draws it: whose output, camera and occluder; inner comp px → its space. */
interface Collapse { root: Comp; pre: THREE.Matrix4; opacity: number }

/** One entry of a render's draw list: the layer, who owns it (a collapsed comp's layers are drawn by their own comp). */
interface Item {
  e: Eval; opacityMul: number; mode?: BlendMode; off: number;
  owner: Comp; col: Collapse | null; map: (s: number) => number; names: Map<string, Layer>;
  visibleAt: (l: Layer, off: number) => boolean;
  /** Sorts with the 3D layers (a 3D layer, or any layer of a collapsed comp). */
  d3: boolean;
}

const PLANE: Layer = {};

/** What one draw of a layer at one time needs (resolved per frame). */
interface Eval {
  l: Layer;
  key: string;
  /** comp time for properties (stepped, shuttered), and the frame's comp time */
  tc: number;
  size: [number, number];
  world: THREE.Matrix4;
  /** layer px → comp px (3x3, row-major), or null when culled */
  H: number[] | null;
  /** A corner-pinned layer on a 3D parent: the parent plane's matrix, which gives the depth (gl.ts depthMatrix). */
  Hz?: number[];
  depth: number;
}

/** The axes (rows: right, down, forward) of a light camera looking along f. */
function cameraRows(f: THREE.Vector3): number[] {
  let right = new THREE.Vector3(0, 1, 0).cross(f);
  if (right.lengthSq() < 1e-9) right = new THREE.Vector3(1, 0, 0).cross(f);
  right.normalize();
  const down = f.clone().cross(right).normalize();
  return [right.x, right.y, right.z, down.x, down.y, down.z, f.x, f.y, f.z];
}
/** A point light's cube face i (+x −x +y −y +z −z) as rows right, down, forward: the rule gl.ts cubeFace() uses. */
function cubeFace(i: number): number[] {
  const f = ([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const)[i]!;
  const d0 = Math.abs(f[1]) > 0.5 ? [0, 0, 1] : [0, 1, 0];
  const cr = (a: readonly number[], b: readonly number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const r = cr(d0, f), dn = cr(f, r);
  return [...r, ...dn, ...f];
}

export class Comp {
  readonly w: number;
  readonly h: number;
  readonly fx: Fx;
  /** Comp px ⇄ metres (engine/space.ts). */
  readonly space: Space;
  layers: Layer[] = [];
  private pxs: number;
  /** Three layers' targets and cameras, per layer. */
  private threes = new Map<string, { rt: THREE.WebGLRenderTarget; depthRT?: THREE.WebGLRenderTarget; cam: THREE.PerspectiveCamera; used: number }>();
  /** This render's occluding depth (comp px along the view axis) from the three layers drawn so far. */
  private occ: { rt: THREE.WebGLRenderTarget; n: number } | null = null;
  private occRT: THREE.WebGLRenderTarget | null = null;
  private occPass: FSPass | null = null;
  private occClear: FSPass | null = null;
  private curOut: THREE.WebGLRenderTarget | null = null;
  /** This render's lights (resolved) and shadow maps; set while the shadow maps are drawn. */
  private lit: { lights: LightGPU[]; ambient: number[]; shadows: ShadowMap[]; cam: number[] } | null = null;
  private shadowRTs: THREE.WebGLRenderTarget[] = [];
  private shadowClear: FSPass | null = null;
  private shadowing = false;
  /** The camera of the render in progress (faceCamera). */
  private camNow: Camera = {};
  /** Set while this comp's layers are drawn collapsed into another comp (Layer.collapse). */
  private col: Collapse | null = null;
  /** The comp whose output, camera and occluder the layers being drawn go to: this one, or the one it is collapsed into. */
  private get R(): Comp { return this.col?.root ?? this; }
  private canvases = new Map<string, { layer: Layer2D; used: number; key?: string }>();
  /** Cached layer contents (see Layer.cache), per layer and echo offset. */
  private cached = new Map<string, { key: string; rt: THREE.WebGLRenderTarget; used: number }>();
  private tick = 0;
  private own: THREE.WebGLRenderTarget | null = null;
  private warned = new Set<string>();
  private names = new Map<string, Layer>();

  constructor(private host: Host, readonly o: CompOpts = {}) {
    this.w = o.w ?? CW;
    this.h = o.h ?? CH;
    this.pxs = SCALE * (o.res ?? 1);
    this.fx = o.fx ?? new Fx();
    this.space = o.space instanceof Space ? o.space : new Space(this.w, this.h, o.space);
  }

  /**
   * Load what the footage layers need for the frame at song time t whose sub-frames span t0..t1 (Scene.prepare's
   * arguments): forward a scene's prepare here when its comp has footage. Nested comps are included.
   */
  prepare(t: number, t0 = t, t1 = t): Promise<void> | undefined {
    return this.prepareAt(t, t0, t1, (s) => s - (this.o.start ?? 0));
  }

  private prepareAt(t: number, t0: number, t1: number, map: (s: number) => number): Promise<void> | undefined {
    const waits: Promise<void>[] = [];
    for (const l of this.layers) {
      const offs = [0, ...(l.echo && l.echo.count > 0 ? Array.from({ length: Math.floor(l.echo.count) }, (_, k) => -(k + 1) * l.echo!.delay) : [])];
      for (const off of offs) {
        const src = (s: number) => this.srcTime(l, map(s) + off);
        if (l.footage) { const p = l.footage.prepare(src(t), src(t0), src(t1)); if (p) waits.push(p); }
        if (l.comp) { const p = l.comp.prepareAt(t, t0, t1, src); if (p) waits.push(p); }
      }
    }
    return waits.length ? Promise.all(waits).then(() => {}) : undefined;
  }

  /** Render the layers at song time `t` into `out` (cleared to bg). */
  render(t: number, out: THREE.WebGLRenderTarget, layers: readonly Layer[] = this.layers) {
    this.renderAt(t, out, (s) => s - (this.o.start ?? 0), layers);
  }

  /** Render into the comp's own target (w x h at its resolution) and return it: to draw the comp yourself. */
  renderTarget(t: number, layers: readonly Layer[] = this.layers) {
    this.render(t, this.target(), layers);
    return this.own!;
  }

  private target() {
    return (this.own ??= makeRT(this.w, this.h, { pxScale: this.pxs, depthBuffer: false }));
  }

  /**
   * `map`: song seconds → this comp's time. Every layer clock goes through it, so a nested comp under a time-remapped
   * layer still takes its motion-blur sub-frames from the song's shutter.
   */
  renderAt(songT: number, out: THREE.WebGLRenderTarget, map: (s: number) => number, layers: readonly Layer[] = this.layers) {
    const r = this.host.renderer;
    this.tick++;
    this.col = null;
    this.occ = null;
    this.curOut = out;
    const bg = this.o.bg;
    if (bg) clearRT(r, out, linear(bg), 1); else clearRT(r, out, [0, 0, 0], 0);

    // the draw list: echoes, then the layer; collapsed comps' layers in their place; contiguous 3D ones sorted far to near
    const items: Item[] = [];
    // (the camera across the shutter: its moves blur like a layer's)
    const cam = ev(this.o.camera, map(shutterT(songT, 1)), {} as Camera);
    this.collect(songT, map, layers, null, cam, items);
    this.col = null;
    this.camNow = cam;
    if (this.o.sort3D !== false) {
      for (let i = 0; i < items.length;) {
        if (!items[i]!.d3) { i++; continue; }
        let j = i;
        while (j < items.length && items[j]!.d3) j++;
        const run = items.slice(i, j).map((x, k) => ({ x, k })).sort((a, b) => b.x.e.depth - a.x.e.depth || a.k - b.k);
        run.forEach((x, k) => { items[i + k] = x.x; });
        i = j;
      }
    }

    this.lit = this.prepareLights(songT, map, items, cam);

    for (const it of items) {
      const e = it.e, l = e.l, C = it.owner;
      if (!e.H && !l.adjustment) continue;
      C.col = it.col; C.names = it.names; C.camNow = cam;
      let matte: THREE.WebGLRenderTarget | null = null;
      if (l.matte) {
        const ml = it.names.get(l.matte.layer);
        if (ml) {
          matte = this.fx.acquire(out.width, out.height, rtScale(out));
          clearRT(r, matte, [0, 0, 0], 0);
          if (it.visibleAt(ml, 0)) {
            const me = C.evaluate(ml, l.matte.layer, songT, it.map, 0, it.names, cam);
            if (me) C.drawLayer(me, songT, it.map, 0, matte, 1, undefined, null, undefined, cam);
          }
        } else C.warn(`matte layer '${l.matte.layer}' not found`);
      }
      C.drawLayer(e, songT, it.map, it.off, out, it.opacityMul, it.mode, matte, l.matte?.mode, cam);
      this.fx.release(matte);
      if (C !== this) C.col = null;
    }
    this.col = null;
    // forget canvases nobody drew for a while
    if (this.tick % 240 === 0) {
      for (const [k, v] of this.canvases) if (this.tick - v.used > 600) { v.layer.texture.dispose(); this.canvases.delete(k); }
      for (const [k, v] of this.cached) if (this.tick - v.used > 600) { v.rt.dispose(); this.cached.delete(k); }
      for (const [k, v] of this.threes) if (this.tick - v.used > 600) { v.rt.dispose(); v.depthRT?.dispose(); this.threes.delete(k); }
    }
    this.occ = null;
    this.curOut = null;
    this.lit = null;
  }

  /**
   * Add this comp's layers at song time songT to a render's draw list: evaluated (placed, projected) under `col` — null
   * for the comp being rendered, else the comp it is collapsed into. A collapsed comp layer adds its comp's layers here.
   */
  private collect(songT: number, map: (s: number) => number, layers: readonly Layer[], col: Collapse | null, cam: Camera, items: Item[]) {
    this.col = col;
    this.camNow = cam;
    const names = new Map<string, Layer>();
    layers.forEach((l, i) => names.set(l.name ?? `#${i}`, l));
    this.names = names;
    const mattes = new Set(layers.map((l) => l.matte?.layer).filter(Boolean) as string[]);
    const tf = map(shutterT(songT, 0));
    const visibleAt = (l: Layer, off: number) => tf + off >= (l.in ?? -Infinity) && tf + off < (l.out ?? Infinity);
    layers.forEach((l, i) => {
      const name = l.name ?? `#${i}`;
      if (l.visible === false || (mattes.has(name) && l.visible !== true)) return;
      if (!l.draw && !l.render && !l.texture && !l.solid && !l.comp && !l.footage && !l.three && !l.adjustment) return;
      if (col && (l.three || l.adjustment)) { this.warn(`${name}: ${l.three ? 'three' : 'adjustment'} layers are skipped inside a collapsed comp`); return; }
      if (l.comp && l.collapse) {
        if (!l.threeD) this.warn(`${name}: collapse needs threeD: true (drawn flat)`);
        else if (l.effects || l.masks?.length || l.matte || l.extrude) this.warn(`${name}: effects / masks / matte / extrude flatten a collapsed comp (drawn flat)`);
        else {
          if (!visibleAt(l, 0)) return;
          if (l.echo) this.warn(`${name}: echo is ignored on a collapsed comp`);
          const tc = this.clock(l, songT, map, 0);
          const pre = (col ? col.pre.clone() : new THREE.Matrix4()).multiply(this.worldOf(l, songT, map, 0, names));
          const inner: Collapse = { root: col?.root ?? this, pre, opacity: ev(l.opacity, tc, 1) * (col?.opacity ?? 1) };
          l.comp.collect(songT, (s) => this.srcTime(l, this.mapClock(l, s, map, 0)), l.comp.layers, inner, cam, items);
          // (back to this comp's own state for the layers after it)
          this.col = col; this.names = names; this.camNow = cam;
          return;
        }
      }
      const add = (off: number, k: number, mode?: BlendMode) => {
        if (!visibleAt(l, off)) return;
        const e = this.evaluate(l, name, songT, map, off, names, cam);
        if (e) items.push({ e, opacityMul: k * (col?.opacity ?? 1), mode, off, owner: this, col, map, names, visibleAt, d3: (!!l.threeD || !!col) && !l.adjustment });
      };
      if (l.echo && l.echo.count > 0) for (let k = Math.floor(l.echo.count); k >= 1; k--) add(-k * l.echo.delay, (l.echo.decay ?? 0.5) ** k, l.echo.mode);
      add(0, 1);
    });
  }

  /** The layer's comp time at this sub-frame (motion blur switch, posterize time), plus an echo offset. */
  private clock(l: Layer, songT: number, map: (s: number) => number, off: number) {
    if (l.fps && l.fps > 0) {
      const t0 = l.in ?? 0, tf = map(shutterT(songT, 0)) + off;
      return t0 + Math.floor((tf - t0) * l.fps + 1e-6) / l.fps;
    }
    const mb = l.smear ? false : l.motionBlur ?? this.o.motionBlur ?? true;
    return map(shutterT(songT, mb === true ? 1 : mb === false ? 0 : mb)) + off;
  }

  /** The layer clock at comp time tf (no shutter): stepped by fps, plus an echo offset. */
  private clockAt(l: Layer, tf: number, off: number) {
    const x = tf + off;
    if (l.fps && l.fps > 0) { const t0 = l.in ?? 0; return t0 + Math.floor((x - t0) * l.fps + 1e-6) / l.fps; }
    return x;
  }

  private sizeOf(l: Layer, t: number): [number, number] {
    if (l.size) return [l.size[0], l.size[1]];
    if (l.comp) return [l.comp.w, l.comp.h];
    if (l.footage && l.footage.width > 0) return [l.footage.width, l.footage.height];
    if (l.texture) {
      const tex = ev(l.texture, t, null);
      const img = tex?.image as { width?: number; height?: number; videoWidth?: number; videoHeight?: number } | undefined;
      if (img) return [(img.videoWidth || img.width || 0) / SCALE, (img.videoHeight || img.height || 0) / SCALE];
    }
    if (!l.draw && !l.render && !l.solid && !l.adjustment && !l.texture && !l.footage && !l.three) return [0, 0];
    return [this.w, this.h];
  }

  /** Local matrix: T(position) · Rx · Ry · Rz · S · T(−anchor). */
  private local(l: Layer, t: number, size: [number, number]) {
    const p = ev(l.position, t, [this.w / 2, this.h / 2] as Vec), a = ev(l.anchor, t, [size[0] / 2, size[1] / 2] as Vec);
    const sc = ev(l.scale, t, 1 as number | Vec);
    const [sx, sy, sz] = typeof sc === 'number' ? [sc, sc, sc] : [sc[0] ?? 1, sc[1] ?? sc[0] ?? 1, sc[2] ?? 1];
    const d3 = !!l.threeD;
    const m = new THREE.Matrix4().makeTranslation(p[0] ?? 0, p[1] ?? 0, d3 ? p[2] ?? 0 : 0);
    if (d3 && l.faceCamera) {
      // the layer's +z (away from its front) along the camera → layer line, its x level with the comp's x
      const R = this.R, { P } = cameraPose(this.camNow, R.w, R.h);
      if (this.col) P.applyMatrix4(this.col.pre.clone().invert());
      const z = new THREE.Vector3(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0).sub(P);
      if (z.lengthSq() > 1e-9) {
        z.normalize();
        const x = new THREE.Vector3(0, 1, 0).cross(z);
        if (x.lengthSq() < 1e-9) x.set(1, 0, 0); else x.normalize();
        m.multiply(new THREE.Matrix4().makeBasis(x, z.clone().cross(x), z));
      }
    } else if (d3) {
      m.multiply(new THREE.Matrix4().makeRotationX(-ev(l.rotationX, t, 0) * DEG));
      m.multiply(new THREE.Matrix4().makeRotationY(-ev(l.rotationY, t, 0) * DEG));
    }
    m.multiply(new THREE.Matrix4().makeRotationZ(ev(l.rotation, t, 0) * DEG));
    m.multiply(new THREE.Matrix4().makeScale(sx, sy, d3 ? sz : 1));
    m.multiply(new THREE.Matrix4().makeTranslation(-(a[0] ?? 0), -(a[1] ?? 0), d3 ? -(a[2] ?? 0) : 0));
    return m;
  }

  private worldOf(l: Layer, songT: number, map: (s: number) => number, off: number, names: Map<string, Layer>, depth = 0): THREE.Matrix4 {
    const t = this.clock(l, songT, map, off);
    const m = this.local(l, t, this.sizeOf(l, t));
    if (!l.parent) return m;
    const p = names.get(l.parent);
    if (!p || depth > 32) { this.warn(`parent '${l.parent}' not found`); return m; }
    return this.worldOf(p, songT, map, off, names, depth + 1).multiply(m);
  }

  private view(cam: Camera) {
    const { P, R, zoom } = cameraPose(cam, this.w, this.h);
    const V = new THREE.Matrix4().makeTranslation(P.x, P.y, P.z).multiply(R).invert();
    return { V, zoom };
  }

  private evaluate(l: Layer, name: string, songT: number, map: (s: number) => number, off: number, names: Map<string, Layer>, cam: Camera): Eval | null {
    const tc = this.clock(l, songT, map, off);
    const size = this.sizeOf(l, tc);
    const key = `${name}`;
    if (l.adjustment) return { l, key, tc, size, world: new THREE.Matrix4(), H: null, depth: 0 };
    if (l.cornerPin) {
      const pts = ev(l.cornerPin, tc, [] as readonly (readonly number[])[]);
      let H: number[] | null = pts.length === 4 ? quadHomography(size[0], size[1], pts) : null;
      if (!H) this.warn(`${name}: cornerPin needs four points`);
      const par = l.parent ? names.get(l.parent) : undefined;
      let Hz: number[] | undefined, depth = 0;
      if (H && par) {
        const pe = this.evaluate(par, l.parent!, songT, map, off, names, cam);
        H = pe?.H ? mul3(pe.H, H) : null;
        // on a 3D parent: in its plane, so its depth is the parent's
        if (pe?.H && (pe.Hz || ((pe.l.threeD || this.col) && !pe.l.cornerPin))) { Hz = pe.Hz ?? pe.H; depth = pe.depth; }
      } else if (H && this.col) {
        // collapsed: the points are on the collapsed comp's plane
        const pl = this.project(PLANE, new THREE.Matrix4(), [this.w, this.h], cam);
        H = pl.H ? mul3(pl.H, H) : null;
        if (pl.H) { Hz = pl.H; depth = pl.depth; }
      }
      return { l, key, tc, size, world: new THREE.Matrix4(), H, Hz, depth };
    }
    const world = this.worldOf(l, songT, map, off, names);
    const pr = this.project(l, world, size, cam);
    return { l, key, tc, size, world, H: pr.H, depth: pr.depth };
  }

  /** Layer px → comp px (3x3 row-major) for a world matrix: the affine part for 2D, through the camera for 3D (null: culled). */
  private project(l: Layer, world: THREE.Matrix4, size: [number, number], cam: Camera): { H: number[] | null; depth: number } {
    const e = world.elements; // column-major
    const col = this.col;
    if (!l.threeD && !col) return { H: [e[0]!, e[4]!, e[12]!, e[1]!, e[5]!, e[13]!, 0, 0, 1], depth: 0 };
    // (collapsed: into the outer comp's space first, then through its camera onto its screen)
    const R = this.R, { V, zoom } = R.view(cam);
    const A = V.multiply(col ? col.pre.clone().multiply(world) : world).elements;
    // camera space of (x, y, 0, 1): columns 0, 1, 3; screen = [zoom·X + w/2·Z, zoom·Y + h/2·Z, Z]
    const G = [A[0]!, A[4]!, A[12]!, A[1]!, A[5]!, A[13]!, A[2]!, A[6]!, A[14]!];
    const cx = R.w / 2, cy = R.h / 2;
    const H = [
      zoom * G[0]! + cx * G[6]!, zoom * G[1]! + cx * G[7]!, zoom * G[2]! + cx * G[8]!,
      zoom * G[3]! + cy * G[6]!, zoom * G[4]! + cy * G[7]!, zoom * G[5]! + cy * G[8]!,
      G[6]!, G[7]!, G[8]!,
    ];
    const zAt = (x: number, y: number) => G[6]! * x + G[7]! * y + G[8]!;
    const corners = [zAt(0, 0), zAt(size[0], 0), zAt(0, size[1]), zAt(size[0], size[1])];
    const depth = zAt(size[0] / 2, size[1] / 2);
    return { H: Math.min(...corners) < 1 ? null : H, depth };
  }

  /** World matrix at comp time tc for the layer and its parents (no shutter, no fps steps). */
  private worldAtTime(l: Layer, tc: number, depth = 0): THREE.Matrix4 {
    const m = this.local(l, tc, this.sizeOf(l, tc));
    const p = l.parent ? this.names.get(l.parent) : undefined;
    return p && depth < 32 ? this.worldAtTime(p, tc, depth + 1).multiply(m) : m;
  }

  /**
   * Layer.smear: the layer's screen motion around the frame's time, measured at its anchor (translation, rotation and
   * scale of the projected layer), turned into blurs in layer px. Centres are in layer px (shifted by the padding later).
   */
  private smearEffects(l: Layer, tf: number, size: [number, number], cam: Camera): Effect[] {
    const h = 1 / 240, k = (l.smear ?? 0) / 30;
    const Hs = [-h, 0, h].map((d) => this.project(l, this.worldAtTime(l, tf + d), size, cam).H);
    if (Hs.some((H) => !H)) return [];
    const a = ev(l.anchor, tf, [size[0] / 2, size[1] / 2] as Vec), ax = a[0] ?? size[0] / 2, ay = a[1] ?? size[1] / 2;
    const P = (H: number[], x: number, y: number): [number, number] => {
      const z = H[6]! * x + H[7]! * y + H[8]!;
      return [(H[0]! * x + H[1]! * y + H[2]!) / z, (H[3]! * x + H[4]! * y + H[5]!) / z];
    };
    // the local frame on screen at the anchor: where it is, where its x and y unit vectors point
    const frame = (H: number[]) => {
      const o = P(H, ax, ay), x = P(H, ax + 1, ay), y = P(H, ax, ay + 1);
      return { o, jx: [x[0] - o[0], x[1] - o[1]], jy: [y[0] - o[0], y[1] - o[1]] };
    };
    const [A, C, B] = Hs.map((H) => frame(H!)) as [ReturnType<typeof frame>, ReturnType<typeof frame>, ReturnType<typeof frame>];
    const out: Effect[] = [];
    // translation: screen velocity back into layer px through the local frame
    const vx = (B.o[0] - A.o[0]) / (2 * h), vy = (B.o[1] - A.o[1]) / (2 * h);
    const det = C.jx[0]! * C.jy[1]! - C.jy[0]! * C.jx[1]!;
    if (Math.abs(det) > 1e-9) {
      const lx = (C.jy[1]! * vx - C.jy[0]! * vy) / det, ly = (-C.jx[1]! * vx + C.jx[0]! * vy) / det;
      const len = Math.hypot(lx, ly) * k;
      if (len > 0.5) out.push({ type: 'directionalBlur', angle: (Math.atan2(ly, lx) * 180) / Math.PI, length: len });
    }
    // rotation: the turn of the local x axis
    let dr = Math.atan2(B.jx[1]!, B.jx[0]!) - Math.atan2(A.jx[1]!, A.jx[0]!);
    dr = Math.atan2(Math.sin(dr), Math.cos(dr));
    const spin = ((dr / (2 * h)) * k * 180) / Math.PI;
    if (Math.abs(spin) > 0.2) out.push({ type: 'radialBlur', kind: 'spin', amount: spin, center: [ax, ay] });
    // scale: the change of the local area
    const s = (F: ReturnType<typeof frame>) => Math.sqrt(Math.abs(F.jx[0]! * F.jy[1]! - F.jy[0]! * F.jx[1]!));
    const sa = s(A), sb = s(B);
    if (sa > 1e-6 && sb > 1e-6) {
      const zoom = 1 - Math.exp(-Math.abs(Math.log(sb / sa) / (2 * h)) * k);
      if (zoom > 0.002) out.push({ type: 'radialBlur', kind: 'zoom', amount: Math.min(0.9, zoom), center: [ax, ay] });
    }
    return out;
  }

  private canvasRec(key: string, w: number, h: number, pxs: number) {
    const k = `${key}|${w}x${h}@${pxs}`;
    let c = this.canvases.get(k);
    if (!c) { c = { layer: new Layer2D(w, h, pxs), used: this.tick }; this.canvases.set(k, c); }
    c.used = this.tick;
    return c;
  }
  private canvas(key: string, w: number, h: number, pxs: number) { return this.canvasRec(key, w, h, pxs).layer; }

  private warn(msg: string) {
    if (this.warned.has(msg)) return;
    this.warned.add(msg);
    console.warn(`[Comp] ${msg}`);
  }

  /** Source time of a layer at comp time tc. */
  private srcTime(l: Layer, tc: number) {
    return l.time ? l.time(tc) : tc - (l.start ?? 0);
  }

  private drawLayer(e: Eval, songT: number, map: (s: number) => number, off: number, target: THREE.WebGLRenderTarget, opacityMul: number,
    modeOverride: BlendMode | undefined, matte: THREE.WebGLRenderTarget | null, matteMode: MatteMode | undefined, cam: Camera) {
    const r = this.host.renderer, comp = this.host.comp, l = e.l, t = e.tc;
    const mt = matte?.texture ?? null;
    const opacity = ev(l.opacity, t, 1) * opacityMul;
    if (opacity <= 0) return;
    const mode = modeOverride ?? l.mode ?? 'normal';
    const tint = ev(l.tint, t, undefined as [number, number, number] | undefined);
    // content (source, masks, effects): at the layer's time, or at the frame's own time for cache 'frame'
    const mb = l.smear ? false : l.motionBlur ?? this.o.motionBlur ?? true;
    const cacheMode = l.adjustment || l.three || l.cache === false ? null : l.cache === 'static' ? 'static' : l.cache === 'frame' || l.cache === true ? 'frame'
      : (l.fps && l.fps > 0) || mb === false ? 'auto' : null;
    const tf = cacheMode === 'frame' ? this.clockAt(l, map(shutterT(songT, 0)), off) : t;
    // a 3D layer: hidden behind the nearer 3D layers and three geometry drawn so far, and hiding what is behind it
    const R = this.R, in3D = !!l.threeD || !!this.col;
    const solid3D = (in3D && !l.cornerPin) || !!e.Hz;
    const depth = solid3D && l.depthTest !== false && R.occ ? R.occ.rt.texture : undefined;
    const zWrite = solid3D && target === R.curOut && R.o.intersect !== false && l.depthWrite !== false;
    const writeZ = (tex: THREE.Texture, premult: boolean, m: number[], size: [number, number]) => {
      if (zWrite) comp.drawDepth(r, tex, R.occTarget(), { premult, opacity, transform: { matrix: m, size, depthMatrix: e.Hz } });
    };
    let effects = (ev(l.effects, tf, [] as EffectList).filter(Boolean) as Effect[]);

    if (l.adjustment) {
      const ts = rtScale(target), bd = this.fx.acquire(target.width, target.height, ts), res = this.fx.acquire(target.width, target.height, ts);
      comp.draw(r, target.texture, bd, { mode: 'replace', premult: false });
      this.fx.run(r, bd.texture, res, effects, { pxs: ts, edge: l.edge ?? 'clamp' });
      let src = res;
      if (l.masks?.length) {
        const m = this.maskTexture(e.key, l.masks, t, target.width / ts, target.height / ts, 0, ts);
        comp.draw(r, res.texture, bd, { mode: 'replace', premult: false, matte: m, matteMode: 'alpha' });
        src = bd;
      }
      comp.draw(r, src.texture, target, { mode, opacity, tint, premult: false, matte: mt, matteMode, mattePremult: false });
      this.fx.release(bd); this.fx.release(res);
      return;
    }

    // depth of field: an extra blur by distance from the focus plane
    if (in3D && !l.cornerPin && cam.dof && cam.dof.radius > 0 && e.depth > 0) {
      const zoom = cam.zoom ?? defaultZoom(R.w);
      const b = cam.dof.radius * Math.abs(e.depth - (cam.dof.focus ?? zoom)) / zoom;
      if (b > 0.05) effects = [...effects, { type: 'blur', radius: b }];
    }

    const [w, h] = e.size;
    if (!(w > 0 && h > 0) || !e.H) return;
    if (l.smear && l.smear > 0) effects = [...effects, ...this.smearEffects(l, map(shutterT(songT, 0)) + off, e.size, cam)];
    const pxs = SCALE * (l.res ?? 1);
    const pad = Math.ceil(effects.reduce((s, x) => s + effectPad(x, [w, h]), 0));
    // points the effects take in layer px (centres, anchors, a flare's source) move with the content into the padded buffer
    if (pad > 0) effects = effects.map((x) => shiftEffect(x, pad, pad));
    const st = this.srcTime(l, tf);
    const slot = `${e.key}@${off}`;
    const ck = cacheMode ? `${cacheMode === 'static' ? 'static' : tf}|${st}|${w}x${h}@${pxs}|${pad}|${JSON.stringify(effects, (_k, v) => (v instanceof THREE.Texture ? v.uuid : v))}` : null;
    const matrix = (p: number) => {
      // buffer px (padded) → comp px: H · T(−pad)
      const H = e.H!;
      return [H[0]!, H[1]!, H[2]! - p * (H[0]! + H[1]!), H[3]!, H[4]!, H[5]! - p * (H[3]! + H[4]!), H[6]!, H[7]!, H[8]! - p * (H[6]! + H[7]!)];
    };
    const place = (tex: THREE.Texture, premult: boolean, bw: number, bh: number, p: number) => {
      if (R.shadowing) { comp.drawDepth(r, tex, target, { premult, opacity, transform: { matrix: matrix(p), size: [bw, bh] } }); return; }
      comp.draw(r, tex, target, { mode, opacity, tint, premult, matte: mt, matteMode, mattePremult: false, transform: { matrix: matrix(p), size: [bw, bh], depthMatrix: e.Hz }, depth, light: this.lightFor(e, p) });
      writeZ(tex, premult, matrix(p), [bw, bh]);
    };

    const simple = !effects.length && !l.masks?.length && !l.extrude;
    // fast paths: straight from the source
    if (simple && (l.draw || l.solid || l.texture || l.footage)) {
      if (l.draw) {
        const rec = this.canvasRec(slot, w, h, pxs), cv = rec.layer;
        if (ck && rec.key === ck) return place(cv.texture, true, w, h, 0);
        cv.clear();
        l.draw(cv.ctx, st, [w, h]);
        rec.key = ck ?? undefined;
        return place(cv.upload(), true, w, h, 0);
      }
      if (l.solid) {
        if (R.shadowing) { comp.drawDepth(r, whiteTex(), target, { premult: true, opacity, transform: { matrix: matrix(0), size: [w, h] } }); return; }
        const c = linear(l.solid), k = tint ?? [1, 1, 1];
        comp.draw(r, whiteTex(), target, { mode, opacity, tint: [c[0] * k[0], c[1] * k[1], c[2] * k[2]], matte: mt, matteMode, mattePremult: false, transform: { matrix: matrix(0), size: [w, h], depthMatrix: e.Hz }, depth, light: this.lightFor(e, 0) });
        return writeZ(whiteTex(), true, matrix(0), [w, h]);
      }
      const tex = this.sourceTexture(l, tf, st);
      if (!tex) return;
      return place(tex, this.straight(l, tex), w, h, 0);
    }

    // general path: the layer into its own padded buffer, masks, effects, then placed
    const bw = w + 2 * pad, bh = h + 2 * pad;
    const hit = ck ? this.cached.get(slot) : undefined;
    if (hit && hit.key === ck) { hit.used = this.tick; return place(hit.rt.texture, false, bw, bh, pad); }
    let buf = this.fx.acquire(bw * pxs, bh * pxs, pxs);
    clearRT(r, buf, [0, 0, 0], 0);
    const inner = { position: [pad + w / 2, pad + h / 2] as [number, number], size: [w, h] as [number, number] };
    if (l.draw) {
      const cv = this.canvas(slot, bw, bh, pxs);
      cv.clear();
      cv.ctx.save(); cv.ctx.translate(pad, pad);
      l.draw(cv.ctx, st, [w, h]);
      cv.ctx.restore();
      comp.draw(r, cv.upload(), buf, { mode: 'replace' });
    } else if (l.solid) {
      comp.draw(r, whiteTex(), buf, { mode: 'replace', tint: linear(l.solid), transform: inner });
    } else if (l.texture || l.footage) {
      const tex = this.sourceTexture(l, tf, st);
      if (tex) comp.draw(r, tex, buf, { mode: 'replace', premult: this.straight(l, tex), transform: inner });
    } else if (l.three) {
      const src = this.renderThree(l, slot, st, w, h, pxs, cam, target === R.curOut);
      comp.draw(r, src.texture, buf, { mode: 'replace', premult: false, transform: inner });
    } else if (l.render || l.comp) {
      let src: THREE.WebGLRenderTarget;
      let tmp: THREE.WebGLRenderTarget | null = null;
      if (l.comp) {
        src = l.comp.target();
        // (a frame-cached nested comp renders at the frame's time: its own layers don't move within the frame either)
        l.comp.renderAt(songT, src, cacheMode === 'frame' ? () => st : (s) => this.srcTime(l, this.mapClock(l, s, map, off)));
      } else {
        tmp = src = this.fx.acquire(w * pxs, h * pxs, pxs);
        clearRT(r, src, [0, 0, 0], 0);
        l.render!(r, src, st);
      }
      comp.draw(r, src.texture, buf, { mode: 'replace', premult: false, transform: inner });
      this.fx.release(tmp);
    }
    if (l.masks?.length) {
      const m = this.maskTexture(e.key, l.masks, tf, bw, bh, pad, pxs);
      const tmp = this.fx.acquire(buf.width, buf.height, pxs);
      comp.draw(r, buf.texture, tmp, { mode: 'replace', premult: false, matte: m, matteMode: 'alpha' });
      this.fx.release(buf);
      buf = tmp;
    }
    if (effects.length) {
      const res = this.fx.acquire(buf.width, buf.height, pxs);
      this.fx.run(r, buf.texture, res, effects, { pxs, edge: l.edge ?? 'none', inner: [pad, pad, w, h] });
      this.fx.release(buf);
      buf = res;
    }
    if (ck) {
      // keep a copy for the next sub-frames / steps (its own target, outside the scratch pool)
      let c = this.cached.get(slot);
      if (!c || c.rt.width !== buf.width || c.rt.height !== buf.height) {
        c?.rt.dispose();
        const rt = new THREE.WebGLRenderTarget(buf.width, buf.height, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
        c = { key: '', rt, used: this.tick };
        this.cached.set(slot, c);
      }
      comp.draw(r, buf.texture, c.rt, { mode: 'replace', premult: false });
      c.key = ck; c.used = this.tick;
    }
    if (l.extrude && !R.shadowing) this.drawExtrude(e, buf, bw, bh, pad, pxs, target, { mode, opacity, mt, matteMode, depth, writeZ }, cam);
    else place(buf.texture, false, bw, bh, pad);
    this.fx.release(buf);
  }

  /**
   * Layer.extrude: the layer's silhouette stacked along the thickness (its own z for depth, its plane for offset), in
   * the side colour, then the face; copies and face drawn far to near, so a 3D layer that turns shows its sides.
   */
  private drawExtrude(e: Eval, buf: THREE.WebGLRenderTarget, bw: number, bh: number, pad: number, pxs: number, target: THREE.WebGLRenderTarget,
    o: { mode: BlendMode; opacity: number; mt: THREE.Texture | null; matteMode: MatteMode | undefined; depth?: THREE.Texture;
      writeZ?: (tex: THREE.Texture, premult: boolean, m: number[], size: [number, number]) => void }, cam: Camera) {
    const r = this.host.renderer, comp = this.host.comp, l = e.l, ex = l.extrude!;
    const in3D = !!l.threeD || !!this.col;
    const depth = in3D ? ex.depth ?? 0 : 0, [ox, oy] = ex.offset ?? [0, 0];
    const len = Math.max(Math.hypot(ox, oy), Math.abs(depth));
    const n = Math.max(1, Math.min(96, ex.steps ?? Math.ceil(len)));
    const sil = this.fx.acquire(buf.width, buf.height, pxs);
    this.fx.run(r, buf.texture, sil, [{ type: 'fill', color: '#ffffff' }], { pxs });
    const c0 = linear(ex.color ?? '#000000'), c1 = linear(ex.colorBack ?? ex.color ?? '#000000');
    const toBuf = (H: number[]) => [H[0]!, H[1]!, H[2]! - pad * (H[0]! + H[1]!), H[3]!, H[4]!, H[5]! - pad * (H[3]! + H[4]!), H[6]!, H[7]!, H[8]! - pad * (H[6]! + H[7]!)];
    // every copy (k = n … 1) and the face (k = 0), with its depth for the painter's order
    const items: { k: number; H: number[]; z: number }[] = [];
    for (let k = n; k >= 0; k--) {
      const u = k / n;
      const w = e.world.clone().multiply(new THREE.Matrix4().makeTranslation(ox * u, oy * u, depth * u));
      const pr = k === 0 ? { H: e.H, depth: e.depth } : this.project(l, w, e.size, cam);
      if (pr.H) items.push({ k, H: pr.H, z: in3D ? pr.depth : k }); // (2D: the farthest copy first, the face last)
    }
    items.sort((a, b) => b.z - a.z);
    for (const it of items) {
      const u = it.k / n;
      const tint: [number, number, number] | undefined = it.k === 0 ? undefined : [c0[0] + (c1[0] - c0[0]) * u, c0[1] + (c1[1] - c0[1]) * u, c0[2] + (c1[2] - c0[2]) * u];
      comp.draw(r, it.k === 0 ? buf.texture : sil.texture, target, { mode: o.mode, opacity: o.opacity, tint, premult: false, matte: o.mt, matteMode: o.matteMode, mattePremult: false, transform: { matrix: toBuf(it.H), size: [bw, bh] }, depth: o.depth });
      o.writeZ?.(it.k === 0 ? buf.texture : sil.texture, false, toBuf(it.H), [bw, bh]);
    }
    this.fx.release(sil);
  }

  /** The texture of a texture / footage layer: footage by source time, a texture by the layer's comp time. */
  private sourceTexture(l: Layer, tf: number, st: number): THREE.Texture | null {
    return l.footage ? l.footage.texture(st) : ev(l.texture, tf, null);
  }

  /** Whether the source texture holds straight (not premultiplied) alpha: what Compositor.draw's premult means. */
  private straight(l: Layer, tex: THREE.Texture) {
    if (l.premultiplied !== undefined) return !l.premultiplied;
    if (l.footage) return !(l.footage.o.premultiplied ?? (tex as THREE.DataTexture).isDataTexture === true);
    return !tex.isRenderTargetTexture;
  }

  /**
   * Layer.three: the scene through the comp camera (converted to metres by this.space) into the layer's own target with
   * a depth texture; when `occludes` (drawn into this render's output), its depth joins the occluder for the 3D layers
   * drawn after it.
   */
  private renderThree(l: Layer, slot: string, st: number, w: number, h: number, pxs: number, cam: Camera, occludes: boolean) {
    const r = this.host.renderer, src = l.three!;
    const W = Math.max(1, Math.round(w * pxs)), H = Math.max(1, Math.round(h * pxs));
    let rec = this.threes.get(slot);
    if (!rec || rec.rt.width !== W || rec.rt.height !== H) {
      rec?.rt.dispose(); rec?.depthRT?.dispose();
      rec = { rt: withDepth(makeRT(w, h, { pxScale: pxs })), cam: new THREE.PerspectiveCamera(), used: this.tick };
      this.threes.set(slot, rec);
    }
    rec.used = this.tick;
    const near = src.near ?? 0.05, far = src.far ?? 2000;
    const c3 = this.space.toThree(cam, rec.cam, near, far);
    src.update?.(st, c3);
    const scene = typeof src.scene === 'function' ? src.scene(st) : src.scene;
    const auto = r.autoClear;
    r.autoClear = false;
    try {
      // (autoClear is off for the custom render's sake: a colour background is the clear colour, as three does it)
      const bgc = scene.background instanceof THREE.Color ? scene.background : null;
      clearRT(r, rec.rt, bgc ? [bgc.r, bgc.g, bgc.b] : [0, 0, 0], bgc ? 1 : 0);
      if (src.render) src.render(r, rec.rt, c3, st);
      else { r.setRenderTarget(rec.rt); r.render(scene, c3); }
      if (occludes && src.occlude !== false) {
        let dt = rec.rt.depthTexture!;
        if (src.render) {
          // a custom render may not leave the scene's depth in out: a depth-only pass of the scene
          rec.depthRT ??= withDepth(makeRT(w, h, { pxScale: pxs }));
          const bgk = scene.background, ov = scene.overrideMaterial;
          scene.background = null; scene.overrideMaterial = depthOnly;
          clearRT(r, rec.depthRT, [0, 0, 0], 0);
          r.setRenderTarget(rec.depthRT); r.render(scene, c3);
          scene.background = bgk; scene.overrideMaterial = ov;
          dt = rec.depthRT.depthTexture!;
        }
        this.addOccluder(dt, near, far);
      }
    } finally {
      r.autoClear = auto;
    }
    return rec.rt;
  }

  /**
   * This render's occluder (depth along the view axis in comp px, nearest kept; the output's size), cleared to far the
   * first time it is asked for in a render.
   */
  /** The comp's lights at this frame, resolved for the shaders, with their shadow maps drawn (null: no lights). */
  private prepareLights(songT: number, map: (s: number) => number, items: Item[], cam: Camera) {
    const ls = ev(this.o.lights, map(shutterT(songT, 1)), [] as readonly Light[]);
    if (!ls.length) return null;
    const amb = [0, 0, 0], lights: LightGPU[] = [], shadows: ShadowMap[] = [];
    for (const L of ls) {
      const col = linear(L.color ?? '#ffffff'), k = L.intensity ?? 1;
      if (L.type === 'ambient') { amb[0] += col[0] * k; amb[1] += col[1] * k; amb[2] += col[2] * k; continue; }
      if (lights.length >= 4) { this.warn('more than 4 lights (not counting ambient): the rest are ignored'); continue; }
      const P = new THREE.Vector3(L.position?.[0] ?? this.w / 2 - 600, L.position?.[1] ?? this.h / 2 - 500, L.position?.[2] ?? -900);
      const T = new THREE.Vector3(L.target?.[0] ?? this.w / 2, L.target?.[1] ?? this.h / 2, L.target?.[2] ?? 0);
      const d = T.clone().sub(P);
      if (d.lengthSq() < 1e-9) d.set(0, 0, 1);
      d.normalize();
      const half = ((L.cone ?? 90) * DEG) / 2, inner = half * (1 - Math.min(1, Math.max(0, L.feather ?? 0.5)));
      const g: LightGPU = {
        type: L.type === 'parallel' ? 1 : L.type === 'spot' ? 3 : 2, pos: [P.x, P.y, P.z], dir: [d.x, d.y, d.z],
        color: [col[0] * k, col[1] * k, col[2] * k], cosIn: Math.cos(inner), cosOut: Math.cos(half),
        falloff: L.falloff === 'smooth' ? 1 : L.falloff === 'inverse' ? 2 : 0, radius: L.radius ?? 500, distance: L.distance ?? 500,
      };
      if (L.shadows && shadows.length >= 2) this.warn('only two lights cast shadows: the rest light without');
      else if (L.shadows) { g.shadow = shadows.length; shadows.push(this.shadowMap(L, g, T, items, songT, cam, shadows.length)); }
      lights.push(g);
    }
    const { P } = cameraPose(cam, this.w, this.h);
    return { lights, ambient: amb, shadows, cam: [P.x, P.y, P.z] };
  }

  /**
   * A light's shadow map: the casting 3D layers' depth along a light camera (a spot: at the light, its cone; a parallel
   * light: far back along its direction, nearly orthographic, covering the comp and around it; a point light: six 90°
   * cameras, one per cube face, in a 3 x 2 atlas — the faces' axes as in gl.ts cubeFace()).
   */
  private shadowMap(L: Light, g: LightGPU, T: THREE.Vector3, items: Item[], songT: number, cam: Camera, k: number): ShadowMap {
    const r = this.host.renderer, cube = g.type === 2;
    const S = Math.max(256, Math.round(L.shadowSize ?? (cube ? 1024 : 2048)));
    const f = new THREE.Vector3(g.dir[0], g.dir[1], g.dir[2]);
    let P = new THREE.Vector3(g.pos[0], g.pos[1], g.pos[2]), zoom: number;
    if (cube) zoom = S / 2;
    else if (g.type === 3) zoom = (S / 2) / Math.tan(Math.min(Math.acos(Math.max(-1, Math.min(1, g.cosOut))) * 1.05, 1.5));
    else { const D = 40000, cover = Math.hypot(this.w, this.h) * 1.5; P = T.clone().addScaledVector(f, -D); zoom = (S / 2) * D / cover; }
    const W = cube ? 3 * S : S, H = cube ? 2 * S : S;
    let rt = this.shadowRTs[k];
    if (!rt || rt.width !== W || rt.height !== H) {
      rt?.dispose();
      rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
      setRtScale(rt, 1);
      this.shadowRTs[k] = rt;
    }
    this.shadowClear ??= new FSPass(/* glsl */ 'void main() { fragColor = vec4(1e20); }', {}, { blending: THREE.NoBlending });
    this.shadowClear.render(r, rt);
    const flat = { ...cam, dof: undefined };
    const faces: { R: number[]; ox: number; oy: number }[] = cube
      ? [0, 1, 2, 3, 4, 5].map((i) => ({ R: cubeFace(i), ox: (i % 3) * S, oy: Math.floor(i / 3) * S }))
      : [{ R: cameraRows(f), ox: 0, oy: 0 }];
    this.shadowing = true;
    try {
      for (const fc of faces) {
        const Rr = fc.R;
        for (const it of items) {
          const e = it.e, l = e.l;
          if (!it.d3 || !l.material?.castsShadows || l.cornerPin || l.adjustment) continue;
          const Wm = it.col ? it.col.pre.clone().multiply(e.world) : e.world;
          // light camera space of the layer point (x, y, 0, 1), then onto the map (as project() does for the comp camera);
          // a layer partly behind the light camera is still drawn: the depth pass drops the fragments behind it
          const we = Wm.elements, c0 = [we[0]!, we[1]!, we[2]!], c1 = [we[4]!, we[5]!, we[6]!], c3 = [we[12]! - P.x, we[13]! - P.y, we[14]! - P.z];
          const row = (i: number, v: number[]) => Rr[i * 3]! * v[0]! + Rr[i * 3 + 1]! * v[1]! + Rr[i * 3 + 2]! * v[2]!;
          const G = [row(0, c0), row(0, c1), row(0, c3), row(1, c0), row(1, c1), row(1, c3), row(2, c0), row(2, c1), row(2, c3)];
          const zAt = (x: number, y: number) => G[6]! * x + G[7]! * y + G[8]!;
          if (Math.max(zAt(0, 0), zAt(e.size[0], 0), zAt(0, e.size[1]), zAt(e.size[0], e.size[1])) < 1) continue;
          const cx = S / 2 + fc.ox, cy = S / 2 + fc.oy;
          const Hm = [zoom * G[0]! + cx * G[6]!, zoom * G[1]! + cx * G[7]!, zoom * G[2]! + cx * G[8]!,
            zoom * G[3]! + cy * G[6]!, zoom * G[4]! + cy * G[7]!, zoom * G[5]! + cy * G[8]!, G[6]!, G[7]!, G[8]!];
          const C = it.owner;
          C.col = it.col; C.names = it.names;
          // (a cube face: only this face's cell — the depth pass clips nothing, so mask the other cells with a scissor)
          if (cube) { rt.scissor.set(fc.ox, fc.oy === 0 ? S : 0, S, S); rt.scissorTest = true; }
          C.drawLayer({ ...e, H: Hm, Hz: undefined }, songT, it.map, it.off, rt, it.opacityMul, undefined, null, undefined, flat);
          if (cube) rt.scissorTest = false;
          if (C !== this) C.col = null;
        }
      }
    } finally {
      this.shadowing = false;
    }
    return { tex: rt.texture, P: [P.x, P.y, P.z], R: faces[0]!.R, zoom, size: S, darkness: Math.min(1, Math.max(0, L.shadowDarkness ?? 1)), soft: Math.max(0, L.shadowDiffusion ?? 0), cube };
  }

  /** The lighting for a 3D layer drawn from a buffer padded by `pad` (none: no lights, a 2D or corner-pinned layer, or opted out). */
  private lightFor(e: Eval, pad: number): Lighting | undefined {
    const L = this.R.lit, l = e.l;
    if (!L || !(l.threeD || this.col) || l.cornerPin || l.material?.acceptsLights === false) return undefined;
    const Wm = (this.col ? this.col.pre.clone().multiply(e.world) : e.world.clone()).multiply(new THREE.Matrix4().makeTranslation(-pad, -pad, 0));
    const m = l.material ?? {};
    return { world: Wm.elements, cam: L.cam, ambient: L.ambient, lights: L.lights, shadows: L.shadows,
      material: [m.ambient ?? 1, m.diffuse ?? 1, m.specular ?? 0, m.shininess ?? 0.3], acceptsShadows: m.acceptsShadows !== false };
  }

  private occTarget(): THREE.WebGLRenderTarget {
    if (this.occ) return this.occ.rt;
    const r = this.host.renderer, out = this.curOut!;
    if (!this.occRT || this.occRT.width !== out.width || this.occRT.height !== out.height) {
      this.occRT?.dispose();
      this.occRT = new THREE.WebGLRenderTarget(out.width, out.height, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
    }
    this.occClear ??= new FSPass(/* glsl */ `void main() { fragColor = vec4(1e20); }`, {}, { blending: THREE.NoBlending });
    this.occClear.render(r, this.occRT);
    this.occ = { rt: this.occRT, n: 0 };
    return this.occRT;
  }

  /** Fold a three layer's depth texture into this render's occluder: linear depth in comp px, nearest wins. */
  private addOccluder(dt: THREE.Texture, near: number, far: number) {
    const r = this.host.renderer;
    const target = this.occTarget();
    if (!this.occPass) {
      this.occPass = new FSPass(/* glsl */ `
        uniform highp sampler2D tD; uniform float near, far, ppm;
        void main() {
          float d = texture(tD, vUv).r;
          float z = d >= 1.0 ? 1e20 : (2.0 * near * far) / (far + near - (d * 2.0 - 1.0) * (far - near));
          fragColor = vec4(d >= 1.0 ? 1e20 : z * ppm, 0.0, 0.0, 1.0);
        }`, { tD: { value: null }, near: { value: 0.05 }, far: { value: 2000 }, ppm: { value: 100 } }, { blending: THREE.CustomBlending });
      const m = this.occPass.mat;
      m.blendEquation = THREE.MinEquation; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneFactor;
      m.blendEquationAlpha = THREE.MinEquation; m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneFactor;
    }
    const u = this.occPass.u;
    u.tD!.value = dt; u.near!.value = near; u.far!.value = far; u.ppm!.value = this.space.ppm;
    this.occPass.render(r, target);
    this.occ!.n++;
  }

  /**
   * How much to scale a layer placed at depth z so it shows as big as at z = 0 (at comp point `at`, default the centre)
   * through the comp camera at comp time t: push layers back for parallax without them shrinking.
   */
  depthScale(z: number, t = 0, at: Vec = [this.w / 2, this.h / 2]): number {
    const cam = ev(this.o.camera, t, {} as Camera);
    const a = projectComp(cam, this.w, this.h, [at[0] ?? 0, at[1] ?? 0, z]), b = projectComp(cam, this.w, this.h, [at[0] ?? 0, at[1] ?? 0, 0]);
    return a && b ? a.z / b.z : 1;
  }

  /** A nested comp's clock: the parent layer's (motion blur, fps, echo offset) at song time s. */
  private mapClock(l: Layer, s: number, map: (s: number) => number, off: number) {
    if (l.fps && l.fps > 0) {
      const t0 = l.in ?? 0, tf = map(s) + off;
      return t0 + Math.floor((tf - t0) * l.fps + 1e-6) / l.fps;
    }
    return map(s) + off;
  }

  /** The layer's masks as a straight-alpha canvas texture of the buffer's size (white = keep). */
  private maskTexture(key: string, masks: readonly Mask[], t: number, bw: number, bh: number, pad: number, pxs: number) {
    const mc = this.canvas(`${key}#mask`, bw, bh, pxs), tc = this.canvas(`${key}#masktmp`, bw, bh, pxs);
    const c = mc.ctx;
    mc.clear();
    const first = masks[0]?.mode ?? 'add';
    if (first === 'subtract' || first === 'intersect') { c.fillStyle = '#fff'; c.fillRect(0, 0, bw, bh); }
    for (const m of masks) {
      const path = toPath2D(ev(m.path, t, '' as Path | Path2D | string));
      const x = tc.ctx;
      tc.clear();
      x.save(); x.translate(pad, pad);
      x.fillStyle = '#fff'; x.strokeStyle = '#fff'; x.lineJoin = 'round';
      const ex = ev(m.expansion, t, 0);
      x.fill(path);
      if (ex > 0) { x.lineWidth = 2 * ex; x.stroke(path); }
      if (ex < 0) { x.globalCompositeOperation = 'destination-out'; x.lineWidth = -2 * ex; x.stroke(path); x.globalCompositeOperation = 'source-over'; }
      x.restore();
      if (m.invert) {
        x.globalCompositeOperation = 'xor'; x.fillStyle = '#fff'; x.fillRect(0, 0, bw, bh); x.globalCompositeOperation = 'source-over';
      }
      const mode = m.mode ?? 'add';
      c.save();
      c.globalAlpha = Math.max(0, Math.min(1, ev(m.opacity, t, 1)));
      c.globalCompositeOperation = mode === 'subtract' ? 'destination-out' : mode === 'intersect' ? 'destination-in' : mode === 'difference' ? 'xor' : 'source-over';
      const f = ev(m.feather, t, 0);
      if (f > 0) c.filter = `blur(${f / 2}px)`;
      c.drawImage(tc.canvas, 0, 0, bw, bh);
      c.restore();
    }
    return mc.upload();
  }

  dispose() {
    for (const v of this.canvases.values()) v.layer.texture.dispose();
    this.canvases.clear();
    for (const v of this.cached.values()) v.rt.dispose();
    this.cached.clear();
    for (const v of this.threes.values()) { v.rt.dispose(); v.depthRT?.dispose(); }
    this.threes.clear();
    this.occRT?.dispose();
    for (const t of this.shadowRTs) t.dispose();
    this.own?.dispose();
    if (!this.o.fx) this.fx.dispose();
  }
}

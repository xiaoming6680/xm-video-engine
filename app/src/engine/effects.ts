// 图层效果（AE 的效果面板）：一张纹理进、一张纹理出，按顺序叠成效果栈。不替画面做决定：每个效果默认什么都不改，
// 参数给多少就做多少；什么时候用、用多重由这支片定。图层系统（engine/layers.ts）的 effects、时间线效果条（engine.ts 的
// TimelineEntry.effects）都走这里，场景里也能直接用：
//
//   fx = new Fx();
//   fx.run(renderer, src.texture, out, [                         // src、out 是渲染目标（预乘 alpha、线性 HDR），尺寸一样
//     { type: 'directionalBlur', angle: 0, length: 300 },        // 横向拉丝
//     { type: 'gradientMap', stops: ['#580420', '#c1a1ad'] },    // 按亮度映射成两色
//   ]);
//   // 数组里的 null / false / undefined 跳过：[hit && { type: 'invert' }, …]
//
// 单位：长度都是逻辑像素（和场景排版一样，4K 输出自动跟着放大）；角度是度，0 = 向右，顺时针为正（y 向下，和 Compositor 一样）。
// 颜色写 CSS 颜色（'#e4001c'、'rgb(…)'、颜色名），按 sRGB 理解。
//
// 颜色类效果在显示空间算（和 AE 默认、Photoshop 一样：中灰是「看起来的中灰」），超过 1 的高光余量会截掉；
// 模糊、发光、曝光、位移类在线性空间算，HDR 余量保留（泛光照样吃得到）。
//
// 效果一览（每项后面是参数和默认值；没写默认值的必填）：
//   模糊
//     blur             radius（标准差，逻辑 px，和 CSS blur()、textanim 的 blur 一样）、axis 'both' | 'x' | 'y'
//     directionalBlur  angle 0、length（拖影总长）、side 'both' | 'back'（只往 angle 的反方向拖，像拖尾）
//     radialBlur       kind 'zoom'（缩放，amount = 半径方向抹开的比例 0–1）| 'spin'（旋转，amount = 度）、center 图层中心
//   颜色（显示空间）
//     gradientMap      stops：颜色数组（均匀分布）或 [位置 0–1, 颜色] 数组，最多 8 个；amount 1。按亮度查颜色（AE 的 Tint、
//                      三色调、Photoshop 的渐变映射都是它：两个颜色就是 Tint）
//     fill             color、opacity 1（保留 alpha，整层换成一个颜色）
//     levels           inBlack 0、inWhite 1、gamma 1、outBlack 0、outWhite 1（0–1）
//     hueSat           hue 0（度）、saturation 0（−1 全灰 … +1 加倍）、lightness 0（−1 … 1）
//     invert           amount 1
//     threshold        level 0.5、soft 0（过渡带宽，0–1）
//     posterize        levels（每通道几档）
//     exposure         stops（线性 × 2^stops：+2 = 亮 4 倍，冲白、过曝帧用；HDR 保留）
//   风格化
//     mosaic           size（块边长，px，或 [w, h]）
//     glow             threshold 0.6（显示空间亮度）、radius 20、intensity 1、color（给了就把光染成这个颜色）、
//                      deep false（true = 一圈紧的核心加几层越来越宽、越来越淡的光，拖得远，像 Deep Glow）
//     halftone         size 8（网点间距 px）、angle 45、ink（不给 = 用原图颜色）、paper（不给 = 透明）、shape 'dot' | 'line'
//     noise            amount 0.1、seed 0（每帧换 seed 才会闪）、mono true、size 1（颗粒 px）
//   扭曲
//     transform        position [dx, dy]、scale（数或 [sx, sy]）、rotation（度）、anchor（默认中心）、opacity、edge（AE 的「变换」效果：
//                      在效果栈里挪内容，不动图层本身。一帧的震屏、冲一下、整幅错位都用它；效果条里就是整幅画面在动）
//     offset           shift [dx, dy]（内容平移，出去的从另一边绕回来：无缝滚动）
//     tile             extend（往外补多少 px）、mode 'mirror' | 'wrap' | 'clamp'（AE 的 Motion Tile：图层四周补出内容，甩镜不露边）
//     displace         amount 20、size 200（噪声尺度 px）、evolution 0（换它让形状流动）、seed 0、octaves 2（湍流置换）
//     wave             amplitude 10、wavelength 120、angle 0（波前进方向；位移垂直于它）、phase 0（周期数，0–1 一圈）
//     blockGlitch      amount 40（块最大横移 px）、block [0, 24]（块宽高，宽 0 = 整行）、density 0.3、seed 0、rgb 0（块里的色分离 px）
//     rgbSplit         offset [6, 0]（红 +offset、蓝 −offset、绿不动）
//   图层样式
//     dropShadow       color '#000'、opacity 1、offset [6, 6]、softness 0（0 = 硬边投影）、only false（只留影子）
//     stroke           color、width 4、position 'outside' | 'center' | 'inside'、opacity 1（沿 alpha 描边）
//   揭示
//     reveal           map（engine/arrival.ts 的 ArrivalMap：每个像素什么时候到，秒；或一张 R 通道存秒数的浮点纹理）、t（现在是第几秒，
//                      和 map 同一个钟）、soft 0（到了之后多少秒从透明变满，0 = 硬边）、invert false（反过来：到点的像素消失，擦掉、
//                      收回）、front（颜色：刚到的那一圈染成它，墨迹的湿边、光的前沿；不给 = 不染）、frontTime 0.1（那一圈多宽，秒）。
//                      map 按图层内容的范围铺满（和 padding 无关），取到范围外按最近的边算
//
//   下面这些（扭曲、转场、调色、图层样式、光）的点（center、position）都按图层像素给，不给 = 图层内容的中心；图层加了留边时
//   自动跟着挪（shiftEffect）。「图层内容」= 图层的 size 那块，不含为效果留的边；时间线效果条、调整层上就是整幅画面。
//   扭曲（AE 的 Distort）
//     bulge            amount（0.5 ≈ 中心放大 2 倍，负数往里吸）、center、radius（默认内容短边的一半；[rx, ry] 是椭圆）
//     spherize         amount 1（−1…1，负数往里收）、center、radius：球面化，边缘硬，像透过玻璃球
//     twirl            angle（度，顺时针为正，中心转得最多）、center、radius
//     ripple           amplitude 10、wavelength 60、phase 0（周期数，一直加 = 波往外走）、center、radius 0（0 = 整层都有，给了就往外衰减到 0）
//     polar            kind 'toPolar'（横向变角度、纵向变半径，顶边收到中心：直线卷成环）| 'toRect'（反过来）、amount 1（0–1 插值）。
//                      非正方形的图层是椭圆（和 AE 一样），要正圆就放在正方形的图层里
//     bend             amount（px，中间相对两头被推多远）、angle 90（推的方向；90 = 往下，中间下垂）：整层弯成弧
//     lensDistort      amount（> 0 桶形 / 鱼眼，< 0 枕形，约 −0.33…1）、center。边角会露空：配 edge 'clamp' / 'mirror' 或放大一点
//     meshWarp         grid：行数组，每行是这一行各顶点的 [dx, dy]（px），至少 2 × 2，顶点均匀铺满内容；顶点之间平滑插值（AE 的 Mesh Warp）。
//                      偏移不大时准；全 0 = 原样
//     displacementMap  map（纹理：渲染目标、图片、画布）、x 'r'、y 'g'（各用哪个通道：'r' 'g' 'b' 'a' 'luma'）、amount 20（px 或 [x, y]）。
//                      中灰不动，白往正方向、黑往负方向推满 amount；map 铺满内容
//     puppet           pins：[{ at: 原位, to: 现在的位置 }]（AE 的操控点）、mesh 12（网格 px，越小越细越慢）、id（网格缓存名：
//                      图层内容的形状变了就换一个）、iterations 8。按 alpha 铺网格（分开的部分各自一块），尽量只转不拉伸
//                      （ARAP，engine/puppet.ts）；没钉子的那块不动
//     shatter          time（冲击后多少秒，≤ 0 完整）、pattern 'glass' | 'radial' | 'bricks' | 'squares' | 'triangles'、pieces 80、
//                      center（冲击点）、radius（这么远以外不碎；不给 = 全碎）、strength 900（px/s）、pop 0.4（往镜头飞的比例）、
//                      gravity 1500（px/s²，往下）、spin 360（度/秒）、front 0（裂纹传播速度 px/s，0 = 一起碎）、depth 6（厚度 px）、seed 0、
//                      perspective 1600、light 0.6、sideColor（侧面颜色；不给 = 本色压暗）、pad（碎片能飞出图层多远，默认图层长边的一半，
//                      最多 1200）。engine/shatter.ts
//   转场（AE 的 Transition；completion 0 = 完整、1 = 全没了，和 AE 一样）
//     linearWipe       completion、angle 0（擦的方向：0 = 从左往右擦掉）、feather 0（px）
//     radialWipe       completion、start −90（从 12 点开始）、direction 'cw' | 'ccw' | 'both'、center、feather 0（px）
//     irisWipe         completion、sides 0（0 = 圆，≥ 3 = 正多边形）、rotation −90（第一个角朝上）、center、feather 0、
//                      invert false（true = 中间先开洞往外扩）
//     venetianBlinds   completion、angle 0（条纹推进的方向）、width 40（px）、feather 0
//     blockDissolve    completion、block 16（px 或 [w, h]）、soft 0（0–1，块慢慢淡）、seed 0
//     gradientWipe     completion、map（纹理；不给 = 用这一层自己的亮度）、soft 0、invert false：暗的先没
//     pageTurn         completion（0 平、1 整页翻走）或 fold（折线上的一点，CC Page Turn 的 Fold Position）、angle 45（往哪个方向翻起：
//                      45 = 右下角先起）、radius 60（卷曲半径 px）、back（背面纹理；不给 = backColor '#f4f1ea'）、backOpacity 1
//                      （< 1 透出正面）、shadow 0.5、light 0.6
//     cardWipe         completion、rows 6、columns 10、axis 'y'（绕竖轴翻）| 'x'、flip 1 | −1、angle 0（翻的先后方向）、width 0.5
//                      （同时在翻的范围）、random 0、seed、perspective 1600、jitter 0（翻时往镜头凸出 px）、back（背面纹理；不给 = 透明）、light 0.5
//   调色（显示空间）
//     curves           rgb、r、g、b、a：各一条 [[入, 出], …]（0–1），没给的通道不变；两端默认 [0, 0]、[1, 1]，点之间单调平滑（不过冲）。
//                      先按单通道再按 rgb 总曲线。S 形加对比：rgb: [[0.25, 0.18], [0.75, 0.82]]
//     colorBalance     shadows、midtones、highlights：各 [r, g, b]，−1…1（1 ≈ 那一段推 0.5）、preserveLuminosity false
//     brightnessContrast  brightness 0（加到显示值上，0.1 = 亮一成）、contrast 0（−1…1，以中灰为轴）
//     leaveColor       color、tolerance 0.06（色相差，0–0.5）、soft 0.04、amount 1：只留这个颜色，其余去色（灰的也去）
//   图层样式（按 alpha 算，默认值照 Photoshop 的图层样式）
//     innerShadow      color '#000'、opacity 0.75、offset [6, 6]、softness 0
//     innerGlow        color '#fff'、size 10（px，从边往里）、opacity 0.75
//     outerGlow        color '#fff'、size 20、opacity 0.75、spread 0（0–1，越大边越硬）
//     bevel            size 10、depth 1、light −135（光从哪来：−135 = 左上）、altitude 30（度）、highlight '#fff'、highlightOpacity 0.75、
//                      shadow '#000'、shadowOpacity 0.75：内斜面
//     gradientOverlay  stops（同 gradientMap）、angle 90（第一个颜色在哪头：90 = 上→下）、kind 'linear' | 'radial'、scale 1、opacity 1、
//                      mode 'normal' | 'multiply' | 'screen' | 'overlay'
//   抠像（AE 的 Keying / Matte；给素材层用，配 tools/roto.py 的蒙版、tools/track.py 的跟踪）
//     chromaKey        color '#00b140'（幕布颜色）、tolerance 0.3（色度差，相对幕布自身的色度：0 = 只抠正好这个色）、soft 0.2、
//                      despill 1（压掉边上和反光里的幕布色）、clipBlack 0 / clipWhite 1（蒙版的黑白点，收紧半透明）
//     lumaKey          level 0.1、soft 0.1、invert false：暗的变透明（黑底的火、光效素材）；invert 让亮的透明
//     matteChoke       amount（px，> 0 往里收、< 0 往外扩）、soft 0（px，边软）：收紧或放松 alpha 的边（AE 的 Simple Choker）
//   光（叠加的光，透明处也会亮；光晕、漏光铺满这层的范围，所以一般放在调整层或时间线效果条上）
//     lightRays        center（光源）、length 0.3（0–0.9，往外拖多远）、intensity 1、threshold 0（只让亮过它的地方出光）、color（染色）：
//                      CC Light Rays / Shine。光会拖出图层外，留边按图层尺寸自动给
//     lensFlare        position（光源，必填）、brightness 1、color '#ffd8a8'、size 1（相对内容对角线）、center（光轴中心，鬼影沿光源→中心排）、
//                      streak 0.5（横向变形光条）、rays 6（星芒条数，0 = 不要）、ghosts 1（鬼影和光环的强度）
//     lightLeak        colors（同 stops，默认橙粉黄）、amount 1、evolution 0（一直加 = 光斑流动）、seed 0、angle −30（光从哪边漏进来）、size 1
//   自己写
//     custom           frag：定义 vec4 effect(vec2 uv, vec2 p)（uv 0–1，p 逻辑 px、y 向下），用 samp(uv) 取原图（预乘线性）；
//                      uniforms：{ 名字: 数 | [2–4 个数] | 纹理 }，自动声明
//   时间类效果（Posterize Time、Echo）属于图层：layers.ts 的 fps、echo。
//
// 边缘：取到图层外面时默认是透明（edge 'none'）；整幅画面的调整（时间线效果条、调整层）默认 'clamp'（重复边缘像素，AE 的
// 「重复边缘像素」），所以整幅模糊不会把四边糊黑。run() 的 o.edge 可改；offset 自己固定绕回，tile 按自己的 mode。
//
// 性能：每个效果一到几个全屏 pass；临时渲染目标按尺寸复用（Fx 自己的池）。模糊按半径自动选步长，大半径不会变慢很多。
import * as THREE from 'three';
import { FSPass, SCALE, rtScale, setRtScale } from './gl';
import type { ArrivalMap } from './arrival';
import { Shatter, type ShatterPattern } from './shatter';
import { Puppet, type PuppetPin } from './puppet';

type V2 = [number, number];
type V3 = [number, number, number];
type Col = string;
/** Gradient stops: colours spread evenly, or [position 0–1, colour] pairs (at most 8). */
type Stops = readonly (Col | readonly [number, Col])[];
/** A curve: [in, out] points, 0–1 (display values). The ends default to [0, 0] and [1, 1]. */
type Curve = readonly (readonly [number, number])[];
/** Which part of a map pixel drives the effect. */
type Chan = 'r' | 'g' | 'b' | 'a' | 'luma';

export type Effect =
  | { type: 'blur'; radius: number; axis?: 'both' | 'x' | 'y' }
  | { type: 'directionalBlur'; angle?: number; length: number; side?: 'both' | 'back' }
  | { type: 'radialBlur'; kind?: 'zoom' | 'spin'; amount: number; center?: V2 }
  | { type: 'gradientMap'; stops: readonly (Col | readonly [number, Col])[]; amount?: number }
  | { type: 'fill'; color: Col; opacity?: number }
  | { type: 'levels'; inBlack?: number; inWhite?: number; gamma?: number; outBlack?: number; outWhite?: number }
  | { type: 'hueSat'; hue?: number; saturation?: number; lightness?: number }
  | { type: 'invert'; amount?: number }
  | { type: 'threshold'; level?: number; soft?: number }
  | { type: 'posterize'; levels: number }
  | { type: 'exposure'; stops: number }
  | { type: 'mosaic'; size: number | V2 }
  | { type: 'glow'; threshold?: number; radius?: number; intensity?: number; color?: Col; deep?: boolean }
  | { type: 'halftone'; size?: number; angle?: number; ink?: Col; paper?: Col; shape?: 'dot' | 'line' }
  | { type: 'noise'; amount?: number; seed?: number; mono?: boolean; size?: number }
  | { type: 'transform'; position?: V2; scale?: number | V2; rotation?: number; anchor?: V2; opacity?: number; edge?: Edge }
  | { type: 'offset'; shift: V2 }
  | { type: 'tile'; extend: number; mode?: 'mirror' | 'wrap' | 'clamp' }
  | { type: 'displace'; amount?: number; size?: number; evolution?: number; seed?: number; octaves?: number }
  | { type: 'wave'; amplitude?: number; wavelength?: number; angle?: number; phase?: number }
  | { type: 'blockGlitch'; amount?: number; block?: V2; density?: number; seed?: number; rgb?: number }
  | { type: 'rgbSplit'; offset?: V2 }
  | { type: 'dropShadow'; color?: Col; opacity?: number; offset?: V2; softness?: number; only?: boolean }
  | { type: 'stroke'; color: Col; width?: number; position?: 'outside' | 'center' | 'inside'; opacity?: number }
  | { type: 'reveal'; map: ArrivalMap | THREE.Texture; t: number; soft?: number; invert?: boolean; front?: Col; frontTime?: number }
  // distort
  | { type: 'bulge'; amount: number; center?: V2; radius?: number | V2 }
  | { type: 'spherize'; amount?: number; center?: V2; radius?: number }
  | { type: 'twirl'; angle: number; center?: V2; radius?: number }
  | { type: 'ripple'; amplitude?: number; wavelength?: number; phase?: number; center?: V2; radius?: number }
  | { type: 'polar'; kind?: 'toPolar' | 'toRect'; amount?: number }
  | { type: 'bend'; amount: number; angle?: number }
  | { type: 'lensDistort'; amount: number; center?: V2 }
  | { type: 'meshWarp'; grid: readonly (readonly V2[])[] }
  | { type: 'displacementMap'; map: THREE.Texture; x?: Chan; y?: Chan; amount?: number | V2 }
  | { type: 'puppet'; pins: readonly PuppetPin[]; mesh?: number; id?: string; iterations?: number }
  | { type: 'shatter'; time: number; pattern?: ShatterPattern; pieces?: number; center?: V2; radius?: number; strength?: number; pop?: number; gravity?: number; spin?: number; front?: number; depth?: number; seed?: number; perspective?: number; light?: number; sideColor?: Col; pad?: number }
  // transitions (completion 0 = all there, 1 = gone, like AE)
  | { type: 'linearWipe'; completion: number; angle?: number; feather?: number }
  | { type: 'radialWipe'; completion: number; start?: number; center?: V2; direction?: 'cw' | 'ccw' | 'both'; feather?: number }
  | { type: 'irisWipe'; completion: number; center?: V2; sides?: number; rotation?: number; feather?: number; invert?: boolean }
  | { type: 'venetianBlinds'; completion: number; angle?: number; width?: number; feather?: number }
  | { type: 'blockDissolve'; completion: number; block?: number | V2; soft?: number; seed?: number }
  | { type: 'gradientWipe'; completion: number; map?: THREE.Texture; soft?: number; invert?: boolean }
  | { type: 'pageTurn'; completion?: number; fold?: V2; angle?: number; radius?: number; back?: THREE.Texture; backColor?: Col; backOpacity?: number; shadow?: number; light?: number }
  | { type: 'cardWipe'; completion: number; rows?: number; columns?: number; axis?: 'x' | 'y'; flip?: 1 | -1; angle?: number; width?: number; random?: number; seed?: number; perspective?: number; jitter?: number; back?: THREE.Texture; light?: number }
  // colour
  | { type: 'curves'; rgb?: Curve; r?: Curve; g?: Curve; b?: Curve; a?: Curve }
  | { type: 'colorBalance'; shadows?: V3; midtones?: V3; highlights?: V3; preserveLuminosity?: boolean }
  | { type: 'brightnessContrast'; brightness?: number; contrast?: number }
  | { type: 'leaveColor'; color: Col; tolerance?: number; soft?: number; amount?: number }
  // layer styles
  | { type: 'innerShadow'; color?: Col; opacity?: number; offset?: V2; softness?: number }
  | { type: 'innerGlow'; color?: Col; size?: number; opacity?: number }
  | { type: 'outerGlow'; color?: Col; size?: number; opacity?: number; spread?: number }
  | { type: 'bevel'; size?: number; depth?: number; light?: number; altitude?: number; highlight?: Col; highlightOpacity?: number; shadow?: Col; shadowOpacity?: number }
  | { type: 'gradientOverlay'; stops: Stops; angle?: number; kind?: 'linear' | 'radial'; scale?: number; opacity?: number; mode?: 'normal' | 'multiply' | 'screen' | 'overlay' }
  // keying
  | { type: 'chromaKey'; color?: Col; tolerance?: number; soft?: number; despill?: number; clipBlack?: number; clipWhite?: number }
  | { type: 'lumaKey'; level?: number; soft?: number; invert?: boolean }
  | { type: 'matteChoke'; amount: number; soft?: number }
  // light
  | { type: 'lightRays'; center?: V2; length?: number; intensity?: number; threshold?: number; color?: Col }
  | { type: 'lensFlare'; position: V2; brightness?: number; color?: Col; size?: number; center?: V2; streak?: number; rays?: number; ghosts?: number }
  | { type: 'lightLeak'; colors?: Stops; amount?: number; evolution?: number; seed?: number; angle?: number; size?: number }
  | { type: 'custom'; frag: string; uniforms?: Record<string, number | readonly number[] | THREE.Texture> };

/** An effect list as scenes write it: falsy entries are skipped. */
export type EffectList = readonly (Effect | null | false | undefined | 0 | '')[];

export type Edge = 'none' | 'clamp' | 'wrap' | 'mirror';
const EDGES: readonly Edge[] = ['none', 'clamp', 'wrap', 'mirror'];

/**
 * How far (logical px) an effect can move content outside its input: the padding a layer needs not to clip it.
 * `size`: the layer's content size, for the effects whose reach scales with it (light rays, lens distortion).
 */
export function effectPad(e: Effect, size?: readonly [number, number]): number {
  const half = size ? Math.hypot(size[0], size[1]) / 2 : 0;
  switch (e.type) {
    case 'blur': return 3 * Math.max(0, e.radius);
    case 'directionalBlur': return (e.side === 'back' ? 1 : 0.5) * Math.abs(e.length);
    case 'glow': return 3 * (e.radius ?? 20);
    case 'outerGlow': return 1.5 * Math.max(0, e.size ?? 20);
    case 'matteChoke': return Math.max(0, -e.amount) + Math.max(0, e.soft ?? 0);
    case 'ripple': return Math.abs(e.amplitude ?? 10);
    case 'bend': return Math.abs(e.amount);
    case 'meshWarp': return Math.max(0, ...e.grid.flat().map((v) => Math.hypot(v[0], v[1])));
    case 'displacementMap': { const a = e.amount ?? 20; return typeof a === 'number' ? Math.abs(a) * Math.SQRT2 : Math.hypot(a[0], a[1]); }
    case 'lensDistort': return e.amount < 0 ? half * Math.min(1, -e.amount) : 0;
    case 'lightRays': { const L = Math.min(0.9, Math.max(0, e.length ?? 0.3)); return half * Math.min(2, L / (1 - L)); }
    case 'puppet': return Math.max(0, ...e.pins.map((p) => Math.hypot(p.to[0] - p.at[0], p.to[1] - p.at[1]))) + 2 * (e.mesh ?? 12);
    case 'shatter': return e.pad ?? (size ? Math.min(1200, 0.5 * Math.max(size[0], size[1])) : 600);
    case 'dropShadow': return Math.hypot(...(e.offset ?? [6, 6])) + 3 * (e.softness ?? 0);
    case 'stroke': return e.position === 'inside' ? 0 : (e.position === 'center' ? 0.5 : 1) * (e.width ?? 4);
    case 'displace': return Math.abs(e.amount ?? 20);
    case 'wave': return Math.abs(e.amplitude ?? 10);
    case 'blockGlitch': return Math.abs(e.amount ?? 40) + Math.abs(e.rgb ?? 0);
    case 'rgbSplit': return Math.hypot(...(e.offset ?? [6, 0]));
    case 'tile': return Math.max(0, e.extend);
    case 'transform': return Math.hypot(...(e.position ?? [0, 0]));
    default: return 0;
  }
}

// the params that are points in layer px (transform.position is an offset, not a point)
const POINTS: Partial<Record<Effect['type'], readonly string[]>> = {
  radialBlur: ['center'], transform: ['anchor'], bulge: ['center'], spherize: ['center'], twirl: ['center'], ripple: ['center'],
  lensDistort: ['center'], radialWipe: ['center'], irisWipe: ['center'], lightRays: ['center'], lensFlare: ['position', 'center'], pageTurn: ['fold'], shatter: ['center'],
};
/** The effect with its points moved by (dx, dy): what a layer does when it pads its content into a bigger buffer. */
export function shiftEffect(e: Effect, dx: number, dy: number): Effect {
  if (e.type === 'puppet') return { ...e, pins: e.pins.map((p) => ({ at: [p.at[0] + dx, p.at[1] + dy] as V2, to: [p.to[0] + dx, p.to[1] + dy] as V2 })) };
  const ks = POINTS[e.type];
  if (!ks) return e;
  const o: Record<string, unknown> = { ...e };
  for (const k of ks) { const p = o[k] as V2 | undefined; if (p) o[k] = [p[0] + dx, p[1] + dy]; }
  return o as Effect;
}

const tmpColor = new THREE.Color();
/** CSS colour → sRGB 0..1 (alpha ignored). */
export function srgb(css: string): [number, number, number] {
  tmpColor.setStyle(css);
  const o = { r: 0, g: 0, b: 0 };
  tmpColor.getRGB(o, THREE.SRGBColorSpace);
  return [o.r, o.g, o.b];
}
/** CSS colour → linear rgb (what Compositor's tint and clearRT take). */
export function linear(css: string): [number, number, number] {
  tmpColor.setStyle(css);
  return [tmpColor.r, tmpColor.g, tmpColor.b];
}

// ---- shaders ---------------------------------------------------------------------------------------------------------
// Every pass: src (premultiplied linear), size (physical px), pxs (physical px per logical px), edge, inner (the content
// rect in uv, for tile / clamp / wrap / mirror). fragLP() = this fragment in logical px (y down); duv(d) = the uv offset
// of a logical-px vector (y down).
const HEAD = /* glsl */ `
  uniform sampler2D src; uniform vec2 size; uniform float pxs; uniform int edge; uniform vec4 inner;
  vec2 fragLP() { return vec2(vUv.x, 1.0 - vUv.y) * size / pxs; }
  vec2 duv(vec2 d) { return vec2(d.x, -d.y) * pxs / size; }
  vec4 samp(vec2 uv) {
    if (edge == 2) uv = inner.xy + mod(uv - inner.xy, inner.zw);
    else if (edge == 3) { vec2 q = (uv - inner.xy) / inner.zw; q = 1.0 - abs(1.0 - mod(q, 2.0)); uv = inner.xy + q * inner.zw; }
    else if (edge == 1) uv = clamp(uv, inner.xy, inner.xy + inner.zw);
    else if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0);
    return texture(src, uv);
  }
  vec3 unpm(vec4 c) { return c.a > 1e-5 ? c.rgb / c.a : vec3(0.0); }
  // straight display-space colour of a premultiplied linear sample, and back
  vec3 disp(vec4 c) { return toSRGB(clamp(unpm(c), 0.0, 1.0)); }
  vec4 fromDisp(vec3 d, float a) { return vec4(toLinear(clamp(d, 0.0, 1.0)) * a, a); }
  float lumD(vec3 d) { return dot(d, vec3(0.2126, 0.7152, 0.0722)); }
  // logical px (y down) → uv, and a sample there
  vec2 lp2uv(vec2 p) { return vec2(p.x, size.y / pxs - p.y) * pxs / size; }
  vec4 sampLP(vec2 p) { return samp(lp2uv(p)); }
  // the content rect (inside the padding) in logical px: x, y (top), w, h; and a point's place in it, 0–1 (y down)
  vec4 rectLP() { vec2 L = size / pxs; return vec4(inner.x * L.x, (1.0 - inner.y - inner.w) * L.y, inner.z * L.x, inner.w * L.y); }
  vec2 inRect(vec2 p) { vec4 R = rectLP(); return clamp((p - R.xy) / R.zw, 0.0, 1.0); }
  vec3 rgb2hsl(vec3 c) { float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b), l = (mx + mn) * 0.5, d = mx - mn;
    if (d < 1e-5) return vec3(0.0, 0.0, l);
    float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn), h;
    if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0); else if (mx == c.g) h = (c.b - c.r) / d + 2.0; else h = (c.r - c.g) / d + 4.0;
    return vec3(h / 6.0, s, l); }
  vec3 hsl2rgb(vec3 h) { vec3 k = clamp(abs(mod(h.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    return h.z + h.y * (k - 0.5) * (1.0 - abs(2.0 * h.z - 1.0)); }
  // a map texture's display value at uv (render targets hold premultiplied linear; images and canvases hold display values)
  vec3 mapDisp(sampler2D m, vec2 uv, bool lin) { vec4 c = texture(m, uv); return lin ? toSRGB(clamp(unpm(c), 0.0, 1.0)) : c.rgb; }
`;

// a gradient lookup over uniforms cols / pos / ns (display colours), for the passes that declare them
const RAMP = /* glsl */ `
  uniform vec3 cols[8]; uniform float pos[8]; uniform int ns;
  vec3 ramp(float l) {
    if (l <= pos[0]) return cols[0];
    vec3 m = cols[0];
    for (int i = 1; i < 8; i++) { if (i >= ns) break;
      if (l >= pos[i]) { m = cols[i]; continue; }
      return mix(cols[i - 1], cols[i], clamp((l - pos[i - 1]) / max(pos[i] - pos[i - 1], 1e-5), 0.0, 1.0)); }
    return m;
  }
`;

const FRAGS: Record<string, string> = {
  copy: `void main() { fragColor = samp(vUv); }`,
  // gaussian along `dir` (uv per tap), n taps each side, sigma in taps
  gauss: `uniform vec2 dir; uniform int n; uniform float sig;
    void main() {
      vec4 s = samp(vUv); float ws = 1.0;
      for (int i = 1; i <= 64; i++) { if (i > n) break; float w = exp(-0.5 * float(i * i) / (sig * sig));
        s += w * (samp(vUv + dir * float(i)) + samp(vUv - dir * float(i))); ws += 2.0 * w; }
      fragColor = s / ws;
    }`,
  // box along the segment a..b (uv offsets)
  line: `uniform vec2 a; uniform vec2 b; uniform int n;
    void main() {
      vec4 s = vec4(0.0);
      for (int i = 0; i < 64; i++) { if (i >= n) break; s += samp(vUv + mix(a, b, (float(i) + 0.5) / float(n))); }
      fragColor = s / float(n);
    }`,
  // zoom: scale about c by exp(k·u), u across [-0.5, 0.5]; spin: rotate about c by ang·u (in px, aspect-correct)
  radial: `uniform vec2 c; uniform float k; uniform int n; uniform int spin;
    void main() {
      vec4 s = vec4(0.0);
      vec2 d = (vUv - c) * size;
      for (int i = 0; i < 64; i++) { if (i >= n) break; float u = (float(i) + 0.5) / float(n) - 0.5;
        vec2 q;
        if (spin == 1) { float a = k * u, cs = cos(a), sn = sin(a); q = vec2(cs * d.x - sn * d.y, sn * d.x + cs * d.y); }
        else q = d * exp(k * u);
        s += samp(c + q / size); }
      fragColor = s / float(n);
    }`,
  gradientMap: `uniform vec3 cols[8]; uniform float pos[8]; uniform int ns; uniform float amount;
    void main() {
      vec4 c = samp(vUv);
      if (c.a <= 1e-5) { fragColor = c; return; }
      vec3 d = disp(c); float l = lumD(d);
      vec3 m = cols[0];
      for (int i = 1; i < 8; i++) { if (i >= ns) break;
        if (l >= pos[i]) { m = cols[i]; continue; }
        m = mix(cols[i - 1], cols[i], clamp((l - pos[i - 1]) / max(pos[i] - pos[i - 1], 1e-5), 0.0, 1.0)); break; }
      if (l < pos[0]) m = cols[0];
      fragColor = fromDisp(mix(d, m, amount), c.a);
    }`,
  fill: `uniform vec3 col; uniform float amount;
    void main() { vec4 c = samp(vUv); fragColor = vec4(mix(c.rgb, toLinear(col) * c.a, amount), c.a); }`,
  levels: `uniform float ib, iw, gm, ob, ow;
    void main() {
      vec4 c = samp(vUv); if (c.a <= 1e-5) { fragColor = c; return; }
      vec3 v = clamp((disp(c) - ib) / max(iw - ib, 1e-5), 0.0, 1.0);
      fragColor = fromDisp(mix(vec3(ob), vec3(ow), pow(v, vec3(1.0 / max(gm, 1e-3)))), c.a);
    }`,
  hueSat: `uniform float hue, hsSat, lig;   // (not 'sat': GLSL_COMMON has a sat() function)
    void main() {
      vec4 c = samp(vUv); if (c.a <= 1e-5) { fragColor = c; return; }
      vec3 h = rgb2hsl(disp(c));
      h.x = fract(h.x + hue / 360.0); h.y = clamp(h.y * (1.0 + hsSat), 0.0, 1.0);
      vec3 r = hsl2rgb(h);
      r = lig >= 0.0 ? mix(r, vec3(1.0), lig) : r * (1.0 + lig);
      fragColor = fromDisp(r, c.a);
    }`,
  invert: `uniform float amount;
    void main() { vec4 c = samp(vUv); if (c.a <= 1e-5) { fragColor = c; return; } vec3 d = disp(c); fragColor = fromDisp(mix(d, 1.0 - d, amount), c.a); }`,
  threshold: `uniform float level, soft;
    void main() { vec4 c = samp(vUv); if (c.a <= 1e-5) { fragColor = c; return; }
      float l = lumD(disp(c)), v = soft > 0.0 ? smoothstep(level - soft * 0.5, level + soft * 0.5, l) : step(level, l);
      fragColor = fromDisp(vec3(v), c.a); }`,
  posterize: `uniform float levels;
    void main() { vec4 c = samp(vUv); if (c.a <= 1e-5) { fragColor = c; return; }
      float n = max(levels, 2.0) - 1.0; fragColor = fromDisp(floor(disp(c) * n + 0.5) / n, c.a); }`,
  exposure: `uniform float k; void main() { vec4 c = samp(vUv); fragColor = vec4(c.rgb * k, c.a); }`,
  mosaic: `uniform vec2 cell;
    void main() { vec2 p = fragLP(), q = (floor(p / cell) + 0.5) * cell;
      fragColor = samp(vec2(q.x, size.y / pxs - q.y) * pxs / size); }`,
  // glow: the bright part, premultiplied (blurred and added back by the caller's passes)
  bright: `uniform float th; uniform vec3 tintc; uniform bool useTint;
    void main() { vec4 c = samp(vUv); if (c.a <= 1e-5) { fragColor = vec4(0.0); return; }
      float l = lumD(disp(c)), m = smoothstep(th - 0.1, th + 0.1, l);
      vec3 rgb = useTint ? toLinear(tintc) * max(max(c.r, c.g), c.b) : c.rgb;
      fragColor = vec4(rgb * m, 0.0); }`,
  // a + b·k (b's alpha too, so the glow shows over transparent parts)
  addTex: `uniform sampler2D b; uniform float k; uniform bool alphaFromRgb;
    void main() { vec4 x = samp(vUv), y = texture(b, vUv) * k;
      float ya = alphaFromRgb ? clamp(max(max(y.r, y.g), y.b), 0.0, 1.0) : y.a;
      fragColor = vec4(x.rgb + y.rgb, max(x.a, min(1.0, x.a + ya))); }`,
  halftone: `uniform float cellS, ang; uniform vec3 ink; uniform bool useInk; uniform vec3 paper; uniform bool usePaper; uniform int line;
    void main() {
      vec2 p = fragLP(); float cs = cos(ang), sn = sin(ang);
      mat2 R = mat2(cs, sn, -sn, cs), Ri = mat2(cs, -sn, sn, cs);
      vec2 q = Ri * p, cc = (floor(q / cellS) + 0.5) * cellS, cp = R * cc;
      vec4 c = samp(vec2(cp.x, size.y / pxs - cp.y) * pxs / size), here = samp(vUv);
      float dark = 1.0 - lumD(disp(c));
      float cov;
      if (line == 1) { float w = dark * cellS * 0.5, d = abs(q.y - cc.y); cov = clamp((w - d) * pxs + 0.5, 0.0, 1.0); }
      else { float r = sqrt(dark) * cellS * 0.7071, d = length(q - cc); cov = clamp((r - d) * pxs + 0.5, 0.0, 1.0); }
      cov *= c.a > 1e-5 ? 1.0 : 0.0;
      vec3 inkD = useInk ? ink : disp(c);
      if (usePaper) fragColor = fromDisp(mix(paper, inkD, cov), here.a);
      else { float a = cov * here.a; fragColor = vec4(toLinear(inkD) * a, a); }
    }`,
  noise: `uniform float amount, seed, grain; uniform bool mono;
    void main() { vec4 c = samp(vUv); if (c.a <= 1e-5) { fragColor = c; return; }
      vec2 g = floor(fragLP() / grain);
      vec3 n = mono ? vec3(hash13(vec3(g, seed))) : hash33(vec3(g, seed));
      fragColor = fromDisp(disp(c) + (n - 0.5) * amount, c.a); }`,
  displace: `uniform float amount, scl, evo, seed; uniform int oct;
    void main() { vec2 p = fragLP() / scl + seed * 13.1;
      vec2 n = vec2(fbm(vec3(p, evo), oct), fbm(vec3(p + 41.7, evo + 7.3), oct));
      fragColor = samp(vUv + duv(n * amount)); }`,
  wave: `uniform float amp, wl, ang, ph;
    void main() { vec2 dir = vec2(cos(ang), sin(ang)), perp = vec2(-dir.y, dir.x);
      float s = sin(6.2831853 * (dot(fragLP(), dir) / wl - ph));
      fragColor = samp(vUv + duv(perp * amp * s)); }`,
  blockGlitch: `uniform float amount, density, seed, rgb; uniform vec2 blk;
    void main() { vec2 p = fragLP();
      vec2 cell = vec2(blk.x > 0.0 ? floor(p.x / blk.x) : 0.0, floor(p.y / max(blk.y, 1.0)));
      float on = step(hash13(vec3(cell, seed)), density);
      float dx = (hash13(vec3(cell, seed + 17.0)) * 2.0 - 1.0) * amount * on;
      vec2 uv = vUv + duv(vec2(dx, 0.0)), o = duv(vec2(rgb * on, 0.0));
      vec4 r = samp(uv + o), g = samp(uv), b = samp(uv - o);
      fragColor = vec4(r.r, g.g, b.b, max(max(r.a, g.a), b.a)); }`,
  // sample at the inverse of: p' = A + R·S·(p − A) + offset
  xform: `uniform vec2 anc, off, scl; uniform float ang, opac;
    void main() {
      vec2 p = fragLP() - anc - off;
      float c = cos(-ang), s = sin(-ang);
      vec2 q = vec2(c * p.x - s * p.y, s * p.x + c * p.y) / scl + anc;
      fragColor = samp(vec2(q.x, size.y / pxs - q.y) * pxs / size) * opac;
    }`,
  rgbSplit: `uniform vec2 off;
    void main() { vec2 o = duv(off); vec4 r = samp(vUv + o), g = samp(vUv), b = samp(vUv - o);
      fragColor = vec4(r.r, g.g, b.b, max(max(r.a, g.a), b.a)); }`,
  // arrival-time reveal: amap holds seconds per pixel of the content rect (rows top-down); dt = now − arrival
  reveal: `uniform sampler2D amap; uniform float now, soft, fw, inv, fon; uniform vec3 fcol;
    void main() { vec4 c = samp(vUv);
      vec2 q = clamp((vUv - inner.xy) / inner.zw, 0.0, 1.0);
      float dt = now - texture(amap, vec2(q.x, 1.0 - q.y)).r;
      float v = soft > 0.0 ? clamp(dt / soft, 0.0, 1.0) : (dt >= 0.0 ? 1.0 : 0.0);
      float band = 0.0;
      if (fon > 0.5 && fw > 0.0) band = inv > 0.5 ? (dt < 0.0 ? 1.0 - clamp(-dt / fw, 0.0, 1.0) : 0.0) : (dt >= 0.0 ? 1.0 - clamp(dt / fw, 0.0, 1.0) : 0.0);
      if (inv > 0.5) v = 1.0 - v;
      vec4 o = c * v;
      o.rgb = mix(o.rgb, fcol * o.a, band);
      fragColor = o; }`,
  // the shadow's alpha: src alpha at p − offset
  shadowA: `uniform vec2 off; void main() { fragColor = vec4(0.0, 0.0, 0.0, samp(vUv - duv(off)).a); }`,
  // shadow (alpha in b) under src
  shadowOver: `uniform sampler2D b; uniform vec3 col; uniform float opac; uniform bool only;
    void main() { vec4 x = samp(vUv); float a = clamp(texture(b, vUv).a, 0.0, 1.0) * opac;
      vec4 sh = vec4(toLinear(col) * a, a);
      fragColor = only ? sh : x + sh * (1.0 - x.a); }`,
  // stroke along the alpha: dilate by rOut, erode by rIn (physical px), ring samples
  stroke: `uniform float rOut, rIn; uniform vec3 col; uniform float opac;
    float ringMax(float R, bool mx) {
      float a = samp(vUv).a, best = a;
      if (R <= 0.0) return a;
      int rings = int(min(ceil(R), 16.0));
      for (int k = 1; k <= 16; k++) { if (k > rings) break;
        float r = R * float(k) / float(rings);
        int m = int(min(8.0 + 4.0 * float(k), 40.0));
        for (int j = 0; j < 40; j++) { if (j >= m) break;
          float t = 6.2831853 * (float(j) + 0.5 * float(k)) / float(m);
          float s = samp(vUv + vec2(cos(t), sin(t)) * r / size).a;
          best = mx ? max(best, s) : min(best, s); } }
      return best;
    }
    void main() { vec4 x = samp(vUv);
      float dil = ringMax(rOut, true), ero = rIn > 0.0 ? ringMax(rIn, false) : x.a;
      float m = clamp(dil - ero, 0.0, 1.0) * opac;
      fragColor = vec4(toLinear(col) * m, m) + x * (1.0 - m); }`,

  // ---- distort: every one samples the source at a moved point (logical px)
  bulge: `uniform vec2 c, rad; uniform float amt;
    void main() { vec2 p = fragLP(); float r = length((p - c) / rad);
      if (r >= 1.0) { fragColor = samp(vUv); return; }
      float w = 1.0 - r; w = w * w * (3.0 - 2.0 * w);
      fragColor = sampLP(c + (p - c) * (1.0 - amt * w)); }`,
  spherize: `uniform vec2 c; uniform float rad, amt;
    void main() { vec2 p = fragLP(); float r = length(p - c) / rad;
      if (r >= 1.0) { fragColor = samp(vUv); return; }
      float k = r < 1e-5 ? (amt >= 0.0 ? mix(1.0, 0.6366198, amt) : mix(1.0, 1.5707963, -amt))
        : (amt >= 0.0 ? mix(r, asin(r) / 1.5707963, amt) : mix(r, sin(r * 1.5707963), -amt)) / r;
      fragColor = sampLP(c + (p - c) * k); }`,
  twirl: `uniform vec2 c; uniform float rad, ang;
    void main() { vec2 p = fragLP(), d = p - c; float r = length(d) / rad;
      if (r >= 1.0) { fragColor = samp(vUv); return; }
      float f = 1.0 - r, a = -ang * f * f, cs = cos(a), sn = sin(a);
      fragColor = sampLP(c + vec2(cs * d.x - sn * d.y, sn * d.x + cs * d.y)); }`,
  ripple: `uniform vec2 c; uniform float rad, wl, amp, ph;
    void main() { vec2 p = fragLP(), d = p - c; float r = length(d);
      float fall = rad > 0.0 ? 1.0 - smoothstep(0.0, 1.0, r / rad) : 1.0;
      vec2 dir = r > 1e-4 ? d / r : vec2(0.0);
      fragColor = sampLP(p + dir * amp * fall * sin(6.2831853 * (r / wl - ph))); }`,
  // rect → polar: x becomes the angle (clockwise from 12 o'clock), y the radius (the top row at the centre); polar → rect undoes it
  polar: `uniform float amt; uniform int toRect;
    void main() { vec2 p = fragLP(); vec4 R = rectLP(); vec2 hs = R.zw * 0.5, c = R.xy + hs, q;
      if (toRect == 0) { vec2 n = (p - c) / hs; float a = atan(n.x, -n.y);
        q = R.xy + vec2(fract(a / 6.2831853 + 1.0) * R.z, length(n) * R.w); }
      else { vec2 u = (p - R.xy) / R.zw; float a = u.x * 6.2831853; q = c + vec2(sin(a), -cos(a)) * u.y * hs; }
      fragColor = sampLP(mix(p, q, amt)); }`,
  // the middle of the layer (across dir) pushed along dir by amt, the two ends stay
  bend: `uniform float amt; uniform vec2 dir;
    void main() { vec2 p = fragLP(); vec4 R = rectLP(); vec2 c = R.xy + R.zw * 0.5, ax = vec2(-dir.y, dir.x);
      float E = abs(ax.x) * R.z * 0.5 + abs(ax.y) * R.w * 0.5, s = clamp(dot(p - c, ax) / max(E, 1e-3), -1.0, 1.0);
      fragColor = sampLP(p - dir * amt * (1.0 - s * s)); }`,
  // r → r (1 + k r²), r over the content's half diagonal: k > 0 barrel (fisheye), k < 0 pincushion
  lensDistort: `uniform vec2 c; uniform float k, rd;
    void main() { vec2 n = (fragLP() - c) / rd; fragColor = sampLP(c + n * (1.0 + k * dot(n, n)) * rd); }`,
  // mw: per-pixel offsets over the content rect (rows top-down), upsampled from the grid
  meshWarp: `uniform sampler2D mw; uniform vec2 mwn;
    void main() { vec2 p = fragLP(), u = inRect(p);
      vec2 t = (u * (mwn - 1.0) + 0.5) / mwn;
      fragColor = sampLP(p - texture(mw, t).rg); }`,
  displacementMap: `uniform sampler2D dmap; uniform bool lin; uniform int cx, cy; uniform vec2 amt;
    float chan(vec3 d, float a, int k) { return k == 0 ? d.r : k == 1 ? d.g : k == 2 ? d.b : k == 3 ? a : lumD(d); }
    void main() { vec2 p = fragLP(), u = inRect(p), uv = vec2(u.x, 1.0 - u.y);
      vec3 d = mapDisp(dmap, uv, lin); float a = texture(dmap, uv).a;
      fragColor = sampLP(p + (vec2(chan(d, a, cx), chan(d, a, cy)) - 0.5) * 2.0 * amt); }`,

  // ---- transitions: the source times a visibility 0–1
  linearWipe: `uniform float cmp, fth; uniform vec2 dir;
    void main() { vec4 x = samp(vUv), R = rectLP(); vec2 c = R.xy + R.zw * 0.5;
      float E = abs(dir.x) * R.z * 0.5 + abs(dir.y) * R.w * 0.5, s = dot(fragLP() - c, dir) + E;
      float e = mix(-fth * 0.5, 2.0 * E + fth * 0.5, cmp);
      float v = fth > 0.0 ? smoothstep(e - fth * 0.5, e + fth * 0.5, s) : step(e, s);
      fragColor = x * (cmp <= 0.0 ? 1.0 : cmp >= 1.0 ? 0.0 : v); }`,
  radialWipe: `uniform float cmp, st, fth; uniform vec2 c; uniform int dirm;
    void main() { vec4 x = samp(vUv); vec2 d = fragLP() - c; float r = length(d), a = atan(d.y, d.x);
      float rel = mod(dirm == 1 ? st - a : a - st, 6.2831853), sweep = cmp * 6.2831853;
      if (dirm == 2) { rel = min(rel, 6.2831853 - rel); sweep = cmp * 3.1415927; }
      float fa = fth / max(r, 1.0), v = fa > 0.0 ? smoothstep(sweep - fa, sweep, rel) : step(sweep, rel);
      fragColor = x * (cmp <= 0.0 ? 1.0 : cmp >= 1.0 ? 0.0 : v); }`,
  // m: the distance in the iris's own metric (circle, or a regular polygon measured to its corners)
  irisWipe: `uniform float cmp, fth, rmax, rot; uniform vec2 c; uniform int sides; uniform bool inv;
    void main() { vec4 x = samp(vUv); vec2 d = fragLP() - c; float m = length(d);
      if (sides >= 3) { float seg = 6.2831853 / float(sides), t = mod(atan(d.y, d.x) - rot, seg) - seg * 0.5; m *= cos(t) / cos(seg * 0.5); }
      float v;
      if (inv) { float R = cmp * (rmax + fth); v = fth > 0.0 ? smoothstep(R - fth, R, m) : step(R, m); }
      else { float R = (1.0 - cmp) * (rmax + fth); v = fth > 0.0 ? 1.0 - smoothstep(R - fth, R, m) : step(m, R); }
      fragColor = x * (cmp <= 0.0 ? 1.0 : cmp >= 1.0 ? 0.0 : v); }`,
  venetianBlinds: `uniform float cmp, wid, fth; uniform vec2 dir;
    void main() { vec4 x = samp(vUv), R = rectLP();
      float s = mod(dot(fragLP() - R.xy - R.zw * 0.5, dir), wid), e = mix(-fth * 0.5, wid + fth * 0.5, cmp);
      float v = fth > 0.0 ? smoothstep(e - fth * 0.5, e + fth * 0.5, s) : step(e, s);
      fragColor = x * (cmp <= 0.0 ? 1.0 : cmp >= 1.0 ? 0.0 : v); }`,
  blockDissolve: `uniform float cmp, sft, seed; uniform vec2 blk;
    void main() { vec4 x = samp(vUv), R = rectLP();
      float h = hash13(vec3(floor((fragLP() - R.xy) / blk), seed));
      float v = sft > 0.0 ? smoothstep(cmp * (1.0 + sft) - sft, cmp * (1.0 + sft), h) : step(cmp, h);
      fragColor = x * (cmp <= 0.0 ? 1.0 : cmp >= 1.0 ? 0.0 : v); }`,
  // the dark parts of the map (or of the layer itself) go first
  gradientWipe: `uniform sampler2D gmap; uniform bool useMap, lin, inv; uniform float cmp, sft;
    void main() { vec4 x = samp(vUv); float l;
      if (useMap) { vec2 u = inRect(fragLP()); l = lumD(mapDisp(gmap, vec2(u.x, 1.0 - u.y), lin)); }
      else l = lumD(disp(x));
      if (inv) l = 1.0 - l;
      float v = sft > 0.0 ? smoothstep(cmp * (1.0 + sft) - sft, cmp * (1.0 + sft), l) : step(cmp, l);
      fragColor = x * (cmp <= 0.0 ? 1.0 : cmp >= 1.0 ? 0.0 : v); }`,

  // page turn: the page rolls round a cylinder of radius R lying on the fold line (fp, normal dir, the turning side at
  // s > 0). A screen point at s: under the flat front (s < 0) or under the curl (0..R: the lower arc shows the front at
  // unrolled distance R·asin(s/R), the upper arc the back at R·(π − asin(s/R))); the part past the curl lies flipped
  // over the front at s < 0 (unrolled πR − s). The turned area gets a soft shadow
  pageTurn: `uniform vec2 fp, dir; uniform float R, sh, lit, bop; uniform vec3 bcol; uniform bool useBack, backLin; uniform sampler2D back;
    bool inPage(vec2 q) { vec4 B = rectLP(); return q.x >= B.x && q.y >= B.y && q.x <= B.x + B.z && q.y <= B.y + B.w; }
    // the back of the page at page point q, seen at screen point p (a back image reads upright where it lands)
    vec4 backAt(vec2 q, vec2 p, float shade) {
      vec4 f = sampLP(q);
      vec3 b = useBack ? mapDisp(back, vec2(inRect(p).x, 1.0 - inRect(p).y), backLin) : bcol;
      // (the paper is where the page is: its alpha; backOpacity < 1 lets the front show through, like thin paper)
      return f.a > 0.0 ? fromDisp(mix(disp(f), b, bop) * shade, f.a) : vec4(0.0);
    }
    vec4 over(vec4 top, vec4 under) { return top + under * (1.0 - top.a); }
    void main() {
      vec2 p = fragLP(); float s = dot(p - fp, dir);
      vec4 col = vec4(0.0);
      if (s < 0.0) {
        col = inPage(p) ? samp(vUv) : vec4(0.0);
        vec2 q = p + dir * (3.1415927 * R - 2.0 * s);
        if (inPage(q)) col = over(backAt(q, p, 1.0), col);
      } else if (s <= R) {
        float a1 = asin(clamp(s / R, 0.0, 1.0));
        vec2 q2 = p + dir * (R * (3.1415927 - a1) - s), q1 = p + dir * (R * a1 - s);
        // shading: the curl turns away from the light toward its top
        if (inPage(q2)) col = backAt(q2, p, mix(1.0, 0.55 + 0.45 * cos(a1), lit));
        else if (inPage(q1)) { vec4 f = sampLP(q1); col = vec4(f.rgb * mix(1.0, 0.35 + 0.65 * cos(a1), lit), f.a); }
      }
      // the shadow the curl casts onto what the turned part uncovered
      if (s > 0.0 && col.a < 1.0 && inPage(p)) {
        float k = sh * exp(-max(s - R * 0.6, 0.0) / max(R * 1.2, 1.0)) * smoothstep(0.0, R * 0.4, s);
        col = over(col, vec4(0.0, 0.0, 0.0, k));
      }
      fragColor = col;
    }`,
  // card wipe: the layer cut into rows x columns of cards that flip one after another (each card's own time from
  // where it sits along the wipe), seen through a pinhole at distance D in front of the content's centre. Every
  // fragment casts its ray at its own card and the two next to it across the flip axis (a tilted card overhangs)
  cardWipe: `uniform float cmp, wid, rnd, seed, D, jit, lit, ang; uniform vec2 grid, wdir; uniform bool axisY, useBack, backLin; uniform sampler2D back; uniform float flipS;
    float cardAngle(vec2 cell) {
      vec4 B = rectLP();
      vec2 cs = B.zw / grid, c = B.xy + (cell + 0.5) * cs, h = B.zw * 0.5;
      float E = abs(wdir.x) * h.x + abs(wdir.y) * h.y;
      float o = (dot(c - B.xy - h, wdir) / max(E, 1e-3)) * 0.5 + 0.5;
      o = mix(o, hash13(vec3(cell, seed)), rnd);
      float u = clamp((cmp * (1.0 + wid) - o * 1.0) / max(wid, 1e-3), 0.0, 1.0);
      return u * u * (3.0 - 2.0 * u) * 3.1415927 * flipS;
    }
    void main() {
      vec4 B = rectLP();
      vec2 p = fragLP(), cs = B.zw / grid, E2 = B.xy + B.zw * 0.5;
      vec3 eye = vec3(E2, -D), rd = normalize(vec3(p, 0.0) - eye);
      vec2 cell0 = floor((p - B.xy) / cs);
      float best = 1e20; vec4 col = vec4(0.0);
      for (int k = -1; k <= 1; k++) {
        vec2 cell = cell0 + (axisY ? vec2(float(k), 0.0) : vec2(0.0, float(k)));
        if (cell.x < 0.0 || cell.y < 0.0 || cell.x >= grid.x || cell.y >= grid.y) continue;
        float th = cardAngle(cell), c = cos(th), sn = sin(th);
        vec3 C = vec3(B.xy + (cell + 0.5) * cs, -jit * abs(sn) * (0.5 + hash13(vec3(cell, seed + 3.0))));
        // into the card's frame: undo its rotation about its own centre (about x: y-z turns; about y: x-z turns)
        vec3 o = eye - C, r = rd;
        if (axisY) { o = vec3(c * o.x + sn * o.z, o.y, -sn * o.x + c * o.z); r = vec3(c * r.x + sn * r.z, r.y, -sn * r.x + c * r.z); }
        else { o = vec3(o.x, c * o.y - sn * o.z, sn * o.y + c * o.z); r = vec3(r.x, c * r.y - sn * r.z, sn * r.y + c * r.z); }
        if (abs(r.z) < 1e-6) continue;
        float t = -o.z / r.z;
        vec2 l = o.xy + r.xy * t;
        if (t <= 0.0 || t >= best || abs(l.x) > cs.x * 0.5 || abs(l.y) > cs.y * 0.5) continue;
        best = t;
        float shade = mix(1.0, 0.45 + 0.55 * abs(c), lit);
        if (c >= 0.0) { vec4 f = sampLP(C.xy + l); col = vec4(f.rgb * shade, f.a); }
        else {
          // the back lands upright once the card has turned over
          vec2 q = C.xy + (axisY ? vec2(-l.x, l.y) : vec2(l.x, -l.y));
          if (useBack) { vec2 u = inRect(q); vec3 d = mapDisp(back, vec2(u.x, 1.0 - u.y), backLin); col = fromDisp(d * shade, 1.0); }
          else col = vec4(0.0);
        }
      }
      fragColor = col;
    }`,

  // ---- colour (display space)
  // lut: 256 x 1, r g b curves (the master rgb curve already folded in) and alpha, read with a manual lerp
  curves: `uniform sampler2D lut;
    vec4 lk(float x) { float f = clamp(x, 0.0, 1.0) * 255.0; int i = int(floor(f));
      return mix(texelFetch(lut, ivec2(i, 0), 0), texelFetch(lut, ivec2(min(i + 1, 255), 0), 0), f - float(i)); }
    void main() { vec4 c = samp(vUv); if (c.a <= 1e-5) { fragColor = c; return; }
      vec3 d = disp(c); fragColor = fromDisp(vec3(lk(d.r).r, lk(d.g).g, lk(d.b).b), clamp(lk(c.a).a, 0.0, 1.0)); }`,
  colorBalance: `uniform vec3 sh, md, hl; uniform bool pl;
    void main() { vec4 c = samp(vUv); if (c.a <= 1e-5) { fragColor = c; return; }
      vec3 d = disp(c); float l = lumD(d);
      float ws = 1.0 - smoothstep(0.0, 0.6, l), wh = smoothstep(0.4, 1.0, l), wm = max(0.0, 1.0 - ws - wh);
      vec3 o = d + (sh * ws + md * wm + hl * wh) * 0.5;
      if (pl) o += l - lumD(clamp(o, 0.0, 1.0));
      fragColor = fromDisp(o, c.a); }`,
  brightnessContrast: `uniform float br, ct;
    void main() { vec4 c = samp(vUv); if (c.a <= 1e-5) { fragColor = c; return; }
      float k = ct >= 0.0 ? 1.0 / max(1.0 - ct, 0.01) : 1.0 + ct;
      fragColor = fromDisp((disp(c) + br - 0.5) * k + 0.5, c.a); }`,
  leaveColor: `uniform vec3 tgt; uniform float tol, sft, amt;
    void main() { vec4 c = samp(vUv); if (c.a <= 1e-5) { fragColor = c; return; }
      vec3 d = disp(c), h = rgb2hsl(d), th = rgb2hsl(tgt);
      float dh = abs(h.x - th.x); dh = min(dh, 1.0 - dh);
      float keep = (1.0 - smoothstep(tol, tol + max(sft, 1e-3), dh)) * smoothstep(0.04, 0.15, h.y);
      fragColor = fromDisp(mix(d, vec3(lumD(d)), amt * (1.0 - keep)), c.a); }`,

  // ---- layer styles (from the alpha)
  // b's alpha: the source alpha moved by the offset (and softened); what it does not cover inside the layer is shadow
  innerOver: `uniform sampler2D b; uniform vec3 col; uniform float opac, gain;
    void main() { vec4 x = samp(vUv); float s = clamp(texture(b, vUv).a, 0.0, 1.0);
      float k = clamp((1.0 - s) * gain, 0.0, 1.0) * opac;
      fragColor = vec4(x.rgb * (1.0 - k) + toLinear(col) * x.a * k, x.a); }`,
  // b's alpha: the softened source alpha; the glow sits under the layer
  outerOver: `uniform sampler2D b; uniform vec3 col; uniform float opac, spread;
    void main() { vec4 x = samp(vUv);
      float g = clamp(texture(b, vUv).a * 2.0 / max(1.0 - spread, 0.02), 0.0, 1.0) * opac;
      fragColor = x + vec4(toLinear(col) * g, g) * (1.0 - x.a); }`,
  // hgt's alpha: the softened alpha as a height field; light from L2 (a unit vector, y down) at altitude lz
  bevel: `uniform sampler2D hgt; uniform vec2 L2; uniform float lz, dep, sz, hio, sho; uniform vec3 hic, shc;
    void main() { vec4 x = samp(vUv); if (x.a <= 1e-5) { fragColor = x; return; }
      vec2 e = 1.0 / size;
      float hx = texture(hgt, vUv + vec2(e.x, 0.0)).a - texture(hgt, vUv - vec2(e.x, 0.0)).a;
      float hy = texture(hgt, vUv - vec2(0.0, e.y)).a - texture(hgt, vUv + vec2(0.0, e.y)).a;
      vec2 g = vec2(hx, hy) * 0.5 * pxs * sz * dep;
      vec3 n = normalize(vec3(-g, 1.0)), L = vec3(L2 * cos(lz), sin(lz));
      float s = dot(n, L) - sin(lz);
      float hk = clamp(s * 2.0, 0.0, 1.0) * hio, sk = clamp(-s * 2.0, 0.0, 1.0) * sho;
      vec3 rgb = x.rgb * (1.0 - hk) + toLinear(hic) * x.a * hk;
      fragColor = vec4(rgb * (1.0 - sk) + toLinear(shc) * x.a * sk, x.a); }`,
  gradientOverlay: `${RAMP} uniform float opac, sc; uniform vec2 dir; uniform bool radial; uniform int md;
    void main() { vec4 x = samp(vUv); if (x.a <= 1e-5) { fragColor = x; return; }
      vec4 R = rectLP(); vec2 p = fragLP() - R.xy - R.zw * 0.5; float t;
      if (radial) t = length(p) / (0.5 * length(R.zw) * sc);
      else { float E = abs(dir.x) * R.z * 0.5 + abs(dir.y) * R.w * 0.5; t = dot(p, dir) / (E * sc) * 0.5 + 0.5; }
      vec3 g = ramp(clamp(t, 0.0, 1.0)), d = disp(x), o = g;
      if (md == 1) o = d * g; else if (md == 2) o = 1.0 - (1.0 - d) * (1.0 - g);
      else if (md == 3) o = mix(2.0 * d * g, 1.0 - 2.0 * (1.0 - d) * (1.0 - g), step(0.5, d));
      fragColor = fromDisp(mix(d, o, opac), x.a); }`,

  // ---- keying
  // distance from the key colour in the chroma plane, relative to the key's own chroma; despill pulls the key's main
  // channel down to the mean of the other two (Keylight's average)
  chromaKey: `uniform vec3 key; uniform float tol, sft, desp, cb, cw; uniform int kch;
    vec2 cbcr(vec3 c) { float y = lumD(c); return vec2(c.b - y, c.r - y); }
    void main() { vec4 c = samp(vUv); if (c.a <= 1e-5) { fragColor = c; return; }
      vec3 d = disp(c);
      float ks = max(length(cbcr(key)), 0.05), dist = length(cbcr(d) - cbcr(key)) / ks;
      float m = smoothstep(tol, tol + max(sft, 1e-3), dist);
      m = clamp((m - cb) / max(cw - cb, 1e-3), 0.0, 1.0);
      if (kch == 0) d.r = mix(d.r, min(d.r, (d.g + d.b) * 0.5), desp);
      else if (kch == 1) d.g = mix(d.g, min(d.g, (d.r + d.b) * 0.5), desp);
      else d.b = mix(d.b, min(d.b, (d.r + d.g) * 0.5), desp);
      fragColor = fromDisp(d, c.a * m); }`,
  lumaKey: `uniform float lv, sft; uniform bool inv;
    void main() { vec4 c = samp(vUv); if (c.a <= 1e-5) { fragColor = c; return; }
      float a = sft > 0.0 ? smoothstep(lv - sft * 0.5, lv + sft * 0.5, lumD(disp(c))) : step(lv, lumD(disp(c)));
      fragColor = c * (inv ? 1.0 - a : a); }`,
  // b: the source softened; its alpha re-thresholded moves the edge (above 0.5 inward, below outward)
  choke: `uniform sampler2D b; uniform float lv, w;
    void main() { vec4 x = samp(vUv), bl = texture(b, vUv);
      float a = smoothstep(lv - w, lv + w, bl.a);
      vec3 col = x.a > 1e-3 ? x.rgb / x.a : bl.a > 1e-4 ? bl.rgb / bl.a : vec3(0.0);
      fragColor = vec4(col * a, a); }`,

  // ---- light
  // rays: each pixel averages the way back toward c (uv), nearer samples weigh more
  rays: `uniform vec2 c; uniform float len; uniform int n;
    void main() { vec2 d = vUv - c; vec4 s = vec4(0.0); float ws = 0.0;
      for (int i = 0; i < 64; i++) { if (i >= n) break; float u = (float(i) + 0.5) / float(n), w = 1.0 - u;
        s += w * samp(c + d * (1.0 - len * u)); ws += w; }
      fragColor = s / ws; }`,
  // weighted sum of up to four textures (deep glow's levels)
  sum4: `uniform sampler2D t2, t3, t4; uniform vec4 w;
    void main() { fragColor = samp(vUv) * w.x + texture(t2, vUv) * w.y + texture(t3, vUv) * w.z + texture(t4, vUv) * w.w; }`,
  // a flare: core and halo at the source, star rays, an anamorphic streak, a chromatic ring, ghosts along the line
  // from the source through the centre. Sizes are fractions of D (the content diagonal × size). Added as light.
  lensFlare: `uniform vec2 sp, cc; uniform float br, sz, stk, ghs; uniform int nr; uniform vec3 col;
    const float GF[6] = float[6](0.45, 0.72, 1.18, 1.42, 1.7, 2.15);
    const float GR[6] = float[6](0.020, 0.045, 0.012, 0.075, 0.03, 0.11);
    const vec3 GC[6] = vec3[6](vec3(1.0, 0.55, 0.25), vec3(0.35, 1.0, 0.55), vec3(0.6, 0.45, 1.0), vec3(1.0, 0.8, 0.4), vec3(0.4, 0.75, 1.0), vec3(1.0, 0.45, 0.6));
    void main() { vec4 x = samp(vUv), R = rectLP(); float D = length(R.zw) * sz;
      vec2 p = fragLP(), d = p - sp; float r = length(d) / D;
      vec3 f = col * (exp(-r * 60.0) * 1.6 + exp(-r * 10.0) * 0.28);
      if (nr > 0) { float a = atan(d.y, d.x); f += col * pow(abs(cos(a * float(nr) * 0.5)), 90.0) * exp(-r * 5.0) * 0.55; }
      f += vec3(0.55, 0.75, 1.0) * stk * exp(-abs(d.y) / (D * 0.0025)) * exp(-abs(d.x) / (D * 0.35)) * 0.7;
      float rr = r - 0.28;
      f += vec3(exp(-pow((rr + 0.01) / 0.014, 2.0)), exp(-pow(rr / 0.014, 2.0)), exp(-pow((rr - 0.01) / 0.014, 2.0))) * 0.07 * ghs;
      vec2 ax = cc - sp;
      for (int k = 0; k < 6; k++) { float gr = length(p - sp - ax * GF[k]) / D, rad = GR[k];
        f += GC[k] * smoothstep(rad, rad * 0.8, gr) * (0.35 + 0.65 * smoothstep(0.0, rad, gr)) * 0.07 * ghs; }
      f *= br;
      fragColor = vec4(x.rgb + f, max(x.a, clamp(max(max(f.r, f.g), f.b), 0.0, 1.0))); }`,
  // big soft colour blobs from one side, screened over the layer (and laid over its transparent parts as light)
  lightLeak: `${RAMP} uniform float amt, evo, seed, scl; uniform vec2 dir;
    void main() { vec4 x = samp(vUv), R = rectLP(); vec2 q = (fragLP() - R.xy - R.zw * 0.5) / (length(R.zw) * scl);
      vec2 w = vec2(fbm(vec3(q * 0.9 + seed * 7.1, evo * 0.3), 2), fbm(vec3(q * 0.9 + 19.3 + seed * 3.7, evo * 0.3), 2));
      float n = clamp(fbm(vec3(q * 0.8 + w * 0.5, evo * 0.2 + seed), 2) * 1.1 + 0.5, 0.0, 1.0);
      float side = smoothstep(-0.7, 0.5, dot(q, dir) * 2.0 + (n - 0.5) * 0.8);
      float k = smoothstep(0.12, 0.62, n) * side * amt;
      vec3 g = ramp(clamp(n * 1.3 - 0.15, 0.0, 1.0)), d = disp(x);
      vec4 o = fromDisp(1.0 - (1.0 - d) * (1.0 - g * k), x.a);
      float la = clamp(k * max(max(g.r, g.g), g.b), 0.0, 1.0) * (1.0 - x.a);
      fragColor = vec4(o.rgb + toLinear(g) * k * (1.0 - x.a), x.a + la); }`,
};

type Uniforms = Record<string, THREE.IUniform>;
const baseUniforms = (): Uniforms => ({
  src: { value: null }, size: { value: new THREE.Vector2(1, 1) }, pxs: { value: 1 }, edge: { value: 0 }, inner: { value: new THREE.Vector4(0, 0, 1, 1) },
});

const v3 = (c: readonly number[]) => new THREE.Vector3(c[0], c[1], c[2]);
const u2 = (): THREE.IUniform => ({ value: new THREE.Vector2() });
const u3 = (): THREE.IUniform => ({ value: new THREE.Vector3() });
const uf = (v = 0): THREE.IUniform => ({ value: v });
const rad = (deg: number) => (deg * Math.PI) / 180;
const CHAN: Record<Chan, number> = { r: 0, g: 1, b: 2, a: 3, luma: 4 };

/** Stops → the RAMP uniforms (display colours, positions, count). */
function rampOf(stops: Stops) {
  const st = stops.slice(0, 8).map((s, i, all) => (typeof s === 'string' ? [all.length > 1 ? i / (all.length - 1) : 0, s] : s) as readonly [number, string]);
  if (!st.length) st.push([0, '#ffffff']);
  return {
    cols: Array.from({ length: 8 }, (_, i) => v3(srgb(st[Math.min(i, st.length - 1)]![1]))),
    pos: Array.from({ length: 8 }, (_, i) => st[Math.min(i, st.length - 1)]![0]),
    ns: st.length,
  };
}
const rampUniforms = (): Uniforms => ({ cols: { value: Array.from({ length: 8 }, () => new THREE.Vector3()) }, pos: { value: new Array(8).fill(0) }, ns: { value: 1 } });

/** A curve sampled at n points over 0–1: monotone cubic through the points (no overshoot), the ends [0, 0] / [1, 1] unless given. */
export function curveTable(pts: Curve | undefined, n = 256): Float32Array {
  const p: [number, number][] = [];
  for (const [x, y] of [...(pts ?? [])].sort((a, b) => a[0] - b[0])) {
    const cx = Math.min(1, Math.max(0, x));
    if (p.length && Math.abs(p[p.length - 1]![0] - cx) < 1e-6) p[p.length - 1] = [cx, y]; else p.push([cx, y]);
  }
  if (!p.length || p[0]![0] > 1e-6) p.unshift([0, 0]);
  if (p[p.length - 1]![0] < 1 - 1e-6) p.push([1, 1]);
  const k = p.length, dx: number[] = [], sl: number[] = [];
  for (let i = 0; i < k - 1; i++) { dx.push(p[i + 1]![0] - p[i]![0]); sl.push((p[i + 1]![1] - p[i]![1]) / dx[i]!); }
  // Fritsch–Carlson tangents
  const m = new Array<number>(k);
  m[0] = sl[0]!; m[k - 1] = sl[k - 2]!;
  for (let i = 1; i < k - 1; i++) m[i] = sl[i - 1]! * sl[i]! <= 0 ? 0 : (sl[i - 1]! + sl[i]!) / 2;
  for (let i = 0; i < k - 1; i++) {
    if (sl[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i]! / sl[i]!, b = m[i + 1]! / sl[i]!, h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * sl[i]!; m[i + 1] = t * b * sl[i]!; }
  }
  const out = new Float32Array(n);
  let j = 0;
  for (let s = 0; s < n; s++) {
    const x = s / (n - 1);
    while (j < k - 2 && x > p[j + 1]![0]) j++;
    const h = dx[j]!, t = (x - p[j]![0]) / h, t2 = t * t, t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * p[j]![1] + (t3 - 2 * t2 + t) * h * m[j]! + (-2 * t3 + 3 * t2) * p[j + 1]![1] + (t3 - t2) * h * m[j + 1]!;
    out[s] = Math.min(1, Math.max(0, y));
  }
  return out;
}
const lookup = (tab: Float32Array, v: number) => { const f = Math.min(1, Math.max(0, v)) * (tab.length - 1), i = Math.floor(f), j = Math.min(i + 1, tab.length - 1); return tab[i]! + (tab[j]! - tab[i]!) * (f - i); };

/** Mesh-warp grid (rows top-down of [dx, dy] per vertex) → a smooth offset field (Catmull-Rom), half float RG, rows top-down. */
function meshField(grid: readonly (readonly V2[])[]): { data: Uint16Array; nx: number; ny: number } {
  const R = grid.length, C = grid[0]!.length;
  const nx = Math.min(129, (C - 1) * 8 + 1), ny = Math.min(129, (R - 1) * 8 + 1);
  const at = (j: number, i: number) => grid[Math.min(R - 1, Math.max(0, j))]![Math.min(C - 1, Math.max(0, i))] ?? [0, 0];
  const cr = (a: number, b: number, c: number, d: number, t: number) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
  const data = new Uint16Array(nx * ny * 4);
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    const gx = (ix / (nx - 1)) * (C - 1), gy = (iy / (ny - 1)) * (R - 1);
    const i = Math.min(C - 2, Math.floor(gx)), j = Math.min(R - 2, Math.floor(gy)), tx = gx - i, ty = gy - j;
    for (let ch = 0; ch < 2; ch++) {
      const row = (jj: number) => cr(at(jj, i - 1)[ch]!, at(jj, i)[ch]!, at(jj, i + 1)[ch]!, at(jj, i + 2)[ch]!, tx);
      data[(iy * nx + ix) * 4 + ch] = THREE.DataUtils.toHalfFloat(cr(row(j - 1), row(j), row(j + 1), row(j + 2), ty));
    }
  }
  return { data, nx, ny };
}

/** Runs effect stacks; owns a pool of scratch render targets by size. One per scene (or share the layers' one). */
export class Fx {
  private passes = new Map<string, FSPass>();
  private pool: { rt: THREE.WebGLRenderTarget; busy: boolean }[] = [];
  // small lookup textures (curves, mesh warp) by their params, most recently used last
  private dtex = new Map<string, THREE.DataTexture>();
  private shatter: Shatter | null = null;
  private puppet: Puppet | null = null;

  private dataTex(key: string, make: () => THREE.DataTexture): THREE.DataTexture {
    let t = this.dtex.get(key);
    if (t) { this.dtex.delete(key); this.dtex.set(key, t); return t; }
    t = make();
    t.needsUpdate = true;
    this.dtex.set(key, t);
    if (this.dtex.size > 48) { const [k0, t0] = this.dtex.entries().next().value as [string, THREE.DataTexture]; t0.dispose(); this.dtex.delete(k0); }
    return t;
  }

  /** The content rect in logical px [x, y, w, h] (inside the padding), and its centre. */
  private rect(c: RunCtx): [number, number, number, number] {
    const lw = c.W / c.pxs, lh = c.H / c.pxs, q = c.inner;
    return [q.x * lw, (1 - q.y - q.w) * lh, q.z * lw, q.w * lh];
  }
  private mid(c: RunCtx, p?: V2): V2 {
    if (p) return p;
    const [x, y, w, h] = this.rect(c);
    return [x + w / 2, y + h / 2];
  }

  private pass(name: string, extra: Uniforms = {}, frag?: string): FSPass {
    let p = this.passes.get(name);
    if (!p) {
      p = new FSPass(HEAD + (frag ?? FRAGS[name]!), { ...baseUniforms(), ...extra });
      this.passes.set(name, p);
    }
    return p;
  }

  /**
   * A free scratch target of `w` x `h` physical px (HalfFloat, no depth), until release(). `pxs`: its physical px per
   * logical px (what rtScale() reports, so the Compositor's transforms work in logical px on it).
   */
  acquire(w: number, h: number, pxs = 1): THREE.WebGLRenderTarget {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    let rt: THREE.WebGLRenderTarget | null = null;
    for (const e of this.pool) if (!e.busy && e.rt.width === w && e.rt.height === h) { e.busy = true; rt = e.rt; break; }
    if (!rt) {
      rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
      this.pool.push({ rt, busy: true });
    }
    setRtScale(rt, pxs);
    return rt;
  }
  release(rt: THREE.WebGLRenderTarget | null | undefined) {
    const e = rt && this.pool.find((x) => x.rt === rt);
    if (e) e.busy = false;
  }
  /** Frees pooled targets that are not in use (call after a size change you will not come back to). */
  trim() {
    this.pool = this.pool.filter((e) => { if (!e.busy) e.rt.dispose(); return e.busy; });
  }

  /**
   * Run `effects` over `src` into `out` (same physical size as src's target). Both premultiplied linear HDR.
   * `o.pxs`: physical px per logical px (default: out's makeRT scale, else SCALE). `o.edge`: what a sample outside the
   * image is (default 'none' = transparent). `o.inner`: the content rect inside a padded target, logical px [x, y, w, h]
   * (tile and the clamp / wrap / mirror edges work from it; default the whole target).
   */
  run(renderer: THREE.WebGLRenderer, src: THREE.Texture, out: THREE.WebGLRenderTarget, effects: EffectList, o: { pxs?: number; edge?: Edge; inner?: readonly [number, number, number, number] } = {}) {
    const list = effects.filter(Boolean) as Effect[];
    const W = out.width, H = out.height, pxs = o.pxs ?? (rtScale(out) || SCALE);
    const lw = W / pxs, lh = H / pxs;
    const inner = o.inner ? new THREE.Vector4(o.inner[0] / lw, 1 - (o.inner[1] + o.inner[3]) / lh, o.inner[2] / lw, o.inner[3] / lh) : new THREE.Vector4(0, 0, 1, 1);
    const ctx: RunCtx = { r: renderer, W, H, pxs, edge: EDGES.indexOf(o.edge ?? 'none'), inner };
    if (!list.length) { this.draw('copy', ctx, src, out); return; }
    let cur = src, held: THREE.WebGLRenderTarget | null = null;
    list.forEach((e, i) => {
      const last = i === list.length - 1;
      const dst = last && out.texture !== cur ? out : this.acquire(W, H, pxs);
      this.apply(e, ctx, cur, dst);
      this.release(held);
      held = dst === out ? null : dst;
      cur = dst.texture;
    });
    if (held) { this.draw('copy', { ...ctx, edge: 0 }, (held as THREE.WebGLRenderTarget).texture, out); this.release(held); }
  }

  private draw(name: string, c: RunCtx, src: THREE.Texture, dst: THREE.WebGLRenderTarget, set?: (u: Uniforms) => void, frag?: string, extra?: Uniforms) {
    const p = this.pass(name, extra, frag);
    const u = p.u;
    u.src!.value = src;
    (u.size!.value as THREE.Vector2).set(c.W, c.H);
    u.pxs!.value = c.pxs;
    u.edge!.value = c.edge;
    (u.inner!.value as THREE.Vector4).copy(c.inner);
    set?.(u);
    p.render(c.r, dst);
  }

  /** Separable gaussian, sigma in physical px. */
  private gauss(c: RunCtx, src: THREE.Texture, dst: THREE.WebGLRenderTarget, sigma: number, axis: 'both' | 'x' | 'y' = 'both') {
    const half = 3 * sigma, n = Math.max(1, Math.min(48, Math.ceil(half))), step = half / n;
    const one = (s: THREE.Texture, d: THREE.WebGLRenderTarget, dx: number, dy: number) =>
      this.draw('gauss', c, s, d, (u) => { (u.dir!.value as THREE.Vector2).set(dx * step / c.W, dy * step / c.H); u.n!.value = n; u.sig!.value = sigma / step; },
        undefined, { dir: { value: new THREE.Vector2() }, n: { value: 1 }, sig: { value: 1 } });
    if (sigma < 0.05) { this.draw('copy', c, src, dst); return; }
    if (axis === 'x') return one(src, dst, 1, 0);
    if (axis === 'y') return one(src, dst, 0, 1);
    const t = this.acquire(c.W, c.H, c.pxs);
    one(src, t, 1, 0);
    one(t.texture, dst, 0, 1);
    this.release(t);
  }

  /** Repeated box passes along a segment (each next pass spans the previous pass's step): a continuous streak. */
  private streak(c: RunCtx, src: THREE.Texture, dst: THREE.WebGLRenderTarget, a: V2, b: V2) {
    // a, b: physical px offsets of the segment's ends
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.5) { this.draw('copy', c, src, dst); return; }
    const segs: [V2, V2, number][] = [];
    let ea = a, eb = b, L = len;
    for (let k = 0; k < 3; k++) {
      const n = Math.max(2, Math.min(48, Math.ceil(L)));
      segs.push([ea, eb, n]);
      const s = L / n;
      if (s <= 1) break;
      const ux = (eb[0] - ea[0]) / L, uy = (eb[1] - ea[1]) / L;
      ea = [-ux * s / 2, -uy * s / 2]; eb = [ux * s / 2, uy * s / 2]; L = s;
    }
    this.chain(c, src, dst, segs.length, (i, s, d) => {
      const [p, q, n] = segs[i]!;
      this.draw('line', c, s, d, (u) => { (u.a!.value as THREE.Vector2).set(p[0] / c.W, -p[1] / c.H); (u.b!.value as THREE.Vector2).set(q[0] / c.W, -q[1] / c.H); u.n!.value = n; },
        undefined, { a: { value: new THREE.Vector2() }, b: { value: new THREE.Vector2() }, n: { value: 2 } });
    });
  }

  /** Run `n` passes src → … → dst through scratch targets. */
  private chain(c: RunCtx, src: THREE.Texture, dst: THREE.WebGLRenderTarget, n: number, f: (i: number, s: THREE.Texture, d: THREE.WebGLRenderTarget) => void) {
    let cur = src, held: THREE.WebGLRenderTarget | null = null;
    for (let i = 0; i < n; i++) {
      const d = i === n - 1 ? dst : this.acquire(c.W, c.H, c.pxs);
      // later passes read a full-size intermediate: no edge remapping needed beyond the first
      f(i, cur, d);
      this.release(held);
      held = d === dst ? null : d;
      cur = d.texture;
    }
  }

  private apply(e: Effect, c: RunCtx, src: THREE.Texture, dst: THREE.WebGLRenderTarget) {
    const P = c.pxs;
    switch (e.type) {
      case 'blur': return this.gauss(c, src, dst, Math.max(0, e.radius) * P, e.axis);
      case 'directionalBlur': {
        const a = ((e.angle ?? 0) * Math.PI) / 180, L = Math.abs(e.length) * P, ux = Math.cos(a), uy = Math.sin(a);
        // a sample at +d shows the content that sits d away: 'back' trails behind the motion (content smeared opposite angle)
        const lo = e.side === 'back' ? 0 : -L / 2, hi = e.side === 'back' ? L : L / 2;
        return this.streak(c, src, dst, [ux * lo, uy * lo], [ux * hi, uy * hi]);
      }
      case 'radialBlur': {
        const spin = e.kind === 'spin';
        const lw = c.W / P, lh = c.H / P, cx = (e.center?.[0] ?? lw / 2) / lw, cy = 1 - (e.center?.[1] ?? lh / 2) / lh;
        let k = spin ? (e.amount * Math.PI) / 180 : -Math.log(Math.max(1e-3, 1 - Math.min(0.999, Math.abs(e.amount))));
        // the farthest pixel's arc, to pick the tap count
        const far = Math.hypot(Math.max(cx, 1 - cx) * c.W, Math.max(cy, 1 - cy) * c.H);
        const passes: [number, number][] = [];
        for (let i = 0; i < 3; i++) {
          const arc = spin ? Math.abs(k) * far : Math.abs(Math.expm1(Math.abs(k))) * far;
          if (arc < 0.5) break;
          const n = Math.max(2, Math.min(48, Math.ceil(arc)));
          passes.push([k, n]);
          k /= n;
          if (arc / n <= 1) break;
        }
        if (!passes.length) return this.draw('copy', c, src, dst);
        return this.chain(c, src, dst, passes.length, (i, s, d) => this.draw('radial', c, s, d, (u) => {
          (u.c!.value as THREE.Vector2).set(cx, cy); u.k!.value = passes[i]![0]; u.n!.value = passes[i]![1]; u.spin!.value = spin ? 1 : 0;
        }, undefined, { c: { value: new THREE.Vector2() }, k: { value: 0 }, n: { value: 2 }, spin: { value: 0 } }));
      }
      case 'gradientMap': {
        const st = e.stops.slice(0, 8).map((s, i, all) => (typeof s === 'string' ? [all.length > 1 ? i / (all.length - 1) : 0, s] : s) as readonly [number, string]);
        const cols = Array.from({ length: 8 }, (_, i) => v3(srgb(st[Math.min(i, st.length - 1)]![1])));
        const pos = Array.from({ length: 8 }, (_, i) => st[Math.min(i, st.length - 1)]![0]);
        return this.draw('gradientMap', c, src, dst, (u) => { u.cols!.value = cols; u.pos!.value = pos; u.ns!.value = st.length; u.amount!.value = e.amount ?? 1; },
          undefined, { cols: { value: cols }, pos: { value: pos }, ns: { value: 1 }, amount: { value: 1 } });
      }
      case 'fill': return this.draw('fill', c, src, dst, (u) => { u.col!.value = v3(srgb(e.color)); u.amount!.value = e.opacity ?? 1; }, undefined, { col: { value: new THREE.Vector3() }, amount: { value: 1 } });
      case 'levels': return this.draw('levels', c, src, dst, (u) => { u.ib!.value = e.inBlack ?? 0; u.iw!.value = e.inWhite ?? 1; u.gm!.value = e.gamma ?? 1; u.ob!.value = e.outBlack ?? 0; u.ow!.value = e.outWhite ?? 1; },
        undefined, { ib: { value: 0 }, iw: { value: 1 }, gm: { value: 1 }, ob: { value: 0 }, ow: { value: 1 } });
      case 'hueSat': return this.draw('hueSat', c, src, dst, (u) => { u.hue!.value = e.hue ?? 0; u.hsSat!.value = e.saturation ?? 0; u.lig!.value = e.lightness ?? 0; },
        undefined, { hue: { value: 0 }, hsSat: { value: 0 }, lig: { value: 0 } });
      case 'invert': return this.draw('invert', c, src, dst, (u) => { u.amount!.value = e.amount ?? 1; }, undefined, { amount: { value: 1 } });
      case 'threshold': return this.draw('threshold', c, src, dst, (u) => { u.level!.value = e.level ?? 0.5; u.soft!.value = e.soft ?? 0; }, undefined, { level: { value: 0.5 }, soft: { value: 0 } });
      case 'posterize': return this.draw('posterize', c, src, dst, (u) => { u.levels!.value = e.levels; }, undefined, { levels: { value: 4 } });
      case 'exposure': return this.draw('exposure', c, src, dst, (u) => { u.k!.value = 2 ** e.stops; }, undefined, { k: { value: 1 } });
      case 'mosaic': {
        const [w, h] = typeof e.size === 'number' ? [e.size, e.size] : e.size;
        return this.draw('mosaic', c, src, dst, (u) => { (u.cell!.value as THREE.Vector2).set(Math.max(0.5, w), Math.max(0.5, h)); }, undefined, { cell: { value: new THREE.Vector2(8, 8) } });
      }
      case 'glow': {
        const t1 = this.acquire(c.W, c.H, c.pxs), t2 = this.acquire(c.W, c.H, c.pxs);
        this.draw('bright', c, src, t1, (u) => { u.th!.value = e.threshold ?? 0.6; u.useTint!.value = !!e.color; if (e.color) u.tintc!.value = v3(srgb(e.color)); },
          undefined, { th: { value: 0.6 }, tintc: { value: new THREE.Vector3(1, 1, 1) }, useTint: { value: false } });
        const flat = { ...c, edge: 0, inner: new THREE.Vector4(0, 0, 1, 1) };
        if (e.deep) {
          // a tight core plus ever wider, dimmer levels: the long falloff of a real bloom (Deep Glow)
          const R0 = (e.radius ?? 20) * P, lv = [0.125, 0.25, 0.5, 1].map(() => this.acquire(c.W, c.H, c.pxs));
          lv.forEach((t, i) => this.gauss(flat, t1.texture, t, R0 * [0.125, 0.25, 0.5, 1][i]!));
          this.draw('sum4', flat, lv[0]!.texture, t2, (u) => { u.t2!.value = lv[1]!.texture; u.t3!.value = lv[2]!.texture; u.t4!.value = lv[3]!.texture; (u.w!.value as THREE.Vector4).set(0.5, 0.35, 0.25, 0.18); },
            undefined, { t2: { value: null }, t3: { value: null }, t4: { value: null }, w: { value: new THREE.Vector4() } });
          lv.forEach((t) => this.release(t));
        } else this.gauss(flat, t1.texture, t2, (e.radius ?? 20) * P);
        this.draw('addTex', c, src, dst, (u) => { u.b!.value = t2.texture; u.k!.value = e.intensity ?? 1; u.alphaFromRgb!.value = true; },
          undefined, { b: { value: null }, k: { value: 1 }, alphaFromRgb: { value: true } });
        this.release(t1); this.release(t2);
        return;
      }
      case 'halftone': return this.draw('halftone', c, src, dst, (u) => {
        u.cellS!.value = Math.max(1, e.size ?? 8); u.ang!.value = ((e.angle ?? 45) * Math.PI) / 180;
        u.useInk!.value = !!e.ink; if (e.ink) u.ink!.value = v3(srgb(e.ink));
        u.usePaper!.value = !!e.paper; if (e.paper) u.paper!.value = v3(srgb(e.paper));
        u.line!.value = e.shape === 'line' ? 1 : 0;
      }, undefined, { cellS: { value: 8 }, ang: { value: 0 }, ink: { value: new THREE.Vector3() }, useInk: { value: false }, paper: { value: new THREE.Vector3(1, 1, 1) }, usePaper: { value: false }, line: { value: 0 } });
      case 'noise': return this.draw('noise', c, src, dst, (u) => { u.amount!.value = e.amount ?? 0.1; u.seed!.value = e.seed ?? 0; u.mono!.value = e.mono ?? true; u.grain!.value = Math.max(0.25, e.size ?? 1); },
        undefined, { amount: { value: 0.1 }, seed: { value: 0 }, mono: { value: true }, grain: { value: 1 } });
      case 'offset': {
        // sample at uv − shift, wrapping inside the content rect
        return this.draw('offset', { ...c, edge: 2 }, src, dst, (u) => { (u.sh!.value as THREE.Vector2).set(e.shift[0] * P / c.W, e.shift[1] * P / c.H); },
          `uniform vec2 sh; void main() { fragColor = samp(vUv - vec2(sh.x, -sh.y)); }`, { sh: { value: new THREE.Vector2() } });
      }
      case 'transform': {
        const lw = c.W / P, lh = c.H / P;
        const [sx, sy] = typeof e.scale === 'number' ? [e.scale, e.scale] : e.scale ?? [1, 1];
        if (Math.abs(sx) < 1e-6 || Math.abs(sy) < 1e-6) return this.draw('clear', c, src, dst, undefined, `void main() { fragColor = vec4(0.0); }`);
        const edge = e.edge ? EDGES.indexOf(e.edge) : c.edge;
        return this.draw('xform', { ...c, edge }, src, dst, (u) => {
          (u.anc!.value as THREE.Vector2).set(e.anchor?.[0] ?? lw / 2, e.anchor?.[1] ?? lh / 2);
          (u.off!.value as THREE.Vector2).set(...(e.position ?? [0, 0]));
          (u.scl!.value as THREE.Vector2).set(sx, sy);
          u.ang!.value = ((e.rotation ?? 0) * Math.PI) / 180;
          u.opac!.value = e.opacity ?? 1;
        }, undefined, { anc: { value: new THREE.Vector2() }, off: { value: new THREE.Vector2() }, scl: { value: new THREE.Vector2(1, 1) }, ang: { value: 0 }, opac: { value: 1 } });
      }
      case 'tile': {
        const edge = e.mode === 'wrap' ? 2 : e.mode === 'clamp' ? 1 : 3;
        return this.draw('copy', { ...c, edge }, src, dst);
      }
      case 'displace': return this.draw('displace', c, src, dst, (u) => { u.amount!.value = e.amount ?? 20; u.scl!.value = Math.max(1, e.size ?? 200); u.evo!.value = e.evolution ?? 0; u.seed!.value = e.seed ?? 0; u.oct!.value = Math.max(1, Math.min(6, e.octaves ?? 2)); },
        undefined, { amount: { value: 20 }, scl: { value: 200 }, evo: { value: 0 }, seed: { value: 0 }, oct: { value: 2 } });
      case 'wave': return this.draw('wave', c, src, dst, (u) => { u.amp!.value = e.amplitude ?? 10; u.wl!.value = Math.max(1, e.wavelength ?? 120); u.ang!.value = ((e.angle ?? 0) * Math.PI) / 180; u.ph!.value = e.phase ?? 0; },
        undefined, { amp: { value: 10 }, wl: { value: 120 }, ang: { value: 0 }, ph: { value: 0 } });
      case 'blockGlitch': return this.draw('blockGlitch', c, src, dst, (u) => {
        u.amount!.value = e.amount ?? 40; (u.blk!.value as THREE.Vector2).set(e.block?.[0] ?? 0, e.block?.[1] ?? 24); u.density!.value = e.density ?? 0.3; u.seed!.value = e.seed ?? 0; u.rgb!.value = e.rgb ?? 0;
      }, undefined, { amount: { value: 40 }, blk: { value: new THREE.Vector2(0, 24) }, density: { value: 0.3 }, seed: { value: 0 }, rgb: { value: 0 } });
      case 'rgbSplit': return this.draw('rgbSplit', c, src, dst, (u) => { (u.off!.value as THREE.Vector2).set(...(e.offset ?? [6, 0])); }, undefined, { off: { value: new THREE.Vector2(6, 0) } });
      case 'dropShadow': {
        const t1 = this.acquire(c.W, c.H, c.pxs);
        this.draw('shadowA', c, src, t1, (u) => { (u.off!.value as THREE.Vector2).set(...(e.offset ?? [6, 6])); }, undefined, { off: { value: new THREE.Vector2() } });
        let sh = t1;
        if ((e.softness ?? 0) > 0) { sh = this.acquire(c.W, c.H, c.pxs); this.gauss({ ...c, edge: 0, inner: new THREE.Vector4(0, 0, 1, 1) }, t1.texture, sh, (e.softness ?? 0) * P); }
        this.draw('shadowOver', c, src, dst, (u) => { u.b!.value = sh.texture; u.col!.value = v3(srgb(e.color ?? '#000')); u.opac!.value = e.opacity ?? 1; u.only!.value = !!e.only; },
          undefined, { b: { value: null }, col: { value: new THREE.Vector3() }, opac: { value: 1 }, only: { value: false } });
        this.release(t1); if (sh !== t1) this.release(sh);
        return;
      }
      case 'stroke': {
        const w = Math.max(0, e.width ?? 4) * P, pos = e.position ?? 'outside';
        const rOut = pos === 'outside' ? w : pos === 'center' ? w / 2 : 0, rIn = pos === 'inside' ? w : pos === 'center' ? w / 2 : 0;
        return this.draw('stroke', c, src, dst, (u) => { u.rOut!.value = rOut; u.rIn!.value = rIn; u.col!.value = v3(srgb(e.color)); u.opac!.value = e.opacity ?? 1; },
          undefined, { rOut: { value: 0 }, rIn: { value: 0 }, col: { value: new THREE.Vector3() }, opac: { value: 1 } });
      }
      case 'reveal': {
        const tex = e.map instanceof THREE.Texture ? e.map : e.map.texture();
        return this.draw('reveal', c, src, dst, (u) => {
          u.amap!.value = tex; u.now!.value = e.t; u.soft!.value = Math.max(0, e.soft ?? 0); u.inv!.value = e.invert ? 1 : 0;
          u.fon!.value = e.front ? 1 : 0; u.fw!.value = Math.max(0, e.frontTime ?? 0.1); if (e.front) u.fcol!.value = v3(linear(e.front));
        }, undefined, { amap: { value: null }, now: { value: 0 }, soft: { value: 0 }, inv: { value: 0 }, fon: { value: 0 }, fw: { value: 0.1 }, fcol: { value: new THREE.Vector3() } });
      }
      // ---- distort
      case 'bulge': {
        const R = this.rect(c), [cx, cy] = this.mid(c, e.center), r = e.radius ?? Math.min(R[2], R[3]) / 2;
        const [rx, ry] = typeof r === 'number' ? [r, r] : r;
        return this.draw('bulge', c, src, dst, (u) => { (u.c!.value as THREE.Vector2).set(cx, cy); (u.rad!.value as THREE.Vector2).set(Math.max(1e-3, rx), Math.max(1e-3, ry)); u.amt!.value = Math.max(-4, Math.min(0.95, e.amount)); },
          undefined, { c: u2(), rad: u2(), amt: uf() });
      }
      case 'spherize': {
        const R = this.rect(c), [cx, cy] = this.mid(c, e.center);
        return this.draw('spherize', c, src, dst, (u) => { (u.c!.value as THREE.Vector2).set(cx, cy); u.rad!.value = Math.max(1e-3, e.radius ?? Math.min(R[2], R[3]) / 2); u.amt!.value = Math.max(-1, Math.min(1, e.amount ?? 1)); },
          undefined, { c: u2(), rad: uf(1), amt: uf() });
      }
      case 'twirl': {
        const R = this.rect(c), [cx, cy] = this.mid(c, e.center);
        return this.draw('twirl', c, src, dst, (u) => { (u.c!.value as THREE.Vector2).set(cx, cy); u.rad!.value = Math.max(1e-3, e.radius ?? Math.min(R[2], R[3]) / 2); u.ang!.value = rad(e.angle); },
          undefined, { c: u2(), rad: uf(1), ang: uf() });
      }
      case 'ripple': {
        const [cx, cy] = this.mid(c, e.center);
        return this.draw('ripple', c, src, dst, (u) => { (u.c!.value as THREE.Vector2).set(cx, cy); u.rad!.value = Math.max(0, e.radius ?? 0); u.wl!.value = Math.max(1, e.wavelength ?? 60); u.amp!.value = e.amplitude ?? 10; u.ph!.value = e.phase ?? 0; },
          undefined, { c: u2(), rad: uf(), wl: uf(60), amp: uf(), ph: uf() });
      }
      case 'polar': return this.draw('polar', c, src, dst, (u) => { u.amt!.value = Math.max(0, Math.min(1, e.amount ?? 1)); u.toRect!.value = e.kind === 'toRect' ? 1 : 0; }, undefined, { amt: uf(1), toRect: uf() });
      case 'bend': {
        const a = rad(e.angle ?? 90);
        return this.draw('bend', c, src, dst, (u) => { u.amt!.value = e.amount; (u.dir!.value as THREE.Vector2).set(Math.cos(a), Math.sin(a)); }, undefined, { amt: uf(), dir: u2() });
      }
      case 'lensDistort': {
        const R = this.rect(c), [cx, cy] = this.mid(c, e.center);
        return this.draw('lensDistort', c, src, dst, (u) => { (u.c!.value as THREE.Vector2).set(cx, cy); u.k!.value = Math.max(-0.33, Math.min(4, e.amount)); u.rd!.value = Math.max(1, Math.hypot(R[2], R[3]) / 2); },
          undefined, { c: u2(), k: uf(), rd: uf(1) });
      }
      case 'meshWarp': {
        if (e.grid.length < 2 || (e.grid[0]?.length ?? 0) < 2) return this.draw('copy', c, src, dst);
        const tex = this.dataTex(`mesh:${JSON.stringify(e.grid)}`, () => {
          const f = meshField(e.grid), t = new THREE.DataTexture(f.data, f.nx, f.ny, THREE.RGBAFormat, THREE.HalfFloatType);
          t.minFilter = t.magFilter = THREE.LinearFilter;
          return t;
        });
        return this.draw('meshWarp', c, src, dst, (u) => { u.mw!.value = tex; (u.mwn!.value as THREE.Vector2).set(tex.image.width, tex.image.height); }, undefined, { mw: { value: null }, mwn: u2() });
      }
      case 'displacementMap': {
        const a = e.amount ?? 20, [ax, ay] = typeof a === 'number' ? [a, a] : a;
        return this.draw('displacementMap', c, src, dst, (u) => {
          u.dmap!.value = e.map; u.lin!.value = !!(e.map as THREE.Texture & { isRenderTargetTexture?: boolean }).isRenderTargetTexture;
          u.cx!.value = CHAN[e.x ?? 'r']; u.cy!.value = CHAN[e.y ?? 'g']; (u.amt!.value as THREE.Vector2).set(ax, ay);
        }, undefined, { dmap: { value: null }, lin: { value: false }, cx: uf(), cy: uf(1), amt: u2() });
      }
      case 'puppet': {
        if (!e.pins.length) return this.draw('copy', c, src, dst);
        const R = this.rect(c);
        this.puppet ??= new Puppet();
        const pins = e.pins.map((p) => ({ at: [p.at[0] - R[0], p.at[1] - R[1]] as V2, to: [p.to[0] - R[0], p.to[1] - R[1]] as V2 }));
        const out = this.puppet.render(c.r, src, c.W, c.H, P, R, c.inner, { pins, mesh: e.mesh, id: e.id, iterations: e.iterations });
        return this.draw('copy', { ...c, edge: 0, inner: new THREE.Vector4(0, 0, 1, 1) }, out.texture, dst);
      }
      case 'shatter': {
        if (e.time <= 0) return this.draw('copy', c, src, dst);
        const R = this.rect(c), [cx, cy] = this.mid(c, e.center);
        this.shatter ??= new Shatter();
        const out = this.shatter.render(c.r, src, dst, c.W, c.H, P, R, { ...e, center: [cx - R[0], cy - R[1]], sideColor: e.sideColor ? linear(e.sideColor) : null });
        return this.draw('copy', { ...c, edge: 0, inner: new THREE.Vector4(0, 0, 1, 1) }, out.texture, dst);
      }
      // ---- transitions
      case 'linearWipe': {
        const a = rad(e.angle ?? 0);
        return this.draw('linearWipe', c, src, dst, (u) => { u.cmp!.value = e.completion; u.fth!.value = Math.max(0, e.feather ?? 0); (u.dir!.value as THREE.Vector2).set(Math.cos(a), Math.sin(a)); },
          undefined, { cmp: uf(), fth: uf(), dir: u2() });
      }
      case 'radialWipe': {
        const [cx, cy] = this.mid(c, e.center);
        return this.draw('radialWipe', c, src, dst, (u) => {
          u.cmp!.value = e.completion; u.st!.value = rad(e.start ?? -90); u.fth!.value = Math.max(0, e.feather ?? 0);
          (u.c!.value as THREE.Vector2).set(cx, cy); u.dirm!.value = e.direction === 'ccw' ? 1 : e.direction === 'both' ? 2 : 0;
        }, undefined, { cmp: uf(), st: uf(), fth: uf(), c: u2(), dirm: uf() });
      }
      case 'irisWipe': {
        const [x, y, w, h] = this.rect(c), [cx, cy] = this.mid(c, e.center), n = Math.round(e.sides ?? 0);
        const far = Math.max(...[[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => Math.hypot(px! - cx, py! - cy)));
        return this.draw('irisWipe', c, src, dst, (u) => {
          u.cmp!.value = e.completion; u.fth!.value = Math.max(0, e.feather ?? 0); u.rmax!.value = n >= 3 ? far / Math.cos(Math.PI / n) : far;
          u.rot!.value = rad(e.rotation ?? -90); (u.c!.value as THREE.Vector2).set(cx, cy); u.sides!.value = n; u.inv!.value = !!e.invert;
        }, undefined, { cmp: uf(), fth: uf(), rmax: uf(1), rot: uf(), c: u2(), sides: uf(), inv: { value: false } });
      }
      case 'venetianBlinds': {
        const a = rad(e.angle ?? 0), wd = Math.max(1, e.width ?? 40);
        return this.draw('venetianBlinds', c, src, dst, (u) => { u.cmp!.value = e.completion; u.wid!.value = wd; u.fth!.value = Math.min(wd, Math.max(0, e.feather ?? 0)); (u.dir!.value as THREE.Vector2).set(Math.cos(a), Math.sin(a)); },
          undefined, { cmp: uf(), wid: uf(40), fth: uf(), dir: u2() });
      }
      case 'blockDissolve': {
        const b = e.block ?? 16, [bw, bh] = typeof b === 'number' ? [b, b] : b;
        return this.draw('blockDissolve', c, src, dst, (u) => { u.cmp!.value = e.completion; u.sft!.value = Math.max(0, e.soft ?? 0); u.seed!.value = e.seed ?? 0; (u.blk!.value as THREE.Vector2).set(Math.max(0.5, bw), Math.max(0.5, bh)); },
          undefined, { cmp: uf(), sft: uf(), seed: uf(), blk: u2() });
      }
      case 'gradientWipe': return this.draw('gradientWipe', c, src, dst, (u) => {
        u.cmp!.value = e.completion; u.sft!.value = Math.max(0, e.soft ?? 0); u.inv!.value = !!e.invert;
        u.useMap!.value = !!e.map; u.gmap!.value = e.map ?? null; u.lin!.value = !!(e.map as (THREE.Texture & { isRenderTargetTexture?: boolean }) | undefined)?.isRenderTargetTexture;
      }, undefined, { cmp: uf(), sft: uf(), inv: { value: false }, useMap: { value: false }, gmap: { value: null }, lin: { value: false } });
      case 'pageTurn': {
        const Rr = Math.max(1, e.radius ?? 60), a = rad(e.angle ?? 45), dx = Math.cos(a), dy = Math.sin(a);
        let fp: V2;
        if (e.fold) fp = e.fold;
        else {
          // completion 0: the fold just past the page's far corner (nothing turned); 1: so far back that the page has
          // turned over completely and lies flipped outside the content
          const [x, y, w, h] = this.rect(c), cx = x + w / 2, cy = y + h / 2;
          const pr = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => (px! - cx) * dx + (py! - cy) * dy);
          const f0 = Math.max(...pr) + 1, f1 = Math.min(...pr) - (Math.PI * Rr) / 2 - 1, k = Math.min(1, Math.max(0, e.completion ?? 0));
          const f = f0 + (f1 - f0) * k;
          fp = [cx + dx * f, cy + dy * f];
        }
        return this.draw('pageTurn', c, src, dst, (u) => {
          (u.fp!.value as THREE.Vector2).set(fp[0], fp[1]); (u.dir!.value as THREE.Vector2).set(dx, dy); u.R!.value = Rr;
          u.sh!.value = e.shadow ?? 0.5; u.lit!.value = e.light ?? 0.6; u.bop!.value = Math.min(1, Math.max(0, e.backOpacity ?? 1));
          u.bcol!.value = v3(srgb(e.backColor ?? '#f4f1ea')); u.useBack!.value = !!e.back; u.back!.value = e.back ?? null;
          u.backLin!.value = !!(e.back as (THREE.Texture & { isRenderTargetTexture?: boolean }) | undefined)?.isRenderTargetTexture;
        }, undefined, { fp: u2(), dir: u2(), R: uf(60), sh: uf(), lit: uf(), bop: uf(1), bcol: u3(), useBack: { value: false }, back: { value: null }, backLin: { value: false } });
      }
      case 'cardWipe': {
        const a = rad(e.angle ?? 0);
        return this.draw('cardWipe', c, src, dst, (u) => {
          u.cmp!.value = e.completion; u.wid!.value = Math.max(0.01, e.width ?? 0.5); u.rnd!.value = Math.min(1, Math.max(0, e.random ?? 0));
          u.seed!.value = e.seed ?? 0; u.D!.value = Math.max(100, e.perspective ?? 1600); u.jit!.value = e.jitter ?? 0; u.lit!.value = e.light ?? 0.5;
          (u.grid!.value as THREE.Vector2).set(Math.max(1, Math.round(e.columns ?? 10)), Math.max(1, Math.round(e.rows ?? 6)));
          (u.wdir!.value as THREE.Vector2).set(Math.cos(a), Math.sin(a)); u.axisY!.value = (e.axis ?? 'y') === 'y'; u.flipS!.value = e.flip ?? 1;
          u.useBack!.value = !!e.back; u.back!.value = e.back ?? null;
          u.backLin!.value = !!(e.back as (THREE.Texture & { isRenderTargetTexture?: boolean }) | undefined)?.isRenderTargetTexture;
        }, undefined, { cmp: uf(), wid: uf(0.5), rnd: uf(), seed: uf(), D: uf(1600), jit: uf(), lit: uf(), ang: uf(), grid: u2(), wdir: u2(),
          axisY: { value: true }, flipS: uf(1), useBack: { value: false }, back: { value: null }, backLin: { value: false } });
      }
      // ---- colour
      case 'curves': {
        const tex = this.dataTex(`curves:${JSON.stringify([e.rgb, e.r, e.g, e.b, e.a])}`, () => {
          const M = curveTable(e.rgb), ch = [e.r, e.g, e.b].map((k) => curveTable(k)), A = curveTable(e.a), d = new Float32Array(256 * 4);
          for (let i = 0; i < 256; i++) { for (let k = 0; k < 3; k++) d[i * 4 + k] = lookup(M, ch[k]![i]!); d[i * 4 + 3] = A[i]!; }
          const t = new THREE.DataTexture(d, 256, 1, THREE.RGBAFormat, THREE.FloatType);
          t.minFilter = t.magFilter = THREE.NearestFilter;
          return t;
        });
        return this.draw('curves', c, src, dst, (u) => { u.lut!.value = tex; }, undefined, { lut: { value: null } });
      }
      case 'colorBalance': return this.draw('colorBalance', c, src, dst, (u) => {
        u.sh!.value = v3(e.shadows ?? [0, 0, 0]); u.md!.value = v3(e.midtones ?? [0, 0, 0]); u.hl!.value = v3(e.highlights ?? [0, 0, 0]); u.pl!.value = !!e.preserveLuminosity;
      }, undefined, { sh: u3(), md: u3(), hl: u3(), pl: { value: false } });
      case 'brightnessContrast': return this.draw('brightnessContrast', c, src, dst, (u) => { u.br!.value = e.brightness ?? 0; u.ct!.value = Math.max(-1, Math.min(0.99, e.contrast ?? 0)); }, undefined, { br: uf(), ct: uf() });
      case 'leaveColor': return this.draw('leaveColor', c, src, dst, (u) => {
        u.tgt!.value = v3(srgb(e.color)); u.tol!.value = Math.max(0, e.tolerance ?? 0.06); u.sft!.value = Math.max(0, e.soft ?? 0.04); u.amt!.value = Math.max(0, Math.min(1, e.amount ?? 1));
      }, undefined, { tgt: u3(), tol: uf(), sft: uf(), amt: uf(1) });
      // ---- layer styles
      case 'innerShadow': case 'innerGlow': case 'outerGlow': case 'bevel': {
        const flat = { ...c, edge: 0, inner: new THREE.Vector4(0, 0, 1, 1) }, t1 = this.acquire(c.W, c.H, c.pxs);
        let soft = t1;
        if (e.type === 'innerShadow') {
          this.draw('shadowA', c, src, t1, (u) => { (u.off!.value as THREE.Vector2).set(...(e.offset ?? [6, 6])); }, undefined, { off: u2() });
          if ((e.softness ?? 0) > 0) { soft = this.acquire(c.W, c.H, c.pxs); this.gauss(flat, t1.texture, soft, (e.softness ?? 0) * P); }
        } else this.gauss(c, src, t1, Math.max(0.5, (e.size ?? (e.type === 'outerGlow' ? 20 : 10)) / 2) * P);
        if (e.type === 'innerShadow' || e.type === 'innerGlow') {
          const col = e.color ?? (e.type === 'innerShadow' ? '#000' : '#fff');
          this.draw('innerOver', c, src, dst, (u) => { u.b!.value = soft.texture; u.col!.value = v3(srgb(col)); u.opac!.value = e.opacity ?? 0.75; u.gain!.value = e.type === 'innerGlow' ? 2 : 1; },
            undefined, { b: { value: null }, col: u3(), opac: uf(0.75), gain: uf(1) });
        } else if (e.type === 'outerGlow') {
          this.draw('outerOver', c, src, dst, (u) => { u.b!.value = t1.texture; u.col!.value = v3(srgb(e.color ?? '#fff')); u.opac!.value = e.opacity ?? 0.75; u.spread!.value = Math.max(0, Math.min(0.98, e.spread ?? 0)); },
            undefined, { b: { value: null }, col: u3(), opac: uf(0.75), spread: uf() });
        } else {
          const L = rad(e.light ?? -135);
          this.draw('bevel', c, src, dst, (u) => {
            u.hgt!.value = t1.texture; (u.L2!.value as THREE.Vector2).set(Math.cos(L), Math.sin(L)); u.lz!.value = rad(Math.max(0, Math.min(89, e.altitude ?? 30)));
            u.dep!.value = e.depth ?? 1; u.sz!.value = Math.max(0.5, e.size ?? 10);
            u.hic!.value = v3(srgb(e.highlight ?? '#fff')); u.hio!.value = e.highlightOpacity ?? 0.75; u.shc!.value = v3(srgb(e.shadow ?? '#000')); u.sho!.value = e.shadowOpacity ?? 0.75;
          }, undefined, { hgt: { value: null }, L2: u2(), lz: uf(), dep: uf(1), sz: uf(10), hic: u3(), hio: uf(), shc: u3(), sho: uf() });
        }
        this.release(t1); if (soft !== t1) this.release(soft);
        return;
      }
      case 'gradientOverlay': {
        const rp = rampOf(e.stops), a = rad(e.angle ?? 90);
        const md = { normal: 0, multiply: 1, screen: 2, overlay: 3 }[e.mode ?? 'normal'];
        return this.draw('gradientOverlay', c, src, dst, (u) => {
          u.cols!.value = rp.cols; u.pos!.value = rp.pos; u.ns!.value = rp.ns; u.opac!.value = e.opacity ?? 1; u.sc!.value = Math.max(1e-3, e.scale ?? 1);
          (u.dir!.value as THREE.Vector2).set(Math.cos(a), Math.sin(a)); u.radial!.value = e.kind === 'radial'; u.md!.value = md;
        }, undefined, { ...rampUniforms(), opac: uf(1), sc: uf(1), dir: u2(), radial: { value: false }, md: uf() });
      }
      // ---- keying
      case 'chromaKey': {
        const k = srgb(e.color ?? '#00b140'), kch = k[0] >= k[1] && k[0] >= k[2] ? 0 : k[1] >= k[2] ? 1 : 2;
        return this.draw('chromaKey', c, src, dst, (u) => {
          u.key!.value = v3(k); u.kch!.value = kch; u.tol!.value = Math.max(0, e.tolerance ?? 0.3); u.sft!.value = Math.max(0, e.soft ?? 0.2);
          u.desp!.value = Math.max(0, Math.min(1, e.despill ?? 1)); u.cb!.value = e.clipBlack ?? 0; u.cw!.value = e.clipWhite ?? 1;
        }, undefined, { key: u3(), kch: uf(1), tol: uf(), sft: uf(), desp: uf(1), cb: uf(), cw: uf(1) });
      }
      case 'lumaKey': return this.draw('lumaKey', c, src, dst, (u) => { u.lv!.value = e.level ?? 0.1; u.sft!.value = Math.max(0, e.soft ?? 0.1); u.inv!.value = !!e.invert; },
        undefined, { lv: uf(), sft: uf(), inv: { value: false } });
      case 'matteChoke': {
        const amt = e.amount, soft = Math.max(0, e.soft ?? 0);
        if (Math.abs(amt) < 1e-3 && soft <= 0) return this.draw('copy', c, src, dst);
        const sigma = Math.max(Math.abs(amt), soft, 0.5), t1 = this.acquire(c.W, c.H, c.pxs);
        this.gauss(c, src, t1, sigma * P);
        this.draw('choke', c, src, dst, (u) => {
          u.b!.value = t1.texture; u.lv!.value = amt > 1e-3 ? 0.8413 : amt < -1e-3 ? 0.1587 : 0.5;
          u.w!.value = Math.min(0.5, Math.max(0.01, soft / (2.5 * sigma)));
        }, undefined, { b: { value: null }, lv: uf(0.5), w: uf(0.05) });
        this.release(t1);
        return;
      }
      // ---- light
      case 'lightRays': {
        const L = Math.min(0.9, Math.max(0, e.length ?? 0.3));
        if (L <= 0 || (e.intensity ?? 1) <= 0) return this.draw('copy', c, src, dst);
        const flat = { ...c, edge: 0, inner: new THREE.Vector4(0, 0, 1, 1) };
        const [cx, cy] = this.mid(c, e.center), lw = c.W / P, lh = c.H / P, cu = cx / lw, cv = 1 - cy / lh;
        const far = Math.hypot(Math.max(cu, 1 - cu) * c.W, Math.max(cv, 1 - cv) * c.H);
        const t1 = this.acquire(c.W, c.H, c.pxs), t2 = this.acquire(c.W, c.H, c.pxs), t3 = this.acquire(c.W, c.H, c.pxs);
        let srcR: THREE.Texture = src;
        if ((e.threshold ?? 0) > 0 || e.color) {
          this.draw('bright', c, src, t1, (u) => { u.th!.value = e.threshold ?? 0; u.useTint!.value = !!e.color; if (e.color) u.tintc!.value = v3(srgb(e.color)); },
            undefined, { th: { value: 0.6 }, tintc: { value: new THREE.Vector3(1, 1, 1) }, useTint: { value: false } });
          srcR = t1.texture;
        }
        const n = Math.max(2, Math.min(64, Math.ceil(L * far)));
        this.draw('rays', srcR === src ? c : flat, srcR, t2, (u) => { (u.c!.value as THREE.Vector2).set(cu, cv); u.len!.value = L; u.n!.value = n; }, undefined, { c: u2(), len: uf(), n: uf(2) });
        // smooth the gaps between the taps (a small zoom blur, one tap step wide)
        const stepK = L / n;
        if (stepK * far > 1) this.apply({ type: 'radialBlur', kind: 'zoom', amount: 1 - Math.exp(-stepK), center: [cx, cy] }, flat, t2.texture, t3);
        else this.draw('copy', flat, t2.texture, t3);
        this.draw('addTex', c, src, dst, (u) => { u.b!.value = t3.texture; u.k!.value = e.intensity ?? 1; u.alphaFromRgb!.value = true; },
          undefined, { b: { value: null }, k: { value: 1 }, alphaFromRgb: { value: true } });
        this.release(t1); this.release(t2); this.release(t3);
        return;
      }
      case 'lensFlare': {
        const [cx, cy] = this.mid(c, e.center);
        return this.draw('lensFlare', c, src, dst, (u) => {
          (u.sp!.value as THREE.Vector2).set(e.position[0], e.position[1]); (u.cc!.value as THREE.Vector2).set(cx, cy);
          u.br!.value = e.brightness ?? 1; u.sz!.value = Math.max(0.05, e.size ?? 1); u.stk!.value = e.streak ?? 0.5; u.ghs!.value = e.ghosts ?? 1;
          u.nr!.value = Math.max(0, Math.round(e.rays ?? 6)); u.col!.value = v3(linear(e.color ?? '#ffd8a8'));
        }, undefined, { sp: u2(), cc: u2(), br: uf(1), sz: uf(1), stk: uf(), ghs: uf(1), nr: uf(), col: u3() });
      }
      case 'lightLeak': {
        const rp = rampOf(e.colors ?? ['#ff5a1f', '#ff2d6f', '#ffd27a']), a = rad(e.angle ?? -30);
        return this.draw('lightLeak', c, src, dst, (u) => {
          u.cols!.value = rp.cols; u.pos!.value = rp.pos; u.ns!.value = rp.ns; u.amt!.value = e.amount ?? 1; u.evo!.value = e.evolution ?? 0;
          u.seed!.value = e.seed ?? 0; u.scl!.value = Math.max(0.05, e.size ?? 1); (u.dir!.value as THREE.Vector2).set(Math.cos(a), Math.sin(a));
        }, undefined, { ...rampUniforms(), amt: uf(1), evo: uf(), seed: uf(), scl: uf(1), dir: u2() });
      }
      case 'custom': {
        const us = e.uniforms ?? {};
        const decl = Object.entries(us).map(([k, v]) => `uniform ${v instanceof THREE.Texture ? 'sampler2D' : typeof v === 'number' ? 'float' : `vec${(v as readonly number[]).length}`} ${k};`).join('\n');
        const key = `custom:${decl}\n${e.frag}`;
        const extra: Uniforms = {};
        for (const k of Object.keys(us)) extra[k] = { value: null };
        return this.draw(key, c, src, dst, (u) => {
          for (const [k, v] of Object.entries(us)) {
            if (v instanceof THREE.Texture || typeof v === 'number') u[k]!.value = v;
            else { const a = v as readonly number[]; u[k]!.value = a.length === 2 ? new THREE.Vector2(a[0], a[1]) : a.length === 3 ? new THREE.Vector3(a[0], a[1], a[2]) : new THREE.Vector4(a[0], a[1], a[2], a[3]); }
          }
        }, `${decl}\n${e.frag}\nvoid main() { fragColor = effect(vUv, fragLP()); }`, extra);
      }
    }
  }

  dispose() {
    for (const p of this.passes.values()) p.mat.dispose();
    for (const e of this.pool) e.rt.dispose();
    for (const t of this.dtex.values()) t.dispose();
    this.shatter?.dispose(); this.puppet?.dispose();
    this.shatter = null; this.puppet = null;
    this.passes.clear();
    this.pool = [];
    this.dtex.clear();
  }
}

interface RunCtx { r: THREE.WebGLRenderer; W: number; H: number; pxs: number; edge: number; inner: THREE.Vector4 }

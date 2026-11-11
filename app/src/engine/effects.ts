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
//     glow             threshold 0.6（显示空间亮度）、radius 20、intensity 1、color（给了就把光染成这个颜色）
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

type V2 = [number, number];
type Col = string;

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
  | { type: 'glow'; threshold?: number; radius?: number; intensity?: number; color?: Col }
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
  | { type: 'custom'; frag: string; uniforms?: Record<string, number | readonly number[] | THREE.Texture> };

/** An effect list as scenes write it: falsy entries are skipped. */
export type EffectList = readonly (Effect | null | false | undefined | 0 | '')[];

export type Edge = 'none' | 'clamp' | 'wrap' | 'mirror';
const EDGES: readonly Edge[] = ['none', 'clamp', 'wrap', 'mirror'];

/** How far (logical px) an effect can move content outside its input: the padding a layer needs not to clip it. */
export function effectPad(e: Effect): number {
  switch (e.type) {
    case 'blur': return 3 * Math.max(0, e.radius);
    case 'directionalBlur': return (e.side === 'back' ? 1 : 0.5) * Math.abs(e.length);
    case 'glow': return 3 * (e.radius ?? 20);
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
  hueSat: `uniform float hue, sat, lig;
    vec3 rgb2hsl(vec3 c) { float mx = max(max(c.r, c.g), c.b), mn = min(min(c.r, c.g), c.b), l = (mx + mn) * 0.5, d = mx - mn;
      if (d < 1e-5) return vec3(0.0, 0.0, l);
      float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn), h;
      if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0); else if (mx == c.g) h = (c.b - c.r) / d + 2.0; else h = (c.r - c.g) / d + 4.0;
      return vec3(h / 6.0, s, l); }
    vec3 hsl2rgb(vec3 h) { vec3 k = clamp(abs(mod(h.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
      return h.z + h.y * (k - 0.5) * (1.0 - abs(2.0 * h.z - 1.0)); }
    void main() {
      vec4 c = samp(vUv); if (c.a <= 1e-5) { fragColor = c; return; }
      vec3 h = rgb2hsl(disp(c));
      h.x = fract(h.x + hue / 360.0); h.y = clamp(h.y * (1.0 + sat), 0.0, 1.0);
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
};

type Uniforms = Record<string, THREE.IUniform>;
const baseUniforms = (): Uniforms => ({
  src: { value: null }, size: { value: new THREE.Vector2(1, 1) }, pxs: { value: 1 }, edge: { value: 0 }, inner: { value: new THREE.Vector4(0, 0, 1, 1) },
});

const v3 = (c: readonly number[]) => new THREE.Vector3(c[0], c[1], c[2]);

/** Runs effect stacks; owns a pool of scratch render targets by size. One per scene (or share the layers' one). */
export class Fx {
  private passes = new Map<string, FSPass>();
  private pool: { rt: THREE.WebGLRenderTarget; busy: boolean }[] = [];

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
      case 'hueSat': return this.draw('hueSat', c, src, dst, (u) => { u.hue!.value = e.hue ?? 0; u.sat!.value = e.saturation ?? 0; u.lig!.value = e.lightness ?? 0; },
        undefined, { hue: { value: 0 }, sat: { value: 0 }, lig: { value: 0 } });
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
        this.gauss({ ...c, edge: 0, inner: new THREE.Vector4(0, 0, 1, 1) }, t1.texture, t2, (e.radius ?? 20) * P);
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
    this.passes.clear();
    this.pool = [];
  }
}

interface RunCtx { r: THREE.WebGLRenderer; W: number; H: number; pxs: number; edge: number; inner: THREE.Vector4 }

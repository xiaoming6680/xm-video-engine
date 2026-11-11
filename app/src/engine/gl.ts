// GL plumbing on top of three.js: HDR render targets, fullscreen shader passes,
// a texture compositor and Canvas2D layers uploaded as textures.
import * as THREE from 'three';
import { GLSL_COMMON } from './glsl/common';
import { SCALE } from './scale';

export { SCALE };
/** Logical canvas: scenes lay out in these px at every output scale (set per project in src/config.ts). */
export { W, H } from '../config';
import { W, H } from '../config';
/** Physical (output) size: the logical canvas times SCALE (`?scale=2` → 2x W x H). */
export const PW = W * SCALE;
export const PH = H * SCALE;

/**
 * Supersampling shared across motion-blur sub-frames. Shaders that supersample internally with the
 * 4 rotated-grid taps (`rgss(k)`) take only tap `ssTap` when it is >= 0: the engine cycles the taps
 * over a frame's sub-frames (always a multiple of 4 of them), which averages to the same image for a
 * quarter of the shading cost. -1 (preview, single-sample stills): take all four.
 * Usage: `uniforms: { ssTap: SS_TAP }` and `${SS_TAP_GLSL}` in the shader, then
 * `for (int k = ssK0(); k < ssK1(); k++) col += shade(px + rgss(k)); col *= ssWeight();`
 */
export const SS_TAP: THREE.IUniform<number> = { value: -1 };
/** GLSL: the ssTap uniform, and loop bounds and weight for the taps this sub-frame takes. */
export const SS_TAP_GLSL = /* glsl */ `
uniform int ssTap;
int ssK0() { return ssTap < 0 ? 0 : ssTap; }
int ssK1() { return ssTap < 0 ? 4 : ssTap + 1; }
float ssWeight() { return ssTap < 0 ? 0.25 : 1.0; }`;

export { SUBFRAME } from './subframe';
import { SUBFRAME } from './subframe';

/** The rgss(k) taps of glsl/common.ts, in px. */
const RGSS: readonly [number, number][] = [[0.125, -0.375], [0.375, 0.125], [-0.125, 0.375], [-0.375, -0.125]];
const savedProj = new THREE.Matrix4();

/**
 * Sub-pixel camera jitter: in a multi-sample export every render through a perspective camera is shifted by one of the
 * 4 rotated-grid taps (in px of the target it renders into), one per quarter of the shutter (SUBFRAME.s), so meshes get
 * the same 4x supersampling as the shaders that take rgss taps: anti-aliased edges for free. The camera's own matrices
 * are left as they were (toUV and the like see the unjittered view). Orthographic cameras (fullscreen passes, 2D layers)
 * are left alone unless `cam.userData.jitter = true` (an orthographic 3D view, e.g. isometric); `cam.userData.jitter =
 * false` opts a perspective camera out (a light's depth view). Cube targets are never jittered.
 */
function jitterRenders(r: THREE.WebGLRenderer) {
  const render = r.render.bind(r);
  r.render = (scene: THREE.Object3D, cam: THREE.Camera) => {
    const k = SUBFRAME.s < 0 ? -1 : Math.min(3, Math.floor(SUBFRAME.s * 4)), rt = r.getRenderTarget();
    const on = k >= 0 && ((cam.userData.jitter as boolean | undefined) ?? (cam as THREE.PerspectiveCamera).isPerspectiveCamera === true);
    if (!on || (rt as { isWebGLCubeRenderTarget?: boolean } | null)?.isWebGLCubeRenderTarget) return render(scene, cam);
    const [ox, oy] = RGSS[k]!, w = rt ? rt.width : PW, h = rt ? rt.height : PH;
    const p = cam.projectionMatrix, e = p.elements;
    savedProj.copy(p);
    // clip.xy += ndcOffset * clip.w: rows 0 and 1 of the projection += offset * row 3 (perspective and orthographic alike)
    for (let j = 0; j < 4; j++) { e[j * 4] = e[j * 4]! + (2 * ox / w) * e[j * 4 + 3]!; e[j * 4 + 1] = e[j * 4 + 1]! + (2 * oy / h) * e[j * 4 + 3]!; }
    cam.projectionMatrixInverse.copy(p).invert();
    try { render(scene, cam); } finally { p.copy(savedProj); cam.projectionMatrixInverse.copy(p).invert(); }
  };
}

/**
 * The engine's renderer on `canvas` (PW x PH). Alpha and a half-float drawing buffer: the canvas doubles as the float
 * surface library/kit/sfx.ts copies engine textures into WebGPU through (drawingBufferStorage needs alpha); the engine's final
 * blit writes alpha 1, so it shows and reads back exactly as an opaque canvas. Renders through 3D cameras are jittered
 * per sub-frame (jitterRenders).
 */
export function makeRenderer(canvas: HTMLCanvasElement) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  r.setPixelRatio(1);
  r.setSize(PW, PH, false);
  const gl = r.getContext() as WebGL2RenderingContext & { drawingBufferStorage?(format: number, w: number, h: number): void };
  if (gl.getExtension('EXT_color_buffer_float') && gl.drawingBufferStorage) gl.drawingBufferStorage(gl.RGBA16F, PW, PH);
  jitterRenders(r);
  return r;
}

const RT_SCALE = new WeakMap<THREE.WebGLRenderTarget, number>();
/** Physical px per logical px of a render target made by makeRT (1 for other targets; SCALE for the canvas). */
export function rtScale(rt: THREE.WebGLRenderTarget | null) { return rt ? RT_SCALE.get(rt) ?? 1 : SCALE; }
/** Record a target's physical px per logical px (for targets not made by makeRT, e.g. a pooled one reused at another scale). */
export function setRtScale(rt: THREE.WebGLRenderTarget, s: number) { RT_SCALE.set(rt, s); }

/**
 * HDR render target. `w`,`h` are LOGICAL px: the target is allocated at w*SCALE x h*SCALE
 * (pass `pxScale: 1` for data-sized targets whose resolution must not follow the output scale).
 */
export function makeRT(w = W, h = H, opts: Partial<THREE.RenderTargetOptions> & { pxScale?: number } = {}) {
  const { pxScale = SCALE, ...o } = opts;
  const rt = new THREE.WebGLRenderTarget(Math.max(1, Math.round(w * pxScale)), Math.max(1, Math.round(h * pxScale)), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    ...o,
  });
  RT_SCALE.set(rt, pxScale);
  return rt;
}

const FS_VERT = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

let fsGeom: THREE.BufferGeometry | null = null;
function fullscreenGeometry() {
  if (!fsGeom) {
    fsGeom = new THREE.BufferGeometry();
    fsGeom.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  }
  return fsGeom;
}

/**
 * A fullscreen fragment-shader pass. Write `frag` as the body of a GLSL ES 3.0 shader that
 * declares its own uniforms and `void main()` writing `fragColor`. `vUv` (0..1) is provided,
 * and GLSL_COMMON (noise, hashes, sdf, palette, hatch helpers) is prepended.
 */
export class FSPass {
  mat: THREE.RawShaderMaterial;
  mesh: THREE.Mesh;
  scene = new THREE.Scene();
  cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  constructor(frag: string, uniforms: Record<string, THREE.IUniform> = {}, opts: { blending?: THREE.Blending; transparent?: boolean } = {}) {
    this.mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: `precision highp float;\nin vec3 position;\n${FS_VERT}`,
      fragmentShader: `precision highp float;\nprecision highp int;\nin vec2 vUv;\nout vec4 fragColor;\n${GLSL_COMMON}\n${frag}`,
      uniforms,
      depthTest: false,
      depthWrite: false,
      blending: opts.blending ?? THREE.NoBlending,
      transparent: opts.transparent ?? false,
    });
    this.mesh = new THREE.Mesh(fullscreenGeometry(), this.mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }
  get u() { return this.mat.uniforms; }
  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null, clear = false) {
    renderer.setRenderTarget(target);
    if (clear) renderer.clear();
    renderer.render(this.scene, this.cam);
  }
}

// ---- Compositor ----------------------------------------------------------------------------------------------------
// 合成器：把一张纹理当一个图层叠到渲染目标上，像 AE 的一个图层：混合模式、不透明度、着色、轨道遮罩、变换（位置 / 缩放 / 旋转 / 锚点）。
// 场景里用 this.ctx.comp（引擎只有一个），预合成见 engine/precomp.ts。
//
// 用法：
//   comp.draw(renderer, layer.upload(), out)                                    // 普通叠加（Layer2D：直通 alpha，默认）
//   comp.draw(renderer, rt.texture, out, { mode: 'add', premult: false })       // 渲染目标（已预乘）要 premult: false
//   comp.draw(renderer, tex, out, { mode: 'overlay', opacity: 0.8 })            // 读底色的模式（见下）
//   comp.draw(renderer, footage.texture, out, { premult: false, matte: text.upload(), matteMode: 'alpha' })   // 字当遮罩
//   comp.draw(renderer, card.texture, out, { premult: false, transform: { position: [960, 540], scale: 0.5, rotation: 15 } })
//
// 参数（都可选）：
//   mode       混合模式，默认 'normal'。
//              GL 固定管线（和以前完全一样）：normal、add（相加）、screen（滤色）、multiply（正片叠底，纹理应是白底图、premult 默认关）、
//              max（逐通道取大）、replace（直接写入 颜色 × 不透明度 × 遮罩，不混合）。
//              读底色（先把目标拷进一张临时渲染目标，再用着色器按 AE / Photoshop 公式算完写回）：overlay 叠加、softLight 柔光、
//              hardLight 强光、colorDodge 颜色减淡、colorBurn 颜色加深、darken 变暗、lighten 变亮、difference 差值、exclusion 排除。
//              线性 HDR 下怎么算见下面 READ_FRAG 前的说明。目标不能是画布本身（null），要是渲染目标。
//   opacity    不透明度 0–1。tint：颜色乘数（线性）。
//   premult    true（默认，multiply 除外）= 纹理是直通 alpha（Layer2D），着色器里预乘；渲染目标的纹理已经预乘，传 false。
//   scale、offset  旧的 UV 变换：scale > 1 缩小（纹理显得更小），offset 按 UV 平移；超出 0–1 的部分不画。有 transform 时在图层自己的纹理里生效（裁切、推拉）。
//   matte      轨道遮罩：一张纹理，按目标的 UV 取（和画面对齐，AE 的遮罩层就是它在合成里的样子），通常是全幅 Layer2D 或渲染目标。
//   matteMode  'alpha'（默认）用遮罩的 alpha；'alphaInv' 反过来；'luma' 用亮度（显示空间 Rec.709 亮度 × alpha，
//              所以 50% 灰 = 露出一半，和 AE 一致）；'lumaInv' 反过来。所有混合模式都能配。
//   mattePremult  和 premult 同义，说的是遮罩纹理：true（默认）= 直通 alpha（Layer2D），渲染目标传 false。
//   transform  图层变换，全部按逻辑像素（y 向下），像 AE 图层的变换属性：
//              position  锚点落在目标的哪里（默认目标中心）；anchor  图层上的轴心，图层像素（默认图层中心）；
//              scale  1 = 100%，[sx, sy] 不等比，负数翻转；rotation  角度，顺时针为正（同 AE）；
//              size  图层的逻辑尺寸，默认 纹理像素 / SCALE（对 Layer2D、makeRT 的默认分辨率都对；new Layer2D(w, h, 1) 这类低分辨率
//              纹理或预合成要显式给，Precomp.draw 会自动填）。
//              图层边缘按物理像素算覆盖率做抗锯齿（旋转的边不锯齿；不旋转、对齐整像素时边缘和不变换一样硬）。
//              缩得很小时没有 mipmap 会闪：预合成可以开 mipmaps（engine/precomp.ts）。
//              replace 配 transform：图层以外不动，图层内（含抗锯齿的边）直接写入，不和底下混合。
//              matrix  透视变换：图层像素 → 目标逻辑像素的 3×3 矩阵（行优先 9 个数，齐次坐标），给了就不看上面几项（size 照样要）。
//              3D 图层、卡片翻转用它，一般由 engine/layers.ts 算好传进来；边缘按屏幕上的实际覆盖率抗锯齿。
//
// 运动模糊：变换、遮罩都是传进来的数，按 f.t 算出来就行，子帧平均自然出拖影。
// 性能：固定管线模式和以前一样一个全屏 pass；读底色的模式多一次整幅拷贝（1080p 半精度约 16 MB 读写，通常 < 0.2 ms），
// 临时渲染目标按（尺寸、格式）懒建、复用，不随 draw 次数增长。

/** GL fixed-function blend modes: no read-back, unchanged since pdoom. */
export type FixedBlendMode = 'normal' | 'add' | 'screen' | 'multiply' | 'max' | 'replace';
/** Modes that read the target (a copy of it) and blend in a shader with the AE / Photoshop formulas. */
export type ReadBlendMode = 'overlay' | 'softLight' | 'hardLight' | 'colorDodge' | 'colorBurn' | 'darken' | 'lighten' | 'difference' | 'exclusion';
export type BlendMode = FixedBlendMode | ReadBlendMode;
/** The read-back modes, in the order of the shader's `mode` uniform. */
export const READ_BLEND_MODES: readonly ReadBlendMode[] = ['overlay', 'softLight', 'hardLight', 'colorDodge', 'colorBurn', 'darken', 'lighten', 'difference', 'exclusion'];
export type MatteMode = 'alpha' | 'alphaInv' | 'luma' | 'lumaInv';
const MATTE_MODES: readonly MatteMode[] = ['alpha', 'alphaInv', 'luma', 'lumaInv'];

/** AE-style layer transform, logical px with y down (see the Compositor notes above). */
export interface LayerTransform {
  /** Where the anchor lands in the target (default: the target's centre). */
  position?: [number, number];
  /** The pivot in layer px from the layer's top-left (default: the layer's centre). */
  anchor?: [number, number];
  /** 1 = 100 %; [sx, sy] non-uniform; negative flips. */
  scale?: number | [number, number];
  /** Degrees, clockwise. */
  rotation?: number;
  /** The layer's logical size (default: texture px / SCALE). */
  size?: [number, number];
  /**
   * Projective transform instead of position / anchor / scale / rotation: layer px → target logical px, a 3x3 matrix in
   * row-major order acting on [x, y, 1] (the result divided by its third component). engine/layers.ts builds it for 3D layers.
   */
  matrix?: readonly number[];
  /**
   * With `matrix`: where the depth comes from when it is not the matrix itself (a corner-pinned layer on a 3D parent:
   * the parent's matrix, whose third row is the depth of the plane both lie on). Depth test and depth write use it.
   */
  depthMatrix?: readonly number[];
}

export interface CompositeOpts {
  mode?: BlendMode;
  opacity?: number;
  tint?: [number, number, number];
  scale?: [number, number];
  offset?: [number, number];
  premult?: boolean;
  matte?: THREE.Texture | null;
  matteMode?: MatteMode;
  mattePremult?: boolean;
  transform?: LayerTransform;
  /**
   * Depth test for a projective transform (a 3D layer): a texture over the target whose red channel is the scene's depth
   * along the view axis in the same units as the matrix's third row (comp px, engine/layers.ts); the layer is hidden
   * where it lies behind it. engine/layers.ts fills it from a three layer below.
   */
  depth?: THREE.Texture | null;
}

/**
 * The shared body of the extended passes (matte / transform / read-back modes). Same sampling as the legacy shader when
 * neither transform nor matte is on; with a transform, the fragment's target px are mapped back into the layer (xf) and
 * the layer's edge gets a coverage ramp one physical px wide.
 */
const EXT_HEAD = /* glsl */ `
  uniform sampler2D tex; uniform float opacity; uniform vec3 tint; uniform vec4 uvXform; uniform bool premult;
  uniform bool useXf; uniform bool persp; uniform mat3 xf; uniform vec2 layerPx, targetPx, edgePx;
  uniform bool useMatte; uniform sampler2D matte; uniform int matteMode; uniform bool mattePremult;
  // (highp: samplers default to lowp in GLSL ES, and some backends really read a float depth at half precision)
  uniform bool useDepth; uniform highp sampler2D depthTex; uniform bool useZxf; uniform mat3 zxf;
  // the plane's 1 / depth at this fragment: from xf's third row, or from the depth matrix's
  float invDepth(vec3 hq) { return useZxf ? (zxf * vec3(vUv.x * targetPx.x, (1.0 - vUv.y) * targetPx.y, 1.0)).z : hq.z; }
  float lumaD(vec3 c) { return dot(toSRGB(clamp(c, 0.0, 1.0)), vec3(0.2126, 0.7152, 0.0722)); }
  // the layer's colour at this fragment, and its coverage (opacity x matte x edge); false = outside the layer
  bool layerSample(out vec4 c, out float k) {
    vec2 uv = vUv; float cov = 1.0;
    if (useXf) {
      vec3 hq = xf * vec3(vUv.x * targetPx.x, (1.0 - vUv.y) * targetPx.y, 1.0);       // target px -> layer px
      vec2 q, d;
      if (persp) {
        // projective: divide, and measure the edge distance in screen px through the derivatives (exact for affine too)
        q = hq.xy / max(hq.z, 1e-6);
        vec2 g = vec2(length(vec2(dFdx(q.x), dFdy(q.x))), length(vec2(dFdx(q.y), dFdy(q.y))));
        d = min(q, layerPx - q) / max(g, vec2(1e-6));
        if (hq.z <= 1e-6) d = vec2(-1.0);
      } else {
        q = hq.xy;
        d = min(q, layerPx - q) * edgePx;                                              // distance inside the edges, physical px
      }
      cov = clamp(min(d.x, d.y) + 0.5, 0.0, 1.0);
      // depth test (3D layers in a three scene): the layer plane's depth here is 1 / hq.z (xf is the inverse of a matrix
      // whose third row gives the depth along the view axis)
      float iz = invDepth(hq);
      if (useDepth && persp && iz > 1e-9) {
        float zl = 1.0 / iz, zs = texture(depthTex, vUv).r;
        if (zl > zs + max(0.5, zs * 2e-4)) cov = 0.0;
      }
      uv = clamp(q / layerPx, 0.0, 1.0); uv.y = 1.0 - uv.y;
    }
    uv = (uv - 0.5) * uvXform.xy + 0.5 + uvXform.zw;
    c = texture(tex, uv);
    k = 0.0;
    if (cov <= 0.0 || uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return false;
    float m = 1.0;
    if (useMatte) {
      vec4 mt = texture(matte, vUv);
      if (matteMode < 2) m = clamp(mt.a, 0.0, 1.0);
      else m = clamp(lumaD(mattePremult ? mt.rgb : mt.rgb / max(mt.a, 1e-4)) * clamp(mt.a, 0.0, 1.0), 0.0, 1.0);
      if (matteMode == 1 || matteMode == 3) m = 1.0 - m;
    }
    k = opacity * m * cov;
    return true;
  }`;

/**
 * Depth write for a projective layer (a 3D layer): where it covers more than half (alpha x opacity x edge), its plane's
 * depth along the view axis (1 / hq.z, the matrix's third row) goes into the target's red channel; MIN blending keeps
 * the nearest. engine/layers.ts uses it so 3D layers hide each other per pixel.
 */
const DEPTH_FRAG = /* glsl */ `${EXT_HEAD}
  void main() {
    vec4 c; float k;
    if (!persp || !layerSample(c, k)) discard;
    vec3 hq = xf * vec3(vUv.x * targetPx.x, (1.0 - vUv.y) * targetPx.y, 1.0);
    float iz = invDepth(hq);
    if (c.a * k < 0.5 || iz <= 1e-9) discard;
    float z = 1.0 / iz;
    fragColor = vec4(z, z, z, z);
  }`;

/** Fixed-function modes with a matte or a transform: the legacy output times the coverage, same GL blending. */
const FIXED_EXT_FRAG = /* glsl */ `${EXT_HEAD}
  void main() {
    vec4 c; float k;
    if (!layerSample(c, k)) discard;
    c.rgb *= tint;
    if (premult) c.rgb *= c.a;
    fragColor = c * k;
  }`;

/*
 * 读底色的混合模式在线性 HDR 下怎么算（取舍）：
 * - 公式在显示空间算。AE（默认不开线性混合）和 Photoshop 都在 gamma 编码的值上套公式，叠加的分界 0.5 是「看起来的中灰」
 *   （线性约 0.21）。直接在线性值上套，叠加 / 柔光会整体偏暗、分界跑到很亮的地方，和直觉对不上。所以两层先截到 0–1，
 *   用 sRGB 曲线编码，按公式算，再和底层按覆盖率（alpha × 不透明度 × 遮罩）在显示空间混合（Photoshop 的不透明度也是这样），
 *   最后解回线性。0–1 以内的内容结果和 Photoshop / CSS mix-blend-mode 一样。
 * - 超过 1 的部分（高光余量 = max(x − 1, 0)，线性）不进公式，单独走：底层的余量乘「白色底在这个上层下还剩多亮」
 *   （B(1, 上层)，解回线性），上层的余量乘「白色上层在这个底上显出多亮」（B(底层, 1)），两者取大加回去，再按覆盖率和底层的余量混合。
 *   效果：叠加、柔光、减淡、加深不会压暗白色，底层的灯照样那么亮（继续触发泛光）；强光、减淡下发光的上层照样发光；
 *   深色上层压暗高光时余量按同样比例压掉；差值 / 排除下白色上层把底层的余量吃掉（白底变黑）。
 *   取大不相加：两层都有余量时不叠加，结果的余量不超过两层里大的那个，不会凭空造出高光。
 * - 变暗、变亮：sRGB 编码是单调的，min / max 在哪个空间取都一样；余量变亮取大、变暗取小，HDR 下也精确。
 * - 低于 0 的值（个别着色器的负数）截到 0。
 * 代价：同样 50% 的不透明度，这些模式在显示空间混合，normal / add / screen / multiply 在线性空间混合（引擎一直如此），
 * 半透明边缘的观感略有差别；要线性空间的效果，用固定管线的模式。
 * 透明的目标（预合成）按 W3C Compositing 处理：底层透明处上层按 normal 显示，结果 alpha = 上 + 下 × (1 − 上)。
 */
const READ_FRAG = /* glsl */ `${EXT_HEAD}
  uniform sampler2D dst; uniform int mode;
  float softD(float b) { return b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b); }
  float blend1(float b, float s) {
    if (mode == 0) return b <= 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);              // overlay
    if (mode == 1) return s <= 0.5 ? b - (1.0 - 2.0 * s) * b * (1.0 - b) : b + (2.0 * s - 1.0) * (softD(b) - b);   // soft light (W3C / PDF)
    if (mode == 2) return s <= 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);              // hard light
    if (mode == 3) return b <= 0.0 ? 0.0 : s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s));               // color dodge
    if (mode == 4) return b >= 1.0 ? 1.0 : s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s);         // color burn
    if (mode == 5) return min(b, s);                                                                // darken
    if (mode == 6) return max(b, s);                                                                // lighten
    if (mode == 7) return abs(b - s);                                                               // difference
    return b + s - 2.0 * b * s;                                                                     // exclusion
  }
  vec3 blend(vec3 b, vec3 s) { return vec3(blend1(b.r, s.r), blend1(b.g, s.g), blend1(b.b, s.b)); }
  void main() {
    vec4 c; float k;
    if (!layerSample(c, k)) discard;
    float a = clamp(c.a, 0.0, 1.0) * k;
    if (a <= 0.0) discard;
    vec3 cs = (premult ? c.rgb : c.rgb / max(c.a, 1e-4)) * tint;
    vec4 bt = texelFetch(dst, ivec2(gl_FragCoord.xy), 0);
    float ab = clamp(bt.a, 0.0, 1.0);
    vec3 cb = ab > 0.0 ? bt.rgb / ab : vec3(0.0);
    // SDR part in display space, HDR headroom in linear
    vec3 sb = toSRGB(clamp(cb, 0.0, 1.0)), ss = toSRGB(clamp(cs, 0.0, 1.0));
    vec3 hb = max(cb - 1.0, 0.0), hs = max(cs - 1.0, 0.0);
    vec3 r = blend(sb, ss);
    vec3 h = mode == 5 ? min(hb, hs) : max(hb * toLinear(blend(vec3(1.0), ss)), hs * toLinear(blend(sb, vec3(1.0))));
    // source over backdrop (W3C): the blended colour where the backdrop is, the plain source where it is empty
    vec3 mD = mix(ss, r, ab), mH = mix(hs, h, ab);
    float ao = a + ab * (1.0 - a);
    vec3 oD = (a * mD + (1.0 - a) * ab * sb) / ao, oH = (a * mH + (1.0 - a) * ab * hb) / ao;
    fragColor = vec4((toLinear(oD) + oH) * ao, ao);
  }`;

/** Draws a texture over a target as a layer: blend mode, opacity, tint, track matte, transform (see the notes above). */
export class Compositor {
  private passes = new Map<BlendMode, FSPass>();
  private frag = /* glsl */ `
    uniform sampler2D tex; uniform float opacity; uniform vec3 tint; uniform vec4 uvXform; uniform bool premult;
    void main() {
      vec2 uv = (vUv - 0.5) * uvXform.xy + 0.5 + uvXform.zw;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
      vec4 c = texture(tex, uv);
      c.rgb *= tint;
      if (premult) c.rgb *= c.a;
      fragColor = vec4(c.rgb, c.a) * opacity;
    }`;
  /** The GL blend state of a fixed-function mode. */
  private static fixedBlend(m: THREE.RawShaderMaterial, mode: FixedBlendMode) {
    m.blendEquation = THREE.AddEquation;
    if (mode === 'normal') { m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor; m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor; }
    if (mode === 'add') { m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneFactor; m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor; }
    if (mode === 'screen') { m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcColorFactor; m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor; }
    if (mode === 'multiply') { m.blendSrc = THREE.DstColorFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor; m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor; }
    if (mode === 'max') { m.blendEquation = THREE.MaxEquation; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneFactor; }
    if (mode === 'replace') { m.blending = THREE.NoBlending; }
  }
  private get(mode: FixedBlendMode) {
    let p = this.passes.get(mode);
    if (!p) {
      const u = { tex: { value: null }, opacity: { value: 1 }, tint: { value: new THREE.Vector3(1, 1, 1) }, uvXform: { value: new THREE.Vector4(1, 1, 0, 0) }, premult: { value: true } };
      p = new FSPass(this.frag, u, { blending: THREE.CustomBlending, transparent: true });
      Compositor.fixedBlend(p.mat, mode);
      this.passes.set(mode, p);
    }
    return p;
  }

  // extended passes (matte / transform / read-back), built on first use
  private extPasses = new Map<FixedBlendMode, FSPass>();
  private readPass: FSPass | null = null;
  private copyPass: FSPass | null = null;
  private depthPass: FSPass | null = null;
  /** Backdrop copies for the read-back modes, one per (size, type, format), reused. */
  private backdrops = new Map<string, THREE.WebGLRenderTarget>();
  private static extUniforms(): Record<string, THREE.IUniform> {
    return {
      tex: { value: null }, opacity: { value: 1 }, tint: { value: new THREE.Vector3(1, 1, 1) }, uvXform: { value: new THREE.Vector4(1, 1, 0, 0) }, premult: { value: true },
      useXf: { value: false }, persp: { value: false }, xf: { value: new THREE.Matrix3() }, layerPx: { value: new THREE.Vector2(1, 1) }, targetPx: { value: new THREE.Vector2(1, 1) }, edgePx: { value: new THREE.Vector2(1, 1) },
      useMatte: { value: false }, matte: { value: null }, matteMode: { value: 0 }, mattePremult: { value: true },
      useDepth: { value: false }, depthTex: { value: null }, useZxf: { value: false }, zxf: { value: new THREE.Matrix3() },
    };
  }
  private getExt(mode: FixedBlendMode) {
    let p = this.extPasses.get(mode);
    if (!p) {
      p = new FSPass(FIXED_EXT_FRAG, Compositor.extUniforms(), { blending: THREE.CustomBlending, transparent: true });
      Compositor.fixedBlend(p.mat, mode);
      this.extPasses.set(mode, p);
    }
    return p;
  }
  private getRead() {
    return (this.readPass ??= new FSPass(READ_FRAG, { ...Compositor.extUniforms(), dst: { value: null }, mode: { value: 0 } }));
  }
  /** A copy of `target` (same size, type and format) in a reused scratch target: what the read-back modes blend over. */
  private backdrop(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget) {
    const t = target.texture, key = `${target.width}x${target.height}:${t.type}:${t.format}:${t.internalFormat ?? ''}`;
    let rt = this.backdrops.get(key);
    if (!rt) {
      rt = new THREE.WebGLRenderTarget(target.width, target.height, {
        type: t.type, format: t.format as THREE.PixelFormat, internalFormat: t.internalFormat, depthBuffer: false,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
      });
      this.backdrops.set(key, rt);
    }
    this.copyPass ??= new FSPass(`uniform sampler2D src; void main() { fragColor = texelFetch(src, ivec2(gl_FragCoord.xy), 0); }`, { src: { value: null } });
    this.copyPass.u.src!.value = t;
    this.copyPass.render(renderer, rt);
    return rt;
  }
  /** Fill the extended uniforms; false when the layer cannot show (zero scale). */
  private setExt(p: FSPass, tex: THREE.Texture, target: THREE.WebGLRenderTarget | null, o: CompositeOpts) {
    const u = p.u;
    u.tex!.value = tex;
    u.opacity!.value = o.opacity ?? 1;
    (u.tint!.value as THREE.Vector3).set(...(o.tint ?? [1, 1, 1]));
    (u.uvXform!.value as THREE.Vector4).set(o.scale?.[0] ?? 1, o.scale?.[1] ?? 1, o.offset?.[0] ?? 0, o.offset?.[1] ?? 0);
    u.premult!.value = o.premult ?? o.mode !== 'multiply';
    u.useMatte!.value = !!o.matte;
    u.matte!.value = o.matte ?? null;
    u.matteMode!.value = Math.max(0, MATTE_MODES.indexOf(o.matteMode ?? 'alpha'));
    u.mattePremult!.value = o.mattePremult ?? true;
    const xf = o.transform;
    u.useXf!.value = !!xf;
    u.persp!.value = false;
    u.useDepth!.value = !!(o.depth && xf?.matrix);
    u.depthTex!.value = o.depth ?? null;
    u.useZxf!.value = false;
    const dm = xf?.matrix && xf.depthMatrix;
    if (dm) {
      const zi = new THREE.Matrix3().set(dm[0]!, dm[1]!, dm[2]!, dm[3]!, dm[4]!, dm[5]!, dm[6]!, dm[7]!, dm[8]!);
      if (Math.abs(zi.determinant()) > 1e-12) { (u.zxf!.value as THREE.Matrix3).copy(zi.invert()); u.useZxf!.value = true; }
    }
    if (!xf) return true;
    const ts = rtScale(target), tw = (target ? target.width : PW) / ts, th = (target ? target.height : PH) / ts;
    const img = tex.image as { width?: number; height?: number; videoWidth?: number; videoHeight?: number } | null | undefined;
    const lw = xf.size?.[0] ?? (img?.videoWidth || img?.width || PW) / SCALE, lh = xf.size?.[1] ?? (img?.videoHeight || img?.height || PH) / SCALE;
    if (xf.matrix) {
      const m = xf.matrix, inv = new THREE.Matrix3().set(m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!, m[6]!, m[7]!, m[8]!);
      if (!(Math.abs(inv.determinant()) > 1e-12 && lw > 0 && lh > 0)) return false;
      (u.xf!.value as THREE.Matrix3).copy(inv.invert());
      u.persp!.value = true;
      (u.layerPx!.value as THREE.Vector2).set(lw, lh);
      (u.targetPx!.value as THREE.Vector2).set(tw, th);
      return true;
    }
    const [px, py] = xf.position ?? [tw / 2, th / 2];
    const [ax, ay] = xf.anchor ?? [lw / 2, lh / 2];
    const [sx, sy] = typeof xf.scale === 'number' ? [xf.scale, xf.scale] : xf.scale ?? [1, 1];
    if (!(Math.abs(sx) > 1e-9 && Math.abs(sy) > 1e-9 && lw > 0 && lh > 0)) return false;
    const r = ((xf.rotation ?? 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    // forward: p = P + R·S·(q − A) (R clockwise on screen, y down); inverse: q = A + S⁻¹·Rᵀ·(p − P)
    (u.xf!.value as THREE.Matrix3).set(
      c / sx, s / sx, ax - (c * px + s * py) / sx,
      -s / sy, c / sy, ay - (-s * px + c * py) / sy,
      0, 0, 1,
    );
    (u.layerPx!.value as THREE.Vector2).set(lw, lh);
    (u.targetPx!.value as THREE.Vector2).set(tw, th);
    (u.edgePx!.value as THREE.Vector2).set(Math.abs(sx) * ts, Math.abs(sy) * ts);
    return true;
  }
  /**
   * Write a projective layer's depth into `target` (a float target, red = depth along the view axis, nearest kept):
   * `o.transform.matrix` as for draw(); `o.depth` still hides it behind what is already there. engine/layers.ts.
   */
  drawDepth(renderer: THREE.WebGLRenderer, tex: THREE.Texture, target: THREE.WebGLRenderTarget, o: CompositeOpts) {
    if (!o.transform?.matrix) return;
    if (!this.depthPass) {
      this.depthPass = new FSPass(DEPTH_FRAG, Compositor.extUniforms(), { blending: THREE.CustomBlending });
      const m = this.depthPass.mat;
      m.blendEquation = THREE.MinEquation; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneFactor;
      m.blendEquationAlpha = THREE.MinEquation; m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneFactor;
    }
    // (no matte here: a matte decides what shows, not what is solid in space)
    if (this.setExt(this.depthPass, tex, target, { ...o, matte: null })) this.depthPass.render(renderer, target);
  }

  /**
   * Draw `tex` over `target` (see the notes above the class for every option). Without `matte` and `transform` a
   * fixed-function mode takes exactly the old path.
   */
  draw(renderer: THREE.WebGLRenderer, tex: THREE.Texture, target: THREE.WebGLRenderTarget | null, o: CompositeOpts = {}) {
    const mode = o.mode ?? 'normal';
    const read = READ_BLEND_MODES.indexOf(mode as ReadBlendMode);
    if (read < 0 && !o.matte && !o.transform) {
      const p = this.get(mode as FixedBlendMode);
      p.u.tex!.value = tex;
      p.u.opacity!.value = o.opacity ?? 1;
      (p.u.tint!.value as THREE.Vector3).set(...(o.tint ?? [1, 1, 1]));
      (p.u.uvXform!.value as THREE.Vector4).set(o.scale?.[0] ?? 1, o.scale?.[1] ?? 1, o.offset?.[0] ?? 0, o.offset?.[1] ?? 0);
      p.u.premult!.value = o.premult ?? o.mode !== 'multiply';
      p.render(renderer, target);
      return;
    }
    if (read < 0) {
      const p = this.getExt(mode as FixedBlendMode);
      if (this.setExt(p, tex, target, o)) p.render(renderer, target);
      return;
    }
    if (!target) throw new Error(`Compositor: mode '${mode}' reads the target; draw into a render target, not the canvas`);
    const p = this.getRead();
    if (!this.setExt(p, tex, target, o)) return;
    const bd = this.backdrop(renderer, target);
    // (a layer or matte that is the target itself is read from the copy: no feedback loop)
    if (tex === target.texture) p.u.tex!.value = bd.texture;
    if (o.matte && o.matte === target.texture) p.u.matte!.value = bd.texture;
    p.u.dst!.value = bd.texture;
    p.u.mode!.value = read;
    p.render(renderer, target);
  }
}

/**
 * Make a 2D context draw in logical px on a backing store `s` times larger: a base transform of
 * `s`, and setTransform/resetTransform/getTransform, shadowBlur/shadowOffsetX/Y and `filter` px
 * lengths (which ignore the CTM) patched to work in logical px. Text, lineWidth, letterSpacing and
 * dashes follow the CTM by themselves. getImageData/putImageData still work in backing-store px.
 */
export function scaleContext2D(c: CanvasRenderingContext2D, s: number) {
  if (s === 1) return c;
  const proto = CanvasRenderingContext2D.prototype;
  const setT = proto.setTransform as (this: CanvasRenderingContext2D, a: number, b: number, c: number, d: number, e: number, f: number) => void;
  const getT = proto.getTransform;
  c.setTransform = function (this: CanvasRenderingContext2D, a?: number | DOMMatrix2DInit, b?: number, cc?: number, d?: number, e?: number, f?: number) {
    if (typeof a === 'number') return setT.call(this, a * s, b! * s, cc! * s, d! * s, e! * s, f! * s);
    const m = new DOMMatrix([(a?.a ?? a?.m11 ?? 1), (a?.b ?? a?.m12 ?? 0), (a?.c ?? a?.m21 ?? 0), (a?.d ?? a?.m22 ?? 1), (a?.e ?? a?.m41 ?? 0), (a?.f ?? a?.m42 ?? 0)]);
    return setT.call(this, m.a * s, m.b * s, m.c * s, m.d * s, m.e * s, m.f * s);
  } as CanvasRenderingContext2D['setTransform'];
  c.resetTransform = function (this: CanvasRenderingContext2D) { setT.call(this, s, 0, 0, s, 0, 0); };
  c.getTransform = function (this: CanvasRenderingContext2D) {
    const m = getT.call(this);
    return new DOMMatrix([m.a / s, m.b / s, m.c / s, m.d / s, m.e / s, m.f / s]);
  };
  for (const k of ['shadowBlur', 'shadowOffsetX', 'shadowOffsetY'] as const) {
    const d = Object.getOwnPropertyDescriptor(proto, k)!;
    Object.defineProperty(c, k, { configurable: true, get() { return d.get!.call(this) / s; }, set(v: number) { d.set!.call(this, v * s); } });
  }
  const fd = Object.getOwnPropertyDescriptor(proto, 'filter')!;
  const px = (v: string, k: number) => v.replace(/(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)px/gi, (_, n: string) => `${+n * k}px`);
  Object.defineProperty(c, 'filter', { configurable: true, get() { return px(fd.get!.call(this), 1 / s); }, set(v: string) { fd.set!.call(this, px(String(v), s)); } });
  setT.call(c, s, 0, 0, s, 0, 0);
  return c;
}

/**
 * A W x H (logical) Canvas2D surface uploaded as an sRGB texture (decoded to linear when sampled).
 * Draw in CSS pixels with origin top-left. Call `upload()` after drawing each frame.
 * The backing canvas is SCALE times larger (`canvas.width` = w*SCALE); the context is pre-scaled
 * (see scaleContext2D), so drawing code works in logical px at every output scale.
 */
export class Layer2D {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  /** `scale`: backing px per drawing px (default SCALE; pass 1 for a deliberately low-res layer, e.g. a soft glow). */
  constructor(public w = W, public h = H, scale = SCALE) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(w * scale);
    this.canvas.height = Math.round(h * scale);
    this.ctx = scaleContext2D(this.canvas.getContext('2d')!, scale);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.flipY = true;
  }
  clear(color?: string) {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.filter = 'none';
    c.shadowBlur = 0;
    c.textAlign = 'left';            // (text state survives between frames on the same canvas: reset it)
    c.textBaseline = 'alphabetic';
    if (color) { c.fillStyle = color; c.fillRect(0, 0, this.w, this.h); }
    else c.clearRect(0, 0, this.w, this.h);
  }
  upload() { this.texture.needsUpdate = true; return this.texture; }
}

/** Clear a render target to a linear colour. */
export function clearRT(renderer: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget | null, rgb: [number, number, number] = [0, 0, 0], a = 1) {
  const prev = renderer.getClearColor(new THREE.Color()).clone();
  const prevA = renderer.getClearAlpha();
  renderer.setRenderTarget(rt);
  renderer.setClearColor(new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace), a);
  renderer.clear(true, true, true);
  renderer.setClearColor(prev, prevA);
}

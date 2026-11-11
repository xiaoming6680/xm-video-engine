// 预合成（AE 的 Precompose）：把一组层渲进自己的画布，再当一个图层摆进画面——带变换（位置 / 缩放 / 旋转 / 锚点）、
// 混合模式、轨道遮罩，都走 Compositor.draw（engine/gl.ts 合成器一节）。
//
// 用法：
//   card = new Precomp(640, 360);                                   // 逻辑像素；分辨率默认跟输出缩放（4K 下自动两倍）
//   card.render(renderer, f.t, (t, out) => {                        // 往自己的画布里画：out 是它的渲染目标（已清成透明）
//     bgPass.u.t!.value = t; bgPass.render(renderer, out);
//     comp.draw(renderer, label.upload(), out);                     // 里面照样能叠图层、用变换和混合模式（可以再套预合成）
//   });
//   card.draw(renderer, comp, out, { transform: { position: [x, y], scale: 0.8, rotation: 12 }, mode: 'screen' });
//   // 也能当遮罩：comp.draw(renderer, footage, out, { matte: card.texture, mattePremult: false })
//
// 参数（new Precomp(w, h, opts)）：
//   w, h      画布的逻辑尺寸（默认整幅 W × H）。里面按这个尺寸排版：Layer2D 建成 new Layer2D(w, h, card.pxScale)，
//             全屏 FSPass 的 vUv × (w, h) 就是逻辑像素（FRAG_PX / PX_SCALE 按整幅输出缩放算，res ≠ 1 时不对）。
//   res       分辨率倍数，在输出缩放之上（默认 1）。2 = 超采样（要放大的图层不糊）；0.5 = 半分辨率（远处、柔的层省时间）。
//   mipmaps   图层缩得比自己小很多时开（缩小、移动时不闪）；每次 render() 结束生成一次。
//   depth     深度缓冲（默认开，画 3D 要）；clear  每次 render() 前的底色，线性 rgb + alpha，默认透明黑。
//
// render(renderer, t, fn)：先清底色，再调 fn(t, out)，返回纹理（预乘 alpha：draw 默认 premult: false）。
// draw(renderer, comp, target, opts)：opts 同 Compositor.draw；transform.size 自动填成 [w, h]，不给 transform 时放在目标中心、100%。
//
// 时间：预合成里的内容照样只取决于传进去的 t（技术约束和场景一样：确定性、子帧任意顺序）。时间重映射就是传换算过的 t：
//   冻结 card.render(r, 3.0, fn)；慢放 card.render(r, t0 + (f.t − t0) * 0.5, fn)；倒放 card.render(r, t1 − (f.t − t0), fn)。
//   同一个 Precomp 可以在一帧里先后渲不同的 t、各 draw 一次（画完就合成，下次 render 才覆盖）。
//   按拍步进、shutterT 传换算后的时间也行（导出时按子帧挪回这一帧；变速的时间在快门里差一点点）；frameIdx 要歌曲秒。
// 运动模糊：图层的变换按 f.t 算，导出时每个子帧重渲内容、重新摆位置，平均出来就是带拖影的图层；
//   冻结的内容每个子帧也会重渲（不做缓存，结果一样，只是多花时间）。
// 性能：每个 Precomp 一张渲染目标（整幅 1080p 半精度约 16 MB 显存，res 2 是 4 倍），render() 多一次清屏，draw() 一个全屏 pass。
import * as THREE from 'three';
import { SCALE, W, H, makeRT, clearRT, type Compositor, type CompositeOpts } from './gl';

export interface PrecompOpts {
  /** Resolution multiplier on top of the output scale (default 1). */
  res?: number;
  /** Mipmaps, generated once per render(): for a layer shown much smaller than its size. */
  mipmaps?: boolean;
  /** Depth buffer (default true: 3D content). */
  depth?: boolean;
  /** Clear colour before each render(), linear rgb + alpha (default transparent black). */
  clear?: [number, number, number, number];
}

export class Precomp {
  /** The precomp's own render target (logical w x h at pxScale physical px per logical px). */
  readonly rt: THREE.WebGLRenderTarget;
  /** Physical px per logical px (SCALE x res): give it to the Layer2Ds drawn inside. */
  readonly pxScale: number;
  private empty = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(readonly w = W, readonly h = H, private opts: PrecompOpts = {}) {
    this.pxScale = SCALE * (opts.res ?? 1);
    this.rt = makeRT(w, h, {
      pxScale: this.pxScale,
      depthBuffer: opts.depth ?? true,
      ...(opts.mipmaps ? { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter } : {}),
    });
  }

  /** The last render (premultiplied alpha). */
  get texture() { return this.rt.texture; }

  /** Clear, draw `fn(t, out)` into the precomp, return its texture. The content depends only on the `t` given here. */
  render(renderer: THREE.WebGLRenderer, t: number, fn: (t: number, out: THREE.WebGLRenderTarget) => void): THREE.Texture {
    const prev = renderer.getRenderTarget();
    const [r, g, b, a] = this.opts.clear ?? [0, 0, 0, 0];
    // (the clear binds the target first: it is allocated with its mip chain while generateMipmaps is still on)
    clearRT(renderer, this.rt, [r, g, b], a);
    const tex = this.rt.texture, mip = tex.generateMipmaps;
    tex.generateMipmaps = false;   // not after every draw inside fn: once, below
    try {
      fn(t, this.rt);
    } finally {
      tex.generateMipmaps = mip;
    }
    if (mip) {
      // three regenerates a target's mipmaps at the end of render(): an empty scene does just that
      const auto = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(this.rt);
      renderer.render(this.empty, this.cam);
      renderer.autoClear = auto;
    }
    renderer.setRenderTarget(prev);
    return tex;
  }

  /** Composite the last render into `target` as a layer (Compositor.draw options; transform.size is filled in). */
  draw(renderer: THREE.WebGLRenderer, comp: Compositor, target: THREE.WebGLRenderTarget | null, o: CompositeOpts = {}) {
    comp.draw(renderer, this.rt.texture, target, { premult: false, ...o, transform: { size: [this.w, this.h], ...(o.transform ?? {}) } });
  }

  dispose() { this.rt.dispose(); }
}

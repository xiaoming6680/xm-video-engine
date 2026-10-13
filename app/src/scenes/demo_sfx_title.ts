// 示例场景：shaders 库（kit/sfx.ts）做标题——影棚背景（StudioBackground）上一行挤出的 3D 镀铬字（Chrome +
// kit/sfx-shape.ts 的文字 SDF），进场时把上一个场景像纸一样翻走（PagePeel，handlesTransition）。`?sfx=showcase` 看。
// 两个 Sfx：标题本身，和只在转场时用的翻页（上一场景 f.under 做纸，标题画面在纸下面）。
import type * as THREE from 'three';
import { Scene, type Frame } from '../engine/scene';
import { makeRT, W, H } from '../engine/gl';
import { F, font } from '../engine/type';
import { ease, clamp } from '../engine/util';
import { Sfx } from '../kit/sfx';
import { sdfText } from '../kit/sfx-shape';

export default class DemoSfxTitle extends Scene {
  override handlesTransition = true;
  title!: Sfx;
  peel!: Sfx;
  titleRT = makeRT(W, H, { depthBuffer: false });

  override async init() {
    const { renderer, params } = this.ctx;
    const text = String(params.text ?? 'XM 基础引擎');
    const { url } = sdfText(text, { font: font(F.archivo(125, 900), 260), padding: 0.04 });
    this.title = new Sfx(renderer, [
      { type: 'StudioBackground', id: 'bg', props: { color: '#1b1f2a', keyColor: '#e9e4da' } },
      { type: 'Chrome', id: 'chrome', props: { shapeSdfUrl: url, shapeType: 'svgExtrude3D', shape: this.shape(0), scale: 1.75, speed: 0.35, dispersion: 0.45 } },
    ]);
    this.peel = new Sfx(renderer, [
      { type: 'EngineTexture', props: { source: 'new' } },
      { type: 'PagePeel', id: 'peel', props: { corner: 'bottom-right', amount: 0, radius: 0.12, shadow: 1 }, children: [{ type: 'EngineTexture', props: { source: 'old' } }] },
    ]);
    await Promise.all([this.title.init(), this.peel.init()]);
  }

  /** The extruded text's shape JSON at local time lt: a slow turn that settles. */
  private shape(lt: number) {
    const k = ease.outCubic(clamp(lt / 6, 0, 1));
    return JSON.stringify({ type: 'svgExtrude3D', depth: 0.11, bevel: 0.018, rotY: -32 + 24 * k, rotX: 10 - 6 * k, rotZ: -2 + 2 * k });
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    this.title.set('chrome', { shape: this.shape(f.lt) });
    this.title.render(f.lt, f.under ? this.titleRT : out);
    if (f.under) {
      // the previous scene is the page, peeled from the bottom-right corner over the overlap
      this.peel.input('old', f.under);
      this.peel.input('new', this.titleRT);
      this.peel.set('peel', { amount: ease.inOutCubic(f.tin) });
      this.peel.render(f.lt, out);
    }
  }

  override dispose() {
    this.title.dispose();
    this.peel.dispose();
  }
}

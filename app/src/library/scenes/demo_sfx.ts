// 示例场景：shaders 库的效果（library/kit/sfx.ts）。`?sfx=<组件名>` 看任一个组件（全部 200 个 + EngineTexture），
// `&sfxprops=<JSON>` 改它的 prop。滤镜类（要子层的）套在一张引擎画的测试卡上（EngineTexture 输入），生成类直接画。
// 模拟类（stateful）由引擎在跳转后从头快进。
import type * as THREE from 'three';
import { Scene, type Frame } from '../../engine/scene';
import { FSPass, makeRT, W, H } from '../../engine/gl';
import { Sfx, sfxComponents, type SfxLayer } from '../kit/sfx';

const q = new URLSearchParams(location.search);

/** The layer list `?sfx=<Name>` shows: filters (components that take a child) get the test card as their child. */
export function demoLayers(name: string, props: Record<string, unknown> = {}): SfxLayer[] {
  const def = sfxComponents().get(name);
  if (!def) throw new Error(`?sfx=${name}: no such component`);
  const takesChild = !!(def.requiresChild || def.requiresRTT || def.acceptsOptionalChild);
  return [{ type: name, id: 'fx', props, children: takesChild ? [{ type: 'EngineTexture', props: { source: 'card' } }] : undefined }];
}

export default class DemoSfx extends Scene {
  // the engine's test card: gradient, grid, a disc with an HDR core, moving with t
  card = new FSPass(/* glsl */ `
    uniform float t;
    void main() {
      vec2 p = (vUv - 0.5) * vec2(${(W / H).toFixed(4)}, 1.0);
      vec3 col = mix(C_INK, C_SIGNAL, vUv.x) * (0.35 + 0.65 * vUv.y);
      vec2 g = abs(fract(p * 8.0) - 0.5);
      col = mix(col, C_BONE, 0.5 * (1.0 - smoothstep(0.0, 0.03, min(g.x, g.y))));
      vec2 c = vec2(0.25 * sin(t * 0.7), 0.1 * cos(t * 0.9));
      float d = length(p - c);
      col = mix(col, C_BONE, 1.0 - smoothstep(0.17, 0.18, d));
      col += vec3(4.0, 3.0, 2.0) * (1.0 - smoothstep(0.0, 0.06, d));
      fragColor = vec4(col, 1.0);
    }`, { t: { value: 0 } });
  cardRT = makeRT(W, H, { depthBuffer: false });
  fx: Sfx;

  constructor(ctx: ConstructorParameters<typeof Scene>[0]) {
    super(ctx);
    const name = String(ctx.params.sfx ?? q.get('sfx') ?? 'PagePeel');
    const props = (ctx.params.props as Record<string, unknown>) ?? JSON.parse(q.get('sfxprops') ?? '{}');
    this.fx = new Sfx(ctx.renderer, demoLayers(name, props));
    this.stateful = this.fx.stateful;
  }

  override async init() {
    await this.fx.init();
  }

  override reset() {
    this.fx.reset();
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    this.card.u.t!.value = f.lt;
    this.card.render(this.ctx.renderer, this.cardRT);
    this.fx.input('card', this.cardRT);
    this.fx.render(f.lt, out);
  }

  override dispose() {
    this.fx.dispose();
  }
}

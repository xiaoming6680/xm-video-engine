// EngineTexture: a shaders-library media component whose pixels come from the engine (a render target, a Layer2D,
// a canvas or an image) instead of a URL — the input end of library/kit/sfx.ts. Use it in an Sfx layer list as
// `{ type: 'EngineTexture', props: { source: 'scene' } }` and bind the pixels with `sfx.input('scene', rt)`.
// Sampled exactly like the library's ImageTexture (its media surface: object-fit, letterbox, sRGB decode; mipmapped):
// an sRGB image source lands in an rgba8unorm texture as ImageTexture's does, a render target (linear HDR, encoded as
// extended sRGB on the way) in an rgba16float one.
import type { GpuFragmentParams, Expr, GpuMediaTexture } from '../vendor/shaders/gpu/contract';
import { defineStd } from '../vendor/shaders/std/index';
import { media } from '../vendor/shaders/gpu/kit/index';
import { objectFitProp } from '../vendor/shaders/utilities/propConfigs';

export type InputFormat = 'rgba8unorm' | 'rgba16float';

/** The texture an EngineTexture holds this frame: sized and formatted by the source, then written and mipmapped. */
export interface InputTexture {
  /** The texture to copy into, `w` x `h` in `format` (re-made when either changes); null once the layer is gone. */
  ensure(w: number, h: number, format: InputFormat): GpuMediaTexture | null;
  /** After the copy: rebuild the mip chain. */
  written(): void;
}

/** Where an EngineTexture gets its pixels: the Sfx that owns the renderer canvas. */
export interface InputSink {
  /** Copy the input called `source` into `tex` for the frame being rendered. */
  fill(source: string, tex: InputTexture): void;
}

const sinks = new WeakMap<HTMLCanvasElement, InputSink>();

/** Route the EngineTextures of the renderer drawing into `canvas` to `sink`. */
export function bindInputSink(canvas: HTMLCanvasElement, sink: InputSink) {
  sinks.set(canvas, sink);
}

const mipLevels = (w: number, h: number) => Math.floor(Math.log2(Math.max(w, h))) + 1;

interface Props { source: string; objectFit: string }

export const EngineTexture = defineStd<Props>({
  name: 'EngineTexture',
  role: 'media',
  species: 'custom',
  category: 'Textures',
  description: 'Pixels from the engine: the input bound with Sfx.input(source, …) (a render target, a Layer2D, a canvas, an image)',
  boundingBoxDeclaration: { aspectRatio: null, supportsResizeFit: true },
  acceptsUVContext: true,
  props: {
    source: {
      default: 'in',
      // (compile-time: the name is read when the composition is built)
      compileTime: true,
      description: 'Name of the engine input (Sfx.input(name, …))',
    },
    objectFit: objectFitProp('fill', 'How the input is sized within the layer', { allowNone: false }),
  },
  gpu: {
    fragment: (params: GpuFragmentParams): Expr => {
      // a 1x1 transparent placeholder until the first fill; the pass manager rebinds when the texture is swapped
      const make = (w: number, h: number, format: InputFormat) =>
        params.createMediaTexture({ width: w, height: h, format, mipLevelCount: mipLevels(w, h), label: 'EngineTexture' });
      let current = make(1, 1, 'rgba8unorm');
      let format: InputFormat = 'rgba8unorm';
      let disposed = false;
      const kit = params.registerMediaTexture(() => current.texture);
      params.onCleanup(() => { disposed = true; current.destroy(); });
      const tex: InputTexture = {
        ensure(w, h, f) {
          if (disposed) return null;
          w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
          if (current.width !== w || current.height !== h || format !== f) {
            const next = make(w, h, f);
            current.destroy();
            current = next;
            format = f;
          }
          return current;
        },
        written() { if (!disposed) current.generateMipmaps(); },
      };
      const name = String(params.propValues.source ?? 'in');
      const canvas = params.canvas;
      // every frame, before the passes run (after the composition is built): the engine pixels of this frame
      params.onBeforeRender(() => sinks.get(canvas)?.fill(name, tex));
      return media.mediaSurface({
        texture: kit,
        uv: params.uvContext ?? params.ctx.uv,
        viewport: params.effectiveViewportSize ?? params.ctx.viewportSize,
        fit: params.propValues.objectFit,
        decode: 'srgb-linear-alpha-cut',
      });
    },
  },
});

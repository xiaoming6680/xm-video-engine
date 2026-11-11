// 预渲染序列帧（plate）当整个场景：时间线的一段就是 Blender、AE 或别的渲染器出的序列，引擎的 2D / 3D 层叠在上面，
// 运动模糊和后期照常走。取帧、预取、相机 JSON 都在底座 engine/plate.ts（这里照旧能 import，旧项目不用改）；
// 序列帧当合成里的一个图层（带变换、蒙版、效果、3D）用 layers.ts 的 footage。
//
//   class Shot extends PlateScene {                                         // 或时间线 params.plate 直接给参数
//     protected override plateOptions() { return { src: '/assets/plates/shot1/####.png', fps: 24, last: 120, at: this.ctx.start, camera: '/assets/plates/shot1/camera.json' }; }
//     protected override overlay(f: Frame, out: THREE.WebGLRenderTarget) { this.plate.applyCamera(this.cam, f.t); renderInto(this.ctx.renderer, this.world, this.cam, out, null); }
//   }
import * as THREE from 'three';
import { Scene, type Frame, type PostOverrides } from '../../engine/scene';
import { clearRT } from '../../engine/gl';
import { Plate, type PlateOptions } from '../../engine/plate';

export * from '../../engine/plate';

type V3 = [number, number, number];

// ------------------------------------------------------------------ the plate as a scene

/**
 * A timeline entry that is a plate. The options come from plateOptions(): by default the entry's `params.plate`, with
 * `at` = the entry's start, so a project scene file can be one line —
 * `export { PlateScene as default } from '../library/kit/plate';` — and the timeline gives
 * `{ params: { plate: { src: '/refs/shot1/####.png', fps: 24, last: 120 } } }`. Subclass it and override overlay() to
 * draw over the plate (2D layers; 3D through `this.plate.applyCamera(cam, f.t)`).
 */
export class PlateScene extends Scene {
  plate!: Plate;
  /** Linear colour under the plate (shows through its alpha and the bars of 'contain'). */
  background: V3 = [0, 0, 0];

  protected plateOptions(): PlateOptions {
    const p = this.ctx.params.plate as PlateOptions | undefined;
    if (!p) throw new Error(`${this.ctx.id}: PlateScene needs params.plate ({ src, fps, last, … }) or a plateOptions() override`);
    return { at: this.ctx.start, ...p };
  }

  override async init() {
    this.plate = new Plate(this.ctx.renderer, this.plateOptions());
    await this.plate.init();
  }

  override prepare(t: number, t0: number, t1: number) { return this.plate.prepare(t, t0, t1); }

  render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides | void {
    clearRT(this.ctx.renderer, out, this.background);
    this.plate.draw(this.ctx.comp, out, f.t);
    return this.overlay(f, out);
  }

  /** Draw over the plate (out already holds it). Return post overrides like render(). */
  protected overlay(_f: Frame, _out: THREE.WebGLRenderTarget): PostOverrides | void {}

  override dispose() { this.plate?.dispose(); }
}

// Shafts of sunlight (from Still_Shining v10, 日出光束): the bright sky around the sun, wherever nothing stands in
// front of it (towers, the mountains, cloud edges, her silhouette), smeared radially away from the sun's place on
// the screen (crepuscular rays as in GPU Gems 3, ch. 13). Light streams out between the towers and around her when
// the sun comes up. Half resolution (soft by nature); the march start is jittered per pixel and sub-frame and the
// motion-blur average smooths it. Added over the frame after the character, before any lens flare.
// Needs the world's depth (sky = cleared depth 1: only open sky feeds the shafts, never lamps or red lights).
//   rays.render(renderer, out, worldRT.texture, worldRT.depthTexture!, figureRT.texture, cam, sunDir, 1.0, f.t * 5.1, ctx.comp);
import * as THREE from 'three';
import { FSPass, makeRT, W, H } from '../engine/gl';

export class SunRays {
  private src = makeRT(W / 2, H / 2, { depthBuffer: false });
  private shafts = makeRT(W / 2, H / 2, { depthBuffer: false });
  private maskPass = new FSPass(/* glsl */ `
    uniform sampler2D world, fig, depth; uniform vec2 sun, res; uniform float thr;
    void main() {
      vec3 c = texture(world, vUv).rgb;
      float a = texture(fig, vUv).a;
      // only open sky feeds the shafts (the depth buffer is cleared to 1 there): never the towers' red lights or the
      // city's lamps, which the radial smear would draw out into lines
      float sky = step(0.9999999, texture(depth, vUv).r);
      // only the hot sky near the sun feeds the shafts (the sun's glow, lit cloud edges): not the city's lights
      float l = luma(c);
      float hot = max(l - thr, 0.0) / max(l, 1e-4);
      float near = exp(-length((vUv - sun) * res) / 520.0);
      fragColor = vec4(c * hot * near * sky * (1.0 - a), 1.0);
    }`, { world: { value: null }, fig: { value: null }, depth: { value: null }, sun: { value: new THREE.Vector2() }, res: { value: new THREE.Vector2(W, H) }, thr: { value: 1.2 } });
  private blurPass = new FSPass(/* glsl */ `
    uniform sampler2D src; uniform vec2 sun; uniform float seed, reach;
    void main() {
      const int N = 72;
      vec2 d = (sun - vUv) * reach / float(N);
      float j = hash12(gl_FragCoord.xy * 0.913 + fract(seed * 0.29) * 57.3);
      vec2 uv = vUv + d * j;
      vec3 acc = vec3(0.0);
      float w = 1.0;
      for (int i = 0; i < N; i++) {
        acc += texture(src, uv).rgb * w;
        w *= 0.972;
        uv += d;
      }
      fragColor = vec4(acc / float(N), 1.0);
    }`, { src: { value: null }, sun: { value: new THREE.Vector2() }, seed: { value: 0 }, reach: { value: 0.92 } });

  /**
   * Add the shafts (strength k) to `out` for the sun seen by camera `cam`; `world` = the world as rendered (HDR, not
   * blurred), `fig` = her layer (alpha). Nothing when the sun is behind the camera or k = 0.
   */
  render(renderer: THREE.WebGLRenderer, out: THREE.WebGLRenderTarget, world: THREE.Texture, depth: THREE.Texture, fig: THREE.Texture, cam: THREE.Camera, sunDir: THREE.Vector3, k: number, seed: number, comp: { draw: (r: THREE.WebGLRenderer, t: THREE.Texture, o: THREE.WebGLRenderTarget, opts: { mode: 'add'; opacity: number }) => void }) {
    if (k <= 0.001) return;
    // the sun's place on the screen: any point toward it projects there, so take one inside the camera's range (a
    // fixed 1e5 fell past the far plane of cameras with far < 1e5 and the shafts silently vanished). p.z > 1: behind
    const pc = cam as Partial<THREE.PerspectiveCamera>;
    const p = cam.position.clone().addScaledVector(sunDir, ((pc.near ?? 0) + (pc.far ?? 2e5)) / 2).project(cam);
    if (!(p.z <= 1)) return;
    const uv = new THREE.Vector2(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    if (uv.x < -0.8 || uv.x > 1.8 || uv.y < -0.8 || uv.y > 1.8) return;
    const m = this.maskPass.u;
    m.world!.value = world; m.depth!.value = depth; m.fig!.value = fig; (m.sun!.value as THREE.Vector2).copy(uv);
    this.maskPass.render(renderer, this.src);
    const b = this.blurPass.u;
    b.src!.value = this.src.texture; (b.sun!.value as THREE.Vector2).copy(uv); b.seed!.value = seed;
    this.blurPass.render(renderer, this.shafts);
    comp.draw(renderer, this.shafts.texture, out, { mode: 'add', opacity: k });
  }
}

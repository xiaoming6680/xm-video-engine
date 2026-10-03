// Lens blur by depth (from Still_Shining v10, 近景虚化): for a world rendered with a depth texture (kit3d GBuf, or any
// target with rt.depthTexture); a character composited afterwards stays sharp. The world goes soft by depth — the city's lights and the towers' windows open into discs (the HDR values
// carry them: a bright light becomes a bright disc). A gather over a disc of samples, each counted when its own
// circle of confusion reaches this pixel (scatter-as-gather, weighted by 1/area); a sample behind a sharper pixel
// can reach it only as far as that pixel's own blur, so the background never bleeds over the foreground, while a
// blurred near object (a tower wall by the camera) does spread over what is behind it. The sample pattern turns
// per pixel and per sub-frame: the motion-blur average makes it smooth (single-sample stills look grainy).
// Unlike kit3d's DofPass (up to ~650 taps) it takes 96 taps, so it fits every sub-frame of an export.
//   const out = bokeh.render(renderer, rt.texture, rt.depthTexture!, cam, { focus: camToSubject, blur: 24 }, f.t * 7.3)
//     ? bokeh.out.texture : rt.texture;
import * as THREE from 'three';
import { FSPass, makeRT, W, H } from '../engine/gl';

const N = 96;

export interface BokehLook {
  /** Distance in focus (m): her, normally. */
  focus: number;
  /** Blur of the far background (logical px): CoC = blur * focus * |1/focus - 1/z|. 0 = off. */
  blur: number;
}

export class Bokeh {
  out = makeRT(W, H, { depthBuffer: false });
  private pass = new FSPass(/* glsl */ `
    uniform sampler2D colTex, depthTex;
    uniform float near, far, focus, aperture, maxBlur, seed;
    uniform vec2 texel;
    float linz(float d) { return near * far / (far - d * (far - near)); }
    float coc(float z) { return clamp(aperture * abs(1.0 / focus - 1.0 / z), 0.0, maxBlur); }
    void main() {
      float z0 = linz(texture(depthTex, vUv).r);
      float c0 = coc(z0);
      vec3 acc = texture(colTex, vUv).rgb / max(c0 * c0, 1.0);
      float wsum = 1.0 / max(c0 * c0, 1.0);
      float rot = hash12(gl_FragCoord.xy * 0.371 + fract(seed * 0.137) * 91.7) * 6.2831853;
      for (int i = 0; i < ${N}; i++) {
        float r = sqrt((float(i) + 0.5) / ${N}.0) * maxBlur;
        float a = float(i) * 2.39996323 + rot;
        vec2 uv = vUv + vec2(cos(a), sin(a)) * r * texel;
        float zs = linz(texture(depthTex, uv).r);
        float cs = coc(zs);
        float reach = zs > z0 ? min(cs, c0 * 1.5 + 1.0) : cs;
        float w = smoothstep(r - 1.2, r + 0.8, reach) / max(cs * cs, 1.0);
        acc += texture(colTex, uv).rgb * w;
        wsum += w;
      }
      fragColor = vec4(acc / wsum, 1.0);
    }`, {
    colTex: { value: null }, depthTex: { value: null }, near: { value: 3 }, far: { value: 400000 }, focus: { value: 5 },
    aperture: { value: 0 }, maxBlur: { value: 1 }, seed: { value: 0 }, texel: { value: new THREE.Vector2(1 / W, 1 / H) },
  });

  /** Blur `color` (with its depth) for camera `cam` into this.out. Returns false (nothing done) when the blur is off. */
  render(renderer: THREE.WebGLRenderer, color: THREE.Texture, depth: THREE.Texture, cam: THREE.PerspectiveCamera, b: BokehLook, seed: number) {
    if (b.blur < 0.3) return false;
    const u = this.pass.u;
    u.colTex!.value = color; u.depthTex!.value = depth;
    u.near!.value = cam.near; u.far!.value = cam.far;
    u.focus!.value = b.focus; u.aperture!.value = b.blur * b.focus;
    // near things (a tower wall by the lens) may blur a little more than the far background, up to 1.2x
    u.maxBlur!.value = b.blur * 1.2; u.seed!.value = seed;
    this.pass.render(renderer, this.out);
    return true;
  }
}

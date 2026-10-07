// Picture warps that re-map a scene's own render: kaleidoscope, infinite (Droste) zoom, iris wipe.
// Each takes a texture (draw the source into a makeRT() first) and writes a full frame into `out`.
//
// Kaleido  — 'polar': N mirrored wedges around a centre (the mandala); 'tile': a mirrored wallpaper of the source
//            (the 3x3 mirror wall before the kaleidoscope in kaomoji.exe). Draw anything that must stay unmirrored
//            (the badge in the middle) over it afterwards.
// Droste   — the source is a picture with a transparent hole (alpha < 1) where a smaller copy of itself belongs:
//            a frame, a window, a TV; premultiplied, as Compositor.draw leaves a Layer2D in a target cleared to alpha 0. `phase` 0 -> 1 zooms one level in (it loops: phase can just be time * speed);
//            each level is `scale` times smaller and turned by `twist` radians (the rotating frame tunnel).
// Iris     — reveal `cur` over `under` inside a growing circle (or a rounded box), with an optional bright ring.
import * as THREE from 'three';
import { FSPass, W, H } from './gl';

const ASP = (W / H).toFixed(5);

export interface KaleidoOpts {
  mode?: 'polar' | 'tile';
  /** polar: number of mirrored wedges; tile: tiles across the frame height. */
  n?: number;
  /** Rotation of the whole pattern, and of the sampled source inside each wedge (radians). */
  rot?: number;
  spin?: number;
  /** >1 samples a larger part of the source (pattern shrinks). Tile mode: frame heights of source per tile (1 = a frame-height square). */
  zoom?: number;
  /** Centre on screen and where in the source the wedge reads from (uv 0..1). */
  center?: [number, number];
  srcCenter?: [number, number];
}

export class Kaleido {
  private pass = new FSPass(/* glsl */ `
    uniform sampler2D src; uniform float n, rot, spin, zoom, tile; uniform vec2 center, srcCenter;
    void main() {
      vec2 asp = vec2(${ASP}, 1.0);
      vec2 p = (vUv - center) * asp;
      vec2 q;
      if (tile < 0.5) {
        float r = length(p), a = atan(p.y, p.x) + rot, seg = TAU / n;
        a = mod(a, seg); a = min(a, seg - a);       // fold into one wedge, mirrored
        a += spin;
        q = r * vec2(cos(a), sin(a));
      } else {
        // tiles of height 1/n, each mirrored against its neighbours; the middle tile is the source unmirrored
        vec2 t = rot2(rot) * p * n;
        q = 0.5 - abs(fract((t + 0.5) * 0.5) * 2.0 - 1.0);   // tile units, -0.5..0.5
        q = rot2(spin) * q;
      }
      vec2 uv = srcCenter + q * zoom / asp;
      uv = 1.0 - abs(1.0 - mod(uv, 2.0));           // mirrored repeat outside the source
      fragColor = texture(src, uv);
    }`, {
    src: { value: null }, n: { value: 12 }, rot: { value: 0 }, spin: { value: 0 }, zoom: { value: 1 }, tile: { value: 0 },
    center: { value: new THREE.Vector2(0.5, 0.5) }, srcCenter: { value: new THREE.Vector2(0.5, 0.5) },
  });
  render(renderer: THREE.WebGLRenderer, src: THREE.Texture, out: THREE.WebGLRenderTarget, o: KaleidoOpts = {}) {
    const u = this.pass.u;
    u.src!.value = src;
    u.tile!.value = o.mode === 'tile' ? 1 : 0;
    u.n!.value = o.n ?? (o.mode === 'tile' ? 3 : 12);
    u.rot!.value = o.rot ?? 0;
    u.spin!.value = o.spin ?? 0;
    u.zoom!.value = o.zoom ?? 1;
    (u.center!.value as THREE.Vector2).set(...(o.center ?? [0.5, 0.5]));
    (u.srcCenter!.value as THREE.Vector2).set(...(o.srcCenter ?? [0.5, 0.5]));
    this.pass.render(renderer, out);
  }
}

export interface DrosteOpts {
  /** Zoom progress in levels (fractional part used: 0 -> 1 is one level deeper, then it repeats). */
  phase: number;
  /** Size of the inner copy relative to the picture (0 < scale < 1). */
  scale?: number;
  /** Turn of each inner copy relative to its parent (radians). */
  twist?: number;
  /** Centre of the hole / the inner copy (uv). */
  center?: [number, number];
  /** What shows where every level is transparent (linear). */
  bg?: [number, number, number];
}

export class Droste {
  private pass = new FSPass(/* glsl */ `
    uniform sampler2D src; uniform float s, twist, ph; uniform vec2 c; uniform vec3 bg;
    void main() {
      vec2 asp = vec2(${ASP}, 1.0);
      // screen -> picture: zoomed in by (1/s)^ph and turned by twist*ph, so ph = 1 shows the inner copy full-frame
      vec2 d = rot2(-twist * ph) * ((vUv - c) * asp) * pow(s, ph);
      // corners that a turn pushed past the picture belong to the parent level
      for (int k = 0; k < 3; k++) {
        vec2 q = d / asp + c;
        if (q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0) break;
        d = rot2(-twist) * d * s;
      }
      // front to back through the holes
      vec3 acc = vec3(0.0); float a = 0.0;
      for (int k = 0; k < 14; k++) {
        vec4 t = texture(src, d / asp + c);
        acc += (1.0 - a) * t.rgb;                    // premultiplied
        a += (1.0 - a) * t.a;
        if (a > 0.995) break;
        d = rot2(twist) * d / s;
      }
      fragColor = vec4(acc + (1.0 - a) * bg, 1.0);
    }`, { src: { value: null }, s: { value: 0.8 }, twist: { value: 0 }, ph: { value: 0 }, c: { value: new THREE.Vector2(0.5, 0.5) }, bg: { value: new THREE.Vector3() } });
  render(renderer: THREE.WebGLRenderer, src: THREE.Texture, out: THREE.WebGLRenderTarget, o: DrosteOpts) {
    const u = this.pass.u;
    u.src!.value = src;
    u.s!.value = o.scale ?? 0.8;
    u.twist!.value = o.twist ?? 0;
    u.ph!.value = o.phase - Math.floor(o.phase);
    (u.c!.value as THREE.Vector2).set(...(o.center ?? [0.5, 0.5]));
    (u.bg!.value as THREE.Vector3).set(...(o.bg ?? [0, 0, 0]));
    this.pass.render(renderer, out);
  }
}

export interface IrisOpts {
  /** 0..1: radius as a fraction of the frame's half diagonal (1 = fully open). */
  p: number;
  center?: [number, number];
  /** 0 = circle; > 0 = rounded box with this aspect (width / height). */
  box?: number;
  /** Edge softness (fraction of frame height) and a ring drawn on the edge (linear colour x strength). */
  feather?: number;
  ring?: [number, number, number];
  ringWidth?: number;
}

export class Iris {
  private pass = new FSPass(/* glsl */ `
    uniform sampler2D under, cur; uniform float r, box, feather, ringW; uniform vec2 c; uniform vec3 ring;
    void main() {
      vec2 asp = vec2(${ASP}, 1.0);
      vec2 p = (vUv - c) * asp;
      float d = box > 0.0 ? sdBox(p, vec2(r * box, r) * 0.7) - r * 0.3 : length(p) - r;
      float m = 1.0 - smoothstep(-feather, feather, d);
      vec3 col = mix(texture(under, vUv).rgb, texture(cur, vUv).rgb, m);
      col += ring * (1.0 - smoothstep(0.0, ringW, abs(d))) * step(0.001, r);
      fragColor = vec4(col, 1.0);
    }`, { under: { value: null }, cur: { value: null }, r: { value: 0 }, box: { value: 0 }, feather: { value: 0.002 }, ringW: { value: 0.004 }, c: { value: new THREE.Vector2(0.5, 0.5) }, ring: { value: new THREE.Vector3() } });
  render(renderer: THREE.WebGLRenderer, under: THREE.Texture, cur: THREE.Texture, out: THREE.WebGLRenderTarget, o: IrisOpts) {
    const u = this.pass.u, half = Math.hypot(W / H, 1) / 2;
    u.under!.value = under; u.cur!.value = cur;
    u.r!.value = Math.max(0, o.p) * half * 1.02;
    u.box!.value = o.box ?? 0;
    u.feather!.value = o.feather ?? 0.002;
    u.ringW!.value = o.ringWidth ?? 0.004;
    (u.c!.value as THREE.Vector2).set(...(o.center ?? [0.5, 0.5]));
    (u.ring!.value as THREE.Vector3).set(...(o.ring ?? [0, 0, 0]));
    this.pass.render(renderer, out);
  }
}

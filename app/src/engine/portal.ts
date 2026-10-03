// Portal transitions (docs/TREATMENT.md, 转场规则): the outgoing scene renders its "interface object" (a monitor
// screen, a nether portal, the extraction ring…) with alpha 0; the incoming scene (handlesTransition = true)
// composites the outgoing frame (f.under) with its own frame shown through that hole:
//   'window' — its frame as rendered (the hole is a window onto the next world, for portals the camera flies through)
//   'screen' — its frame mapped flat onto a quad (a monitor showing the next world, in perspective); when the
//              outgoing camera ends with the screen exactly filling the frame, the mapping is the identity and the
//              handover has no seam.
// Both layers can get the same radial zoom blur around the portal centre so the speed reads as one continuous move.
import * as THREE from 'three';
import { FSPass } from './gl';

export type UV = { x: number; y: number };
/** Screen quads of portals published by outgoing scenes each frame (frame UV, y up): TL, TR, BR, BL. */
export const portalQuads = new Map<string, [UV, UV, UV, UV]>();

/** 3x3 homography (row-major) mapping the unit square (0,0)-(1,1) to the quad p0 (0,0), p1 (1,0), p2 (1,1), p3 (0,1). */
function squareToQuad(p: UV[]): number[] {
  const [a, b, c, d] = p as [UV, UV, UV, UV];
  const dx1 = b.x - c.x, dx2 = d.x - c.x, dx3 = a.x - b.x + c.x - d.x;
  const dy1 = b.y - c.y, dy2 = d.y - c.y, dy3 = a.y - b.y + c.y - d.y;
  let g = 0, h = 0;
  if (Math.abs(dx3) > 1e-12 || Math.abs(dy3) > 1e-12) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  return [b.x - a.x + g * b.x, d.x - a.x + h * d.x, a.x, b.y - a.y + g * b.y, d.y - a.y + h * d.y, a.y, g, h, 1];
}
function inv3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

export interface PortalOpts {
  mode: 'window' | 'screen';
  /** For 'screen': the quad (frame UV, y up) TL, TR, BR, BL — the image's top-left corner goes to TL. */
  quad?: [UV, UV, UV, UV];
  /** Radial zoom blur strength (fraction of the distance to the centre smeared, ~0..0.15) and its centre (UV). */
  blur?: number;
  center?: UV;
  /** Additive flash over the whole frame (linear HDR), e.g. the screen blowing up on the key press. */
  flash?: number;
  flashColor?: [number, number, number];
}

export class PortalBlend {
  private pass = new FSPass(/* glsl */ `
    uniform sampler2D A, B; uniform int mode; uniform mat3 Hinv; uniform vec2 center; uniform float blur, flash; uniform vec3 flashColor;
    vec2 toB(vec2 uv) {
      if (mode == 0) return uv;
      vec3 q = Hinv * vec3(uv, 1.0);
      return q.xy / q.z;
    }
    void main() {
      const int N = 12;
      vec3 a = vec3(0.0), b = vec3(0.0); float m = 0.0;
      for (int i = 0; i < N; i++) {
        float s = 1.0 - blur * (float(i) / float(N - 1));
        vec2 uv = center + (vUv - center) * s;
        vec4 ta = texture(A, uv);
        a += ta.rgb; m += 1.0 - ta.a;
        vec2 bu = toB(uv);
        float inside = step(0.0, bu.x) * step(bu.x, 1.0) * step(0.0, bu.y) * step(bu.y, 1.0);
        b += texture(B, clamp(bu, 0.0, 1.0)).rgb * inside;
      }
      a /= float(N); b /= float(N); m = clamp(m / float(N), 0.0, 1.0);
      vec3 col = mix(a, b, m);
      col += flashColor * flash;
      fragColor = vec4(col, 1.0);
    }`, {
    A: { value: null }, B: { value: null }, mode: { value: 0 }, Hinv: { value: new THREE.Matrix3() },
    center: { value: new THREE.Vector2(0.5, 0.5) }, blur: { value: 0 }, flash: { value: 0 },
    flashColor: { value: new THREE.Vector3(1, 1, 1) },
  });

  render(r: THREE.WebGLRenderer, under: THREE.Texture, own: THREE.Texture, out: THREE.WebGLRenderTarget, o: PortalOpts) {
    const u = this.pass.u;
    u.A!.value = under; u.B!.value = own;
    u.mode!.value = o.mode === 'screen' ? 1 : 0;
    if (o.mode === 'screen' && o.quad) {
      // the quad is given TL, TR, BR, BL; in UV (y up) the image's (0,0) is its bottom-left: pass BL, BR, TR, TL
      const Hq = inv3(squareToQuad([o.quad[3], o.quad[2], o.quad[1], o.quad[0]]));
      (u.Hinv!.value as THREE.Matrix3).set(Hq[0]!, Hq[1]!, Hq[2]!, Hq[3]!, Hq[4]!, Hq[5]!, Hq[6]!, Hq[7]!, Hq[8]!);
    }
    (u.center!.value as THREE.Vector2).set(o.center?.x ?? 0.5, o.center?.y ?? 0.5);
    u.blur!.value = o.blur ?? 0;
    u.flash!.value = o.flash ?? 0;
    (u.flashColor!.value as THREE.Vector3).set(...(o.flashColor ?? [1, 1, 1]));
    this.pass.render(r, out);
  }
}

/** Material that punches a portal hole: depth-tested, writes rgba = 0 (the incoming scene fills it). */
export function portalHoleMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'void main(){ gl_FragColor = vec4(0.0); }',
    blending: THREE.NoBlending,
  });
}

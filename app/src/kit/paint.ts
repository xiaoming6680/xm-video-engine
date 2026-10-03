// The painted look (from Falling_Again; the user: 你不适合写实风, 参考封面的风格). The 3D frame is repainted like a painting
// (there: the album cover): a polynomial-weighted 8-sector Kuwahara filter (Kyprianidis et al.) over an ELONGATED footprint
// turns smooth shading into flat strokes of paint — long diagonal strokes in the sky (upper left to lower right, as on
// the cover), long strokes lying along the ground — then the colours are pulled onto the cover's palette (navy,
// indigo, violet, lilac, pink-white) while the hot glass and the lightning keep their own light. HDR in, HDR out:
// the engine's bloom and tone curve still run after it.
import * as THREE from 'three';
import { FSPass, W, H, SCALE } from '../engine/gl';
import { hexToLinear } from '../engine/util';

// Falling_Again's cover colours, dark to light (the default ramps; pass your own 8-colour ramps to the constructor)
export const COVER_RAMP_HEX = ['#0c1c35', '#182d51', '#324173', '#424484', '#7668a5', '#b197be', '#eddce3', '#f6eaee'];
// under the low deck of the second drop (the user chose A 明暗反差 from the concept frames, docs/concepts): deeper
// darks, and the lit parts going magenta and pink-white like the cover's bursts instead of pale lilac
// (the user: 品红有些过了，收一点 — the lit end pulled back toward the cover's lilac-pink)
export const COVER_RAMP2_HEX = ['#070c1e', '#0f1838', '#1d235c', '#353076', '#5e4891', '#a07cb4', '#e6c4dc', '#f8ecf2'];

const FS = /* glsl */ `
uniform sampler2D src, depthTex;
uniform vec2 texel;
uniform float near, far, radius, paint, stroke, aniso, deck;
uniform vec3 ramp[8], ramp2[8];

float linDepth(vec2 uv) { float d = texture(depthTex, uv).r; return near * far / (far - d * (far - near)); }
vec3 comp(vec3 c) { return c / (1.0 + c); }
vec3 decomp(vec3 c) { return c / max(1.0 - c, 1e-3); }
vec3 rampAt(float x) {
  x = clamp(x, 0.0, 1.0) * 7.0;
  int i = int(min(floor(x), 6.0));
  return mix(mix(ramp[i], ramp[i + 1], x - float(i)), mix(ramp2[i], ramp2[i + 1], x - float(i)), deck);
}

void main() {
  vec2 uv = vUv;
  float z = linDepth(uv);
  bool sky = z > far * 0.9;
  // stroke direction: the sky's diagonal sweep; on the ground the strokes lie flat, steeper close to the camera
  float ang = sky ? -0.62 : mix(-0.12, -0.02, smoothstep(30.0, 600.0, z));
  vec2 dir = vec2(cos(ang), sin(ang)) * vec2(1.0, ${(W / H).toFixed(5)});
  vec2 nrm = vec2(-dir.y, dir.x);
  // (smaller strokes right under the camera: the ripples rushing past are what reads as speed)
  float R = radius * (sky ? 1.25 : mix(0.45, 1.0, smoothstep(12.0, 90.0, z)) * mix(1.0, 0.7, smoothstep(50.0, 900.0, z)));
  float a = aniso * (sky ? 1.0 : 0.8);

  const float zeta = 0.33;
  const float eta = (0.33 + 0.836) / 0.3011; // (zeta + cos(0.58)) / sin(0.58)^2
  vec4 m[8]; vec3 s[8];
  for (int k = 0; k < 8; k++) { m[k] = vec4(0.0); s[k] = vec3(0.0); }
  const int N = 6;
  for (int j = -N; j <= N; j++) for (int i = -N; i <= N; i++) {
    vec2 v = vec2(float(i), float(j)) / float(N);
    float r2 = dot(v, v);
    if (r2 > 1.0) continue;
    // the footprint: long along the stroke, short across it
    vec2 off = (dir * v.x * a + nrm * v.y / a) * R;
    vec3 c = comp(texture(src, uv + off * texel).rgb);
    float w[8];
    float vxx = zeta - eta * v.x * v.x, vyy = zeta - eta * v.y * v.y, q;
    q = max(0.0, v.y + vxx); w[0] = q * q;
    q = max(0.0, -v.x + vyy); w[2] = q * q;
    q = max(0.0, -v.y + vxx); w[4] = q * q;
    q = max(0.0, v.x + vyy); w[6] = q * q;
    vec2 u = 0.70710678 * vec2(v.x - v.y, v.x + v.y);
    vxx = zeta - eta * u.x * u.x; vyy = zeta - eta * u.y * u.y;
    q = max(0.0, u.y + vxx); w[1] = q * q;
    q = max(0.0, -u.x + vyy); w[3] = q * q;
    q = max(0.0, -u.y + vxx); w[5] = q * q;
    q = max(0.0, u.x + vyy); w[7] = q * q;
    float sum = 0.0;
    for (int k = 0; k < 8; k++) sum += w[k];
    float g = exp(-3.125 * r2) / max(sum, 1e-6);
    for (int k = 0; k < 8; k++) { float wk = w[k] * g; m[k] += vec4(c * wk, wk); s[k] += c * c * wk; }
  }
  vec4 o = vec4(0.0);
  for (int k = 0; k < 8; k++) {
    if (m[k].w <= 0.0) continue;
    vec3 mu = m[k].rgb / m[k].w;
    vec3 var = abs(s[k] / m[k].w - mu * mu);
    float sg = var.r + var.g + var.b;
    float wk = 1.0 / (1.0 + pow(3000.0 * sg, 4.0));
    o += vec4(mu * wk, wk);
  }
  vec3 orig = texture(src, uv).rgb;
  vec3 pc = o.w > 0.0 ? decomp(o.rgb / o.w) : orig;
  pc = mix(orig, pc, paint);

  // the cover's palette: the luminance picks the colour; saturated light (hot glass, sparks) and HDR keep their own
  float l = dot(pc, vec3(0.2126, 0.7152, 0.0722));
  vec3 rc = rampAt(pow(l / (l + 0.18), mix(0.85, 1.2, deck)) * 1.15);
  float mx = max(pc.r, max(pc.g, pc.b)), mn = min(pc.r, min(pc.g, pc.b));
  float satur = (mx - mn) / max(mx, 1e-4);
  float keep = clamp(smoothstep(0.55, 0.85, satur) * step(pc.b, pc.r) + smoothstep(1.0, 3.0, mx), 0.0, 1.0);
  vec3 col = mix(mix(pc, rc * (l / max(dot(rc, vec3(0.2126, 0.7152, 0.0722)), 1e-4)), mix(0.55, 0.8, deck)), pc, keep * (1.0 - 0.5 * deck));

  // dry-brush streaks along the stroke direction and a little canvas tooth
  vec2 px = uv / texel;
  vec2 sp = vec2(dot(px, dir / length(dir)), dot(px, nrm / length(nrm)));
  float st = snoise(sp * vec2(1.0 / 70.0, 1.0 / 3.5)) * 0.6 + snoise(sp * vec2(1.0 / 22.0, 1.0 / 1.6)) * 0.4;
  col *= 1.0 + stroke * st;
  col *= 1.0 + 0.025 * snoise(px * 0.9);
  fragColor = vec4(max(col, 0.0), 1.0);
}`;

export class PaintPass {
  pass: FSPass;
  constructor(ramp: string[] = COVER_RAMP_HEX, ramp2: string[] = COVER_RAMP2_HEX) {
    const RAMP = ramp.map(hexToLinear), RAMP2 = ramp2.map(hexToLinear);
    this.pass = new FSPass(FS, {
      src: { value: null }, depthTex: { value: null },
      texel: { value: new THREE.Vector2(1 / (W * SCALE), 1 / (H * SCALE)) },
      near: { value: 0.5 }, far: { value: 6000 },
      radius: { value: 7 * SCALE }, paint: { value: 1 }, stroke: { value: 0.07 }, aniso: { value: 2.0 },
      ramp: { value: RAMP.map((c) => new THREE.Vector3(...c)) }, ramp2: { value: RAMP2.map((c) => new THREE.Vector3(...c)) }, deck: { value: 0 },
    });
  }
  render(r: THREE.WebGLRenderer, color: THREE.Texture, depth: THREE.Texture, cam: THREE.PerspectiveCamera, out: THREE.WebGLRenderTarget, deck = 0) {
    const u = this.pass.u;
    u.deck!.value = deck;
    u.src!.value = color; u.depthTex!.value = depth; u.near!.value = cam.near; u.far!.value = cam.far;
    this.pass.render(r, out);
  }
}

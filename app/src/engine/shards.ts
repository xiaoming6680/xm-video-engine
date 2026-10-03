// The glass break (C7): a picture cracks along Voronoi cells around an impact point, then the cells fly apart as
// shards, spinning, tilting (shading changes with the tilt) and rushing toward the lens; each shard keeps showing
// its own piece of the picture, with a bright bevel along its edges. A mesh of fan-triangulated cells, animated in
// the vertex shader from the time since the break (deterministic).
import * as THREE from 'three';
import { W, H } from './gl';
import { mulberry32 } from './util';

type P = [number, number];

/** Polygon of site i: the frame clipped by the bisector half-planes of every other site. */
function cell(sites: P[], i: number, pad: number): P[] {
  let poly: P[] = [[-pad, -pad], [W + pad, -pad], [W + pad, H + pad], [-pad, H + pad]];
  const [sx, sy] = sites[i]!;
  for (let j = 0; j < sites.length; j++) {
    if (j === i || poly.length === 0) continue;
    const [tx, ty] = sites[j]!;
    // keep points closer to s than to t:  (p - m)·(t - s) <= 0
    const mx = (sx + tx) / 2, my = (sy + ty) / 2, nx = tx - sx, ny = ty - sy;
    const f = (p: P) => (p[0] - mx) * nx + (p[1] - my) * ny;
    const out: P[] = [];
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k]!, b = poly[(k + 1) % poly.length]!;
      const fa = f(a), fb = f(b);
      if (fa <= 0) out.push(a);
      if ((fa <= 0) !== (fb <= 0)) {
        const u = fa / (fa - fb);
        out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
      }
    }
    poly = out;
  }
  return poly;
}

const VERT = /* glsl */ `
precision highp float;
in vec3 position;          // xy: screen px of this vertex in the unbroken picture
in vec2 aCenter;           // the shard's centroid
in vec3 aRand;
in float aEdge;            // 0 at the centroid, 1 on the shard's outline
uniform float uT;          // seconds since the break (negative: cracks still forming)
uniform vec2 uImpact;
uniform float uPower;
out vec2 vUv;
out float vEdge;
out float vShade;
void main() {
  vec2 d = aCenter - uImpact;
  float dist = length(d);
  vec2 dir = d / max(dist, 1.0);
  float tt = max(0.0, uT - dist / 4000.0);               // the break runs outward from the impact
  float v = uPower * (260.0 + 700.0 * aRand.x) * (0.5 + 500.0 / (dist + 260.0));
  vec2 c = aCenter + dir * v * tt + vec2(0.0, -120.0) * tt * tt;
  float ang = (aRand.y - 0.5) * 7.0 * tt * uPower;
  float tilt = (aRand.z - 0.5) * 9.0 * tt * uPower;
  float sc = 1.0 + tt * uPower * (0.5 + 1.4 * aRand.z);  // rushing toward the lens
  vec2 q = position.xy - aCenter;
  vec2 ax = normalize(vec2(cos(aRand.x * 6.28), sin(aRand.x * 6.28)));
  float along = dot(q, ax);
  q += ax * along * (cos(tilt) - 1.0);                    // fake 3D tilt: squash along a random axis
  float cs = cos(ang), sn = sin(ang);
  vec2 p = c + mat2(cs, sn, -sn, cs) * q * sc;
  vec2 clip = p / vec2(${W}.0, ${H}.0) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vUv = vec2(position.x / ${W}.0, 1.0 - position.y / ${H}.0);
  vEdge = aEdge;
  vShade = cos(tilt) * 0.5 + 0.5;
}`;

const FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
in float vEdge;
in float vShade;
uniform sampler2D uSrc;
uniform float uT, uLight;
out vec4 fragColor;
void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  // distance to the shard's outline in px (vEdge runs 0 at the centroid to 1 on the outline): a hairline crack
  // with a soft glow, the same width on every shard
  float px = (1.0 - vEdge) / max(fwidth(vEdge), 1e-4);
  float rim = (1.0 - smoothstep(0.0, 1.6, px)) + 0.35 * exp(-px / 5.0);
  float crack = uT < 0.0 ? smoothstep(-0.18, 0.0, uT) : 1.0;     // the cracks light up before it breaks
  c *= mix(0.7, 1.15, vShade);
  c += vec3(0.75, 0.88, 1.0) * rim * uLight * crack * (0.6 + 0.8 * vShade);
  fragColor = vec4(c, 1.0);
}`;

export class Shards {
  mat: THREE.RawShaderMaterial;
  scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  constructor(impact: P, seed = 7, n = 70) {
    const rnd = mulberry32(seed);
    const sites: P[] = [];
    // denser near the impact (small splinters), coarse far away
    for (let i = 0; i < n; i++) {
      const r = Math.pow(rnd(), 1.6) * 1250, a = rnd() * Math.PI * 2;
      sites.push([impact[0] + Math.cos(a) * r * 1.3, impact[1] + Math.sin(a) * r]);
    }
    const pos: number[] = [], ctr: number[] = [], rr: number[] = [], edge: number[] = [];
    sites.forEach((_, i) => {
      const poly = cell(sites, i, 40);
      if (poly.length < 3) return;
      let cx = 0, cy = 0;
      for (const p of poly) { cx += p[0]; cy += p[1]; }
      cx /= poly.length; cy /= poly.length;
      const r3 = [rnd(), rnd(), rnd()];
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k]!, b = poly[(k + 1) % poly.length]!;
        for (const [p, e] of [[[cx, cy], 0], [a, 1], [b, 1]] as const) {
          pos.push(p[0], p[1], 0); ctr.push(cx, cy); rr.push(...r3); edge.push(e);
        }
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aCenter', new THREE.Float32BufferAttribute(ctr, 2));
    g.setAttribute('aRand', new THREE.Float32BufferAttribute(rr, 3));
    g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
    this.mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { uSrc: { value: null }, uT: { value: -1 }, uImpact: { value: new THREE.Vector2(...impact) }, uPower: { value: 1 }, uLight: { value: 1 } },
      depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(g, this.mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }
  /** Draw the (cracking / flying) picture `src` over `out` (which should already hold what is behind the glass). */
  render(renderer: THREE.WebGLRenderer, src: THREE.Texture, out: THREE.WebGLRenderTarget, t: number, o: { power?: number; light?: number } = {}) {
    const u = this.mat.uniforms;
    u.uSrc!.value = src;
    u.uT!.value = t;
    u.uPower!.value = o.power ?? 1;
    u.uLight!.value = o.light ?? 1;
    renderer.setRenderTarget(out);
    renderer.render(this.scene, this.cam);
  }
}

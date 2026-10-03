// Motes in the air (from Still_Shining v10, 空气里的光点): glints catching the light around a character. A field of
// points repeating every L metres, always filling a box around the camera; each mote sits still in the air, or is
// carried along with her by `follow` (1: they fall with her and drift — glitter around her; 0: she falls past them —
// the motion-blur average draws them as streaks, the speed made visible). Glints twinkle as they turn. Two passes:
// the motes beyond her before she is laid over the world, the ones nearer than her after, so she sits among them.
// Keep `shift` continuous inside a shot (Still_Shining ss_main.ts moteShift: follow changes only on cuts). Size
// ~0.035 m reads at 5-15 m; units are metres (L = 38 m box around the camera, 6000 motes).
import * as THREE from 'three';
import { SCALE } from '../engine/gl';

const M = 6000, L = 38;

const VERT = /* glsl */ `
precision highp float;
in vec3 position;   // base position in the repeating box (0..L)
in vec4 seedv;      // phase, rate, size, hue
uniform mat4 viewMatrix, projectionMatrix;
uniform vec3 uCam, uShift;
uniform float uT, uFocal, uNear, uFar, uSize;
out float vI;
out vec3 vC;
void main() {
  // the copy of this mote nearest the camera: wrap into the box centred on it
  vec3 o = uCam - vec3(${L / 2}.0);
  vec3 p = mod(position + uShift - o, ${L}.0) + o;
  vec4 v = viewMatrix * vec4(p, 1.0);
  float d = -v.z;
  gl_Position = projectionMatrix * v;
  // which pass: beyond her (uNear = her distance, uFar = inf) or before her (0 .. her distance)
  float keep = step(uNear, d) * step(d, uFar) * step(0.4, d);
  float px = uSize * seedv.z * uFocal / max(d, 0.4);               // physical px
  gl_PointSize = clamp(px, 1.0, 9.0 * ${SCALE.toFixed(1)});
  // energy kept when the point is clamped to 1 px, faded out at the far edge of the box and right at the lens
  float area = px * px / max(gl_PointSize * gl_PointSize, 1e-3);
  float tw = pow(max(0.0, sin(seedv.x + uT * seedv.y)), 6.0);       // a glint as it turns
  vI = keep * (0.5 + 5.0 * tw) * min(1.0, area) * smoothstep(${(L / 2).toFixed(1)}, ${(L * 0.3).toFixed(1)}, d) * smoothstep(0.4, 1.5, d);
  vC = mix(vec3(1.0, 0.9, 0.78), vec3(0.85, 0.92, 1.0), seedv.w);
}`;

const FRAG = /* glsl */ `
precision highp float;
in float vI;
in vec3 vC;
uniform vec3 uTint;
uniform float uK;
out vec4 fragColor;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r = dot(q, q);
  if (r > 1.0 || vI <= 0.0) discard;
  fragColor = vec4(vC * uTint * uK * vI * exp(-r * 4.0), 1.0);
}`;

export class Motes {
  scene = new THREE.Scene();
  private mat: THREE.RawShaderMaterial;
  constructor() {
    const pos = new Float32Array(M * 3), sd = new Float32Array(M * 4);
    let s = 7;
    const rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    for (let i = 0; i < M; i++) {
      pos[i * 3] = rnd() * L; pos[i * 3 + 1] = rnd() * L; pos[i * 3 + 2] = rnd() * L;
      sd[i * 4] = rnd() * 6.283; sd[i * 4 + 1] = 2 + rnd() * 9; sd[i * 4 + 2] = 0.5 + rnd() * rnd() * 2.2; sd[i * 4 + 3] = rnd();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('seedv', new THREE.BufferAttribute(sd, 4));
    this.mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        uCam: { value: new THREE.Vector3() }, uShift: { value: new THREE.Vector3() }, uT: { value: 0 }, uFocal: { value: 1 },
        uNear: { value: 0 }, uFar: { value: 1e9 }, uSize: { value: 0.05 }, uTint: { value: new THREE.Vector3(1, 1, 1) }, uK: { value: 1 },
      },
      blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
    });
    const pts = new THREE.Points(g, this.mat);
    pts.frustumCulled = false;
    this.scene.add(pts);
  }

  /**
   * Draw one pass of the motes into `rt` (added). shift: how far the air has carried them (m, world: e.g. her
   * displacement x follow); k: brightness; tint: the light on them (the low sun's colour by day, the city's by night);
   * range: [near, far] distance band of this pass (m).
   */
  render(renderer: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget, cam: THREE.PerspectiveCamera, shift: THREE.Vector3, t: number, k: number, tint: THREE.Color, range: [number, number], size = 0.05) {
    if (k <= 0.001) return;
    const u = this.mat.uniforms;
    (u.uCam!.value as THREE.Vector3).copy(cam.position);
    (u.uShift!.value as THREE.Vector3).copy(shift);
    u.uT!.value = t; u.uK!.value = k; u.uSize!.value = size;
    u.uNear!.value = range[0]; u.uFar!.value = range[1];
    (u.uTint!.value as THREE.Vector3).set(tint.r, tint.g, tint.b);
    u.uFocal!.value = (rt.height / 2) / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    renderer.setRenderTarget(rt);
    renderer.render(this.scene, cam);
  }
}

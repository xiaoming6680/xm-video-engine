// A pixel-art world filmed by a real 3D camera (the bad-time-mv look, rewritten for this engine):
//   * `world`: a small Canvas2D (default 480 x 270) drawn in pixel units and sampled NEAREST, so pixels stay square
//     however the camera zooms; `emi`: the same size, only what glows (drawn there too) — added with `glow` gain so
//     the engine's bloom picks up exactly those pixels
//   * the camera looks at world point (x, y) and can pitch / yaw / roll / dolly (zoom): the flat world tilts into a
//     trapezoid, turns, rushes in; a far "void" plane behind it (dot grid + twinkling squares) gives parallax depth
//   * optional dot-matrix gaps between world pixels (visible when zoomed in)
// Everything in the shader is a ray-plane intersection, so it is a pure function of the camera you pass.
//   const st = new PixelStage();                       st.world.clear('#000'); …draw…; st.emi.clear(); …draw glows…
//   st.render(renderer, out, { x: 240, y: 135, zoom: 1, roll: 0.05, pitch: -0.2 }, { t: f.t, glow: 2.5 });
import * as THREE from 'three';
import { FSPass, Layer2D, W, H } from '../engine/gl';

export interface StageCam { x: number; y: number; zoom?: number; roll?: number; pitch?: number; yaw?: number }
export interface StageOpts {
  t: number;
  /** Gain of the emissive layer (> 1 blooms). */
  glow?: number;
  /** 0..1 dark gaps between world pixels. */
  grid?: number;
  /** Void behind the world: strength, dot spacing (world px), its colour (linear) and depth behind the world. */
  voidAmt?: number;
  voidStep?: number;
  voidColor?: [number, number, number];
  voidDepth?: number;
  /** Vertical field of view (radians). */
  fov?: number;
}

export class PixelStage {
  world: Layer2D;
  emi: Layer2D;
  private pass: FSPass;
  constructor(public w = 480, public h = 270) {
    this.world = new Layer2D(w, h, 1);
    this.emi = new Layer2D(w, h, 1);
    for (const l of [this.world, this.emi]) {
      l.texture.magFilter = THREE.NearestFilter;
      l.texture.minFilter = THREE.LinearFilter;
      l.ctx.imageSmoothingEnabled = false;
    }
    this.pass = new FSPass(/* glsl */ `
      uniform sampler2D world, emi; uniform vec2 wsize; uniform vec3 camPos, fwd, right, down; uniform vec2 tanH;
      uniform float glow, grid, voidAmt, voidStep, voidDepth, time; uniform vec3 voidCol;
      vec3 voidAt(vec3 dir) {
        float tt = (voidDepth - camPos.z) / dir.z;
        if (tt <= 0.0 || voidAmt <= 0.0) return vec3(0.0);
        vec2 p = camPos.xy + dir.xy * tt;
        vec2 cell = floor(p / voidStep), f = fract(p / voidStep);
        float dotv = step(f.x, 0.1) * step(f.y, 0.1);
        float tw = step(0.986, hash12(cell + 7.0)) * (0.45 + 0.55 * sin(time * 3.0 + hash12(cell) * 40.0));
        float sq = step(0.997, hash12(floor(p / (voidStep * 2.0)) + 3.0));
        float fade = sat(1.0 - length(p - wsize * 0.5) / (wsize.x * 1.6));
        return (voidCol * dotv + vec3(tw) * 0.4 + vec3(0.18) * sq) * voidAmt * fade;
      }
      void main() {
        vec2 s = vUv * 2.0 - 1.0;
        vec3 dir = fwd + right * s.x * tanH.x - down * s.y * tanH.y;     // vUv.y is up; world y is down
        vec3 col = voidAt(dir);
        float tt = -camPos.z / dir.z;
        if (tt > 0.0) {
          vec2 wp = camPos.xy + dir.xy * tt;                           // world px (y down)
          vec2 uv = vec2(wp.x / wsize.x, 1.0 - wp.y / wsize.y);
          if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
            vec4 c = texture(world, uv);
            vec2 pf = fract(wp);
            c.rgb *= 1.0 - grid * 0.8 * max(step(0.84, pf.x), step(0.84, pf.y)) * c.a;
            col = mix(col, c.rgb, c.a);
            vec4 e = texture(emi, uv);
            col += e.rgb * e.a * glow;
          }
        }
        fragColor = vec4(col, 1.0);
      }`, {
      world: { value: this.world.texture }, emi: { value: this.emi.texture }, wsize: { value: new THREE.Vector2(w, h) },
      camPos: { value: new THREE.Vector3() }, fwd: { value: new THREE.Vector3() }, right: { value: new THREE.Vector3() }, down: { value: new THREE.Vector3() },
      tanH: { value: new THREE.Vector2() }, glow: { value: 2 }, grid: { value: 0 }, voidAmt: { value: 1 }, voidStep: { value: 12 },
      voidDepth: { value: 300 }, voidCol: { value: new THREE.Vector3() }, time: { value: 0 },
    });
  }

  /** Upload both layers and draw the stage into `out` (overwrites it). */
  render(renderer: THREE.WebGLRenderer, out: THREE.WebGLRenderTarget, cam: StageCam, o: StageOpts) {
    this.world.upload(); this.emi.upload();
    const fov = o.fov ?? 0.7, ty = Math.tan(fov / 2), tx = ty * (W / H);
    // the camera starts looking down +z at the world plane (z = 0), x right, y down; roll about the view axis,
    // then pitch (about x) and yaw (about y)
    const F = new THREE.Vector3(0, 0, 1), R = new THREE.Vector3(1, 0, 0), D = new THREE.Vector3(0, 1, 0);
    const roll = new THREE.Quaternion().setFromAxisAngle(F, cam.roll ?? 0);
    const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(cam.pitch ?? 0, cam.yaw ?? 0, 0, 'YXZ')).multiply(roll);
    F.applyQuaternion(rot); R.applyQuaternion(rot); D.applyQuaternion(rot);
    // distance that shows the world's full height at zoom 1
    const dist = this.h / 2 / ty / (cam.zoom ?? 1);
    const u = this.pass.u;
    (u.camPos!.value as THREE.Vector3).set(cam.x - F.x * dist, cam.y - F.y * dist, -F.z * dist);
    (u.fwd!.value as THREE.Vector3).copy(F); (u.right!.value as THREE.Vector3).copy(R); (u.down!.value as THREE.Vector3).copy(D);
    (u.tanH!.value as THREE.Vector2).set(tx, ty);
    u.glow!.value = o.glow ?? 2;
    u.grid!.value = o.grid ?? 0;
    u.voidAmt!.value = o.voidAmt ?? 1;
    u.voidStep!.value = o.voidStep ?? 12;
    u.voidDepth!.value = o.voidDepth ?? 300;
    (u.voidCol!.value as THREE.Vector3).set(...(o.voidColor ?? [0.03, 0.05, 0.14]));
    u.time!.value = o.t;
    this.pass.render(renderer, out);
  }
}

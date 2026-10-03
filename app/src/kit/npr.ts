// The drawn look (v6.1, the user: "do it in pdoom's dimension" — code-built 3D drawn flat, not rendered real):
// the 3D world is drawn as anime layout line art. Lines come from the geometry (depth breaks = silhouettes,
// normal breaks = creases), the fill is a flat graphic gradient by depth, and only what emits light keeps its
// colour (windows, lamps, signals) — plus whatever the `color` mask lets through (the sunrise colouring the world
// in). Teto, the wires and the rain are drawn after this pass, over it.
import * as THREE from 'three';
import { FSPass, W, H, makeRT, SCALE } from '../engine/gl';

export interface NprLook {
  /** Fill colours near / far (linear) and the depth (m) over which near turns far. */
  fillNear: THREE.Color;
  fillFar: THREE.Color;
  fillDist: number;
  /** Line colour (linear, can be > 1 to glow) and width (px). */
  line: THREE.Color;
  width: number;
  /** How much of the lit image shows through the fill (0 = flat fill, 1 = the rendered colour). */
  color: number;
  /** Light pools: how much the lamps' light brightens the fill (posterised). */
  pools: number;
  /** Emitters (luminance above this) keep their own colour. */
  emitAbove: number;
}

export class NprPass {
  normalRT = makeRT(W, H);
  private normalMat = new THREE.MeshNormalMaterial();
  private pass: FSPass;
  constructor() {
    this.pass = new FSPass(/* glsl */ `
      uniform sampler2D colTex, depthTex, nrmTex;
      uniform float near, far, width, colorK, pools, emitAbove, fillDist;
      uniform vec3 fillNear, fillFar, lineCol;
      uniform vec2 texel;
      float lin(vec2 uv) { float d = texture(depthTex, uv).r; return near * far / (far - d * (far - near)); }
      void main() {
        vec3 c = texture(colTex, vUv).rgb;
        float z = lin(vUv);
        vec3 n = texture(nrmTex, vUv).rgb * 2.0 - 1.0;
        bool sky = texture(depthTex, vUv).r >= 0.99999;
        // edges: the largest relative depth step and normal turn in a small ring
        float ed = 0.0, en = 0.0;
        for (int i = 0; i < 8; i++) {
          float a = float(i) * 0.785398;
          vec2 o = vec2(cos(a), sin(a)) * texel * width;
          float z2 = lin(vUv + o);
          ed = max(ed, abs(z2 - z) / min(z, z2));
          vec3 n2 = texture(nrmTex, vUv + o).rgb * 2.0 - 1.0;
          en = max(en, 1.0 - dot(n, n2));
        }
        float line = max(smoothstep(0.04, 0.12, ed), smoothstep(0.25, 0.6, en) * (1.0 - smoothstep(60.0, 200.0, z)));
        // the fill: flat, by depth; lamp pools posterised into two steps
        float k = 1.0 - exp(-z / fillDist);
        vec3 fill = mix(fillNear, fillFar, k);
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        float pool = smoothstep(0.05, 0.12, l) * 0.5 + smoothstep(0.2, 0.35, l) * 0.5;
        fill += pools * pool * normalize(c + 1e-4) * 0.35;
        vec3 o = mix(fill, c, colorK);
        // emitters keep their colour
        float em = smoothstep(emitAbove, emitAbove * 1.6, l);
        o = mix(o, c, em);
        o = mix(o, lineCol, line * (1.0 - em));
        if (sky) o = c;
        fragColor = vec4(o, 1.0);
      }`, {
      colTex: { value: null }, depthTex: { value: null }, nrmTex: { value: null },
      near: { value: 0.1 }, far: { value: 1000 }, width: { value: 1.2 }, colorK: { value: 0 }, pools: { value: 1 },
      emitAbove: { value: 0.6 }, fillDist: { value: 60 },
      fillNear: { value: new THREE.Color() }, fillFar: { value: new THREE.Color() }, lineCol: { value: new THREE.Color() },
      texel: { value: new THREE.Vector2(1 / (W * SCALE), 1 / (H * SCALE)) },
    });
  }
  /** Normals of the opaque world (objects in `skip` hidden: wires, rain, halos, cels, the sky). */
  renderNormals(r: THREE.WebGLRenderer, scene: THREE.Scene, cam: THREE.Camera, skip: THREE.Object3D[]) {
    const vis = skip.map((o) => o.visible);
    skip.forEach((o) => (o.visible = false));
    const prev = scene.overrideMaterial;
    scene.overrideMaterial = this.normalMat;
    r.setRenderTarget(this.normalRT);
    r.setClearColor(0x8080ff, 1);
    r.clear(true, true, true);
    r.render(scene, cam);
    scene.overrideMaterial = prev;
    skip.forEach((o, i) => (o.visible = vis[i]!));
  }
  render(r: THREE.WebGLRenderer, color: THREE.Texture, depth: THREE.Texture, cam: THREE.PerspectiveCamera, look: NprLook, out: THREE.WebGLRenderTarget) {
    const u = this.pass.u;
    u.colTex!.value = color; u.depthTex!.value = depth; u.nrmTex!.value = this.normalRT.texture;
    u.near!.value = cam.near; u.far!.value = cam.far;
    u.width!.value = look.width; u.colorK!.value = look.color; u.pools!.value = look.pools; u.emitAbove!.value = look.emitAbove;
    u.fillDist!.value = look.fillDist;
    (u.fillNear!.value as THREE.Color).copy(look.fillNear); (u.fillFar!.value as THREE.Color).copy(look.fillFar);
    (u.lineCol!.value as THREE.Color).copy(look.line);
    this.pass.render(r, out);
  }
}

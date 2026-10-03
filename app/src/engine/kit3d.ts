// Physically based helpers for the v2 scenes (docs/TREATMENT.md): a colour + depth target, raymarched volumetric light
// with a real shadow map (shafts through blinds / roof slots), and a gather depth of field. Passes over the HDR frame,
// before the engine's post. (Grew out of the concept frames, concepts/kit.ts.)
import * as THREE from 'three';
import { FSPass, makeRT, W, H, SCALE } from './gl';

/** HDR colour + float depth texture of one camera view. */
export class GBuf {
  rt: THREE.WebGLRenderTarget;
  constructor(w = W, h = H) {
    this.rt = makeRT(w, h);
    const d = new THREE.DepthTexture(this.rt.width, this.rt.height, THREE.FloatType);
    d.minFilter = d.magFilter = THREE.NearestFilter;
    this.rt.depthTexture = d;
  }
  render(r: THREE.WebGLRenderer, scene: THREE.Scene, cam: THREE.Camera, clear = new THREE.Color(0, 0, 0)) {
    r.setRenderTarget(this.rt);
    r.setClearColor(clear, 1);
    r.clear(true, true, true);
    r.render(scene, cam);
  }
  get color() { return this.rt.texture; }
  get depth() { return this.rt.depthTexture!; }
}

const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });

/**
 * A light that fills the air: its frustum (perspective = a spot / a window / a screen, orthographic = the sun) is the
 * beam, a depth map from the light gives the occlusion, and the pass raymarches the camera ray through it. Objects on
 * layer 2 do not occlude (e.g. the emitter itself).
 */
export class VolLight {
  cam: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private map: THREE.WebGLRenderTarget;
  color = new THREE.Color(1, 1, 1);
  /** In-scattering density (1/m) and its fbm modulation 0..1 (drifting haze). */
  density = 0.08;
  noise = 0.6;
  noiseScale = 1.2;
  /** Inverse-square falloff distance (m); 0 = none (sun). */
  falloff = 0;
  /** Soft edge of the frustum in light UV (0 = hard). */
  edge = 0.08;
  /** Henyey–Greenstein anisotropy: >0 glows when looking into the light. */
  g = 0.35;
  constructor(cam: THREE.PerspectiveCamera | THREE.OrthographicCamera, size = 2048) {
    this.cam = cam;
    this.cam.layers.enable(0);
    this.cam.layers.disable(2);
    this.map = new THREE.WebGLRenderTarget(size, size, { depthBuffer: true });
    const d = new THREE.DepthTexture(size, size, THREE.FloatType);
    d.minFilter = d.magFilter = THREE.NearestFilter;
    this.map.depthTexture = d;
  }
  update(r: THREE.WebGLRenderer, scene: THREE.Scene) {
    this.cam.updateMatrixWorld(true);
    (this.cam as THREE.PerspectiveCamera).updateProjectionMatrix();
    const prev = scene.overrideMaterial, bg = scene.background;
    scene.overrideMaterial = depthOnly;
    scene.background = null;
    r.setRenderTarget(this.map);
    r.clear(true, true, true);
    r.render(scene, this.cam);
    scene.overrideMaterial = prev;
    scene.background = bg;
  }
  get depth() { return this.map.depthTexture!; }
  viewProj() { return new THREE.Matrix4().multiplyMatrices(this.cam.projectionMatrix, this.cam.matrixWorldInverse); }
}

const MAXL = 3;

/** Adds the in-scattered light of up to 3 VolLights to a GBuf's colour, writing into `out`. */
export class VolPass {
  private pass: FSPass;
  steps = 72;
  constructor() {
    const lu = (i: number) => `uniform sampler2D ld${i};`;
    this.pass = new FSPass(/* glsl */ `
      uniform sampler2D colTex, depthTex; ${[0, 1, 2].map(lu).join(' ')}
      uniform mat4 invVP; uniform vec3 camPos; uniform float seed; uniform int steps; uniform float maxDist; uniform int nL;
      uniform mat4 lVP[${MAXL}]; uniform vec3 lPos[${MAXL}]; uniform vec3 lCol[${MAXL}];
      uniform vec4 lPar[${MAXL}]; // density, noise, noiseScale, falloff
      uniform vec4 lPar2[${MAXL}]; // edge, g, ortho(0/1), unused
      uniform vec3 lDir[${MAXL}];
      float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }
      float shadowAt(int i, vec2 uv) {
        return i == 0 ? texture(ld0, uv).r : i == 1 ? texture(ld1, uv).r : texture(ld2, uv).r;
      }
      void main() {
        vec3 col = texture(colTex, vUv).rgb;
        float d = texture(depthTex, vUv).r;
        vec4 wp = invVP * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); wp /= wp.w;
        vec3 rd = wp.xyz - camPos; float tmax = min(length(rd), maxDist); rd = normalize(rd);
        float j = hash12(gl_FragCoord.xy * 0.731 + seed * 17.13);
        float dt = tmax / float(steps);
        vec3 acc = vec3(0.0);
        for (int li = 0; li < ${MAXL}; li++) {
          if (li >= nL) break;
          vec4 P = lPar[li], P2 = lPar2[li];
          vec3 sum = vec3(0.0);
          for (int s = 0; s < 160; s++) {
            if (s >= steps) break;
            vec3 p = camPos + rd * (float(s) + j) * dt;
            vec4 lc = lVP[li] * vec4(p, 1.0); lc.xyz /= lc.w;
            vec2 luv = lc.xy * 0.5 + 0.5;
            if (luv.x < 0.0 || luv.x > 1.0 || luv.y < 0.0 || luv.y > 1.0 || lc.z > 1.0 || lc.z < -1.0) continue;
            float lz = lc.z * 0.5 + 0.5;
            float vis = lz <= shadowAt(li, luv) + 0.0004 ? 1.0 : 0.0;
            if (vis == 0.0) continue;
            vec2 e = min(luv, 1.0 - luv);
            float edge = P2.x > 0.0 ? smoothstep(0.0, P2.x, min(e.x, e.y)) : 1.0;
            vec3 L = P2.z > 0.5 ? -lDir[li] : lPos[li] - p;
            float dist = length(L); L /= max(dist, 1e-4);
            float att = P.w > 0.0 ? 1.0 / (1.0 + (dist * dist) / (P.w * P.w)) : 1.0;
            float n = fbm(p * P.z + vec3(0.0, seed * 0.0, 0.0), 3) * 0.5 + 0.5;
            float dens = P.x * mix(1.0, n * 1.6, P.y);
            sum += edge * att * dens * hg(dot(rd, L), P2.y);
          }
          acc += sum * dt * lCol[li];
        }
        fragColor = vec4(col + acc, 1.0);
      }`, {
      colTex: { value: null }, depthTex: { value: null }, ld0: { value: null }, ld1: { value: null }, ld2: { value: null },
      invVP: { value: new THREE.Matrix4() }, camPos: { value: new THREE.Vector3() }, seed: { value: 0 }, steps: { value: 72 }, maxDist: { value: 60 }, nL: { value: 0 },
      lVP: { value: [0, 1, 2].map(() => new THREE.Matrix4()) }, lPos: { value: [0, 1, 2].map(() => new THREE.Vector3()) },
      lCol: { value: [0, 1, 2].map(() => new THREE.Vector3()) }, lPar: { value: [0, 1, 2].map(() => new THREE.Vector4()) },
      lPar2: { value: [0, 1, 2].map(() => new THREE.Vector4()) }, lDir: { value: [0, 1, 2].map(() => new THREE.Vector3(0, -1, 0)) },
    });
  }
  render(r: THREE.WebGLRenderer, g: GBuf, cam: THREE.PerspectiveCamera, lights: VolLight[], out: THREE.WebGLRenderTarget, seed: number, maxDist = 60, color?: THREE.Texture) {
    const u = this.pass.u;
    u.colTex!.value = color ?? g.color; u.depthTex!.value = g.depth;
    cam.updateMatrixWorld(true);
    (u.invVP!.value as THREE.Matrix4).multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).invert();
    (u.camPos!.value as THREE.Vector3).copy(cam.getWorldPosition(new THREE.Vector3()));
    u.seed!.value = seed; u.steps!.value = this.steps; u.maxDist!.value = maxDist; u.nL!.value = Math.min(MAXL, lights.length);
    lights.slice(0, MAXL).forEach((l, i) => {
      (u[`ld${i}`]!).value = l.depth;
      (u.lVP!.value as THREE.Matrix4[])[i]!.copy(l.viewProj());
      (u.lPos!.value as THREE.Vector3[])[i]!.copy(l.cam.getWorldPosition(new THREE.Vector3()));
      (u.lCol!.value as THREE.Vector3[])[i]!.set(l.color.r, l.color.g, l.color.b);
      (u.lPar!.value as THREE.Vector4[])[i]!.set(l.density, l.noise, l.noiseScale, l.falloff);
      (u.lPar2!.value as THREE.Vector4[])[i]!.set(l.edge, l.g, (l.cam as THREE.OrthographicCamera).isOrthographicCamera ? 1 : 0, 0);
      (u.lDir!.value as THREE.Vector3[])[i]!.copy(l.cam.getWorldDirection(new THREE.Vector3()));
    });
    this.pass.render(r, out);
  }
}

/**
 * Single-pass gather depth of field (golden-angle spiral; background samples cannot blur over a sharper foreground).
 * CoC in logical px = aperture * |1/focus − 1/z| (z, focus in metres), capped at maxBlur.
 */
export class DofPass {
  private pass: FSPass;
  focus = 2;
  aperture = 40;
  maxBlur = 28;
  constructor() {
    this.pass = new FSPass(/* glsl */ `
      uniform sampler2D colTex, depthTex; uniform float near, far, focus, aperture, maxBlur, radScale, pxs; uniform vec2 texel;
      float lin(float d) { return near * far / (far - d * (far - near)); }
      float coc(float z) { return min(maxBlur, aperture * abs(1.0 / focus - 1.0 / z)); }
      void main() {
        float cz = lin(texture(depthTex, vUv).r);
        float cs = coc(cz);
        vec3 col = texture(colTex, vUv).rgb; float tot = 1.0;
        float rad = radScale; float ang = 0.0;
        for (int i = 0; i < 2000; i++) {
          if (rad >= maxBlur) break;
          vec2 tc = vUv + vec2(cos(ang), sin(ang)) * texel * rad * pxs;
          vec3 sc = texture(colTex, tc).rgb;
          float sz = lin(texture(depthTex, tc).r);
          float ss = coc(sz);
          if (sz > cz) ss = clamp(ss, 0.0, cs * 2.0);
          float m = smoothstep(rad - 0.5, rad + 0.5, ss);
          col += mix(col / tot, sc, m); tot += 1.0;
          rad += radScale / rad; ang += 2.39996323;
        }
        fragColor = vec4(col / tot, 1.0);
      }`, {
      colTex: { value: null }, depthTex: { value: null }, near: { value: 0.1 }, far: { value: 100 }, focus: { value: 2 }, aperture: { value: 40 },
      maxBlur: { value: 28 }, radScale: { value: 0.6 }, pxs: { value: SCALE }, texel: { value: new THREE.Vector2(1 / (W * SCALE), 1 / (H * SCALE)) },
    });
  }
  render(r: THREE.WebGLRenderer, color: THREE.Texture, depth: THREE.Texture, cam: THREE.PerspectiveCamera, out: THREE.WebGLRenderTarget) {
    const u = this.pass.u;
    u.colTex!.value = color; u.depthTex!.value = depth;
    u.near!.value = cam.near; u.far!.value = cam.far;
    u.focus!.value = this.focus; u.aperture!.value = this.aperture; u.maxBlur!.value = this.maxBlur;
    this.pass.render(r, out);
  }
}

/** Colour-only copy of a GBuf target (so a pass can read one target and write another). */
export function scratchRT() { return makeRT(W, H, { depthBuffer: false }); }

/**
 * The game worlds' look (docs/TREATMENT.md v2.1; the user: where plain 3D looks cheap, stylise): ink lines where depth
 * breaks (silhouettes, creases), light posterised into soft bands per stop, a touch of saturation. Reads as drawn, not
 * as a grey-box render.
 */
export class StylePass {
  private pass: FSPass;
  ink = 1;
  bands = 2.2;
  poster = 0.75;
  sat = 1.12;
  inkColor = new THREE.Color(0.03, 0.025, 0.03);
  constructor() {
    this.pass = new FSPass(/* glsl */ `
      uniform sampler2D colTex, depthTex; uniform float near, far, ink, bands, poster, sat; uniform vec2 texel; uniform vec3 inkCol;
      float lin(vec2 uv) { float d = texture(depthTex, uv).r; return near * far / (far - d * (far - near)); }
      void main() {
        vec3 c = texture(colTex, vUv).rgb;
        float z = lin(vUv);
        float e = 0.0;
        for (int i = 0; i < 8; i++) {
          float a = float(i) * 0.785398;
          vec2 o = vec2(cos(a), sin(a)) * texel * 1.6;
          e = max(e, (lin(vUv + o) - z) / z);
        }
        float line = smoothstep(0.035, 0.09, e) * ink;
        float l = max(luma(c), 1e-5);
        float q = exp2(floor(log2(l) * bands + 0.5) / bands);
        float soft = exp2(log2(l));
        vec3 pc = c * mix(1.0, q / l, poster);
        float pl = luma(pc);
        pc = max(mix(vec3(pl), pc, sat), 0.0);
        fragColor = vec4(mix(pc, inkCol * min(pl, 0.2), line), 1.0);
      }`, { colTex: { value: null }, depthTex: { value: null }, near: { value: 0.1 }, far: { value: 100 }, ink: { value: 1 }, bands: { value: 2.2 }, poster: { value: 0.75 }, sat: { value: 1.12 }, texel: { value: new THREE.Vector2(1 / (W * SCALE), 1 / (H * SCALE)) }, inkCol: { value: new THREE.Vector3() } });
  }
  render(r: THREE.WebGLRenderer, color: THREE.Texture, depth: THREE.Texture, cam: THREE.PerspectiveCamera, out: THREE.WebGLRenderTarget) {
    const u = this.pass.u;
    u.colTex!.value = color; u.depthTex!.value = depth; u.near!.value = cam.near; u.far!.value = cam.far;
    u.ink!.value = this.ink; u.bands!.value = this.bands; u.poster!.value = this.poster; u.sat!.value = this.sat;
    (u.inkCol!.value as THREE.Vector3).set(this.inkColor.r, this.inkColor.g, this.inkColor.b);
    this.pass.render(r, out);
  }
}

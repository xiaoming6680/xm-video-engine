// Sky demo (kit/clouds, kit/motes, kit/sunrays, kit/bokeh — from Still_Shining v10), loaded only with ?sky (see
// timeline.ts): high above a cloud sea at sunset, a glowing knot in focus a few metres away, a city of lights far
// below through the gaps. Shows the order: world (with depth) -> clouds -> motes beyond the subject -> lens blur ->
// subject -> motes before it -> sun shafts. Units: metres. New projects can delete it.
import * as THREE from 'three';
import { Scene, type Frame } from '../engine/scene';
import { W, H, makeRT, FSPass } from '../engine/gl';
import { Clouds, CLOUDS_DEFAULT, cloudLight } from '../kit/clouds';
import { Motes } from '../kit/motes';
import { SunRays } from '../kit/sunrays';
import { Bokeh } from '../kit/bokeh';
import { mulberry32 } from '../engine/util';

const SUN_ELEV = 2.5;

export default class DemoSky extends Scene {
  world = new THREE.Scene();
  subject = new THREE.Scene();
  cam = new THREE.PerspectiveCamera(50, W / H, 1, 200000);
  worldRT = (() => { const rt = makeRT(W, H); rt.depthTexture = new THREE.DepthTexture(rt.width, rt.height, THREE.FloatType); return rt; })();
  subjRT = makeRT(W, H, { samples: 4 });
  clouds = new Clouds();
  motes = new Motes();
  rays = new SunRays();
  bokeh = new Bokeh();
  sunDir = new THREE.Vector3(0, Math.sin(THREE.MathUtils.degToRad(SUN_ELEV)), -Math.cos(THREE.MathUtils.degToRad(SUN_ELEV)));
  knot!: THREE.Mesh;
  private sky = new FSPass(/* glsl */ `
    uniform mat4 invVP; uniform vec3 camPos, sunDir;
    void main() {
      vec4 a = invVP * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
      vec3 d = normalize(a.xyz / a.w - camPos);
      float e = d.y;
      vec3 c = mix(vec3(0.55, 0.42, 0.55), vec3(0.03, 0.08, 0.26), smoothstep(-0.02, 0.45, e));
      c = mix(c, vec3(0.05, 0.06, 0.14), smoothstep(0.0, -0.08, e));
      float s = max(dot(d, sunDir), 0.0);
      c += vec3(1.0, 0.75, 0.55) * (0.22 * pow(s, 24.0) + 1.4 * pow(s, 400.0)) + vec3(1.0, 0.95, 0.9) * 60.0 * step(0.99995, s);
      fragColor = vec4(c, 1.0);
    }`, { invVP: { value: new THREE.Matrix4() }, camPos: { value: new THREE.Vector3() }, sunDir: { value: new THREE.Vector3() } });

  override init() {
    this.clouds.init(this.ctx.renderer);
    // a city of lights far below (bright points: the lens opens them into discs)
    const rnd = mulberry32(5), n = 30000, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = 400 + 20000 * Math.sqrt(rnd()), a = rnd() * Math.PI * 2;
      pos.set([Math.cos(a) * r, 0, Math.sin(a) * r - 6000], i * 3);
      const w = rnd();
      col.set(w < 0.7 ? [6, 4.2, 2.2] : [3.5, 4.5, 6], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const lights = new THREE.Points(g, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true }));
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.012, 0.016, 0.04) }));
    ground.position.y = -1;
    this.world.add(ground, lights);
    // the subject in focus
    this.knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.9, 0.28, 220, 24), new THREE.MeshStandardMaterial({ color: 0x223355, emissive: new THREE.Color(0.9, 0.35, 0.5), emissiveIntensity: 0.22, roughness: 0.35, metalness: 0.2 }));
    const sun = new THREE.DirectionalLight(0xffe0c8, 3);
    sun.position.copy(this.sunDir).multiplyScalar(100);
    this.subject.add(this.knot, sun, new THREE.HemisphereLight(0x6f86c8, 0x1a1830, 0.8));
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const r = this.ctx.renderer, t = f.t;
    // the camera drifts down toward the cloud tops, the knot 7 m ahead of it
    const camPos = new THREE.Vector3(Math.sin(t * 0.05) * 60, 3600 - 18 * t, 900 - 30 * t);
    this.cam.position.copy(camPos);
    this.cam.lookAt(camPos.x, camPos.y - 1.8, camPos.z - 10);
    this.cam.updateMatrixWorld(true);
    const at = new THREE.Vector3(0, -0.15, -1).applyQuaternion(this.cam.quaternion).multiplyScalar(7).add(camPos);
    this.knot.position.copy(at);
    this.knot.rotation.set(t * 0.3, t * 0.45, 0);
    // world with depth: sky, then the city
    const u = this.sky.u;
    (u.invVP!.value as THREE.Matrix4).multiplyMatrices(this.cam.projectionMatrix, this.cam.matrixWorldInverse).invert();
    (u.camPos!.value as THREE.Vector3).copy(camPos); (u.sunDir!.value as THREE.Vector3).copy(this.sunDir);
    r.setRenderTarget(this.worldRT); r.setClearColor(0x000000, 1); r.clear(true, true, true);
    this.sky.render(r, this.worldRT);
    r.setRenderTarget(this.worldRT); r.render(this.world, this.cam);
    // clouds over the world
    const light = cloudLight(this.sunDir, SUN_ELEV, 1, 0.9, 1, new THREE.Color(0.32, 0.3, 0.46), 2.5e-5);
    if (this.clouds.render(r, this.cam, { ...CLOUDS_DEFAULT, cov: 0.5 }, light, t, t * 13.7)) this.ctx.comp.draw(r, this.clouds.rt.texture, this.worldRT, { mode: 'normal', premult: false });
    // motes beyond the subject (part of the world: the lens blurs them), drifting with the camera
    const shift = new THREE.Vector3(0, -0.6 * t, 0).add(camPos.clone().multiplyScalar(0.9));
    const tint = new THREE.Color(1.0, 0.86, 0.72).multiplyScalar(1.4);
    this.motes.render(r, this.worldRT, this.cam, shift, t, 0.9, tint, [7, 1e9], 0.035);
    // the lens: focus on the knot
    const blurred = this.bokeh.render(r, this.worldRT.texture, this.worldRT.depthTexture!, this.cam, { focus: 7, blur: 22 }, t * 7.3);
    this.ctx.comp.draw(r, blurred ? this.bokeh.out.texture : this.worldRT.texture, out, { mode: 'replace' });
    // the subject, sharp, then the motes before it and the shafts around it
    r.setRenderTarget(this.subjRT); r.setClearColor(0x000000, 0); r.clear(true, true, true);
    r.render(this.subject, this.cam);
    r.setClearColor(0x000000, 1);
    this.ctx.comp.draw(r, this.subjRT.texture, out, { mode: 'normal', premult: false });
    this.motes.render(r, out, this.cam, shift, t, 0.9, tint, [0, 7], 0.035);
    this.rays.render(r, out, this.worldRT.texture, this.worldRT.depthTexture!, this.subjRT.texture, this.cam, this.sunDir, 0.6, t * 5.1, this.ctx.comp);
    return { bloom: 0.45, bloomThreshold: 1.3, grain: 0.03, vignette: 0.14 };
  }
}

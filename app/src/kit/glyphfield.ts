// Glyph particles: characters as small quads in 3D, thousands at once (one instanced draw). The kaomoji.exe boot:
// the terminal bursts into tumbling letters that fly back and land as the character-grid face; also galaxies made
// of kaomoji, swarms, rain. Two parts:
//   cellsFromCanvas(canvas, atlas, { cell })  the glyph grid of a picture (brightness -> glyph by measured ink, the
//                                            colour of the picture): the landing targets / a static grid
//   GlyphParticles                           set each glyph's position (screen px, y down, z toward the viewer),
//                                            3D rotation, size, glyph and colour, then render into a target
// Positions are whatever the scene computes from f.t (explode, drift, ease to a cell): stays a pure function of time.
// The glyphs come from engine/ascii.ts GlyphAtlas (the same ramp as the Ascii pass, so landed particles and an
// Ascii-rendered grid look the same).
import * as THREE from 'three';
import type { GlyphAtlas } from '../engine/ascii';
import { W, H } from '../engine/gl';
import { hash } from '../engine/util';

export interface GlyphCell { x: number; y: number; g: number; color: [number, number, number]; l: number }

const lin = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };

/**
 * The glyph grid of a picture on a canvas that covers the frame (any backing size): cells `cell` px tall (logical),
 * as wide as the atlas glyphs. Each cell's brightness (luma, gained and gamma'd, plus a little dither) picks a glyph;
 * cells under `threshold` stay empty and are left out. `lum: 'max'` measures brightness by the brightest channel. Colours are linear and normalised to their brightest channel
 * times `boost` (the density carries the brightness, as in the Ascii pass). x, y = cell centres in logical px.
 */
export function cellsFromCanvas(cv: HTMLCanvasElement, atlas: GlyphAtlas, o: { cell: number; threshold?: number; gamma?: number; gain?: number; dither?: number; boost?: number; seed?: number; only?: string; lum?: 'luma' | 'max' }): GlyphCell[] {
  const ch = o.cell, cw = ch * atlas.aspect, k = cv.width / W;
  // `only`: pick from these glyphs alone (e.g. ' .-=+*#%@'), still in order of measured ink
  const sub = o.only ? atlas.ramp.map((g, i) => i).filter((i) => i > 0 && o.only!.includes(atlas.ramp[i]!)) : null;
  const pick = (l: number) => (sub && sub.length ? sub[Math.min(sub.length - 1, Math.round(l * (sub.length - 1)))]! : atlas.level(l));
  const img = cv.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, cv.width, cv.height).data;
  const at = (x: number, y: number) => { const i = (Math.min(cv.height - 1, Math.round(y * k)) * cv.width + Math.min(cv.width - 1, Math.round(x * k))) * 4; return [img[i]!, img[i + 1]!, img[i + 2]!, img[i + 3]!] as const; };
  const out: GlyphCell[] = [];
  for (let y = ch / 2; y < H; y += ch) for (let x = cw / 2; x < W; x += cw) {
    let r = 0, g = 0, b = 0;
    for (const [dx, dy] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) {
      const p = at(x + dx * cw, y + dy * ch), a = p[3] / 255;
      r += lin(p[0]) * a; g += lin(p[1]) * a; b += lin(p[2]) * a;
    }
    r /= 4; g /= 4; b /= 4;
    // brightness: luma, or the brightest channel ('max': a saturated colour counts as bright, so it gets dense glyphs)
    const L = o.lum === 'max' ? Math.max(r, g, b) : 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let l = Math.pow(Math.max(0, L * (o.gain ?? 1)), o.gamma ?? 0.6);
    l += (hash(x, y, o.seed ?? 3) - 0.5) * (o.dither ?? 0.5) / atlas.n;
    if (l < (o.threshold ?? 0.06)) continue;
    const mx = Math.max(r, g, b, 1e-4), bo = o.boost ?? 1;
    out.push({ x, y, g: pick(Math.min(1, l)), color: [(r / mx) * bo, (g / mx) * bo, (b / mx) * bo], l: Math.min(1, l) });
  }
  return out;
}

export class GlyphParticles {
  readonly max: number;
  count = 0;
  private geo: THREE.InstancedBufferGeometry;
  private iPos: THREE.InstancedBufferAttribute;
  private iRot: THREE.InstancedBufferAttribute;
  private iCol: THREE.InstancedBufferAttribute;
  private iGly: THREE.InstancedBufferAttribute;
  private mat: THREE.ShaderMaterial;
  private scene = new THREE.Scene();
  readonly cam: THREE.PerspectiveCamera;

  /** `size`: glyph height in px at z = 0; `blend`: 'add' (glow on dark grounds) or 'normal'. */
  constructor(private atlas: GlyphAtlas, max: number, o: { size?: number; blend?: 'add' | 'normal'; fov?: number } = {}) {
    this.max = max;
    const size = o.size ?? 22, fov = o.fov ?? 35;
    // a camera that maps the z = 0 plane 1:1 to logical px
    this.cam = new THREE.PerspectiveCamera(fov, W / H, 1, 20000);
    this.cam.position.set(0, 0, H / 2 / Math.tan(THREE.MathUtils.degToRad(fov / 2)));
    this.cam.lookAt(0, 0, 0);
    const plane = new THREE.PlaneGeometry(size * atlas.aspect, size);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = plane.index;
    this.geo.setAttribute('position', plane.getAttribute('position'));
    this.geo.setAttribute('uv', plane.getAttribute('uv'));
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);  // x, y, z, scale
    this.iRot = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);  // euler x, y, z
    this.iCol = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);  // linear rgb, alpha
    this.iGly = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    for (const a of [this.iPos, this.iRot, this.iCol, this.iGly]) a.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iPos', this.iPos); this.geo.setAttribute('iRot', this.iRot);
    this.geo.setAttribute('iCol', this.iCol); this.geo.setAttribute('iGly', this.iGly);
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { atlas: { value: atlas.texture }, n: { value: atlas.n } },
      vertexShader: /* glsl */ `
        in vec4 iPos; in vec3 iRot; in vec4 iCol; in float iGly;
        out vec2 vUv; out vec4 vCol; flat out float vGly;
        mat3 rx(float a) { float c = cos(a), s = sin(a); return mat3(1, 0, 0, 0, c, s, 0, -s, c); }
        mat3 ry(float a) { float c = cos(a), s = sin(a); return mat3(c, 0, -s, 0, 1, 0, s, 0, c); }
        mat3 rz(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0, -s, c, 0, 0, 0, 1); }
        void main() {
          vUv = uv; vCol = iCol; vGly = iGly;
          vec3 p = rz(iRot.z) * ry(iRot.y) * rx(iRot.x) * (position * iPos.w) + iPos.xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D atlas; uniform float n;
        in vec2 vUv; in vec4 vCol; flat in float vGly;
        out vec4 fragColor;   // (with glslVersion GLSL3, three r186 declares no output of its own)
        void main() {
          float a = texture(atlas, vec2((vGly + vUv.x) / n, vUv.y)).a * vCol.a;
          if (a < 0.003) discard;
          fragColor = vec4(vCol.rgb * a, a);
        }`,
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor,
      blendDst: o.blend === 'normal' ? THREE.OneMinusSrcAlphaFactor : THREE.OneFactor,
    });
    const mesh = new THREE.Mesh(this.geo, this.mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  /** Glyph i at screen (x, y) px (y down), z px toward the viewer, rotations (radians), scale, ramp glyph, linear colour, alpha. */
  set(i: number, x: number, y: number, z: number, rx: number, ry: number, rz: number, s: number, g: number, c: [number, number, number], a = 1) {
    this.iPos.setXYZW(i, x - W / 2, H / 2 - y, z, s);
    this.iRot.setXYZ(i, rx, ry, rz);
    this.iCol.setXYZW(i, c[0], c[1], c[2], a);
    this.iGly.setX(i, g);
  }

  /** Draw the first `count` glyphs over `out` (blended, does not clear). */
  render(renderer: THREE.WebGLRenderer, out: THREE.WebGLRenderTarget, count: number) {
    this.count = Math.min(count, this.max);
    this.geo.instanceCount = this.count;
    for (const a of [this.iPos, this.iRot, this.iCol, this.iGly]) { a.needsUpdate = true; a.clearUpdateRanges(); a.addUpdateRange(0, this.count * a.itemSize); }
    renderer.setRenderTarget(out);
    renderer.render(this.scene, this.cam);
  }
}

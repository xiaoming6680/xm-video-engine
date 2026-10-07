// ?ref=intro, 0–4.68 s (bars 1–3; docs/复刻配方.md): the kaomoji.exe boot before ref_boot, timed to the reference
// (song time = its time, 150 BPM, a bar = 1.6 s). A green block cursor; the boot log jumps in close and zoomed,
// scrolls up faster and faster and smears into glyph rain; the camera tilts down until the rain falls onto a floor
// of log rows with the progress bar at its front edge, creeping forward; a whip pan to the right lands on ref_boot's
// terminal close-up. One camera (GlyphParticles.cam) shoots the rain and the floor, so the tilt is a real 3D move.
// Text is our own. Animatic pass: layout, timing and camera are the reference's; detail comes in the fine pass.
import * as THREE from 'three';
import { Scene, type Frame } from '../engine/scene';
import { FSPass, Layer2D, W, H, SCALE } from '../engine/gl';
import { F, font } from '../engine/type';
import { GlyphAtlas } from '../engine/ascii';
import { GlyphParticles } from '../kit/glyphfield';
import { clamp, ease, frameIdx, hash, keys, mulberry32, prog } from '../engine/util';

// key times (song s)
const LOG = 0.8, SCROLL = 1.18, RAIN = 1.63, SCAN = 2.32, TILT = 2.78, FLOOR = 3.3, WHIP = 4.56, OUT = 4.7;
const GREEN = '#65F09E', TEXT = '#AABAB1', ORANGE = '#F0A040', PINK = '#F078A8';
const MONO = F.mono(600);
const RAIN_CHARS = '()•ω^_-=+*:;.,|/\\<>[]{}°~!?#%@0123456789ABCDEFx';
const HEX = 'E2 80 A2 20 CF 89 20 E2 80 A2'.split(' ');
const NCOL = 170, PER = 34;
const FOV = 35, CAM_D = H / 2 / Math.tan((FOV / 2) * Math.PI / 180);
const FLOOR_Y = -620, FLOOR_W = 5200, FLOOR_D = 5200, FLOOR_Z0 = 420;   // world px (y up, z toward the camera)

interface Col { x: number; z: number; sp: number; y0: number; len: number; pink: boolean; hex: boolean; seed: number }

export default class RefIntroTerm extends Scene {
  bg = new FSPass(/* glsl */ `
    uniform vec3 edge, center;
    void main() {
      vec2 p = (vUv - vec2(0.5, 0.55)) * vec2(${(W / H).toFixed(4)}, 1.0);
      fragColor = vec4(mix(center, edge, smoothstep(0.0, 0.8, length(p))), 1.0);
    }`, { edge: { value: new THREE.Vector3() }, center: { value: new THREE.Vector3() } });
  text = new Layer2D();
  atlas!: GlyphAtlas;
  parts!: GlyphParticles;
  cols: Col[] = [];
  floorCv = document.createElement('canvas');
  floorTex!: THREE.CanvasTexture;
  floorScene = new THREE.Scene();
  floorMat!: THREE.MeshBasicMaterial;
  floorKey = -1;
  gmap = new Map<string, number>();

  override init() {
    this.atlas = new GlyphAtlas({ chars: RAIN_CHARS });
    this.atlas.ramp.forEach((ch, i) => this.gmap.set(ch, i));
    this.parts = new GlyphParticles(this.atlas, NCOL * PER + 64, { size: 46, fov: FOV });
    const rnd = mulberry32(5);
    for (let i = 0; i < NCOL; i++) {
      // most columns near the camera (dense, readable glyphs), some far ones for depth; spread over the frustum's width
      const z = rnd() < 0.8 ? -700 + rnd() * 1300 : -3200 + rnd() * 2300;
      const half = (CAM_D - z) * Math.tan((FOV / 2) * Math.PI / 180) * (W / H) * 1.1;
      this.cols.push({ x: (rnd() - 0.5) * 2 * half, z, sp: 800 + rnd() * 900, y0: rnd() * 4000, len: 16 + Math.floor(rnd() * (PER - 16)), pink: rnd() < 0.1, hex: false, seed: i * 7 + 1 });
    }
    // the orange hex column, right of centre and close
    this.cols[0] = { x: 330, z: 150, sp: 520, y0: 900, len: HEX.length * 2, pink: false, hex: true, seed: 3 };
    // the floor: log rows on a plane, drawn into a canvas texture (redrawn when the progress figure changes)
    this.floorCv.width = 2048 * Math.min(SCALE, 2); this.floorCv.height = 2048 * Math.min(SCALE, 2);
    this.floorTex = new THREE.CanvasTexture(this.floorCv);
    this.floorTex.colorSpace = THREE.SRGBColorSpace;
    this.floorTex.anisotropy = 8;
    this.floorMat = new THREE.MeshBasicMaterial({ map: this.floorTex, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, color: new THREE.Color(1.5, 1.5, 1.5) });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR_W, FLOOR_D), this.floorMat);
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(0, FLOOR_Y, FLOOR_Z0 - FLOOR_D / 2);
    this.floorScene.add(plane);
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer } = this.ctx, t = f.t;
    const lin = (r: number, g: number, b: number) => new THREE.Vector3(...[r, g, b].map((v) => Math.pow(v / 255, 2.2)));
    (this.bg.u.edge!.value as THREE.Vector3).copy(lin(12, 20, 17));
    (this.bg.u.center!.value as THREE.Vector3).copy(t < RAIN ? lin(30, 44, 38) : lin(18, 30, 25));
    this.bg.render(renderer, out);
    if (t < RAIN + 0.05) this.boot(f, out);
    if (t >= RAIN - 0.08) this.world(f, out);
    // red scan bar sweeping down over the rain
    const sp = prog(t, SCAN, SCAN + 0.22);
    if (sp > 0 && sp < 1) {
      const c = this.text.ctx; this.text.clear();
      const y = -H * 0.1 + H * 1.2 * ease.inOutQuad(sp), g = c.createLinearGradient(0, y - 40, 0, y + 40);
      g.addColorStop(0, 'rgba(255,50,30,0)'); g.addColorStop(0.5, 'rgba(255,60,35,0.85)'); g.addColorStop(1, 'rgba(255,50,30,0)');
      c.fillStyle = g; c.fillRect(0, y - 40, W, 80);
      this.ctx.comp.draw(renderer, this.text.upload(), out, { mode: 'add' });
    }
    return { crt: 1, crtCurve: 0.13, crtLines: 300, vignette: 0.8, bloom: 0.6, bloomThreshold: 0.7, bloomRadius: 0.7, halation: 0.08, ca: 1.6, grain: 0.035, phosphor: 0.45,
      flash: t >= LOG ? 0.5 * Math.exp(-(t - LOG) * 30) : 0 };
  }

  /** 0 – 1.63: the cursor, then the boot log (zooming in, then scrolling up into streaks). */
  private boot(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp } = this.ctx, t = f.t, c = this.text.ctx;
    this.text.clear();
    if (t < LOG) {
      // the block cursor: big, a little left of centre, shrinking slowly as the camera pulls back; glowing
      // (a breathing glow and a slow drift: the tube is alive before anything is typed)
      c.translate(Math.sin(t * 3.1) * 6, Math.cos(t * 2.3) * 4);
      const k = (1 - 0.14 * ease.outQuad(prog(t, 0, LOG))) * (1 + 0.03 * Math.sin(t * 9)), w = W * 0.1 * k * (1 - 0.15 * prog(t, 0.35, 0.45) * (1 - prog(t, 0.55, 0.7))), h = H * 0.36 * k;
      c.shadowColor = 'rgba(101,240,158,0.9)'; c.shadowBlur = 40;
      c.fillStyle = GREEN; c.fillRect(W * 0.385 - w / 2, H * 0.39 - h / 2, w, h);
      c.setTransform(1, 0, 0, 1, 0, 0);
      comp.draw(renderer, this.text.upload(), out, { tint: [1.25, 1.25, 1.25] });
      return;
    }
    const lines = this.logLines();
    // zoom: lands close (0.8), holds while it types, then pulls back as it scrolls away
    const z = keys(t, [[LOG, 1.5], [LOG + 0.1, 1.0, ease.outCubic], [SCROLL, 0.96, ease.linear], [RAIN, 0.52, ease.inQuad]]);
    // scroll: lines arrive every 40 ms; after SCROLL the whole log runs up, accelerating
    const shown = Math.min(lines.length, 5 + Math.floor((t - LOG) / 0.035));
    const LH = 138, FS = 100;
    const scroll = (tt: number) => -keys(tt, [[SCROLL, 0], [RAIN, LH * 24, ease.inCubic]]);
    // a few faint copies along the scroll make the streaks of the reference's fast scroll (motion blur adds the rest)
    const copies = t > SCROLL + 0.15 ? 5 : 1;
    for (let k = copies - 1; k >= 0; k--) {
      const tt = t - k * 0.012;
      c.save();
      c.globalAlpha = k === 0 ? 1 : 0.35 * (1 - k / copies);
      c.translate(W * 0.03, H * 0.08);
      c.scale(z, z);
      c.translate(0, scroll(tt));
      c.font = font(MONO, FS); c.textBaseline = 'alphabetic';
      for (let i = 0; i < shown; i++) {
        const [str, col] = lines[i]!;
        c.fillStyle = col; c.shadowColor = col; c.shadowBlur = 10;
        c.fillText(str, 0, LH * (i + 1));
      }
      c.restore();
    }
    // the last frames before the rain: the text darkens into it
    const fadeOut = prog(t, RAIN - 0.12, RAIN);
    comp.draw(renderer, this.text.upload(), out, { tint: [1.15, 1.15, 1.15], opacity: 1 - fadeOut });
  }

  private logLines(): [string, string][] {
    const L: [string, string][] = [['SMILE.EXE v1.0 (•ω•)', ORANGE], ['(c) 2026 xm labs · all faces reserved', TEXT]];
    const msgs = ['boot: cpu0 online', 'mem: 1024 friends ok', 'gpu: angle · 16 samples', '[ OK ] mounting /dev/smile', '[ OK ] started grin-daemon', '[ OK ] started blink-timer',
      '[ OK ] calibrating mouth ω', '[ OK ] loading eyes • •', '[SCAN] cheeks .. nominal', '[ OK ] found cat (=^•ω•^=)', '[ OK ] found bear ʕ•ᴥ•ʔ', '[ OK ] party.exe queued',
      '[ OK ] tuning bass 150 bpm', '[ OK ] warming tube', '[ OK ] 0 missing glyphs', '[ OK ] drawing swiss grid', '[ OK ] inking riso drums', '[ OK ] rolling memphis', '[ OK ] lighting matrix', '[ OK ] party target set'];
    msgs.forEach((m, i) => L.push([i < 3 ? `[ ${(i * 0.000413 + (i === 2 ? 0.0005 : 0)).toFixed(6).padStart(9)}] ${m}` : m, m.startsWith('[SCAN]') ? '#E8503C' : m.includes('(') ? PINK : i < 3 ? TEXT : '#9FE8B8']));
    return L;
  }

  /** 1.63 – 4.7: glyph rain, the tilt down onto the floor of log rows, the whip. */
  private world(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer } = this.ctx, t = f.t, P = this.parts, cam = P.cam;
    // camera: level, then tilts down onto the floor (and rises a little); creeps forward over the floor; whips right
    const pitch = keys(t, [[TILT, 0.3], [FLOOR, -0.12, ease.inOutCubic], [WHIP, -0.15, ease.linear]]);
    const yaw = -keys(t, [[WHIP, 0], [OUT, 1.1, ease.inCubic]]);
    const cy = keys(t, [[TILT, 0], [FLOOR, -40, ease.inOutCubic]]), cz = CAM_D - keys(t, [[FLOOR, 0], [WHIP, 150, ease.linear]]);
    cam.position.set(0, cy, cz);
    cam.rotation.set(pitch, yaw, 0, 'YXZ');
    // floor (visible once the camera looks down)
    if (t > TILT) {
      const pc = Math.round(25 + 60 * prog(t, FLOOR, WHIP));
      if (pc !== this.floorKey) { this.floorKey = pc; this.drawFloor(pc); }
      this.floorMat.opacity = prog(t, TILT, TILT + 0.25);
      renderer.setRenderTarget(out);
      renderer.render(this.floorScene, cam);
    }
    // rain columns: heads fall; glyphs trail above, fading; heads white, pink and hex columns
    let n = 0;
    const fi = frameIdx(t);
    const lit = prog(t, RAIN - 0.06, RAIN + 0.1);
    for (const col of this.cols) {
      const span = 3600, head = 1800 - ((col.y0 + col.sp * (t - RAIN + 2)) % span);
      for (let j = 0; j < col.len; j++) {
        const y = head + j * 52;
        if (y > 1900 || y < FLOOR_Y + 10) continue;
        const fade = 1 - j / col.len;
        const ch = col.hex ? HEX[Math.floor(j / 2) % HEX.length]![j % 2]! : RAIN_CHARS[Math.floor(hash(col.seed, j, Math.floor(fi / 2) + j) * RAIN_CHARS.length)]!;
        const g = this.gmap.get(ch) ?? 1;
        const c: [number, number, number] = j === 0 ? [1.6, 1.8, 1.7] : col.hex ? [1.4, 0.55, 0.12] : col.pink ? [1.3, 0.3, 0.6] : [0.25, 1.15, 0.45];
        // once the camera looks down, the near columns are gone: the rain is far behind the floor
        const near = col.z > -1800 ? 1 - prog(t, TILT, FLOOR - 0.1) : 1;
        const a = (j === 0 ? 1 : 0.3 + 0.7 * fade) * lit * near;
        if (a < 0.01) continue;
        P.set(n++, col.x + W / 2, H / 2 - y, col.z, 0, 0, 0, 1, g, c, a);
      }
    }
    P.render(renderer, out, n);
  }

  /** The floor texture: log rows in perspective (near edge = bottom of the canvas), the progress bar at the front. */
  private drawFloor(pc: number) {
    const cv = this.floorCv, c = cv.getContext('2d')!, S = cv.width / 2048;
    c.setTransform(S, 0, 0, S, 0, 0);
    c.clearRect(0, 0, 2048, 2048);
    const rows = 16, rh = 2048 / rows, x0 = 2048 * 0.3;
    c.font = font(MONO, 50); c.textBaseline = 'middle';
    for (let r = 0; r < rows - 1; r++) {
      const y = rh * (r + 0.5), dim = 0.35 + 0.65 * (r / rows);
      const id = String(213 + r * 31).padStart(4, '0');
      c.globalAlpha = dim;
      c.fillStyle = '#7FE6A6'; c.fillText('[ OK ]', x0, y);
      c.fillStyle = '#D8E2DC'; c.fillText(`friend ${id} online`, x0 + 220, y);
      c.fillStyle = PINK; c.fillText(r % 3 === 0 ? '(•ω•)ﾉ' : r % 3 === 1 ? '(^ω^)' : '(•‿•)', x0 + 820, y);
    }
    c.globalAlpha = 1;
    const y = rh * (rows - 0.5);
    c.fillStyle = '#D8E2DC'; c.fillText('loading friends [', x0 - 200, y);
    c.fillStyle = GREEN; c.fillRect(x0 + 330, y - 24, 560 * pc / 100, 48);
    c.fillStyle = '#D8E2DC'; c.fillText(']', x0 + 900, y);
    c.fillStyle = ORANGE; c.fillText(`${pc}%`, x0 + 980, y);
    this.floorTex.needsUpdate = true;
  }
}

// ?ref=intro, 7.9–15.6 s (bars 5–10; docs/复刻配方.md): the swiss-grid poster section, timed to the reference (song
// time = its time). The red dot from ref_boot's eye grows into the poster's sun, out of focus, and the camera pulls
// back: black arcs turn round it, •ω• slides in, the sun drops behind the face and becomes the red pill round it; a
// dive into the pill, then a long pull-back shows it is one cell of a table of kaomoji; cut to the 3D head (glass
// brackets swinging round, "CF 89"), a beat of wireframe debug view, the head front on; a zoom blur into a little face
// and the SMILE.EXE sheet whose cells fill with pink / blue / yellow from the middle out (the pop section wipes it).
// Animatic pass: layout, timing and camera moves follow the reference; the materials and detail come in the fine pass.
import * as THREE from 'three';
import { Scene, type Frame } from '../engine/scene';
import { Layer2D, W, H, clearRT } from '../engine/gl';
import { F, font } from '../engine/type';
import { plate, metaLine } from '../kit/termhud';
import { clamp, ease, hash, keys, mulberry32, prog, lerp } from '../engine/util';
import { roomEnvironment } from '../engine/world';

type Ctx = CanvasRenderingContext2D;
const CREAM = '#EEEBE6', RED = '#E8412C', INK = '#141414';
const BAR = 1.6;
// shots (song s)
const POSTER = 8.0, DROP = 9.15, PILL = 9.6, TABLE = 10.02, HEAD = 11.2, WIRE = 12.83, FRONT = 13.6, DIVE = 14.2, SHEET = 14.4;
const EYE_TO = { x: W * 0.66, y: H * 0.45 };
const FACES = ['(O_O;)', '(•ω•)', '(⊙_◎)', 'Σ(□_□)', 'm(_ _)m', '(^_^)', '(T_T)', '(>_<)', '(o_o)', '(-_-)', '(¬_¬)', '(=_=)', '(^o^)', '(°o°)', '(*_*)', '(;_;)', '(@_@)', '(x_x)', '(._.)', '(◎_◎)', '(^▽^)', '(·_·)', '(ò_ó)', '(ʘ_ʘ)', '(°_°)', '(⌐■_■)', '(ಠ_ಠ)', '(•_•)'];

export default class RefIntroSwiss extends Scene {
  layer = new Layer2D();
  over = new Layer2D();
  scene3 = new THREE.Scene();
  cam3 = new THREE.PerspectiveCamera(30, W / H, 0.1, 100);
  head = new THREE.Group();
  brackets: THREE.Mesh[] = [];
  wireMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.75, 0.78, 0.82), wireframe: true });

  override init() {
    const r = this.ctx.renderer;
    this.scene3.environment = roomEnvironment(r);
    this.scene3.add(new THREE.HemisphereLight(0xffffff, 0x404040, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(-3, 5, 6); this.scene3.add(key);
    const red = new THREE.MeshStandardMaterial({ color: '#D8301C', roughness: 0.62, envMapIntensity: 0.4 });
    const black = new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 0.08, metalness: 0.1 });
    const glass = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.04, metalness: 0.1, transparent: true, opacity: 0.45, envMapIntensity: 1.6 });
    const matte = new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.9 });
    this.head.add(new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), red));
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.24, 32, 24), black);
      eye.position.set(s * 0.62, 0.42, 0.78); this.head.add(eye);
    }
    // ω: two half rings, open side up, standing out of the face
    for (const s of [-1, 1]) {
      const arc = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.09, 16, 40, Math.PI), red);
      arc.rotation.z = Math.PI; arc.position.set(s * 0.22, -0.25, 1.02); this.head.add(arc);
    }
    // glass brackets ( ) and the black pillars behind
    for (const s of [-1, 1]) {
      const b = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.22, 24, 64, Math.PI * 0.62), glass);
      b.rotation.z = s < 0 ? Math.PI * 0.69 : -Math.PI * 0.31;
      b.position.set(s * 0.25, 0, 0.4);
      this.brackets.push(b); this.head.add(b);
    }
    for (const [x, z, h] of [[-2.6, -1.2, 3.2], [-1.4, -0.5, 2.4], [1.5, -0.6, 2.6], [2.7, -1.0, 3.4], [-3.6, -2, 2.8], [3.8, -2, 2.6]] as const) {
      const p = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, h, 8, 24), matte);
      p.position.set(x, -2.4, z); this.head.add(p);
    }
    this.scene3.add(this.head);
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const t = f.t, { renderer, comp } = this.ctx;
    let post: Record<string, unknown> = {};
    if (t < POSTER) post = this.dot(t, out);
    else if (t < HEAD) post = this.poster(t, out);
    else if (t < DIVE) post = this.head3d(t, out);
    else post = this.sheet(t, out);
    // HUD over everything but the black lead-in: bar plate, the program, the grid's metadata
    if (t >= POSTER) {
      const c = this.over.ctx; this.over.clear();
      const dark = t >= WIRE && t < FRONT;
      plate(c, W - 28, 26, `${String(Math.floor(t / BAR) + 1).padStart(2, '0')}/63`, { size: 22, align: 'right', bg: dark ? '#3A3A40' : INK, fg: '#F4F2EE' });
      c.font = font(F.mono(500), 15); c.fillStyle = dark ? '#9A9AA2' : '#333'; c.fillText('smile.exe', 40, 34);
      metaLine(c, W - 40, H - 26, ['E2 80 A2 20 CF 89', '150 bpm', '4/4', 'swiss grid'], { size: 13, color: dark ? '#8A8A92' : '#77736C', align: 'right' });
      comp.draw(renderer, this.over.upload(), out);
    }
    return { bloom: 0.25, bloomThreshold: 0.95, grain: 0.04, vignette: 0.15, halation: 0.05, ca: 1.0, ...post };
  }

  // 7.9–8.0: on black, the red dot (ref_boot's eye) grows to fill the frame
  private dot(t: number, out: THREE.WebGLRenderTarget) {
    const c = this.layer.ctx; this.layer.clear('#000');
    const q = prog(t, 7.9, POSTER), r = 40 + W * 0.9 * ease.inExpo(q);
    c.filter = `blur(${4 + 30 * q}px)`;
    c.fillStyle = RED; c.beginPath(); c.arc(lerp(EYE_TO.x, W * 0.55, q), lerp(EYE_TO.y, H * 0.44, q), r, 0, Math.PI * 2); c.fill();
    this.ctx.comp.draw(this.ctx.renderer, this.layer.upload(), out, { mode: 'replace' });
    return { bloom: 0.4 };
  }

  // 8.0–11.2: the poster, the pill, the table
  private poster(t: number, out: THREE.WebGLRenderTarget) {
    const c = this.layer.ctx; this.layer.clear(CREAM);
    if (t < PILL) this.sun(c, t);
    else this.table(c, t);
    this.ctx.comp.draw(this.ctx.renderer, this.layer.upload(), out, { mode: 'replace' });
    return {};
  }

  private sun(c: Ctx, t: number) {
    // camera: from close and out of focus to the poster (8.0–8.5)
    const k = keys(t, [[POSTER, 1.45], [8.45, 1.0, ease.outCubic], [PILL, 1.12, ease.linear]]);
    const blur = 26 * (1 - prog(t, POSTER, 8.28, ease.outCubic));
    // the sun: holds, then drops behind the face (DROP) to become its pill
    const drop = ease.inOutCubic(prog(t, DROP, 9.45));
    const sx = lerp(W * 0.587, W * 0.405, drop), sy = lerp(H * 0.43, H * 0.75, drop), sr = W * lerp(0.184, 0.17, drop);
    c.save();
    c.translate(W * 0.55, H * 0.44); c.scale(k, k); c.translate(-W * 0.55, -H * 0.44);
    c.filter = blur > 0.5 ? `blur(${blur}px)` : 'none';
    // arcs: concentric rings of segments, each turning at its own speed
    const ax = lerp(W * 0.587, W * 0.5, drop), ay = lerp(H * 0.43, H * 0.6, drop);
    c.strokeStyle = INK; c.lineCap = 'butt';
    const arcIn = prog(t, 8.05, 8.4, ease.outCubic);
    for (let ring = 0; ring < 9; ring++) {
      const R = W * 0.184 * (1.2 + ring * 0.2) * (0.6 + 0.4 * arcIn), rnd = mulberry32(ring * 13 + 1);
      c.lineWidth = 7 + 6 * rnd();
      const sp = (ring % 2 ? 1 : -1) * (0.7 + 0.8 * rnd()), segs = 5 + Math.floor(rnd() * 5);
      for (let s = 0; s < segs; s++) {
        const a0 = (s / segs) * Math.PI * 2 + rnd() + t * sp, len = (0.25 + 0.45 * rnd()) * (Math.PI * 2 / segs) * arcIn;
        c.beginPath(); c.arc(ax, ay, R, a0, a0 + len); c.stroke();
      }
    }
    // ticks below the sun
    c.lineWidth = 3;
    for (const [x, y0] of [[0.59, 0.67], [0.64, 0.72], [0.71, 0.7], [0.77, 0.75]] as const) {
      c.beginPath(); c.moveTo(W * x, H * y0 + (1 - arcIn) * 200); c.lineTo(W * x, H * 1.05); c.stroke();
    }
    c.fillStyle = RED; c.beginPath(); c.arc(sx, sy, sr, 0, Math.PI * 2); c.fill();
    // the face slides in along the bottom; inside the sun it is white
    // •ω• types in at the left edge (a glyph every 0.13 s), the closing bracket comes with the drop; "(" stays off frame
    const fs = H * lerp(0.3, 0.34, drop);
    const blinkQ = prog(t, 9.36, 9.4) * (1 - prog(t, 9.48, 9.52));
    const full = blinkQ > 0.5 ? '(-ω-)' : '(•ω•)';
    const n = t < DROP ? 1 + Math.min(3, Math.floor((t - 8.6) / 0.13) + 1) : 5;
    const face = t < 8.6 ? '' : full.slice(0, n);
    c.font = font(F.archivo(100, 900), fs);
    const fx = -c.measureText('(').width + W * lerp(-0.005, 0.06, drop);
    c.font = font(F.archivo(100, 900), fs); c.textBaseline = 'middle';
    c.fillStyle = INK; c.fillText(face, fx, H * 0.77);
    c.save(); c.beginPath(); c.arc(sx, sy, sr, 0, Math.PI * 2); c.clip();
    c.fillStyle = CREAM; c.fillText(face, fx, H * 0.77); c.restore();
    c.restore();
    c.filter = 'none';
  }

  /** The kaomoji table round the red pill: z = zoom (1 = the 7 x 6 view), the pill's screen position. */
  private table(c: Ctx, t: number) {
    const z = keys(t, [[PILL, 9.5], [TABLE, 7.6, ease.linear], [10.22, 3.3, ease.outExpo], [11.2, 0.92, ease.outCubic]]);
    const settle = prog(t, TABLE, 10.22, ease.outCubic);
    const cw = 292, ch = 118;
    // the pill (cell 0,0) sits at the frame's centre in the dive, then the camera's pull-back pivots elsewhere
    const px = lerp(W * 0.52, W * 0.75, settle) + (W * 0.56 - W * 0.75) * prog(t, 10.22, 11.0, ease.inOutCubic);
    const py = lerp(H * 0.5, H * 0.22, settle) + (H * 0.43 - H * 0.22) * prog(t, 10.22, 11.0, ease.inOutCubic);
    const X = (i: number) => px + (i - 0.5) * cw * z, Y = (j: number) => py + (j - 0.5) * ch * z;
    const i0 = Math.floor(-px / (cw * z)) - 1, i1 = Math.ceil((W - px) / (cw * z)) + 1, j0 = Math.floor(-py / (ch * z)) - 1, j1 = Math.ceil((H - py) / (ch * z)) + 1;
    // grid lines
    c.strokeStyle = 'rgba(20,20,20,0.55)'; c.lineWidth = Math.max(1, 1.4 * Math.min(z, 3));
    for (let i = i0; i <= i1; i++) { c.beginPath(); c.moveTo(X(i), 0); c.lineTo(X(i), H); c.stroke(); }
    for (let j = j0; j <= j1; j++) { c.beginPath(); c.moveTo(0, Y(j)); c.lineTo(W, Y(j)); c.stroke(); }
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
      const cx = X(i) + cw * z / 2, cy = Y(j) + ch * z / 2;
      if (i === 0 && j === 0) {
        // the red pill with the white face
        const pw = cw * z * 0.86, ph = ch * z * 0.74;
        c.fillStyle = RED; c.beginPath(); c.roundRect(cx - pw / 2, cy - ph / 2, pw, ph, ph / 2); c.fill();
        c.font = font(F.archivo(100, 900), ch * z * 0.52); c.fillStyle = CREAM; c.fillText('(•ω•)', cx, cy + ch * z * 0.02);
        continue;
      }
      const h = hash(i, j, 7);
      // a few cells light up red as the view widens
      if (t > 10.8 && h < 0.05 + 0.1 * prog(t, 10.8, 11.1)) { c.fillStyle = RED; c.fillRect(X(i) + 2, Y(j) + 2, cw * z - 4, ch * z - 4); }
      c.font = font(F.archivo(100, h < 0.6 ? 700 : 500), ch * z * (h < 0.25 ? 0.44 : 0.3));
      c.fillStyle = h > 0.85 ? 'rgba(20,20,20,0.3)' : INK;
      c.fillText(FACES[Math.floor(h * 997) % FACES.length]!, cx, cy);
    }
    c.textAlign = 'left';
  }

  // 11.2–14.2: the 3D head; 12.83–13.6 the wireframe debug view
  private head3d(t: number, out: THREE.WebGLRenderTarget) {
    const { renderer, comp } = this.ctx;
    const wire = t >= WIRE && t < FRONT, front = t >= FRONT;
    // camera orbits from the head's left to its right; front on and closer after the wireframe
    const yaw = front ? keys(t, [[FRONT, 0.12], [DIVE, -0.12, ease.linear]]) : keys(t, [[HEAD, -0.75], [WIRE, 0.45, ease.outCubic], [FRONT, 0.6, ease.linear]]);
    const dist = front ? keys(t, [[FRONT, 6.2], [DIVE, 5.8, ease.linear]]) : keys(t, [[HEAD, 7.6], [WIRE, 6.8, ease.outCubic], [FRONT, 6.6, ease.linear]]);
    this.cam3.position.set(Math.sin(yaw) * dist, 0.15, Math.cos(yaw) * dist);
    this.cam3.lookAt(0, -0.1, 0);
    // the glass brackets swing round the head and settle (11.2–12.1)
    const sw = 1 - ease.outCubic(prog(t, HEAD, 12.1));
    this.brackets.forEach((b, i) => { b.rotation.y = (i ? -1 : 1) * sw * 2.4; b.position.z = 0.4 + sw * 0.8; });
    this.head.rotation.y = 0.12 * Math.sin(t * 2.2);
    clearRT(renderer, out, wire ? [0.026, 0.026, 0.03] : [0.84, 0.82, 0.79]);
    this.scene3.overrideMaterial = wire ? this.wireMat : null;
    renderer.setRenderTarget(out);
    renderer.render(this.scene3, this.cam3);
    this.scene3.overrideMaterial = null;
    // 2D: "CF 89" and the code point, the debug labels, the red scan bar
    const c = this.layer.ctx; this.layer.clear();
    c.font = font(F.archivo(100, 900), 230); c.textBaseline = 'alphabetic';
    c.fillStyle = wire ? 'rgba(200,200,210,0.35)' : INK; c.fillText('CF 89', -40 + (front ? 30 : 0), 205);
    c.font = font(F.archivo(100, 500), 34); c.fillText('U+03C9 ω', 700, 160);
    if (wire) {
      c.font = font(F.mono(500), 14); c.fillStyle = '#A8A8B0';
      for (let i = 0; i < 18; i++) c.fillText(['clean', 'scan', 'clean', 'mesh', 'clean'][i % 5]!, 40, 260 + i * 34);
      c.fillStyle = '#E8412C'; c.fillText('[SCAN] grid 060/144 · 0 threats', 40, H - 40);
      c.strokeStyle = '#E8412C'; c.lineWidth = 3; c.beginPath(); c.arc(W * 0.47, H * 0.58, 70, 0, Math.PI * 2); c.stroke();
    }
    const bar = prog(t, 12.35, 12.6);
    if (bar > 0 && bar < 1) { c.fillStyle = RED; c.fillRect(0, H * (0.6 + 0.3 * bar), W, 46); }
    comp.draw(renderer, this.layer.upload(), out);
    return { bloom: 0.3, ca: wire ? 2 : 1.4 };
  }

  // 14.2–15.6: the zoom blur into a little face, then the SMILE.EXE sheet filling with colour cells
  private sheet(t: number, out: THREE.WebGLRenderTarget) {
    const c = this.layer.ctx; this.layer.clear(CREAM);
    if (t < SHEET) {
      const q = prog(t, DIVE, SHEET);
      // streaks rushing past toward the middle
      const rnd = mulberry32(3);
      c.strokeStyle = 'rgba(40,40,40,0.35)'; c.lineCap = 'round';
      for (let i = 0; i < 160; i++) {
        const a = rnd() * Math.PI * 2, d = ((rnd() + q * 1.8) % 1), r0 = H * (0.1 + d * 0.9), len = 60 + 240 * d;
        c.lineWidth = 2 + 6 * d; c.beginPath(); c.moveTo(W / 2 + Math.cos(a) * r0 * 1.6, H / 2 + Math.sin(a) * r0); c.lineTo(W / 2 + Math.cos(a) * (r0 + len) * 1.6, H / 2 + Math.sin(a) * (r0 + len)); c.stroke();
      }
      const s = lerp(1, 1.5, q);
      c.fillStyle = '#F5D9B8'; c.fillRect(W / 2 - 80 * s, H / 2 - 70 * s, 160 * s, 140 * s);
      c.font = font(F.archivo(100, 700), 44 * s); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = INK; c.fillText('(•ω•)', W / 2, H / 2);
      c.textAlign = 'left';
      this.ctx.comp.draw(this.ctx.renderer, this.layer.upload(), out, { mode: 'replace' });
      return { radial: 0.25 * (1 - q) };
    }
    // the sheet: header, rows of small faces, footer; 16 x 9 cells fill from the middle out
    const rnd = mulberry32(9);
    c.font = font(F.archivo(125, 900), 64); c.fillStyle = INK; c.textBaseline = 'alphabetic';
    c.fillText('S M I L E . E X E', 60, 72);
    c.font = font(F.mono(500), 19);
    for (let r = 0; r < 18; r++) {
      let line = '';
      for (let k = 0; k < 14; k++) line += FACES[Math.floor(rnd() * FACES.length)] + '  ';
      c.fillStyle = 'rgba(20,20,20,0.75)'; c.fillText(line, 20 - (r % 3) * 30 + (r % 2 ? 1 : -1) * (t - SHEET) * 260 - 200, 120 + r * 48);
    }
    c.font = font(F.archivo(125, 900), 76); c.fillStyle = INK; c.fillText('1 5 0 B P M · 4 / 4 · 1 6 × 9', 30, H - 22);
    const cols = 16, rows = 9, cw = W / cols, chh = H / rows;
    const fill = prog(t, 14.5, 15.2, ease.inQuad);
    const inks = ['#F0549E', '#1F78C8', '#FFE04A'];
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const d = Math.hypot((i - 7.5) / 8, (j - 4) / 4.5) / 1.42;
      if (d > fill * 1.05 + hash(i, j) * 0.08) continue;
      const k = Math.floor(hash(i, j, 3) * 3);
      c.fillStyle = inks[k]!; c.fillRect(i * cw + 3, j * chh + 3, cw - 6, chh - 6);
      c.font = font(F.archivo(100, 700), 22); c.fillStyle = k === 1 ? '#F4F2EE' : INK;
      c.fillText(hash(i, j, 5) < 0.5 ? '(•ω•)' : '(-ω-)', i * cw + cw / 2, j * chh + chh / 2);
    }
    c.textAlign = 'left';
    this.ctx.comp.draw(this.ctx.renderer, this.layer.upload(), out, { mode: 'replace' });
    return { flash: 0.25 * Math.exp(-(t - SHEET) * 25) };
  }
}

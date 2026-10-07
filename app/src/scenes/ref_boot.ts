// Boot (?ref=boot): a frame-matched re-creation of the kaomoji.exe opening (its 5.4–8.0 s; docs/复刻配方.md) —
// a terminal close-up typing a command, Enter flashes the tube, the text whips away and bursts into tumbling glyph
// particles that fly back and land as the character-grid face, a red scan bar, the face rolls up into a glyph ball.
// Times are the scene's local seconds (T = f.lt) matching the reference from 5.4 s; in a real project put the beats
// of the song on them. Log text and command are our own. New projects can delete it.
import * as THREE from 'three';
import { Scene, type Frame } from '../engine/scene';
import { FSPass, Layer2D, W, H } from '../engine/gl';
import { F, font } from '../engine/type';
import { GlyphAtlas } from '../engine/ascii';
import { cellsFromCanvas, GlyphParticles, type GlyphCell } from '../kit/glyphfield';
import { clamp, ease, hash, mulberry32, prog } from '../engine/util';

// key times (s, local)
const ENTER = 0.8, BURST = 0.98, GATHER = 1.6, LAND = 1.82, SCAN = 1.98, BLINK = 2.2, ROLL = 2.44, END = 2.62;
// motion trails: ghost copies at earlier times (a pure function of time, unlike a feedback buffer)
const TRAIL = 6, TRAIL_DT = 0.011;
const MONO = F.mono(600);
// colours (sRGB) measured on the reference
const TEXT = '#AABAB1', GREEN = '#65F09E';
const SYMBOLS = ' .-=+*#%@';
/** Grid glyph colour: the face's colours brightened; the white eyes go well over 1 so they bloom like the reference. */
const glyphColour = (c: GlyphCell): [number, number, number] => {
  const white = Math.min(c.color[0], c.color[1], c.color[2]) > 0.75;
  const k = white ? 1.3 : 1.45;
  return [c.color[0] * k, c.color[1] * k, c.color[2] * k];
};

interface P { tx: number; ty: number; g: number; c: [number, number, number]; x0: number; y0: number; z0: number; vx: number; vy: number; vz: number; r0: [number, number, number]; w: [number, number, number]; delay: number; gf: number; land: boolean }

export default class DemoBoot extends Scene {
  term = new Layer2D();
  fx = new Layer2D();
  atlas!: GlyphAtlas;
  parts!: GlyphParticles;
  ps: P[] = [];
  cells: GlyphCell[] = [];
  bg = new FSPass(/* glsl */ `
    uniform vec3 edge, center; uniform float glow;
    void main() {
      vec2 p = (vUv - vec2(0.5, 0.55)) * vec2(${(W / H).toFixed(4)}, 1.0);
      float r = length(p);
      vec3 c = mix(center, edge, smoothstep(0.0, 0.75, r));
      c += vec3(0.010, 0.008, 0.008) * glow * exp(-r * r * 6.0);   // the warm grey bloom of the glass
      fragColor = vec4(c, 1.0);
    }`, { edge: { value: new THREE.Vector3() }, center: { value: new THREE.Vector3() }, glow: { value: 0 } });

  override init() {
    // the grid uses symbols only (the reference's  - = + * # % @ ); flying particles use letters and digits
    this.atlas = new GlyphAtlas({ chars: SYMBOLS + 'abcdefghkmnoprstuvwxyzABDEFGHKMNPRSTUVXZ0123456789' });
    // the face, drawn soft-edged with a top-lit gradient so the grid gets dense interiors and light edges
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const c = cv.getContext('2d')!;
    c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
    c.filter = 'blur(5px)';
    const grad = (y0: number, y1: number, top: string, bot: string) => { const g = c.createLinearGradient(0, y0, 0, y1); g.addColorStop(0, top); g.addColorStop(1, bot); return g; };
    // brackets: thick arcs at the frame edges
    // brackets: thin arcs hugging the frame edges
    c.lineWidth = 78; c.lineCap = 'round';
    c.strokeStyle = grad(H * 0.1, H * 0.95, '#93BBA2', '#6A927B');
    c.beginPath(); c.ellipse(W * 0.135, H * 0.5, W * 0.125, H * 0.43, 0, Math.PI * 0.6, Math.PI * 1.4); c.stroke();
    c.beginPath(); c.ellipse(W * 0.865, H * 0.5, W * 0.125, H * 0.43, 0, -Math.PI * 0.4, Math.PI * 0.4); c.stroke();
    // eyes: white discs, brightest in the middle
    for (const x of [W * 0.2, W * 0.8]) {
      const g = c.createRadialGradient(x, H * 0.43, 0, x, H * 0.43, 128);
      g.addColorStop(0, '#FFFFFF'); g.addColorStop(0.8, '#F0F0EE'); g.addColorStop(1, '#C8C8C5');
      c.fillStyle = g; c.beginPath(); c.arc(x, H * 0.43, 126, 0, Math.PI * 2); c.fill();
    }
    // ω
    c.font = font(F.archivo(125, 900), 640); c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = grad(H * 0.22, H * 0.7, '#D27F98', '#9A576B');
    c.fillText('ω', W * 0.5, H * 0.42);
    this.cells = cellsFromCanvas(cv, this.atlas, { cell: 26, gamma: 0.8, gain: 1.7, threshold: 0.14, boost: 1.0, only: SYMBOLS, lum: 'max' });
    // particles: every cell lands; extra debris flies and fades
    const rnd = mulberry32(17), extra = 2600, n = this.cells.length + extra;
    this.parts = new GlyphParticles(this.atlas, n * (TRAIL + 1), { size: 32 });
    const debrisCols: [number, number, number][] = [[0.58, 0.63, 0.6], [0.49, 0.09, 0.18], [0.58, 0.63, 0.6], [0.49, 0.09, 0.18], [0.58, 0.63, 0.6], [0.49, 0.09, 0.18], [0.85, 0.3, 0.05], [0.58, 0.63, 0.6], [0.49, 0.09, 0.18], [0.12, 0.5, 0.25]];
    for (let i = 0; i < n; i++) {
      const cell = this.cells[i];
      // born on the terminal's text block (left half), blown to the right; pink (ω) glyphs from the upper part,
      // white and green from the lower: the cloud keeps colour patches, as in the reference
      const pink = !!cell && cell.color[0] > cell.color[1] * 1.3;
      const x0 = W * (-0.05 + 0.45 * rnd()), y0 = H * (pink ? 0.05 + 0.5 * rnd() : 0.35 + 0.6 * rnd());
      const sp = 900 + 2600 * rnd() ** 3, a = (rnd() - 0.5) * 0.9;
      this.ps.push({
        tx: cell?.x ?? 0, ty: cell?.y ?? 0, g: cell?.g ?? 1 + Math.floor(rnd() * (this.atlas.n - 1)),
        c: cell ? glyphColour(cell) : debrisCols[i % debrisCols.length]!,
        x0, y0, z0: -200 + 450 * rnd(), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.6, vz: (rnd() - 0.5) * 300,
        r0: [rnd() * 6, rnd() * 6, rnd() * 6], w: [(rnd() - 0.5) * 9, (rnd() - 0.5) * 9, (rnd() - 0.5) * 6],
        delay: rnd() * 0.06, gf: 1 + Math.floor(rnd() * (this.atlas.n - 1)), land: !!cell,
      });
    }
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp } = this.ctx, T = f.lt;
    // ---- background: the terminal's green-grey, near black while the particles fly, the warm grey glass for the face ----
    const faceUp = prog(T, LAND - 0.1, LAND + 0.15);
    const lin = (r: number, g: number, b: number) => new THREE.Vector3(...[r, g, b].map((v) => Math.pow(v / 255, 2.2)));
    const termBg = T < BURST ? 1 : 0;
    const edge = lin(37, 44, 43).multiplyScalar(termBg).add(lin(20, 37, 30).multiplyScalar((1 - termBg) * (0.35 + 0.65 * faceUp)));
    const center = lin(54, 75, 62).multiplyScalar(termBg).add(lin(36, 30, 28).multiplyScalar((1 - termBg) * (0.3 + 0.7 * faceUp)));
    (this.bg.u.edge!.value as THREE.Vector3).copy(edge);
    (this.bg.u.center!.value as THREE.Vector3).copy(center);
    this.bg.u.glow!.value = (1 - termBg) * faceUp;
    this.bg.render(renderer, out);
    if (T < BURST + 0.04) this.terminal(f, out);
    if (T >= BURST - 0.02) this.particles(f, out);
    // ---- red scan bar ----
    const fx = this.fx.ctx; this.fx.clear();
    const sp = prog(T, SCAN, SCAN + 0.17);
    if (sp > 0 && sp < 1) {
      const y = -H * 0.05 + H * 1.1 * ease.inOutQuad(sp), g = fx.createLinearGradient(0, y - 46, 0, y + 46);
      g.addColorStop(0, 'rgba(255,50,30,0)'); g.addColorStop(0.5, 'rgba(255,60,35,0.95)'); g.addColorStop(1, 'rgba(255,50,30,0)');
      fx.fillStyle = g; fx.fillRect(0, y - 46, W, 92);
      comp.draw(renderer, this.fx.upload(), out, { mode: 'add', tint: [1.2, 0.9, 0.8] });
    }
    const flashEnter = T >= ENTER ? 0.8 * Math.exp(-(T - ENTER) * 32) : 0;
    const flashEnd = prog(T, END - 0.04, END + 0.04);
    return {
      crt: 1, crtCurve: 0.11, crtLines: 300, vignette: 0.8, bloom: T < BURST ? 0.35 : 0.6, bloomThreshold: T < BURST ? 0.9 : 0.7, bloomRadius: 0.7, halation: 0.08,
      ca: 1.6, grain: 0.035, flash: flashEnter + flashEnd * 2, radial: 0,
    };
  }

  private terminal(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp } = this.ctx, T = f.lt, c = this.term.ctx;
    this.term.clear();
    // camera: a slow push and drift; after Enter the whole terminal whips off to the left
    const whip = ease.inCubic(prog(T, ENTER + 0.03, BURST));
    const k = 1.0 + 0.04 * T;
    c.save();
    c.translate(-W * 0.03 * T - whip * W * 1.6, H * 0.02 * T);
    c.scale(k, k);
    const FS = 128, LH = 150, X0 = 120;
    c.font = font(MONO, FS); c.textBaseline = 'alphabetic';
    c.shadowColor = 'rgba(190,210,198,0.45)'; c.shadowBlur = 12;
    // the progress line and the prompt stay put; the log grows upward from just above them. A line every 0.2 s
    // stamped with the clock (reference time 5.4 + T); the newest fades in while the older ones are pushed up
    // (continuous: no jump when a line is added, so no double image under motion blur)
    const loadY = H * 0.5, now = 5.4 + T;
    const msgs = ['smile: calibrating ω', 'gpu: 64 samples / frame', 'faces: 1024 indexed', 'beat: 150 bpm locked', 'tube: phosphor warm', 'cheeks: nominal', 'party: armed'];
    const newest = Math.floor(now / 0.2 + 1e-6), frac = now / 0.2 - newest, push = (1 - ease.outCubic(clamp(frac * 3))) * LH;
    for (let j = 0; j < 4; j++) {
      const i = newest - j, y = loadY - LH * (j + 1) + push;
      c.globalAlpha = j === 0 ? ease.outCubic(clamp(frac * 3)) : 1;
      c.fillStyle = j === 0 ? TEXT : 'rgba(170,186,177,0.85)';
      c.fillText(`[ ${(i * 0.2).toFixed(6).padStart(11)}] ${msgs[((i % msgs.length) + msgs.length) % msgs.length]}`, X0, y);
    }
    c.globalAlpha = 1;
    // progress bar
    c.fillStyle = TEXT; c.fillText('loading faces [', X0, loadY);
    const bx = X0 + c.measureText('loading faces [').width, bw = 900, p = 0.55 + 0.4 * prog(T, 0, ENTER);
    c.fillStyle = GREEN; c.shadowColor = 'rgba(101,240,158,0.75)'; c.fillRect(bx + 10, loadY - 98, (bw - 20) * p, 112);
    c.fillStyle = TEXT; c.shadowColor = 'rgba(190,210,198,0.6)'; c.fillText(']', bx + bw, loadY);
    const y = loadY + LH * 1.55;
    // the command, typed ~10 chars/s, and the green block cursor
    const cmd = 'smile --run --loud', typed = cmd.slice(0, clamp(Math.floor((T + 1.0) * 10), 0, cmd.length));
    c.fillStyle = GREEN; c.fillText('>', X0, y);
    c.fillStyle = TEXT; c.fillText(typed, X0 + FS * 1.1, y);
    const cx = X0 + FS * 1.1 + c.measureText(typed).width + 10, typing = typed.length < cmd.length;
    if (typing || Math.floor(T * 4) % 2 === 0) { c.fillStyle = GREEN; c.shadowColor = 'rgba(101,240,158,0.8)'; c.fillRect(cx, y - 100, 70, 124); }
    c.restore();
    comp.draw(renderer, this.term.upload(), out, { tint: [1.2, 1.2, 1.2] });
  }

  /** Particle i at local time T: position (px, z toward the viewer), rotation, glyph, alpha, colour gain. */
  private state(i: number, T: number) {
    const p = this.ps[i]!, te = Math.max(0, T - BURST), drag = 7.5;
    // the burst: thrown, slowed by drag, drifting and tumbling
    const s = (1 - Math.exp(-drag * te)) / drag;
    let x = p.x0 + p.vx * s + 40 * te, y = p.y0 + p.vy * s - 12 * te, z = p.z0 + p.vz * s;
    let rx = p.r0[0] + p.w[0] * te, ry = p.r0[1] + p.w[1] * te, rz = p.r0[2] + p.w[2] * te;
    let g = p.gf, a = clamp((T - BURST) / 0.05), k = 0.9;
    if (p.land) {
      // gather: accelerate onto the cell (staggered), straighten out, take the cell's glyph near the end
      const q = ease.inCubic(prog(T, GATHER + p.delay, LAND - 0.02 + p.delay * 0.3));
      x += (p.tx - x) * q; y += (p.ty - y) * q; z *= 1 - q;
      rx *= 1 - q; ry *= 1 - q; rz *= 1 - q;
      if (q > 0.85) g = p.g;
      k = 0.9 + 0.1 * q;
      // the blink: the eyes' glyph rows squeeze to one line and open again
      if (p.c[0] > 1.2 && p.c[2] > 1.2 && Math.abs(p.ty - H * 0.43) < 150) {
        const b = prog(T, BLINK, BLINK + 0.07) * (1 - prog(T, BLINK + 0.16, BLINK + 0.24));
        const keep = 130 * (1 - ease.inOutQuad(b)) + 14;
        if (Math.abs(p.ty - H * 0.43) > keep) a = 0;
      }
      // the exit: the face whips off to the left (the trails smear its rows into stripes)
      const r = ease.inCubic(prog(T, ROLL, END));
      x -= r * W * 1.9; y += r * (p.ty - H * 0.45) * 0.15;
    } else {
      // debris fades out while the face gathers
      a *= 1 - prog(T, GATHER - 0.05, LAND - 0.1);
    }
    // depth: far glyphs dimmer
    a *= 1 / (1 + Math.max(0, -z) / 1600);
    return { x, y, z, rx, ry, rz, g, a, k };
  }

  private particles(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer } = this.ctx, T = f.lt, P = this.parts;
    // landing pop: the face flares as it locks (eyes bloom)
    const pop = T >= LAND ? 1 + 0.35 * Math.exp(-(T - LAND) * 9) : 1;
    let n = 0;
    for (let i = 0; i < this.ps.length; i++) {
      const p = this.ps[i]!, st = this.state(i, T);
      if (st.a <= 0.01) continue;
      // a faint per-glyph flicker on the grid (constant over a frame's shutter)
      const fl = T > LAND ? 0.88 + 0.12 * hash(i, Math.round(T * 60)) : 1;
      const k = st.k * pop * fl;
      P.set(n++, st.x, st.y, st.z, st.rx, st.ry, st.rz, 1, st.g, [p.c[0] * k, p.c[1] * k, p.c[2] * k], st.a);
      // trails while it moves fast: copies at earlier times, fading
      const old = this.state(i, T - TRAIL * TRAIL_DT);
      if (Math.hypot(st.x - old.x, st.y - old.y) < 12) continue;
      for (let j = 1; j <= TRAIL; j++) {
        const o = j === TRAIL ? old : this.state(i, T - j * TRAIL_DT), fa = st.a * 0.55 * (1 - j / (TRAIL + 1));
        P.set(n++, o.x, o.y, o.z, o.rx, o.ry, o.rz, 1, st.g, [p.c[0] * k, p.c[1] * k, p.c[2] * k], fa);
      }
    }
    P.render(renderer, out, n);
  }
}

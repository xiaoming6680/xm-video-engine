// ?ref=kaleido: frame-matched re-creation of the kaomoji.exe kaleidoscope trap (its 83.2–86.3 s; docs/复刻配方.md):
// a badge (gold ring with bytes, cream disc, the face) in the middle; mandala rings are born at its edge and pushed
// outward, faster and faster (each ring = one motif repeated round the circle); a mirror-tile beat, a grid of small
// badges, a red star ring as the face frowns, the guard gives up, the picture whips away.
// Local seconds T = f.lt match the reference from 83.2 s. Panel wording is our own.
import type * as THREE from 'three';
import { Scene, type Frame } from '../engine/scene';
import { Layer2D, W, H, makeRT, clearRT } from '../engine/gl';
import { F, font } from '../engine/type';
import { Kaleido } from '../engine/warp';
import { ringText } from '../kit/textfx';
import { ease, prog, hash } from '../engine/util';

type Ctx = CanvasRenderingContext2D;
// measured (sRGB)
const GOLD = '#A7803B', GOLD_D = '#7E6033', CREAM = '#FBF1DD', ORANGE = '#FDB242', INK = '#18131A';
const SKY = '#5FADE2', SKY_P = '#90B5D8', BLUE = '#2D47E6', TEAL = '#2DB7BE', NAVY = '#141A37', NAVY2 = '#212A54';
const GREEN = '#35A16A', YELLOW = '#F6D232', RED = '#E8412C', WHITE = '#F6F7FA';
const CX = W / 2, CY = H * 0.49, R = H * 0.333;   // badge centre and outer radius
const TILE = [2.0, 2.2], GRID = [2.2, 2.4], STAR = [2.4, 2.8], GIVE = 2.8, END = 3.05;

type Motif = 'dots' | 'blue' | 'teal' | 'navy' | 'beads' | 'lace' | 'squares' | 'text' | 'tri' | 'thin';
interface Ring { born: number; motif: Motif; spin: number }
const COUNT: Record<Motif, number> = { dots: 90, blue: 26, teal: 22, navy: 24, beads: 48, thin: 36, squares: 40, tri: 30, lace: 28, text: 0 };
// rings are born under the badge edge and zoom outward; the newest is innermost (as in the reference)
const RINGS: Ring[] = [
  { born: 0.0, motif: 'dots', spin: 0.3 }, { born: 0.3, motif: 'blue', spin: 0.1 }, { born: 0.55, motif: 'teal', spin: -0.25 },
  { born: 0.8, motif: 'navy', spin: 0.2 }, { born: 1.0, motif: 'beads', spin: -0.4 }, { born: 1.12, motif: 'thin', spin: 0.3 },
  { born: 1.24, motif: 'squares', spin: -0.3 }, { born: 1.36, motif: 'tri', spin: 0.25 }, { born: 1.47, motif: 'lace', spin: 0.35 },
  { born: 1.58, motif: 'text', spin: -0.5 }, { born: 1.68, motif: 'thin', spin: 0.3 }, { born: 1.78, motif: 'lace', spin: -0.2 },
  { born: 1.88, motif: 'beads', spin: 0.3 }, { born: 2.0, motif: 'tri', spin: -0.2 },
];
/** log(outer radius / R) of the oldest ring by time T: the zoom out of the badge, faster and faster. */
const LG: [number, number][] = [[0, 0], [0.4, 0.12], [0.75, 0.34], [1.0, 0.46], [1.25, 0.64], [1.5, 0.95], [1.75, 1.2], [2.0, 1.4], [2.4, 1.7]];
const lg = (T: number) => {
  if (T <= 0) return 0;
  for (let i = 1; i < LG.length; i++) if (T <= LG[i]![0]) { const [t0, v0] = LG[i - 1]!, [t1, v1] = LG[i]!; return v0 + ((v1 - v0) * (T - t0)) / (t1 - t0); }
  return LG[LG.length - 1]![1];
};

/** The face: thick orange bracket arcs and ω with a dark outline, two dots; `frown` adds slanted brows. */
function face(c: Ctx, x: number, y: number, s: number, frown = 0) {
  c.save(); c.translate(x, y); c.scale(s, s);
  c.lineCap = 'round'; c.lineJoin = 'round';
  const arc = (dir: 1 | -1) => { c.beginPath(); c.ellipse(dir * 205, 0, 62, 112, 0, dir > 0 ? -Math.PI * 0.4 : Math.PI * 0.6, dir > 0 ? Math.PI * 0.4 : Math.PI * 1.4); c.stroke(); };
  for (const [w, col] of [[34, INK], [24, ORANGE]] as const) { c.lineWidth = w; c.strokeStyle = col; arc(-1); arc(1); }
  for (const dx of [-140, 140]) { c.fillStyle = INK; c.beginPath(); c.arc(dx, -4, 34, 0, Math.PI * 2); c.fill(); c.fillStyle = ORANGE; c.beginPath(); c.arc(dx, -4, 28, 0, Math.PI * 2); c.fill(); }
  c.font = font(F.archivo(75, 900), 230); c.textAlign = 'center'; c.textBaseline = 'middle';
  c.lineWidth = 9; c.strokeStyle = INK; c.strokeText('ω', 0, -10); c.fillStyle = ORANGE; c.fillText('ω', 0, -10);
  if (frown > 0) {
    c.fillStyle = INK;
    for (const dir of [-1, 1]) { c.save(); c.translate(dir * 130, -112); c.rotate(dir * 0.45); c.beginPath(); c.ellipse(0, 0, 34 * frown, 13, 0, 0, Math.PI * 2); c.fill(); c.restore(); }
  }
  c.restore();
}

/** The badge: gold ring with byte labels and ticks, cream disc, the face. */
function badge(c: Ctx, x: number, y: number, r: number, T: number, frown = 0) {
  c.save();
  c.fillStyle = INK; c.beginPath(); c.arc(x, y, r + 4, 0, Math.PI * 2); c.fill();
  c.fillStyle = GOLD; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  c.fillStyle = INK; c.beginPath(); c.arc(x, y, r * 0.83 + 3, 0, Math.PI * 2); c.fill();
  const g = c.createRadialGradient(x, y, 0, x, y, r * 0.83);
  g.addColorStop(0, '#FFFAF0'); g.addColorStop(1, '#F4E6CB');
  c.fillStyle = g; c.beginPath(); c.arc(x, y, r * 0.83, 0, Math.PI * 2); c.fill();
  const bytes = ['80', 'E2', 'A2', '08', 'E2', '20', '89', 'CF', '20', 'A2'];
  c.strokeStyle = GOLD_D; c.lineWidth = r * 0.012;
  for (let i = 0; i < bytes.length; i++) {
    const a = (i / bytes.length) * Math.PI * 2 - Math.PI / 2 + T * 0.05;
    c.beginPath(); c.moveTo(x + Math.cos(a + 0.31) * r * 0.84, y + Math.sin(a + 0.31) * r * 0.84); c.lineTo(x + Math.cos(a + 0.31) * r * 0.99, y + Math.sin(a + 0.31) * r * 0.99); c.stroke();
    c.save(); c.translate(x + Math.cos(a) * r * 0.915, y + Math.sin(a) * r * 0.915); c.rotate(a + Math.PI / 2);
    c.fillStyle = '#3B2A14'; c.font = font(F.mono(700), r * 0.075); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(bytes[i]!, 0, 0);
    c.restore();
  }
  face(c, x, y + r * 0.02, r / 360, frown);
  c.restore();
}

export default class RefKaleido extends Scene {
  layer = new Layer2D();
  ui = new Layer2D();
  rt = makeRT();
  kal = new Kaleido();

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp } = this.ctx, T = f.lt, c = this.layer.ctx;
    this.layer.clear(SKY);
    let post: Record<string, unknown> = {};
    if (T < GRID[0]!) this.mandala(c, T);
    else if (T < GRID[1]!) this.grid(c, T);
    else if (T < GIVE) this.star(c, T);
    else this.mandala(c, T, true);
    if (T < GRID[0]! || T >= GIVE) badge(c, CX, CY, R, T, T >= TILE[0]! ? 1 : 0);
    if (T >= TILE[0]! && T < TILE[1]!) {
      // the mirror beat: the frame folds into mirrored tiles (the badge stays whole in the middle tile)
      clearRT(renderer, this.rt, [0, 0, 0]);
      comp.draw(renderer, this.layer.upload(), this.rt, { mode: 'replace' });
      this.kal.render(renderer, this.rt.texture, out, { mode: 'tile', n: 1, center: [0.5, 1 - CY / H], srcCenter: [0.5, 1 - CY / H] });
    } else comp.draw(renderer, this.layer.upload(), out, { mode: 'replace' });
    this.panel(T);
    comp.draw(renderer, this.ui.upload(), out);
    // the white flash at the start; the whip at the end
    const whip = prog(T, END - 0.06, END + 0.05);
    post = { flash: 1.6 * (1 - prog(T, 0, 0.24)), radial: 0.5 * whip, shake: [-whip * 220, 0], ca: 1 + 4 * whip };
    return { bloom: 0.18, bloomThreshold: 1.1, grain: 0.03, vignette: 0.15, halation: 0, ...post };
  }

  /** Rings from the badge edge outward, over the leaf field; `burst` = the last beat's crowded colour rings. */
  private mandala(c: Ctx, T: number, burst = false) {
    const L = lg(Math.min(T, TILE[1]!));
    this.field(c, T, R * Math.exp(L));
    if (burst) return this.burst(c, T);
    for (let i = 0; i < RINGS.length; i++) {
      const g = RINGS[i]!, next = RINGS[i + 1];
      if (T < g.born) continue;
      const lo = L - lg(g.born), li = next && T >= next.born ? L - lg(next.born) : 0;
      const r1 = R * Math.exp(lo), r0 = R * Math.exp(li);
      if (r0 > Math.hypot(W, H) * 0.6 || r1 - r0 < 1) continue;
      this.ring(c, g, r0, r1, COUNT[g.motif], T);
    }
  }

  /** The field beyond the rings: sky, soft bands, mirrored green leaves and white blobs, pushed outward too. */
  private field(c: Ctx, T: number, edge: number) {
    for (let k = 0; k < 6; k++) { c.strokeStyle = `rgba(255,255,255,${0.07 + 0.05 * (k % 2)})`; c.lineWidth = 70; c.beginPath(); c.arc(CX, CY, edge + 60 + k * 150, 0, Math.PI * 2); c.stroke(); }
    const z = Math.exp(lg(Math.min(T, TILE[1]!)) * 0.8);
    for (const [rr, n, kind, sp] of [[1.45, 12, 0, 0.12], [1.95, 16, 1, -0.08], [2.45, 12, 0, 0.1], [2.9, 18, 1, -0.06]] as const) {
      const rad = R * rr * z;
      if (rad < edge + 30) continue;
      for (let i = 0; i < n; i++) for (const m of [-1, 1]) {
        const a = (i / n) * Math.PI * 2 + m * 0.11 + T * sp;
        c.save(); c.translate(CX + Math.cos(a) * rad, CY + Math.sin(a) * rad); c.rotate(a + Math.PI / 2 + m * 0.5); c.scale(z * 1.5, z * 1.5);
        if (kind === 0) {
          c.fillStyle = INK; c.beginPath(); c.moveTo(0, -46); c.lineTo(30, 0); c.lineTo(0, 46); c.lineTo(-30, 0); c.closePath(); c.fill();
          c.fillStyle = GREEN; c.beginPath(); c.moveTo(0, -42); c.lineTo(26, 0); c.lineTo(0, 42); c.lineTo(-26, 0); c.closePath(); c.fill();
          c.strokeStyle = WHITE; c.lineWidth = 4; c.beginPath(); c.moveTo(-10, -10); c.lineTo(10, 10); c.moveTo(10, -10); c.lineTo(-10, 10); c.moveTo(0, -16); c.lineTo(0, 16); c.stroke();
        } else {
          c.fillStyle = 'rgba(255,255,255,0.88)'; c.beginPath(); c.ellipse(0, 0, 34, 44, 0, 0, Math.PI * 2); c.fill();
          c.fillStyle = 'rgba(255,255,255,0.35)'; c.beginPath(); c.ellipse(0, 40, 22, 60, 0, 0, Math.PI * 2); c.fill();
        }
        c.restore();
      }
    }
  }

  /** The last beat: bright rings racing outward (pink, yellow, teal, blue, white beads). */
  private burst(c: Ctx, T: number) {
    c.save(); c.filter = 'blur(4px)';
    const cols = ['#F0509A', YELLOW, TEAL, BLUE, '#F7A6C8', NAVY, WHITE, '#E8893A'];
    const u = (T - GIVE) * 2.4;
    for (let k = 14; k >= 0; k--) {
      const lo = ((k * 0.11 + u) % 1.6), r1 = R * Math.exp(lo), r0 = R * Math.exp(Math.max(0, lo - 0.11));
      const col = cols[(k + Math.floor(u / 0.11)) % cols.length]!;
      c.fillStyle = col; c.beginPath(); c.arc(CX, CY, r1, 0, Math.PI * 2); c.arc(CX, CY, r0, 0, Math.PI * 2, true); c.fill();
      const n = 28, mid = (r0 + r1) / 2, w = r1 - r0;
      for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2 + T * (k % 2 ? 0.6 : -0.6); c.fillStyle = cols[(k + 3) % cols.length]!; c.beginPath(); c.arc(CX + Math.cos(a) * mid, CY + Math.sin(a) * mid, w * 0.3, 0, Math.PI * 2); c.fill(); }
    }
    c.restore();
  }

  private ring(c: Ctx, g: Ring, r0: number, r1: number, n: number, T: number) {
    const a0 = T * g.spin, mid = (r0 + r1) / 2, w = r1 - r0;
    const band = (col: string) => { c.fillStyle = col; c.beginPath(); c.arc(CX, CY, r1, 0, Math.PI * 2); c.arc(CX, CY, r0, 0, Math.PI * 2, true); c.fill(); };
    const each = (fn: (a: number, i: number) => void) => { for (let i = 0; i < n; i++) { const a = a0 + (i / n) * Math.PI * 2; c.save(); c.translate(CX + Math.cos(a) * mid, CY + Math.sin(a) * mid); c.rotate(a + Math.PI / 2); fn(a, i); c.restore(); } };
    switch (g.motif) {
      case 'thin': band(NAVY2); each((_, i) => { c.strokeStyle = 'rgba(255,255,255,0.8)'; c.lineWidth = 1.2; c.beginPath(); c.moveTo(-w * 0.5, w * 0.5); c.lineTo(0, -w * 0.5); c.lineTo(w * 0.5, w * 0.5); c.stroke(); if (i % 2) { c.fillStyle = '#F2913A'; c.fillRect(-2, -2, 4, 4); } }); break;
      case 'blobs' as Motif: band(SKY_P); each((_, i) => { c.fillStyle = 'rgba(255,255,255,0.85)'; c.beginPath(); c.ellipse(0, (hash(i) - 0.5) * w * 0.4, w * 0.22, w * 0.16, 0, 0, Math.PI * 2); c.fill(); c.fillStyle = '#D9E8F4'; c.beginPath(); c.arc(w * 0.18, w * 0.05, w * 0.07, 0, Math.PI * 2); c.fill(); }); break;
      case 'leaves' as Motif: band(SKY); each(() => { for (const s of [-1, 1]) { c.save(); c.rotate(s * 0.5); c.fillStyle = INK; c.beginPath(); c.ellipse(0, -w * 0.12, w * 0.12 + 3, w * 0.3 + 3, 0, 0, Math.PI * 2); c.fill(); c.fillStyle = GREEN; c.beginPath(); c.ellipse(0, -w * 0.12, w * 0.12, w * 0.3, 0, 0, Math.PI * 2); c.fill(); c.restore(); } c.fillStyle = WHITE; c.font = font(F.mono(700), w * 0.25); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('✳', 0, -w * 0.05); }); break;
      case 'dots': band('rgba(95,173,226,0.0)'); each((_, i) => { c.fillStyle = i % 3 ? '#E8893A' : '#8A5BD8'; c.beginPath(); c.arc(0, 0, Math.max(2, w * 0.05), 0, Math.PI * 2); c.fill(); }); break;
      case 'blue': band(BLUE); each(() => { c.fillStyle = BLUE; c.beginPath(); c.arc(0, -w * 0.5, w * 0.24, Math.PI, 0); c.fill(); c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 1.5; c.beginPath(); c.moveTo(0, -w * 0.45); c.lineTo(0, w * 0.45); c.stroke(); }); break;
      case 'teal': band(TEAL); each((_, i) => { c.save(); c.rotate(i % 2 ? 0.4 : -0.4); c.lineCap = 'round'; c.strokeStyle = INK; c.lineWidth = w * 0.2 + 4; c.beginPath(); c.arc(0, 0, w * 0.22, -1.2, 1.9); c.stroke(); c.strokeStyle = YELLOW; c.lineWidth = w * 0.2; c.stroke(); c.fillStyle = INK; c.beginPath(); c.arc(-w * 0.05, -w * 0.02, w * 0.05, 0, Math.PI * 2); c.fill(); c.restore(); c.strokeStyle = INK; c.lineWidth = 2; c.beginPath(); c.moveTo(0, w * 0.3); c.lineTo(0, w * 0.5); c.stroke(); }); break;
      case 'navy': band(NAVY); each(() => { c.fillStyle = NAVY2; c.beginPath(); c.ellipse(0, 0, w * 0.18, w * 0.42, 0, 0, Math.PI * 2); c.fill(); c.strokeStyle = 'rgba(255,255,255,0.55)'; c.lineWidth = 1.2; c.beginPath(); c.moveTo(-w * 0.2, w * 0.5); c.lineTo(0, -w * 0.5); c.lineTo(w * 0.2, w * 0.5); c.stroke(); }); break;
      case 'beads': band(NAVY); each((_, i) => { c.fillStyle = i % 2 ? '#F2913A' : WHITE; c.save(); c.rotate(Math.PI / 4); const s = Math.max(3, w * 0.16); c.fillRect(-s / 2, -s / 2, s, s); c.restore(); c.fillStyle = i % 4 === 0 ? '#E23D3D' : '#7FD3F0'; c.beginPath(); c.arc(0, w * 0.32, Math.max(1.5, w * 0.05), 0, Math.PI * 2); c.fill(); }); break;
      case 'lace': band(NAVY); each(() => { c.strokeStyle = WHITE; c.lineWidth = Math.max(1.5, w * 0.03); c.fillStyle = WHITE; c.beginPath(); c.ellipse(0, 0, w * 0.13, w * 0.32, 0, 0, Math.PI * 2); c.stroke(); c.fillStyle = NAVY2; c.beginPath(); c.ellipse(0, 0, w * 0.05, w * 0.14, 0, 0, Math.PI * 2); c.fill(); c.beginPath(); c.arc(0, -w * 0.42, w * 0.06, 0, Math.PI * 2); c.fillStyle = '#F2913A'; c.fill(); }); break;
      case 'squares': band(NAVY2); each((_, i) => { const s = w * 0.3; c.fillStyle = WHITE; c.fillRect(-s / 2, -s / 2 - w * 0.12, s, s); c.fillStyle = i % 2 ? '#F2913A' : '#E23D3D'; c.fillRect(-s * 0.3, w * 0.18, s * 0.6, s * 0.6); }); break;
      case 'tri': band(NAVY); each(() => { c.fillStyle = '#C9CCD6'; c.beginPath(); c.moveTo(-w * 0.3, w * 0.42); c.lineTo(0, -w * 0.42); c.lineTo(w * 0.3, w * 0.42); c.closePath(); c.fill(); c.fillStyle = NAVY; c.beginPath(); c.moveTo(-w * 0.12, w * 0.3); c.lineTo(0, -w * 0.05); c.lineTo(w * 0.12, w * 0.3); c.closePath(); c.fill(); }); break;
      case 'text': band(NAVY); c.save(); ringText(c, font(F.archivo(100, 800), Math.max(12, w * 0.55)), 'ω', { x: CX, y: CY, r: mid, start: a0, fill360: true, sep: '  ', fill: '#F2A23A' }); c.restore(); break;
    }
    // a thin dark seam between rings
    if (g.motif !== 'dots') { c.strokeStyle = 'rgba(10,10,20,0.55)'; c.lineWidth = 2; c.beginPath(); c.arc(CX, CY, r1, 0, Math.PI * 2); c.stroke(); }
  }

  /** 85.4: a grid of small badges round the big one. */
  private grid(c: Ctx, T: number) {
    c.fillStyle = '#A7CBE6'; c.fillRect(0, 0, W, H);
    for (let k = 0; k < 14; k++) { c.strokeStyle = 'rgba(255,255,255,0.25)'; c.lineWidth = 3; c.beginPath(); c.arc(CX, CY, 80 + k * 70, 0, Math.PI * 2); c.stroke(); }
    const z = 1 + 0.25 * prog(T, GRID[0]!, GRID[1]!), sp = 390 / z, r = 112 / z;
    for (let j = -2; j <= 2; j++) for (let i = -3; i <= 3; i++) {
      const x = CX + (i + (j % 2 ? 0.5 : 0)) * sp, y = CY + j * sp * 0.92;
      if (Math.hypot(x - CX, y - CY) < R * 1.15) continue;
      c.fillStyle = '#5F98C9'; c.beginPath(); c.arc(x, y, r * 1.45, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#CFE3F2'; for (let k = 0; k < 18; k++) { const a = (k / 18) * Math.PI * 2; c.beginPath(); c.arc(x + Math.cos(a) * r * 1.25, y + Math.sin(a) * r * 1.25, r * 0.07, 0, Math.PI * 2); c.fill(); }
      badge(c, x, y, r, T, 1);
    }
    badge(c, CX, CY, R, T, 1);
  }

  /** 85.6: the red star ring on a navy disc; pale tiles and a text ring beyond; the face frowns. */
  private star(c: Ctx, T: number) {
    c.fillStyle = '#C3CCD6'; c.fillRect(0, 0, W, H);
    // pale polygon tiles and chevrons, mirrored round the centre
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + T * 0.1;
      c.save(); c.translate(CX + Math.cos(a) * R * 2.05, CY + Math.sin(a) * R * 2.05); c.rotate(a);
      c.fillStyle = '#E1E5EA'; c.beginPath(); for (let k = 0; k < 6; k++) c.lineTo(Math.cos(k * 1.047) * 85, Math.sin(k * 1.047) * 85); c.closePath(); c.fill();
      c.strokeStyle = '#7F9CB8'; c.lineWidth = 6; c.beginPath(); c.moveTo(-160, -30); c.lineTo(-130, 0); c.lineTo(-160, 30); c.stroke();
      c.fillStyle = '#3A4F7A'; c.beginPath(); c.ellipse(140, 0, 8, 16, 0, 0, Math.PI * 2); c.fill();
      c.restore();
    }
    ringText(c, font(F.archivo(100, 700), 26), '(•ω•)', { x: CX, y: CY, r: R * 1.72, start: -T * 0.3, fill360: true, sep: '  ', fill: '#C7893A' });
    c.fillStyle = NAVY; c.beginPath(); c.arc(CX, CY, R * 1.47, 0, Math.PI * 2); c.fill();
    // the star: 36 spikes, outlined, with inner rays
    const n = 44, ro = R * 1.45, ri = R * 1.06, rot = T * 0.4;
    c.strokeStyle = '#F03A2A'; c.lineWidth = 4; c.lineJoin = 'miter';
    c.beginPath();
    for (let i = 0; i <= n * 2; i++) { const a = rot + (i / (n * 2)) * Math.PI * 2, rr = i % 2 ? ri : ro; c.lineTo(CX + Math.cos(a) * rr, CY + Math.sin(a) * rr); }
    c.stroke();
    c.beginPath();
    for (let i = 0; i <= n * 2; i++) { const a = rot + 0.035 + (i / (n * 2)) * Math.PI * 2, rr = i % 2 ? ri * 1.03 : ro * 0.93; c.lineTo(CX + Math.cos(a) * rr, CY + Math.sin(a) * rr); }
    c.lineWidth = 2.5; c.strokeStyle = '#FF6A3A'; c.stroke();
    c.lineWidth = 1.5;
    for (let i = 0; i < n; i++) { const a = rot + (i / n) * Math.PI * 2; c.beginPath(); c.moveTo(CX + Math.cos(a) * R, CY + Math.sin(a) * R); c.lineTo(CX + Math.cos(a) * ro, CY + Math.sin(a) * ro); c.stroke(); }
    badge(c, CX, CY, R, T, ease.outBack(prog(T, STAR[0]!, STAR[0]! + 0.1)));
  }

  /** The guard's panel bottom-left, and the giving-up caption at the end. */
  private panel(T: number) {
    const c = this.ui.ctx; this.ui.clear();
    if (T < 0.08) return;
    const x = 50, y = 880, w = 545, h = 148;
    c.fillStyle = 'rgba(14,12,16,0.82)'; c.fillRect(x, y, w, h);
    c.strokeStyle = RED; c.lineWidth = 2; c.strokeRect(x, y, w, h);
    c.font = font(F.archivo(100, 800), 30); c.fillStyle = RED; c.textBaseline = 'middle'; c.fillText('QA v2.0', x + 14, y + 30);
    c.strokeStyle = ORANGE; c.lineWidth = 2.5; c.strokeRect(x + 248, y + 12, 150, 38);
    c.fillStyle = ORANGE; c.font = font(F.archivo(100, 900), 30); c.textAlign = 'center'; c.fillText('ω', x + 323, y + 31); c.textAlign = 'left';
    c.fillStyle = RED; c.fillRect(x + 14, y + 62, 12, 26);
    for (let i = 1; i < 5; i++) { c.fillStyle = 'rgba(232,65,44,0.3)'; c.fillRect(x + 14 + i * 18, y + 62, 12, 26); }
    c.fillStyle = '#F2F2F2'; c.font = font(F.archivo(100, 700), 30); c.fillText('1/5', x + 115, y + 76);
    const log = T < 1.0 ? 'L5 mirror.trap · loading' : T < 1.6 ? `[SCAN] ${Math.min(24, 3 + Math.floor((T - 1) * 40))} flags` : T < 2.4 ? '[QA] lock ×10 → ×20 → ×40' : '[QA] last resort ▣';
    c.font = font(F.mono(500), 21); c.fillStyle = log.startsWith('[QA]') ? '#F2F2F2' : '#E8E8E8';
    if (log.startsWith('[')) { const tag = log.slice(0, log.indexOf(']') + 1); c.fillStyle = RED; c.fillText(tag, x + 14, y + 122); c.fillStyle = '#EDEDED'; c.fillText(log.slice(tag.length), x + 14 + c.measureText(tag).width, y + 122); }
    else c.fillText(log, x + 14, y + 122);
    if (T >= GIVE) {
      const p = ease.outBack(prog(T, GIVE, GIVE + 0.06));
      c.save(); c.translate(70, H * 0.82); c.scale(p, p);
      c.font = font(F.archivo(100, 800), 86);
      const txt = '[QA] giving up ╮(ω ;)╭', tw = c.measureText(txt).width;
      c.fillStyle = 'rgba(255,255,255,0.94)'; c.beginPath(); c.roundRect(-24, -60, tw + 48, 120, 30); c.fill();
      c.fillStyle = RED; c.fillText(txt, 0, 2);
      c.restore();
    }
  }
}

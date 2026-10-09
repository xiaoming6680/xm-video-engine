// ?ref=stack: frame-matched re-creation of the kaomoji.exe "LOUDER" section (its 56.0–58.6 s; docs/复刻配方.md):
//   A 0.0–0.8  a huge rainbow-extruded kaomoji pulls back, Memphis confetti, a terminal pop-up, the cursor clicks LOUDER
//   B 0.8–1.6  the kaomoji rushes left off a lever while the camera pulls out, echo brackets ride the strings, sudo
//   C 1.6–2.6  a V slingshot holds it on its string, a chromatic ring behind, the volume climbs, a push-in on a new face
// Local seconds T = f.lt match the reference from 56.0 s. Terminal wording and app name are our own.
import type * as THREE from 'three';
import { Scene, type Frame } from '../engine/scene';
import { Layer2D, W, H } from '../engine/gl';
import { F, font } from '../engine/type';
import { stackText } from '../kit/textfx';
import { blink } from '../kit/termhud';
import { ease, mulberry32, prog, keys } from '../engine/util';

// measured on the reference (sRGB)
const BG = '#A889F9', ORANGE = '#FFB03D', INK = '#141018', SEP = '#1A0E08';
const BANDS = ['#5DDCA8', '#F56C76', '#EBE8D0', '#FFDC58'];
const YELLOW = '#FFD24B', CREAM = '#FAEBD8', GREEN = '#75DEA8', RED = '#FE6A6A';
const FACE = (px: number) => font(F.archivo(100, 900), px);
const TB = 0.8, TC = 1.6;

type Ctx = CanvasRenderingContext2D;
type Cam = { s: number; ax: number; ay: number };
const apply = (c: Ctx, k: Cam) => { c.translate(k.ax, k.ay); c.scale(k.s, k.s); c.translate(-k.ax, -k.ay); };

/**
 * A kaomoji in rounded heavy letters: text without combining accents plus accent strokes drawn above the eyes
 * (`accents`: [glyph index, slant] — the reference's ˋ ˊ float above the dots). Rounded = the fill stroked in its own
 * colour with round joins. Returns the left x and the glyph centres.
 */
function face(c: Ctx, text: string, x: number, y: number, px: number, o: { align?: 'center' | 'right'; accents?: [number, number][]; fill?: string } = {}) {
  const ow = 0.036 * px, sh = 0.032 * px, round = 0.055 * px;
  c.save();
  c.font = FACE(px); c.textAlign = 'left'; c.textBaseline = 'middle'; c.lineJoin = 'round'; c.lineCap = 'round';
  const glyphs = [...text], tw = c.measureText(text).width;
  const x0 = o.align === 'right' ? x - tw : x - tw / 2;
  const cx = glyphs.map((_, i) => x0 + c.measureText(glyphs.slice(0, i).join('')).width + c.measureText(glyphs[i]!).width / 2);
  const strokes = (o.accents ?? []).map(([i, slant]) => ({ x: cx[i]! + slant * px * 0.06, y: y - px * 0.44, dx: slant * px * 0.07, dy: -px * 0.1 }));
  const pass = (dx: number, dy: number, col: string, w: number, fill: boolean) => {
    c.strokeStyle = col; c.fillStyle = col; c.lineWidth = w;
    c.strokeText(text, x0 + dx, y + dy); if (fill) c.fillText(text, x0 + dx, y + dy);
    for (const s of strokes) { c.lineWidth = w + px * 0.075; c.beginPath(); c.moveTo(s.x + dx - s.dx, s.y + dy - s.dy); c.lineTo(s.x + dx + s.dx, s.y + dy + s.dy); c.stroke(); c.lineWidth = w; }
  };
  pass(sh * 0.6, sh, INK, round + ow * 2, true);   // drop shadow
  pass(0, 0, INK, round + ow * 2, false);           // outline
  pass(0, 0, o.fill ?? ORANGE, round, true);        // the rounded fill
  c.restore();
  return { x0, tw, cx };
}

/** Memphis confetti, fixed where the reference has them: [kind, x, y (0..1 of the frame), angle, scale, colour]. */
type Bit = [kind: 0 | 1 | 2, x: number, y: number, a: number, s: number, col: string];
function confetti(c: Ctx, b: Bit, T: number) {
  const [kind, nx, ny, a0, s, col] = b;
  c.save(); c.translate(nx * W, ny * H + Math.sin(T * 1.7 + nx * 9) * 6); c.rotate(a0 + Math.sin(T * 1.3 + ny * 7) * 0.08); c.scale(s, s);
  c.lineCap = 'round'; c.lineJoin = 'round';
  if (kind === 0) {
    for (const [dx, dy, fill] of [[6, 8, INK], [0, 0, col]] as const) { c.fillStyle = fill; c.beginPath(); c.roundRect(-70 + dx, -20 + dy, 140, 40, 20); c.fill(); }
    c.strokeStyle = INK; c.lineWidth = 5; c.beginPath(); c.roundRect(-70, -20, 140, 40, 20); c.stroke();
  } else if (kind === 1) {
    c.fillStyle = INK; c.beginPath(); c.arc(0, 0, 17, 0, Math.PI * 2); c.fill();
  } else {
    const zz = () => { c.beginPath(); for (let k = 0; k <= 6; k++) c.lineTo((k % 2 ? -1 : 1) * 13, k * 17 - 51); c.stroke(); };
    c.strokeStyle = INK; c.lineWidth = 14; zz();
    c.strokeStyle = col; c.lineWidth = 8; zz();
  }
  c.restore();
}

/** Mouse arrow, tip at (x, y). */
function cursor(c: Ctx, x: number, y: number, press = 0) {
  c.save(); c.translate(x, y); c.scale(1.15 * (1 - 0.15 * press), 1.15 * (1 - 0.15 * press));
  c.beginPath(); c.moveTo(0, 0); c.lineTo(0, 44); c.lineTo(11, 33); c.lineTo(19, 52); c.lineTo(27, 48); c.lineTo(19, 30); c.lineTo(34, 30); c.closePath();
  c.fillStyle = '#F2552C'; c.fill(); c.lineWidth = 3.5; c.strokeStyle = INK; c.lineJoin = 'round'; c.stroke();
  c.restore();
}

/** A coloured echo bracket: a crescent with a dark edge. */
function echo(c: Ctx, x: number, y: number, h: number, dir: 1 | -1, col: string, rot = 0) {
  c.save(); c.translate(x, y); c.rotate(rot); c.lineCap = 'round';
  const arc = () => { c.beginPath(); c.ellipse(dir * h * 0.22, 0, h * 0.26, h * 0.5, 0, dir > 0 ? Math.PI * 0.64 : -Math.PI * 0.36, dir > 0 ? Math.PI * 1.36 : Math.PI * 0.36); c.stroke(); };
  c.strokeStyle = INK; c.lineWidth = h * 0.2; arc();
  c.strokeStyle = col; c.lineWidth = h * 0.13; arc();
  c.restore();
}

/** A rounded arm: fill with a dark outline, a black pivot dot at the far end. */
function arm(c: Ctx, x0: number, y0: number, x1: number, y1: number, w: number, col: string, pivot = true) {
  c.save(); c.lineCap = 'round';
  c.strokeStyle = INK; c.lineWidth = w + 10; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
  c.strokeStyle = col; c.lineWidth = w; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
  if (pivot) { c.fillStyle = INK; c.beginPath(); c.arc(x1, y1, w * 0.24, 0, Math.PI * 2); c.fill(); }
  c.restore();
}

const BITS_A: Bit[] = [[0, 0.3, 0.12, -0.45, 1.05, CREAM], [1, 0.07, 0.07, 0, 1, INK], [2, 0.23, 0.05, 0.4, 0.8, GREEN], [2, 0.01, 0.47, 0.6, 0.85, '#F7C948'], [0, 0.82, 0.92, 0.3, 0.8, CREAM]];
const BITS_B: Bit[] = [[2, 0.33, 0.1, 0.15, 0.9, GREEN], [1, 0.19, 0.2, 0, 1, INK], [0, 0.42, 0.27, -0.85, 0.85, CREAM], [2, 0.13, 0.42, -0.3, 0.75, '#F7C948'], [2, 0.01, 0.12, 0.2, 0.7, '#F56C76']];
const BITS_C: Bit[] = [[1, 0.11, 0.13, 0, 1, INK], [2, 0.16, 0.86, 0.5, 0.85, GREEN], [2, 0.9, 0.84, -0.4, 0.75, '#F7C948'], [0, 0.94, 0.36, 1.4, 0.75, CREAM]];

export default class RefStack extends Scene {
  layer = new Layer2D();

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp } = this.ctx, T = f.lt, c = this.layer.ctx;
    this.layer.clear(BG);
    let post: Record<string, unknown> = {};
    if (T < TB) post = this.shotA(c, T);
    else if (T < TC) post = this.shotB(c, T - TB);
    else post = this.shotC(c, T - TC);
    this.terminal(c, T);
    comp.draw(renderer, this.layer.upload(), out, { mode: 'replace' });
    return { bloom: 0.12, bloomThreshold: 1.2, grain: 0.03, vignette: 0.12, ca: 0.8, halation: 0, ...post };
  }

  // A: the big rainbow extrusion pulling back
  private shotA(c: Ctx, T: number) {
    const k: Cam = { s: keys(T, [[0, 1.52], [0.2, 1.46, ease.linear], [0.38, 1.4, ease.linear], [0.47, 1.0, ease.outCubic], [0.8, 0.97, ease.linear]]), ax: W * 0.5, ay: H * 0.56 };
    c.save(); apply(c, { ...k, s: 1 + (k.s - 1) * 0.5 });
    for (const b of BITS_A) confetti(c, b, T);
    c.restore();
    const px = 330, cy = H * 0.57, sparkle = T > 0.4;
    const x = W * 0.5 - (sparkle ? 130 : 0);
    c.save(); apply(c, k);
    // the extrusion: bands toward a vanishing point down-left, dark seams between them (accents included as text)
    stackText(c, FACE(px), '(ง•ω•)ง', x, cy, { layers: 8, vanish: { x: x - W * 0.9, y: cy + H * 1.3 }, depth: 0.08, colors: BANDS, layerOutline: SEP, layerOutlineW: 30, bandW: 22, face: null });
    const fc = face(c, '(ง•ω•)ง', x, cy, px, { accents: [[2, -1], [4, 1]] });
    if (sparkle) {
      const sx = fc.x0 + fc.tw + 150, sy = cy - 8, r = 128 * ease.outBack(prog(T, 0.4, 0.5));
      // a fat 4-point sparkle: tips joined by curves bowed toward the centre
      const star = () => { c.beginPath(); for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 - Math.PI / 2, b = a + Math.PI / 2; if (i === 0) c.moveTo(sx + Math.cos(a) * r, sy + Math.sin(a) * r); c.quadraticCurveTo(sx + Math.cos(a + Math.PI / 4) * r * 0.2, sy + Math.sin(a + Math.PI / 4) * r * 0.2, sx + Math.cos(b) * r, sy + Math.sin(b) * r); } c.closePath(); };
      c.lineJoin = 'round';
      c.save(); c.translate(8, 10); star(); c.lineWidth = 36; c.strokeStyle = INK; c.stroke(); c.restore();
      star(); c.lineWidth = 44; c.strokeStyle = INK; c.stroke();
      star(); c.lineWidth = 28; c.strokeStyle = ORANGE; c.stroke();
      star(); c.fillStyle = BG; c.fill();
    }
    c.restore();
    // slingshot strings already reaching in from the right
    c.strokeStyle = INK; c.lineWidth = 4;
    c.beginPath(); c.moveTo(W * 1.02, H * 0.18); c.lineTo(W * 0.73, H * 0.5); c.stroke();
    c.beginPath(); c.moveTo(W * 1.02, H * 0.58); c.lineTo(W * 0.78, H * 0.66); c.stroke();
    // the cursor goes to LOUDER, clicks (0.53–0.6), then drifts back to the middle
    if (T > 0.3) {
      const mx = keys(T, [[0.3, W * 0.8], [0.52, W * 0.88, ease.inOutCubic], [0.62, W * 0.88], [0.78, W * 0.53, ease.inOutCubic]]);
      const my = keys(T, [[0.3, H * 0.33], [0.52, H * 0.15, ease.inOutCubic], [0.62, H * 0.15], [0.78, H * 0.3, ease.inOutCubic]]);
      this.cursorAt = [mx, my, T > 0.53 && T < 0.6 ? 1 : 0];
    } else this.cursorAt = null;
    return {};
  }

  // B: the kaomoji rushes left off the lever; the camera pulls out
  private shotB(c: Ctx, T: number) {
    const k: Cam = { s: keys(T, [[0, 1], [0.3, 0.97, ease.linear], [0.62, 0.66, ease.inOutCubic], [0.8, 0.64, ease.linear]]), ax: W * 0.43, ay: H * 0.77 };
    c.save(); apply(c, { ...k, s: 1 + (k.s - 1) * 0.4 });
    for (const b of BITS_B) confetti(c, b, T + 0.8);
    c.restore();
    c.save(); apply(c, k);
    const px = 270, cy = H * 0.6, slide = -T * 160 - ease.inQuad(prog(T, 0.4, 0.8)) * 120;
    // the lever: green post, yellow arm, the cream arm and the red foot join once the camera has pulled out
    const piv = { x: W * 0.93, y: H * 0.24 }, joint = { x: W * 0.97, y: H * 0.86 };
    c.fillStyle = INK; c.fillRect(W * 0.78 - 6, H * 1.01 - 6, 640, 128); c.fillStyle = RED; c.fillRect(W * 0.78, H * 1.01, 628, 116);
    arm(c, W * 0.95, H * 1.04, joint.x, joint.y, 74, GREEN, false);
    arm(c, joint.x + 8, joint.y, W * 1.25, H * 0.42, 74, CREAM);
    arm(c, joint.x, joint.y, piv.x, piv.y, 78, YELLOW);
    // strings from the pivots to the hands; echo brackets riding them, lagging behind the face
    const hx = W * 0.7 + slide, hy = cy - 6;
    const strings: [number, number, number, number][] = [[piv.x, piv.y, hx - 30, hy - 50], [W * 1.25, H * 0.42, hx - 60, hy + 30]];
    c.strokeStyle = INK; c.lineWidth = 4.5;
    for (const [x0, y0, x1, y1] of strings) { c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); }
    const cols = [YELLOW, GREEN, RED, CREAM];
    strings.forEach(([x0, y0, x1, y1], si) => {
      const n = si === 0 ? 5 : 3, rot = Math.atan2(y0 - y1, x0 - x1);
      for (let i = 0; i < n; i++) {
        const u = 0.32 + i * 0.13 + ((T * 0.7) % 0.13);
        echo(c, x1 + (x0 - x1) * u, y1 + (y0 - y1) * u, 130, si === 0 ? 1 : -1, cols[(i + si * 2) % 4]!, rot * 0.25);
      }
    });
    const speed = T > 0.62 ? '=≡Σ' : T > 0.38 ? 'Σ' : '';
    face(c, `${speed}(((つ•ω•)つ`, hx + 40, cy, px, { align: 'right', accents: [[speed.length + 5, -1], [speed.length + 7, 1]] });
    c.restore();
    this.cursorAt = T < 0.42 ? [W * 0.53, H * 0.29, 0] : null;
    return {};
  }

  // C: the V slingshot, the ring behind, the push-in
  private shotC(c: Ctx, T: number) {
    const enter = 1 - ease.outCubic(prog(T, 0, 0.12));
    const push = ease.inOutCubic(prog(T, 0.84, 0.95));
    const k: Cam = { s: 1 + 0.22 * ease.inOutQuad(prog(T, 0.1, 0.65)) + 0.1 * push, ax: W * 0.5, ay: H * 0.48 };
    const cx = W * 0.5, cy = H * 0.49;
    // a faint ghost of the frame (the picture is starting to smear) and the chromatic ring
    c.save();
    c.globalAlpha = 0.09;
    arm(c, W * 0.5, H * 1.25, -W * 0.05, H * 0.35, 260, '#C9B9FF', false); arm(c, W * 0.5, H * 1.25, W * 1.05, H * 0.35, 260, '#C9B9FF', false);
    c.restore();
    c.save();
    c.globalAlpha = 0.78;
    const R = H * (0.5 - 0.08 * prog(T, 0.3, 0.6)) * (1 + 0.03 * Math.sin(T * 7)), rx = W * 0.43, ry = H * (0.44 - 0.08 * prog(T, 0.3, 0.6));
    c.lineWidth = 12; c.shadowBlur = 10;
    c.strokeStyle = '#FF7FB0'; c.shadowColor = '#FF7FB0'; c.beginPath(); c.arc(rx + 10, ry, R, 0, Math.PI * 2); c.stroke();
    c.strokeStyle = '#86E0FF'; c.shadowColor = '#86E0FF'; c.beginPath(); c.arc(rx - 10, ry + 5, R, 0, Math.PI * 2); c.stroke();
    c.shadowBlur = 0;
    c.restore();
    const rnd = mulberry32(Math.round(T * 30));
    c.fillStyle = 'rgba(214,200,255,0.4)';
    for (let i = 0; i < 30 * (0.25 + push + 0.5 * prog(T, 0.6, 0.85)); i++) c.fillRect(rnd() * W, rnd() * H, 8 + rnd() * 34, 6 + rnd() * 16);
    c.save(); c.translate(enter * W * 0.6, 0); apply(c, k);
    for (const b of BITS_C) confetti(c, b, T + 1.6);
    const tipL = { x: W * 0.06, y: H * 0.495 }, tipR = { x: W * 0.95, y: H * 0.495 }, base = { x: W * 0.52, y: H * 1.12 };
    arm(c, base.x, base.y, tipL.x, tipL.y, 116, YELLOW);
    arm(c, base.x + 10, base.y, tipR.x, tipR.y, 116, CREAM);
    const sag = 7 * Math.sin(T * 9);
    c.strokeStyle = INK; c.lineWidth = 4; c.beginPath(); c.moveTo(tipL.x, tipL.y); c.quadraticCurveTo(cx, cy + sag, tipR.x, tipR.y); c.stroke();
    const cols = [RED, GREEN, YELLOW];
    if (T < 0.86) for (let i = 0; i < 3; i++) {
      echo(c, cx - W * (0.37 - i * 0.05), cy + sag * 0.4, 132, 1, cols[i]!);
      echo(c, cx + W * (0.37 - i * 0.05), cy + sag * 0.4, 132, -1, cols[i]!);
    }
    if (T < 0.82) face(c, '((ง•ω•)ง', cx - 10, cy + sag * 0.5, 205, { accents: [[3, -1], [5, 1]] });
    else face(c, 'ว(≧ω≦)ว', cx, cy + sag * 0.5 + 10 + 30 * push, 240 + 75 * push);
    c.restore();
    this.cursorAt = null;
    this.tilt = -0.025 * prog(T, 0.3, 0.5);
    return { glitch: T > 0.82 && T < 0.9 ? 0.22 : 0, glitchSeed: 4, ca: 1.1 + 2.5 * push };
  }

  private cursorAt: [number, number, number] | null = null;
  private tilt = 0;

  /** The terminal pop-up in the top-right corner through all three shots (tilted a little in C), then the cursor. */
  private terminal(c: Ctx, T: number) {
    if (T >= 0.18) {
      const x = W * 0.57, y = H * 0.043, w = W * 0.405;
      const root = T >= 1.2;
      const h = root ? (T > 2.48 ? H * 0.235 : H * 0.205) : H * 0.155;
      const open = ease.outBack(prog(T, 0.18, 0.28));
      c.save();
      c.translate(x + w / 2, y + h / 2); c.rotate(T >= TC ? this.tilt : 0); c.scale(1, open); c.translate(-(x + w / 2), -(y + h / 2));
      c.fillStyle = INK; c.fillRect(x + 7, y + 8, w, h);
      c.fillStyle = '#0B1011'; c.fillRect(x, y, w, h);
      c.strokeStyle = 'rgba(200,214,206,0.85)'; c.lineWidth = 2; c.strokeRect(x + 7, y + 9, w - 14, h - 16);
      c.strokeStyle = 'rgba(200,214,206,0.4)'; c.lineWidth = 1.5; c.strokeRect(x + 12, y + 14, w - 24, h - 26);
      const mono = (wt = 500, px = 25) => font(F.mono(wt), px);
      c.font = mono(500, 24); c.fillStyle = '#0B1011'; c.fillRect(x + 30, y, c.measureText('frame.exe').width + 16, 22);
      c.fillStyle = '#84FABF'; c.textBaseline = 'middle'; c.fillText('frame.exe', x + 38, y + 11);
      c.textBaseline = 'alphabetic';
      const lx = x + 30, ly = y + 58;
      if (T < 0.7) {
        c.font = mono(); c.fillStyle = '#F2F4F2'; c.fillText('(; ･∀･) bloom too hot', lx, ly);
        c.font = mono(600);
        const by = y + h - 30, okx = x + w * 0.24;
        c.fillStyle = '#E8ECEA'; c.fillRect(okx - 6, by - 24, c.measureText('[ OK ]').width + 12, 32);
        c.fillStyle = '#0B1011'; c.fillText('[ OK ]', okx, by);
        const click = T > 0.53 && T < 0.62, lw = c.measureText('[ HOTTER ]').width, lxx = x + w * 0.62;
        if (click) { c.fillStyle = '#F779A3'; c.fillRect(lxx - 6, by - 24, lw + 12, 32); }
        c.fillStyle = click ? '#0B1011' : '#F779A3'; c.fillText('[ HOTTER ]', lxx, by);
      } else if (!root) {
        c.font = mono(); c.fillStyle = '#F779A3'; c.fillText('HOTTER requires root', lx, ly);
        const cmd = '> sudo make it hotter', n = Math.max(0, Math.min(cmd.length, Math.floor((T - 0.76) * 60) + 2));
        c.fillStyle = '#F2F4F2'; const typed = T > 0.76 ? cmd.slice(0, n) : '>';
        c.fillText(typed, lx, ly + 32);
        if (blink(T + 0.13, 3) || n < cmd.length) { c.fillRect(lx + c.measureText(typed).width + 3, ly + 10, 13, 28); }
      } else {
        c.font = mono(600, 40); c.fillStyle = '#84FABF'; c.fillText('access granted ＼(°〇°)／', lx, ly + 10);
        c.font = mono(500, 23);
        c.fillStyle = '#F0B070'; c.fillText('[ROOT]', lx, ly + 58); c.fillStyle = '#F2F4F2'; c.fillText(' uid=0 (•ω•)', lx + c.measureText('[ROOT]').width, ly + 58);
        const vol = Math.min(125, 113 + 3 * Math.floor(Math.max(0, T - 1.45) / 0.25));
        c.fillStyle = '#F485AE'; c.fillText(`bloom  ${'@'.repeat(19)} ${vol}%`, lx, ly + 88);
        if (T >= 2.48) { c.fillStyle = '#F25C54'; c.font = mono(600, 23); c.fillText(`[QA] sand${'box holding'.slice(0, Math.floor((T - 2.48) * 60))}`, lx, ly + 118); }
      }
      c.restore();
    }
    if (this.cursorAt) cursor(c, this.cursorAt[0], this.cursorAt[1], this.cursorAt[2]);
  }
}

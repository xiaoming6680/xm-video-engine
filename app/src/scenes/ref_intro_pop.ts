// ?ref=intro, 15.36–22.2 s (bars 10–14; docs/复刻配方.md): the pop / risograph section, timed to the reference (song
// time = its time). A staircase wipe eats the SMILE.EXE colour sheet; a big misregistered face on halftone paper; bar
// 11 cuts the card every 16th (cream, pink, blue, yellow) with a new face every beat; bar 12 a small face rushes up to
// fill the frame each beat, speed lines behind; bar 13 white faces drift over purple; bar 14 the face falls apart, its
// pink eyes stay, slide together and set as the sun over a sea of ω — the sun ref_droste's frame tunnel starts from.
// The print look is the post `riso` pass (pink + blue + yellow inks, halftone, misregistration): the cards are flat.
// Animatic pass: cuts, layout and moves follow the reference; detail comes in the fine pass.
import * as THREE from 'three';
import { Scene, type Frame } from '../engine/scene';
import { FSPass, Layer2D, W, H, makeRT } from '../engine/gl';
import { F, font } from '../engine/type';
import { ease, hash, keys, lerp, mulberry32, prog } from '../engine/util';

type Ctx = CanvasRenderingContext2D;
const WIPE = 15.36, WIPE_DUR = 0.2, CARDS = 16.0, RUSH = 17.6, DRIFT = 19.2, LAST = 20.8, FALL = 21.12, SUNSET = 21.3, END = 22.2;
const CREAM = '#F2EEE6', PINK = '#F0549E', BLUE = '#1F6FB8', YELLOW = '#FFE04A', PURPLE = '#8A5AB0', NAVY = '#2B3A78';
const ROUND = F.archivo(100, 900);
/** One face per beat (song beat index → face). */
const CARD_FACES = ['(•ω•)', '(•ω•)ノ', '=^•ω•^=', '(=^•ω•^=)', '(^▽^)', '(≧▽≦)', '(°o°)', '(°O°)ノ'];
const RUSH_FACES = ['Σ(•□•)', '(☆▼☆)', '(°◆°)', '\\(^O^)/'];
const DRIFT_FACES = ['=^•ω•^=', '(•ω•)', '(^▽^)', '(≧ω≦)'];

export default class RefIntroPop extends Scene {
  override handlesTransition = true;
  layer = new Layer2D();
  card = makeRT();
  wipe = new FSPass(/* glsl */ `
    uniform sampler2D under, cur; uniform float t, t0, dur, hasUnder;
    void main() {
      // 16 x 9 cells, revealed along a staircase from the top left; the cells just about to go are purple
      vec2 cell = floor(vec2(vUv.x * 16.0, (1.0 - vUv.y) * 9.0));
      float tr = t0 + dur * (cell.x + 1.1 * cell.y) / 23.8;
      vec4 c = texture(cur, vUv);
      if (hasUnder < 0.5 || t >= tr) fragColor = c;
      else if (t >= tr - 0.016) fragColor = vec4(vec3(0.25, 0.1, 0.42) * (0.75 + 0.25 * hash12(cell)), 1.0);
      else fragColor = texture(under, vUv);
    }`, { under: { value: null }, cur: { value: null }, t: { value: 0 }, t0: { value: WIPE }, dur: { value: WIPE_DUR }, hasUnder: { value: 0 } });

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const t = f.t, { renderer, comp } = this.ctx, c = this.layer.ctx;
    let post: Record<string, unknown> = {};
    if (t < CARDS) post = this.face(c, t, CREAM, '(•ω•)', 0.95 + 0.12 * prog(t, 15.5, CARDS), PINK, BLUE, true);
    else if (t < RUSH) post = this.cards(c, t);
    else if (t < DRIFT) post = this.rush(c, t);
    else if (t < LAST) post = this.drift(c, t);
    else post = this.sunset(c, t);
    comp.draw(renderer, this.layer.upload(), this.card, { mode: 'replace' });
    this.wipe.u.under!.value = f.under; this.wipe.u.cur!.value = this.card.texture;
    this.wipe.u.t!.value = t; this.wipe.u.hasUnder!.value = f.under ? 1 : 0;
    this.wipe.render(renderer, out);
    // the print: riso inks over the whole section, in while the wipe runs
    return { riso: prog(t, WIPE, WIPE + WIPE_DUR), risoInks: 0, risoDot: 9, risoShift: 3.5, bloom: 0.15, bloomThreshold: 1.2, grain: 0.03, vignette: 0.1, ca: 0.6, halation: 0, ...post };
  }

  /** A card: ground colour, a big face with an offset copy (misregistered second ink), registration marks. */
  private face(c: Ctx, t: number, ground: string, text: string, scale: number, ink: string, shadow: string, marks: boolean, dx = 0) {
    if (ground) this.layer.clear(ground);
    const size = H * 0.42 * scale;
    c.font = font(ROUND, size); c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineJoin = 'round'; c.lineWidth = size * 0.08;
    c.fillStyle = shadow; c.strokeStyle = shadow;
    c.strokeText(text, W / 2 + dx + size * 0.05, H / 2 + size * 0.06); c.fillText(text, W / 2 + dx + size * 0.05, H / 2 + size * 0.06);
    c.fillStyle = ink; c.strokeStyle = ink;
    c.strokeText(text, W / 2 + dx, H / 2); c.fillText(text, W / 2 + dx, H / 2);
    c.textAlign = 'left';
    if (marks) this.marks(c, ground === CREAM ? NAVY : '#2A2A40');
    return {};
  }

  private marks(c: Ctx, col: string) {
    c.strokeStyle = col; c.lineWidth = 2;
    for (const [x, y] of [[48, 48], [W - 48, 48], [48, H - 48], [W - 48, H - 48]]) {
      c.beginPath(); c.arc(x, y, 14, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.moveTo(x - 22, y); c.lineTo(x + 22, y); c.moveTo(x, y - 22); c.lineTo(x, y + 22); c.stroke();
    }
    c.font = font(F.mono(500), 12); c.fillStyle = col; c.fillText('E2 80 A2 20 CF 89 · riso · 2 inks', 80, H - 44);
  }

  /** A torn paper edge (a jagged polygon) — the next card sliding in at the frame's side. */
  private torn(c: Ctx, x: number, col: string, seed: number, left: boolean) {
    const rnd = mulberry32(seed);
    c.fillStyle = col; c.beginPath();
    c.moveTo(left ? -10 : W + 10, -10);
    for (let y = -10; y <= H + 10; y += 26) c.lineTo(x + (rnd() - 0.5) * 34, y);
    c.lineTo(left ? -10 : W + 10, H + 10); c.closePath(); c.fill();
  }

  // bar 11: a cut every 16th through four grounds, a new face every beat
  private cards(c: Ctx, t: number) {
    // (the reference's cards change a frame after each 16th)
    const s16 = Math.max(0, Math.floor((t - CARDS - 0.03) / 0.1)), beat = Math.max(0, Math.floor((t - CARDS - 0.03) / 0.4));
    const grounds = [CREAM, PINK, BLUE, YELLOW], g = grounds[s16 % 4]!;
    const ink = g === CREAM ? PURPLE : g === PINK ? BLUE : g === BLUE ? PINK : '#7A3A18', sh = g === CREAM ? PINK : g === YELLOW ? '#F07830' : CREAM;
    const local = Math.max(0, (t - CARDS - 0.03 - s16 * 0.1) / 0.1);
    // every card punches in a little and slides: the frame never stands still between the cuts
    const r = mulberry32(s16 * 3 + 1);
    this.face(c, t, g, CARD_FACES[beat % CARD_FACES.length]!, 1.12 - 0.1 * local + 0.05 * r(), ink, sh, true, (r() - 0.5) * 160 + (local - 0.5) * 90);
    // torn pieces: the next ground peeking in at the right, a yellow or pink triangle at the left
    this.torn(c, W - 40 - 160 * local, grounds[(s16 + 1) % 4]!, s16 * 7 + 3, false);
    const rnd = mulberry32(s16 + 50);
    c.fillStyle = rnd() < 0.5 ? YELLOW : PINK;
    c.beginPath(); c.moveTo(-10, H * (0.1 + 0.2 * rnd())); c.lineTo(80 + 120 * rnd(), H * (0.5 + 0.1 * rnd())); c.lineTo(-10, H * (0.85 + 0.1 * rnd())); c.fill();
    return {};
  }

  // bar 12: each beat a small face rushes up from the middle to fill the frame; speed lines behind
  private rush(c: Ctx, t: number) {
    const beat = Math.floor((t - RUSH) / 0.4), q = ((t - RUSH) % 0.4) / 0.4;
    const g = [PINK, BLUE, CREAM, PINK][beat % 4]!;
    this.layer.clear(g);
    const rnd = mulberry32(beat * 11 + 2);
    c.strokeStyle = g === CREAM ? 'rgba(240,84,158,0.6)' : 'rgba(255,255,255,0.45)'; c.lineCap = 'round';
    for (let i = 0; i < 90; i++) {
      const a = rnd() * Math.PI * 2, d = (rnd() + q * 2.6) % 1, r0 = H * (0.08 + 0.9 * d), len = 30 + 160 * d;
      c.lineWidth = 2 + 5 * d; c.beginPath();
      c.moveTo(W / 2 + Math.cos(a) * r0 * 1.7, H / 2 + Math.sin(a) * r0); c.lineTo(W / 2 + Math.cos(a) * (r0 + len) * 1.7, H / 2 + Math.sin(a) * (r0 + len)); c.stroke();
    }
    // small for a moment, then it rushes up (the reference: big 0.15 s into the beat), still growing
    const scale = 0.12 + 1.0 * ease.inOutCubic(prog(q, 0.1, 0.36)) + 0.25 * q;
    const ink = g === BLUE ? CREAM : g === PINK ? BLUE : PINK;
    this.face(c, t, '', RUSH_FACES[beat % RUSH_FACES.length]!, scale, ink, g === CREAM ? BLUE : PINK, false);
    return {};
  }

  // bar 13: white faces drift sideways over purple, a new one every beat
  private drift(c: Ctx, t: number) {
    const beat = Math.floor((t - DRIFT) / 0.4), q = ((t - DRIFT) % 0.4) / 0.4;
    this.face(c, t, PURPLE, DRIFT_FACES[beat % DRIFT_FACES.length]!, 1.18 - 0.12 * ease.outCubic(q), '#F6F2EC', '#6A3A90', false, (0.5 - ease.outCubic(q)) * W * 0.5 * (beat % 2 ? -1 : 1));
    return {};
  }

  // bar 14: the last face falls apart, the eyes stay and set as the sun over a sea of ω
  private sunset(c: Ctx, t: number) {
    const fall = ease.inCubic(prog(t, FALL, FALL + 0.16)), sea = ease.outCubic(prog(t, FALL + 0.05, SUNSET + 0.15));
    const toCream = prog(t, 21.95, END, ease.inOutQuad);
    this.layer.clear(CREAM);
    // sky: peach to pale yellow, fading back to cream for the cut
    if (sea > 0) {
      const g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, `rgba(250,232,176,${sea * (1 - toCream)})`); g.addColorStop(0.75, `rgba(246,196,140,${sea * (1 - toCream)})`);
      c.fillStyle = g; c.fillRect(0, 0, W, H);
    }
    // the face: brackets and ω drop away; the eyes (pink dots) stay, then slide together into the sun
    const size = H * 0.42;
    c.font = font(ROUND, size); c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round'; c.lineWidth = size * 0.08;
    if (fall < 1) {
      c.fillStyle = BLUE; c.strokeStyle = BLUE;
      const y = H / 2 + fall * H * 0.9 - 30 * Math.sin((t - LAST) * 9);
      for (const [s, x] of [['(', -0.33], ['ω', 0], [')', 0.33]] as const) { c.strokeText(s, W / 2 + x * W, y); c.fillText(s, W / 2 + x * W, y); }
    }
    const merge = ease.inOutCubic(prog(t, SUNSET, 21.5));
    const rise = keys(t, [[SUNSET, H * 0.8], [21.9, H * 0.62, ease.outCubic], [END, H * 0.5, ease.inOutQuad]]);
    const eyeY = lerp(H * 0.36 + (t < FALL ? 0 : 0), rise, merge);
    for (const s of [-1, 1]) {
      const x = W / 2 + s * W * 0.17 * (1 - merge);
      if (merge < 0.98 || s < 0) {
        const r = lerp(size * 0.2, H * 0.17, merge);
        if (merge > 0.3) { c.fillStyle = '#FFD23A'; c.beginPath(); c.arc(x, eyeY, r, 0, Math.PI * 2); c.fill(); }
        c.fillStyle = merge > 0.3 ? '#F2582C' : PINK; c.beginPath(); c.arc(x, eyeY, merge > 0.3 ? r * 0.6 : r, 0, Math.PI * 2); c.fill();
      }
    }
    // dotted rings round the sun
    if (merge > 0.6) {
      c.fillStyle = `rgba(230,120,60,${0.6 * (1 - toCream)})`;
      for (let k = 0; k < 3; k++) for (let i = 0; i < 48; i++) { const a = (i / 48) * Math.PI * 2 + k * 0.07, R = H * (0.22 + 0.06 * k); c.fillRect(W / 2 + Math.cos(a) * R - 2, eyeY + Math.sin(a) * R - 2, 4, 4); }
    }
    // the sea: bands of ω rising from the bottom (in front of the sun's lower half)
    if (sea > 0) {
      const top = lerp(H * 1.05, H * 0.8, sea) + toCream * H * 0.05;
      c.fillStyle = '#5C8FCC'; c.fillRect(0, top, W, H - top);
      c.font = font(ROUND, 46); c.fillStyle = '#EAF0F8';
      for (let r = 0; r < 5; r++) for (let i = -1; i < 14; i++) c.fillText('ω', ((((i * 150 + (r % 2) * 75 + t * 240 * (r % 2 ? 1 : -1)) % (W + 150)) + W + 150) % (W + 150)) - 50, top + 34 + r * 52);
      c.fillStyle = '#E8EEF6'; for (let i = 0; i < 6; i++) c.fillRect(hash(i, 3) * W, top - 6, 120 + 160 * hash(i, 4), 10);
    }
    c.textAlign = 'left';
    return { riso: 1 - 0.6 * toCream };
  }
}

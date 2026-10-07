// ?ref=rhythm: frame-matched re-creation of the kaomoji.exe rhythm-game section (its 65.5–68.75 s; docs/复刻配方.md):
// a white pixel disc opens from the CRT face, the highway (kit/rhythm.ts) runs under a big kaomoji that throws its arms
// on the beat, the combo climbs exactly as in the reference, a red sun rises, FULL COMBO, the picture tears.
// Local seconds T = f.lt match the reference from 65.5 s. Wording is our own.
import type * as THREE from 'three';
import { Scene, type Frame } from '../engine/scene';
import { Layer2D, W, H } from '../engine/gl';
import { F, font } from '../engine/type';
import { Highway, type Note } from '../kit/rhythm';
import { ease, hash, prog } from '../engine/util';

const INK = '#141414', ORANGE = '#FCB13F', RED = '#E5402D';
// the reference's combo counter, sampled every 0.1 s (reference time -> combo): the notes are placed to match it
const COMBO: [number, number][] = [[65.5, 0], [65.6, 2], [65.7, 3], [65.8, 5], [65.9, 7], [66.0, 10], [66.1, 11], [66.2, 13], [66.3, 14], [66.4, 17], [66.5, 18], [66.6, 19], [66.7, 21], [66.8, 24], [66.9, 25], [67.0, 26], [67.1, 27], [67.2, 30], [67.3, 31], [67.4, 33], [67.5, 35], [67.6, 38], [67.7, 39], [67.8, 42], [67.9, 44], [68.0, 48], [68.1, 50], [68.2, 52], [68.3, 55]];
const FULL = 2.9;

export default class RefRhythm extends Scene {
  layer = new Layer2D();
  disc = document.createElement('canvas');
  hw!: Highway;
  private finalScore = false;

  override init() {
    // notes: the k-th hit lands where the reference's combo reaches k (on a 1/40 s grid)
    const notes: Note[] = [];
    for (let k = 1; k <= 55; k++) {
      const i = COMBO.findIndex(([, c]) => c >= k);
      const [t1, c1] = COMBO[i]!, [t0, c0] = COMBO[i - 1]!;
      const t = Math.round((t0 + ((k - c0 - 0.5) / Math.max(1, c1 - c0)) * (t1 - t0) - 65.5) * 40) / 40;
      const r = hash(k, 7), lane = r < 0.3 ? 0 : r < 0.58 ? 1 : r < 0.82 ? 2 : 3;
      notes.push({ t, lane, dot: lane === 0 && k % 5 === 2 });
    }
    this.hw = new Highway({
      notes, since: 0, markers: [{ t: 9, label: '46 · GUARD v2.0' }],
      env: (t) => 0.5 + 0.4 * Math.sin(t * 7.8) * Math.sin(t * 3.1),
      score: (c) => (this.finalScore ? 255255 : Math.round(c * c * 62 + c * 200)),
    });
    this.disc.width = 96; this.disc.height = 54;
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp } = this.ctx, T = f.lt, c = this.layer.ctx;
    if (T < 0.1) return this.intro(c, T, out);
    this.layer.clear('#F1ECE7');
    this.finalScore = T >= FULL;
    this.hw.o.scoreSub = T < 1.2 ? '[SCAN] probe 1 · dodged' : '[SCAN] incoming';
    // the red sun rising behind the runway's far end
    if (T > 2.62 && T < FULL) {
      const y = -H * 0.1 + H * 0.16 * ease.outCubic(prog(T, 2.62, 2.85));
      c.fillStyle = RED; c.beginPath(); c.arc(W * 0.5, y, H * 0.105, 0, Math.PI * 2); c.fill();
    }
    this.hw.draw(c, T);
    // HUD bits on the runway: the bar counter, the guard's progress
    c.font = font(F.archivo(100, 700), 26); c.fillStyle = RED; c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillText(T < 2.45 ? '43/63' : '44/63', W * 0.236, H * 0.49);
    c.globalAlpha = 0.55; c.font = font(F.mono(500), 15); c.textAlign = 'center';
    c.fillText(`guard updating ${Math.min(99, 41 + Math.floor(T * 4))}%`, W * 0.5, H * 0.985); c.globalAlpha = 1;
    this.face(c, T);
    if (T >= FULL) {
      c.fillStyle = INK; c.font = font(F.archivo(100, 900), 236); c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('FULL COMBO', W * 0.49, H * 0.11);
    }
    comp.draw(renderer, this.layer.upload(), out, { mode: 'replace' });
    const tear = T >= FULL ? (T < FULL + 0.06 ? 0.55 : T > 3.15 ? 1 : 0.12) : 0;
    return { bloom: 0.05, bloomThreshold: 1.5, grain: 0.035, vignette: 0.12, ca: 0.6 + 4 * tear, halation: 0, glitch: tear * 0.7, glitchSeed: 7, radial: T < 0.17 ? 0.35 * (1 - prog(T, 0.1, 0.17)) : 0 };
  }

  /** The kaomoji over the runway: brackets, eyes, an orange ω, arms by pose, a white halo behind. */
  private face(c: CanvasRenderingContext2D, T: number) {
    const cx = W * 0.5, cy = H * 0.49, beat = Math.floor((T - 0.1) / 0.4), bp = ((T - 0.1) / 0.4) % 1;
    const s = 1 + 0.03 * Math.exp(-bp * 6);
    c.save(); c.translate(cx, cy); c.scale(1, 0.62);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, W * 0.16);
    g.addColorStop(0, 'rgba(250,248,245,1)'); g.addColorStop(0.7, 'rgba(250,248,245,0.92)'); g.addColorStop(1, 'rgba(250,248,245,0)');
    c.fillStyle = g; c.fillRect(-W * 0.17, -W * 0.17, W * 0.34, W * 0.34); c.restore();
    c.save(); c.translate(cx, cy); c.scale(s, s); c.translate(-cx, -cy);
    c.fillStyle = INK; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = font(F.archivo(87.5, 700), 350);
    c.fillText('(', W * 0.37, cy); c.fillText(')', W * 0.63, cy);
    for (const x of [W * 0.424, W * 0.576]) { c.beginPath(); c.arc(x, cy + 4, 34, 0, Math.PI * 2); c.fill(); }
    c.font = font(F.archivo(100, 900), 255); c.lineJoin = 'round'; c.lineWidth = 6; c.strokeStyle = INK; c.strokeText('ω', cx, cy - 6);
    c.fillStyle = ORANGE; c.fillText('ω', cx, cy - 6);
    if (T >= 2.45 && T < FULL) { c.fillStyle = INK; c.font = font(F.archivo(100, 800), 120); c.fillText(';', W * 0.607, cy + 6); }
    // arms by pose: raised ヽ ノ, square └ ┐, flat — —, cheering at FULL COMBO
    const pose = T < 0.5 ? 0 : T < 1.35 ? 1 : T < 1.65 ? 2 : T < 2.05 ? 0 : T < 2.45 ? 1 : T < FULL ? 3 : 4;
    const wave = pose === 1 && beat % 2 === 1 ? 0.025 : 0;
    c.strokeStyle = INK; c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = 24;
    const L = (pts: [number, number][]) => { c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x * W, y * H) : c.moveTo(x * W, y * H))); c.stroke(); };
    if (pose === 1) { L([[0.288, 0.375 - wave], [0.333, 0.455]]); L([[0.722, 0.36 - wave], [0.7, 0.41 - wave * 0.5], [0.666, 0.46]]); }
    if (pose === 2) { L([[0.322, 0.4], [0.322, 0.485], [0.352, 0.485]]); L([[0.64, 0.41], [0.684, 0.41], [0.684, 0.485]]); }
    if (pose === 3) { L([[0.29, 0.47], [0.335, 0.47]]); L([[0.665, 0.47], [0.71, 0.47]]); }
    if (pose === 4) { c.lineWidth = 12; L([[0.31, 0.39], [0.36, 0.49]]); L([[0.69, 0.39], [0.64, 0.49]]); }
    c.restore();
  }

  /** The opening: a white pixel disc with a tiny pixel face grows out of the dark. */
  private intro(c: CanvasRenderingContext2D, T: number, out: THREE.WebGLRenderTarget) {
    const d = this.disc.getContext('2d')!, r = 23 + 10 * ease.inCubic(T / 0.1);
    d.fillStyle = '#0B0E0D'; d.fillRect(0, 0, 96, 54);
    d.fillStyle = '#F4F2EE'; d.beginPath(); d.arc(48, 23, r, 0, Math.PI * 2); d.fill();
    d.fillStyle = INK; d.fillRect(36, 21, 2, 5); d.fillRect(58, 21, 2, 5); d.fillRect(41, 22, 2, 2); d.fillRect(53, 22, 2, 2);
    d.fillStyle = ORANGE; d.fillRect(45, 21, 6, 4);
    this.layer.clear('#0B0E0D');
    c.imageSmoothingEnabled = false; c.drawImage(this.disc, 0, 0, W, H); c.imageSmoothingEnabled = true;
    this.ctx.comp.draw(this.ctx.renderer, this.layer.upload(), out, { mode: 'replace' });
    return { bloom: 0.3, grain: 0.03, vignette: 0.3, crt: 0.6, crtCurve: 0.1, ca: 1.5 };
  }
}

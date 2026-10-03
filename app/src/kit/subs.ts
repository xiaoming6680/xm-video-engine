// Subtitles and credits (from Still_Shining v8): the sung line with its translation (Line.zh) under it,
// fixed in the lower third (`y`; in a vertical frame keep clear of Douyin's right-hand buttons and bottom caption); the words light up as they are
// sung (unsung words dim); lines ease in and out. Credits in the intro: thin, wide-tracked, in the sky.
// One Canvas2D layer, redrawn only when what it shows changes (a quantised state key).
import { Layer2D, W, H } from '../engine/gl';
import { font } from '../engine/type';
import type { Lyrics, Line } from '../engine/lyrics';
import { clamp, ease, prog } from '../engine/util';

const EN = 'Archivo-750-700';
const ZHF = 'NotoSansSC-500';

export interface Credit { text: string; x: number; y: number; size: number; family: string; a: number; tracking: number; align?: CanvasTextAlign }

export class Subs {
  layer = new Layer2D();
  private key = '';
  /** Vertical centre of the English line (logical px); the Chinese sits under it. */
  y = Math.round(H * 0.69);
  constructor(private lyrics: Lyrics) {}

  /**
   * Draw the state at song time t. `show`: overall opacity (0 hides the subtitles, e.g. while a title fills the
   * frame); `credits`: extra text.
   */
  draw(t: number, show: number, credits: Credit[] = []) {
    const L = this.lyrics;
    // the line on screen: from 0.12 s before its first word to 0.25 s after its end (or until the next line)
    let line: Line | null = null, a = 0;
    for (const l of L.lines) {
      const next = L.lines[l.i + 1];
      const t0 = l.words[0]!.start - 0.12, t1 = Math.min(l.end + 0.35, next ? next.words[0]!.start - 0.12 : l.end + 0.35);
      if (t >= t0 && t < t1) { line = l; a = Math.min(prog(t, t0, t0 + 0.12, ease.outCubic), 1 - prog(t, t1 - 0.18, t1, ease.inQuad)); break; }
    }
    a *= clamp(show);
    // state key: line, words lit (quantised progress), opacity steps, credits
    const lit = line ? line.words.map((w) => Math.round(clamp((t - w.start) / 0.09) * 4)).join('') : '';
    const k = `${line?.i ?? -1}|${lit}|${Math.round(a * 40)}|${credits.map((c) => `${c.text}${Math.round(c.a * 40)}${c.y.toFixed(0)}`).join(',')}`;
    if (k === this.key) return this.layer.texture;
    this.key = k;
    const c = this.layer.ctx;
    this.layer.clear();
    if (line && a > 0.002) {
      const rise = (1 - a) * 10;
      // a soft dark scrim under the two lines (reads over a bright sky or a sparkling city)
      c.save();
      c.globalAlpha = a * 0.5;
      c.translate(W / 2, this.y + 30 + rise);
      c.scale(1, 0.2);
      const g = c.createRadialGradient(0, 0, 0, 0, 0, 520);
      g.addColorStop(0, 'rgba(3, 10, 34, 0.75)');
      g.addColorStop(0.55, 'rgba(3, 10, 34, 0.45)');
      g.addColorStop(1, 'rgba(3, 10, 34, 0)');
      c.fillStyle = g;
      c.fillRect(-W / 2, -520, W, 1040);
      c.restore();
      c.save();
      c.textBaseline = 'middle';
      c.shadowColor = 'rgba(2, 10, 40, 0.55)';
      c.shadowBlur = 14;
      // English, word by word (sung words full white, the rest dim)
      c.font = font(EN, 44);
      (c as any).letterSpacing = '0.5px';
      const words = line.words;
      const sp = c.measureText(' ').width;
      const ws = words.map((w) => c.measureText(w.w).width);
      let total = ws.reduce((s, v) => s + v, 0) + sp * (words.length - 1);
      const maxW = 840;
      const scale = total > maxW ? maxW / total : 1;
      total *= scale;
      let x = W / 2 - total / 2;
      c.save();
      c.translate(0, this.y + rise);
      c.scale(scale, 1);
      x /= scale;
      words.forEach((w, i) => {
        const p = clamp((t - w.start + 0.04) / 0.09);
        c.globalAlpha = a * (0.42 + 0.58 * p);
        c.fillStyle = '#f4f7ff';
        c.fillText(w.w, x, 0);
        x += ws[i]! + sp;
      });
      c.restore();
      // Chinese, whole line (it is a translation: it does not follow the words)
      if (line.zh) {
        c.font = font(ZHF, 36);
        (c as any).letterSpacing = '2px';
        c.textAlign = 'center';
        c.globalAlpha = a * 0.92;
        c.fillStyle = '#e9efff';
        const zw = c.measureText(line.zh).width, zs = Math.min(1, 840 / zw);
        c.save();
        c.translate(W / 2, this.y + 60 + rise);
        c.scale(zs, zs);
        c.fillText(line.zh, 0, 0);
        c.restore();
        c.textAlign = 'left';
      }
      c.restore();
    }
    for (const cr of credits) {
      if (cr.a <= 0.002) continue;
      c.save();
      c.textBaseline = 'middle';
      c.textAlign = cr.align ?? 'center';
      c.font = font(cr.family, cr.size);
      (c as any).letterSpacing = `${cr.tracking}px`;
      c.globalAlpha = clamp(cr.a);
      c.shadowColor = 'rgba(2, 10, 40, 0.45)';
      c.shadowBlur = 10;
      c.fillStyle = '#f2f6ff';
      c.fillText(cr.text, cr.x, cr.y);
      c.restore();
    }
    return this.layer.upload();
  }
}

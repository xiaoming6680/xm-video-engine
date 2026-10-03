// Subtitles and credits (from Still_Shining v8–v10): the sung line with its translation (Line.zh) under it, fixed in
// the lower third (`y`; in a vertical frame keep clear of Douyin's right-hand buttons and bottom caption); the words
// light up as they are sung (unsung words dim); a line switches in on its first word's onset, never ahead of the voice.
// Credits: thin, wide-tracked, in the sky. Canvas2D layers, redrawn only when what they show changes (a state key).
// Two inks of the same lines (white with a dark scrim / deep navy with a light halo): SubsComposite measures how
// bright the frame is behind the lines, on the GPU, and crossfades between them (Still_Shining v10: white text over
// white clouds did not read). Usage:
//   const ink = subs.draw(t, show, credits);                    // { light, dark } textures
//   comp.draw(renderer, out.texture, copyRT, { mode: 'replace' }); // the frame so far, to measure (a copy: `out` is the target)
//   subsComp.render(renderer, copyRT.texture, ink, out, subs.y);
import * as THREE from 'three';
import { FSPass, Layer2D, W, H } from '../engine/gl';
import { font } from '../engine/type';
import type { Lyrics, Line } from '../engine/lyrics';
import { clamp, ease, prog } from '../engine/util';

const EN = 'Archivo-750-700';
const ZHF = 'NotoSansSC-500';

export interface Credit { text: string; x: number; y: number; size: number; family: string; a: number; tracking: number; align?: CanvasTextAlign }

export class Subs {
  /** Two inks of the same lines: white over dark frames, deep navy over bright ones (SubsComposite picks per frame). */
  layer = new Layer2D();
  dark = new Layer2D();
  private key = '';
  /** Vertical centre of the English line (logical px); the Chinese sits under it. */
  y = Math.round(H * 0.69);
  constructor(private lyrics: Lyrics) {}

  /**
   * Draw the state at song time t into both inks. `show`: overall opacity (0 hides the subtitles, e.g. while a title
   * fills the frame); `credits`: extra text (always white: they sit in the sky).
   */
  draw(t: number, show: number, credits: Credit[] = []) {
    const L = this.lyrics;
    // the line on screen: it switches in on its first word's onset (a two-frame fade) and holds until the next line's
    // onset or 0.35 s after it ends, so every change of subtitle lands on the voice
    let line: Line | null = null, a = 0;
    for (const l of L.lines) {
      const next = L.lines[l.i + 1];
      const t0 = l.words[0]!.start - 0.03, t1 = Math.min(l.end + 0.35, next ? next.words[0]!.start - 0.03 : l.end + 0.35);
      if (t >= t0 && t < t1) { line = l; a = Math.min(prog(t, t0, t0 + 0.05, ease.outCubic), 1 - prog(t, t1 - (next && t1 < l.end + 0.35 ? 0.04 : 0.2), t1, ease.inQuad)); break; }
    }
    a *= clamp(show);
    // state key: line, words lit (quantised progress), opacity steps, credits
    const lit = line ? line.words.map((w) => Math.round(clamp((t - w.start + 0.01) / 0.06) * 4)).join('') : '';
    const k = `${line?.i ?? -1}|${lit}|${Math.round(a * 40)}|${credits.map((c) => `${c.text}${Math.round(c.a * 40)}${c.y.toFixed(0)}`).join(',')}`;
    if (k === this.key) return { light: this.layer.texture, dark: this.dark.texture };
    this.key = k;
    this.paint(this.layer, false, t, line, a, credits);
    this.paint(this.dark, true, t, line, a, credits);
    return { light: this.layer.upload(), dark: this.dark.upload() };
  }

  private paint(layer: Layer2D, darkInk: boolean, t: number, line: Line | null, a: number, credits: Credit[]) {
    const c = layer.ctx;
    layer.clear();
    if (line && a > 0.002) {
      const rise = (1 - a) * 10;
      // white ink: a soft dark scrim under the two lines (reads over a bright sky or a sparkling city); navy ink (over
      // white clouds): no scrim, a faint light halo instead
      if (!darkInk) {
        c.save();
        c.globalAlpha = a * 0.5;
        c.translate(W / 2, this.y + 30 + rise);
        c.scale(1, 0.2);
        const g = c.createRadialGradient(0, 0, 0, 0, 0, 520);
        g.addColorStop(0, 'rgba(3, 10, 34, 0.75)');
        g.addColorStop(0.55, 'rgba(3, 10, 34, 0.45)');
        g.addColorStop(1, 'rgba(3, 10, 34, 0)');
        c.fillStyle = g;
        c.fillRect(-540, -520, 1080, 1040);
        c.restore();
      }
      c.save();
      c.textBaseline = 'middle';
      c.shadowColor = darkInk ? 'rgba(255, 255, 255, 0.5)' : 'rgba(2, 10, 40, 0.55)';
      c.shadowBlur = 14;
      // English, word by word (sung words full ink, the rest dim)
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
        const p = clamp((t - w.start + 0.01) / 0.06);
        c.globalAlpha = a * (0.42 + 0.58 * p);
        c.fillStyle = darkInk ? '#0a1846' : '#f4f7ff';
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
        c.fillStyle = darkInk ? '#102054' : '#e9efff';
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
  }
}

/**
 * Lays the subtitles over the frame in the ink the frame needs (v10: over the cloud sea white text did not read):
 * the brightness of the strip behind the lines is measured on the GPU from the frame itself (no read-back, the same
 * for every sub-frame order), and the white and navy inks are crossfaded by it.
 */
export class SubsComposite {
  private avg = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
  private measure = new FSPass(/* glsl */ `
    uniform sampler2D src; uniform vec2 band;   // the strip's vertical range in uv (y up)
    void main() {
      float s = 0.0;
      for (int j = 0; j < 8; j++) for (int i = 0; i < 24; i++) {
        vec2 uv = vec2(0.12 + 0.76 * (float(i) + 0.5) / 24.0, mix(band.x, band.y, (float(j) + 0.5) / 8.0));
        s += min(luma(texture(src, uv).rgb), 2.0);
      }
      fragColor = vec4(s / 192.0, 0.0, 0.0, 1.0);
    }`, { src: { value: null }, band: { value: new THREE.Vector2() } });
  private pass = new FSPass(/* glsl */ `
    uniform sampler2D light, dark, avg;
    void main() {
      float k = smoothstep(0.34, 0.62, texture(avg, vec2(0.5)).r);
      vec4 c = mix(texture(light, vUv), texture(dark, vUv), k);
      fragColor = vec4(c.rgb * c.a, c.a);
    }`, { light: { value: null }, dark: { value: null }, avg: { value: null } }, { blending: THREE.CustomBlending, transparent: true });
  constructor() {
    const m = this.pass.mat;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
    m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  }
  /** `frame`: the picture so far (read); `out`: where the subtitles go (may be the same target's texture's owner). */
  render(renderer: THREE.WebGLRenderer, frame: THREE.Texture, ink: { light: THREE.Texture; dark: THREE.Texture }, out: THREE.WebGLRenderTarget, y: number) {
    const mu = this.measure.u;
    mu.src!.value = frame;
    // the strip around the two lines (logical px y down -> uv y up)
    (mu.band!.value as THREE.Vector2).set(1 - (y + 95) / H, 1 - (y - 35) / H);
    this.measure.render(renderer, this.avg);
    const u = this.pass.u;
    u.light!.value = ink.light; u.dark!.value = ink.dark; u.avg!.value = this.avg.texture;
    this.pass.render(renderer, out);
  }
}

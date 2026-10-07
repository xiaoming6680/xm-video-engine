// The HUD layer drawn over every frame (before grain/vignette). The corner credit is OFF by default (post.watermark
// = 0): the user wants the credit inside the scenes, never a standing watermark (docs/TREATMENT.md, 署名).
import { Layer2D, W } from './gl';
import { F, font } from './type';

import { CREDIT } from '../config';
export { CREDIT };

export interface HudState {
  /** Overall HUD opacity (post.hud). */
  opacity: number;
  /** Standing credit opacity 0..1 (post.watermark); 0 while the ending shows the full credit. */
  watermark: number;
  /** 0..1: the frame behind is light, so the credit switches to dark ink. */
  paper: number;
  /** The animatic slate (?animatic, Engine.slateAt): bar "06/63", a line with shot id, section and time, beat 0..3. */
  slate?: { bar: string; line: string; beat: number } | null;
}

export class Hud {
  private layer = new Layer2D();

  draw(_t: number, st: HudState) {
    const c = this.layer.ctx;
    this.layer.clear();
    const a = st.opacity * st.watermark;
    if (a > 0.001) {
      c.save();
      c.font = font(F.mono(500), 17);
      c.textBaseline = 'alphabetic';
      c.textAlign = 'right';
      // light text with a soft dark halo reads on any frame; on paper frames the ink version
      const ink = st.paper > 0.5;
      c.shadowColor = ink ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.55)';
      c.shadowBlur = 6;
      c.fillStyle = ink ? `rgba(20,20,22,${0.55 * a})` : `rgba(238,233,223,${0.42 * a})`;
      c.letterSpacing = '2px';
      c.fillText(CREDIT, W - 40, 52);
      c.restore();
    }
    if (st.slate) {
      // the review slate of the animatic: big enough to read on a phone, in the top-left corner
      const s = st.slate;
      c.save();
      c.font = font(F.mono(700), 46);
      const bw = Math.max(c.measureText(s.bar).width, 0) + 36;
      c.font = font(F.mono(500), 20);
      const lw = c.measureText(s.line).width + 36;
      const w = Math.max(bw + 170, lw);
      c.fillStyle = 'rgba(0,0,0,0.82)'; c.fillRect(24, 24, w, 104);
      c.fillStyle = '#FFFFFF'; c.textBaseline = 'alphabetic';
      c.font = font(F.mono(700), 46); c.fillText(s.bar, 42, 76);
      for (let i = 0; i < 4; i++) { c.fillStyle = i === s.beat ? (i === 0 ? '#FF5A3C' : '#FFFFFF') : 'rgba(255,255,255,0.22)'; c.fillRect(42 + bw + i * 34, 48, 24, 24); }
      c.font = font(F.mono(500), 20); c.fillStyle = 'rgba(255,255,255,0.85)'; c.fillText(s.line, 42, 112);
      c.restore();
    }
    return this.layer.upload();
  }
}

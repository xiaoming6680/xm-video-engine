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
    return this.layer.upload();
  }
}

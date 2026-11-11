// AE 式缓动示例（?ease）：四种缓动同一段距离、同样 0.8 秒，并排比较；每行底下的点是每 1/30 秒的位置（动画的
// 「间距图」：点挤在一起 = 慢，拉开 = 快）。第 2、3 行是 kfe 可拖轨道：预览里按 G 打开曲线编辑器直接拖。
// 用来看缓动的区别，不是画面标准。
import type * as THREE from 'three';
import { Scene, type Frame } from '../../engine/scene';
import { Layer2D, W, H } from '../../engine/gl';
import { F, font } from '../../engine/type';
import { kf, K, type Key } from '../../engine/anim';
import { kfe } from '../../engine/tracks';

const BG = '#111214', INK = '#ece9e2', DIM = '#7d8088', HOT = '#ff7a3c';
const X0 = W * 0.26, X1 = W * 0.86, T0 = 0.3, T1 = 1.1, LOOP = 2.2;

export default class DemoEase extends Scene {
  layer = new Layer2D();

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const c = this.layer.ctx;
    this.layer.clear(BG);
    const lt = f.lt % LOOP;
    const rows: { label: string; note: string; x: (t: number) => number }[] = [
      { label: 'smooth (auto)', note: "kf(t, [[t0, a], [t1, b]])", x: (t) => kf(t, [[T0, X0], [T1, X1]]) },
      { label: 'go -> land', note: 'K.go, K.land   (kfe: drag me, G)', x: (t) => kfe(t, 'go-land.x', [[T0, X0, K.go], [T1, X1, K.land]]) },
      { label: 'windup -> slam', note: 'K.windup, K.slam   (kfe)', x: (t) => kfe(t, 'windup-slam.x', [[T0, X0, K.windup], [T1, X1, K.slam]]) },
      { label: 'easy ease (F9)', note: 'K.easy', x: (t) => kf(t, [[T0, X0, K.easy], [T1, X1, K.easy]] as Key<number>[]) },
    ];
    c.fillStyle = INK; c.font = font(F.sans(700), 30);
    c.fillText('Same distance, same 0.8 s: only the ease differs', W * 0.05, H * 0.09);
    c.fillStyle = DIM; c.font = font(F.sans(400), 19);
    c.fillText('dots = position every 1/30 s (spacing chart): close together = slow, far apart = fast', W * 0.05, H * 0.135);
    rows.forEach((r, i) => {
      const y = H * (0.27 + 0.2 * i);
      c.fillStyle = INK; c.font = font(F.sans(700), 24); c.fillText(r.label, W * 0.05, y - 6);
      c.fillStyle = DIM; c.font = font(F.mono(400), 15); c.fillText(r.note, W * 0.05, y + 22);
      // spacing chart: where the dot is on every 30 fps frame of the move
      for (let k = 0; k <= Math.round((T1 - T0) * 30); k++) {
        const x = r.x(T0 + k / 30);
        c.fillStyle = 'rgba(236,233,226,0.35)'; c.beginPath(); c.arc(x, y + 52, 3.2, 0, Math.PI * 2); c.fill();
      }
      c.strokeStyle = '#2a2d33'; c.lineWidth = 2; c.beginPath(); c.moveTo(X0, y); c.lineTo(X1, y); c.stroke();
      c.fillStyle = i === 1 || i === 2 ? HOT : INK;
      c.beginPath(); c.arc(r.x(lt), y, 22, 0, Math.PI * 2); c.fill();
    });
    this.ctx.comp.draw(this.ctx.renderer, this.layer.upload(), out, { mode: 'replace' });
  }
}

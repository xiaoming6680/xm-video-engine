// 示例场景：演示引擎的基本用法，新项目可以删掉。
//   * 全屏着色器背景（FSPass，调色板常量 C_INK / C_SIGNAL，底鼓脉冲 f.a.kick）
//   * Canvas2D 文字（F.archivo 等宽字距、中文自动回落到思源黑体）
//   * 逐词歌词（Lyrics.wordProgress：唱到哪个词亮到哪个词）
//   * 跟着小节落下的方块，并把每次落地登记成 cue（render.ts cues + tools/qa/cuecheck.py 核对卡点）
// 输出必须只取决于 f.t（确定性）：导出时每帧会按任意顺序渲染多个子帧做运动模糊。
import type * as THREE from 'three';
import { Scene, type Cue, type Frame } from '../engine/scene';
import { FSPass, Layer2D, W, H } from '../engine/gl';
import { F, font } from '../engine/type';
import { rgba } from '../engine/palette';
import { Lyrics } from '../engine/lyrics';
import { clamp, ease } from '../engine/util';

export default class Demo extends Scene {
  bg = new FSPass(/* glsl */ `
    uniform float t, kick, inv;
    void main() {
      vec2 p = (vUv - 0.5) * vec2(${(W / H).toFixed(4)}, 1.0);
      float v = 1.0 - smoothstep(0.1, 0.9, length(p));
      vec3 col = mix(C_INK, C_INK2, v) + C_SIGNAL * 0.06 * kick * v;
      fragColor = vec4(mix(col, C_BONE * 0.9, inv), 1.0);
    }`, { t: { value: 0 }, kick: { value: 0 }, inv: { value: 0 } });
  text = new Layer2D();

  /** Downbeat times inside this entry's window: the block lands on each. */
  private landings() {
    return this.ctx.audio.downbeats.filter((t) => t >= this.ctx.start && t < this.ctx.end);
  }

  override cues(): Cue[] {
    return this.landings().map((t, i) => ({ t, name: `block lands #${i + 1}`, on: 'downbeat' }));
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp, lyrics, params } = this.ctx;
    const inv = params.inverted ? 1 : 0;
    const u = this.bg.u;
    u.t!.value = f.t; u.kick!.value = f.a.kick; u.inv!.value = inv;
    this.bg.render(renderer, out);

    const c = this.text.ctx;
    this.text.clear();
    const ink = inv ? 'ink' : 'bone';

    // title: width animates with the bar phase (Archivo comes in width steps 62–125)
    c.fillStyle = rgba(ink);
    c.font = font(F.archivo(75 + 50 * ease.outCubic(f.barPhase), 900), Math.round(Math.min(H * 0.11, W * 0.05)));
    c.fillText('XM ENGINE 基础引擎', W * 0.07, H * 0.3);
    c.font = font(F.mono(400), Math.round(H * 0.022));
    c.fillStyle = rgba('ash');
    c.fillText(`t ${f.t.toFixed(2)}s   bar ${f.bar.toFixed(2)}   ${this.ctx.audio.bpmAt(f.t).toFixed(0)} BPM   [${this.ctx.id}]`, W * 0.07, H * 0.36);

    // the block: falls during each bar, lands on the downbeat (overshoot + settle after the landing)
    const ls = this.landings();
    const next = ls.find((t) => t > f.t), prev = [...ls].reverse().find((t) => t <= f.t);
    const s = H * 0.09, x = W * 0.75, ground = H * 0.62;
    let y = ground;
    if (next !== undefined) {
      const bar = 4 * this.ctx.audio.periodAt(next);
      const p = clamp(1 - (next - f.t) / bar);
      y = ground - (1 - ease.inQuad(p)) * H * 0.4;
    }
    const since = prev !== undefined ? f.t - prev : 9;
    const squash = Math.exp(-since * 9) * 0.35; // landing squash, decays
    c.fillStyle = rgba('signal');
    c.fillRect(x - (s * (1 + squash)) / 2, y - s * (1 - squash), s * (1 + squash), s * (1 - squash));
    c.fillStyle = rgba('graphite');
    c.fillRect(W * 0.6, ground, W * 0.3, 2);

    // karaoke: the current line, each word lit as it is sung (none without data/lyrics.json)
    const line = lyrics.lineAt(f.t) ?? lyrics.lastLine(f.t);
    if (line && f.t < line.end + 1.5) {
      c.font = font(F.archivo(100, 700), Math.round(Math.min(H * 0.05, W * 0.03)));
      let lx = W * 0.07;
      for (const w of line.words) {
        const p = Lyrics.wordProgress(w, f.t);
        c.fillStyle = p > 0 ? rgba('signal') : rgba(ink, 0.35);
        c.fillText(w.w, lx, H * 0.78);
        lx += c.measureText(w.w + ' ').width;
      }
    }
    comp.draw(renderer, this.text.upload(), out);
    return { bloom: 0.5 };
  }
}

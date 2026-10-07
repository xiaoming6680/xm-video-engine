// Beat-check film (docs/新项目流程.md step 1): the song over a black frame that shows what the analysis thinks the
// music is doing, so the user can confirm the bars, the sections and the drops by ear before anything is designed.
//   bun scripts/render.ts beatcheck        (or the preview at /?beatcheck)
// Shows: the bar number and the four beats of the bar; the section strip of the whole song with the playhead; a
// scrolling roll of the sound events (data/events.json) and the onsets, with a now-line; the envelopes; lyric lines
// as numbered spans with word ticks (line numbers only, never the text: lyrics stay out of everything we look at).
import type * as THREE from 'three';
import { Scene, type Frame } from './scene';
import { Layer2D, W, H } from './gl';
import { F, font } from './type';
import { clamp } from './util';

const COLS: Record<string, string> = {
  kick: '#FF5A3C', snare: '#FFC23C', clap: '#FFE07A', hat: '#5BD6A0', perc: '#3EC1D3', crash: '#C9A7FF', riser: '#9B7BEA',
  fx_hit: '#FF8AD8', bass_in: '#5B8CFF', bass_out: '#3A5BB0', stop: '#FFFFFF', chop: '#FF9E9E', vocal: '#F3E9D2',
};
const SEC = ['#2B6CB0', '#9B4DCA', '#D9480F', '#2F9E44', '#C2255C', '#1098AD', '#E67700', '#5F3DC4'];

export default class BeatCheck extends Scene {
  layer = new Layer2D();
  private types: string[] = [];

  override init() {
    const ev = this.ctx.audio.ev;
    this.types = [...new Set(ev.all.map((e) => e.type))].sort((a, b) => Object.keys(COLS).indexOf(a) - Object.keys(COLS).indexOf(b));
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const { audio, lyrics, comp, renderer } = this.ctx, c = this.layer.ctx, t = f.t, dur = audio.duration;
    this.layer.clear('#0B0B0D');
    const bars = Math.max(1, Math.round(audio.barAt(dur)));
    const bar = Math.floor(f.bar), beatIn = Math.floor(f.barPhase * 4 + 1e-6);
    const sec = audio.section(t);
    // ---- bar number and beats ----
    c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    c.font = font(F.archivo(100, 900), 190); c.fillStyle = '#F3EFE6';
    c.fillText(`${String(bar + 1).padStart(2, '0')}`, W * 0.3, H * 0.36);
    c.font = font(F.mono(500), 34); c.fillStyle = 'rgba(243,239,230,0.55)';
    c.fillText(`/ ${bars} 小节`, W * 0.3, H * 0.42);
    for (let i = 0; i < 4; i++) {
      const on = i === beatIn, pulse = on ? Math.exp(-f.beatPhase * 5) : 0;
      c.fillStyle = on ? (i === 0 ? '#FF5A3C' : '#F3EFE6') : 'rgba(243,239,230,0.14)';
      const s = 46 + 16 * pulse;
      c.fillRect(W * 0.3 - 150 + i * 100 - s / 2, H * 0.5 - s / 2, s, s);
    }
    c.textAlign = 'left'; c.font = font(F.mono(500), 26); c.fillStyle = '#F3EFE6';
    c.fillText(`${t.toFixed(2)} s   ${audio.bpmAt(t).toFixed(1)} BPM   ${sec?.name ?? ''}`, W * 0.56, H * 0.2);
    c.font = font(F.mono(400), 20); c.fillStyle = 'rgba(243,239,230,0.6)';
    c.fillText('听：数字跳在每个强拍上吗？段落名和你听到的一致吗？drop 在哪个小节？', W * 0.56, H * 0.25);
    // ---- envelopes (the last 3 s) ----
    const ex = W * 0.56, ew = W * 0.4, ey = H * 0.42;
    for (const [name, col] of [['rms', '#F3EFE6'], ['low', '#FF5A3C'], ['vocal', '#5BD6A0']] as const) {
      c.strokeStyle = col; c.lineWidth = 2; c.beginPath();
      for (let i = 0; i <= 120; i++) { const tt = t - 3 + (3 * i) / 120, v = audio.env(name, tt); const x = ex + (ew * i) / 120, y = ey - v * 110; i ? c.lineTo(x, y) : c.moveTo(x, y); }
      c.stroke();
      c.fillStyle = col; c.font = font(F.mono(500), 16); c.fillText(name, ex + ew + 10, ey - audio.env(name, t) * 110);
    }
    // ---- event roll: -1.5 s .. +3 s, now at a third ----
    const rx = 140, rw = W - 200, ry = H * 0.56, rowH = 30, t0 = t - 1.5, span = 4.5;
    const X = (tt: number) => rx + ((tt - t0) / span) * rw;
    const rows = [...this.types, 'lyrics'];
    c.font = font(F.mono(500), 16); c.textAlign = 'right'; c.textBaseline = 'middle';
    rows.forEach((type, i) => {
      const y = ry + i * rowH;
      c.fillStyle = 'rgba(255,255,255,0.04)'; c.fillRect(rx, y - rowH / 2 + 2, rw, rowH - 4);
      c.fillStyle = COLS[type] ?? '#AAA'; c.fillText(type, rx - 12, y);
      c.save(); c.beginPath(); c.rect(rx, y - rowH / 2, rw, rowH); c.clip();
      if (type === 'lyrics') {
        for (const l of lyrics.lines) {
          if (l.end < t0 || l.start > t0 + span) continue;
          c.fillStyle = 'rgba(243,233,210,0.18)'; c.fillRect(X(l.start), y - 10, X(l.end) - X(l.start), 20);
          c.fillStyle = '#F3E9D2'; c.textAlign = 'left'; c.fillText(`第 ${l.i + 1} 行`, X(l.start) + 4, y); c.textAlign = 'right';
          for (const w of l.words) c.fillRect(X(w.start), y + 6, 2, 6);
        }
        c.restore();
        return;
      }
      for (const e of audio.ev.in(t0, t0 + span, type)) {
        const x = X(e.t), hit = Math.abs(e.t - t) < 0.06;
        c.fillStyle = COLS[type] ?? '#AAA'; c.globalAlpha = 0.35 + 0.65 * clamp(e.s);
        c.fillRect(x - (hit ? 4 : 2), y - (hit ? 12 : 9), hit ? 8 : 4, hit ? 24 : 18);
        if (e.end) c.fillRect(x, y - 2, X(e.end) - x, 4);
        c.globalAlpha = 1;
      }
      c.restore();
    });
    // beat grid and the now-line over the roll
    const rollH = rows.length * rowH;
    for (let b = Math.ceil(audio.beatAt(t0)); audio.timeOfBeat(b) < t0 + span; b++) {
      const x = X(audio.timeOfBeat(b)), down = b % 4 === 0;
      c.fillStyle = down ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)';
      c.fillRect(x, ry - rowH / 2 - (down ? 14 : 0), down ? 2 : 1, rollH + (down ? 14 : 0));
      if (down) { c.textAlign = 'center'; c.fillStyle = 'rgba(255,255,255,0.6)'; c.fillText(String(Math.round(audio.barAt(audio.timeOfBeat(b))) + 1), x, ry - rowH / 2 - 24); }
    }
    c.fillStyle = '#FF5A3C'; c.fillRect(X(t) - 1.5, ry - rowH / 2 - 8, 3, rollH + 16);
    // ---- section strip of the whole song ----
    const sy = H - 70, sx = 140, sw = W - 200;
    audio.sections.forEach((s, i) => {
      const x0 = sx + (s.start / dur) * sw, x1 = sx + (s.end / dur) * sw;
      c.fillStyle = SEC[i % SEC.length]!; c.globalAlpha = s === sec ? 1 : 0.55; c.fillRect(x0, sy, x1 - x0 - 2, 34); c.globalAlpha = 1;
      c.fillStyle = '#FFFFFF'; c.textAlign = 'left'; c.font = font(F.mono(600), 15);
      if (x1 - x0 > 50) c.fillText(s.name, x0 + 6, sy + 17);
    });
    for (const d of audio.downbeats) { const x = sx + (d / dur) * sw; c.fillStyle = 'rgba(255,255,255,0.25)'; c.fillRect(x, sy + 36, 1, 8); }
    c.fillStyle = '#FFFFFF'; c.fillRect(sx + (t / dur) * sw - 2, sy - 8, 4, 54);
    comp.draw(renderer, this.layer.upload(), out, { mode: 'replace' });
    return { bloom: 0, grain: 0, vignette: 0, ca: 0, halation: 0 };
  }
}

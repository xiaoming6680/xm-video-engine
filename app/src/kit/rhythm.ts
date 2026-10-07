// Rhythm-game highway, frame-matched to the kaomoji.exe FULL COMBO section (docs/复刻配方.md, ?ref=rhythm):
//   * a perspective runway on paper toward a vanishing point; its surface is rows of waveform ridges (Joy Division
//     style) that scroll toward the viewer, each row hiding the ones behind it, one row red; a red end block far away
//   * lanes with labels under the hit line; notes come from the song's sound events (notesFromEvents) or a list:
//     'plate' notes are black plates with a white kaomoji, 'box' notes small squares, 'kana' notes black squares
//     with a white kana, 'dot' notes red discs
//   * on a hit: a big plate (plate lanes) or a red bar with the kana (bar lanes) at the hit line, PERFECT under the
//     lane label; SCORE at the top, a huge pale combo number top right, markers far down the runway
// Everything is a pure function of t. Usage (scene, Canvas2D layer):
//   const hw = new Highway({ lanes: DEFAULT_LANES, notes: notesFromEvents(this.ctx.audio, …) }); hw.draw(ctx2d, f.t)
import type { AudioData } from '../engine/audio';
import { F, font } from '../engine/type';
import { clamp, ease, hash } from '../engine/util';
import { W, H } from '../engine/gl';

type Ctx = CanvasRenderingContext2D;

export interface Lane {
  label: string;
  /** Lane edges at the hit line (0..1 of the frame width) — lanes need not touch (the reference leaves the middle free). */
  x0: number; x1: number;
  /** Where the label sits (0..1 of the width). */
  labelX: number;
  kind: 'plate' | 'box' | 'kana';
}
export interface Note { t: number; lane: number; label?: string; dot?: boolean }

export const DEFAULT_LANES: Lane[] = [
  { label: 'KICK', x0: 0.02, x1: 0.2, labelX: 0.067, kind: 'plate' },
  { label: 'CLAP', x0: 0.2, x1: 0.41, labelX: 0.19, kind: 'plate' },
  { label: 'HAT', x0: 0.59, x1: 0.73, labelX: 0.695, kind: 'box' },
  { label: 'VOX', x0: 0.73, x1: 0.96, labelX: 0.82, kind: 'kana' },
];
export const PLATES = ['＼(•ω•)／', '┌(•ω•)┘', '└(•ω•)┐', '٩(•ω•)۶', '(ง•ω•)ง', '(っ•ω•)っ', 'ヽ(•ω•)ノ', '(*•ω•)✧'];
export const KANA = ['あ', 'い', 'う', 'え', 'お', 'か', 'き'];

/** Notes from the analysed sound events: each lane takes the event types listed for it. */
export function notesFromEvents(audio: AudioData, lanes: string[][], t0 = 0, t1 = Infinity): Note[] {
  const out: Note[] = [];
  lanes.forEach((types, lane) => { for (const e of audio.ev.of(...types)) if (e.t >= t0 && e.t < t1) out.push({ t: e.t, lane }); });
  return out.sort((a, b) => a.t - b.t);
}

export interface HighwayOpts {
  lanes?: Lane[];
  notes: Note[];
  /** Seconds of notes on the runway (hit line to far end). */
  lead?: number;
  /** Hit line y, vanishing point, depth ratio of the far end (bigger = longer runway). */
  hitY?: number; vx?: number; vy?: number; far?: number;
  /** Ridge rows and their height (px at the far end; near rows are flatter). */
  ridges?: number; ridgeAmp?: number;
  /** 0..1 loudness ahead of now (shapes the ridges); default flat. */
  env?: (t: number) => number;
  /** Labels far down the runway. */
  markers?: { t: number; label: string }[];
  /** Hits counted from this time. */
  since?: number;
  /** SCORE from the combo; null hides the score and combo. */
  score?: ((combo: number) => number) | null;
  scoreSub?: string;
  plates?: string[]; kana?: string[];
  paper?: string; ink?: string; red?: string;
}

const PAPER = '#F1ECE7', INK = '#141414', RED = '#E5402D', PALE = '#CBC7C1';

export class Highway {
  o: Required<Omit<HighwayOpts, 'env' | 'score'>> & { env: (t: number) => number; score: ((c: number) => number) | null };
  constructor(o: HighwayOpts) {
    this.o = {
      lanes: DEFAULT_LANES, lead: 2.4, hitY: H * 0.81, vx: W * 0.5, vy: H * 0.09, far: 5, ridges: 70, ridgeAmp: 95,
      markers: [], since: 0, scoreSub: '', plates: PLATES, kana: KANA, paper: PAPER, ink: INK, red: RED,
      ...o, env: o.env ?? (() => 0.5), score: o.score === undefined ? (c: number) => Math.round(c * c * 62 + c * 200) : o.score,
    } as Highway['o'];
    this.o.notes = [...o.notes].sort((a, b) => a.t - b.t);
  }

  /** Screen point of a point on the hit line at x (0..1 of W) pushed `d` along the runway (0 = hit line, 1 = far end). */
  P(x: number, d: number) {
    const z = 1 + d * (this.o.far - 1), X = x * W;
    return { x: this.o.vx + (X - this.o.vx) / z, y: this.o.vy + (this.o.hitY - this.o.vy) / z, z };
  }

  combo(t: number) { let n = 0; for (const e of this.o.notes) { if (e.t > t) break; if (e.t >= this.o.since) n++; } return n; }

  draw(c: Ctx, t: number) {
    const o = this.o;
    c.save();
    // ---- ridges, far to near: each row filled with paper below its line, hiding the rows behind ----
    const R = o.ridges, scroll = (t / o.lead) * R, L = o.lanes[0]!.x0 - 0.06, Rt = o.lanes[o.lanes.length - 1]!.x1 + 0.06;
    for (let k = R + 10; k >= 0; k--) {
      const idx = Math.floor(scroll) + k - 10, d = (idx - scroll) / R;
      if (d < -0.14 || d > 1) continue;
      const te = t + d * o.lead, env = o.env(te), pts: [number, number][] = [];
      const grow = 0.35 + 0.65 * Math.pow(Math.max(0, d), 0.6);
      for (let i = 0; i <= 90; i++) {
        const xn = L + ((Rt - L) * i) / 90, p = this.P(xn, d);
        const centre = Math.exp(-((xn - 0.5) ** 2) / 0.05);
        const n = 0.45 * Math.sin(xn * 31 + idx * 1.3) * Math.sin(xn * 13 - idx * 0.7) + 0.55 * (hash(idx, i) - 0.5) + 0.5;
        pts.push([p.x, p.y - o.ridgeAmp * grow * (0.35 + 0.9 * centre) * (0.4 + env) * Math.max(0, n)]);
      }
      const base = this.P(0.5, d).y;
      c.beginPath(); c.moveTo(pts[0]![0], base + 3);
      for (const [x, y] of pts) c.lineTo(x, y);
      c.lineTo(pts[pts.length - 1]![0], base + 3); c.closePath();
      c.fillStyle = o.paper; c.fill();
      c.beginPath(); c.moveTo(pts[0]![0], pts[0]![1]); for (const [x, y] of pts) c.lineTo(x, y);
      c.lineWidth = Math.max(1, 2 - d); c.strokeStyle = idx % 23 === 0 ? o.red : `rgba(26,24,22,${0.5 + 0.3 * (1 - Math.max(0, d))})`;
      c.stroke();
    }
    // ---- lane edges: from the far end through the hit line to the bottom of the frame ----
    c.strokeStyle = 'rgba(20,20,20,0.75)'; c.lineWidth = 1.6;
    const edges = [...new Set(o.lanes.flatMap((l) => [l.x0, l.x1]))];
    for (const x of edges) {
      const a = this.P(x, 1), b = this.P(x, 0), k = (H - a.y) / (b.y - a.y);
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(a.x + (b.x - a.x) * k, H); c.stroke();
    }
    // ---- the far end: a red block with notes queuing on it ----
    const e0 = this.P(0.4, 1), e1 = this.P(0.6, 1);
    c.fillStyle = o.red; c.fillRect(e0.x - 40, e0.y - 46, e1.x - e0.x + 80, 40);
    for (let i = 0; i < 7; i++) { c.fillStyle = o.ink; const q = this.P(0.42 + 0.03 * hash(i, 2), 0.97 - i * 0.025); c.fillRect(q.x - 46 + hash(i, Math.floor(t * 10)) * 12, q.y - 8, 70 + i * 6, 9 + i); }
    // ---- markers far down the runway ----
    c.font = font(F.archivo(100, 700), 30); c.textBaseline = 'middle';
    for (const m of o.markers) {
      const ahead = m.t - t;
      if (ahead < o.lead * 0.8) continue;
      const d = clamp(0.86 + Math.log1p((ahead - o.lead * 0.8) / 3) * 0.04, 0, 0.99), p = this.P(0.42, d);
      c.strokeStyle = o.red; c.fillStyle = o.red; c.lineWidth = 1.4;
      c.beginPath(); c.moveTo(p.x - 230, p.y); c.lineTo(p.x, p.y); c.stroke();
      c.textAlign = 'right'; c.fillText(m.label, p.x - 240, p.y);
    }
    // ---- notes, far to near ----
    for (let i = o.notes.length - 1; i >= 0; i--) {
      const nt = o.notes[i]!, u = nt.t - t;
      if (u < 0 || u > o.lead) continue;
      this.note(c, nt, u / o.lead, i);
    }
    // ---- hits ----
    o.lanes.forEach((lane, li) => {
      let last: Note | null = null, idx = -1;
      for (let i = 0; i < o.notes.length; i++) { const n = o.notes[i]!; if (n.t > t) break; if (n.lane === li) { last = n; idx = i; } }
      if (!last) return;
      const dt = t - last.t, x0 = lane.x0 * W, x1 = lane.x1 * W, hy = o.hitY;
      if (lane.kind === 'plate' && dt < 0.32 && !last.dot) {
        const pop = ease.outBack(clamp(dt / 0.08)), w = (x1 - x0) * 0.98, h = H * 0.083;
        c.save(); c.translate((x0 + x1) / 2, hy - h * 0.15); c.scale(pop, pop); c.globalAlpha = 1 - clamp((dt - 0.24) / 0.08);
        c.fillStyle = o.ink; c.fillRect(-w / 2, -h / 2, w, h);
        c.fillStyle = '#FFFFFF'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.font = font(F.archivo(100, 700), h * 0.62); c.fillText(last.label ?? o.plates[idx % o.plates.length]!, 0, 2, w * 0.92);
        c.restore();
      }
      if (lane.kind !== 'plate' && dt < 0.22) {
        c.globalAlpha = 1 - clamp((dt - 0.14) / 0.08);
        c.fillStyle = o.red; c.fillRect(x0 - 10, hy - 24, x1 - x0 + 20, 26);
        if (lane.kind === 'kana') {
          const s = H * 0.075; c.fillStyle = o.ink; c.fillRect(x1 - s * 1.6, hy - s * 0.62, s, s);
          c.fillStyle = '#FFFFFF'; c.font = font(F.archivo(100, 900), s * 0.7); c.textAlign = 'center'; c.textBaseline = 'middle';
          c.fillText(last.label ?? o.kana[idx % o.kana.length]!, x1 - s * 1.1, hy - s * 0.1);
        }
        c.globalAlpha = 1;
      }
      if (dt < 0.4) {
        c.globalAlpha = 1 - clamp((dt - 0.32) / 0.08);
        c.fillStyle = '#2A2A2A'; c.font = font(F.archivo(100, 600), 42); c.textAlign = 'left'; c.textBaseline = 'alphabetic';
        c.fillText('PERFECT', lane.labelX * W - 8, H * 0.935, (lane.x1 - lane.labelX) * W + 40);
        c.globalAlpha = 1;
      }
    });
    // lane labels
    c.font = font(F.archivo(100, 500), 20); c.fillStyle = '#555'; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    for (const l of o.lanes) c.fillText(l.label, l.labelX * W, H * 0.885);
    // ---- score and combo ----
    if (o.score) {
      const combo = this.combo(t), score = o.score(combo);
      c.textAlign = 'center'; c.fillStyle = '#1E1E1E'; c.font = font(F.archivo(87.5, 500), 40);
      c.fillText(`SCORE ${String(score).padStart(6, '0').replace(/(\d{3})(\d{3})$/, '$1 $2')}`, W * 0.39, H * 0.067);
      if (o.scoreSub) { c.fillStyle = o.red; c.font = font(F.mono(500), 21); c.fillText(o.scoreSub, W * 0.39, H * 0.1); }
      c.textAlign = 'right'; c.fillStyle = PALE; c.font = font(F.archivo(100, 900), H * 0.52);
      c.fillText(String(combo), W * 1.02, H * 0.27);
      c.fillStyle = '#1E1E1E'; c.font = font(F.archivo(100, 700), 30); c.textAlign = 'left';
      c.fillText('COMBO', W * 0.783, H * 0.345);
    }
    c.restore();
  }

  private note(c: Ctx, n: Note, d: number, i: number) {
    const o = this.o, lane = o.lanes[n.lane]!;
    const a = this.P(lane.x0, d), b = this.P(lane.x1, d), lw = b.x - a.x;
    c.save();
    if (n.dot) {
      c.fillStyle = o.red; c.beginPath(); c.arc((a.x + b.x) / 2, a.y - lw * 0.1, Math.max(3, lw * 0.11), 0, Math.PI * 2); c.fill();
    } else if (lane.kind === 'plate') {
      const w = lw * 0.82, h = w * 0.24, x = a.x + (lw - w) * (0.5 + 0.35 * (hash(i, 3) - 0.5)), y = a.y - h - lw * 0.04;
      c.fillStyle = o.ink; c.fillRect(x, y, w, h);
      if (h > 7) { c.fillStyle = '#FFFFFF'; c.font = font(F.archivo(100, 700), h * 0.66); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(n.label ?? o.plates[i % o.plates.length]!, x + w / 2, y + h / 2 + 1, w * 0.9); }
    } else if (lane.kind === 'box') {
      const s = Math.max(4, lw * 0.13), x = a.x + lw * (0.2 + 0.5 * hash(i, 5)), y = a.y - s * 1.2;
      if (i % 3 === 0) { c.strokeStyle = o.ink; c.lineWidth = 1.4; c.fillStyle = '#FFFFFF'; c.fillRect(x, y, s * 1.4, s); c.strokeRect(x, y, s * 1.4, s); }
      else { c.fillStyle = o.ink; c.fillRect(x, y, s * 0.6, s * 0.6); }
    } else {
      const w = lw * 0.5, h = w * 0.36, x = a.x + lw * 0.3, y = a.y - h - lw * 0.03;
      c.fillStyle = o.ink; c.fillRect(x, y, w, h);
      if (h > 7) { c.fillStyle = '#FFFFFF'; c.font = font(F.archivo(100, 900), h * 0.72); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(n.label ?? o.kana[i % o.kana.length]!, x + w / 2, y + h / 2 + 1); }
    }
    c.restore();
  }
}

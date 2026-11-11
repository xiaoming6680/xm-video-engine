// 曲线图（render.ts curves）：把每个场景的 kfe 轨道画成 AE 图表编辑器那样的图，配上拍点和切点，存成 PNG，
// 让看不到动起来的样子的 Agent 也能「看见」动作：哪里快、哪里慢、落点在不在拍上、是不是全是对称的平滑（发飘）。
// 每条轨道一行：上面是值曲线（关键帧是菱形），下面黄色是速度（AE 的速度图）；竖线是拍（粗的是小节线），红线是切点。
import { allTracks, keysOf, isOverridden, type TrackInfo } from '../engine/tracks';
import { kf, handles, type Key } from '../engine/anim';

export interface SheetHost {
  timeline: readonly { id: string; start: number; end: number }[];
  beats: readonly number[];
  downbeats: readonly number[];
}

export interface TrackReport {
  id: string;
  overridden: boolean;
  keys: { t: number; song: number; v: number; mode: string; beatMs: number | null }[];
  segments: { from: number; to: number; shape: string }[];
  peakSpeed: number;
  peakAt: number;
  note: string;
}

const modeName = (m: Key<number>[2]) => (m === undefined ? 'auto' : typeof m === 'string' ? m : `in ${Math.round((m.in ?? 1 / 3) * 100)}% out ${Math.round((m.out ?? 1 / 3) * 100)}%`);

/** How a segment moves, from its handles: what a motion designer would call it. */
function shape(keys: Key<number>[], i: number): string {
  const m = keys[i]![2];
  if (m === 'hold') return '定格';
  if (m === 'lin') return '匀速';
  const [oa, sa, ib, sb] = handles(keys, i);
  const dv = keys[i + 1]![1] - keys[i]![1], dt = keys[i + 1]![0] - keys[i]![0];
  const avg = Math.abs(dv / dt) || 1e-9;
  const startFast = oa < 0.2 || Math.abs(sa) > 1.5 * avg, endFast = ib < 0.2 || Math.abs(sb) > 1.5 * avg;
  const startSlow = !startFast && Math.abs(sa) < 0.3 * avg, endSlow = !endFast && Math.abs(sb) < 0.3 * avg;
  if (startFast && endSlow) return ib > 0.6 ? '快出慢停' : '快出缓停';
  if (startSlow && endFast) return oa > 0.6 ? '慢起快收' : '缓起快收';
  if (startSlow && endSlow) return Math.abs(oa - ib) < 0.12 ? '对称缓动' : '不对称缓动';
  return '平滑穿过';
}

export async function curveSheets(host: SheetHost): Promise<{ scene: string; png: string; tracks: TrackReport[] }[]> {
  const byScene = new Map<string, TrackInfo[]>();
  for (const r of allTracks()) { const l = byScene.get(r.scene) ?? []; l.push(r); byScene.set(r.scene, l); }
  const out: { scene: string; png: string; tracks: TrackReport[] }[] = [];
  for (const [scene, rows] of byScene) {
    rows.sort((a, b) => a.name.localeCompare(b.name));
    // frame the keys (not the whole entry: a 1 s move in a 60 s entry would be a sliver), with some room either side
    let x0 = Infinity, x1 = -Infinity;
    for (const r of rows) { const ks = keysOf(r.id), off = r.songT - r.argT; x0 = Math.min(x0, ks[0]![0] + off); x1 = Math.max(x1, ks[ks.length - 1]![0] + off); }
    const pad = Math.max(0.25, (x1 - x0) * 0.12);
    x0 -= pad; x1 += pad;
    const W = 1600, ROW = 150, TOP = 46, H = TOP + ROW * rows.length + 30, L = 200, R = 20;
    const cv = new OffscreenCanvas(W, H), g = cv.getContext('2d')!;
    g.fillStyle = '#0d0e10'; g.fillRect(0, 0, W, H);
    const X = (s: number) => L + ((s - x0) / (x1 - x0)) * (W - L - R);
    g.font = '600 18px sans-serif'; g.fillStyle = '#e9e5dc';
    g.fillText(`${scene}  ${x0.toFixed(2)}–${x1.toFixed(2)} s   值（蓝）/ 速度（黄）/ 拍（灰，粗 = 小节）/ 切点（红）`, 12, 28);
    // beats, bars, cuts behind every row
    for (const b of host.beats) if (b >= x0 && b <= x1) { g.fillStyle = '#23262c'; g.fillRect(Math.round(X(b)), TOP, 1, ROW * rows.length); }
    for (const b of host.downbeats) if (b >= x0 && b <= x1) { g.fillStyle = '#3d414a'; g.fillRect(Math.round(X(b)), TOP, 2, ROW * rows.length); }
    for (const e of host.timeline) if (e.start > x0 && e.start < x1) { g.fillStyle = '#c0392b'; g.fillRect(Math.round(X(e.start)), TOP, 2, ROW * rows.length); }
    const reports: TrackReport[] = [];
    rows.forEach((r, ri) => {
      const ks = keysOf(r.id), off = r.songT - r.argT, y0 = TOP + ri * ROW;
      const n = W - L - R, vals: number[] = [], sp: number[] = [];
      for (let i = 0; i <= n; i++) {
        const s = x0 + (x1 - x0) * i / n - off;
        vals.push(kf(s, ks)); sp.push(Math.abs(kf(s + 1 / 480, ks) - kf(s - 1 / 480, ks)) * 240);
      }
      let lo = Math.min(...vals, ...ks.map((k) => k[1])), hi = Math.max(...vals, ...ks.map((k) => k[1]));
      if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
      const spMax = Math.max(...sp, 1e-9), peakI = sp.indexOf(spMax);
      const VY = (v: number) => y0 + 12 + (1 - (v - lo) / (hi - lo)) * (ROW * 0.55);
      const SY = (d: number) => y0 + ROW - 10 - (d / spMax) * (ROW * 0.3);
      g.strokeStyle = '#1e2025'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, y0 + ROW - 0.5); g.lineTo(W, y0 + ROW - 0.5); g.stroke();
      // speed (filled), then value
      g.fillStyle = 'rgba(232,179,57,0.25)'; g.beginPath(); g.moveTo(L, SY(0)); sp.forEach((d, i) => g.lineTo(L + i, SY(d))); g.lineTo(L + n, SY(0)); g.closePath(); g.fill();
      g.strokeStyle = '#e8b339'; g.lineWidth = 1.2; g.beginPath(); sp.forEach((d, i) => (i ? g.lineTo(L + i, SY(d)) : g.moveTo(L + i, SY(d)))); g.stroke();
      g.strokeStyle = '#7fb6ff'; g.lineWidth = 2; g.beginPath(); vals.forEach((v, i) => (i ? g.lineTo(L + i, VY(v)) : g.moveTo(L + i, VY(v)))); g.stroke();
      ks.forEach((k) => {
        const x = X(k[0] + off), y = VY(k[1]);
        g.fillStyle = '#e9e5dc'; g.beginPath();
        if (k[2] === 'hold') g.rect(x - 4, y - 4, 8, 8); else { g.moveTo(x, y - 6); g.lineTo(x + 6, y); g.lineTo(x, y + 6); g.lineTo(x - 6, y); g.closePath(); }
        g.fill();
      });
      g.fillStyle = '#e9e5dc'; g.font = '600 15px sans-serif'; g.fillText(r.name + (isOverridden(r.id) ? ' ●' : ''), 12, y0 + 22);
      g.fillStyle = '#8d9097'; g.font = '13px monospace';
      g.fillText(`${lo.toFixed(2)} – ${hi.toFixed(2)}`, 12, y0 + 42);
      g.fillText(`峰速 ${spMax.toFixed(1)}/s`, 12, y0 + 60);
      // the report
      const nearestBeat = (s: number) => {
        let best: number | null = null;
        for (const b of host.beats) if (best === null || Math.abs(b - s) < Math.abs(best - s)) best = b;
        return best === null ? null : Math.round((s - best) * 1000);
      };
      const segs = ks.slice(0, -1).map((k, i) => ({ from: +(k[0] + off).toFixed(3), to: +(ks[i + 1]![0] + off).toFixed(3), shape: shape(ks, i) }));
      const moving = segs.filter((s) => s.shape !== '定格');
      const sym = moving.filter((s) => s.shape === '对称缓动' || s.shape === '平滑穿过').length;
      const note = moving.length && sym === moving.length ? '全是对称缓动 / 平滑：速度两头一样，容易显得飘；AE 的利落靠不对称（K.go → K.land、K.windup → K.slam）' : '';
      if (note) { g.fillStyle = '#e8b339'; g.fillText('全对称，可能发飘', 12, y0 + 78); }
      segs.forEach((s) => { g.fillStyle = '#8d9097'; g.font = '12px sans-serif'; g.fillText(s.shape, (X(s.from) + X(s.to)) / 2 - 22, y0 + ROW - 2); });
      reports.push({
        id: r.id, overridden: isOverridden(r.id),
        keys: ks.map((k) => ({ t: +k[0].toFixed(4), song: +(k[0] + off).toFixed(3), v: +k[1].toFixed(4), mode: modeName(k[2]), beatMs: nearestBeat(k[0] + off) })),
        segments: segs, peakSpeed: +spMax.toFixed(3), peakAt: +(x0 + (x1 - x0) * peakI / n).toFixed(3), note,
      });
    });
    const b = new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer());
    let png = '';
    for (let i = 0; i < b.length; i += 0x8000) png += String.fromCharCode(...b.subarray(i, i + 0x8000));
    out.push({ scene, png: btoa(png), tracks: reports });
  }
  return out;
}

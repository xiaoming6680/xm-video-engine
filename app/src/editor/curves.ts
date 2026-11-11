// 曲线编辑器（只在预览里，按 G 开关）：像 AE 的图表编辑器一样直接拖关键帧和手柄，改的是 engine/tracks.ts 的 kfe 轨道。
//
// 左边列出画面上的场景用到的可拖轨道（勾「全部」看所有见过的），右边是值曲线，可切成速度图（AE 的 Speed Graph）。
//   拖关键帧          改时间和值；Shift 只改值，Ctrl 只改时间；靠近拍点自动吸附（按住 Alt 不吸）
//   拖手柄            改这一侧的影响（横向长度占这一段的比例）和速度（斜率），就是 AE 的贝塞尔手柄
//   双击曲线          加一个关键帧；Delete 删选中的
//   按钮 / 快捷键     F9 缓动、快出、慢停、蓄力、砸下、平滑、线性、定格；F 适配；Ctrl+Z 撤销、Ctrl+Y 重做
//   滚轮              缩放时间；Shift+滚轮平移；Ctrl+滚轮缩放数值；右键拖动平移
//   点空白处          跳到那个时间
// 改动 0.4 秒后自动写回 app/src/tracks.json（vite 的 /__tracks），导出照它渲。「复制」把这条轨道的关键帧复制成代码，
// 可以粘回场景里；「恢复代码」删掉 json 里这一条，回到代码里写的。
import { allTracks, keysOf, setKeys, isOverridden, tracksJSON, type Keys, type TrackInfo } from '../engine/tracks';
import { kf, handles, K, type KEase, type KMode, type Key } from '../engine/anim';

export interface EditorHost {
  /** Song time of the preview, and seeking it. */
  time(): number;
  seek(t: number): void;
  timeline: readonly { id: string; start: number; end: number }[];
  beats: readonly number[];
  downbeats: readonly number[];
}

const H = 300, LIST_W = 250, PAD = 34;
const C = { bg: '#0d0e10', panel: '#15171a', line: '#2a2d33', text: '#e9e5dc', dim: '#8d9097', key: '#e9e5dc', sel: '#ff7a3c', curve: '#7fb6ff', speed: '#e8b339', head: '#ff4d4d', beat: '#26292f', bar: '#3a3e46', handle: '#ff7a3c' };

const isEase = (m: KMode | undefined): m is KEase => typeof m === 'object' && m !== null;
const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3));

/** The key's current handles written out as an explicit AE ease (so one side can change without moving the other). */
function asEase(keys: Keys, i: number): KEase {
  const m = keys[i]![2];
  const e: KEase = isEase(m) ? { ...m } : {};
  if (i > 0) { const [, , ib, sb] = handles(keys, i - 1); e.in ??= ib; e.speedIn ??= sb; }
  if (i < keys.length - 1) { const [oa, sa] = handles(keys, i); e.out ??= oa; e.speedOut ??= sa; }
  return e;
}

function codeOf(keys: Keys): string {
  const mode = (m: KMode | undefined) => {
    if (m === undefined) return '';
    if (typeof m === 'string') return `, '${m}'`;
    const parts: string[] = [];
    if (m.in !== undefined) parts.push(`in: ${+m.in.toFixed(3)}`);
    if (m.out !== undefined) parts.push(`out: ${+m.out.toFixed(3)}`);
    if (m.speedIn) parts.push(`speedIn: ${+m.speedIn.toFixed(3)}`);
    if (m.speedOut) parts.push(`speedOut: ${+m.speedOut.toFixed(3)}`);
    return `, { ${parts.join(', ')} }`;
  };
  return '[' + keys.map((k) => `[${+k[0].toFixed(4)}, ${+k[1].toFixed(4)}${mode(k[2])}]`).join(', ') + ']';
}

export function createCurveEditor(host: EditorHost) {
  const root = document.createElement('div');
  root.style.cssText = `position:fixed;left:0;right:0;bottom:64px;height:${H}px;background:${C.bg};border-top:1px solid ${C.line};display:none;z-index:8;font:12px/1.4 "Segoe UI Variable Text","Microsoft YaHei UI",system-ui,sans-serif;color:${C.text};user-select:none`;
  root.innerHTML = `
    <div style="position:absolute;left:0;top:0;bottom:0;width:${LIST_W}px;border-right:1px solid ${C.line};display:flex;flex-direction:column">
      <div style="display:flex;gap:8px;align-items:center;padding:6px 8px;border-bottom:1px solid ${C.line}">
        <b style="font-size:13px">曲线</b><label style="color:${C.dim};margin-left:auto"><input type="checkbox" data-r="all"> 全部</label>
      </div>
      <div data-r="list" style="overflow:auto;flex:1"></div>
    </div>
    <div style="position:absolute;left:${LIST_W}px;right:0;top:0;height:30px;display:flex;gap:4px;align-items:center;padding:0 8px;border-bottom:1px solid ${C.line};overflow:hidden;white-space:nowrap" data-r="bar"></div>
    <canvas data-r="cv" style="position:absolute;left:${LIST_W}px;right:0;top:30px;bottom:0;width:calc(100% - ${LIST_W}px);height:${H - 30}px;cursor:crosshair"></canvas>`;
  document.body.appendChild(root);
  const $ = (r: string) => root.querySelector(`[data-r="${r}"]`) as HTMLElement;
  const cv = $('cv') as HTMLCanvasElement, g = cv.getContext('2d')!;
  const list = $('list'), bar = $('bar'), allBox = $('all') as HTMLInputElement;

  let sel: string | null = null, selKey = -1, showSpeed = false, open = false;
  type Box = { x0: number; x1: number; y0: number; y1: number };
  let view: Box | null = null;
  let status = '', statusErr = false, saveTimer = 0;
  const undo: { id: string; keys: Keys | undefined }[] = [], redo: typeof undo = [];

  // ---------------------------------------------------------------- toolbar
  const btn = (label: string, title: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label; b.title = title;
    b.style.cssText = `font:inherit;color:${C.text};background:${C.panel};border:1px solid ${C.line};border-radius:5px;padding:2px 8px;cursor:pointer`;
    b.onclick = (e) => { e.stopPropagation(); fn(); draw(); };
    bar.appendChild(b); return b;
  };
  const name = document.createElement('span'); name.style.cssText = 'font-weight:600;margin-right:8px;min-width:120px;overflow:hidden;text-overflow:ellipsis';
  bar.appendChild(name);
  btn('缓动 F9', 'AE 的缓动：两侧影响 33%、速度 0', () => applyMode((e) => ({ ...e, ...K.easy, speedIn: 0, speedOut: 0 })));
  btn('快出', '从这一帧猛地出发（出去那侧影响 5%）', () => applyMode((e) => ({ ...e, out: 0.05, speedOut: 0 })));
  btn('慢停', '长长地减速落到这一帧（进来那侧影响 90%）', () => applyMode((e) => ({ ...e, in: 0.9, speedIn: 0 })));
  btn('蓄力', '慢慢起步（出去那侧影响 90%）', () => applyMode((e) => ({ ...e, out: 0.9, speedOut: 0 })));
  btn('砸下', '全速撞到这一帧（进来那侧影响 5%）', () => applyMode((e) => ({ ...e, in: 0.05, speedIn: 0 })));
  btn('平滑', '速度连续地穿过（Catmull-Rom）', () => applyMode(() => 'auto'));
  btn('线性', '这一段匀速', () => applyMode(() => 'lin'));
  btn('定格', '停在这个值，到下一帧跳过去', () => applyMode(() => 'hold'));
  const spBtn = btn('速度图', 'AE 的速度图：看哪里快哪里慢', () => { showSpeed = !showSpeed; spBtn.style.background = showSpeed ? '#3a2f12' : C.panel; });
  btn('适配 F', '把整条曲线放进视野', () => { view = null; });
  btn('复制', '把这条轨道的关键帧复制成代码', () => { if (sel) void navigator.clipboard?.writeText(codeOf(keysOf(sel))).then(() => setStatus('已复制成代码')); });
  btn('恢复代码', '删掉 tracks.json 里这一条，回到代码里写的', () => { if (sel && isOverridden(sel)) { push(sel); setKeys(sel, undefined); changed(); } });
  const st = document.createElement('span'); st.style.cssText = `margin-left:auto;color:${C.dim}`; bar.appendChild(st);
  function setStatus(s: string, err = false) { status = s; statusErr = err; st.textContent = s; st.style.color = err ? C.speed : C.dim; }

  // ---------------------------------------------------------------- edits and saving
  function push(id: string) { undo.push({ id, keys: isOverridden(id) ? keysOf(id).map((k) => [...k] as unknown as Key<number>) : undefined }); redo.length = 0; if (undo.length > 200) undo.shift(); }
  function edit(id: string, fn: (ks: Keys) => Keys) { setKeys(id, fn(keysOf(id).map((k) => [k[0], k[1], k[2]] as Key<number>))); }
  function changed() {
    setStatus('保存中……');
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
      try {
        const r = await fetch('/__tracks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: tracksJSON() });
        if (!r.ok) throw new Error(await r.text());
        setStatus('已保存 ' + new Date().toLocaleTimeString());
      } catch (e) { setStatus('没保存上：' + String(e).slice(0, 60), true); }
    }, 400);
    renderList();
  }
  function applyMode(fn: (e: KEase) => KMode) {
    if (!sel || selKey < 0) { setStatus('先点选一个关键帧', true); return; }
    push(sel);
    edit(sel, (ks) => { const i = selKey; if (ks[i]) ks[i] = [ks[i]![0], ks[i]![1], fn(asEase(ks, i))]; return ks; });
    changed();
  }
  function undoStep(stack: typeof undo, other: typeof undo) {
    const s = stack.pop(); if (!s) return;
    other.push({ id: s.id, keys: isOverridden(s.id) ? keysOf(s.id).map((k) => [...k] as unknown as Key<number>) : undefined });
    setKeys(s.id, s.keys); sel = s.id; changed();
  }

  // ---------------------------------------------------------------- track list
  function visible(): TrackInfo[] {
    const t = host.time();
    const live = new Set(host.timeline.filter((e) => t >= e.start && t < e.end).map((e) => e.id));
    return allTracks().filter((r) => allBox.checked || live.has(r.scene) || r.id === sel).sort((a, b) => a.id.localeCompare(b.id));
  }
  let listSig = '';
  function renderList() {
    const rows = visible();
    const sig = rows.map((r) => r.id + (isOverridden(r.id) ? '*' : '')).join('|') + '#' + sel;
    if (sig !== listSig) {
      listSig = sig; list.textContent = '';
      if (!rows.length) {
        list.innerHTML = `<div style="padding:10px;color:${C.dim}">画面上的场景没有可拖轨道。<br>在场景里把 kf(t, keys) 换成 kfe(t, '名字', keys)（engine/tracks.ts）</div>`;
      }
      for (const r of rows) {
        const d = document.createElement('div');
        d.dataset.id = r.id;
        d.style.cssText = `padding:4px 8px;cursor:pointer;display:flex;gap:6px;border-bottom:1px solid #1b1d21;${r.id === sel ? `background:${C.panel};box-shadow:inset 3px 0 ${C.sel}` : ''}`;
        d.innerHTML = `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span><span data-v style="color:${C.dim};font-variant-numeric:tabular-nums"></span>`;
        (d.firstChild as HTMLElement).textContent = (allBox.checked ? r.id : r.name) + (isOverridden(r.id) ? ' ●' : '');
        (d.firstChild as HTMLElement).title = r.id + (isOverridden(r.id) ? '（tracks.json 里改过）' : '（代码里的）');
        d.onclick = () => { sel = r.id; selKey = -1; view = null; renderList(); draw(); };
        list.appendChild(d);
      }
    }
    for (const d of list.children as HTMLCollectionOf<HTMLElement>) {
      const r = allTracks().find((x) => x.id === d.dataset.id); const v = d.querySelector('[data-v]');
      if (r && v) v.textContent = fmt(r.value);
    }
  }
  allBox.onchange = () => { listSig = ''; renderList(); };

  // ---------------------------------------------------------------- geometry
  const info = () => (sel ? allTracks().find((r) => r.id === sel) ?? null : null);
  const offOf = (r: TrackInfo) => r.songT - r.argT;
  function fit(r: TrackInfo) {
    // frame the keys (a 1 s move in a 60 s entry would be a sliver), with room either side to drag them
    const ks = keysOf(r.id), off = offOf(r);
    let x0 = ks[0]![0] + off, x1 = ks[ks.length - 1]![0] + off;
    const padT = Math.max(0.3, (x1 - x0) * 0.25);
    x0 -= padT; x1 += padT;
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i <= 200; i++) { const v = kf(x0 - off + (x1 - x0) * i / 200, ks); y0 = Math.min(y0, v); y1 = Math.max(y1, v); }
    for (const k of ks) { y0 = Math.min(y0, k[1]); y1 = Math.max(y1, k[1]); }
    if (y1 - y0 < 1e-6) { y0 -= 1; y1 += 1; }
    const m = (y1 - y0) * 0.12, mx = (x1 - x0) * 0.03;
    view = { x0: x0 - mx, x1: x1 + mx, y0: y0 - m, y1: y1 + m };
  }
  const W = () => cv.clientWidth, Hh = () => cv.clientHeight;
  const X = (s: number) => PAD + ((s - view!.x0) / (view!.x1 - view!.x0)) * (W() - 2 * PAD);
  const Y = (v: number) => Hh() - 18 - ((v - view!.y0) / (view!.y1 - view!.y0)) * (Hh() - 36);
  const S = (x: number) => view!.x0 + ((x - PAD) / (W() - 2 * PAD)) * (view!.x1 - view!.x0);
  const V = (y: number) => view!.y0 + ((Hh() - 18 - y) / (Hh() - 36)) * (view!.y1 - view!.y0);

  /** Screen points of key i's handles: [in, out] (null where the side has no segment or the segment is hold / lin). */
  function handlePts(ks: Keys, i: number, off: number): [{ x: number; y: number } | null, { x: number; y: number } | null] {
    let hin = null, hout = null;
    const seg = (j: number) => { const m = ks[j]![2]; return m !== 'hold' && m !== 'lin'; };
    if (i > 0 && seg(i - 1)) {
      const a = ks[i - 1]!, b = ks[i]!, dt = b[0] - a[0], [, , ib, sb] = handles(ks, i - 1);
      hin = { x: X(b[0] - ib * dt + off), y: Y(b[1] - sb * ib * dt) };
    }
    if (i < ks.length - 1 && seg(i)) {
      const a = ks[i]!, b = ks[i + 1]!, dt = b[0] - a[0], [oa, sa] = handles(ks, i);
      hout = { x: X(a[0] + oa * dt + off), y: Y(a[1] + sa * oa * dt) };
    }
    return [hin, hout];
  }

  // ---------------------------------------------------------------- drawing
  function draw() {
    if (!open) return;
    const dpr = devicePixelRatio || 1, w = W(), h = Hh();
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = C.bg; g.fillRect(0, 0, w, h);
    const r = info();
    name.textContent = r ? r.id : '没选轨道';
    if (!r) { g.fillStyle = C.dim; g.fillText('在左边选一条轨道', PAD, 30); return; }
    if (!view) fit(r);
    const ks = keysOf(r.id), off = offOf(r);
    // beats and bars
    for (const b of host.beats) { if (b < view!.x0 || b > view!.x1) continue; g.fillStyle = C.beat; g.fillRect(Math.round(X(b)), 0, 1, h); }
    for (const b of host.downbeats) { if (b < view!.x0 || b > view!.x1) continue; g.fillStyle = C.bar; g.fillRect(Math.round(X(b)), 0, 1, h); }
    // time labels
    g.fillStyle = C.dim; g.font = '11px ui-monospace,Consolas,monospace';
    const span = view!.x1 - view!.x0, stepT = span > 20 ? 5 : span > 8 ? 1 : span > 3 ? 0.5 : 0.1;
    for (let s = Math.ceil(view!.x0 / stepT) * stepT; s <= view!.x1; s += stepT) g.fillText(s.toFixed(stepT < 1 ? 1 : 0) + 's', X(s) + 2, h - 4);
    g.fillText(fmt(view!.y1), 2, 12); g.fillText(fmt(view!.y0), 2, h - 18);
    // speed graph (AE): |dv/dt| scaled to the panel
    if (showSpeed) {
      const n = Math.max(2, Math.floor(w - 2 * PAD)), sp: number[] = [];
      let mx = 1e-9;
      for (let i = 0; i <= n; i++) { const s = view!.x0 + span * i / n - off, d = Math.abs(kf(s + 1 / 480, ks) - kf(s - 1 / 480, ks)) * 240; sp.push(d); mx = Math.max(mx, d); }
      g.beginPath(); g.moveTo(PAD, h - 18);
      sp.forEach((d, i) => g.lineTo(PAD + i, h - 18 - (d / mx) * (h - 36)));
      g.lineTo(PAD + n, h - 18); g.closePath(); g.fillStyle = 'rgba(232,179,57,0.16)'; g.fill();
      g.strokeStyle = C.speed; g.lineWidth = 1.5; g.beginPath(); sp.forEach((d, i) => (i ? g.lineTo : g.moveTo).call(g, PAD + i, h - 18 - (d / mx) * (h - 36))); g.stroke();
      g.fillStyle = C.speed; g.fillText(`速度 最大 ${fmt(mx)}/s`, w - 150, 12);
    }
    // value curve
    g.strokeStyle = C.curve; g.lineWidth = 2; g.beginPath();
    for (let x = PAD; x <= w - PAD; x++) { const v = kf(S(x) - off, ks); (x === PAD ? g.moveTo : g.lineTo).call(g, x, Y(v)); }
    g.stroke();
    // keys and the selected key's handles
    ks.forEach((k, i) => {
      const x = X(k[0] + off), y = Y(k[1]), on = i === selKey, m = k[2];
      if (on) {
        const [hi, ho] = handlePts(ks, i, off);
        for (const p of [hi, ho]) if (p) {
          g.strokeStyle = C.handle; g.lineWidth = 1; g.beginPath(); g.moveTo(x, y); g.lineTo(p.x, p.y); g.stroke();
          g.fillStyle = C.bg; g.beginPath(); g.arc(p.x, p.y, 4.5, 0, Math.PI * 2); g.fill(); g.stroke();
        }
      }
      g.fillStyle = on ? C.sel : C.key; g.beginPath();
      if (m === 'hold') g.rect(x - 4.5, y - 4.5, 9, 9);
      else { g.moveTo(x, y - 6); g.lineTo(x + 6, y); g.lineTo(x, y + 6); g.lineTo(x - 6, y); g.closePath(); }
      g.fill();
    });
    // playhead
    const t = host.time();
    if (t >= view!.x0 && t <= view!.x1) { g.fillStyle = C.head; g.fillRect(Math.round(X(t)), 0, 2, h); g.fillText(fmt(kf(t - off, ks)), X(t) + 5, 24); }
    if (selKey >= 0 && ks[selKey]) {
      const k = ks[selKey]!, m = k[2];
      const desc = m === undefined ? '平滑' : typeof m === 'string' ? ({ auto: '平滑', ease: '缓动', lin: '线性', hold: '定格' } as Record<string, string>)[m] : `进 ${Math.round((m.in ?? 1 / 3) * 100)}% / 出 ${Math.round((m.out ?? 1 / 3) * 100)}%`;
      g.fillStyle = C.text; g.fillText(`关键帧 ${selKey + 1}/${ks.length}  t ${fmt(k[0])}（歌 ${fmt(k[0] + off)}s）  值 ${fmt(k[1])}  ${desc}`, PAD, 14);
    }
  }

  // ---------------------------------------------------------------- pointer
  type Drag = { kind: 'key' | 'in' | 'out' | 'scrub' | 'pan'; i: number; x0: number; y0: number; v0?: Box; moved?: boolean };
  let drag: Drag | null = null;
  const pos = (e: PointerEvent | MouseEvent) => { const b = cv.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  function snapBeat(s: number, alt: boolean) {
    if (alt) return s;
    let best = s, bd = 7;
    for (const b of host.beats) { const d = Math.abs(X(b) - X(s)); if (d < bd) { bd = d; best = b; } }
    return best;
  }
  cv.onpointerdown = (e) => {
    const r = info(); if (!r || !view) return;
    const p = pos(e), ks = keysOf(r.id), off = offOf(r);
    cv.setPointerCapture(e.pointerId);
    if (e.button === 2) { drag = { kind: 'pan', i: -1, x0: p.x, y0: p.y, v0: { ...view } }; return; }
    if (selKey >= 0 && ks[selKey]) {
      const [hi, ho] = handlePts(ks, selKey, off);
      if (ho && Math.hypot(p.x - ho.x, p.y - ho.y) < 8) { push(r.id); drag = { kind: 'out', i: selKey, x0: p.x, y0: p.y }; return; }
      if (hi && Math.hypot(p.x - hi.x, p.y - hi.y) < 8) { push(r.id); drag = { kind: 'in', i: selKey, x0: p.x, y0: p.y }; return; }
    }
    const hit = ks.findIndex((k) => Math.hypot(p.x - X(k[0] + off), p.y - Y(k[1])) < 9);
    if (hit >= 0) { selKey = hit; push(r.id); drag = { kind: 'key', i: hit, x0: p.x, y0: p.y }; draw(); return; }
    selKey = -1; host.seek(S(p.x)); drag = { kind: 'scrub', i: -1, x0: p.x, y0: p.y }; draw();
  };
  cv.onpointermove = (e) => {
    if (!drag) return;
    const r = info(); if (!r || !view) return;
    const p = pos(e), off = offOf(r);
    // a click on a key only selects it: nothing changes (and nothing is saved) until it is dragged a few px
    if (!drag.moved && Math.hypot(p.x - drag.x0, p.y - drag.y0) < 3) return;
    drag.moved = true;
    if (drag.kind === 'pan' && drag.v0) {
      const ds = ((p.x - drag.x0) / (W() - 2 * PAD)) * (drag.v0.x1 - drag.v0.x0), dv = ((p.y - drag.y0) / (Hh() - 36)) * (drag.v0.y1 - drag.v0.y0);
      view = { x0: drag.v0.x0 - ds, x1: drag.v0.x1 - ds, y0: drag.v0.y0 + dv, y1: drag.v0.y1 + dv };
    } else if (drag.kind === 'scrub') host.seek(S(p.x));
    else if (drag.kind === 'key') {
      const i = drag.i;
      edit(r.id, (ks) => {
        const k = ks[i]!; let t = k[0], v = k[1];
        if (!e.shiftKey) {
          t = snapBeat(S(p.x), e.altKey) - off;
          const lo = i > 0 ? ks[i - 1]![0] + 1 / 240 : -Infinity, hi = i < ks.length - 1 ? ks[i + 1]![0] - 1 / 240 : Infinity;
          t = Math.min(hi, Math.max(lo, t));
        }
        if (!e.ctrlKey) v = V(p.y);
        ks[i] = [t, v, k[2]];
        return ks;
      });
    } else {
      const i = drag.i, out = drag.kind === 'out';
      edit(r.id, (ks) => {
        const j = out ? i + 1 : i - 1; if (!ks[i] || !ks[j]) return ks;
        const a = ks[Math.min(i, j)]!, b = ks[Math.max(i, j)]!, dt = b[0] - a[0], k = ks[i]!;
        const ht = S(p.x) - off, hv = V(p.y), es = asEase(ks, i);
        if (out) { const infl = Math.min(1, Math.max(0.01, (ht - k[0]) / dt)); es.out = infl; es.speedOut = (hv - k[1]) / (infl * dt); }
        else { const infl = Math.min(1, Math.max(0.01, (k[0] - ht) / dt)); es.in = infl; es.speedIn = (k[1] - hv) / (infl * dt); }
        ks[i] = [k[0], k[1], es];
        return ks;
      });
    }
    draw();
  };
  cv.onpointerup = () => {
    if (drag && (drag.kind === 'key' || drag.kind === 'in' || drag.kind === 'out')) { if (drag.moved) changed(); else undo.pop(); }
    drag = null;
  };
  cv.oncontextmenu = (e) => e.preventDefault();
  cv.ondblclick = (e) => {
    const r = info(); if (!r || !view) return;
    const p = pos(e), off = offOf(r), t = S(p.x) - off, ks = keysOf(r.id);
    push(r.id);
    const nk: Key<number> = [t, kf(t, ks)];
    setKeys(r.id, [...ks, nk]);
    selKey = keysOf(r.id).findIndex((k) => k[0] === t);
    changed(); draw();
  };
  cv.onwheel = (e) => {
    if (!view) return;
    e.preventDefault();
    const p = pos(e), k = Math.exp(e.deltaY * 0.0015);
    if (e.ctrlKey) { const v = V(p.y); view = { ...view, y0: v + (view.y0 - v) * k, y1: v + (view.y1 - v) * k }; }
    else if (e.shiftKey) { const d = (view.x1 - view.x0) * e.deltaY * 0.001; view = { ...view, x0: view.x0 + d, x1: view.x1 + d }; }
    else { const s = S(p.x); view = { ...view, x0: s + (view.x0 - s) * k, x1: s + (view.x1 - s) * k }; }
    draw();
  };
  let hover = false;
  root.onpointerenter = () => { hover = true; }; root.onpointerleave = () => { hover = false; };
  window.addEventListener('keydown', (e) => {
    if (!open || !hover) return;
    if (e.key === 'F9') { e.preventDefault(); applyMode((x) => ({ ...x, ...K.easy, speedIn: 0, speedOut: 0 })); draw(); }
    else if (e.key === 'f' || e.key === 'F') { view = null; draw(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel && selKey >= 0 && keysOf(sel).length > 1) {
      push(sel); setKeys(sel, keysOf(sel).filter((_, i) => i !== selKey)); selKey = -1; changed(); draw();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) { e.preventDefault(); undoStep(undo, redo); draw(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || ((e.key === 'z' || e.key === 'Z') && e.shiftKey))) { e.preventDefault(); undoStep(redo, undo); draw(); }
  });

  // ---------------------------------------------------------------- open / close, per-frame refresh
  const wrap = document.getElementById('wrap'), ui = document.getElementById('ui');
  function layout() {
    const uiH = ui && !ui.classList.contains('hidden') ? 64 : 0;
    root.style.bottom = uiH + 'px';
    if (wrap) wrap.style.bottom = open ? `${uiH + H}px` : '';
  }
  return {
    toggle() {
      open = !open; root.style.display = open ? 'block' : 'none'; layout();
      if (open) { if (!sel) sel = visible()[0]?.id ?? null; listSig = ''; renderList(); draw(); }
    },
    /** Called by the preview every frame: values in the list and the playhead move with the song. */
    frame() { if (!open) return; layout(); renderList(); if (!drag) draw(); },
    get open() { return open; },
    get status() { return { status, statusErr }; },
  };
}

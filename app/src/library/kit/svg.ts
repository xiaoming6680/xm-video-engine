// SVG 素材 → 形状（kit/morph.ts 的 Shape）：Illustrator / Figma 导出的 tag、手绘字、涂鸦、贴纸，读进来就能
// 填色、描边、沿路径写出来（PathWalk）、互相变形（Morph）。
//   const art = await loadSvg('assets/tag.svg');      // 放在 app/public/assets/ 下
//   art.items → [{ shape, fill, stroke, strokeWidth, id }]，art.box = viewBox
// 支持 path（全部命令，含圆弧 A）、polygon、polyline、rect、circle、ellipse、line，元素和 <g> 上的 transform。
// 不支持：文字（导出前转曲）、clipPath / mask、渐变（只取纯色）、use。
import type { V2 } from '../../engine/util';
import { flatten, type Cmd, type Shape } from './morph';

/** Parse an SVG path `d` string into absolute commands (M L Q C Z; H V S T A converted). */
export function parsePathD(d: string): Cmd[] {
  const toks = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: Cmd[] = [];
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0;
  let lastC: { x: number; y: number } | null = null, lastQ: { x: number; y: number } | null = null;
  const num = () => parseFloat(toks[i++]!);
  const flag = () => { // arc flags can be packed ("a10 10 0 01 5 5"): take one digit
    const t = toks[i]!;
    if (t.length > 1 && (t[0] === '0' || t[0] === '1')) { toks[i] = t.slice(1); return t[0] === '1' ? 1 : 0; }
    i++;
    return parseFloat(t) ? 1 : 0;
  };
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i]!)) cmd = toks[i++]!;
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    if (C === 'M') {
      x = ox + num(); y = oy + num(); sx = x; sy = y;
      out.push({ type: 'M', x, y });
      cmd = rel ? 'l' : 'L'; // following pairs are line-tos
      lastC = lastQ = null;
    } else if (C === 'L') { x = ox + num(); y = oy + num(); out.push({ type: 'L', x, y }); lastC = lastQ = null; }
    else if (C === 'H') { x = ox + num(); out.push({ type: 'L', x, y }); lastC = lastQ = null; }
    else if (C === 'V') { y = oy + num(); out.push({ type: 'L', x, y }); lastC = lastQ = null; }
    else if (C === 'C') {
      const x1 = ox + num(), y1 = oy + num(), x2 = ox + num(), y2 = oy + num();
      x = ox + num(); y = oy + num();
      out.push({ type: 'C', x1, y1, x2, y2, x, y });
      lastC = { x: x2, y: y2 }; lastQ = null;
    } else if (C === 'S') {
      const x1 = lastC ? 2 * x - lastC.x : x, y1 = lastC ? 2 * y - lastC.y : y;
      const x2 = ox + num(), y2 = oy + num();
      x = ox + num(); y = oy + num();
      out.push({ type: 'C', x1, y1, x2, y2, x, y });
      lastC = { x: x2, y: y2 }; lastQ = null;
    } else if (C === 'Q') {
      const x1 = ox + num(), y1 = oy + num();
      x = ox + num(); y = oy + num();
      out.push({ type: 'Q', x1, y1, x, y });
      lastQ = { x: x1, y: y1 }; lastC = null;
    } else if (C === 'T') {
      const x1: number = lastQ ? 2 * x - lastQ.x : x, y1: number = lastQ ? 2 * y - lastQ.y : y;
      x = ox + num(); y = oy + num();
      out.push({ type: 'Q', x1, y1, x, y });
      lastQ = { x: x1, y: y1 }; lastC = null;
    } else if (C === 'A') {
      const rx = num(), ry = num(), rot = num(), large = flag(), sweep = flag();
      const x2 = ox + num(), y2 = oy + num();
      for (const c of arcToCubics(x, y, rx, ry, rot, large, sweep, x2, y2)) out.push(c);
      x = x2; y = y2; lastC = lastQ = null;
    } else if (C === 'Z') {
      out.push({ type: 'Z' }); x = sx; y = sy; lastC = lastQ = null;
    } else i++; // unknown token: skip
  }
  return out;
}

/** SVG elliptical arc → cubic béziers (the standard endpoint-to-centre conversion). */
function arcToCubics(x1: number, y1: number, rx: number, ry: number, rotDeg: number, large: number, sweep: number, x2: number, y2: number): Cmd[] {
  if (rx === 0 || ry === 0) return [{ type: 'L', x: x2, y: y2 }];
  const phi = (rotDeg * Math.PI) / 180, cs = Math.cos(phi), sn = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cs * dx + sn * dy, y1p = -sn * dx + cs * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
  const cx = cs * cxp - sn * cyp + (x1 + x2) / 2, cy = sn * cxp + cs * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const segs = Math.ceil(Math.abs(dt) / (Math.PI / 2));
  const out: Cmd[] = [];
  const d = dt / segs, k = (4 / 3) * Math.tan(d / 4);
  const P = (t: number) => ({ x: cx + rx * Math.cos(t) * cs - ry * Math.sin(t) * sn, y: cy + rx * Math.cos(t) * sn + ry * Math.sin(t) * cs });
  const D = (t: number) => ({ x: -rx * Math.sin(t) * cs - ry * Math.cos(t) * sn, y: -rx * Math.sin(t) * sn + ry * Math.cos(t) * cs });
  for (let s = 0; s < segs; s++) {
    const a = t1 + s * d, b = a + d;
    const pa = P(a), pb = P(b), da = D(a), db = D(b);
    out.push({ type: 'C', x1: pa.x + k * da.x, y1: pa.y + k * da.y, x2: pb.x - k * db.x, y2: pb.y - k * db.y, x: pb.x, y: pb.y });
  }
  return out;
}

// ---------- whole documents (browser only: DOMParser) ----------

type M = [number, number, number, number, number, number]; // a b c d e f
const I: M = [1, 0, 0, 1, 0, 0];
const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
function parseTransform(s: string | null): M {
  let m: M = I;
  if (!s) return m;
  for (const [, fn, args] of s.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = (args!.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
    let n: M = I;
    if (fn === 'matrix') n = a as M;
    else if (fn === 'translate') n = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
    else if (fn === 'scale') n = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
    else if (fn === 'rotate') {
      const r = ((a[0] ?? 0) * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r), cx = a[1] ?? 0, cy = a[2] ?? 0;
      n = mul(mul([1, 0, 0, 1, cx, cy], [c, sn, -sn, c, 0, 0]), [1, 0, 0, 1, -cx, -cy]);
    } else if (fn === 'skewX') n = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
    else if (fn === 'skewY') n = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    m = mul(m, n);
  }
  return m;
}
const apply = (m: M, p: V2): V2 => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

export interface SvgItem { id: string; shape: Shape; fill: string | null; stroke: string | null; strokeWidth: number; closed: boolean }
export interface SvgArt { items: SvgItem[]; box: { x: number; y: number; w: number; h: number } }

function styleOf(el: Element, key: string): string | null {
  const inline = el.getAttribute('style')?.match(new RegExp(`(?:^|;)\\s*${key}\\s*:\\s*([^;]+)`))?.[1]?.trim();
  return inline ?? el.getAttribute(key);
}

/** Parse an SVG document's drawable elements into shapes in viewBox units. */
export function parseSvg(text: string, tol = 2): SvgArt {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;
  const vb = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const box = vb.length === 4 && vb.every(Number.isFinite)
    ? { x: vb[0]!, y: vb[1]!, w: vb[2]!, h: vb[3]! }
    : { x: 0, y: 0, w: parseFloat(svg.getAttribute('width') ?? '100'), h: parseFloat(svg.getAttribute('height') ?? '100') };
  const items: SvgItem[] = [];
  const walk = (el: Element, m: M, fill: string | null, stroke: string | null, sw: number) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'defs' || tag === 'clippath' || tag === 'mask' || tag === 'style') return;
    const mm = mul(m, parseTransform(el.getAttribute('transform')));
    const f = styleOf(el, 'fill') ?? fill, s = styleOf(el, 'stroke') ?? stroke;
    const w = parseFloat(styleOf(el, 'stroke-width') ?? '') || sw;
    let cmds: Cmd[] | null = null, closed = true;
    const n = (k: string) => parseFloat(el.getAttribute(k) ?? '0');
    if (tag === 'path') cmds = parsePathD(el.getAttribute('d') ?? '');
    else if (tag === 'rect') {
      const x = n('x'), y = n('y'), ww = n('width'), hh = n('height');
      cmds = [{ type: 'M', x, y }, { type: 'L', x: x + ww, y }, { type: 'L', x: x + ww, y: y + hh }, { type: 'L', x, y: y + hh }, { type: 'Z' }];
    } else if (tag === 'circle' || tag === 'ellipse') {
      const cx = n('cx'), cy = n('cy'), rx = tag === 'circle' ? n('r') : n('rx'), ry = tag === 'circle' ? n('r') : n('ry');
      cmds = parsePathD(`M${cx - rx},${cy} a${rx},${ry} 0 1,0 ${2 * rx},0 a${rx},${ry} 0 1,0 ${-2 * rx},0 Z`);
    } else if (tag === 'polygon' || tag === 'polyline') {
      const p = (el.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number);
      cmds = [];
      for (let k = 0; k + 1 < p.length; k += 2) cmds.push({ type: k ? 'L' : 'M', x: p[k]!, y: p[k + 1]! });
      if (tag === 'polygon') cmds.push({ type: 'Z' }); else closed = false;
    } else if (tag === 'line') {
      cmds = [{ type: 'M', x: n('x1'), y: n('y1') }, { type: 'L', x: n('x2'), y: n('y2') }];
      closed = false;
    }
    if (cmds) {
      if (tag === 'path' && !cmds.some((c) => c.type === 'Z')) closed = false;
      const shape = flatten(cmds, tol).map((k) => k.map((p) => apply(mm, p)));
      const scale = Math.sqrt(Math.abs(mm[0] * mm[3] - mm[1] * mm[2]));
      items.push({ id: el.getAttribute('id') ?? '', shape, fill: f === 'none' ? null : f ?? '#000', stroke: s === 'none' ? null : s, strokeWidth: w * scale, closed });
    }
    for (const ch of Array.from(el.children)) walk(ch, mm, f, s, w);
  };
  walk(svg, I, null, null, 1);
  return { items, box };
}

/** Fetch and parse an SVG from the app's public folder. */
export async function loadSvg(url: string, tol = 2): Promise<SvgArt> {
  return parseSvg(await (await fetch(url)).text(), tol);
}

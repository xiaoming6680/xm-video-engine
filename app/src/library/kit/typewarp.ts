// 字的变形和进出（动效海报的字：Canvas2D，按行切片重画一张预先排好的字图）。If The Sun Burns Out（VCT '26 粉丝动效
// 复刻）里照原片一帧帧对出来的做法，原片一拍二（每秒 15 张画），所以默认按 15 张 / 秒换形。
//
// 为什么要它：海报式 MV 的字不是平移、缩放进来的，是被“甩”进来的——飞的那两张拉成速度线、落地压扁回弹、停住时还在慢慢
// 变大；字受击时整块弯一下、错开几条宽带，字仍读得出。逐像素噪声、细碎撕裂这类做法会把字撕成斑马纹，读不出来。
//
//   streak    像素拉丝：字从尾部一行行被拉成速度线（行组的切口参差、线长随机），沿运动方向拉到 1.6 倍、垂直压到 0.7
//   bendTear  长弯 + 宽带错位：一道波长 1.5 倍字高的长弯，再把两三条宽带（各 10–16 % 字高）横向推开，其余不动
//   arrive    一个词的进场：出现时横拉竖压（1.4 × 0.75）再回弹，停留 0.8 s 内放大 8 %、慢慢漂；飞行两张用 streak
//             （第一张红青分色）；落位压扁（1.22 × 0.86）再回弹
//   tinted    字图换色（缓存）：arrive 分色、同形的阴影 / 描边层
//
// 反例（试过、原片不是这样）：把字切成 7 px 细条、每三条随机推一把的“撕裂”（tear）——一眼是故障滤镜，字变斑马纹读不出。
// 要撕就用 bendTear：大的形变只有一道弯，错位只有两三条宽带。
//
//   const cv = wordCanvas('JUST', font(F.sans(900), 220), '#f2efe8');           // 字图：场景 init() 或按词缓存
//   arrive(c, cv, f.t, { t0: w.start, from: [W * 0.3, H * 0.6, 1], to: [W * 0.7, H * 0.3, 0.3], seed: 4 });
//   bendTear(c, cv, x, y, 1, 1, 36, 110, 7, drawing(f.t));                      // 受击那几张
//
// 输出只取决于 t（drawing(t) 是张号，换形、随机都按张走；一张画之内的子帧看到同一个形，不糊）。
// 手绘墨线（逐张重新抖、笔压粗细、转角出头、淡淡第二笔）在 kit/tegaki.ts 的 sketchLine。示例：?ref=typewarp。
import { clamp, ease, hash, lerp, shutterT, stepT, TAU, handJitter } from '../../engine/util';

type C2 = CanvasRenderingContext2D;
type Cv = HTMLCanvasElement;
/** A word's place: [centre x, centre y, scale]. */
export type Place = [x: number, y: number, scale: number];

/** Drawings per second (the reference is animated on twos at 30 fps). Divides the export fps (60). */
export const TW_RATE = 15;
/** The drawing number at t (crisp: every sub-frame of an export frame sees the same drawing). */
export const drawing = (t: number, rate = TW_RATE) => Math.floor(shutterT(t, 0) * rate + 1e-6);

/** A word set on its own canvas (cv.width = its advance + a margin, height 1.3 × px), for streak / bendTear / arrive. */
export function wordCanvas(text: string, cssFont: string, color: string, px = parseFloat(/(\d+(\.\d+)?)px/.exec(cssFont)?.[1] ?? '100')) {
  const m = document.createElement('canvas').getContext('2d')!;
  m.font = cssFont;
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(m.measureText(text).width + px * 0.1);
  cv.height = Math.ceil(px * 1.3);
  const c = cv.getContext('2d')!;
  c.font = cssFont; c.fillStyle = color; c.textBaseline = 'alphabetic';
  c.fillText(text, px * 0.05, px * 1.02);
  return cv;
}

const tints = new WeakMap<Cv, Map<string, Cv>>();
/** `cv` recoloured (its alpha kept), cached per canvas and colour. */
export function tinted(cv: Cv, color: string) {
  let m = tints.get(cv);
  if (!m) { m = new Map(); tints.set(cv, m); }
  let o = m.get(color);
  if (o) return o;
  o = document.createElement('canvas'); o.width = cv.width; o.height = cv.height;
  const x = o.getContext('2d')!;
  x.drawImage(cv, 0, 0); x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, o.width, o.height);
  m.set(color, o);
  return o;
}

/**
 * Streaked type: the word pulled into speed lines. Row by row (3 px rows, in groups of four with their own cut) its
 * trailing side is replaced by that row's edge pixel stretched out behind it, 80–600 px × k, so the letters tear into
 * lines from the back. k 0..1: how far it has gone (at 1: 1.6 × as long along the motion, 0.7 × across). dir −1: the
 * lines trail to the left (it moves right). (x, y): the word's centre; sc its scale; d the drawing (new cuts each one).
 */
export function streak(c: C2, cv: Cv, x: number, y: number, sc: number, k: number, dir: number, seed: number, d: number) {
  const step = 3, sw = sc * (1 + 0.6 * k), sh = sc * (1 - 0.3 * k), w = cv.width * sw, h = cv.height * sh, x0 = x - w / 2, y0 = y - h / 2;
  for (let row = 0, i = 0; row < cv.height; row += step, i++) {
    const g = Math.floor(i / 4), cutF = clamp(k * (0.35 + 0.75 * hash(g, seed, d))), len = (80 + 520 * hash(i, seed + 1, d)) * k * sh;
    const cut = Math.round(dir < 0 ? cutF * cv.width : (1 - cutF) * cv.width), jx = (hash(i, seed + 2, d) - 0.5) * 6 * k;
    if (dir < 0) {
      c.drawImage(cv, cut, row, cv.width - cut, step, x0 + cut * sw + jx, y0 + row * sh, (cv.width - cut) * sw, step * sh + 0.5);
      if (cut > 0 && cut < cv.width) c.drawImage(cv, cut, row, 1, step, x0 + cut * sw - len + jx, y0 + row * sh, len + cut * sw * 0.15, step * sh + 0.5);
    } else {
      c.drawImage(cv, 0, row, cut, step, x0 + jx, y0 + row * sh, cut * sw, step * sh + 0.5);
      if (cut > 0 && cut < cv.width) c.drawImage(cv, cut - 1, row, 1, step, x0 + cut * sw + jx, y0 + row * sh, len, step * sh + 0.5);
    }
  }
}

/**
 * Bent and torn, readable: the word (top-left at x, y, scaled sx, sy) bends in one long curve (a sine 1.5 × its drawn
 * height long, `amp` px, a new phase every drawing), and two or three wide bands — 10–16 % of its height each — are
 * shoved sideways by 40–100 % of `shove`, either way; everything else stays whole. Same seed and d for two layers (a
 * coloured shadow under the word) and they bend as one.
 */
export function bendTear(c: C2, cv: Cv, x: number, y: number, sx: number, sy: number, amp: number, shove: number, seed: number, d: number) {
  const step = 4, hh = cv.height * sy, lam = 1.5 * hh, ph = hash(seed, d, 6) * TAU, nb = 2 + Math.floor(hash(seed, d, 1) * 2);
  const bands = Array.from({ length: nb }, (_, k): [number, number, number] => {
    const bh = hh * (0.1 + 0.06 * hash(seed, d, k, 2)), y0 = hash(seed, d, k, 3) * (hh - bh);
    return [y0, y0 + bh, (hash(seed, d, k, 4) < 0.5 ? -1 : 1) * shove * (0.4 + 0.6 * hash(seed, d, k, 5))];
  });
  for (let row = 0; row < cv.height; row += step) {
    const yy = row * sy;
    let dx = amp * Math.sin((yy / lam) * TAU + ph);
    for (const [a, b, off] of bands) if (yy >= a && yy < b) dx += off;
    c.drawImage(cv, 0, row, cv.width, step, x + dx, y + yy, cv.width * sx, step * sy + 0.6);
  }
}

export interface ArriveOpts {
  /** Song time it appears (the drawing it falls in). */
  t0: number;
  /** Where it appears big and crisp, and where it settles: [centre x, centre y, scale]. */
  from: Place;
  to: Place;
  seed: number;
  /** When it leaves `from` (default two drawings after t0). */
  hold?: number;
  /** Drawings per second (default TW_RATE, 15). */
  rate?: number;
  /** Drift while held (px / s, leftward) and growth while held (+10 % / s, at most `grow`, default 0.08). */
  drift?: number;
  grow?: number;
  /** The first drawing in flight split into these two inks under the word (null: no split). */
  split?: readonly [string, string] | null;
  /** Hand-placed jitter per drawing (px, default 2). */
  jitter?: number;
}

/**
 * A word arriving, drawing by drawing: it comes in at `from` stretched wide and squashed (1.4 × 0.75), overshoots
 * (0.93 × 1.07) and holds, drifting and growing (8 % over 0.8 s); at `hold` it flies to `to` in two drawings, torn into
 * speed lines from its back (streak 0.55 then 0.9, along an arc 40 px high; the first drawing split red / cyan); it
 * lands squashed (1.22 × 0.86), rebounds (0.96 × 1.04) and settles. Nothing before t0.
 */
export function arrive(c: C2, cv: Cv, t: number, o: ArriveOpts) {
  const rate = o.rate ?? TW_RATE, td = stepT(t, rate), t0 = o.t0, hold = o.hold ?? t0 + 2 / rate;
  if (td < t0 - 1e-3) return;
  const a = o.from, b = o.to, drift = o.drift ?? 40, grow = o.grow ?? 0.08, split = o.split === undefined ? ['#ff2a2a', '#22e0ff'] as const : o.split;
  const [hx, hy] = handJitter(t, rate, o.jitter ?? 2, o.seed);
  const put = (x: number, y: number, sc: number, sx = 1, sy = 1) =>
    c.drawImage(cv, x - (cv.width * sc * sx) / 2 + hx, y - (cv.height * sc * sy) / 2 + hy, cv.width * sc * sx, cv.height * sc * sy);
  const u = (td - hold) * rate, e0 = Math.round((td - t0) * rate), d = drawing(t, rate);
  c.save();
  if (u < -1e-6) {
    const [qx, qy] = e0 <= 0 ? [1.4, 0.75] : e0 === 1 ? [0.93, 1.07] : [1, 1];
    put(a[0] - (td - t0) * drift, a[1], a[2] * (1 + Math.min(grow, (td - t0) * 0.1)), qx, qy);
  } else if (u < 2 - 1e-6) {
    const x0 = a[0] - (hold - t0) * drift, s0 = a[2] * (1 + Math.min(grow, (hold - t0) * 0.1)), dir = b[0] >= x0 ? -1 : 1;
    const k = ease.inOutQuad((u + 1) / 3), x = lerp(x0, b[0], k), y = lerp(a[1], b[1], k) - 40 * Math.sin(Math.PI * k), sc = lerp(s0, b[2], k * 0.8);
    const alpha = c.globalAlpha;
    if (u < 1 - 1e-6 && split) {
      c.globalAlpha = alpha * 0.5;
      streak(c, tinted(cv, split[0]), x - 6 + hx, y + hy, sc, 0.55, dir, o.seed + 3, d);
      streak(c, tinted(cv, split[1]), x + 6 + hx, y + hy, sc, 0.55, dir, o.seed + 4, d);
    }
    c.globalAlpha = alpha * 0.95;
    streak(c, cv, x + hx, y + hy, sc, u < 1 - 1e-6 ? 0.55 : 0.9, dir, o.seed, d);
  } else {
    const [qx, qy] = u < 3 - 1e-6 ? [1.22, 0.86] : u < 4 - 1e-6 ? [0.96, 1.04] : [1, 1];
    put(b[0], b[1], b[2], qx, qy);
  }
  c.restore();
}

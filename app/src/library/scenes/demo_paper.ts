// 纸片拼贴示例（?paper）：一张拼贴海报的 6 秒。纸片按 12 fps 一张张拍到牛皮纸上（手放抖动、落地压扁、影子随抬起
// 高度）；剪刀边（月亮照片的白边、字块）和撕边（报纸、黑色横条、夜空）；扫描纸纹；照片是真半调（程序画的月亮，
// 6.5 px、45°）；月亮沿虚线剪开，盖子在铜钉上抖三下后弹开，夜空从里面长出来、星星洒出来；机位按 6 fps 小推近、
// 弹开时震一下；收尾颗粒、灰尘、暖色暗角。部件在 engine/paper.ts 的「拼贴」一节。
// 参考 mg-styles-15 demos/06-collage（MIT，Vincentwei1021）的节奏和数字；画面内容是这里自己的。
import type * as THREE from 'three';
import { Scene, type Cue, type Frame, type TrackPoint } from '../../engine/scene';
import { W, H, SCALE } from '../../engine/gl';
import { F, font } from '../../engine/type';
import { clamp, lerp, hash, fbm2, ease, TAU } from '../../engine/util';
import { drawLifted, type ShadowOpts, type Pose } from '../kit/tactile';
import {
  CollageStage, pastePose, stepsSince, rostrum, sprite, drawSprite, scissorSprite, splitSprite, halftoneMono, scissorPoints,
  circlePts, rectPts, polyPath, tearShape, tearSprite, drawTorn, sheetPattern, tapeSprite, flecks, brad, boil, halftone, sparkle,
  type Sprite, type Pt, type PasteOpts, type Paste,
} from '../engine/paper';

// ---- palette (sRGB): kraft board, riso red, cream stock, ink, newsprint, night navy, chrome yellow
const KRAFT = '#a8896a', RED = '#b42c24', CREAM = '#efe7d6', INK = '#1a1612', NEWS = '#e4d9c1', NAVY = '#1e2a44', YELLOW = '#e9b23a';
const SH: ShadowOpts = { alpha: [0.36, -0.08] }; // a little stronger than tactile's default on the mid-dark kraft

// ---- when things land (scene seconds; 120 bpm test song: a beat is 0.5 s = 6 steps at 12 fps)
const T = {
  disc: 0.5, moon: 1.0, newsA: 1.5, newsB: 1.75, band: 2.0, rule: 2 + 1 / 12,
  chips: [2.5, 2.5 + 2 / 12, 2.5 + 4 / 12, 3.0], no: 3.25, rattle: [3.5, 3.5 + 2 / 12, 3.5 + 4 / 12], pop: 4.0, roundel: 5.0, tear: 5.5,
};

// ---- the moon: where it lies, its cut line (moon px, origin at its centre) and the brass brad the lid turns on
const MOON = { x: 830, y: 590, d: 520 };
const CUT: Pt[] = [[-300, -72], [-236, -78], [-150, -69], [-62, -82], [30, -71], [118, -83], [206, -73], [300, -79]];
const cutY = (x: number) => {
  for (let i = 0; i < CUT.length - 1; i++) { const [x0, y0] = CUT[i]!, [x1, y1] = CUT[i + 1]!; if (x <= x1) return lerp(y0, y1, clamp((x - x0) / (x1 - x0))); }
  return CUT[CUT.length - 1]![1];
};
const HINGE: Pt = [-206, cutY(-206) - 7];
// lid after the pop, one entry per 12 fps step: angle (deg), lift, dy; then it rests at -100°
const LID_FLY = [[-28, 0.9, -30], [-70, 1.3, -40], [-108, 0.9, -16], [-97, 0.3, -4]] as const;

// stars spilled out of the moon: final page position, size, launch step after the pop, arc height, kind
const STARS = [
  { x: 1012, y: 236, r: 64, k: 1, arc: -170, rot: 0.25, kind: 'star', col: YELLOW, seed: 81 },
  { x: 690, y: 196, r: 50, k: 2, arc: -150, rot: -0.2, kind: 'spark', col: CREAM, seed: 82 },
  { x: 1236, y: 430, r: 40, k: 3, arc: -120, rot: 0.5, kind: 'star', col: RED, seed: 83 },
  { x: 880, y: 118, r: 30, k: 4, arc: -110, rot: -0.4, kind: 'star', col: YELLOW, seed: 84 },
] as const;

// the left newsprint scrap: where it lies; at T.tear its top-right corner is torn off and flies away (one entry per
// 12 fps step: offset, rotation in deg about the corner's middle, lift)
const NB = { x: 168, y: 636, r: -5.5 };
const CORNER = [[6, -10, -3, 0.35], [40, -64, -10, 0.8], [130, -210, -24, 1.2], [260, -440, -40, 1.5], [430, -740, -62, 1.7]] as const;

// ransom-note chips: glyph, family, paper, ink, centre, rotation (deg)
const CHIPS = [
  { ch: '纸', fam: 'NotoSansSC-900', bg: 'red', fg: INK, x: 1490, y: 446, r: -6.5, dy: 8 },
  { ch: '上', fam: 'NotoSerifSC-600', bg: 'news', fg: INK, x: 1722, y: 430, r: 4.5, dy: 2 },
  { ch: '月', fam: 'NotoSansSC-900', bg: 'ink', fg: CREAM, x: 1502, y: 668, r: 3, dy: 8 },
  { ch: '亮', fam: 'NotoSerifSC-600', bg: 'cream', fg: RED, x: 1738, y: 652, r: -4.5, dy: 2 },
] as const;

// camera: a slow push towards the moon, held, kicked by the pop, eased back to show the whole sheet (6 fps)
const CAM = [{ t: 0, z: 1 }, { t: 3.5, z: 1.035 }, { t: 4.5, z: 1.035 }, { t: 6.5, z: 1.012, x: 10 }];
const KICK = { t: T.pop, z: [0.02, 0.012, 0.006, 0.002], x: [10, -6, 3, 0], y: [16, -9, 4, 0] };

// ------------------------------------------------------------------ assets (painted once in init)
/**
 * A moon photo (grey, alpha = the disc), D logical px: a waxing gibbous lit from the upper left, the near side's maria
 * where they are, bright rayed craters (a Tycho, a Copernicus, a Kepler), small fresh craters, a little film noise.
 */
function moonPhoto(D: number, seed: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = cv.height = D;
  const c = cv.getContext('2d')!, img = c.createImageData(D, D), d = img.data;
  const ln = Math.hypot(0.42, 0.3, 0.86), lx = -0.42 / ln, ly = -0.3 / ln, lz = 0.86 / ln;
  // maria: centre, radii (disc units, x right, y down)
  const MARE = [[-0.62, -0.05, 0.3, 0.5], [-0.32, -0.42, 0.3, 0.24], [-0.02, -0.66, 0.3, 0.08], [0.17, -0.38, 0.17, 0.16], [0.38, -0.12, 0.22, 0.18],
    [-0.12, -0.15, 0.17, 0.11], [-0.22, 0.3, 0.2, 0.14], [-0.52, 0.38, 0.1, 0.09], [0.6, 0.12, 0.13, 0.18], [0.4, 0.3, 0.08, 0.08], [0.75, -0.32, 0.1, 0.12]];
  const RAYED = [[-0.12, 0.72, 0.04, 1], [-0.3, -0.12, 0.034, 0.6], [-0.56, -0.13, 0.02, 0.4]].map(([x, y, r, k], j) => ({
    x: x!, y: y!, r: r!, k: k!, ang: Array.from({ length: 18 }, (_, i) => hash(j, i, seed, 9) * TAU), len: Array.from({ length: 18 }, (_, i) => 0.25 + hash(j, i, seed, 8) * 0.6),
  }));
  const small = Array.from({ length: 120 }, (_, i) => ({ x: (hash(i, seed, 1) * 2 - 1) * 0.95, y: (hash(i, seed, 2) * 2 - 1) * 0.95, r: 0.01 + hash(i, seed, 3) ** 2.5 * 0.05 }));
  for (let y = 0, i = 0; y < D; y++) for (let x = 0; x < D; x++, i += 4) {
    const nx = ((x + 0.5) / D) * 2 - 1, ny = ((y + 0.5) / D) * 2 - 1, r = Math.hypot(nx, ny);
    const a = clamp((1 - r) * (D / 2) + 0.5);
    if (a <= 0) continue;
    const nz = Math.sqrt(Math.max(0, 1 - r * r)), warp = 0.5 * fbm2(nx * 4.5 + 1.7, ny * 4.5 - 2.1, 4, seed) + 0.16 * fbm2(nx * 17, ny * 17, 2, seed + 6);
    let m = 0;
    for (const [mx, my, rx, ry] of MARE) m = Math.max(m, clamp((1.02 - Math.hypot((nx - mx!) / rx!, (ny - my!) / ry!) - warp) / 0.35));
    let alb = lerp(0.7, 0.33 + 0.14 * fbm2(nx * 5, ny * 5, 3, seed + 4), m) + 0.14 * fbm2(nx * 13, ny * 13, 3, seed + 2) * (1 - 0.6 * m);
    for (const q of RAYED) {
      const du = nx - q.x, dv = ny - q.y, dd = Math.hypot(du, dv), ang = Math.atan2(dv, du);
      alb += 0.3 * q.k * Math.exp(-dd / (q.r * 2.2)); // bright ejecta blanket
      for (let j = 0; j < q.ang.length; j++) {
        let df = Math.abs(ang - q.ang[j]!) % TAU; df = Math.min(df, TAU - df);
        alb += 0.2 * q.k * Math.exp(-(((df * dd) / 0.028) ** 2)) * clamp(1 - dd / q.len[j]!) * clamp(dd / q.r - 1);
      }
      if (dd < q.r) alb -= 0.1 * (1 - dd / q.r);
    }
    for (const q of small) {
      const du = nx - q.x, dv = ny - q.y;
      if (Math.abs(du) > q.r * 1.4 || Math.abs(dv) > q.r * 1.4) continue;
      const dd = Math.hypot(du, dv) / q.r, s = -(du * lx + dv * ly) / (dd * q.r + 1e-6); // + on the wall facing the light
      if (dd < 1) alb += -0.04 + 0.16 * s * dd * dd;
      else if (dd < 1.4) alb += 0.16 * Math.exp(-(((dd - 1.08) / 0.12) ** 2));
    }
    alb += (hash(x, y, seed) - 0.5) * 0.04;
    const lam = nx * lx + ny * ly + nz * lz, shade = clamp((lam + 0.04) / 0.3) * (0.6 + 0.4 * Math.max(0, lam));
    d[i] = d[i + 1] = d[i + 2] = Math.pow(clamp(alb * shade), 1 / 1.5) * 255; d[i + 3] = a * 255;
  }
  c.putImageData(img, 0, 0);
  return cv;
}

const WORDS = ('the of and a to in moon paper night lantern silver tide harbour city clock street light was with by for on at from that ' +
  'this upon its our quiet window ladder river bridge market evening morning winter autumn letters notice wanted sale lost found ferry ' +
  'station signal crescent orbit eclipse tonight almanac weather fair cloudy north south hour minute paste scissors print press column ' +
  'edition reader observed above below rising setting council lamp oil glass telescope society members meeting held hall twelve').split(' ');
const HEADS = ['LUNAR AFFAIRS', 'NOTICE TO MARINERS', 'WANTED—A LADDER', 'THE ALMANAC', 'LOST & FOUND', 'TIDES', 'BY TELEGRAPH', 'AMUSEMENTS'];

/** A sheet of old newsprint (w x h): masthead, ruled columns of justified serif text, small-caps heads, a boxed notice. */
function newsprint(w: number, h: number, seed: number, paper: HTMLCanvasElement): Sprite {
  return sprite(w, h, (c) => {
    c.fillStyle = sheetPattern(c, paper); c.fillRect(0, 0, w, h);
    const ink = 'rgba(38,31,22,.9)';
    c.fillStyle = ink; c.strokeStyle = ink;
    // masthead
    c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    c.font = font(F.serif(600), 58); c.letterSpacing = '3px';
    c.fillText('THE EVENING LANTERN', w * 0.46, 64);
    c.letterSpacing = '0px';
    c.lineWidth = 2.2; c.beginPath(); c.moveTo(12, 80); c.lineTo(w - 12, 80); c.stroke();
    c.lineWidth = 0.8; c.beginPath(); c.moveTo(12, 85); c.lineTo(w - 12, 85); c.stroke();
    c.font = font(F.mono(500), 11);
    c.fillText('VOL. VII · No. 1854 · PRICE TWO CENTS · FULL MOON EDITION', w * 0.46, 99);
    c.lineWidth = 0.8; c.beginPath(); c.moveTo(12, 106); c.lineTo(w - 12, 106); c.stroke();
    const colW = 148, gut = 13, cols = Math.floor((w - 16) / (colW + gut));
    let n = 0;
    for (let col = 0; col < cols; col++) {
      const x0 = 10 + col * (colW + gut);
      let y = 124;
      if (col) { c.lineWidth = 0.7; c.beginPath(); c.moveTo(x0 - gut / 2, 112); c.lineTo(x0 - gut / 2, h - 8); c.stroke(); }
      while (y < h - 8) {
        const r = hash(seed, col, y, 1);
        if (r < 0.07 && y < h - 60) { // a head
          c.textAlign = 'center'; c.font = font(F.archivo(75, 700), 13); c.letterSpacing = '1px';
          c.fillText(HEADS[Math.floor(hash(seed, col, y, 2) * HEADS.length)]!, x0 + colW / 2, y + 8);
          c.letterSpacing = '0px';
          c.lineWidth = 0.6; c.beginPath(); c.moveTo(x0 + colW * 0.3, y + 14); c.lineTo(x0 + colW * 0.7, y + 14); c.stroke();
          y += 26; continue;
        }
        if (r > 0.985 && y < h - 120) { // a boxed notice
          c.lineWidth = 1.2; c.strokeRect(x0 + 4, y - 4, colW - 8, 70);
          c.textAlign = 'center'; c.font = font(F.serif(600), 24); c.fillText('MOON', x0 + colW / 2, y + 26);
          c.font = font(F.serif(400), 13); c.fillText('to be seen tonight', x0 + colW / 2, y + 44);
          c.font = font(F.mono(500), 9); c.fillText('WEATHER PERMITTING', x0 + colW / 2, y + 58);
          y += 82; continue;
        }
        // a justified line of body text
        c.font = font(F.serif(400), 12.5); c.textAlign = 'left';
        const words: string[] = [];
        let wsum = 0;
        for (;;) {
          const wd = WORDS[Math.floor(hash(seed, n++, 3) * WORDS.length)]!, ww = c.measureText(wd).width;
          if (wsum + ww + words.length * 3 > colW) break;
          words.push(wd); wsum += ww;
        }
        const last = hash(seed, col, y, 4) < 0.12, gap = last ? 3.4 : (colW - wsum) / Math.max(1, words.length - 1);
        let x = x0;
        for (const wd of words) { c.fillText(wd, x, y); x += c.measureText(wd).width + gap; }
        y += last ? 17 : 13.4;
      }
    }
  });
}

/** A scissor-cut quad: rectangle w x h about the origin with corners nudged ±j px (scissors on a straight edge). */
const cutQuad = (w: number, h: number, seed: number, j: number) => scissorPoints(rectPts(-w / 2, -h / 2, w, h), { eps: 1, wobble: 0, jitter: j, seed });

/** A ransom-note chip: a cream outer cut, the coloured paper inside, one glyph. */
function chip(w: number, h: number, bg: string | CanvasPattern | ((c: CanvasRenderingContext2D) => void), paint: (c: CanvasRenderingContext2D) => void, seed: number): Sprite {
  const P = 14;
  return sprite(w + 2 * P, h + 2 * P, (c, sw, shh) => {
    c.translate(sw / 2, shh / 2);
    c.fillStyle = CREAM; c.fill(polyPath(cutQuad(w + 12, h + 12, seed, 5)));
    const inner = polyPath(cutQuad(w, h, seed + 9, 4));
    if (typeof bg === 'function') { c.save(); c.clip(inner); bg(c); c.restore(); } else { c.fillStyle = bg; c.fill(inner); }
    paint(c);
  });
}

/** A 5-point star (or a 4-point sparkle) cut out with scissors, printed with a halftone shade on its far side. */
function starSprite(r: number, kind: 'star' | 'spark', col: string, seed: number, pat: (col: string) => CanvasPattern): Sprite {
  const P = 12;
  return sprite(2 * r + 2 * P, 2 * r + 2 * P, (c, w) => {
    const cx = w / 2, pts: Pt[] = [], n = kind === 'star' ? 5 : 4, inner = kind === 'star' ? 0.45 : 0.3;
    for (let i = 0; i < 2 * n; i++) {
      const a = (i / (2 * n)) * TAU - Math.PI / 2, rr = i % 2 ? r * inner : r;
      // dense points along each edge so the scissor rim follows it
      const b = ((i + 1) / (2 * n)) * TAU - Math.PI / 2, r2 = (i + 1) % 2 ? r * inner : r;
      for (let k = 0; k < 8; k++) { const u = k / 8; pts.push([cx + lerp(Math.cos(a) * rr, Math.cos(b) * r2, u), cx + lerp(Math.sin(a) * rr, Math.sin(b) * r2, u)]); }
    }
    c.fillStyle = CREAM; c.fill(polyPath(scissorPoints(pts, { rim: 5, eps: 1.6, wobble: 0.6, seed })));
    const body = polyPath(scissorPoints(pts, { rim: 0, eps: 1, wobble: 0, jitter: 0.6, seed: seed + 1 }));
    c.fillStyle = pat(col); c.fill(body);
    halftone(c, body, 'rgba(26,22,18,.55)', 5.5, Math.PI / 4, (x, y) => clamp(((x - cx) * 0.6 + (y - cx) * 0.8) / r * 0.8 + 0.1), [0, 0, w, w]);
  });
}

// ------------------------------------------------------------------ scene
export default class DemoPaper extends Scene {
  stage = new CollageStage(7);
  S: Record<string, Sprite> = {};
  lid!: Sprite;
  body!: Sprite;
  stars: Sprite[] = [];
  chips: Sprite[] = [];
  tapes: Sprite[] = [];
  newsB: [Sprite, Sprite] | null = null;

  override async init() {
    const st = await this.stage.load(KRAFT);
    const sheets: Record<string, HTMLCanvasElement> = {};
    const sheet = (col: string, o = {}) => (sheets[col] ??= st.sheet(col, 768, 768, { strength: 4.5, mottle: 0.05, seed: col.length * 7 + col.charCodeAt(2), ...o }));
    const tmp = document.createElement('canvas').getContext('2d')!;
    const pat = (col: string) => sheetPattern(tmp, sheet(col));
    const P = 30; // sprite padding for rims and fibres

    // red riso disc: one long scissor cut round
    const R = 338;
    this.S.disc = sprite(2 * R + 2 * P, 2 * R + 2 * P, (c, w) => {
      const p = polyPath(scissorPoints(circlePts(w / 2, w / 2, R), { eps: 2.2, seed: 3 }));
      c.fillStyle = sheetPattern(c, sheet(RED, { strength: 4, mottle: 0.05 })); c.fill(p);
    });

    // the moon: photo → true halftone → scissor rim → printed cut line → split into lid and body on the cut
    const D = MOON.d, photo = moonPhoto(D, 11), big = document.createElement('canvas');
    big.width = big.height = Math.round(D * SCALE);
    const bc = big.getContext('2d')!;
    bc.imageSmoothingQuality = 'high'; bc.drawImage(photo, 0, 0, big.width, big.height);
    const ht = halftoneMono(big, { period: 6.5, angle: 45, lo: 0.08, hi: 0.95, gamma: 1.05, tone: 0.35, pxScale: SCALE });
    const moon = scissorSprite(ht, D, D, { rim: 6, seed: 7 });
    const m = moon.w / 2;
    const printed = sprite(moon.w, moon.h, (c) => {
      c.drawImage(moon.cv, 0, 0, moon.w, moon.h);
      c.save(); c.beginPath(); c.arc(m, m, D / 2 + 6, 0, TAU); c.clip();
      c.strokeStyle = 'rgba(22,19,15,.85)'; c.lineWidth = 4.5; c.setLineDash([16, 10]); c.lineCap = 'butt';
      c.beginPath(); CUT.forEach(([x, y], i) => (i ? c.lineTo(m + x, m + y) : c.moveTo(m + x, m + y))); c.stroke();
      c.restore();
      // a tiny pair of scissors where the line starts
      scissors(c, m - 182, m + cutY(-182) + 1, -0.08, 0.28, 0.26);
    });
    [this.lid, this.body] = splitSprite(printed, CUT.map(([x, y]) => [m + x, m + y] as Pt));

    // the night inside the moon: a navy wedge, torn up both sides, dots deepening to the top, stars
    // its top runs off the frame: what shows is a V opening out of the cut
    const WW = 1200, WH = 640, base = WH - 30, wx = 520;
    const wedge = tearShape([[wx - 200, WH], [wx - 480, 0], [wx + 620, 0], [wx + 205, WH]], { amp: 9, wave: 240, rim: 5, edges: [true, false, true, false], seed: 21 });
    this.S.wedge = sprite(WW, WH + P, (c) => {
      c.translate(0, P);
      drawTorn(c, wedge, (c) => {
        c.fillStyle = sheetPattern(c, sheet(NAVY, { strength: 6 })); c.fillRect(0, -P, WW, WH + P);
        halftone(c, polyPath(wedge.outline), 'rgba(8,10,20,.75)', 6.5, Math.PI / 4, (_x, y) => clamp(0.95 - y / WH) * 0.9, [0, 0, WW, WH]);
        for (let i = 0; i < 110; i++) {
          const x = hash(i, 5) * WW, y = hash(i, 6) * WH * 0.85, s = hash(i, 7);
          if (s > 0.86) sparkle(c, x, y, 7 + s * 9, CREAM, 0.18);
          else { c.fillStyle = `rgba(239,231,214,${0.5 + s * 0.5})`; c.beginPath(); c.arc(x, y, 0.8 + s * 1.6, 0, TAU); c.fill(); }
        }
      }, '#e9e2d2');
    });
    this.S.wedge.ox = wx; this.S.wedge.oy = base + P;

    // newsprint: one big sheet, two scraps torn out of it
    const news = newsprint(1000, 980, 5, sheet(NEWS, { strength: 4, mottle: 0.07 }));
    const scrap = (sx: number, sy: number, w: number, h: number, seed: number, edges?: boolean[]) => {
      const tear = tearShape(rectPts(P, P, w, h), { amp: 9, wave: 240, rim: 6, seed, edges });
      return sprite(w + 2 * P, h + 2 * P, (c) => drawTorn(c, tear, (c) => c.drawImage(news.cv, P - sx, P - sy, news.w, news.h)));
    };
    this.S.newsA = scrap(150, 20, 760, 330, 31);
    this.S.newsB = scrap(520, 360, 420, 560, 32);
    // [the scrap without its corner, the corner]: torn from the right edge up to the top edge
    this.newsB = tearSprite(this.S.newsB, [500, 330], [215, -20], { seed: 51, amp: 7, rim: 8 });
    this.tapes = [tapeSprite(190, 50, '#d9c69a', 1), tapeSprite(170, 48, '#e3d6b6', 2), tapeSprite(200, 52, '#d9c69a', 3)];

    // black band with the line, a red rule under it: long edges torn, the ends run off the frame
    const BW = 2600, BH = 150;
    const band = tearShape(rectPts(P, P, BW, BH), { amp: 4, wave: 320, rim: 4, fibres: 6, seed: 41, edges: [true, false, true, false] });
    this.S.band = sprite(BW + 2 * P, BH + 2 * P, (c) => {
      drawTorn(c, band, sheetPattern(c, sheet(INK, { strength: 8 })), '#d8d0bf');
      c.fillStyle = CREAM; c.font = font(F.archivo(62, 900), 118); c.letterSpacing = '3px'; c.textBaseline = 'middle';
      c.fillText('THE MOON IS MADE OF PAPER', P + BW / 2 - 712, P + BH / 2 + 5);
    });
    const rule = tearShape(rectPts(P, P, 2400, 30), { amp: 2.5, wave: 200, rim: 3, fibres: 4, seed: 42, edges: [true, false, true, false] });
    this.S.rule = sprite(2400 + 2 * P, 30 + 2 * P, (c) => drawTorn(c, rule, sheetPattern(c, sheet(RED, { strength: 6, mottle: 0.08 }))));

    // ransom chips
    const CS = 228, wash = (c: CanvasRenderingContext2D) => { c.fillStyle = sheetPattern(c, news.cv); c.fillRect(-200, -200, 400, 400); c.fillStyle = 'rgba(236,229,214,.6)'; c.fillRect(-200, -200, 400, 400); };
    this.chips = CHIPS.map((q, i) => chip(CS, CS,
      q.bg === 'news' ? wash : q.bg === 'red' ? pat(RED) : q.bg === 'ink' ? pat(INK) : pat(CREAM),
      (c) => { c.fillStyle = q.fg; c.font = font(q.fam, 196); c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(q.ch, 0, q.dy); }, 60 + i));
    this.S.no = chip(178, 92, pat(RED), (c) => {
      c.fillStyle = CREAM; c.font = font(F.archivo(62, 900), 70); c.textAlign = 'center'; c.textBaseline = 'middle'; c.letterSpacing = '2px';
      c.fillText('Nº07', 2, 4);
    }, 70);

    // round sticker: cream scissor cut, ink disc, three lines
    this.S.roundel = sprite(260, 260, (c) => {
      c.translate(130, 130);
      c.fillStyle = CREAM; c.fill(polyPath(scissorPoints(circlePts(0, 0, 112), { eps: 1.8, seed: 77 })));
      c.fillStyle = pat(INK); c.beginPath(); c.arc(0, 0, 100, 0, TAU); c.fill();
      c.fillStyle = CREAM; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = font('NotoSansSC-700', 36); c.letterSpacing = '4px'; c.fillText('满月特刊', 2, -28);
      c.font = font('NotoSansSC-700', 21); c.letterSpacing = '5px'; c.fillText('随刊附赠月亮', 2.5, 12);
      c.font = font(F.archivo(62, 700), 19); c.letterSpacing = '3px'; c.fillText('MOON INCLUDED', 1.5, 46);
    });

    this.stars = STARS.map((s) => starSprite(s.r, s.kind, s.col, s.seed, pat));
  }

  override cues(): Cue[] {
    const s = this.ctx.start;
    return [
      { t: s + T.disc, name: 'red disc lands', on: 'beat' }, { t: s + T.moon, name: 'moon lands', on: 'beat' },
      { t: s + T.newsA, name: 'newsprint lands', on: 'beat' }, { t: s + T.band, name: 'band lands' },
      ...T.chips.map((t, i) => ({ t: s + t, name: `chip ${i + 1} lands`, on: 'beat' })).filter((_, i) => i % 3 === 0),
      { t: s + T.pop, name: 'moon lid pops' }, { t: s + T.roundel, name: 'sticker lands', on: 'beat' }, { t: s + T.tear, name: 'corner torn off', on: 'beat' },
    ];
  }

  /** Paste a sprite at (x, y) (rotation `rest` in rad): stepped slap + hand jitter + lift shadow. */
  private put(c: CanvasRenderingContext2D, t: number, t0: number, s: Sprite, x: number, y: number, o: PasteOpts) {
    const p = pastePose(t, t0, { scale: 1.32, ...o });
    drawLifted(c, p, (c) => drawSprite(c, s), x, y, SH);
    return p;
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const t = f.t - this.ctx.start;
    this.lt = t;
    const cam = rostrum(t, CAM, { focus: [840, 540], kicks: [KICK] });
    const c = this.stage.begin(t, cam);
    const kp = stepsSince(t, T.pop);

    // printed on the page itself
    mono(c, 'PAPER MOON QUARTERLY', 96, 72, 18, 'left');
    mono(c, 'Nº07  ·  PL. VII  ·  CUT & PASTE ON KRAFT, 2026', W - 96, H - 44, 17, 'right');

    const disc = this.put(c, t, T.disc, this.S.disc!, 830, 470, { seed: 1, rot: 0.06 });
    this.drawNewsB(c, t);
    if (stepsSince(t, T.newsB) >= 1) this.tape(c, t, 0, 112, 388, -0.1, 3);
    this.put(c, t, T.newsA, this.S.newsA!, 1596, 214, { seed: 6, rest: 3.2 * DEG, from: [60, -30] });
    if (stepsSince(t, T.newsA) >= 1) this.tape(c, t, 1, 1272, 74, 0.5, 8);

    // ---- the moon (with its lid, the night inside, the spill), carried by one paste pose
    const mp = pastePose(t, T.moon, { seed: 9, scale: 1.4, rot: 0.08, from: [70, -90] });
    if (mp.visible) { c.save(); this.moonFrame(c, t, mp, kp); this.drawMoon(c, t, mp.lift, kp); c.restore(); }
    flecks(c, [[620, 760, -1, 0.4], [600, 620, -1, -0.2], [1060, 760, 1, 0.4], [1080, 600, 1, -0.2], [700, 360, -0.6, -1], [960, 360, 0.6, -1]], mp.k, 90, 7);
    if (disc.k <= 1) flecks(c, [[520, 300, -1, -0.5], [1140, 300, 1, -0.5], [500, 640, -1, 0.5]], disc.k, 91, 5);

    // band and rule slide in from the left and slap
    this.put(c, t, T.band, this.S.band!, 960, 900, { seed: 15, rest: -8 * DEG, rot: 0.02, scale: 1.08, from: [-780, 110] });
    this.put(c, t, T.rule, this.S.rule!, 900, 1000, { seed: 17, rest: -8 * DEG, rot: 0.02, scale: 1.06, from: [-700, 98] });

    CHIPS.forEach((q, i) => this.put(c, t, T.chips[i]!, this.chips[i]!, q.x, q.y, { seed: 21 + i, rest: q.r * DEG, rot: (i % 2 ? -1 : 1) * 0.1 }));
    if (stepsSince(t, T.chips[3]!) >= 2) this.tape(c, t, 2, 1606, 322, -0.18, 25);
    this.put(c, t, T.no, this.S.no!, 1752, 958, { seed: 27, rest: -5 * DEG });
    const rd = this.put(c, t, T.roundel, this.S.roundel!, 272, 262, { seed: 29, rest: -8 * DEG, rot: -0.12 });
    flecks(c, [[170, 200, -1, -0.4], [380, 330, 1, 0.4], [180, 360, -1, 0.6]], rd.k, 92, 5);

    // the lid on top while it flies
    if (kp >= 0 && kp < 4 && mp.visible) { c.save(); this.moonFrame(c, t, mp, kp); this.drawLid(c, kp, 0); brad(c, HINGE[0], HINGE[1], 13); c.restore(); }

    this.ctx.comp.draw(this.ctx.renderer, this.stage.end(t), out, { mode: 'replace' });
  }

  /** Into the moon's frame (origin at its centre): its paste pose; the pop shakes it (2 px at 12 fps) and jolts it. */
  private moonFrame(c: CanvasRenderingContext2D, t: number, mp: Paste, kp: number) {
    let { x, y, rot } = mp;
    if (!mp.moving && kp >= 0 && kp < 5) { // swap the resting boil for the moving one while the lid goes
      const a = boil(t, 9, false), b = boil(t, 9, true);
      x += b[0] - a[0]; y += b[1] - a[1]; rot += b[2] - a[2];
    }
    c.translate(MOON.x + x, MOON.y + y); c.rotate(rot); c.scale(mp.scale, mp.scale);
    if (kp >= 0 && kp < 3) { c.rotate([2.2, -1.5, 0.6][kp]! * DEG); c.translate(0, [12, -6, 2][kp]!); }
  }

  /** Moon in its own frame (origin at its centre): night wedge → lid (when resting) → spilled stars → body → brad. */
  private drawMoon(c: CanvasRenderingContext2D, t: number, lift: number, kp: number) {
    if (kp >= 0) { // the night springs out of the cut: tall and thin, wide, settle (06's wedge steps); the first step smears
      const g = [[0.94, 1.35], [1.07, 1.1], [0.97, 0.96], [1.01, 1.02]][kp] ?? [1, 1], [jx, jy, jr] = boil(t, 33, kp < 4);
      const wedge = (sx: number, sy: number, alpha: number) => {
        c.save(); c.translate(jx, cutY(0) + 26 + jy); c.rotate(jr); c.scale(sx, sy); c.globalAlpha = alpha;
        if (alpha < 1) drawSprite(c, this.S.wedge!);
        else drawLifted(c, { visible: true, x: 0, y: 0, rot: 0, scale: 1, lift: 0.05 }, (c) => drawSprite(c, this.S.wedge!), 0, 0, SH);
        c.restore();
      };
      wedge(g[0]!, g[1]!, 1);
      if (kp === 0) { wedge(g[0]! * 0.97, g[1]! * 0.78, 0.7); wedge(g[0]! * 0.93, g[1]! * 0.52, 0.5); }
    }
    if (kp < 0 || kp >= 4) this.drawLid(c, kp, lift);
    if (kp >= 0) for (let i = 0; i < STARS.length; i++) this.drawStar(c, t, i, kp);
    drawLifted(c, { visible: true, x: 0, y: 0, rot: 0, scale: 1, lift }, (c) => drawSprite(c, this.body), 0, 0, SH);
    brad(c, HINGE[0], HINGE[1], 13);
  }

  /** The lid turning on the brad: rattles before the pop, flies (kp 0..3), slaps open at -100°. */
  private drawLid(c: CanvasRenderingContext2D, kp: number, lift: number) {
    let a = 0, l = lift, dy = 0, sx = 1, sy = 1;
    const kr = T.rattle.findIndex((r) => stepsSince(this.lt, r) === 0);
    if (kp < 0 && kr >= 0) { a = [-2.5, -5, -8.5][kr]!; dy = [-2, -4, -7][kr]!; l = 0.1 + kr * 0.05; }
    if (kp >= 0 && kp < 4) { const q = LID_FLY[kp]!; a = q[0]; l = q[1]; dy = q[2]; }
    else if (kp === 4) { a = -101; l = 0; sx = 1.03; sy = 0.94; }
    else if (kp > 4) { a = kp === 5 ? -98.5 : -100; l = 0.04; }
    c.save();
    c.translate(HINGE[0], HINGE[1] + dy); c.rotate(a * DEG); c.scale(sx, sy); c.translate(-HINGE[0], -HINGE[1]);
    drawLifted(c, { visible: true, x: 0, y: 0, rot: 0, scale: 1, lift: l }, (c) => drawSprite(c, this.lid), 0, 0, SH);
    c.restore();
  }

  private lt = 0;

  /** A star thrown out of the moon on a 12 fps arc (6 steps), landing with a 1.06 bounce; drawn in moon px. */
  private drawStar(c: CanvasRenderingContext2D, t: number, i: number, kp: number) {
    const s = STARS[i]!, k = kp - s.k;
    if (k < 0) return;
    const fl = 6, e = ease.outCubic(clamp(k / fl));
    const M: Pt = [0, cutY(0) - 10], Fp: Pt = [s.x - MOON.x, s.y - MOON.y];
    const cx = (M[0] + Fp[0]) / 2, cy = Math.min(M[1], Fp[1]) + s.arc;
    const bz = (a: number, b: number, d: number) => (1 - e) * (1 - e) * a + 2 * (1 - e) * e * b + e * e * d;
    const sc = k < fl ? lerp(0.35, 1, e) : k === fl ? 1.06 : 1;
    const pose: Pose = { visible: true, x: 0, y: 0, rot: lerp(s.rot - 1.4, s.rot, e), scale: sc, lift: k < fl ? (1 - e) * 0.8 + 0.1 : 0.06 };
    const [jx, jy, jr] = boil(t, s.seed, k <= fl);
    pose.rot += jr;
    drawLifted(c, pose, (c) => drawSprite(c, this.stars[i]!), bz(M[0], cx, Fp[0]) + jx, bz(M[1], cy, Fp[1]) + jy, SH);
  }

  /** The left newsprint: pasted at T.newsB; at T.tear its corner rips off and flies out of the frame. */
  private drawNewsB(c: CanvasRenderingContext2D, t: number) {
    const kt = stepsSince(t, T.tear);
    if (kt < 0) { this.put(c, t, T.newsB, this.S.newsB!, NB.x, NB.y, { seed: 2, rest: NB.r * DEG, from: [-60, 30] }); return; }
    const [keep, corner] = this.newsB!, [jx, jy, jr] = boil(t, 2, kt < 2);
    drawLifted(c, { visible: true, x: jx, y: jy, rot: NB.r * DEG + jr, scale: 1, lift: 0 }, (c) => drawSprite(c, keep), NB.x, NB.y, SH);
    const f = CORNER[kt];
    if (f) {
      const pv: Pt = [150, -205]; // the corner's middle, from the scrap's centre
      c.save();
      c.translate(NB.x + jx, NB.y + jy); c.rotate(NB.r * DEG + jr);
      c.translate(pv[0] + f[0], pv[1] + f[1]); c.rotate(f[2] * DEG); c.translate(-pv[0], -pv[1]);
      drawLifted(c, { visible: true, x: 0, y: 0, rot: 0, scale: 1 + f[3] * 0.06, lift: f[3] }, (c) => drawSprite(c, corner), 0, 0, SH);
      c.restore();
    }
    // fibres puff out of the rip for two steps
    const rip = (u: number): [number, number, number, number] => {
      const x = lerp(500, 215, u) - 240, y = lerp(330, -20, u) - 310, a = NB.r * DEG;
      return [NB.x + x * Math.cos(a) - y * Math.sin(a), NB.y + x * Math.sin(a) + y * Math.cos(a), 0.8, -0.6];
    };
    flecks(c, [rip(0.25), rip(0.5), rip(0.75), rip(0.4)], kt, 93, 6);
  }

  private tape(c: CanvasRenderingContext2D, t: number, i: number, x: number, y: number, rot: number, seed: number) {
    const [jx, jy, jr] = boil(t, seed, false, { restAmp: 1 });
    drawLifted(c, { visible: true, x: 0, y: 0, rot: rot + jr, scale: 1, lift: 0 }, (c) => drawSprite(c, this.tapes[i]!), x + jx, y + jy, { rest: [1, 2], blur: [3, 0], alpha: [0.16, 0] });
  }

  override track(t: number): Record<string, TrackPoint> {
    const lt = t - this.ctx.start, p = pastePose(lt, T.moon, { seed: 9, scale: 1.4, rot: 0.08, from: [70, -90] });
    return p.visible ? { moon: { x: MOON.x + p.x, y: MOON.y + p.y, s: p.scale, r: p.rot } } : {};
  }
}

const DEG = Math.PI / 180;

function mono(c: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, align: CanvasTextAlign) {
  c.save();
  c.font = font(F.mono(500), size); c.letterSpacing = '3px'; c.fillStyle = 'rgba(26,20,14,.78)'; c.textAlign = align; c.textBaseline = 'alphabetic';
  c.fillText(s, x, y);
  c.restore();
}

/** Two cut-paper blades on a pivot (the little ✂ at the start of a cut line). */
function scissors(c: CanvasRenderingContext2D, x: number, y: number, rot: number, open: number, s: number) {
  c.save(); c.translate(x, y); c.rotate(rot); c.scale(s, s);
  for (const pass of [0, 1]) for (const sgn of [-1, 1]) {
    c.save(); c.rotate(sgn * open);
    c.beginPath(); c.moveTo(-8, 0); c.lineTo(110, 0); c.lineTo(86, 5 * sgn); c.lineTo(30, 10 * sgn); c.lineTo(-8, 9 * sgn); c.closePath();
    c.lineJoin = 'miter'; c.strokeStyle = '#f2ecdf'; c.fillStyle = INK;
    if (!pass) { c.lineWidth = 11; c.stroke(); } else c.fill();
    c.beginPath(); c.ellipse(-50, 18 * -sgn, 22, 15, 0.25 * sgn, 0, TAU);
    c.lineWidth = pass ? 9 : 19; c.strokeStyle = pass ? (sgn > 0 ? RED : INK) : '#f2ecdf'; c.stroke();
    c.beginPath(); c.moveTo(-4, 0); c.lineTo(-32, 11 * -sgn); c.lineWidth = pass ? 8 : 18; c.stroke();
    c.restore();
  }
  c.restore();
}

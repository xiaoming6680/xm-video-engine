// 玻璃拟态示例（?glass）：极光上三张透视磨砂卡片（对话、聆听、控制）从远处落进来，界面跟着活起来；
// 控制卡开关的圆钮变成一滴玻璃，升进对话卡，鼓成胶囊透镜放大回复的字（7 个波长折射，字边有色散）；
// 然后镜头推入、卡片向两边分开飞过镜头，露出后面的玻璃字标题，那滴玻璃缩成标题的句号环。
// 标题后面有深色底池和贴字暗晕，玻璃字在亮极光上也读得清。部件在 kit/glass.ts。
// 参考 mg-styles-15 demos/12-aurora-glass（MIT，Vincentwei1021）的分镜和卡片布局，文案和节奏自己写。
import * as THREE from 'three';
import { Scene, type Frame, type TrackPoint } from '../../engine/scene';
import { Layer2D, makeRT, W, H, SCALE } from '../../engine/gl';
import { F, font } from '../../engine/type';
import { clamp, lerp, ease, TAU } from '../../engine/util';
import { kf, kfv } from '../kit/anim';
import {
  Aurora, FrostCard, GlassLens, GlassText, glassCam, orbit, plane, projectLocal,
  type CardLook, type GlassCam, type GlassCard, type LensLook, type LensShape, type Vec3,
} from '../kit/glass';

const sine = (x: number) => -(Math.cos(Math.PI * clamp(x)) - 1) / 2;
const span = (t: number, a: number, b: number, fn: (x: number) => number = sine) => fn(clamp((t - a) / (b - a)));
const WHITE = (a: number) => `rgba(255,255,255,${a})`;
/** The UI's Chinese copy: 思源黑体 at a UI weight (400 body, 500 labels). */
const zh = (w: 400 | 500, px: number) => font(`NotoSansSC-${w}`, px);
/** Fade in with an 8 px rise (UI copy appearing). */
function riseA(t: number, t0: number, dur = 0.75) { const k = clamp((t - t0) / dur); return { a: sine(k), dy: 8 * (1 - ease.outCubic(k)) }; }

// ---- choreography (s from the scene start)
const T = {
  inA: 0.2, inB: 0.55, inC: 0.9,                      // the panes arrive from depth (1.9 s to settle)
  ask: 1.35, typing: 2.0, reply: [2.6, 3.05, 3.5, 3.95], chips: 4.55, voice: 1.4,
  toggle: 4.45, slider: [5.0, 5.9],
  knobGlass: 6.2, bead: 6.55, snap: 7.1, glide: 7.5, free: 9.15, settle: 10.9,   // the knob turns to glass → lens → 句号
  part: 9.0, push: [8.9, 11.2],                       // the camera pushes in, the panes part
  title: 9.45, sub: 10.45, ring: [11.0, 11.7], sweep: [12.3, 13.3], sweep2: [15.1, 16.1],   // the title rises behind the parting panes
} as const;

// the camera (x, y: shift; z: dolly, px): settle on the cluster, lean in on the knob as it turns to glass, follow the
// drop up to the reply, then push in through the parting panes
const CAM: [number, readonly number[], ('auto' | 'ease')?][] = [
  [0, [70, 24, 120]], [2.6, [10, 40, 300]], [5.6, [-16, 36, 350]], [6.75, [-44, 130, 610], 'ease'],
  [7.7, [10, 30, 560]], [8.9, [14, 10, 600]], [11.2, [0, 0, 1180], 'ease'], [18, [0, 0, 1250]],
];

interface CardDef {
  id: 'A' | 'B' | 'C'; w: number; h: number; r: number; base: Vec3; rot: readonly [number, number];
  tin: number; tout: number; pdur: number; drift: Vec3; prot: readonly [number, number]; ph: number; atlas: readonly [number, number];
}
// A conversation, B voice (behind A: its waveform runs on under A's frost), C controls (in front)
const CARDS: CardDef[] = [
  { id: 'A', w: 660, h: 470, r: 42, base: [1090, 500, 0], rot: [2, 6.5], tin: T.inA, tout: T.part, pdur: 1.6, drift: [920, -30, -560], prot: [2, -16], ph: 0, atlas: [0, 0] },
  { id: 'B', w: 400, h: 200, r: 38, base: [752, 292, 230], rot: [4, -10], tin: T.inB, tout: T.part + 0.08, pdur: 1.65, drift: [-640, -400, -520], prot: [-8, 14], ph: 1.7, atlas: [680, 0] },
  { id: 'C', w: 440, h: 250, r: 40, base: [652, 800, -120], rot: [-4, -9], tin: T.inC, tout: T.part + 0.04, pdur: 1.65, drift: [-440, 330, -460], prot: [10, 14], ph: 3.1, atlas: [680, 220] },
];
const ATLAS_W = 1140, ATLAS_H = 480;
const REPLY = ['给你排了一张夜里的歌单：', '先是钢琴，再慢慢换成弦乐，', '最后一首停在雨声里。', '十一点，它会自己停下。'];

// the Focus toggle on card C (card-local px from its top-left); its knob is where the glass is born
const TOG = { x: 440 - 32 - 80, y: 92 - 22.5, w: 80, h: 45 };
const KNOB_R = 18.75;
const toggleP = (t: number) => span(t, T.toggle, T.toggle + 0.42, ease.inOutCubic);
/** Knob centre, card-C-local from the card's centre. */
const knobLocal = (t: number): [number, number] => [TOG.x + TOG.h / 2 + toggleP(t) * (TOG.w - TOG.h) - 220, TOG.y + TOG.h / 2 - 125];

// the title: 「玻璃拟态」 in glass, the lens settles as its hanging 句号 (a glass ring)
const TITLE = '玻璃拟态', TITLE_FONT = 'NotoSansSC-900', TITLE_SIZE = 210, TITLE_TRACK = 10, TITLE_BASE = 578;
const RING_R = 32, RING_W = 17, WC_Y = 560;
const RISE_D = [0.13, 0, 0.02, 0.15];

function cubicHermite(p0: number, m0: number, p1: number, m1: number, s: number, dt: number) {
  const s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * dt * m0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * dt * m1;
}

export default class DemoGlass extends Scene {
  private aurora = new Aurora();
  private cards = new FrostCard();
  private lens = new GlassLens();
  private title = new GlassText();
  private atlas = new Layer2D(ATLAS_W, ATLAS_H, 2 * SCALE);   // all three cards' UI, one upload
  private sub = new Layer2D();
  private rtA = makeRT();
  private rtB = makeRT();
  private subKey = NaN;
  private TL = { xs: [] as number[], adv: [] as number[], total: 0, top: 0, bot: 0, cx: 0, cy: 0 };

  override init() {
    const tx = this.atlas.texture;   // mipmapped and premultiplied: the panes start far away and small
    tx.generateMipmaps = true;
    tx.minFilter = THREE.LinearMipmapLinearFilter;
    tx.premultiplyAlpha = true;
    // title metrics: four glyphs centred, the hanging 句号 (the ring) pulls the lockup half its width left
    const c = this.sub.ctx;
    c.font = font(TITLE_FONT, TITLE_SIZE);
    const ch = [...TITLE], adv = ch.map((g) => c.measureText(g).width);
    const total = adv.reduce((a, b) => a + b, 0) + TITLE_TRACK * (ch.length - 1);
    const gap = 0.05 * TITLE_SIZE, x0 = W / 2 - total / 2 - 0.5 * (gap + RING_R);
    const xs: number[] = []; let x = x0;
    ch.forEach((_, i) => { xs.push(x); x += adv[i]! + TITLE_TRACK; });
    const m = c.measureText(TITLE);
    const top = TITLE_BASE - m.actualBoundingBoxAscent, bot = TITLE_BASE + m.actualBoundingBoxDescent;
    this.TL = { xs, adv, total, top, bot, cx: x0 + total + gap + RING_R, cy: bot - RING_R - 2 };
  }

  private camera(t: number): GlassCam { const [x, y, z] = kfv(t, CAM.map(([kt, v, m]) => [kt, v, m] as const)); return glassCam(x!, y!, z!); }
  private wordScale(t: number) { return 1 + 0.025 * span(t, T.title, 17); }
  private toWord(x: number, y: number, ws: number): [number, number] { return [W / 2 + (x - W / 2) * ws, WC_Y + (y - WC_Y) * ws]; }

  /** A pane at t: where it is (arrival from depth with a damped tilt, a slow float, the cluster's orbit, the parting). */
  private cardState(c: CardDef, t: number): { card: GlassCard; look: Partial<CardLook>; z: number; rect: [number, number, number, number] } {
    const k = clamp((t - c.tin) / 1.9), e = ease.outQuint(k);
    const eo = span(t, c.tout, c.tout + c.pdur, ease.inOutCubic);
    const tau = Math.max(0, t - c.tin), tilt = 20 * Math.exp(-3.2 * tau) * Math.cos(3.6 * tau);
    const fl = [Math.sin((TAU * t) / 5.4 + c.ph) * 5, Math.sin((TAU * t) / 6.3 + c.ph * 1.3) * 0.9, Math.sin((TAU * t) / 7.7 + c.ph * 0.7) * 1.1];
    let C: Vec3 = [c.base[0] + c.drift[0] * eo, c.base[1] + 70 * (1 - e) + fl[0]! + c.drift[1] * eo, c.base[2] + 560 * (1 - e) + c.drift[2] * eo];
    let rx = c.rot[0] + (k > 0 ? tilt : 20) + fl[1]! + c.prot[0] * eo, ry = c.rot[1] + fl[2]! + c.prot[1] * eo;
    // slow orbit of the whole cluster: true parallax and a changing perspective on the glass
    const yaw = lerp(8, 0, span(t, -0.8, 5.6, ease.outCubic)) - 2.5 * span(t, 5.6, 10.5);
    const pitch = lerp(-4, 0, span(t, -0.8, 5.6, ease.outCubic));
    C = orbit(C, yaw, pitch, [W / 2, H / 2, 80]);
    ry += yaw; rx -= pitch;
    const op = span(t, c.tin, c.tin + 0.8) * (1 - span(t, c.tout + c.pdur * 0.55, c.tout + c.pdur));
    const dfk = span(t, c.tout, c.tout + c.pdur * 0.7);   // defocus leads the travel: the pane leaves the focal plane
    const g1 = (t - c.tin - 0.3) / 1.4;
    const glint: [number, number] = g1 > 0 && g1 < 1 ? [lerp(-1.9, 1.9, sine(g1)), 0.11 * Math.sin(Math.PI * g1)] : [0, 0];
    return {
      card: { plane: plane(C, rx, ry), w: c.w, h: c.h, radius: c.r },
      look: {
        opacity: op, contentA: 1 - 0.75 * span(t, c.tout - 0.05, c.tout + 0.7), defocus: 16 * dfk, glint,
        lod: 3.2 * (1 - span(t, c.tin, c.tin + 1.1, ease.outCubic)) + 3.2 * dfk - 0.35,
        sheen: -0.7 + 1.2 * clamp((t + 1) / 18) + (rx - c.rot[0]) * 0.07 + (ry - c.rot[1]) * 0.05,
      },
      z: C[2],
      rect: [c.atlas[0] / ATLAS_W, 1 - c.atlas[1] / ATLAS_H, c.w / ATLAS_W, c.h / ATLAS_H],
    };
  }

  private local(ci: number, t: number, lx: number, ly: number) { return projectLocal(this.cardState(CARDS[ci]!, t).card.plane, lx, ly, this.camera(t)); }
  private knobScreen(t: number) { const [kx, ky] = knobLocal(t); return this.local(2, t, kx, ky); }

  /** The glass drop's centre: on the knob, rising out of card C, carried by card A's reply, then free to the 句号. */
  private lensOnUI(t: number): [number, number] {
    if (t <= T.bead) { const k = this.knobScreen(t); return [k[0], k[1]]; }
    const [kx, ky] = knobLocal(t);
    const rise = kfv(t, [[T.bead, [0, 0]], [T.snap, [40, -6]], [T.glide, [170, -190]]]);
    const pc = this.local(2, t, kx + rise[0]!, ky + rise[1]!);
    const g = kfv(t, [[T.bead + 0.3, [-220, 76]], [T.glide, [-150, 40]], [T.free, [-40, 44]]]);
    const pa = this.local(0, t, g[0]!, g[1]!);
    const w = span(t, T.snap - 0.1, T.glide + 0.25);
    return [lerp(pc[0], pa[0], w), lerp(pc[1], pa[1], w)];
  }
  private ringCentre(t: number): [number, number] { return this.toWord(this.TL.cx, this.TL.cy, this.wordScale(t)); }
  private lensCentre(t: number): [number, number] {
    if (t < T.free) return this.lensOnUI(t);
    // free flight, C1 from the hand-off: Hermite from where the reply let go (with its velocity) to the 句号
    const p0 = this.lensOnUI(T.free), pm = this.lensOnUI(T.free - 0.01);
    const v0 = [(p0[0] - pm[0]) / 0.01, (p0[1] - pm[1]) / 0.01];
    const p1 = this.ringCentre(t), s = clamp((t - T.free) / (T.settle - T.free)), dt = T.settle - T.free;
    return [cubicHermite(p0[0], v0[0]!, p1[0], 0, s, dt), cubicHermite(p0[1], v0[1]!, p1[1], 0, s, dt)];
  }

  private lensState(t: number): { shape: LensShape; look: Partial<LensLook> } | null {
    const on = span(t, T.knobGlass - 0.08, T.knobGlass + 0.08);
    if (on <= 0) return null;
    const kr = KNOB_R * this.knobScreen(Math.min(t, T.snap))[2];
    let hx: number, hy: number;
    if (t < T.bead) {   // the knob itself has turned to glass, held with a soft wobble
      const wob = Math.sin(TAU * 3 * (t - T.knobGlass)) * Math.exp(-4 * Math.max(0, t - T.knobGlass)) * 0.07;
      hx = kr * 1.14 * (1 + wob); hy = kr * 1.14 * (1 - wob);
    } else if (t < T.snap) {   // a drop of glass pulls out of the toggle
      hx = hy = kr * 1.14 * lerp(1, 2, span(t, T.bead, T.snap));
    } else if (t < T.glide) {   // snap: a quick wobble, then it swells into the capsule
      const k = span(t, T.snap, T.glide), r0 = kr * 1.14 * 2, d = t - T.snap, wob = Math.sin(TAU * 7.5 * d) * Math.exp(-14 * d) * 0.12;
      hx = lerp(r0, 200, k) * (1 - wob); hy = lerp(r0, 110, k) * (1 + wob);
    } else {
      const R = RING_R * this.wordScale(t);
      hx = kf(t, [[T.glide, 200], [T.glide + 0.5, 224], [T.free, 190], [T.free + 0.7, 112], [T.settle, R, 'ease']]);
      hy = kf(t, [[T.glide, 110], [T.glide + 0.5, 122], [T.free, 106], [T.free + 0.7, 88], [T.settle, R, 'ease']]);
      const br = 1 + 0.018 * Math.sin((TAU * (t - T.settle - 0.35)) / 2.2) * span(t, T.settle + 0.2, T.settle + 0.9);
      hx *= br; hy *= br;
    }
    const [x, y] = this.lensCentre(t);
    const rk = span(t, T.ring[0], T.ring[1]);
    const ringW = rk > 0 ? lerp(Math.min(hx, hy) * 1.1, RING_W * this.wordScale(t), rk) : 0;
    const lift = span(t, T.bead, 7.9) * (1 - 0.9 * span(t, 10.2, T.settle));
    const glint = t < 9 ? lerp(-1.8, 1.8, clamp((t - 7.4) / 1.2)) : lerp(-1.8, 1.8, clamp((t - 12.0) / 1.2));
    return {
      shape: { x, y, hx, hy, ringW },
      look: {
        on, lift, caustic: 0.22 * lift, glint,
        mag: kf(t, [[T.knobGlass, 1], [T.bead + 0.5, 1.14], [T.glide + 0.4, 1.36], [T.free + 0.3, 1.32], [T.free + 0.9, 1.26], [T.settle, 1.2, 'ease']]),
        rimGlow: lerp(1, 2.1, span(t, 10.3, T.settle)), ringLit: 0.4 * span(t, 10.8, T.settle + 0.3),
      },
    };
  }

  override track(t: number): Record<string, TrackPoint> {
    const L = this.lensState(t);
    return L ? { lens: { x: L.shape.x, y: L.shape.y, s: Math.min(L.shape.hx, L.shape.hy) } } : {};
  }

  // ---------------------------------------------------------------- the panes' UI (card-local px)

  private drawChat(c: CanvasRenderingContext2D, t: number) {
    const w = 660, h = 470, P0 = 38;
    const hA = riseA(t, T.inA + 0.35, 0.9);
    c.globalAlpha = hA.a;
    orb(c, P0 + 16, P0 + 16 + hA.dy, 16);
    c.font = zh(500, 21); c.fillStyle = WHITE(0.96); c.fillText('极光', P0 + 44, P0 + 23 + hA.dy);
    const thinking = span(t, T.typing - 0.1, T.typing + 0.15, (x) => x) * (1 - span(t, T.reply[0] - 0.05, T.reply[0] + 0.35, (x) => x));
    c.font = zh(400, 16); c.fillStyle = WHITE(0.55); c.textAlign = 'right';
    c.globalAlpha = hA.a * (1 - thinking); c.fillText('刚刚', w - P0, P0 + 22 + hA.dy);
    c.globalAlpha = hA.a * thinking; c.fillText('思考中', w - P0, P0 + 22 + hA.dy);
    c.textAlign = 'left'; c.globalAlpha = 1;
    // the question (right aligned)
    const ub = riseA(t, T.ask, 0.7);
    if (ub.a > 0) {
      c.font = zh(400, 21);
      const txt = '今晚想听点安静的。', tw = c.measureText(txt).width, bw = tw + 44, bx = w - P0 - bw, by = 100 + ub.dy;
      c.globalAlpha = ub.a;
      c.beginPath(); c.roundRect(bx, by, bw, 50, 25); c.fillStyle = WHITE(0.16); c.fill(); c.strokeStyle = WHITE(0.24); c.lineWidth = 1; c.stroke();
      c.fillStyle = WHITE(0.97); c.fillText(txt, bx + 22, by + 33);
      c.globalAlpha = 1;
    }
    // typing dots
    const ty = span(t, T.typing, T.typing + 0.3, (x) => x) * (1 - span(t, T.reply[0] - 0.1, T.reply[0] + 0.2, (x) => x));
    if (ty > 0.001) {
      c.globalAlpha = sine(ty);
      c.beginPath(); c.roundRect(P0, 178, 76, 40, 20); c.fillStyle = WHITE(0.12); c.fill();
      for (let i = 0; i < 3; i++) {
        const ph = 0.5 + 0.5 * Math.sin(t * 7.5 - i * 0.9);
        c.fillStyle = WHITE(0.35 + 0.5 * ph); c.beginPath(); c.arc(P0 + 22 + i * 16, 198 - 2 * ph, 4, 0, TAU); c.fill();
      }
      c.globalAlpha = 1;
    }
    // the reply streams in glyph by glyph (opacity + an 8 px rise each)
    c.font = zh(400, 25);
    REPLY.forEach((line, li) => {
      let x = P0;
      [...line].forEach((g, i) => {
        const r = riseA(t, T.reply[li]! + i * 0.032, 0.7), a = c.measureText(g).width;
        if (r.a > 0) { c.globalAlpha = r.a; c.fillStyle = WHITE(li === 2 ? 1 : 0.9); c.fillText(g, x, 214 + li * 42 + r.dy); }
        x += a;
      });
    });
    c.globalAlpha = 1;
    // action chips
    c.font = zh(500, 17);
    let cx = P0 + 48;
    ['开始播放', '稍后提醒我'].forEach((txt, i) => {
      const r = riseA(t, T.chips + i * 0.12, 0.75), tw = c.measureText(txt).width, bw = tw + 40;
      if (r.a > 0) {
        c.globalAlpha = r.a;
        c.beginPath(); c.roundRect(cx, h - P0 - 42 + r.dy, bw, 42, 21); c.fillStyle = WHITE(i === 0 ? 0.2 : 0.1); c.fill();
        c.strokeStyle = WHITE(0.26); c.lineWidth = 1; c.stroke();
        c.fillStyle = WHITE(0.94); c.fillText(txt, cx + 20, h - P0 - 15 + r.dy);
      }
      cx += bw + 12;
    });
    c.globalAlpha = 1;
  }

  private drawVoice(c: CanvasRenderingContext2D, t: number, song: number) {
    const w = 400, h = 200, P0 = 30;
    const hA = riseA(t, T.inB + 0.35, 0.9);
    c.globalAlpha = hA.a;
    c.font = zh(500, 19); c.fillStyle = WHITE(0.95); c.fillText('聆听中', P0, P0 + 18 + hA.dy);
    const lw = c.measureText('聆听中').width, secs = Math.max(0, Math.floor(t - T.voice + 3));
    c.font = font(F.sans(500), 17); c.fillStyle = WHITE(0.5); c.fillText(`0:${String(secs).padStart(2, '0')}`, P0 + lw + 12, P0 + 18 + hA.dy);
    c.globalAlpha = 1;
    // a waveform radiating from the orb (newest at the orb), driven by the song; the orb sits on card A's left edge, so
    // half the bars run on under A's frost
    const OX = 178, cy = 112, maxH = 80, bw = 6, step = 11.5, on = span(t, T.voice, T.voice + 0.8);
    const env = (s: number) => clamp(this.ctx.audio.env('rms', Math.max(0, s)) * 1.2);
    const bar = (x: number, dist: number, a: number) => {
      const tt = song - dist * 0.0042, e = env(tt);
      const shape = Math.exp(-((dist / 150) ** 2)) * 0.8 + 0.2, jitter = 0.72 + 0.28 * Math.sin(x * 0.37 + tt * 3.1);
      const bh = Math.max(5, maxH * on * (0.1 + 0.9 * Math.pow(e, 0.75) * shape * jitter));
      const gr = c.createLinearGradient(0, cy - bh / 2, 0, cy + bh / 2);
      gr.addColorStop(0, `rgba(170,238,255,${a})`); gr.addColorStop(0.5, `rgba(255,255,255,${a})`); gr.addColorStop(1, `rgba(196,176,255,${a})`);
      c.fillStyle = gr; c.beginPath(); c.roundRect(x - bw / 2, cy - bh / 2, bw, bh, bw / 2); c.fill();
    };
    for (let x = OX - 34, i = 0; x > P0; x -= step, i++) bar(x, OX - x, 0.5 + 0.45 * Math.exp(-i / 6));
    for (let x = OX + 34; x < w - P0; x += step) bar(x, x - OX, 0.95);
    const e0 = env(song), pr = 20 * (0.92 + 0.14 * e0) * (0.3 + 0.7 * on);
    const halo = c.createRadialGradient(OX, cy, 0, OX, cy, pr * 4.6);
    halo.addColorStop(0, `rgba(120,228,255,${0.95 * on})`); halo.addColorStop(0.28, `rgba(67,211,242,${0.64 * on})`);
    halo.addColorStop(0.6, `rgba(67,211,242,${0.26 * on})`); halo.addColorStop(1, 'rgba(67,211,242,0)');
    c.fillStyle = halo; c.beginPath(); c.arc(OX, cy, pr * 4.6, 0, TAU); c.fill();
    const core = c.createRadialGradient(OX - pr * 0.3, cy - pr * 0.35, 0, OX, cy, pr);
    core.addColorStop(0, '#FFFFFF'); core.addColorStop(0.35, '#BFF4FF'); core.addColorStop(1, '#43D3F2');
    c.globalAlpha = on; c.fillStyle = core; c.beginPath(); c.arc(OX, cy, pr, 0, TAU); c.fill();
    const cap = riseA(t, T.voice + 0.9, 0.8);
    c.globalAlpha = cap.a * 0.62; c.font = zh(400, 15); c.fillStyle = WHITE(1);
    c.fillText('“……放点安静的”', P0, h - P0 + 4 + cap.dy);
    c.globalAlpha = 1;
  }

  private drawModes(c: CanvasRenderingContext2D, t: number) {
    const w = 440, P0 = 32;
    const hA = riseA(t, T.inC + 0.35, 0.9);
    c.globalAlpha = hA.a;
    // row 1: Focus, with the toggle whose knob becomes the glass
    const y1 = 92 + hA.dy;
    c.save(); c.translate(P0 + 14, y1); c.fillStyle = WHITE(0.92);
    c.beginPath(); c.arc(0, 0, 12, 0, TAU); c.arc(6, -5, 10, 0, TAU, true); c.fill('evenodd'); c.restore();
    c.font = zh(500, 21); c.fillStyle = WHITE(0.96); c.fillText('专注', P0 + 42, y1 - 3);
    c.font = zh(400, 15); c.fillStyle = WHITE(0.55); c.fillText('只有家人能联系你', P0 + 42, y1 + 21);
    const p = toggleP(t), tx = TOG.x, ty = TOG.y + hA.dy;
    c.beginPath(); c.roundRect(tx, ty, TOG.w, TOG.h, TOG.h / 2); c.fillStyle = WHITE(0.16); c.fill();
    if (p > 0) {
      c.save(); c.globalAlpha = hA.a * p;
      const gr = c.createLinearGradient(tx, 0, tx + TOG.w, 0); gr.addColorStop(0, '#5B7CFF'); gr.addColorStop(1, '#43D3F2');
      c.beginPath(); c.roundRect(tx, ty, TOG.w, TOG.h, TOG.h / 2); c.fillStyle = gr; c.fill(); c.restore();
      c.globalAlpha = hA.a;
    }
    c.beginPath(); c.roundRect(tx + 0.5, ty + 0.5, TOG.w - 1, TOG.h - 1, TOG.h / 2); c.strokeStyle = WHITE(0.22); c.lineWidth = 1; c.stroke();
    // the white knob cross-fades into the glass knob, and comes back once the drop has left
    const glass = span(t, T.knobGlass - 0.07, T.knobGlass + 0.08), back = span(t, T.snap + 0.25, T.snap + 0.6);
    const ka = 1 - glass + glass * back;
    if (ka > 0.002) {
      const [kx, ky] = knobLocal(t), stretch = 1 + 0.22 * Math.sin(Math.PI * clamp((t - T.toggle) / 0.42));
      c.save(); c.globalAlpha = hA.a * ka; c.translate(kx + 220, ky + 125 + hA.dy); c.scale(stretch, 1);
      c.shadowColor = 'rgba(10,5,40,0.35)'; c.shadowBlur = 8; c.shadowOffsetY = 2;
      c.fillStyle = '#FFFFFF'; c.beginPath(); c.arc(0, 0, KNOB_R, 0, TAU); c.fill(); c.restore();
      c.globalAlpha = hA.a;
    }
    c.fillStyle = WHITE(0.12); c.fillRect(P0, 139 + hA.dy, w - 2 * P0, 1);
    // row 2: Glow (the slider really turns the aurora up)
    const y2 = 190 + hA.dy;
    c.save(); c.translate(P0 + 14, y2 - 7); c.strokeStyle = WHITE(0.92); c.lineWidth = 2; c.lineCap = 'round';
    c.beginPath(); c.arc(0, 0, 6, 0, TAU); c.stroke();
    for (let i = 0; i < 8; i++) { const a = (i * TAU) / 8; c.beginPath(); c.moveTo(Math.cos(a) * 10, Math.sin(a) * 10); c.lineTo(Math.cos(a) * 13, Math.sin(a) * 13); c.stroke(); }
    c.restore();
    c.font = zh(500, 21); c.fillStyle = WHITE(0.96); c.fillText('光晕', P0 + 42, y2);
    const sx0 = 190, sx1 = w - P0, sy = y2 - 7, v = lerp(0.3, 0.74, span(t, T.slider[0], T.slider[1], ease.inOutCubic));
    c.beginPath(); c.roundRect(sx0, sy - 2, sx1 - sx0, 4, 2); c.fillStyle = WHITE(0.18); c.fill();
    const g2 = c.createLinearGradient(sx0, 0, sx1, 0); g2.addColorStop(0, '#7A5CFF'); g2.addColorStop(1, '#43D3F2');
    c.beginPath(); c.roundRect(sx0, sy - 2, (sx1 - sx0) * v, 4, 2); c.fillStyle = g2; c.fill();
    c.save(); c.shadowColor = 'rgba(10,5,40,0.35)'; c.shadowBlur = 6; c.shadowOffsetY = 1;
    c.fillStyle = '#fff'; c.beginPath(); c.arc(sx0 + (sx1 - sx0) * v, sy, 10, 0, TAU); c.fill(); c.restore();
    c.font = font(F.sans(500), 15); c.fillStyle = WHITE(0.55); c.textAlign = 'right'; c.fillText(`${Math.round(v * 100)}%`, sx1, y2 + 24); c.textAlign = 'left';
    c.globalAlpha = 1;
  }

  private drawAtlas(t: number, song: number) {
    this.atlas.clear();
    const c = this.atlas.ctx;
    for (const d of CARDS) {
      c.save(); c.translate(d.atlas[0], d.atlas[1]);
      c.beginPath(); c.rect(0, 0, d.w, d.h); c.clip();
      c.textBaseline = 'alphabetic';
      if (d.id === 'A') this.drawChat(c, t); else if (d.id === 'B') this.drawVoice(c, t, song); else this.drawModes(c, t);
      c.restore();
    }
    return this.atlas.upload();
  }

  // ---------------------------------------------------------------- title

  /**
   * The glass glyphs into the title mask, always at full alpha (the glass fades in through GlassText's opacity: a faint
   * mask would make a low, faceted bevel); each glyph rises on its own beat. Returns the title's opacity.
   */
  private drawTitle(t: number) {
    const a = riseA(t, T.title, 0.8).a;
    if (a <= 0) return 0;
    // drawn at scale 1 (the slow push is GlassText's zoom); offsets rounded to 1/100 px are the cache key
    const dys = RISE_D.map((d) => Math.round(riseA(t, T.title + d, 0.95).dy * 160) / 100);
    this.title.setMask(dys.join(','), (c) => {
      c.font = font(TITLE_FONT, TITLE_SIZE); c.fillStyle = '#fff';
      [...TITLE].forEach((g, i) => c.fillText(g, this.TL.xs[i]!, TITLE_BASE + dys[i]!));
    });
    return a;
  }

  /**
   * Line 2, flat white on a soft deep shadow so it reads on the pool. Drawn at scale 1 and only when its rise offset
   * changes (the cache key); fade and push are applied when it is composited. Returns its opacity.
   */
  private drawSub(t: number) {
    const r = riseA(t, T.sub, 0.7);
    if (r.a <= 0) return 0;
    const dy = Math.round(r.dy * 100) / 100;
    if (dy === this.subKey) return r.a;
    this.subKey = dy;
    const L = this.sub, c = L.ctx;
    L.clear();
    const cn = '磨砂与色散', en = 'AURORA · GLASS', y = 702 + dy;
    const fc = zh(500, 50), fe = font(F.sans(500), 29);
    c.font = fc; c.letterSpacing = '4px'; const cw = c.measureText(cn).width - 4;
    c.font = fe; c.letterSpacing = '6px'; const ew = c.measureText(en).width - 6;
    const gap = 30, x0 = W / 2 - (cw + gap * 2 + 2 + ew) / 2;
    c.shadowColor = 'rgba(6,4,36,0.6)'; c.shadowBlur = 14; c.shadowOffsetY = 2;
    c.font = fc; c.letterSpacing = '4px'; c.fillStyle = WHITE(0.97); c.fillText(cn, x0, y);
    c.fillStyle = WHITE(0.55); c.fillRect(Math.round(x0 + cw + gap), y - 40, 2, 44);
    c.font = fe; c.letterSpacing = '6px'; c.fillStyle = WHITE(0.95); c.fillText(en, x0 + cw + gap * 2 + 2, y - 8);
    c.letterSpacing = '0px'; c.shadowBlur = 0; c.shadowOffsetY = 0; c.shadowColor = 'rgba(0,0,0,0)';
    L.upload();
    return r.a;
  }

  // ---------------------------------------------------------------- frame

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const r = this.ctx.renderer, t = f.t - this.ctx.start, cam = this.camera(t);
    const gain = kf(t, [[0, 0.78], [1.3, 1.0, 'ease'], [T.slider[0], 1.0, 'ease'], [T.slider[1], 1.08, 'ease'], [T.push[0], 1.08, 'ease'],
      [T.push[0] + 1.2, 1.16], [T.push[1] + 0.8, 1.04, 'ease']]);
    this.aurora.render(r, this.rtA, f.t, { gain, zoom: 1 + Math.max(0, cam.z - 300) * 1e-4, parallax: [cam.x * 0.35, cam.y * 0.35] });
    let cur = this.rtA;

    // the title lives BEHIND the glass: the parting panes frost it as they leave
    const titleA = this.drawTitle(t);
    if (titleA > 0) {
      const ws = this.wordScale(t), TL = this.TL;
      const [px, py] = this.toWord((TL.xs[0]! + TL.cx + RING_R) / 2, (TL.top + TL.bot) / 2, ws);
      const ks = Math.max(clamp((t - T.sweep[0]) / (T.sweep[1] - T.sweep[0])) * (t < T.sweep2[0] ? 1 : 0), clamp((t - T.sweep2[0]) / (T.sweep2[1] - T.sweep2[0])));
      this.title.render(r, this.rtA, this.rtB, {
        pool: { x: px, y: py + 30 * ws, hw: (TL.total / 2 + 120) * ws, hh: 170 * ws, k: span(t, T.title - 0.15, T.title + 0.85), radius: 170 * ws, falloff: 240 },
        center: [px, py], opacity: titleA, halo: 0.45, zoom: [W / 2, WC_Y, ws], lift: 0.2,   // a touch whiter than the kit default: reads on any part of the aurora
        sweep: [lerp(-620, 620, ease.inOutCubic(ks)) * ws, 70, ks > 0 && ks < 1 ? 0.42 * Math.sin(Math.PI * ks) : 0],
      });
      cur = this.rtB;
    }
    const subA = this.drawSub(t);
    if (subA > 0) {   // pushed with the title: zoom about (W/2, WC_Y) through the compositor's UV transform
      const k = 1 / this.wordScale(t), cv = 1 - WC_Y / H;
      this.ctx.comp.draw(r, this.sub.texture, cur, { opacity: subA, scale: [k, k], offset: [0, (cv - 0.5) * (1 - k)] });
    }

    // the panes, back to front, each frosting what is already behind it
    const states = CARDS.map((c) => this.cardState(c, t)).filter((s) => (s.look.opacity ?? 0) > 0.001).sort((a, b) => b.z - a.z);
    if (states.length) {
      const tex = this.drawAtlas(t, f.t);
      for (const s of states) this.cards.draw(r, cur, s.card, cam, s.look, { tex, rect: s.rect });
    }

    // the liquid glass drop over everything (always the last pass: cur → out)
    const L = this.lensState(t);
    this.lens.render(r, cur, out, L?.shape ?? null, L?.look);
    return { bloom: 0.22, bloomThreshold: 0.45, vignette: 0.18, grain: 0.035, shoulder: 0.5 };
  }
}

/** The assistant's avatar: a small aurora orb. */
function orb(c: CanvasRenderingContext2D, x: number, y: number, r: number) {
  const g = c.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
  g.addColorStop(0, '#E9E4FF'); g.addColorStop(0.35, '#9A7CFF'); g.addColorStop(0.75, '#3F55F0'); g.addColorStop(1, '#35C8EE');
  c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
  c.strokeStyle = WHITE(0.5); c.lineWidth = 1; c.beginPath(); c.arc(x, y, r - 0.5, 0, TAU); c.stroke();
}

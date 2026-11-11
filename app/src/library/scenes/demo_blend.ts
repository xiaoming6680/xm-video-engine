// 合成示例（?blend）：混合模式、轨道遮罩、预合成图层（engine/gl.ts 合成器一节、engine/precomp.ts）。从 0 秒开始，约 7 秒做完动作，
// 之后停在最后的样子慢慢浮动。用来看部件，不是画面标准。
//   上排  11 格对比。底图：天空、太阳（中心线性 3，HDR）、山、底部灰阶条；上层每格一样：左列白→黑渐变、中列 50% 灰、右列橙 / 青。
//         第 1 格只有底图，第 2 格是上层本身（normal），后面九格是读底色的模式。照 Photoshop 的直觉看：叠加 / 柔光 / 强光里 50% 灰
//         不改底图，太阳照样发光（泛光只吃 > 1.2 的 HDR，看得出高光余量留下来了）；变暗里灰压过太阳、变亮里太阳压过灰；
//         差值里白把底图反相、黑不变；减淡把亮处推白，加深把暗处压黑。
//   左下  轨道遮罩。「遮罩 MATTE」当 alpha 遮罩露出流动的画面；遮罩本身是一个带变换的预合成（字缩放进场、浮动、4.3 s 甩一下，
//         露出的范围跟着糊）；一道光用颜色减淡 + 同一张遮罩扫过字面（读底色的模式配遮罩）。下面四格是同一张遮罩源
//         （圆形 alpha、圆里左黑右白）在 alpha / alphaInv / luma / lumaInv 下露出的样子，画面是同一个流动预合成用 scale / offset 裁出来的。
//   右下  预合成。一张卡片：里面有自己的渐变、网格、按时间转的指针、弹跳的球（球又是卡片里带变换的一层）；整张卡飞进来、
//         2.5 s 转一圈、4.4 s 左右甩（看运动模糊、旋转边缘的抗锯齿）。右上角是同一个预合成按 0.5× 慢放的时间再渲一次
//         （滤色叠加、缩到 36%、开 mipmap），读数和指针都慢一半：时间重映射就是给预合成传换算过的 t。
import type * as THREE from 'three';
import { Scene, type Frame, type PostOverrides } from '../../engine/scene';
import { FSPass, Layer2D, W, H, type BlendMode, type MatteMode } from '../../engine/gl';
import { Precomp } from '../../engine/precomp';
import { F, font } from '../../engine/type';
import { clamp, ease, keys, prog, shutterT, type Key } from '../../engine/util';

// ---- layout (logical px)
const TW = 150, TH = 250, TG = 14, TX0 = (W - (11 * TW + 10 * TG)) / 2, TY0 = 104;
const tileX = (i: number) => TX0 + i * (TW + TG);
const TILES: { mode: BlendMode | null; zh: string; en: string }[] = [
  { mode: null, zh: '底图', en: 'backdrop' },
  { mode: 'normal', zh: '上层', en: 'normal' },
  { mode: 'overlay', zh: '叠加', en: 'overlay' },
  { mode: 'softLight', zh: '柔光', en: 'softLight' },
  { mode: 'hardLight', zh: '强光', en: 'hardLight' },
  { mode: 'colorDodge', zh: '颜色减淡', en: 'colorDodge' },
  { mode: 'colorBurn', zh: '颜色加深', en: 'colorBurn' },
  { mode: 'darken', zh: '变暗', en: 'darken' },
  { mode: 'lighten', zh: '变亮', en: 'lighten' },
  { mode: 'difference', zh: '差值', en: 'difference' },
  { mode: 'exclusion', zh: '排除', en: 'exclusion' },
];
const PL = { x: 65, y: 452, w: 880, h: 584 };    // track matte panel
const PR = { x: 975, y: 452, w: 880, h: 584 };   // precomp panel
// the four matte-mode swatches in the matte panel
const SWW = 190, SWH = 100, SWG = 16, SWX0 = PL.x + (PL.w - (4 * SWW + 3 * SWG)) / 2, SWY0 = PL.y + PL.h - SWH - 30;
const SWATCHES: MatteMode[] = ['alpha', 'alphaInv', 'luma', 'lumaInv'];
const swX = (i: number) => SWX0 + i * (SWW + SWG);
// the card precomp and its slowed-down echo
const CW = 520, CH = 320;
const CARD_AT: [number, number] = [PR.x + 400, PR.y + 340];
const ECHO_AT: [number, number] = [PR.x + PR.w - 110, PR.y + 100];
const T_ECHO = 1.6;
const echoTime = (t: number) => T_ECHO + (t - T_ECHO) * 0.5;

/** A GLSL float literal. */
const g = (x: number) => x.toFixed(2);

const BG_FRAG = /* glsl */ `
  const vec2 TS = vec2(${g(TW)}, ${g(TH)});
  const float TX0 = ${g(TX0)}, TY0 = ${g(TY0)}, TSTEP = ${g(TW + TG)};
  float rbox(vec2 p, vec2 c, vec2 hs, float r) { vec2 q = abs(p - c) - hs + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
  // the tiles' backdrop: a small sunset with an HDR sun (linear 3 in the core) and a grey ramp along the bottom
  vec3 backdrop(vec2 q) {
    vec2 uv = q / TS;
    vec3 c = toLinear(mix(vec3(0.10, 0.16, 0.42), vec3(0.98, 0.58, 0.30), smoothstep(0.02, 0.62, uv.y)));
    float d = length(q - vec2(0.5, 0.36) * TS);
    c += toLinear(vec3(1.0, 0.72, 0.42)) * 0.35 * exp(-max(d - 18.0, 0.0) / 14.0);
    c = mix(c, vec3(3.0, 2.6, 2.0), clamp((18.0 - d) * PX_SCALE + 0.5, 0.0, 1.0));
    float hy = (0.66 + 0.035 * sin(uv.x * 9.0 + 1.3) + 0.015 * sin(uv.x * 23.0)) * TS.y;
    vec3 hill = toLinear(mix(vec3(0.16, 0.27, 0.22), vec3(0.05, 0.09, 0.08), smoothstep(hy, 0.9 * TS.y, q.y)));
    c = mix(c, hill, clamp((q.y - hy) * PX_SCALE + 0.5, 0.0, 1.0));
    if (q.y > 0.88 * TS.y) c = toLinear(vec3(uv.x));
    return c;
  }
  void main() {
    vec2 p = vec2(FRAG_PX.x, ${g(H)} - FRAG_PX.y);   // logical px, y down
    vec3 col = toLinear(mix(vec3(0.075, 0.078, 0.09), vec3(0.045, 0.047, 0.055), p.y / ${g(H)}));
    // the two panels: raised fill, 1 px border
    for (int k = 0; k < 2; k++) {
      vec2 o = k == 0 ? vec2(${g(PL.x)}, ${g(PL.y)}) : vec2(${g(PR.x)}, ${g(PR.y)});
      vec2 hs = vec2(${g(PL.w)}, ${g(PL.h)}) * 0.5;
      float d = rbox(p, o + hs, hs, 14.0);
      col = mix(col, toLinear(vec3(0.098, 0.105, 0.122)), clamp(0.5 - d * PX_SCALE, 0.0, 1.0));
      col = mix(col, toLinear(vec3(0.18, 0.19, 0.215)), clamp(1.0 - abs(d + 0.5) * PX_SCALE, 0.0, 1.0));
    }
    // the matte swatches' wells
    for (int k = 0; k < 4; k++) {
      vec2 c = vec2(${g(SWX0)} + float(k) * ${g(SWW + SWG)}, ${g(SWY0)}) + vec2(${g(SWW)}, ${g(SWH)}) * 0.5;
      float d = rbox(p, c, vec2(${g(SWW)}, ${g(SWH)}) * 0.5, 6.0);
      col = mix(col, toLinear(vec3(0.055, 0.058, 0.068)), clamp(0.5 - d * PX_SCALE, 0.0, 1.0));
    }
    // the tiles
    float i = floor((p.x - TX0) / TSTEP);
    vec2 q = vec2(p.x - TX0 - i * TSTEP, p.y - TY0);
    if (i >= 0.0 && i < 11.0 && q.x >= 0.0 && q.x < TS.x && q.y >= 0.0 && q.y < TS.y) col = backdrop(q);
    fragColor = vec4(col, 1.0);
  }`;

// the footage the matte reveals: slow aurora-like colour with drifting stripes
const FOOTAGE_FRAG = /* glsl */ `
  uniform float t; uniform vec2 size;
  void main() {
    vec2 p = vec2(vUv.x, 1.0 - vUv.y) * size;
    float n = fbm(p * 0.0035 + vec2(0.13 * t, -0.05 * t), 4);
    float h = 0.00075 * p.x - 0.0004 * p.y + 0.55 * n + 0.06 * t;
    vec3 col = vec3(0.56, 0.42, 0.58) + vec3(0.44, 0.40, 0.42) * cos(6.28318 * (h + vec3(0.0, 0.18, 0.42)));
    float s = sin((p.x + 0.6 * p.y) * 0.045 - 3.0 * t);
    col *= 0.8 + 0.24 * smoothstep(-0.2, 0.6, s);
    fragColor = vec4(toLinear(clamp(col, 0.0, 1.0)), 1.0);
  }`;

// the card's own content: a diagonal gradient, a grid, a dial whose hand turns 90° per second of the precomp's time
const CARD_FRAG = /* glsl */ `
  uniform float t; uniform vec2 size;
  void main() {
    vec2 p = vec2(vUv.x, 1.0 - vUv.y) * size;
    vec3 col = mix(vec3(0.16, 0.20, 0.55), vec3(0.93, 0.36, 0.30), clamp(dot(p / size, vec2(0.62, 0.38)), 0.0, 1.0));
    vec2 g = abs(fract(p / 40.0 - 0.5) - 0.5) * 40.0;
    col = mix(col, vec3(1.0), 0.14 * clamp(1.0 - (min(g.x, g.y) - 0.5) * PX_SCALE, 0.0, 1.0));
    vec2 d = p - vec2(size.x - 72.0, 72.0);
    float r = length(d), ang = t * 1.5707963;
    vec2 dir = vec2(sin(ang), -cos(ang));
    float along = dot(d, dir), across = abs(dot(d, vec2(-dir.y, dir.x)));
    float ring = clamp(1.5 - abs(r - 44.0) * PX_SCALE, 0.0, 1.0);
    float hand = along > -4.0 && along < 40.0 ? clamp(2.0 - across * PX_SCALE, 0.0, 1.0) : 0.0;
    col = mix(col, vec3(1.0), max(0.85 * ring, hand));
    col = mix(col, vec3(1.0), clamp((5.0 - r) * PX_SCALE + 0.5, 0.0, 1.0));
    fragColor = vec4(toLinear(col), 1.0);
  }`;

const ink = (a: number) => `rgba(238,238,236,${a})`;
const dim = (a: number) => `rgba(150,152,160,${a})`;

export default class DemoBlend extends Scene {
  bg = new FSPass(BG_FRAG);
  footPass = new FSPass(FOOTAGE_FRAG, { t: { value: 0 }, size: { value: [PL.w, PL.h] } });
  cardPass = new FSPass(CARD_FRAG, { t: { value: 0 }, size: { value: [CW, CH] } });
  // static layers: drawn and uploaded once in init()
  probe = new Layer2D(TW, TH);
  text = new Layer2D(880, 340);
  swatchMatte = new Layer2D();
  shine = new Layer2D(240, 760);
  ui = new Layer2D();
  // precomps
  textMatte = new Precomp(W, H, { depth: false });
  footage = new Precomp(PL.w, PL.h, { depth: false });
  card = new Precomp(CW, CH, { mipmaps: true });
  ball = new Layer2D(64, 64, this.card.pxScale);
  labels = [new Layer2D(CW, CH, this.card.pxScale), new Layer2D(CW, CH, this.card.pxScale)];
  private labelKey = ['', ''];

  override init() {
    // the top layer of every tile: white→black | 50 % grey | orange / teal
    let c = this.probe.ctx;
    this.probe.clear();
    const g = c.createLinearGradient(0, 0, 0, TH);
    g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#000000');
    c.fillStyle = g; c.fillRect(0, 0, 50, TH);
    c.fillStyle = '#808080'; c.fillRect(50, 0, 50, TH);
    c.fillStyle = '#ff8a1f'; c.fillRect(100, 0, 50, TH / 2);
    c.fillStyle = '#1fa7c4'; c.fillRect(100, TH / 2, 50, TH / 2);
    this.probe.upload();

    // the track matte's type
    c = this.text.ctx;
    this.text.clear();
    c.fillStyle = '#ffffff';
    c.font = font(F.sans(900), 230);
    const zw = c.measureText('遮罩').width;
    c.font = font(F.sans(800), 88);
    const ew = Math.max(c.measureText('TRACK').width, c.measureText('MATTE').width);
    const k = Math.min(1, 820 / (zw + 30 + ew)), x0 = (880 - k * (zw + 30 + ew)) / 2;
    c.font = font(F.sans(900), 230 * k);
    c.fillText('遮罩', x0, 255);
    c.font = font(F.sans(800), 88 * k);
    c.fillText('TRACK', x0 + k * (zw + 30), 165);
    c.fillText('MATTE', x0 + k * (zw + 30), 255);
    this.text.upload();

    // the swatch matte source, full frame: a disc (alpha) filled black → white (luma)
    c = this.swatchMatte.ctx;
    this.swatchMatte.clear();
    SWATCHES.forEach((_, i) => {
      const cx = swX(i) + SWW / 2, cy = SWY0 + SWH / 2, r = 40;
      const gr = c.createLinearGradient(cx - r, 0, cx + r, 0);
      gr.addColorStop(0, '#000000'); gr.addColorStop(1, '#ffffff');
      c.fillStyle = gr;
      c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
    });
    this.swatchMatte.upload();

    // the light that sweeps over the type: a soft vertical band
    c = this.shine.ctx;
    this.shine.clear();
    const sg = c.createLinearGradient(0, 0, 240, 0);
    sg.addColorStop(0, 'rgba(255,246,228,0)'); sg.addColorStop(0.5, 'rgba(255,246,228,1)'); sg.addColorStop(1, 'rgba(255,246,228,0)');
    c.fillStyle = sg; c.fillRect(0, 0, 240, 760);
    this.shine.upload();

    // the ball inside the card
    c = this.ball.ctx;
    this.ball.clear();
    const bg = c.createRadialGradient(26, 24, 2, 32, 32, 28);
    bg.addColorStop(0, '#ffffff'); bg.addColorStop(1, '#ffd9a8');
    c.fillStyle = bg;
    c.beginPath(); c.arc(32, 32, 26, 0, Math.PI * 2); c.fill();
    this.ball.upload();

    // labels
    c = this.ui.ctx;
    this.ui.clear();
    c.fillStyle = ink(0.95);
    c.font = font(F.sans(700), 26);
    c.fillText('合成器', 65, 62);
    c.font = font(F.mono(400), 15);
    c.fillStyle = dim(1);
    c.fillText('Compositor.draw · 混合模式 / 轨道遮罩 / 图层变换 · Precomp', 160, 61);
    c.textAlign = 'right';
    c.fillText('上层：白→黑 | 50% 灰 | 橙 / 青    底图太阳中心 = 线性 3（泛光只吃 > 1.2）', W - 65, 61);
    c.textAlign = 'left';
    TILES.forEach((tl, i) => {
      c.fillStyle = ink(tl.mode && tl.mode !== 'normal' ? 0.95 : 0.6);
      c.font = font(F.sans(500), 20);
      c.fillText(tl.zh, tileX(i) + 2, TY0 + TH + 30);
      c.fillStyle = dim(1);
      c.font = font(F.mono(400), 13);
      c.fillText(tl.en, tileX(i) + 2, TY0 + TH + 50);
    });
    for (const [p, zh, en] of [[PL, '轨道遮罩', 'matte · 字当遮罩露出下面的画面；光用颜色减淡配同一张遮罩'], [PR, '预合成', 'Precomp · 自己的画布、自己的时间，当一个图层摆进来']] as const) {
      c.fillStyle = ink(0.95);
      c.font = font(F.sans(700), 24);
      c.fillText(zh, p.x + 26, p.y + 42);
      c.fillStyle = dim(1);
      c.font = font(F.mono(400), 14);
      c.fillText(en, p.x + 26 + (zh.length * 24 + 16), p.y + 41);
    }
    SWATCHES.forEach((m, i) => {
      c.fillStyle = dim(1);
      c.font = font(F.mono(400), 14);
      c.fillText(`matteMode '${m}'`, swX(i) + 2, SWY0 - 10);
    });
    c.textAlign = 'right';
    c.fillStyle = dim(1);
    c.font = font(F.sans(500), 16);
    c.fillText('同一个预合成，0.5× 慢放', ECHO_AT[0] - 110, ECHO_AT[1] - 6);
    c.font = font(F.mono(400), 13);
    c.fillText(`render(r, ${T_ECHO} + (t − ${T_ECHO}) × 0.5, …) · screen`, ECHO_AT[0] - 110, ECHO_AT[1] + 16);
    c.textAlign = 'left';
    this.ui.upload();
  }

  /** The card's content at precomp time `t`; `readout` is the frame's (crisp) time shown on it, `slot` picks a label layer. */
  private drawCard(t: number, readout: number, slot: number) {
    const r = this.ctx.renderer, comp = this.ctx.comp;
    this.card.render(r, t, (tt, out) => {
      this.cardPass.u.t!.value = tt;
      this.cardPass.render(r, out);
      // the ball: a layer inside the precomp, with its own transform (bounces, squashes on contact)
      const ph = ((tt / 0.8) % 1 + 1) % 1, hop = 4 * ph * (1 - ph);
      const sweep = ((tt * 0.25) % 2 + 2) % 2, bx = 60 + 330 * (sweep < 1 ? sweep : 2 - sweep);
      const sq = Math.max(0, 1 - Math.min(ph, 1 - ph) / 0.07) * 0.28;
      comp.draw(r, this.ball.texture, out, { transform: { position: [bx, 268 - 150 * hop], anchor: [32, 58], size: [64, 64], scale: [1 + sq, 1 - sq] } });
      const L = this.labels[slot]!, key = readout.toFixed(2);
      if (this.labelKey[slot] !== key) {
        this.labelKey[slot] = key;
        const c = L.ctx;
        L.clear();
        c.fillStyle = 'rgba(255,255,255,0.95)';
        c.font = font(F.mono(500), 22);
        c.fillText(`t = ${key} s`, 26, 44);
        c.font = font(F.sans(800), 58);
        c.fillText('PRECOMP', 26, 294);
        c.font = font(F.sans(500), 19);
        c.fillStyle = 'rgba(255,255,255,0.8)';
        c.fillText('里面的球、指针、读数都只看传进来的 t', 28, 226);
        L.upload();
      }
      comp.draw(r, L.texture, out);
    });
  }

  render(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    const r = this.ctx.renderer, comp = this.ctx.comp, t = f.t;
    this.bg.render(r, out);

    // ---- the blend-mode row: the same top layer over the same backdrop, mode by mode
    TILES.forEach((tl, i) => {
      if (!tl.mode) return;
      const a = ease.outCubic(clamp((t - 0.05 * i) / 0.4));
      if (a > 0) comp.draw(r, this.probe.texture, out, { mode: tl.mode, opacity: a, transform: { position: [tileX(i) + TW / 2, TY0 + TH / 2] } });
    });

    // ---- track matte: the type (a precomp with its own motion) reveals the footage
    const tin = prog(t, 0.15, 1.2, ease.outCubic);
    const whip = keys(t, [[4.3, 0], [4.62, -70, ease.inOutCubic], [5.1, 0, ease.inOutCubic]]);
    const drift = Math.max(0, t - 1.2);
    this.textMatte.render(r, t, (_, o) => comp.draw(r, this.text.texture, o, {
      opacity: clamp(tin * 1.6),
      transform: {
        position: [PL.x + PL.w / 2 + whip, PL.y + 240 + 6 * Math.sin(1.3 * drift)],
        scale: 1.35 - 0.35 * tin,
        rotation: -6 * (1 - tin) + 1.2 * Math.sin(0.9 * drift),
      },
    }));
    this.footage.render(r, t, (tt, o) => { this.footPass.u.t!.value = tt; this.footPass.render(r, o); });
    const panelC: [number, number] = [PL.x + PL.w / 2, PL.y + PL.h / 2];
    this.footage.draw(r, comp, out, { transform: { position: panelC }, matte: this.textMatte.texture, mattePremult: false });
    // a read-back mode with the same matte: the light only lands on the letters
    const sweep = t < 4 ? prog(t, 2.3, 3.5, ease.inOutCubic) : prog(t, 5.6, 6.8, ease.inOutCubic);
    if (sweep > 0 && sweep < 1) comp.draw(r, this.shine.texture, out, {
      mode: 'colorDodge', matte: this.textMatte.texture, mattePremult: false,
      transform: { position: [PL.x - 160 + (PL.w + 320) * sweep, PL.y + 240], rotation: 18 },
    });
    // the four matte modes, each a crop of the same footage (the old scale / offset UV transform, inside the layer)
    const kx = SWW / PL.w, ky = SWH / PL.h;
    SWATCHES.forEach((m, i) => {
      const lx = swX(i) - PL.x, ly = SWY0 - PL.y;
      comp.draw(r, this.footage.texture, out, {
        premult: false, scale: [kx, ky], offset: [lx / PL.w - 0.5 + 0.5 * kx, 1 - (ly + SWH) / PL.h - 0.5 + 0.5 * ky],
        transform: { position: [swX(i) + SWW / 2, SWY0 + SWH / 2], size: [SWW, SWH] },
        matte: this.swatchMatte.texture, matteMode: m,
      });
    });

    // ---- precomp: the card flies in, spins, whips; its echo runs at half speed
    const tf = shutterT(t, 0);   // the frame's own time, for the readouts (crisp)
    const ea = clamp((t - T_ECHO) / 0.4);
    if (ea > 0) {
      this.drawCard(echoTime(t), echoTime(tf), 0);
      this.card.draw(r, comp, out, { mode: 'screen', opacity: ea, transform: { position: ECHO_AT, scale: 0.36, rotation: 8 } });
    }
    const fly = prog(t, 0.2, 1.3, ease.outCubic);
    const K = (ks: Key[]) => keys(t, ks);
    const x = CARD_AT[0] + 760 * (1 - fly) + K([[4.4, 0], [4.75, -120, ease.inOutCubic], [5.2, 0, ease.inOutCubic]]);
    const y = CARD_AT[1] + 60 * (1 - fly) + 6 * Math.sin(1.7 * Math.max(0, t - 1.3));
    const rot = 40 * (1 - fly) - 4 * fly * Math.exp(-2.5 * Math.max(0, t - 1.3)) * Math.cos(7 * Math.max(0, t - 1.3))
      + K([[2.5, 0], [3.7, 360, ease.inOutCubic]]) + 1.5 * Math.sin(1.3 * Math.max(0, t - 1.3));
    const sc = (0.55 + 0.45 * fly) * K([[2.5, 1], [3.1, 0.72, ease.inOutCubic], [3.7, 1, ease.inOutCubic]]);
    if (fly > 0) {
      this.drawCard(t, tf, 1);
      this.card.draw(r, comp, out, { transform: { position: [x, y], scale: sc, rotation: rot } });
    }

    comp.draw(r, this.ui.texture, out);
    return { bloom: 0.6, bloomThreshold: 1.2, bloomKnee: 0.2 };
  }
}

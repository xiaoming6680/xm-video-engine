// The flat-design worlds (docs/TREATMENT.md, 画面语言 · 平面设计): each shot is a paper theatre — flat, cut-paper
// layers (Canvas2D) standing at different depths in a three.js scene, so a moving camera gives real parallax and the
// layers throw soft shadows on the ones behind. Figures are pictograms (Otl Aicher / Olympic style: round head,
// straight limbs with round caps, gaps where limbs cross), colour is flat (3–5 per world + ink + paper), type is
// part of the picture. Helpers here: the stage, rough cut edges, halftone, paper fibre, pictogram figures.
//
// 后半（「拼贴」一节）是定格拼贴的 2D 做法：纸片剧场在 Clarity 被说「劣质感」，查下来是 3D 相机按 60 fps 平滑滑过各层
// （数字感）、roughPath 的边是噪声不像剪刀剪的、影子烘死在图层里、纸纹是程序画的。拼贴一节照定格动画重写：按 12 fps
// 步进 + 手放抖动、剪刀边是几刀直线、撕边带白色纤维、照片真半调、扫描纸纹、影子随抬起高度、机位按 6 fps 步进。
// 上面 Clarity 时代的函数（PaperStage、roughPath、cut 的默认影子……）行为不变。
import * as THREE from 'three';
import { clamp, hash, lerp, ease, noise1, noise2, stepT, handJitter, smoothstep, TAU } from '../../engine/util';
import { W, H, SCALE, Layer2D } from '../../engine/gl';
import { slap, liftShadow, type Pose as LiftPose, type SlapOpts, type ShadowOpts } from '../kit/tactile';

export const INK = '#17150f';
export const PAPER = '#f1ebdd';

type Draw = (c: CanvasRenderingContext2D, w: number, h: number) => void;
export interface Layer { mesh: THREE.Mesh; cv: HTMLCanvasElement; c: CanvasRenderingContext2D; tex: THREE.CanvasTexture; draw: Draw; }

/** Redraw a layer's canvas (dynamic layers: running figures, bursts). `draw` gets the cleared context. */
export function redraw(L: Layer, draw: Draw, pad = 0) {
  const c = L.c; c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, L.cv.width, L.cv.height);
  c.translate(pad, pad); draw(c, L.cv.width - pad * 2, L.cv.height - pad * 2);
  L.tex.needsUpdate = true;
}

/**
 * A stage whose z = 0 plane shows exactly the designed W x H px frame (src/config.ts) when the camera is at rest. `layer()`
 * places a canvas at depth z (negative = farther) scaled so that it still appears at its designed px rect at rest.
 */
export class PaperStage {
  scene = new THREE.Scene();
  cam: THREE.PerspectiveCamera;
  D: number;
  layers: Layer[] = [];
  constructor(public fov = 28) {
    this.cam = new THREE.PerspectiveCamera(fov, W / H, 5, 200000);
    this.D = (H / 2) / Math.tan(((fov / 2) * Math.PI) / 180);
    this.cam.position.set(0, 0, this.D);
  }
  private canvasLayer(w: number, h: number, draw: Draw) {
    const cv = document.createElement('canvas'); cv.width = Math.ceil(w); cv.height = Math.ceil(h);
    const c = cv.getContext('2d')!;
    draw(c, cv.width, cv.height);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    return { cv, c, tex, mat };
  }
  /** A flat layer covering the designed px rect (x, y, w, h) at depth z (with `pad` px of bleed on every side). */
  /**
   * `pivot` puts the mesh origin on the layer's bottom or top edge (pop-up: rotate x about the bottom edge; unroll:
   * scale y from the top edge).
   */
  layer(o: { x?: number; y?: number; w?: number; h?: number; z: number; draw: Draw; pad?: number; order?: number; pivot?: 'bottom' | 'top' }) {
    const pad = o.pad ?? 0, x = (o.x ?? 0) - pad, y = (o.y ?? 0) - pad, w = (o.w ?? W) + pad * 2, h = (o.h ?? H) + pad * 2;
    const k = (this.D - o.z) / this.D;
    const { cv, c, tex, mat } = this.canvasLayer(w, h, (cc, ww, hh) => { cc.translate(pad, pad); o.draw(cc, ww - pad * 2, hh - pad * 2); });
    const geo = new THREE.PlaneGeometry(w * k, h * k);
    const dy = o.pivot === 'bottom' ? (h * k) / 2 : o.pivot === 'top' ? -(h * k) / 2 : 0;
    geo.translate(0, dy, 0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set((x + w / 2 - W / 2) * k, (H / 2 - (y + h / 2)) * k - dy, o.z);
    mesh.renderOrder = o.order ?? o.z; // far layers first
    this.scene.add(mesh);
    const L = { mesh, cv, c, tex, draw: o.draw };
    this.layers.push(L);
    return L;
  }
  /** A free plane in world units (e.g. a map lying on the ground): canvas px w x h, world size sw x sh. */
  plane(o: { w: number; h: number; sw: number; sh: number; pos: [number, number, number]; rot?: [number, number, number]; draw: Draw; order?: number }) {
    const { cv, c, tex, mat } = this.canvasLayer(o.w, o.h, o.draw);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(o.sw, o.sh), mat);
    mesh.position.set(...o.pos);
    if (o.rot) mesh.rotation.set(...o.rot);
    mesh.renderOrder = o.order ?? 0;
    this.scene.add(mesh);
    const L = { mesh, cv, c, tex, draw: o.draw };
    this.layers.push(L);
    return L;
  }
  /** Designed px (x right, y down) at depth z -> world position. */
  at(x: number, y: number, z: number) { const k = (this.D - z) / this.D; return new THREE.Vector3((x - W / 2) * k, (H / 2 - y) * k, z); }
}

/** Paper: a base colour with fibres and a faint mottle. */
export function paper(c: CanvasRenderingContext2D, w: number, h: number, base: string, seed = 1, amt = 1) {
  c.fillStyle = base; c.fillRect(0, 0, w, h);
  const n = Math.floor((w * h) / 900 * amt);
  for (let i = 0; i < n; i++) {
    const x = hash(i, seed, 1) * w, y = hash(i, seed, 2) * h, l = 3 + hash(i, seed, 3) * 10, a = hash(i, seed, 4) * Math.PI;
    c.strokeStyle = hash(i, seed, 5) > 0.5 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)';
    c.lineWidth = 0.6 + hash(i, seed, 6);
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke();
  }
  for (let i = 0; i < 60 * amt; i++) {
    const x = hash(i, seed, 7) * w, y = hash(i, seed, 8) * h, r = 40 + hash(i, seed, 9) * 160;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, hash(i, seed, 10) > 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.03)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

/** A polygon with cut-paper edges: edges subdivided every `step` px and nudged by up to `amp` px. */
export function roughPath(pts: [number, number][], amp = 1.2, seed = 1, step = 14, closed = true) {
  const p = new Path2D();
  const n = pts.length;
  let first = true;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const [x0, y0] = pts[i]!, [x1, y1] = pts[(i + 1) % n]!;
    const L = Math.hypot(x1 - x0, y1 - y0), k = Math.max(1, Math.round(L / step)), nx = -(y1 - y0) / (L || 1), ny = (x1 - x0) / (L || 1);
    for (let j = 0; j < k; j++) {
      const u = j / k, d = j === 0 ? 0 : (hash(i, j, seed) - 0.5) * 2 * amp;
      const x = x0 + (x1 - x0) * u + nx * d, y = y0 + (y1 - y0) * u + ny * d;
      if (first) { p.moveTo(x, y); first = false; } else p.lineTo(x, y);
    }
  }
  if (closed) p.closePath(); else p.lineTo(...pts[n - 1]!);
  return p;
}

/**
 * Fill a path with a soft paper shadow under it (the layer's own drop shadow). `shadow` is [dx, dy, blur, alpha], or a
 * number: the height the piece is lifted above the table (kit/tactile.ts liftShadow: 0 = lying on it, 1 = held up at
 * the camera), scaled with the current transform's zoom.
 */
export function cut(c: CanvasRenderingContext2D, path: Path2D, fill: string | CanvasGradient | CanvasPattern, shadow: [number, number, number, number] | number | null = [0, 6, 16, 0.28]) {
  c.save();
  if (typeof shadow === 'number') {
    const m = c.getTransform(), k = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)), s = liftShadow(shadow);
    shadow = [s[0] * k, s[1] * k, s[2] * k, s[3]];
  }
  if (shadow) { c.shadowOffsetX = shadow[0]; c.shadowOffsetY = shadow[1]; c.shadowBlur = shadow[2]; c.shadowColor = `rgba(20,14,8,${shadow[3]})`; }
  c.fillStyle = fill; c.fill(path);
  c.restore();
}

/** Halftone dots clipped to `path`: dot radius = cell/2 * f(x, y) (0..1), grid rotated by `angle`. */
export function halftone(c: CanvasRenderingContext2D, path: Path2D, color: string, cell: number, angle: number, f: (x: number, y: number) => number, box: [number, number, number, number]) {
  c.save(); c.clip(path); c.fillStyle = color;
  const [bx, by, bw, bh] = box, cx = bx + bw / 2, cy = by + bh / 2, R = Math.hypot(bw, bh) / 2 + cell, ca = Math.cos(angle), sa = Math.sin(angle);
  for (let v = -R; v <= R; v += cell) for (let u = -R; u <= R; u += cell) {
    const x = cx + u * ca - v * sa, y = cy + u * sa + v * ca;
    if (x < bx - cell || y < by - cell || x > bx + bw + cell || y > by + bh + cell) continue;
    const r = (cell / 2) * Math.min(1.2, Math.max(0, f(x, y)));
    if (r < 0.3) continue;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  }
  c.restore();
}

// ------------------------------------------------------------------ pictograms
/** Joint angles (rad, 0 = straight down, + = towards the facing direction) and torso lean (+ = forward). */
export interface Pose { lean: number; armF: [number, number]; armB: [number, number]; legF: [number, number]; legB: [number, number]; head?: number }
export const POSES = {
  run: { lean: 0.32, armF: [-0.9, 0.5], armB: [1.1, 2.3], legF: [1.15, 0.1], legB: [-0.55, -1.6] } as Pose,
  run2: { lean: 0.3, armF: [1.0, 2.2], armB: [-0.8, 0.4], legF: [-0.5, -1.5], legB: [1.1, 0.2] } as Pose,
  stand: { lean: 0, armF: [0.15, 0.1], armB: [-0.15, -0.1], legF: [0.08, 0.02], legB: [-0.08, -0.02], head: -0.25 } as Pose,
  aim: { lean: 0.12, armF: [1.45, 1.6], armB: [0.9, 1.65], legF: [0.35, 0.05], legB: [-0.35, -0.05] } as Pose,
};
export interface Gear { helmet?: string; pack?: string; rifle?: string; band?: string; cloak?: string }

/**
 * A pictogram at hip (x, y), height ~s (feet to head top), facing right (dir 1) or left (-1), in `col`; limbs that
 * cross the body get a gap in `gap` (the background colour), as in the classic pictograms.
 */
export function pictogram(c: CanvasRenderingContext2D, pose: Pose, x: number, y: number, s: number, col: string, gap: string, dir: 1 | -1 = 1, gear: Gear = {}) {
  const lw = s * 0.12, tw = s * 0.2, thigh = s * 0.27, shin = s * 0.27, upper = s * 0.2, fore = s * 0.19;
  const V = (a: number, l: number): [number, number] => [Math.sin(a) * l * dir, Math.cos(a) * l];
  const sh: [number, number] = [x + Math.sin(pose.lean) * s * 0.34 * dir, y - Math.cos(pose.lean) * s * 0.34];
  const head: [number, number] = [sh[0] + Math.sin(pose.lean + (pose.head ?? 0)) * s * 0.17 * dir, sh[1] - Math.cos(pose.lean + (pose.head ?? 0)) * s * 0.17];
  const seg = (a: [number, number], ang: [number, number], l1: number, l2: number, w: number) => {
    const b: [number, number] = [a[0] + V(ang[0], l1)[0], a[1] + V(ang[0], l1)[1]];
    const e: [number, number] = [b[0] + V(ang[1], l2)[0], b[1] + V(ang[1], l2)[1]];
    return { a, b, e, w };
  };
  const limb = (L: { a: [number, number]; b: [number, number]; e: [number, number]; w: number }, withGap: boolean) => {
    c.lineCap = 'round'; c.lineJoin = 'round';
    if (withGap) { c.strokeStyle = gap; c.lineWidth = L.w + s * 0.05; c.beginPath(); c.moveTo(...L.a); c.lineTo(...L.b); c.lineTo(...L.e); c.stroke(); }
    c.strokeStyle = col; c.lineWidth = L.w; c.beginPath(); c.moveTo(...L.a); c.lineTo(...L.b); c.lineTo(...L.e); c.stroke();
  };
  const hip: [number, number] = [x, y];
  const legB = seg(hip, pose.legB, thigh, shin, lw * 1.12), armB = seg(sh, pose.armB, upper, fore, lw);
  const legF = seg(hip, pose.legF, thigh, shin, lw * 1.12), armF = seg(sh, pose.armF, upper, fore, lw);
  limb(legB, false); limb(armB, false);
  if (gear.pack) { c.save(); c.translate((x + sh[0]) / 2 - Math.cos(pose.lean) * tw * 0.75 * dir, (y + sh[1]) / 2 - Math.sin(pose.lean) * tw * 0.3); c.rotate(pose.lean * dir); c.fillStyle = gear.pack; c.beginPath(); c.roundRect(-tw * 0.5, -s * 0.15, tw * 0.9, s * 0.28, s * 0.03); c.fill(); c.restore(); }
  // torso
  c.lineCap = 'round'; c.strokeStyle = col; c.lineWidth = tw; c.beginPath(); c.moveTo(...hip); c.lineTo(...sh); c.stroke();
  if (gear.cloak) { c.fillStyle = gear.cloak; c.beginPath(); c.moveTo(sh[0] - tw * 0.6, sh[1]); c.lineTo(sh[0] + tw * 0.6, sh[1]); c.lineTo(x + tw * 1.3, y + s * 0.12); c.lineTo(x - tw * 1.3, y + s * 0.12); c.fill(); }
  limb(legF, true);
  // head
  c.fillStyle = col; c.beginPath(); c.arc(head[0], head[1], s * 0.1, 0, Math.PI * 2); c.fill();
  if (gear.helmet) { c.fillStyle = gear.helmet; c.beginPath(); c.arc(head[0], head[1] - s * 0.01, s * 0.115, Math.PI * 1.02, Math.PI * 1.98); c.fill(); c.fillRect(head[0] - s * 0.125, head[1] - s * 0.02, s * 0.25, s * 0.025); }
  limb(armF, true);
  if (gear.band) { const m: [number, number] = [(armF.a[0] + armF.b[0]) / 2, (armF.a[1] + armF.b[1]) / 2]; c.fillStyle = gear.band; c.beginPath(); c.arc(m[0], m[1], lw * 0.55, 0, Math.PI * 2); c.fill(); }
  if (gear.rifle) {
    const hnd = armF.e, ang = Math.atan2(armF.e[1] - armF.b[1], armF.e[0] - armF.b[0]) - 0.9 * dir;
    c.strokeStyle = gear.rifle; c.lineWidth = s * 0.05; c.lineCap = 'butt';
    c.beginPath(); c.moveTo(hnd[0] - Math.cos(ang) * s * 0.18, hnd[1] - Math.sin(ang) * s * 0.18); c.lineTo(hnd[0] + Math.cos(ang) * s * 0.3, hnd[1] + Math.sin(ang) * s * 0.3); c.stroke();
  }
  return { head, feet: [legF.e, legB.e] };
}

/** A run cycle between the two stride poses; phase in cycles (one cycle = two footfalls). */
export function runPose(phase: number): Pose {
  const w = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2), a = POSES.run, b = POSES.run2;
  const L = (x: number, y: number) => x + (y - x) * w;
  const L2 = (x: [number, number], y: [number, number]): [number, number] => [L(x[0], y[0]), L(x[1], y[1])];
  return { lean: L(a.lean, b.lean), armF: L2(a.armF, b.armF), armB: L2(a.armB, b.armB), legF: L2(a.legF, b.legF), legB: L2(a.legB, b.legB) };
}

/** A pictogram running away from us (back view): torso, head, one leg kicked up behind, arms pumping. */
export function pictoBack(c: CanvasRenderingContext2D, phase: number, x: number, y: number, s: number, col: string, gear: Gear = {}) {
  const k = Math.sin(phase * Math.PI * 2), lw = s * 0.12, hip = s * 0.08;
  c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = col;
  const bob = -Math.abs(k) * s * 0.03;
  const leg = (side: number, up: number) => {
    const hx = x + side * hip, hy = y + bob, kx = hx + side * s * 0.04, ky = hy + s * (0.27 - up * 0.1), fx = kx + side * s * 0.02, fy = ky + s * (0.27 - up * 0.42);
    c.lineWidth = lw * 1.12; c.beginPath(); c.moveTo(hx, hy); c.lineTo(kx, ky); c.lineTo(fx, fy); c.stroke();
  };
  leg(-1, Math.max(0, k)); leg(1, Math.max(0, -k));
  const sy = y + bob - s * 0.34;
  c.lineWidth = s * 0.22; c.beginPath(); c.moveTo(x, y + bob); c.lineTo(x, sy); c.stroke();
  const arm = (side: number, sw: number) => {
    c.lineWidth = lw; c.beginPath(); c.moveTo(x + side * s * 0.12, sy + s * 0.02);
    c.lineTo(x + side * s * 0.2, sy + s * (0.16 - sw * 0.08)); c.lineTo(x + side * s * 0.16, sy + s * (0.3 - sw * 0.2)); c.stroke();
  };
  arm(-1, k); arm(1, -k);
  if (gear.pack) { c.fillStyle = gear.pack; c.beginPath(); c.roundRect(x - s * 0.11, sy + s * 0.04, s * 0.22, s * 0.2, s * 0.03); c.fill(); }
  c.fillStyle = col; c.beginPath(); c.arc(x, sy - s * 0.15, s * 0.1, 0, Math.PI * 2); c.fill();
  if (gear.band) { c.fillStyle = gear.band; c.beginPath(); c.arc(x - s * 0.19, sy + s * 0.1, lw * 0.5, 0, Math.PI * 2); c.fill(); }
}

/** Flat ground shadow: a squashed ellipse. */
export function footShadow(c: CanvasRenderingContext2D, x: number, y: number, w: number, a = 0.22) {
  c.fillStyle = `rgba(30,20,10,${a})`; c.beginPath(); c.ellipse(x, y, w, w * 0.14, 0, 0, Math.PI * 2); c.fill();
}

/** A 4-point sparkle star (the wish / the stars). */
export function sparkle(c: CanvasRenderingContext2D, x: number, y: number, r: number, col: string, thin = 0.16) {
  c.fillStyle = col; c.beginPath();
  for (let i = 0; i < 8; i++) { const rr = i % 2 ? r * thin : r, a = (i / 8) * Math.PI * 2 - Math.PI / 2; c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
  c.closePath(); c.fill();
}

// ================================================================== 拼贴（2D、按拍步进）
// 定格拼贴：桌上一张纸，剪下来的纸片一张张被手拍上去。参考 mg-styles-15 demos/06-collage（MIT，Vincentwei1021）
// 的 index.html 和 work/prep.py 重写。要点和数字都取自那支片：
// - 节奏：所有动作按 12 fps 步进，每步手放抖动约 2 px；落定的纸片按 6 fps 抖约 1.1 px（pastePose / boil）。
//   落纸用 kit/tactile.ts 的 slap，影子随抬起高度（liftShadow / drawLifted）：落地那一步压扁 .972，下一步 1.01
// - 剪刀边：轮廓外扩出白边，再用 Douglas–Peucker 拉成几刀直线、顶点微偏 ±0.7 px（scissorPoints；
//   位图用 scissorSprite：alpha 开运算、膨胀、闭运算填掉剪刀进不去的凹口，描出轮廓再拉直）
// - 撕边：4 个八度的正弦叠加（波长 1、1/3、1/9、1/27，权重 1、.5、.25、.12）加细噪声，外面一圈露出的白色
//   纸芯带纤维（tearShape / drawTorn）
// - 照片：真半调 6.5 px、45°，底下垫 30 % 连续调（报纸翻印的样子；halftoneMono）
// - 纸：扫描纸 textures/paper001.jpg（ambientCG，CC0）的纸齿按颜色调成各色纸（paperSheet），纹理跟着纸片走
// - 机位：按 6 fps 步进的翻拍台，最多推近到 1.06；镜头不在层间穿行，是纸片自己落下、开合、撕开（rostrum）
// - 收尾：颗粒按步偏移、灰尘每两步换一张、暖色暗角 0.28（CollageFinish）
// 整套装在 CollageStage 里（一张 Layer2D）。示例：scenes/demo_paper.ts（?paper）。照片素材的离线预处理
// （剪刀白边、撕边、半调、木偶切片）用 tools/assets/collage.py。

/** A point in logical px (x right, y down). */
export type Pt = [number, number];

/** Signed area of a closed polygon; positive when it runs clockwise on screen (y down). */
export function polyArea(pts: readonly Pt[]): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) { const p = pts[i]!, q = pts[(i + 1) % n]!; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}

const outNormal = (a: Pt, b: Pt, s: number): Pt => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
  return L < 1e-9 ? [0, 0] : [(s * dy) / L, (-s * dx) / L];
};

/** A closed polygon pushed outward by `d` px (negative = inward), each vertex along its mitred normal (miter capped at 3d). */
export function offsetPoly(pts: readonly Pt[], d: number): Pt[] {
  const n = pts.length, s = polyArea(pts) >= 0 ? 1 : -1, out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n]!, q = pts[i]!, r = pts[(i + 1) % n]!;
    const n2 = outNormal(q, r, s), a1 = outNormal(p, q, s), n1 = a1[0] || a1[1] ? a1 : n2; // a zero-length edge: use the other
    let mx = n1[0] + n2[0], my = n1[1] + n2[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) { mx = n1[0]; my = n1[1]; } else { mx /= ml; my /= ml; }
    const cos = mx * n1[0] + my * n1[1], k = Math.min(3, 1 / Math.max(cos, 1e-3));
    out.push([q[0] + mx * d * k, q[1] + my * d * k]);
  }
  return out;
}

function dpOpen(pts: readonly Pt[], eps: number): Pt[] {
  const n = pts.length;
  if (n < 3) return pts.map((p) => [p[0], p[1]] as Pt);
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a]!, [bx, by] = pts[b]!, dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i]!;
      const d = L < 1e-9 ? Math.hypot(px - ax, py - ay) : Math.abs(dx * (py - ay) - dy * (px - ax)) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push([pts[i]![0], pts[i]![1]]);
  return out;
}

/**
 * Douglas–Peucker on a closed polygon: no point of the original lies further than `eps` from the result, which keeps
 * only the vertices the shape needs (a densely sampled circle becomes a polygon of straight facets).
 */
export function simplifyPoly(pts: readonly Pt[], eps: number): Pt[] {
  const n = pts.length;
  if (n < 4 || eps <= 0) return pts.map((p) => [p[0], p[1]] as Pt);
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) { const d = Math.hypot(pts[i]![0] - pts[0]![0], pts[i]![1] - pts[0]![1]); if (d > fd) { fd = d; far = i; } }
  const A = dpOpen(pts.slice(0, far + 1), eps), B = dpOpen([...pts.slice(far), pts[0]!], eps);
  const out = [...A, ...B.slice(1, -1)];
  // vertex 0 was kept only because the split started there: drop it when it lies on the facet through its neighbours
  if (out.length > 3) {
    const p = out[out.length - 1]!, q = out[0]!, r = out[1]!, dx = r[0] - p[0], dy = r[1] - p[1], L = Math.hypot(dx, dy);
    if (L > 1e-9 && Math.abs(dx * (q[1] - p[1]) - dy * (q[0] - p[0])) / L <= eps) out.shift();
  }
  return out;
}

export interface ScissorOpts {
  /** White border (px) left around the shape: the outline is pushed out by this much first. */
  rim?: number;
  /** Straightness: no facet strays more than `eps` px from the outline (default max(2, rim · 0.7), as 06 prep.py). */
  eps?: number;
  /** Slow wander (px) of the outline before straightening, so the facets come out of uneven length (default 0.8 eps). */
  wobble?: number;
  /** Final nudge of each corner (±px, default 0.7). */
  jitter?: number;
  seed?: number;
}

/**
 * Scissor-cut outline of a closed shape (dense points, any orientation): pushed out by `rim`, straightened into a few
 * long cuts (Douglas–Peucker), corners nudged. Reads as cut with scissors; roughPath's per-14-px noise reads as noise.
 */
export function scissorPoints(pts: readonly Pt[], o: ScissorOpts = {}): Pt[] {
  const rim = o.rim ?? 0, eps = o.eps ?? Math.max(2, rim * 0.7), wob = o.wobble ?? eps * 0.8, jit = o.jitter ?? 0.7, seed = o.seed ?? 1;
  let p: Pt[] = rim ? offsetPoly(pts, rim) : pts.map((q) => [q[0], q[1]] as Pt);
  if (wob > 0 && p.length > 2) {
    const s = polyArea(p) >= 0 ? 1 : -1, n = p.length, src = p;
    let arc = 0;
    p = src.map((q, i) => {
      if (i) arc += Math.hypot(q[0] - src[i - 1]![0], q[1] - src[i - 1]![1]);
      const nn = outNormal(src[(i + n - 1) % n]!, src[(i + 1) % n]!, s), w = noise1(arc / 41, seed * 7 + 3) * wob;
      return [q[0] + nn[0] * w, q[1] + nn[1] * w] as Pt;
    });
  }
  p = simplifyPoly(p, eps);
  if (jit > 0) p = p.map(([x, y], i) => [x + (hash(i, seed, 11) * 2 - 1) * jit, y + (hash(i, seed, 12) * 2 - 1) * jit] as Pt);
  return p;
}

/** Points on a circle, clockwise on screen, about every 3 px (or `n`). */
export function circlePts(cx: number, cy: number, r: number, n = 0): Pt[] {
  const k = n || Math.max(24, Math.round((TAU * r) / 3));
  return Array.from({ length: k }, (_, i) => [cx + Math.cos((i / k) * TAU) * r, cy + Math.sin((i / k) * TAU) * r] as Pt);
}

/** A rectangle's corners, clockwise on screen from the top left. */
export function rectPts(x: number, y: number, w: number, h: number): Pt[] {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

/** A closed polygon as a Path2D. */
export function polyPath(pts: readonly Pt[]): Path2D {
  const p = new Path2D();
  pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y)));
  p.closePath();
  return p;
}

/** scissorPoints as a Path2D. */
export function scissorPath(pts: readonly Pt[], o: ScissorOpts = {}): Path2D {
  return polyPath(scissorPoints(pts, o));
}

export interface TornOpts {
  /** Size of the tear (px): the edge strays about this far from the straight line. */
  amp?: number;
  /** Wavelength (px) of the slowest of the four octaves (the others are 1/3, 1/9, 1/27 of it). */
  wave?: number;
  /** Point spacing (px). */
  step?: number;
  /** Fine per-point noise, as a fraction of amp. */
  fine?: number;
  seed?: number;
}

function tearProfile(seed: number, wave: number) {
  return [[1, 1], [3, 0.5], [9, 0.25], [27, 0.12]].map(([k, a], j) => ({
    f: (k! * TAU) / wave, a: a! * (0.6 + 0.4 * hash(seed, j, 21)), ph: hash(seed, j, 22) * TAU,
  }));
}

/**
 * A torn edge from p0 to p1 (both included, the ends pinned so torn edges join at corners): four octaves of sines plus
 * fine noise off the straight line (06 prep.py torn_edge), about `amp` px.
 */
export function tornEdge(p0: Pt, p1: Pt, o: TornOpts = {}): Pt[] {
  const amp = o.amp ?? 8, wave = o.wave ?? 260, step = o.step ?? 3, fine = o.fine ?? 0.15, seed = o.seed ?? 1;
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], L = Math.hypot(dx, dy);
  if (L < 1e-6) return [[p0[0], p0[1]], [p1[0], p1[1]]];
  const nx = -dy / L, ny = dx / L, n = Math.max(2, Math.ceil(L / step)), oct = tearProfile(seed, wave), ta = Math.min(L / 2, amp * 3);
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, s = u * L;
    let off = 0;
    for (const q of oct) off += q.a * Math.sin(s * q.f + q.ph);
    off += (hash(seed, i, 23) + hash(seed, i, 24) + hash(seed, i, 25) - 1.5) * 2 * fine;
    const d = off * amp * smoothstep(0, ta, s) * smoothstep(0, ta, L - s);
    out.push([p0[0] + dx * u + nx * d, p0[1] + dy * u + ny * d]);
  }
  return out;
}

export interface TearOpts extends TornOpts {
  /** Which edges are torn (edge i runs from point i to i + 1); false = a straight cut. Default: all torn. */
  edges?: readonly boolean[];
  /** Width (px) of the white paper core showing along torn edges (0 = none). */
  rim?: number;
  /** Fibres per 100 px of torn edge, sticking out of the rim. */
  fibres?: number;
}

/** A torn piece: its outline, the white rim bands along the torn edges, and loose fibres [x0, y0, x1, y1, width]. */
export interface Tear { outline: Pt[]; rims: Pt[][]; fibres: [number, number, number, number, number][] }

/**
 * The white core showing along a torn edge `e` (points), on the side of the unit normal `n`: a band of uneven width
 * (about `rim` px, pinched at the ends) and `fpc` fibres per 100 px poking out of it.
 */
function rimBand(e: readonly Pt[], n: Pt, rim: number, seed: number, wave: number, fpc: number) {
  let L = 0;
  for (let j = 1; j < e.length; j++) L += Math.hypot(e[j]![0] - e[j - 1]![0], e[j]![1] - e[j - 1]![1]);
  const prof = tearProfile(seed, wave);
  const outer = e.map(([x, y], j) => {
    const u = j / (e.length - 1);
    let w = 0;
    for (const q of prof) w += q.a * Math.sin(u * L * q.f + q.ph);
    const k = clamp(0.7 + 0.45 * w, 0.15, 1.5) * smoothstep(0, 0.04, u) * smoothstep(0, 0.04, 1 - u);
    return [x + n[0] * rim * k, y + n[1] * rim * k] as Pt;
  });
  const fibres: Tear['fibres'] = [], m = Math.round((L / 100) * fpc);
  for (let j = 0; j < m; j++) {
    const q = outer[Math.floor(hash(seed, j, 31) * outer.length)]!, len = 2 + hash(seed, j, 32) * 6, ang = (hash(seed, j, 33) - 0.5) * 2.2;
    const ca = Math.cos(ang), sa = Math.sin(ang), fx = n[0] * ca - n[1] * sa, fy = n[0] * sa + n[1] * ca;
    fibres.push([q[0] - n[0] * 1.5, q[1] - n[1] * 1.5, q[0] + fx * len, q[1] + fy * len, 0.5 + hash(seed, j, 34) * 0.7]);
  }
  return { band: [...e, ...outer.slice().reverse()], fibres };
}

function paintRim(c: CanvasRenderingContext2D, bands: readonly Pt[][], fibres: Tear['fibres'], color: string) {
  c.save();
  c.fillStyle = color; c.strokeStyle = color; c.lineCap = 'round';
  c.globalAlpha = 0.95;
  for (const r of bands) c.fill(polyPath(r));
  c.globalAlpha = 0.75;
  for (const [x0, y0, x1, y1, w] of fibres) { c.lineWidth = w; c.beginPath(); c.moveTo(x0, y0); c.quadraticCurveTo((x0 + x1) / 2 + (y1 - y0) * 0.2, (y0 + y1) / 2 - (x1 - x0) * 0.2, x1, y1); c.stroke(); }
  c.restore();
}

/**
 * Tear a polygon (clockwise or not): torn edges get a tornEdge outline, a band of white paper core of uneven width
 * outside it (the top layer of the paper tears back further than the core) and fibres poking out of that band.
 */
export function tearShape(pts: readonly Pt[], o: TearOpts = {}): Tear {
  const n = pts.length, s = polyArea(pts) >= 0 ? 1 : -1, seed = o.seed ?? 1, rim = o.rim ?? 6, fpc = o.fibres ?? 9;
  const outline: Pt[] = [], rims: Pt[][] = [], fibres: Tear['fibres'] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i]!, b = pts[(i + 1) % n]!;
    if (o.edges && o.edges[i] === false) { outline.push([a[0], a[1]]); continue; }
    const e = tornEdge(a, b, { ...o, seed: seed * 31 + i });
    outline.push(...e.slice(0, -1));
    if (rim <= 0) continue;
    const r = rimBand(e, outNormal(a, b, s), rim, seed * 31 + i + 977, (o.wave ?? 260) * 0.45, fpc);
    rims.push(r.band); fibres.push(...r.fibres);
  }
  return { outline, rims, fibres };
}

/** Paint a torn piece: the white rim and fibres, then the paper on top (`fill`, or a painter clipped to the outline). */
export function drawTorn(c: CanvasRenderingContext2D, s: Tear, fill: string | CanvasGradient | CanvasPattern | ((c: CanvasRenderingContext2D) => void), rimColor = '#f6f1e6') {
  paintRim(c, s.rims, s.fibres, rimColor);
  const p = polyPath(s.outline);
  c.save();
  if (typeof fill === 'function') { c.clip(p); fill(c); } else { c.fillStyle = fill; c.fill(p); }
  c.restore();
}

// ------------------------------------------------------------------ sprites (a piece painted once, drawn with one shadow)
/**
 * A piece painted once into its own canvas (at the output SCALE, context pre-scaled to logical px), so it casts one
 * shadow when drawn (kit/tactile.ts drawLifted). (ox, oy) is the point it is drawn about (its centre by default).
 */
export interface Sprite { cv: HTMLCanvasElement; w: number; h: number; ox: number; oy: number; scale: number }

/** A sprite of w x h logical px; `paint` draws it in logical px. */
export function sprite(w: number, h: number, paint: (c: CanvasRenderingContext2D, w: number, h: number) => void, scale = SCALE): Sprite {
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(w * scale); cv.height = Math.ceil(h * scale);
  const c = cv.getContext('2d')!;
  c.scale(scale, scale);
  paint(c, w, h);
  return { cv, w, h, ox: w / 2, oy: h / 2, scale };
}

/** Draw a sprite with its anchor at the current origin. */
export function drawSprite(c: CanvasRenderingContext2D, s: Sprite) {
  c.drawImage(s.cv, -s.ox, -s.oy, s.w, s.h);
}

/**
 * Cut a sprite in two along a polyline running left to right across it (sprite px): [above, below], each the same size
 * and anchor as the original, so a puppet's pieces share one frame and a hinge is a point in it.
 */
export function splitSprite(s: Sprite, line: readonly Pt[]): [Sprite, Sprite] {
  const side = (above: boolean) => sprite(s.w, s.h, (c) => {
    const p = new Path2D(), y = above ? -10 : s.h + 10;
    p.moveTo(-10, line[0]![1]);
    for (const [x, yy] of line) p.lineTo(x, yy);
    p.lineTo(s.w + 10, line[line.length - 1]![1]); p.lineTo(s.w + 10, y); p.lineTo(-10, y); p.closePath();
    c.clip(p);
    c.drawImage(s.cv, 0, 0, s.w, s.h);
  }, s.scale);
  const a = side(true), b = side(false);
  a.ox = b.ox = s.ox; a.oy = b.oy = s.oy;
  return [a, b];
}

/**
 * Tear a sprite in two along a torn line from p0 to p1 (sprite px; put both ends outside the paper): [left, right] of
 * the line as you walk from p0 to p1, each the original's size and anchor. The new edges show the white paper core
 * (only where there was paper): a fibrous band `rim` px wide on the left piece, whose top layer tore back, a thin one
 * on the right.
 */
export function tearSprite(s: Sprite, p0: Pt, p1: Pt, o: TornOpts & { rim?: number; rimColor?: string } = {}): [Sprite, Sprite] {
  const line = tornEdge(p0, p1, { amp: 6, wave: 160, ...o }), seed = o.seed ?? 1, rim = o.rim ?? 7, col = o.rimColor ?? '#f6f1e6';
  const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1, ux = (p1[0] - p0[0]) / L, uy = (p1[1] - p0[1]) / L, B = 2 * (s.w + s.h);
  const piece = (sgn: number, rimW: number) => sprite(s.w, s.h, (c) => {
    const nx = uy * sgn, ny = -ux * sgn; // this piece's side of the line (sgn 1: left as you walk p0 → p1)
    if (rimW > 0) {
      const r = rimBand(line, [-nx, -ny], rimW, seed * 7 + (sgn > 0 ? 1 : 2), 90, 10);
      paintRim(c, [r.band], r.fibres, col);
      c.globalCompositeOperation = 'destination-in'; c.drawImage(s.cv, 0, 0, s.w, s.h); c.globalCompositeOperation = 'source-over';
    }
    const region: Pt[] = [...line, [p1[0] + ux * B, p1[1] + uy * B], [p1[0] + (ux + nx) * B, p1[1] + (uy + ny) * B], [p0[0] + (nx - ux) * B, p0[1] + (ny - uy) * B], [p0[0] - ux * B, p0[1] - uy * B]];
    c.save(); c.clip(polyPath(region)); c.drawImage(s.cv, 0, 0, s.w, s.h); c.restore();
  }, s.scale);
  const a = piece(1, rim), b = piece(-1, rim * 0.35);
  a.ox = b.ox = s.ox; a.oy = b.oy = s.oy;
  return [a, b];
}

// ------------------------------------------------------------------ raster: masks, contours, scissor rims, halftone
const BIG = 1e20;
function edt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0; z[0] = -BIG; z[1] = BIG;
  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) { k--; s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!); }
    k++; v[k] = q; z[k] = s; z[k + 1] = BIG;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1]! < q) k++; d[q] = (q - v[k]!) * (q - v[k]!) + f[v[k]!]!; }
}

/** Squared distance from each pixel to the nearest set pixel of `mask` (w x h, exact; Felzenszwalb–Huttenlocher). */
export function edt(mask: Uint8Array, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h), m = Math.max(w, h);
  const f = new Float64Array(m), d = new Float64Array(m), v = new Int32Array(m), z = new Float64Array(m + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = mask[y * w + x] ? 0 : BIG;
    edt1(f, h, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y]!;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x]!;
    edt1(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = d[x]!;
  }
  return out;
}

/** Grow a mask by a disc of radius r px. */
export function dilateMask(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  const d = edt(mask, w, h), r2 = r * r, out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i]! <= r2 ? 1 : 0;
  return out;
}

/** Shrink a mask by a disc of radius r px. */
export function erodeMask(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < inv.length; i++) inv[i] = mask[i] ? 0 : 1;
  const g = dilateMask(inv, w, h, r);
  for (let i = 0; i < g.length; i++) g[i] = g[i] ? 0 : 1;
  return g;
}

const DX = [-1, -1, 0, 1, 1, 1, 0, -1], DY = [0, -1, -1, -1, 0, 1, 1, 1];
const dirOf = (dx: number, dy: number) => { for (let i = 0; i < 8; i++) if (DX[i] === dx && DY[i] === dy) return i; return 0; };

/**
 * Outer contours (pixel centres, clockwise on screen) of the 8-connected blobs of `mask` with at least `minArea` pixels,
 * by Moore-neighbour tracing.
 */
export function traceContours(mask: Uint8Array, w: number, h: number, minArea = 1): Pt[][] {
  const lab = new Int32Array(w * h), starts: number[] = [], areas: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || lab[i]) continue;
    const id = starts.length + 1;
    starts.push(i);
    let area = 0;
    lab[i] = id; stack.push(i);
    while (stack.length) {
      const j = stack.pop()!, x = j % w, y = (j - x) / w;
      area++;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k]!, ny = y + DY[k]!;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (mask[q] && !lab[q]) { lab[q] = id; stack.push(q); }
      }
    }
    areas.push(area);
  }
  const out: Pt[][] = [];
  starts.forEach((s0, b) => {
    if (areas[b]! < minArea) return;
    const id = b + 1, inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && lab[y * w + x] === id;
    const sx = s0 % w, sy = (s0 - sx) / w, pts: Pt[] = [[sx + 0.5, sy + 0.5]];
    let px = sx, py = sy, dir = 0; // dir: from the pixel to the background pixel we came from (west of the start)
    const step = () => {
      for (let i = 1; i <= 8; i++) {
        const d = (dir + i) % 8, nx = px + DX[d]!, ny = py + DY[d]!;
        if (!inside(nx, ny)) continue;
        const bx = px + DX[(d + 7) % 8]!, by = py + DY[(d + 7) % 8]!;
        px = nx; py = ny; dir = dirOf(bx - px, by - py);
        return true;
      }
      return false; // a single pixel
    };
    if (step()) {
      const s2x = px, s2y = py;
      pts.push([px + 0.5, py + 0.5]);
      for (let it = 0; it < 4 * w * h + 8; it++) {
        const cx = px, cy = py;
        step();
        // back at the start and leaving it the way we first did (Jacob's criterion): the start was pushed twice
        if (cx === sx && cy === sy && px === s2x && py === s2y) { pts.pop(); break; }
        pts.push([px + 0.5, py + 0.5]);
      }
    }
    out.push(pts);
  });
  return out;
}

export interface ScissorSpriteOpts extends ScissorOpts {
  /** Gaps narrower than about this (px) are bridged: scissors can't get into them (default 3 rim, as 06 prep.py). */
  close?: number;
  /** Rim colour (the white of the paper the picture was printed on). */
  color?: string;
  /** Alpha (0..1) above which a pixel counts as picture. */
  threshold?: number;
}

/**
 * Cut a picture out with scissors (06 prep.py scissor_border): its alpha is cleaned (opened), grown by `rim`, closed,
 * traced, straightened into facets, nudged; the picture sits on that white-rimmed shape. `src` is drawn at w x h
 * logical px. Returns a sprite (padded) and the cut outline(s) in sprite px.
 */
export function scissorSprite(src: CanvasImageSource, w: number, h: number, o: ScissorSpriteOpts = {}): Sprite & { outline: Pt[][]; pad: number } {
  const rim = o.rim ?? 5, close = o.close ?? rim * 3, pad = Math.ceil(rim + close + 3), w2 = Math.ceil(w + 2 * pad), h2 = Math.ceil(h + 2 * pad);
  const m = document.createElement('canvas');
  m.width = w2; m.height = h2;
  const mc = m.getContext('2d', { willReadFrequently: true })!;
  mc.drawImage(src, pad, pad, w, h);
  const px = mc.getImageData(0, 0, w2, h2).data, thr = (o.threshold ?? 0.45) * 255;
  let mask: Uint8Array = new Uint8Array(w2 * h2);
  for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4 + 3]! > thr ? 1 : 0;
  mask = dilateMask(erodeMask(mask, w2, h2, 3), w2, h2, 3);
  mask = dilateMask(mask, w2, h2, rim + close);
  mask = erodeMask(mask, w2, h2, close);
  const outline = traceContours(mask, w2, h2, 80).map((ct) => scissorPoints(ct, { ...o, rim: 0, eps: o.eps ?? Math.max(2, rim * 0.7), wobble: o.wobble ?? 0 }));
  const s = sprite(w2, h2, (c) => {
    c.fillStyle = o.color ?? '#f4efe4';
    for (const ct of outline) c.fill(polyPath(ct));
    c.drawImage(src, pad, pad, w, h);
  });
  return { ...s, outline, pad };
}

/** Spot function of an AM halftone screen at (x, y): 0..1 cosine dots, `period` px apart, rotated `angleDeg`. */
export function screenSpot(x: number, y: number, period: number, angleDeg: number): number {
  const a = (angleDeg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const u = (x * ca + y * sa) / period, v = (-x * sa + y * ca) / period;
  return (Math.cos(TAU * u) + Math.cos(TAU * v)) * 0.25 + 0.5;
}

/** Ink (0..1) where a tone of coverage `cov` meets the screen value `spot`; `aa` softens the dot edge (06: 1.6 / period). */
export function screenInk(cov: number, spot: number, aa: number): number {
  return clamp((cov - spot) / aa + 0.5);
}

export interface HalftoneOpts {
  /** Dot pitch (logical px) and screen angle (degrees). 06-collage: 6.5 px at 45°. */
  period?: number;
  angle?: number;
  /** Tone curve: luminance below lo is solid ink, above hi bare paper; then ^gamma. */
  lo?: number;
  hi?: number;
  gamma?: number;
  /** Continuous tone left under the dots (newspaper repro: 0.3). */
  tone?: number;
  ink?: string;
  paper?: string;
  /** Backing px per logical px of `src` (a canvas made at SCALE: SCALE). */
  pxScale?: number;
}

const hexRgb = (s: string): [number, number, number] => {
  const n = parseInt(s.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/**
 * A true one-ink halftone of a picture (06 prep.py halftone_mono): luminance → dot screen (anti-aliased spot-function
 * threshold) in `ink` on `paper`, with `tone` of the continuous image left under the dots. Alpha is kept.
 */
export function halftoneMono(src: HTMLCanvasElement, o: HalftoneOpts = {}): HTMLCanvasElement {
  const k = o.pxScale ?? 1, period = (o.period ?? 6.5) * k, angle = o.angle ?? 45, lo = o.lo ?? 0.06, hi = o.hi ?? 0.93, gamma = o.gamma ?? 0.95, tone = o.tone ?? 0.3;
  const ink = hexRgb(o.ink ?? '#1c1814'), pap = hexRgb(o.paper ?? '#f4e2bf'), aa = 1.6 / period;
  const ca = Math.cos((angle * Math.PI) / 180), sa = Math.sin((angle * Math.PI) / 180), fr = TAU / period;
  const out = document.createElement('canvas');
  out.width = src.width; out.height = src.height;
  const c = out.getContext('2d', { willReadFrequently: true })!;
  c.drawImage(src, 0, 0);
  const img = c.getImageData(0, 0, out.width, out.height), d = img.data;
  for (let y = 0, i = 0; y < out.height; y++) for (let x = 0; x < out.width; x++, i += 4) {
    if (d[i + 3] === 0) continue;
    const lum = (d[i]! * 0.3 + d[i + 1]! * 0.59 + d[i + 2]! * 0.11) / 255;
    const u = (x + 0.5) * ca + (y + 0.5) * sa, v = -(x + 0.5) * sa + (y + 0.5) * ca; // = screenSpot, inlined
    const L = Math.pow(clamp((lum - lo) / (hi - lo)), gamma), a = screenInk(1 - L, (Math.cos(fr * u) + Math.cos(fr * v)) * 0.25 + 0.5, aa);
    const b = 1 - tone + tone * L;
    for (let ch = 0; ch < 3; ch++) d[i + ch] = Math.round((pap[ch]! * b * (1 - a) + ink[ch]! * a) * 255);
  }
  c.putImageData(img, 0, 0);
  return out;
}

// ------------------------------------------------------------------ real paper
/** The paper scan shipped with the engine (ambientCG Paper001, CC0; app/public/textures). */
export const PAPER_SCAN = 'textures/paper001.jpg';

/** Load an image (url relative to the app root). */
export async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

export interface SheetOpts {
  /** How strongly the scan's tooth shows: colour × (1 + strength · (scan / mean − 1)). The scan itself is faint: 3–6. */
  strength?: number;
  /** Logical px per scan px (0.47: the 4096 px scan spans a 1920 px frame). */
  grainPx?: number;
  /** Slow blotches (± fraction of the colour; kraft board: 0.05). */
  mottle?: number;
  /** Fibres per 100 x 100 px (kraft: 1.5; 0 = none). */
  fibres?: number;
  seed?: number;
  scale?: number;
}

/**
 * A sheet of real paper in colour `base` (w x h logical px, at `scale`): the scan's tooth relative to its mean
 * multiplies the colour (06 prep.py: colour × fine / fine.mean), plus optional blotches and fibres. Use it as a page
 * (drawImage) or a fill (sheetPattern): the texture then moves with the piece.
 */
export function paperSheet(scan: HTMLImageElement | HTMLCanvasElement, w: number, h: number, base: string, o: SheetOpts = {}): HTMLCanvasElement {
  const sc = o.scale ?? SCALE, seed = o.seed ?? 1, g = o.grainPx ?? 0.47, str = o.strength ?? 4, mot = o.mottle ?? 0;
  const cw = Math.ceil(w * sc), ch = Math.ceil(h * sc), cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  const c = cv.getContext('2d', { willReadFrequently: true })!;
  // the scan, tiled at grainPx from a seeded offset
  const pat = c.createPattern(scan, 'repeat')!, sw = scan.width, shh = scan.height;
  pat.setTransform(new DOMMatrix().scaleSelf(g * sc, g * sc).translateSelf(-Math.floor(hash(seed, 1) * sw), -Math.floor(hash(seed, 2) * shh)));
  c.fillStyle = pat; c.fillRect(0, 0, cw, ch);
  const img = c.getImageData(0, 0, cw, ch), d = img.data, col = hexRgb(base);
  let mean = 0;
  for (let i = 0; i < d.length; i += 4) mean += d[i]! * 0.3 + d[i + 1]! * 0.59 + d[i + 2]! * 0.11;
  mean /= d.length / 4;
  // blotches on a coarse grid (every 24 logical px), bilinear in between
  const G = 24 * sc, gw = Math.ceil(cw / G) + 2, gh = Math.ceil(ch / G) + 2, grid = new Float32Array(gw * gh);
  if (mot) for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    grid[y * gw + x] = noise2((x * 24) / 260, (y * 24) / 260, seed) * 0.7 + noise2((x * 24) / 70, (y * 24) / 70, seed + 5) * 0.3;
  }
  for (let y = 0, i = 0; y < ch; y++) {
    const gy = y / G, y0 = Math.floor(gy), fy = gy - y0;
    for (let x = 0; x < cw; x++, i += 4) {
      const v = (d[i]! * 0.3 + d[i + 1]! * 0.59 + d[i + 2]! * 0.11) / mean;
      let m = 1 + str * (v - 1);
      if (mot) {
        const gx = x / G, x0 = Math.floor(gx), fx = gx - x0, a = grid[y0 * gw + x0]!, b = grid[y0 * gw + x0 + 1]!, e = grid[(y0 + 1) * gw + x0]!, f = grid[(y0 + 1) * gw + x0 + 1]!;
        m *= 1 + mot * lerp(lerp(a, b, fx), lerp(e, f, fx), fy);
      }
      d[i] = col[0] * m * 255; d[i + 1] = col[1] * m * 255; d[i + 2] = col[2] * m * 255; d[i + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
  const nf = Math.round(((w * h) / 10000) * (o.fibres ?? 0));
  if (nf) {
    c.save(); c.scale(sc, sc); c.lineCap = 'round';
    for (let i = 0; i < nf; i++) {
      const x = hash(i, seed, 41) * w, y = hash(i, seed, 42) * h, l = 2 + hash(i, seed, 43) ** 2 * 14, a = hash(i, seed, 44) * TAU, dark = hash(i, seed, 45) < 0.55;
      c.strokeStyle = dark ? `rgba(40,26,12,${0.1 + 0.2 * hash(i, seed, 46)})` : `rgba(255,248,232,${0.12 + 0.2 * hash(i, seed, 46)})`;
      c.lineWidth = 0.5 + hash(i, seed, 47) * 0.9;
      c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + Math.cos(a + 0.6) * l * 0.5, y + Math.sin(a + 0.6) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l); c.stroke();
    }
    c.restore();
  }
  return cv;
}

/** A repeating fill from a sheet (or any canvas made at `scale`), sized for a context drawing in logical px. */
export function sheetPattern(c: CanvasRenderingContext2D, sheet: HTMLCanvasElement, scale = SCALE): CanvasPattern {
  const p = c.createPattern(sheet, 'repeat')!;
  p.setTransform(new DOMMatrix().scaleSelf(1 / scale, 1 / scale));
  return p;
}

// ------------------------------------------------------------------ stop-motion timing
export interface BoilOpts {
  /** Moving: jitter amplitude (px) and how often the hand puts it down again (per s). 06: 2 px at 12. */
  amp?: number;
  rate?: number;
  /** Resting: 06: 1.1 px at 6. */
  restAmp?: number;
  restRate?: number;
}

/** Hand-placed jitter [dx, dy, drot] of a cut-out: moving pieces 2 px at 12 fps, resting ones 1.1 px at 6 fps; rot = amp · 0.2°. */
export function boil(t: number, seed: number, moving: boolean, o: BoilOpts = {}): [number, number, number] {
  const rate = moving ? o.rate ?? 12 : o.restRate ?? 6, amp = moving ? o.amp ?? 2 : o.restAmp ?? 1.1;
  const [dx, dy] = handJitter(t, rate, amp, seed), k = Math.round(stepT(t, rate) * rate);
  return [dx, dy, (hash(k, seed, 3) * 2 - 1) * amp * 0.2 * (Math.PI / 180)];
}

export interface PasteOpts extends SlapOpts, BoilOpts {
  seed?: number;
  /** Steps per second (12) and how many steps it falls (3). */
  fps?: number;
  steps?: number;
  /** Steps it keeps moving (12 fps jitter) after landing (2). */
  settle?: number;
}

/** A pasted cut-out's pose: tactile Pose plus `k` (steps since landing, negative while falling) and `moving`. */
export interface Paste extends LiftPose { k: number; moving: boolean }

/**
 * A cut-out slapped down by hand at t0, as stop motion (06 slap + jit): kit/tactile.ts slap sampled at 12 fps and
 * landing on the step nearest t0 (falls 3 steps from lift 1, squashes .972, rebounds 1.01), hand jitter on top: 2 px at
 * 12 fps while moving, 1.1 px at 6 fps once it rests. Draw with drawLifted. `from` defaults to [36, -48] (it comes
 * down from the upper right, towards the light).
 */
export function pastePose(t: number, t0: number, o: PasteOpts = {}): Paste {
  const fps = o.fps ?? 12, t0q = Math.round(t0 * fps) / fps, ts = stepT(t, fps), k = Math.round((ts - t0q) * fps);
  const p = slap(ts, t0q, { ...o, dur: (o.steps ?? 3) / fps + 1e-4, from: o.from ?? [36, -48] });
  const moving = k < (o.settle ?? 2), [jx, jy, jr] = boil(t, o.seed ?? 1, moving, o);
  return { ...p, x: p.x + jx, y: p.y + jy, rot: p.rot + jr, k, moving };
}

/** Steps (at `fps`) since t0, quantised like pastePose: 0 on the landing step, negative before. */
export function stepsSince(t: number, t0: number, fps = 12): number {
  return Math.round((stepT(t, fps) - Math.round(t0 * fps) / fps) * fps);
}

export interface CamKey { t: number; z: number; x?: number; y?: number; ease?: (u: number) => number }
export interface CamKick { t: number; z?: readonly number[]; x?: readonly number[]; y?: readonly number[] }
export interface Rostrum { z: number; x: number; y: number; fx: number; fy: number }

/**
 * A rostrum (animation-stand) camera: zoom z about the focus (fx, fy) plus a pan (x, y), keyed and sampled at `rate`
 * (6 fps: the operator cranks between exposures), never closer than `max` (1.06). `kicks` jolt it on impacts, one
 * value per 12 fps step after t (added to z, x, y), as 06 does when the lid pops.
 */
export function rostrum(t: number, keys: readonly CamKey[], o: { rate?: number; focus?: Pt; kicks?: readonly CamKick[]; max?: number } = {}): Rostrum {
  const ts = stepT(t, o.rate ?? 6), [fx, fy] = o.focus ?? [W / 2, H / 2];
  let z = 1, x = 0, y = 0;
  if (keys.length) {
    let i = 0;
    while (i < keys.length - 1 && keys[i + 1]!.t <= ts) i++;
    const a = keys[i]!, b = keys[Math.min(i + 1, keys.length - 1)]!;
    const u = b === a || ts <= a.t ? 0 : (b.ease ?? ease.inOutCubic)(clamp((ts - a.t) / (b.t - a.t)));
    z = lerp(a.z, b.z, u); x = lerp(a.x ?? 0, b.x ?? 0, u); y = lerp(a.y ?? 0, b.y ?? 0, u);
  }
  for (const kk of o.kicks ?? []) {
    const k = stepsSince(t, kk.t, 12);
    if (k < 0) continue;
    z += kk.z?.[k] ?? 0; x += kk.x?.[k] ?? 0; y += kk.y?.[k] ?? 0;
  }
  return { z: Math.min(z, o.max ?? 1.06), x, y, fx, fy };
}

/** Apply a rostrum camera to a context drawing the page in logical px. */
export function applyRostrum(c: CanvasRenderingContext2D, r: Rostrum) {
  c.translate(r.fx + r.x, r.fy + r.y); c.scale(r.z, r.z); c.translate(-r.fx, -r.fy);
}

// ------------------------------------------------------------------ small props
/** Paper fibres and specks puffing out of an impact for two steps (k = 0, 1 steps after landing). pts: [x, y, dirx, diry]. */
export function flecks(c: CanvasRenderingContext2D, pts: readonly (readonly [number, number, number, number])[], k: number, seed: number, n = 6, color = '#f3eddf') {
  if (k < 0 || k > 1 || !pts.length) return;
  c.save(); c.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const [px, py, dx, dy] = pts[i % pts.length]!;
    const a = Math.atan2(dy, dx) + (hash(seed, i) - 0.5) * 1.1, d = (12 + hash(seed + 1, i) * 22) * (k + 1);
    const x = px + Math.cos(a) * d, y = py + Math.sin(a) * d;
    c.globalAlpha = k ? 0.45 : 0.92;
    if (i % 3 === 2) { c.fillStyle = 'rgba(30,20,10,.85)'; c.beginPath(); c.arc(x, y, 2 + hash(seed + 2, i) * 2.5, 0, TAU); c.fill(); }
    else {
      const L = 10 + hash(seed + 3, i) * 14, b = a + (hash(seed + 4, i) - 0.5) * 2.2;
      c.strokeStyle = color; c.lineWidth = 2.6;
      c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + Math.cos(b) * L * 0.6, y + Math.sin(b) * L * 0.6, x + Math.cos(a) * L, y + Math.sin(a) * L); c.stroke();
    }
  }
  c.restore();
}

/** A brass paper fastener (a puppet's joint) at (x, y), radius r, with its own small shadow. */
export function brad(c: CanvasRenderingContext2D, x: number, y: number, r = 15) {
  c.save();
  c.shadowColor = 'rgba(34,20,8,.5)'; c.shadowBlur = 5; c.shadowOffsetX = 3; c.shadowOffsetY = 4;
  const g = c.createRadialGradient(x - r / 3, y - r * 0.4, 1, x, y, r * 1.07);
  g.addColorStop(0, '#ffe9a6'); g.addColorStop(0.35, '#d6a945'); g.addColorStop(1, '#7a5516');
  c.beginPath(); c.arc(x, y, r, 0, TAU); c.fillStyle = g; c.fill();
  c.shadowColor = 'transparent';
  c.lineWidth = r * 0.1; c.strokeStyle = 'rgba(60,38,8,.9)'; c.stroke();
  c.beginPath(); c.arc(x, y, r * 0.6, 3.6, 5.2); c.strokeStyle = 'rgba(255,245,210,.8)'; c.lineWidth = r * 0.13; c.stroke();
  c.restore();
}

/** Masking tape: a translucent strip with serrated torn ends and a faint crepe texture (w x h logical px). */
export function tapeSprite(w: number, h: number, color = '#e3d4b0', seed = 1, alpha = 0.82): Sprite {
  return sprite(w, h, (c) => {
    const p: Pt[] = [];
    const teeth = Math.max(4, Math.round(h / 5));
    for (let i = 0; i <= teeth; i++) p.push([w - 3 + (i % 2 ? -3 : 2) * (0.6 + hash(seed, i, 1) * 0.6), (i / teeth) * h]);
    for (let i = teeth; i >= 0; i--) p.push([3 + (i % 2 ? 3 : -2) * (0.6 + hash(seed, i, 2) * 0.6), (i / teeth) * h]);
    c.globalAlpha = alpha; c.fillStyle = color; c.fill(polyPath(p));
    c.globalAlpha = 1; c.save(); c.clip(polyPath(p));
    for (let i = 0; i < w / 3; i++) { // crepe: faint creases across the tape
      const x = hash(seed, i, 3) * w;
      c.strokeStyle = hash(seed, i, 4) < 0.5 ? 'rgba(255,255,255,.12)' : 'rgba(90,70,40,.07)';
      c.lineWidth = 0.6 + hash(seed, i, 5);
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x + (hash(seed, i, 6) - 0.5) * 6, h); c.stroke();
    }
    c.restore();
  });
}

// ------------------------------------------------------------------ finishing + stage
export interface FinishOpts {
  /** Film grain (overlay opacity, 06: 0.26), offset every step. */
  grain?: number;
  /** Dust and hairs (multiply opacity, 06: 0.35), one of two plates, swapped every two steps. */
  dust?: number;
  /** Warm vignette at the corners (06: 0.28). */
  vignette?: number;
  /** Steps per second the grain and dust change (12). */
  fps?: number;
}

/** The last layers of a collage frame (06 finish()): grain, dust, warm vignette, all stepped like the animation. */
export class CollageFinish {
  grain: HTMLCanvasElement;
  dust: HTMLCanvasElement[];
  constructor(public seed = 1, public scale = SCALE) {
    // grain at logical resolution (it is a film grain, not a pixel noise: at 4K it stays the same size)
    const G = 512;
    this.grain = document.createElement('canvas');
    this.grain.width = this.grain.height = G;
    const gc = this.grain.getContext('2d')!, img = gc.createImageData(G, G);
    for (let i = 0; i < G * G; i++) {
      const v = 128 + (hash(i, seed, 51) + hash(i, seed, 52) + hash(i, seed, 53) + hash(i, seed, 54) - 2) * 92;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = clamp(v, 0, 255); img.data[i * 4 + 3] = 255;
    }
    gc.putImageData(img, 0, 0);
    this.dust = [0, 1].map((n) => {
      const s = sprite(W, H, (c) => {
        c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
        const rs = seed * 13 + n * 7;
        c.lineCap = 'round';
        for (let i = 0; i < 90; i++) { // specks
          c.fillStyle = `rgba(34,24,14,${0.35 + 0.5 * hash(i, rs, 61)})`;
          c.beginPath(); c.arc(hash(i, rs, 62) * W, hash(i, rs, 63) * H, 0.5 + hash(i, rs, 64) ** 3 * 2.4, 0, TAU); c.fill();
        }
        for (let i = 0; i < 16; i++) { // hairs and fibres
          const x = hash(i, rs, 71) * W, y = hash(i, rs, 72) * H, L = 12 + hash(i, rs, 73) * 60, a = hash(i, rs, 74) * TAU, bend = (hash(i, rs, 75) - 0.5) * 1.6;
          c.strokeStyle = `rgba(30,22,14,${0.3 + 0.35 * hash(i, rs, 76)})`; c.lineWidth = 0.6 + hash(i, rs, 77) * 0.8;
          c.beginPath(); c.moveTo(x, y);
          c.bezierCurveTo(x + Math.cos(a) * L * 0.4, y + Math.sin(a) * L * 0.4, x + Math.cos(a + bend) * L * 0.7, y + Math.sin(a + bend) * L * 0.7, x + Math.cos(a + bend * 1.6) * L, y + Math.sin(a + bend * 1.6) * L);
          c.stroke();
        }
      }, scale);
      return s.cv;
    });
  }
  draw(c: CanvasRenderingContext2D, t: number, o: FinishOpts = {}) {
    const fps = o.fps ?? 12, k = Math.round(stepT(t, fps) * fps), ga = o.grain ?? 0.26, da = o.dust ?? 0.35, va = o.vignette ?? 0.28;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.shadowColor = 'transparent';
    if (ga > 0) {
      const p = c.createPattern(this.grain, 'repeat')!;
      p.setTransform(new DOMMatrix().translateSelf(-Math.floor(hash(k, 1) * 120), -Math.floor(hash(k, 2) * 900)));
      c.globalCompositeOperation = 'overlay'; c.globalAlpha = ga; c.fillStyle = p; c.fillRect(0, 0, W, H);
    }
    if (da > 0) {
      c.globalCompositeOperation = 'multiply'; c.globalAlpha = da;
      c.drawImage(this.dust[Math.floor(k / 2) % 2]!, (k % 3) * -3, 0, W + 6, H);
    }
    if (va > 0) {
      const g = c.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 1.05);
      g.addColorStop(0, 'rgba(40,20,5,0)'); g.addColorStop(1, `rgba(40,20,5,${va})`);
      c.globalCompositeOperation = 'multiply'; c.globalAlpha = 1; c.fillStyle = g; c.fillRect(0, 0, W, H);
    }
    c.restore();
  }
}

/** Page bleed (px) past each edge, so a camera kick never shows the edge of the paper. */
const BLEED = 24;

/**
 * A 2D collage stage: one Canvas2D layer with a real-paper page under a stepped rostrum camera, finished with grain,
 * dust and a warm vignette. `await load()` in init; per frame `const c = stage.begin(t, cam)`, paint the pieces in page
 * px, then composite `stage.end(t)`.
 */
export class CollageStage {
  layer = new Layer2D();
  scan: HTMLImageElement | null = null;
  page: HTMLCanvasElement | null = null;
  finish: CollageFinish;
  constructor(public seed = 1) { this.finish = new CollageFinish(seed); }
  /** Load the paper scan and make the page in colour `base`. */
  async load(base = '#b49a74', o: SheetOpts & { url?: string } = {}) {
    this.scan = await loadImage(o.url ?? PAPER_SCAN);
    this.page = paperSheet(this.scan, W + 2 * BLEED, H + 2 * BLEED, base, { strength: 5, mottle: 0.06, fibres: 1.5, seed: this.seed, ...o });
    return this;
  }
  /** A sheet of the same scan in another colour (pieces of coloured paper; sheetPattern makes it a fill). */
  sheet(base: string, w = 1024, h = 1024, o: SheetOpts = {}) {
    if (!this.scan) throw new Error('CollageStage.sheet: await load() first');
    return paperSheet(this.scan, w, h, base, { seed: this.seed + 17, ...o });
  }
  /** Clear, draw the page under the camera and leave the camera applied: paint the pieces next. */
  begin(t: number, cam?: Rostrum): CanvasRenderingContext2D {
    const c = this.layer.ctx;
    this.layer.clear();
    c.save();
    if (cam) applyRostrum(c, cam);
    if (this.page) c.drawImage(this.page, -BLEED, -BLEED, W + 2 * BLEED, H + 2 * BLEED);
    return c;
  }
  /** Drop the camera, add the finishing layers; returns the layer's texture to composite. */
  end(t: number, o: FinishOpts = {}) {
    const c = this.layer.ctx;
    c.restore();
    this.finish.draw(c, t, o);
    return this.layer.upload();
  }
}

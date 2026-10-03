// The flat-design worlds (docs/TREATMENT.md, 画面语言 · 平面设计): each shot is a paper theatre — flat, cut-paper
// layers (Canvas2D) standing at different depths in a three.js scene, so a moving camera gives real parallax and the
// layers throw soft shadows on the ones behind. Figures are pictograms (Otl Aicher / Olympic style: round head,
// straight limbs with round caps, gaps where limbs cross), colour is flat (3–5 per world + ink + paper), type is
// part of the picture. Helpers here: the stage, rough cut edges, halftone, paper fibre, pictogram figures.
import * as THREE from 'three';
import { hash } from './util';
import { W, H } from './gl';

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

/** Fill a path with a soft paper shadow under it (the layer's own drop shadow). */
export function cut(c: CanvasRenderingContext2D, path: Path2D, fill: string | CanvasGradient | CanvasPattern, shadow: [number, number, number, number] | null = [0, 6, 16, 0.28]) {
  c.save();
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

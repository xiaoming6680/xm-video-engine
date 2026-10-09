// ?ref=invader: frame-matched re-creation of the kaomoji.exe 8-bit level (its 76.8–79.85 s; docs/复刻配方.md): a space
// shooter of kaomoji invaders under a big pixel face, red bunkers, a guard ship; green ones grow from below, the face
// drops into the swarm, an orange flash; then a 3D voxel well (a falling-block game) full of white blocks with a cyan
// smile and red garbage rows, lines clear; it breaks apart into coloured cubes.
// Local seconds T = f.lt match the reference from 76.8 s. Wording is our own.
import * as THREE from 'three';
import { Scene, type Frame } from '../engine/scene';
import { Layer2D, W, H } from '../engine/gl';
import { font } from '../engine/type';
import { ease, prog, keys, mulberry32, hash, frameIdx } from '../engine/util';

type Ctx = CanvasRenderingContext2D;
const PIX = (px: number) => font('PressStart2P', px);
const ORANGE = '#F7AE3C', RED = '#E9442E', CYAN = '#4FC6E8', GREEN = '#3CCB5A';
const FAILED = 1.2, DROP = 1.0, FLASH = 1.2, TILT = 1.55, WELL = 1.68, BREAK = 2.86, SHATTER = 2.98;
// the big pixel face in grid units (x, y, w, h): brackets, eyes, ω
const FACE: [number, number, number, number][] = [
  [0, 0, 2, 1], [0, 0, 1, 13], [0, 12, 1, 1], [1, 13, 1, 1],
  [16, 0, 2, 1], [17, 0, 1, 13], [17, 12, 1, 1], [16, 13, 1, 1],
  [4, 3, 3, 3], [11, 3, 3, 3],
  [5, 8, 1, 3], [6, 10, 2, 1], [8, 8, 2, 2], [10, 10, 2, 1], [12, 8, 1, 3],
];

export default class RefInvader extends Scene {
  layer = new Layer2D();
  ui = new Layer2D();
  world = new THREE.Scene();
  cam = new THREE.PerspectiveCamera(36, W / H, 0.1, 500);
  cubes!: THREE.InstancedMesh;
  cells: { x: number; y: number; z: number; col: THREE.Color; row: number; v: THREE.Vector3; spin: THREE.Vector3 }[] = [];
  shards!: THREE.InstancedMesh;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();

  override init() {
    // the well: 12 x 13 front layer of cells, grey walls and floor, the pixel face above
    const rnd = mulberry32(9), add = (x: number, y: number, z: number, hex: number, row = -1) => {
      const a = Math.atan2(y - 6, x - 5.5);
      this.cells.push({ x, y, z, col: new THREE.Color(hex), row, v: new THREE.Vector3(Math.cos(a) * (4 + rnd() * 10), Math.sin(a) * (4 + rnd() * 10) + 2, 8 + rnd() * 22), spin: new THREE.Vector3(rnd() * 8, rnd() * 8, rnd() * 8) });
    };
    const heights = [9, 9, 10, 10, 9, 7, 7, 7, 8, 7, 9, 9];
    const smile = new Set(['3,5', '4,4', '5,3', '6,3', '7,3', '8,4', '9,5', '2,7', '3,7', '7,6', '8,6']);
    for (let x = 0; x < 12; x++) for (let y = 0; y < heights[x]!; y++) {
      if (x === 10 && y > 1) continue;                      // the open slot
      const cyan = x === 0 || x === 11 || smile.has(`${x},${y}`) || (y > 7 && rnd() < 0.3);
      add(x, y, 0, y < 2 ? 0xe9442e : cyan ? 0x4fc6e8 : 0xf3f4f6, y);
    }
    for (let y = -1; y < 11; y++) { add(-1, y, 0, 0x6b6e76); add(12, y, 0, 0x6b6e76); }
    for (let x = 0; x < 12; x++) add(x, -1, 0, 0x6b6e76);
    for (let z = -1; z >= -2; z--) for (let x = -1; x <= 12; x++) add(x, -1, z, 0x50535a);
    for (const [fx, fy, fw, fh] of FACE) for (let i = 0; i < fw; i++) for (let j = 0; j < fh; j++) add(0.9 + (fx + i) * 0.56, 10.4 + (13 - fy - j) * 0.56, 1.2, 0xf7ae3c, 99);
    const geo = new THREE.BoxGeometry(0.94, 0.94, 0.94);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.0 });
    this.cubes = new THREE.InstancedMesh(geo, mat, this.cells.length);
    this.cells.forEach((c, i) => this.cubes.setColorAt(i, c.col));
    this.world.add(this.cubes);
    const sun = new THREE.DirectionalLight(0xffffff, 2.4); sun.position.set(-6, 14, 18);
    this.world.add(sun, new THREE.AmbientLight(0xffffff, 0.9));
    // shards: small cubes thrown out of the front of the well toward the camera
    const sg = new THREE.BoxGeometry(0.22, 0.22, 0.5);
    this.shards = new THREE.InstancedMesh(sg, new THREE.MeshBasicMaterial(), 360);
    const sc = [0xe9442e, 0x4fc6e8, 0xf3f4f6, 0xe9442e];
    for (let i = 0; i < 360; i++) this.shards.setColorAt(i, new THREE.Color(sc[i % 4]!));
    this.shards.visible = false;
    this.world.add(this.shards);
  }

  render(f: Frame, out: THREE.WebGLRenderTarget) {
    const T = f.lt;
    if (T < WELL) return this.arcade(f, out);
    return this.well(f, out);
  }

  /** The big pixel face at (x, y) top-left, unit u. */
  private bigFace(c: Ctx, x: number, y: number, u: number, glow = 1) {
    c.save(); c.shadowColor = `rgba(255,170,60,${0.6 * glow})`; c.shadowBlur = 18; c.fillStyle = ORANGE;
    for (const [fx, fy, fw, fh] of FACE) c.fillRect(x + fx * u, y + fy * u, fw * u - 2, fh * u - 2);
    c.restore();
  }

  private hud(c: Ctx, T: number, three = false) {
    if (!three) {
      c.font = PIX(36); c.fillStyle = '#F2F2F2'; c.textBaseline = 'top';
      c.fillText(`SCORE ${String(100 + 100 * Math.floor(T * 3)).padStart(6, '0')}`, 16, 18); c.fillText('HI-SCORE 662874', 16, 60);
      c.fillStyle = RED; c.textAlign = 'right'; c.fillText('QA v2.0 ▲▲▲', W - 30, 22); c.textAlign = 'left';
    }
    const x = 56, y = 144, lives = T >= BREAK ? 3 : 4;
    c.fillStyle = 'rgba(0,0,0,0.55)'; c.fillRect(x, y, 560, 192); c.strokeStyle = RED; c.lineWidth = 3; c.strokeRect(x, y, 560, 192);
    c.font = PIX(26); c.fillStyle = RED; c.fillText(T >= BREAK ? 'QA v2.0 (￣□￣)' : 'QA v2.0 (;´A`)', x + 16, y + 22);
    for (let i = 0; i < 5; i++) { c.fillStyle = i < lives ? RED : 'rgba(233,68,46,0.3)'; c.fillRect(x + 16 + i * 30, y + 76, 24, 30); }
    c.fillText(`${lives}/5`, x + 190, y + 80);
    const log = T < 0.35 ? 'L2 8bit.rom · loading' : T < FAILED ? '[QA] flag 1 → 2' : T < 2.1 ? 'qa failed x80' : T < BREAK ? '[QA] garbage x2' : 'L2 breached ✗';
    c.font = PIX(20); c.fillStyle = log.startsWith('[') ? RED : '#EDEDED'; c.fillText(log, x + 16, y + 142);
    if (T < BREAK) { c.fillStyle = RED; if (frameIdx(T) % 30 < 15) c.fillRect(x + 16 + c.measureText(log).width + 6, y + 138, 14, 26); }
  }

  // 76.8–78.48: the space shooter
  private arcade(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp } = this.ctx, T = f.lt, c = this.layer.ctx;
    this.layer.clear('#000');
    const rnd = mulberry32(3);
    for (let i = 0; i < 220; i++) { const x = rnd() * W, y = rnd() * H, s = rnd() < 0.2 ? 6 : 4; c.fillStyle = `rgba(255,255,255,${0.4 + 0.6 * hash(i, frameIdx(T) >> 3)})`; c.fillRect(x, (y + T * 40 * (s / 4)) % H, s, s); }
    const tilt = ease.inCubic(prog(T, TILT, WELL));
    c.save();
    // the play field tips back into 3D at the end (a hint before the cut)
    c.translate(W / 2, H * 0.6); c.transform(1, 0, -0.4 * tilt, 1 - 0.4 * tilt, 0, 0); c.translate(-W / 2, -H * 0.6);
    // invaders: kaomoji text in rows, marching in steps
    const step = Math.floor(T / 0.2), dx = (step % 4 < 2 ? 1 : -1) * 22 * ((step % 2) + 0.5), gather = prog(T, FAILED - 0.2, TILT);
    c.font = PIX(32); c.textBaseline = 'middle';
    const row = (y: number, xs: number[], col: string, txt: string) => { c.fillStyle = col; for (const x of xs) c.fillText(txt, x + dx * (1 - gather), y); };
    if (gather < 0.5) {
      row(460, [430, 560, 690, 880, 1010, 1210, 1340, 1470], CYAN, "'(ω)'");
      row(516, [430, 880, 1210], CYAN, "'(ω)'");
      row(572, [430, 650, 780, 1090, 1220, 1430], CYAN, "'(ω)'");
      row(670, [880, 1010], '#E8E8E8', '.(ω).'); row(726, [880], '#E8E8E8', '.(ω).');
      row(780, [430, 650, 880, 1200, 1420], '#E8E8E8', T < 0.5 ? '.(ω).' : "'(ω)'");
    }
    // the swarm gathers in the middle and the green ones grow from below
    if (gather > 0) {
      c.globalAlpha = Math.min(1, gather * 2);
      for (let j = 0; j < 5; j++) for (let i = 0; i < 11; i++) { c.fillStyle = '#E8E8E8'; c.fillText("'(ω)'", 600 + i * 110 + dx * 0.3, 600 + j * 52 + gather * 20); }
      c.globalAlpha = 1;
    }
    const greens = Math.floor(prog(T, 0.55, FLASH) * 28);
    for (let k = 0; k < greens; k++) { c.fillStyle = GREEN; c.fillText("'(ω)'", 760 + (k % 7) * 110 - (k > 13 ? 220 : 0) + (k % 2) * 20, 845 + Math.floor(k / 7) * 46 - (k > 13 ? 60 : 0)); }
    // bunkers and the guard ship
    for (const x of [330, 700, 1130, 1510]) { c.save(); c.translate(x, 925); c.scale(1.35, 1.35); c.translate(-x, -925); c.fillStyle = RED; c.beginPath(); c.moveTo(x - 60, 940); c.lineTo(x - 60, 905); c.quadraticCurveTo(x, 870, x + 60, 905); c.lineTo(x + 60, 940); c.lineTo(x + 30, 940); c.lineTo(x + 20, 920); c.lineTo(x - 20, 920); c.lineTo(x - 30, 940); c.closePath(); c.fill(); c.restore(); }
    c.font = PIX(30); c.fillStyle = RED; c.textAlign = 'center'; c.fillText('(;´A`)', 980 + Math.sin(T * 5) * 60, 975); c.textAlign = 'left';
    c.strokeStyle = RED; c.lineWidth = 4; c.beginPath(); c.moveTo(0, 1052); c.lineTo(W, 1052); c.stroke();
    // shots
    for (let i = 0; i < 6; i++) { const t0 = i * 0.23, p = ((T - t0) % 0.6) / 0.6; if (T < t0) continue; c.fillStyle = GREEN; c.fillRect(980 + Math.sin(t0 * 5) * 60, 940 - p * 500, 6, 22); }
    // the face: holds at the top, drops into the swarm, flashes
    const fy = keys(T, [[0, 10], [DROP, 10], [FLASH, 560, ease.inQuad], [FLASH + 0.15, 560], [TILT, 10, ease.outCubic]]), fs = keys(T, [[0, 30], [DROP, 30], [FLASH, 34], [TILT, 30]]);
    this.bigFace(c, W / 2 - 9 * fs, fy, fs, 1);
    c.restore();
    if (T > FLASH - 0.05 && T < FLASH + 0.25) {
      const a = 1 - prog(T, FLASH, FLASH + 0.25);
      for (let i = 0; i < 40; i++) { const an = (i / 40) * Math.PI, r = 300 + 500 * prog(T, FLASH, FLASH + 0.25); c.fillStyle = `rgba(255,190,80,${a})`; c.fillRect(W / 2 + Math.cos(an) * r * 1.6, 1000 - Math.sin(an) * r, 8, 8); }
    }
    this.hud(c, T);
    comp.draw(renderer, this.layer.upload(), out, { mode: 'replace' });
    return { bloom: 0.75, bloomThreshold: 0.6, ca: 1.5, grain: 0.03, vignette: 0.25, crt: 0.5, crtCurve: 0.02, crtLines: 300 };
  }

  // 78.48–79.85: the voxel well, then it breaks
  private well(f: Frame, out: THREE.WebGLRenderTarget) {
    const { renderer, comp } = this.ctx, T = f.lt, u = T - WELL;
    const brk = Math.max(0, T - BREAK), cols = [0x4fc6e8, 0xf0509a, 0xf6d23c, 0x3a6fe8, 0x3ccb8a, 0xe9442e, 0x66e0d0];
    // line clears: a row goes dark, then the rows above drop one
    const clears: [number, number][] = [[2.0, 6], [2.35, 8]];
    this.cells.forEach((cl, i) => {
      let y = cl.y, s = 1;
      for (const [tc, row] of clears) { if (cl.row === row && T > tc && T < tc + 0.12) s = 0.05; if (cl.row > row && cl.row < 50 && T > tc + 0.12) y -= ease.outCubic(prog(T, tc + 0.12, tc + 0.2)); }
      const p = new THREE.Vector3(cl.x, y, cl.z);
      this.q.identity();
      const b = Math.max(0, T - SHATTER - hash(i, 9) * 0.18);
      if (b > 0 && cl.row !== 99) {
        p.addScaledVector(cl.v, b * 0.55).y -= 4 * b * b;
        this.q.setFromEuler(new THREE.Euler(cl.spin.x * b, cl.spin.y * b, cl.spin.z * b));
        this.cubes.setColorAt(i, new THREE.Color(cols[Math.floor(hash(i, 3) * cols.length)]!));
      } else this.cubes.setColorAt(i, cl.col);
      this.m.compose(p, this.q, new THREE.Vector3(s, s, s));
      this.cubes.setMatrixAt(i, this.m);
    });
    this.cubes.instanceMatrix.needsUpdate = true;
    this.shards.visible = brk > 0;
    if (brk > 0) {
      const rr = mulberry32(77);
      for (let i = 0; i < 360; i++) {
        const x0 = rr() * 12, y0 = rr() * 9, a = rr() * Math.PI * 2, sp = 6 + rr() * 20, d = Math.max(0, brk - rr() * 0.1);
        const p = new THREE.Vector3(x0 + Math.cos(a) * sp * d * 0.6, y0 + Math.sin(a) * sp * d * 0.6, 0.6 + sp * d * 1.2);
        this.q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(Math.cos(a) * 0.5, Math.sin(a) * 0.5, 1).normalize());
        this.m.compose(p, this.q, new THREE.Vector3(1, 1, 1 + d * 6));
        this.shards.setMatrixAt(i, this.m);
      }
      this.shards.instanceMatrix.needsUpdate = true;
    }
    if (this.cubes.instanceColor) this.cubes.instanceColor.needsUpdate = true;
    // the camera: swings in from a tipped angle, then a slow push; a shake on the break
    const yaw = keys(u, [[0, 0.75], [0.3, 0.3, ease.outCubic], [1.4, 0.26]]), dist = keys(u, [[0, 24], [0.3, 17.5, ease.outCubic], [1.4, 16.5]]);
    const sh = brk > 0 ? Math.sin(brk * 60) * 0.06 * Math.exp(-brk * 8) : 0;
    this.cam.position.set(5.5 - Math.sin(yaw) * dist + sh, 14 + sh, Math.cos(yaw) * dist);
    this.cam.up.set(-Math.sin(keys(u, [[0, 0.22], [0.3, 0.05, ease.outCubic], [1.4, 0.03]])), 1, 0).normalize();
    this.cam.lookAt(5.6, 6.4, 0);
    renderer.setRenderTarget(out); renderer.setClearColor(0x000000, 1); renderer.clear(true, true, true);
    renderer.render(this.world, this.cam);
    const c = this.ui.ctx; this.ui.clear();
    this.hud(c, T, true);
    if (T >= BREAK) { c.font = PIX(26); c.fillStyle = '#E8E8E8'; c.textAlign = 'right'; c.fillText('LINES 7429', W - 40, 40); c.textAlign = 'left'; }
    comp.draw(renderer, this.ui.upload(), out);
    return { bloom: 0.5, bloomThreshold: 0.85, ca: 1.5 + 4 * Math.exp(-brk * 6) * (brk > 0 ? 1 : 0), grain: 0.03, vignette: 0.3, radial: brk > 0 ? 0.08 : 0 };
  }
}

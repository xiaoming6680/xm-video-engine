// 序列帧示例（?plate；?plate=exr 换半分辨率的 EXR）：refs/plate_test/ 的测试序列当底——弹跳的球、地面网格、慢慢绕的相机，
// 30 fps，运动模糊烘在帧里，左上大号帧号、左下帧号条码（抽帧自动核对用）。上面叠引擎自己画的：按每帧相机 JSON 摆的
// 3D 圆环套住球、球下的落点圈和垂线（3D 对不对得上），右上角引擎算出的帧号和时间，底部两颗扫过的光点
// （快门 1 跟着引擎的运动模糊拖影，快门 0 不糊）。泛光照常开，证明后期也走。
// 测试序列不进 git（refs/ 被忽略），由一段 Python 脚本生成；没有它时画面上写明。用来看部件，不是画面标准。
//
// ?plate=blender：Blender 渲的示例镜头 assets/blender/drop/（tools/blender/render.py + shots_example.py，按歌曲帧号 60 fps，
// 半浮点 EXR 优先、没有就 PNG；渲了哪些帧看同目录的 frames.json）。上面叠：按 cam.json 每帧相机摆的 3D 标记——
// 套住镀铬句号的圆环、套住几颗会被波推动的小球的小圈、每个字母中心的十字和落点圈，旁边是引擎写的字母高度；
// 右上角引擎帧号和序列帧号（一致时 SYNC）。标记贴着 Blender 的物体走，说明帧号和相机都对上了。
import * as THREE from 'three';
import type { Frame, PostOverrides } from '../../engine/scene';
import { Layer2D, W, H } from '../../engine/gl';
import { F, font } from '../../engine/type';
import { frameIdx, shutterT } from '../../engine/util';
import { renderInto } from '../../engine/world';
import { PlateScene, type PlateOptions } from '../kit/plate';

const MODE = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('plate') : null;
const EXR = MODE === 'exr';
const BLENDER = MODE === 'blender';
const DIR = '/refs/plate_test';
/** The Blender example shot (tools/blender/shots_example.py, shot 'drop'). */
const BDIR = '/assets/blender/drop';
/** The test ball's radius (world units, as the generator renders it). */
const R_BALL = 0.5;
/** shots_example.py's sizes (metres, Blender scene): the chrome full stop, the bed balls, the bed's top. */
const B_DOT = 0.27, B_BALL = 0.105, B_BED = 0.21;
const WORD = 'DROP';

/** frames.json written by render.py: which frames of the shot are on disk. */
interface Manifest { fps: number; formats: Record<string, { first: number; last: number; count: number; missing: number[] }> }

const cyan = (k = 1) => new THREE.Color(0.3 * k, 1.5 * k, 2.2 * k);

export default class DemoPlate extends PlateScene {
  layer = new Layer2D();
  world = new THREE.Scene();
  cam = new THREE.PerspectiveCamera(40, W / H, 0.1, 100);
  // HDR colours: the bloom picks them up
  ring = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.022, 12, 96), new THREE.MeshBasicMaterial({ color: cyan() }));
  spot = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.46, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: cyan(), side: THREE.DoubleSide }));
  drop = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 1, 8).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 0.8, 1.1) }));
  /** ?plate=blender: markers in the Blender shot's world (three's axes: parseCameras converted them). */
  bm: { dot: THREE.Mesh; balls: THREE.Mesh[]; cross: THREE.Group[]; feet: THREE.Mesh[] } | null = null;
  seq: { ext: string; first: number; last: number; count: number } | null = null;
  /** Why the sequence could not be shown (refs/plate_test/ not generated, assets/blender/drop/ not rendered). */
  missing = '';

  protected override plateOptions(): PlateOptions {
    if (BLENDER) {
      const s = this.seq!;
      // frame numbers are the song's 60 fps frames: frame n shows from n / 60
      return { src: `${BDIR}/####.${s.ext}`, fps: 60, first: s.first, last: s.last, at: s.first / 60, outside: 'hold', camera: `${BDIR}/cam.json` };
    }
    return {
      src: EXR ? `${DIR}/exr/####.exr` : `${DIR}/png/####.png`,
      fps: 30, first: 1, last: 90, at: this.ctx.start, outside: 'loop', camera: `${DIR}/camera.json`,
    };
  }

  override async init() {
    if (BLENDER) this.initBlender();
    else this.world.add(this.ring, this.spot, this.drop);
    if (BLENDER) {
      try {
        const r = await fetch(`${BDIR}/frames.json`);
        if (!r.ok || /text\/html/.test(r.headers.get('content-type') ?? '')) throw new Error(`${BDIR}/frames.json not found`);
        const m = (await r.json()) as Manifest;
        const ext = m.formats.exr ? 'exr' : 'png', f = m.formats[ext];
        if (!f) throw new Error(`${BDIR}/frames.json lists no frames`);
        this.seq = { ext, first: f.first, last: f.last, count: f.count };
      } catch (e) {
        this.missing = String((e as Error)?.message ?? e);
        this.seq = { ext: 'png', first: 0, last: 0, count: 0 }; // (a plate that shows nothing: render() still has one)
      }
    }
    try { await super.init(); } catch (e) { this.missing ||= String((e as Error)?.message ?? e); }
  }

  private initBlender() {
    const mat = (c: THREE.Color) => new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide, depthTest: false, transparent: true });
    const dot = new THREE.Mesh(new THREE.TorusGeometry(B_DOT * 1.16, 0.006, 8, 128), mat(cyan(1.2)));
    const balls = [0, 1, 2, 3].map(() => new THREE.Mesh(new THREE.TorusGeometry(B_BALL * 1.12, 0.0035, 8, 64), mat(new THREE.Color(2.2, 1.6, 0.25))));
    const cross = [...WORD].map(() => {
      const g = new THREE.Group(), m = mat(cyan());
      for (const ax of [0, 1, 2]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(ax === 0 ? 0.16 : 0.006, ax === 1 ? 0.16 : 0.006, ax === 2 ? 0.16 : 0.006), m);
        g.add(bar);
      }
      return g;
    });
    // landing marks: flat rings on the bed's top under each letter (an ellipse in perspective)
    const feet = [...WORD].map(() => new THREE.Mesh(new THREE.RingGeometry(0.34, 0.352, 96).rotateX(-Math.PI / 2), mat(cyan(0.8))));
    this.world.add(dot, ...balls, ...cross, ...feet);
    this.bm = { dot, balls, cross, feet };
  }

  protected override overlay(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    return BLENDER ? this.overlayBlender(f, out) : this.overlayTest(f, out);
  }

  private overlayBlender(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    const r = this.ctx.renderer, c = this.layer.ctx;
    this.layer.clear();
    const rec = this.plate?.camera(f.t);
    const labels: [string, THREE.Vector3][] = [];
    if (rec?.points && this.bm && this.plate.applyCamera(this.cam, f.t)) {
      const P = rec.points, b = this.bm;
      const at = (k: string) => (P[k] ? new THREE.Vector3(...P[k]) : null);
      const d = at('dot');
      b.dot.visible = !!d;
      if (d) { b.dot.position.copy(d); b.dot.quaternion.copy(this.cam.quaternion); }
      b.balls.forEach((m, i) => {
        const p = at(`b${i}`);
        m.visible = !!p;
        if (p) { m.position.copy(p); m.quaternion.copy(this.cam.quaternion); }
      });
      [...WORD].forEach((ch, i) => {
        const p = at(ch);
        b.cross[i]!.visible = b.feet[i]!.visible = !!p;
        if (!p) return;
        b.cross[i]!.position.copy(p);
        b.feet[i]!.position.set(p.x, B_BED + 0.002, p.z);
        labels.push([`${ch}  ${(p.y - B_BED).toFixed(2)} m`, p]);
      });
      renderInto(r, this.world, this.cam, out, null);
    }

    // labels next to the letters' centres (projected with the same camera)
    c.font = font(F.mono(500), 18);
    c.textAlign = 'left';
    for (const [s, p] of labels) {
      const v = p.clone().project(this.cam);
      if (v.z > 1) continue;
      const x = (v.x * 0.5 + 0.5) * W, y = (0.5 - v.y * 0.5) * H;
      c.fillStyle = 'rgba(20,24,48,0.55)';
      c.beginPath(); c.roundRect(x + 14, y - 34, c.measureText(s).width + 16, 26, 6); c.fill();
      c.fillStyle = '#bff3ff';
      c.fillText(s, x + 22, y - 15);
    }

    // engine frame vs plate frame (the frame's own time: numbers don't smear)
    const tf = shutterT(f.t, 0), n = this.plate?.frameAt(f.t) ?? null, e = frameIdx(tf);
    const inside = this.seq && e >= this.seq.first && e <= this.seq.last;
    c.textAlign = 'right';
    c.fillStyle = 'rgba(20,24,48,0.8)';
    c.font = font(F.mono(500), 22);
    c.fillText(`ENGINE #${String(e).padStart(4, '0')} · t ${tf.toFixed(3)} s`, W - 72, 84);
    c.font = font(F.sans(700), 64);
    c.fillText(n === null ? '—' : `PLATE #${String(n).padStart(4, '0')}`, W - 72, 150);
    c.font = font(F.mono(500), 20);
    c.fillStyle = !inside ? 'rgba(20,24,48,0.6)' : n === e ? '#0b8a5a' : '#d0263e';
    c.fillText(!inside ? `outside the rendered range (hold)` : n === e ? 'SYNC · Blender plate, 60 fps, cam.json' : 'FRAME MISMATCH', W - 72, 184);
    if (this.seq) {
      c.fillStyle = 'rgba(20,24,48,0.6)';
      c.fillText(`${this.seq.ext.toUpperCase()} ${this.seq.first}–${this.seq.last} (${this.seq.count} frames)`, W - 72, 212);
    }

    if (this.missing || this.plate?.failed.size) {
      c.textAlign = 'center';
      c.fillStyle = '#ffd27f';
      c.font = font(F.sans(600), 32);
      c.fillText('没有找到 Blender 序列 assets/blender/drop/（不在 git 里，先用 tools/blender/render.py 渲）', W / 2, H / 2);
      c.font = font(F.mono(400), 20);
      c.fillText('blender -b --factory-startup -P tools/blender/render.py -- --shots shots_example --shot drop --exr', W / 2, H / 2 + 44);
      c.fillText(this.missing || `${this.plate.failed.size} frame(s) failed to load`, W / 2, H / 2 + 76);
    }
    this.ctx.comp.draw(r, this.layer.upload(), out);
    // the plate is display-referred (≤ 1): bloom only the HDR markers (no soft knee, or the pastel plate glows too)
    return { bloom: 0.3, bloomThreshold: 1.05, bloomKnee: 0 };
  }

  private overlayTest(f: Frame, out: THREE.WebGLRenderTarget): PostOverrides {
    const r = this.ctx.renderer;
    // 3D in the plate's world: the camera and the ball's position of the frame shown (held like the image, so no blur)
    const ball = this.plate.camera(f.t)?.points?.ball;
    if (ball && this.plate.applyCamera(this.cam, f.t)) {
      const [x, y, z] = ball;
      this.ring.position.set(x, y, z);
      this.ring.quaternion.copy(this.cam.quaternion); // facing the camera
      this.spot.position.set(x, 0.004, z);
      this.drop.position.set(x, 0, z);
      this.drop.scale.y = Math.max(1e-3, y - R_BALL);
      renderInto(r, this.world, this.cam, out, null);
    }

    const c = this.layer.ctx;
    this.layer.clear();
    // the frame's own time (not the sub-frame's): numbers don't smear
    const tf = shutterT(f.t, 0), n = this.plate.frameAt(f.t);
    c.textAlign = 'right';
    c.fillStyle = 'rgba(127,231,255,0.95)';
    c.font = font(F.mono(500), 26);
    c.fillText('ENGINE', W - 80, 92);
    c.font = font(F.sans(700), 96);
    c.fillText(n === null ? '—' : `#${String(n).padStart(4, '0')}`, W - 80, 190);
    c.font = font(F.mono(400), 24);
    c.fillText(`t ${tf.toFixed(3)} s · plate 30 fps · ${EXR ? 'EXR half float' : 'PNG 8-bit'}`, W - 80, 232);

    // two dots sweeping along the bottom at 3000 px/s: shutter 1 smears with the engine's motion blur, shutter 0 stays crisp
    ([[1, 850], [0, 900]] as const).forEach(([k, y]) => {
      const x = ((shutterT(f.t, k) * 3000) % (W + 200)) - 100;
      c.fillStyle = '#7fe7ff';
      c.beginPath(); c.roundRect(x - 20, y - 9, 40, 18, 9); c.fill();
      c.fillStyle = 'rgba(255,255,255,0.75)';
      c.font = font(F.mono(400), 20);
      c.fillText(`shutter ${k}`, W - 80, y + 7);
    });

    if (this.missing || this.plate.failed.size) {
      c.textAlign = 'center';
      c.fillStyle = '#ffd27f';
      c.font = font(F.sans(600), 34);
      c.fillText('没有找到测试序列 refs/plate_test/（不在 git 里，要先用 Python 脚本生成）', W / 2, H / 2);
      c.font = font(F.mono(400), 20);
      c.fillText(this.missing || `${this.plate.failed.size} frame(s) failed to load`, W / 2, H / 2 + 44);
    }
    this.ctx.comp.draw(r, this.layer.upload(), out);
    return { bloom: EXR ? 0.6 : 0.35 };
  }
}

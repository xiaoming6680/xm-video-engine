// 导入的模型（glTF / GLB）：Blender、模型库或别处来的模型放进 three 场景，动画按时间逐帧确定地摆（倒放、跳帧、子帧都一样）。
// 不替画面做决定：材质、灯光、摆在哪都是场景自己的事；这里只管读进来、量尺寸、摆姿势。
//
//   model = await loadModel('/assets/models/robot.glb');               // 场景 init 里；文件放在 assets/（开发服务器服务的目录）
//   model.fit({ height: 1.8 }).shadows();                               // 按高度缩放（米）、底部落地、水平居中；投影 / 接受阴影
//   world.add(model.root);                                              // three 场景（Comp 的 three 图层，或自己渲）
//   model.pose(t - 2.0, 'Walk');                                        // 每帧：动画 Walk 在它自己的第 t − 2 秒（默认循环）
//   model.pose(t, 'Jump', { loop: 'once' });                            // 播一次停在最后一帧；'pingpong' 来回
//   model.pose([{ clip: 'Walk', t, weight: 0.4 }, { clip: 'Run', t, weight: 0.6 }]);   // 几段混在一起
//   const b = model.clone();                                            // 再摆一个（共用几何和材质，骨骼动画各走各的）
//   model.find('Head')                                                  // 按名字找节点（Blender 里的物体名）
//   model.clips.map((c) => [c.name, c.duration])                        // 文件里有哪些动画
//
// 压缩：Draco、Meshopt 的模型直接能读；KTX2 纹理要传 { renderer }。Draco 和 KTX2 的解码器由开发服务器从 three 的包里给
// （vite.config.ts 的 /__three/）。单位：glTF 是米、y 向上，Blender 导出时自动转好。
// 动画确定性：pose 每次按给的时间把用到的动画设到那一刻再求值，不靠累加的 delta；不同动画之间没有自动过渡（要过渡就自己给 weight）。
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

export type Loop = 'repeat' | 'once' | 'pingpong';
export interface ClipPose { clip: string | number; t: number; weight?: number; loop?: Loop; speed?: number }

/** Clip time for a play time t under a loop mode (pure: tests/model.test.ts). */
export function clipTime(t: number, duration: number, loop: Loop = 'repeat'): number {
  if (!(duration > 0)) return 0;
  // (just short of the end: three's LoopOnce at exactly the duration counts as finished)
  const end = duration - 1e-6;
  if (loop === 'once') return Math.min(end, Math.max(0, t));
  if (loop === 'pingpong') {
    const u = ((t % (2 * duration)) + 2 * duration) % (2 * duration);
    return Math.min(end, u <= duration ? u : 2 * duration - u);
  }
  return Math.min(end, ((t % duration) + duration) % duration);
}

export class Model {
  /** Put this in the scene. */
  readonly root: THREE.Object3D;
  readonly clips: THREE.AnimationClip[];
  /** Cameras in the file (Blender cameras exported with it). */
  readonly cameras: THREE.Camera[];
  private mixer: THREE.AnimationMixer | null;
  private actions = new Map<THREE.AnimationClip, THREE.AnimationAction>();

  constructor(root: THREE.Object3D, clips: THREE.AnimationClip[] = [], cameras: THREE.Camera[] = []) {
    this.root = root;
    this.clips = clips;
    this.cameras = cameras;
    this.mixer = clips.length ? new THREE.AnimationMixer(root) : null;
  }

  /** A clip by name or index (undefined: none). */
  clip(c: string | number): THREE.AnimationClip | undefined {
    return typeof c === 'number' ? this.clips[c] : this.clips.find((x) => x.name === c);
  }

  /**
   * Pose the model: `clip` (name or index; default the first) at its own time t, or several clips with weights. Every
   * clip not named is switched off, so a pose depends only on what this call asks for.
   */
  pose(t: number | ClipPose[], clip: string | number = 0, o: { loop?: Loop; speed?: number; weight?: number } = {}): this {
    if (!this.mixer) return this;
    const list: ClipPose[] = typeof t === 'number' ? [{ clip, t, ...o }] : t;
    const on = new Set<THREE.AnimationAction>();
    for (const p of list) {
      const c = this.clip(p.clip);
      if (!c) { warnOnce(`model: no clip '${p.clip}' (has ${this.clips.map((x) => x.name).join(', ') || 'none'})`); continue; }
      let a = this.actions.get(c);
      if (!a) {
        a = this.mixer.clipAction(c);
        a.setLoop(THREE.LoopRepeat, Infinity);
        a.clampWhenFinished = true;
        this.actions.set(c, a);
      }
      a.enabled = true;
      a.paused = false;
      a.timeScale = 1;
      a.setEffectiveWeight(p.weight ?? 1);
      a.play();
      a.time = clipTime(p.t * (p.speed ?? 1), c.duration, p.loop ?? 'repeat');
      on.add(a);
    }
    for (const a of this.actions.values()) if (!on.has(a)) { a.enabled = false; a.setEffectiveWeight(0); }
    this.mixer.update(0);
    this.root.updateMatrixWorld(true);
    return this;
  }

  /** Bounding box in the parent's space (current pose). */
  bounds(): THREE.Box3 {
    this.root.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(this.root, true);
  }

  /** Size of the bounding box (m). */
  get size(): THREE.Vector3 { return this.bounds().getSize(new THREE.Vector3()); }

  /**
   * Scale to a height or width (m, uniform), put the bottom on y = 0 (`ground`, default true) and centre it in x and z
   * (`center`, default true). Measured at the current pose.
   */
  fit(o: { height?: number; width?: number; ground?: boolean; center?: boolean } = {}): this {
    const r = this.root;
    const s0 = this.size;
    const k = o.height ? o.height / Math.max(1e-9, s0.y) : o.width ? o.width / Math.max(1e-9, Math.max(s0.x, s0.z)) : 1;
    r.scale.multiplyScalar(k);
    const b = this.bounds(), c = b.getCenter(new THREE.Vector3());
    if (o.center !== false) { r.position.x -= c.x; r.position.z -= c.z; }
    if (o.ground !== false) r.position.y -= b.min.y;
    r.updateMatrixWorld(true);
    return this;
  }

  /** Cast / receive shadows on every mesh (setupRenderer in world.ts turns the shadow map on). */
  shadows(cast = true, receive = true): this {
    this.root.traverse((m) => { if ((m as THREE.Mesh).isMesh) { m.castShadow = cast; m.receiveShadow = receive; } });
    return this;
  }

  /** A node by name (Blender object name). */
  find(name: string): THREE.Object3D | undefined { return this.root.getObjectByName(name); }

  /** Another copy: shares geometry, materials and clips; skinned meshes get their own skeleton. */
  clone(): Model {
    return new Model(cloneSkinned(this.root), this.clips, this.cameras);
  }
}

const warned = new Set<string>();
function warnOnce(m: string) { if (!warned.has(m)) { warned.add(m); console.warn(m); } }

let draco: DRACOLoader | null = null;
let ktx2: KTX2Loader | null = null;

/** Load a .glb / .gltf. `renderer` is only needed for KTX2 textures. */
export async function loadModel(url: string, o: { renderer?: THREE.WebGLRenderer } = {}): Promise<Model> {
  const loader = new GLTFLoader();
  draco ??= new DRACOLoader().setDecoderPath('/__three/draco/gltf/');
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);
  if (o.renderer) {
    ktx2 ??= new KTX2Loader().setTranscoderPath('/__three/basis/').detectSupport(o.renderer);
    loader.setKTX2Loader(ktx2);
  }
  let g: GLTF;
  try {
    g = await loader.loadAsync(url);
  } catch (e) {
    throw new Error(`loadModel ${url}: ${e instanceof Error ? e.message : e}`);
  }
  return new Model(g.scene, g.animations, g.cameras);
}

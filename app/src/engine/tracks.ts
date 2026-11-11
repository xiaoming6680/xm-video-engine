// 可拖的关键帧轨道：代码里给默认关键帧，预览里按 G 打开曲线编辑器直接拖，改动存在 app/src/tracks.json，导出照它渲。
//
//   import { kfe } from '../engine/tracks';
//   import { K } from '../engine/anim';
//   const y = kfe(f.lt, 'title.y', [[0, 300, K.go], [0.6, 0, K.land]]);   // 和 kf(t, keys) 一样用，多一个名字
//
// - 名字在场景里唯一就行，引擎自动在前面加时间线条目的 id（'hook/title.y'），同一个场景模块用在两个条目上各管各的
// - tracks.json 里有这个名字，就用 json 里的关键帧，代码里的只是默认值；编辑器里「恢复代码里的」会删掉 json 里那条
// - 传什么时间都行（f.t、f.lt、自己算的），编辑器按这一帧的歌曲秒和传进来的时间之差，把关键帧画在整片的时间上
// - 只做标量；位置拆成 x、y 两条（AE 的「单独尺寸」）。时间线条目的 remap（时间重映射）也是一条可拖的轨道
// - Agent 也可以直接改 tracks.json（格式就是 kf 的关键帧数组），改完刷新预览
// - 输出只取决于 t：tracks.json 在启动时读一次，导出和预览读的是同一份
import { kf, type Key } from './anim';

export type Keys = Key<number>[];

export interface TrackInfo {
  /** 带条目 id 前缀的全名，比如 'hook/title.y'。 */
  id: string;
  /** 条目 id（scene），轨道名（name）。 */
  scene: string;
  name: string;
  /** 代码里给的默认关键帧。 */
  code: Keys;
  /** 最近一次调用：传进来的时间、那一帧的歌曲秒（两者之差把关键帧放到整片时间上）、取到的值。 */
  argT: number;
  songT: number;
  value: number;
}

/** 引擎在每个场景 render 前设：当前条目 id 和歌曲秒（和 glyphScope 一样的做法）。 */
export const trackScope = { id: '', t: 0 };

const registry = new Map<string, TrackInfo>();
let overrides: Record<string, Keys> = {};
const listeners = new Set<() => void>();

/** 读 tracks.json（boot 时调一次）。没有这个文件就全用代码里的。 */
export async function loadTracks(): Promise<void> {
  try {
    const r = await fetch('/__tracks', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    overrides = (j && typeof j === 'object' && j.tracks) || {};
  } catch { /* 静态构建或没开 dev 服务器：用代码里的 */ }
}

/** 可编辑的标量关键帧：用法同 kf(t, keys)，名字用来在编辑器和 tracks.json 里认它。 */
export function kfe(t: number, name: string, keys: readonly Key<number>[]): number {
  const id = trackScope.id ? `${trackScope.id}/${name}` : name;
  const ks = overrides[id] ?? (keys as Keys);
  const v = kf(t, ks);
  let r = registry.get(id);
  if (!r) {
    r = { id, scene: trackScope.id, name, code: keys as Keys, argT: t, songT: trackScope.t, value: v };
    registry.set(id, r);
  } else { r.code = keys as Keys; r.argT = t; r.songT = trackScope.t; r.value = v; }
  return v;
}

/** 编辑器用：所有见过的轨道。 */
export function allTracks(): TrackInfo[] { return [...registry.values()]; }
/** 这条轨道现在用的关键帧（json 里的，没有就是代码里的）。 */
export function keysOf(id: string): Keys { return overrides[id] ?? registry.get(id)?.code ?? []; }
export function isOverridden(id: string): boolean { return id in overrides; }
/** 改一条轨道（编辑器拖动时调）；undefined = 删掉 json 里那条，回到代码里的。 */
export function setKeys(id: string, keys: Keys | undefined) {
  if (keys) overrides[id] = keys.map((k) => [k[0], k[1], k[2]] as Key<number>).sort((a, b) => a[0] - b[0]);
  else delete overrides[id];
  for (const f of listeners) f();
}
export function onTracksChange(f: () => void) { listeners.add(f); return () => listeners.delete(f); }
/** 整份 json（编辑器保存时写回 app/src/tracks.json）。 */
export function tracksJSON(): string {
  const tracks: Record<string, Keys> = {};
  for (const id of Object.keys(overrides).sort()) tracks[id] = overrides[id]!;
  return JSON.stringify({ version: 1, tracks }, null, 1) + '\n';
}

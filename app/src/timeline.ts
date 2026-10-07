// 剪辑表：哪个场景模块在哪段歌曲时间里（歌曲秒）。场景文件放在 src/scenes/<name>.ts，默认导出 Scene 子类。
// 窗口首尾相接就是硬切；重叠就是转场（默认交叉淡化，场景设 handlesTransition 可自己合成）。
// 时间尽量从数据推出来（lyrics.get(...).start、audio.timeOfBar(k)），少写死数字。
import type { TimelineEntry } from './engine/engine';
import type { SceneClass } from './engine/scene';
import type { Lyrics } from './engine/lyrics';
import type { AudioData } from './engine/audio';

const modules = import.meta.glob<{ default: SceneClass }>('./scenes/*.ts');
const scene = (name: string) => () => {
  const m = modules[`./scenes/${name}.ts`];
  return m ? m() : Promise.reject(new Error(`scene module not found: scenes/${name}.ts`));
};

export function makeTimeline(_ly: Lyrics, au: AudioData): TimelineEntry[] {
  const E = (id: string, file: string, start: number, end: number, extra: Partial<TimelineEntry> = {}): TimelineEntry =>
    ({ id, load: scene(file), start, end, ...extra });
  // ?sky：只载入天空示例（云海、光点、日出光束、镜头虚化，scenes/demo_sky.ts），不在默认示例里
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('sky')) return [E('demo-sky', 'demo_sky', 0, au.duration)];
  // ?ref=<名>：参考片逐帧复刻（scenes/ref_<名>.ts，docs/复刻配方.md），场景从 0 秒开始、本地时间对齐原片那一段
  const REF: Record<string, number> = { boot: 2.7, stack: 2.6, rhythm: 3.6, kaleido: 3.1, record: 1.65, droste: 3.2, glitch: 1.65, crash: 8.1, invader: 3.05, stage: 4.0 };
  const ref = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('ref') ?? (new URLSearchParams(location.search).has('boot') ? 'boot' : null) : null;
  if (ref && REF[ref]) return [E(`ref-${ref}`, `ref_${ref}`, 0, REF[ref]!)];
  // ?ref=intro：原片前 16 小节（0–25.6 s）从头连着复刻，镜头首尾相接、转场是真的，歌曲秒 = 原片秒。
  // 配原声：--song refs/kaomoji（tools/grid_song.py 从原片建，refs/ 不进仓库）
  if (ref === 'intro') return [
    E('intro-term', 'ref_intro_term', 0, 4.7),
    E('intro-boot', 'ref_boot', 4.7, 7.9, { params: { origin: 5.4, exit: 'eye' } }),
    E('intro-swiss', 'ref_intro_swiss', 7.9, 15.6),
    E('intro-pop', 'ref_intro_pop', 15.36, 22.2),
    E('intro-droste', 'ref_droste', 22.2, 25.6, { params: { origin: 22.2 } }),
  ];
  // 示例：2D 场景 3 小节，同一个模块换参数再 2 小节，然后 3D 场景到结尾（都在强拍上硬切）
  const b3 = au.timeOfBar(3), b5 = au.timeOfBar(5);
  return [
    E('demo-a', 'demo', 0, b3),
    E('demo-b', 'demo', b3, b5, { params: { inverted: true } }),
    E('demo-3d', 'demo3d', b5, au.duration),
  ];
}

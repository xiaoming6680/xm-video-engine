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
  // 示例：2D 场景 3 小节，同一个模块换参数再 2 小节，然后 3D 场景到结尾（都在强拍上硬切）
  const b3 = au.timeOfBar(3), b5 = au.timeOfBar(5);
  return [
    E('demo-a', 'demo', 0, b3),
    E('demo-b', 'demo', b3, b5, { params: { inverted: true } }),
    E('demo-3d', 'demo3d', b5, au.duration),
  ];
}

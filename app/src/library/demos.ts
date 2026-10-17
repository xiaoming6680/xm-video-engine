// 效果库的示例入口（只在基础引擎里有；timeline.ts 找到这个文件才用它；下面的路径相对 src/library/）。网址参数选一段示例，没有参数时返回 null，用项目自己的时间线。
//   ?sky                云海、空气光点、日出光束、镜头虚化（scenes/demo_sky.ts）
//   ?voxel              低多边形地形 + 体素字（scenes/demo_voxel.ts）
//   ?sfx=<组件名>       shaders 库的一个效果（kit/sfx.ts、scenes/demo_sfx.ts），&sfxprops=<JSON> 改 prop
//   ?sfx=showcase       示例场景被翻页（PagePeel）翻走，露出 3D 镀铬标题（scenes/demo_sfx_title.ts）
//   ?ref=<名>           参考片逐帧复刻的十段（scenes/ref_<名>.ts，docs/复刻配方.md 第四节），场景从 0 秒开始
//   ?ref=intro          原片前 16 小节连着复刻（粗分镜），配原声加 --song refs/kaomoji（tools/grid_song.py 建）
import type { TimelineEntry } from '../engine/engine';
import type { AudioData } from '../engine/audio';

type E = (id: string, file: string, start: number, end: number, extra?: Partial<TimelineEntry>) => TimelineEntry;

const REF: Record<string, number> = { boot: 2.7, stack: 2.6, rhythm: 3.6, kaleido: 3.1, record: 1.65, droste: 3.2, glitch: 1.65, crash: 8.1, invader: 3.05, stage: 4.0 };

export function demos(E: E, au: AudioData): TimelineEntry[] | null {
  if (typeof location === 'undefined') return null;
  const q = new URLSearchParams(location.search);
  if (q.has('sky')) return [E('demo-sky', 'demo_sky', 0, au.duration)];
  if (q.has('voxel')) return [E('demo-voxel', 'demo_voxel', 0, au.duration)];
  const sfx = q.get('sfx');
  if (sfx === 'showcase') return [E('sfx-a', 'demo', 0, 3), E('sfx-title', 'demo_sfx_title', 2, au.duration)];
  if (sfx) return [E('demo-sfx', 'demo_sfx', 0, au.duration)];
  const ref = q.get('ref') ?? (q.has('boot') ? 'boot' : null);
  if (ref && REF[ref]) return [E(`ref-${ref}`, `ref_${ref}`, 0, REF[ref]!)];
  // 镜头首尾相接、转场是真的，歌曲秒 = 原片秒
  if (ref === 'intro') return [
    E('intro-term', 'ref_intro_term', 0, 4.7),
    E('intro-boot', 'ref_boot', 4.7, 7.9, { params: { origin: 5.4, exit: 'eye' } }),
    E('intro-swiss', 'ref_intro_swiss', 7.9, 15.6),
    E('intro-pop', 'ref_intro_pop', 15.36, 22.2),
    E('intro-droste', 'ref_droste', 22.2, 25.6, { params: { origin: 22.2 } }),
  ];
  return null;
}

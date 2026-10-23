// 效果库的示例入口（只在基础引擎里有；timeline.ts 找到这个文件才用它；下面的路径相对 src/library/）。网址参数选一段示例，没有参数时返回 null，用项目自己的时间线。
//   ?sky                云海、空气光点、日出光束、镜头虚化（scenes/demo_sky.ts）
//   ?voxel              低多边形地形 + 体素字（scenes/demo_voxel.ts）
//   ?tactile            实物感：贴纸拍到桌上、影子随抬起高度变（kit/tactile.ts、scenes/demo_tactile.ts）
//   ?brush              手绘线：压力笔刷、线条沸腾、摄影表（kit/tegaki.ts、scenes/demo_brush.ts）
//   ?mg                 MG 动作：弹簧挤压、经圆变形、一笔画、镜头领先（kit/anim.ts、kit/morph.ts、scenes/demo_mg.ts）
//   ?caption            综艺花字和 HUD 字：五层花字、单字弹出、乱码解码（kit/textfx.ts、kit/termhud.ts、scenes/demo_caption.ts）
//   ?paper              纸片拼贴：剪刀边、撕边、按拍步进、真纸纹（engine/paper.ts、scenes/demo_paper.ts）
//   ?liquid             液态：SDF 融球和字标融合（kit/liquid.ts、scenes/demo_liquid.ts）
//   ?glass              玻璃拟态：色散折射、磨砂卡片（kit/glass.ts、scenes/demo_glass.ts）
//   ?plate              预渲染序列帧当场景（kit/plate.ts、scenes/demo_plate.ts）；?plate=blender 读 tools/blender 渲的示例镜头（assets/blender/drop/）
//   ?sfx=<组件名>       shaders 库的一个效果（kit/sfx.ts、scenes/demo_sfx.ts），&sfxprops=<JSON> 改 prop
//   ?sfx=showcase       示例场景被翻页（PagePeel）翻走，露出 3D 镀铬标题（scenes/demo_sfx_title.ts）
//   ?ref=<名>           参考片逐帧复刻的十段（scenes/ref_<名>.ts，docs/复刻配方.md 第四节），场景从 0 秒开始
//   ?ref=intro          原片前 16 小节连着复刻（粗分镜），配原声加 --song refs/kaomoji（tools/grid_song.py 建）
import type { TimelineEntry } from '../engine/engine';
import type { AudioData } from '../engine/audio';
import { PDOOM_LOOK } from '../engine/post';

type E = (id: string, file: string, start: number, end: number, extra?: Partial<TimelineEntry>) => TimelineEntry;

const REF: Record<string, number> = { boot: 2.7, stack: 2.6, rhythm: 3.6, kaleido: 3.1, record: 1.65, droste: 3.2, glitch: 1.65, crash: 8.1, invader: 3.05, stage: 4.0 };

// 这些场景是在旧默认后期（泛光、颗粒、暗角、色差、高光压缩）下调的，示例里照旧打开，画面和当初一样
export function demos(E0: E, au: AudioData): TimelineEntry[] | null {
  if (typeof location === 'undefined') return null;
  const E: E = (id, file, start, end, extra = {}) => E0(id, file, start, end, { post: PDOOM_LOOK, ...extra });
  const q = new URLSearchParams(location.search);
  if (q.has('sky')) return [E('demo-sky', 'demo_sky', 0, au.duration)];
  if (q.has('voxel')) return [E('demo-voxel', 'demo_voxel', 0, au.duration)];
  if (q.has('tactile')) return [E0('demo-tactile', 'demo_tactile', 0, au.duration)]; // 新写的，用中性默认后期
  for (const k of ['brush', 'mg', 'caption', 'paper', 'liquid', 'glass', 'plate']) if (q.has(k)) return [E0(`demo-${k}`, `demo_${k}`, 0, au.duration)];
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

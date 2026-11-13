// 效果库的示例入口（只在基础引擎里有；timeline.ts 找到这个文件才用它；下面的路径相对 src/library/）。网址参数选一段示例，没有参数时返回 null，用项目自己的时间线。
//   ?sky                云海、空气光点、日出光束、镜头虚化（scenes/demo_sky.ts）
//   ?voxel              低多边形地形 + 体素字（scenes/demo_voxel.ts）
//   ?tactile            实物感：贴纸拍到桌上、影子随抬起高度变（kit/tactile.ts、scenes/demo_tactile.ts）
//   ?brush              手绘线：压力笔刷、线条沸腾、摄影表（kit/tegaki.ts、scenes/demo_brush.ts）
//   ?mg                 MG 动作：弹簧挤压、经圆变形、一笔画、镜头领先（engine/anim.ts、kit/morph.ts、scenes/demo_mg.ts）
//   ?ease               AE 式缓动：关键帧的入 / 出速度和影响，和平滑曲线并排（engine/anim.ts、scenes/demo_ease.ts）
//   ?textanim           文字动画器：按字范围选择的位移、缩放、旋转、透明、模糊、字距、乱码（engine/textanim.ts、scenes/demo_textanim.ts）
//   ?shape              形状层：描边生长、虚线、重复器、路径抖动、路径变形（engine/shape.ts、scenes/demo_shape.ts）
//   ?blend              混合模式、轨道遮罩、预合成图层变换（engine/gl.ts、engine/precomp.ts、scenes/demo_blend.ts）
//   ?layers             图层系统和效果栈：3D 图层和摄像机、父子、fps、蒙版、效果、调整层、遮罩、回声、时间重映射，
//                       外加一条跨切点的时间线效果条（engine/layers.ts、engine/effects.ts、scenes/demo_layers.ts）
//   ?effects            效果栈：扭曲、转场、调色、图层样式、光，一格一个（engine/effects.ts、scenes/demo_effects.ts）
//   ?particles          粒子：喷泉、火花爆发、雪尘湍流、字散成粒子、3D 球面 + 摄像机、环和星芒（engine/particles.ts、scenes/demo_particles.ts）
//   ?pathops            路径运算（圆角、收缩膨胀、扭转、锯齿、位移）、合并路径、运动路径 + 自动朝向（engine/pathops.ts、anim.ts motionPath）
//   ?lights             灯光和投影：环境光、聚光灯（软影子）、平行光，材质的投影 / 接受 / 高光（layers.ts 的 lights、material）
//   ?deform             操控点（小人挥手、字随波弯）和碎裂（玻璃、放射状 + 裂纹传播）（engine/puppet.ts、shatter.ts）
//   ?camtrack           3D 摄像机反求：反求的摄像机 + 实拍，牌子立在地上、旗子插在反求的点上、地上冒火花（tools/camtrack.py、engine/track.ts；素材先用 camtrack.py --test 生成）
//   ?typeset            排字：竖排、沿路径排字、字里填图案（engine/textanim.ts、scenes/demo_typeset.ts）
//   ?reveal             到达时间和换张：按笔顺写字带笔尖、线稿一段一段描、光一档一档扩开、黑条擦掉、换张按锚点对齐
//                       （engine/arrival.ts、effects.ts 的 reveal、engine/swap.ts、scenes/demo_reveal.ts）
//   ?caption            综艺花字和 HUD 字：五层花字、单字弹出、乱码解码（kit/textfx.ts、kit/termhud.ts、scenes/demo_caption.ts）
//   ?paper              纸片拼贴：剪刀边、撕边、按拍步进、真纸纹（engine/paper.ts、scenes/demo_paper.ts）
//   ?liquid             液态：SDF 融球和字标融合（kit/liquid.ts、scenes/demo_liquid.ts）
//   ?glass              玻璃拟态：色散折射、磨砂卡片（kit/glass.ts、scenes/demo_glass.ts）
//   ?space              一台摄像机：3D 图层、three.js 场景、GLB 模型、视频素材在同一个空间里，3D 图层被 three 的物体挡住
//                       （engine/space.ts、layers.ts 的 three / footage、engine/model.ts、engine/plate.ts、scenes/demo_space.ts）
//   ?stage              2.5D 舞台：3D 图层逐像素互挡（窗陷进地面、交叉卡片）、视频四角钉进电视屏、朝向摄像机、depthScale、前景虚焦、
//                       折叠变换的窗（里面有纵深，圆标伸出窗框）；?stage=flat 是旧的整层排序和拍平
//                       （engine/layers.ts、scenes/demo_stage.ts）
//   ?plate              预渲染序列帧当场景（kit/plate.ts、scenes/demo_plate.ts）；?plate=blender 读 tools/blender 渲的示例镜头（assets/blender/drop/）
//   ?sfx=<组件名>       shaders 库的一个效果（kit/sfx.ts、scenes/demo_sfx.ts），&sfxprops=<JSON> 改 prop
//   ?sfx=showcase       示例场景被翻页（PagePeel）翻走，露出 3D 镀铬标题（scenes/demo_sfx_title.ts）
//   ?ref=<名>           参考片逐帧复刻的十段（scenes/ref_<名>.ts，docs/复刻配方.md 第四节），场景从 0 秒开始
//   ?ref=intro          原片前 16 小节连着复刻（粗分镜），配原声加 --song refs/kaomoji（tools/grid_song.py 建）
//   ?ref=typewarp       字的进场 / 拉丝 / 长弯错位和手绘墨线（kit/typewarp.ts、tegaki.ts sketchLine；If The Sun Burns Out 的做法）
import type { TimelineEntry } from '../engine/engine';
import type { AudioData } from '../engine/audio';
import { PDOOM_LOOK } from '../engine/post';
import { frameFrom } from '../engine/util';

type E = (id: string, file: string, start: number, end: number, extra?: Partial<TimelineEntry>) => TimelineEntry;

const REF: Record<string, number> = { boot: 2.7, stack: 2.6, rhythm: 3.6, kaleido: 3.1, record: 1.65, droste: 3.2, glitch: 1.65, crash: 8.1, invader: 3.05, stage: 4.0, typewarp: 4.0 };

// 这些场景是在旧默认后期（泛光、颗粒、暗角、色差、高光压缩）下调的，示例里照旧打开，画面和当初一样
export function demos(E0: E, au: AudioData): TimelineEntry[] | null {
  if (typeof location === 'undefined') return null;
  const E: E = (id, file, start, end, extra = {}) => E0(id, file, start, end, { post: PDOOM_LOOK, ...extra });
  const q = new URLSearchParams(location.search);
  if (q.has('sky')) return [E('demo-sky', 'demo_sky', 0, au.duration)];
  if (q.has('voxel')) return [E('demo-voxel', 'demo_voxel', 0, au.duration)];
  if (q.has('tactile')) return [E0('demo-tactile', 'demo_tactile', 0, au.duration)]; // 新写的，用中性默认后期
  for (const k of ['brush', 'mg', 'caption', 'paper', 'liquid', 'glass', 'plate', 'ease', 'textanim', 'shape', 'blend', 'typeset', 'reveal', 'space', 'stage', 'effects', 'particles', 'pathops', 'lights', 'deform', 'camtrack']) if (q.has(k)) return [E0(`demo-${k}`, `demo_${k}`, 0, au.duration)];
  if (q.has('layers')) {
    // a cut at 5 s (the scene goes on: it is the clip that shows the cut): the 3 frames before it change colour,
    // smear and burn out, the first frame after is inverted, the next one soft
    const cut = 5;
    return [E0('demo-layers', 'demo_layers', 0, au.duration), {
      id: 'layers-cut', start: cut - 3 / 30, end: cut + 2 / 30, effects: (t) => {
        const k = frameFrom(t, cut);
        if (k === -3) return [{ type: 'gradientMap', stops: ['#580420', '#c1a1ad'] }];
        if (k === -2) return [{ type: 'gradientMap', stops: ['#580420', '#c1a1ad'] }, { type: 'directionalBlur', angle: 0, length: 700 }];
        if (k === -1) return [{ type: 'directionalBlur', angle: 0, length: 1600 }, { type: 'exposure', stops: 1.5 }];
        if (k === 0) return [{ type: 'invert' }];
        return [{ type: 'blur', radius: 6 }];
      },
      // the frame after the inverted one shakes (post as a function of time)
      post: (t) => (frameFrom(t, cut) === 1 ? { shake: [34, 0] } : {}),
    }];
  }
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

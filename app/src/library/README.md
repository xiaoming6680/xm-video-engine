# 效果库

以前几支片子做过的特效、场景级部件、示例场景和 shaders 库。**新项目不复制这个目录**：用户点名要某种效果、或者某个镜头确实需要时再来拿。
这一页是目录：每个模块一行，**用法、参数、注意事项在各文件开头的注释里**，挑中了再去读那个文件的开头。

- **怎么用**：把文件按原路径复制进项目的 `app/src/library/`（连同它 import 的库内文件，见文件开头），import 不用改：`import { … } from '../library/kit/clouds'`。示例场景复制到项目的 `app/src/library/scenes/`，时间线按名字载入
- **看效果**：基础引擎里开网址参数（入口 `demos.ts`），见下表「示例」列
- **以前的结果**：纸片剧场（`engine/paper.ts` 的 3D 纸片）在 Clarity 被说有劣质感，图片拆层做视差（`engine/sprite.ts`）在 Still_Shining、乐观自由被说像 PPT，代码搭的人物（MMD、自建模型）在乐观自由被说别扭。用之前先想清楚能不能做好。纸片要有实物感：影子随抬起高度变、拍落余振（`kit/tactile.ts`），整张拼贴用 `engine/paper.ts` 末尾的拼贴一节（`?paper`），镜头不在纸层之间穿行
- 示例场景是写来验证模块、看接线的，不是画面标准；`ref_*` 十段是照参考片做的练习，判断不如原片
- 单线书写字体（`engine/stroke.ts`）用前在场景 `init()` 里 `await loadStrokeFonts()`
- 动了 `kit/sfx*.ts`、`kit/edt.ts` 或 `vendor/shaders` 要跑 `cd app && bun scripts/sfx-test.ts`

## 3D

| 文件 | 做什么 | 示例 · 来源 |
|---|---|---|
| `engine/terrain.ts` | 低多边形地形、等高线梯田沙盘、水面 | Clarity |
| `engine/voxel.ts` | 体素网格（MC 式 AO、组装 / 飞散动画、文字转体素） | `?voxel` · Clarity |
| `engine/portal.ts` | 传送门转场：下一场透过物体上的洞出现 | Clarity |
| `engine/shards.ts` | 玻璃碎裂转场：裂纹后碎片飞向镜头 | Still_Shining |
| `engine/mmd/`、`engine/mmd/rig.ts` | MMD 模型加载器（MIT）；裙摆碰撞、走光检查 `thighView` | Still_Shining |
| `kit/fpv.ts` | 贴地高速飞行相机、沿谷底找路线、环绕镜头 | Falling_Again |
| `kit/geo.ts` | 带顶点色的几何体合并、悬链线 | Still_Shining |
| `kit/clouds.ts` | 体积云层（碎积云、银边、日落烧红云底、指定位置放云），每帧约 +7 ms | `?sky` · Still_Shining |
| `kit/bokeh.ts` | 按深度的镜头虚化（光斑，比 kit3d 的 DofPass 便宜） | `?sky` · Still_Shining |
| `kit/sunrays.ts` | 屏幕空间光束（只取天空亮像素，按角色遮挡） | `?sky` · Still_Shining |
| `kit/motes.ts` | 空气光点，运动时拉成速度线 | `?sky` · Still_Shining |
| `kit/npr.ts` | 3D 画成动画线稿（深度 / 法线断开处出线、平涂） | Still_Shining |
| `kit/paint.ts` | Kuwahara 油画滤镜，拉到指定色带 | Falling_Again |
| `kit/plate.ts` | Blender / AE 渲的序列帧当场景（逐帧预取、相机 JSON 叠 3D）；Blender 端在 `tools/blender/` | `?plate`、`?plate=blender` |

## 2D 和图形

| 文件 | 做什么 | 示例 · 来源 |
|---|---|---|
| `engine/fx.ts` | 天空渐变、星芒、气流线、文字窗口、集中线、重新打光、水洼倒影 | Still_Shining |
| `engine/sprite.ts` | 透明 PNG 精灵：弯曲网格（头发布料随风）、分层调色、2D 视差相机 | Still_Shining |
| `engine/paper.ts` | 3D 纸片剧场；**拼贴**（文件末尾）：2D 拼贴舞台、12 fps 拍落、剪刀边、撕边、木偶、真半调；照片预处理 `tools/assets/collage.py` | `?paper` · Clarity，拼贴照 mg-styles-15 |
| `kit/tactile.ts` | 实物感：影子随抬起高度变、拍落余振；贴纸白边用 `props.py --edge` | `?tactile` · mg-styles-15 |
| `kit/tegaki.ts` | 手绘线：压力笔刷、噪声场沸腾、摄影表、填色错位、纸齿、特写补偿、smear 帧、手写字 | `?brush` · Still_Shining，笔刷照 mg-styles-15 |
| `kit/anim.ts` | 关键帧（`kf`），弹簧、挤压、错峰、对数缩放、镜头领先 `lead` | `?mg` · 2026-10，MG 动作照 mg-styles-15 |
| `kit/morph.ts` | 形状变形（`Morph`、经圆的 `SlotMorph`）、路径动画、一笔画 `OneLine` | `?mg` · 2026-10 |
| `kit/svg.ts` | SVG 素材 → 形状（path、圆弧、transform、填色描边） | 2026-10 |
| `kit/rig.ts` | 象形小人：奔跑 / 走路循环、二十来个关键姿势、按年龄的身体比例 | 2026-10 |
| `kit/textfx.ts` | 环形字、路径字、贴纸字、叠层挤出字、裂纹字；综艺花字（五层字、单字弹出、砸入余振、爆炸框） | `?caption` · 复刻配方，花字照 mg-styles-15 |
| `kit/termhud.ts` | 叙事 HUD（号牌、旁白框、监控面板、终端弹窗）；FUI（三档亮度、乱码解码、辉光黑晕字、重击关快门） | `?caption` · 复刻配方，FUI 照 mg-styles-15 |
| `kit/typo.ts` | 巨型窄体字当窗口、逐词砸字、中文行 | Still_Shining |
| `kit/lyrics-kit.ts` | 英文逐词 + 中文逐字的歌词排版、鼓点推镜、星芒 | Still_Shining |
| `kit/subs.ts` | 双语逐词字幕，按背后亮度自动选墨色 | Still_Shining |
| `engine/ascii.ts` | 字符画（按亮度换字符，彩色 / 单色荧光） | `?ref=crash` · 复刻配方 |
| `kit/glyphfield.ts` | 字符粒子：几千个字在 3D 里飞散 / 汇聚 | `?ref=boot` · 复刻配方 |
| `engine/warp.ts` | 万花筒、无限缩放画框隧道、虹膜转场 | `?ref=kaleido`、`?ref=droste` · 复刻配方 |
| `kit/rhythm.ts` | 音游跑道（音符来自真实鼓点） | `?ref=rhythm` · 复刻配方 |
| `kit/pixelstage.ts` | 像素世界被 3D 相机拍（Hi-bit） | `?ref=stage` · bad-time-mv 手法 |
| `kit/liquid.ts` | 2.5D 液态：融球、拉丝、果冻字标，只适合正面机位 | `?liquid` · mg-styles-15 |
| `kit/glass.ts` | 玻璃拟态：极光背景、透视磨砂卡片、色散透镜、玻璃字 | `?glass` · mg-styles-15 |
| `kit/edt.ts` | 精确距离变换（覆盖图 → 有符号距离场），liquid 和 sfx-shape 共用 | — |

## shaders 库（200 个 WebGPU 效果）

shader-effects-inc/shaders（MIT）原样收在 `vendor/shaders`（补丁见那里的 `VENDOR.md`）。**接法和规矩**见 [sfx用法.md](sfx用法.md)，**组件清单**见 [sfx组件.md](sfx组件.md)。用了它的成片 `CREDITS` 写 shaders by Shader Effects, Inc.（MIT）。

| 文件 | 做什么 | 示例 |
|---|---|---|
| `kit/sfx.ts` | `Sfx`：图层列表（shaders.com 的 preset JSON）→ 引擎纹理（线性 HDR） | `?sfx=<组件名>`、`?sfx=showcase` |
| `kit/sfx-input.ts` | `EngineTexture`：引擎画面当图层喂进去 | — |
| `kit/sfx-shape.ts` | 文字 / 图片 / 画布 → SDF（镀铬字、玻璃字、3D 挤出字） | `?sfx=showcase` |
| `app/scripts/sfx-test.ts` | 全部组件和原库逐像素对照、确定性、扫描、耗时；`--catalog` 生成清单 | — |

## 参考和没收进来的

- **十段效果练习** `scenes/ref_*.ts`（`?ref=<名>`）：开机字符粒子、画框隧道、唱片、叠层字、音游、体素井、万花筒、崩溃关机、像素世界等，列表和对照方法见基础引擎 `docs/复刻配方.md` 第四、五节；看字符画、字符粒子、像素世界、音游怎么接线、取值多少
- **第三方参考**（仓库根目录 `third_party/`，代码用 `python tools/fetch_refs.py` 按固定提交拉）：水彩 / 水墨 / 厚涂笔刷和 43 种画风说明（lemo-opuscar）、纸偶骨骼和软体物理（papermotion）、手绘笔刷和角色 rig（claude-animation-skill）、写实浅水（clearwater）、p5.brush 手绘流程（ClaudeAnimationBase）、15 种 MG 风格样片（mg-styles-15）。用时按引擎写法改写，成片 `CREDITS` 注明来源
- **绑定了具体歌曲或角色、没收进来的**，去原项目看：Still_Shining 的 `teto3d.ts`（Teto 的 MMD 角色）、楼窗、城市灯海、`city3d.ts`、城镇和火车、`manga/`；Falling_Again 的沙漠、云、闪电、隧道和 `analysis/cut.py`；pdoom 的 P(doom) 读数、`zh.ts`、图版场景；world.execute(me) 的宿舍（`blender/dorm.py`）和歌词进 3D（`scenes/seq.ts` 的 `lyr3d`）

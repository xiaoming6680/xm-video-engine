# 能力地图

给 Agent 查的。人想知道每一步怎么说，看[做片指南](做片指南.md)。

引擎是模型的器官，管画面之外的事：耳朵（分析歌）、眼睛（联系表、运动曲线、洋葱皮）、手（逐帧准确出片、交付）、记性（`TREATMENT.md` 记要求，`film.py` 留版本）、嘴（配音、配乐、音效），再加一套交付前的体检。这些事不用每次从头摸索，少花 token、少返工。

**画面方向谁来定都行**：人定大方向和想要的几幕，你照着做；或者全交给你，你出几个方向让人挑。具体怎么画由你定，下面的技术栈对照、AE 式零件和效果库都只是选项，自己写得更好就不用。

工具文件开头都写了用法；命令在项目根目录运行，`<引擎>` 是这个仓库的路径。文件开头写的 `python tools/x.py`，在引擎外面用时换成 `python <引擎>/tools/x.py`。

## 开工引导：和人一步步确认

人常常只给一首歌和一句“做个 MV”。一口气猜完整片再被推翻，最费 token；一次抛一长串问题，人也答不准。所以一步步来：每一步只确认一两件事，给人看具体的东西（选项、参考片、一两张静帧、一小段），人点头了再往下。已经说清楚的不问；人说“你定”就自己定，但每一步做完仍然给人看一眼。

大致的顺序（按片子调整，不是固定步骤）：

1. **歌和范围**：用歌的哪一段、横屏还是竖屏、发哪里。分析完歌先给人听确认片（下面「流程工具 · 开工」），拍子和段落对上再往下
2. **方向谁来定**：人定大方向和想要的几幕，你照着做；或者全交给你，你出几个方向让人挑
3. **大方向**：一句话的概念，加一两支参考片（`film.py target add`）。人说的风格词先复述成具体画面再确认，见下面
4. **几幕**：每幕一两句，画面里有什么、发生什么、落在歌的哪段。人定的就照记；你提的给人挑
5. **一幕先做出来**：挑最能代表方向的一段先做，给人看，认可了再铺开
6. **素材和交付物**：角色、Logo、文案、封面、抖音版、字幕，用到时再问

每一步的回答连同原话、日期记进项目的 `docs/TREATMENT.md`（[模板](TREATMENT模板.md)）。会话压缩后读文件，不再问一遍。

**人说的风格词怎么接**：同一个词常常有完全不同的理解，不要直接套一种。先用自己的话复述两三种理解，最好配参考图或一张静帧，让人指“是这个”。下面是常见的几种理解，只当提问的起点，不对就听人的：

| 说法 | 可能指的是（举例，不全） |
|---|---|
| 极简 | 大留白、少元素的排版 / 单色几何图形 / 只留一个主体的干净镜头 |
| 科技感 | 深色底加细线和数据界面 / 冷光金属和玻璃的 3D / 故障、扫描线、终端字 |
| 电影感 | 宽画幅、浅景深、慢推镜 / 胶片颗粒和调色 / 有叙事的分镜和景别变化 |
| 可爱 | 圆润的角色和表情 / 糖果色、贴纸、Q 版 / 软乎乎的弹性动作 |
| 有质感 | 纸、布、金属这类真实材质 / 光影和景深做足 / 手工、实物、定格感 |
| 水墨 | 写意的墨晕和留白 / 工笔线描加淡彩 / 只借水墨元素的现代设计 |
| 像素 | 8-bit 游戏感 / 精细的像素插画 / 低分辨率加 CRT 的复古屏幕 |
| 拼贴 | 剪报杂志拼贴 / 照片和手绘混搭 / 低帧率一顿一顿的动画感 |
| 手绘 | 铅笔线稿 / 水彩、蜡笔这类画材 / 逐帧手绘动画 |
| 温暖治愈 | 暖色调的生活场景 / 柔光和慢节奏 / 手绘绘本感 |
| 年轻潮流 | 撞色和大字排版 / 街头、涂鸦、贴纸 / 快节奏卡点 |

**节奏**也一样先问：人想要舒缓还是冲击，再对着歌确认哪里该停、哪里该猛。大落点卡上，中间留出喘气的地方，通常不必每拍都动。

## 省 token 的做法

- **能跑脚本的不要自己写**：听歌、导出、对齐偏移、拼连播、量响度和卡点，都用下面的现成工具
- **只渲改动的部分**：`render.ts video --from 秒 --to 秒` 只出一段；改一处就只重渲那一段
- **认可的就锁住**：`film.py lock` 之后不再碰，省掉“改坏了再改回来”
- **重的东西按需开**：多方向候选、整套自检、独立评审、子帧运动模糊都很耗，人要或片子确实需要时再用
- **看图前先缩小**：联系表、抽帧条比逐帧看便宜；只有关键动作才逐帧

## 流程工具

### 开工

| 想做 | 用 |
|---|---|
| 建项目 | `python <引擎>/tools/new_project.py <目录> [app analysis tools tts library skills]`。默认空项目，模块之后还能加 |
| 分析歌：节拍、段落、鼓点、逐词歌词（中文、日文、韩文、英文） | `python <引擎>/analysis/run.py 歌.flac`，见[音乐分析](音乐分析.md) |
| **分析确认**：分析完先给人听一遍，拍子、小节、段落、drop 对不对 | `cd app && bun scripts/render.ts beatcheck` 出确认片（放歌，数字跳在每个强拍上，标段落、鼓点、人声；要项目带 `app`）。不对就在 `data/song_config.json` 写速度和段落提示重跑，见[音乐分析](音乐分析.md) |
| **歌词确认**：逐词歌词对得准不准 | `python <引擎>/tools/lyric_check.py` 出检查片（`--compare` 并排比两份；歌词只进视频，你不看） |
| 记方向和人说过的话 | 项目的 `docs/TREATMENT.md` |

### 版本和挑选

`tools/film.py`，详见文件开头。

| 想做 | 用 |
|---|---|
| 开工前用现成成片对齐方向 | `film.py target add 参考.mp4` |
| 收一版，不覆盖；查有没有动到认可的段落 | `film.py add 视频 --note 改了什么` |
| 收错了：改偏移或备注、拿掉 | `film.py edit 版本 --offset 秒`、`film.py drop 版本` |
| 让人逐段挑（单个切换或几版并列）、记瞬间、锁定、确认你的理解 | `film.py page`（放终端里跑；Agent 自己测试时加 `?mute`）、`film.py say 段号 "我打算……"` |
| 几个子代理并行做同一段的不同方向 | 各写各的场景文件，`render.ts video --query swap=<条目>:<场景> --from 段起 --to 段止` 渲，`film.py add` 收 |
| 拼一条带声音的连播 | `film.py assemble` |
| 把选择整理成拼合表、退回某一版的代码 | `film.py plan`、`film.py restore 版本` |

### 声音

| 想做 | 用 |
|---|---|
| 给成片叠音效、给没有歌的片子做配乐 | `tools/audio/`（[说明](../tools/audio/README.md)）；app 场景的 `cues()` 里写 `sfx: 'hit'`，`render.ts cues` 导出后 `sfx_mix.py --cues` 自动对齐 |
| 克隆音色读旁白 | `tts/`（[配音](配音.md)；要先 `new_project.py <项目> tts`） |
| 截取片段的结尾拖长最后一个音 | `tools/held_note_ending.py`；一般人声唱完收、伴奏淡出就够 |

### 合成和交付

| 想做 | 用 |
|---|---|
| 序列帧加音频成片，帧数精确；可接片头卡片 | `tools/frames_to_video.py` |
| 抖音版 | `tools/douyin_mux.py` |
| 封面：从静帧裁横竖两张、排标题 | `tools/cover_title.py`，或按这支片自己设计 |

### 检查

交付前想过一遍技术问题：`python <引擎>/tools/qa/selfcheck.py`（只有技术和卡点算问题，其余是参考）。真峰值、音画偏移、闪光、接缝、运动曲线、卡点、联系表，还有独立评审的提示词：[检查和评审](检查和评审.md)。看不到视频也能读动作：`render.ts curves`（关键帧曲线图配拍点）、`review.py onion`（洋葱皮）。

## 画面：什么效果用什么技术

任何能出序列帧的办法都行，出了帧交给 `tools/frames_to_video.py` 和 `film.py`。右列是引擎里现成的，可用可不用。

| 想要的效果 | 合适的技术 | 引擎里现成的（可选） |
|---|---|---|
| 排版、字的动画、卡片、UI、MG | Canvas 2D、HTML/CSS、SVG | `engine/textanim.ts`、`engine/layers.ts` 的 `Comp` |
| 描边生长、路径动画、Logo、图标 | SVG / Canvas 路径 | `engine/shape.ts`、`engine/arrival.ts` + 效果 `reveal` |
| 手绘、像素、拼贴、逐张换画 | Canvas 2D 小画布、低帧率步进 | `engine/swap.ts`、图层的 `fps`；效果库的 tegaki、paper |
| 发光、水面、折射、颗粒、程序化背景、光线步进 | GLSL / WebGPU 着色器 | `FSPass`（`engine/gl.ts`）、`engine/effects.ts`、200 个 WebGPU 着色器 |
| 轻量 3D、摄像机运动、3D 字、导入模型 | three.js | `engine/world.ts`、`engine/space.ts`、`engine/model.ts` |
| 重 3D、真实材质、光追、角色 | Blender 出序列帧 | `tools/blender/`（[说明](../tools/blender/README.md)），序列帧进 app 用 `engine/plate.ts` |
| 贴图、背景、角色图 | 生图 | `tools/codex_gen.py`；抠图、拆层 `tools/assets/` |
| 实拍、视频素材 | 抽帧当图层 | `tools/footage.py` + 图层的 `footage` |
| 复古后期：CRT、VHS、故障、网点、调色 | 后期着色器 | `engine/post.ts` 的参数（默认全关），取值见[复刻配方](复刻配方.md) |
| 照着参考片复刻一个镜头 | 逐帧对照 | [复刻配方](复刻配方.md)、`tools/refmatch.py`、技能 `mv-refmatch` |
| 选字体 | 出对比图 | `tools/font_sheet.py` |

`app/` 怎么写场景、怎么预览：[场景渲染](场景渲染.md)。

### AE 式零件（可选）

画画的一种办法，不是器官，用不用随你。app 里像 AE 的一套，说明在[场景渲染](场景渲染.md)「动作」一节和各文件开头，示例在预览网址后加参数。

| 想做 | 用 |
|---|---|
| 关键帧和 AE 式缓动；预览里按 `g` 直接拖关键帧，存下来导出照它渲 | `engine/anim.ts` 的 `K` / `ae()`，`engine/tracks.ts` 的 `kfe`，示例 `?ease` |
| 整段冻结、慢放、倒放 | 时间线条目的 `remap` |
| 按字范围打动画、竖排、沿路径排字、字里填图案 | `engine/textanim.ts`，示例 `?textanim`、`?typeset` |
| 线稿描出、按笔顺写字、光一档一档亮开、擦掉；几张关键图换张 | `engine/arrival.ts` + 效果 `reveal`、`engine/swap.ts`，示例 `?reveal` |
| 描边生长、虚线、重复器、路径抖动和变形 | `engine/shape.ts`，示例 `?shape` |
| 混合模式、轨道遮罩、预合成 | `engine/gl.ts` 的 `Compositor`、`engine/precomp.ts`，示例 `?blend` |
| 图层：入出点、父子、3D 图层和摄像机、蒙版、效果栈、调整层、回声、逐层 fps、运动模糊 | `engine/layers.ts` 的 `Comp`，示例 `?layers` |
| 字和 three.js 3D、Blender 镜头共用一台摄像机，互相遮挡 | `engine/space.ts` + 图层的 `three`，示例 `?space` |
| 2.5D 舞台：卡片站在地面、互相穿过、四角钉、朝向摄像机 | 图层的 `cornerPin`、`faceCamera`、`collapse`，示例 `?stage` |
| 图层效果：模糊、渐变映射、色阶、发光、半调、置换、故障、投影、描边、自定义着色器 | `engine/effects.ts` |
| 跨两个场景的转场、切点前后几帧的变色和冲白、立体厚度 | 时间线条目的 `transition`、效果条 + `frameFrom`、图层的 `extrude` |
| wiggle、关键帧循环 | `engine/anim.ts` 的 `wiggle`、`loopOut` |

### 效果库（可选）

以前做过的效果，放在 `app/src/library/`（[目录](../app/src/library/README.md)），新项目默认不复制。它们带着当时那支片的风格，不一定适合这支片，也不一定比你现写的好；用之前先确认合不合这支片的方向。

| 有什么 | 在哪 |
|---|---|
| 字符画、云海、体素、拼贴、手绘线、MG 动作、花字、液态、玻璃、MMD 等 | `app/src/library/`，示例 `?brush`、`?paper`、`?mg`、`?caption`、`?liquid`、`?glass`、`?sky`、`?voxel` |
| 200 个 WebGPU 着色器 | `app/src/library/vendor/shaders` |
| 调色预设（冷暗暖亮，泛光、光晕、色差、颗粒一起开） | `engine/post.ts` 的 `grade`、`PDOOM_LOOK` |
| 漫画墨线和网点 | `tools/blender/toon.py` |
| 一支拼贴 PV 的逐帧手法拆解 | [手法拆解](手法拆解_BV1WS456JEXS.md) |
| 水彩、水墨、纸偶等没收进来的参考代码 | `third_party/`（`python tools/fetch_refs.py` 拉取） |

## 其他

- 分析、抠图、深度模型怎么选，许可证：[模型选型](模型选型.md)
- `app` 的核心模块在 `app/src/engine/`，每个文件开头有说明。`config.ts` 是项目设置，`timeline.ts` 是剪辑表（表格见[场景渲染](场景渲染.md)末尾）
- 自测用的合成曲 `tools/make_test_song.py`；清晰度粗测 `tools/sharpness.py`；MMD 手臂反解 `tools/pose_arm.py`；参考片建拍子网格 `tools/grid_song.py`
- 写出来的通用工具可以回流到引擎，说清用途和用法即可

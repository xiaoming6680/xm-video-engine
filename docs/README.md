# 能力地图

想做什么，用什么。全部可选，可以不用、改掉或换成自己写的。工具文件开头都写了用法；命令在项目根目录运行，`<引擎>` 是这个仓库的路径。文件开头写的 `python tools/x.py`，在引擎外面用时换成 `python <引擎>/tools/x.py`。

## 开工

| 想做 | 用 |
|---|---|
| 建项目 | `python <引擎>/tools/new_project.py <目录> [app analysis tools tts library skills]`。默认空项目，模块之后还能加 |
| 分析歌：节拍、段落、鼓点、逐词歌词 | `python <引擎>/analysis/run.py 歌.flac`，见 [音乐分析](音乐分析.md) |
| 少返工：历次退回的原因和管用的做法 | [少返工](少返工.md) |
| 记方向和用户说过的话 | 项目的 `docs/TREATMENT.md`（[模板](TREATMENT模板.md)） |

## 版本和挑选

`tools/film.py`，详见文件开头。

| 想做 | 用 |
|---|---|
| 开工前用现成成片对齐方向 | `film.py target add 参考.mp4` |
| 收一版，不覆盖；自动查有没有动到认可的段落 | `film.py add 视频 --note 改了什么` |
| 让用户逐段挑、记瞬间、锁定、确认你的理解 | `film.py page`（放终端里跑；Agent 自己测试时加 `?mute`） |
| 拼一条带声音的连播 | `film.py assemble` |
| 把选择整理成拼合表 | `film.py plan` |
| 退回某一版的代码 | `film.py restore 版本` |

## 做画面

| 想做 | 用 |
|---|---|
| 排版、动效、着色器、轻量 3D，改完马上预览 | `app/`，见 [场景渲染](场景渲染.md) |
| 重 3D、真实材质、光追 | Blender：`tools/blender/`（`render.py` 驱动、`lib.py`，[说明](../tools/blender/README.md)） |
| 漫画墨线和网点、粗字块 | `tools/blender/toon.py` |
| 现成的效果：字符画、云海、体素、拼贴、手绘线、MG 动作、花字、液态、玻璃、MMD、200 个 WebGPU 着色器…… | `app/src/library/`（[目录](../app/src/library/README.md)），想用就复制 |
| 复古、故障、CRT、VHS、Riso、像素化 | `app/src/engine/post.ts` 的后期参数，[复刻配方](复刻配方.md) 有取值 |
| 照参考片复刻镜头 | [复刻配方](复刻配方.md) 第五节，`tools/refmatch.py`，技能 `mv-refmatch` |
| 生成贴图、道具、背景 | `tools/codex_gen.py`；抠图、拆层 `tools/assets/` |
| 选字体 | `tools/font_sheet.py` 出对比图 |
| 水彩、水墨、纸偶等没收进来的 | `third_party/`（`python tools/fetch_refs.py` 拉参考代码） |

以上都不合适就自己写。写出来的通用工具可以回流到这里，作为可选项。

## 声音

| 想做 | 用 |
|---|---|
| 给成片叠音效、给没有歌的片子做配乐 | `tools/audio/`（[说明](../tools/audio/README.md)）；app 场景的 `cues()` 里写 `sfx: 'hit'`，`render.ts cues` 导出后 `sfx_mix.py --cues` 自动对齐 |
| 克隆音色读旁白 | `tts/`（[配音](配音.md)；要先 `new_project.py <项目> tts`） |
| 截取片段的结尾 | 一般人声唱完收、伴奏淡出就好（《一点》用户说拖长音处理得不好）；要拖长最后一个音用 `tools/held_note_ending.py` |

## 合成和交付

| 想做 | 用 |
|---|---|
| 序列帧加音频成片，帧数精确；可接片头卡片（任意图片） | `tools/frames_to_video.py` |
| 封面 | `tools/cover_title.py`（模板式），或自己渲 |
| 抖音版 | `tools/douyin_mux.py` |

## 检查

真峰值、音画偏移、闪光、接缝、运动曲线、卡点、联系表，还有独立评审的提示词：[检查和评审](检查和评审.md)。

## 其他

- 分析、抠图、深度模型怎么选，许可证：[模型选型](模型选型.md)
- `app` 的核心模块：`app/src/engine/`，每个文件开头有说明。`config.ts` 是项目设置，`timeline.ts` 是剪辑表，`audio.ts` 节拍和事件，`lyrics.ts` 逐词歌词，`gl.ts` 图层和合成，`post.ts` 后期，`world.ts`、`kit3d.ts` 3D，`util.ts` 缓动和噪声（表格见[场景渲染](场景渲染.md)末尾）
- 自测用的合成曲：`tools/make_test_song.py`；清晰度粗测：`tools/sharpness.py`；MMD 手臂反解：`tools/pose_arm.py`；参考片建拍子网格：`tools/grid_song.py`

## 旧文档去哪了

2026-11 改革时合并了。旧项目的 `CLAUDE.md` 提到这些名字时按下表找；原文在 git 历史里，本机还有一份在 `docs/archive/2026-11_改革前/`（不进仓库）。

| 旧文档 | 现在 |
|---|---|
| 新项目流程、使用指南、模块目录 | 这一页、[音乐分析](音乐分析.md)、[少返工](少返工.md) |
| 引擎指南、引擎参考 | [场景渲染](场景渲染.md) |
| 质量验收、评审提示词 | [检查和评审](检查和评审.md) |

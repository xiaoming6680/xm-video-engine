<div align="center">

# AGENT视频基础引擎

**给 AI Agent 做音乐视频用的底座：画面交给模型，引擎帮你把流程走顺、少花 token。**

*A toolkit for AI agents making music videos. The model designs the picture; the engine is its organs — it hears the song, exports frame-exact, keeps every version and checks the cut — so less effort and fewer tokens go to chores.*

[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

<img src="docs/images/ae.webp" alt="九个 AE 式零件示例：文字动画器、形状层、笔顺描线、图层系统、混合模式和轨道遮罩、排字、统一摄像机、2.5D 舞台、关键帧缓动" width="880">

</div>

现在的模型自己就能写出好看的画面，难的是画面之外：需求说不清、听不到歌、导出掉帧、改一版盖掉上一版、会话一长就忘。引擎把这些做成现成的流程，像模型的器官：

| 器官 | 做什么 |
|---|---|
| 嘴：开工引导 | 需求说不清时，一次问清画面谁来把关、用歌哪段、画幅、风格和参考，给选项点选 |
| 耳朵：分析歌 | 节拍、段落、鼓点、逐词歌词（中日韩英），再出确认片给人听一遍 |
| 手：逐帧出片 | 任意时刻都能准确画出来，帧数精确、音画对齐；正式版、抖音版、封面 |
| 记性：版本 | 每一版都留着，人逐段挑、锁定，只重做没认可的部分 |
| 眼睛：检查 | 抽帧表、关键帧曲线、洋葱皮、卡点偏差、音量峰值、闪光 |

画面谁来设计都行：你自己在 AE 之类的软件里做好交过来，或者交给 Agent。

## 分析歌，先听一遍确认

分析完歌先出确认片：大数字踩在每个强拍上，标着鼓点、人声和段落。拍子和 drop 对上了再往下做，后面的卡点都靠它。

<img src="docs/images/beatcheck.webp" alt="分析确认片：小节号随强拍跳动，下面是 kick、snare、hat、歌词轨和段落条" width="880">

## 每一版都留着，逐段挑

挑选页里几版并列在同一个时钟上播，点哪版就选哪版，认可的段落锁住。Agent 想改方向时先在这里问一句，你点“对 / 不对”。

<img src="docs/images/pick.webp" alt="挑选页：四个段落、三个版本并列播放，右侧是 AI 的提问和选择按钮" width="880">

## 看得见动起来的样子

模型看不了视频，引擎把动作变成图：抽帧表看节奏，关键帧曲线看是“快出慢停”还是在飘。

<img src="docs/images/see.jpg" alt="上半是一段动画的抽帧表，下半是两条关键帧曲线：快出慢停和慢起快收" width="880">

## 画面：用什么技术都行

Canvas、SVG、three.js、着色器、Blender、生图、实拍都行，[能力地图](docs/README.md)里有“什么效果适合什么技术”的对照。引擎自带两套可选的东西，Agent 自己写得更好就不用：

**AE 式零件**：图层、关键帧和曲线编辑器、文字动画器、形状层、混合模式和遮罩、统一摄像机、2.5D 舞台（最上面那张图）。

**效果库**：手绘、拼贴、MG、花字、液态、玻璃、云海、体素、实物感等，还有 200 个 WebGPU 着色器。

<img src="docs/images/effects.webp" alt="九个效果库示例：手绘火柴、纸片拼贴、MG 一笔画、综艺花字、液态字、玻璃拟态、云海、体素字、贴纸拍落" width="880">

在 `app` 里跑 `bunx vite`，网址后面加 `?textanim`、`?space`、`?paper` 这样的参数就能看每个示例。

## 开始

需要 Python、[ffmpeg](https://ffmpeg.org)、[bun](https://bun.sh)、Edge 或 Chrome，以及一个 Agent（比如 Claude Code）。

```bash
python 引擎/tools/new_project.py 我的新MV app
cd 我的新MV
python ../引擎/analysis/run.py 歌.flac
```

然后在这个目录打开 Agent，说你想要什么，说不清也没关系，它会先问。

- [做片指南](docs/做片指南.md)：给人看，从一首歌到成片每一步怎么说
- [能力地图](docs/README.md)：给 Agent 查，流程工具、开工引导、效果和技术栈对照

## 许可和致谢

代码按 [MIT](LICENSE) 发布。引擎核心来自 [mexicat/pdoom-video](https://github.com/mexicat/pdoom-video)（Giacomo Magnanini，MIT）；`app/src/library/vendor/shaders/` 来自 [shader-effects-inc/shaders](https://github.com/shader-effects-inc/shaders)（MIT）；部分效果和配乐音效库 `tools/audio/mgaudio` 照 [Vincentwei1021/mg-styles-15](https://github.com/Vincentwei1021/mg-styles-15)（MIT）重写或收录，乐器采样来自 VCSL（CC0）；几段效果练习参考了 B 站《当 (•ω•) 被运行之后……》和 [guiguisocute/bad-time-mv](https://github.com/guiguisocute/bad-time-mv) 的画面手法，代码是重写的。字体为 OFL，纸纹贴图为 CC0。`audio/`、`data/` 里是脚本合成的测试曲，不含任何歌曲。其他参考过的开源仓库见 [third_party/README.md](third_party/README.md)。

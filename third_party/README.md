# 第三方参考代码

这里的代码原样复制自各自的开源仓库（2026-10-03 拉取），只删掉了图片、视频、音频和大体积数据，没有改动代码。全部是 MIT 许可，各目录保留原 `LICENSE`。

**这些不是引擎的一部分**，是按需移植的参考：做到需要的画风时，读对应目录，把要用的部分改写成引擎的写法（`render(f)` 纯函数、线性 HDR、`Layer2D` / `FSPass`），放进项目或引擎的 `app/src/engine/`，并在成片 `CREDITS` 里注明来源。移植方法和各模块的适用场景见 `../docs/模块目录.md`。

| 目录 | 来源（提交） | 许可 | 拿来做什么 |
|---|---|---|---|
| `lemo-opuscar/` | [lemomo-ai/lemo-opuscar](https://github.com/lemomo-ai/lemo-opuscar) `c4bc370`（2026-10-02） | MIT © LemoLab | 43 种画风的 `STYLE.md`（外观、色彩、字体、运动、镜头语法、媒介特有动作、常见坑）；`DIRECTOR.md` / `TECHNIQUE.md` 导演与制作方法；`core/three/post.js` 3D 景深 + GTAO；`core/post/crt.js` CRT/VHS 后期；`core/render/readcheck.mjs` 文字可读检查；水彩、水墨、油画厚涂三套笔刷引擎（`styles/*/demo/`） |
| `papermotion/` | [francozanardi/papermotion](https://github.com/francozanardi/papermotion) `aafddbe`（2026-09-26） | MIT © Franco Zanardi | 纸片风角色骨骼（`src/rig`）、软体物理（`src/physics`）、纸张渲染（`src/paper`）、镜头与编排（`src/camera`、`src/direction`）、天气（`src/weather`）；`skill/references/` 里的美术指导、角色、检查方法和常见坑 |
| `claude-animation-skill/` | [buildwithhanif/claude-animation-skill](https://github.com/buildwithhanif/claude-animation-skill) `4ddb8c8`（2026-09-23） | MIT © Hanif | 手绘笔刷 `Pen`（锥形笔触、铅笔、水彩晕染、自写文字）、纸张与自然纹理、角色 rig（蚂蚁、豆豆人、chibi、小怪物）、动作游戏手感特效（hit-stop、震屏、火花）、低多边形海报风；`skill/references/` 的细节手册（detail.md）、运动（motion.md）、坑（traps.md） |
| `clearwater/` | [Aureliengmz/clearwater](https://github.com/Aureliengmz/clearwater) `4bc8261`（2026-09-23） | MIT © Lumaris | 单文件 WebGL2 写实浅水：FFT 波浪、涟漪模拟、焦散、自适应质量 |
| `ClaudeAnimationBase/` | [JohnHeibel/ClaudeAnimationBase](https://github.com/JohnHeibel/ClaudeAnimationBase) `0ac8bf2`（2026-09-24） | MIT © John Heibel | p5.js + p5.brush 手绘卡通流程；`ANIMATION_GUIDE.md` 的表演、时序、审片方法（联系表、逐帧条、跟随世界坐标的局部放大）。角色 Clawd 是 Anthropic 的吉祥物，**不要用在自己发布的作品里**，只学方法和画法 |

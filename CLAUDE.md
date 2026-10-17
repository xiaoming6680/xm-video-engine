# 小铭的视频基础引擎

做代码生成 MV 的引擎：渲染管线（确定性、运动模糊、4K、BT.709）、音频分析、歌词对齐、检查和发布工具、配音。新项目用 `tools/new_project.py` 从这里复制出去。

- **做新片**：`docs/新项目流程.md`。三步：节拍校验片 → 一段成片质量的样片（方向自己定，不先出概念图）→ 整片
- **写场景**：`docs/引擎指南.md`。输出只取决于 `f.t`（随机带种子，逐帧闪烁用 `frameIdx(t)`）；后期默认全关；渲完的静帧要亲眼看
- **查缺陷**：`docs/质量验收.md`。每轮先带音乐、原速、从头到尾连着看，再看单帧和报告
- **歌词不进对话**：内嵌歌词用 ffprobe 直接写成 `data/lyrics.src.lrc`，不 cat / Read；只看行号、时间、字数
- **效果库**（字符画、云海、体素、纸片、MMD、shaders 库、十段复刻练习……）在 `app/src/library/`，新项目不复制，用户点名要某种效果时再去拿（`app/src/library/README.md`）。复刻参考视频：`docs/复刻配方.md` 第五节、技能 `.claude/skills/mv-refmatch`
- 其他：核心模块和 Python 工具 `docs/模块目录.md`；配音 `docs/配音.md`；换模型和许可证 `docs/模型选型.md`；给人看的完整说明 `docs/使用指南.md`
- **渲染**：`render.ts` 默认自己起私有服务器（5173 上可能是别的项目）；输出 BT.709，外部重新编码要保留（`check_video.py` 会查）
- **字体**：基础引擎只放 OFL 字体；商业字体只在具体项目里用（`config.ts` 的 `EXTRA_FONTS`）
- **参考片的素材只在本机**：原片、原声、截图、对照视频放 `refs/`、`out/`，不进 git、不发布
- **改引擎**：在这里改并验证（`cd app && bunx tsc --noEmit -p tsconfig.json`，再渲示例场景看图）；已复制出去的项目不会自动更新。动了 `library/kit/sfx*.ts` 或 `library/vendor/shaders` 要跑 `bun scripts/sfx-test.ts`
- **来源**：核心来自 mexicat/pdoom-video（MIT，Giacomo Magnanini），扩展来自 Clarity、Falling_Again、Still_Shining；效果库的 shaders 来自 shader-effects-inc/shaders（MIT）。成片 `CREDITS` 注明

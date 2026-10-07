# 小铭的视频基础引擎

做代码生成 MV 的基础引擎和工具箱。新项目从这里复制出去（`tools/new_project.py`），做不同风格时按需取用模块。

## 先读哪些

| 要做什么 | 读 |
|---|---|
| 开一个新 MV 项目 | `docs/新项目流程.md` |
| 选模块、找某种效果在哪 | `docs/模块目录.md` |
| 写场景（引擎 API、确定性、运动模糊、4K） | `docs/引擎指南.md` |
| 写 TREATMENT | `docs/TREATMENT模板.md`，可借的想法在 `docs/方法.md` |
| 做 CRT / 字符画 / 故障 / 像素 / 音游 / HUD 这类效果，或复刻参考片的镜头 | `docs/复刻配方.md`（第四节十段 `?ref` 是单帧的质量标准，第五节是方法：单帧像 + 连贯 + 运动量接近） |
| 每轮预览验收 | `docs/质量验收.md` |
| 第三方笔刷、角色骨骼、画风说明 | `third_party/README.md` |
| 换分析 / 抠图 / 深度模型，查许可证 | `docs/模型选型.md`（不比现有的好就不换） |

## 结构

- `app/`：引擎（TypeScript + three.js，bun + Vite）。`src/config.ts` 是项目设置，`src/engine/` 核心和 2D/3D 模块，`src/kit/` 场景级辅助，`src/scenes/` 示例场景，`scripts/` 渲染脚本
- `analysis/`：音频分析和歌词对齐（Python）。分离模型共用 `analysis/models/`（约 400 MB，不进 git）；段落草稿 `structure.py` 用 `analysis/models/songformer/` 里的独立环境（`setup_structure.py` 装，约 6 GB）。各环节选哪个模型、试过哪些没换、许可证：`docs/模型选型.md`
- `tools/`：质检、对照、Codex 生图、素材处理、抖音合成、封面、建新项目
- `third_party/`：5 个 MIT 开源工程的参考代码，未改写进引擎
- `audio/`、`data/`：`tools/make_test_song.py` 生成的测试曲和数据，用来自测

## 规矩

- **歌词不进对话**：内嵌歌词用 ffprobe 直接写成 `data/lyrics.src.lrc`，不 cat / Read；检查歌词数据只看行号、时间、字数（`render.ts info` 已经这样输出）。对齐、排版在脚本里按行号和时间戳处理
- **做片分步、逐步锁定**（`docs/新项目流程.md`）：节拍校验片 → 方向样片（10–15 秒带声音的真实代码）→ 全片粗分镜（`render.ts animatic`）→ 关键镜头打样 → 分段精做。方向样片和粗分镜两步一定停下来给用户看；锁定项和带范围的反馈写进 TREATMENT；模糊意见先问清，不擅自全片加码
- **设计放手做**：不设手法禁区；`docs/质量验收.md` 在预览时查缺陷，各项在哪一步查见它开头
- **连着看**：每轮先带音乐、原速、从头到尾连着看，再看单帧；切点用 `tools/qa/seams.py` 查。复刻参考片要单帧像 + 连贯 + 运动量接近三样都过（`refmatch.py` sheet / motion / strip、`seams.py --ref`），碎片拼出来的演示不算
- **场景输出只取决于 `f.t`**：随机带种子，不用 `Math.random()`、`Date.now()`；逐帧闪烁用 `frameIdx(t)`
- **渲染**：`render.ts` 默认自己起私有服务器（5173 上可能是别的项目）；渲完的静帧要亲眼看
- **输出 BT.709**：`render.ts` 已转换并打标签；外部重新编码要保留（`douyin_mux.py` 已处理），`check_video.py` 会查
- **字体**：基础引擎只放 OFL 字体；苹方、华文行楷这类商业字体只在具体项目里用，通过 `config.ts` 的 `EXTRA_FONTS` 加；`render.ts glyphs` 查回落到系统字体的字
- **参考片的素材只在本机**：原片、原声、截图、对照视频放 `refs/`、`out/`（都不进 git），不发布
- **改引擎**：在基础引擎里改并验证（`bunx tsc --noEmit -p tsconfig.json`，再渲示例场景看图），已经复制出去的项目不会自动更新，需要时手动同步
- **来源**：引擎核心来自 mexicat/pdoom-video（MIT，Giacomo Magnanini），扩展来自 Clarity、Falling_Again、Still_Shining 三个项目；成片 `CREDITS` 注明

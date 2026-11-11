# AGENT视频基础引擎

给 Agent 做音乐视频用的底座。引擎是模型的器官：分析歌、逐帧出片、留版本和逐段挑选、检查、配音配乐、交付，帮人把流程走顺、少花 token。画面由人或 Agent 自己定，AE 式零件和效果库都是可选的；任何部分都可以不用、改掉或绕开，不需要理由。

- **用什么：** 能力地图 `docs/README.md`（开工引导、省 token 的做法、流程工具、效果和技术栈对照）；给人看的流程在 `docs/做片指南.md`
- **需求说不清时一步步确认：** 按能力地图「开工引导」，每步只确认一两件事，给具体的东西看，人点头再往下；人说「你定」就自己定，做完仍给人看一眼
- **本机记录：** `docs/本机/`（不进仓库）若存在，里面是做过的片的原始记录和经验，开工前可以看

## 不能碰的

- **歌词不进对话：** 内嵌歌词直接写成 `data/lyrics.src.lrc`，只按行号、时间、字数处理，不 cat / Read。`.ignore` 让搜索跳过 `data/` 和 shaders 库的源文件
- **参考片的素材只在本机：** 原片、原声、截图、对照视频放 `refs/`、`out/`，不进 git、不发布
- **个人痕迹不进仓库：** 做过的片名、人说过的话、作品图、本机路径只写进 `docs/本机/`；公开的文档和代码注释用中性说法，称呼用「人」「做片的人」
- **字体：** 这里只放 OFL 字体；商业字体只放在具体项目里（`config.ts` 的 `EXTRA_FONTS`）
- **署名：** 成片 `CREDITS` 注明用到的引擎、开源代码和素材。核心来自 mexicat/pdoom-video（MIT），shaders 来自 shader-effects-inc/shaders（MIT），详见 `README.md`
- **带声音的页面：** 在面板里测试要静音（`film.py` 的页面加 `?mute`，其他页面先把 video、audio 设成 muted）

## 改引擎

- 加能力和选项，不加强制步骤；重的流程（多方向候选、整套自检、独立评审）保持按需，默认走轻的路
- 新东西先问：它是器官（分析、出片、版本、检查、声音、交付），还是一种画画的办法？器官进底座；画画的办法进可选零件或效果库（`app/src/library/`），默认不进新项目
- 工具开头写清楚用途和用法；脚本读写当前目录，能留在引擎里原地跑
- 验证：`python -m unittest tools/qa/test_qa.py`；改了 app：`cd app && bunx tsc --noEmit -p tsconfig.json`，再渲示例看图；动了 `library/kit/sfx*.ts`、`kit/edt.ts` 或 `library/vendor/shaders` 跑 `bun scripts/sfx-test.ts`
- 已复制出去的项目不会自动更新

只有编码上的坑留在这里：`render.ts` 默认自己起私有服务器；只停外层 shell 时渲染进程会自己收掉，旧版残留用 `bun scripts/kill-render.ts`；外部重新编码要保留 BT.709（`check_video.py` 会查）。

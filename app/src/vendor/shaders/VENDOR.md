# shaders（收进引擎的第三方库）

引擎的 `kit/sfx.ts` 用它：200 个 WebGPU 效果组件（渐变、噪声、玻璃、镀铬、光、扭曲、转场、模糊、模拟）。

- 来源：<https://github.com/shader-effects-inc/shaders> 的 `packages/core/src`，commit `81fd4ece5d493ca6c424a2af41f0e2c361ec8258`（2026-10-09，Release v4.0.4）
- 许可：MIT，Copyright (c) 2026 Shader Effects Inc.（本目录 `LICENSE`）。成片 CREDITS 写「Shader effects: shaders by Shader Effects, Inc. (MIT)」
- 只收 core（引擎 + 组件 + 框架无关的渲染器）。shaders.com 的设计编辑器、Pro 预设、MCP 不是这个包的东西，也没收
- 没收：`__tests__/`（测试跑在原仓库里）、`telemetry/`（遥测：原库的 js/react/vue 宿主会抽样往 shaders.com 发性能数据，core 渲染器本身不调用；引擎只用 core，不带遥测）、`shaders/*/cover.jpg`（编辑器的封面图）
- 依赖（app/package.json）：`typegpu@0.12.3`、`colorjs.io@0.5.2`；开发依赖 `unplugin-typegpu@0.12.2`（vite.config.ts 里的插件，把 `'use gpu'` 函数编译成 WGSL）、`@webgpu/types@0.1.60`。路径别名 `@coreroot` → 本目录（vite.config.ts、tsconfig.json）

## 补丁

改动处都标了 `XM-PATCH(<名>)`（`grep -rn XM-PATCH app/src/vendor/shaders`），完整差异在 `VENDOR.patch`（相对原库同一 commit，25 个文件；在干净的原库副本上打这个补丁，结果和本目录一致，CRLF、LF 两种副本都验证过）。

| 名 | 文件 | 做什么、为什么 |
|---|---|---|
| no-process | gpu/root.ts | 去掉 Node 的 `process.env`（浏览器里没有）；关掉 TypeGPU 两类误报警告（`external-omitted`，以及原库 MaterialX 噪声哈希对 u32 用 `>>` 的弃用提示，每次编译都刷屏） |
| canvas-format | gpu/index.ts | `initialize({ canvasFormat })`：画布纹理格式。引擎用 `rgba16float`（默认是 8 位），HDR 和精度不丢；配 `toneMapping: 'extended'` |
| fixed-size | gpu/index.ts | `initialize({ fixedSize: { width, height, pixelRatio } })`：离屏、尺寸固定（不看 devicePixelRatio，不按浏览器窗口压缩分辨率，不听窗口缩放），一开始就帧锁定 |
| clock | gpu/index.ts | `setClock(t, overrides?)`：所有时钟直接设到 t（`t × speed`），帧可以任意顺序渲；`renderNow(dt)` 同步出一帧；`isSettled()` 组合是否已是当前 prop 描述的那个（编译期 prop 改了，新组合下一帧才上屏）；`resetState()` 丢掉所有组合（连同模拟的状态），时钟归零 |
| errors | gpu/index.ts | `getErrors()` / `clearErrors()`：渲染、设备、组合验证错误都记下来，宿主可以报错而不是悄悄画空 |
| pointer | gpu/index.ts | `setPointer(x, y, active)`：脚本控制的指针；调过一次之后窗口的鼠标、触摸事件一律不听（预览时鼠标在页面上晃，不会让导出结果变） |
| pending | gpu/xmPending.ts（新文件）+ std/paint/media、utilities/fonts、utilities/sdfBounds、gpu/kit/sdf、shaders/Ascii | 全页面的异步加载计数（图片解码、SDF、真正走网络的字体），宿主在导出前等它归零 |
| abs-clock | gpu/index.ts + StudioBackground、Form3D、std/effects/blurs（frameSway）、std/effects/color（filmGrain）、gpu/kit/sdf3d | 宿主用 setClock 驱动时，`frameParams.xmTime` = 这一帧的绝对时间；原库这 6 处自己在 CPU 上累加 dt 的时钟（环境灯漂移、自转、颗粒漂移、胶片晃动、形状子属性动画）改用它。否则无状态渲染（dt = 0）时它们冻住，重组合时也会归零 |
| media-cache | std/paint/media、gpu/kit/sdf | 解码过的图片、加载过的 SDF 按 URL 缓存：组合重建（有状态列表 reset、重编译）时第一帧就同步写入，不会有缺图的帧 |
| host-clock | gpu/xmClock.ts（新文件）+ gpu/index.ts、std/sim/grids、std/sim/fluids、gpu/kit/waves、gpu/kit/host/canvasRaster、gpu/kit/sdf3d、shaders/Fog | 原库多处读墙钟（`Date.now()`）：CPU 网格模拟（ChromaFlow、PixelThrow）按墙钟算 dt，波纹 / 网格的静止判定、流体的 now、文字栅格的 16 ms 节流都看墙钟，导出时结果随机器快慢变。宿主驱动时 `xmNow()` = 这一帧的时间，网格模拟用帧的 dt，栅格每帧都查，体积场分辨率不带历史死区；Fog 的预热相位不再用 `Math.random()` |
| deterministic-fluids | gpu/scaffolds/fluids.ts | 流体（Smoke、InkFlow、SmokeFlow、SmokeFill、Fog、ParticleFlow）的压力 Jacobi 迭代原来在同一个缓冲上原地读写，结果取决于 GPU 调度（同样的帧跑两次 Fog 差 51 级）。改成红黑 Gauss–Seidel，ceil(J/2) 轮，dispatch 数和解算强度同原来 |
| deterministic-boids | shaders/Boids、std/sim/agentForces | Boids 原地更新鸟群、同一个 dispatch 里读邻居（原注释：读到本帧还是上一帧的邻居看调度），鸟群是混沌系统，两次运行完全分叉。加 `agentsPrev` 快照，更新前拷一份，flocking 从快照读 |
| desktop-quality | utilities/device.ts | `xmForceDesktopQuality()`：宿主（kit/sfx.ts）一律走桌面质量，触屏笔记本或小窗口不会被判成手机而降质（预览和导出一致） |
| no-nan | gpu/kit/noisePaints.ts | Strands 的收尾 `toneLift` 对负值做 `pow`（WGSL 里是 NaN），HSL / HSV 色彩空间下出 NaN 像素（8 位画布上是黑点）：先截到 0 |
| local-fonts | utilities/fonts.ts、shaders/Ascii | 页面自己注册过的字体（引擎的字体）直接用，不去请求 Google Fonts |
| role | std/lower.ts | 编译后的定义上保留声明的 role（`xmRole`），宿主据此判断哪些组件有状态（'simulation'） |
| sdf-1024 | gpu/kit/sdf.ts、utilities/sdfBounds.ts | 自定义形状的 SDF 场 512² → 1024²（引擎自己生成，kit/sfx-shape.ts：文字的细笔画）。shaders.com 生成的 512² .bin 因此不能直接用 |

## 测试

`bun scripts/sfx-test.ts`（app 目录下）：每个组件经原库自己的离线路径（`createRendererFromJSON`，8 位画布）和经引擎宿主（Sfx）各渲一遍逐像素比，外加确定性、逐步 vs 直接、两种输入路径、冒烟。结果写到 `out/sfx_test/`。详见 `docs/模块目录.md` 的 shaders 一节。

## 更新到原库的新版本

1. clone 原库新 commit；把 `packages/core/src` 复制过来覆盖本目录，同样不要 `__tests__/`、`telemetry/`、`*.jpg`
2. 在仓库根目录 `git apply -p2 --directory=app/src/vendor/shaders app/src/vendor/shaders/VENDOR.patch`（补丁里的路径是 `a/shaders/…`；新文件 `gpu/xmPending.ts`、`gpu/xmClock.ts` 也在补丁里）；对不上的地方按上表手工补。本文件、`LICENSE`、`VENDOR.patch` 保留
3. 依赖版本对齐原库的 `packages/core/package.json`（typegpu、unplugin-typegpu 两个要同版本系列）
4. `bunx tsc --noEmit -p tsconfig.json`，`bun scripts/sfx-test.ts` 全部通过；新组件有状态的，补进 kit/sfx.ts 的 `STATEFUL_EXTRA`（测试的 stepping 项会指出来）
5. 重新生成 `VENDOR.patch`：干净的原库 `packages/core/src`（同样的排除）放到 `a/shaders`，本目录（不含本文件、`LICENSE`、`VENDOR.patch`）放到 `b/shaders`，在它们的上一级 `git diff --no-index --no-prefix --binary a/shaders b/shaders > VENDOR.patch`（Windows 上 `core.autocrlf=true` 时 git 按 LF 比较，换行不同不会算成整文件改动；关了 autocrlf 就先把两边统一成同一种换行）；再拿一份干净副本按第 2 步打一遍，和本目录 `diff -r` 应当无差别。最后改本文件开头的 commit 号

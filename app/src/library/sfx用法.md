# shaders 库的用法和规则

> 效果库 `kit/sfx.ts` 用到的 shaders 库（200 个 WebGPU 效果）怎么接、有哪些规矩。组件清单在 [sfx组件.md](sfx组件.md)，目录在 [README.md](README.md)。

shaders 库（shader-effects-inc/shaders，MIT，收在 `vendor/shaders`，见那里的 `VENDOR.md`）的 200 个效果组件：渐变、噪声、玻璃 / 镀铬 / 霓虹等形状材质、光、扭曲、转场、模糊、流体和粒子模拟。图层列表就是 shaders.com 导出的 preset JSON，在浏览器真的 WebGPU 上渲，再交回引擎当纹理（GPU 到 GPU，半浮点，HDR 不丢）。组件清单见 [sfx组件.md](sfx组件.md)，示例 `/?sfx=<组件名>`（`scenes/demo_sfx.ts`）和 `/?sfx=showcase`（`scenes/demo_sfx_title.ts`：上一场景翻页翻走，露出 3D 镀铬标题）。

```ts
import { Sfx } from '../library/kit/sfx';     // 项目场景里（src/scenes/）的写法
import { sdfText } from '../library/kit/sfx-shape';
async init() {
  this.fx = new Sfx(this.ctx.renderer, [
    { type: 'StudioBackground' },
    { type: 'Chrome', id: 'title', props: { shapeSdfUrl: sdfText('标题', { font: font(F.sans(700), 260) }).url, shapeType: 'svgExtrude3D' } },
    { type: 'PagePeel', id: 'peel', props: { amount: 0 }, children: [{ type: 'EngineTexture', props: { source: 'prev' } }] },
  ]);
  await this.fx.init();                           // 设备、管线、异步加载（图片、字体、形状）
}
render(f, out) {
  this.fx.input('prev', this.prevRT);             // EngineTexture 的画面：渲染目标、Layer2D、画布、图片
  this.fx.set('peel', { amount: f.tin });         // 任何 prop，任何一帧（图层要有 id）
  this.fx.render(f.lt, out);                      // 时刻 t 的画面：线性 HDR、直通 alpha
}
```

规则：

- **要 WebGPU**：Edge / Chrome（`render.ts` 的无头 Edge 有）。引擎画布因此开了 alpha 和半浮点缓冲（`gl.ts makeRenderer`，最终画面和以前逐位一致）。
- **时间**：`fx.render(t)` 的 t 是你给的秒数（`f.lt` 或 `f.t`，和调参时一致）。没有模拟的列表（`fx.stateful === false`，大多数）是 t 的纯函数，帧可以任意顺序渲，自适应运动模糊照常用。有模拟的列表（原库的 simulation 组件，加上靠积分 dt 的 CursorRipples、Liquify 等，以及用了鼠标驱动的图层；`fx.stateful === true`）按每秒 `rate`（默认 60）步从上次 `reset()` 走到 t：场景设 `stateful = this.fx.stateful`，`reset()` 里调 `this.fx.reset()`，导出用固定 `--samples`。
- **异步加载**：`await fx.init()` 等图片、字体、形状都加载完。之后再改 url / `shapeSdfUrl` / 字体这类 prop，要 `await fx.ready()`；所以这些在 `init()` 里定好，不要在 `render()` 里换（换了会警告：那一帧可能缺图）。
- **编译期 prop**（组件定义里标 `compileTime`，如 PagePeel 的 `corner`、各种 `shapeType`）：改了会重编译那一组合（几十毫秒），宿主自动多渲一帧到新组合上屏；可以改，别每帧改。
- **颜色**：默认 `colorSpace: 'srgb'`（色值和引擎其他模块一致）。`'p3-linear'` 是原库默认、也就是 shaders.com 编辑器里看到的样子；一个页面所有 Sfx 必须用同一种（原库是全局设置）。
- **输出**：`fx.render` 写进 `fx.rt` 或你给的 `out`（覆盖写入），线性 HDR、直通 alpha；透明的地方（比如翻页翻走的部分）是 alpha 0，用 `ctx.comp.draw` 叠到别的画面上。
- **输入**：`{ type: 'EngineTexture', props: { source: '名' } }` + `fx.input('名', 源)`。渲染目标按线性 HDR 传（经引擎画布中转，尺寸不能大于输出），Layer2D / 画布 / 图片按 sRGB 传。
- **指针**：读指针的组件（流体、涟漪、拖尾）用 `fx.setPointer(x, y, active)` 脚本控制（0..1，左上原点）；真实鼠标一律不听。
- **自定义形状**：`kit/sfx-shape.ts` 的 `sdfText` / `sdfImage` / `sdfShape` 把文字、图片、画布画的东西做成 SDF（1024²，blob URL），给任何有 `shapeSdfUrl` 的形状材质用；`shapeType: 'svgExtrude3D'` + `shape` JSON（`depth`、`bevel`、`rotX/Y/Z`）是挤出的立体。
- **字体**：Text、Ascii 的 `fontFamily` 写引擎注册过的字体名（`F.sans()`、`F.serif()` 返回的名字，`Plex-400`、`PressStart2P`，或 `config.ts` 的 `EXTRA_FONTS`），就直接用本地字体。写别的名字（组件默认的 Inter、Ascii 列表里的等宽字体），原库会去 Google Fonts 在线下载，断网时回落到系统字体；渲染不要依赖在线字体，要用就下载到项目里注册。
- **不能逐帧导出**的：VideoTexture、WebcamTexture（按真实时间播放）、HTMLInCanvas（要活的 DOM）。视频画面用引擎自己的解码帧经 EngineTexture 喂。
- **自己写效果**：原库的 `defineShader`（`vendor/shaders/std`，写 WGSL 或用它的原语）定义的组件，传 `new Sfx(…, layers, { components: [MyFx] })` 就能按名字和库里的组件混用。
- **NaN**：任何组件算出的非有限像素（NaN / Inf）交回引擎前都变成透明黑，不会被泛光扩成黑斑。
- **开销**（`fx.render` 一帧，含 WebGPU→WebGL 回传；NVIDIA Blackwell 显卡）：1080p 中位数约 1 ms、九成在 1.3 ms 内；4K 中位数约 1.4 ms、九成在 2.3 ms 内；最贵的 Form3D 约 5 / 15 ms。滤镜每路 EngineTexture 输入另加不到 1 ms。运动模糊的每个子帧都要算一遍。各组件的数见 [sfx组件.md](sfx组件.md)。
- **别绕开 three.js 改 GL 状态**：自己调 `gl.pixelStorei` 之类会让 three 的状态缓存失真（kit/sfx.ts 曾因此让下一次 Layer2D 上传上下颠倒）；用 `renderer.state.*`。

在 shaders.com 的编辑器（免费，要登录）里调好一个效果再搬进来：Export Code 选 JavaScript，把 `createShader(el, { components: [...] })` 里的 `components` 数组原样贴给 `new Sfx(renderer, components, { colorSpace: 'p3-linear' })`（p3-linear 才和编辑器里看到的颜色一致；同一页面别的 Sfx 也得用它）。要喂引擎画面的地方把 ImageTexture 换成 EngineTexture。编辑器的 Pro 预设和导出 SDF 形状要付费，引擎用不到：形状用 `kit/sfx-shape.ts` 自己做。

出错时（组件编译失败、验证错误、加载失败）Sfx 把库报的错打到控制台（`render.ts` 的 BROWSER LOG 里看得到），`fx.errors()` 也能取。

改了原库或宿主后：`cd app && bun scripts/sfx-test.ts --tests parity,determinism,stepping,input,smoke,sweep`（全部组件：和原库自身离线渲染逐像素对照、确定性、逐步 vs 直接、全部 prop 取值扫描、冒烟；外加两路输入、HDR 保真、NaN 兜底、three.js 状态一致性），`bun test tests/sfx-shape.test.ts`（距离场）；耗时单独测（`--tests perf`，4K 加 `--scale 2`），测时机器上别跑别的，否则数会偏高，再渲 `?sfx=showcase` 的视频看一遍（`render.ts video --from 0 --to 8 --samples 4 --query sfx=showcase`）。

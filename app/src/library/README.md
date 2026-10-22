# 效果库

以前几支片子里做过的特效模块、场景级部件、示例场景和 shaders 库，从引擎核心里搬出来放在这里（2026-10-17）。
**新项目不复制这个目录**（`tools/new_project.py` 跳过它），引擎的文档也不默认指向这里：用户点名要某种效果、或者某个镜头确实需要时再来拿。

- **怎么用**：把要用的文件按原路径复制进项目的 `app/src/library/`（连同它 import 的库内文件，见文件开头），import 不用改；项目场景里写 `import { … } from '../library/kit/clouds'`。示例场景可以复制到项目的 `app/src/library/scenes/`，时间线直接按名字载入
- **看效果**：在基础引擎里开 `/?sky`、`/?voxel`、`/?sfx=<组件名>`、`/?sfx=showcase`、`/?ref=<名>`、`/?ref=intro`（入口 `demos.ts`）
- **以前的结果**：纸片剧场（`engine/paper.ts`）在 Clarity 被说“有劣质感”；拿图片拆层做视差动（`engine/sprite.ts` + `tools/assets/layers.py`）在 Still_Shining、乐观自由都被说“像 PPT”；代码搭的人物（MMD、自建模型）在乐观自由被说“别扭”。这些路子用之前先想清楚能不能做好
- 这里的示例场景是写来验证模块、看接线的，不是画面标准；`ref_*` 十段是照参考片做的练习，用户看过，判断不如原片
- 单线书写字体（`engine/stroke.ts`）引擎不再在启动时加载，用前在场景 `init()` 里 `await loadStrokeFonts()`
- 动了 `kit/sfx*.ts` 或 `vendor/shaders` 要跑 `cd app && bun scripts/sfx-test.ts`

## 3D

| 文件 | 做什么 | 什么时候用 | 来源 |
|---|---|---|---|
| `engine/terrain.ts` | 低多边形地形、等高线梯田沙盘、水面区域 | 地形、沙丘、岛屿 | Clarity |
| `engine/voxel.ts` | 体素网格 → 一个实例化网格，带 MC 式 AO、按时间组装 / 飞散动画、文字转体素 | 方块世界、体素字 | Clarity |
| `engine/portal.ts` | 「传送门」转场：下一场透过上一场物体上的洞出现 | 场景之间要从物体里穿过去时 | Clarity |
| `engine/shards.ts` | 玻璃碎裂转场：沃罗诺伊裂纹后碎片飞向镜头 | 碎裂、冲击 | Still_Shining |
| `engine/mmd/` | three.js 的 MMD 模型加载器（MIT） | 用 MMD 角色模型时（Still_Shining 的 `teto3d.ts` 是完整用法） | Still_Shining |
| `kit/fpv.ts` | 贴地高速飞行相机（提前爬升、不穿模）、沿谷底找路线、环绕镜头；地形用 `ground` 传入 | 穿越、俯冲、一镜到底飞行 | Falling_Again |
| `kit/geo.ts` | 带顶点颜色的几何体合并、悬链线 | 程序建模（电线、城市） | Still_Shining |
| `kit/clouds.ts` | 体积云层：Perlin-Worley 噪声塑形的碎积云，半分辨率光线步进，自阴影、多次散射近似、银边、云里是亮的、远处融进雾；`cloudLight()` 按太阳高度给光（日落后从下面烧红云底）；`bump` 把一朵云放在指定位置（角色穿云）。每帧约 +7 ms，云量为 0 时不算 | 云海、穿云、头顶的云层；示例 `?sky`（`scenes/demo_sky.ts`） | Still_Shining v10 |
| `kit/bokeh.ts` | 按深度的镜头虚化（96 采样的金角螺旋 gather，背景不糊到前景上，采样图案按子帧旋转，导出时每个子帧都能用）：城市灯、楼窗散成光斑，角色后合成保持清晰 | 近景、人物特写；比 kit3d 的 DofPass 便宜得多 | Still_Shining v10 |
| `kit/sunrays.ts` | 屏幕空间光束：只取深度为天空的亮像素（不会把红灯拖成线），按角色 alpha 遮挡，从太阳的屏幕位置径向拖开 | 日出、逆光、云缝里的光 | Still_Shining v10 |
| `kit/motes.ts` | 空气光点：镜头周围循环盒子里的闪烁冰晶，跟着角色走就是飘在身边的闪光，静止在空气里就被动态模糊拉成速度线；按到角色的距离分前后两遍 | 下坠 / 飞行的速度感、闪光、夜里的浮尘 | Still_Shining v10 |
| `engine/mmd/rig.ts` | MMD 角色：裙摆和腿的碰撞（按铰链外掀 + 相邻跟随 + 下摆回落，每帧独立，没有物理状态）、走光检查 `thighView`（镜头和大腿方向夹角）、按名字找骨骼链 | 角色抬腿时裙摆穿模；抖音不走光（配 `render.ts scan`） | Still_Shining v10 |
| `kit/npr.ts` | 把 3D 画成动画线稿：深度 / 法线断开处出线，平涂渐变，只有发光体保留颜色 | 「代码搭 3D、画面像手绘」 | Still_Shining |
| `kit/paint.ts` | Kuwahara 油画滤镜：3D 画面重画成笔触，再拉到指定色带 | 「不要写实、要像封面那样的画」 | Falling_Again |


## 2D

| 文件 | 做什么 | 什么时候用 | 来源 |
|---|---|---|---|
| `engine/fx.ts` | 天空渐变、太阳星芒、气流线、文字窗口、调色、集中线、重新打光、水洼倒影、拷贝 | 2D 场景的常用全屏效果 | Still_Shining |
| `engine/sprite.ts` | 透明 PNG 精灵：可弯曲网格（头发 / 布料随风，遮罩可传入）、分层调色、景深模糊、2D 视差相机 `Cam2D` | Codex 出的角色和背景拆层做视差动画 | Still_Shining |
| `engine/paper.ts` | 纸片剧场：Canvas2D 图层放进 3D 做视差，纸纹、毛边、半调、象形小人 | 平面设计 / 纸艺风 | Clarity |
| `kit/tegaki.ts` | 手绘感：8 fps 抽帧、线条抖动、纸张、手写字、速度线、墨点 | 手绘 / 漫画风 | Still_Shining |
| `kit/typo.ts` | 巨型窄体字当窗口看画面、逐词砸字、中文行 | 歌词排版为主的段落 | Still_Shining |
| `kit/lyrics-kit.ts` | 英文逐词 + 中文逐字的歌词排版、标准歌词位、鼓点推镜 `pump`、泪滴、星芒、关键帧轮换 | 双语歌词、二次元风 | Still_Shining |
| `engine/ascii.ts` | 字符画：任意画面按亮度换成字符网格（实测墨量排序、彩色 / 单色荧光、可自定义字符集）；`GlyphAtlas` 字形图集（和字符粒子共用） | 终端、CRT、“由字符组成”的形状 | 复刻配方 |
| `kit/glyphfield.ts` | 字符粒子：几千个字在 3D 里翻转飞散 / 汇聚（一次实例化绘制），`cellsFromCanvas` 把形状变成字符格落点 | 字符爆散、字符组成的脸 / 星系；示例 `?ref=boot` | 复刻配方 |
| `engine/warp.ts` | 万花筒 `Kaleido`（极坐标 N 折 / 镜像墙纸）、无限缩放 `Droste`（挖空画框、每层旋转）、虹膜转场 `Iris` | 曼陀罗、画框隧道、圆窗换画风 | 复刻配方 |
| `kit/textfx.ts` | 环形字 `ringText`、路径字 `pathText`、贴纸字 `stickerText`、彩虹叠层挤出 `stackText`、裂纹字 `crackText` | 唱片环、Memphis 贴纸字、彩虹立体字 | 复刻配方 |
| `kit/termhud.ts` | 叙事 HUD：小节号牌、元数据行、漫画旁白框、标注框、监控面板、终端弹窗（逐字打）、滚动数位、瞄准环 | 用界面讲故事 | 复刻配方 |
| `kit/rhythm.ts` | 音游跑道 `Highway`：音符来自 `events.json` 的真实鼓点，判定牌、连击、分数、波形山脊、远端段落标记 | 音游段落 | 复刻配方 |
| `kit/pixelstage.ts` | 像素世界被 3D 相机拍：低分辨率画布（最近邻）+ 发光层 + 俯仰/偏航/翻滚/推拉 + 远处点阵虚空 + 像素点阵 | 像素游戏风、Hi-bit | bad-time-mv 手法（重写） |
| `kit/subs.ts` | 双语逐词点亮字幕（只在变化时重画），每句在第一个词开口时才换；白 / 深藏青两种墨色，`SubsComposite` 在 GPU 上量字幕背后的亮度自动选（白云上不再看不清） | 需要固定字幕条时 | Still_Shining v8–v10 |
| `kit/anim.ts` | 关键帧动画：数值 / 向量 / 颜色的关键帧（`auto` 速度连续穿过、`ease` 停住、`lin`、`hold`），循环轨道、贝塞尔缓动预设、弹簧、挤压拉伸、2D 镜头（`applyCamera` / `toScreen` / 带滞后的 `follow`） | 任何要连贯的图形动画：元素一直存在、属性沿缓动曲线变、转场是同一元素在变（不要用逐帧随机凑运动量） | 2026-10 连贯性 |
| `kit/morph.ts` | 形状变形和路径动画：字 / 圆 / 方块 / SVG 都变成轮廓，`Morph` 互相变形（条数不同时从一点长出）；`PathWalk` 沿路径走、修剪路径；`ribbon` 变宽描边；`smoothPath` | 点胀成圆、圆变成字、笔头写字、沿着字跑、拖尾 | 2026-10 连贯性 |
| `kit/svg.ts` | SVG 素材 → 形状：path（含圆弧）、多边形、矩形、圆、transform，取填色和描边 | 用 Illustrator / Figma 画的 tag、手绘字、贴纸放进 `public/assets/` 做动画 | 2026-10 连贯性 |
| `kit/rig.ts` | 象形小人绑定：设计过的冲刺循环（两拍一循环，脚步踩拍）、预备 / 起跳 / 收腿 / 落地等关键姿势、姿势混合、关节位置 | 图形风的奔跑角色；围巾、拖尾按关节在过去一小段时间里走过的路径画 | 2026-10 连贯性 |

## shaders 库的 200 个效果（WebGPU）

shaders（shader-effects-inc/shaders，MIT）原样收在 `vendor/shaders`（只打了标 `XM-PATCH` 的补丁，见那里的 `VENDOR.md`），跑在浏览器真的 WebGPU 上，和引擎在 GPU 上互传纹理。组件清单（说明、要不要子层、有没有状态、和原库的对照结果、每帧耗时）见 [sfx组件.md](sfx组件.md)。用了它的成片 `CREDITS` 写 shaders by Shader Effects, Inc.（MIT）。

| 文件 | 做什么 | 什么时候用 | 来源 |
|---|---|---|---|
| `kit/sfx.ts` | `Sfx`：图层列表（shaders.com 导出的 preset JSON 格式）→ 引擎纹理（线性 HDR、直通 alpha）；`set` 改 prop、`input` 喂引擎画面、`render(t)`、`reset`；自动判断有无状态 | 渐变 / 噪声背景、玻璃 / 镀铬 / 霓虹 / 液态金属等形状材质、光束 / 镜头光晕 / 漏光、各种扭曲、13 种转场、景深 / 移轴 / 渐进模糊、流体 / 墨 / 烟 / 粒子 / 反应扩散模拟、字符画、半调、版画、胶片 | 本引擎 |
| `kit/sfx-input.ts` | `EngineTexture` 组件：引擎的渲染目标 / Layer2D / 画布 / 图片当图层（和原库 ImageTexture 一样的适配方式） | 给滤镜、转场、形状材质（折射背景）喂引擎画面 | 本引擎 |
| `kit/sfx-shape.ts` | 文字 / 图片 / 画布 → SDF（原库的 .bin 格式，1024²，blob URL）：`sdfText`、`sdfImage`、`sdfShape` | 镀铬字、玻璃字、霓虹字、3D 挤出字（`shapeType: 'svgExtrude3D'`）、Logo | 本引擎 |
| `scenes/demo_sfx.ts`、`scenes/demo_sfx_title.ts` | `/?sfx=<组件名>` 看任一组件（滤镜套在测试卡上）；`/?sfx=showcase`：翻页转场 + 3D 镀铬标题 | 挑效果、看接线 | 本引擎 |
| `app/scripts/sfx-test.ts`（`app/sfxtest.html`、`sfxtest.ts`） | 全部组件和原库自身离线渲染逐像素对照、确定性、逐步 vs 直接、两路输入、全部 prop 取值扫描、冒烟、耗时（1080p / 4K）；`--catalog` 生成组件清单 | 改了原库或宿主之后 | 本引擎 |

### 用法和规则

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

## 参考实现：十段效果练习

`scenes/ref_*.ts`（`/?ref=<名>`）：照两支参考片做的十段（开机字符粒子、画框隧道、威胁爆发、唱片、叠层字、音游、8-bit 体素井、万花筒、崩溃关机、像素世界），列表、手法和对照方法见基础引擎 `docs/复刻配方.md` 第四、五节。用字符画、字符粒子、像素世界、音游这些模块时看它们怎么接线、取值大概多少；它们是碎片、比原片静。

## 第三方参考（仓库根目录 `third_party/`，没改写进引擎）

水彩 / 水墨 / 厚涂笔刷、CRT 的另一种写法、43 种画风说明（lemo-opuscar），纸偶骨骼和软体物理（papermotion），手绘笔刷和角色 rig（claude-animation-skill），写实浅水（clearwater），p5.brush 手绘流程（ClaudeAnimationBase）。要用时读源码，按引擎的写法改写，成片 `CREDITS` 注明来源。详见 `third_party/README.md`。

## 没收进来的

这些绑定了具体歌曲或角色，要用时去原项目里看：

- Still_Shining：`teto3d.ts`（Teto 的 MMD 角色：卡通材质、骨骼姿势、头发裙子风动；其中的裙摆碰撞和走光检查已抽成 `engine/mmd/rig.ts`）、`ss/towers.ts` 的楼窗、`ss/city.ts` 的城市灯海、`city3d.ts`（程序生成的夜景城市）、`ss/`、`world/` 里的城镇和火车、`manga/`
- Falling_Again：沙漠、云、闪电、隧道等场景；`analysis/cut.py`（剪辑版音频）
- pdoom：P(doom) 读数、`zh.ts` 中文翻译层、各图版场景

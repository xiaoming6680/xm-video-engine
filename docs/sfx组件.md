# shaders 库组件（kit/sfx.ts）

201 个（含引擎的 EngineTexture）。由 `bun scripts/sfx-test.ts --catalog ../docs/sfx组件.md --report ../out/sfx_test/report.json --perf ../out/sfx_perf/report.json --report4k ../out/sfx_perf4k/report.json` 生成（app 目录下；三份报告来自 `bun scripts/sfx-test.ts --tests parity,determinism,stepping,input,smoke,sweep --out ../out/sfx_test`、`bun scripts/sfx-test.ts --tests perf --out ../out/sfx_perf` 和 `bun scripts/sfx-test.ts --tests perf --scale 2 --out ../out/sfx_perf4k`；测性能时机器上别跑别的），改了原库或重测后重跑；说明是原库的英文原文。
每个组件的 prop、默认值、取值范围看 `app/src/vendor/shaders/shaders/<名>/index.ts`；怎么用见 [模块目录.md](模块目录.md) 第四节。

标记：**子** 滤镜，要子层（EngineTexture 或别的组件）；**态** 有状态（场景要 `stateful = true`，`reset()` 里调 `fx.reset()`）；**指** 读指针（`fx.setPointer`）；**实** 实时媒体（视频 / 摄像头 / DOM），不能逐帧导出，用 EngineTexture 喂画面代替。
对照：和原库自己的离线渲染逐像素比的最大差（8 位色阶，各测试帧取最大；测试 2026-10-13，NVIDIA Blackwell 显卡）。ms：`fx.render()` 一帧的耗时（连续 30 帧取平均，含 WebGPU→WebGL 回传），1080p / 4K。

## Adjustments（14）

| 组件 | 标记 | 说明 | 对照 | ms 1080p | ms 4K |
|---|---|---|---|---|---|
| BrightnessContrast | 子 | Adjust brightness and contrast of the image | 0 | 1.1 | 1.3 |
| Duotone | 子 | Map colors to two tones based on luminance | 1 | 1.2 | 1.3 |
| Exposure | 子 | Multiplicative exposure (gain) on the child. | 0 | 1.1 | 1.3 |
| FilmStock | 子 | Real analog film color from measured film-emulation LUTs — ten classic stock looks with emulsion halation and projector gate weave | 1 | 1.6 | 1.9 |
| Grayscale | 子 | Convert colors to black and white | 1 | 1.1 | 1.3 |
| HueShift | 子 | Rotate hue around the color wheel | 0 | 1.1 | 1.4 |
| Invert | 子 | Invert RGB colors while preserving alpha | 1 | 1.2 | 1.3 |
| Posterize | 子 | Reduce color depth to create a poster effect | 0 | 1.1 | 1.3 |
| Saturation | 子 | Adjust color saturation intensity | 0 | 1.1 | 1.5 |
| Sharpness | 子 | Adjust image sharpness using a convolution kernel | 0 | 1.2 | 1.5 |
| Solarize | 子 | Inverts tones above a luminance threshold — a classic darkroom and photo effect | 1 | 1.1 | 1.7 |
| Tint | 子 | Apply a color tint to the image | 1 | 1.2 | 1.3 |
| Tritone | 子 | Map colors to three tones: shadows, midtones, highlights | 1 | 1.2 | 1.4 |
| Vibrance | 子 | Selective saturation adjustment protecting skin tones | 0 | 1.1 | 1.3 |

## Blurs（9）

| 组件 | 标记 | 说明 | 对照 | ms 1080p | ms 4K |
|---|---|---|---|---|---|
| AngularBlur | 子 | Radial motion blur rotating around a center point | 1 | 1.4 | 2.7 |
| Blur | 子 | A simple Gaussian blur effect | 1 | 1.3 | 2.0 |
| BokehBlur | 子 | Photographic lens blur where bright highlights bloom into aperture-shaped discs | 1 | 1.4 | 4.8 |
| ChannelBlur | 子 | Independent blur for red, green, and blue channels | 1 | 1.3 | 1.6 |
| DiffuseBlur | 子 | Grain-like pixel displacement at random | 1 | 1.2 | 1.8 |
| LinearBlur | 子 | Directional motion blur in a specific angle | 1 | 1.3 | 2.1 |
| ProgressiveBlur | 子 | Blur that increases progressively in one direction | 1 | 1.3 | 1.8 |
| TiltShift | 子 | Selective focus blur mimicking tilt-shift photography | 1 | 1.3 | 2.3 |
| ZoomBlur | 子 | Radial zoom blur expanding from a center point | 1 | 1.2 | 2.5 |

## Distortions（22）

| 组件 | 标记 | 说明 | 对照 | ms 1080p | ms 4K |
|---|---|---|---|---|---|
| BarShift | 子 | Slices content into parallel bars, each offset independently for a fractured or glitch-like effect | 1 | 1.1 | 1.5 |
| Bend | 子 | Bends the ends of the frame toward you like a curved display — content at the edges swells closer under real perspective, or curls away when the strength goe… | 1 | 1.2 | 1.5 |
| Bulge | 子 | Magnify or pinch content around a center point | 1 | 1.2 | 1.4 |
| ConcentricSpin | 子 | Concentric rings that each rotate the underlying image by different amounts | 1 | 1.1 | 1.4 |
| CornerPin | 子 | Pin each corner of the content to an arbitrary position for a free perspective warp | 0 | 1.2 | 1.6 |
| DisplacementMap | 子 | Distorts child content using another layer's pixels as a displacement map | 0 | 1.2 | 1.5 |
| Flip | 子 | Mirror content horizontally, vertically, or both | 0 | 1.3 | 1.3 |
| FlowField | 子 | Fluid-like distortion with constant smooth motion | 1 | 1.3 | 2.2 |
| FlutedGlass | 子 | Full-screen fluted glass effect — refracts content through repeating cylindrical bars | 1 | 1.2 | 1.6 |
| Form3D | 子 | Wraps child content onto a 3D raymarched shape with lighting. | 1 | 4.6 | 15.4 |
| GlassTiles | 子 | Refraction-like distortion in a tile grid pattern | 1 | 1.1 | 1.4 |
| Kaleidoscope | 子 | Create a kaleidoscope effect with radial mirrored segments | 1 | 1.1 | 1.7 |
| Mirror | 子 | Mirror content across a line defined by center point and angle | 0 | 1.1 | 1.7 |
| Perspective | 子 | Rotate the plane in 3D space with pan and tilt | 0 | 1.1 | 1.9 |
| PolarCoordinates | 子 | Convert rectangular coordinates to polar space | 1 | 1.1 | 1.7 |
| RectangularCoordinates | 子 | Convert polar coordinates back to rectangular space | 1 | 1.1 | 1.3 |
| Repeater | 子 | Repeat the child content in grid, radial or linear layouts with per-instance variation | 1 | 1.2 | 2.5 |
| Spherize | 子 | Map content onto a 3D sphere surface with depth distortion | 2 | 1.1 | 1.6 |
| Stretch | 子 | Stretch content towards a direction from a center point | 1 | 1.1 | 1.4 |
| Surface3D | 子 态 指 | Drapes child content over a 3D wave surface with perspective and lighting | 1 | 2.8 | 3.6 |
| Twirl | 子 | Rotate and twist content around a center point | 1 | 1.2 | 1.3 |
| WaveDistortion | 子 | Wave-based distortion with multiple waveform types | 1 | 1.2 | 1.4 |

## Interactive（16）

| 组件 | 标记 | 说明 | 对照 | ms 1080p | ms 4K |
|---|---|---|---|---|---|
| Boids | 态 指 | A living murmuration of hundreds of flocking agents drawn as crisp arrows, streaks, dots or glowing comets — separation, alignment and cohesion drive fluid, … | 2 | 0.8 | 1.1 |
| ChromaFlow | 态 指 | Interactive liquid flow effect that follows your cursor | 0 | 0.3 | 0.6 |
| CursorRipples | 子 态 指 | Fluid-like ripple distortion | 0 | 1.3 | 1.6 |
| CursorTrail | 态 指 | Animated trail effect that tracks cursor movement | 0 | 1.0 | 3.5 |
| Fog | 态 指 | Fog that fills the screen and interacts with the mouse | 2 | 1.3 | 1.2 |
| GridDistortion | 子 态 指 | Interactive grid distortion controlled by mouse position | 0 | 1.2 | 1.5 |
| InkFlow | 态 指 | Drag to paint swirling ribbons of ink through a real fluid field — eddies keep evolving after you let go | 0 | 0.5 | 0.6 |
| Liquify | 子 态 指 | Liquid-like interactive deformation effect | 0 | 1.3 | 1.4 |
| MagneticFilings | 态 指 | Thousands of tiny iron filings scattered on paper that swing to align with a magnetic field around the cursor, tracing out the field lines — a dipole whose a… | 2 | 0.5 | 0.7 |
| ParticleFlow | 态 指 | Thousands of drifting dust particles carried by a real incompressible fluid field the cursor stirs — drag to plow a wake and the particles ride the eddies an… | 2 | 1.1 | 1.1 |
| PixelSort | 子 态 指 | Pixels sort by brightness around the cursor and keep their sorted position, optionally decaying back over time | 0 | 1.4 | 2.1 |
| PixelThrow | 子 态 指 | Throws pixels along the cursor's path like a fluid — brighter (or redder/greener/bluer) pixels are flung farther, then settle back with friction | 0 | 1.3 | 2.0 |
| ReactionDiffusion | 子 态 指 | A living Gray-Scott reaction-diffusion pattern that fills the layer and blooms wherever you drag the cursor | 2 | 1.4 | 2.1 |
| Shatter | 子 态 指 | Broken glass effect with tectonic plate displacement | 0 | 1.2 | 1.6 |
| Smoke | 态 指 | Realistic fluid smoke simulation with vorticity dynamics | 2 | 1.2 | 1.2 |
| SmokeFlow | 态 指 | Cursor-driven smoke that lingers, swirls, and dissipates with fluid dynamics | 0 | 0.5 | 0.7 |

## Shape Effects（23）

| 组件 | 标记 | 说明 | 对照 | ms 1080p | ms 4K |
|---|---|---|---|---|---|
| BrushedMetal |  | Photorealistic brushed metal — a satin anodised surface combed with fine directional grain that smears the reflected studio and key light into the long aniso… | 2 | 0.4 | 1.1 |
| CarbonFiber |  | Photorealistic woven carbon fibre — interlaced tows whose anisotropic sheen flips ninety degrees cell to cell, raised into a quilted weave and finished with … | 1 | 0.4 | 0.9 |
| Chrome |  | Studio-lit mirror chrome — a precision-machined shape with a controllable polished bevel, softly convex faces and a photographic studio reflected in them: on… | 1 | 0.4 | 0.9 |
| Crystal | 子 | Diamond-like crystal lens with faceted refraction. | 1 | 2.0 | 6.8 |
| Emboss | 子 | Embossed / debossed relief shading on top of child content, driven by a custom shape | 1 | 1.2 | 2.0 |
| Frost |  | Photoreal frozen ice — thickness-driven subsurface scattering that reads as a solid block, with fine frost crystals creeping in from the edges | 2 | 0.6 | 0.9 |
| Glass | 子 | Optically realistic glass lens driven in a custom shape | 1 | 1.2 | 2.0 |
| Goo |  | Photoreal wet liquid — animated 3D metaball blobs that merge and bulge to loosely form the shape, with sliding wet highlights, a clearcoat rim and a transluc… | 2 | 0.7 | 1.2 |
| Heatmap |  | Thermal-camera heat flowing through any 2D, SVG, or 3D shape. | 2 | 0.7 | 1.3 |
| Hologram |  | Volumetric sci-fi hologram — a translucent emissive projection of the shape with fresnel-lit edges, depth scan-lines that wrap 3D forms, CRT scanlines, flick… | 2 | 0.6 | 0.8 |
| Holographic |  | Iridescent holographic foil sticker with animated rainbow sheen and glitter flakes | 2 | 0.6 | 1.0 |
| Irradiance | 态 | Photorealistic light spilling around the edge of any 2D, SVG, or 3D shape — any number of movable colored point lights strike the silhouette and the lit edge… | 2 | 0.6 | 1.1 |
| LightEdge |  | Glowing, pulsing light racing around the edge of any 2D, SVG, or 3D shape. | 2 | 0.5 | 1.5 |
| LiquidMetal |  | Flowing liquid chrome — a molten reflective surface that wraps the shape, sweeping a procedural studio reflection across animated folds with crisp speculars … | 1 | 0.4 | 0.9 |
| Nebula |  | A volumetric gas nebula sealed inside polished glass; billowing emission clouds with hollow dark cavities and hot glowing cores, star fields drifting at real… | 1 | 1.1 | 3.1 |
| Neon |  | Photorealistic neon tube / 3D pipe effect driven by a custom shape | 2 | 0.5 | 1.2 |
| Obsidian |  | Dark tinted glass whose faces stay near-black while every surface turning away from the viewer ignites with a flowing iridescent gradient — vivid color livin… | 2 | 0.4 | 0.9 |
| Particles | 态 指 | A swarm of simulated particles that settles into the shape, filling it evenly — flat, SVG or true 3D volumes — scattering from the cursor (or chasing it), tu… | 2 | 0.5 | 1.1 |
| Plastic |  | Glossy molded plastic with photorealistic studio reflections, driven in a custom shape | 2 | 0.7 | 1.1 |
| SmokeFill | 态 指 | Fill a shape with swirling fluid smoke that interacts with the shape boundary | 2 | 1.4 | 1.2 |
| ThinFilm |  | Iridescent thin-film edge | 2 | 0.4 | 0.9 |
| Voxels |  | Rebuild any shape out of voxels — a flat shape becomes chunky pixel art, a 3D shape a lit voxel model with smooth ambient occlusion, cast shadows, a key ligh… | 2 | 0.5 | 1.4 |
| Water |  | Translucent water — a refractive, light-absorbing body that deepens to its color with thickness, wrapped in a wind-driven wave surface that reflects a proced… | 2 | 0.7 | 1.3 |

## Shapes（16）

| 组件 | 标记 | 说明 | 对照 | ms 1080p | ms 4K |
|---|---|---|---|---|---|
| Arc |  | Pie sector (arc wedge) with adjustable radius and aperture angle | 0 | 0.4 | 1.1 |
| Circle |  | Generate a circle with adjustable size and softness | 0 | 0.3 | 0.6 |
| Crescent |  | Crescent moon shape — an outer circle with an inner circle subtracted | 0 | 0.3 | 0.6 |
| Cross |  | Plus / cross shape with adjustable arm length, width, and rounding | 0 | 0.3 | 0.6 |
| Ellipse |  | Ellipse with independently adjustable horizontal and vertical radii | 0 | 0.3 | 0.6 |
| Flower |  | Petal shape with N lobes and adjustable inner-to-outer radius ratio | 0 | 0.3 | 0.6 |
| Heart |  | Heart shape with adjustable size | 0 | 0.5 | 0.6 |
| Line |  | Draw a straight line between two points with color, thickness, and solid, dashed, or dotted styles | 0 | 0.3 | 0.6 |
| Parallelogram |  | Parallelogram with adjustable width, height and skew | 0 | 0.3 | 0.6 |
| Polygon |  | Regular polygon with adjustable sides and corner rounding | 0 | 0.5 | 0.6 |
| Ring |  | Annular ring (donut) with adjustable radius and band thickness | 0 | 0.5 | 0.6 |
| RoundedRect |  | Rounded rectangle with adjustable width, height, and corner rounding | 0 | 0.5 | 0.6 |
| Star |  | Classic star polygon with straight sides and sharp pointed tips | 0 | 0.5 | 0.6 |
| Teardrop |  | Teardrop — a rounded bulb tapering to a sharp point | 0 | 0.5 | 0.6 |
| Trapezoid |  | Trapezoid with adjustable top and bottom widths and height | 0 | 0.3 | 0.6 |
| Vesica |  | Vesica piscis (lens shape) formed by the intersection of two overlapping circles | 0 | 0.3 | 0.6 |

## Stylize（31）

| 组件 | 标记 | 说明 | 对照 | ms 1080p | ms 4K |
|---|---|---|---|---|---|
| Ascii | 子 | Convert imagery to ASCII character art | 1 | 1.3 | 1.6 |
| Chalkboard | 子 | Renders content as a chalk drawing on a blackboard, with edge strokes and cross-hatch shading | 1 | 1.2 | 1.9 |
| ChromaticAberration | 子 | Separate RGB channels for a prismatic distortion effect | 1 | 1.2 | 1.5 |
| CompressionArtifacts | 子 | Simulates lossy JPEG compression — 8×8 DCT block quantization, blockiness, ringing and color bleed | 1 | 1.3 | 3.6 |
| ContourLines | 子 | Draw topographical contour lines based on luminance or alpha | 1 | 1.1 | 1.3 |
| CRTScreen | 子 | Retro CRT monitor simulation with scanlines | 1 | 1.1 | 1.6 |
| DataMosh | 子 态 | Corrupted-codec motion smearing — macroblocks lock in place and drag their pixels across the frame in liquid trails, each recovering on its own clock, like a… | 2 | 1.2 | 1.6 |
| Dither | 子 | Dithering effect with multiple pattern options | 0 | 1.2 | 1.5 |
| DropShadow | 子 | Adds a soft shadow behind the child content based on its alpha silhouette | 0 | 1.2 | 2.0 |
| Engraving | 子 | Copper-plate line engraving — the image is redrawn as flowing line work whose weight swells with darkness, lines displaced by the form like a banknote portra… | 1 | 1.2 | 1.9 |
| FilmGrain | 子 | Analog film grain texture overlay, weighted toward darker areas | 1 | 1.1 | 1.6 |
| Glitch | 子 | Digital glitch that melts pixels and distorts colors | 1 | 1.4 | 1.7 |
| Glow | 子 | Soft glow effect with adjustable intensity | 1 | 1.6 | 1.9 |
| GradientMap | 子 | Maps source luminance through an animated color gradient (Photoshop-style gradient map) | 1 | 1.2 | 1.4 |
| Halftone | 子 | Halftone dot pattern effect for printing aesthetics | 2 | 1.2 | 1.7 |
| KeyFrames | 子 态 | Motion-tracking overlay — trackers hunt and follow features in the content, dropping keyframe diamonds behind them along their motion paths, like a composito… | 1 | 1.5 | 2.4 |
| LensDistortion | 子 | Split content into shifting chromatic layers with barrel or pincushion lens warp. | 1 | 1.4 | 4.4 |
| LensFlare |  | Realistic camera lens flare with artifacts. | 2 | 0.5 | 1.2 |
| LightLeak | 子 | Photorealistic film light leak — warm overexposed light bleeding in from a draggable anchor point, with streak bands, chromatic fringing, and slow breathing … | 1 | 1.2 | 1.6 |
| ObjectTracker | 子 | Computer-vision style object detection overlay — draws bounding boxes and labels around detected regions of the content below, with grid, quadtree and mosaic… | 1 | 1.2 | 1.8 |
| Paper | 子 | Applies realistic paper grain and surface roughness to child content | 1 | 1.1 | 3.6 |
| ParticleField | 子 态 指 | Explodes the child content into a breathing 3D field of particles — bright areas float toward you and dark areas recede, the whole relief can be orbited with… | 2 | 1.3 | 2.0 |
| Pixelate | 子 | Pixelation effect with adjustable cell size | 1 | 1.2 | 1.8 |
| ReflectivePlane | 子 | Reflective floor that mirrors the content above it | 1 | 1.3 | 1.8 |
| Sparkle | 子 | Twinkling star glints over the bright parts of the layer inside | 1 | 1.3 | 2.1 |
| Stone | 子 | Applies a marbled stone relief and surface distortion to child content | 1 | 1.2 | 2.5 |
| TimeTrail | 子 态 | An Echo-style temporal trail — whatever moves sheds a smooth, decaying long-exposure ghost trail (frame-difference Motion mode works on opaque images and vid… | 1 | 1.2 | 1.6 |
| VHS | 子 | Analog VHS tape with intermittent tape damage, chroma bleed, and per-scanline noise | 1 | 1.1 | 1.7 |
| Vignette | 子 | Darkens or tints the edges of the frame, drawing attention toward the center | 1 | 1.1 | 1.4 |
| Watercolor | 子 | Painterly watercolor look — Kuwahara flattening, pigment edge darkening, paper grain and bleeding | 1 | 1.1 | 2.3 |
| Wool | 子 | Applies an interwoven fibrous fabric texture and distortion to child content | 1 | 1.4 | 3.3 |

## Textures（56）

| 组件 | 标记 | 说明 | 对照 | ms 1080p | ms 4K |
|---|---|---|---|---|---|
| Aurora |  | Mesmerizing aurora borealis with layered curtains, vertical rays, and flowing light. | 2 | 0.6 | 2.0 |
| Beam |  | A beam of light from one point to another. | 2 | 0.3 | 0.6 |
| Blob |  | Organic animated blob with 3D lighting and gradients | 2 | 0.3 | 0.7 |
| BlockNoise |  | Blocky value noise with soft cells that morph over time | 1 | 0.3 | 0.7 |
| BlueNoise |  | High-frequency blue noise — even, grainy speckle ideal for dithering | 1 | 0.3 | 0.7 |
| BrickPattern |  | Classic brick wall pattern with alternating rows and mortar gaps | 1 | 0.3 | 0.6 |
| Checkerboard |  | Classic checkerboard pattern with two alternating colors | 0 | 0.3 | 0.6 |
| Chevron |  | Animated chevron / zigzag stripe pattern | 1 | 0.3 | 0.6 |
| ColorWheel |  | A directional gradient that smoothly cycles through rainbow colors or a custom set of three colors | 1 | 0.3 | 0.6 |
| ConicGradient |  | Colors sweep in a full circle around a center point, like a color wheel | 1 | 0.3 | 0.6 |
| CurlNoise |  | Swirling divergence-free flow field that drifts over time | 1 | 0.5 | 1.2 |
| DiamondGradient |  | Diamond-shaped gradient radiating from a center point using Manhattan distance | 1 | 0.3 | 0.6 |
| DotGrid |  | Grid of dots with optional twinkling animation | 0 | 0.3 | 0.6 |
| EngineTexture |  | Pixels from the engine: the input bound with Sfx.input(source, …) (a render target, a Layer2D, a canvas, an image) | – | 1.2 | 1.5 |
| ErosionNoise |  | Branching, hydraulic-erosion ridges carved into noise | 1 | 0.7 | 2.1 |
| FallingLines |  | Directional falling lines with a leading-to-trailing color fade | 2 | 0.3 | 0.6 |
| FloatingParticles | 态 指 | Drifting, twinkling motes — thousands of real simulated particles floating in a shared heading with per-particle wander and variance, and a cursor that stirs… | 2 | 0.4 | 0.7 |
| FlowingGradient |  | Liquid silk gradient with organic flowing color bands | 1 | 0.7 | 2.4 |
| FractalNoise |  | Multi-octave fractal Brownian motion noise texture with true noise evolution | 1 | 0.7 | 1.6 |
| GaborNoise |  | Oriented sine-grain noise with a fingerprint-like flow | 1 | 0.5 | 0.7 |
| Godrays |  | Volumetric light rays emanating from a point | 2 | 0.6 | 1.0 |
| Grid |  | Simple grid lines pattern with adjustable thickness and rotation | 0 | 0.5 | 0.6 |
| HexGrid |  | Honeycomb hexagonal grid pattern | 1 | 0.5 | 0.6 |
| HTMLInCanvas | 实 | Render live HTML/DOM content as a WebGPU texture layer via the html-in-canvas API. | – | – | – |
| ImageTexture |  | Display an image with customizable object-fit modes | 0 | 0.5 | 0.7 |
| IsometricCubes |  | Isometric tumbling-blocks tiling — a 3D cube illusion (rhombille pattern) | 1 | 0.3 | 0.7 |
| LinearGradient |  | Create smooth linear color gradients | 1 | 0.3 | 0.6 |
| Marble |  | Classic marble swirl and vein texture using noise-warped sine waves | 1 | 0.4 | 1.1 |
| MeshGradient |  | Flowing mesh gradient of soft drifting color swaths whose seams wrap through the palette | 1 | 0.9 | 2.5 |
| MultiPointGradient |  | Five individually placed color points blended together by proximity — drag each point to shape the gradient | 1 | 0.5 | 0.7 |
| PerlinNoise |  | Smooth gradient noise that morphs over time | 1 | 0.4 | 1.0 |
| Plasma |  | Animated effect of glowing plasma | 1 | 0.8 | 2.1 |
| Prism |  | A beam of light that fans out and splits into a slowly-rotating rainbow past a controllable point. | 2 | 0.5 | 0.6 |
| RadialGradient |  | Radial gradient radiating from a center point | 1 | 0.5 | 0.6 |
| Ripples |  | Concentric animated ripples emanating from a point | 0 | 0.5 | 0.6 |
| Satin |  | Flowing satin — a draped cloth of soft rippling folds lit like real fabric: a highlight streaked along the weave, a velvet sheen on the fold flanks and creas… | 1 | 0.9 | 2.4 |
| Scratches |  | Fine hairline scratches, like a worn film or scratched surface | 1 | 0.6 | 1.1 |
| SimplexNoise |  | Organic noise with animated movement | 1 | 0.5 | 0.8 |
| SineWave |  | Animated wave with thickness and softness | 2 | 0.5 | 0.6 |
| SolidColor |  | Fill the canvas with a single solid color | 0 | 0.5 | 0.6 |
| Spiral |  | Rotating spiral pattern with animated movement | 1 | 0.5 | 0.6 |
| Strands |  | Flowing ribbons of light with a multi-color gradient | 2 | 0.9 | 3.2 |
| Stripes |  | Alternating colored stripes with animation | 1 | 0.3 | 0.6 |
| StudioBackground |  | Multi-light studio background with ambient motion. | 1 | 0.4 | 0.8 |
| SunBurst |  | Radial sunburst rays emanating from a center point | 1 | 0.3 | 0.6 |
| Swirl |  | Flowing swirl pattern with multi-layered noise | 1 | 0.5 | 0.7 |
| Text |  | Text with any Google font — multi-line with wrapping, alignment and line height — rendered crisp via a glyph texture | 1 | 0.5 | 0.9 |
| TriangularGrid |  | Tiling grid of equilateral triangles with optional animated row offsets | 1 | 0.3 | 0.6 |
| Truchet |  | Quarter-circle arc tiles that connect to form organic, maze-like flowing curves | 1 | 0.3 | 0.6 |
| VideoTexture | 实 | Display a video with customizable playback and object-fit modes | – | – | – |
| Voronoi |  | Cellular pattern where each pixel is colored by its distance to the nearest of many scattered points | 1 | 0.4 | 1.0 |
| Waveform |  | Audio-visualizer waveform — equalizer bars, a filled wave, an oscilloscope line, or a dot matrix — driven by a simulated signal whose amplitude you can map t… | 2 | 0.5 | 0.8 |
| WaveletNoise |  | Rotating banded wavelets that ripple as they animate | 1 | 0.5 | 0.8 |
| Weave |  | Interlaced textile weave pattern with two thread colors going over and under each other | 0 | 0.5 | 0.7 |
| WebcamTexture | 实 | Display a live webcam feed with customizable object-fit modes | – | – | – |
| WorleyNoise |  | Cellular noise field — distance-based, with selectable feature combinations and fractal octaves | 1 | 0.8 | 1.9 |

## Transitions（13）

| 组件 | 标记 | 说明 | 对照 | ms 1080p | ms 4K |
|---|---|---|---|---|---|
| BarnDoors | 子 | Split the content along a center line and wipe outward in both directions | 2 | 1.3 | 1.5 |
| BlockDissolve | 子 | Dissolve the content away as a grid of blocks vanishing in random order | 1 | 1.1 | 1.5 |
| CheckerWipe | 子 | Wipe the content away as a checkerboard of fading squares | 1 | 1.3 | 1.3 |
| DiamondWipe | 子 | Wipe the content away through a lattice of growing diamonds | 1 | 1.1 | 1.4 |
| IrisWipe | 子 | Reveal through an expanding circle growing from a center point | 2 | 1.1 | 1.3 |
| LinearWipe | 子 | Wipe the content away along a straight edge with a soft feathered transition | 1 | 1.2 | 1.3 |
| NoiseDissolve | 子 | Dissolve the content away through an organic noise pattern | 2 | 1.1 | 1.7 |
| PagePeel | 子 | Curl the content up from a corner like a peeling page | 1 | 1.2 | 1.7 |
| RadialWipe | 子 | Sweep the content away in a clock-hand arc around a center point | 2 | 1.1 | 1.4 |
| RandomBars | 子 | Wipe the content away as parallel bars vanishing in random order | 1 | 1.2 | 1.3 |
| RippleWipe | 子 | Wipe the content away in concentric rings pulsing out from a center point | 1 | 1.1 | 1.4 |
| SliceWipe | 子 | Slice the content into strips that slide away in alternating directions | 1 | 1.2 | 1.3 |
| VenetianBlinds | 子 | Wipe the content away behind a set of parallel closing strips | 2 | 1.1 | 1.3 |

## Utilities（1）

| 组件 | 标记 | 说明 | 对照 | ms 1080p | ms 4K |
|---|---|---|---|---|---|
| Group | 子 | Container for organizing and composing child effects — supports flex-like flow layout (column/row stacking via the flow prop) | 0 | 1.2 | 1.3 |

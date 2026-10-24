# Blender 镜头

Blender 渲序列帧给引擎当画面（`app/src/library/kit/plate.ts`）。用法在各文件开头：

| 文件 | 做什么 |
|---|---|
| `render.py` | 驱动：镜头表（shots 模块）→ 每帧快门开、中、关打关键帧 → 按歌曲帧号出 EXR / PNG、`cam.json`、`frames.json`，断点续渲；`--still` 看图 |
| `lib.py` | 渲染设置、材质、几何、灯光相机、缓动；`held_keys`（节点插槽按帧换值）、`drive_time`（节点插槽随时间走）、`smooth_range`（Map Range 平滑映射）、`studio_strips`（只给反射看的影棚灯带） |
| `shots_example.py` | 示例镜头 `drop` |
| `cam_project.py` | 按渲染的相机（`cam.json`）把 3D 点投到画面上：每帧的屏幕位置和视半径，`--check` 在序列帧上画绿圈核对（普通 Python） |

```bash
"E:/Program Files/Steam/steamapps/common/Blender/blender.exe" -b --factory-startup -P tools/blender/render.py -- --shots shots_example --shot drop --still 3.2
```

## 坑（Blender 5.x + Cycles，If The Sun Burns Out 踩过）

1. **切点被运动模糊拖糊。** 关键帧只打在整数帧上时，Cycles 在快门内对相邻两帧线性插值；镜头里在第 n 帧硬切（换机位、换物体），快门的前半就会插值到上一机位，切点那帧糊成两个画面。`render.py` 现在在每帧的快门开、中、关（f − h、f、f + h，h = 快门 / 2）各打一个关键帧；镜头的 `at(S, t)` 要按 `lib.frame_of(t, fps)`（这一帧自己的画面）判断切点，快门内的子帧时刻就判到同一边。
2. **节点插槽的关键帧是 Bezier。** 给材质 / world 节点插槽 `keyframe_insert` 时，Blender 5 不认 `preferences.edit.keyframe_new_interpolation_type`（`clear_scene` 设的 LINEAR 也没用），插出来是 Bezier：值从第 0 帧起就在慢慢往下一个关键帧滑（金杯反射的天空提前好几秒变暗）。用 `lib.held_keys(插槽, [(帧, 值), …])`：插完到 action 的 F 曲线上改成 CONSTANT（5.x 是分层 action：`action.layers[].strips[].channelbags[].fcurves`，旧版 `action.fcurves`），每个值从前半帧起保持，整段快门看到同一个值。
3. **Map Range 的 SMOOTHSTEP 不能反着写。** Cycles 里 From Min 必须小于 From Max，反过来整段输出 0，不报错。要反向就交换 To Min / To Max，不要交换 From；`lib.smooth_range(N, L, 值, a, b, lo, hi)` 自动处理。
4. **金属要映出东西才像金属。** 一整片亮天空（`studio_world`）映在金属上是一片白，像塑料。`lib.studio_strips()`：一圈只在反射里看得见的竖条灯带（宽窄、亮度不一，中间留黑，可整圈转、可按帧换色降亮），Light Path 的 Is Glossy Ray 分流，相机和漫反射看到黑。**要设 `world.cycles.sampling_method = 'NONE'`**：Cycles 按非光泽射线建 world 的重要性图，这里全黑，不关就把灯带当成没有光，反射里全是噪点。灯带只管反射，照亮物体靠灯。
5. **发光体在调色里被压平。** 合成器的色调映射（Khronos PBR Neutral、AgX）和引擎的高光压缩会把很亮的发光体压回去：核心发光从 4.5 加到 8，屏幕上的峰值不变（约 210），只是更白更粉。很亮的饱和橙往白走时会变成三文鱼粉——发光色带的中间调取偏黄的橙（#D8761E / #FFBE48、#F09A22 / #FFC850）。要它是全画面最亮的点，在引擎合成里补：`cam_project.py` 按渲染相机把它投到画面上（每帧位置和视半径），场景在那里用滤色叠光晕和芯（2.2 倍视半径、0.35），满屏特写时减弱。
6. **材质里的数随时间走。** 驱动器表达式里的 `frame` 含运动模糊的子帧：`lib.drive_time(插槽, 每秒多少)` 写成 `offset + frame / fps × rate`，不用 Python 驱动（`--factory-startup` 下 Python 驱动不自动运行）。

`cam.json` 的四元数是 `[x, y, z, w]`（`render.py` 的 `write_camjson`，`kit/plate.ts` 也按这个读），`fov` 是竖直视角（度），相机朝自己的 −Z 看、+Y 朝上。

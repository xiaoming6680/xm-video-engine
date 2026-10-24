# Blender 小工具：渲染设置、材质、带倒角的基本体、灯、相机、缓动，加上读引擎数据（拍、小节、歌词行）和逐帧烘关键帧。
# render.py 和各个 shots 模块共用；只在 Blender 自带的 Python 里跑（bpy）。
# 单位米，Z 轴向上。颜色写 sRGB 十六进制，进 Blender 前转线性。
# 提炼自 world.excute(me) 的 blender/lib.py；灯光和质感的做法参考 mg-styles-15（MIT）的 demos/04-3d-render。
import bpy, bmesh, math, os, json
from mathutils import Vector, Matrix, Euler, Quaternion

HERE = os.path.dirname(os.path.abspath(__file__))


def find_root(arg=None):
    """项目根目录：参数 > 当前目录（有 data/audio.json）> 这个文件往上两级（tools/blender/ 所在的仓库）。"""
    if arg:
        return os.path.abspath(arg)
    if os.path.exists(os.path.join(os.getcwd(), 'data', 'audio.json')):
        return os.getcwd()
    return os.path.dirname(os.path.dirname(HERE))


ROOT = find_root()


def set_root(path):
    global ROOT
    ROOT = find_root(path)
    return ROOT


def hexlin(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]


def rgba(h, a=1.0):
    return (*hexlin(h), a)


# ------------------------------------------------------------------ 引擎数据：拍、小节、歌词行
class Project:
    """读项目的 data/audio.json（beats、downbeats、sections、bpm）、data/events.json、data/lyrics.json（只用时间）。"""

    def __init__(self, root=None):
        self.root = find_root(root) if root else ROOT
        self.audio = self._json('data', 'audio.json') or {}
        self.beats = self.audio.get('beats', [])
        self.downbeats = self.audio.get('downbeats', [])
        self.sections = self.audio.get('sections', [])
        self.bpm = self.audio.get('bpm', 120.0)
        self.duration = self.audio.get('duration', 0.0)
        self.events_ = (self._json('data', 'events.json') or {}).get('events', [])
        self.lines = (self._json('data', 'lyrics.json') or {}).get('lines', [])

    def _json(self, *p):
        path = os.path.join(self.root, *p)
        if not os.path.exists(path):
            return None
        with open(path, encoding='utf-8') as fh:
            return json.load(fh)

    def path(self, *p):
        return os.path.join(self.root, *p)

    def beat(self, i):
        """第 i 拍的时间（超出分析范围按 bpm 外推）。"""
        b = self.beats
        if 0 <= i < len(b):
            return b[i]
        sp = 60.0 / self.bpm
        return (b[-1] + (i - len(b) + 1) * sp) if b and i >= 0 else i * sp

    def bar(self, k):
        """第 k 小节（强拍）的时间。"""
        d = self.downbeats
        if 0 <= k < len(d):
            return d[k]
        sp = 240.0 / self.bpm
        return (d[-1] + (k - len(d) + 1) * sp) if d and k >= 0 else k * sp

    def beats_in(self, t0, t1):
        return [b for b in self.beats if t0 <= b < t1]

    def nearest_beat(self, t):
        return min(self.beats, key=lambda b: abs(b - t)) if self.beats else t

    def events(self, kind, t0=-1e9, t1=1e9):
        """声音事件（kick / snare / hat / vocal …）在 [t0, t1) 里的时间。"""
        return [e['t'] for e in self.events_ if e.get('type') == kind and t0 <= e['t'] < t1]

    def line(self, i):
        """第 i 行歌词的 (开始, 结束)；只取时间，不碰歌词原文。"""
        ln = self.lines[i]
        return ln['start'], ln['end']

    def section(self, name):
        s = next(x for x in self.sections if x.get('name') == name)
        return s['start'], s['end']


# ------------------------------------------------------------------ 歌曲时间 ↔ 帧号
def frame_of(t, fps=60):
    """歌曲时间 → 帧号（四舍五入：第 n 帧在 n / fps 秒，和引擎导出一致）。"""
    return int(math.floor(t * fps + 0.5))


def time_of(f, fps=60):
    return f / fps


# ------------------------------------------------------------------ 渲染设置
# 显示变换在合成器里做（场景线性 → 色调映射 → 再解回线性），颜色管理用 Standard：
# 这样 PNG 是映射后的画面，EXR 存的是映射后画面的线性值（半浮点，引擎 plate.ts 当线性读、自己转 sRGB），两者看起来一样，
# 而 EXR 不会像 8 位 PNG 那样在后期调色时出色带。
TONE = {'Khronos PBR Neutral': 'Khronos PBR Neutral sRGB', 'AgX': 'AgX Base sRGB', 'Filmic': 'Filmic sRGB', 'Standard': 'sRGB'}


def pick_device(want=None):
    """GPU：OPTIX > CUDA > CPU（环境变量 BLENDER_DEVICE 可指定）。"""
    want = want or os.environ.get('BLENDER_DEVICE')
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for dev in ([want] if want else ['OPTIX', 'CUDA', 'HIP', 'METAL', 'ONEAPI']):
        try:
            prefs.compute_device_type = dev
        except TypeError:
            continue
        prefs.get_devices()
        hits = [d for d in prefs.devices if d.type == dev]
        if hits:
            for d in prefs.devices:
                d.use = d.type == dev
            bpy.context.scene.cycles.device = 'GPU'
            return dev
    bpy.context.scene.cycles.device = 'CPU'
    return 'CPU'


def setup_render(fps=60, res=(1920, 1080), pct=100, samples=128, threshold=0.01, min_samples=32, transparent=False,
                 mblur=True, shutter=0.5, view='Khronos PBR Neutral', exposure=0.0, denoise=True, device=None, haze=None):
    """Cycles + GPU + OIDN（带反照率和法线，ACCURATE 预滤波：比只给 RGB 的逐帧去噪稳，不容易闪）。
    运动模糊快门按帧算，0.5 = 半帧、以这一帧为中心（和引擎导出的默认 --shutter 0.5 一致）。"""
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    dev = pick_device(device)
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = pct
    sc.render.fps = fps
    cy = sc.cycles
    cy.samples = samples
    cy.use_adaptive_sampling = True
    cy.adaptive_threshold = threshold
    cy.adaptive_min_samples = min_samples
    cy.use_denoising = denoise
    if denoise:
        cy.denoiser = 'OPENIMAGEDENOISE'
        cy.denoising_input_passes = 'RGB_ALBEDO_NORMAL'
        cy.denoising_prefilter = 'ACCURATE'
        for k, v in (('denoising_quality', 'HIGH'), ('denoising_use_gpu', dev != 'CPU')):
            try:
                setattr(cy, k, v)
            except (AttributeError, TypeError):
                pass
    # 种子随帧变：固定种子在镜头移动时像糊在镜头上的脏点；采样够了逐帧变化的残余噪声看不出来
    cy.use_animated_seed = True
    cy.max_bounces = 8
    cy.diffuse_bounces = 3
    cy.glossy_bounces = 4
    cy.transmission_bounces = 8
    cy.transparent_max_bounces = 8
    cy.volume_bounces = 0
    cy.caustics_reflective = False
    cy.caustics_refractive = False
    cy.sample_clamp_indirect = 6.0
    cy.blur_glossy = 0.8
    cy.filter_width = 1.5
    sc.render.film_transparent = transparent
    sc.render.use_motion_blur = mblur
    sc.render.motion_blur_shutter = shutter
    sc.render.motion_blur_position = 'CENTER'
    sc.render.dither_intensity = 1.0
    sc.render.use_persistent_data = True
    sc.display_settings.display_device = 'sRGB'
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    sc.view_settings.exposure = 0.0
    sc.view_settings.gamma = 1.0
    tone_compositor(sc, view, exposure, haze)
    out_png(sc)
    return sc


def tone_compositor(sc, view='Khronos PBR Neutral', exposure=0.0, haze=None):
    """合成器：渲染层 → 曝光 →（深度雾）→ 色调映射（view 的 sRGB 色彩空间）→ 解回线性 → 输出。返回曝光节点（逐帧改 set_exposure）。
    深度雾用 mist 通道（world.mist_settings 的 start / depth，线性衰减）：color 是曝光之后的线性颜色（十六进制按 sRGB 转），
    amount 是最远处的雾的比例。"""
    cg = bpy.data.node_groups.new('tone', 'CompositorNodeTree')
    sc.compositing_node_group = cg
    cg.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
    N, L = cg.nodes, cg.links
    rl = N.new('CompositorNodeRLayers')
    ex = N.new('CompositorNodeExposure')
    ex.name = 'exposure'
    ex.inputs['Exposure'].default_value = exposure
    a = N.new('CompositorNodeConvertColorSpace')
    a.from_color_space, a.to_color_space = 'scene_linear', TONE[view]
    b = N.new('CompositorNodeConvertColorSpace')
    b.from_color_space, b.to_color_space = 'sRGB', 'scene_linear'
    go = N.new('NodeGroupOutput')
    L.new(rl.outputs['Image'], ex.inputs['Image'])
    src = ex.outputs['Image']
    if haze:
        sc.view_layers[0].use_pass_mist = True
        w = sc.world or bpy.data.worlds.new('world')
        sc.world = w
        w.mist_settings.start = haze.get('start', 10.0)
        w.mist_settings.depth = haze.get('depth', 15.0)
        w.mist_settings.falloff = 'LINEAR'
        k = N.new('ShaderNodeMath')
        k.operation = 'MULTIPLY'
        k.use_clamp = True
        k.inputs[1].default_value = haze.get('amount', 1.0)
        L.new(rl.outputs['Mist'], k.inputs[0])
        mx = N.new('ShaderNodeMix')
        mx.data_type = 'RGBA'
        mx.clamp_factor = True
        mx.inputs['B'].default_value = rgba(haze.get('color', '#FFFFFF'))
        L.new(k.outputs[0], mx.inputs['Factor'])
        L.new(src, mx.inputs['A'])
        src = mx.outputs['Result']
    L.new(src, a.inputs['Image'])
    L.new(a.outputs['Image'], b.inputs['Image'])
    L.new(b.outputs['Image'], go.inputs['Image'])
    sc.render.use_compositing = True
    return ex


def set_exposure(ev):
    cg = bpy.context.scene.compositing_node_group
    if cg and 'exposure' in cg.nodes:
        cg.nodes['exposure'].inputs['Exposure'].default_value = ev


def out_png(sc, depth='8'):
    """8 位 PNG 带抖动（看图、预览用）；16 位进浏览器也会被解成 8 位，给引擎用 EXR。"""
    s = sc.render.image_settings
    s.file_format = 'PNG'
    s.color_mode = 'RGBA' if sc.render.film_transparent else 'RGB'
    s.color_depth = depth
    s.compression = 15


def out_exr(sc, codec='ZIP'):
    """半浮点 EXR（无损 ZIP，引擎的 EXRLoader 解得快；要小一点用 DWAA，有损）。"""
    s = sc.render.image_settings
    s.file_format = 'OPEN_EXR'
    s.color_mode = 'RGBA' if sc.render.film_transparent else 'RGB'
    s.color_depth = '16'
    s.exr_codec = codec


def save_result(path, kind='png', codec='ZIP'):
    """把刚渲完的结果存成 png / exr（先写临时文件再改名：中途被杀不会留下半张图）。"""
    sc = bpy.context.scene
    out_exr(sc, codec) if kind == 'exr' else out_png(sc)
    tmp = path + '.tmp.' + kind
    bpy.data.images['Render Result'].save_render(tmp, scene=sc)
    os.replace(tmp, path)


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    import addon_utils
    addon_utils.enable('cycles', default_set=True)
    bpy.context.preferences.edit.keyframe_new_interpolation_type = 'LINEAR'


# ------------------------------------------------------------------ 材质
def new_mat(name):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True  # (5.x 起材质总是用节点，这个属性只为兼容旧版)
    except AttributeError:
        pass
    return m


def principled(name, base='#FFFFFF', rough=0.5, metal=0.0, trans=0.0, ior=1.45, coat=0.0, coat_rough=0.05,
               emit=None, es=0.0, alpha=1.0, sheen=0.0, sss=0.0, spec=0.5, sss_radius=None, sss_scale=None):
    m = new_mat(name)
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = rgba(base) if isinstance(base, str) else base
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    b.inputs['IOR'].default_value = ior
    b.inputs['Transmission Weight'].default_value = trans
    b.inputs['Coat Weight'].default_value = coat
    b.inputs['Coat Roughness'].default_value = coat_rough
    b.inputs['Sheen Weight'].default_value = sheen
    b.inputs['Subsurface Weight'].default_value = sss
    if sss_radius:
        b.inputs['Subsurface Radius'].default_value = sss_radius
    if sss_scale:
        b.inputs['Subsurface Scale'].default_value = sss_scale
    b.inputs['Specular IOR Level'].default_value = spec
    if emit:
        b.inputs['Emission Color'].default_value = rgba(emit)
        b.inputs['Emission Strength'].default_value = es
    b.inputs['Alpha'].default_value = alpha
    return m


def nodes(m):
    return m.node_tree.nodes, m.node_tree.links, next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')


def smooth_range(N, L, value, a, b, lo=0.0, hi=1.0):
    """Map Range（SMOOTHSTEP）：value 在 a 时是 lo、在 b 时是 hi，中间平滑过渡，返回输出插槽。value 是插槽或数。
    Cycles 的 SMOOTHSTEP 要 From Min < From Max，反过来（a > b）整段输出 0、不报错；所以 a > b 时这里交换 From 和 To，
    自己写 Map Range 要反向时也一样：换 To Min / To Max，不要换 From。"""
    if a > b:
        a, b, lo, hi = b, a, hi, lo
    mr = N.new('ShaderNodeMapRange')
    mr.interpolation_type = 'SMOOTHSTEP'
    mr.inputs['From Min'].default_value, mr.inputs['From Max'].default_value = a, b
    mr.inputs['To Min'].default_value, mr.inputs['To Max'].default_value = lo, hi
    if isinstance(value, (int, float)):
        mr.inputs['Value'].default_value = value
    else:
        L.new(value, mr.inputs['Value'])
    return mr.outputs['Result']


def add_rough_noise(m, lo, hi, scale=40.0, detail=6.0, coord='Object', bump=0.0, vec_scale=(1, 1, 1)):
    """粗糙度用噪声在 lo..hi 间变化（指纹、磨损、灰），可选一点凹凸。"""
    N, L, b = nodes(m)
    tc = N.new('ShaderNodeTexCoord')
    mp = N.new('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = vec_scale
    nz = N.new('ShaderNodeTexNoise')
    nz.inputs['Scale'].default_value = scale
    nz.inputs['Detail'].default_value = detail
    mr = N.new('ShaderNodeMapRange')
    mr.inputs['To Min'].default_value = lo
    mr.inputs['To Max'].default_value = hi
    L.new(tc.outputs[coord], mp.inputs['Vector'])
    L.new(mp.outputs['Vector'], nz.inputs['Vector'])
    L.new(nz.outputs['Fac'], mr.inputs['Value'])
    L.new(mr.outputs['Result'], b.inputs['Roughness'])
    if bump > 0:
        bp = N.new('ShaderNodeBump')
        bp.inputs['Strength'].default_value = bump
        L.new(nz.outputs['Fac'], bp.inputs['Height'])
        L.new(bp.outputs['Normal'], b.inputs['Normal'])
    return m


def add_ao(m, distance=0.2, amount=0.55, samples=8):
    """接触处压暗底色（AO 乘进 Base Color）：小球缝、物体落地处有分量。只接在没连别的节点的底色上。"""
    N, L, b = nodes(m)
    ao = N.new('ShaderNodeAmbientOcclusion')
    ao.samples = samples
    ao.inputs['Distance'].default_value = distance
    mx = N.new('ShaderNodeMix')
    mx.data_type = 'RGBA'
    mx.blend_type = 'MULTIPLY'
    mx.inputs['Factor'].default_value = amount
    mx.inputs['A'].default_value = tuple(b.inputs['Base Color'].default_value)
    L.new(ao.outputs['AO'], mx.inputs['B'])
    L.new(mx.outputs['Result'], b.inputs['Base Color'])
    return m


def gummy(name, base='#FF4F6E', rough=0.16, coat=0.5, radius=(1.0, 0.35, 0.3), scale=0.12):
    """软糖：次表面散射 + 一层清漆（参考 04-3d-render 的 gummy）。"""
    m = principled(name, base, rough, coat=coat, coat_rough=0.04, sss=1.0, sss_radius=radius, sss_scale=scale, spec=0.55)
    nodes(m)[2].subsurface_method = 'BURLEY'
    return m


def chrome(name='chrome', base='#F4F3F6', rough=0.045):
    return principled(name, base, rough, metal=1.0)


def candy(name, base='#F2E8DC', rough=0.32, coat=1.0, spec=0.5):
    """糖衣塑料：底层稍粗、外面一层亮清漆。"""
    return principled(name, base, rough, coat=coat, coat_rough=0.06, spec=spec)


def wood(name, light='#C9A57A', dark='#9C7448', rough=0.45, scale=3.0, stretch=(1, 8, 1)):
    """浅色木纹贴面：拉长的波纹 + 噪声扰动。"""
    m = principled(name, light, rough)
    N, L, b = nodes(m)
    tc = N.new('ShaderNodeTexCoord')
    mp = N.new('ShaderNodeMapping')
    mp.inputs['Scale'].default_value = stretch
    wv = N.new('ShaderNodeTexWave')
    wv.wave_type = 'BANDS'
    wv.inputs['Scale'].default_value = scale
    wv.inputs['Distortion'].default_value = 6.0
    wv.inputs['Detail'].default_value = 4.0
    wv.inputs['Detail Scale'].default_value = 1.5
    ramp = N.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].color = rgba(dark)
    ramp.color_ramp.elements[1].color = rgba(light)
    ramp.color_ramp.elements[0].position = 0.25
    L.new(tc.outputs['Object'], mp.inputs['Vector'])
    L.new(mp.outputs['Vector'], wv.inputs['Vector'])
    L.new(wv.outputs['Fac'], ramp.inputs['Fac'])
    L.new(ramp.outputs['Color'], b.inputs['Base Color'])
    return m


def image_mat(name, path, emission=0.0, rough=0.4, alpha=False, coat=0.0, interp='Linear', extension='CLIP',
              sequence=None, base_dark=None):
    """贴图材质。emission > 0 时图同时当发光（屏幕）；sequence=(frame_start, frame_count, offset) 用序列帧。"""
    m = principled(name, '#FFFFFF', rough, coat=coat)
    N, L, b = nodes(m)
    tx = N.new('ShaderNodeTexImage')
    img = bpy.data.images.load(path, check_existing=True)
    if sequence:
        img.source = 'SEQUENCE'
        tx.image_user.frame_start, tx.image_user.frame_duration, tx.image_user.frame_offset = sequence
        tx.image_user.use_auto_refresh = True
    tx.image = img
    tx.interpolation = interp
    tx.extension = extension
    if base_dark:
        b.inputs['Base Color'].default_value = rgba(base_dark)
    else:
        L.new(tx.outputs['Color'], b.inputs['Base Color'])
    if emission > 0:
        L.new(tx.outputs['Color'], b.inputs['Emission Color'])
        b.inputs['Emission Strength'].default_value = emission
    if alpha:
        L.new(tx.outputs['Alpha'], b.inputs['Alpha'])
    return m, tx


def emission_mat(name, color, strength=1.0):
    m = new_mat(name)
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = rgba(color)
    em.inputs['Strength'].default_value = strength
    o = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(em.outputs[0], o.inputs['Surface'])
    m.cycles.emission_sampling = 'NONE'
    return m


# ------------------------------------------------------------------ 几何
def link(ob, coll=None):
    (coll or bpy.context.scene.collection).objects.link(ob)
    return ob


def mesh_from_bm(name, bm, mats=()):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for mt in mats:
        me.materials.append(mt)
    return link(bpy.data.objects.new(name, me))


def bevel(ob, width, segments=3, limit='ANGLE'):
    md = ob.modifiers.new('bevel', 'BEVEL')
    md.width = width
    md.segments = segments
    md.limit_method = limit
    md.harden_normals = False
    return md


def smooth(ob, angle=40):
    for p in ob.data.polygons:
        p.use_smooth = True
    try:
        ob.modifiers.new('ws', 'WEIGHTED_NORMAL')
    except Exception:
        pass
    return ob


def box(name, size, loc=(0, 0, 0), mat=None, bev=0.0, seg=3, rot=(0, 0, 0), parent=None):
    """size = (x, y, z) 全尺寸，loc = 中心。"""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    ob = mesh_from_bm(name, bm, [mat] if mat else [])
    ob.location = loc
    ob.rotation_euler = rot
    if bev > 0:
        bevel(ob, bev, seg)
        smooth(ob)
    if parent:
        ob.parent = parent
    return ob


def cyl(name, r, h, loc=(0, 0, 0), mat=None, verts=48, rot=(0, 0, 0), bev=0.0, seg=3, r2=None, parent=None):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=verts, radius1=r, radius2=r if r2 is None else r2, depth=h)
    ob = mesh_from_bm(name, bm, [mat] if mat else [])
    ob.location = loc
    ob.rotation_euler = rot
    for p in ob.data.polygons:
        p.use_smooth = True
    if bev > 0:
        bevel(ob, bev, seg)
    if parent:
        ob.parent = parent
    return ob


def sphere_mesh(name, r, seg=48, rings=24, mat=None):
    """只建网格（不放进场景）：成百上千个小球共用一份网格。"""
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=r)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    if mat:
        me.materials.append(mat)
    return me


def instance(name, data, loc=(0, 0, 0), scale=1.0, coll=None):
    """共用一份网格的物体（linked duplicate）。"""
    ob = link(bpy.data.objects.new(name, data), coll)
    ob.location = loc
    ob.scale = (scale, scale, scale) if isinstance(scale, (int, float)) else scale
    return ob


def rounded_slab(name, w, h, d, r, loc=(0, 0, 0), mat=None, seg=8, bev=0.0, rot=(0, 0, 0), parent=None):
    """圆角矩形板（手机、立牌底座）：XY 平面上 w×h、圆角 r，沿 Z 厚 d，底面在 z=0。"""
    bm = bmesh.new()
    pts = []
    for cx, cy, a0 in ((w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90), (-w / 2 + r, -h / 2 + r, 180), (w / 2 - r, -h / 2 + r, 270)):
        for k in range(seg + 1):
            a = math.radians(a0 + 90 * k / seg)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    vs = [bm.verts.new((x, y, 0)) for x, y in pts]
    f = bm.faces.new(vs)
    ext = bmesh.ops.extrude_face_region(bm, geom=[f])
    top = [e for e in ext['geom'] if isinstance(e, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, vec=(0, 0, d), verts=top)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = mesh_from_bm(name, bm, [mat] if mat else [])
    ob.location = loc
    ob.rotation_euler = rot
    if bev > 0:
        bevel(ob, bev, 3)
    smooth(ob)
    if parent:
        ob.parent = parent
    return ob


def plane(name, w, h, loc=(0, 0, 0), mat=None, rot=(0, 0, 0), parent=None):
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=0.5)
    bmesh.ops.scale(bm, vec=Vector((w, h, 1)), verts=bm.verts)
    ob = mesh_from_bm(name, bm, [mat] if mat else [])
    # UV 0..1
    ob.data.uv_layers.new(name='UVMap')
    uv = ob.data.uv_layers['UVMap'].data
    for poly in ob.data.polygons:
        for li in poly.loop_indices:
            v = ob.data.vertices[ob.data.loops[li].vertex_index].co
            uv[li].uv = (v.x / w + 0.5, v.y / h + 0.5)
    ob.location = loc
    ob.rotation_euler = rot
    if parent:
        ob.parent = parent
    return ob


def cyc(name, mat=None, width=80.0, y_near=-30.0, y_wall=14.0, radius=5.0, top=30.0, z=0.0):
    """无缝影棚背景：地面沿 +Y 延伸，在 y_wall 处以半径 radius 弯成竖墙（看不到地平线和墙角）。"""
    prof = [(y, z) for y in [y_near + (y_wall - y_near) * i / 40 for i in range(41)]]
    for k in range(1, 28):
        a = (math.pi / 2) * k / 27
        prof.append((y_wall + radius * math.sin(a), z + radius * (1 - math.cos(a))))
    for k in range(1, 10):
        prof.append((y_wall + radius, z + radius + (top - radius) * k / 9))
    xs = [-width / 2 + width * i / 40 for i in range(41)]
    bm = bmesh.new()
    grid = [[bm.verts.new((x, y, zz)) for (y, zz) in prof] for x in xs]
    for i in range(len(xs) - 1):
        for j in range(len(prof) - 1):
            bm.faces.new((grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]))
    ob = mesh_from_bm(name, bm, [mat] if mat else [])
    for p in ob.data.polygons:
        p.use_smooth = True
    return ob


def text_mesh(name, text, font, size=1.0, extrude=0.1, bevel_depth=0.06, offset=None, res=6, mat=None, stand=True,
              remesh=0.0, smooth_iter=0):
    """字 → 网格物体，原点在底边中心。stand=True 时立起来（字面朝 −Y，字头朝 +Z，看的人在 −Y 那边）。
    圆角字母：倒角接近笔画半宽、offset 取负的倒角（外轮廓不变胖），笔画截面就接近圆管；remesh > 0 再体素重建 + 平滑，鼓一点。"""
    cu = bpy.data.curves.new(name + '_cu', 'FONT')
    cu.body = text
    cu.font = bpy.data.fonts.load(font, check_existing=True)
    cu.size = size
    cu.extrude = extrude
    cu.bevel_depth = bevel_depth
    cu.bevel_resolution = res
    cu.offset = -bevel_depth if offset is None else offset
    cu.resolution_u = 24
    tmp = link(bpy.data.objects.new(name + '_tmp', cu))
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(tmp.evaluated_get(dg))
    bpy.data.objects.remove(tmp)
    bpy.data.curves.remove(cu)
    me.name = name
    if stand:
        me.transform(Matrix.Rotation(math.radians(90), 4, 'X'))
    xs = [v.co.x for v in me.vertices]
    ys = [v.co.y for v in me.vertices]
    zs = [v.co.z for v in me.vertices]
    me.transform(Matrix.Translation((-(min(xs) + max(xs)) / 2, -(min(ys) + max(ys)) / 2, -min(zs))))
    ob = link(bpy.data.objects.new(name, me))
    if mat:
        me.materials.append(mat)
    if remesh > 0:
        md = ob.modifiers.new('remesh', 'REMESH')
        md.mode = 'VOXEL'
        md.voxel_size = remesh
        md.use_smooth_shade = True
    if smooth_iter:
        md = ob.modifiers.new('smooth', 'CORRECTIVE_SMOOTH')
        md.iterations = smooth_iter
        md.smooth_type = 'LENGTH_WEIGHTED'
        md.use_only_smooth = True
    for p in me.polygons:
        p.use_smooth = True
    ob['size'] = (max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs))
    return ob


def curve_tube(name, pts, radius, mat=None, res=12, bevel_res=6):
    """穿过一串点的软管（数据线）。"""
    cd = bpy.data.curves.new(name, 'CURVE')
    cd.dimensions = '3D'
    cd.resolution_u = res
    cd.bevel_depth = radius
    cd.bevel_resolution = bevel_res
    sp = cd.splines.new('NURBS')
    sp.points.add(len(pts) - 1)
    for p, c in zip(sp.points, pts):
        p.co = (*c, 1)
    sp.use_endpoint_u = True
    sp.order_u = 4
    ob = link(bpy.data.objects.new(name, cd))
    if mat:
        cd.materials.append(mat)
    return ob


# ------------------------------------------------------------------ 灯和相机
def look_at(ob, target, track='-Z'):
    d = Vector(target) - ob.location
    ob.rotation_euler = d.to_track_quat(track, 'Y').to_euler()


def area(name, loc, target, size, energy, color='#FFFFFF', size_y=None, shape='RECTANGLE', spread=180):
    ld = bpy.data.lights.new(name, 'AREA')
    ld.energy = energy
    ld.color = hexlin(color)
    ld.shape = shape
    ld.size = size
    if size_y:
        ld.size_y = size_y
    ld.spread = math.radians(spread)
    ob = link(bpy.data.objects.new(name, ld))
    ob.location = loc
    look_at(ob, target)
    return ob


def point(name, loc, energy, color='#FFFFFF', radius=0.05):
    ld = bpy.data.lights.new(name, 'POINT')
    ld.energy = energy
    ld.color = hexlin(color)
    ld.shadow_soft_size = radius
    ob = link(bpy.data.objects.new(name, ld))
    ob.location = loc
    return ob


def spot(name, loc, target, energy, color='#FFFFFF', angle=60, blend=0.4, radius=0.03):
    ld = bpy.data.lights.new(name, 'SPOT')
    ld.energy = energy
    ld.color = hexlin(color)
    ld.spot_size = math.radians(angle)
    ld.spot_blend = blend
    ld.shadow_soft_size = radius
    ob = link(bpy.data.objects.new(name, ld))
    ob.location = loc
    look_at(ob, target)
    return ob


def only_glossy(ob):
    """只在反射里出现（不照亮、不投影、相机看不见）：给镀铬和清漆一块可控的亮面 / 暗面。"""
    ob.visible_camera = False
    ob.visible_diffuse = False
    ob.visible_shadow = False
    ob.visible_transmission = False
    ob.visible_volume_scatter = False
    ob.visible_glossy = True
    return ob


def card(name, loc, target, w, h, color, strength=1.0):
    """反射用的发光卡片（亮灯条或压暗的黑旗），只出现在反射里。"""
    me = bpy.data.meshes.new(name)
    me.from_pydata([(-w / 2, -h / 2, 0), (w / 2, -h / 2, 0), (w / 2, h / 2, 0), (-w / 2, h / 2, 0)], [], [(0, 1, 2, 3)])
    me.materials.append(emission_mat(name + '_m', color, strength))
    ob = link(bpy.data.objects.new(name, me))
    ob.location = loc
    look_at(ob, target, 'Z')
    return only_glossy(ob)


def shadow_pair(name, loc, target, energy, blockers, angle=56, blend=0.6, radius=0.4):
    """可控落影（04-3d-render 的做法）：同一位置一正一负两盏聚光，正的只被 blockers 挡、负的不投影，
    其余地方正负相消，只剩 blockers 的影子；energy 随时间变就是影子渐浓（逐帧改 data.energy，两盏一起）。"""
    coll = bpy.data.collections.new(name + '_blockers')
    for ob in blockers:
        coll.objects.link(ob)
    pair = []
    for sgn, shd in ((1.0, True), (-1.0, False)):
        ob = spot(f'{name}_{"pos" if sgn > 0 else "neg"}', loc, target, sgn * energy, angle=angle, blend=blend, radius=radius)
        ob.data.use_shadow = shd
        ob.visible_glossy = False
        ob.visible_transmission = False
        ob.visible_volume_scatter = False
        if shd:
            ob.light_linking.blocker_collection = coll
        pair.append(ob)
    return pair


def camera(name='cam', lens=50, sensor=36, fstop=2.0, focus=None, clip=(0.05, 200)):
    """相机：传感器按宽度算（sensor_fit = HORIZONTAL，cam.json 里的竖直视角按这个换算）。"""
    cd = bpy.data.cameras.new(name)
    cd.lens = lens
    cd.sensor_width = sensor
    cd.sensor_fit = 'HORIZONTAL'
    cd.clip_start, cd.clip_end = clip
    cd.dof.use_dof = True
    cd.dof.aperture_fstop = fstop
    cd.dof.aperture_blades = 7
    cd.dof.aperture_rotation = math.radians(12)
    if focus is not None:
        cd.dof.focus_distance = focus
    ob = link(bpy.data.objects.new(name, cd))
    ob.rotation_mode = 'QUATERNION'
    bpy.context.scene.camera = ob
    return ob


def cam_quat(eye, target, roll=0.0):
    """相机朝向：从 eye 看 target，上方靠 +Z，再绕视线转 roll（弧度）。"""
    q = (Vector(target) - Vector(eye)).to_track_quat('-Z', 'Y')
    if roll:
        q = q @ Quaternion((0, 0, 1), roll)
    return q


def vfov(lens, sensor=36.0, res=(1920, 1080)):
    """竖直视角（度），sensor_fit = HORIZONTAL。"""
    hf = 2 * math.atan(sensor / (2 * lens))
    return math.degrees(2 * math.atan(math.tan(hf / 2) * res[1] / res[0]))


def project(eye, target, lens, p, roll=0.0, sensor=36.0, res=(1920, 1080)):
    """世界点 p 在画面上的位置（0..1，左上为原点）和深度；镜头后面返回 None。"""
    q = cam_quat(eye, target, roll)
    v = q.inverted() @ (Vector(p) - Vector(eye))
    if v.z >= -1e-6:
        return None
    f = lens / sensor  # 焦距 / 传感器宽
    x = 0.5 + f * v.x / -v.z
    y = 0.5 - f * v.y / -v.z * res[0] / res[1]
    return x, y, -v.z


def use_world(w):
    """换场景的 world，保留旧 world 的 mist 设置（深度雾在 setup_render 里设，镜头之后才建 world）。"""
    sc = bpy.context.scene
    old = sc.world
    if old and old != w:
        for k in ('start', 'depth', 'falloff'):
            setattr(w.mist_settings, k, getattr(old.mist_settings, k))
    sc.world = w
    return w


def world_color(color='#000000', strength=1.0):
    sc = bpy.context.scene
    w = bpy.data.worlds.new('world')
    try:
        w.use_nodes = True
    except AttributeError:
        pass
    bg = next(n for n in w.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs['Color'].default_value = rgba(color)
    bg.inputs['Strength'].default_value = strength
    return use_world(w)


def studio_world(ambient='#EADCF0', strength=0.35, sky='#F6E8F1', horizon=0.42, zenith=1.45):
    """影棚环境：漫反射看到一层暗的底色，反射光线看到一片亮的渐变天空（地平线暗、头顶亮）——
    镀铬和清漆就像映着一个大柔光箱，不会反出黑来（04-3d-render 的做法，这里不用 HDRI）。"""
    sc = bpy.context.scene
    w = bpy.data.worlds.new('studio')
    try:
        w.use_nodes = True
    except AttributeError:
        pass
    nt = w.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    N, L = nt.nodes, nt.links
    bg = N.new('ShaderNodeBackground')
    bg.inputs['Color'].default_value = rgba(ambient)
    bg.inputs['Strength'].default_value = strength
    tc = N.new('ShaderNodeTexCoord')
    sp = N.new('ShaderNodeSeparateXYZ')
    L.new(tc.outputs['Generated'], sp.inputs[0])
    mr = N.new('ShaderNodeMapRange')
    mr.interpolation_type = 'SMOOTHSTEP'
    mr.inputs['From Min'].default_value = -0.05
    mr.inputs['From Max'].default_value = 0.75
    mr.inputs['To Min'].default_value = horizon
    mr.inputs['To Max'].default_value = zenith
    L.new(sp.outputs['Z'], mr.inputs['Value'])
    bg2 = N.new('ShaderNodeBackground')
    bg2.inputs['Color'].default_value = rgba(sky)
    L.new(mr.outputs['Result'], bg2.inputs['Strength'])
    lp = N.new('ShaderNodeLightPath')
    mx = N.new('ShaderNodeMixShader')
    L.new(lp.outputs['Is Glossy Ray'], mx.inputs[0])
    L.new(bg.outputs[0], mx.inputs[1])
    L.new(bg2.outputs[0], mx.inputs[2])
    out = N.new('ShaderNodeOutputWorld')
    L.new(mx.outputs[0], out.inputs['Surface'])
    return use_world(w)


# 影棚灯带的默认排布：(方位角 °, 半宽 °, 亮度)，宽窄、亮度各不相同，中间留黑（If The Sun Burns Out 的金杯）
STRIPS = ((0, 6, 3.8), (58, 2.5, 6.4), (128, 11, 2.3), (196, 4, 5.1), (284, 8, 3.2))


def studio_strips(strips=STRIPS, color='#FFD9A8', strength=1.0, spin=0.0, wash=0.35, elev=(-80, -58, 33, 60), at=()):
    """给金属用的影棚灯带 world：只在反射里看得见的一圈竖条灯（相机和漫反射看到黑），金属映出几条亮带、中间是暗，
    比映一整片亮天空（studio_world）更有金属感。
      strips  每条 (方位角 °, 半宽 °, 亮度)：亮度从中心到 0.45 倍半宽是满的，到半宽处平滑落到 0
      spin    整圈每秒转多少度（0 = 不转）：光带一条条扫过金属面（驱动器按帧算，运动模糊照常）
      wash    灯带之间的一层暗底（相对灯带亮度）：金面不至于全黑、保住本色
      elev    仰角带 (起, 满, 满, 止)（°）：从脚下 −80° 渐亮到 −58°，到仰角 33° 后渐暗、60° 以上没有
      at      [(帧, 颜色, 亮度倍数)]：从这一帧起换色、降亮（held_keys，整段快门同一个值），例如熄灯后换冷蓝降到 0.55
    world.cycles.sampling_method 设成 'NONE'：Cycles 按非光泽射线建的重要性图在这里全黑，不关会把它当成没有光，
    反射里的灯带变成噪点。灯带只管反射，照亮物体还得靠灯。"""
    w = bpy.data.worlds.new('strips')
    try:
        w.use_nodes = True
    except AttributeError:
        pass
    nt = w.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    N, L = nt.nodes, nt.links

    def math_node(op, a=None, b=None):
        m = N.new('ShaderNodeMath')
        m.operation = op
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                m.inputs[i].default_value = v
            else:
                L.new(v, m.inputs[i])
        return m.outputs[0]

    tc = N.new('ShaderNodeTexCoord')
    vec = tc.outputs['Generated']                    # world 里 Generated 是视线方向
    if spin:
        rot = N.new('ShaderNodeVectorRotate')
        rot.rotation_type = 'Z_AXIS'
        drive_time(rot.inputs['Angle'], math.radians(spin))
        L.new(vec, rot.inputs['Vector'])
        vec = rot.outputs['Vector']
    sp = N.new('ShaderNodeSeparateXYZ')
    L.new(vec, sp.inputs[0])
    az = math_node('ARCTAN2', sp.outputs['Y'], sp.outputs['X'])
    total = None
    for deg, half, gain in strips:
        wr = N.new('ShaderNodeMath')
        wr.operation = 'WRAP'
        L.new(math_node('SUBTRACT', az, math.radians(deg)), wr.inputs[0])
        wr.inputs[1].default_value, wr.inputs[2].default_value = -math.pi, math.pi
        d = math_node('ABSOLUTE', wr.outputs[0])
        s = smooth_range(N, L, d, math.radians(half), math.radians(half * 0.45), 0.0, gain)
        total = s if total is None else math_node('ADD', total, s)
    sn = [math.sin(math.radians(e)) for e in elev]
    band = math_node('MULTIPLY', smooth_range(N, L, sp.outputs['Z'], sn[0], sn[1], 0.0, 1.0),
                     smooth_range(N, L, sp.outputs['Z'], sn[3], sn[2], 0.0, 1.0))
    lum = math_node('MULTIPLY', band, math_node('ADD', total, wash))
    gain = N.new('ShaderNodeMath')
    gain.operation = 'MULTIPLY'
    L.new(lum, gain.inputs[0])
    bg = N.new('ShaderNodeBackground')
    if at:
        held_keys(gain.inputs[1], [(0, strength)] + [(f, strength * g) for f, _, g in at])
        held_keys(bg.inputs['Color'], [(0, rgba(color))] + [(f, rgba(c)) for f, c, _ in at])
    else:
        gain.inputs[1].default_value = strength
        bg.inputs['Color'].default_value = rgba(color)
    L.new(gain.outputs[0], bg.inputs['Strength'])
    dark = N.new('ShaderNodeBackground')
    dark.inputs['Strength'].default_value = 0.0
    lp = N.new('ShaderNodeLightPath')
    mx = N.new('ShaderNodeMixShader')
    L.new(lp.outputs['Is Glossy Ray'], mx.inputs[0])
    L.new(dark.outputs[0], mx.inputs[1])
    L.new(bg.outputs[0], mx.inputs[2])
    out = N.new('ShaderNodeOutputWorld')
    L.new(mx.outputs[0], out.inputs['Surface'])
    try:
        w.cycles.sampling_method = 'NONE'
    except AttributeError:
        pass
    return use_world(w)


# ------------------------------------------------------------------ 逐帧关键帧（运动模糊要用）
def bake(idb, path, frames, values, index=-1, interp='LINEAR'):
    """给 idb（物体 / 相机数据 / 灯数据）的 path 一次写入整段关键帧：frames[i] 帧的值是 values[i]（数，或每个分量一组）。
    直接写 F 曲线（5.x 的分层动作），几千个物体也快；线性插值，子帧（运动模糊）在相邻两帧间取。"""
    from bpy_extras import anim_utils
    ad = idb.animation_data or idb.animation_data_create()
    if ad.action is None:
        act = bpy.data.actions.new(f'{idb.name}_act')
        ad.action = act
        if ad.action_slot is None:
            ad.action_slot = act.slots.new(id_type=idb.id_type, name=idb.name)
    cb = anim_utils.action_ensure_channelbag_for_slot(ad.action, ad.action_slot)
    vals = list(values)
    comps = len(vals[0]) if hasattr(vals[0], '__len__') else 0
    idxs = range(comps) if comps else [max(index, 0)]
    kind = {'CONSTANT': 0, 'LINEAR': 1, 'BEZIER': 2}[interp]
    for k, ci in enumerate(idxs):
        fc = cb.fcurves.find(path, index=ci) or cb.fcurves.new(path, index=ci)
        fc.keyframe_points.clear()
        n = len(frames)
        fc.keyframe_points.add(n)
        co = [0.0] * (2 * n)
        for i, f in enumerate(frames):
            co[2 * i] = float(f)
            co[2 * i + 1] = float(vals[i][k] if comps else vals[i])
        fc.keyframe_points.foreach_set('co', co)
        fc.keyframe_points.foreach_set('interpolation', [kind] * n)
        fc.update()


def held_keys(sock, keys):
    """材质 / world 节点插槽的值按帧换：keys = [(帧, 值), …]（值是数，或颜色这类一组数），每个值从那一帧前半帧起保持
    （CONSTANT），整段快门看到同一个值，下一个关键帧之前不变。帧号用镜头的 fps（lib.frame_of(t, fps)）。
    坑：Blender 5 给节点插槽 keyframe_insert 时不认 preferences.edit.keyframe_new_interpolation_type（clear_scene 设的
    LINEAR 也没用），插出来是 Bezier——值从第 0 帧起就在慢慢往下一个关键帧滑（金杯反射的天空提前好几秒变暗）。
    所以插完要到 action 的 F 曲线上把插值改成 CONSTANT：5.x 是分层 action（layers → strips → channelbags → fcurves），
    旧版是 action.fcurves。"""
    for f, v in keys:
        sock.default_value = v
        sock.keyframe_insert('default_value', frame=f - 0.5)
    path, act = sock.path_from_id('default_value'), sock.id_data.animation_data.action
    try:
        fcs = list(act.fcurves)
    except AttributeError:
        fcs = [fc for ly in act.layers for st in ly.strips for cb in st.channelbags for fc in cb.fcurves]
    for fc in fcs:
        if fc.data_path == path:
            for k in fc.keyframe_points:
                k.interpolation = 'CONSTANT'
            fc.update()


def drive_time(sock, rate, offset=0.0, fps=None):
    """节点插槽随时间连续走：值 = offset + 歌曲秒 × rate（驱动器表达式按当前帧算，含运动模糊的子帧）。
    fps 默认取场景的（setup_render 设好以后再调）。"""
    sc = bpy.context.scene
    fps = fps or sc.render.fps / sc.render.fps_base
    fc = sock.driver_add('default_value')
    fc.driver.type = 'SCRIPTED'
    fc.driver.expression = f'{offset} + frame / {fps} * {rate}'
    return fc


# ------------------------------------------------------------------ 缓动和插值
def clamp01(x):
    return max(0.0, min(1.0, x))


def smoothstep(e0, e1, x):
    t = clamp01((x - e0) / (e1 - e0))
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def ease_io(x):
    x = clamp01(x)
    return 4 * x ** 3 if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


def ease_out(x):
    x = clamp01(x)
    return 1 - (1 - x) ** 3


def ease_in(x):
    x = clamp01(x)
    return x ** 3


def expo_out(x, k=7.2):
    """长尾减速：k = 7.2 时前 20% 的时间走完 80% 的路（04-3d-render 的推镜头）。"""
    return 1 - (1 - clamp01(x)) ** k


def linear(x):
    return clamp01(x)


def damped(t, hz=3.0, decay=0.15):
    """t ≥ 0 起振的衰减余弦（1 → 0）：落地后的弹、压扁回弹。t < 0 为 0。"""
    if t < 0:
        return 0.0
    return math.exp(-t / decay) * math.cos(2 * math.pi * hz * t)


def keys(t, ks):
    """分段关键帧插值：ks = [(t, value, ease?)]，ease 是进入这一键的那段的缓动（默认 ease_io，和引擎 util.keys 一样）；
    value 可以是数、元组或 Vector。"""
    if t <= ks[0][0]:
        return ks[0][1]
    for (t0, v0, *_), (t1, v1, *e) in zip(ks, ks[1:]):
        if t <= t1:
            u = (t - t0) / (t1 - t0) if t1 > t0 else 1
            u = (e[0] if e else ease_io)(u)
            if isinstance(v0, Vector):
                return v0.lerp(Vector(v1), u)
            if isinstance(v0, (tuple, list)):
                return type(v0)(a + (b - a) * u for a, b in zip(v0, v1))
            return v0 + (v1 - v0) * u
    return ks[-1][1]


def hand(t, amp=0.0012, hz=0.32, seed=1):
    """手持的轻微漂移（米）：几个不成倍数的正弦相加，只取决于 t。"""
    n = lambda s: math.sin(t * hz * 6.283 * (1 + 0.13 * s) + s * 1.7) * 0.6 + math.sin(t * hz * 6.283 * (2.31 + 0.07 * s) + s * 4.1) * 0.4
    return Vector((n(seed) * amp, n(seed + 3) * amp, n(seed + 7) * amp * 0.7))


def hash01(*xs):
    """带种子的无状态随机（0..1），和顺序无关。"""
    h = 2166136261
    for x in xs:
        h ^= int(x * 1000003) & 0xFFFFFFFF
        h = (h * 16777619) & 0xFFFFFFFF
    h ^= h >> 13
    h = (h * 0x5bd1e995) & 0xFFFFFFFF
    h ^= h >> 15
    return h / 4294967296.0

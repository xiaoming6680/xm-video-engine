# Blender 渲序列帧的通用驱动：一个镜头 = 歌曲时间段 + 每一帧的相机 / 物体 / 灯的状态（写在单独的 shots 模块里）。
#   blender -b --factory-startup -P tools/blender/render.py -- --shots shots_example --shot drop [--exr] [参数…]
# 输出 assets/blender/<镜头>/<歌曲帧号 60fps>.png（--exr：半浮点 .exr），引擎 library/kit/plate.ts 按帧号读；
# 同目录写 cam.json（每帧相机，plate.ts 的格式，axes = blender）和 frames.json（渲好了哪些帧）。
# 先把整段的相机和动画物体逐帧打上关键帧（每帧的快门开、中、关三处：Cycles 的运动模糊只在快门内取位置），再逐帧渲染；
# 已经渲好的帧跳过（断点续渲）。材质 / world 节点里的数随时间变：lib.held_keys（插值要改成 CONSTANT，见 lib.py）。
#
# 参数（都在 -- 后面）：
#   --shots 模块名或 .py 路径（默认 shots_example；模块名先在 tools/blender/ 找，再在项目根目录的 blender/ 找）
#   --shot 名字（默认模块里的第一个）   --list 列出镜头
#   --root 项目根目录（默认当前目录，或这个文件往上两级）
#   --still t1,t2   只渲这几个歌曲时刻，PNG 写到 out/blender/<镜头>/（看图用）
#   --from t --to t  只渲这一段（歌曲秒，在镜头范围内）   --every k  每 k 帧渲一张
#   --scale 50  分辨率百分比   --samples N  采样数（覆盖镜头设置）   --exposure ev  曝光（覆盖）
#   --exr  写半浮点 EXR（给引擎用：不出色带）；--png 同时也写 PNG   --codec ZIP|PIZ|DWAA
#   --out 目录（默认：正式 assets/blender/<镜头>/；--scale 不是 100 或 --every > 1 时 out/blender/<镜头>_preview/，不会被正式渲染当成已渲好）
#   --camjson  只导出 cam.json 不渲   --force  已有的帧也重渲   --tag 静帧文件名后缀   --disable 名字前缀,…  藏掉这些物体 / 灯
#   --seed N  固定 Cycles 的噪声种子（默认随帧变）：同一帧换两个种子各渲一张，两张之差就是逐帧闪烁的上限（查去噪稳不稳）
#
# shots 模块：SHOTS = {'名字': 函数(P) → dict}，P 是 lib.Project（拍、小节、歌词行时间）。返回的 dict：
#   id, t0, t1（歌曲秒）, fps=60, res=(1920, 1080), render={samples, view, exposure, …（lib.setup_render 的参数）},
#   build(S) → S：搭场景（S 里已有 'P'、'cam'、'shot'），把要动的物体放进 S 或按名字能在 bpy.data.objects 里找到；
#   at(S, t) → 这一刻的状态（只取决于 t；t 也会是快门开 / 关的子帧时刻）。镜头里要硬切（换机位、换物体）时按
#     lib.frame_of(t, fps)（这一帧自己的画面）判断，快门内的子帧就和这一帧判到同一边，切点不会被运动模糊拖糊：
#     'cam': {eye, target, lens=50, fstop=2.8, focus=None（= 到 target 的距离）, roll=0}（或旧写法元组 (eye, target, lens, fstop, focus[, roll])）
#     'objs': {名字: {loc, rot（欧拉）| quat, scale}}（或旧写法 (loc, rot)）   'lights': {灯名: 能量}   'exposure': ev
#     'points': {名字: (x, y, z)}  这一帧画面里要让引擎对齐的点（Blender 坐标），写进 cam.json
import bpy, sys, os, math, json, time, importlib, importlib.util
from mathutils import Vector, Quaternion
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def arg(k, d=None):
    return argv[argv.index(k) + 1] if k in argv else d


def flag(k):
    return k in argv


ROOT = lib.set_root(arg('--root'))
P = lib.Project(ROOT)


def load_shots(name):
    if name.endswith('.py') or os.sep in name or '/' in name:
        path = name if os.path.isabs(name) else os.path.join(ROOT, name)
    else:
        path = next((p for p in (os.path.join(lib.HERE, name + '.py'), os.path.join(ROOT, 'blender', name + '.py'),
                                 os.path.join(ROOT, 'tools', 'blender', name + '.py')) if os.path.exists(p)), None)
        if not path:
            raise SystemExit(f'找不到 shots 模块 {name}（tools/blender/ 或项目的 blender/ 里）')
    sys.path.insert(0, os.path.dirname(path))
    spec = importlib.util.spec_from_file_location(os.path.splitext(os.path.basename(path))[0], path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def cam_state(st):
    """at() 的 'cam' → (eye, target, lens, fstop, focus, roll)。"""
    c = st['cam']
    if isinstance(c, dict):
        eye, tgt = Vector(c['eye']), Vector(c['target'])
        fd = c.get('focus')
        return eye, tgt, float(c.get('lens', 50.0)), float(c.get('fstop', 2.8)), float((tgt - eye).length if fd is None else fd), float(c.get('roll', 0.0))
    eye, tgt, lens, fst, fd, *rest = c
    return Vector(eye), Vector(tgt), float(lens), float(fst), float(fd), float(rest[0] if rest else 0.0)


def obj_state(v):
    if isinstance(v, dict):
        return v
    loc, rot = v
    return {'loc': loc, 'rot': rot}


def find(S, name):
    v = S.get(name)
    return v if isinstance(v, bpy.types.Object) else bpy.data.objects[name]


def bake_all(S, shot, cam, kf):
    """kf 帧（含前后各一帧）的状态 → 相机、物体、灯的关键帧。"""
    fps = shot['fps']
    sts = [shot['at'](S, f / fps) for f in kf]
    eyes, quats, lens, fst, fds = [], [], [], [], []
    prev = None
    for st in sts:
        eye, tgt, ln, fs, fd, roll = cam_state(st)
        q = lib.cam_quat(eye, tgt, roll)
        if prev is not None and prev.dot(q) < 0:
            q.negate()  # (四元数插值走短的那边)
        prev = q
        eyes.append(tuple(eye)); quats.append(tuple(q)); lens.append(ln); fst.append(fs); fds.append(fd)
    lib.bake(cam, 'location', kf, eyes)
    lib.bake(cam, 'rotation_quaternion', kf, quats)
    lib.bake(cam.data, 'lens', kf, lens)
    lib.bake(cam.data, 'dof.aperture_fstop', kf, fst)
    lib.bake(cam.data, 'dof.focus_distance', kf, fds)
    names = {}
    for st in sts:
        for name, v in st.get('objs', {}).items():
            names.setdefault(name, set()).update(k for k, x in obj_state(v).items() if x is not None)
    for name, chans in names.items():
        ob = find(S, name)
        seq = [obj_state(st['objs'][name]) for st in sts]
        if 'loc' in chans:
            lib.bake(ob, 'location', kf, [tuple(s['loc']) for s in seq])
        if 'rot' in chans:
            ob.rotation_mode = 'XYZ'
            lib.bake(ob, 'rotation_euler', kf, [tuple(s['rot']) for s in seq])
        if 'quat' in chans:
            ob.rotation_mode = 'QUATERNION'
            lib.bake(ob, 'rotation_quaternion', kf, [tuple(s['quat']) for s in seq])
        if 'scale' in chans:
            sc_ = [s['scale'] for s in seq]
            lib.bake(ob, 'scale', kf, [(x, x, x) if isinstance(x, (int, float)) else tuple(x) for x in sc_])
    lights = set()
    for st in sts:
        lights.update(st.get('lights', {}).keys())
    for name in lights:
        ob = find(S, name)
        lib.bake(ob.data, 'energy', kf, [st['lights'].get(name, ob.data.energy) for st in sts])
    return len(names)


def write_camjson(S, shot, path):
    """每帧相机（plate.ts 的 PlateCam，Blender 坐标：axes = blender），镜头前后各多一帧。"""
    fps, res = shot['fps'], shot['res']
    f0, f1 = lib.frame_of(shot['t0'], fps), lib.frame_of(shot['t1'], fps)
    cd = S['cam'].data
    rows = []
    for f in range(f0 - 1, f1 + 2):
        st = shot['at'](S, f / fps)
        eye, tgt, ln, fs, fd, roll = cam_state(st)
        q = lib.cam_quat(eye, tgt, roll)
        r = {'f': f, 'p': [round(v, 5) for v in eye], 'q': [round(q.x, 6), round(q.y, 6), round(q.z, 6), round(q.w, 6)],
             'fov': round(lib.vfov(ln, cd.sensor_width, res), 5), 'lens': round(ln, 4), 'focus': round(fd, 4)}
        if st.get('points'):
            r['points'] = {k: [round(float(c), 5) for c in v] for k, v in st['points'].items()}
        rows.append(r)
    near, far = round(cd.clip_start, 4), round(cd.clip_end, 3)
    data = {'fps': fps, 'first': f0 - 1, 'axes': 'blender', 'sensor': cd.sensor_width, 'res': list(res),
            'shot': shot['id'], 't0': shot['t0'], 't1': shot['t1'], 'frames': rows}
    for r in rows:
        r['near'], r['far'] = near, far
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + '.tmp', 'w', encoding='utf-8') as fh:
        json.dump(data, fh, separators=(',', ':'))
    os.replace(path + '.tmp', path)
    print('CAMJSON', path, len(rows), flush=True)


def write_manifest(out, shot, res, pct):
    """frames.json：这个目录里已经渲好的帧（引擎示例按它定 first / last）。"""
    got = {}
    for fn in os.listdir(out):
        stem, ext = os.path.splitext(fn)
        if stem.isdigit() and ext in ('.png', '.exr'):
            got.setdefault(ext[1:], []).append(int(stem))
    data = {'shot': shot['id'], 'fps': shot['fps'], 't0': shot['t0'], 't1': shot['t1'],
            'res': [res[0] * pct // 100, res[1] * pct // 100], 'formats': {}}
    for ext, fs in got.items():
        fs.sort()
        data['formats'][ext] = {'first': fs[0], 'last': fs[-1], 'count': len(fs),
                                'missing': [f for f in range(fs[0], fs[-1] + 1) if f not in set(fs)][:200]}
    with open(os.path.join(out, 'frames.json.tmp'), 'w', encoding='utf-8') as fh:
        json.dump(data, fh)
    os.replace(os.path.join(out, 'frames.json.tmp'), os.path.join(out, 'frames.json'))


def main():
    mod = load_shots(arg('--shots', 'shots_example'))
    if flag('--list'):
        for k, fn in mod.SHOTS.items():
            s = fn(P)
            print(f'SHOT {k}: {s["t0"]:.3f}–{s["t1"]:.3f} s')
        return
    sid = arg('--shot', next(iter(mod.SHOTS)))
    shot = dict(fps=60, res=(1920, 1080), render={})
    shot.update(mod.SHOTS[sid](P))
    fps = shot['fps']
    lib.clear_scene()
    ro = dict(shot['render'])
    if arg('--samples'):
        ro['samples'] = int(arg('--samples'))
    if arg('--exposure'):
        ro['exposure'] = float(arg('--exposure'))
    pct = int(arg('--scale', '100'))
    sc = lib.setup_render(fps=fps, res=shot['res'], pct=pct, **ro)
    if arg('--seed'):
        sc.cycles.use_animated_seed = False
        sc.cycles.seed = int(arg('--seed'))
    cam = lib.camera('cam')
    S = {'P': P, 'cam': cam, 'shot': shot}
    t_ = time.time()
    S = shot['build'](S) or S
    print(f'BUILD {sid} {time.time() - t_:.1f}s, {len(bpy.data.objects)} objects', flush=True)
    for pre in [x for x in arg('--disable', '').split(',') if x]:
        for ob in bpy.data.objects:
            if ob.name.startswith(pre):
                ob.hide_render = True

    f0, f1 = lib.frame_of(shot['t0'], fps), lib.frame_of(shot['t1'], fps)
    seq_out = os.path.join(ROOT, 'assets', 'blender', sid)
    if flag('--camjson'):
        write_camjson(S, shot, os.path.join(arg('--out', seq_out), 'cam.json'))
        return
    every = int(arg('--every', '1'))
    stills = [float(x) for x in arg('--still', '').split(',') if x]
    if stills:
        frames = [lib.frame_of(t, fps) for t in stills]
    else:
        a = max(f0, lib.frame_of(float(arg('--from')), fps)) if arg('--from') else f0
        b = min(f1, lib.frame_of(float(arg('--to')), fps)) if arg('--to') else f1
        frames = list(range(a, b + 1, every))
    if not frames:
        raise SystemExit('没有要渲的帧（--from / --to 在镜头范围外？）')
    # 每帧在快门开、中、关三处打关键帧（f−h、f、f+h，h = 快门 / 2，运动模糊只读这几处），首尾各多一帧：
    # 镜头里按这一帧自己的画面（round(t·fps)）决定的切点，就不会被线性插值在快门内拖过切点、糊成两个画面
    h = sc.render.motion_blur_shutter / 2 if sc.render.use_motion_blur else 0.0
    kf = sorted({min(frames) - 1, max(frames) + 1} | {f + d for f in frames for d in ((-h, 0.0, h) if h else (0.0,))})
    t_ = time.time()
    n = bake_all(S, shot, cam, kf)
    print(f'KEYS {len(kf)} frames, camera + {n} objects {time.time() - t_:.1f}s', flush=True)

    preview = pct != 100 or every > 1
    if stills:
        out = arg('--out', os.path.join(ROOT, 'out', 'blender', sid))
        kinds = ['png']
    else:
        out = arg('--out', os.path.join(ROOT, 'out', 'blender', sid + '_preview') if preview else seq_out)
        kinds = (['exr'] + (['png'] if flag('--png') else [])) if flag('--exr') else ['png']
    os.makedirs(out, exist_ok=True)
    if not stills:
        write_camjson(S, shot, os.path.join(out, 'cam.json'))
    codec = arg('--codec', 'ZIP')
    tag = arg('--tag', '')
    done, spent = 0, 0.0
    for f in frames:
        if stills:
            paths = {'png': os.path.join(out, f'{sid}{tag}_{f / fps:.3f}.png')}
        else:
            paths = {k: os.path.join(out, f'{f:04d}.{k}') for k in kinds}
            if not flag('--force') and all(os.path.exists(p) for p in paths.values()):
                continue  # 已渲好的帧跳过（中断后接着渲）
        sc.frame_set(f)
        st = shot['at'](S, f / fps)
        if 'exposure' in st:
            lib.set_exposure(st['exposure'] if not arg('--exposure') else float(arg('--exposure')))
        t_ = time.time()
        bpy.ops.render.render()
        for k, p in paths.items():
            lib.save_result(p, k, codec)
        dt = time.time() - t_
        done += 1
        spent += dt
        print(f'FRAME {f} t={f / fps:.3f} {dt:.1f}s', flush=True)
        if not stills:
            write_manifest(out, shot, shot['res'], pct)
    if not stills:
        write_manifest(out, shot, shot['res'], pct)
    print(f'DONE {sid}: {done} frames, {spent / max(done, 1):.1f}s/frame → {out}', flush=True)


main()

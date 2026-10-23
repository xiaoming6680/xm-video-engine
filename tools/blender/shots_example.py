# 示例镜头表（给 render.py 用）：drop —— 软糖字母 D R O P 一拍一个落在一片糖衣小球上，第五拍（强拍）一颗镀铬球当句号砸下来，
# 小球被压下去、一圈圈荡开，相机从高处边推近边降下来。约 3.75 秒，节拍取自项目的 data/audio.json。
#   blender -b --factory-startup -P tools/blender/render.py -- --shots shots_example --shot drop --exr
# 质感和灯光照 mg-styles-15（MIT）demos/04-3d-render 的做法：次表面软糖、镀铬、只给反射看的亮天空、一正一负两盏聚光做落影。
# 所有运动是时间的闭式函数（没有模拟状态），任意一帧都能单独算。单位米，Z 向上，字面朝 −Y（相机在 −Y 那边）。
import math, os
import bpy
from mathutils import Vector, Euler
import lib
from lib import keys, smoothstep, damped, hash01

FONT = os.path.join(lib.ROOT, 'app', 'public', 'fonts', 'Archivo-w1000-900.ttf')  # OFL
WORD = 'DROP'
G = 18.0                 # 重力（米/秒²，比真实的大一点，落得干脆）
R = 0.105                # 小球半径
PITCH = 0.24             # 小球间距（六边形排布）
BED = 2 * R              # 小球顶面高度
SINK = 0.035             # 字落稳后压进球阵的深度
RB = 0.27                # 镀铬句号半径
GAP = 0.075              # 字母外轮廓之间的空隙
LETTER_COL = ['#FF4A5C', '#FF7A36', '#FFB52E', '#FF5C93']
BED_COL = [('#C9D3F2', 0.78), ('#F6ECDF', 0.14), ('#FFD27A', 0.08)]   # 长春花蓝为主，奶白、黄油色点缀
WAVE_V, WAVE_L, WAVE_S, WAVE_T = 2.6, 0.55, 0.36, 0.6                  # 波速、波长、包络宽、衰减时间
REACH = 4.2              # 离落点多远以内的小球会动（再远波已经看不见）


def shot_drop(P):
    # 落点：第 2 小节起一拍一个字，第 5 拍（第 3 小节强拍）句号
    b0 = P.bar(2)
    i0 = min(range(len(P.beats)), key=lambda i: abs(P.beats[i] - b0)) if P.beats else 0
    lands = [P.beat(i0 + k) for k in range(5)]
    t0, t1 = lands[0] - 0.45, lands[4] + 1.3

    def cam_at(t):
        # 从高处俯看一片球阵，边推近边降下来，地平线和字一起进画面
        eye = keys(t, [(t0, Vector((-1.9, -10.6, 3.7))), (t1, Vector((-0.5, -7.1, 1.42)), lambda x: 1 - (1 - x) ** 2)])
        tgt = keys(t, [(t0, Vector((0.1, 0.0, 0.3))), (t1, Vector((0.06, 0.0, 0.5)), lambda x: 1 - (1 - x) ** 2)])
        lens = keys(t, [(t0, 42.0), (t1, 50.0)])
        # 句号砸下那一下镜头轻轻一沉
        bump = 0.014 * damped(t - lands[4], 3.5, 0.12) * smoothstep(0, 0.02, t - lands[4])
        eye = eye + lib.hand(t, 0.006, 0.28, 3) + Vector((0, 0, -bump))
        return dict(eye=eye, target=tgt, lens=lens, fstop=0.5, focus=(tgt - eye).length * 0.99)

    def drop_z(t, T, h, hop):
        """落到 T 时刻着地：之前从 h 高处自由落下（更早停在 h），之后两下小跳。返回离静止高度的高度。"""
        tau = t - T
        if tau < 0:
            return min(h, 0.5 * G * tau * tau)
        z, start = 0.0, 0.06
        for hh in (hop, hop * 0.22):
            d = 2 * math.sqrt(2 * hh / G)
            if start <= tau < start + d:
                u = (tau - start) / d
                z = hh * 4 * u * (1 - u)
            start += d + 0.03
        return z

    def squash(t, T, a):
        """竖直缩放：下落时拉长一点，着地两帧内压扁，再衰减着回弹。"""
        tau = t - T
        s = 1 + 0.08 * smoothstep(-0.3, -0.06, tau) * (1 - smoothstep(-0.03, 0.0, tau))
        if tau >= 0:
            s -= a * smoothstep(0, 0.035, tau) * math.exp(-tau / 0.14) * math.cos(2 * math.pi * 2.8 * max(0.0, tau - 0.035))
        return s

    def build(S):
        # ---------------------------------------------------------- 环境、背景
        lib.studio_world('#E6E3F4', 0.32, '#F3EEFA', 0.42, 1.5)
        # 影棚背景：近处是球阵下面的地（偏深，球缝里有层次），往远处渐变成墙，墙自发一点光不发灰（04-3d-render 的 cyc 也这样）
        bg = lib.principled('cyc', '#9AA3CC', 0.85, emit='#EEE8FA', spec=0.15)
        N, L, b = lib.nodes(bg)
        tc = N.new('ShaderNodeTexCoord'); sp = N.new('ShaderNodeSeparateXYZ'); L.new(tc.outputs['Object'], sp.inputs[0])
        def ramp(a, b_, lo, hi):
            mr = N.new('ShaderNodeMapRange'); mr.interpolation_type = 'SMOOTHSTEP'
            mr.inputs['From Min'].default_value = a; mr.inputs['From Max'].default_value = b_
            mr.inputs['To Min'].default_value = lo; mr.inputs['To Max'].default_value = hi
            L.new(sp.outputs['Y'], mr.inputs['Value'])
            return mr.outputs['Result']
        mx = N.new('ShaderNodeMix'); mx.data_type = 'RGBA'
        mx.inputs['A'].default_value = lib.rgba('#9AA3CC'); mx.inputs['B'].default_value = lib.rgba('#E9E4F6')
        L.new(ramp(12.4, 15.5, 0.0, 1.0), mx.inputs['Factor'])
        ao = N.new('ShaderNodeAmbientOcclusion'); ao.samples = 8; ao.inputs['Distance'].default_value = 0.25
        am = N.new('ShaderNodeMix'); am.data_type = 'RGBA'; am.blend_type = 'MULTIPLY'; am.inputs['Factor'].default_value = 0.6
        L.new(mx.outputs['Result'], am.inputs['A']); L.new(ao.outputs['AO'], am.inputs['B']); L.new(am.outputs['Result'], b.inputs['Base Color'])
        L.new(ramp(13.0, 19.0, 0.0, 1.1), b.inputs['Emission Strength'])
        bg.cycles.emission_sampling = 'NONE'
        lib.cyc('cyc', bg, y_wall=13.0, radius=5.0)

        # ---------------------------------------------------------- 字母
        letters = []
        for k, ch in enumerate(WORD):
            m = lib.gummy(f'gum_{ch}', LETTER_COL[k])
            ob = lib.text_mesh(f'L_{ch}', ch, FONT, size=1.32, extrude=0.03, bevel_depth=0.115, offset=-0.11, res=8, mat=m,
                                remesh=0.006, smooth_iter=6)
            letters.append(ob)
        widths = [ob['size'][0] for ob in letters]
        total = sum(widths) + GAP * (len(WORD) - 1) + GAP * 1.6 + 2 * RB
        x = -total / 2
        S['letters'] = []
        for ob, w in zip(letters, widths):
            S['letters'].append(dict(ob=ob, x=x + w / 2, w=w, h=ob['size'][2], d=ob['size'][1]))
            x += w + GAP
        bx = x - GAP + GAP * 1.6 + RB
        bpy_ball = lib.link(bpy.data.objects.new('dot', lib.sphere_mesh('dot', RB, 128, 64, lib.chrome())))
        S['ball'] = dict(ob=bpy_ball, x=bx)
        # 落点和下落的高度（起点在画面外）
        S['drops'] = [dict(T=lands[k], x=L_['x'], r=L_['w'] / 2, A=0.07, h=3.4 + 0.2 * k, hop=0.11) for k, L_ in enumerate(S['letters'])]
        S['drops'].append(dict(T=lands[4], x=bx, r=RB * 0.8, A=0.10, h=4.4, hop=0.22))
        for k, L_ in enumerate(S['letters']):
            L_['tilt'] = ((hash01(k, 1) - 0.5) * 0.5, (hash01(k, 2) - 0.5) * 0.5, (hash01(k, 3) - 0.5) * 0.3)
            # 字底的点（判断哪些小球被压着）
            me = L_['ob'].data
            L_['foot'] = [(v.co.x, v.co.y) for v in me.vertices if v.co.z < 0.03]

        # ---------------------------------------------------------- 球阵：只建镜头运动中看得到的部分；离落点近的才动
        cams = [cam_at(t0 + (t1 - t0) * k / 6) for k in range(7)]
        mats = [(lib.add_ao(lib.candy(f'bed{k}', c), 0.12, 0.5), p) for k, (c, p) in enumerate(BED_COL)]
        meshes = [lib.sphere_mesh(f'ball{k}', R, 40, 20, m) for k, (m, _) in enumerate(mats)]
        dy = PITCH * math.sqrt(3) / 2
        S['bed'] = []
        n_all = 0
        j = 0
        y = -7.0
        while y < 12.6:
            xo = (j % 2) * PITCH / 2
            xx = -12.0 + xo
            while xx < 12.0:
                p = (xx, y, R)
                if any(_visible(c, p, 0.06) for c in cams):
                    # 颜色：低频成片 + 少量散点
                    blob = 0.5 + 0.5 * math.sin(xx * 0.9 + 1.3) * math.sin(y * 0.7 - 0.4)
                    ws = [p_ * ((1.25 - 0.5 * blob) if k_ == 0 else (0.8 + 0.6 * blob)) for k_, (_, p_) in enumerate(mats)]
                    r_ = hash01(xx * 7.1, y * 3.3, 5) * sum(ws)
                    kk = 0
                    while kk < len(ws) - 1 and r_ > ws[kk]:
                        r_ -= ws[kk]
                        kk += 1
                    s = 1 + 0.05 * (hash01(xx, y, 9) - 0.5) * 2
                    ob = lib.instance(f'bed_{n_all:05d}', meshes[kk], (xx, y, R * s), s)
                    if _seg_dist(xx, y, S) < REACH:
                        feet = []
                        for k, L_ in enumerate(S['letters']):
                            if abs(xx - L_['x']) < L_['w'] / 2 + R and abs(y) < L_['d'] / 2 + R:
                                dmin = min(math.hypot(xx - L_['x'] - fx, y - fy) for fx, fy in L_['foot'])
                                m_ = smoothstep(R * 1.05, R * 0.35, dmin)
                                if m_ > 0:
                                    feet.append((k, m_))
                        S['bed'].append(dict(ob=ob, x=xx, y=y, z0=R * s, rs=R * s, jt=(hash01(xx, y, 11) - 0.5) * 0.03,
                                             ja=0.8 + 0.4 * hash01(xx, y, 12), feet=feet))
                    n_all += 1
                xx += PITCH
            y += dy
            j += 1
        # 引擎对齐用的几颗参照球：字前面几排、会被波推动的（只写进 cam.json 的 points，不影响画面）
        pick = lambda px, py: min(S['bed'], key=lambda b_: math.hypot(b_['x'] - px, b_['y'] - py))
        Lx = [L_['x'] for L_ in S['letters']]
        S['refs'] = {'b0': pick(bx + 0.1, -0.9), 'b1': pick(Lx[2] + 0.1, -0.9), 'b2': pick(Lx[0], -0.9), 'b3': pick(bx + 0.9, -0.4)}
        print(f'bed: {n_all} balls, {len(S["bed"])} animated', flush=True)

        # ---------------------------------------------------------- 灯
        lib.area('key', (-6.5, -5.5, 7.5), (0.3, 0.0, 0.3), 5.0, 2600, '#FFF4EC', shape='DISK', spread=75)
        rim = lib.area('rim', (2.0, 7.5, 4.6), (0.2, 0.0, 0.6), 7.0, 2600, '#FFD3E2', size_y=1.8, spread=120)
        lib.area('fill', (7.0, -8.5, 3.0), (0.0, 0.0, 0.4), 8.0, 260, '#DCE2FF', shape='DISK')
        lib.area('wall', (0.0, 8.0, 1.5), (0.0, 18.0, 4.0), 7.0, 900, '#F2EAFF', shape='DISK')
        # 轮廓光只打字母和球，不在背后的球阵上拉出一条粉色高光带
        excl = bpy.data.collections.new('rim_excl')
        for ob in bpy.data.objects:
            if ob.name.startswith(('bed_', 'cyc')):
                excl.objects.link(ob)
        rim.light_linking.receiver_collection = excl
        for co in excl.collection_objects:
            co.light_linking.link_state = 'EXCLUDE'
        # 反射里的暗旗和粉色灯条：镀铬有真正的暗部和一道彩色高光
        lib.card('flag', (bx - 1.8, -7.0, 6.2), (bx, 0, 0.4), 12.0, 7.0, '#25203A', 1.0)
        lib.card('strip', (bx + 5.0, -3.2, 2.6), (bx, 0, 0.5), 0.45, 6.0, '#FF7FB0', 6.0)
        # 落影：字和句号在球阵上的影子，下落时越来越实
        S['shadow'] = lib.shadow_pair('drop_shadow', (0.2, -0.8, 7.5), (0.2, 0.0, 0.0), 1600,
                                      [L_['ob'] for L_ in S['letters']] + [bpy_ball], angle=60, radius=0.35)
        return S

    def at(S, t):
        objs, pts = {}, {}
        tops = []   # 每个下落物这一刻：着地高度 → 用来压小球
        for k, L_ in enumerate(S['letters']):
            d = S['drops'][k]
            hz = drop_z(t, d['T'], d['h'], d['hop'])
            sz = squash(t, d['T'], 0.24)
            sxy = 1 / math.sqrt(sz)
            tau = t - d['T']
            tilt = 1 - smoothstep(-0.32, 0.0, tau)
            wob = 0.05 * damped(tau, 2.4, 0.22) * smoothstep(0, 0.03, tau)
            ax, ay, az = L_['tilt']
            rot = (ax * tilt + wob * 0.4, ay * tilt + wob * (1 if k % 2 else -1), az * tilt)
            z = BED - SINK + hz
            objs[L_['ob'].name] = {'loc': (L_['x'], 0.0, z), 'rot': rot, 'scale': (sxy, sxy, sz)}
            c = Vector((L_['x'], 0.0, z)) + Euler(rot).to_matrix() @ Vector((0, 0, L_["h"] * sz / 2))
            pts[WORD[k]] = tuple(c)
            tops.append(z)
        d = S['drops'][4]
        hz = drop_z(t, d['T'], d['h'], d['hop'])
        sz = squash(t, d['T'], 0.18)
        sxy = 1 / math.sqrt(sz)
        bz = BED - 0.06 + hz           # 球底
        roll = 0.6 * smoothstep(-0.4, 0.6, t - d['T'])
        objs['dot'] = {'loc': (S['ball']['x'], 0.0, bz + RB * sz), 'rot': (roll, 0.0, 0.0), 'scale': (sxy, sxy, sz)}
        pts['dot'] = (S['ball']['x'], 0.0, bz + RB * sz)
        ball_c = (S['ball']['x'], bz + RB * sz, RB * sxy, RB * sz)
        # 小球：波 + 被压着的往下让
        for b_ in S['bed']:
            dz = 0.0
            for d in S['drops']:
                tau = t - d['T'] - b_['jt']
                if tau <= 0:
                    continue
                de = max(0.0, math.hypot(b_['x'] - d['x'], b_['y']) - d['r'])
                u = de - WAVE_V * tau
                dz += (d['A'] * b_['ja'] * smoothstep(0, 0.05, tau) * math.exp(-tau / WAVE_T) * math.exp(-(u / WAVE_S) ** 2)
                       * math.cos(2 * math.pi * u / WAVE_L) / math.sqrt(1 + 1.5 * de))
                # 落点正中一下凹
                dz -= d['A'] * 0.7 * math.exp(-tau / 0.16) * math.exp(-(de / 0.35) ** 2) * smoothstep(0, 0.03, tau)
            top = b_['z0'] + b_['rs'] + dz
            for k, m_ in b_['feet']:
                lim = tops[k] - 0.006
                if top > lim:
                    top -= (top - lim) * m_
            # 句号底下
            ex, ez, ar, cr = ball_c
            dd = math.hypot(b_['x'] - ex, b_['y'])
            if dd < ar * 0.98:
                lim = ez - cr * math.sqrt(max(0.0, 1 - (dd / ar) ** 2)) - 0.006
                if top > lim:
                    top = lim
            objs[b_['ob'].name] = {'loc': (b_['x'], b_['y'], top - b_['rs'])}
        for k, b_ in S['refs'].items():
            pts[k] = objs[b_['ob'].name]['loc']
        return {
            'cam': cam_at(t),
            'objs': objs,
            'points': pts,
            'exposure': -1.0,
        }

    return dict(id='drop', t0=t0, t1=t1, fps=60, res=(1920, 1080),
                render=dict(samples=128, threshold=0.012, min_samples=32, view='Khronos PBR Neutral', exposure=-1.0,
                            haze=dict(color='#E2DCF0', start=11.0, depth=14.0, amount=0.75)),
                build=build, at=at)


def _visible(c, p, margin):
    """p 在这个机位的画面里（含 margin 的外扩）。"""
    r = lib.project(c['eye'], c['target'], c['lens'], p)
    return r is not None and -margin < r[0] < 1 + margin and -margin < r[1] < 1 + margin * 2


def _seg_dist(x, y, S):
    """到落点连线（字母和句号所在的那一段 x，y = 0）的距离。"""
    xs = [d['x'] for d in S['drops']]
    cx = min(max(x, min(xs)), max(xs))
    return math.hypot(x - cx, y)


SHOTS = {'drop': shot_drop}

# 漫画墨线和网点（《蜈蚣》用的画风）：不打灯，N·L → 亮面 / 网点 / 排线 / 暗面；反壳墨线；粗字块。
# 排线和网点按画面坐标算，1080p 和 4K 的图案一样大。可选工具，不是默认画风。示例：shots_toon_example.py
#   lit、shade：亮面、暗面的颜色；side：字块侧面的颜色（面向由物体空间法线判断）；spec：一条硬高光
#   alt、alt_name：节点里的值切换亮面颜色（比如红底上把甲片换白），用 lib.held_keys 按切点换
#   nl_src：lambda g, geo: 返回明暗的输出口；要始终亮面（字）用 lambda g, geo: g.value('nl1', 1.0)
# 几个坑（《蜈蚣》踩过）：
#   Blender 里中文字比字号小很多，type_mesh 先量一个字再定字号；中文笔画密，墨线要细，不倒角
#   材质里 lightx、boil 是节点值，可以直接改 default_value，或用 held_keys 按帧换
#   Wireframe 节点用像素宽度时要乘 resolution_percentage / 100，不然 4K 下线变细
#   连续渲几千帧偶尔整段白变黑：渲完用 verify_frames.py 和一遍低分辨率比对
import math
import os
from pathlib import Path

import bmesh
import bpy

import lib

RED, WHITE, INK = '#E3061B', '#F4F1EA', '#0B0A0A'
_ENGINE_FONTS = Path(__file__).resolve().parents[2] / 'app' / 'public' / 'fonts'


def font_path(name):
    """先找项目自己的字体，再找引擎的。"""
    p = Path(lib.ROOT) / 'app' / 'public' / 'fonts' / name
    return str(p if p.exists() else _ENGINE_FONTS / name)


class G:
    """材质节点的简写：g.m('MULTIPLY', a, b) 返回输出口；a、b 可以是数或输出口。"""

    def __init__(self, mat):
        self.nt = mat.node_tree
        self.N, self.L = self.nt.nodes, self.nt.links

    def m(self, op, a, b=None, clamp=False):
        n = self.N.new('ShaderNodeMath')
        n.operation = op
        n.use_clamp = clamp
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = float(v)
            else:
                self.L.new(v, n.inputs[i])
        return n.outputs[0]

    def value(self, name, v=0.0):
        n = self.N.new('ShaderNodeValue')
        n.name = name
        n.outputs[0].default_value = v
        return n.outputs[0]

    def xyz(self, x, y, z):
        n = self.N.new('ShaderNodeCombineXYZ')
        for i, v in enumerate((x, y, z)):
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = float(v)
            else:
                self.L.new(v, n.inputs[i])
        return n.outputs[0]

    def sep(self, v):
        n = self.N.new('ShaderNodeSeparateXYZ')
        self.L.new(v, n.inputs[0])
        return n.outputs


def toon(name, lit, shade=INK, side=None, hatch=1.0, spec=0.0, face_axis=1, alt=None, alt_name=None, nl_src=None):
    """三阶卡通：亮面 lit，半调网点，排线，暗面 shade。"""
    m = lib.new_mat(name)
    g = G(m)
    out = next(n for n in g.N if n.type == 'OUTPUT_MATERIAL')
    g.N.remove(g.N['Principled BSDF'])
    geo = g.N.new('ShaderNodeNewGeometry')
    dot = g.N.new('ShaderNodeVectorMath')
    dot.operation = 'DOT_PRODUCT'
    g.L.new(geo.outputs['Normal'], dot.inputs[0])
    lv = g.N.new('ShaderNodeCombineXYZ')
    g.L.new(g.value('lightx', -0.48), lv.inputs[0])
    lv.inputs[1].default_value = -0.62
    lv.inputs[2].default_value = 0.62
    g.L.new(lv.outputs[0], dot.inputs[1])
    nl = nl_src(g, geo) if nl_src else g.m('ADD', g.m('MULTIPLY', dot.outputs['Value'], 0.5), 0.5)
    tc = g.N.new('ShaderNodeTexCoord')
    w = g.sep(tc.outputs['Window'])
    px, py = g.m('MULTIPLY', w[0], 1920.0), g.m('MULTIPLY', w[1], 1080.0)
    # 笔触抖动：boil 换值，排线就换一种抖法
    boil = g.value('boil', 0.0)
    nz = g.N.new('ShaderNodeTexNoise')
    nz.inputs['Scale'].default_value = 0.02
    nz.inputs['Detail'].default_value = 3.0
    g.L.new(g.xyz(px, py, g.m('MULTIPLY', boil, 50.0)), nz.inputs['Vector'])
    wob = g.m('MULTIPLY', g.m('SUBTRACT', nz.outputs[0], 0.5), 26.0)
    hl = g.m('ADD', g.m('ADD', px, py), wob)
    stripes = g.m('LESS_THAN', g.m('FRACT', g.m('DIVIDE', hl, 11.0)), 0.5)
    ang = 0.6
    dx = g.m('ADD', g.m('MULTIPLY', px, math.cos(ang)), g.m('MULTIPLY', py, -math.sin(ang)))
    dy = g.m('ADD', g.m('MULTIPLY', px, math.sin(ang)), g.m('MULTIPLY', py, math.cos(ang)))
    fx, fy = g.m('SUBTRACT', g.m('FRACT', g.m('DIVIDE', dx, 9.0)), 0.5), g.m('SUBTRACT', g.m('FRACT', g.m('DIVIDE', dy, 9.0)), 0.5)
    rd = g.m('SQRT', g.m('ADD', g.m('MULTIPLY', fx, fx), g.m('MULTIPLY', fy, fy)))
    dots = g.m('LESS_THAN', rd, 0.34)
    a_lit = g.m('GREATER_THAN', nl, 0.62)
    a_dot = g.m('MULTIPLY', g.m('GREATER_THAN', nl, 0.42), dots)
    a_hat = g.m('MULTIPLY', g.m('GREATER_THAN', nl, 0.24), stripes)
    lit_mask = g.m('MAXIMUM', a_lit, g.m('MAXIMUM', a_dot, g.m('MULTIPLY', a_hat, hatch)))
    mx = g.N.new('ShaderNodeMix')
    mx.data_type = 'RGBA'
    g.L.new(lit_mask, mx.inputs['Factor'])
    mx.inputs['A'].default_value = lib.rgba(shade)
    mx.inputs['B'].default_value = lib.rgba(lit)
    if alt:
        mv = g.N.new('ShaderNodeMix')
        mv.data_type = 'RGBA'
        g.L.new(g.value(alt_name, 0.0), mv.inputs['Factor'])
        mv.inputs['A'].default_value = lib.rgba(lit)
        mv.inputs['B'].default_value = lib.rgba(alt)
        g.L.new(mv.outputs['Result'], mx.inputs['B'])
    col = mx.outputs['Result']
    if side:
        obn = g.sep(tc.outputs['Normal'])
        face = g.m('GREATER_THAN', g.m('ABSOLUTE', obn[face_axis]), 0.72)
        mx2 = g.N.new('ShaderNodeMix')
        mx2.data_type = 'RGBA'
        g.L.new(face, mx2.inputs['Factor'])
        ms = g.N.new('ShaderNodeMix')
        ms.data_type = 'RGBA'
        g.L.new(lit_mask, ms.inputs['Factor'])
        ms.inputs['A'].default_value = lib.rgba(INK)
        ms.inputs['B'].default_value = lib.rgba(side)
        g.L.new(ms.outputs['Result'], mx2.inputs['A'])
        g.L.new(col, mx2.inputs['B'])
        col = mx2.outputs['Result']
    if spec:
        hv = g.m('GREATER_THAN', g.m('POWER', nl, 18.0), 0.55)
        ms2 = g.N.new('ShaderNodeMix')
        ms2.data_type = 'RGBA'
        g.L.new(g.m('MULTIPLY', hv, spec), ms2.inputs['Factor'])
        g.L.new(col, ms2.inputs['A'])
        ms2.inputs['B'].default_value = lib.rgba(WHITE)
        col = ms2.outputs['Result']
    em = g.N.new('ShaderNodeEmission')
    g.L.new(col, em.inputs['Color'])
    g.L.new(em.outputs[0], out.inputs['Surface'])
    m.cycles.emission_sampling = 'NONE'
    return m


def ink_mat():
    """反壳墨线的材质：外壳只显示背面。"""
    m = lib.new_mat('ink_hull')
    g = G(m)
    out = next(n for n in g.N if n.type == 'OUTPUT_MATERIAL')
    g.N.remove(g.N['Principled BSDF'])
    geo = g.N.new('ShaderNodeNewGeometry')
    em = g.N.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = lib.rgba(INK)
    tr = g.N.new('ShaderNodeBsdfTransparent')
    mx = g.N.new('ShaderNodeMixShader')
    g.L.new(geo.outputs['Backfacing'], mx.inputs[0])
    g.L.new(em.outputs[0], mx.inputs[1])
    g.L.new(tr.outputs[0], mx.inputs[2])
    g.L.new(mx.outputs[0], out.inputs['Surface'])
    m.cycles.emission_sampling = 'NONE'
    return m


def add_hull(me, thick, ink):
    """把网格复制一份，沿法线外扩、面反向，材质用墨线。"""
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.normal_update()
    slot = len(me.materials)
    me.materials.append(ink)
    src = list(bm.faces)
    vs = list(bm.verts)
    nv = [bm.verts.new(v.co + v.normal * thick) for v in vs]
    idx = {v: i for i, v in enumerate(vs)}
    for f in src:
        try:
            nf = bm.faces.new([nv[idx[v]] for v in reversed(f.verts)])
            nf.material_index = slot
            nf.smooth = f.smooth
        except ValueError:
            pass
    bm.to_mesh(me)
    bm.free()
    return me


_ZH_H0 = []


def type_mesh(name, text, size, extrude=0.3, mat=None, font='NotoSansSC-900.ttf', latin_font='Archivo-w620-900.ttf', bevel_depth=0.0, res=0):
    """字块网格，字面朝 −Y、字头朝 +Z，原点在底边中心。中文：字高 = 0.86 × size。"""
    if not any(ord(c) > 0x2E80 for c in text):
        return lib.text_mesh(name, text, font_path(latin_font), size=size, extrude=extrude, bevel_depth=bevel_depth, res=res, mat=mat, stand=True)
    fp = font_path(font)
    if not _ZH_H0:
        pr = lib.text_mesh('zh_probe', '蜈', fp, size=10.0, extrude=0.01, bevel_depth=0.0, res=0, stand=True)
        _ZH_H0.append(pr['size'][2])
        me = pr.data
        bpy.data.objects.remove(pr)
        bpy.data.meshes.remove(me)
    ob = lib.text_mesh(name, text, fp, size=10.0 * size * 0.86 / _ZH_H0[0], extrude=extrude, bevel_depth=0.0, res=0, mat=mat, stand=True)
    for f in ob.data.polygons:
        f.use_smooth = False
    return ob


def chunk_text(name, text, size, mat, ink, extrude=None, line=0.016):
    """粗字块加墨线。"""
    ob = type_mesh(name, text, size, extrude=extrude if extrude is not None else 0.2 * size, mat=mat)
    add_hull(ob.data, line * size, ink)
    ob.rotation_mode = 'QUATERNION'
    return ob

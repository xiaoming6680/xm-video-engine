# toon.py 的最小示例：红底上一个粗字块和一个带墨线的球。
#   blender -b --factory-startup -P tools/blender/render.py -- --shots shots_toon_example --shot toon --still 1.0 --out out/toon
import math

import bmesh
import bpy

import lib
import toon as T


def build(S):
    w = bpy.data.worlds.new('bg')
    bpy.context.scene.world = w
    nodes = w.node_tree.nodes
    nodes.clear()
    out = nodes.new('ShaderNodeOutputWorld')
    bg = nodes.new('ShaderNodeBackground')
    bg.inputs[0].default_value = lib.rgba(T.RED)
    w.node_tree.links.new(bg.outputs[0], out.inputs[0])
    ink = T.ink_mat()
    # 字面始终是亮面，侧面黑
    face = T.toon('type', T.WHITE, side=T.INK, hatch=0.0, nl_src=lambda g, geo: g.value('nl1', 1.0))
    ob = T.chunk_text('word', '字块', 3.0, face, ink)
    ob.location = (-1.6, 0, -1.3)
    # 球：亮面、网点、排线都看得到
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=4, radius=1.1)
    me = bpy.data.meshes.new('ball')
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    me.materials.append(T.toon('ball', T.WHITE, spec=0.9))
    T.add_hull(me, 0.03, ink)
    ball = bpy.data.objects.new('ball', me)
    bpy.context.scene.collection.objects.link(ball)
    ball.location = (2.7, 0, 0)
    S['cam'].data.clip_end = 500
    return S


def at(S, t):
    return {'cam': dict(eye=(0.4, -11.0, 1.2), target=(0.4, 0, 0), lens=42, fstop=32.0, focus=11.0, roll=-0.03), 'objs': {'ball': {'rot': (0, 0, t * math.pi)}}}


SHOTS = {'toon': lambda P: dict(id='toon', t0=0.0, t1=2.0, fps=60, res=(1920, 1080), build=build, at=at, render=dict(samples=16, threshold=0.0, min_samples=0, view='Standard', denoise=False, mblur=False))}

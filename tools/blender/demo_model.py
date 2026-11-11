"""示例模型：给 app 的 ?space 示例（library/scenes/demo_space.ts）做一个小 GLB，顺便验证 Blender → GLB → 引擎这条路。

内容：一根带骨骼的弯柱（三节骨头，动画 Sway：来回弯）、柱顶一个发光的环（动画 Spin：转一圈、上下浮），一个底座。
两段动画在 glTF 里是两段 clip，按名字取；网格用 Draco 压缩（顺带验证解码器）；单位米，导出时 Z 向上自动转成 Y 向上。

  blender -b --factory-startup -P tools/blender/demo_model.py -- --out app/public/models/demo_totem.glb
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
out = argv[argv.index('--out') + 1] if '--out' in argv else 'app/public/models/demo_totem.glb'
out = os.path.abspath(out)
os.makedirs(os.path.dirname(out), exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 30
scene.frame_start, scene.frame_end = 1, 61


def lin(h):
    h = h.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c] + [1.0]


def mat(name, color, metal=0.0, rough=0.5, emit=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = lin(color)
    b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    if emit:
        b.inputs['Emission Color'].default_value = lin(emit)
        b.inputs['Emission Strength'].default_value = strength
    return m


def bevel_box(name, size, loc, material, width=0.03):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.object
    o.name = name
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    md = o.modifiers.new('bevel', 'BEVEL')
    md.width, md.segments = width, 3
    bpy.ops.object.modifier_apply(modifier='bevel')
    bpy.ops.object.shade_smooth_by_angle()
    o.data.materials.append(material)
    return o


dark = mat('Basalt', '#2a2730', metal=0.2, rough=0.45)
pale = mat('Bone', '#e9e2d4', metal=0.0, rough=0.6)
glow = mat('Glow', '#ff6a3d', metal=0.0, rough=0.3, emit='#ff7a40', strength=6.0)

# base
bevel_box('Base', (1.1, 1.1, 0.25), (0, 0, 0.125), dark, 0.05)

# bending column (skinned)
bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.22, depth=2.4, location=(0, 0, 0.25 + 1.2))
col = bpy.context.object
col.name = 'Column'
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.subdivide(number_cuts=8)
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.shade_smooth()
col.data.materials.append(pale)

arm_data = bpy.data.armatures.new('Rig')
rig = bpy.data.objects.new('Rig', arm_data)
scene.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode='EDIT')
prev = None
for i in range(3):
    b = arm_data.edit_bones.new(f'Seg{i}')
    b.head = Vector((0, 0, 0.25 + 0.8 * i))
    b.tail = Vector((0, 0, 0.25 + 0.8 * (i + 1)))
    if prev:
        b.parent = prev
        b.use_connect = True
    prev = b
bpy.ops.object.mode_set(mode='OBJECT')

bpy.ops.object.select_all(action='DESELECT')
col.select_set(True)
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.parent_set(type='ARMATURE_AUTO')

# Sway: each segment bends a little more, a 2-second loop
rig.animation_data_create()
act = bpy.data.actions.new('Sway')
rig.animation_data.action = act
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode='POSE')
for f, a in [(1, 0.0), (16, 1.0), (31, 0.0), (46, -1.0), (61, 0.0)]:
    for i, pb in enumerate(rig.pose.bones):
        pb.rotation_mode = 'XYZ'
        pb.rotation_euler = (0.0, math.radians(14 * a), math.radians(6 * a * i))
        pb.keyframe_insert('rotation_euler', frame=f)
bpy.ops.object.mode_set(mode='OBJECT')

# glowing ring on top, Spin: one turn and a bob over 2 s
bpy.ops.mesh.primitive_torus_add(major_radius=0.55, minor_radius=0.05, major_segments=64, minor_segments=12, location=(0, 0, 3.0))
ring = bpy.context.object
ring.name = 'Ring'
ring.rotation_euler = (math.radians(70), 0, 0)
ring.data.materials.append(glow)
ring.animation_data_create()
ring.animation_data.action = bpy.data.actions.new('Spin')
for f, z, rz in [(1, 3.0, 0.0), (31, 3.18, math.pi), (61, 3.0, 2 * math.pi)]:
    ring.location.z = z
    ring.rotation_euler = (math.radians(70), 0, rz)
    ring.keyframe_insert('location', frame=f)
    ring.keyframe_insert('rotation_euler', frame=f)

# keep both actions for export (each becomes a glTF animation)
for o in (rig, ring):
    tr = o.animation_data.nla_tracks.new()
    tr.strips.new(o.animation_data.action.name, 1, o.animation_data.action)
    o.animation_data.action = None

bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_animations=True, export_animation_mode='ACTIONS',
                          export_yup=True, export_apply=True, export_lights=False, export_cameras=False,
                          export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6)
print('wrote', out, os.path.getsize(out), 'bytes')

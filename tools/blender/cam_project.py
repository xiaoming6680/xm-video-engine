"""按 Blender 渲染的相机（render.py 写的 cam.json）把 3D 点投到画面上：每帧的屏幕位置和视半径。

为什么要它：序列帧里发光的东西（核心、灯、太阳）经过引擎的调色、高光压缩常被压暗，光晕也被裁掉；按相机把它投到画面上，
引擎就能在合成里给它补光晕、补芯、对齐字和图形（If The Sun Burns Out 的奖杯核心：gen/core_screen.json，绿圈核对过）。
普通 Python 就能跑（不要 Blender），只读 cam.json。

  # 固定的世界点（Blender 坐标，米）；--radius 给了就算视半径（球在画面上的半径，像素）
  python tools/blender/cam_project.py --shot trophy --point core=0,0,1.32 --radius core=0.09 -o app/public/gen/screen_points.json
  # 镜头 at() 返回的 'points'（会动的物体，render.py 每帧写进 cam.json）：不给 --point 就全部投
  python tools/blender/cam_project.py --shot trophy --radius 0.09
  # 核对：在序列帧上画绿圈拼成一张（帧号用镜头的 fps；序列默认 assets/blender/<镜头>/<帧号>.png，预览序列 --seq 另给）
  python tools/blender/cam_project.py --shot trophy --point core=0,0,1.32 --radius core=0.09 --check out/qa/core_check.jpg --frames 296,310,330

输出 JSON（同一个文件里多个镜头合并，重跑覆盖这个镜头）：
  {"<镜头>": {"<点>": {"<帧号>": [x, y, r]}}}
  x, y 是渲染分辨率（cam.json 的 res，例 1920×1080）里的像素，左上为原点；r 是视半径（像素，没给半径为 0）；点在相机后面的帧不写。
引擎里按帧取：帧号 = Math.round(t × 镜头 fps)（kit/plate.ts 取帧的同一个规则，序列一拍二时用画面的时间）；
序列帧铺满画面（fit 'cover'、宽高比相同）时直接乘 W / res[0]，否则按 plate 的铺法换算。
cam.json 的格式：render.py write_camjson（四元数 q = [x, y, z, w]，和 kit/plate.ts 读的一样；fov 是竖直视角，度）。
"""
import argparse
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent


def qrot_inv(q, v):
    """v 转到相机坐标：q 的逆（共轭）作用在 v 上。q = [x, y, z, w]。"""
    x, y, z, w = q
    qx, qy, qz = -x, -y, -z
    # t = 2 · cross(q.xyz, v)；v' = v + w·t + cross(q.xyz, t)
    tx = 2 * (qy * v[2] - qz * v[1])
    ty = 2 * (qz * v[0] - qx * v[2])
    tz = 2 * (qx * v[1] - qy * v[0])
    return (v[0] + w * tx + (qy * tz - qz * ty),
            v[1] + w * ty + (qz * tx - qx * tz),
            v[2] + w * tz + (qx * ty - qy * tx))


def project(row, res, p, radius=0.0):
    """一帧的相机（cam.json 的一行）下，世界点 p 的 [x, y, r]（像素）；在相机后面返回 None。
    Blender 相机朝自己的 −Z 看、+Y 朝上；fov 是竖直视角。"""
    v = qrot_inv(row['q'], [p[i] - row['p'][i] for i in range(3)])
    if v[2] >= -1e-6:
        return None
    w, h = res
    th = math.tan(math.radians(row['fov']) / 2)
    x = (v[0] / -v[2]) / (th * w / h)
    y = (v[1] / -v[2]) / th
    r = 0.0
    if radius > 0:
        d = math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
        r = math.tan(math.asin(min(1.0, radius / d))) / th * h / 2
    return [round((x + 1) / 2 * w, 1), round((1 - y) / 2 * h, 1), round(r, 1)]


def named(items, cast):
    """['core=0,0,1', '0.2'] → {'core': …, None: …}（没名字的是给全部点的默认值）。"""
    out = {}
    for s in items or []:
        k, _, v = s.rpartition('=')
        out[k or None] = cast(v)
    return out


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--shot', help='镜头名：读 <root>/assets/blender/<镜头>/cam.json')
    ap.add_argument('--cam', help='cam.json 路径（代替 --shot）')
    ap.add_argument('--root', default=str(ROOT), help='项目根目录（默认这个文件往上三级）')
    ap.add_argument('--point', action='append', help='名字=x,y,z（Blender 世界坐标），可重复；不给就用 cam.json 每帧的 points')
    ap.add_argument('--radius', action='append', help='球半径（米）：名字=r 或 r（全部点）')
    ap.add_argument('-o', '--out', help='输出 JSON（默认 <root>/app/public/gen/screen_points.json），已有就合并')
    ap.add_argument('--check', help='在序列帧上画绿圈，拼成这张图（核对投影）')
    ap.add_argument('--frames', help='--check 的帧号，逗号分隔（默认取首、中、尾三帧）')
    ap.add_argument('--seq', help='--check 读的序列目录（默认 cam.json 所在目录；<帧号 4 位>.png）')
    a = ap.parse_args()
    root = Path(a.root)
    if not (a.cam or a.shot):
        ap.error('要 --shot 或 --cam')
    cam_path = Path(a.cam) if a.cam else root / 'assets' / 'blender' / a.shot / 'cam.json'
    cam = json.loads(cam_path.read_text(encoding='utf-8'))
    shot = a.shot or cam.get('shot') or cam_path.parent.name
    res = cam['res']
    fixed = named(a.point, lambda v: [float(c) for c in v.split(',')])
    if None in fixed:
        ap.error('--point 要写成 名字=x,y,z')
    radii = named(a.radius, float)
    names = list(fixed) or sorted({k for r in cam['frames'] for k in (r.get('points') or {})})
    if not names:
        ap.error('cam.json 里没有 points（镜头 at() 没返回），用 --point 名字=x,y,z 给世界坐标')
    result = {n: {} for n in names}
    for row in cam['frames']:
        for n in names:
            p = fixed.get(n) or (row.get('points') or {}).get(n)
            if p is None:
                continue
            v = project(row, res, p, radii.get(n, radii.get(None, 0.0)))
            if v is not None:
                result[n][str(row['f'])] = v
    out = Path(a.out) if a.out else root / 'app' / 'public' / 'gen' / 'screen_points.json'
    data = json.loads(out.read_text(encoding='utf-8')) if out.exists() else {}
    data[shot] = result
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, separators=(',', ':')), encoding='utf-8')
    for n in names:
        fs = sorted(int(f) for f in result[n])
        print(f'{shot}/{n}: {len(fs)} 帧' + (f'（{fs[0]}–{fs[-1]}）' if fs else '（全在相机后面）'))
    print(out)
    if a.check:
        check(a, cam_path, cam, res, result)


def check(a, cam_path, cam, res, result):
    from PIL import Image, ImageDraw
    seq = Path(a.seq) if a.seq else cam_path.parent
    rows = [r['f'] for r in cam['frames']]
    frames = [int(f) for f in a.frames.split(',')] if a.frames else [rows[1], rows[len(rows) // 2], rows[-2]]
    tiles = []
    for f in frames:
        p = seq / f'{f:04d}.png'
        if not p.exists():
            print(f'没有 {p}，跳过')
            continue
        im = Image.open(p).convert('RGB')
        k = im.width / res[0]                       # 预览序列（--scale 50）按比例画
        d = ImageDraw.Draw(im)
        for n, by in result.items():
            v = by.get(str(f))
            if not v:
                continue
            x, y, r = v[0] * k, v[1] * k, max(v[2] * k, 6)
            d.ellipse([x - r, y - r, x + r, y + r], outline=(40, 255, 90), width=max(2, int(3 * k)))
            d.line([x - 8, y, x + 8, y], fill=(40, 255, 90), width=2)
            d.line([x, y - 8, x, y + 8], fill=(40, 255, 90), width=2)
            d.text((x + r + 6, y - 8), n, fill=(40, 255, 90))
        d.text((10, 10), f'{f}', fill=(255, 255, 255))
        tiles.append(im.resize((960, round(960 * im.height / im.width))))
    if not tiles:
        print('--check：一张序列帧都没找到')
        return
    sheet = Image.new('RGB', (960 * len(tiles), max(t.height for t in tiles)))
    for i, t in enumerate(tiles):
        sheet.paste(t, (960 * i, 0))
    Path(a.check).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(a.check, quality=88)
    print(a.check)


if __name__ == '__main__':
    main()

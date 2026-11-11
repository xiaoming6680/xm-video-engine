"""比对两组序列帧，找出渲染出错的帧（普通 Python，不用 Blender）。

  python tools/blender/verify_frames.py assets/blender4k/x assets/blender/x [--limit 0.2] [--json 坏帧.json]

Cycles 连续渲几千帧时，偶尔整段材质变黑（白变黑），事后很难靠抽帧发现。这里按文件名配对，缩小后比白、红、黑的面积占比，
差异超过 --limit 的帧连成段打印出来；再用 render.py --from --to --force 重渲。参照组可以是另一遍低分辨率渲染，也可以是已验证的版本。
只抓大面积变色，抓不到局部小错。颜色门限按红白黑的片子定的，别的配色改 frac()。
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np


def frac(path):
    im = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_COLOR)
    im = cv2.resize(im, (160, 90), interpolation=cv2.INTER_AREA).astype(int)
    white = ((im[:, :, 0] > 170) & (im[:, :, 1] > 170) & (im[:, :, 2] > 170)).mean()
    red = ((im[:, :, 2] > 150) & (im[:, :, 1] < 80)).mean()
    black = (im.max(axis=2) < 60).mean()
    return np.array([white, red, black])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("a")
    ap.add_argument("b")
    ap.add_argument("--limit", type=float, default=0.2)
    ap.add_argument("--json", default="")
    args = ap.parse_args()
    bad, n = [], 0
    for pa in sorted(Path(args.a).glob("*.png")):
        pb = Path(args.b) / pa.name
        if not pb.exists():
            continue
        n += 1
        if float(np.abs(frac(pa) - frac(pb)).max()) > args.limit:
            bad.append(int(pa.stem))
    runs = []
    for f in bad:
        if runs and f == runs[-1][1] + 1:
            runs[-1][1] = f
        else:
            runs.append([f, f])
    print(f"比了 {n} 帧，差异大的 {len(bad)} 帧，分 {len(runs)} 段：{runs}")
    if args.json:
        Path(args.json).write_text(json.dumps(runs), encoding="utf-8")


if __name__ == "__main__":
    main()

"""清晰度粗测（docs/发布.md「审核通知」那一节的口径）：缩到 640×360、每秒取 2 帧，算灰度拉普拉斯方差（越低越糊），
打印中位数和各段的值。机审具体怎么判不公开，这只是个相对指标：同一套口径下比版本之间的高低。

    python tools/sharpness.py out/falling_again_抖音版.mp4 [--vf "unsharp=9:9:0.8"] [--per 4]

--vf 在缩小之前先过一道 ffmpeg 滤镜（试锐化用）；--per 每隔多少秒打印一段的中位数。
"""
import argparse
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ffmpeg_path import FFMPEG  # noqa: E402
W, H, RATE = 640, 360, 2


def measure(path, vf=None):
    chain = (f"{vf}," if vf else "") + f"fps={RATE},scale={W}:{H}:flags=area,format=gray"
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", path, "-vf", chain, "-f", "rawvideo", "-"],
                         capture_output=True, check=True).stdout
    frames = np.frombuffer(raw, np.uint8).reshape(-1, H, W).astype(np.float32)
    return np.array([ndimage.laplace(f).var() for f in frames])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--vf")
    ap.add_argument("--per", type=float, default=0)
    a = ap.parse_args()
    v = measure(a.video, a.vf)
    print(f"median {np.median(v):.0f}  (p10 {np.percentile(v, 10):.0f}, p90 {np.percentile(v, 90):.0f}, {len(v)} frames)")
    if a.per:
        n = int(a.per * RATE)
        print("  ".join(f"{i / RATE:.0f}s:{np.median(v[i:i + n]):.0f}" for i in range(0, len(v), n)))


if __name__ == "__main__":
    main()

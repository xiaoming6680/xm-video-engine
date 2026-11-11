"""长曝光叠帧：把一段视频的每一帧叠成一张图，运动路径一眼能看出连没连上（断掉的地方是一段段散点，连贯的是一条线）。

  python tools/qa/trail.py 视频.mp4 --from 1.4 --to 2.6 [--mode onion|max] [--every 2] [--ref 参考.mp4 --ref-start 0] -o out/qa/trail.png

  onion（默认）每 --every 帧取一帧，按时间从蓝到红上色叠在一起（看方向和间距：间距均匀 = 匀速，越来越密 = 在减速）
  max           每帧取最亮（真正的长曝光，亮的东西走过的路径整条留下）
  --ref         参考视频同一段并排在上面
--segs a:b,c:d 一次出几段（每段一行）。
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
from frames import decode  # noqa: E402


def _font(px: int):
    for f in ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/consola.ttf"):
        try:
            return ImageFont.truetype(f, px)
        except OSError:
            pass
    return ImageFont.load_default()


def exposure(path: str, a: float, b: float, mode: str, every: int, w: int) -> Image.Image:
    h = round(w * 9 / 16)
    fr = decode(path, a, b - a, 30, (w, h), gray=False).astype(np.float32) / 255
    if not len(fr):
        return Image.new("RGB", (w, h))
    if mode == "max":
        img = fr.max(axis=0)
    else:
        sel = fr[::every]
        n = len(sel)
        base = fr.mean(axis=0) * 0.35
        img = base.copy()
        for i, f in enumerate(sel):
            u = i / max(1, n - 1)
            tint = np.array([0.25 + 0.75 * u, 0.35, 1.0 - 0.75 * u], dtype=np.float32)
            lum = f.mean(axis=2, keepdims=True)
            # what differs from the average (what moves) gets the time colour
            diff = np.abs(f - fr.mean(axis=0)).mean(axis=2, keepdims=True)
            img = np.maximum(img, np.clip(diff * 2.2, 0, 1) * tint * np.clip(lum * 1.4 + 0.3, 0, 1))
    return Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--from", dest="from_", type=float, default=0.0)
    ap.add_argument("--to", type=float)
    ap.add_argument("--segs", help="几段一起：a:b,c:d")
    ap.add_argument("--mode", choices=["onion", "max"], default="onion")
    ap.add_argument("--every", type=int, default=2)
    ap.add_argument("--width", type=int, default=640)
    ap.add_argument("--ref")
    ap.add_argument("--ref-start", type=float, default=0.0)
    ap.add_argument("-o", "--out", default="out/qa/trail.png")
    a = ap.parse_args()

    segs = [tuple(map(float, s.split(":"))) for s in a.segs.split(",")] if a.segs else [(a.from_, a.to if a.to else a.from_ + 2)]
    rows = []
    for s0, s1 in segs:
        ours = exposure(a.video, s0, s1, a.mode, a.every, a.width)
        tiles = [("我们", ours)]
        if a.ref:
            tiles.insert(0, ("参考", exposure(a.ref, a.ref_start + s0, a.ref_start + s1, a.mode, a.every, a.width)))
        w, h = ours.size
        row = Image.new("RGB", (w * len(tiles), h + 22), (20, 20, 20))
        d = ImageDraw.Draw(row)
        for i, (lab, im) in enumerate(tiles):
            row.paste(im, (i * w, 22))
            d.text((i * w + 6, 2), f"{lab} {s0:.2f}–{s1:.2f}s  {a.mode}（蓝→红 = 先→后）", fill=(255, 220, 0), font=_font(14))
        rows.append(row)
    W = max(r.width for r in rows)
    sheet = Image.new("RGB", (W, sum(r.height for r in rows)), (20, 20, 20))
    y = 0
    for r in rows:
        sheet.paste(r, (0, y))
        y += r.height
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(a.out)
    print(a.out)


if __name__ == "__main__":
    main()

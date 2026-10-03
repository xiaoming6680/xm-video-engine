"""目标帧和渲染帧左右拼在一起，方便逐项对照（docs/方法.md 第一节）。

用法：
  python tools/compare.py 目标.png 渲染.png -o out/wip/compare.png [--height 720] [--diff]

两张图缩放到同一高度并排；--diff 再在右边加一张亮度差异图（越亮差得越多）。
"""
import argparse
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def fit(img: Image.Image, h: int) -> Image.Image:
    w = round(img.width * h / img.height)
    return img.convert("RGB").resize((w, h), Image.LANCZOS)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("render")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--diff", action="store_true")
    a = ap.parse_args()

    tgt, ren = fit(Image.open(a.target), a.height), fit(Image.open(a.render), a.height)
    panels = [("target", tgt), ("render", ren)]
    if a.diff:
        # 差异图按渲染图的尺寸比较，目标图先缩放到同样大小
        t = np.asarray(tgt.resize(ren.size, Image.LANCZOS), dtype=np.float32)
        r = np.asarray(ren, dtype=np.float32)
        lum = lambda x: x @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
        d = np.clip(np.abs(lum(t) - lum(r)) * 2.0, 0, 255).astype(np.uint8)
        panels.append(("luma diff", Image.fromarray(d).convert("RGB")))

    gap = 8
    W = sum(p.width for _, p in panels) + gap * (len(panels) - 1)
    sheet = Image.new("RGB", (W, a.height + 28), (24, 24, 24))
    draw = ImageDraw.Draw(sheet)
    x = 0
    for label, p in panels:
        sheet.paste(p, (x, 28))
        draw.text((x + 6, 6), label, fill=(220, 220, 220))
        x += p.width + gap
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(a.out)
    print(a.out)


if __name__ == "__main__":
    main()

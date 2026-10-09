"""发布封面：从 4K 静帧裁出横 4:3、竖 3:4 两张（抖音），或加 --bili 只出一张 16:9（B 站），压一组排版（和以前的封面同一套：宋体主文案、
字距拉开的英文小字、一条细线、BY 署名；署名默认取 app/src/config.ts 的 CREDIT，没填就不印）。

    cd app && bun scripts/render.ts stills --scale 2 --samples 16 --t 59.5 --out ../out/covers/src && cd ..
    python tools/cover_title.py out/covers/src/f_0059.50.png --line1 闪电劈进沙漠 --line2 会留下什么？

--cx 是裁切中心（占画面宽度的比例），让主体在两张图里都落在中间；--at top 把文字放到上方（主体在下半部分时用）。
竖版文字整体在底部 13% 以上，抖音主页网格的点赞数不会盖住；横版矮，文字块压到底部 7% 以上。
B 站 16:9 是整幅不裁，文字块收小、压到底部 6% 以上：中间留给画面；推荐卡片的播放数和时长在左右两角，不会碰到居中的字。
"""
import argparse
import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
FONTS = ROOT / "app/public/fonts"
SERIF = FONTS / "NotoSerifSC-600.ttf"
CAPS = FONTS / "Archivo-w1125-500.ttf"
SANS = FONTS / "NotoSansSC-500.ttf"  # 标签里有中文时用
# 封面调色板（docs/方向提案.md）：粉白、丁香
WHITE = (246, 240, 250)
LILAC = (201, 186, 238)


def blur3(img, s):
    return np.stack([ndimage.gaussian_filter(img[..., k], s) for k in range(3)], -1)


def grade(img):
    """轻调：提一点局部反差，四周压暗，把视线收到主体上。"""
    h, w = img.shape[:2]
    img = img + 0.25 * (img - blur3(img, w * 0.03))
    img = np.clip(img, 0, 1) ** 1.1
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.hypot(xx / w - 0.5, (yy / h - 0.5) * 0.8)
    img = img * (1 - 0.45 * np.clip((r - 0.3) / 0.4, 0, 1) ** 1.5)[..., None]
    return np.clip(img, 0, 1)


def spaced(draw, x, y, text, font, fill, tracking):
    """逐字画，字间距 = tracking × 字号；x 是整行的水平中心，y 是这一行墨迹的顶边。"""
    widths = [draw.textlength(ch, font=font) for ch in text]
    gap = tracking * font.size
    total = sum(widths) + gap * (len(text) - 1)
    cx = x - total / 2
    y -= font.getbbox(text)[1]
    for ch, w in zip(text, widths):
        draw.text((cx, y), ch, font=font, fill=fill)
        cx += w + gap


def ink(font, text):
    b = font.getbbox(text)
    return b[3] - b[1]


def credit():
    """app/src/config.ts 的 CREDIT（角落署名）：封面默认的 BY 行。没填就是空，不印。"""
    p = Path(__file__).resolve().parent.parent / "app" / "src" / "config.ts"
    m = re.search(r"export const CREDIT = '([^']*)'", p.read_text(encoding="utf-8")) if p.exists() else None
    return f"BY {m.group(1)}" if m and m.group(1) else ""


def make(src, aspect, size, cx, a, top, bottom, k):
    W, H = src.size
    cw = round(H * aspect[0] / aspect[1])
    x0 = min(max(round(cx * W - cw / 2), 0), W - cw)
    im = src.crop((x0, 0, x0 + cw, H)).resize(size, Image.LANCZOS)
    w, h = size
    img = grade(np.asarray(im, np.float32) / 255)

    u = min(w, h)
    cjk = any("一" <= ch <= "鿿" for ch in a.tag)
    f_tag = ImageFont.truetype(str(SANS if cjk else CAPS), round(u * k * (0.026 if cjk else 0.024)))
    f_main = ImageFont.truetype(str(SERIF), round(u * k * 0.08))
    f_by = ImageFont.truetype(str(CAPS), round(u * k * 0.021))
    m = f_main.size
    # 自上而下：(种类, 文字, 字体, 下方留白)，按墨迹的实际高度排
    items = [("text", a.tag, f_tag, 0.6 * m)] if a.tag else []
    lines = [t for t in (a.line1, a.line2) if t]
    for i, t in enumerate(lines):
        items.append(("text", t, f_main, (0.62 if i == len(lines) - 1 else 0.36) * m))
    if a.by:
        items += [("rule", None, None, 0.5 * m), ("text", a.by, f_by, 0)]
    heights = [ink(f, t) if k == "text" else 1 for k, t, f, _ in items]
    block = sum(heights) + sum(gap for *_, gap in items)
    y = h * top if a.at == "top" else h * bottom - block

    # 文字后面压一片柔和的暗，字落在画面上更稳
    yy = np.arange(h)[:, None]
    band = np.exp(-(((yy - (y + block / 2)) / (block * 0.95)) ** 2)) * np.ones((1, w))
    img = img * (1 - 0.35 * band)[..., None]
    im = Image.fromarray((img * 255 + 0.5).astype(np.uint8))

    d = ImageDraw.Draw(im)
    for (kind, text, font, gap), hgt in zip(items, heights):
        if kind == "rule":
            r = u * 0.09
            d.line([(w / 2 - r / 2, y), (w / 2 + r / 2, y)], fill=LILAC, width=max(1, round(u * 0.0016)))
        else:
            big = font is f_main
            tr = 0.12 if big else 0.3 if font is f_tag and cjk else 0.42
            spaced(d, w / 2, y, text, font, WHITE if big else LILAC, tr)
        y += hgt + gap
    return im


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("still")
    ap.add_argument("--cx", type=float, default=0.5)
    ap.add_argument("--line1", required=True, help="主文案第一行")
    ap.add_argument("--line2", default="")
    ap.add_argument("--tag", default="", help="上方小字，如 'FALLING AGAIN · NURKO, RONIIT'")
    ap.add_argument("--by", default=credit(), help="底部署名，默认 'BY ' + config.ts 的 CREDIT")
    ap.add_argument("--at", default="bottom", choices=["bottom", "top"])
    ap.add_argument("--name", default="", help="输出文件名的后缀")
    ap.add_argument("--out", default="out/covers/发布")
    ap.add_argument("--bili", action="store_true", help="只出 B 站 16:9 封面（1920×1080）")
    a = ap.parse_args()

    src = Image.open(a.still).convert("RGB")
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    jobs = [
        # (文件名, 比例, 尺寸, 放上方时的顶边, 放下方时的底边, 字号倍数)：横版矮，文字块往下压、字收小一点，免得压到地平线
        (f"横封面_4x3{a.name}.jpg", (4, 3), (1600, 1200), 0.1, 0.93, 0.9),
        (f"竖封面_3x4{a.name}.jpg", (3, 4), (1200, 1600), 0.09, 0.87, 1.0),
    ]
    if a.bili:
        jobs = [(f"B站封面_16x9{a.name}.jpg", (16, 9), (1920, 1080), 0.1, 0.94, 0.72)]
    for name, aspect, size, top, bottom, k in jobs:
        im = make(src, aspect, size, a.cx, a, top, bottom, k)
        im.save(out / name, quality=95, subsampling=0)
        print(out / name)


if __name__ == "__main__":
    main()

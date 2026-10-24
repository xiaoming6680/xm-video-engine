"""字体对比图：同一段字用 N 款字体排成一张，每格标号和字体名，深色底，可加发光——标题 / 品牌字拿不准时先出这张让用户挑。

  # 英文签名 / 标题，横排
  python tools/font_sheet.py --text "If The Sun Burns Out" --font app/public/fonts/BigShouldersDisplay-Black.ttf --font Mistral --font "Segoe UI Variable Display" -o out/fonts/title.jpg
  # 中文竖排，加发光；字取歌词第 12 行的译文（--zh；不加取原文），字不出现在命令行和输出里
  python tools/font_sheet.py --lyric 12 --zh --vertical --glow 0.8 --dir app/public/fonts --font 华文行楷 -o out/fonts/zh.jpg
  # 一个目录里的全部字体（含子目录），每行 3 格
  python tools/font_sheet.py --text "冠军" --dir "C:/Windows/Fonts" --match "*hei*" --cols 3 -o out/fonts/hei.jpg

--font 可以是文件路径、文件名或字体族名（在 app/public/fonts、C:/Windows/Fonts、用户字体目录里找文件名或字体内的名字），
.ttc 用 路径#序号 选其中一款；可变字体用 名字@实例 选命名实例（SegUIVar.ttf@Semibold Display），或写 族名 + 实例词
（"Segoe UI Variable Display"：带 Display 的实例每个一格）。缺字的字体在格子里标「缺 N 字」（要 fontTools）。
基础引擎只放 OFL 字体；商业字体（苹方、Mistral、华文行楷……）只在具体项目里用：挑定后复制到项目的
app/public/fonts/src/zh/（中文，analysis/make_fonts_zh.py 按片中用字裁子集）或 app/public/fonts/（英文），再登记 config.ts 的 EXTRA_FONTS。
"""
import argparse
import fnmatch
import json
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT_DIRS = [ROOT / "app" / "public" / "fonts", Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts",
             Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "Windows" / "Fonts"]
EXTS = (".ttf", ".otf", ".ttc")
LABEL_FONTS = ["msyh.ttc", "NotoSansSC-500.ttf", "segoeui.ttf", "arial.ttf"]


def hexrgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def font_files(dirs):
    for d in dirs:
        if d.is_dir():
            for p in d.rglob("*"):
                if p.suffix.lower() in EXTS:
                    yield p


def family_names(path, index=0):
    """字体里的族名 / 全名，和可变字体的命名实例。"""
    try:
        from fontTools.ttLib import TTFont
        f = TTFont(path, fontNumber=index, lazy=True)
        names = {r.toUnicode() for r in f["name"].names if r.nameID in (1, 4, 16, 17)}
        insts = [f["name"].getDebugName(i.subfamilyNameID) for i in f["fvar"].instances] if "fvar" in f else []
        f.close()
        return names, [i for i in insts if i]
    except Exception:
        return set(), []


def resolve(spec):
    """--font 的值 → [(路径, ttc 序号, 可变字体的实例名或 None)]。"""
    spec, _, inst = spec.partition("@")
    path, _, idx = spec.partition("#")
    idx, inst = int(idx or 0), inst or None
    for p in (Path(path), ROOT / path):
        if p.exists():
            return [(p, idx, inst)]
    files = list(font_files(FONT_DIRS))
    low = path.lower()
    hit = [f for f in files if f.name.lower() == low or f.stem.lower() == low]
    if hit:
        return [(hit[0], idx, inst)]
    for f in files:                                     # 按字体里的名字找（慢：只在文件名找不到时）
        names, insts = family_names(f, idx)
        for n in names:
            n = n.lower()
            if n == low:
                return [(f, idx, inst)]
            if insts and low.startswith(n + " "):       # 族名 + 实例词：每个含这些词的实例一格
                want = set(low[len(n):].split())
                got = [i for i in insts if want <= set(i.lower().split())]
                if got:
                    return [(f, idx, i) for i in got]
    print(f"找不到字体：{spec}", file=sys.stderr)
    return []


def missing(path, idx, text):
    try:
        from fontTools.ttLib import TTFont
        f = TTFont(path, fontNumber=idx, lazy=True)
        cmap = f.getBestCmap() or {}
        f.close()
        return sorted({c for c in text if not c.isspace() and ord(c) not in cmap})
    except Exception:
        return []


def label_font(px):
    for n in LABEL_FONTS:
        for d in FONT_DIRS:
            if (d / n).exists():
                return ImageFont.truetype(str(d / n), px)
    return ImageFont.load_default()


def draw_text(path, idx, inst, text, size, vertical, color):
    """一款字体排出的字：RGBA，透明底。竖排逐字往下排（字身 1.05 倍行距），横排一行或按换行多行。"""
    f = ImageFont.truetype(str(path), size, index=idx)
    if inst:
        f.set_variation_by_name(inst)
    pad = size // 3
    if vertical:
        chars = [c for c in text if not c.isspace()]
        step = int(size * 1.05)
        w, h = size + 2 * pad, step * len(chars) + 2 * pad
        im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        for i, c in enumerate(chars):
            d.text((w / 2, pad + i * step + step / 2), c, font=f, fill=color + (255,), anchor="mm")
        return im
    lines = text.split("\\n") if "\\n" in text else text.split("\n")
    boxes = [f.getbbox(l or " ") for l in lines]
    lh = int(size * 1.2)
    w = max(b[2] - min(0, b[0]) for b in boxes) + 2 * pad
    h = lh * len(lines) + 2 * pad
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for i, l in enumerate(lines):
        d.text((pad, pad + i * lh + lh / 2), l, font=f, fill=color + (255,), anchor="lm")
    return im


def glowed(im, amount, color, size):
    """字下面垫一层模糊的光（两档半径：贴字的亮边 + 外面的晕）。"""
    if amount <= 0:
        return im
    a = im.split()[3]
    out = Image.new("RGBA", im.size, (0, 0, 0, 0))
    for r, k in ((size * 0.06, 0.9), (size * 0.22, 0.6)):
        m = a.filter(ImageFilter.GaussianBlur(r)).point(lambda v, k=k: min(255, int(v * k * amount * 1.6)))
        layer = Image.new("RGBA", im.size, color + (0,))
        layer.putalpha(m)
        out = Image.alpha_composite(out, layer)
    return Image.alpha_composite(out, im)


def lyric_text(n, zh):
    data = json.loads((ROOT / "data" / "lyrics.json").read_text(encoding="utf-8"))
    lines = data["lines"] if isinstance(data, dict) else data
    ln = lines[n]
    t = ln.get("zh") if zh else ln.get("text")
    if not t:
        raise SystemExit(f"第 {n} 行没有{'译文 zh' if zh else '原文'}")
    return t


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--text", help="要排的字（\\n 换行）")
    ap.add_argument("--lyric", type=int, help="用 data/lyrics.json 第 N 行（从 0 数）的字，不在命令行里写歌词")
    ap.add_argument("--zh", action="store_true", help="--lyric 取译文（Line.zh）")
    ap.add_argument("--font", action="append", default=[], help="字体文件 / 文件名 / 字体族名，可重复；.ttc 用 路径#序号")
    ap.add_argument("--dir", action="append", default=[], help="这个目录（含子目录）里的全部字体")
    ap.add_argument("--match", help="--dir 里只取文件名匹配这个通配的（例 *Sans*）")
    ap.add_argument("--vertical", action="store_true", help="竖排（中文）")
    ap.add_argument("--size", type=int, default=110, help="字号（像素，默认 110）")
    ap.add_argument("--cols", type=int, default=0, help="每行几格（默认：竖排 6、横排 2）")
    ap.add_argument("--bg", default="#0c0c10", help="底色")
    ap.add_argument("--color", default="#f2efe8", help="字色")
    ap.add_argument("--glow", type=float, default=0.0, help="发光强度 0–1（0 = 不发光）")
    ap.add_argument("--glow-color", default="#ffb84a", help="发光颜色")
    ap.add_argument("-o", "--out", required=True)
    a = ap.parse_args()
    text = lyric_text(a.lyric, a.zh) if a.lyric is not None else a.text
    if not text:
        ap.error("要 --text 或 --lyric")
    fonts = [x for s in a.font for x in resolve(s)]
    for d in a.dir:
        fonts += [(p, 0, None) for p in sorted(font_files([Path(d)])) if not a.match or fnmatch.fnmatch(p.name.lower(), a.match.lower())]
    if not fonts:
        ap.error("没有字体（--font / --dir）")
    color, gcol, bg = hexrgb(a.color), hexrgb(a.glow_color), hexrgb(a.bg)
    tiles = []
    for i, (p, idx, inst) in enumerate(fonts, 1):
        try:
            im = glowed(draw_text(p, idx, inst, text, a.size, a.vertical, color), a.glow, gcol, a.size)
        except (OSError, ValueError) as e:
            print(f"读不了 {p}：{e}", file=sys.stderr)
            continue
        miss = missing(p, idx, text)
        tiles.append((i, p.name + (f"#{idx}" if idx else "") + (f"@{inst}" if inst else ""), im, len(miss)))
    cols = a.cols or (6 if a.vertical else 2)
    big, small = label_font(34), label_font(18)
    lab = lambda i, name, nmiss: name + (f"  缺 {nmiss} 字" if nmiss else "")
    cw = max(max(t[2].width for t in tiles) + 40, max(int(small.getlength(lab(*t[:2], t[3]))) + 28 * len(str(t[0])) + 50 for t in tiles))
    ch = max(t[2].height for t in tiles) + 70
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cw * min(cols, len(tiles)), ch * rows), bg)
    d = ImageDraw.Draw(sheet)
    for k, (i, name, im, nmiss) in enumerate(tiles):
        x, y = (k % cols) * cw, (k // cols) * ch
        d.rectangle([x + 6, y + 6, x + cw - 6, y + ch - 6], outline=(60, 60, 68), width=1)
        sheet.paste(im, (x + (cw - im.width) // 2, y + 56 + (ch - 70 - im.height) // 2), im)
        d.text((x + 16, y + 12), f"{i}", font=big, fill=(255, 200, 80))
        d.text((x + 16 + 26 * len(str(i)) + 12, y + 22), lab(i, name, nmiss), font=small,
               fill=(255, 110, 90) if nmiss else (150, 150, 160))
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(a.out, quality=90)
    for k, (i, name, _, nmiss) in enumerate(tiles):
        print(f"{i:>2}  {name}" + (f"  （缺 {nmiss} 字）" if nmiss else ""))
    print(a.out)


if __name__ == "__main__":
    main()

# Chinese fonts (app/src/engine/lang.ts: every Latin family falls back to them glyph by glyph): Noto Sans SC and
# Noto Serif SC (SIL OFL), subset to the characters the video prints in Chinese and instanced at the weights it
# draws (lang.ts CJK_FAMILIES). The characters come from the lyrics the app loads (data/lyrics.json or
# lyrics.approx.json: the lines and their translations, Line.zh; an older-style data/lyrics.zh.json too, if there
# is one; an instrumental has none of them) and from every string literal with Chinese in it under app/src (scene
# text, the watermark).
# Only U+2000 and up are kept (CJK, full-width punctuation, “ ” ‘ ’ … —): Latin, digits and spaces come from
# the video's own families (Archivo, IBM Plex Mono, Cormorant), which the Chinese faces stand behind.
# Rerun after changing any Chinese text:
#   uv run --no-project --with fonttools python make_fonts_zh.py [--gb2312] [--extra <font>[#n]]… [NotoSansSC[wght].ttf] [NotoSerifSC[wght].ttf]
# (defaults: the copies Windows 11 ships in C:\Windows\Fonts; Google Fonts has the same files)
# --gb2312: also keep every GB2312 character (larger files, for work in progress: new text needs no rerun).
# A project's own Chinese display faces (a brush script for the translation, a face the user picked from
# tools/font_sheet.py — 马善政, PingFang, 华文行楷…): every .ttf / .otf / .ttc in app/public/fonts/src/zh/, and each
# --extra file (#n: the face in a .ttc), is cut to the same characters plus printable ASCII and saved as
# app/public/fonts/<file name>.ttf (a variable face keeps its axes); register it in src/config.ts EXTRA_FONTS.
# Commercial faces only ever go into that project, never into the base engine (OFL only here).
import io
import json
import re
import sys
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "public" / "fonts"
GB2312 = "--gb2312" in sys.argv
ARGS, EXTRA = [], []
argv = sys.argv[1:]
for i, a in enumerate(argv):
    if a == "--extra" and i + 1 < len(argv):
        EXTRA.append(argv[i + 1])
    elif not a.startswith("--") and not (i and argv[i - 1] == "--extra"):
        ARGS.append(a)
ZH_SRC = ROOT / "app" / "public" / "fonts" / "src" / "zh"
if ZH_SRC.is_dir():
    EXTRA += [str(p) for p in sorted(ZH_SRC.iterdir()) if p.suffix.lower() in (".ttf", ".otf", ".ttc")]
SRC = {
    "NotoSansSC": Path(ARGS[0]) if len(ARGS) > 0 else Path(r"C:\Windows\Fonts\NotoSansSC-VF.ttf"),
    "NotoSerifSC": Path(ARGS[1]) if len(ARGS) > 1 else Path(r"C:\Windows\Fonts\NotoSerifSC-VF.ttf"),
}
WEIGHTS = {"NotoSansSC": [300, 400, 500, 700, 900], "NotoSerifSC": [400, 600]}


def strings(x):
    """Every string in a JSON document."""
    if isinstance(x, str):
        yield x
    elif isinstance(x, dict):
        for v in x.values():
            yield from strings(v)
    elif isinstance(x, list):
        for v in x:
            yield from strings(v)


def han(s):
    return any(0x3000 <= ord(c) <= 0x9FFF or 0xF900 <= ord(c) <= 0xFFEF for c in s)


LITERAL = re.compile(r"'(?:\\.|[^'\\\n])*'|\"(?:\\.|[^\"\\\n])*\"|`(?:\\.|[^`\\])*`")

LYRICS = [ROOT / "data" / n for n in ("lyrics.json", "lyrics.approx.json", "lyrics.zh.json")]  # 纯音乐都没有：只用 app/src 里的中文
texts = [s for p in LYRICS if p.exists() for s in strings(json.loads(p.read_text(encoding="utf-8")))]
for f in sorted((ROOT / "app" / "src").rglob("*.ts")):
    src = f.read_text(encoding="utf-8")
    texts += [m for m in LITERAL.findall(src) if han(m)]
chars = {c for c in "".join(texts) if ord(c) >= 0x2000}
if GB2312:
    for hi in range(0xA1, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                c = bytes([hi, lo]).decode("gb2312")
            except UnicodeDecodeError:
                continue
            if ord(c) >= 0x2000:
                chars.add(c)
chars = sorted(chars)
print(len(chars), "characters:", "".join(chars) if not GB2312 else "(GB2312 and the video's)")

for name, src in SRC.items():
    f = TTFont(src)
    opts = Options()
    opts.name_IDs = ["*"]  # keep the copyright and license records
    opts.name_languages = ["*"]
    opts.layout_features = ["*"]
    sub = Subsetter(opts)
    sub.populate(unicodes=[ord(c) for c in chars])
    sub.subset(f)
    buf = io.BytesIO()
    f.save(buf)
    for wt in WEIGHTS[name]:
        inst = instancer.instantiateVariableFont(TTFont(io.BytesIO(buf.getvalue())), {"wght": wt}, updateFontNames=False)
        out = OUT / f"{name}-{wt}.ttf"
        inst.save(out)
        print(out.name, out.stat().st_size // 1024, "KB")

for spec in EXTRA:
    path, _, n = spec.partition("#")
    src = Path(path)
    f = TTFont(src, fontNumber=int(n or 0))
    opts = Options()
    opts.name_IDs = ["*"]
    opts.name_languages = ["*"]
    opts.layout_features = ["*"]
    sub = Subsetter(opts)
    sub.populate(unicodes=[ord(c) for c in chars] + list(range(0x20, 0x7F)))
    sub.subset(f)
    out = OUT / f"{src.stem}{'-' + n if n else ''}.ttf"
    f.save(out)
    print(out.name, out.stat().st_size // 1024, "KB")

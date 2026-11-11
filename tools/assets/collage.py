"""Photos and cut-outs into collage pieces -> assets/collage/ (the offline half of app/src/library/engine/paper.ts 「拼贴」).

参考 mg-styles-15 demos/06-collage/work/prep.py（MIT，Vincentwei1021）重写。为什么离线做：照片的真半调、剪刀白边要逐像素算，
大图在浏览器里每次启动算一遍太慢；做成 PNG 后场景里当贴纸用（paper.ts sprite / drawLifted）。

  halftone  --halftone mono (default): one ink, 6.5 px dots at 45°, 30 % of the continuous tone left under the dots
            (newspaper repro); cmyk: four screens (15/75/0/45°) mixed 60 % with the original; none
  edge      --edge scissor (default): cut out along the alpha: cleaned (opened), grown by --rim px (the white border),
            closed (scissors can't get into narrow gaps), traced, straightened into facets (approxPolyDP), corners
            nudged ±0.7 px, filled at 3x. torn: the picture (no alpha needed: a photo, a page) torn out as a rectangle,
            four octaves of sines along every edge plus a white fibrous rim of uneven width. none: alpha as it is
  puppet    --cut "x,y x,y ...": sliced along that line (left to right) into a top and a bottom piece in the same frame
            (a lid, a jaw); --hinge x,y (the brass brad) goes into the layout with the cut. Coordinates are px of the
            resized picture (--h / --w), before the padding; the layout has them in piece px

Writes assets/collage/NAME.png (puppet: NAME_top.png and NAME_bottom.png too) and NAME.json: {w, h, pad, outline,
cut, hinge}, all in piece px (origin top left; outline = the cut edge, for kit/morph.ts PathWalk). The app serves
them at /assets/collage/ (vite.config.ts repo-assets). Deterministic (--seed).

  python tools/assets/collage.py art/raw/moon.png --h 520 --rim 6
  python tools/assets/collage.py refs/page.jpg --edge torn --halftone none --w 760 --name news_a
  python tools/assets/collage.py art/raw/bust.png --h 900 --cut "40,300 300,290 620,305" --hinge 70,296
  python tools/assets/collage.py art/raw/rose.png --halftone cmyk --period 6 --rim 5
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path.cwd()  # run from the project root
OUT = ROOT / "assets" / "collage"
PAPER_W = np.array([244, 239, 228], np.float32) / 255  # the white of the stock (rims, fibres)
INK = np.array([28, 24, 20], np.float32) / 255
SS = 3  # supersampling for cut edges


# ---------------------------------------------------------------- halftone
def lum(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] * 0.3 + rgb[..., 1] * 0.59 + rgb[..., 2] * 0.11


def spot(h: int, w: int, period: float, angle: float) -> np.ndarray:
    """AM screen spot function, 0..1 cosine dots `period` px apart, rotated `angle` degrees (paper.ts screenSpot)."""
    y, x = np.mgrid[0:h, 0:w].astype(np.float32) + 0.5
    a = np.deg2rad(angle)
    u = (x * np.cos(a) + y * np.sin(a)) / period
    v = (-x * np.sin(a) + y * np.cos(a)) / period
    return (np.cos(2 * np.pi * u) + np.cos(2 * np.pi * v)) * 0.25 + 0.5


def screen(cov: np.ndarray, period: float, angle: float) -> np.ndarray:
    """Ink 0..1 of a tone `cov` through the screen, dot edges anti-aliased over ~1.6 px."""
    return np.clip((cov - spot(cov.shape[0], cov.shape[1], period, angle)) / (1.6 / period) + 0.5, 0, 1)


def halftone_mono(rgb, period=6.5, angle=45.0, lo=0.06, hi=0.93, gamma=0.95, tone=0.3, tint=(0.93, 0.88, 0.78)):
    L = np.clip((lum(rgb) - lo) / (hi - lo), 0, 1) ** gamma
    ink = screen(1 - L, period, angle)[..., None]
    paper = PAPER_W * np.array(tint, np.float32) / max(tint)
    base = paper * (1 - tone + tone * L[..., None])  # faint continuous tone under the dots
    return base * (1 - ink) + INK * ink


def halftone_cmyk(rgb, period=6.0, mix=0.6, sat=1.1):
    g = lum(rgb)[..., None]
    rgb = np.clip(g + (rgb - g) * sat, 0, 1)
    C, M, Y = 1 - rgb[..., 0], 1 - rgb[..., 1], 1 - rgb[..., 2]
    K = np.minimum(np.minimum(C, M), Y)
    den = 1 - K + 1e-5
    C, M, Y = (C - K) / den, (M - K) / den, (Y - K) / den
    out = np.ones_like(rgb) * PAPER_W
    for cov, ang, col in ((C, 15, (0.0, 0.62, 0.88)), (M, 75, (0.9, 0.12, 0.48)), (Y, 0, (1.0, 0.9, 0.05)), (K * 0.95, 45, (0.11, 0.1, 0.09))):
        ink = screen(cov, period, ang)[..., None]
        out = out * (1 - ink + ink * np.array(col, np.float32))
    return rgb * (1 - mix) + out * mix


# ---------------------------------------------------------------- edges
def disc(r: float) -> np.ndarray:
    r = max(1, int(round(r)))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def fill_poly(polys, h: int, w: int) -> np.ndarray:
    """Polygons (px) filled anti-aliased at SS x, 0..1."""
    m = np.zeros((h * SS, w * SS), np.uint8)
    cv2.fillPoly(m, [np.round(np.asarray(p, np.float64) * SS).astype(np.int32) for p in polys], 255, lineType=cv2.LINE_AA)
    return cv2.resize(m, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32) / 255


def scissor(alpha: np.ndarray, rim: float, close: float, eps: float, rng) -> tuple[np.ndarray, list]:
    """The scissor-cut shape around the picture's alpha and its facet outlines."""
    a = (alpha > 0.45).astype(np.uint8) * 255
    a = cv2.morphologyEx(a, cv2.MORPH_OPEN, disc(3))
    d = cv2.dilate(a, disc(rim)) if rim > 0 else a
    d = cv2.morphologyEx(d, cv2.MORPH_CLOSE, disc(close))
    cnts, _ = cv2.findContours(d, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    polys = []
    for cn in cnts:
        if cv2.contourArea(cn) < 80:
            continue
        ap = cv2.approxPolyDP(cn, eps, True)[:, 0, :].astype(np.float64) + 0.5
        polys.append(ap + rng.uniform(-0.7, 0.7, ap.shape))
    m = fill_poly(polys, *alpha.shape)
    return np.maximum(m, alpha * (cv2.dilate(a, np.ones((3, 3), np.uint8)) > 0)), polys


def torn_line(p0, p1, amp: float, rng, step=3.0, wave=260.0) -> np.ndarray:
    """Points from p0 to p1, ends pinned: four octaves of sines (wavelength wave, /3, /9, /27) + fine noise (paper.ts tornEdge)."""
    p0, p1 = np.asarray(p0, np.float64), np.asarray(p1, np.float64)
    L = float(np.hypot(*(p1 - p0)))
    n = max(2, int(np.ceil(L / step)))
    s = np.linspace(0, L, n + 1)
    off = np.zeros_like(s)
    for k, a in ((1, 1.0), (3, 0.5), (9, 0.25), (27, 0.12)):
        off += a * rng.uniform(0.6, 1.0) * np.sin(s * k * 2 * np.pi / wave + rng.uniform(0, 2 * np.pi))
    off += rng.normal(0, 0.15, s.shape)
    ta = min(L / 2, amp * 3)
    off *= np.clip(s / ta, 0, 1) * np.clip((L - s) / ta, 0, 1)
    nrm = np.array([-(p1 - p0)[1], (p1 - p0)[0]]) / L
    return p0 + np.outer(s / L, p1 - p0) + np.outer(off * amp, nrm)


def torn_rect(x0, y0, x1, y1, amp, rng):
    c = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    return np.vstack([torn_line(c[i], c[(i + 1) % 4], amp, rng)[:-1] for i in range(4)])


def torn(h: int, w: int, pad: int, amp: float, rim: float, rng) -> tuple[np.ndarray, np.ndarray, list]:
    """(paper mask, white rim mask, outline) of a rectangle torn out of an h x w picture placed `pad` px in."""
    paper = torn_rect(pad, pad, w - pad, h - pad, amp, rng)
    outer = torn_rect(pad - rim, pad - rim, w - pad + rim, h - pad + rim, amp * 1.1, rng)
    m, r = fill_poly([paper], h, w), fill_poly([outer], h, w)
    fib = cv2.GaussianBlur(rng.random((h, w)).astype(np.float32), (0, 0), 1.2)
    r = np.clip(r * (0.75 + 0.5 * fib), 0, 1)  # a fuzzy, uneven white (06 prep.py)
    # loose fibres poking out of the rim
    hairs = np.zeros((h * SS, w * SS), np.uint8)
    cen = np.array([w / 2, h / 2])
    for i in rng.choice(len(outer), size=min(len(outer), int(len(outer) / 6)), replace=False):
        p = outer[i]
        d = (p - cen) / (np.linalg.norm(p - cen) + 1e-6)
        ang = rng.uniform(-1.1, 1.1)
        d = np.array([d[0] * np.cos(ang) - d[1] * np.sin(ang), d[0] * np.sin(ang) + d[1] * np.cos(ang)])
        q = p + d * rng.uniform(2, 8)
        cv2.line(hairs, tuple(np.round((p - d * 1.5) * SS).astype(int)), tuple(np.round(q * SS).astype(int)), 200, max(1, int(SS * rng.uniform(0.5, 1.1))), cv2.LINE_AA)
    r = np.maximum(r, cv2.resize(hairs, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32) / 255)
    return m, r, [paper]


# ---------------------------------------------------------------- main
def parse_pts(s: str) -> list:
    return [[float(v) for v in p.split(",")] for p in s.split()]


def save(path: Path, rgba: np.ndarray) -> None:
    Image.fromarray(np.clip(rgba * 255 + 0.5, 0, 255).astype(np.uint8), "RGBA").save(path, optimize=True)


def run(a) -> None:
    rng = np.random.default_rng(a.seed)
    src = np.asarray(Image.open(a.src).convert("RGBA")).astype(np.float32) / 255
    if a.edge != "torn" and src[..., 3].min() < 0.99:  # crop to the picture
        ys, xs = np.where(src[..., 3] > 0.1)
        src = src[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    s = a.h / src.shape[0] if a.h else (a.w / src.shape[1] if a.w else 1.0)
    if s != 1.0:
        w, h = max(1, round(src.shape[1] * s)), max(1, round(src.shape[0] * s))
        src = cv2.resize(src, (w, h), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
    rgb, alpha = src[..., :3], src[..., 3]
    if a.halftone == "mono":
        rgb = halftone_mono(rgb, a.period, a.angle, tone=a.tone)
    elif a.halftone == "cmyk":
        rgb = halftone_cmyk(rgb, a.period, a.mix)
    rgb = np.clip(rgb, 0, 1)

    if a.edge == "torn":
        pad = int(np.ceil(a.amp * 2.6 + a.rim + 10))
        H, W = rgb.shape[0] + 2 * pad, rgb.shape[1] + 2 * pad
        pic = np.pad(rgb, ((pad, pad), (pad, pad), (0, 0)), mode="edge")
        m, r, outline = torn(H, W, pad + a.amp * 1.5, a.amp, a.rim, rng)
        a_out = np.maximum(m, r)
        out = np.dstack([pic * m[..., None] + PAPER_W * (1 - m[..., None]), a_out])
    else:
        close = a.close or a.rim * 3
        # room for the rim AND the closing: closer than that to the border, the erosion stops at it and leaves white
        # tabs where the picture comes nearest the edge (06 prep.py padded 3 rim + 4 and got them)
        pad = int(np.ceil(a.rim + close + 4)) if a.edge == "scissor" else 0
        pic = np.pad(np.dstack([rgb, alpha]), ((pad, pad), (pad, pad), (0, 0)))
        if a.edge == "scissor":
            m, outline = scissor(pic[..., 3], a.rim, close, a.eps or max(2.0, a.rim * 0.7), rng)
            pa = pic[..., 3:4]
            out = np.dstack([pic[..., :3] * pa + PAPER_W * (1 - pa), m])
        else:
            out, outline = pic, []
    H, W = out.shape[:2]
    name = a.name or Path(a.src).stem
    OUTD = Path(a.out) if a.out else OUT
    OUTD.mkdir(parents=True, exist_ok=True)
    save(OUTD / f"{name}.png", out)
    layout = {"w": W, "h": H, "pad": pad, "outline": [[round(float(x), 1), round(float(y), 1)] for p in outline for x, y in p]}
    if a.cut:
        cut = [[x + pad, y + pad] for x, y in parse_pts(a.cut)]
        cut = [[-W, cut[0][1]]] + cut + [[2 * W, cut[-1][1]]]  # run the cut off both sides
        above = fill_poly([cut + [[2 * W, -H], [-W, -H]]], H, W)
        save(OUTD / f"{name}_top.png", np.dstack([out[..., :3], out[..., 3] * above]))
        save(OUTD / f"{name}_bottom.png", np.dstack([out[..., :3], out[..., 3] * (1 - above)]))
        layout["cut"] = [[round(x, 1), round(y, 1)] for x, y in cut[1:-1]]
    if a.hinge:
        hx, hy = parse_pts(a.hinge)[0]
        layout["hinge"] = [hx + pad, hy + pad]
    (OUTD / f"{name}.json").write_text(json.dumps(layout), encoding="utf-8")
    print(f"{name}: {W}x{H} pad {pad}, {a.halftone} halftone, {a.edge} edge" + (", puppet top/bottom" if a.cut else ""))


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("src", nargs="+", help="input pictures (PNG with alpha for scissor; anything for torn)")
    p.add_argument("--name", help="output name (one input only; default: the file name)")
    p.add_argument("--out", help="output folder (default assets/collage)")
    p.add_argument("--h", type=float, help="resize to this height (px)")
    p.add_argument("--w", type=float, help="resize to this width (px)")
    p.add_argument("--halftone", choices=["mono", "cmyk", "none"], default="mono")
    p.add_argument("--period", type=float, default=6.5, help="dot pitch (px)")
    p.add_argument("--angle", type=float, default=45.0, help="mono screen angle (deg)")
    p.add_argument("--tone", type=float, default=0.3, help="mono: continuous tone left under the dots")
    p.add_argument("--mix", type=float, default=0.6, help="cmyk: how much of the screened picture")
    p.add_argument("--edge", choices=["scissor", "torn", "none"], default="scissor")
    p.add_argument("--rim", type=float, default=5.0, help="white border (scissor) / fibre rim (torn), px")
    p.add_argument("--close", type=float, default=0.0, help="scissor: gaps narrower than this are bridged (default 3 rim)")
    p.add_argument("--eps", type=float, default=0.0, help="scissor: facet tolerance px (default max(2, 0.7 rim))")
    p.add_argument("--amp", type=float, default=9.0, help="torn: size of the tear, px")
    p.add_argument("--cut", help='puppet: cut line "x,y x,y ..." left to right')
    p.add_argument("--hinge", help='puppet: the brad "x,y"')
    p.add_argument("--seed", type=int, default=606)
    a = p.parse_args()
    if a.name and len(a.src) > 1:
        p.error("--name needs a single input")
    for s in a.src:
        a1 = argparse.Namespace(**{**vars(a), "src": s})
        run(a1)


if __name__ == "__main__":
    main()

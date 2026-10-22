"""Turn Codex sticker art drawn on white (art/raw/NAME.png) into transparent stickers + outlines -> assets/props/.

  cutout   only near-white connected to the image border is background, so white inside the object stays; the edge
           gets a soft alpha from how far each pixel is from white, and the white is un-blended out of the edge colour
           (no white fringe). --see-through: every near-white patch wider than a few px goes too (window panes, a ring)
  trim     to the object plus a margin
  outline  alpha thresholded, grown by OUTLINE_PAD px, outermost contour simplified to SIMPLIFY px: a line can be
           sewn / walked around the sticker (kit/morph.ts PathWalk)

Writes assets/props/NAME.png and NAME.json ({w, h, outline: [[x, y], ...]}, pixels relative to the sticker centre);
the app serves them at /assets/props/ (vite.config.ts repo-assets).

  python tools/assets/props.py balloon chair        # art/raw/balloon.png, art/raw/chair.png
  python tools/assets/props.py "s_*"                # a glob over art/raw/
  python tools/assets/props.py window --see-through

For tools/codex_gen.py: one isolated object, centred, generous empty margin all round, plain pure white background.
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path.cwd()  # run from the project root
RAW = ROOT / "art" / "raw"
OUT = ROOT / "assets" / "props"
OUTLINE_PAD = 14
SIMPLIFY = 2.5


def cutout(rgb: np.ndarray, see_through: bool = False) -> np.ndarray:
    """RGBA with the border-connected white background removed (soft edge, white fringe pulled out)."""
    f = rgb.astype(np.float32)
    mn = f.min(axis=2)
    sat = f.max(axis=2) - mn
    whiteish = (mn > 232) & (sat < 22)
    lab, _ = ndimage.label(whiteish)
    border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    bg = np.isin(lab, list(border))
    if see_through:
        bg = whiteish & (ndimage.binary_opening(whiteish, iterations=2) | bg)
    # soft alpha in a thin band around the object: how far from white the pixel is
    near = ndimage.binary_dilation(bg, iterations=3) & ~bg
    a = np.where(bg, 0.0, 1.0)
    soft = np.clip((255 - mn) / 70, 0, 1)
    a = np.where(near, soft, a)
    a = ndimage.gaussian_filter(a, 0.6)
    a = np.where(bg & ~near, 0.0, a)
    # un-blend white from the edge pixels: c = a*obj + (1-a)*white -> obj = (c - (1-a)*255) / a
    obj = np.where(a[..., None] > 0.05, (f - (1 - a[..., None]) * 255) / np.maximum(a[..., None], 0.05), f)
    return np.dstack([np.clip(obj, 0, 255), a * 255]).astype(np.uint8)


def outline(alpha: np.ndarray) -> list[list[float]]:
    m = (alpha > 110).astype(np.uint8)
    m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * OUTLINE_PAD + 1,) * 2))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25)))
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    c = max(cs, key=cv2.contourArea)
    return cv2.approxPolyDP(c, SIMPLIFY, True)[:, 0, :].astype(float).tolist()


def run(src: Path, see_through: bool) -> None:
    rgba = cutout(np.asarray(Image.open(src).convert("RGB")), see_through)
    a = rgba[..., 3]
    ys, xs = np.where(a > 8)
    if not len(xs):
        print(f"{src.stem}: nothing but white, skipped")
        return
    pad = OUTLINE_PAD + 24
    x0, x1 = max(0, xs.min() - pad), min(a.shape[1], xs.max() + pad + 1)
    y0, y1 = max(0, ys.min() - pad), min(a.shape[0], ys.max() + pad + 1)
    crop = rgba[y0:y1, x0:x1]
    Image.fromarray(crop, "RGBA").save(OUT / f"{src.stem}.png")
    h, w = crop.shape[:2]
    pts = [[round(x - w / 2, 1), round(y - h / 2, 1)] for x, y in outline(crop[..., 3])]
    (OUT / f"{src.stem}.json").write_text(json.dumps({"w": w, "h": h, "outline": pts}), encoding="utf-8")
    print(f"{src.stem}: {w}x{h}, outline {len(pts)} pts")


def main() -> None:
    see_through = "--see-through" in sys.argv
    pats = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not pats:
        sys.exit(__doc__)
    OUT.mkdir(parents=True, exist_ok=True)
    for pat in pats:
        srcs = sorted(RAW.glob(f"{pat}.png"))
        if not srcs:
            print(f"{pat}: no {RAW.relative_to(ROOT).as_posix()}/{pat}.png")
        for src in srcs:
            run(src, see_through)


if __name__ == "__main__":
    main()

"""Clean the cut-out edges of Codex's transparent PNGs -> assets/clean/<same name>.png

Codex's background removal leaves a 1-3 px fringe of saturated blue/cyan/magenta pixels and stray specks along the
alpha edge. Per image:
  1. drop near-transparent noise (alpha < 10/255) and specks (opaque components smaller than MIN_SPECK px);
  2. erode the alpha by ERODE px and re-feather it (Gaussian, FEATHER px) so the edge is smooth and slightly inset;
  3. colour decontamination: the RGB of every non-solid pixel is replaced by the colour pushed outward from the solid
     interior (cv2.inpaint over the edge band), so the soft edge carries the object's own colour, not the fringe;
  4. alpha bleeding: fully transparent pixels get the colour of the nearest opaque ones (push-pull pyramid), so
     bilinear / mipmap filtering of the straight-alpha texture in the renderer never pulls in dark or stray colours.

  python tools/assets/clean_alpha.py assets/bg/city_far.png assets/bg/clouds_a.png ...
"""
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path.cwd()  # run from the project root
MIN_SPECK = 60
ERODE = 2
FEATHER = 0.9


def read(p):
    return cv2.imdecode(np.fromfile(str(p), np.uint8), cv2.IMREAD_UNCHANGED)


def write(p, img):
    p.parent.mkdir(parents=True, exist_ok=True)
    ok, buf = cv2.imencode(".png", img)
    buf.tofile(str(p))


def bleed(rgb, a):
    """Push-pull fill of the RGB under transparent pixels from the surrounding opaque colours."""
    w = (a > 0.02).astype(np.float32)
    c = rgb.astype(np.float32) * w[..., None]
    pyr = [(c, w)]
    while min(c.shape[:2]) > 4:
        c = cv2.resize(c, (c.shape[1] // 2, c.shape[0] // 2), interpolation=cv2.INTER_AREA)
        w = cv2.resize(w, (w.shape[1] // 2, w.shape[0] // 2), interpolation=cv2.INTER_AREA)
        pyr.append((c, w))
    fill = pyr[-1][0] / np.maximum(pyr[-1][1], 1e-6)[..., None]
    for c, w in reversed(pyr[:-1]):
        up = cv2.resize(fill, (c.shape[1], c.shape[0]), interpolation=cv2.INTER_LINEAR)
        k = np.clip(w * 4, 0, 1)[..., None]
        fill = c / np.maximum(w, 1e-6)[..., None] * k + up * (1 - k)
    return np.where(a[..., None] > 0.02, rgb, np.clip(fill + 0.5, 0, 255).astype(np.uint8))


def clean(src, erode=ERODE):
    im = read(src)
    assert im.ndim == 3 and im.shape[2] == 4, f"{src} has no alpha"
    rgb, a = im[..., :3], im[..., 3].astype(np.float32) / 255.0
    a[a < 10 / 255] = 0
    solid = (a > 0.5).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(solid, connectivity=8)
    small = np.isin(lab, np.where(stats[:, cv2.CC_STAT_AREA] < MIN_SPECK)[0][1:] if n > 1 else [])
    a[small] = 0
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * erode + 1, 2 * erode + 1))
    core = cv2.erode((a > 0.5).astype(np.uint8), k)
    a2 = cv2.GaussianBlur(core.astype(np.float32), (0, 0), FEATHER)
    a2 = np.minimum(a2, cv2.GaussianBlur(a, (0, 0), 0.6) + 0.02)
    interior = cv2.erode(core, k)                       # colours we trust
    band = ((a2 > 0.001) & (interior == 0)).astype(np.uint8)
    fixed = cv2.inpaint(rgb, band, 4, cv2.INPAINT_TELEA)
    rgb2 = bleed(np.where(band[..., None] > 0, fixed, rgb), a2)
    out = np.dstack([rgb2, np.clip(a2 * 255 + 0.5, 0, 255).astype(np.uint8)])
    dst = ROOT / "assets" / "clean" / Path(src).name
    write(dst, out)
    print("cleaned", src, "->", dst.relative_to(ROOT), f"speck px removed {int(small.sum())}")


if __name__ == "__main__":
    # --erode N before the files (characters: 1, thin spires/lines: 1, clouds/buildings: 2)
    args, er = sys.argv[1:], ERODE
    if args and args[0] == "--erode":
        er, args = int(args[1]), args[2:]
    for p in args:
        clean(ROOT / p if not Path(p).is_absolute() else Path(p), er)

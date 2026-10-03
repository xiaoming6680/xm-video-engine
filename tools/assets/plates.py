"""Prepare Codex background plates (art/raw/p_*.png) for the code-built world -> assets/plates/.

  p_sky_*    sky panoramas: RGB, the horizon is the bottom edge. Also writes NAME.json with the average colour of
             the bottom rows (the scenes use it as the fog colour, so the 3D world melts into the painted horizon).
  p_city_*   skyline strips painted on flat green: keyed to RGBA (green screen with despill), trimmed at the top.

  python tools/assets/plates.py p_sky_night p_city_night
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path.cwd()  # run from the project root
RAW = ROOT / "art" / "raw"
OUT = ROOT / "assets" / "plates"


def srgb_to_lin(c):
    c = np.asarray(c, np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def sky(name):
    im = np.array(Image.open(RAW / f"{name}.png").convert("RGB")).astype(np.float32) / 255
    h = im.shape[0]
    bottom = im[int(h * 0.94):].reshape(-1, 3).mean(axis=0)
    band = im[int(h * 0.80):int(h * 0.92)].reshape(-1, 3).mean(axis=0)
    top = im[: int(h * 0.08)].reshape(-1, 3).mean(axis=0)
    OUT.mkdir(parents=True, exist_ok=True)
    Image.fromarray((im * 255 + 0.5).astype(np.uint8)).save(OUT / f"{name}.jpg", quality=95)
    meta = dict(w=im.shape[1], h=h, horizon=srgb_to_lin(bottom).tolist(), low=srgb_to_lin(band).tolist(), top=srgb_to_lin(top).tolist())
    (OUT / f"{name}.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    print("sky", name, meta)


def city(name):
    im = np.array(Image.open(RAW / f"{name}.png").convert("RGB")).astype(np.float32) / 255
    r, g, b = im[..., 0], im[..., 1], im[..., 2]
    # green dominance -> transparency
    gd = g - np.maximum(r, b)
    a = 1 - np.clip((gd - 0.12) / 0.35, 0, 1)
    a = cv2.GaussianBlur(a, (3, 3), 0.7)
    # despill: clamp green to the max of red and blue where it dominates
    im[..., 1] = np.minimum(g, np.maximum(r, b) * 1.05 + 0.02)
    ys = np.where(a.max(axis=1) > 0.5)[0]
    y0 = max(0, ys.min() - 8)
    out = np.dstack([im, a])[y0:]
    OUT.mkdir(parents=True, exist_ok=True)
    Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGBA").save(OUT / f"{name}.png")
    (OUT / f"{name}.json").write_text(json.dumps(dict(w=out.shape[1], h=out.shape[0]), indent=1), encoding="utf-8")
    print("city", name, out.shape)


if __name__ == "__main__":
    for n in sys.argv[1:]:
        (city if n.startswith("p_city") else sky)(n)

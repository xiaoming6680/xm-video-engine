"""Cut a character layer (art/raw/c_*.png, drawn on flat grey) into a clean RGBA sprite for the 3D scenes.

  matte    anime-seg ISNet (tools/layers.py), tightened: alpha below 0.03 -> 0, above 0.97 -> 1
  colour   decontaminated against the known grey ground: C = (I - (1 - a) * G) / a, so semi-transparent hair
           strands keep their own colour instead of a grey fringe
  trim     to the opaque bounding box plus a margin; the soles (lowest opaque row) are recorded in the JSON

Writes assets/cut/NAME.png and NAME.json ({w, h, footV, headV}).

  python tools/assets/cutout.py c_teto_back
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from layers import matte  # noqa: E402

ROOT = Path.cwd()  # run from the project root
RAW = ROOT / "art" / "raw"
OUT = ROOT / "assets" / "cut"


def run(name, margin=24):
    rgba = np.array(Image.open(RAW / f"{name}.png").convert("RGB")).astype(np.float32) / 255
    a = matte((rgba * 255).astype(np.uint8))
    a = np.clip((a - 0.03) / 0.94, 0, 1)
    # the ISNet matte sits ~1 px outside the line art: pull it in (grey rim otherwise)
    a = np.minimum(a, cv2.GaussianBlur(cv2.erode(a, np.ones((3, 3), np.uint8)), (3, 3), 0.8))
    # the ground colour: median of the frame border
    b = np.concatenate([rgba[:8].reshape(-1, 3), rgba[-8:].reshape(-1, 3), rgba[:, :8].reshape(-1, 3), rgba[:, -8:].reshape(-1, 3)])
    g = np.median(b, axis=0)
    aa = np.maximum(a, 1e-3)[..., None]
    col = np.clip((rgba - (1 - aa) * g) / aa, 0, 1)
    col = np.where(a[..., None] > 0.995, rgba, col)
    ys, xs = np.where(a > 0.5)
    y0, y1 = max(0, ys.min() - margin), min(a.shape[0], ys.max() + margin + 1)
    x0, x1 = max(0, xs.min() - margin), min(a.shape[1], xs.max() + margin + 1)
    out = np.dstack([col, a])[y0:y1, x0:x1]
    OUT.mkdir(parents=True, exist_ok=True)
    Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGBA").save(OUT / f"{name}.png")
    h, w = out.shape[:2]
    rows = np.where((out[..., 3] > 0.5).sum(axis=1) > 2)[0]
    meta = dict(w=w, h=h, footV=float((rows.max() + 1) / h), headV=float(rows.min() / h), ground=[float(x) for x in g])
    (OUT / f"{name}.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    print("ok", name, w, h, meta)


if __name__ == "__main__":
    for n in sys.argv[1:]:
        run(n)

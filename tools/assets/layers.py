"""Split key-art frames into layers for the multiplane camera: character matte + depth map.

For art/raw/NAME.png writes art/layers/NAME/:
  matte.png   character alpha (anime-seg ISNet, skytnt/anime-seg isnetis.onnx), 8-bit
  depth.png   relative depth (Depth Anything V2 Small, Apache-2.0), 16-bit, 0 = far, 65535 = near
  preview.jpg the frame, the matte and the depth side by side

  python tools/assets/layers.py k_street k_glass
  python tools/assets/layers.py --all
  python tools/assets/layers.py --large k_street   # V2 Large instead: CC-BY-NC weights, not for monetised work

Small vs Large on 15 key-art frames (Still_Shining, 暗叫): depth correlation 0.87-0.999 (most > 0.96), no visible
difference in the previews; Depth Anything 3 was blurrier. See docs/模型选型.md.
"""
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path.cwd()  # run from the project root
RAW = ROOT / "art" / "raw"
OUT = ROOT / "art" / "layers"

_seg = None
_depth = None


def seg_model():
    global _seg
    if _seg is None:
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        path = hf_hub_download("skytnt/anime-seg", "isnetis.onnx")
        _seg = ort.InferenceSession(path, providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    return _seg


def depth_model():
    global _depth
    if _depth is None:
        import torch
        # the installed torchvision does not match torch: hide it (import torchvision -> ImportError)
        sys.modules["torchvision"] = None
        import transformers.utils.import_utils as iu
        iu.is_torchvision_available = lambda: False
        iu.is_torchvision_v2_available = lambda: False
        from transformers.models.depth_anything.modeling_depth_anything import DepthAnythingForDepthEstimation
        size = "Large" if "--large" in sys.argv else "Small"
        _depth = DepthAnythingForDepthEstimation.from_pretrained(f"depth-anything/Depth-Anything-V2-{size}-hf").to("cuda").eval()
    return _depth


def matte(rgb, s=1024):
    img = rgb.astype(np.float32) / 255
    h0, w0 = img.shape[:2]
    h, w = (s, int(s * w0 / h0)) if h0 > w0 else (int(s * h0 / w0), s)
    ph, pw = s - h, s - w
    x = np.zeros([s, s, 3], np.float32)
    x[ph // 2:ph // 2 + h, pw // 2:pw // 2 + w] = cv2.resize(img, (w, h))
    m = seg_model().run(None, {"img": x.transpose(2, 0, 1)[None]})[0][0, 0]
    m = m[ph // 2:ph // 2 + h, pw // 2:pw // 2 + w]
    return np.clip(cv2.resize(m, (w0, h0), interpolation=cv2.INTER_LINEAR), 0, 1)


def depth(rgb, short=770):
    import torch
    h0, w0 = rgb.shape[:2]
    k = short / min(h0, w0)
    h, w = int(round(h0 * k / 14)) * 14, int(round(w0 * k / 14)) * 14
    x = cv2.resize(rgb, (w, h), interpolation=cv2.INTER_CUBIC).astype(np.float32) / 255
    x = (x - [0.485, 0.456, 0.406]) / [0.229, 0.224, 0.225]
    x = torch.from_numpy(x.transpose(2, 0, 1)[None].astype(np.float32)).to("cuda")
    with torch.inference_mode():
        d = depth_model()(pixel_values=x).predicted_depth  # relative inverse depth: bigger = nearer
    d = d.squeeze().float().cpu().numpy()
    d = cv2.resize(d, (rgb.shape[1], rgb.shape[0]), interpolation=cv2.INTER_CUBIC)
    lo, hi = np.percentile(d, 0.5), np.percentile(d, 99.5)
    return np.clip((d - lo) / (hi - lo + 1e-9), 0, 1)


def run(name):
    im = Image.open(RAW / f"{name}.png").convert("RGB")
    rgb = np.array(im)
    d = OUT / name
    d.mkdir(parents=True, exist_ok=True)
    m = matte(rgb)
    z = depth(rgb)
    # cv2.imwrite silently fails on non-ASCII paths (D:\!XM的项目\...): encode, then write with numpy
    cv2.imencode(".png", (m * 255 + 0.5).astype(np.uint8))[1].tofile(str(d / "matte.png"))
    cv2.imencode(".png", (z * 65535 + 0.5).astype(np.uint16))[1].tofile(str(d / "depth.png"))
    H = 900
    W = rgb.shape[1] * H // rgb.shape[0]
    tiles = [cv2.resize(rgb, (W, H)),
             cv2.resize(np.dstack([m * 255] * 3).astype(np.uint8), (W, H)),
             cv2.resize(cv2.applyColorMap((z * 255).astype(np.uint8), cv2.COLORMAP_TURBO)[:, :, ::-1], (W, H))]
    Image.fromarray(np.hstack(tiles)).save(d / "preview.jpg", quality=88)
    print("ok", name, rgb.shape, "matte cover %.1f%%" % (100 * m.mean()))


if __name__ == "__main__":
    names = [p.stem for p in sorted(RAW.glob("*.png"))] if "--all" in sys.argv else [a for a in sys.argv[1:] if not a.startswith("--")]
    for n in names:
        run(n)

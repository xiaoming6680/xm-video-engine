"""Roto（AE 的 Roto 笔刷 / 抠主体）：在 tools/footage.py 抽好的序列帧上，给一帧点几下（或框一下）要的东西，整段逐帧出蒙版，
写成带透明的 PNG 序列帧，app 里用 loadFootage 读，当轨道遮罩（matte）或直接当抠好的素材层用。

  # 在项目根目录跑；<帧目录> 是 footage.py 写的 assets/footage/<名字>/
  python tools/roto.py assets/footage/clip --at 1 --points 640,360 --name person              # 第 1 帧点人身上一下，往前后传
  python tools/roto.py assets/footage/clip --at 30 --points 640,360 700,500 --neg 900,300 --name person   # 多点几下；--neg 点不要的
  python tools/roto.py assets/footage/clip --at 1 --box 400,120,900,700 --name car                         # 框住
  python tools/roto.py assets/footage/clip --at 1 --box 400,120,900,700 --method grabcut --name car        # 不用模型（离线，粗一些）
  可选：--model tiny | small | base-plus | large（SAM 2.1 的大小，默认 small）；--feather 1.5（边羽化 px）；
        --cutout（写原图颜色 + 透明 = 抠好的素材；默认写白色 + 透明 = 蒙版）；--from / --to 只做这几帧

  场景里：roto = await loadFootage(r, '/assets/footage/clip_person');
          { name: 'roto', footage: roto, start: S },                        // 蒙版层（当遮罩的层自动不显示）
          { name: 'bg-text', draw: …, matte: { layer: 'roto', mode: 'alphaInv' } },   // 字只在人身后（人挡住字）

方法：
  sam      SAM 2.1（Meta，Apache-2.0）的视频分割，经 transformers；第一次用会从 Hugging Face 下载权重（small 约 180 MB），
           有 CUDA 就用显卡。这台机器的 torchvision 和 torch 版本不配套，脚本里自动绕开（不影响结果）
  grabcut  OpenCV 的 GrabCut：参考帧用框和点初始化，之后每帧把上一帧的蒙版按光流（DIS）挪过来当种子再分割。不用下载，
           边缘和细节（头发、透明物）比 SAM 差，适合主体和背景颜色差得开的镜头
结果写到 assets/footage/<名字>_<name>/（00001.png … + meta.json）。
"""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from track import frame_paths, load_meta, pts_arg  # noqa: E402
from retime import Flow, grid, warp  # noqa: E402


def sam_masks(paths: list[Path], at: int, pos: np.ndarray, neg: np.ndarray, box, size: str) -> dict[int, np.ndarray]:
    try:
        import torchvision  # noqa: F401
    except Exception:
        # a torchvision built for another torch breaks transformers' import; SAM 2 does not need it
        sys.modules["torchvision"] = None
    import torch
    from PIL import Image
    from transformers import Sam2VideoModel, Sam2VideoProcessor
    name = f"facebook/sam2.1-hiera-{size}"
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    dt = torch.bfloat16 if dev == "cuda" else torch.float32
    print(f"SAM 2.1（{size}）在 {dev} 上跑……")
    model = Sam2VideoModel.from_pretrained(name).to(dev, dtype=dt)
    proc = Sam2VideoProcessor.from_pretrained(name)
    frames = [Image.open(p).convert("RGB") for p in paths]
    sess = proc.init_video_session(video=frames, inference_device=dev, video_storage_device="cpu", dtype=dt)
    kw = {}
    if len(pos) or len(neg):
        allp = [list(map(float, p)) for p in list(pos) + list(neg)]
        kw["input_points"] = [[allp]]
        kw["input_labels"] = [[[1] * len(pos) + [0] * len(neg)]]
    if box is not None:
        kw["input_boxes"] = [[list(map(float, box))]]
    proc.add_inputs_to_inference_session(inference_session=sess, frame_idx=at, obj_ids=1, **kw)
    out: dict[int, np.ndarray] = {}
    with torch.inference_mode():
        model(inference_session=sess, frame_idx=at)
        for rev in (False, True):
            for o in model.propagate_in_video_iterator(sess, start_frame_idx=at, reverse=rev):
                m = proc.post_process_masks([o.pred_masks], original_sizes=[[sess.video_height, sess.video_width]], binarize=False)[0]
                out[int(o.frame_idx)] = torch.sigmoid(m[0, 0].float()).cpu().numpy()
                print(f"\r{len(out)}/{len(paths)}", end="", flush=True)
    print()
    return out


def grabcut_masks(paths: list[Path], at: int, pos: np.ndarray, neg: np.ndarray, box) -> dict[int, np.ndarray]:
    img0 = cv2.imread(str(paths[at]))
    h, w = img0.shape[:2]
    if box is None:
        if not len(pos):
            sys.exit("grabcut 要 --box，或者至少一个 --points")
        x0, y0 = pos.min(0) - 120
        x1, y1 = pos.max(0) + 120
        box = [max(0, x0), max(0, y0), min(w - 1, x1), min(h - 1, y1)]
    x0, y0, x1, y1 = (int(round(v)) for v in box)
    m = np.full((h, w), cv2.GC_BGD, np.uint8)
    m[y0:y1, x0:x1] = cv2.GC_PR_FGD
    r = max(4, min(w, h) // 120)
    for x, y in pos:
        cv2.circle(m, (int(x), int(y)), r, cv2.GC_FGD, -1)
    for x, y in neg:
        cv2.circle(m, (int(x), int(y)), r, cv2.GC_BGD, -1)

    def cut(img: np.ndarray, seed: np.ndarray, iters: int) -> np.ndarray:
        bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
        mm = seed.copy()
        if not ((mm == cv2.GC_FGD) | (mm == cv2.GC_PR_FGD)).any() or not ((mm == cv2.GC_BGD) | (mm == cv2.GC_PR_BGD)).any():
            return ((mm == cv2.GC_FGD) | (mm == cv2.GC_PR_FGD)).astype(np.float32)
        cv2.grabCut(img, mm, None, bgd, fgd, iters, cv2.GC_INIT_WITH_MASK)
        return ((mm == cv2.GC_FGD) | (mm == cv2.GC_PR_FGD)).astype(np.float32)

    out = {at: cut(img0, m, 5)}
    flow, g = Flow("medium"), grid(h, w)
    for step in (1, -1):
        prev_m, prev_g = out[at], cv2.cvtColor(img0, cv2.COLOR_BGR2GRAY)
        i = at + step
        while 0 <= i < len(paths):
            img = cv2.imread(str(paths[i]))
            gr = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            # last frame's mask carried here along the flow (this frame's pixel x came from x + F(x) there)
            moved = warp(prev_m, g, flow(gr, prev_g)) > 0.5
            mu8 = moved.astype(np.uint8)
            # how sure the carried mask is scales with its size: the flow inside flat areas lags, so the sure core is
            # well inside and the band GrabCut may move the edge in is wide
            r_eq = float(np.sqrt(max(1, int(mu8.sum())) / np.pi))
            k_in = int(max(5, 0.3 * r_eq)) | 1
            k_out = int(max(21, 0.6 * r_eq)) | 1
            seed = np.full((h, w), cv2.GC_BGD, np.uint8)
            seed[cv2.dilate(mu8, np.ones((k_out, k_out), np.uint8)) > 0] = cv2.GC_PR_BGD
            seed[mu8 > 0] = cv2.GC_PR_FGD
            seed[cv2.erode(mu8, np.ones((k_in, k_in), np.uint8)) > 0] = cv2.GC_FGD
            out[i] = cut(img, seed, 5)
            prev_m, prev_g = out[i], gr
            print(f"\r{len(out)}/{len(paths)}", end="", flush=True)
            i += step
    print()
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Roto：逐帧抠主体（见文件开头）")
    ap.add_argument("dir", help="footage.py 抽的帧目录（有 meta.json）")
    ap.add_argument("--name", required=True, help="输出名：写到 <帧目录>_<name>/")
    ap.add_argument("--at", type=int, default=1, help="在哪一帧上点 / 框（帧号，从 1 起）")
    ap.add_argument("--points", nargs="+", default=[], help="要的东西上的点 x,y …（素材像素）")
    ap.add_argument("--neg", nargs="+", default=[], help="不要的地方的点 x,y …")
    ap.add_argument("--box", help="框 x0,y0,x1,y1")
    ap.add_argument("--method", choices=["sam", "grabcut"], default="sam")
    ap.add_argument("--model", choices=["tiny", "small", "base-plus", "large"], default="small")
    ap.add_argument("--feather", type=float, default=1.0, help="边羽化（px）")
    ap.add_argument("--cutout", action="store_true", help="写原图颜色 + 透明（默认白色 + 透明的蒙版）")
    ap.add_argument("--from", dest="frm", type=int)
    ap.add_argument("--to", type=int)
    a = ap.parse_args(argv)
    d = Path(a.dir)
    meta = load_meta(d)
    paths = frame_paths(d, meta)
    lo = (a.frm or meta["first"]) - meta["first"]
    hi = (a.to or meta["last"]) - meta["first"]
    paths = paths[lo:hi + 1]
    at = a.at - meta["first"] - lo
    if not 0 <= at < len(paths):
        sys.exit(f"--at {a.at} 不在这几帧里")
    pos = pts_arg(a.points) if a.points else np.zeros((0, 2))
    neg = pts_arg(a.neg) if a.neg else np.zeros((0, 2))
    box = [float(v) for v in a.box.split(",")] if a.box else None
    if not len(pos) and box is None:
        sys.exit("给 --points 或 --box")
    masks = sam_masks(paths, at, pos, neg, box, a.model) if a.method == "sam" else grabcut_masks(paths, at, pos, neg, box)
    out = d.parent / f"{d.name}_{a.name}"
    out.mkdir(parents=True, exist_ok=True)
    cover = []
    for i, p in enumerate(paths):
        m = masks.get(i)
        img = cv2.imread(str(p))
        if m is None:
            m = np.zeros(img.shape[:2], np.float32)
        if a.feather > 0:
            m = cv2.GaussianBlur(m.astype(np.float32), (0, 0), a.feather)
        al = np.clip(m * 255 + 0.5, 0, 255).astype(np.uint8)
        rgb = img if a.cutout else np.full_like(img, 255)
        cv2.imwrite(str(out / f"{i + 1:05d}.png"), np.dstack([rgb, al]))
        cover.append(float((al > 127).mean()))
    m2 = {**meta, "first": 1, "last": len(paths), "pattern": "#####.png", "duration": len(paths) / meta["fps"], "source": f"roto of {d.name} ({a.method})"}
    (out / "meta.json").write_text(json.dumps(m2, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"写好 {out}：{len(paths)} 帧；蒙版占画面 {min(cover):.1%}–{max(cover):.1%}")


if __name__ == "__main__":
    main()

"""看片辅助（docs/质量验收.md 第三节「看片」），从 Still_Shining 的 qa8.py 整理而来。

  python tools/qa/review.py out/film.mp4 [--start 0]
      -> out/qa/<名>_sheet.jpg   联系表：每 0.5 秒一帧，180 px 宽（手机大小下读不读得清，一眼就知道）
         out/qa/<名>_motion.png  画面运动量（帧差）对歌的 RMS 和段落线：看密度有没有跟着歌起伏
         以及每段的平均运动量和亮度
  python tools/qa/review.py out/film.mp4 strip 24 27.4 8 [--start 0]
      -> out/qa/<名>_strip_24-27.4.jpg  两个时刻之间均匀取 8 帧排成一条（看关键动作，0.2 秒一帧就取 n = 时长 / 0.2）

--start：视频第 0 秒对应的歌曲时间（src/config.ts VIDEO_START），段落和 RMS 按它对齐。
时间参数都是视频时间。响度、闪光、空帧、色彩标签用 check_video.py。
"""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path.cwd()


def ascii_copy(src: Path, out: Path) -> Path:
    # cv2 can't open non-ASCII paths on Windows reliably: work on an ASCII temp copy
    tmp = out / "_qa_in.mp4"
    tmp.write_bytes(src.read_bytes())
    return tmp


def strip(src: Path, t0: float, t1: float, n: int) -> None:
    out = ROOT / "out" / "qa"
    out.mkdir(parents=True, exist_ok=True)
    tmp = ascii_copy(src, out)
    cap = cv2.VideoCapture(str(tmp))
    fps = cap.get(cv2.CAP_PROP_FPS)
    tiles = []
    for k in range(n):
        t = t0 + (t1 - t0) * k / max(1, n - 1)
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(round(t * fps)))
        ok, f = cap.read()
        if not ok:
            continue
        w = 270 if f.shape[0] > f.shape[1] else 400
        f = cv2.resize(f, (w, int(f.shape[0] * w / f.shape[1])), interpolation=cv2.INTER_AREA)
        cv2.putText(f, f"{t:.2f}", (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
        tiles.append(f)
    cap.release()
    tmp.unlink()
    img = np.concatenate(tiles, 1)
    p = out / f"{src.stem}_strip_{t0:g}-{t1:g}.jpg"
    _, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 88])
    buf.tofile(str(p))
    print(p)


def sections(start: float, dur: float) -> list[tuple[float, str]]:
    """Section starts in video time, from data/audio.json (song time)."""
    a = json.loads((ROOT / "data" / "audio.json").read_text(encoding="utf-8"))
    out = []
    for s in a.get("sections", []):
        t = s["start"] - start
        if 0 <= t < dur:
            out.append((t, s["name"]))
    return out


def main(src: Path, start: float) -> None:
    name = src.stem
    out = ROOT / "out" / "qa"
    out.mkdir(parents=True, exist_ok=True)
    tmp = ascii_copy(src, out)
    cap = cv2.VideoCapture(str(tmp))
    fps = cap.get(cv2.CAP_PROP_FPS)
    lum, diff, sheet = [], [], []
    prev = None
    every = int(round(fps * 0.5))
    i = 0
    while True:
        ok, f = cap.read()
        if not ok:
            break
        small = cv2.resize(f, (180, int(f.shape[0] * 180 / f.shape[1])), interpolation=cv2.INTER_AREA)
        g = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
        lum.append(float(g.mean()))
        diff.append(float(np.abs(g - prev).mean()) if prev is not None else 0.0)
        prev = g
        if i % every == every // 2:
            sheet.append((i / fps, small))
        i += 1
    cap.release()
    tmp.unlink()
    lum, diff = np.array(lum), np.array(diff)
    n = len(lum)
    dur = n / fps

    cols = 16
    rows = (len(sheet) + cols - 1) // cols
    h = sheet[0][1].shape[0]
    canvas = np.zeros((rows * (h + 16), cols * 180, 3), np.uint8)
    for k, (t, f) in enumerate(sheet):
        y, x = (k // cols) * (h + 16), (k % cols) * 180
        canvas[y + 16:y + 16 + h, x:x + 180] = f
        cv2.putText(canvas, f"{t:5.1f}", (x + 3, y + 12), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (220, 220, 220), 1)
    _, buf = cv2.imencode(".jpg", canvas, [cv2.IMWRITE_JPEG_QUALITY, 85])
    buf.tofile(str(out / f"{name}_sheet.jpg"))

    A = json.loads((ROOT / "data" / "audio.json").read_text(encoding="utf-8"))
    rms = np.array((A.get("features") or {}).get("rms") or A.get("rms") or [0.0])
    secs = sections(start, dur)
    k = max(1, int(fps / 4))
    sm = np.convolve(diff, np.ones(k) / k, mode="same")
    W, H = 1800, 380
    plot = np.full((H, W, 3), 24, np.uint8)
    ts = np.arange(n) / fps + start
    ri = np.clip((ts * A.get("fps", 100)).astype(int), 0, len(rms) - 1)

    def poly(vals, color, scale):
        pts = np.stack([np.arange(n) * (W - 1) / max(1, n - 1), H - 22 - np.clip(vals * scale, 0, H - 44)], 1).astype(np.int32)
        cv2.polylines(plot, [pts], False, color, 1, cv2.LINE_AA)

    poly(rms[ri], (90, 160, 255), H - 60)
    poly(sm, (120, 255, 120), (H - 60) / max(1e-6, np.percentile(sm, 99)))
    poly(lum, (220, 220, 220), H - 60)
    for t, lab in secs:
        x = int(t * fps * (W - 1) / max(1, n - 1))
        cv2.line(plot, (x, 24), (x, H - 22), (80, 80, 160), 1)
        cv2.putText(plot, lab, (x + 3, 36), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (180, 180, 255), 1)
    for s in range(0, int(dur) + 1, 5):
        x = int(s * fps * (W - 1) / max(1, n - 1))
        cv2.putText(plot, str(s), (x + 2, H - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (200, 200, 200), 1)
    cv2.putText(plot, "blue: song RMS   green: picture motion   grey: mean luminance", (10, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (230, 230, 230), 1)
    _, buf = cv2.imencode(".png", plot)
    buf.tofile(str(out / f"{name}_motion.png"))

    print(f"{name}: {n} frames ({dur:.2f} s, {fps:g} fps)")
    bounds = [0.0] + [t for t, _ in secs] + [dur]
    labels = ["(start)"] + [lab for _, lab in secs]
    for (a, b), lab in zip(zip(bounds[:-1], bounds[1:]), labels):
        if b - a < 1 / fps:
            continue
        seg, lseg = sm[int(a * fps):int(b * fps)], lum[int(a * fps):int(b * fps)]
        print(f"  {lab:10s} {a:6.2f}-{b:6.2f}: motion {seg.mean():.4f}  luma {lseg.mean():.3f}")
    print(f"  wrote out/qa/{name}_sheet.jpg, out/qa/{name}_motion.png")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("rest", nargs="*", help="strip t0 t1 n")
    ap.add_argument("--start", type=float, default=0.0, help="视频第 0 秒对应的歌曲时间")
    a = ap.parse_args()
    p = Path(a.video)
    if not p.is_absolute():
        p = ROOT / p
    if a.rest and a.rest[0] == "strip":
        strip(p, float(a.rest[1]), float(a.rest[2]), int(a.rest[3]))
    else:
        main(p, a.start)
    sys.exit(0)

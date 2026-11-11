"""看片辅助（docs/检查和评审.md「看片」）。

  python tools/qa/review.py out/film.mp4 [--start 0]
      -> out/qa/<名>_sheet.jpg   联系表：每 0.5 秒一帧，180 px 宽（手机大小下读不读得清，一眼就知道）
         out/qa/<名>_motion.png  画面运动量（帧差）对歌的 RMS 和段落线：看密度有没有跟着歌起伏
         以及每段的平均运动量和亮度
  python tools/qa/review.py out/film.mp4 strip 24 27.4 8 [--start 0]
      -> out/qa/<名>_strip_24-27.4.jpg  两个时刻之间均匀取 8 帧排成一条（看关键动作，0.2 秒一帧就取 n = 时长 / 0.2）
  python tools/qa/review.py out/film.mp4 onion 24 25 16
      -> out/qa/<名>_onion_24-25.jpg  洋葱皮：16 帧叠成一张，动的部分从冷到暖着色。间距就是速度（挤 = 慢、开 = 快），
         连起来是运动弧线：看缓动对不对、是不是一路匀速、落点前有没有减速，不用看视频也读得出来

  python tools/qa/review.py refs/xx/ref.mp4 frames [起 止]
      -> out/qa/<名>_frames/s_0012.jpg …  逐帧表：每一帧都在，一秒一张（6 列，标帧号和秒），拆参考片的手法用：
         几帧到位、哪帧糊、哪帧换色、一拍几张都数得出来；看不清的帧再用 strip 抽大图
         以及 cuts.json（每帧帧差和帧差尖峰：真切点、闪帧、快动作，也有编码器 I 帧的假尖峰）

  python tools/qa/review.py out/film.mp4 rhythm [起 止]
      -> 节奏质地（按 30 帧量）：每秒切点、完全停住的帧占比、停顿长度、每秒运动量的起伏。和参考片各跑一次对照：
         手搓感的 PV 里两三成的帧是停住的（步进的保持帧、砸完的停顿），平滑地一直漂的片子接近 0

--start：视频第 0 秒对应的歌曲时间（src/config.ts VIDEO_START），段落和 RMS 按它对齐。
时间参数都是视频时间。真峰值、闪光、空帧、色彩标签用 check_video.py。
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


def frames(src: Path, t0: float = 0.0, t1: float | None = None) -> None:
    out = ROOT / "out" / "qa" / f"{src.stem}_frames"
    out.mkdir(parents=True, exist_ok=True)
    tmp = ascii_copy(src, out)
    cap = cv2.VideoCapture(str(tmp))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    per = max(1, int(round(fps)))
    cols = 6 if per % 6 == 0 else 5 if per % 5 == 0 else 6
    first = int(round(t0 * fps))
    cap.set(cv2.CAP_PROP_POS_FRAMES, first)
    tiles, diffs, prev, n = [], [], None, first

    def flush(sec: int) -> None:
        if not tiles:
            return
        h, w = tiles[0].shape[:2]
        rows = -(-len(tiles) // cols)
        canvas = np.zeros((rows * h, cols * w, 3), np.uint8)
        for k, tile in enumerate(tiles):
            canvas[(k // cols) * h:(k // cols + 1) * h, (k % cols) * w:(k % cols + 1) * w] = tile
        _, buf = cv2.imencode(".jpg", canvas, [cv2.IMWRITE_JPEG_QUALITY, 82])
        buf.tofile(str(out / f"s_{sec:04d}.jpg"))

    while True:
        if t1 is not None and n / fps >= t1:
            break
        ok, f = cap.read()
        if not ok:
            break
        w = 216 if f.shape[0] > f.shape[1] else 384
        s = cv2.resize(f, (w, int(f.shape[0] * w / f.shape[1])), interpolation=cv2.INTER_AREA)
        g = cv2.cvtColor(s, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255
        diffs.append(float(np.abs(g - prev).mean()) if prev is not None else 0.0)
        prev = g
        cv2.rectangle(s, (0, 0), (118, 20), (0, 0, 0), -1)
        cv2.putText(s, f"#{n} {n / fps:.2f}s", (3, 15), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
        tiles.append(s)
        n += 1
        if n % per == 0:
            flush(n // per - 1)
            tiles = []
    flush(n // per)
    cap.release()
    tmp.unlink()
    d = np.array(diffs)
    med = float(np.median(d[1:])) if len(d) > 1 else 0.0
    cuts = [first + i for i in range(1, len(d)) if d[i] > max(0.08, 4 * med) and d[i] >= d[i - 1] and d[i] >= d[min(len(d) - 1, i + 1)]]
    (out / "cuts.json").write_text(json.dumps({"fps": fps, "first": first, "frames": n - first, "diff": [round(x, 4) for x in diffs],
                                               "cuts": cuts, "cut_times": [round(c / fps, 3) for c in cuts]}), encoding="utf-8")
    print(f"{n - first} 帧，{fps:g} fps，{len(cuts)} 个帧差尖峰 -> {out}")


def rhythm(src: Path, t0: float = 0.0, t1: float | None = None) -> dict:
    out = ROOT / "out" / "qa"
    out.mkdir(parents=True, exist_ok=True)
    tmp = ascii_copy(src, out)
    cap = cv2.VideoCapture(str(tmp))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, round(fps / 30))  # 60 fps: every other frame, so both sides are measured at 30
    n, prev, d = 0, None, []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        n += 1
        if (n - 1) % step:
            continue
        t = (n - 1) / fps
        if t < t0:
            continue
        if t1 is not None and t >= t1:
            break
        g = cv2.cvtColor(cv2.resize(f, (320, 180), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32) / 255
        if prev is not None:
            d.append(float(np.abs(g - prev).mean()))
        prev = g
    cap.release()
    tmp.unlink()
    a = np.array(d)
    dur = len(a) / 30 if len(a) else 0.0
    med = float(np.median(a)) if len(a) else 0.0
    cuts = [i for i in range(1, len(a) - 1) if a[i] > max(0.08, 4 * med) and a[i] >= a[i - 1] and a[i] >= a[i + 1]]
    held = a < 0.002  # the same picture as the frame before (a step's hold, a freeze), allowing for compression noise
    runs, r = {}, 0
    for x in list(held) + [False]:
        if x:
            r += 1
        elif r:
            runs[r] = runs.get(r, 0) + 1
            r = 0
    w = [a[i:i + 30].mean() for i in range(0, len(a) - 29, 30)]
    res = {"seconds": round(dur, 2), "cuts_per_s": round(len(cuts) / dur, 2) if dur else 0.0, "held": round(float(held.mean()), 3) if len(a) else 0.0,
           "holds": dict(sorted(runs.items())), "median_diff": round(med, 4), "swing": round(float(np.std(w) / np.mean(w)), 2) if w and np.mean(w) > 0 else 0.0}
    print(f"{src.name}  {dur:.1f} s（按 30 帧量）")
    print(f"  每秒切点 {res['cuts_per_s']:.2f}    完全停住的帧 {res['held']:.0%}    帧差中位数 {med:.4f}    每秒运动量起伏 {res['swing']:.2f}")
    print(f"  停顿长度（帧：次数）{res['holds'] or '没有'}")
    return res


def onion(src: Path, t0: float, t1: float, n: int) -> None:
    """洋葱皮：一段动作里 n 帧叠成一张。不动的部分是背景（n 帧的中位数，压暗），动的部分按时间从冷到暖着色、
    越晚越实，最后一帧是原色。点和点的间距就是速度（挤 = 慢、开 = 快），连起来的形状就是运动弧线。"""
    out = ROOT / "out" / "qa"
    out.mkdir(parents=True, exist_ok=True)
    tmp = ascii_copy(src, out)
    cap = cv2.VideoCapture(str(tmp))
    fps = cap.get(cv2.CAP_PROP_FPS)
    frames, times = [], []
    for k in range(n):
        t = t0 + (t1 - t0) * k / max(1, n - 1)
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(round(t * fps)))
        ok, f = cap.read()
        if not ok:
            continue
        w = 540 if f.shape[0] > f.shape[1] else 960
        frames.append(cv2.resize(f, (w, int(f.shape[0] * w / f.shape[1])), interpolation=cv2.INTER_AREA).astype(np.float32))
        times.append(t)
    cap.release()
    tmp.unlink()
    if len(frames) < 2:
        sys.exit("取不到帧：检查时间范围（视频时间）")
    stack = np.stack(frames)
    bg = np.median(stack, axis=0)
    img = bg * 0.45
    kernel = np.ones((3, 3), np.uint8)
    for k, f in enumerate(frames):
        u = k / (len(frames) - 1)
        moving = (np.abs(f - bg).max(axis=2) > 18).astype(np.uint8)
        moving = cv2.dilate(moving, kernel).astype(bool)
        hue = np.uint8([[[int(120 * (1 - u)), 200, 255]]])                      # 蓝绿 → 红（OpenCV 的色相 0–180）
        tint = cv2.cvtColor(hue, cv2.COLOR_HSV2BGR).astype(np.float32)[0, 0]
        col = f if k == len(frames) - 1 else f * 0.5 + tint * 0.5
        a = 1.0 if k == len(frames) - 1 else 0.3 + 0.55 * u
        img[moving] = img[moving] * (1 - a) + col[moving] * a
    img = np.clip(img, 0, 255).astype(np.uint8)
    for k, t in enumerate(times):                                                 # 图例：每帧的颜色和时间
        u = k / (len(times) - 1)
        c = cv2.cvtColor(np.uint8([[[int(120 * (1 - u)), 200, 255]]]), cv2.COLOR_HSV2BGR)[0, 0].tolist()
        x = 8 + k * 64
        if x > img.shape[1] - 60:
            break
        cv2.circle(img, (x + 6, img.shape[0] - 14), 5, c, -1, cv2.LINE_AA)
        cv2.putText(img, f"{t:.2f}", (x + 14, img.shape[0] - 9), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (235, 235, 235), 1, cv2.LINE_AA)
    p = out / f"{src.stem}_onion_{t0:g}-{t1:g}.jpg"
    _, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    buf.tofile(str(p))
    print(p)


def sections(start: float, dur: float) -> list[tuple[float, str]]:
    """Section starts in video time, from data/audio.json (song time)."""
    p = ROOT / "data" / "audio.json"
    if not p.exists():
        return []
    a = json.loads(p.read_text(encoding="utf-8"))
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

    # 没有分析数据也能出联系表和运动量，只是少了 RMS 曲线和段落线
    A = json.loads((ROOT / "data" / "audio.json").read_text(encoding="utf-8")) if (ROOT / "data" / "audio.json").exists() else {}
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
    ap.add_argument("rest", nargs="*", help="strip t0 t1 n | onion t0 t1 n | frames [t0 t1] | rhythm [t0 t1]")
    ap.add_argument("--start", type=float, default=0.0, help="视频第 0 秒对应的歌曲时间")
    a = ap.parse_args()
    p = Path(a.video)
    if not p.is_absolute():
        p = ROOT / p
    if a.rest and a.rest[0] == "strip":
        strip(p, float(a.rest[1]), float(a.rest[2]), int(a.rest[3]))
    elif a.rest and a.rest[0] == "rhythm":
        rhythm(p, float(a.rest[1]) if len(a.rest) > 1 else 0.0, float(a.rest[2]) if len(a.rest) > 2 else None)
    elif a.rest and a.rest[0] == "frames":
        frames(p, float(a.rest[1]) if len(a.rest) > 1 else 0.0, float(a.rest[2]) if len(a.rest) > 2 else None)
    elif a.rest and a.rest[0] == "onion":
        onion(p, float(a.rest[1]), float(a.rest[2]), int(a.rest[3]) if len(a.rest) > 3 else 12)
    else:
        main(p, a.start)
    sys.exit(0)

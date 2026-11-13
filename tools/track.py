"""跟踪（AE 的跟踪器 / Mocha 的平面跟踪 / 变形稳定器）：在 tools/footage.py 抽好的序列帧上算，结果写成 JSON，
app 里用 engine/track.ts 读，贴到图层的 position、cornerPin 或素材层的变换上。坐标就是素材的像素（素材图层的图层像素），
所以把要跟着走的图层设成素材层的子层（parent），素材怎么缩放、移动都对得上。

  # 在项目根目录跑；<帧目录> 是 footage.py 写的 assets/footage/<名字>/
  python tools/track.py point   assets/footage/clip --at 1 --points 640,360 900,410        # 点跟踪：从第 1 帧这两个点往前后跟
  python tools/track.py planar  assets/footage/clip --at 1 --corners 412,180 860,210 850,520 400,500   # 平面跟踪：四个角（左上起顺时针）
  python tools/track.py stabilize assets/footage/clip --smooth 15                             # 稳定：抵消手抖（--lock 完全锁住）
  python tools/track.py pick    assets/footage/clip --at 1                                    # 出一张带坐标网格的帧，帮着读点的位置
  可选：--name 结果名（默认 point / planar / stabilize），写到 <帧目录>/track_<name>.json；--from / --to 只跟这几帧

做法：
  point      金字塔 LK 光流逐帧跟，前后向误差大或跟丢时在上一位置附近做模板匹配找回；每帧给可信度 0–1
  planar     区域里的特征点用 LK 跟、RANSAC 求单应估计，再用 ECC 把这一帧对齐回参考帧的区域（亚像素、不累积漂移）
  stabilize  全画面特征点逐帧求相似变换（平移、旋转、缩放），累积成轨迹，高斯平滑后算出每帧要补的变换；边缘会露出来，
             图层自己放大一点盖住
结果 JSON：{ type, fps, first, size: [w, h], frames: n, … }：point → points: { 名字: [[x, y, 可信度], …每帧] }；
planar → corners: [[[x, y] × 4], …]、conf；stabilize → xform: [[dx, dy, 角度, 缩放], …]（绕画面中心，图层照着摆就稳了）
"""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np


def load_meta(d: Path) -> dict:
    m = d / "meta.json"
    if not m.exists():
        sys.exit(f"{d} 里没有 meta.json：先用 python tools/footage.py <视频> --name <名字> 抽帧")
    return json.loads(m.read_text(encoding="utf-8"))


def frame_paths(d: Path, meta: dict) -> list[Path]:
    ext = meta["pattern"].split(".")[-1]
    n = meta["pattern"].count("#")
    return [d / f"{i:0{n}d}.{ext}" for i in range(meta["first"], meta["last"] + 1)]


def gray(p: Path) -> np.ndarray:
    im = cv2.imread(str(p), cv2.IMREAD_GRAYSCALE)
    if im is None:
        sys.exit(f"读不了 {p}")
    return im


LK = dict(winSize=(31, 31), maxLevel=4, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 40, 0.01))


def track_points(frames: list[Path], at: int, pts: np.ndarray, patch: int = 24, search: int = 60) -> np.ndarray:
    """Every frame's [x, y, conf] for each point, tracked forward and backward from frame index `at`."""
    n, k = len(frames), len(pts)
    out = np.zeros((n, k, 3), np.float64)
    ref = gray(frames[at])
    tpl = [ref[max(0, int(y) - patch):int(y) + patch + 1, max(0, int(x) - patch):int(x) + patch + 1].copy() for x, y in pts]
    out[at, :, :2] = pts
    out[at, :, 2] = 1
    for step in (1, -1):
        prev, p = ref, pts.astype(np.float32).reshape(-1, 1, 2)
        i = at + step
        while 0 <= i < n:
            cur = gray(frames[i])
            nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev, cur, p, None, **LK)
            back, st2, _ = cv2.calcOpticalFlowPyrLK(cur, prev, nxt, None, **LK)
            fb = np.linalg.norm((back - p).reshape(-1, 2), axis=1)
            for j in range(k):
                x, y = nxt[j, 0]
                ok = st[j, 0] == 1 and st2[j, 0] == 1 and fb[j] < 1.5
                conf = float(np.exp(-fb[j])) if ok else 0.0
                if not ok and tpl[j].size:
                    # lost: look for the template around the last place
                    px, py = p[j, 0]
                    x0, y0 = max(0, int(px) - search), max(0, int(py) - search)
                    win = cur[y0:int(py) + search, x0:int(px) + search]
                    if win.shape[0] > tpl[j].shape[0] and win.shape[1] > tpl[j].shape[1]:
                        r = cv2.matchTemplate(win, tpl[j], cv2.TM_CCOEFF_NORMED)
                        _, mv, _, ml = cv2.minMaxLoc(r)
                        if mv > 0.6:
                            x, y = x0 + ml[0] + min(patch, int(pts[j][0])), y0 + ml[1] + min(patch, int(pts[j][1]))
                            conf = float(mv) * 0.8
                        else:
                            x, y = px, py
                    else:
                        x, y = px, py
                    nxt[j, 0] = (x, y)
                out[i, j] = (x, y, conf)
            prev, p = cur, nxt
            i += step
    return out


def track_planar(frames: list[Path], at: int, corners: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Every frame's 4 corners (and a confidence): LK features + RANSAC homography, refined to the reference by ECC."""
    n = len(frames)
    ref = gray(frames[at])
    h, w = ref.shape
    mask = np.zeros_like(ref)
    cv2.fillConvexPoly(mask, corners.astype(np.int32), 255)
    # the reference patch for ECC: the region's bounding box (plus a margin) in the reference frame
    x0, y0 = np.maximum(corners.min(0).astype(int) - 8, 0)
    x1, y1 = np.minimum(corners.max(0).astype(int) + 8, [w - 1, h - 1])
    ref_patch = ref[y0:y1, x0:x1].astype(np.float32)
    patch_mask = mask[y0:y1, x0:x1]
    off = np.array([[1, 0, x0], [0, 1, y0], [0, 0, 1]], np.float64)
    out = np.zeros((n, 4, 2), np.float64)
    conf = np.zeros(n)
    out[at], conf[at] = corners, 1

    def seed(img: np.ndarray, H: np.ndarray):
        # features inside the region in this frame, and where they are in the reference
        m = np.zeros_like(img)
        cv2.fillConvexPoly(m, cv2.perspectiveTransform(corners.reshape(-1, 1, 2), H).reshape(-1, 2).astype(np.int32), 255)
        f = cv2.goodFeaturesToTrack(img, 400, 0.01, 6, mask=m)
        if f is None:
            return None, None
        return f.astype(np.float32), cv2.perspectiveTransform(f.astype(np.float64), np.linalg.inv(H)).astype(np.float32)

    for step in (1, -1):
        H = np.eye(3)
        prev = ref
        cur_f, ref_f = seed(ref, H)
        i = at + step
        while 0 <= i < n:
            cur = gray(frames[i])
            ok_lk = False
            if cur_f is not None and len(cur_f) >= 8:
                nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev, cur, cur_f, None, **LK)
                good = st.reshape(-1) == 1
                if good.sum() >= 8:
                    Hn, inl = cv2.findHomography(ref_f[good], nxt[good], cv2.RANSAC, 2.0)
                    if Hn is not None:
                        H, ok_lk = Hn, True
                        keep = np.zeros(len(good), bool)
                        keep[np.flatnonzero(good)[inl.reshape(-1) == 1]] = True
                        cur_f, ref_f = nxt[keep], ref_f[keep]
            # ECC: the current frame warped back into the reference patch's place, aligned to it
            c = 0.0
            try:
                Hp = H @ off  # patch px → current frame
                warped = cv2.warpPerspective(cur, Hp, (x1 - x0, y1 - y0), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP).astype(np.float32)
                Wc = np.eye(3, dtype=np.float32)
                c, Wc = cv2.findTransformECC(ref_patch, warped, Wc, cv2.MOTION_HOMOGRAPHY,
                                             (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 60, 1e-5), patch_mask, 5)
                # warped(q) = cur(Hp q); ECC: ref(q) ≈ warped(Wc q) → ref(q) ≈ cur(Hp Wc q)
                H = Hp @ Wc.astype(np.float64) @ np.linalg.inv(off)
            except cv2.error:
                if not ok_lk:
                    c = 0.0
            out[i] = cv2.perspectiveTransform(corners.reshape(-1, 1, 2).astype(np.float64), H).reshape(4, 2)
            conf[i] = max(0.0, float(c))
            if cur_f is None or len(cur_f) < 40:
                cur_f, ref_f = seed(cur, H)
            prev = cur
            i += step
    return out, conf


def stabilize(frames: list[Path], smooth: float, lock: bool) -> tuple[np.ndarray, list[float]]:
    """Per frame [dx, dy, angle, scale] about the frame centre that moves the frame onto the smoothed (or locked) path."""
    n = len(frames)
    prev = gray(frames[0])
    h, w = prev.shape
    c = np.array([w / 2, h / 2])
    # cumulative similarity from frame 0 to frame i, as 3x3
    C = [np.eye(3)]
    for i in range(1, n):
        cur = gray(frames[i])
        f = cv2.goodFeaturesToTrack(prev, 600, 0.01, 12)
        M = None
        if f is not None and len(f) >= 6:
            nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev, cur, f, None, **LK)
            g = st.reshape(-1) == 1
            if g.sum() >= 6:
                M, _ = cv2.estimateAffinePartial2D(f[g], nxt[g], method=cv2.RANSAC, ransacReprojThreshold=2.0)
        step = np.vstack([M, [0, 0, 1]]) if M is not None else np.eye(3)
        C.append(step @ C[-1])
        prev = cur
    # the path as (tx, ty, angle, log scale) of where frame 0's centre goes, smoothed
    par = []
    for A in C:
        s = float(np.hypot(A[0, 0], A[1, 0]))
        a = float(np.arctan2(A[1, 0], A[0, 0]))
        p = A[:2, :2] @ c + A[:2, 2]
        par.append([p[0] - c[0], p[1] - c[1], a, np.log(max(s, 1e-6))])
    par = np.array(par)
    par[:, 2] = np.unwrap(par[:, 2])
    if lock:
        tgt = np.zeros_like(par)
    else:
        k = max(1, int(smooth * 3))
        x = np.arange(-k, k + 1)
        g = np.exp(-0.5 * (x / max(smooth, 1e-6)) ** 2)
        g /= g.sum()
        pad = np.pad(par, ((k, k), (0, 0)), mode="edge")
        tgt = np.stack([np.convolve(pad[:, j], g, mode="valid") for j in range(4)], 1)
    out = []
    for (ptx, pty, pa, ps), (ttx, tty, ta, ts) in zip(par, tgt):
        # the correction p' = c + d + sc·R(da)·(p − c): frame 0's centre (now at c + actual) lands at c + target
        da, sc = ta - pa, float(np.exp(ts - ps))
        R = np.array([[np.cos(da), -np.sin(da)], [np.sin(da), np.cos(da)]])
        d = np.array([ttx, tty]) - sc * (R @ np.array([ptx, pty]))
        out.append([float(d[0]), float(d[1]), float(np.degrees(da)), sc])
    return np.array(out), [float(c[0]), float(c[1])]


def pick(frames: list[Path], at: int, out: Path):
    im = cv2.imread(str(frames[at]))
    h, w = im.shape[:2]
    step = 50 if max(w, h) <= 1400 else 100
    for x in range(0, w, step):
        cv2.line(im, (x, 0), (x, h), (255, 255, 255) if x % (step * 2) == 0 else (128, 128, 128), 1)
        cv2.putText(im, str(x), (x + 2, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 255), 1, cv2.LINE_AA)
    for y in range(0, h, step):
        cv2.line(im, (0, y), (w, y), (255, 255, 255) if y % (step * 2) == 0 else (128, 128, 128), 1)
        cv2.putText(im, str(y), (2, y - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 255), 1, cv2.LINE_AA)
    cv2.imwrite(str(out), im)
    print(f"带坐标网格的第 {at + 1} 帧：{out}")


def pts_arg(vals: list[str]) -> np.ndarray:
    return np.array([[float(v) for v in s.split(",")] for s in vals], np.float64)


def main(argv=None):
    ap = argparse.ArgumentParser(description="跟踪：点、平面、稳定（见文件开头）")
    ap.add_argument("mode", choices=["point", "planar", "stabilize", "pick"])
    ap.add_argument("dir", help="footage.py 抽的帧目录（有 meta.json）")
    ap.add_argument("--at", type=int, default=1, help="参考帧（帧号，从 1 起；点和角都在这一帧上给）")
    ap.add_argument("--points", nargs="+", help="点跟踪的点：x,y …（素材像素）")
    ap.add_argument("--labels", nargs="+", help="点的名字（默认 p0 p1 …）")
    ap.add_argument("--corners", nargs=4, help="平面跟踪的四个角：左上 右上 右下 左下，各 x,y")
    ap.add_argument("--smooth", type=float, default=15, help="稳定：平滑的高斯标准差（帧），越大越稳、越飘")
    ap.add_argument("--lock", action="store_true", help="稳定：完全锁住（像三脚架）")
    ap.add_argument("--from", dest="frm", type=int, help="只跟这一帧号起")
    ap.add_argument("--to", type=int, help="到这一帧号止")
    ap.add_argument("--name", help="结果名，写到 <帧目录>/track_<name>.json")
    a = ap.parse_args(argv)
    d = Path(a.dir)
    meta = load_meta(d)
    frames = frame_paths(d, meta)
    lo = (a.frm or meta["first"]) - meta["first"]
    hi = (a.to or meta["last"]) - meta["first"]
    frames = frames[lo:hi + 1]
    at = a.at - meta["first"] - lo
    if not 0 <= at < len(frames):
        sys.exit(f"--at {a.at} 不在跟踪的帧里")
    if a.mode == "pick":
        pick(frames, at, d / f"pick_{a.at:05d}.png")
        return
    res = {"type": a.mode, "fps": meta["fps"], "first": meta["first"] + lo, "size": [meta["width"], meta["height"]], "frames": len(frames)}
    if a.mode == "point":
        if not a.points:
            sys.exit("点跟踪要 --points x,y …")
        p = pts_arg(a.points)
        tr = track_points(frames, at, p)
        names = a.labels or [f"p{i}" for i in range(len(p))]
        res["points"] = {nm: [[round(float(v), 3) for v in tr[i, j]] for i in range(len(frames))] for j, nm in enumerate(names)}
        lost = {nm: int((tr[:, j, 2] < 0.2).sum()) for j, nm in enumerate(names)}
        print("可信度低（< 0.2）的帧数：", lost)
    elif a.mode == "planar":
        if not a.corners:
            sys.exit("平面跟踪要 --corners 四个 x,y")
        cs, conf = track_planar(frames, at, pts_arg(a.corners))
        res["corners"] = [[[round(float(x), 3), round(float(y), 3)] for x, y in f] for f in cs]
        res["conf"] = [round(float(c), 4) for c in conf]
        print(f"ECC 相关系数：中位 {np.median(conf):.3f}，最低 {conf.min():.3f}（第 {int(conf.argmin()) + res['first']} 帧）")
    else:
        xf, c = stabilize(frames, a.smooth, a.lock)
        res["xform"] = [[round(float(v), 4) for v in r] for r in xf]
        res["center"] = c
        print(f"补偿最大平移 {np.abs(xf[:, :2]).max():.1f} px、最大旋转 {np.abs(xf[:, 2]).max():.2f}°：图层放大一点盖住露出的边")
    out = d / f"track_{a.name or a.mode}.json"
    out.write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
    print(f"写好 {out}")


if __name__ == "__main__":
    main()

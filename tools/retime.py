"""光流变速和像素运动模糊（AE 的 Timewarp / Twixtor、RSMB）：在 tools/footage.py 抽好的序列帧之间按光流补帧，写成新的序列帧目录，
app 里照样用 loadFootage 读。光流用 OpenCV 自带的 DIS（不用下载模型）。

  # 在项目根目录跑；<帧目录> 是 footage.py 写的 assets/footage/<名字>/
  python tools/retime.py assets/footage/clip --speed 0.25 --name clip_slow       # 4 倍慢放（帧率不变，帧数 ×4）
  python tools/retime.py assets/footage/clip --fps 120 --name clip_120           # 时长不变，补到 120 fps
  python tools/retime.py assets/footage/clip --curve 0:1,1.5:0.2,3:1 --name ramp # 变速曲线：输出秒:速度，速度按线性插值（升格再回正常）
  python tools/retime.py assets/footage/clip --map 0:0,2:0.5,4:3 --name remap    # 时间重映射：输出秒:原片秒（AE 的 Time Remap）
  python tools/retime.py assets/footage/clip --blur 0.5 --name clip_mb           # 像素运动模糊：半个快门（180°），按光流在一帧内多采几次
  可选：--blur 和变速一起用；--samples 8（运动模糊每帧采几次）；--preset ultrafast | fast | medium（光流精度，medium 最准，默认）

做法：相邻两帧求前后两个方向的光流，中间时刻按「线性运动」近似出指向两帧的光流（Super SloMo 的近似），各自反向取样，
按前后一致性给遮挡处降权后混合。快速运动、半透明、大面积遮挡处会有拉丝或重影，和 Timewarp 一样要看一眼。
结果写到 assets/footage/<name>/（00001.jpg … + meta.json），帧格式跟原素材（png 素材出 png）。
"""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from track import frame_paths, load_meta  # noqa: E402

PRESETS = {"ultrafast": cv2.DISOPTICAL_FLOW_PRESET_ULTRAFAST, "fast": cv2.DISOPTICAL_FLOW_PRESET_FAST, "medium": cv2.DISOPTICAL_FLOW_PRESET_MEDIUM}


class Flow:
    """Optical flow between frames (DIS), cached per pair: flow(a, b)(x) = where a's pixel x is in b, minus x."""

    def __init__(self, preset: str = "medium"):
        self.dis = cv2.DISOpticalFlow_create(PRESETS[preset])
        self.cache: dict = {}

    def __call__(self, ga: np.ndarray, gb: np.ndarray, key=None) -> np.ndarray:
        if key is not None and key in self.cache:
            return self.cache[key]
        f = self.dis.calc(ga, gb, None)
        if key is not None:
            if len(self.cache) > 16:
                self.cache.pop(next(iter(self.cache)))
            self.cache[key] = f
        return f


def grid(h: int, w: int) -> np.ndarray:
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    return np.dstack([gx, gy])


def warp(img: np.ndarray, g: np.ndarray, f: np.ndarray) -> np.ndarray:
    m = g + f
    return cv2.remap(img, m[..., 0], m[..., 1], cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def between(I0: np.ndarray, I1: np.ndarray, F01: np.ndarray, F10: np.ndarray, u: float, g: np.ndarray) -> np.ndarray:
    """The frame at u (0–1) between I0 and I1."""
    if u <= 1e-4:
        return I0
    if u >= 1 - 1e-4:
        return I1
    Ft0 = -(1 - u) * u * F01 + u * u * F10
    Ft1 = (1 - u) ** 2 * F01 - u * (1 - u) * F10
    # how well each frame's flow agrees with the other way back (low = occluded there)
    e0 = np.linalg.norm(F01 + warp(F10, g, F01), axis=2)
    e1 = np.linalg.norm(F10 + warp(F01, g, F10), axis=2)
    v0 = np.exp(-warp(e0, g, Ft0) / 2.0)[..., None]
    v1 = np.exp(-warp(e1, g, Ft1) / 2.0)[..., None]
    w0, w1 = warp(I0.astype(np.float32), g, Ft0), warp(I1.astype(np.float32), g, Ft1)
    a, b = (1 - u) * v0, u * v1
    return (a * w0 + b * w1) / np.maximum(a + b, 1e-6)


class Source:
    """The footage frames with flow-interpolated in-betweens at any source time."""

    def __init__(self, d: Path, preset: str):
        self.meta = load_meta(d)
        self.paths = frame_paths(d, self.meta)
        self.fps = float(self.meta["fps"])
        self.flow = Flow(preset)
        self.imgs: dict = {}
        im = self.img(0)
        self.g = grid(im.shape[0], im.shape[1])

    def img(self, i: int) -> np.ndarray:
        i = min(len(self.paths) - 1, max(0, i))
        if i not in self.imgs:
            if len(self.imgs) > 8:
                self.imgs.pop(next(iter(self.imgs)))
            im = cv2.imread(str(self.paths[i]), cv2.IMREAD_UNCHANGED)
            if im is None:
                sys.exit(f"读不了 {self.paths[i]}")
            self.imgs[i] = im
        return self.imgs[i]

    def gray(self, i: int) -> np.ndarray:
        im = self.img(i)
        return cv2.cvtColor(im[..., :3], cv2.COLOR_BGR2GRAY) if im.ndim == 3 else im

    def at(self, s: float) -> np.ndarray:
        """The frame at source time s (seconds from the first frame), float32."""
        x = min(len(self.paths) - 1, max(0.0, s * self.fps))
        i = int(np.floor(x))
        u = x - i
        if u < 1e-4 or i >= len(self.paths) - 1:
            return self.img(i).astype(np.float32)
        F01 = self.flow(self.gray(i), self.gray(i + 1), (i, i + 1))
        F10 = self.flow(self.gray(i + 1), self.gray(i), (i + 1, i))
        return between(self.img(i), self.img(i + 1), F01, F10, u, self.g)


def keys_arg(s: str) -> list[tuple[float, float]]:
    return sorted((float(a), float(b)) for a, b in (kv.split(":") for kv in s.split(",")))


def interp(keys: list[tuple[float, float]], x: float) -> float:
    if x <= keys[0][0]:
        return keys[0][1]
    for (x0, y0), (x1, y1) in zip(keys, keys[1:]):
        if x <= x1:
            return y0 + (y1 - y0) * (x - x0) / max(x1 - x0, 1e-9)
    return keys[-1][1]


def main(argv=None):
    ap = argparse.ArgumentParser(description="光流变速、补帧、像素运动模糊（见文件开头）")
    ap.add_argument("dir", help="footage.py 抽的帧目录（有 meta.json）")
    ap.add_argument("--name", required=True, help="输出的素材名：写到 assets/footage/<name>/（和输入同一个父目录）")
    ap.add_argument("--speed", type=float, help="恒定速度：0.25 = 4 倍慢放")
    ap.add_argument("--fps", type=float, help="输出帧率（默认同原片）")
    ap.add_argument("--curve", help="变速曲线 输出秒:速度,…")
    ap.add_argument("--map", help="时间重映射 输出秒:原片秒,…")
    ap.add_argument("--duration", type=float, help="输出多长（秒；默认用完原片为止）")
    ap.add_argument("--blur", type=float, default=0.0, help="像素运动模糊的快门（输出一帧的比例，0.5 = 180°）")
    ap.add_argument("--samples", type=int, default=8, help="运动模糊每帧采几次")
    ap.add_argument("--preset", choices=list(PRESETS), default="medium")
    a = ap.parse_args(argv)
    d = Path(a.dir)
    src = Source(d, a.preset)
    fps_in, n_in = src.fps, len(src.paths)
    fps_out = a.fps or fps_in
    src_len = (n_in - 1) / fps_in
    if a.map:
        mk = keys_arg(a.map)
        s_of = lambda t: interp(mk, t)  # noqa: E731
        dur = a.duration or mk[-1][0]
    elif a.curve:
        ck = keys_arg(a.curve)
        # integrate the speed curve over output time
        dt, ts, ss = 1 / (fps_out * 8), [0.0], [0.0]
        while ss[-1] < src_len and len(ts) < 10_000_000 and (a.duration is None or ts[-1] < a.duration):
            ss.append(ss[-1] + interp(ck, ts[-1]) * dt)
            ts.append(ts[-1] + dt)
        T, S = np.array(ts), np.array(ss)
        s_of = lambda t: float(np.interp(t, T, S))  # noqa: E731
        dur = a.duration or float(T[-1])
    else:
        k = a.speed or 1.0
        s_of = lambda t: t * k  # noqa: E731
        dur = a.duration or src_len / k
    n_out = int(np.floor(dur * fps_out + 1e-6)) + 1
    out = d.parent / a.name
    out.mkdir(parents=True, exist_ok=True)
    ext = src.meta["pattern"].split(".")[-1]
    for j in range(n_out):
        t = j / fps_out
        if a.blur > 0:
            span = a.blur / fps_out
            acc = None
            for q in range(a.samples):
                tt = t + span * ((q + 0.5) / a.samples - 0.5)
                f = src.at(min(src_len, max(0.0, s_of(tt))))
                acc = f if acc is None else acc + f
            frame = acc / a.samples
        else:
            frame = src.at(min(src_len, max(0.0, s_of(t))))
        img = np.clip(frame + 0.5, 0, 255).astype(np.uint8)
        p = out / f"{j + 1:05d}.{ext}"
        cv2.imwrite(str(p), img, [cv2.IMWRITE_JPEG_QUALITY, 95] if ext == "jpg" else [])
        if j % 30 == 0 or j == n_out - 1:
            print(f"\r{j + 1}/{n_out}", end="", flush=True)
    print()
    meta = {**src.meta, "fps": fps_out, "first": 1, "last": n_out, "duration": n_out / fps_out, "source": f"retime of {d.name}"}
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"写好 {out}：{n_out} 帧，{fps_out:g} fps")


if __name__ == "__main__":
    main()

"""视频抽帧和逐帧变化量（seams.py、refmatch.py 共用）。帧经 ffmpeg 解码成小尺寸原始像素，按 fps 重采样。"""
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ffmpeg_path import FFMPEG, FFPROBE  # noqa: E402

# 逐帧变化量的标准尺寸：320×180 灰度（连贯性交接.md 的数据都按这个量）
DIFF_W, DIFF_H = 320, 180


def duration(path: str) -> float:
    out = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
                         capture_output=True, text=True).stdout.strip()
    return float(out)


def has_audio(path: str) -> bool:
    out = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", path],
                         capture_output=True, text=True).stdout.strip()
    return bool(out)


def decode(path: str, start: float, dur: float, fps: float = 30, size: tuple[int, int] = (DIFF_W, DIFF_H), gray: bool = True) -> np.ndarray:
    """[start, start + dur) 按 fps 抽帧：灰度 (n, h, w) 或 RGB (n, h, w, 3)，uint8。"""
    w, h = size
    fmt, ch = ("gray", 1) if gray else ("rgb24", 3)
    args = [FFMPEG, "-v", "error", "-ss", f"{max(0.0, start):.4f}", "-t", f"{dur:.4f}", "-i", path,
            "-vf", f"fps={fps},scale={w}:{h}:flags=area,format={fmt}", "-f", "rawvideo", "-"]
    b = subprocess.run(args, capture_output=True, check=True).stdout
    n = len(b) // (w * h * ch)
    a = np.frombuffer(b[: n * w * h * ch], np.uint8)
    return a.reshape(n, h, w) if gray else a.reshape(n, h, w, 3)


def frame_diff(frames: np.ndarray) -> np.ndarray:
    """相邻帧平均绝对差（0–255）。第 k 个值是帧 k → k+1 的变化。"""
    f = frames.astype(np.float32)
    if f.ndim == 4:
        f = f.mean(axis=3)
    return np.abs(np.diff(f, axis=0)).mean(axis=(1, 2))


def decode_audio(path: str, start: float, dur: float, sr: int = 48000) -> np.ndarray | None:
    """[start, start + dur) 的音频，(n, 2) float32；没有音轨返回 None。"""
    if not has_audio(path):
        return None
    args = [FFMPEG, "-v", "error", "-ss", f"{max(0.0, start):.4f}", "-t", f"{dur:.4f}", "-i", path, "-vn", "-ac", "2", "-ar", str(sr),
            "-f", "f32le", "-"]
    b = subprocess.run(args, capture_output=True, check=True).stdout
    return np.frombuffer(b, np.float32).reshape(-1, 2)

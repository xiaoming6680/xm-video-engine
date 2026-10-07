"""成片技术检查：响度 / 真峰值、空帧、闪光（3×3 分区）、音画偏移、色彩标签。docs/质量验收.md 第三节「技术」。

用法：
  python tools/qa/check_video.py out/final.mp4 [--song audio/song.wav --start 0] [--douyin out/wip/douyin_test.mp4]

- 闪光：画面分 3×3 区，每区按线性相对亮度 Y 找相反方向的成对变化（一次变化 ≥ 0.1，暗的一端 < 0.8，
  约等于 200 nit 显示器上 20 cd/m²、暗端 < 160 cd/m²），任一区任意 1 秒内超过 3 次闪烁（7 次变化）就不过。
  整帧平均亮度只看得见大面积同时闪；局部大闪（半边画面一亮一暗）要分区才看得出
- 音画偏移：成片音轨和原曲（--song，从 --start 起）做互相关，差几个采样。AAC 编码有 1024–2048 采样的起始延迟，
  靠 MP4 的 edit list 抵消；混流丢了它，声音会整体晚 20–40 ms。默认用项目的 audio/song.wav 和 src/config.ts 的 VIDEO_START
- --douyin 另外按抖音常见码率（1080p 约 6 Mbps）重编码一份，用来肉眼看暗部色带和糊块
任何一项不过时退出码为 1。
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from ffmpeg_path import FFMPEG, FFPROBE  # noqa: E402

TARGET_LUFS, LUFS_TOL, MAX_TP = -14.0, 1.5, -1.0
MAX_FLASH_PER_S = 3
FLASH_DY, FLASH_DARK = 0.1, 0.8      # 一次变化的亮度差、暗端上限（线性相对亮度）
MAX_AV_SAMPLES = 48                   # 音画偏移容差：1 ms（48 kHz）
REGION = ["左上", "上", "右上", "左", "中", "右", "左下", "下", "右下"]


def run(args: list[str]) -> str:
    p = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return p.stdout + p.stderr


def loudness(path: str) -> tuple[float, float]:
    out = run([FFMPEG, "-hide_banner", "-nostats", "-i", path, "-af", "ebur128=peak=true", "-f", "null", "-"])
    tail = out[out.rfind("Summary:"):]
    i = float(re.search(r"I:\s*(-?[\d.]+) LUFS", tail).group(1))
    tp = float(re.search(r"Peak:\s*(-?[\d.]+) dBFS", tail).group(1))
    return i, tp


def black_segments(path: str) -> list[tuple[float, float]]:
    out = run([FFMPEG, "-hide_banner", "-nostats", "-i", path, "-vf", "blackdetect=d=0.04:pix_th=0.06", "-an", "-f", "null", "-"])
    return [(float(a), float(b)) for a, b in re.findall(r"black_start:([\d.]+) black_end:([\d.]+)", out)]


# ---------------------------------------------------------------- 闪光
def region_luma(path: str, gw: int = 3, gh: int = 3) -> tuple[np.ndarray, float]:
    """每帧每区的平均线性相对亮度 (n, gh*gw)，和帧率。"""
    s = json.loads(run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "json", path]))
    num, den = s["streams"][0]["r_frame_rate"].split("/")
    fps = float(num) / float(den)
    w, h = 32 * gw, 18 * gh
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", path, "-vf", f"scale={w}:{h}:flags=area,format=rgb24", "-an", "-f", "rawvideo", "-"],
                         capture_output=True, check=True).stdout
    fr = np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)
    c = np.arange(256) / 255.0
    lut = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4).astype(np.float32)
    out = []
    for k in range(0, len(fr), 600):
        f = lut[fr[k:k + 600]]
        y = f[..., 0] * 0.2126 + f[..., 1] * 0.7152 + f[..., 2] * 0.0722
        out.append(y.reshape(len(y), gh, h // gh, gw, w // gw).mean(axis=(2, 4)).reshape(len(y), gh * gw))
    return np.concatenate(out), fps


def transitions(y: np.ndarray, dy: float = FLASH_DY, dark: float = FLASH_DARK) -> list[int]:
    """亮度曲线的折返点（zigzag：反向超过 dy 才算一次折返）之间，变化 ≥ dy 且暗端 < dark 的每一次变化，返回结束帧号。"""
    piv, trend, lo, hi, ext = [], 0, 0, 0, 0
    for i in range(1, len(y)):
        if trend == 0:
            if y[i] > y[hi]:
                hi = i
            if y[i] < y[lo]:
                lo = i
            if y[hi] - y[lo] >= dy:
                piv.append(min(lo, hi))
                trend, ext = (1, hi) if hi > lo else (-1, lo)
        elif trend == 1:
            if y[i] > y[ext]:
                ext = i
            elif y[ext] - y[i] >= dy:
                piv.append(ext)
                trend, ext = -1, i
        else:
            if y[i] < y[ext]:
                ext = i
            elif y[i] - y[ext] >= dy:
                piv.append(ext)
                trend, ext = 1, i
    if trend:
        piv.append(ext)
    return [b for a, b in zip(piv, piv[1:]) if abs(y[b] - y[a]) >= dy and min(y[a], y[b]) < dark]


def flash_report(ys: np.ndarray, fps: float) -> dict[str, list[tuple[float, float]]]:
    """每区（和整帧）任意 1 秒窗口里的闪烁次数（= 变化次数 / 2）超过上限的时刻：{区名: [(秒, 次数)]}。"""
    bad: dict[str, list[tuple[float, float]]] = {}
    cols = [(REGION[k], ys[:, k]) for k in range(ys.shape[1])] + [("整帧", ys.mean(axis=1))]
    win = int(round(fps))
    for name, y in cols:
        tr = np.array(transitions(y))
        if len(tr) < 2 * MAX_FLASH_PER_S + 1:
            continue
        hits = []
        for j in range(len(tr)):
            n = int(((tr >= tr[j]) & (tr < tr[j] + win)).sum())
            if n / 2 > MAX_FLASH_PER_S:
                hits.append((tr[j] / fps, n / 2))
        if hits:
            merged = [hits[0]]
            for t, n in hits[1:]:
                if t - merged[-1][0] < 1:
                    merged[-1] = (merged[-1][0], max(merged[-1][1], n))
                else:
                    merged.append((t, n))
            bad[name] = merged
    return bad


# ---------------------------------------------------------------- 音画偏移
def stream_starts(path: str) -> dict[str, float]:
    s = json.loads(run([FFPROBE, "-v", "error", "-show_entries", "stream=codec_type,start_time", "-of", "json", path]))
    return {x["codec_type"]: float(x.get("start_time", 0) or 0) for x in s["streams"]}


def av_offset(video: str, song: str, start: float, dur: float = 20.0, sr: int = 48000) -> int | None:
    """成片音轨相对原曲（从 start 起）晚了几个采样（负数 = 早）；没有音轨返回 None。"""
    from frames import decode_audio
    v = decode_audio(video, 0, dur, sr)
    s = decode_audio(song, start, dur, sr)
    if v is None or s is None or len(v) < sr or len(s) < sr:
        return None
    v, s = v.mean(axis=1), s.mean(axis=1)
    n = min(len(v), len(s))
    v, s = v[:n] - v[:n].mean(), s[:n] - s[:n].mean()
    m = 1 << int(np.ceil(np.log2(2 * n)))
    c = np.fft.irfft(np.fft.rfft(v, m) * np.conj(np.fft.rfft(s, m)), m)
    lim = int(0.25 * sr)
    lags = np.concatenate([np.arange(0, lim), np.arange(-lim, 0)])
    vals = np.concatenate([c[:lim], c[-lim:]])
    return int(lags[int(np.argmax(vals))])


def config_video_start(root: Path) -> float:
    cfg = root / "app/src/config.ts"
    if cfg.exists():
        m = re.search(r"VIDEO_START\s*=\s*([\d.]+)", cfg.read_text(encoding="utf-8"))
        if m:
            return float(m.group(1))
    return 0.0


def color_tags(path: str) -> dict:
    out = run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
               "stream=width,height,r_frame_rate,pix_fmt,color_space,color_primaries,color_transfer,color_range", "-of", "json", path])
    return json.loads(out)["streams"][0]


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video")
    ap.add_argument("--song", help="原曲（量音画偏移）；默认项目的 audio/song.wav（存在时）")
    ap.add_argument("--start", type=float, help="成片 0 秒对应原曲的秒数；默认 src/config.ts 的 VIDEO_START")
    ap.add_argument("--douyin", help="按抖音常见码率重编码一份到这个路径")
    a = ap.parse_args()
    bad = False
    root = Path.cwd()

    v = color_tags(a.video)
    print(f"视频：{v['width']}x{v['height']} {v['r_frame_rate']} {v['pix_fmt']}")
    tags = (v.get("color_space"), v.get("color_primaries"), v.get("color_transfer"))
    ok = tags == ("bt709", "bt709", "bt709")
    bad |= not ok
    print(f"[{'OK' if ok else '!!'}] 色彩标签 space/primaries/transfer = {tags}（应为 bt709）")

    try:
        i, tp = loudness(a.video)
        ok = abs(i - TARGET_LUFS) <= LUFS_TOL and tp <= MAX_TP
        bad |= not ok
        print(f"[{'OK' if ok else '!!'}] 响度 {i:.1f} LUFS（目标 {TARGET_LUFS}±{LUFS_TOL}），真峰值 {tp:.1f} dBTP（≤ {MAX_TP}）")
    except AttributeError:
        print("[--] 没有音轨，跳过响度")

    song = a.song or (str(root / "audio/song.wav") if (root / "audio/song.wav").exists() else None)
    if song:
        start = a.start if a.start is not None else config_video_start(root)
        off = av_offset(a.video, song, start)
        st = stream_starts(a.video)
        if off is None:
            print("[--] 没有音轨，跳过音画偏移")
        else:
            ok = abs(off) <= MAX_AV_SAMPLES
            bad |= not ok
            print(f"[{'OK' if ok else '!!'}] 音画偏移 {off:+d} 采样（{off / 48:+.2f} ms，容差 ±{MAX_AV_SAMPLES}）；"
                  f"流起点 视频 {st.get('video', 0):.4f}s / 音频 {st.get('audio', 0):.4f}s（原曲 {Path(song).name} 从 {start:g}s 起）")
    else:
        print("[--] 没有原曲（--song），跳过音画偏移")

    segs = black_segments(a.video)
    bad |= bool(segs)
    print(f"[{'OK' if not segs else '!!'}] 空帧 / 黑场：{len(segs)} 段" + "".join(f"\n      {s:.2f}–{e:.2f}s" for s, e in segs))

    ys, fps = region_luma(a.video)
    fl = flash_report(ys, fps)
    bad |= bool(fl)
    print(f"[{'OK' if not fl else '!!'}] 闪光：3×3 分区，每区每秒 ≤ {MAX_FLASH_PER_S} 次" +
          "".join(f"\n      {name}：" + "，".join(f"{t:.1f}s 起 {n:g} 次/秒" for t, n in hits) for name, hits in fl.items()))

    if a.douyin:
        Path(a.douyin).parent.mkdir(parents=True, exist_ok=True)
        run([FFMPEG, "-y", "-hide_banner", "-i", a.video, "-c:v", "libx264", "-b:v", "6M", "-maxrate", "6M", "-bufsize", "12M",
             "-preset", "medium", "-c:a", "aac", "-b:a", "128k", a.douyin])
        print(f"[--] 抖音码率重编码：{a.douyin}（肉眼看暗部色带和细节）")

    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()

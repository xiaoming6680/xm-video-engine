"""成片技术检查：响度 / 真峰值、空帧、大面积闪光、色彩标签。docs/质量验收.md 第三节「技术」。

用法：
  python tools/qa/check_video.py out/final.mp4 [--douyin out/wip/douyin_test.mp4]

--douyin 另外按抖音常见码率（1080p 约 6 Mbps）重编码一份，用来肉眼看暗部色带和糊块。
任何一项不过时退出码为 1。
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from ffmpeg_path import FFMPEG, FFPROBE  # noqa: E402

TARGET_LUFS, LUFS_TOL, MAX_TP = -14.0, 1.5, -1.0
MAX_FLASH_PER_S = 3


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


def flashes(path: str) -> list[tuple[int, int]]:
    """大面积闪光：画面平均亮度在一帧内跳变超过 20%（满量程）记一次；按整秒统计。"""
    out = run([FFMPEG, "-hide_banner", "-nostats", "-i", path, "-vf", "scale=160:-2,signalstats,metadata=print:key=lavfi.signalstats.YAVG", "-an", "-f", "null", "-"])
    ts = [float(t) for t in re.findall(r"pts_time:([\d.]+)", out)]
    ys = [float(y) for y in re.findall(r"YAVG=([\d.]+)", out)]
    per_s: dict[int, int] = {}
    for k in range(1, min(len(ts), len(ys))):
        if abs(ys[k] - ys[k - 1]) > 0.2 * 235:
            s = int(ts[k])
            per_s[s] = per_s.get(s, 0) + 1
    return sorted(per_s.items())


def color_tags(path: str) -> dict:
    out = run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
               "stream=width,height,r_frame_rate,pix_fmt,color_space,color_primaries,color_transfer,color_range", "-of", "json", path])
    return json.loads(out)["streams"][0]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--douyin", help="按抖音常见码率重编码一份到这个路径")
    a = ap.parse_args()
    bad = False

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

    segs = black_segments(a.video)
    bad |= bool(segs)
    print(f"[{'OK' if not segs else '!!'}] 空帧 / 黑场：{len(segs)} 段" + "".join(f"\n      {s:.2f}–{e:.2f}s" for s, e in segs))

    fl = [(s, n) for s, n in flashes(a.video) if n > MAX_FLASH_PER_S]
    bad |= bool(fl)
    print(f"[{'OK' if not fl else '!!'}] 大面积闪光每秒 ≤ {MAX_FLASH_PER_S} 次" + "".join(f"\n      第 {s} 秒：{n} 次" for s, n in fl))

    if a.douyin:
        Path(a.douyin).parent.mkdir(parents=True, exist_ok=True)
        run([FFMPEG, "-y", "-hide_banner", "-i", a.video, "-c:v", "libx264", "-b:v", "6M", "-maxrate", "6M", "-bufsize", "12M",
             "-preset", "medium", "-c:a", "aac", "-b:a", "128k", a.douyin])
        print(f"[--] 抖音码率重编码：{a.douyin}（肉眼看暗部色带和细节）")

    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()

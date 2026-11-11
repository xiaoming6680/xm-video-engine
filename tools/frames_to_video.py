"""序列帧 + 音频 → 成片，帧数绝对精确。不走 concat 列表，帧一张张写进 ffmpeg 的管道（concat 拼静帧卡片时可能多出 2 帧，整片晚 33 毫秒）。

  python <引擎>/tools/frames_to_video.py --frames assets/blender4k/x --frames assets/blender4k/r --from 0 --to 82 --audio 歌.flac --out out/release/片.mp4
      [--fps 60] [--crf 17] [--preset medium] [--res 1920x1080] [--card 片头.png --card-secs 4.5] [--af "volume=-6dB"] [--fade-out 0.38]

文件名是歌曲帧号（歌曲秒 × fps，4 位数字），--frames 可以给多个目录：同一帧号用排在前面的那个。缺帧就报错，不补。
--card：片头卡片（任意图片，比如按这支片设计的警告卡），淡入淡出，声音从卡片结束后才开始（检查音画时 check_video.py --lead 同一个秒数）。
AAC 编码会让真峰值过冲：源文件很响时用 --af "volume=-6dB"，编码器固定 fast，比限幅器管用。
"""
import argparse
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ffmpeg_path import FFMPEG  # noqa: E402


def read(p):
    return cv2.imdecode(np.fromfile(str(p), dtype=np.uint8), cv2.IMREAD_COLOR)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--frames", action="append", required=True)
    ap.add_argument("--from", dest="t0", type=float, required=True)
    ap.add_argument("--to", dest="t1", type=float, required=True)
    ap.add_argument("--audio", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--crf", default="17")
    ap.add_argument("--preset", default="medium")
    ap.add_argument("--res", default="")
    ap.add_argument("--card", default="")
    ap.add_argument("--card-secs", type=float, default=0.0)
    ap.add_argument("--af", default="")
    ap.add_argument("--fade-out", type=float, default=0.0)
    a = ap.parse_args()
    dirs = [Path(d) for d in a.frames]
    f0, f1 = round(a.t0 * a.fps), round(a.t1 * a.fps)

    def src(f):
        for d in dirs:
            p = d / f"{f:04d}.png"
            if p.exists():
                return p
        return None

    missing = [f for f in range(f0, f1) if src(f) is None]
    if missing:
        sys.exit(f"缺 {len(missing)} 帧，例如 {missing[:6]}")
    h, w = read(src(f0)).shape[:2]
    vf = "scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709"
    if a.res:
        W, H = a.res.split("x")
        vf = f"scale={W}:{H}:flags=lanczos," + vf
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(a.fps), "-i", "-"]
    if a.audio:
        cmd += ["-ss", f"{a.t0:.4f}", "-t", f"{a.t1 - a.t0:.4f}", "-i", a.audio, "-map", "0:v", "-map", "1:a"]
        af = [x for x in [a.af, "aresample=48000"] if x]
        if a.fade_out:
            af.append(f"afade=t=out:st={a.t1 - a.t0 - a.fade_out:.3f}:d={a.fade_out}:curve=hsin")
        if a.card_secs:
            af.append(f"adelay={int(a.card_secs * 1000)}:all=1")
        cmd += ["-af", ",".join(af), "-c:a", "aac", "-aac_coder", "fast", "-b:a", "320k"]
    cmd += ["-c:v", "libx264", "-preset", a.preset, "-crf", a.crf, "-pix_fmt", "yuv420p", "-vf", vf, "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv", "-movflags", "+faststart", str(out)]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    n = 0
    if a.card:
        im = read(a.card)
        if im.shape[:2] != (h, w):
            im = cv2.resize(im, (w, h), interpolation=cv2.INTER_AREA)
        bg = np.full_like(im, im[0, 0])
        total, fade = round(a.card_secs * a.fps), round(0.25 * a.fps)
        for i in range(total):
            g = min((i + 1) / (fade + 1), (total - i) / (fade + 1), 1.0)
            fr = im if g >= 1 else (bg * (1 - g) + im * g + 0.5).astype(np.uint8)
            p.stdin.write(fr.tobytes())
            n += 1
    for f in range(f0, f1):
        p.stdin.write(read(src(f)).tobytes())
        n += 1
    p.stdin.close()
    if p.wait():
        sys.exit("ffmpeg 失败")
    print(f"写好 {out}：{n} 帧，{n / a.fps:.3f} 秒")


if __name__ == "__main__":
    main()

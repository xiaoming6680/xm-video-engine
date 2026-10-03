"""抖音版合成（从 Falling_Again 的 douyin_mux.py 整理）：渲好的画面 + 一段配乐 → 发布用 MP4。

  python tools/douyin_mux.py out/douyin/video.mp4 audio/song.wav -o out/片名_抖音版.mp4
      [--audio-start 15.6667 | --audio-downbeat 10]  配乐从哪里开始（歌曲秒，或第 N 个强拍，从 0 数）
      [--gain -1.8]          音量（dB）：锐化后 AAC 会多冒一点峰值，压到真峰值 −1 dBTP 以下
      [--sharpen "unsharp=11:11:1.0"]  只动亮度的大半径锐化（Falling_Again 原片被机审判「画质模糊」时加的；none = 不锐化）
      [--fade-out 0.8]       最后几秒画面淡到黑（0 = 不淡）
      [--crf 18] [--maxrate 30M] [--fps 60]

画面通常先用 render-par.ts 单独渲（--from/--to 选段、--query 传场景参数）。输出保持 BT.709 标签，
做完用 tools/qa/check_video.py 查响度、闪光和标签。
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ffmpeg_path import FFMPEG, FFPROBE  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("audio")
    ap.add_argument("-o", "--out", required=True)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--audio-start", type=float, default=0.0)
    g.add_argument("--audio-downbeat", type=int, help="从 data/audio.json 的第 N 个强拍开始（保住强拍的起音）")
    ap.add_argument("--gain", type=float, default=-1.8)
    ap.add_argument("--sharpen", default="unsharp=11:11:1.0")
    ap.add_argument("--fade-out", type=float, default=0.8)
    ap.add_argument("--crf", default="18")
    ap.add_argument("--maxrate", default="30M")
    ap.add_argument("--fps", default="60")
    a = ap.parse_args()

    probe = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "json", a.video],
                           capture_output=True, text=True, check=True)
    dur = float(json.loads(probe.stdout)["format"]["duration"])
    start = a.audio_start
    if a.audio_downbeat is not None:
        start = json.loads(Path("data/audio.json").read_text(encoding="utf-8"))["downbeats"][a.audio_downbeat]

    audio = (f"[1:a]atrim=start={start:.4f},asetpts=PTS-STARTPTS,volume={a.gain}dB,"
             f"afade=t=in:d=0.003,apad=whole_dur={dur:.4f}[a]")
    vf = []
    if a.sharpen and a.sharpen != "none":
        vf.append(a.sharpen)
    if a.fade_out > 0:
        vf.append(f"fade=t=out:st={dur - a.fade_out:.4f}:d={a.fade_out}")
    # keep the BT.709 tags of the render (filters on yuv don't convert, but the tags must reach the new stream)
    vf.append("setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709")
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", a.video, "-i", a.audio,
                    "-filter_complex", f"[0:v]{','.join(vf)}[v];{audio}", "-map", "[v]", "-map", "[a]",
                    "-c:v", "libx264", "-preset", "slow", "-crf", a.crf, "-maxrate", a.maxrate, "-bufsize", "60M",
                    "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", a.fps,
                    "-c:a", "aac", "-b:a", "320k", "-ar", "48000", "-t", f"{dur:.4f}",
                    "-movflags", "+faststart", a.out], check=True)
    print(a.out, f"{dur:.3f} s")


if __name__ == "__main__":
    main()

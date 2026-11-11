"""速度已知的歌 → 一个歌曲目录，引擎用 `render.ts … --song <目录>`（预览 `?song=<目录>`）跑它，不动项目自己的 audio/、data/。

用途：复刻参考片时配它的原声（作者公布了 BPM），或者代码生成的音乐（乐谱本来就知道每一拍）。
  python tools/grid_song.py 参考.mp4 --bpm 150 [--offset 0] [--bars 63] [--section 前奏:1 --section A:6 …] -o refs/kaomoji

写出（目录放 refs/ 下，refs/ 不进仓库）：
  song.wav     48 kHz 立体声（预览播放和导出混流都用它）
  audio.json   拍子网格（不做节拍检测：从 --offset 起每拍 60/bpm 秒）、强拍、段落、包络、起音（结构同 analysis/analyze.py）
  events.json  kick / snare / hat（结构同 analysis/events.py），从频带能量的起音找，记录离 16 分音符网格多少毫秒
包络和鼓点只是粗量（没有分离音轨：drums ≈ 低频 + 高频起音，bass ≈ 低频，other ≈ 中频，vocal = 0）。
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy.signal import butter, find_peaks, sosfiltfilt

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ffmpeg_path import FFMPEG  # noqa: E402

SR = 48000
FPS = 100


def band_env(x: np.ndarray, lo: float | None, hi: float | None) -> np.ndarray:
    """频带的 RMS 包络（FPS 帧 / 秒）。"""
    if lo and hi:
        y = sosfiltfilt(butter(4, [lo, hi], btype="band", fs=SR, output="sos"), x)
    elif hi:
        y = sosfiltfilt(butter(4, hi, btype="low", fs=SR, output="sos"), x)
    elif lo:
        y = sosfiltfilt(butter(4, lo, btype="high", fs=SR, output="sos"), x)
    else:
        y = x
    hop = SR // FPS
    n = len(y) // hop
    return np.sqrt((y[: n * hop].reshape(n, hop) ** 2).mean(axis=1) + 1e-12)


def norm(e: np.ndarray) -> np.ndarray:
    return np.clip(e / (np.percentile(e, 99) + 1e-9), 0, 1)


def onsets(e: np.ndarray, min_gap: float, thr: float) -> list[tuple[float, float]]:
    """包络的起音：对数能量的正向差分的峰（相隔至少 min_gap 秒），强度归一到 0..1。"""
    d = np.maximum(np.diff(np.log(e + 1e-6), prepend=np.log(e[0] + 1e-6)), 0)
    d = d / (np.percentile(d[d > 0], 99) + 1e-9) if (d > 0).any() else d
    pk, pr = find_peaks(d, height=thr, distance=max(1, int(min_gap * FPS)))
    return [(round(i / FPS, 3), round(float(min(1.0, h)), 3)) for i, h in zip(pk, pr["peak_heights"])]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("audio", help="任何 ffmpeg 读得了的音频或带音轨的视频")
    ap.add_argument("--bpm", type=float, required=True)
    ap.add_argument("--offset", type=float, default=0.0, help="第一拍（第 1 小节强拍）的秒数")
    ap.add_argument("--beats-per-bar", type=int, default=4)
    ap.add_argument("--bars", type=int, help="小节数（默认按时长算）")
    ap.add_argument("--section", action="append", default=[], help="段落名:起始小节（从 1 数），可重复")
    ap.add_argument("-o", "--out", required=True)
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    wav = out / "song.wav"
    subprocess.run([FFMPEG, "-v", "error", "-y", "-i", a.audio, "-vn", "-ac", "2", "-ar", str(SR), "-c:a", "pcm_s16le", str(wav)], check=True)
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", str(wav), "-ac", "1", "-f", "f32le", "-"], capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.float32).astype(np.float64)
    dur = len(x) / SR

    beat = 60.0 / a.bpm
    bpb = a.beats_per_bar
    n_beats = int(np.floor((dur - a.offset) / beat + 1e-6)) + 1
    if a.bars:
        n_beats = min(n_beats, a.bars * bpb)
    beats = [round(a.offset + i * beat, 4) for i in range(n_beats)]
    downbeats = beats[::bpb]
    bar_t = lambda k: a.offset + (k - 1) * bpb * beat
    secs = sorted(((s.rsplit(":", 1)[0], int(s.rsplit(":", 1)[1])) for s in a.section), key=lambda s: s[1]) or [("song", 1)]
    sections = [{"name": n, "start": round(max(0.0, bar_t(b)), 4), "end": round(bar_t(secs[i + 1][1]) if i + 1 < len(secs) else dur, 4)} for i, (n, b) in enumerate(secs)]

    low, mid, high, full = band_env(x, None, 150), band_env(x, 150, 2000), band_env(x, 4000, None), band_env(x, None, None)
    feats = {"rms": norm(full), "low": norm(low), "mid": norm(mid), "high": norm(high)}
    feats["bass"] = feats["low"]
    feats["other"] = feats["mid"]
    feats["drums"] = norm(np.maximum(feats["low"], feats["high"]))
    feats["vocal"] = np.zeros_like(full)
    kick = onsets(band_env(x, 30, 120), 0.12, 0.25)
    snare = onsets(band_env(x, 1500, 5000), 0.1, 0.3)
    hat = onsets(band_env(x, 7000, None), 0.06, 0.3)
    audio = {"duration": round(dur, 4), "bpm": a.bpm, "fps": FPS, "beats": beats, "downbeats": downbeats, "sections": sections,
             "features": {k: [round(float(v), 4) for v in e] for k, e in feats.items()},
             "onsets": {"kick": kick, "snare": snare, "hat": hat, "vocal": []},
             "note": f"tools/grid_song.py: a fixed {a.bpm:g} BPM grid from {a.offset:g} s (no beat tracking); envelopes and onsets from band energies"}
    (out / "audio.json").write_text(json.dumps(audio), encoding="utf-8")

    six = beat / 4
    events = []
    for typ, lst in (("kick", kick), ("snare", snare), ("hat", hat)):
        for t, s in lst:
            q = int(round((t - a.offset) / six))
            events.append({"t": t, "type": typ, "s": s, "q": q, "bar": q // (4 * bpb), "step": q % (4 * bpb), "dq": round((t - (a.offset + q * six)) * 1000, 1)})
    events.sort(key=lambda e: e["t"])
    (out / "events.json").write_text(json.dumps({"events": events}), encoding="utf-8")
    off = [abs(e["dq"]) for e in events if e["type"] == "kick"]
    print(f"{out}: {dur:.2f} s, {len(beats)} 拍 / {len(downbeats)} 小节，段落 {', '.join(s['name'] for s in sections)}；"
          f"kick {len(kick)}（离 16 分网格中位 {np.median(off) if off else 0:.0f} ms）、snare {len(snare)}、hat {len(hat)}")


if __name__ == "__main__":
    main()

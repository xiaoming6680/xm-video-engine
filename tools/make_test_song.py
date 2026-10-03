"""生成一首测试用的合成曲和对应的分析数据，让引擎在没有真歌时也能跑起来（示例场景、渲染和检查脚本的自测）。

用法（在引擎或项目根目录）：
  python tools/make_test_song.py [--bpm 120] [--bars 8] [--root .]

写出：
  audio/song.wav      合成的鼓 + 贝斯（44.1 kHz 立体声）
  data/audio.json     节拍、强拍、段落、包络、起音（结构同 analysis/analyze.py 的输出）
  data/events.json    kick / snare / hat 事件（结构同 analysis/events.py 的输出）
  data/lyrics.json    两行占位歌词（自编文字，只用来测逐词高亮）
真项目用 analysis/ 里的脚本从真歌生成这些文件，会覆盖它们。
"""
import argparse
import json
import wave
from pathlib import Path

import numpy as np

SR = 44100
FPS = 100  # envelope frame rate (audio.json "fps")


def env_decay(n: int, tau: float) -> np.ndarray:
    return np.exp(-np.arange(n) / (tau * SR))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bpm", type=float, default=120.0)
    ap.add_argument("--bars", type=int, default=8)
    ap.add_argument("--root", default=".")
    a = ap.parse_args()
    root = Path(a.root)
    (root / "audio").mkdir(parents=True, exist_ok=True)
    (root / "data").mkdir(parents=True, exist_ok=True)

    beat = 60.0 / a.bpm
    n_beats = a.bars * 4
    dur = n_beats * beat + 1.0
    n = int(dur * SR)
    rng = np.random.default_rng(7)
    mix = np.zeros(n)
    drums = np.zeros(n)
    bass = np.zeros(n)
    beats = [round(i * beat, 4) for i in range(n_beats)]
    downbeats = beats[::4]
    kicks, snares, hats = [], [], []

    def add(buf, t, sig):
        i = int(t * SR)
        j = min(n, i + len(sig))
        buf[i:j] += sig[: j - i]

    kick_len = int(0.35 * SR)
    tk = np.arange(kick_len) / SR
    kick = np.sin(2 * np.pi * (45 * tk + 90 * (1 - np.exp(-tk * 30)) / 30)) * env_decay(kick_len, 0.12)
    snare_len = int(0.25 * SR)
    snare = rng.standard_normal(snare_len) * env_decay(snare_len, 0.06) * 0.5
    hat_len = int(0.06 * SR)
    hat = np.diff(rng.standard_normal(hat_len + 1)) * env_decay(hat_len, 0.015) * 0.25

    for i in range(n_beats):
        t = i * beat
        add(drums, t, kick * 0.9); kicks.append(t)
        if i % 4 in (1, 3):
            add(drums, t, snare); snares.append(t)
        for h in (0, 0.5):
            add(drums, t + h * beat, hat); hats.append(t + h * beat)
        # bass: root note per bar (A1, F1, C2, G1)
        f0 = [55.0, 43.65, 65.41, 49.0][(i // 4) % 4]
        bl = int(beat * SR)
        tb = np.arange(bl) / SR
        add(bass, t, np.sin(2 * np.pi * f0 * tb) * env_decay(bl, 0.35) * 0.35)

    mix = drums + bass
    mix /= max(1e-9, np.abs(mix).max()) / 0.7
    stereo = np.stack([mix, mix], axis=1)
    with wave.open(str(root / "audio/song.wav"), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((stereo * 32767).astype("<i2").tobytes())

    # envelopes: RMS per 10 ms frame, normalised 0..1
    hop = SR // FPS
    def rms_env(x):
        m = len(x) // hop
        r = np.sqrt((x[: m * hop].reshape(m, hop) ** 2).mean(axis=1))
        return np.round(r / max(1e-9, r.max()), 4).tolist()
    e_mix, e_drums, e_bass = rms_env(mix), rms_env(drums), rms_env(bass)
    zeros = [0.0] * len(e_mix)
    half = round(a.bars / 2 * 4 * beat, 4)
    audio = {
        "duration": round(dur, 4), "bpm": a.bpm, "fps": FPS,
        "beats": beats, "downbeats": downbeats,
        "sections": [{"name": "A", "start": 0.0, "end": half}, {"name": "B", "start": half, "end": round(dur, 4)}],
        "features": {"rms": e_mix, "low": e_bass, "mid": e_drums, "high": e_drums, "vocal": zeros,
                     "drums": e_drums, "bass": e_bass, "other": zeros},
        "onsets": {"kick": [[round(t, 4), 1.0] for t in kicks], "snare": [[round(t, 4), 0.8] for t in snares],
                   "hat": [[round(t, 4), 0.4] for t in hats], "vocal": []},
    }
    (root / "data/audio.json").write_text(json.dumps(audio), encoding="utf-8")

    def ev(t, typ, s):
        q = round(t / (beat / 4))
        return {"t": round(t, 4), "type": typ, "s": s, "q": q, "bar": q // 16, "step": q % 16, "dq": 0.0}
    events = [ev(t, "kick", 1.0) for t in kicks] + [ev(t, "snare", 0.8) for t in snares] + [ev(t, "hat", 0.4) for t in hats]
    (root / "data/events.json").write_text(json.dumps({"events": sorted(events, key=lambda e: e["t"])}), encoding="utf-8")

    # placeholder lyrics (made up for the test): one word per beat, bars 2–3 and 6–7
    def line(text_words, start_beat):
        words = [{"w": w, "start": round((start_beat + k) * beat, 4), "end": round((start_beat + k + 0.9) * beat, 4)}
                 for k, w in enumerate(text_words)]
        return {"text": " ".join(text_words), "start": words[0]["start"], "end": words[-1]["end"], "words": words}
    lyrics = {"lines": [line(["one", "two", "three", "four", "测试", "引擎"], 4),
                        line(["节拍", "对齐", "check", "the", "beat", "grid"], 4 + 4 * (a.bars // 2))]}
    (root / "data/lyrics.json").write_text(json.dumps(lyrics, ensure_ascii=False), encoding="utf-8")
    print(f"wrote audio/song.wav ({dur:.1f}s, {a.bpm} BPM, {a.bars} bars), data/audio.json, events.json, lyrics.json")


if __name__ == "__main__":
    main()

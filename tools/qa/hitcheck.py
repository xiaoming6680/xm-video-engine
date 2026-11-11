"""量分轨里真实的击打，和你排的切点比：切点离最近的击打差多少毫秒。在项目根目录运行。

  python <引擎>/tools/qa/hitcheck.py --cuts 53.75,54.19,54.61          # 或 --cuts cuts.json（秒的列表）
  python <引擎>/tools/qa/hitcheck.py --write data/hits_all.json         # 只量击打，写文件，用来排切点

只读 audio/stems4/ 的分轨（analysis/run.py 生成）。分段定基准（段落响度差很多）：--sections 0,40,54,82。
等分网格不等于卡点：音乐里的鼓和贝斯常常提前或拖后，先量击打再排切点。
"""
import argparse
import json
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import find_peaks, stft

STEMS = (("drums", 30, 150, "kick", 0.4), ("drums", 180, 3000, "snare", 0.4), ("bass", 30, 400, "bass", 0.5), ("other", 200, 12000, "other", 0.6))


def flux(x, sr, lo, hi):
    hop = int(sr * 0.002)
    f, t, Z = stft(x, sr, nperseg=int(sr * 0.012), noverlap=int(sr * 0.012) - hop, boundary=None, padded=False)
    m = np.log1p(np.abs(Z[(f >= lo) & (f < hi)]) * 200).sum(axis=0)
    return t, np.convolve(np.maximum(0, np.diff(m, prepend=m[0])), np.ones(5) / 5, mode="same")


def measure(sections):
    hits = []
    for stem, lo, hi, name, rel in STEMS:
        p = Path("audio/stems4") / f"{stem}.wav"
        if not p.exists():
            continue
        x, sr = sf.read(str(p), always_2d=True)
        t, d = flux(x.mean(axis=1), sr, lo, hi)
        edges = sections or [0.0, float(t[-1]) + 1]
        for a, b in zip(edges, edges[1:]):
            m = (t >= a) & (t < b)
            if not m.any():
                continue
            ref = np.percentile(d[m], 99.5)
            idx, _ = find_peaks(d[m], height=ref * rel, distance=int(0.07 / (t[1] - t[0])))
            hits += [(round(float(t[m][i]), 3), round(float(d[m][i] / ref), 2), name) for i in idx]
    return sorted(hits)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cuts", default="")
    ap.add_argument("--write", default="")
    ap.add_argument("--sections", default="", help="分段定基准的边界（秒，逗号分隔）")
    ap.add_argument("--tol", type=float, default=17.0, help="超过多少毫秒才列出（默认一帧）")
    a = ap.parse_args()
    hits = measure([float(x) for x in a.sections.split(",") if x])
    if not hits:
        raise SystemExit("audio/stems4/ 里没有分轨：先跑 analysis/run.py")
    print(f"量到 {len(hits)} 个击打")
    if a.write:
        Path(a.write).parent.mkdir(parents=True, exist_ok=True)
        Path(a.write).write_text(json.dumps(hits), encoding="utf-8")
    if not a.cuts:
        return
    cuts = json.loads(Path(a.cuts).read_text(encoding="utf-8")) if a.cuts.endswith(".json") else [float(x) for x in a.cuts.split(",")]
    H = np.array([h[0] for h in hits])
    off = 0
    for c in cuts:
        i = int(np.argmin(np.abs(H - c)))
        ms = (c - H[i]) * 1000
        if abs(ms) > a.tol:
            off += 1
            print(f"  {c:8.3f}  最近 {H[i]:.3f}（差 {ms:+.0f} ms，{hits[i][2]} 强度 {hits[i][1]:.2f}）")
    print(f"{len(cuts)} 个切点，{off} 个差超过 {a.tol:.0f} ms")


if __name__ == "__main__":
    main()

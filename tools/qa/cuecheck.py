"""卡点检查：场景登记的关键动作（Scene.cues）和剪辑点，离它要落的拍子 / 声音事件差多少毫秒。

先导出 cue：  cd app && bun scripts/render.ts cues          （写 out/qa/cues.json）
再检查：      python tools/qa/cuecheck.py [--tol 17] [--root .]

对每个 cue 找最近的目标：on='downbeat' → data/audio.json 的 downbeats；'beat' → beats；
其它（'kick'、'snare'、'clap'…）→ data/events.json 里该类型的事件（没有就退回 audio.json 的 onsets）。
偏差超过 --tol 毫秒（默认 17，约 60 fps 的一帧）的标 !!；有 !! 时退出码为 1。
"""
import argparse
import bisect
import json
import sys
from pathlib import Path


def nearest(sorted_times: list[float], t: float) -> float | None:
    if not sorted_times:
        return None
    i = bisect.bisect_left(sorted_times, t)
    cands = [sorted_times[j] for j in (i - 1, i) if 0 <= j < len(sorted_times)]
    return min(cands, key=lambda x: abs(x - t))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".", help="项目根目录（含 data/ 和 out/）")
    ap.add_argument("--cues", help="cues.json 路径（默认 <root>/out/qa/cues.json）")
    ap.add_argument("--tol", type=float, default=17.0, help="允许偏差（毫秒）")
    a = ap.parse_args()
    root = Path(a.root)
    cues = json.loads(Path(a.cues or root / "out/qa/cues.json").read_text(encoding="utf-8"))["cues"]
    audio = json.loads((root / "data/audio.json").read_text(encoding="utf-8"))
    targets: dict[str, list[float]] = {"beat": sorted(audio["beats"]), "downbeat": sorted(audio["downbeats"])}
    ev_path = root / "data/events.json"
    if ev_path.exists():
        for e in json.loads(ev_path.read_text(encoding="utf-8")).get("events", []):
            targets.setdefault(e["type"], []).append(e["t"])
    for kind, lst in (audio.get("onsets") or {}).items():
        targets.setdefault(kind, [t for t, _ in lst])
    for k in targets:
        targets[k].sort()

    bad = 0
    print(f"{'t':>8}  {'目标':<9} {'偏差':>8}  场景 / 动作")
    for c in cues:
        on = c.get("on") or "downbeat"
        ref = nearest(targets.get(on, []), c["t"])
        if ref is None:
            print(f"{c['t']:8.3f}  {on:<9} {'无目标':>8}  {c.get('scene', '')} / {c['name']}")
            bad += 1
            continue
        d = (c["t"] - ref) * 1000
        flag = "!!" if abs(d) > a.tol else "  "
        bad += flag == "!!"
        print(f"{c['t']:8.3f}  {on:<9} {d:+7.1f}ms {flag} {c.get('scene', '')} / {c['name']}")
    print(f"\n{len(cues)} 个 cue，{bad} 个超出 ±{a.tol:g} ms")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()

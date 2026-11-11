"""主元素轨迹检查：场景报告的元素位置（Scene.track → render.ts track）逐帧看连不连。

  cd app && bun scripts/render.ts track [--from a --to b] [--out ../out/qa/track.json]
  python tools/qa/trackcheck.py out/qa/track.json [-o out/qa/track] [--jump 0.06] [--min-speed 0.05]

查三样（位置按画面高度 H 归一化，速度单位 H/秒）：
  跳位   一帧里位置跳了 > --jump（默认 0.06H）且前后两帧都慢：瞬移，看起来是“断了”
         （缩放一帧变化 > 1.35 倍、前后都稳，也算）
  急停   在动（> --min-speed，默认 0.4H/s）→ 一帧内停住（< 1/5）：PPT 式的“到了就停”，不在拍上的标出来
  交接   一个元素消失、同一帧有别的元素出现：两者位置差 < 0.08H 算接上了（主角换了身份但没断），否则“断开”
输出：报告（终端 + report.md）和每个元素的 x / y / 速度 / 缩放曲线图（竖线是拍，粗线是强拍）。
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("track")
    ap.add_argument("-o", "--out", default="out/qa/track")
    ap.add_argument("--jump", type=float, default=0.06, help="一帧跳多远算瞬移（画面高度的比例）")
    ap.add_argument("--min-speed", type=float, default=0.4, help="多快算在动（H/秒）；原地跑的起伏不算")
    ap.add_argument("--handoff", type=float, default=0.08, help="交接时两元素离多近算接上（H）")
    ap.add_argument("--H", type=float, default=1080)
    a = ap.parse_args()

    d = json.loads(Path(a.track).read_text(encoding="utf-8"))
    fps, frames = d["fps"], d["frames"]
    beats = np.array(d.get("beats", []), dtype=float)
    downs = np.array(d.get("downbeats", []), dtype=float)
    ts = np.array([f["t"] for f in frames])
    names = sorted({k for f in frames for k in f["p"]})
    H = a.H
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    def beat_off(t: float) -> str:
        if not len(beats):
            return ""
        i = int(np.argmin(np.abs(beats - t)))
        return f"（离拍 {1000 * (t - beats[i]):+.0f} ms）"

    series = {}
    for n in names:
        xs = np.full(len(frames), np.nan); ys = xs.copy(); ss = xs.copy(); rs = xs.copy()
        for i, f in enumerate(frames):
            p = f["p"].get(n)
            if p:
                xs[i], ys[i] = p["x"] / H, p["y"] / H
                ss[i] = p.get("s", np.nan)
                rs[i] = p.get("r", np.nan)
        series[n] = (xs, ys, ss, rs)

    lines: list[str] = [f"# 轨迹检查：{a.track}", "", f"{len(frames)} 帧（{fps} fps），{len(names)} 个元素：{', '.join(names)}", ""]
    issues = 0

    for n in names:
        xs, ys, ss, _ = series[n]
        on = ~np.isnan(xs)
        if on.sum() < 2:
            continue
        step = np.hypot(np.diff(xs), np.diff(ys))  # H per frame (nan where off)
        speed = step * fps
        found: list[str] = []
        for i in range(1, len(step) - 1):
            if np.isnan(step[i]) or np.isnan(step[i - 1]) or np.isnan(step[i + 1]):
                continue
            calm = max(step[i - 1], step[i + 1])
            if step[i] > a.jump and step[i] > 4 * calm:
                found.append(f"- 跳位 {ts[i + 1]:.3f}s：一帧移动 {step[i]:.2f}H，前后每帧只 {step[i - 1]:.3f} / {step[i + 1]:.3f}H {beat_off(ts[i + 1])}")
            s0, s1 = ss[i], ss[i + 1]
            if not np.isnan(s0) and not np.isnan(s1) and s0 > 0 and s1 > 0:
                ratio = max(s1 / s0, s0 / s1)
                calm_s = max(abs(np.log(ss[i] / ss[i - 1])) if ss[i - 1] > 0 else 0, abs(np.log(ss[i + 2] / ss[i + 1])) if i + 2 < len(ss) and ss[i + 1] > 0 and not np.isnan(ss[i + 2]) else 0)
                if ratio > 1.35 and np.log(ratio) > 4 * calm_s:
                    found.append(f"- 缩放跳变 {ts[i + 1]:.3f}s：一帧 ×{s1 / s0:.2f} {beat_off(ts[i + 1])}")
        for i in range(1, len(speed)):
            if np.isnan(speed[i]) or np.isnan(speed[i - 1]):
                continue
            if speed[i - 1] > a.min_speed and speed[i] < speed[i - 1] / 5 and speed[i] < a.min_speed:
                tag = beat_off(ts[i])
                on_beat = len(beats) and np.min(np.abs(beats - ts[i])) < 0.05
                found.append(f"- 急停 {ts[i]:.3f}s：{speed[i - 1]:.2f} → {speed[i]:.2f} H/s {tag}{'' if on_beat else '  ← 不在拍上'}")
        # visibility changes and hand-offs
        idx = np.where(np.diff(on.astype(int)) != 0)[0]
        for i in idx:
            t = ts[i + 1]
            if on[i] and not on[i + 1]:  # disappears: did someone appear right here?
                p = (xs[i], ys[i])
                best = None
                for m in names:
                    if m == n:
                        continue
                    mx, my, _, _ = series[m]
                    for j in (i, i + 1):
                        if j < len(mx) and not np.isnan(mx[j]) and (j == 0 or np.isnan(mx[j - 1]) or j == i + 1):
                            dd = np.hypot(mx[j] - p[0], my[j] - p[1])
                            if best is None or dd < best[1]:
                                best = (m, dd)
                if best and best[1] < a.handoff:
                    found.append(f"- 交接 {t:.3f}s：→ {best[0]}，离 {best[1]:.3f}H，接上了")
                elif best:
                    found.append(f"- 交接 {t:.3f}s：→ {best[0]}，离 {best[1]:.2f}H  ← 断开（> {a.handoff}H）")
                else:
                    found.append(f"- 消失 {t:.3f}s（没有元素接着它出现）")
        sp = speed[~np.isnan(speed)]
        head = f"## {n}　{on.sum()} 帧在场，速度中位 {np.median(sp):.2f} H/s、最大 {np.max(sp):.2f}" if len(sp) else f"## {n}"
        lines.append(head)
        lines += found or ["- 连续，没有跳位 / 急停"]
        lines.append("")
        issues += sum(1 for x in found if "←" in x or "跳位" in x or "缩放跳变" in x)

    lines.append(f"要看一下的：{issues} 处")
    rep = "\n".join(lines)
    print(rep)
    (out / "report.md").write_text(rep, encoding="utf-8")

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DejaVu Sans"]
        plt.rcParams["axes.unicode_minus"] = False
        fig, axs = plt.subplots(4, 1, figsize=(14, 10), sharex=True)
        for n in names:
            xs, ys, ss, _ = series[n]
            sp = np.concatenate([[np.nan], np.hypot(np.diff(xs), np.diff(ys)) * fps])
            axs[0].plot(ts, xs, label=n)
            axs[1].plot(ts, ys)
            axs[2].plot(ts, sp)
            axs[3].plot(ts, ss)
        for ax, lab in zip(axs, ["x (H)", "y (H)", "速度 (H/s)", "缩放"]):
            ax.set_ylabel(lab)
            for b in beats:
                if ts[0] <= b <= ts[-1]:
                    ax.axvline(b, color="#bbb", lw=0.5)
            for b in downs:
                if ts[0] <= b <= ts[-1]:
                    ax.axvline(b, color="#888", lw=1.2)
        axs[1].invert_yaxis()
        axs[0].legend(fontsize=8, loc="upper left", ncol=3)
        axs[-1].set_xlabel("秒")
        fig.tight_layout()
        fig.savefig(out / "curves.png", dpi=90)
        print(f"曲线：{out / 'curves.png'}")
    except ImportError:
        print("（没有 matplotlib，不出曲线图）", file=sys.stderr)


if __name__ == "__main__":
    main()

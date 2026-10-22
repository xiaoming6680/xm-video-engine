"""镜头 / 画面运动曲线（光流）：每帧整体在往哪动、多快、是推还是拉，画成曲线，和参考片对比；标出急停和抽动。

  python tools/qa/flowcurve.py 视频.mp4 [--from a --to b] [--ref 参考.mp4 --ref-start 0] [--audio-json refs/x/audio.json] -o out/qa/flow.png

每帧（320 宽灰度，Farnebäck 光流）：
  平移   光流的中位数（画面整体往哪走，px/帧 @320 宽）
  推拉   光流的散度（> 0 推近、< 0 拉远）
  跟随占比  这一帧的变化里，能被“跟着光流挪过去”解释掉的比例：高 = 东西在连续移动；低 = 东西在凭空出现 / 消失 / 换色
报告：
  急停  整体速度一帧内从快（> --fast）掉到 1/5 以下
  抽动  加速度一帧内正负来回（同一方向上 +、−、+），连续的运动不会这样
"""
import argparse
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from frames import decode, duration  # noqa: E402


def analyse(path: str, a: float, b: float):
    fr = decode(path, a, b - a, 30, (320, 180), gray=True)
    h, w = fr.shape[1:]
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    rows = []
    for i in range(1, len(fr)):
        f0, f1 = fr[i - 1], fr[i]
        raw = np.abs(f1.astype(np.float32) - f0).mean()
        flow = cv2.calcOpticalFlowFarneback(f0, f1, None, 0.5, 4, 21, 3, 5, 1.1, 0)
        back = cv2.calcOpticalFlowFarneback(f1, f0, None, 0.5, 4, 21, 3, 5, 1.1, 0)
        warped = cv2.remap(f0.astype(np.float32), gx + back[..., 0], gy + back[..., 1], cv2.INTER_LINEAR)
        comp = np.abs(f1.astype(np.float32) - warped).mean()
        mag = np.hypot(flow[..., 0], flow[..., 1])
        mov = mag > 0.3
        dx = float(np.median(flow[..., 0][mov])) if mov.any() else 0.0
        dy = float(np.median(flow[..., 1][mov])) if mov.any() else 0.0
        div = float(np.mean(np.gradient(flow[..., 0], axis=1) + np.gradient(flow[..., 1], axis=0)))
        speed = float(np.median(mag[mov])) if mov.any() else 0.0
        follow = 1 - comp / raw if raw > 0.5 else np.nan
        rows.append((a + i / 30, dx, dy, speed, div * 100, follow, raw))
    return np.array(rows)


def report(name: str, R: np.ndarray, fast: float, beats: np.ndarray) -> list[str]:
    out = [f"## {name}"]
    if not len(R):
        return out + ["- 没有帧"]
    t, sp, fol = R[:, 0], R[:, 3], R[:, 5]
    out.append(f"- 速度中位 {np.median(sp):.2f} px/帧，跟随占比中位 {np.nanmedian(fol):.0%}")
    for i in range(1, len(sp)):
        if sp[i - 1] > fast and sp[i] < sp[i - 1] / 5:
            off = f"，离拍 {1000 * (t[i] - beats[np.argmin(np.abs(beats - t[i]))]):+.0f} ms" if len(beats) else ""
            out.append(f"- 急停 {t[i]:.3f}s：{sp[i - 1]:.1f} → {sp[i]:.1f}{off}")
    acc = np.diff(sp)
    jit = [t[i + 1] for i in range(1, len(acc) - 1) if acc[i - 1] * acc[i] < 0 and acc[i] * acc[i + 1] < 0 and min(abs(acc[i - 1]), abs(acc[i]), abs(acc[i + 1])) > 0.6]
    if jit:
        out.append(f"- 抽动 {len(jit)} 处：{', '.join(f'{x:.2f}' for x in jit[:12])}{' …' if len(jit) > 12 else ''}")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--from", dest="from_", type=float, default=0.0)
    ap.add_argument("--to", type=float)
    ap.add_argument("--ref")
    ap.add_argument("--ref-start", type=float, default=0.0)
    ap.add_argument("--audio-json", help="拍子画竖线（refs/<名>/audio.json 或 data/audio.json）")
    ap.add_argument("--fast", type=float, default=2.0, help="多快算快（px/帧 @320 宽）")
    ap.add_argument("-o", "--out", default="out/qa/flow.png")
    a = ap.parse_args()
    to = a.to if a.to else duration(a.video)

    beats = np.array([])
    if a.audio_json:
        import json
        beats = np.array(json.loads(Path(a.audio_json).read_text(encoding="utf-8"))["beats"], dtype=float)

    ours = analyse(a.video, a.from_, to)
    lines = report("我们", ours, a.fast, beats)
    ref = None
    if a.ref:
        ref = analyse(a.ref, a.ref_start + a.from_, a.ref_start + to)
        ref[:, 0] -= a.ref_start
        lines = report("参考", ref, a.fast, beats) + [""] + lines
    print("\n".join(lines))

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False
    fig, axs = plt.subplots(4, 1, figsize=(14, 9), sharex=True)
    for R, lab, col in ([(ref, "参考", "#888")] if ref is not None else []) + [(ours, "我们", "#d22")]:
        axs[0].plot(R[:, 0], R[:, 3], color=col, label=lab)
        axs[1].plot(R[:, 0], R[:, 1], color=col)
        axs[1].plot(R[:, 0], R[:, 2], color=col, ls="--")
        axs[2].plot(R[:, 0], R[:, 4], color=col)
        axs[3].plot(R[:, 0], R[:, 5], color=col)
    for ax, lab in zip(axs, ["速度 px/帧", "平移 x（实线）y（虚线）", "推拉（散度×100）", "跟随占比"]):
        ax.set_ylabel(lab)
        for b in beats:
            if a.from_ <= b <= to:
                ax.axvline(b, color="#ccc", lw=0.6)
    axs[0].legend()
    axs[-1].set_xlabel("秒")
    fig.tight_layout()
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(a.out, dpi=90)
    Path(a.out).with_suffix(".md").write_text("\n".join(lines), encoding="utf-8")
    print(a.out)


if __name__ == "__main__":
    main()

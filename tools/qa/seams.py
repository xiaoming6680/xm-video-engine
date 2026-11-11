"""接缝检查：每个切点 / 转场前后，比较画面锚点（主体位置、大小）、运动（平移、推拉、旋转、变化量）、亮度、色调，
以及声音的延续（响度、频谱质心、立体声宽度；“咔哒”是切点处采样跳变和平时最大跳变之比，只作参考）。单帧对照看不出“连不连贯”，问题都出在这些地方。

用法（项目根目录）：
  python tools/qa/seams.py out/draft/v1.mp4                          # 自动找切点（帧差尖峰 + 直方图突变）
  python tools/qa/seams.py out/draft/v1.mp4 --cuts 8.0,15.4          # 只看这几个时刻（视频秒）
  python tools/qa/seams.py out/draft/v1.mp4 --cues out/qa/cues.json  # 时间线的剪辑点（render.ts cues；歌曲秒，--start 换算）
  python tools/qa/seams.py ours.mp4 --ref 参考.mp4 [--ref-start 0]    # 复刻：同一处的接缝和参考并排比，列出两边各自多出的切点
  选项：--from / --to（视频秒范围）、--fps 30、-o out/qa/seams（report.md、seams.json、每个切点的前后帧条）

读报告：
  - 锚点：画面里“和背景最不一样”的部分的重心和散布（主体位置、大小）。好的切点要么锚点接住（位置相近），
    要么运动接住（前一镜往右甩、后一镜从左进来）；两样都断、亮度和色调又一起跳，就是“硬跳”
  - 运动：光流的平移（画面宽 / 秒）、推拉（ln 尺度 / 秒，正 = 推近）、旋转（弧度 / 秒），和帧差（0–255）
  - 有参考时以参考为准：参考在这里也跳就不算问题；参考是连续运动、我们是硬切，或反过来，都要改
报告只给数，不自动判对错；`--strict` 时有“看一下”的项就退出码 1。参考视频和截图只在本机，不进仓库。
"""
import argparse
import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import median_filter

sys.path.insert(0, str(Path(__file__).resolve().parent))
from frames import decode, decode_audio, duration, frame_diff  # noqa: E402

SMALL = (160, 90)      # 锚点、光流
STRIP = (480, 270)     # 帧条
WIN = 6                # 前后各看几帧（30 fps 时 0.2 s）


def _font(px: int):
    for f in ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/consola.ttf"):
        if os.path.exists(f):
            return ImageFont.truetype(f, px)
    return ImageFont.load_default()


# ---------------------------------------------------------------- 切点
def find_events(gray: np.ndarray, fps: float, thr: float = 18, ratio: float = 2.5) -> list[tuple[int, int]]:
    """切点 / 快速转场：帧差高于 thr 且高于附近 1 秒中位数的 ratio 倍，或灰度直方图突变。返回 [(k0, k1)]：
    帧 k0 是变化前最后一帧，k1 + 1 是变化后第一帧。连续几帧都在变（k1 > k0）就是转场。"""
    d = frame_diff(gray)
    if len(d) == 0:
        return []
    local = median_filter(d, size=max(3, int(fps) | 1), mode="nearest")
    h = np.stack([np.histogram(g, bins=32, range=(0, 256))[0] / g.size for g in gray])
    hd = 0.5 * np.abs(np.diff(h, axis=0)).sum(axis=1)          # 0..1，相邻帧直方图差
    flag = ((d > thr) & (d > ratio * local + 2)) | ((hd > 0.35) & (d > 12))
    ev, k = [], 0
    while k < len(d):
        if flag[k]:
            j = k
            while j + 1 < len(d) and (flag[j + 1] or (j + 2 < len(d) and flag[j + 2])):
                j += 1
            ev.append((k, j))
            k = j + 1
        else:
            k += 1
    return ev


# ---------------------------------------------------------------- 每帧的量
def anchor(rgb: np.ndarray) -> tuple[float, float, float]:
    """主体锚点：和画面中位色差得最多的像素的加权重心 (x, y)（单位：画面高，x 从 0 到宽高比）和散布（画面高）。"""
    lab = cv2.cvtColor(rgb.astype(np.float32) / 255.0, cv2.COLOR_RGB2Lab)
    med = np.median(lab.reshape(-1, 3), axis=0)
    dist = np.linalg.norm(lab - med, axis=2)
    w = np.maximum(dist - 8.0, 0.0) ** 2
    hh, ww = dist.shape
    if w.sum() < 1e-6:
        return ww / hh / 2, 0.5, 0.0
    ys, xs = np.mgrid[0:hh, 0:ww]
    xs = (xs + 0.5) / hh
    ys = (ys + 0.5) / hh
    cx, cy = (w * xs).sum() / w.sum(), (w * ys).sum() / w.sum()
    spread = np.sqrt((w * ((xs - cx) ** 2 + (ys - cy) ** 2)).sum() / w.sum())
    return float(cx), float(cy), float(spread)


def flow_stats(a: np.ndarray, b: np.ndarray, fps: float) -> np.ndarray:
    """两帧灰度之间的整体运动：[平移 x（画面宽/秒）, 平移 y（画面高/秒）, 推拉（ln 尺度/秒）, 旋转（弧度/秒）]。"""
    fl = cv2.calcOpticalFlowFarneback(a, b, None, 0.5, 3, 15, 3, 5, 1.2, 0)
    hh, ww = a.shape
    ys, xs = np.mgrid[0:hh, 0:ww].astype(np.float32)
    rx, ry = xs - ww / 2, ys - hh / 2
    r2 = (rx ** 2 + ry ** 2).mean()
    fx, fy = fl[..., 0], fl[..., 1]
    return np.array([fx.mean() / ww * fps, fy.mean() / hh * fps,
                     (fx * rx + fy * ry).mean() / r2 * fps, (fy * rx - fx * ry).mean() / r2 * fps])


def lab_mean(rgb: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(rgb.astype(np.float32) / 255.0, cv2.COLOR_RGB2Lab).reshape(-1, 3).mean(axis=0)


def audio_stats(path: str, t: float) -> dict | None:
    """切点前后 0.1 s 的响度（dBFS）、频谱质心（Hz）、立体声宽度（side/mid），和切点 ±5 ms 内的断点（咔哒声）。"""
    sr = 48000
    a = decode_audio(path, t - 0.25, 0.5, sr)
    if a is None or len(a) < sr * 0.4:
        return None
    c = int(round(0.25 * sr)) if t >= 0.25 else int(round(t * sr))
    seg = int(0.1 * sr)

    def stats(x: np.ndarray):
        m, s = x.mean(axis=1), (x[:, 0] - x[:, 1]) / 2
        rms = np.sqrt((m ** 2).mean() + 1e-12)
        spec = np.abs(np.fft.rfft(m * np.hanning(len(m))))
        f = np.fft.rfftfreq(len(m), 1 / sr)
        cen = (spec * f).sum() / (spec.sum() + 1e-12)
        return 20 * np.log10(rms), cen, np.sqrt((s ** 2).mean()) / (rms + 1e-9)

    b, af = stats(a[c - seg:c]), stats(a[c:c + seg])
    m = a.mean(axis=1)
    dd = np.abs(np.diff(m))
    near = dd[max(0, c - 240):c + 240]
    click = float(near.max() / (np.percentile(dd, 99) + 1e-3)) if len(near) else 0.0   # 切点处的采样跳变 / 平时的大跳变
    return {"rms_db": [round(float(b[0]), 1), round(float(af[0]), 1)], "centroid_hz": [int(round(float(b[1]))), int(round(float(af[1])))],
            "width": [round(float(b[2]), 3), round(float(af[2]), 3)], "click": round(click, 2)}


def measure(path: str, t0: float, k0: int, k1: int, fps: float, with_audio: bool) -> dict:
    """事件 (k0, k1)（相对于 t0 的帧号）前后各 WIN 帧的量。"""
    a0 = max(0, k0 - WIN)
    rgb = decode(path, t0 + a0 / fps, (k1 + 2 + WIN - a0) / fps, fps, STRIP, gray=False)
    small = np.stack([cv2.resize(f, SMALL, interpolation=cv2.INTER_AREA) for f in rgb])
    gray = np.stack([cv2.cvtColor(f, cv2.COLOR_RGB2GRAY) for f in small])
    i0, i1 = k0 - a0, min(len(rgb) - 1, k1 + 1 - a0)          # 变化前最后一帧、变化后第一帧
    before, after = range(max(0, i0 - WIN), i0), range(i1, min(len(rgb) - 1, i1 + WIN))
    fb = np.mean([flow_stats(gray[i], gray[i + 1], fps) for i in before], axis=0) if len(before) else np.zeros(4)
    fa = np.mean([flow_stats(gray[i], gray[i + 1], fps) for i in after], axis=0) if len(after) else np.zeros(4)
    d = frame_diff(small)
    ab, aa = anchor(small[i0]), anchor(small[i1])
    lb, la = lab_mean(small[i0]), lab_mean(small[i1])
    t_cut = t0 + (k0 + 1) / fps
    out = {
        "t": round(t_cut, 3), "frames": k1 - k0 + 1, "kind": "切" if k1 == k0 else f"转场 {(k1 - k0 + 1) / fps:.2f}s",
        "anchor": [[round(ab[0], 3), round(ab[1], 3)], [round(aa[0], 3), round(aa[1], 3)]],
        "anchor_jump": round(float(np.hypot(aa[0] - ab[0], aa[1] - ab[1])), 3),
        "size": [round(ab[2], 3), round(aa[2], 3)],
        "size_ratio": round(aa[2] / ab[2], 2) if ab[2] > 1e-3 else None,
        "motion": [[round(float(x), 3) for x in fb], [round(float(x), 3) for x in fa]],
        "diff": [round(float(d[max(0, i0 - WIN):i0].mean()), 1) if i0 > 0 else 0.0, round(float(d[i1:i1 + WIN].mean()), 1) if i1 < len(d) else 0.0],
        "cut_diff": round(float(d[i0:i1].max()), 1) if i1 > i0 else 0.0,
        "luma": [round(float(gray[i0].mean()), 1), round(float(gray[i1].mean()), 1)],
        "lab": [[round(float(x), 1) for x in lb], [round(float(x), 1) for x in la]],
        "dE": round(float(np.linalg.norm(la - lb)), 1),
        "_strip": [rgb[max(0, i0 - 1)], rgb[i0], rgb[i1], rgb[min(len(rgb) - 1, i1 + 1)]],
        "_anchor_px": [ab, ab, aa, aa],
    }
    if with_audio:
        out["audio"] = audio_stats(path, t_cut)
    return out


def flags(m: dict) -> list[str]:
    """不看参考时值得看一下的接缝：锚点和运动都没接住、亮度或色调又一起跳（“硬跳”）；主体大小突变；声音断。只是提示。"""
    f = []
    mb, ma = np.array(m["motion"][0]), np.array(m["motion"][1])
    moving = np.linalg.norm(mb[:3]) > 0.15 or np.linalg.norm(ma[:3]) > 0.15
    carry = float(mb[:3] @ ma[:3]) / (np.linalg.norm(mb[:3]) * np.linalg.norm(ma[:3]) + 1e-6) if moving else 0.0
    lost = m["anchor_jump"] > 0.35 and carry < 0.3
    jumps = [x for x, on in ((f"亮度 {m['luma'][0]:.0f}→{m['luma'][1]:.0f}", abs(m["luma"][1] - m["luma"][0]) > 70),
                             (f"色调 ΔE {m['dE']}", m["dE"] > 45)) if on]
    if lost and jumps:
        f.append(f"硬跳：锚点跳 {m['anchor_jump']:.2f}H、运动没接住，" + "、".join(jumps))
    sr = m["size_ratio"]
    if sr and (sr > 2.5 or sr < 0.4) and not moving:
        f.append(f"主体大小突变 ×{sr}")
    au = m.get("audio")
    if au:
        if au["rms_db"][1] - au["rms_db"][0] < -18:
            f.append(f"声音掉 {au['rms_db'][0]}→{au['rms_db'][1]} dB")
    return f


def fmt_motion(v) -> str:
    x, y, z, r = v
    parts = []
    if abs(x) > 0.05 or abs(y) > 0.05:
        parts.append(f"平移({x:+.2f},{y:+.2f})")
    if abs(z) > 0.08:
        parts.append(f"{'推' if z > 0 else '拉'}{abs(z):.2f}")
    if abs(r) > 0.08:
        parts.append(f"转{r:+.2f}")
    return " ".join(parts) or "静"


# ---------------------------------------------------------------- 输出
def strip_image(rows: list[tuple[str, dict]], out: Path):
    W, H = STRIP
    f = _font(18)
    img = Image.new("RGB", (W * 4 + 18, (H + 30) * len(rows)), (30, 30, 34))
    d = ImageDraw.Draw(img)
    for r, (title, m) in enumerate(rows):
        y0 = r * (H + 30)
        d.text((6, y0 + 4), f"{title}  t={m['t']:.2f}s  {m['kind']}", fill=(255, 214, 90) if r == 0 else (120, 230, 160), font=f)
        for i, (fr, an) in enumerate(zip(m["_strip"], m["_anchor_px"])):
            x0 = i * (W + 6)
            img.paste(Image.fromarray(fr), (x0, y0 + 30))
            ax, ay = an[0] * H + x0, an[1] * H + y0 + 30
            rr = max(6, an[2] * H)
            d.ellipse([ax - rr, ay - rr, ax + rr, ay + rr], outline=(255, 60, 60), width=2)
            d.line([ax - 8, ay, ax + 8, ay], fill=(255, 60, 60), width=2)
            d.line([ax, ay - 8, ax, ay + 8], fill=(255, 60, 60), width=2)
            if i == 2:
                d.line([x0 - 4, y0 + 30, x0 - 4, y0 + 30 + H], fill=(255, 255, 255), width=2)
    img.save(out, quality=88)


def row_text(m: dict) -> str:
    au = m.get("audio")
    a = f" | 声 {au['rms_db'][0]}→{au['rms_db'][1]}dB 质心 {au['centroid_hz'][0]}→{au['centroid_hz'][1]}Hz 宽 {au['width'][0]}→{au['width'][1]} 咔哒 {au['click']}" if au else ""
    return (f"锚点 ({m['anchor'][0][0]:.2f},{m['anchor'][0][1]:.2f})→({m['anchor'][1][0]:.2f},{m['anchor'][1][1]:.2f}) 跳 {m['anchor_jump']:.2f}H"
            f" 大小 ×{m['size_ratio']} | 运动 {fmt_motion(m['motion'][0])} → {fmt_motion(m['motion'][1])}"
            f" 帧差 {m['diff'][0]}→{m['diff'][1]}（切点 {m['cut_diff']}） | 亮度 {m['luma'][0]:.0f}→{m['luma'][1]:.0f} ΔE {m['dE']}{a}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video")
    ap.add_argument("--from", dest="from_", type=float, default=0.0)
    ap.add_argument("--to", type=float)
    ap.add_argument("--fps", type=float, default=30)
    ap.add_argument("--cuts", help="只看这些时刻（视频秒，逗号分隔）")
    ap.add_argument("--cues", help="render.ts cues 导出的 JSON：用其中的剪辑点（cut → …）")
    ap.add_argument("--start", type=float, default=0.0, help="--cues 是歌曲秒：视频 0 秒对应的歌曲秒（VIDEO_START）")
    ap.add_argument("--ref", help="参考视频：同一处的接缝并排比")
    ap.add_argument("--ref-start", type=float, default=0.0, help="参考视频里对应我们视频 0 秒的时刻")
    ap.add_argument("--match", type=float, default=0.15, help="两边切点相差多少秒以内算同一个")
    ap.add_argument("--strict", action="store_true")
    ap.add_argument("-o", "--out", default="out/qa/seams")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    fps = a.fps
    t0 = a.from_
    t1 = a.to or duration(a.video)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    from frames import has_audio
    aud = has_audio(a.video)

    gray = decode(a.video, t0, t1 - t0, fps)
    if a.cuts or a.cues:
        ts = [float(x) for x in a.cuts.split(",")] if a.cuts else \
            [c["t"] - a.start for c in json.load(open(a.cues, encoding="utf-8"))["cues"] if c["name"].startswith("cut")]
        ev = [(k, k) for k in (int(round((t - t0) * fps)) - 1 for t in ts) if 0 <= k < len(gray) - 1]
    else:
        ev = find_events(gray, fps)
    ours = [measure(a.video, t0, k0, k1, fps, aud) for k0, k1 in ev]

    refs = []
    if a.ref:
        rg = decode(a.ref, a.ref_start + t0, t1 - t0, fps)
        rev = find_events(rg, fps)
        raud = has_audio(a.ref)
        refs = [measure(a.ref, a.ref_start + t0, k0, k1, fps, raud) for k0, k1 in rev]
        for m in refs:
            m["t_ours"] = round(m["t"] - a.ref_start, 3)

    lines = [f"# 接缝检查：{a.video}", "", f"范围 {t0:.2f}–{t1:.2f} s，{fps:g} fps；{len(ours)} 个切点 / 转场" + (f"；参考 {a.ref}（+{a.ref_start} s）{len(refs)} 个" if a.ref else ""), ""]
    report = {"video": a.video, "ref": a.ref, "events": []}
    used = set()
    n_flag = 0
    for i, m in enumerate(ours):
        r = None
        if refs:
            c = [(abs(x["t_ours"] - m["t"]), j) for j, x in enumerate(refs) if j not in used]
            c = [x for x in c if x[0] <= a.match]
            if c:
                r = refs[min(c)[1]]
                used.add(min(c)[1])
        fl = flags(m)
        if r is not None:
            # 参考在这里也一样跳的，不算
            rf = set(x.split("：")[0].split(" ")[0] for x in flags(r))
            fl = [x for x in fl if x.split("：")[0].split(" ")[0] not in rf]
        n_flag += bool(fl)
        lines.append(f"## {m['t']:.2f} s　{m['kind']}" + (f"　（参考 {r['t']:.2f} s {r['kind']}）" if r else ("　（参考这里没有切点）" if refs else "")))
        lines.append(f"- 我们：{row_text(m)}")
        if r:
            lines.append(f"- 参考：{row_text(r)}")
        if fl:
            lines.append(f"- **看一下**：{'；'.join(fl)}")
        name = f"cut_{m['t']:07.2f}.jpg"
        strip_image([("我们", m)] + ([("参考", r)] if r else []), out / name)
        lines.append(f"- 帧条：{name}")
        lines.append("")
        report["events"].append({k: v for k, v in m.items() if not k.startswith("_")} | {"flags": fl, "ref": {k: v for k, v in r.items() if not k.startswith("_")} if r else None})
    missing = [x for j, x in enumerate(refs) if j not in used]
    if missing:
        lines.append("## 参考有、我们没有的切点 / 转场")
        for x in missing:
            name = f"refcut_{x['t_ours']:07.2f}.jpg"
            strip_image([("参考", x)], out / name)
            lines.append(f"- {x['t_ours']:.2f} s（参考 {x['t']:.2f} s）{x['kind']}：{row_text(x)}　帧条 {name}")
        lines.append("")
        report["ref_only"] = [{k: v for k, v in x.items() if not k.startswith("_")} for x in missing]
    (out / "report.md").write_text("\n".join(lines), encoding="utf-8")
    (out / "seams.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\n".join(lines))
    print(f"\n{len(ours)} 个切点，{n_flag} 个要看一下" + (f"，参考多出 {len(missing)} 个" if refs else "") + f" → {out / 'report.md'}")
    sys.exit(1 if a.strict and (n_flag or missing) else 0)


if __name__ == "__main__":
    main()

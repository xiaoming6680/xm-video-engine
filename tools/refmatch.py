"""逐帧对照复刻的工具（docs/复刻配方.md 第五节）：拿参考视频的一段当靶子，把引擎渲染和它并排比，一轮轮改到像。

用法（在引擎或项目根目录）：
  # 1. 看原片：一段按 fps 抽帧排成联系表，每格标原片时间
  python tools/refmatch.py frames 参考.mp4 --from 56.0 --to 58.6 [--fps 10] [--cols 4] -o out/refmatch/ref.jpg
  # 2. 量数据：取色（一个点的 7x7 平均，或一个框里最亮 / 中位的颜色）、存全分辨率帧
  python tools/refmatch.py sample 参考.mp4 --t 57.2 --pt 640,360 --pt 100,80 [--box 300,60,640,200]
  python tools/refmatch.py grab 参考.mp4 --t 57.2,57.6 -o out/refmatch/full
  # 3. 并排对照：原片 ref-start + T 和引擎同一刻 T（场景本地秒）左右拼，每行一个时刻
  python tools/refmatch.py sheet 参考.mp4 --ref-start 56.0 --t 0.2,0.6,1.0 --query ref=stack [--only id] [--samples 12] -o out/refmatch/stack_r1.jpg
  #    跨过切点：--cuts 自动取参考在 [--from, --to] 里每个切点前 0.1 s、前一帧、后一帧、后 0.1 s；--ours 也可以是渲好的视频
  python tools/refmatch.py sheet 参考.mp4 --ref-start 0 --cuts --from 0 --to 25.6 --ours out/intro/v1.mp4 -o out/refmatch/intro_cuts.jpg
  # 4. 连续帧条：从 t 起连续 n 帧（30 fps），上原片下引擎，看每帧长了什么、动了多少（单帧对照看不出“太静”）
  python tools/refmatch.py strip 参考.mp4 --ref-start 0 --ours out/intro/v1.mp4 --t 12.0,16.2 [--n 8] -o out/refmatch/strip.jpg
  # 5. 运动量：逐段 / 逐小节的每帧变化量（320×180 灰度相邻帧平均差），原片 vs 引擎，加曲线图
  python tools/refmatch.py motion 参考.mp4 --ref-start 0 --ours out/intro/v1.mp4 [--from 0 --to 25.6] [--bar 1.6 | --seg 开机:0:8 --seg 海报:8:7.4] -o out/refmatch/motion.png
  # 6. 视频对照：原速 n 遍 + 慢放 1 遍，配原片声音（只给自己看，不发布）。从头连着看一整段：--loops 1 --slow 0
  python tools/refmatch.py video 参考.mp4 --ref-start 56.0 --ours out/wip/stack.mp4 [--dur 2.6] [--loops 3] [--slow 4] -o out/refmatch/stack.mp4
  # 接缝（切点前后锚点、运动、亮度、色调、声音的跳变）：python tools/qa/seams.py ours.mp4 --ref 参考.mp4 --ref-start 0

验收看三样（docs/复刻配方.md 第五节）：单帧像（sheet）、连贯（seams.py，加带音乐原速从头连着看 video --loops 1 --slow 0）、
运动量接近（motion：每段 引擎 / 原片 在 0.7–1.4 之间；strip 看每帧变化的内容）。

sheet 会调用 app/scripts/render.ts stills（自己起私有服务器）；Python 找不到 bun 时（商店版 Python 看不到 AppData/Roaming），
先在 app/ 里 `bun scripts/render.ts stills --t 0.2,0.6 --query ref=stack --samples 12 --out ../out/wip/x`，再加 `--ours out/wip/x`。--t 是“引擎这边的时间”（歌曲秒）；原片取 ref-start + t。
参考视频只用来对照，截图和对照视频不进仓库、不发布。
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "qa"))
from ffmpeg_path import FFMPEG  # noqa: E402
from frames import decode, duration, frame_diff  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"


def _font(px: int):
    for f in ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/consola.ttf"):
        if os.path.exists(f):
            return ImageFont.truetype(f, px)
    return ImageFont.load_default()


def find_bun() -> str:
    """bun: PATH, ~/.bun, or the npm shim (on Windows a .cmd, which CreateProcess only runs by its full path)."""
    for c in (shutil.which("bun"), shutil.which("bun.cmd")):
        if c:
            return c
    for c in (Path.home() / ".bun/bin/bun.exe", Path(os.environ.get("APPDATA", "")) / "npm/bun.cmd"):
        if c.exists():
            return str(c)
    return "bun"


def grab(ref: str, t: float, out: Path) -> Path:
    if not out.exists():
        out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([FFMPEG, "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", ref, "-frames:v", "1", str(out)], check=True)
    return out


def label(img: Image.Image, text: str, color: str) -> Image.Image:
    d = ImageDraw.Draw(img)
    f = _font(20)
    w = d.textlength(text, font=f) + 12
    d.rectangle([0, 0, w, 28], fill="black")
    d.text((6, 3), text, fill=color, font=f)
    return img


def cmd_frames(a):
    tmp = Path(tempfile.mkdtemp(prefix="refmatch_"))
    subprocess.run([FFMPEG, "-v", "error", "-y", "-ss", str(a.from_), "-t", str(a.to - a.from_), "-i", a.ref, "-vf", f"fps={a.fps}", str(tmp / "f_%04d.png")], check=True)
    fs = sorted(tmp.glob("f_*.png"))
    tw = a.width // a.cols
    tiles = []
    for i, f in enumerate(fs):
        im = Image.open(f).convert("RGB")
        im = im.resize((tw, round(im.height * tw / im.width)), Image.LANCZOS)
        tiles.append(label(im, f"{a.from_ + i / a.fps:.2f}", "yellow"))
    th = tiles[0].height
    rows = (len(tiles) + a.cols - 1) // a.cols
    sh = Image.new("RGB", (tw * a.cols, th * rows))
    for i, im in enumerate(tiles):
        sh.paste(im, ((i % a.cols) * tw, (i // a.cols) * th))
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    sh.save(a.out, quality=88)
    print(a.out, f"({len(tiles)} frames)")


def cmd_sample(a):
    f = grab(a.ref, a.t, Path(tempfile.mkdtemp(prefix="refmatch_")) / "s.png")
    im = np.asarray(Image.open(f).convert("RGB")).astype(int)
    print(f"frame {im.shape[1]}x{im.shape[0]} at {a.t}s")
    for p in a.pt or []:
        x, y = map(int, p.split(","))
        c = im[max(0, y - 3):y + 4, max(0, x - 3):x + 4].reshape(-1, 3).mean(0).round().astype(int)
        print(f"  pt {x},{y}: rgb{tuple(c)}  #{c[0]:02X}{c[1]:02X}{c[2]:02X}")
    for b in a.box or []:
        x0, y0, x1, y1 = map(int, b.split(","))
        r = im[y0:y1, x0:x1].reshape(-1, 3)
        L = r.sum(1)
        top = r[np.argsort(L)[-max(1, len(r) // 50):]].mean(0).round().astype(int)
        med = np.median(r, 0).astype(int)
        print(f"  box {b}: brightest 2% rgb{tuple(top)}  median rgb{tuple(med)}")


def cmd_grab(a):
    out = Path(a.out)
    for t in [float(x) for x in a.t.split(",")]:
        print(grab(a.ref, t, out / f"ref_{t:07.2f}.png"))


def ref_cuts(a) -> list[float]:
    """参考在 [from, to]（引擎时间）里的切点（seams.find_events），每个取前 0.1 s、前一帧、后一帧、后 0.1 s。"""
    from seams import find_events
    fps = 30
    t0, t1 = a.from_, a.to
    g = decode(a.ref, a.ref_start + t0, t1 - t0, fps)
    ts = []
    for k0, k1 in find_events(g, fps):
        tb, ta = t0 + k0 / fps, t0 + (k1 + 1) / fps
        ts += [tb - 0.1, tb, ta, ta + 0.1]
    return [round(t, 3) for t in ts if t0 <= t <= t1]


def cmd_sheet(a):
    if a.cuts:
        if a.from_ is None or a.to is None:
            sys.exit("--cuts 要配 --from / --to（引擎时间）")
        ts = ref_cuts(a)
        print(f"参考的切点前后共 {len(ts)} 个时刻")
    elif a.t:
        ts = [float(x) for x in a.t.split(",")]
    else:
        sys.exit("要 --t 或 --cuts")
    tmp = Path(tempfile.mkdtemp(prefix="refmatch_"))
    if a.ours and a.ours.lower().endswith((".mp4", ".mov", ".mkv")):
        # a rendered video: its frame at engine time t is at t - ours_start
        for t in ts:
            grab(a.ours, t - a.ours_start, tmp / f"f_{t:07.2f}.png")
        stills = tmp
    else:
        stills = Path(a.ours) if a.ours else tmp
        if not a.ours:
            render_stills(a, ts, tmp)
    _sheet(a, ts, stills, tmp)


def render_stills(a, ts, tmp):
    args = [find_bun(), "scripts/render.ts", "stills", "--t", ",".join(f"{t:g}" for t in ts), "--out", str(tmp), "--samples", str(a.samples)]
    if a.query:
        args += ["--query", a.query]
    if a.only:
        args += ["--only", a.only]
    r = subprocess.run(args, cwd=APP, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0 or "SCENE ERRORS" in (r.stderr + r.stdout):
        print(r.stdout[-2000:], r.stderr[-3000:])
        if r.returncode != 0:
            sys.exit(1)


def _sheet(a, ts, stills, tmp):
    H = a.cell
    W = round(H * 16 / 9)
    rows = []
    for t in ts:
        rt = a.ref_start + t
        ref = Image.open(grab(a.ref, rt, tmp / f"ref_{rt:07.2f}.png")).convert("RGB").resize((W, H), Image.LANCZOS)
        ours = Image.open(stills / f"f_{t:07.2f}.png").convert("RGB").resize((W, H), Image.LANCZOS)
        row = Image.new("RGB", (W * 2 + 6, H), (40, 40, 44))
        row.paste(label(ref, f"原片 {rt:.2f}", "yellow"), (0, 0))
        row.paste(label(ours, f"引擎 t={t:.2f}", "#7f7"), (W + 6, 0))
        rows.append(row)
    per = a.rows
    outs = []
    for k in range(0, len(rows), per):
        part = rows[k:k + per]
        sh = Image.new("RGB", (part[0].width, (H + 6) * len(part)), (40, 40, 44))
        for i, r_ in enumerate(part):
            sh.paste(r_, (0, i * (H + 6)))
        o = a.out if len(rows) <= per else a.out.replace(".jpg", f"_{k // per}.jpg")
        Path(o).parent.mkdir(parents=True, exist_ok=True)
        sh.save(o, quality=86)
        outs.append(o)
    print("\n".join(outs))


def cmd_strip(a):
    """连续 n 帧：上原片、下引擎（引擎是视频，按 30 fps 取帧）。"""
    fps, n = 30, a.n
    W = a.width // n
    H = round(W * 9 / 16)
    f = _font(16)
    rows = []
    for t in [float(x) for x in a.t.split(",")]:
        r = decode(a.ref, a.ref_start + t, n / fps, fps, (W, H), gray=False)
        o = decode(a.ours, t - a.ours_start, n / fps, fps, (W, H), gray=False)
        for tag, fr, col in (("原片", r, (255, 214, 90)), ("引擎", o, (120, 230, 160))):
            row = Image.new("RGB", (W * n, H + 24), (24, 24, 28))
            d = ImageDraw.Draw(row)
            d.text((6, 3), f"{tag} {t:.2f}s 起连续 {n} 帧（30 fps）  帧差中位数 {np.median(frame_diff(fr)):.1f}", fill=col, font=f)
            for i in range(min(n, len(fr))):
                row.paste(Image.fromarray(fr[i]), (i * W, 24))
            rows.append(row)
    sh = Image.new("RGB", (W * n, sum(r.height + 4 for r in rows)), (50, 50, 56))
    y = 0
    for r in rows:
        sh.paste(r, (0, y))
        y += r.height + 4
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    sh.save(a.out, quality=88)
    print(a.out)


def cmd_motion(a):
    """逐段每帧变化量：原片 vs 引擎（同一段时间，30 fps，320×180 灰度相邻帧平均差）。"""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fps = 30
    t0 = a.from_ if a.from_ is not None else 0.0
    t1 = a.to if a.to is not None else min(duration(a.ours) + a.ours_start, duration(a.ref) - a.ref_start)
    r = frame_diff(decode(a.ref, a.ref_start + t0, t1 - t0, fps))
    o = frame_diff(decode(a.ours, t0 - a.ours_start, t1 - t0, fps))
    n = min(len(r), len(o))
    r, o = r[:n], o[:n]
    if a.seg:
        segs = []
        for x in a.seg:
            name, st, du = x.rsplit(":", 2)
            segs.append((name, float(st), float(st) + float(du)))
    else:
        bar = a.bar or 1.6
        segs = []
        k = int(np.floor(t0 / bar + 1e-6))
        while k * bar < t1 - 1e-6:
            segs.append((f"{k + 1:02d}", max(t0, k * bar), min(t1, (k + 1) * bar)))
            k += 1
    print(f"{'段':<8}{'时间':>14}  {'原片':>5}{'引擎':>6}{'比':>6}   冻结帧    跳变>25")
    worst = []
    for name, st, en in segs:
        i0, i1 = int(round((st - t0) * fps)), int(round((en - t0) * fps))
        rs, os_ = r[i0:i1], o[i0:i1]
        if len(rs) == 0:
            continue
        mr, mo = float(np.median(rs)), float(np.median(os_))
        ratio = mo / max(mr, 0.5)
        mark = "" if 0.7 <= ratio <= 1.4 else ("  ← 太静" if ratio < 0.7 else "  ← 太躁")
        if mark:
            worst.append(name)
        print(f"{name:<8}{st:6.2f}–{en:6.2f}  {mr:6.1f}{mo:6.1f}{ratio:6.2f}  {int((rs < 0.3).sum()):>4}/{int((os_ < 0.3).sum()):<4} {int((rs > 25).sum()):>4}/{int((os_ > 25).sum()):<4}{mark}")
    mr, mo = float(np.median(r)), float(np.median(o))
    print(f"{'全段':<8}{t0:6.2f}–{t1:6.2f}  {mr:6.1f}{mo:6.1f}{mo / max(mr, 0.5):6.2f}")
    print(f"比在 0.7–1.4 之外：{', '.join(worst) or '无'}")
    plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DejaVu Sans"]
    plt.rcParams["axes.unicode_minus"] = False
    ts = t0 + (np.arange(n) + 1) / fps
    sm = lambda x: np.convolve(x, np.ones(5) / 5, mode="same")
    fig, ax = plt.subplots(figsize=(16, 4.5), dpi=110)
    ax.plot(ts, sm(r), color="#d9a400", lw=1.4, label="参考")
    ax.plot(ts, sm(o), color="#2a9d5c", lw=1.4, label="引擎")
    for _, st, _ in segs:
        ax.axvline(st, color="#999", lw=0.5)
    ax.set_xlabel("秒")
    ax.set_ylabel("每帧变化量（0–255，5 帧平滑）")
    ax.set_xlim(t0, t1)
    ax.legend(loc="upper right")
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    fig.tight_layout()
    fig.savefig(a.out)
    print(a.out)


def cmd_video(a):
    tmp = Path(tempfile.mkdtemp(prefix="refmatch_"))
    dur = a.dur or float(subprocess.run([FFMPEG.replace("ffmpeg", "ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", a.ours], capture_output=True, text=True).stdout.strip())
    hdr = Image.new("RGB", (1920, 56), (22, 22, 26))
    d = ImageDraw.Draw(hdr)
    f = _font(30)
    d.text((16, 8), f"原片 {a.ref_start:.2f}–{a.ref_start + dur:.2f} s", fill=(255, 214, 90), font=f)
    d.text((976, 8), a.title or "引擎复刻", fill=(120, 230, 160), font=f)
    hdr.save(tmp / "hdr.png")
    once = tmp / "once.mp4"
    subprocess.run([FFMPEG, "-v", "error", "-y", "-ss", str(a.ref_start), "-t", str(dur), "-i", a.ref, "-i", a.ours, "-i", str(tmp / "hdr.png"),
                    "-filter_complex", "[0:v]scale=960:540,fps=30,setsar=1[l];[1:v]scale=960:540,fps=30,setsar=1[r];[l][r]hstack[v];[2:v][v]vstack[o]",
                    "-map", "[o]", "-map", "0:a?", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-t", str(dur), str(once)], check=True)
    parts = [once] * a.loops
    if a.slow > 1:
        slow = tmp / "slow.mp4"
        subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(once), "-vf", f"setpts={a.slow}*PTS", "-an", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", str(slow)], check=True)
        # silent audio for the slow part so the concat keeps one audio track
        slow_a = tmp / "slow_a.mp4"
        subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(slow), "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-shortest", "-c:v", "copy", "-c:a", "aac", str(slow_a)], check=True)
        parts.append(slow_a)
    lst = tmp / "list.txt"
    lst.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", a.out], check=True)
    print(a.out)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    p = sp.add_parser("frames"); p.add_argument("ref"); p.add_argument("--from", dest="from_", type=float, required=True); p.add_argument("--to", type=float, required=True)
    p.add_argument("--fps", type=float, default=10); p.add_argument("--cols", type=int, default=4); p.add_argument("--width", type=int, default=1920); p.add_argument("-o", "--out", required=True)
    p = sp.add_parser("sample"); p.add_argument("ref"); p.add_argument("--t", type=float, required=True); p.add_argument("--pt", action="append"); p.add_argument("--box", action="append")
    p = sp.add_parser("grab"); p.add_argument("ref"); p.add_argument("--t", required=True); p.add_argument("-o", "--out", required=True)
    p = sp.add_parser("sheet"); p.add_argument("ref"); p.add_argument("--ref-start", type=float, required=True); p.add_argument("--t")
    p.add_argument("--query"); p.add_argument("--only"); p.add_argument("--samples", type=int, default=12); p.add_argument("--ours", help="stills already rendered by render.ts stills (f_0001.20.png …): skip rendering"); p.add_argument("--cell", type=int, default=360); p.add_argument("--rows", type=int, default=6); p.add_argument("-o", "--out", required=True)
    p.add_argument("--cuts", action="store_true", help="the reference's cuts in --from..--to instead of --t"); p.add_argument("--from", dest="from_", type=float); p.add_argument("--to", type=float); p.add_argument("--ours-start", type=float, default=0.0, help="engine time at the start of an --ours video")
    p = sp.add_parser("strip"); p.add_argument("ref"); p.add_argument("--ref-start", type=float, required=True); p.add_argument("--ours", required=True); p.add_argument("--ours-start", type=float, default=0.0)
    p.add_argument("--t", required=True); p.add_argument("--n", type=int, default=8); p.add_argument("--width", type=int, default=2400); p.add_argument("-o", "--out", required=True)
    p = sp.add_parser("motion"); p.add_argument("ref"); p.add_argument("--ref-start", type=float, required=True); p.add_argument("--ours", required=True); p.add_argument("--ours-start", type=float, default=0.0)
    p.add_argument("--from", dest="from_", type=float); p.add_argument("--to", type=float); p.add_argument("--bar", type=float, help="one row per bar of this length (s); default 1.6"); p.add_argument("--seg", action="append", help="name:start:dur (engine time), repeatable"); p.add_argument("-o", "--out", required=True)
    p = sp.add_parser("video"); p.add_argument("ref"); p.add_argument("--ref-start", type=float, required=True); p.add_argument("--ours", required=True); p.add_argument("--dur", type=float)
    p.add_argument("--loops", type=int, default=3); p.add_argument("--slow", type=float, default=4); p.add_argument("--title"); p.add_argument("-o", "--out", required=True)
    a = ap.parse_args()
    {"frames": cmd_frames, "sample": cmd_sample, "grab": cmd_grab, "sheet": cmd_sheet, "strip": cmd_strip, "motion": cmd_motion, "video": cmd_video}[a.cmd](a)


if __name__ == "__main__":
    main()

"""交付自检（可选）：想在交片之前过一遍时用，把技术问题和看片材料写成一份报告。
不规定画面怎么做，也不规定流程：只有技术项（色彩、真峰值、音画偏移、闪光）和场景自己登记的卡点算问题；
其余各项（看片材料、曲线、候选、动作表、评审……）只做参考，没用就写「没用」，不算问题。

  python <引擎>/tools/qa/selfcheck.py [视频]          # 项目根目录运行；默认取 film/film.json 最新收的那一版的原文件
  python <引擎>/tools/qa/selfcheck.py 视频 --quick    # 不替你跑要开浏览器的两项（曲线图、卡点导出），几十秒就完

报告写到 out/qa/自检.md，终端里打印摘要。逐项：
  1 技术        check_video.py：色彩标签、真峰值、音画偏移、空帧、闪光
  2 看片材料    review.py 的联系表、运动量曲线；动作最大的三处各一张洋葱皮（review.py onion）
  3 看片笔记    out/qa/看片笔记.md：要比成片新，并且提到上面每一张图的文件名（写看到了什么、要不要改）。
                图是给 Agent 自己看的：想写就 Read 打开逐张写一两句（参考项）
  4 运动量跟歌  各段的画面运动量和歌的响度（RMS）是不是同起同落（等级相关）；最响的段是不是也动得最多
  5 动作曲线    render.ts curves（已导出且比成片新就直接用，否则试着自己跑；跑不了会给出命令）：kfe 轨道有几条、哪些「可能发飘」；一条都没有 = 主要动作没法检查（不用 kfe 也行，会标出来）
  6 卡点        render.ts cues + cuecheck.py：场景登记的关键动作离拍子差多少
  7 候选        film/film.json：每段有几个版本可挑；只有一版的段列出来
  8 确认      没标的段、等确认的「我打算」
  9 动作表      docs/TREATMENT.md「动作表」：有没有填、行数够不够分段数
 10 独立评审    out/qa/评审*.md：有没有、比成片新不新（评审的回复存成这个文件）
技术项或卡点有问题时退出码 1，其余项不影响退出码。报告只给事实，不打分；要不要改、怎么改还是看片子和做片的人。
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
ROOT = Path.cwd()
OUT = ROOT / "out" / "qa"
PY = sys.executable
ENV = {"PYTHONUTF8": "1"}


def run(cmd: list[str], cwd: Path = ROOT, timeout: int = 1800) -> tuple[int, str]:
    import os
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           env={**os.environ, **ENV}, timeout=timeout)
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except subprocess.TimeoutExpired:
        return 124, "超时"
    except FileNotFoundError as e:
        return 127, str(e)


def find_bun() -> str:
    """bun: PATH, ~/.bun, or the npm shim (on Windows a .cmd, which CreateProcess only runs by its full path); as in refmatch.py."""
    import os
    import shutil
    for c in (shutil.which("bun"), shutil.which("bun.cmd")):
        if c:
            return c
    for c in (Path.home() / ".bun/bin/bun.exe", Path(os.environ.get("APPDATA", "")) / "npm/bun.cmd"):
        if c.exists():
            return str(c)
    return "bun"


def config_start() -> float:
    cfg = ROOT / "app" / "src" / "config.ts"
    if cfg.exists():
        m = re.search(r"VIDEO_START\s*(?::[^=;]*)?=\s*(-?[\d.]+)", cfg.read_text(encoding="utf-8"))
        if m:
            return float(m.group(1))
    return 0.0


def film_state() -> dict | None:
    p = ROOT / "film" / "film.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


HARD = {"技术", "卡点"}  # 只有这两项算问题，影响退出码


class Report:
    def __init__(self):
        self.rows: list[tuple[str, str, str]] = []   # (项, 状态, 说明)；状态：OK / !! / 没做 / 不适用 / 待看
        self.looks: list[Path] = []                    # 要亲眼看的图

    def add(self, item: str, state: str, note: str):
        self.rows.append((item, state, note))
        print(f"[{state}] {item}：{note.splitlines()[0] if note else ''}")


# ---------------------------------------------------------------- 各项
def tech(rep: Report, video: Path, start: float):
    code, out = run([PY, str(HERE / "check_video.py"), str(video), "--start", str(start)])
    bad = [l.strip() for l in out.splitlines() if l.strip().startswith("[!!]")]
    rep.add("技术", "OK" if code == 0 and not bad else "!!", "全部通过" if code == 0 and not bad else "\n".join(bad) or out[-400:])


def motion_curve(video: Path) -> tuple[np.ndarray, float]:
    import cv2
    tmp = OUT / "_selfcheck_in.mp4"
    tmp.write_bytes(video.read_bytes())
    cap = cv2.VideoCapture(str(tmp))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    diff, prev = [], None
    while True:
        ok, f = cap.read()
        if not ok:
            break
        g = cv2.cvtColor(cv2.resize(f, (160, int(f.shape[0] * 160 / f.shape[1]))), cv2.COLOR_BGR2GRAY).astype(np.float32) / 255
        diff.append(float(np.abs(g - prev).mean()) if prev is not None else 0.0)
        prev = g
    cap.release()
    tmp.unlink()
    return np.array(diff), fps


def materials(rep: Report, video: Path, start: float) -> tuple[np.ndarray, float]:
    code, out = run([PY, str(HERE / "review.py"), str(video), "--start", str(start)])
    sheet, mot = OUT / f"{video.stem}_sheet.jpg", OUT / f"{video.stem}_motion.png"
    if code or not sheet.exists():
        rep.add("看片材料", "!!", "review.py 失败：" + out[-300:])
        return np.zeros(0), 30.0
    rep.looks += [sheet, mot]
    diff, fps = motion_curve(video)
    import review
    k = max(1, int(fps / 4))
    sm = np.convolve(diff, np.ones(k) / k, mode="same")
    # 动作最大的三处（彼此隔开 1.5 秒），各出一张洋葱皮
    order, picks = np.argsort(sm)[::-1], []
    for i in order:
        t = i / fps
        if all(abs(t - p) > 1.5 for p in picks):
            picks.append(t)
        if len(picks) == 3:
            break
    dur = len(diff) / fps
    for t in sorted(picks):
        t0, t1 = max(0.0, t - 0.4), min(dur - 0.05, t + 0.4)
        try:
            review.onion(video, round(t0, 2), round(t1, 2), 12)
            rep.looks.append(OUT / f"{video.stem}_onion_{round(t0, 2):g}-{round(t1, 2):g}.jpg")
        except SystemExit:
            pass
    rep.add("看片材料", "OK", f"联系表、运动量曲线、{len(picks)} 张洋葱皮（动作最大的几处：{', '.join(f'{p:.1f}s' for p in sorted(picks))}）")
    return sm, fps


def follow_song(rep: Report, sm: np.ndarray, fps: float, start: float):
    au = ROOT / "data" / "audio.json"
    if not au.exists() or not len(sm):
        rep.add("运动量跟歌", "不适用", "没有 data/audio.json（没分析歌）")
        return
    A = json.loads(au.read_text(encoding="utf-8"))
    rms = np.array((A.get("features") or {}).get("rms") or A.get("rms") or [])
    afps = A.get("fps", 100)
    dur = len(sm) / fps
    secs = [(s["start"] - start, s.get("name") or s.get("label") or "") for s in A.get("sections", []) if s["start"] - start < dur]
    bounds = sorted({max(0.0, t) for t, _ in secs} | {0.0, dur})
    rows = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        if b - a < 1.0:
            continue
        m = float(sm[int(a * fps):int(b * fps)].mean())
        r = float(rms[int((a + start) * afps):int((b + start) * afps)].mean()) if len(rms) else 0.0
        rows.append((a, b, m, r))
    if len(rows) < 3 or not len(rms):
        rep.add("运动量跟歌", "不适用", f"段落太少（{len(rows)} 段），比不出起伏")
        return
    mr = np.argsort(np.argsort([x[2] for x in rows])); rr = np.argsort(np.argsort([x[3] for x in rows]))
    rho = float(np.corrcoef(mr, rr)[0, 1])
    loud = max(rows, key=lambda x: x[3]); most = max(rows, key=lambda x: x[2])
    detail = "\n".join(f"  {a:6.1f}–{b:6.1f}s  运动 {m:.4f}  响度 {r:.3f}" for a, b, m, r in rows)
    ok = rho >= 0.3
    note = (f"等级相关 {rho:+.2f}（≥ 0.3 算同起同落）；最响的段 {loud[0]:.1f}–{loud[1]:.1f}s，动得最多的段 {most[0]:.1f}–{most[1]:.1f}s\n{detail}")
    rep.add("运动量跟歌", "OK" if ok else "!!", note)


def export(name: str, args: list[str], out: Path, video: Path, quick: bool) -> str | None:
    """render.ts 的导出（curves / cues）：Agent 已经导出、比成片新就直接用；否则试着自己跑。
    返回 None = 拿到了；否则是「没做」的说明（有的 Python 看不到 npm 装的 bun，跑不了时让 Agent 自己跑）。"""
    if out.exists() and out.stat().st_mtime >= video.stat().st_mtime:
        return None
    cmd = f"cd app && bun scripts/render.ts {name} " + " ".join(args)
    if quick:
        return f"{out.relative_to(ROOT).as_posix()} {'不存在' if not out.exists() else '比成片旧'}；--quick 不替你跑：{cmd}"
    code, log = run([find_bun(), "scripts/render.ts", name, *args], cwd=ROOT / "app")
    if code == 0 and out.exists() and out.stat().st_mtime >= video.stat().st_mtime:
        return None
    return f"自己跑没跑成（{log.strip().splitlines()[-1][:80] if log.strip() else code}）：先跑 {cmd}，再自检"


def curves(rep: Report, quick: bool, t0: float, t1: float, video: Path):
    if not (ROOT / "app" / "scripts" / "render.ts").exists():
        rep.add("动作曲线", "不适用", "没有 app（画面不是 app 做的）")
        return
    j = ROOT / "out" / "qa" / "curves" / "curves.json"
    why = export("curves", ["--from", f"{t0:.3f}", "--to", f"{t1:.3f}", "--step", "0.1"], j, video, quick)
    if why:
        rep.add("动作曲线", "没做", why)
        return
    sheets = json.loads(j.read_text(encoding="utf-8")).get("sheets", [])
    tracks = [t for s in sheets for t in s["tracks"]]
    if not tracks:
        rep.add("动作曲线", "!!", "场景里一条 kfe 轨道都没有：主要动作没法用曲线检查，也不能在预览里拖（kf 换成 kfe）")
        return
    floaty = [t["id"] for t in tracks if t.get("note")]
    for s in sheets:
        rep.looks.append(ROOT / "out" / "qa" / "curves" / (re.sub(r"[^\w.-]+", "_", s["scene"]) + ".png"))
    rep.add("动作曲线", "!!" if floaty else "OK",
            f"{len(tracks)} 条 kfe 轨道" + (f"；{len(floaty)} 条全是对称缓动，可能发飘：{', '.join(floaty[:8])}" if floaty else "，没有全对称的"))


def cues(rep: Report, quick: bool, video: Path):
    if not (ROOT / "app" / "scripts" / "render.ts").exists():
        rep.add("卡点", "不适用", "没有 app")
        return
    cj = ROOT / "out" / "qa" / "cues.json"
    why = export("cues", [], cj, video, quick)
    if why:
        rep.add("卡点", "没做", why)
        return
    n_scene = sum(1 for c in json.loads(cj.read_text(encoding="utf-8")).get("cues", []) if not str(c.get("name", "")).startswith("cut → "))
    code, out = run([PY, str(HERE / "cuecheck.py")])
    bad = [l for l in out.splitlines() if "!!" in l]
    note = f"场景登记了 {n_scene} 个关键动作" + ("" if n_scene else "（只有剪辑点：关键动作没登记 cues()，卡没卡上量不了）")
    rep.add("卡点", "OK" if code == 0 and n_scene else "!!", note + (f"；{len(bad)} 个偏差超过一帧" if bad else ""))


def candidates(rep: Report, st: dict | None):
    if not st:
        rep.add("候选", "没做", "没有 film/film.json：版本没用 film.py 收，没法逐段挑")
        return
    vs, segs = st.get("versions", []), st.get("segments", [])
    one = []
    for s in segs:
        n = sum(1 for v in vs if v["t0"] <= s["t0"] + 0.01 and s["t1"] - 0.01 <= v["t1"])
        if n <= 1:
            one.append(f"{s['id']}({n})")
    rep.add("候选", "!!" if one and len(one) > len(segs) / 2 else "OK",
            f"{len(segs)} 段、{len(vs)} 版" + (f"；只有一版或没有版本的段：{' '.join(one)}" if one else "；每段都有两版以上可挑"))


def confirm(rep: Report, st: dict | None):
    if not st:
        rep.add("确认", "不适用", "没有 film/film.json")
        return
    picks = st.get("picks", {})
    unmarked = [s["id"] for s in st.get("segments", []) if not (picks.get(s["id"]) or {}).get("pick")]
    waiting = [sid for sid, p in picks.items() if p.get("plan") and p.get("plan_ok") not in ("yes", "no")]
    note = []
    if unmarked:
        note.append(f"还没标的段：{' '.join(unmarked)}（按没认可算）")
    if waiting:
        note.append(f"「我打算」等确认：{' '.join(waiting)}")
    rep.add("确认", "待看" if note else "OK", "；".join(note) or "每段都标了，没有待确认的理解")


def motion_table(rep: Report, st: dict | None):
    p = ROOT / "docs" / "TREATMENT.md"
    if not p.exists():
        rep.add("动作表", "没做", "没有 docs/TREATMENT.md")
        return
    t = p.read_text(encoding="utf-8")
    m = re.search(r"^##\s*动作表\s*$(.*?)(?=^##\s|\Z)", t, re.M | re.S)
    if not m:
        rep.add("动作表", "没做", "TREATMENT.md 里没有「## 动作表」（模板：<引擎>/docs/TREATMENT模板.md）")
        return
    rows = [l for l in m.group(1).splitlines() if l.strip().startswith("|") and not re.match(r"^\|\s*[-:| ]+\|?\s*$", l.strip())]
    rows = [r for r in rows[1:] if len([c for c in r.strip("|").split("|") if c.strip()]) >= 3]   # 去掉表头，至少填了 3 格
    n_seg = len(st.get("segments", [])) if st else 0
    short = n_seg and len(rows) < n_seg
    rep.add("动作表", "!!" if not rows or short else "OK", f"填了 {len(rows)} 行" + (f"，片子分了 {n_seg} 段" if n_seg else ""))


def review_done(rep: Report, video: Path):
    files = sorted(OUT.glob("评审*.md"), key=lambda p: p.stat().st_mtime)
    if not files:
        rep.add("独立评审", "没做", "没有 out/qa/评审*.md（让没参与制作的子代理按 docs/检查和评审.md 的提示词挑刺，回复存成这个文件）")
        return
    newest = files[-1]
    if newest.stat().st_mtime < video.stat().st_mtime:
        rep.add("独立评审", "没做", f"{newest.name} 比成片旧：评审看的不是这一版")
        return
    rep.add("独立评审", "OK", f"{newest.name}")


def notes(rep: Report, video: Path):
    p = OUT / "看片笔记.md"
    names = [x.name for x in rep.looks if x.exists()]
    if not names:
        return
    if not p.exists() or p.stat().st_mtime < video.stat().st_mtime:
        rep.add("看片笔记", "没做", f"out/qa/看片笔记.md {'不存在' if not p.exists() else '比成片旧'}：把下面每张图 Read 打开看，逐张写看到了什么")
        return
    txt = p.read_text(encoding="utf-8")
    miss = [n for n in names if n not in txt]
    rep.add("看片笔记", "没做" if miss else "OK", (f"还没写到的图：{'、'.join(miss)}" if miss else f"{len(names)} 张图都写了"))


# ---------------------------------------------------------------- 主流程
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video", nargs="?")
    ap.add_argument("--quick", action="store_true", help="跳过要开浏览器的曲线图和卡点导出")
    ap.add_argument("--start", type=float, default=None, help="视频第 0 秒对应歌的第几秒（默认按 film.json 的偏移或 config.ts 的 VIDEO_START）")
    a = ap.parse_args()
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except AttributeError:
            pass
    st = film_state()
    start = a.start
    if a.video:
        video = Path(a.video)
    elif st and st.get("versions"):
        v = st["versions"][-1]
        video = Path(v.get("source") or v["file"])
        start = v.get("offset", 0.0) if start is None else start
    else:
        sys.exit("给一个视频，或者先用 film.py add 收一版")
    if not video.is_absolute():
        video = ROOT / video
    if not video.exists():
        sys.exit(f"没有这个文件：{video}")
    if start is None:
        start = config_start()
    OUT.mkdir(parents=True, exist_ok=True)
    print(f"自检：{video}（视频第 0 秒 = 歌的 {start:g} 秒）\n")
    rep = Report()
    tech(rep, video, start)
    sm, fps = materials(rep, video, start)
    follow_song(rep, sm, fps, start)
    dur = len(sm) / fps if len(sm) else 0.0
    curves(rep, a.quick, start, start + dur, video)
    cues(rep, a.quick, video)
    candidates(rep, st)
    confirm(rep, st)
    motion_table(rep, st)
    review_done(rep, video)
    notes(rep, video)

    # 只有技术项和登记的卡点算问题；其余是参考，「没做」写成「没用」
    rep.rows = [(i, "没用" if s == "没做" and i not in HARD else s, n) for i, s, n in rep.rows]
    bad = [r for r in rep.rows if r[0] in HARD and r[1] == "!!"]
    ref = [r for r in rep.rows if r[0] not in HARD and r[1] in ("!!", "没用", "待看")]
    L = [f"# 交付自检：{video.name}", "", f"成片：`{video}`；视频第 0 秒 = 歌的 {start:g} 秒。由 `tools/qa/selfcheck.py` 生成。", ""]
    L += ["## 有问题（技术、卡点）", ""] + ([f"- **{i}**：{n.splitlines()[0]}" for i, _, n in bad] or ["- 没有"]) + [""]
    L += ["## 参考（可选，没用不算问题）", ""] + ([f"- **{i}**（{s}）：{n.splitlines()[0]}" for i, s, n in ref] or ["- 没有"]) + [""]
    L += ["## 看片材料", "", "想看动起来的样子时 Read 打开：", ""]
    L += [f"- `{p.relative_to(ROOT).as_posix() if p.is_relative_to(ROOT) else p}`" for p in rep.looks if p.exists()] + [""]
    L += ["## 逐项", "", "| 项 | 状态 | 说明 |", "|---|---|---|"]
    for i, s, n in rep.rows:
        L.append(f"| {i} | {s} | {n.splitlines()[0].replace('|', '/') if n else ''} |")
    for i, s, n in rep.rows:
        if "\n" in n:
            L += ["", f"### {i}", "", "```", n, "```"]
    out = OUT / "自检.md"
    out.write_text("\n".join(L) + "\n", encoding="utf-8")
    print(f"\n技术、卡点有问题 {len(bad)} 项；参考 {len(ref)} 项。报告：{out.relative_to(ROOT).as_posix()}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()

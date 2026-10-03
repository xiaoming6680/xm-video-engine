"""用 Codex 桌面版自带 CLI 的内置生图批量出图（从 Still_Shining 的 gen_assets.py 整理）。

提示词写在一个 JSON 里（默认 assets/prompts.json），每张图一项：
  {
    "_style": "统一风格描述，拼在每条新图提示词后面（比例、画风、光线……）",
    "bg_city":  {"out": "assets/bg/city.png", "prompt": "A night city seen from above ...", "size": "Wide 16:9, 1920x1080."},
    "ch_front": {"out": "assets/char/front.png", "prompt": "...", "ref": "assets/char/sheet.png"},
    "ch_jump":  {"out": "assets/char/jump.png", "edit": "Edit the attached image: ...", "ref": "assets/char/front.png", "after": "ch_front"}
  }
  prompt = 新图（拼上 _style 和 size）；edit = 改图（原样发送，要求附 ref）；after = 依赖的另一张先出。

  python tools/codex_gen.py [names...] [--file assets/prompts.json] [--list] [--jobs 5]

已存在的 out 会跳过（重出就先删掉）。每张图的完整提示词和 Codex 日志写在 prompts 文件旁边的 <name>.txt / .log。
"""
import argparse
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path.cwd()


def codex() -> str:
    base = Path(os.environ["LOCALAPPDATA"]) / "OpenAI" / "Codex" / "bin"
    exes = sorted(base.glob("*/codex.exe"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not exes:
        sys.exit(f"找不到 codex.exe（{base}\\<hash>\\codex.exe）：装 Codex 桌面版，或搜一下 codex.exe 的位置")
    return str(exes[0])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="*")
    ap.add_argument("--file", default="assets/prompts.json")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--jobs", type=int, default=5)
    a = ap.parse_args()
    pf = ROOT / a.file
    spec = json.loads(pf.read_text(encoding="utf-8"))
    style = spec.pop("_style", "")
    logdir = pf.parent / "_codex"
    logdir.mkdir(parents=True, exist_ok=True)

    def have(n: str) -> bool:
        return (ROOT / spec[n]["out"]).exists()

    if a.list:
        for n in spec:
            print(("have " if have(n) else "     ") + n)
        return

    def text_of(n: str) -> str:
        s = spec[n]
        if "edit" in s:
            t = s["edit"]
            return t if "Save it as" in t else f"{t} Save it as {s['out']}"
        return f"Generate an image: {s['prompt']} {style} {s.get('size', '')} Save it as {s['out']}".replace("  ", " ")

    exe = codex()

    def run(n: str) -> bool:
        s, text = spec[n], text_of(n)
        (logdir / f"{n}.txt").write_text(text, encoding="utf-8")
        (ROOT / s["out"]).parent.mkdir(parents=True, exist_ok=True)
        cmd = [exe, "exec", "--skip-git-repo-check", "--sandbox", "workspace-write", text]
        if s.get("ref"):
            cmd += ["-i", s["ref"]]
        t0 = time.time()
        with open(logdir / f"{n}.log", "w", encoding="utf-8", errors="replace") as log:
            subprocess.run(cmd, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        ok = have(n)
        print(f"{'ok  ' if ok else 'FAIL'} {n:18s} {time.time() - t0:5.0f}s  {s['out']}", flush=True)
        return ok

    names = a.names or list(spec)
    todo = [n for n in names if not have(n)]
    first = [n for n in todo if not spec[n].get("after") or have(spec[n]["after"])]
    later = [n for n in todo if n not in first]
    with ThreadPoolExecutor(a.jobs) as ex:
        list(ex.map(run, first))
    with ThreadPoolExecutor(a.jobs) as ex:
        list(ex.map(run, later))


if __name__ == "__main__":
    main()

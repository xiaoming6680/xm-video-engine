"""从基础引擎建一个新的 MV 项目骨架。

  python tools/new_project.py ../我的新MV [--vertical]

复制：app/（不含 node_modules）、analysis/（不含 models、work）、tools/、docs/ 里的模板和清单、LICENSE（→ LICENSE.engine）；
建好 audio/ data/ assets/ out/ refs/；docs/TREATMENT.md 从模板来；--vertical 把 config.ts 改成 1080×1920。
目标目录已存在且不是空的就停下，不覆盖任何东西。之后：
  cd <项目>/app && bun install
  把歌放成 audio/song.wav，跑 analysis/ 的脚本生成 data/（见 docs/新项目流程.md）
"""
import argparse
import re
import shutil
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
SKIP = shutil.ignore_patterns("node_modules", "__pycache__", "models", "work", "*.log", "_codex")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--vertical", action="store_true", help="竖版 1080×1920（抖音）")
    a = ap.parse_args()
    dst = Path(a.target)
    if dst.exists() and any(dst.iterdir()):
        sys.exit(f"{dst} 已存在且不是空的，不覆盖。换个目录，或先自己清空。")
    dst.mkdir(parents=True, exist_ok=True)

    shutil.copytree(BASE / "app", dst / "app", ignore=SKIP)
    shutil.copytree(BASE / "analysis", dst / "analysis", ignore=SKIP)
    shutil.copytree(BASE / "tools", dst / "tools", ignore=SKIP)
    (dst / "docs").mkdir()
    shutil.copy(BASE / "docs" / "TREATMENT模板.md", dst / "docs" / "TREATMENT.md")
    shutil.copy(BASE / "LICENSE", dst / "LICENSE.engine")
    shutil.copy(BASE / ".gitignore", dst / ".gitignore")
    for d in ["audio", "data", "assets", "out", "refs"]:
        (dst / d).mkdir(exist_ok=True)

    # separation models: point the new project at the base engine's shared download
    sep = dst / "analysis" / "separate.py"
    s = sep.read_text(encoding="utf-8")
    s = re.sub(r"^SHARED = .*$", f"SHARED = {str((BASE / 'analysis' / 'models').as_posix())!r}", s, count=1, flags=re.M)
    sep.write_text(s, encoding="utf-8")

    cfg = dst / "app" / "src" / "config.ts"
    if a.vertical:
        s = cfg.read_text(encoding="utf-8")
        s = re.sub(r"export const W = \d+;", "export const W = 1080;", s)
        s = re.sub(r"export const H = \d+;", "export const H = 1920;", s)
        cfg.write_text(s, encoding="utf-8")

    (dst / "README.md").write_text(
        f"# {dst.name}\n\n代码生成的 MV。引擎来自「小铭的视频基础引擎」（MIT，见 LICENSE.engine）。\n\n"
        "- 预览：`cd app && bun install && bunx vite`\n- 设计：`docs/TREATMENT.md`\n", encoding="utf-8")
    print(f"建好了：{dst}")
    print("下一步：cd app && bun install；歌放成 audio/song.wav；按基础引擎 docs/新项目流程.md 生成 data/")


if __name__ == "__main__":
    main()

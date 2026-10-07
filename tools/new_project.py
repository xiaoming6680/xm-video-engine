"""从基础引擎建一个新的 MV 项目骨架。

  python tools/new_project.py ../我的新MV [--vertical]

复制：app/（不含 node_modules）、analysis/（不含 models、work）、tools/、docs/ 里的模板和清单、LICENSE（→ LICENSE.engine）；
建好 audio/ data/ assets/ out/ refs/；docs/TREATMENT.md 从模板来；写一份项目的 CLAUDE.md（流程和质量下限，指回基础引擎的文档）；
参考视频放 refs/，.gitignore 让它们不进仓库；--vertical 把 config.ts 改成 1080×1920。
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
    with open(dst / ".gitignore", "a", encoding="utf-8") as f:
        NL = chr(10)
        f.write(NL + "# 参考视频和截图只在本机对照（别人的作品），不进仓库" + NL
                + "".join(f"refs/**/*.{e}" + NL for e in ["mp4", "mkv", "webm", "mov", "m4a", "flac"]))
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
    base = BASE.as_posix()
    (dst / "CLAUDE.md").write_text(chr(10).join([
        f"# {dst.name}", "",
        f"用「小铭的视频基础引擎」做的 MV。基础引擎在 `{base}`，下面的 docs 都在那里。", "",
        "## 规矩", "",
        "- **流程**：`docs/新项目流程.md`。规格 → 节拍校验片 → 方向样片（10–15 秒带声音的真实代码）→ 全片粗分镜（`render.ts animatic`）→ "
        "关键镜头打样 → 分段精做；方向样片和粗分镜两步停下来给用户看，锁定项和带范围的反馈写进本项目 `docs/TREATMENT.md`",
        "- **质量下限**：复古 / 字符 / 故障 / 像素这类效果不低于基础引擎 `?ref=<名>` 十段的单帧质量（`docs/复刻配方.md` 第四节），同类镜头先抄它们的结构和数值；"
        "用户给了参考视频时，按第五节验收三样：单帧像（`tools/refmatch.py sheet`）、连贯（`tools/qa/seams.py --ref`，带音乐原速从头连着看）、"
        "运动量接近（`refmatch.py motion` / `strip`，每段 0.7–1.4）；只做到“效果有了”或只有单帧像、拼起来不连贯都不算",
        "- 每轮先带音乐、原速、从头到尾连着看，再看单帧和报告（`tools/qa/seams.py`、`check_video.py`、`render.ts glyphs`）",
        "- 每轮预览按 `docs/质量验收.md` 查缺陷；写场景前读 `docs/引擎指南.md`",
        "- 歌词不进对话：内嵌歌词用 ffprobe 直接写成 `data/lyrics.src.lrc`，只按行号和时间戳处理",
        "- 参考视频放 `refs/`，只在本机对照，不进仓库、不发布", "",
    ]), encoding="utf-8")
    print(f"建好了：{dst}")
    print("下一步：cd app && bun install；歌放成 audio/song.wav；按基础引擎 docs/新项目流程.md 生成 data/")


if __name__ == "__main__":
    main()

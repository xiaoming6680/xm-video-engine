"""建一个 MV 项目。默认是空项目：引擎的工具都能原地用，要改或要用哪部分再复制进来。

  python tools/new_project.py ../我的新MV                 # 空项目：CLAUDE.md、docs/TREATMENT.md、audio/ data/ assets/ out/ refs/
  python tools/new_project.py ../我的新MV app             # 加上 TypeScript 场景渲染器（要写 app 场景时）
  python tools/new_project.py ../我的新MV app analysis    # 模块可以一次给多个，也可以之后再加

模块：app（渲染器，不含效果库）、library（效果库全部，一般复制用到的文件就够）、analysis、tools、tts、skills、all（全部）。
原地用的意思是：在项目根目录运行 python <引擎>/analysis/run.py、python <引擎>/tools/film.py、python <引擎>/tools/qa/check_video.py，
它们读写当前目录。只有要改脚本本身时才需要复制。已经存在的文件和目录一律不覆盖。--vertical 把 app 的画布改成 1080×1920。
"""
import argparse
import re
import shutil
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
SKIP = shutil.ignore_patterns("node_modules", "__pycache__", "models", "work", "*.log", "_codex", "setup_structure.py")
SKIP_APP = shutil.ignore_patterns("node_modules", "__pycache__", "*.log", "library", "sfxtest.html", "sfx-test.ts", "tests")
SKIP_TTS = shutil.ignore_patterns("__pycache__", "models", ".venv-*", ".cache", "out", "setup_tts.py")
SKIP_TOOLS = shutil.ignore_patterns("node_modules", "__pycache__", "*.log", "_codex", ".venv", "samples")
MODULES = ("app", "library", "analysis", "tools", "tts", "skills")


def claude_md(name):
    base = BASE.as_posix()
    return f"""# {name}

MV 项目。可选的工具箱在 `{base}`（能力地图 `docs/README.md`），用不用、用哪些、怎么做画面都由你定。

- 目标是用户认可的成片。用户退回过的做法记在 `docs/TREATMENT.md`，开工前和被压缩后先重读它
- 怎么少返工：`{base}/docs/少返工.md`（来自历次退回的统计，是做法不是规矩）
- 要换掉用户认可过的内容，先问；评审意见里动到口味的也先问
- 歌词不进对话：只按行号和时间戳处理 `data/lyrics.src.lrc`
- 参考片只放 `refs/`，只在本机对照，不进仓库、不发布
- 浏览器里测试带声音的页面要静音
"""


def treatment(name):
    tpl = (BASE / "docs" / "TREATMENT模板.md").read_text(encoding="utf-8")
    return tpl.replace("《歌名》", f"《{name}》")


def write_new(path, text):
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def copy_dir(src, dst, ignore):
    if dst.exists():
        print(f"已有 {dst.name}/，跳过（不覆盖）")
        return False
    shutil.copytree(src, dst, ignore=ignore)
    return True


def point_shared(file, value):
    """复制出去的脚本用引擎那份模型和环境，不各下一份。"""
    s = file.read_text(encoding="utf-8")
    s = re.sub(r"^SHARED = .*$", f"SHARED = {value.as_posix()!r}", s, count=1, flags=re.M)
    file.write_text(s, encoding="utf-8")


def add(dst, m, vertical):
    if m == "app" and copy_dir(BASE / "app", dst / "app", SKIP_APP):
        if vertical:
            cfg = dst / "app" / "src" / "config.ts"
            s = cfg.read_text(encoding="utf-8")
            s = re.sub(r"export const W = \d+;", "export const W = 1080;", s)
            s = re.sub(r"export const H = \d+;", "export const H = 1920;", s)
            cfg.write_text(s, encoding="utf-8")
        print("下一步：cd app && bun install")
    elif m == "library":
        (dst / "app" / "src").mkdir(parents=True, exist_ok=True)
        copy_dir(BASE / "app" / "src" / "library", dst / "app" / "src" / "library", SKIP)
    elif m == "analysis" and copy_dir(BASE / "analysis", dst / "analysis", SKIP):
        point_shared(dst / "analysis" / "separate.py", BASE / "analysis" / "models")
        point_shared(dst / "analysis" / "structure.py", BASE / "analysis" / "models" / "songformer")
        shutil.copy(BASE / "tools" / "ffmpeg_path.py", dst / "analysis" / "ffmpeg_path.py")  # run.py 要用
    elif m == "tools" and copy_dir(BASE / "tools", dst / "tools", SKIP_TOOLS):
        point_shared(dst / "tools" / "audio" / "_env.py", BASE / "tools" / "audio")
    elif m == "tts" and copy_dir(BASE / "tts", dst / "tts", SKIP_TTS):
        point_shared(dst / "tts" / "common.py", BASE / "tts")
    elif m == "skills":
        copy_dir(BASE / ".claude" / "skills", dst / ".claude" / "skills", SKIP)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("target")
    ap.add_argument("modules", nargs="*", help=" ".join(MODULES) + " all")
    ap.add_argument("--vertical", action="store_true", help="app 的画布改成竖版 1080×1920")
    a = ap.parse_args()
    mods = list(MODULES) if "all" in a.modules else a.modules
    bad = [m for m in mods if m not in MODULES]
    if bad:
        sys.exit(f"没有这些模块：{bad}。可选：{' '.join(MODULES)} all")
    dst = Path(a.target)
    fresh = not (dst / "CLAUDE.md").exists()
    dst.mkdir(parents=True, exist_ok=True)
    for d in ("audio", "data", "assets", "out", "refs"):
        (dst / d).mkdir(exist_ok=True)
    write_new(dst / "CLAUDE.md", claude_md(dst.resolve().name))
    write_new(dst / "docs" / "TREATMENT.md", treatment(dst.resolve().name))
    write_new(dst / "README.md", f"# {dst.resolve().name}\n\n方向和用户的决定在 `docs/TREATMENT.md`。\n")
    if not (dst / "LICENSE.engine").exists():
        shutil.copy(BASE / "LICENSE", dst / "LICENSE.engine")
    if not (dst / ".gitignore").exists():
        shutil.copy(BASE / ".gitignore", dst / ".gitignore")
        with open(dst / ".gitignore", "a", encoding="utf-8") as f:
            f.write("\n# 参考视频和截图只在本机对照（别人的作品），不进仓库\n" + "".join(f"refs/**/*.{e}\n" for e in ("mp4", "mkv", "webm", "mov", "m4a", "flac")))
            f.write("\n# 版本工具的代理和代码快照很大，选择和备注（film/film.json）才进仓库\nfilm/media/\nfilm/code/\nfilm/restore/\nfilm/.cache/\nfilm/*.mp4\n")
    if not (dst / ".ignore").exists():
        shutil.copy(BASE / ".ignore", dst / ".ignore")  # 搜索跳过 data/（歌词不被搜进对话）
    for m in mods:
        add(dst, m, a.vertical)
    print(("建好了：" if fresh else "加好了：") + str(dst))
    if fresh:
        print(f"下一步：cd 进项目，python {BASE.as_posix()}/analysis/run.py 歌.flac；能力地图 {BASE.as_posix()}/docs/README.md")


if __name__ == "__main__":
    main()

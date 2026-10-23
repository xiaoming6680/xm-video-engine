"""从基础引擎建一个新的 MV 项目骨架。

  python tools/new_project.py ../我的新MV [--vertical]

复制：app/（不含 node_modules、效果库 src/library/ 和它的测试 sfxtest.html、scripts/sfx-test.ts、tests/）、analysis/（不含 models、work、setup_structure.py；分离模型和 SongFormer 环境共用基础引擎的）、tools/（不含配乐库的环境和采样，共用基础引擎的）、tts/（配音脚本，不含环境和模型，共用基础引擎的）、.claude/skills/、docs/ 里的 TREATMENT 模板、LICENSE（→ LICENSE.engine）；
建好 audio/ data/ assets/ out/ refs/；写一份项目的 CLAUDE.md（三步流程，指回基础引擎的文档）；
参考视频放 refs/，.gitignore 让它们不进仓库；--vertical 把 config.ts 改成 1080×1920。
要用效果库里的某个模块：把它（和它 import 的库内文件）按原路径复制进新项目的 app/src/library/，import 不用改。
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
SKIP = shutil.ignore_patterns("node_modules", "__pycache__", "models", "work", "*.log", "_codex",
                              "setup_structure.py")  # installs into the base engine only (shared)
# the effects library and its tests stay in the base engine: a project copies in the modules it uses
SKIP_APP = shutil.ignore_patterns("node_modules", "__pycache__", "*.log", "library", "sfxtest.html", "sfx-test.ts", "tests")
SKIP_TTS = shutil.ignore_patterns("__pycache__", "models", ".venv-*", ".cache", "out", "setup_tts.py")
# tools/audio: its environment and instrument samples (~400 MB) stay in the base engine (tools/audio/setup_audio.py)
SKIP_TOOLS = shutil.ignore_patterns("node_modules", "__pycache__", "*.log", "_codex", ".venv", "samples")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--vertical", action="store_true", help="竖版 1080×1920（抖音）")
    a = ap.parse_args()
    dst = Path(a.target)
    if dst.exists() and any(dst.iterdir()):
        sys.exit(f"{dst} 已存在且不是空的，不覆盖。换个目录，或先自己清空。")
    dst.mkdir(parents=True, exist_ok=True)

    shutil.copytree(BASE / "app", dst / "app", ignore=SKIP_APP)
    shutil.copytree(BASE / "analysis", dst / "analysis", ignore=SKIP)
    shutil.copytree(BASE / "tools", dst / "tools", ignore=SKIP_TOOLS)
    shutil.copytree(BASE / "tts", dst / "tts", ignore=SKIP_TTS)  # 配音（旁白类片子用）
    shutil.copytree(BASE / ".claude" / "skills", dst / ".claude" / "skills", ignore=SKIP)  # 复刻技能 mv-refmatch
    (dst / "docs").mkdir()
    shutil.copy(BASE / "docs" / "TREATMENT模板.md", dst / "docs" / "TREATMENT.md")
    shutil.copy(BASE / "LICENSE", dst / "LICENSE.engine")
    shutil.copy(BASE / ".gitignore", dst / ".gitignore")
    shutil.copy(BASE / ".ignore", dst / ".ignore")  # search skips data/ (lyrics never get grepped into a conversation)
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
    # structure analysis: same, for the SongFormer environment (analysis/setup_structure.py in the base engine)
    st = dst / "analysis" / "structure.py"
    s = st.read_text(encoding="utf-8")
    s = re.sub(r"^SHARED = .*$", f"SHARED = {str((BASE / 'analysis' / 'models' / 'songformer').as_posix())!r}", s, count=1, flags=re.M)
    st.write_text(s, encoding="utf-8")
    # narration (tts/): voices, ASR and aligner environments + models live in the base engine (tts/setup_tts.py)
    tc = dst / "tts" / "common.py"
    s = tc.read_text(encoding="utf-8")
    s = re.sub(r"^SHARED = .*$", f"SHARED = {str((BASE / 'tts').as_posix())!r}", s, count=1, flags=re.M)
    tc.write_text(s, encoding="utf-8")
    # soundtrack / sound effects (tools/audio/): the environment and samples are the base engine's too
    ae = dst / "tools" / "audio" / "_env.py"
    s = ae.read_text(encoding="utf-8")
    s = re.sub(r"^SHARED = .*$", f"SHARED = {str((BASE / 'tools' / 'audio').as_posix())!r}", s, count=1, flags=re.M)
    ae.write_text(s, encoding="utf-8")

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
        "- **流程**：`docs/新项目流程.md`，三步：节拍校验片 → 一段成片质量的样片 → 整片。样片和整片草稿给用户看；"
        "定下的事和用户的意见（标范围：镜 / 段 / 全片）记进本项目 `docs/TREATMENT.md`",
        "- **方向自己定，放手做**；不先出概念图当画面靶子（Codex 只做贴图、道具、背景）。用户认可的样片就是全片的画面标准",
        "- 写场景前读 `docs/引擎指南.md`（一页，必读）；细节按需搜 `docs/引擎参考.md`，不通读",
        "- 每轮先带音乐、原速、从头到尾连着看，再按 `docs/质量验收.md` 查缺陷；样片和整片草稿给用户前另开会话当评委挑刺（提示词 `docs/评审提示词.md`）",
        "- 效果库（字符画、云海、体素、拼贴、手绘线、MG 动作、花字、液态、玻璃、序列帧、MMD、shaders 库……）在基础引擎 `app/src/library/`，用户点名要某种效果时再去拿："
        "按原路径复制进本项目的 `app/src/library/`",
        "- 用户给了参考视频、明确要复刻：`docs/复刻配方.md` 第五节",
        "- 歌词不进对话：内嵌歌词用 ffprobe 直接写成 `data/lyrics.src.lrc`，只按行号和时间戳处理",
        "- 参考视频放 `refs/`，只在本机对照，不进仓库、不发布", "",
    ]), encoding="utf-8")
    print(f"建好了：{dst}")
    print("下一步：cd app && bun install；歌放成 audio/song.wav；按基础引擎 docs/新项目流程.md 生成 data/")


if __name__ == "__main__":
    main()

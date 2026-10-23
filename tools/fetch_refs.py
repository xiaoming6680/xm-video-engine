"""把第三方参考仓库按固定提交拉到 third_party/<目录>/（不进 git，见 third_party/README.md）。

这些不是引擎的一部分，是按需移植的参考：做到对应画风时拉下来读，改写成引擎的写法。
  python tools/fetch_refs.py                 # 全部
  python tools/fetch_refs.py papermotion     # 只拉一个
  python tools/fetch_refs.py --list          # 列出清单
已经拉过的目录跳过。--strip-media 删掉图片、视频、音频（和以前收在仓库里的那份一样，只留代码和文档）。
"""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / "third_party"

# 目录名、仓库、提交（2026-10 收录时的版本）
REFS = [
    ("lemo-opuscar", "https://github.com/lemomo-ai/lemo-opuscar.git", "c4bc370"),
    ("papermotion", "https://github.com/francozanardi/papermotion.git", "aafddbe"),
    ("claude-animation-skill", "https://github.com/buildwithhanif/claude-animation-skill.git", "4ddb8c8"),
    ("clearwater", "https://github.com/Aureliengmz/clearwater.git", "4bc8261"),
    ("ClaudeAnimationBase", "https://github.com/JohnHeibel/ClaudeAnimationBase.git", "0ac8bf2"),
    ("mg-styles-15", "https://github.com/Vincentwei1021/mg-styles-15.git", "49052d8"),
]
# 收录时把技能目录挪到了 <目录>/skill/，文档按这个路径引用：拉下来后照样放一份
ALIAS = {
    "claude-animation-skill": "plugins/claude-animation/skills/claude-animation",
    "papermotion": ".claude/skills/papermotion",
}
MEDIA = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".mov", ".webm", ".mkv", ".wav", ".mp3", ".flac", ".ogg", ".m4a", ".hdr", ".exr"}


def git(*args: str, cwd: Path | None = None) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True)


def fetch(name: str, url: str, rev: str, strip: bool) -> None:
    d = DEST / name
    if d.exists():
        print(f"{name}: 已有，跳过")
        return
    # 只下要检出的那一版的文件（blobless），再切到收录时的提交
    git("clone", "-q", "--filter=blob:none", "--no-checkout", url, str(d))
    git("checkout", "-q", rev, cwd=d)
    shutil.rmtree(d / ".git", ignore_errors=True)
    if name in ALIAS:
        shutil.copytree(d / ALIAS[name], d / "skill")
    if strip:
        for p in d.rglob("*"):
            if p.is_file() and p.suffix.lower() in MEDIA:
                p.unlink()
    print(f"{name}: {url} @ {rev} → {d.relative_to(ROOT).as_posix()}")


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--list" in sys.argv:
        for name, url, rev in REFS:
            print(f"{name:24s} {rev}  {url}")
        return
    names = {n for n, _, _ in REFS}
    for a in args:
        if a not in names:
            sys.exit(f"没有这个参考：{a}（--list 看清单）")
    DEST.mkdir(exist_ok=True)
    for name, url, rev in REFS:
        if not args or name in args:
            fetch(name, url, rev, "--strip-media" in sys.argv)


if __name__ == "__main__":
    main()

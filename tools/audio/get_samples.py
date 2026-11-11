"""把 mgaudio 的乐器采样放到 tools/audio/samples/（VCSL 子集，CC0，103 个文件约 56 MB，不进 git）。

  python tools/audio/get_samples.py --from <目录>   # 从本机复制：mg-styles-15 克隆里的 lib/audio/samples
  python tools/audio/get_samples.py --github        # 从 GitHub 取：git 稀疏检出 mg-styles-15，只下 lib/audio/samples
  python tools/audio/get_samples.py --check         # 只核对已有的采样
      [--ref <提交>]  --github 取哪个提交（默认是移植时核对过的 49052d8）
      [--dest 目录]   放到哪（默认 tools/audio/samples；放到别处时设 $MGAUDIO_SAMPLES 指过去）
      [--force]       目标里已有采样也覆盖

放好后按 samples.sha256 逐个核对：--github 核对不上就报错退出；--from 的来源可能是自己重建的，只提示。
也可以从 VCSL 原库重建（要联网和 librosa）：tools/audio/vcsl/ 的 select_vcsl.py → download_vcsl.sh → build_samples.py，
见 tools/audio/README.md。只用标准库，系统 Python 就能跑；--github 要 git。
"""
import argparse
import hashlib
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "samples.sha256"
REPO = "https://github.com/Vincentwei1021/mg-styles-15.git"
REF = "49052d80bfaf9fa8412cc9710530e5e95a3b8d8c"
SUB = "lib/audio/samples"


def _digest(p: Path) -> str:
    b = p.read_bytes()
    if p.suffix == ".json":  # git 的 autocrlf 会把文本检出成 CRLF；清单按仓库里的 LF 算
        b = b.replace(b"\r\n", b"\n")
    return hashlib.sha256(b).hexdigest()


def verify(dest: Path) -> tuple[int, list[str]]:
    """按清单核对：返回 (核对上的个数, 问题列表)。"""
    ok, bad = 0, []
    for line in MANIFEST.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        h, rel = line.split("  ", 1)
        p = dest / rel
        if not p.exists():
            bad.append(f"缺 {rel}")
        elif _digest(p) != h:
            bad.append(f"内容不同 {rel}")
        else:
            ok += 1
    return ok, bad


def _copy(src: Path, dest: Path):
    if not (src / "index.json").exists():
        sys.exit(f"{src} 里没有 index.json，不是 mgaudio 的采样目录（应是 mg-styles-15 的 {SUB}）")
    dest.mkdir(parents=True, exist_ok=True)
    n = 0
    for p in sorted(src.rglob("*")):
        if p.is_file():
            q = dest / p.relative_to(src)
            q.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, q)
            n += 1
    idx = dest / "index.json"
    idx.write_bytes(idx.read_bytes().replace(b"\r\n", b"\n"))
    print(f"复制了 {n} 个文件：{src} -> {dest}")


def _rmtree(p: Path):
    def onerr(func, path, _exc):  # git 的对象文件是只读的
        os.chmod(path, stat.S_IWRITE)
        func(path)
    shutil.rmtree(p, onexc=onerr) if sys.version_info >= (3, 12) else shutil.rmtree(p, onerror=onerr)


def _github(ref: str, dest: Path):
    git = shutil.which("git")
    if not git:
        sys.exit("--github 要 git；没有就手动下载 mg-styles-15 仓库，再用 --from <仓库>/lib/audio/samples")
    tmp = Path(tempfile.mkdtemp(prefix="mgaudio_samples_"))
    try:
        repo = tmp / "repo"
        print(f"稀疏检出 {REPO} @ {ref[:12]} 的 {SUB} …")
        run = lambda *a: subprocess.run([git, *a], check=True)  # noqa: E731
        run("clone", "--quiet", "--filter=blob:none", "--no-checkout", "--sparse", REPO, str(repo))
        run("-C", str(repo), "sparse-checkout", "set", SUB)
        run("-C", str(repo), "-c", "advice.detachedHead=false", "checkout", "--quiet", ref)
        _copy(repo / SUB, dest)
    finally:
        _rmtree(tmp)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--from", dest="src", help="本机的采样目录（mg-styles-15 的 lib/audio/samples）")
    g.add_argument("--github", action="store_true", help="从 GitHub 稀疏检出 mg-styles-15 的 lib/audio/samples")
    g.add_argument("--check", action="store_true", help="只核对已有的采样")
    ap.add_argument("--ref", default=REF, help="--github 用的提交 / 分支")
    ap.add_argument("--dest", default=os.environ.get("MGAUDIO_SAMPLES") or str(HERE / "samples"))
    ap.add_argument("--force", action="store_true", help="目标里已有采样也覆盖")
    a = ap.parse_args()
    dest = Path(a.dest)
    if not a.check:
        if (dest / "index.json").exists() and not a.force:
            print(f"{dest} 已有采样，不覆盖（要重来加 --force），只核对")
        elif a.github:
            _github(a.ref, dest)
        else:
            _copy(Path(a.src), dest)
    ok, bad = verify(dest)
    total = ok + len(bad)
    print(f"核对 {ok}/{total} 个文件一致" + ("" if not bad else "：" + "；".join(bad[:8]) + (" …" if len(bad) > 8 else "")))
    if bad and (a.github or a.check):
        sys.exit(1)


if __name__ == "__main__":
    main()

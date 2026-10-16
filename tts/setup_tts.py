"""装配音环境（只在基础引擎里装一次，各项目共用）：两个 venv + 三个模型，约 25 GB。已有的跳过，可以重跑。

  python tts/setup_tts.py [--rate 12M]     # --rate：下载限速（curl 的写法，别人在打游戏时用），默认不限

- .venv-voxcpm（Python 3.11）：torch 2.8.0+cu128、voxcpm、torchcodec 0.7 → voice.py / narrate.py
- .venv-asr（Python 3.12）：torch 2.11.0+cu128、qwen-asr（锁 transformers 4.57.6，和 voxcpm 冲突所以分开）→ check.py / align.py
- 模型放 tts/models/：openbmb/VoxCPM2（Apache-2.0）、Qwen/Qwen3-ASR-1.7B、Qwen/Qwen3-ForcedAligner-0.6B（都是 Apache-2.0）
需要 uv、curl；RTX 50 系（sm_120）要 cu128 的 torch。torch 轮子先用 curl 下到 tts/.cache/wheels（能限速），其余包走 uv（并发 1）。
"""
import argparse
import json
import os
import subprocess
import urllib.request
from pathlib import Path

HOME = Path(__file__).resolve().parent
WHL = HOME / ".cache" / "wheels"
TORCH = {  # venv → (Python 版本, torch 版本, 额外的包)
    ".venv-voxcpm": ("3.11", "2.8.0", ["voxcpm==2.0.3", "torchcodec==0.7.*", "soundfile"]),
    ".venv-asr": ("3.12", "2.11.0", ["qwen-asr==0.0.6", "transformers==4.57.6", "soundfile"]),
}
MODELS = {"VoxCPM2": "openbmb/VoxCPM2", "Qwen3-ASR-1.7B": "Qwen/Qwen3-ASR-1.7B",
          "Qwen3-ForcedAligner-0.6B": "Qwen/Qwen3-ForcedAligner-0.6B"}


def curl(url: str, dest: Path, rate: str):
    if dest.exists():
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    print("下载", dest.name)
    cmd = ["curl", "-sS", "-L", "--fail", "--retry", "5", "-C", "-", "-o", str(dest) + ".part", url]
    if rate:
        cmd[1:1] = ["--limit-rate", rate]
    subprocess.run(cmd, check=True)
    os.replace(str(dest) + ".part", dest)


def venv(name: str, rate: str, env: dict):
    py, tv, extra = TORCH[name]
    path = HOME / name
    if (path / "Scripts" / "python.exe").exists():
        print(name, "已有，跳过")
        return
    tag = "cp" + py.replace(".", "")
    wheels = []
    for pkg in ("torch", "torchaudio"):
        f = f"{pkg}-{tv}+cu128-{tag}-{tag}-win_amd64.whl"
        curl(f"https://download.pytorch.org/whl/cu128/{pkg}-{tv}%2Bcu128-{tag}-{tag}-win_amd64.whl", WHL / f, rate)
        wheels.append(str(WHL / f))
    subprocess.run(["uv", "venv", "-q", "-p", py, str(path)], check=True, env=env)
    pip = ["uv", "pip", "install", "-q", "-p", str(path / "Scripts" / "python.exe"), "--find-links", str(WHL)]
    subprocess.run(pip + wheels, check=True, env=env)
    subprocess.run(pip + [f"torch=={tv}+cu128", f"torchaudio=={tv}+cu128"] + extra, check=True, env=env)


def model(name: str, repo: str, rate: str):
    files = json.load(urllib.request.urlopen(f"https://huggingface.co/api/models/{repo}/tree/main?recursive=1"))
    for f in files:
        if f["type"] == "file":
            curl(f"https://huggingface.co/{repo}/resolve/main/{f['path']}", HOME / "models" / name / f["path"], rate)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rate", default="", help="下载限速，如 12M（字节/秒）")
    a = ap.parse_args()
    env = dict(os.environ, UV_CACHE_DIR=str(HOME / ".cache" / "uv"), UV_LINK_MODE="copy",
               UV_CONCURRENT_DOWNLOADS="1" if a.rate else os.environ.get("UV_CONCURRENT_DOWNLOADS", "4"))
    for name in TORCH:
        venv(name, a.rate, env)
    for name, repo in MODELS.items():
        model(name, repo, a.rate)
    print("配音环境装好了：", HOME)


if __name__ == "__main__":
    main()

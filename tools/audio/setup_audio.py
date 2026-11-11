"""装配乐 / 音效环境（只在基础引擎里装一次，各项目共用）：tools/audio/.venv，Python 3.12，约 400 MB。已有就跳过，可以重跑。

  python tools/audio/setup_audio.py [--librosa] [--force] [--python 3.12]

- 出声音的包版本跟 mgaudio 原作者验证过的一致（mg-styles-15 的 requirements.txt）：
  numpy、scipy、soundfile、numba、pedalboard、pyloudnorm；另装 matplotlib（画频谱图）；
  --librosa 另装 librosa（mgaudio.qc 的起音检测、vcsl/build_samples.py 重建采样时测音高要用，sfx_mix / score 不用）
- 需要 uv（setup_tts.py 也用它）；没有 uv 时退回标准库 venv + pip（用跑本脚本的这个 Python 的版本）
- 不往系统 Python 里装任何东西。装好以后 python tools/audio/xxx.py 会自己换到这个环境（_env.py）
"""
import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
VENV = HERE / ".venv"
PY = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
# matplotlib 只画图，不锁死：原作者的 3.9.1 在 Windows 上没有轮子（要现场编译，会失败）
PKGS = ["numpy==2.4.6", "scipy==1.16.3", "soundfile==0.14.0", "numba==0.66.0", "pedalboard==0.9.25",
        "pyloudnorm==0.2.0", "matplotlib>=3.9.2"]
LIBROSA = ["librosa==0.11.0"]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--librosa", action="store_true", help="另装 librosa（qc 起音检测 / 重建采样）")
    ap.add_argument("--force", action="store_true", help="删掉已有的 .venv 重装")
    ap.add_argument("--python", default="3.12", help="uv 用的 Python 版本（默认 3.12）")
    a = ap.parse_args()
    if a.force and VENV.exists():
        shutil.rmtree(VENV)
    pkgs = PKGS + (LIBROSA if a.librosa else [])
    uv = shutil.which("uv")
    env = dict(os.environ, UV_LINK_MODE="copy")
    if not PY.exists():
        if uv:
            subprocess.run([uv, "venv", "-q", "-p", a.python, str(VENV)], check=True, env=env)
        else:
            print("没找到 uv，用", sys.executable, "的 venv + pip")
            subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)
    else:
        print(VENV, "已有，只补装缺的包")
    if uv:
        subprocess.run([uv, "pip", "install", "-q", "-p", str(PY), *pkgs], check=True, env=env)
    else:
        subprocess.run([str(PY), "-m", "pip", "install", "-q", *pkgs], check=True)
    code = "import numpy, scipy, soundfile, numba, pedalboard, pyloudnorm, matplotlib; print('ok', numpy.__version__)"
    subprocess.run([str(PY), "-c", code], check=True)
    print("配乐环境装好了：", PY)
    if not (HERE / "samples" / "index.json").exists():
        print("采样还没放：python tools/audio/get_samples.py --github（或 --from <mg-styles-15 的 lib/audio/samples>）")


if __name__ == "__main__":
    main()

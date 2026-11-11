"""One-time setup for analysis/structure.py (SongFormer song-structure analysis).

  python analysis/setup_structure.py      (in the base engine; new projects don't get a copy)

Puts everything under the base engine's analysis/models/songformer/ (not in git; every project shares it):
  repo/   ASLP-lab/SongFormer at a pinned commit, with its MuQ and MusicFM submodules
  .venv/  its own Python 3.12 environment (made with uv): SongFormer pins transformers 4.x, the main
          environment has 5.x, and audio-separator / onnx there must not be disturbed
  repo/src/SongFormer/ckpts/  SongFormer + MusicFM weights; MuQ (~1.3 GB) downloads to the HF cache on first run
Needs git and uv on PATH and ~6 GB of disk (torch cu128 is most of it; uv reuses its cache).

Licences: SongFormer code + weights CC BY 4.0, MusicFM MIT, MuQ code MIT but its WEIGHTS ARE CC-BY-NC 4.0.
structure.py only produces section times for planning, nothing of the model ends up in the video; see
docs/模型选型.md before using it on paid work.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
HOME = BASE / "analysis" / "models" / "songformer"
REPO = HOME / "repo"
VENV = HOME / ".venv"
PY = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
COMMIT = "139b2aa3b14bd1c6d961d0994e9fc975f1ef7fd5"   # tested 2026-10-08 (MuQ 28847ea, musicfm b83ebed)
TORCH = ["torch==2.11.0+cu128", "torchaudio==2.11.0+cu128", "torchvision==0.26.0+cu128"]
PKGS = ["transformers==4.57.6", "numpy<2", "librosa", "soundfile", "scipy", "omegaconf", "ema-pytorch",
        "x-transformers", "x-clip", "einops", "easydict", "nnAudio", "safetensors", "huggingface_hub", "requests",
        "matplotlib", "msaf", "pandas", "loguru", "tqdm", "accelerate"]


def run(*cmd, **kw):
    print(">", " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], check=True, **kw)


def main():
    for tool in ("git", "uv"):
        if not shutil.which(tool):
            sys.exit(f"{tool} not found on PATH")
    HOME.mkdir(parents=True, exist_ok=True)
    if not (REPO / ".git").exists():
        run("git", "clone", "https://github.com/ASLP-lab/SongFormer.git", REPO)
    run("git", "-C", REPO, "checkout", "-q", COMMIT)
    run("git", "-C", REPO, "submodule", "update", "--init", "--recursive")

    if not PY.exists():
        run("uv", "venv", "--python", "3.12", VENV)
    env = dict(os.environ, VIRTUAL_ENV=str(VENV))
    # one resolve with torch pinned to the cu128 build (RTX 50 series): installed separately, x-clip & co. pull a
    # newer CPU torch from PyPI over it and torchaudio's DLL no longer loads
    run("uv", "pip", "install", *TORCH, *PKGS, "--extra-index-url", "https://download.pytorch.org/whl/cu128",
        "--index-strategy", "unsafe-best-match", env=env)
    run("uv", "pip", "install", "--no-deps", "-e", REPO / "src" / "third_party" / "MuQ", env=env)

    # SongFormer.safetensors + MusicFM weights (its own downloader, run from src/SongFormer)
    run(PY, "utils/fetch_pretrained.py", cwd=REPO / "src" / "SongFormer")
    run(PY, "-c", "import torch, muq, transformers; print('ok', torch.__version__, torch.cuda.is_available(), transformers.__version__)")
    print("done: python analysis/structure.py (from a project root)")


if __name__ == "__main__":
    main()

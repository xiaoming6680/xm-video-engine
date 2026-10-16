"""配音脚本的公共设置（只用标准库，两个 venv 都能导入）：项目路径、共用的环境和模型、文案分段。

环境和模型只在基础引擎里放一份（约 25 GB），各项目共用：$XM_TTS，否则本项目 tts/ 下有模型就用自己的，否则 SHARED
（tools/new_project.py 会把基础引擎的 tts 路径写进这里）。
"""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # 项目根目录
SHARED = str(ROOT / "tts")  # (in the base engine itself: its own folder)
_local = ROOT / "tts"
HOME = Path(os.environ.get("XM_TTS") or (_local if (_local / "models").is_dir() else SHARED))
MODELS = HOME / "models"
OUT = ROOT / "tts" / "out"  # 生成的音频放在项目自己这里
VOICES = OUT / "voices"
TAKES = OUT / "takes"

_FFMPEG_DLL = [Path("E:/ffmpeg-master-latest-win64-gpl-shared/bin")]


def ffmpeg_dlls():
    """torchcodec（VoxCPM 读参考音用）要 ffmpeg 的共享库版 DLL。torch 必须先加载：ffmpeg 目录里有同名 DLL，抢先加载会让 torch 段错误。"""
    import torch  # noqa: F401

    for d in _FFMPEG_DLL:
        if d.is_dir():
            os.add_dll_directory(str(d))
            os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")


def load_voxcpm():
    """加载 VoxCPM2。权重改用 safetensors 的 pread 读：默认的 mmap 读在模型建好之后会访问冲突、整个进程段错误
    （2026-10-17 在这台机器上稳定复现；单独读文件两种都正常，原因没查到）。"""
    ffmpeg_dlls()
    import functools

    import voxcpm.model.voxcpm2 as vm
    from safetensors.torch import load_file
    from voxcpm import VoxCPM

    vm.load_file = functools.partial(load_file, backend="pread")
    return VoxCPM.from_pretrained(str(MODELS / "VoxCPM2"), load_denoiser=False)


def sections() -> dict[str, str]:
    """data/script.json → {段: 这一段要读的文字}。一行 {"sec": 段, "text": 字幕, "say": 读法（可省）}，同段的行连起来整段生成。"""
    script = json.loads((ROOT / "data" / "script.json").read_text(encoding="utf-8"))
    out: dict[str, list[str]] = {}
    for ln in script["lines"]:
        out.setdefault(ln["sec"], []).append(ln.get("say", ln["text"]))
    return {k: "".join(v) for k, v in out.items()}


def load_index(folder: Path) -> dict:
    p = folder / "index.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def save_index(folder: Path, index: dict):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")

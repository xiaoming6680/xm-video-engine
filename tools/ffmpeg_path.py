"""找 ffmpeg / ffprobe：先看 PATH，再看本机已知位置（ffmpeg 不在 PATH 上）。"""
import shutil
from pathlib import Path

_KNOWN = [
    Path.home() / "AppData/Local/Microsoft/WinGet/Packages",  # winget 装的版本，下面按 glob 找
    Path("E:/ffmpeg-master-latest-win64-gpl-shared/bin"),
]


def _find(name: str) -> str:
    hit = shutil.which(name)
    if hit:
        return hit
    for base in _KNOWN:
        if not base.exists():
            continue
        if (base / f"{name}.exe").exists():
            return str(base / f"{name}.exe")
        for p in base.glob(f"Gyan.FFmpeg*/**/bin/{name}.exe"):
            return str(p)
    raise FileNotFoundError(f"找不到 {name}：装 ffmpeg 或把它加到 PATH")


FFMPEG = _find("ffmpeg")
FFPROBE = _find("ffprobe")

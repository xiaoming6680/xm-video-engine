"""配乐 / 音效工具的环境和路径（只用标准库，任何 Python 都能导入）。

环境（tools/audio/.venv）和采样（tools/audio/samples/）只在基础引擎里放一份，各项目共用：
  $XM_AUDIO，否则本项目 tools/audio/ 下有 .venv / samples 就用自己的，否则 SHARED
  （tools/new_project.py 会把基础引擎的 tools/audio 路径写进 SHARED 这一行）。
入口脚本开头调 ensure()：当前 Python 缺依赖、而环境已经装好时，换成环境里的 Python 重跑自己。
"""
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent  # tools/audio
SHARED = str(HERE)  # (in the base engine itself: its own folder)
REQUIRED = ["numpy", "scipy", "soundfile", "numba", "pedalboard", "pyloudnorm"]


def _home(sub: str) -> Path:
    env = os.environ.get("XM_AUDIO")
    if env:
        return Path(env)
    return HERE if (HERE / sub).exists() else Path(SHARED)


def venv_python() -> Path:
    v = _home(".venv") / ".venv"
    return v / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def samples_dir() -> Path:
    return _home("samples/index.json") / "samples"


def missing() -> list[str]:
    return [m for m in REQUIRED if importlib.util.find_spec(m) is None]


def utf8_console():
    """跟引擎别的脚本一样输出 UTF-8（Windows 管道默认 GBK）。"""
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="backslashreplace")
        except Exception:
            pass


def ensure():
    """依赖齐了就设好采样目录返回；不齐就用 tools/audio/.venv 的 Python 重跑当前脚本，没有环境就说清楚怎么装。"""
    utf8_console()
    os.environ.setdefault("MGAUDIO_SAMPLES", str(samples_dir()))
    if str(HERE) not in sys.path:
        sys.path.insert(0, str(HERE))
    lack = missing()
    if not lack:
        return
    py = venv_python()
    if py.exists() and Path(sys.executable).resolve() != py.resolve():
        env = dict(os.environ, PYTHONUTF8="1")
        sys.exit(subprocess.run([str(py), *sys.argv], env=env).returncode)
    sys.exit(f"当前 Python（{sys.executable}）缺 {', '.join(lack)}。\n"
             f"先装配乐环境：python {HERE / 'setup_audio.py'}（建 {py.parent.parent}，不动系统 Python），"
             f"之后照常 python 跑这些脚本就会自动换到那个环境；也可以直接用 {py} 跑。")

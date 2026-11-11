"""读项目的 app/src/config.ts 里的视频起止（VIDEO_START、VIDEO_END：视频在歌里的第几秒开始、结束）。

  from project_config import video_range, video_start
  start, end = video_range(Path.cwd())     # 没有 app、没写或写成 null 的返回 None
  start = video_start(Path.cwd())          # 没有就 0.0

认得 `VIDEO_START = 15.6`、`VIDEO_START: number = 15.6`、负数（片头卡在歌开始之前）。
film.py、selfcheck.py、check_video.py、audio/sfx_mix.py 都用这一处，偏移才算得一致。
"""
import re
from pathlib import Path

_NUM = r"\s*(?::[^=;]*)?=\s*(-?\d+(?:\.\d*)?|-?\.\d+)"


def video_range(root: Path) -> tuple[float | None, float | None]:
    cfg = Path(root) / "app" / "src" / "config.ts"
    if not cfg.exists():
        return None, None
    text = cfg.read_text(encoding="utf-8")
    out = []
    for name in ("VIDEO_START", "VIDEO_END"):
        m = re.search(r"\b" + name + _NUM, text)
        out.append(float(m.group(1)) if m else None)
    return out[0], out[1]


def video_start(root: Path, default: float = 0.0) -> float:
    s, _ = video_range(root)
    return default if s is None else s

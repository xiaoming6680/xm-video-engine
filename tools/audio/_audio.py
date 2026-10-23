"""sfx_mix.py / score.py 共用的部分：音效清单（「名字@秒[@增益]」和 cues.json）、读写音频、ffmpeg、轻母带。

要在 _env.ensure() 之后导入（需要 numpy 和 mgaudio）。
"""
from __future__ import annotations

import ast
import json
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import soundfile as sf

from mgaudio import core, master as M, sfx as SFX

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # tools/：ffmpeg_path
from ffmpeg_path import FFMPEG, FFPROBE  # noqa: E402

SR = core.SR
AUDIO_EXT = {".wav", ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".aif", ".aiff", ".wma"}
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"}
# 常用的叫法 → (mgaudio.sfx 的函数, 默认参数)；hit(size=1.5) 这样也能加参数
ALIASES = {"hit": ("impact", {"kind": "punch"})}
# 需要传入一段声音、清单里没法写的函数
_NEEDS_SOUND = {"swell", "stutter", "record_scratch"}


def sfx_names() -> list[str]:
    """mgaudio.sfx 里能在清单里直接用的函数名（加上别名）。"""
    out = [k for k, v in vars(SFX).items()
           if callable(v) and not k.startswith("_") and getattr(v, "__module__", "") == SFX.__name__
           and k not in _NEEDS_SOUND]
    return sorted(out + list(ALIASES))


# ---------------------------------------------------------------------------------------------- 清单
@dataclass
class Item:
    """一个要放的音效。t = 画面上那一下的时刻（成片秒）；src = 文件路径或 sfx 表达式。"""
    src: str
    t: float
    gain: float = 0.0
    pan: float | None = None
    label: str = ""
    is_file: bool = False
    meta: dict = field(default_factory=dict)


_SPEC = re.compile(r"^(?P<src>.+?)@(?P<t>[-+]?\d+(?:\.\d*)?)(?:@(?P<g>[-+]?\d+(?:\.\d*)?))?$")


def is_audio_file(s: str) -> bool:
    return Path(s).suffix.lower() in AUDIO_EXT or Path(s).is_file()


def parse_at(spec: str) -> Item:
    """「名字或文件@秒[@增益dB]」→ Item。名字可以带参数：whoosh(0.8, kind='sci')@3.2@-4。"""
    m = _SPEC.match(spec.strip())
    if not m:
        raise ValueError(f"看不懂 {spec!r}：要写成 名字@秒 或 名字@秒@增益dB（例如 pop@1.5、whoosh(0.8)@3.2@-4、a.wav@2）")
    src = m.group("src").strip()
    item = Item(src=src, t=float(m.group("t")), gain=float(m.group("g") or 0.0), label=src)
    item.is_file = is_audio_file(src)
    if not item.is_file:
        sfx_call(src)  # 现在就检查写法，不等到渲染
    return item


def sfx_call(expr: str):
    """解析 sfx 表达式（只认 mgaudio.sfx 的函数，参数只能是字面量），返回 (函数, args, kwargs)。不用 eval。"""
    expr = expr.strip()
    try:
        node = ast.parse(expr, mode="eval").body
    except SyntaxError:
        raise ValueError(f"音效写法不对：{expr!r}") from None
    if isinstance(node, ast.Name):
        name, args, kw = node.id, [], {}
    elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        name = node.func.id
        try:
            args = [ast.literal_eval(a) for a in node.args]
            kw = {k.arg: ast.literal_eval(k.value) for k in node.keywords if k.arg}
        except ValueError:
            raise ValueError(f"{expr!r}：参数只能写数字、字符串、列表这类字面量") from None
        if any(k.arg is None for k in node.keywords):
            raise ValueError(f"{expr!r}：不支持 **参数")
    else:
        raise ValueError(f"音效写法不对：{expr!r}（要写成 名字 或 名字(参数)）")
    if name not in sfx_names():
        raise ValueError(f"没有叫 {name!r} 的音效；可用的：{' '.join(sfx_names())}")
    if name in ALIASES:
        name, base = ALIASES[name]
        kw = {**base, **kw}
    return getattr(SFX, name), args, kw


def make_sound(item: Item) -> core.Sound:
    if item.is_file:
        x = read_audio(item.src)
        if x is None:
            raise ValueError(f"{item.src} 里没有音轨")
        return core.Sound(x, 0.0)
    fn, args, kw = sfx_call(item.src)
    try:
        s = fn(*args, **kw)
    except TypeError as e:
        raise ValueError(f"{item.src}：{e}") from None
    return core.as_sound(s)


def load_cues(path: str | Path) -> list[dict]:
    """读 cue 列表。支持 render.ts cues 导出的 {"cues": [{t, name, on, scene}]}、直接一个列表，
    或 mgaudio 的 {名字: 秒 | [秒, …]}。每条可以额外带 sfx / gain / pan。时间是歌曲秒。"""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, dict) and "cues" in data:
        data = data["cues"]
    if isinstance(data, dict):
        rows = []
        for k, v in data.items():
            for t in (v if isinstance(v, list) else [v]):
                if isinstance(t, (int, float)):
                    rows.append({"t": float(t), "name": k})
        data = rows
    out = []
    for c in data:
        if isinstance(c, (int, float)):
            c = {"t": float(c), "name": ""}
        out.append(dict(c, t=float(c["t"]), name=str(c.get("name", ""))))
    return sorted(out, key=lambda c: c["t"])


def cue_items(cues: list[dict], start: float, maps: list[str], default: str | None) -> tuple[list[Item], list[dict]]:
    """cue → Item：cue 自带 sfx 字段优先，然后按 --map 的「正则=音效」（对 cue 名字，先写的先匹配），再用 --cue-sfx。
    时间换算成片秒 = cue 秒 − start。返回 (要放的, 没配上音效的)。"""
    rules = []
    for m in maps:
        if "=" not in m:
            raise ValueError(f"--map 要写成 正则=音效：{m!r}")
        pat, s = m.split("=", 1)
        sfx_call(s) if not is_audio_file(s) else None
        rules.append((re.compile(pat, re.I), s))
    items, skipped = [], []
    for c in cues:
        src = c.get("sfx") or next((s for rx, s in rules if rx.search(c["name"])), None) or default
        if not src:
            skipped.append(c)
            continue
        it = Item(src=src, t=c["t"] - start, gain=float(c.get("gain", 0.0)), pan=c.get("pan"),
                  label=f"{src} ← {c['name'] or 'cue'}", is_file=is_audio_file(src), meta={"cue_t": c["t"]})
        if not it.is_file:
            sfx_call(src)
        items.append(it)
    return items, skipped


# ---------------------------------------------------------------------------------------------- 音频读写
def probe(path: str | Path) -> dict:
    out = subprocess.run([FFPROBE, "-v", "error", "-show_entries",
                          "stream=index,codec_type,duration,r_frame_rate,color_space,color_primaries,color_transfer"
                          ":format=duration", "-of", "json", str(path)],
                         capture_output=True, text=True, encoding="utf-8", errors="replace")
    if out.returncode:
        raise ValueError(f"ffprobe 读不了 {path}：{out.stderr.strip()[:200]}")
    j = json.loads(out.stdout)
    st = j.get("streams", [])
    v = next((s for s in st if s["codec_type"] == "video"), None)
    a = next((s for s in st if s["codec_type"] == "audio"), None)
    dur = float((v or {}).get("duration") or j.get("format", {}).get("duration") or 0)
    fps = None
    if v and v.get("r_frame_rate", "0/0") != "0/0":
        n, d = v["r_frame_rate"].split("/")
        fps = float(n) / float(d) if float(d) else None
    tags = (v.get("color_space"), v.get("color_primaries"), v.get("color_transfer")) if v else None
    return {"video": v is not None, "audio": a is not None, "duration": dur, "fps": fps, "tags": tags}


def _resample(x: np.ndarray, sr: int) -> np.ndarray:
    if sr == SR:
        return x
    from math import gcd
    from scipy.signal import resample_poly
    g = gcd(SR, sr)
    return resample_poly(x, SR // g, sr // g, axis=1)


def read_audio(path: str | Path) -> np.ndarray | None:
    """任意音频 / 视频 → (2, n) float64 @ 48 kHz；没有音轨返回 None。wav/flac 直接读，其它交给 ffmpeg。"""
    path = Path(path)
    if path.suffix.lower() in {".wav", ".flac", ".aif", ".aiff", ".ogg"}:
        try:
            x, sr = sf.read(str(path), always_2d=True, dtype="float64")
            if x.shape[1] <= 2:
                return core.to_stereo(_resample(x.T, sr))
        except RuntimeError:
            pass
    if not probe(path)["audio"]:
        return None
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / "a.wav"
        subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(path), "-map", "0:a:0", "-vn", "-ac", "2",
                        "-ar", str(SR), "-c:a", "pcm_f32le", str(tmp)], check=True)
        x, _ = sf.read(str(tmp), always_2d=True, dtype="float64")
    return core.to_stereo(x.T)


def write_wav(path: str | Path, y: np.ndarray, subtype: str = "PCM_24"):
    M.write(str(path), y, subtype)


def loudness(path: str | Path) -> tuple[float, float]:
    """ffmpeg ebur128 量整段：(积分响度 LUFS, 真峰值 dBTP)。跟 tools/qa/check_video.py 一样的量法。"""
    out = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", str(path), "-map", "0:a:0",
                          "-af", "ebur128=peak=true", "-f", "null", "-"],
                         capture_output=True, text=True, encoding="utf-8", errors="replace")
    tail = (out.stdout + out.stderr)
    tail = tail[tail.rfind("Summary:"):]
    i = float(re.search(r"I:\s*(-?[\d.]+) LUFS", tail).group(1))
    tp = float(re.search(r"Peak:\s*(-?[\d.]+) dBFS", tail).group(1))
    return i, tp


def master_light(x: np.ndarray, lufs: float = -14.0, tp: float = -1.0) -> tuple[np.ndarray, dict]:
    """给已经做过母带的歌 + 音效用的轻母带：只做 20 kHz 线性相位低通、真峰值限幅和响度归一（mgaudio.master 去掉
    高通、总线压缩、低频合单声道和首尾淡入淡出，不改歌本身的声音）。不加高通：IIR 高通在低频的相位超前会让
    check_video.py 量出约 −2 ms 的音画偏移。"""
    return M.master(x, lufs=lufs, tp=tp, hp=None, glue_comp=False, mono_bass=None, fade_in=0.0, fade_out=0.0)


def encode(wav: Path, out: Path, video: Path | None = None, dur: float | None = None):
    """wav → 输出。有 video 时视频流原样复制（BT.709 标签跟着走），音轨编 AAC 320k 48 kHz（edit list 抵消编码延迟）。"""
    out.parent.mkdir(parents=True, exist_ok=True)
    if video is not None:
        cmd = [FFMPEG, "-v", "error", "-y", "-i", str(video), "-i", str(wav), "-map", "0:v", "-map", "1:a:0",
               "-c:v", "copy", "-c:a", "aac", "-b:a", "320k", "-ar", str(SR)]
        if dur:
            cmd += ["-t", f"{dur:.4f}"]
        cmd += ["-movflags", "+faststart", str(out)]
    else:
        codec = {".m4a": ["-c:a", "aac", "-b:a", "320k"], ".aac": ["-c:a", "aac", "-b:a", "320k"],
                 ".mp3": ["-c:a", "libmp3lame", "-b:a", "320k"], ".ogg": ["-c:a", "libvorbis", "-q:a", "8"],
                 ".opus": ["-c:a", "libopus", "-b:a", "256k"]}.get(out.suffix.lower())
        if codec is None:
            raise ValueError(f"不认识的输出格式 {out.suffix}（音频用 .wav .flac .m4a .mp3 .ogg .opus，视频用 .mp4 .mov .mkv）")
        cmd = [FFMPEG, "-v", "error", "-y", "-i", str(wav), *codec, "-ar", str(SR), str(out)]
    subprocess.run(cmd, check=True)

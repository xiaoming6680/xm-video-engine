"""一条命令把歌变成数据。在项目根目录运行：

  python <引擎>/analysis/run.py 歌.flac [--bpm 134] [--force] [--only separate,analyze,lyrics,events]

会依次做：转成 audio/song.wav（44.1 kHz）→ 内嵌歌词写进 data/lyrics.src.lrc（不打印）→ 分离人声和四轨 → 节拍和包络 data/audio.json →
逐词对齐 data/lyrics.json（有歌词才跑；中文、日文、韩文走 align_words.py，英文走 ctc_align.py）→ 声音事件 data/events.json。已有结果的步骤跳过（--force 重跑）。
某一步失败不影响后面的步骤，最后列出来。只想要某一步就直接跑那个脚本（都在 analysis/，文件开头有说明）。
速度、段落不对：在 data/song_config.json 写 {"bpm_hint": 134, "section_bars": [["intro", null, 8], ["drop", 8, null]]}，再 --only analyze --force。
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent / "tools")]  # 只复制了 analysis 模块时，ffmpeg_path.py 在 analysis/ 里
from ffmpeg_path import FFMPEG, FFPROBE  # noqa: E402

ROOT = Path.cwd()
AUDIO, DATA = ROOT / "audio", ROOT / "data"
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass


def run(script, *args):
    return subprocess.run([sys.executable, str(HERE / script), *args], cwd=ROOT, env={**__import__("os").environ, "PYTHONUTF8": "1"}).returncode == 0


def step_wav(src, force):
    wav = AUDIO / "song.wav"
    if wav.exists() and (not force or not src):
        return True
    if not src:
        print("没有 audio/song.wav，也没给歌的文件")
        return False
    AUDIO.mkdir(exist_ok=True)
    return subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", str(wav)]).returncode == 0


def step_lyrics_src(src):
    """内嵌歌词直接写文件，不经过屏幕。"""
    lrc = DATA / "lyrics.src.lrc"
    if lrc.exists() or not src:
        return
    for tag in ("LYRICS", "lyrics", "UNSYNCEDLYRICS", "unsyncedlyrics"):
        r = subprocess.run([FFPROBE, "-v", "quiet", "-show_entries", f"format_tags={tag}", "-of", "default=nw=1:nk=1", str(src)], capture_output=True)
        if r.stdout.strip():
            lrc.write_bytes(r.stdout)
            print(f"内嵌歌词写进 {lrc.relative_to(ROOT).as_posix()}（{len(r.stdout.splitlines())} 行，没有打印）")
            return


def summary():
    au = DATA / "audio.json"
    if au.exists():
        d = json.loads(au.read_text(encoding="utf-8"))
        beats = d.get("beats") or []
        secs = d.get("sections") or []
        bpm = d.get("bpm") or d.get("tempo") or (round(60 * (len(beats) - 1) / (beats[-1] - beats[0]), 2) if len(beats) > 1 else "?")
        print(f"  节拍：{bpm} BPM，{len(beats)} 拍，{len(d.get('downbeats') or [])} 小节，{len(secs)} 段")
    ev = DATA / "events.json"
    if ev.exists():
        d = json.loads(ev.read_text(encoding="utf-8"))
        items = d.get("events", d) if isinstance(d, dict) else d
        if isinstance(items, list):
            kinds = {}
            for x in items:
                k = x.get("type") or x.get("kind") if isinstance(x, dict) else None
                kinds[k] = kinds.get(k, 0) + 1
            print("  事件：" + "，".join(f"{k} {n}" for k, n in sorted(kinds.items(), key=lambda kv: -kv[1])[:8]))
    if (DATA / "lyrics.json").exists():
        print("  歌词：逐词对齐好了（data/lyrics.json）")


def pick_aligner(choice):
    """auto：原文里有中日韩文字就用 align_words.py（转写成字母再对齐），全是拉丁字母就用 ctc_align.py（英文，两个模型融合）。"""
    if choice != "auto":
        return "align_words.py" if choice == "words" else "ctc_align.py"
    from romanize import is_cjk, pick_lines
    lines = pick_lines((DATA / "lyrics.src.lrc").read_text(encoding="utf-8"))
    return "align_words.py" if any(is_cjk(text) for _, text, _ in lines) else "ctc_align.py"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("song", nargs="?", help="歌的文件；已经有 audio/song.wav 可以不给")
    ap.add_argument("--bpm", type=float, help="大概的速度：自动判成半速、倍速时给")
    ap.add_argument("--force", action="store_true", help="已有结果也重跑")
    ap.add_argument("--only", default="", help="只跑这几步：separate,analyze,lyrics,events")
    ap.add_argument("--aligner", choices=("auto", "words", "ctc"), default="auto",
                    help="歌词对齐用哪个：auto（歌词里有中日韩文字用 words，否则 ctc）、words（align_words.py，什么语言都行）、ctc（ctc_align.py，只对英文）")
    a = ap.parse_args()
    DATA.mkdir(exist_ok=True)
    only = {x for x in a.only.split(",") if x}
    want = lambda k: not only or k in only
    fails = []
    if a.bpm:
        cfg = DATA / "song_config.json"
        d = json.loads(cfg.read_text(encoding="utf-8")) if cfg.exists() else {}
        d["bpm_hint"] = a.bpm
        cfg.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    if not step_wav(a.song, a.force):
        sys.exit("没有歌，停在这里")
    step_lyrics_src(a.song)
    steps = [
        ("separate", "人声分离", AUDIO / "stems" / "vocals.wav", ("separate.py", "vocals")),
        ("separate", "四轨分离", AUDIO / "stems4" / "drums.wav", ("separate.py", "demucs")),
        ("analyze", "节拍和包络", DATA / "audio.json", ("analyze.py",)),
    ]
    if (DATA / "lyrics.src.lrc").exists():
        steps.append(("lyrics", "歌词对齐", DATA / "lyrics.json", (pick_aligner(a.aligner),)))
    steps.append(("events", "声音事件", DATA / "events.json", ("events.py",)))
    for key, name, out, cmd in steps:
        if not want(key):
            continue
        if out.exists() and not a.force:
            print(f"跳过 {name}（已有 {out.relative_to(ROOT).as_posix()}）")
            continue
        print(f"== {name}", flush=True)
        if not run(*cmd):
            fails.append(name)
    print("== 结果")
    summary()
    if fails:
        print("没成功的步骤：" + "、".join(fails) + "（其他步骤的结果可以照常用）")
    print("下一步先让人确认分析对不对：cd app && bun scripts/render.ts beatcheck 出分析确认片（拍子、小节、段落；要项目带 app），"
          "有歌词时 python <引擎>/tools/lyric_check.py 出歌词确认片；都对上了再往下做")


if __name__ == "__main__":
    main()

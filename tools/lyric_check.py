"""歌词对齐检查片：放歌，画面上按 data/lyrics.json 的逐词时间一个词一个词点亮，给人看对得准不准。在项目根目录运行：

  python <引擎>/tools/lyric_check.py [--lyrics data/lyrics.json] [--compare 另一份.json --label 新对齐 --compare-label 原来的]
                                     [--from 秒 --to 秒] [--out out/check/lyrics_check.mp4]

- 下方是 --lyrics，给了 --compare 时上方是它（两份对齐并排比）；左上角是秒数
- 每份的相邻两句上下交替、位置固定：两句时间重叠时各自待在自己那行，不互相挤
- 词点亮的过程是这个词的 [start, end]；一句在第一个词前 0.3 s 先出现（暗的），最后一个词结束后 0.3 s 消失
- 歌词只进视频，脚本只打印路径和时长：Agent 不看这个视频，给人看
- 1280×720、30 fps、快速编码，只用来检查，不是成片
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ffmpeg_path import FFMPEG, FFPROBE  # noqa: E402

ROOT = Path.cwd()


def ts(t):
    t = max(0.0, t)
    h, r = divmod(t, 3600)
    m, s = divmod(r, 60)
    return "%d:%02d:%05.2f" % (h, m, s)


def esc(s):
    return s.replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\n", " ")


def events(doc, style, t0, t1, rows):
    out = []
    for k, line in enumerate(doc.get("lines", [])):
        ws = [w for w in line.get("words", []) if w.get("end", 0) > t0 and w.get("start", 0) < t1]
        if not ws:
            continue
        a = ws[0]["start"] - 0.3
        b = ws[-1]["end"] + 0.3
        parts, cur = [], a
        for w in ws:
            gap = int(round(max(0.0, w["start"] - cur) * 100))
            if gap:
                parts.append("{\\k%d}" % gap)
            dur = max(1, int(round((w["end"] - max(w["start"], cur)) * 100)))
            sep = "" if not parts or _cjk(w["w"]) else " "
            parts.append("{\\kf%d}%s%s" % (dur, sep, esc(w["w"])))
            cur = max(cur, w["end"])
        pos = "{\\an2\\pos(640,%d)}" % rows[k % 2]
        out.append("Dialogue: 0,%s,%s,%s,,0,0,0,,%s%s" % (ts(a - t0), ts(b - t0), style, pos, "".join(parts)))
    return out


def _cjk(s):
    return any("぀" <= c <= "ヿ" or "㐀" <= c <= "鿿" or "가" <= c <= "힯" for c in s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lyrics", default="data/lyrics.json")
    ap.add_argument("--compare")
    ap.add_argument("--label", default="")
    ap.add_argument("--compare-label", default="")
    ap.add_argument("--audio", default="audio/song.wav")
    ap.add_argument("--from", dest="t0", type=float)
    ap.add_argument("--to", dest="t1", type=float)
    ap.add_argument("--out", default="out/check/lyrics_check.mp4")
    a = ap.parse_args()

    main_doc = json.loads((ROOT / a.lyrics).read_text(encoding="utf-8"))
    cmp_doc = json.loads((ROOT / a.compare).read_text(encoding="utf-8")) if a.compare else None
    dur = float(subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                                str(ROOT / a.audio)], capture_output=True, text=True).stdout.strip())
    words = [w for d in (main_doc, cmp_doc) if d for l in d.get("lines", []) for w in l.get("words", [])]
    t0 = a.t0 if a.t0 is not None else max(0.0, min((w["start"] for w in words), default=0) - 2)
    t1 = a.t1 if a.t1 is not None else min(dur, max((w["end"] for w in words), default=dur) + 2)

    out = (ROOT / a.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    ass = out.with_suffix(".ass")
    head = """[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,Microsoft YaHei,46,&H0000E5FF,&H00606060,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2,0,2,40,40,170,1
Style: Cmp,Microsoft YaHei,46,&H00FFD27A,&H00606060,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2,0,2,40,40,380,1
Style: Label,Microsoft YaHei,24,&H00A0A0A0,&H00A0A0A0,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,1,40,40,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    ev = events(main_doc, "Main", t0, t1, (560, 630))
    if a.label:
        ev.append("Dialogue: 1,%s,%s,Label,,0,0,0,,{\\an1\\pos(40,680)}%s" % (ts(0), ts(t1 - t0), esc(a.label)))
    if cmp_doc:
        ev += events(cmp_doc, "Cmp", t0, t1, (290, 360))
        if a.compare_label:
            ev.append("Dialogue: 1,%s,%s,Label,,0,0,0,,{\\an1\\pos(40,200)}%s" % (ts(0), ts(t1 - t0), esc(a.compare_label)))
    # 左上角的秒数（歌曲时间），每 0.1 s 一条
    k = 0
    while t0 + k * 0.1 < t1:
        s = t0 + k * 0.1
        ev.append("Dialogue: 2,%s,%s,Label,,0,0,0,,{\\an7\\pos(30,24)}%.1f s" % (ts(k * 0.1), ts((k + 1) * 0.1), s))
        k += 1
    ass.write_text(head + "\n".join(ev) + "\n", encoding="utf-8-sig")

    cmd = [FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x101114:s=1280x720:r=30:d=%.3f" % (t1 - t0),
           "-ss", "%.3f" % t0, "-t", "%.3f" % (t1 - t0), "-i", str(ROOT / a.audio),
           "-vf", "subtitles=%s" % ass.name, "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast",
           "-crf", "26", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-shortest", str(out)]
    r = subprocess.run(cmd, cwd=str(ass.parent))
    if r.returncode:
        sys.exit("ffmpeg 失败")
    print("写好了 %s（%.1f–%.1f s，%.0f 秒）" % (out, t0, t1, t1 - t0))


if __name__ == "__main__":
    main()

"""逐段版本：看过的每一版都留着、按歌的时间对齐，人逐段挑，认可的段落锁定，退回不丢东西。在项目根目录运行。

  python <引擎>/tools/film.py init --song audio/song.wav [--range 0,82] [--at 0,10,20 | --every 15]   # 分段（默认读 data/audio.json 的段落；范围默认 config.ts 的视频起止）
  python <引擎>/tools/film.py add out/draft/v2.mp4 [--id v2] [--offset 0] [--note 改了什么]            # 收一版：做代理，存代码快照，核对偏移，查有没有动到锁定的段
  python <引擎>/tools/film.py edit v2 --offset 1.5 | --note …                                         # 收错了：改偏移或备注
  python <引擎>/tools/film.py drop v2 [--force]                                                        # 收错了：拿掉这一版（挪进 film/trash/，锁定的不能拿）
  python <引擎>/tools/film.py target add 参考.mp4 [--from 10 --to 25] [--note 为什么挑它]              # 开工前的靶子：现成成片，让人说要不要
  python <引擎>/tools/film.py say s03 "我打算：……"                                                     # 把理解写给人确认（页面上有 对 / 不对）
  python <引擎>/tools/film.py page [--port 5190]                                                       # 挑选页：同一时钟切版本或几版并列看（V）、记瞬间、锁定；放终端里长期跑
      页面：顶部是进度和「下一个待定」（没选的段、AI 在等回答的段）；切版本只是看，选的是正在看的那版（Enter），锁定 L；音量默认 30%
  python <引擎>/tools/film.py status | plan                                                            # 看现状；把选择整理成拼合表 film/plan.md
  python <引擎>/tools/film.py assemble [--out film/连播.mp4] [--labels] [--res 1280x720]                                 # 按选择拼一条带声音的连播，查连着看的问题
  python <引擎>/tools/film.py restore v2                                                               # 把某一版的代码解到 film/restore/v2/，不碰现有文件
  python <引擎>/tools/film.py lock s03 v2 | unlock s03 | pick s03 v2 | recut --at … [--range 起,止]    # 人在对话里定了就这样记

--offset：这个视频第 0 秒对应歌的第几秒；片头有 4.5 秒警告卡时写 -4.5。不写就用 app/src/config.ts 的 VIDEO_START（和 check_video.py 一样）；
视频有声音时，拿声音在歌里找位置核对：对不上会说，没写 --offset 时直接按声音对齐。
锁定段的比对：抽 5 帧缩成 320×180 灰度，切 16×9 块，任一块平均差超过 10 就报。每次 add 都把各锁定段的差值打出来。
代码快照在 add 时拍：先收版本再改代码；比视频新的代码文件会被列出来。素材（assets/）只记清单，不进快照。
代理和代码快照放 film/（不进 git）。选择、锁定、备注都在 film/film.json，页面和命令行读写同一份。
没标的段落按「没认可」算：plan 会列出来，不要当成可以照搬。
"""
import argparse
import datetime as dt
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys
import threading
import urllib.parse
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ffmpeg_path import FFMPEG, FFPROBE  # noqa: E402
from project_config import video_range  # noqa: E402

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")  # Windows 默认 GBK，中文段名和备注不能乱码
    except AttributeError:
        pass

ROOT = Path.cwd()
FILM = ROOT / "film"
STATE = FILM / "film.json"
MEDIA = FILM / "media"
CODE = FILM / "code"
PAGE = Path(__file__).resolve().parent / "film_page.html"
LOCK = threading.Lock()
# 代码快照不收这些（素材和成片太大，也不是「这一版怎么做出来的」）
SNAP_SKIP_DIRS = {"film", "out", "assets", "audio", "refs", "node_modules", ".git", "__pycache__", "models", "work", ".venv", "public", "vendor", "third_party"}
SNAP_SKIP_EXT = {".mp4", ".mkv", ".mov", ".webm", ".wav", ".flac", ".mp3", ".png", ".jpg", ".jpeg", ".exr", ".glb", ".blend", ".pt", ".onnx", ".pyc"}
SNAP_MAX_BYTES = 5_000_000


def now():
    return dt.datetime.now().isoformat(timespec="seconds")


def load():
    if not STATE.exists():
        sys.exit("这个目录还没有 film/film.json：先跑 film.py init")
    return json.loads(STATE.read_text(encoding="utf-8"))


def save(s):
    FILM.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(s, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, STATE)


def rel(p):
    p = Path(p).resolve()
    try:
        return p.relative_to(ROOT.resolve()).as_posix()
    except ValueError:
        return str(p)


def probe(path):
    r = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate:format=duration", "-of", "json", str(path)],
                       capture_output=True, text=True, encoding="utf-8")
    if r.returncode:
        sys.exit(f"读不了 {path}：{r.stderr.strip()[:200]}")
    d = json.loads(r.stdout)
    out = {"dur": float(d["format"].get("duration", 0)), "w": 0, "h": 0, "fps": 60.0}
    for st in d.get("streams", []):
        if st.get("codec_type") == "video":
            n, m = st["r_frame_rate"].split("/")
            out.update(w=st["width"], h=st["height"], fps=float(n) / float(m or 1))
    return out


def mmss(t):
    return f"{int(t // 60)}:{t % 60:05.2f}"


def config_range():
    """app/src/config.ts 的 VIDEO_START、VIDEO_END（视频在歌里的起止）；没有 app 或没写返回 None。"""
    return video_range(ROOT)


def pcm(path, sr):
    import numpy as np
    r = subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"], capture_output=True)
    if r.returncode or len(r.stdout) < 4 * sr:
        return None
    return np.frombuffer(r.stdout, dtype=np.float32).astype(np.float64)


def sound_offset(video, song, declared, sr=8000):
    """拿视频自己的声音在歌里找位置：视频第 0 秒对应歌的第几秒。
    返回 (测到的偏移, 那里的相关, declared 处 ±20 ms 内的相关)；视频没声音或太短返回 None。
    相关是归一化互相关（-1–1），同一首歌的混音一般 0.8 以上；只叠了音效也还有 0.5 以上。"""
    import numpy as np
    v, s = pcm(video, sr), pcm(song, sr)
    if v is None or s is None:
        return None
    # 从视频里第一段有声音的地方取 15 秒（片头卡片常是静音）
    k = sr // 10
    env = np.convolve(np.abs(v), np.ones(k) / k, mode="same")
    loud = np.flatnonzero(env > 0.1 * env.max()) if env.max() > 1e-4 else []
    if not len(loud):
        return None
    i0 = int(loud[0])
    L = min(len(v) - i0, 15 * sr, len(s))
    if L < sr:
        return None
    c = v[i0:i0 + L] - v[i0:i0 + L].mean()
    n = 1 << int(np.ceil(np.log2(len(s) + L)))
    num = np.fft.irfft(np.fft.rfft(s, n) * np.conj(np.fft.rfft(c, n)), n)[:len(s) - L + 1]
    c1, c2 = np.concatenate([[0.0], np.cumsum(s)]), np.concatenate([[0.0], np.cumsum(s * s)])
    var = (c2[L:] - c2[:-L]) - (c1[L:] - c1[:-L]) ** 2 / L
    r = num / (np.sqrt(np.maximum(var, 1e-12)) * np.sqrt((c * c).sum()) + 1e-12)
    p = int(np.argmax(r))
    d = int(round((i0 / sr + declared) * sr))
    w = int(0.02 * sr)
    r_decl = float(r[max(d - w, 0):min(d + w + 1, len(r))].max()) if -w <= d < len(r) + w else None
    return round(p / sr - i0 / sr, 3), float(r[p]), r_decl


# ---------------------------------------------------------------- 分段
def seg_list(points, name=None):
    pts = sorted(set(round(x, 3) for x in points))
    return [{"id": f"s{i + 1:02d}", "name": (name[i] if name and i < len(name) else ""), "t0": a, "t1": b} for i, (a, b) in enumerate(zip(pts, pts[1:]))]


def cut_points(a, t0, t1):
    if a.at:
        inner = [float(x) for x in a.at.split(",") if x.strip()]
        return [t0] + [x for x in inner if t0 < x < t1] + [t1], None
    if a.every:
        n = max(1, int(round((t1 - t0) / a.every)))
        return [t0 + (t1 - t0) * i / n for i in range(n + 1)], None
    au = ROOT / "data" / "audio.json"
    if au.exists():
        secs = json.loads(au.read_text(encoding="utf-8")).get("sections") or []
        pts, names = [], []
        for s in secs:
            st, en = float(s.get("start", 0)), float(s.get("end", 0))
            if en <= t0 or st >= t1:
                continue
            pts.append(max(st, t0))
            names.append(s.get("name") or s.get("label") or "")
        if len(pts) > 1:
            return pts + [t1], names
        # 分析结果只有一整段：按小节切成 15 秒左右，切点落在强拍上；想换用 recut
        pts = [t0]
        for x in json.loads(au.read_text(encoding="utf-8")).get("downbeats") or []:
            x = float(x)
            if t0 < x < t1 and x - pts[-1] >= 15 and t1 - x >= 6:
                pts.append(x)
        if len(pts) > 1:
            print("歌没有分段信息，按小节切成十几秒一段。想换切点用 recut --at 或 --every")
            return pts + [t1], None
    print("没有段落信息，只分了一整段。要切开用 recut --at 或 --every")
    return [t0, t1], None


def film_range(given, dur):
    """片子用歌的哪段：--range > config.ts 的 VIDEO_START / VIDEO_END > 整首歌。"""
    if given:
        return tuple(float(x) for x in given.split(","))
    cs, ce = config_range()
    if cs is None and ce is None:
        return 0.0, dur
    t0, t1 = cs or 0.0, ce if ce is not None else dur
    print(f"范围按 app/src/config.ts：{mmss(t0)}–{mmss(t1)}（换用 --range 起,止）")
    return t0, t1


def cmd_init(a):
    if STATE.exists():
        sys.exit("film/film.json 已经有了：不覆盖。要重新分段用 recut")
    song = a.song or ("audio/song.wav" if (ROOT / "audio/song.wav").exists() else "")
    dur = probe(song)["dur"] if song else 0.0
    t0, t1 = film_range(a.range, dur)
    if t1 <= t0:
        sys.exit("不知道片子多长：给 --song 或 --range 起,止")
    pts, names = cut_points(a, t0, t1)
    save({"song": song, "range": [t0, t1], "segments": seg_list(pts, names), "versions": [], "targets": [], "picks": {}, "overall": "", "history": []})
    s = load()
    print(f"分了 {len(s['segments'])} 段：" + "  ".join(f"{x['id']} {mmss(x['t0'])}" for x in s["segments"]))


def cmd_recut(a):
    s = load()
    t0, t1 = (float(x) for x in a.range.split(",")) if a.range else s["range"]
    if t1 <= t0:
        sys.exit("--range 起,止：止要比起大")
    if a.range:
        s["range"] = [t0, t1]
        print(f"范围改成 {mmss(t0)}–{mmss(t1)}")
    pts, names = cut_points(a, t0, t1)
    # 换分段前把人的选择存进 history：段号的含义变了，不能把旧选择算到新段上
    if s["picks"]:
        s["history"].append({"at": now(), "segments": s["segments"], "picks": s["picks"]})
    s["segments"], s["picks"] = seg_list(pts, names), {}
    save(s)
    print(f"重新分成 {len(s['segments'])} 段。旧选择存在 film.json 的 history 里，需要时对照着重新定")


# ---------------------------------------------------------------- 收版本
def make_proxy(src, dst, a0=None, a1=None):
    """关键帧密（好拖）、响度拉平（切版本音量不跳）。只给页面和连播用，成片还是从原文件出。"""
    dst.parent.mkdir(parents=True, exist_ok=True)
    info = probe(src)
    scale = "scale=-2:720:flags=lanczos" if info["w"] >= info["h"] else "scale=720:-2:flags=lanczos"  # 竖版也不压扁
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y"]
    if a0 is not None:
        cmd += ["-ss", f"{a0:.3f}"]
    if a1 is not None:
        cmd += ["-to", f"{a1:.3f}"]
    cmd += ["-i", str(src), "-vf", scale, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-g", "12", "-pix_fmt", "yuv420p",
            "-af", "loudnorm=I=-16:TP=-1.5:LRA=14", "-ar", "48000", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(dst)]
    if subprocess.run(cmd).returncode:
        sys.exit(f"做代理失败：{src}")


def snapshot(zpath, made=None):
    """这一版的代码：之后要退回到它，从这里解出来。不依赖 git，也不需要提交。
    素材（assets/）太大不收，只把清单（路径、大小、修改时间）写进 _assets.tsv，退回时知道当时有哪些素材。
    made 是视频文件的修改时间：快照在 add 时拍，比视频新的代码文件会被列出来（快照里是改过的样子，不一定能重现这条视频）。"""
    zpath.parent.mkdir(parents=True, exist_ok=True)
    n, newer = 0, []
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for dp, dns, fns in os.walk(ROOT):
            dns[:] = [d for d in dns if d not in SNAP_SKIP_DIRS and not d.startswith(".venv")]
            for fn in fns:
                p = Path(dp) / fn
                if p.suffix.lower() in SNAP_SKIP_EXT:
                    continue
                try:
                    st = p.stat()
                    if st.st_size > SNAP_MAX_BYTES:
                        continue
                    z.write(p, p.relative_to(ROOT).as_posix())
                    n += 1
                    if made is not None and st.st_mtime > made + 2:
                        newer.append(p.relative_to(ROOT).as_posix())
                except OSError:
                    pass
        assets = ROOT / "assets"
        if assets.is_dir():
            rows = []
            for p in sorted(assets.rglob("*")):
                if p.is_file():
                    st = p.stat()
                    rows.append(f"{p.relative_to(ROOT).as_posix()}\t{st.st_size}\t{dt.datetime.fromtimestamp(st.st_mtime).isoformat(timespec='seconds')}")
            z.writestr("_assets.tsv", "路径\t字节\t修改时间\n" + "\n".join(rows) + "\n")
    return n, newer


GW, GH, BX, BY = 320, 180, 16, 9  # 比对用的灰度帧尺寸，切成 16×9 块（每块 20×20）
GUARD_BLOCK = 10.0  # 任一块的平均差超过它（0–255）就算动到了。整帧平均会被留白冲淡：主体挪了位置、整帧平均差只有 1–3


def gray_frame(path, t):
    import numpy as np
    r = subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-ss", f"{max(t, 0):.3f}", "-i", str(path), "-frames:v", "1", "-vf", f"scale={GW}:{GH},format=gray", "-f", "rawvideo", "-"], capture_output=True)
    if len(r.stdout) < GW * GH:
        return None
    return np.frombuffer(r.stdout[:GW * GH], dtype=np.uint8).astype(float).reshape(GH, GW)


def frame_diff(fa, fb):
    """两帧差在哪：(差最大的一块的平均差 0–255, 超过 GUARD_BLOCK 的块占全画面的比例)。"""
    d = abs(fa - fb).reshape(BY, GH // BY, BX, GW // BX).mean(axis=(1, 3))
    return float(d.max()), float((d > GUARD_BLOCK).mean())


def guard(s, v):
    """新版本有没有动到人认可的段落：每个锁定段抽 5 帧，分块和认可的那一版比。每个锁定段都返回一条，没动到的也返回。"""
    out = []
    by = {x["id"]: x for x in s["versions"]}
    for seg in s["segments"]:
        p = s["picks"].get(seg["id"]) or {}
        if not p.get("locked") or p.get("pick") not in by or p["pick"] == v["id"]:
            continue
        o = by[p["pick"]]
        row = {"seg": seg["id"], "locked": o["id"], "block": None, "share": 0.0, "hit": False, "why": ""}
        out.append(row)
        if v["t1"] <= seg["t0"] or v["t0"] >= seg["t1"]:
            row["why"] = "这一版没覆盖这段"
            continue
        if not (v["t0"] <= seg["t0"] and seg["t1"] <= v["t1"]):
            row["why"] = "只覆盖了一部分，没比；要比就收一版覆盖整段的"
            continue
        worst, share = [], []
        for i in range(5):
            t = seg["t0"] + (seg["t1"] - seg["t0"]) * (i + 0.5) / 5
            fa, fb = gray_frame(ROOT / v["file"], t - v["offset"]), gray_frame(ROOT / o["file"], t - o["offset"])
            if fa is not None and fb is not None:
                b, sh = frame_diff(fa, fb)
                worst.append(b)
                share.append(sh)
        if not worst:
            row["why"] = "读不出帧，没比"
            continue
        row.update(block=round(max(worst), 1), share=max(share), hit=max(worst) > GUARD_BLOCK)
    return out


def print_guard(rows):
    if not rows:
        return
    print(f"锁定段比对（抽 5 帧，16×9 块里差最大的一块，0–255；超过 {GUARD_BLOCK:g} 算动到）：")
    for r in rows:
        if r["block"] is None:
            print(f"  {r['seg']}（锁定 {r['locked']}）：{r['why']}")
        elif r["hit"]:
            print(f"  {r['seg']}（锁定 {r['locked']}）：最大块差 {r['block']}，变了约 {r['share']:.0%} 的画面  ← 动到了")
        else:
            print(f"  {r['seg']}（锁定 {r['locked']}）：最大块差 {r['block']}，没变")
    if any(r["hit"] for r in rows):
        print("除非对方要求，否则动到的段落继续用锁定的那一版；不要把它们当成新版的改进交上去")


def new_id(s, src):
    """文件名本身是 v12、v3b 这样的就用它；否则接着最大的 v 号往下编（删掉的版本号不再用）。"""
    stem = Path(src).stem
    if re.fullmatch(r"v\d+[\w.-]*", stem):
        if all(x["id"] != stem for x in s["versions"]):
            return stem
        print(f"{stem} 已经有了，这一版另编号")
    nums = [int(m[1]) for x in s["versions"] + s.get("dropped", []) if (m := re.fullmatch(r"v(\d+)", x["id"]))]
    return f"v{max(nums, default=0) + 1}"


def pick_offset(s, src, given):
    """视频第 0 秒对应歌的第几秒：--offset > config.ts 的 VIDEO_START > 0；有声音就拿声音核对一遍。"""
    cs, _ = config_range()
    off, how = (given, "--offset") if given is not None else ((cs, "app/src/config.ts 的 VIDEO_START") if cs is not None else (0.0, "默认 0"))
    song = ROOT / s["song"] if s.get("song") else None
    if not (song and song.exists()):
        print(f"偏移 {off:g} 秒（{how}）。film.json 里没有歌（init --song），没法拿声音核对")
        return off
    m = sound_offset(src, song, off)
    if m is None:
        print(f"偏移 {off:g} 秒（{how}）。这一版没有声音，没法核对；不对用 film.py edit 版本 --offset 改")
        return off
    best, r_best, r_decl = m
    # 歌有重复的小节、循环段落时，错开整小节也能有 0.7 的相关；所以要和最吻合的位置比，不能只看够不够高
    if abs(best - off) <= 0.034 or (r_decl is not None and r_decl >= 0.5 and r_decl >= r_best - 0.05):
        print(f"偏移 {off:g} 秒（{how}），和声音对上了（相关 {r_decl if r_decl is not None else r_best:.2f}）")
        return off
    if r_best < 0.5:
        print(f"偏移 {off:g} 秒（{how}）。声音和歌对不上（最好处相关 {r_best:.2f}，可能只有音效或不是这首歌），没法核对")
        return off
    if given is None:
        print(f"偏移：{how} 是 {off:g} 秒，但声音对不上；按声音对齐，视频第 0 秒是歌的 {best:g} 秒（相关 {r_best:.2f}）。不对用 film.py edit 版本 --offset 改")
        return best
    print(f"注意：--offset {off:g} 和视频的声音对不上（那里相关 {r_decl if r_decl is not None else 0:.2f}，歌有重复段落时错位也会有点相关）。"
          f"声音像是从歌的 {best:g} 秒开始（相关 {r_best:.2f}）。确认后用 film.py edit 版本 --offset {best:g} 改")
    return off


def cmd_add(a):
    s = load()
    src = Path(a.video)
    if not src.exists():
        sys.exit(f"没有这个文件：{src}")
    vid = a.id or new_id(s, src)
    if any(x["id"] == vid for x in s["versions"]):
        sys.exit(f"{vid} 已经有了：版本不覆盖，换个 --id")
    if not re.fullmatch(r"[\w.-]+", vid):
        sys.exit("版本号只用字母、数字、点、横线、下划线")
    info = probe(src)
    off = pick_offset(s, src, a.offset)
    f = MEDIA / f"{vid}.mp4"
    if a.no_proxy:
        shutil.copy2(src, f) if MEDIA.mkdir(parents=True, exist_ok=True) is None else None
    else:
        print(f"做代理 {vid}（{info['dur']:.1f} 秒）……", flush=True)
        make_proxy(src, f)
    n, newer = snapshot(CODE / f"{vid}.zip", src.stat().st_mtime)
    v = {"id": vid, "file": rel(f), "source": rel(src), "offset": off, "t0": round(off, 3), "t1": round(off + info["dur"], 3), "note": a.note or "", "added": now(), "code": rel(CODE / f"{vid}.zip")}
    rows = guard(s, v)
    r0, r1 = s["range"]
    if v["t1"] <= r0 or v["t0"] >= r1:
        print(f"注意：这一版覆盖歌曲 {mmss(max(v['t0'], 0))}–{mmss(v['t1'])}，和片子的范围 {mmss(r0)}–{mmss(r1)} 没有重叠。检查偏移：视频第 0 秒对应歌的第几秒")
    s["versions"].append(v)
    save(s)
    print(f"收好 {vid}：覆盖歌曲 {mmss(max(v['t0'], 0))}–{mmss(v['t1'])}；代码快照 {n} 个文件")
    if newer:
        print(f"注意：{len(newer)} 个代码文件比视频新（视频渲完后又改过），快照里是改过的样子，restore 出来不一定能重现这条视频："
              + "、".join(newer[:5]) + ("……" if len(newer) > 5 else ""))
    print_guard(rows)


def cmd_edit(a):
    s = load()
    v = next((x for x in s["versions"] if x["id"] == a.ver), None)
    if not v:
        sys.exit(f"没有这版：{a.ver}")
    if a.offset is None and a.note is None:
        sys.exit("要改什么：--offset 秒 或 --note 文字")
    if a.offset is not None:
        dur = v["t1"] - v["t0"]
        v["offset"], v["t0"], v["t1"] = a.offset, round(a.offset, 3), round(a.offset + dur, 3)
        print(f"{a.ver} 的偏移改成 {a.offset:g}：覆盖歌曲 {mmss(max(v['t0'], 0))}–{mmss(v['t1'])}")
        locked = [sid for sid, p in s["picks"].items() if p.get("pick") == a.ver and p.get("locked")]
        if locked:
            print(f"注意：{' '.join(locked)} 锁定在这一版，偏移一改，认可过的画面在时间上挪了，跟对方说一声")
    if a.note is not None:
        v["note"] = a.note
    save(s)


def cmd_drop(a):
    """收错的版本拿掉：文件挪进 film/trash/，记录留在 film.json 的 dropped 里，不真删。"""
    s = load()
    v = next((x for x in s["versions"] if x["id"] == a.ver), None)
    if not v:
        sys.exit(f"没有这版：{a.ver}")
    used = [sid for sid, p in s["picks"].items() if p.get("pick") == a.ver]
    locked = [sid for sid in used if s["picks"][sid].get("locked")]
    if locked:
        sys.exit(f"{' '.join(locked)} 锁定在 {a.ver}（认可过），不能拿掉。真要拿，先问对方，再 unlock")
    if used and not a.force:
        sys.exit(f"{' '.join(used)} 选的是 {a.ver}：加 --force 会清掉这些选择")
    for sid in used:
        s["picks"][sid].pop("pick", None)
    trash = FILM / "trash" / f"{a.ver}-{dt.datetime.now():%Y%m%d-%H%M%S}"
    trash.mkdir(parents=True, exist_ok=True)
    for k in ("file", "code"):
        p = ROOT / v[k] if v.get(k) else None
        if p and p.exists():
            shutil.move(str(p), str(trash / p.name))
    s["versions"].remove(v)
    s.setdefault("dropped", []).append({**v, "dropped": now(), "trash": rel(trash)})
    save(s)
    print(f"拿掉 {a.ver}：代理和代码快照挪到 {rel(trash)}" + (f"；清掉了 {' '.join(used)} 的选择" if used else ""))


def cmd_target(a):
    s = load()
    src = Path(a.clip)
    if not src.exists():
        sys.exit(f"没有这个文件：{src}")
    k = len(s["targets"]) + 1
    f = MEDIA / f"target{k:02d}.mp4"
    make_proxy(src, f, a.start, a.to)
    s["targets"].append({"id": f"t{k:02d}", "file": rel(f), "source": rel(src), "from": a.start, "to": a.to, "note": a.note or "", "verdict": "", "user_note": ""})
    save(s)
    print(f"靶子 t{k:02d} 收好了。用 film.py page 带声音给人看")


# ---------------------------------------------------------------- 状态
def seg_pick(s, sid):
    return s["picks"].setdefault(sid, {})


def latest_cover(s, seg):
    for v in reversed(s["versions"]):
        if v["t0"] <= seg["t0"] + 0.01 and seg["t1"] - 0.01 <= v["t1"]:
            return v
    return None


def cmd_pick(a):
    s = load()
    if a.seg not in {x["id"] for x in s["segments"]}:
        sys.exit(f"没有这段：{a.seg}")
    if a.ver != "none" and a.ver not in {x["id"] for x in s["versions"]}:
        sys.exit(f"没有这版：{a.ver}（都不要写 none）")
    seg_pick(s, a.seg)["pick"] = a.ver
    save(s)
    print(f"{a.seg} → {a.ver}")


def cmd_lock(a):
    s = load()
    if a.seg not in {x["id"] for x in s["segments"]}:
        sys.exit(f"没有这段：{a.seg}")
    if a.ver and a.ver not in {x["id"] for x in s["versions"]}:
        sys.exit(f"没有这版：{a.ver}")
    p = seg_pick(s, a.seg)
    if a.ver:
        p["pick"] = a.ver
    if not p.get("pick") or p["pick"] == "none":
        sys.exit("这段还没选版本：lock 段号 版本号")
    p["locked"] = True
    save(s)
    print(f"{a.seg} 锁定在 {p['pick']}")


def cmd_unlock(a):
    s = load()
    seg_pick(s, a.seg)["locked"] = False
    save(s)
    print(f"{a.seg} 解锁")


def cmd_say(a):
    s = load()
    if a.seg not in {x["id"] for x in s["segments"]}:
        sys.exit(f"没有这段：{a.seg}")
    p = seg_pick(s, a.seg)
    p["plan"], p["plan_ok"], p["plan_fix"] = a.text, "", ""
    save(s)
    print("写好了，等人在页面上说对不对")


def cmd_status(a):
    s = load()
    print(f"{len(s['segments'])} 段，{len(s['versions'])} 版：" + " ".join(v["id"] for v in s["versions"]))
    if s["targets"]:
        print("靶子：" + "  ".join(f"{t['id']}={t['verdict'] or '没说'}" for t in s["targets"]))
    for seg in s["segments"]:
        p = s["picks"].get(seg["id"]) or {}
        flag = "锁定" if p.get("locked") else ("已选" if p.get("pick") else "没标")
        extra = f" 备注:{len(p.get('note', ''))}字" if p.get("note") else ""
        extra += f" 瞬间:{len(p.get('marks', []))}" if p.get("marks") else ""
        if p.get("plan"):
            extra += f" 理解:{p.get('plan_ok') or '待确认'}"
        print(f"  {seg['id']} {mmss(seg['t0'])}–{mmss(seg['t1'])} {seg.get('name', ''):10s} {flag} {p.get('pick', '-')}{extra}")


def cmd_plan(a):
    s = load()
    L = ["# 拼合表（film.py plan 生成）", "", "建议先给人过一眼再动手。没标的段落没被认可，不要写成照搬。", ""]
    if s.get("overall"):
        L += ["## 整体意见", "", s["overall"], ""]
    good = [t for t in s["targets"] if t.get("verdict") == "yes"]
    bad = [t for t in s["targets"] if t.get("verdict") == "no"]
    if good or bad:
        L += ["## 靶子", ""] + [f"- 要：{t['id']} {t['source']}（{t.get('user_note') or t.get('note') or ''}）" for t in good] + [f"- 不要：{t['id']} {t['source']}（{t.get('user_note') or ''}）" for t in bad] + [""]
    L += ["| 段 | 时间 | 用哪版 | 状态 | 原话和标记 |", "|---|---|---|---|---|"]
    todo, wait = [], []
    for seg in s["segments"]:
        p = s["picks"].get(seg["id"]) or {}
        state = "锁定，不动" if p.get("locked") else ("已选" if p.get("pick") else "没标，要重做或再问")
        if p.get("pick") == "none":
            state = "都不要，重做"
        said = []
        if p.get("plan"):
            ok = p.get("plan_ok")
            said = [f"我打算（说对）：{p['plan']}"] if ok == "yes" else ([f"我打算（说不对）：{p['plan']}；改成：{p.get('plan_fix', '')}"] if ok == "no" else [f"我打算（等确认）：{p['plan']}"])
            if ok not in ("yes", "no"):
                wait.append(seg["id"])
        words = "；".join(filter(None, [p.get("note", "")] + [f"{m['v']}@{m['t']:.2f}：{m.get('text', '')}" for m in p.get("marks", [])] + said))
        L.append(f"| {seg['id']} {seg.get('name', '')} | {mmss(seg['t0'])}–{mmss(seg['t1'])} | {p.get('pick', '-')} | {state} | {words.replace('|', '/')} |")
        if not p.get("locked") and (not p.get("pick") or p.get("pick") == "none"):
            todo.append(seg["id"])
    L += ["", f"要重做或再问：{' '.join(todo) if todo else '没有'}", f"「我打算」还没等到确认：{' '.join(wait) if wait else '没有'}", ""]
    out = FILM / "plan.md"
    out.write_text("\n".join(L), encoding="utf-8")
    print(f"写好 {rel(out)}。要重做或再问：{' '.join(todo) if todo else '没有'}；「我打算」等确认：{' '.join(wait) if wait else '没有'}")


def cmd_restore(a):
    s = load()
    v = next((x for x in s["versions"] if x["id"] == a.ver), None)
    if not v or not v.get("code"):
        sys.exit(f"没有 {a.ver} 的代码快照")
    dst = FILM / "restore" / a.ver
    if dst.exists():
        sys.exit(f"{rel(dst)} 已经有了，不覆盖")
    with zipfile.ZipFile(ROOT / v["code"]) as z:
        z.extractall(dst)
    print(f"{a.ver} 的代码解到 {rel(dst)}。现有文件没动，要什么自己拿")


# ---------------------------------------------------------------- 连播
def cmd_assemble(a):
    s = load()
    if not s["versions"]:
        sys.exit("还没有版本：先 film.py add")
    by = {x["id"]: x for x in s["versions"]}
    last = probe(ROOT / s["versions"][-1]["file"])
    fps = last["fps"]
    w, h = (int(x) for x in a.res.split("x")) if a.res else (last["w"], last["h"])
    inputs, parts, rows = [], [], []
    idx = {}
    for i, seg in enumerate(s["segments"]):
        p = s["picks"].get(seg["id"]) or {}
        v = by.get(p.get("pick")) if p.get("pick") not in (None, "none") else None
        how = p.get("pick") or ""
        if v is None and p.get("pick") != "none":
            v = latest_cover(s, seg)
            how = f"{v['id']}（没标，用最新）" if v else "没有版本"
        n_frames = round(seg["t1"] * fps) - round(seg["t0"] * fps)
        if v is None:
            parts.append(f"color=c=black:s={w}x{h}:r={fps}:d={n_frames / fps:.4f},format=yuv420p,setsar=1[v{i}]")
        else:
            if v["id"] not in idx:
                idx[v["id"]] = len(inputs) // 2
                inputs += ["-i", str(ROOT / v["file"])]
            f0 = round((seg["t0"] - v["offset"]) * fps)
            parts.append(f"[{idx[v['id']]}:v]fps={fps},trim=start_frame={f0}:end_frame={f0 + n_frames},setpts=N/({fps}*TB),scale={w}:{h}:flags=lanczos,format=yuv420p,setsar=1[v{i}]")
        rows.append((seg["id"], how))
    label = ""
    if a.labels:
        cache = FILM / ".cache"
        cache.mkdir(parents=True, exist_ok=True)
        font = cache / "label.ttf"
        if not font.exists():
            shutil.copy(Path(__file__).resolve().parents[1] / "app/public/fonts/Archivo-w620-700.ttf", font)
        chain, t = [], 0.0
        for i, seg in enumerate(s["segments"]):
            dur = (round(seg["t1"] * fps) - round(seg["t0"] * fps)) / fps
            tag = re.sub(r"[^\w.-]", "", f"{seg['id']}-{rows[i][1].split('（')[0]}") or seg["id"]
            chain.append(f"drawtext=fontfile=film/.cache/label.ttf:text={tag}:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8:x=20:y=20:enable='between(t,{t:.3f},{t + dur:.3f})'")
            t += dur
        label = "," + ",".join(chain)
    concat = "".join(f"[v{i}]" for i in range(len(s["segments"]))) + f"concat=n={len(s['segments'])}:v=1:a=0{label}[out]"
    graph = ";".join(parts + [concat])
    t0, t1 = s["segments"][0]["t0"], s["segments"][-1]["t1"]
    n_total = round(t1 * fps) - round(t0 * fps)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y"] + inputs
    audio = []
    if s.get("song") and (ROOT / s["song"]).exists():
        cmd += ["-ss", f"{t0:.3f}", "-t", f"{n_total / fps:.4f}", "-i", str(ROOT / s["song"])]
        audio = ["-map", f"{len(inputs) // 2}:a", "-af", "aresample=48000", "-c:a", "aac", "-b:a", "192k"]
    gf = FILM / ".cache" / "assemble.txt"
    gf.parent.mkdir(parents=True, exist_ok=True)
    gf.write_text(graph, encoding="utf-8")
    rest = [str(gf), "-map", "[out]"] + audio + ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-movflags", "+faststart", str(out)]
    # 新版 ffmpeg 写法是 -/filter_complex 文件，旧版是 -filter_complex_script 文件
    if subprocess.run(cmd + ["-/filter_complex"] + rest, cwd=ROOT).returncode and subprocess.run(cmd + ["-filter_complex_script"] + rest, cwd=ROOT).returncode:
        sys.exit("拼接失败")
    got = probe(out)
    print(f"写好 {rel(out)}：{got['dur']:.3f} 秒（应为 {n_total / fps:.3f}）")
    for sid, how in rows:
        print(f"  {sid} ← {how or '都不要（黑场）'}")
    empty = [sid for sid, how in rows if how == "没有版本"]
    if empty:
        print(f"注意：{' '.join(empty)} 没有版本覆盖，是黑场。如果那里应该有画面，检查 add 时的 --offset")
    if not audio:
        print("注意：没有歌（init 时给 --song），这条连播没有声音")


# ---------------------------------------------------------------- 挑选页
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/":
            return self._send(200, PAGE.read_bytes(), "text/html; charset=utf-8")
        if u.path == "/api/state":
            return self._send(200, STATE.read_bytes())
        if u.path == "/m":
            return self._media(urllib.parse.parse_qs(u.query).get("f", [""])[0])
        self._send(404, b"{}")

    def _media(self, f):
        p = (ROOT / f).resolve()
        if not str(p).startswith(str(MEDIA.resolve())) or not p.is_file():
            return self._send(404, b"{}")
        size = p.stat().st_size
        m = re.match(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
        a, b = 0, size - 1
        if m:
            if m[1]:
                a = int(m[1])
                b = int(m[2]) if m[2] else b
            elif m[2]:
                a = max(0, size - int(m[2]))
        b = min(b, size - 1)
        self.send_response(206 if m else 200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(b - a + 1))
        if m:
            self.send_header("Content-Range", f"bytes {a}-{b}/{size}")
        self.end_headers()
        try:
            with open(p, "rb") as fh:
                fh.seek(a)
                left = b - a + 1
                while left > 0:
                    chunk = fh.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (BrokenPipeError, ConnectionError, ConnectionAbortedError):
            pass

    def do_POST(self):
        if self.path != "/api/save":
            return self._send(404, b"{}")
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        # 只收人能在页面上改的字段，按段合并：同一页开两份也只会盖掉同一段的同一项
        with LOCK:
            s = load()
            if "overall" in body:
                s["overall"] = body["overall"]
            for sid, patch in (body.get("picks") or {}).items():
                p = s["picks"].setdefault(sid, {})
                for k in ("pick", "locked", "note", "marks", "plan_ok", "plan_fix"):
                    if k in patch:
                        p[k] = patch[k]
            for tid, patch in (body.get("targets") or {}).items():
                for t in s["targets"]:
                    if t["id"] == tid:
                        for k in ("verdict", "user_note"):
                            if k in patch:
                                t[k] = patch[k]
            save(s)
        self._send(200, json.dumps({"ok": True, "saved": now()}).encode())


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def cmd_page(a):
    load()
    print(f"挑选页：http://127.0.0.1:{a.port}　选择存 film/film.json。放终端里跑，关掉就断（页面会自动重试保存）")
    Server(("127.0.0.1", a.port), Handler).serve_forever()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    for name, fn in (("init", cmd_init), ("recut", cmd_recut)):
        q = sp.add_parser(name)
        q.set_defaults(fn=fn)
        q.add_argument("--at", default="", help="切点（歌曲秒，逗号分隔）")
        q.add_argument("--every", type=float, default=0, help="每多少秒一段")
        q.add_argument("--range", default="", help="片子用歌的哪段：起,止（init 默认读 app/src/config.ts 的 VIDEO_START / VIDEO_END，没有就整首歌）")
        if name == "init":
            q.add_argument("--song", default="")
    q = sp.add_parser("add")
    q.set_defaults(fn=cmd_add)
    q.add_argument("video")
    q.add_argument("--id", default="", help="默认用文件名（v12.mp4 → v12），文件名不是 v 加数字就接着编")
    q.add_argument("--offset", type=float, default=None, help="视频第 0 秒对应歌的第几秒（片头有卡片时为负）；默认 config.ts 的 VIDEO_START，有声音时自动核对")
    q.add_argument("--note", default="")
    q.add_argument("--no-proxy", action="store_true", help="不转码，直接复制（文件已经是 720p、关键帧够密时）")
    q = sp.add_parser("edit")
    q.set_defaults(fn=cmd_edit)
    q.add_argument("ver")
    q.add_argument("--offset", type=float, default=None)
    q.add_argument("--note", default=None)
    q = sp.add_parser("drop")
    q.set_defaults(fn=cmd_drop)
    q.add_argument("ver")
    q.add_argument("--force", action="store_true", help="有段落选了这一版时，清掉这些选择再拿掉（锁定的不行）")
    q = sp.add_parser("target")
    q.set_defaults(fn=cmd_target)
    q.add_argument("action", choices=["add"])
    q.add_argument("clip")
    q.add_argument("--from", dest="start", type=float, default=None)
    q.add_argument("--to", type=float, default=None)
    q.add_argument("--note", default="")
    q = sp.add_parser("pick")
    q.set_defaults(fn=cmd_pick)
    q.add_argument("seg")
    q.add_argument("ver")
    q = sp.add_parser("lock")
    q.set_defaults(fn=cmd_lock)
    q.add_argument("seg")
    q.add_argument("ver", nargs="?")
    q = sp.add_parser("unlock")
    q.set_defaults(fn=cmd_unlock)
    q.add_argument("seg")
    q = sp.add_parser("say")
    q.set_defaults(fn=cmd_say)
    q.add_argument("seg")
    q.add_argument("text")
    sp.add_parser("status").set_defaults(fn=cmd_status)
    sp.add_parser("plan").set_defaults(fn=cmd_plan)
    q = sp.add_parser("restore")
    q.set_defaults(fn=cmd_restore)
    q.add_argument("ver")
    q = sp.add_parser("assemble")
    q.set_defaults(fn=cmd_assemble)
    q.add_argument("--out", default="film/连播.mp4")
    q.add_argument("--res", default="", help="默认和版本的代理一样：横版 720p，竖版 720 宽")
    q.add_argument("--labels", action="store_true", help="左上角标段号和版本")
    q = sp.add_parser("page")
    q.set_defaults(fn=cmd_page)
    q.add_argument("--port", type=int, default=5190)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()

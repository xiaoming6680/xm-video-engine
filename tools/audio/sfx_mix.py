"""给成片或歌叠一层音效：合成音效（mgaudio.sfx）或现成的 wav，按画面时刻对齐，音乐轻微闪避，母带到 −14 LUFS。

  python tools/audio/sfx_mix.py <输入.mp4 | 输入.wav> -o <输出.mp4 | 输出.wav>
      --at 名字@秒[@增益dB] …    时间是成片秒（片头从 0 算）。名字 = 合成音效（pop、hit、whoosh(0.8, kind='sci')……，
                                 --list 列全）或音效文件（a.wav@1.2，跟 world.excute(me) 的 mix_sfx.py 一样）
      --cues out/qa/cues.json    render.ts cues 导出的卡点（歌曲秒），配 --start 换成成片秒；
        --map 正则=音效 …        按 cue 名字配音效（先写的先配，如 --map "lands=pop" --map "slam=hit"）
        --cue-sfx 音效           没配上的 cue 都用这个（不给就跳过，并列出来）
        --start 秒               成片 0 秒对应的歌曲秒（render.ts video --from 的值）；视频默认取 config.ts 的 VIDEO_START
      [--fps 60] [--lead-frames 1]   起音比画面早几帧（默认 1 帧：瞬态落在画面那一帧上）；视频不给 --fps 就用它的帧率
      [--duck 3]           每个音效的同步点附近把音乐压低几 dB（0 = 不压）
      [--sfx-gain 0]       所有音效整体加减（dB）；单个音效用 @增益
      [--bed -20]          音乐先归到这个响度再叠合成音效（mgaudio 的约定：增益 0 时音效比音乐床高约 2 dB）
      [--lufs -14 | off] [--tp -1]   母带目标；off = 不做响度归一，只乘 --gain（和旧 mix_sfx.py 一样，纯音量）
      [--gain 0]           叠完后整体增益（只在 --lufs off 时起作用）
      [--stems 目录] [--png 频谱.png] [--report 清单.json] [--seed 0] [--list]

同步点（mgaudio 的约定）：一次性的声音（hit、pop、click……）对瞬态，whoosh 对掠过的最响处，riser / reverse_cymbal /
charge / swell / lock_on 对末尾（那一下），transition / text_hit 对那一下。所以只管写画面上那一下的时刻。
文件音效按原音量相对原曲（音乐归一时跟着一起缩放），从文件开头算。
输出视频时视频流原样复制（BT.709 标签不丢），音轨 AAC 320k；编码后量真峰值，超了就压低重来。
旧 mix_sfx.py 的行为：--lufs off --duck 0 --lead-frames 0。
"""
import argparse
import json
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _env  # noqa: E402

if __name__ == "__main__":
    _env.ensure()

import numpy as np  # noqa: E402

import mgaudio as mg  # noqa: E402
from mgaudio import core, master as M  # noqa: E402
import _audio as A  # noqa: E402


def build_mix(music, items, dur, fps=60.0, lead_frames=1.0, duck=3.0, bed=-20.0, sfx_gain=0.0, normalize=True):
    """music：(2, n) 或 None。返回 (母带前的混音 (2, N), 放置清单, {'music': 音乐干声, 'sfx': 音效干声})。"""
    N = core.ns(dur)
    lead = lead_frames / fps
    L = M.lufs(music) if music is not None else -120.0
    have = L > -70
    gm = (bed - L) if (normalize and have) else 0.0          # 音乐（和文件音效）的增益
    syn = 0.0 if normalize or not have else (L - bed)          # 不归一时，合成音效跟着原曲的响度走
    m = mg.Mix(duration=dur)
    if music is not None:
        m.track("music", group="music").add(core.Sound(core.fit(music, N)), 0.0, gain=gm)
    if duck > 0:
        m.group("music").duck(by="sfx", mode="trigger", depth=duck, attack=0.006, hold=0.05, release=0.25)
    rows = []
    for it in items:
        s = A.make_sound(it)
        at = it.t - lead
        start = at - s.sync
        row = {"label": it.label, "t": round(it.t, 4), "sync_at": round(at, 4), "sync": round(s.sync, 4),
               "start": round(start, 4), "end": round(start + s.dur, 4), "gain": round(it.gain + sfx_gain, 2)}
        row.update(it.meta)
        if at < 0 or at >= dur:
            row["skipped"] = "时刻不在片子里"
        else:
            if start < 0:
                row["note"] = f"开头 {-start:.3f}s 被片头截掉"
            m.sfx(s, at, gain=it.gain + sfx_gain + (gm if it.is_file else syn), pan=it.pan)
        rows.append(row)
    pre = m.render()
    return pre, rows, {"music": m.stems.get("group.music"), "sfx": m.stems.get("group.sfx")}, {
        "music_lufs": round(L, 2), "music_gain": round(gm, 2)}


def config_video_start(root: Path) -> float | None:
    cfg = root / "app/src/config.ts"
    if cfg.exists():
        mm = re.search(r"VIDEO_START\s*=\s*([\d.]+)", cfg.read_text(encoding="utf-8"))
        if mm:
            return float(mm.group(1))
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", nargs="?")
    ap.add_argument("-o", "--out")
    ap.add_argument("--at", action="append", default=[], help="名字或文件@成片秒[@增益dB]")
    ap.add_argument("--cues", help="cues.json（歌曲秒）")
    ap.add_argument("--map", action="append", default=[], help="正则=音效：按 cue 名字配")
    ap.add_argument("--cue-sfx", help="没配上的 cue 用的音效")
    ap.add_argument("--start", type=float, help="成片 0 秒对应的歌曲秒")
    ap.add_argument("--fps", type=float)
    ap.add_argument("--lead-frames", type=float, default=1.0)
    ap.add_argument("--duck", type=float, default=3.0)
    ap.add_argument("--sfx-gain", type=float, default=0.0)
    ap.add_argument("--bed", type=float, default=-20.0)
    ap.add_argument("--lufs", default="-14", help="目标积分响度，或 off")
    ap.add_argument("--tp", type=float, default=-1.0)
    ap.add_argument("--gain", type=float, default=0.0)
    ap.add_argument("--stems")
    ap.add_argument("--png")
    ap.add_argument("--report")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--list", action="store_true", help="列出能用的合成音效")
    a = ap.parse_args()
    if a.list:
        print("合成音效（mgaudio.sfx，参数见 tools/audio/README.md 和 mgaudio/sfx.py）：")
        print(" ".join(A.sfx_names()))
        return
    if not a.input or not a.out:
        ap.error("要给 输入 和 -o 输出")
    src, out = Path(a.input), Path(a.out)
    normalize = a.lufs.lower() != "off"
    if normalize and a.gain:
        print("提示：--gain 只在 --lufs off 时起作用（默认会归一到目标响度）")
    core.reset_rng(a.seed)

    info = A.probe(src)
    is_video = info["video"] and src.suffix.lower() not in A.AUDIO_EXT
    if out.suffix.lower() in A.VIDEO_EXT and not is_video:
        sys.exit(f"输入 {src.name} 没有画面，输出不了视频；输出写成 .wav / .m4a")
    music = A.read_audio(src)
    if music is None:
        print("输入没有音轨：只有音效" + ("，响度按音效算" if normalize else ""))
    dur = info["duration"] if is_video else (music.shape[1] / A.SR if music is not None else info["duration"])
    fps = a.fps or (info["fps"] if is_video and info["fps"] else 60.0)

    items = [A.parse_at(s) for s in a.at]
    if a.cues:
        start = a.start
        if start is None:
            start = (config_video_start(Path.cwd()) or 0.0) if is_video else 0.0
        cue_its, skipped = A.cue_items(A.load_cues(a.cues), start, a.map, a.cue_sfx)
        print(f"cue：{len(cue_its)} 个配上音效，成片秒 = 歌曲秒 − {start:g}" +
              (f"；{len(skipped)} 个没配（--map / --cue-sfx）：" + "，".join(f"{c['t']:g} {c['name']}" for c in skipped[:12])
               if skipped else ""))
        items += cue_its
    if not items:
        sys.exit("没有要加的音效：用 --at 或 --cues")
    items.sort(key=lambda it: it.t)

    pre, rows, stems, minfo = build_mix(music, items, dur, fps, a.lead_frames, a.duck, a.bed, a.sfx_gain, normalize)
    print(f"音乐 {minfo['music_lufs']:.1f} LUFS，叠音效前 {minfo['music_gain']:+.1f} dB；{fps:g} fps，起音提前 {a.lead_frames:g} 帧")
    for r in rows:
        tail = r.get("skipped") or r.get("note") or ""
        print(f"  {r['t']:8.3f}s  同步点 {r['sync_at']:8.3f}s  起 {r['start']:8.3f}s  {r['gain']:+5.1f} dB  {r['label']}  {tail}")
    if a.stems:
        sd = Path(a.stems)
        sd.mkdir(parents=True, exist_ok=True)
        for k, v in stems.items():
            if v is not None:
                A.write_wav(sd / f"{k}.wav", v, "FLOAT")

    with tempfile.TemporaryDirectory() as td:
        direct = out.suffix.lower() in {".wav", ".flac"}
        wav = out if direct else Path(td) / "mix.wav"
        tp_try = a.tp if direct else a.tp - 0.5   # AAC / MP3 编码常把真峰值抬高 0.5–1.5 dB，先留点余量省一轮
        for attempt in range(4):
            if normalize:
                y, _ = A.master_light(pre, float(a.lufs), tp_try)
            else:
                y = (pre * core.amp(a.gain)).astype(np.float32)
            A.write_wav(wav, y)
            if direct:
                L, TP = M.lufs(y), M.true_peak(y)
            else:
                A.encode(wav, out, src if is_video else None, dur if is_video else None)
                L, TP = A.loudness(out)
            if not normalize or TP <= a.tp or attempt == 3:
                break
            tp_try -= (TP - a.tp) + 0.2
            print(f"编码后真峰值 {TP:.2f} dBTP 超了，限幅压到 {tp_try:.2f} 重来")
        if a.png:
            from mgaudio import qc
            qc.spectrogram(str(wav), a.png, marks=[r["sync_at"] for r in rows if "skipped" not in r])
    clipped = int(np.sum(np.abs(y) >= 0.9999))
    print(f"-> {out}  {dur:.3f}s  {L:.2f} LUFS  真峰值 {TP:.2f} dBTP  削波 {clipped} 个采样")
    if is_video:
        tags = A.probe(out)["tags"]
        print(f"   色彩标签 space/primaries/transfer = {tags}" + ("" if tags == ("bt709",) * 3 else "  （原片就不是 bt709？）"))
    if not normalize and TP > a.tp:
        print(f"注意：真峰值 {TP:.2f} 超过 {a.tp}（--lufs off 不限幅，把 --gain 调低）")
    if a.report:
        Path(a.report).parent.mkdir(parents=True, exist_ok=True)
        Path(a.report).write_text(json.dumps({"input": str(src), "output": str(out), "fps": fps, "lead_frames": a.lead_frames,
                                              "lufs": round(L, 2), "true_peak": round(TP, 2), **minfo, "items": rows},
                                             ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()

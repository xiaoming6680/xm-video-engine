"""给不用歌的片子（科普、配音片）生成一段配乐：mgaudio 的配方（recipes）按时长和卡点编好、加音效、母带到 −14 LUFS。

  python tools/audio/score.py -o out/score.wav --recipe explainer --duration 30
      [--bpm 112] [--key D] [--mode major] [--prog "Imaj7 V vi7 IVmaj7"]
      [--drop 12] [--build 10] [--outro 27]   段落（秒）：drop = 高潮那一下（网格第 0 小节从这里起），outro = 收尾
      [--hits 1.2,3.4,…]                       画面卡点（秒）；不给 --bpm 时选配方速度范围里最贴合这些点的速度
      [--cues out/qa/cues.json --start 0]      或者从 cues 里取卡点（成片秒 = 歌曲秒 − start）
        [--map 正则=音效 …] [--cue-sfx 音效]   同时在 cue 上放音效（写法同 sfx_mix.py）
      [--at 名字@秒[@增益] …]                  在这些时刻放音效（同 sfx_mix.py，起音提前 --lead-frames 帧）
      [--set flavor=piano --set lead=False …]  配方的额外参数（--list 看每个配方有什么）
      [--music-level -20] [--duck 3]           音乐床响度、音效处音乐闪避（配方自带）
      [--lufs -14] [--tp -1] [--png 频谱.png] [--stems 目录] [--seed 0]
      [--synth-fallback]                       没装采样时，用到采样的配方改用合成音色（默认报错，提示跑 get_samples.py）
  python tools/audio/score.py --list           列出配方、默认速度 / 调 / 和弦和额外参数

配方原本为 10 秒的 MG 短片设计；更长的时长也能用（各声部按小节循环），段落位置自己给更好。
"""
import argparse
import ast
import inspect
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _env  # noqa: E402

if __name__ == "__main__":
    _env.ensure()

from mgaudio import core, recipes, samples  # noqa: E402
import _audio as A  # noqa: E402

COMMON = {"duration", "bpm", "key", "mode", "prog", "drop", "build", "outro", "hits", "energy", "music_level",
          "sfx_duck", "kw"}


def recipe_table() -> str:
    lines = []
    for name, fn in recipes.RECIPES.items():
        sig = inspect.signature(fn)
        d = {k: p.default for k, p in sig.parameters.items() if p.default is not inspect.Parameter.empty}
        extra = ", ".join(f"{k}={d[k]!r}" for k in d if k not in COMMON)
        doc = (fn.__doc__ or "").strip().splitlines()[0]
        lines.append(f"{name:12s} {d.get('key')} {d.get('mode'):8s} {d.get('prog')!s:26s} {extra}\n             {doc}")
    styles = ", ".join(f"{k}→{v[0]}" for k, v in recipes.STYLES.items())
    return "\n".join(lines) + f"\n\n风格名也能当 --recipe 用（mg-styles-15 的 22 种风格）：{styles}"


def parse_set(items: list[str]) -> dict:
    out = {}
    for s in items:
        if "=" not in s:
            raise SystemExit(f"--set 要写成 名字=值：{s!r}")
        k, v = s.split("=", 1)
        try:
            out[k.strip()] = ast.literal_eval(v.strip())
        except (ValueError, SyntaxError):
            out[k.strip()] = v.strip()
    return out


def build(a):
    """按参数编好配方的 Mix（还没放音效）。"""
    kw = {k: getattr(a, k) for k in ("bpm", "key", "mode", "prog", "drop", "build", "outro") if getattr(a, k) is not None}
    kw.update(duration=a.duration, music_level=a.music_level, sfx_duck=a.duck)
    hits = [float(x) for x in a.hits.split(",") if x.strip()] if a.hits else []
    cue_its = []
    if a.cues:
        cues = A.load_cues(a.cues)
        hits += [c["t"] - a.start for c in cues if 0 <= c["t"] - a.start <= a.duration]
        if a.map or a.cue_sfx:
            cue_its, _ = A.cue_items(cues, a.start, a.map, a.cue_sfx)
    if hits:
        kw["hits"] = sorted(hits)
    kw.update(parse_set(a.set))
    if a.recipe in recipes.RECIPES:
        m = recipes.recipe(a.recipe, **kw)
    else:
        m = recipes.for_style(a.recipe, **kw)
    return m, cue_its


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-o", "--out")
    ap.add_argument("--recipe", default="explainer", help="配方名或风格名（--list）")
    ap.add_argument("--duration", type=float, default=10.0)
    for k in ("bpm", "drop", "build", "outro"):
        ap.add_argument(f"--{k}", type=float)
    for k in ("key", "mode", "prog"):
        ap.add_argument(f"--{k}")
    ap.add_argument("--hits", help="卡点秒，逗号分隔")
    ap.add_argument("--cues")
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--map", action="append", default=[])
    ap.add_argument("--cue-sfx")
    ap.add_argument("--at", action="append", default=[])
    ap.add_argument("--fps", type=float, default=60.0)
    ap.add_argument("--lead-frames", type=float, default=1.0)
    ap.add_argument("--set", action="append", default=[])
    ap.add_argument("--music-level", type=float, default=-20.0)
    ap.add_argument("--duck", type=float, default=3.0)
    ap.add_argument("--lufs", type=float, default=-14.0)
    ap.add_argument("--tp", type=float, default=-1.0)
    ap.add_argument("--png")
    ap.add_argument("--stems")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--synth-fallback", action="store_true")
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()
    if a.list:
        print(recipe_table())
        return
    if not a.out:
        ap.error("要给 -o 输出.wav")
    core.reset_rng(a.seed)
    samples.MISSING.clear()
    try:
        m, cue_its = build(a)
    except samples.SamplesMissing as e:
        sys.exit(f"{e}\n（这个配方一定要采样；或者换个配方 / 参数）")
    except TypeError as e:
        sys.exit(f"配方参数不对：{e}（python tools/audio/score.py --list 看每个配方的参数）")
    if samples.MISSING and not samples.installed() and not a.synth_fallback:
        sys.exit(f"配方 {a.recipe} 要用采样 {', '.join(sorted(samples.MISSING))}，但采样没装（{samples.ROOT}）。\n"
                 f"先跑：{samples.HOWTO}\n或者加 --synth-fallback 用合成音色代替（音色会不一样）。")
    f = m.form
    s = f.summary()
    print(f"{a.recipe}：{s['bpm']} bpm  {s['key']}  build {s['build']}  drop {s['drop']}  outro {s['outro']}  "
          f"和弦 {' '.join(s['chords'])} → {s['final']}" + (f"  卡点最大偏差 {s['hit_fit_err'] * 1000:.0f} ms"
                                                            if s['hit_fit_err'] is not None else ""))
    lead = a.lead_frames / a.fps
    for it in [A.parse_at(x) for x in a.at] + cue_its:
        snd = A.make_sound(it)
        if 0 <= it.t - lead < a.duration:
            m.sfx(snd, it.t - lead, gain=it.gain, pan=it.pan)
            print(f"  音效 {it.t:7.3f}s  {it.label}")
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    res = m.export(a.out, lufs=a.lufs, tp=a.tp, spectrogram=a.png, stems_dir=a.stems)
    if res.get("warnings"):
        print("提示：" + "；".join(res["warnings"]))


if __name__ == "__main__":
    main()

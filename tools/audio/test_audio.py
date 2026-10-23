"""配乐 / 音效工具的快速单测（不需要采样，十几秒）。

  python tools/audio/test_audio.py                      # 自动换到 tools/audio/.venv
  tools/audio/.venv/Scripts/python -m unittest discover -s tools/audio -p "test_*.py" -v
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import _env  # noqa: E402

if __name__ == "__main__":
    _env.ensure()
elif _env.missing():
    raise unittest.SkipTest(f"缺 {', '.join(_env.missing())}：用 {_env.venv_python()} 跑（先 setup_audio.py）")

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402

from mgaudio import core, drums, master as M, samples, sfx  # noqa: E402
from mgaudio.recipes import chill  # noqa: E402
import _audio as A  # noqa: E402
import sfx_mix  # noqa: E402

SR = core.SR


def bed(dur=6.0, seed=1):
    """合成的「歌」：粉噪 + 低音正弦 + 每拍一个鼓点，约 -20 LUFS。"""
    n = core.ns(dur)
    t = np.arange(n) / SR
    x = core.pink(n, seed=seed) * 0.3 + 0.2 * np.sin(2 * np.pi * 55 * t)
    for b in np.arange(0.25, dur, 0.5):
        k = core.ns(b)
        m = min(n - k, core.ns(0.08))
        x[k:k + m] += 0.6 * np.sin(2 * np.pi * 80 * t[:m]) * np.exp(-t[:m] / 0.03)
    return np.stack([x, x * 0.9])


def first_onset(x, t0, t1, rel=0.01):
    a = np.abs(x).max(axis=0)
    i0, i1 = core.ns(t0), core.ns(t1)
    seg = a[i0:i1]
    return (i0 + int(np.argmax(seg > rel * seg.max()))) / SR


class Spec(unittest.TestCase):
    def test_parse_at(self):
        it = A.parse_at("pop@1.5")
        self.assertEqual((it.src, it.t, it.gain, it.is_file), ("pop", 1.5, 0.0, False))
        it = A.parse_at("whoosh(0.8, kind='sci')@3.25@-4")
        self.assertEqual((it.t, it.gain), (3.25, -4.0))
        it = A.parse_at(r"D:\音效 @x\a.wav@2")         # 文件名里有 @ 和中文也行
        self.assertTrue(it.is_file)
        self.assertEqual((it.src, it.t), (r"D:\音效 @x\a.wav", 2.0))

    def test_rejects(self):
        for bad in ["pop", "nosuch@1", "__import__('os')@1", "pop(kind=open('x'))@1", "pop(**{})@1",
                    "whoosh(0.8)+1@2", "swell@1"]:
            with self.assertRaises(ValueError, msg=bad):
                A.parse_at(bad)

    def test_alias(self):
        fn, args, kw = A.sfx_call("hit")
        self.assertIs(fn, sfx.impact)
        self.assertEqual(kw, {"kind": "punch"})
        _, _, kw = A.sfx_call("hit(size=1.5)")
        self.assertEqual(kw, {"kind": "punch", "size": 1.5})
        self.assertIn("whoosh", A.sfx_names())

    def test_cues(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "cues.json"
            p.write_text(json.dumps({"cues": [
                {"t": 10.5, "name": "红球落地", "on": "beat", "scene": "a"},
                {"t": 11.0, "name": "cut → b", "on": "beat", "scene": "b"},
                {"t": 12.0, "name": "标题砸下", "sfx": "hit", "gain": -2},
                {"t": 13.0, "name": "别的"}]}, ensure_ascii=False), encoding="utf-8")
            cues = A.load_cues(p)
            items, skipped = A.cue_items(cues, 10.0, ["落地=pop(kind='bubble')", "cut=swish"], None)
            self.assertEqual([(i.src, i.t) for i in items],
                             [("pop(kind='bubble')", 0.5), ("swish", 1.0), ("hit", 2.0)])
            self.assertEqual(items[2].gain, -2)
            self.assertEqual([c["name"] for c in skipped], ["别的"])
            items, skipped = A.cue_items(cues, 10.0, [], "pop")
            self.assertEqual(len(items), 4)
            p.write_text(json.dumps({"pops": [0.5, 0.9], "drop": 4.8}), encoding="utf-8")   # mgaudio 风格
            self.assertEqual([(c["name"], c["t"]) for c in A.load_cues(p)], [("pops", 0.5), ("pops", 0.9), ("drop", 4.8)])


class Mix(unittest.TestCase):
    def test_sync_points_one_frame_early(self):
        """瞬态 / whoosh 峰值 / riser 末尾对在「画面时刻 − 1 帧」。"""
        core.reset_rng(0)
        items = [A.parse_at(s) for s in ["pop@1.0", "riser(0.6, kind='noise')@2.5", "whoosh(0.6)@4.0"]]
        pre, rows, stems, _ = sfx_mix.build_mix(None, items, 5.0, fps=60, lead_frames=1, duck=0)
        s = stems["sfx"]
        lead = 1 / 60
        self.assertAlmostEqual(first_onset(s, 0.9, 1.1), 1.0 - lead, delta=0.0003)
        # riser：同步点之后（3 ms 收尾以外）没有声音，之前有
        k = core.ns(2.5 - lead)
        self.assertLess(np.abs(s[:, k + core.ns(0.004):k + core.ns(0.2)]).max(), 1e-4)
        self.assertGreater(np.abs(s[:, k - core.ns(0.05):k]).max(), 0.05)
        w = next(r for r in rows if r["label"].startswith("whoosh"))
        self.assertAlmostEqual(w["sync_at"], 4.0 - lead, places=3)
        self.assertAlmostEqual(w["start"], 4.0 - lead - 0.62 * 0.6, places=3)

    def test_master_loudness_peak_duck(self):
        core.reset_rng(0)
        music = bed()
        items = [A.parse_at(s) for s in ["hit@1.5", "pop@3.0", "whoosh@4.5"]]
        pre, rows, stems, info = sfx_mix.build_mix(music, items, 6.0, fps=60, lead_frames=1, duck=3)
        self.assertAlmostEqual(info["music_gain"], -20.0 - M.lufs(music), delta=0.01)   # 音乐先归到 -20 LUFS
        y, _ = A.master_light(pre, -14.0, -1.0)
        self.assertEqual(y.shape, (2, core.ns(6.0)))
        self.assertAlmostEqual(M.lufs(y), -14.0, delta=0.2)
        self.assertLessEqual(M.true_peak(y), -1.0)
        self.assertEqual(int(np.sum(np.abs(y) >= 0.9999)), 0)
        # 闪避：同步点处音乐比没压时低约 3 dB
        dry, _, st0, _ = sfx_mix.build_mix(music, items, 6.0, fps=60, lead_frames=1, duck=0)
        a, b = core.ns(3.0 - 1 / 60), core.ns(3.0 - 1 / 60 + 0.05)
        ratio = 20 * np.log10(np.abs(stems["music"][:, a:b]).max() / np.abs(st0["music"][:, a:b]).max())
        self.assertAlmostEqual(ratio, -3.0, delta=0.3)

    def test_legacy_mode_matches_old_mix_sfx(self):
        """--lufs off --duck 0 --lead-frames 0：文件原音量、从给定时刻开始叠在原曲上（旧 mix_sfx.py 的做法）。"""
        music = bed(3.0)
        with tempfile.TemporaryDirectory() as td:
            f = Path(td) / "click.wav"
            click = np.zeros(4800)
            click[100:140] = 0.5
            sf.write(str(f), click, SR, subtype="FLOAT")
            pre, rows, _, _ = sfx_mix.build_mix(music, [A.parse_at(f"{f}@1.25")], 3.0, lead_frames=0, duck=0,
                                                normalize=False)
        diff = pre - music
        k = core.ns(1.25)
        self.assertAlmostEqual(float(diff[0, k + 100]), 0.5, places=5)
        self.assertLess(np.abs(diff[:, :k + 100]).max(), 1e-6)

    def test_true_peak_blocks(self):
        x = bed(3.0) * 1.5
        self.assertAlmostEqual(M.true_peak(x, block=1 << 14), M.true_peak(x), delta=0.02)


class Samples(unittest.TestCase):
    def setUp(self):
        self.root = samples.ROOT
        self.td = tempfile.TemporaryDirectory()
        samples.set_root(self.td.name)

    def tearDown(self):
        samples.set_root(self.root)
        self.td.cleanup()

    def test_missing_samples(self):
        self.assertFalse(samples.installed())
        self.assertFalse(samples.available("piano"))
        self.assertIn("piano", samples.MISSING)
        with self.assertRaises(samples.SamplesMissing) as cm:
            samples.inst("piano")
        self.assertIn("get_samples.py", str(cm.exception))
        with self.assertRaises(samples.SamplesMissing):
            samples.hit("crash")
        # 有合成替代的照常出声
        self.assertGreater(core.peak(drums.crash().data), 0.01)
        self.assertIs(chill._keys("piano"), chill._rhodes_chord)

    def test_index_only_lists_existing_files(self):
        Path(self.td.name, "piano").mkdir()
        sf.write(str(Path(self.td.name, "piano", "C4.flac")), np.zeros(4800), SR)
        Path(self.td.name, "index.json").write_text(json.dumps({
            "piano": [{"file": "piano/C4.flac", "name": "C4", "midi": 60, "peak": 0.5},
                      {"file": "piano/D4.flac", "name": "D4", "midi": 62, "peak": 0.5}],
            "gong": [{"file": "gong/g.flac", "name": "g", "peak": 0.5}]}), encoding="utf-8")
        samples.set_root(self.td.name)
        self.assertEqual(samples.available(), ["piano"])
        self.assertEqual(len(samples.inst("piano").items), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)

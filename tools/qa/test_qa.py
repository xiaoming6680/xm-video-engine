"""检查脚本和 film.py 的单元测试（合成数据，不需要真视频）。在项目根目录：python -m unittest tools/qa/test_qa.py"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_video import av_offset, flash_report, transitions, phone_band_db, hit_report  # noqa: E402
from frames import FFMPEG  # noqa: E402
from seams import anchor, find_events  # noqa: E402


def write_wav(path: Path, x: np.ndarray, sr: int = 48000):
    y = (np.clip(x, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(y.tobytes())


class FlashTest(unittest.TestCase):
    fps = 60

    def series(self, hz: float, lo: float, hi: float, secs: float = 3) -> np.ndarray:
        t = np.arange(int(secs * self.fps)) / self.fps
        return np.where(np.sin(2 * np.pi * hz * t) >= 0, hi, lo)

    def test_fast_flashes_fail(self):
        y = self.series(5, 0.05, 0.6)            # 5 次/秒的明暗交替
        self.assertGreaterEqual(len(transitions(y)), 25)
        bad = flash_report(np.stack([y] * 9, axis=1), self.fps)
        self.assertIn("中", bad)

    def test_slow_flashes_pass(self):
        y = self.series(1.5, 0.05, 0.6)          # 1.5 次/秒
        self.assertEqual(flash_report(np.stack([y] * 9, axis=1), self.fps), {})

    def test_small_or_bright_changes_pass(self):
        small = self.series(6, 0.30, 0.36)       # 变化 < 0.1
        bright = self.series(6, 0.85, 0.98)      # 暗端 > 0.8
        self.assertEqual(transitions(small), [])
        self.assertEqual(transitions(bright), [])

    def test_one_region_only(self):
        ys = np.full((180, 9), 0.3)
        ys[:, 0] = self.series(5, 0.05, 0.6)     # 只有左上角在闪：整帧平均看不出，分区看得出
        bad = flash_report(ys, self.fps)
        self.assertIn("左上", bad)
        self.assertNotIn("整帧", bad)


class AVOffsetTest(unittest.TestCase):
    def test_offsets(self):
        sr = 48000
        rng = np.random.default_rng(1)
        x = rng.standard_normal(sr * 4) * 0.2
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            write_wav(d / "song.wav", x)
            write_wav(d / "late.wav", np.concatenate([np.zeros(960), x[:-960]]))
            self.assertEqual(av_offset(str(d / "late.wav"), str(d / "song.wav"), 0, dur=3), 960)
            # AAC in MP4: the encoder delay must be cancelled by the edit list (offset 0)
            subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=64x36:r=30:d=4", "-i", str(d / "song.wav"),
                            "-c:v", "libx264", "-c:a", "aac", "-b:a", "320k", "-shortest", str(d / "v.mp4")], check=True)
            self.assertLessEqual(abs(av_offset(str(d / "v.mp4"), str(d / "song.wav"), 0, dur=3)), 2)
            # a start offset: the video's audio is the song from 1.0 s
            write_wav(d / "cut.wav", x[sr:])
            self.assertEqual(av_offset(str(d / "cut.wav"), str(d / "song.wav"), 1.0, dur=2), 0)


class SeamTest(unittest.TestCase):
    def test_cut_found(self):
        rng = np.random.default_rng(2)
        a = (rng.random((90, 160)) * 255).astype(np.uint8)
        b = (255 - a // 2).astype(np.uint8)
        frames = np.stack([a] * 20 + [b] * 20)
        self.assertEqual(find_events(frames, 30), [(19, 19)])

    def test_pan_is_not_a_cut(self):
        rng = np.random.default_rng(3)
        big = (rng.random((90, 400)) * 255).astype(np.uint8)
        frames = np.stack([np.roll(big, -2 * k, axis=1)[:, :160] for k in range(40)])
        self.assertEqual(find_events(frames, 30), [])

    def test_anchor_follows_subject(self):
        img = np.full((90, 160, 3), 230, np.uint8)
        img[30:60, 100:130] = (220, 40, 40)      # 红块在右边
        x, y, s = anchor(img)
        self.assertAlmostEqual(x, 115 / 90, delta=0.05)
        self.assertAlmostEqual(y, 45 / 90, delta=0.05)


class PhoneHitTest(unittest.TestCase):
    def test_sub_heavy_hit_loses_on_a_phone(self):
        sr = 48000
        t = np.arange(8 * sr) / sr
        x = 0.01 * np.sin(2 * np.pi * 1000 * t)                                        # a quiet bed
        boom = (t >= 2) & (t < 2.3)
        x[boom] += 0.9 * np.sin(2 * np.pi * 55 * t[boom]) * np.exp(-(t[boom] - 2) * 8)  # loud, all sub
        note = (t >= 5) & (t < 5.3)
        x[note] += 0.3 * np.sin(2 * np.pi * 2000 * t[note])                            # quieter overall, mid band
        tt, db = phone_band_db(x, sr)
        (h1, _, p1), (h2, _, p2) = hit_report(tt, db, [2.05, 5.1])
        self.assertLess(p1, 95)        # the boom does not read on a phone
        self.assertGreaterEqual(p2, 95)


FILM_PY = Path(__file__).resolve().parents[1] / "film.py"


class FilmTest(unittest.TestCase):
    """film.py 的安全网：锁定段比对、偏移、拿掉收错的版本、plan 列出待确认的理解。在临时项目里真跑命令。"""

    def setUp(self):
        self.d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.d, True)

    def film(self, *args, ok=True):
        r = subprocess.run([sys.executable, str(FILM_PY), *args], cwd=self.d, capture_output=True, text=True, encoding="utf-8",
                           env={**os.environ, "PYTHONUTF8": "1"})
        if ok:
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return r.stdout + r.stderr

    def clip(self, name, box_x, song_from=None, dur=4):
        """白底上一个 30×30 的黑方块（画面主体很小，整帧平均差冲得很淡）；song_from 给了就配上歌从那一秒起的声音。"""
        cmd = [FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=white:s=640x360:r=30:d={dur},drawbox=x={box_x}:y=160:w=30:h=30:color=black:t=fill"]
        if song_from is not None:
            cmd += ["-ss", str(song_from), "-t", str(dur), "-i", str(self.d / "audio/song.wav"), "-c:a", "aac", "-shortest"]
        subprocess.run(cmd + ["-c:v", "libx264", "-pix_fmt", "yuv420p", str(self.d / name)], check=True)
        return name

    def state(self):
        return json.loads((self.d / "film/film.json").read_text(encoding="utf-8"))

    def test_guard_sees_a_small_moved_subject(self):
        self.film("init", "--range", "0,4", "--at", "2")
        self.film("add", self.clip("a.mp4", 100))
        self.film("lock", "s01", "v1")
        out = self.film("add", self.clip("b.mp4", 400))           # the subject moved: whole-frame mean diff is only ~2
        self.assertIn("s01（锁定 v1）：最大块差", out)
        self.assertIn("动到了", out)
        out = self.film("add", self.clip("c.mp4", 100))           # the same picture again
        self.assertIn("没变", out)
        self.assertNotIn("动到了", out)

    def test_offset_from_config_then_from_sound(self):
        (self.d / "audio").mkdir()
        rng = np.random.default_rng(3)
        loop = np.tile(rng.standard_normal(48000), 8) * 0.15    # a one-second loop under fresh noise: off by a whole loop still correlates ~0.7
        write_wav(self.d / "audio/song.wav", loop + rng.standard_normal(48000 * 8) * 0.1)
        (self.d / "app/src").mkdir(parents=True)
        (self.d / "app/src/config.ts").write_text("export const VIDEO_START = 2;\nexport const VIDEO_END: number | null = 6;\n", encoding="utf-8")
        self.assertIn("范围按 app/src/config.ts", self.film("init", "--at", "4"))
        self.assertEqual(self.state()["range"], [2.0, 6.0])
        self.assertIn("对上了", self.film("add", self.clip("v1.mp4", 100, song_from=2)))   # VIDEO_START, confirmed by the sound
        self.assertIn("按声音对齐", self.film("add", self.clip("v7.mp4", 100, song_from=3)))  # VIDEO_START is wrong for this one
        vs = {v["id"]: v for v in self.state()["versions"]}
        self.assertEqual(sorted(vs), ["v1", "v7"])                                         # ids from the file names
        self.assertAlmostEqual(vs["v1"]["offset"], 2.0, places=2)
        self.assertAlmostEqual(vs["v7"]["offset"], 3.0, places=2)
        self.assertIn("对不上", self.film("add", self.clip("x.mp4", 100, song_from=3), "--offset", "2"))  # an explicit offset is kept, with a warning
        self.assertEqual(self.state()["versions"][-1]["id"], "v8")
        self.film("edit", "v8", "--offset", "3")
        self.assertEqual(self.state()["versions"][-1]["t0"], 3.0)

    def test_drop_keeps_locked_and_moves_files(self):
        self.film("init", "--range", "0,4", "--at", "2")
        self.film("add", self.clip("a.mp4", 100))
        self.film("add", self.clip("b.mp4", 400))
        self.film("lock", "s01", "v1")
        self.assertNotEqual(subprocess.run([sys.executable, str(FILM_PY), "drop", "v1"], cwd=self.d, capture_output=True).returncode, 0)
        self.film("pick", "s02", "v2")
        self.film("drop", "v2", ok=False)
        self.film("drop", "v2", "--force")
        s = self.state()
        self.assertEqual([v["id"] for v in s["versions"]], ["v1"])
        self.assertNotIn("pick", s["picks"]["s02"])
        self.assertTrue(list((self.d / "film/trash").glob("v2-*/v2.mp4")))
        self.film("add", self.clip("c.mp4", 100))
        self.assertEqual(self.state()["versions"][-1]["id"], "v3")                          # a dropped id is not reused

    def test_plan_lists_unconfirmed_plans(self):
        self.film("init", "--range", "0,4", "--at", "2")
        self.film("say", "s02", "我打算：换成远景")
        self.assertIn("「我打算」等确认：s02", self.film("plan"))
        self.assertIn("我打算（等确认）：我打算：换成远景", (self.d / "film/plan.md").read_text(encoding="utf-8"))


class SelfcheckTest(unittest.TestCase):
    """交付自检的判断：动作表、候选、独立评审、看片笔记（不跑渲染，只看它怎么认「做过没有」）。"""

    def setUp(self):
        import selfcheck
        self.sc = selfcheck
        self.d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.d, True)
        self.old = (selfcheck.ROOT, selfcheck.OUT)
        self.addCleanup(lambda: setattr(selfcheck, "ROOT", self.old[0]) or setattr(selfcheck, "OUT", self.old[1]))
        selfcheck.ROOT, selfcheck.OUT = self.d, self.d / "out" / "qa"
        selfcheck.OUT.mkdir(parents=True)
        self.st = {"segments": [{"id": f"s0{i}", "t0": i * 4.0, "t1": i * 4.0 + 4} for i in range(3)],
                   "versions": [{"id": "v1", "t0": 0, "t1": 12}, {"id": "v2", "t0": 0, "t1": 4}], "picks": {}}

    def state(self, fn, *args):
        rep = self.sc.Report()
        fn(rep, *args)
        return rep.rows[-1][1], rep.rows[-1][2]

    def test_motion_table(self):
        self.assertEqual(self.state(self.sc.motion_table, self.st)[0], "没做")            # no TREATMENT.md
        (self.d / "docs").mkdir()
        head = "## 动作表\n\n说明\n\n| 段 | 时间 | 在动的 | 进出 | 重拍 | 缓动 | 候选 |\n|---|---|---|---|---|---|---|\n"
        row = "| s0{} | 0–4 | 字、线 | 弹入 | 第 1 拍 | 快出慢停 | 两个 |\n"
        (self.d / "docs/TREATMENT.md").write_text("# x\n\n" + head + row.format(1) + "| s02 |  |  |  |  |  |  |\n\n## 版本\n", encoding="utf-8")
        self.assertEqual(self.state(self.sc.motion_table, self.st)[0], "!!")              # one filled row (the empty one does not count), 3 segments
        (self.d / "docs/TREATMENT.md").write_text("# x\n\n" + head + "".join(row.format(i) for i in (1, 2, 3)), encoding="utf-8")
        self.assertEqual(self.state(self.sc.motion_table, self.st)[0], "OK")

    def test_candidates(self):
        s, note = self.state(self.sc.candidates, self.st)
        self.assertEqual(s, "!!")                                                          # s01, s02 have one version: more than half
        self.assertIn("s01(1)", note)
        self.assertEqual(self.state(self.sc.candidates, None)[0], "没做")

    def test_review_and_notes_must_be_newer_than_the_film(self):
        video = self.d / "out" / "v.mp4"
        video.write_bytes(b"x")
        old = video.stat().st_mtime
        self.assertEqual(self.state(self.sc.review_done, video)[0], "没做")
        (self.sc.OUT / "评审.md").write_text("意见", encoding="utf-8")
        os.utime(self.sc.OUT / "评审.md", (old - 100, old - 100))
        self.assertEqual(self.state(self.sc.review_done, video)[0], "没做")                # older than the film: reviewed another cut
        os.utime(self.sc.OUT / "评审.md", (old + 100, old + 100))
        self.assertEqual(self.state(self.sc.review_done, video)[0], "OK")
        rep = self.sc.Report()
        img = self.sc.OUT / "v_sheet.jpg"
        img.write_bytes(b"x")
        rep.looks = [img, self.sc.OUT / "v_onion_1-2.jpg"]
        (self.sc.OUT / "v_onion_1-2.jpg").write_bytes(b"x")
        (self.sc.OUT / "看片笔记.md").write_text("v_sheet.jpg：第二段太空\n", encoding="utf-8")
        os.utime(self.sc.OUT / "看片笔记.md", (old + 100, old + 100))
        self.sc.notes(rep, video)
        self.assertEqual(rep.rows[-1][1], "没做")
        self.assertIn("v_onion_1-2.jpg", rep.rows[-1][2])                                  # the onion skin was not written about



class FramesTest(unittest.TestCase):
    """review.py frames：每一帧都进表、一秒一张，硬切能在帧差尖峰里找到。"""

    def test_every_frame_and_the_cut(self):
        d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d, True)
        # 2 s at 30 fps: white for 1.5 s, then black (a cut at frame 45)
        subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=320x180:r=30:d=1.5", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=0.5",
                        "-filter_complex", "[0][1]concat=n=2:v=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(d / "v.mp4")], check=True)
        r = subprocess.run([sys.executable, str(Path(__file__).parent / "review.py"), "v.mp4", "frames"], cwd=d, capture_output=True, text=True,
                           encoding="utf-8", env={**os.environ, "PYTHONUTF8": "1"})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        out = d / "out/qa/v_frames"
        self.assertEqual(sorted(x.name for x in out.glob("s_*.jpg")), ["s_0000.jpg", "s_0001.jpg"])
        cuts = json.loads((out / "cuts.json").read_text(encoding="utf-8"))
        self.assertEqual(cuts["frames"], 60)
        self.assertEqual(cuts["cuts"], [45])



class RhythmTest(unittest.TestCase):
    """review.py rhythm：一段 10 fps 的画面放成 30 fps（每张停 3 帧），停住的帧约三分之二、停顿都是 2 帧。"""

    def test_holds(self):
        d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d, True)
        subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=10:duration=3", "-vf", "fps=30",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(d / "v.mp4")], check=True)
        sys.path.insert(0, str(Path(__file__).parent))
        import review
        review.ROOT = d
        r = review.rhythm(d / "v.mp4")
        self.assertAlmostEqual(r["held"], 2 / 3, delta=0.05)
        self.assertEqual(set(r["holds"]), {2})


if __name__ == "__main__":
    unittest.main()

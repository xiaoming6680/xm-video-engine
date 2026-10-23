"""检查脚本的单元测试（合成数据，不需要真视频）。在项目根目录：python -m unittest tools/qa/test_qa.py"""
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


if __name__ == "__main__":
    unittest.main()

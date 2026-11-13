"""tools/retime.py 的测试：已知运动的合成序列帧，补出来的中间帧和真值比。

  python -m unittest tools/test_retime.py
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import retime  # noqa: E402
from test_track import texture, write_seq, W, H  # noqa: E402


def shot(big: np.ndarray, x: float) -> np.ndarray:
    return cv2.warpAffine(big, np.float32([[1, 0, -x], [0, 1, -50]]), (W, H), flags=cv2.INTER_LINEAR)


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    m = float(np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))
    return 99.0 if m == 0 else 10 * np.log10(255 ** 2 / m)


class RetimeTest(unittest.TestCase):
    def test_slow_motion_in_betweens(self):
        big = texture(7, W + 400, H + 100)
        frames = [cv2.cvtColor(shot(big, 50 + 8 * i), cv2.COLOR_GRAY2BGR) for i in range(10)]
        with tempfile.TemporaryDirectory() as td:
            d = Path(td) / "src"
            d.mkdir()
            write_seq(d, frames)
            retime.main([str(d), "--speed", "0.25", "--name", "slow"])
            out = Path(td) / "slow"
            meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["last"], 37)   # 9 source intervals × 4 + 1
            worst = 99.0
            for j in (1, 2, 3, 6, 18, 30):
                got = cv2.imread(str(out / f"{j + 1:05d}.png"), cv2.IMREAD_GRAYSCALE)
                truth = shot(big, 50 + 8 * j / 4)
                # compare away from the borders (the edges have nothing to pull from)
                worst = min(worst, psnr(got[20:-20, 20:-20], truth[20:-20, 20:-20]))
        self.assertGreater(worst, 30, f"worst in-between PSNR {worst:.1f} dB")

    def test_time_remap_holds_and_motion_blur_smears(self):
        big = texture(8, W + 400, H + 100)
        frames = [cv2.cvtColor(shot(big, 50 + 20 * i), cv2.COLOR_GRAY2BGR) for i in range(6)]
        with tempfile.TemporaryDirectory() as td:
            d = Path(td) / "src"
            d.mkdir()
            write_seq(d, frames)
            retime.main([str(d), "--map", "0:0.1,0.1:0.1", "--name", "hold", "--duration", "0.1"])
            h = [cv2.imread(str(Path(td) / "hold" / f"{k:05d}.png"), cv2.IMREAD_GRAYSCALE) for k in (1, 3)]
            self.assertEqual(float(np.abs(h[0].astype(int) - h[1].astype(int)).max()), 0.0)
            retime.main([str(d), "--blur", "0.5", "--name", "mb"])
            sharp = cv2.imread(str(d / "00003.png"), cv2.IMREAD_GRAYSCALE)
            mb = cv2.imread(str(Path(td) / "mb" / "00003.png"), cv2.IMREAD_GRAYSCALE)
        # the truth: the frame averaged over the shutter (frame 3 sits at x = 90; half a frame of 20 px/frame = 85 … 95)
        truth = np.mean([shot(big, 85 + 10 * (q + 0.5) / 8).astype(np.float64) for q in range(8)], axis=0)
        self.assertGreater(psnr(mb[20:-20, 20:-20], truth[20:-20, 20:-20]), 30)
        # and it is really blurred: far from the sharp frame
        self.assertLess(psnr(sharp[20:-20, 20:-20], truth[20:-20, 20:-20]), psnr(mb[20:-20, 20:-20], truth[20:-20, 20:-20]) - 3)

if __name__ == "__main__":
    unittest.main()

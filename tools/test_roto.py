"""tools/roto.py 的测试（离线的 grabcut 方法）：纹理背景上移动的圆盘，逐帧蒙版和真值的交并比。

  python -m unittest tools/test_roto.py
"""
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import roto  # noqa: E402
from test_track import texture, write_seq, W, H  # noqa: E402


class RotoTest(unittest.TestCase):
    def test_grabcut_follows_a_moving_disc(self):
        bg = cv2.cvtColor(texture(9, W, H), cv2.COLOR_GRAY2BGR)
        bg = (bg * 0.6 + 40).astype(np.uint8)
        frames, truth = [], []
        for i in range(20):
            f = bg.copy()
            c = (int(200 + 12 * i), int(180 + 30 * np.sin(i / 4)))
            cv2.circle(f, c, 60, (40, 140, 255), -1, cv2.LINE_AA)
            cv2.circle(f, (c[0] - 15, c[1] - 10), 18, (60, 200, 255), -1, cv2.LINE_AA)
            m = np.zeros((H, W), np.uint8)
            cv2.circle(m, c, 60, 255, -1)
            frames.append(f); truth.append(m > 127)
        with tempfile.TemporaryDirectory() as td:
            d = Path(td) / "clip"
            d.mkdir()
            write_seq(d, frames)
            roto.main([str(d), "--at", "10", "--box", "230,125,390,285", "--points", "308,203", "--method", "grabcut", "--name", "disc"])
            out = Path(td) / "clip_disc"
            ious = []
            for i in range(20):
                a = cv2.imread(str(out / f"{i + 1:05d}.png"), cv2.IMREAD_UNCHANGED)[..., 3] > 127
                ious.append((a & truth[i]).sum() / max(1, (a | truth[i]).sum()))
        print("IoU", [round(float(x), 3) for x in ious])
        self.assertGreater(min(ious), 0.9, f"worst IoU {min(ious):.3f}")


if __name__ == "__main__":
    unittest.main()

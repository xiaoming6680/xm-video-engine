"""tools/track.py 的测试：合成已知运动的序列帧，看点、平面、稳定的结果和真值差多少。

  python -m unittest tools/test_track.py
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import track  # noqa: E402

W, H = 640, 360


def texture(seed: int, w: int, h: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    t = rng.random((h // 4, w // 4)).astype(np.float32)
    t = cv2.resize(t, (w, h), interpolation=cv2.INTER_CUBIC)
    t = cv2.GaussianBlur(t, (0, 0), 1.2)
    t = (t - t.min()) / (t.max() - t.min())
    return (t * 255).astype(np.uint8)


def write_seq(d: Path, frames: list[np.ndarray]):
    for i, f in enumerate(frames):
        cv2.imwrite(str(d / f"{i + 1:05d}.png"), f)
    (d / "meta.json").write_text(json.dumps({"fps": 30, "first": 1, "last": len(frames), "width": W, "height": H, "pattern": "#####.png"}), encoding="utf-8")


class TrackTest(unittest.TestCase):
    def test_point(self):
        big = texture(1, W + 200, H + 200)
        shifts = [(100 + 40 * np.sin(i / 6), 100 + 25 * np.cos(i / 9)) for i in range(40)]
        frames = [cv2.warpAffine(big, np.float32([[1, 0, -sx], [0, 1, -sy]]), (W, H), flags=cv2.INTER_LINEAR) for sx, sy in shifts]
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            write_seq(d, frames)
            track.main(["point", str(d), "--at", "20", "--points", "300,180", "150,90"])
            r = json.loads((d / "track_point.json").read_text(encoding="utf-8"))
        sx0, sy0 = shifts[19]
        for nm, (x0, y0) in (("p0", (300, 180)), ("p1", (150, 90))):
            err = [np.hypot(x - (x0 + sx0 - sx), y - (y0 + sy0 - sy)) for (x, y, _), (sx, sy) in zip(r["points"][nm], shifts)]
            self.assertLess(max(err), 0.5, f"{nm}: max error {max(err):.3f}")

    def test_planar(self):
        bg, card = texture(2, W, H), texture(3, 200, 140)
        src = np.float32([[0, 0], [200, 0], [200, 140], [0, 140]])
        truth, frames = [], []
        for i in range(30):
            a = i / 29
            q = np.float32([[200 + 60 * a, 100 - 10 * a], [400 + 40 * a, 90 + 20 * a], [420 + 20 * a, 260 - 15 * a], [190 + 50 * a, 250 + 10 * a]])
            Hm = cv2.getPerspectiveTransform(src, q)
            f = bg.copy()
            warped = cv2.warpPerspective(card, Hm, (W, H), flags=cv2.INTER_LINEAR)
            m = cv2.warpPerspective(np.full_like(card, 255), Hm, (W, H), flags=cv2.INTER_NEAREST)
            f[m > 0] = warped[m > 0]
            frames.append(f)
            truth.append(q)
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            write_seq(d, frames)
            c0 = truth[0]
            track.main(["planar", str(d), "--at", "1", "--corners", *[f"{x},{y}" for x, y in c0]])
            r = json.loads((d / "track_planar.json").read_text(encoding="utf-8"))
        err = max(np.hypot(*(np.array(c) - t).T).max() for c, t in zip(r["corners"], truth))
        self.assertLess(err, 1.0, f"max corner error {err:.3f}")

    def test_stabilize_lock(self):
        big = texture(4, W + 120, H + 120)
        rng = np.random.default_rng(5)
        jit = [(rng.normal(0, 6), rng.normal(0, 6), rng.normal(0, 1.0)) for _ in range(30)]
        jit[0] = (0.0, 0.0, 0.0)
        frames, mats = [], []
        for dx, dy, ang in jit:
            M = cv2.getRotationMatrix2D((W / 2 + 60, H / 2 + 60), ang, 1.0)
            M[:, 2] += (-60 + dx, -60 + dy)
            frames.append(cv2.warpAffine(big, M, (W, H), flags=cv2.INTER_LINEAR))
            mats.append(M)
        with tempfile.TemporaryDirectory() as td:
            d = Path(td)
            write_seq(d, frames)
            track.main(["stabilize", str(d), "--lock"])
            r = json.loads((d / "track_stabilize.json").read_text(encoding="utf-8"))
        c = np.array(r["center"])
        # a scene point seen in frame 0 at p0: in frame i it is at Mi·Mo⁻¹·p0; the correction must bring it back to p0
        M0 = np.vstack([mats[0], [0, 0, 1]])
        worst = 0.0
        for (dx, dy, deg, sc), M in zip(r["xform"], mats):
            Mi = np.vstack([M, [0, 0, 1]]) @ np.linalg.inv(M0)
            a = np.radians(deg)
            R = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]])
            for p0 in ([200.0, 120.0], [450.0, 260.0], [320.0, 180.0]):
                pi = (Mi @ np.array([*p0, 1.0]))[:2]
                back = c + np.array([dx, dy]) + sc * (R @ (pi - c))
                worst = max(worst, float(np.hypot(*(back - p0))))
        self.assertLess(worst, 1.0, f"max stabilized error {worst:.3f}")


if __name__ == "__main__":
    unittest.main()

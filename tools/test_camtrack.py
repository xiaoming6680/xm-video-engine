"""tools/camtrack.py 的测试：已知相机路径和焦距，渲出一段「点云」序列帧，从像素开始反求，和真值比。

  python -m unittest tools/test_camtrack.py
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import camtrack  # noqa: E402
from test_track import write_seq, W, H  # noqa: E402

F_TRUE = 500.0
N = 40


def ry(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rx(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


# a textured room: (point on plane, normal, in-plane axes u / v, extent [u0, u1, v0, v1], texture seed); y down
PLANES = [
    (np.array([0, 2.0, 0]), np.array([0, -1.0, 0]), np.array([1.0, 0, 0]), np.array([0, 0, 1.0]), (-30, 30, 0, 60), 21),   # floor
    (np.array([0, 0, 20.0]), np.array([0, 0, -1.0]), np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), (-30, 30, -15, 2), 22),  # back wall
    (np.array([-7.0, 0, 0]), np.array([1.0, 0, 0]), np.array([0, 0, 1.0]), np.array([0, 1.0, 0]), (0, 20, -15, 2), 23),     # left wall
    (np.array([0, 0, 8.0]), np.array([0, 0, -1.0]), np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), (1, 3.5, -0.5, 2), 24),   # a panel
    (np.array([0, 0, 12.0]), np.array([0, 0, -1.0]), np.array([1.0, 0, 0]), np.array([0, 1.0, 0]), (-4, -1.5, -2, 2), 25),  # another
]
TEX = {}


def tex(seed):
    if seed not in TEX:
        rng = np.random.default_rng(seed)
        t = cv2.GaussianBlur(rng.random((512, 512)).astype(np.float32), (0, 0), 1.6)
        t = (t - t.min()) / (t.max() - t.min())
        TEX[seed] = (40 + 200 * t).astype(np.float32)
    return TEX[seed]


def truth(n: int = N):
    rng = np.random.default_rng(11)
    cams = []
    for i in range(n):
        C = np.array([0.1 * i, -0.01 * i, 0.06 * i])
        M = ry(np.radians(-0.6 * i)) @ rx(np.radians(0.15 * i))      # camera → world
        cams.append((M, C))
    # sample points on the surfaces (for the projection check)
    X = []
    for P0, n, u, v, (u0, u1, v0, v1), _ in PLANES:
        for _ in range(60):
            X.append(P0 + u * rng.uniform(u0, u1) + v * rng.uniform(v0, v1))
    return np.array(X), None, cams


def render(X, amp, M, C):
    gx, gy = np.meshgrid(np.arange(W, dtype=np.float64), np.arange(H, dtype=np.float64))
    d = np.stack([(gx - W / 2) / F_TRUE, (gy - H / 2) / F_TRUE, np.ones_like(gx)], -1) @ M.T
    best = np.full((H, W), np.inf)
    img = np.zeros((H, W), np.float32)
    for P0, n, u, v, (u0, u1, v0, v1), seed in PLANES:
        den = d @ n
        with np.errstate(divide="ignore", invalid="ignore"):
            t = ((P0 - C) @ n) / den
            hit = C + d * t[..., None]
            a, b = (hit - P0) @ u, (hit - P0) @ v
            ok = (t > 0) & (t < best) & (a >= u0) & (a <= u1) & (b >= v0) & (b <= v1)
        T = tex(seed)
        mx, my = np.mod(np.nan_to_num(a) * 40, 512).astype(np.float32), np.mod(np.nan_to_num(b) * 40, 512).astype(np.float32)
        val = cv2.remap(T, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)
        img[ok] = val[ok]
        best[ok] = t[ok]
    return np.clip(img, 0, 255).astype(np.uint8)


def quat_to_mat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


class CamTrackTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.X, amp, cls.cams = truth()
        cls.td = tempfile.TemporaryDirectory()
        cls.d = Path(cls.td.name) / "clip"
        cls.d.mkdir()
        write_seq(cls.d, [cv2.cvtColor(render(cls.X, amp, M, C), cv2.COLOR_GRAY2BGR) for M, C in cls.cams])

    @classmethod
    def tearDownClass(cls):
        cls.td.cleanup()

    def check(self, res, f_tol):
        cams = res["cameras"]
        self.assertGreaterEqual(sum(c is not None for c in cams), N - 2)
        self.assertLess(res["rms"], 0.6)
        zoom = res["zoom"]
        self.assertLess(abs(zoom - F_TRUE) / F_TRUE, f_tol, f"zoom {zoom:.1f}")
        idx = [i for i, c in enumerate(cams) if c is not None]
        P = np.array([cams[i][:3] for i in idx])
        Ct = np.array([self.cams[i][1] for i in idx])
        # the solve's scale: the least-squares k with P − P0 ≈ k (C − C0)
        dP, dC = P - P[0], Ct - Ct[0]
        k = float((dP * dC).sum() / (dC * dC).sum())
        path = np.linalg.norm(np.diff(Ct, axis=0), axis=1).sum()
        err = np.linalg.norm(dP - k * dC, axis=1).max() / (k * path)
        self.assertLess(err, 0.02, f"position error {err:.4f} of the path")
        rot = max(np.degrees(np.arccos(np.clip((np.trace(quat_to_mat(cams[i][3:]).T @ self.cams[i][0]) - 1) / 2, -1, 1))) for i in idx)
        self.assertLess(rot, 0.5, f"rotation error {rot:.3f}°")
        # comp camera (AE: X = Rᵀ(p − P), screen = zoom·X/Z + centre) puts a true point where the footage shows it
        o = np.array([W / 2, H / 2, -zoom])
        worst = 0.0
        for i in idx[::7]:
            M, C = self.cams[i]
            R, t = M.T, -M.T @ C
            Mc = quat_to_mat(cams[i][3:]); Pc = np.array(cams[i][:3])
            for X in self.X[:200:9]:
                pc = (R @ X) + t
                if pc[2] < 1:
                    continue
                want = F_TRUE * pc[:2] / pc[2] + [W / 2, H / 2]
                Xc = Mc.T @ (k * X + o - Pc)
                got = zoom * Xc[:2] / Xc[2] + [W / 2, H / 2]
                if 0 <= want[0] < W and 0 <= want[1] < H:
                    worst = max(worst, float(np.linalg.norm(got - want)))
        # (a searched focal a fraction of a percent off moves the edge of the frame by about that fraction of the width)
        tol = 2.0 + W * abs(zoom - F_TRUE) / F_TRUE
        self.assertLess(worst, tol, f"comp camera reprojection {worst:.2f} px (allowed {tol:.2f})")

    def test_known_fov(self):
        fov = float(np.degrees(2 * np.arctan((W / 2) / F_TRUE)))
        res = camtrack.main([str(self.d), "--fov", f"{fov:.4f}", "--name", "known"])
        self.check(res, 0.01)

    def test_searched_fov(self):
        res = camtrack.main([str(self.d), "--name", "search"])
        self.check(res, 0.03)

    def test_ground(self):
        fov = float(np.degrees(2 * np.arctan((W / 2) / F_TRUE)))
        res = camtrack.main([str(self.d), "--fov", f"{fov:.4f}", "--ground", "0,250,640,360", "--at", "1", "--name", "ground"])
        cams = res["cameras"]
        # the floor (y = 2 in the truth, which is already level) stays level: the first camera hardly turns
        q = np.array(cams[0][3:])
        self.assertGreater(abs(q[3]), np.cos(np.radians(1.0) / 2))
        # and its height in comp px is the camera's centre line plus 2 world units at the solve's scale
        idx = [i for i, c in enumerate(cams) if c is not None]
        P = np.array([cams[i][:3] for i in idx]); Ct = np.array([self.cams[i][1] for i in idx])
        dP, dC = P - P[0], Ct - Ct[0]
        k = float((dP * dC).sum() / (dC * dC).sum())
        # (k comes from the camera path and carries its own 1–2 %; the plane itself is fitted to the floor points)
        self.assertLess(abs(res["ground"]["y"] - (H / 2 + 2 * k)) / (2 * k), 0.05)


if __name__ == "__main__":
    unittest.main()

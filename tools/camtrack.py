"""3D 摄像机反求（AE 的 3D 摄像机跟踪器）：从 tools/footage.py 抽好的序列帧算出拍摄时摄像机怎么动、焦距多少，写成 JSON，
app 里 engine/track.ts 读成合成的摄像机（逐帧位置、朝向、zoom），3D 图层、粒子、three 场景、灯光就像长在实拍画面里。

  # 在项目根目录跑；<帧目录> 是 footage.py 写的 assets/footage/<名字>/
  python tools/camtrack.py assets/footage/street                      # 焦距不知道：从画面自标定
  python tools/camtrack.py assets/footage/street --fov 54            # 知道水平视角（度）就给，更稳
  python tools/camtrack.py assets/footage/street --ground 300,700,1600,1050 --at 1   # 第 1 帧里这块是地面：把世界摆正，地面水平
  可选：--comp 1920x1080（合成尺寸，默认和素材一样）；--name camera（写到 <帧目录>/track_<name>.json）；--features 1500；
        --from / --to 只算这几帧
  python tools/camtrack.py --test camtest                            # 不要原片：渲一段已知摄像机路径的纹理房间（640×360，3 秒）
                                                                     # 到 assets/footage/camtest/，拿来试反求和 app 的 ?camtrack 示例

做法（增量式运动恢复结构）：
  1. 特征点逐帧 LK 跟（前后向检查），少了就补新点
  2. 找视差够大的两帧，本质矩阵求相对位姿、三角化出第一批三维点
  3. 其余每帧用已知三维点 PnP（RANSAC）求位姿，再和之前视差够的帧三角化新点
  4. 光束法平差（Levenberg–Marquardt，解析雅可比、稀疏正规方程直接解；先 Huber，去掉误差大的观测再按最小二乘调一次）
  焦距没给时自标定：多对帧的基础矩阵，找让本质矩阵两个奇异值相等的焦距（Mendonça–Cipolla）
结果坐标是合成的 AE 规矩（像素、y 向下、z 往屏幕里）：第一帧的摄像机就是 AE 默认摄像机（在合成中心正前方 zoom 处），
场景的中位深度落在 z = 0 那一层（1:1 显示）；--ground 时世界转到地面水平（地面高度写在 ground.y）。
JSON：{ type: 'camera', fps, first, frames, size, comp, zoom, fov, cameras: [[x, y, z, qx, qy, qz, qw] | null, …], cloud: [[x, y, z], …], ground?, rms }
做不出来的帧（跟丢、视差不够）是 null，engine/track.ts 按最近的好帧补。
"""
import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from track import frame_paths, gray, load_meta  # noqa: E402

# LK for the solve: smaller windows and fewer levels than tools/track.py's (big windows at the coarse levels average
# surfaces at different depths, which moves a feature off its point)
LK = dict(winSize=(21, 21), maxLevel=3, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 40, 0.01))


# ---------------------------------------------------------------- feature tracks

def track_features(frames: list[np.ndarray], max_n: int = 1500) -> dict[int, dict[int, tuple[float, float]]]:
    """Feature tracks: id → {frame: (x, y)}; LK with a forward-backward check, refilled where they thinned out."""
    h, w = frames[0].shape
    min_d = max(6, int(min(w, h) / 120))
    tracks: dict[int, dict[int, tuple[float, float]]] = {}
    nid = 0

    def detect(img, existing):
        nonlocal nid
        mask = np.full((h, w), 255, np.uint8)
        for x, y in existing:
            cv2.circle(mask, (int(x), int(y)), min_d * 2, 0, -1)
        f = cv2.goodFeaturesToTrack(img, max_n - len(existing), 0.005, min_d, mask=mask, blockSize=7)
        out = []
        if f is not None:
            for x, y in f.reshape(-1, 2):
                out.append((nid, float(x), float(y)))
                nid += 1
        return out

    cur = [(i, x, y) for i, x, y in detect(frames[0], [])]
    for i, x, y in cur:
        tracks[i] = {0: (x, y)}
    for k in range(1, len(frames)):
        if cur:
            p0 = np.float32([[x, y] for _, x, y in cur]).reshape(-1, 1, 2)
            p1, st, _ = cv2.calcOpticalFlowPyrLK(frames[k - 1], frames[k], p0, None, **LK)
            pb, st2, _ = cv2.calcOpticalFlowPyrLK(frames[k], frames[k - 1], p1, None, **LK)
            fb = np.linalg.norm((pb - p0).reshape(-1, 2), axis=1)
            nxt = []
            for (tid, _, _), q, s1, s2, e in zip(cur, p1.reshape(-1, 2), st.reshape(-1), st2.reshape(-1), fb):
                x, y = float(q[0]), float(q[1])
                if s1 and s2 and e < 0.8 and 0 <= x < w and 0 <= y < h:
                    tracks[tid][k] = (x, y)
                    nxt.append((tid, x, y))
            cur = nxt
        if len(cur) < 0.7 * max_n:
            for tid, x, y in detect(frames[k], [(x, y) for _, x, y in cur]):
                tracks[tid] = {k: (x, y)}
                cur.append((tid, x, y))
    return {i: t for i, t in tracks.items() if len(t) >= 3}


# ---------------------------------------------------------------- geometry

def rotate(v: np.ndarray, r: np.ndarray) -> np.ndarray:
    """Rotate vectors v (N x 3) by Rodrigues vectors r (N x 3)."""
    th = np.linalg.norm(r, axis=1)[:, None]
    with np.errstate(invalid="ignore", divide="ignore"):
        k = np.where(th > 1e-12, r / th, 0.0)
    c, s = np.cos(th), np.sin(th)
    return v * c + np.cross(k, v) * s + k * np.sum(k * v, axis=1)[:, None] * (1 - c)


def project(X: np.ndarray, rv: np.ndarray, tv: np.ndarray, f: float, c: np.ndarray) -> np.ndarray:
    P = rotate(X, rv) + tv
    return f * P[:, :2] / P[:, 2:3] + c


def triangulate(K, R1, t1, R2, t2, a, b):
    P1 = K @ np.hstack([R1, t1.reshape(3, 1)])
    P2 = K @ np.hstack([R2, t2.reshape(3, 1)])
    X = cv2.triangulatePoints(P1, P2, np.float64(a).T, np.float64(b).T)
    return (X[:3] / X[3]).T


def reproj_err(K, R, t, X, x):
    P = (R @ X.T).T + t
    q = (K @ P.T).T
    return np.linalg.norm(q[:, :2] / q[:, 2:3] - x, axis=1), P[:, 2]


class Recon:
    """Incremental reconstruction for one focal length."""

    def __init__(self, tracks, n_frames: int, size: tuple[int, int], f: float):
        self.tracks, self.n, (self.w, self.h), self.f = tracks, n_frames, size, f
        self.c = np.array([self.w / 2, self.h / 2])
        self.K = np.array([[f, 0, self.c[0]], [0, f, self.c[1]], [0, 0, 1]], np.float64)
        self.poses: dict[int, tuple[np.ndarray, np.ndarray]] = {}
        self.X: dict[int, np.ndarray] = {}

    def common(self, a, b):
        ids = [i for i, t in self.tracks.items() if a in t and b in t]
        return ids, np.float64([self.tracks[i][a] for i in ids]), np.float64([self.tracks[i][b] for i in ids])

    def init(self) -> bool:
        a = 0
        best = None
        for b in range(1, self.n):
            ids, pa, pb = self.common(a, b)
            if len(ids) < 40:
                break
            disp = np.median(np.linalg.norm(pa - pb, axis=1))
            if disp < max(12.0, 0.025 * self.w):
                continue
            E, m = cv2.findEssentialMat(pa, pb, self.K, cv2.RANSAC, 0.999, 1.0)
            if E is None or E.shape != (3, 3):
                continue
            Hm, hm = cv2.findHomography(pa, pb, cv2.RANSAC, 2.0)
            # a pure rotation / a plane fits a homography as well: wait for real parallax
            if hm is not None and m is not None and hm.sum() > 0.9 * m.sum() and b < self.n - 1:
                continue
            _, R, t, mp = cv2.recoverPose(E, pa, pb, self.K, mask=m)
            best = (b, R, t.reshape(3), ids, pa, pb, mp.reshape(-1) > 0)
            break
        if best is None:
            return False
        b, R, t, ids, pa, pb, ok = best
        self.poses[a] = (np.eye(3), np.zeros(3))
        self.poses[b] = (R, t)
        X = triangulate(self.K, np.eye(3), np.zeros(3), R, t, pa, pb)
        ea, za = reproj_err(self.K, np.eye(3), np.zeros(3), X, pa)
        eb, zb = reproj_err(self.K, R, t, X, pb)
        for i, x, good, e1, e2, z1, z2 in zip(ids, X, ok, ea, eb, za, zb):
            if good and z1 > 0 and z2 > 0 and e1 < 2 and e2 < 2:
                self.X[i] = x
        self.init_pair = (a, b)
        return len(self.X) >= 20

    def pnp(self, k: int) -> bool:
        ids = [i for i in self.X if k in self.tracks[i]]
        if len(ids) < 10:
            return False
        X = np.float64([self.X[i] for i in ids])
        x = np.float64([self.tracks[i][k] for i in ids])
        near = min(self.poses, key=lambda j: abs(j - k))
        rv0, _ = cv2.Rodrigues(self.poses[near][0])
        ok, rv, tv, inl = cv2.solvePnPRansac(X, x, self.K, None, rv0.copy(), self.poses[near][1].reshape(3, 1).copy(), True, 300, 2.0, 0.999)
        if not ok or inl is None or len(inl) < 8:
            return False
        inl = inl.reshape(-1)
        rv, tv = cv2.solvePnPRefineLM(X[inl], x[inl], self.K, None, rv, tv)
        R, _ = cv2.Rodrigues(rv)
        self.poses[k] = (R, tv.reshape(3))
        return True

    def grow(self, k: int):
        """Triangulate the tracks seen in k and in an earlier solved frame far enough away."""
        Rk, tk = self.poses[k]
        Ck = -Rk.T @ tk
        for i, t in self.tracks.items():
            if i in self.X or k not in t:
                continue
            cands = [j for j in t if j in self.poses and j != k]
            if not cands:
                continue
            j = max(cands, key=lambda q: abs(q - k))
            Rj, tj = self.poses[j]
            Cj = -Rj.T @ tj
            X = triangulate(self.K, Rj, tj, Rk, tk, [t[j]], [t[k]])[0]
            v1, v2 = X - Cj, X - Ck
            ang = np.degrees(np.arccos(np.clip(v1 @ v2 / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-12), -1, 1)))
            if ang < 1.0:
                continue
            e1, z1 = reproj_err(self.K, Rj, tj, X[None], np.float64([t[j]]))
            e2, z2 = reproj_err(self.K, Rk, tk, X[None], np.float64([t[k]]))
            if z1[0] > 0 and z2[0] > 0 and e1[0] < 2 and e2[0] < 2:
                self.X[i] = X

    def run(self) -> bool:
        if not self.init():
            return False
        a, b = self.init_pair
        self.grow(b)
        order = list(range(b + 1, self.n)) + list(range(b - 1, a, -1))
        for k in order:
            if self.pnp(k):
                self.grow(k)
        return True

    # ---- bundle adjustment
    def observations(self):
        cams = sorted(self.poses)
        cidx = {c: i for i, c in enumerate(cams)}
        pids = sorted(self.X)
        pidx = {p: i for i, p in enumerate(pids)}
        obs = [(cidx[k], pidx[i], x, y) for i in pids for k, (x, y) in self.tracks[i].items() if k in cidx]
        return cams, pids, np.array(obs, np.float64)

    def adjust(self, refine_f: bool, rounds: int = 2, iters: int = 60) -> float:
        """
        Bundle adjustment: Levenberg–Marquardt with analytic Jacobians (a camera's rotation updated by a small left turn,
        re-linearised every step), the damped normal equations solved sparse and direct. The first camera stays put;
        Huber weights in the robust rounds, plain least squares in the last; between rounds the far-off observations go.
        """
        from scipy.sparse import coo_matrix, diags
        from scipy.sparse.linalg import spsolve
        rms = np.inf
        for rnd in range(rounds):
            cams, pids, obs = self.observations()
            nc, npt = len(cams), len(pids)
            ci, pi, uv = obs[:, 0].astype(int), obs[:, 1].astype(int), obs[:, 2:4]
            m = len(obs)
            fixed = cams.index(0) if 0 in cams else 0
            Rm = np.array([self.poses[c][0] for c in cams])
            tv = np.array([self.poses[c][1] for c in cams], np.float64)
            X = np.array([self.X[p] for p in pids], np.float64)
            f = self.f
            free = np.array([i != fixed for i in range(nc)])
            col = np.cumsum(free) - 1                       # a free camera's slot
            ncf = int(free.sum())
            nprm = 6 * ncf + 3 * npt + (1 if refine_f else 0)
            robust = rnd < rounds - 1 or rounds == 1

            def residual(Rm, tv, X, f):
                P = np.einsum("nij,nj->ni", Rm[ci], X[pi]) + tv[ci]
                return P, f * P[:, :2] / P[:, 2:3] + self.c - uv

            def cost(r, w):
                return float(np.sum(w * np.sum(r * r, axis=1)))

            def weights(r):
                if not robust:
                    return np.ones(m)
                e = np.linalg.norm(r, axis=1)
                return np.where(e <= 1.5, 1.0, 1.5 / np.maximum(e, 1e-12))

            P, r = residual(Rm, tv, X, f)
            w = weights(r)
            cur = cost(r, w)
            lam = 1e-3
            for _ in range(iters):
                # d(u, v)/dP, then the chain into the parameters
                iz = 1.0 / P[:, 2]
                du = np.stack([f * iz, np.zeros(m), -f * P[:, 0] * iz * iz], 1)
                dv = np.stack([np.zeros(m), f * iz, -f * P[:, 1] * iz * iz], 1)
                RX = P - tv[ci]                              # R·X
                # dP/dw = −[R X]×  (a small left turn w), dP/dt = I, dP/dX = R
                skew = np.zeros((m, 3, 3))
                skew[:, 0, 1], skew[:, 0, 2], skew[:, 1, 0], skew[:, 1, 2], skew[:, 2, 0], skew[:, 2, 1] = RX[:, 2], -RX[:, 1], -RX[:, 2], RX[:, 0], RX[:, 1], -RX[:, 0]
                dPdw = skew                                   # (skew above is already −[R X]×)
                rows, cols, vals = [], [], []
                obs_i = np.arange(m)
                fr = free[ci]
                for k, d in ((0, du), (1, dv)):
                    rr = 2 * obs_i + k
                    jw = np.einsum("nj,njk->nk", d, dPdw)        # 3
                    jX = np.einsum("nj,njk->nk", d, Rm[ci])      # 3
                    base = 6 * col[ci]
                    for s in range(3):
                        rows += [rr[fr], rr[fr]]; cols += [base[fr] + s, base[fr] + 3 + s]; vals += [jw[fr, s], d[fr, s]]
                        rows.append(rr); cols.append(6 * ncf + 3 * pi + s); vals.append(jX[:, s])
                    if refine_f:
                        rows.append(rr); cols.append(np.full(m, nprm - 1)); vals.append(P[:, k] * iz)
                J = coo_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(2 * m, nprm)).tocsr()
                W2 = np.repeat(w, 2)
                JtW = J.T.multiply(W2).tocsr()
                A = (JtW @ J).tocsc()
                g = JtW @ r.ravel()
                dA = A.diagonal()
                improved = False
                for _try in range(10):
                    delta = spsolve(A + diags(lam * np.maximum(dA, 1e-9)), -g)
                    dcam = delta[:6 * ncf].reshape(-1, 6)
                    Rn, tn = Rm.copy(), tv.copy()
                    for i in range(nc):
                        if not free[i]:
                            continue
                        dw = dcam[col[i], :3]
                        Rn[i] = cv2.Rodrigues(dw)[0] @ Rm[i]
                        tn[i] = tv[i] + dcam[col[i], 3:]
                    Xn = X + delta[6 * ncf:6 * ncf + 3 * npt].reshape(-1, 3)
                    fn = f + (delta[-1] if refine_f else 0.0)
                    Pn, rn = residual(Rn, tn, Xn, fn)
                    if np.all(Pn[:, 2] > 1e-6):
                        new = cost(rn, w)
                        if new < cur:
                            Rm, tv, X, f, P, r = Rn, tn, Xn, fn, Pn, rn
                            rel = (cur - new) / max(cur, 1e-30)
                            cur, lam, improved = new, max(lam / 3, 1e-9), True
                            break
                    lam *= 5
                if not improved or rel < 1e-10:
                    break
                w = weights(r)
                cur = cost(r, w)
            for i, c in enumerate(cams):
                self.poses[c] = (Rm[i], tv[i])
            for i, p in enumerate(pids):
                self.X[p] = X[i]
            if refine_f:
                self.f = float(f)
                self.K[0, 0] = self.K[1, 1] = self.f
            err = np.linalg.norm(r, axis=1)
            rms = float(np.sqrt(np.mean(err ** 2)))
            if rnd < rounds - 1:
                # drop the observations far off, and the points left with too few
                bad = err > max(2.0, 3 * np.median(err))
                for (c, p, _, _), b in zip(obs, bad):
                    if b:
                        self.tracks[pids[int(p)]].pop(cams[int(c)], None)
                for p in pids:
                    if sum(1 for k in self.tracks[p] if k in self.poses) < 2:
                        self.X.pop(p, None)
        return rms


def estimate_focal(tracks, n: int, size: tuple[int, int], log=print) -> float | None:
    """
    Self-calibration from fundamental matrices (Mendonça–Cipolla): with the principal point at the centre and square
    pixels, the right focal length makes every essential matrix Kᵀ·F·K have two equal singular values. F from about ten
    frame pairs with enough parallax (RANSAC), then a sweep over the field of view and a golden-section refine.
    """
    w, h = size
    c = np.array([w / 2, h / 2])
    gap = max(3, n // 12)
    Fs = []
    for a in range(0, max(1, n - gap), max(1, (n - gap) // 10 or 1)):
        b = min(n - 1, a + gap)
        ids = [i for i, t in tracks.items() if a in t and b in t]
        if len(ids) < 30:
            continue
        pa = np.float64([tracks[i][a] for i in ids]) - c
        pb = np.float64([tracks[i][b] for i in ids]) - c
        if np.median(np.linalg.norm(pa - pb, axis=1)) < 3:
            continue
        F, m = cv2.findFundamentalMat(pa, pb, cv2.FM_RANSAC, 0.7, 0.999)
        if F is None or F.shape != (3, 3) or m is None or m.sum() < 20:
            continue
        Fs.append(F)
    if len(Fs) < 2:
        return None

    def cost(fov_deg: float) -> float:
        f = (w / 2) / np.tan(np.radians(fov_deg) / 2)
        K = np.diag([f, f, 1.0])
        s = 0.0
        for F in Fs:
            sv = np.linalg.svd(K.T @ F @ K, compute_uv=False)
            s += (sv[0] - sv[1]) / max(sv[0] + sv[1], 1e-12)
        return s / len(Fs)

    grid = np.arange(10, 121, 1.0)
    vals = [cost(g) for g in grid]
    k = int(np.argmin(vals))
    lo, hi = grid[max(0, k - 1)], grid[min(len(grid) - 1, k + 1)]
    g = (np.sqrt(5) - 1) / 2
    x1, x2 = hi - g * (hi - lo), lo + g * (hi - lo)
    for _ in range(40):
        if cost(x1) < cost(x2):
            hi, x2 = x2, x1
            x1 = hi - g * (hi - lo)
        else:
            lo, x1 = x1, x2
            x2 = lo + g * (hi - lo)
    fov = (lo + hi) / 2
    log(f"  自标定：{len(Fs)} 对帧，水平视角约 {fov:.1f}°")
    return float(fov)


def solve(frames, tracks, fov: float | None, log=print):
    h, w = frames[0].shape
    given = bool(fov)
    if not fov:
        fov = estimate_focal(tracks, len(frames), (w, h), log)
        if fov is None:
            log("  自标定做不了（视差太小），按 50° 算")
            fov = 50.0
    f = (w / 2) / np.tan(np.radians(fov) / 2)
    rec = Recon({i: dict(t) for i, t in tracks.items()}, len(frames), (w, h), f)
    if not rec.run():
        sys.exit("反求失败：素材里摄像机几乎不动（纯摇镜）或特征太少。纯摇镜用 tools/track.py stabilize / planar 更合适")
    # the focal length from self-calibration is a start: the adjustment refines it (a given --fov stays)
    rms = rec.adjust(refine_f=not given, rounds=3)
    log(f"  {len(rec.poses)}/{len(frames)} 帧，{len(rec.X)} 点，重投影 {rms:.2f} px，水平视角 {np.degrees(2 * np.arctan((w / 2) / rec.f)):.2f}°")
    return rec, rms


def to_comp(rec: Recon, comp: tuple[int, int], ground=None):
    """The solve in comp px (AE): frame 0's camera = AE's default camera, the median depth on z = 0."""
    W, H = comp
    zoom = rec.f * W / rec.w
    pts = np.array([rec.X[i] for i in sorted(rec.X)])
    R0, t0 = rec.poses[0] if 0 in rec.poses else rec.poses[min(rec.poses)]
    depth = np.median((R0 @ pts.T).T[:, 2] + t0[2])
    k = zoom / max(depth, 1e-9)
    # world → comp: x_comp = k·G·x_world + o  (G: the ground alignment, identity without it)
    G = np.eye(3)
    gy = None
    if ground is not None:
        n, p0 = ground
        # the plane's normal to −y (up on screen), keeping the camera on the "up" side
        C0 = -R0.T @ t0
        if n @ (C0 - p0) < 0:
            n = -n
        target = np.array([0.0, -1.0, 0.0])
        v = np.cross(n, target)
        s, c = np.linalg.norm(v), n @ target
        if s > 1e-9:
            vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
            G = np.eye(3) + vx + vx @ vx * ((1 - c) / s ** 2)
    C0 = -R0.T @ t0
    o = np.array([W / 2, H / 2, -zoom]) - k * (G @ C0)
    cams = []
    for i in range(rec.n):
        if i not in rec.poses:
            cams.append(None)
            continue
        R, t = rec.poses[i]
        C = -R.T @ t
        P = k * (G @ C) + o
        M = G @ R.T  # camera axes (right, down, forward) as columns in comp space
        q = rot_to_quat(M)
        cams.append([round(float(v), 4) for v in (*P, *q)])
    comp_pts = (k * (G @ pts.T)).T + o
    if ground is not None:
        n, p0 = ground
        gy = float((k * (G @ p0) + o)[1])
    return zoom, cams, comp_pts, gy


def rot_to_quat(M: np.ndarray):
    t = np.trace(M)
    if t > 0:
        s = np.sqrt(t + 1.0) * 2
        return (M[2, 1] - M[1, 2]) / s, (M[0, 2] - M[2, 0]) / s, (M[1, 0] - M[0, 1]) / s, 0.25 * s
    i = int(np.argmax(np.diag(M)))
    if i == 0:
        s = np.sqrt(1.0 + M[0, 0] - M[1, 1] - M[2, 2]) * 2
        return 0.25 * s, (M[0, 1] + M[1, 0]) / s, (M[0, 2] + M[2, 0]) / s, (M[2, 1] - M[1, 2]) / s
    if i == 1:
        s = np.sqrt(1.0 + M[1, 1] - M[0, 0] - M[2, 2]) * 2
        return (M[0, 1] + M[1, 0]) / s, 0.25 * s, (M[1, 2] + M[2, 1]) / s, (M[0, 2] - M[2, 0]) / s
    s = np.sqrt(1.0 + M[2, 2] - M[0, 0] - M[1, 1]) * 2
    return (M[0, 2] + M[2, 0]) / s, (M[1, 2] + M[2, 1]) / s, 0.25 * s, (M[1, 0] - M[0, 1]) / s


def fit_ground(rec: Recon, at: int, box):
    """A plane through the solved points that frame `at` sees inside box (RANSAC, then least squares)."""
    x0, y0, x1, y1 = box
    ids = [i for i in rec.X if at in rec.tracks[i] and x0 <= rec.tracks[i][at][0] <= x1 and y0 <= rec.tracks[i][at][1] <= y1]
    if len(ids) < 8:
        sys.exit(f"--ground：那块区域里只有 {len(ids)} 个三维点，框大一点或换一帧")
    P = np.array([rec.X[i] for i in ids])
    rng = np.random.default_rng(0)
    best, bi = None, None
    scale = np.median(np.linalg.norm(P - P.mean(0), axis=1))
    for _ in range(300):
        s = P[rng.choice(len(P), 3, replace=False)]
        n = np.cross(s[1] - s[0], s[2] - s[0])
        if np.linalg.norm(n) < 1e-12:
            continue
        n /= np.linalg.norm(n)
        inl = np.abs((P - s[0]) @ n) < 0.02 * scale
        if bi is None or inl.sum() > bi.sum():
            best, bi = (n, s[0]), inl
    Q = P[bi]
    c = Q.mean(0)
    _, _, Vt = np.linalg.svd(Q - c)
    return Vt[2], c


def make_test(name: str):
    """A textured room filmed by a known moving camera (tools/test_camtrack.py's scene), as footage for trying the solve."""
    import test_camtrack as T
    out = Path("assets/footage") / name
    out.mkdir(parents=True, exist_ok=True)
    _, _, cams = T.truth(90)
    for i, (M, C) in enumerate(cams):
        cv2.imwrite(str(out / f"{i + 1:05d}.png"), cv2.cvtColor(T.render(None, None, M, C), cv2.COLOR_GRAY2BGR))
    meta = {"fps": 30, "first": 1, "last": len(cams), "width": T.W, "height": T.H, "pattern": "#####.png", "duration": len(cams) / 30, "source": "camtrack --test"}
    (out / "meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    fov = float(np.degrees(2 * np.arctan((T.W / 2) / T.F_TRUE)))
    print(f"写好 {out}：{len(cams)} 帧 {T.W}×{T.H}，真实水平视角 {fov:.2f}°（地面在第 1 帧的下半部分）")


def main(argv=None):
    ap = argparse.ArgumentParser(description="3D 摄像机反求（见文件开头）")
    ap.add_argument("dir", nargs="?", help="footage.py 抽的帧目录（有 meta.json）")
    ap.add_argument("--test", metavar="NAME", help="渲一段测试素材到 assets/footage/NAME/")
    ap.add_argument("--fov", type=float, help="水平视角（度）；不给就自己搜")
    ap.add_argument("--comp", help="合成尺寸 宽x高（默认和素材一样）")
    ap.add_argument("--ground", help="地面区域 x0,y0,x1,y1（--at 那一帧的素材像素）")
    ap.add_argument("--at", type=int, default=1, help="--ground 用的帧号")
    ap.add_argument("--features", type=int, default=1500)
    ap.add_argument("--name", default="camera")
    ap.add_argument("--from", dest="frm", type=int)
    ap.add_argument("--to", type=int)
    a = ap.parse_args(argv)
    if a.test:
        make_test(a.test)
        return None
    if not a.dir:
        ap.error("给帧目录，或者 --test NAME")
    d = Path(a.dir)
    meta = load_meta(d)
    paths = frame_paths(d, meta)
    lo = (a.frm or meta["first"]) - meta["first"]
    hi = (a.to or meta["last"]) - meta["first"]
    paths = paths[lo:hi + 1]
    frames = [gray(p) for p in paths]
    h, w = frames[0].shape
    print(f"跟踪特征点（{len(frames)} 帧）……")
    tracks = track_features(frames, a.features)
    print(f"  {len(tracks)} 条轨迹")
    print("反求……")
    rec, rms = solve(frames, tracks, a.fov)
    comp = tuple(int(v) for v in a.comp.split("x")) if a.comp else (w, h)
    ground = fit_ground(rec, a.at - meta["first"] - lo, [float(v) for v in a.ground.split(",")]) if a.ground else None
    zoom, cams, pts, gy = to_comp(rec, comp, ground)
    fov = float(np.degrees(2 * np.arctan((w / 2) / rec.f)))
    res = {"type": "camera", "fps": meta["fps"], "first": meta["first"] + lo, "frames": len(frames), "size": [w, h], "comp": list(comp),
           "zoom": round(zoom, 3), "fov": round(fov, 3), "cameras": cams, "cloud": [[round(float(v), 2) for v in p] for p in pts], "rms": round(rms, 4)}
    if gy is not None:
        res["ground"] = {"y": round(gy, 2)}
    out = d / f"track_{a.name}.json"
    out.write_text(json.dumps(res), encoding="utf-8")
    solved = sum(1 for c in cams if c is not None)
    print(f"写好 {out}：{solved}/{len(frames)} 帧有摄像机，{len(pts)} 个三维点，水平视角 {fov:.1f}°，重投影误差 {rms:.2f} px")
    return res


if __name__ == "__main__":
    main()

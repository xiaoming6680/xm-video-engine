"""Pose an MMD arm by where its parts should point (from Still_Shining v10): give the upper-arm and forearm directions,
get the Euler angles for 左腕 / 左ひじ (and mirrored for 右腕 / 右ひじ) in the pose format the scenes use: degrees
[x, y, z], order 'YXZ', applied on top of the rest pose (Still_Shining teto3d.ts setPose).

Why: guessing Euler angles for an A-pose model goes wrong in ways that read as unnatural from some angle (Still
Shining v9: both arms held straight out like a puppet; v8: lowered arms sank into the body and read as one-armed).
Directions are what a pose drawing says: "upper arm out and forward, forearm up toward the chest".

  python tools/pose_arm.py '[{"lu": [0.75,-0.3,0.58], "lf": [0.35,0.3,0.88], "ru": [0.55,-0.72,0.42], "rf": [0.1,-0.35,0.93]}]'

Directions are in her torso's frame: x = her left (for the right arm: x = her right, i.e. give both arms as if
outward-positive), y = up, z = her front; they need not be unit length. `lt` / `rt` (deg) roll an upper arm about
itself. --rest: the left upper arm's rest direction (shoulder -> elbow bone positions; dump them with the scene's
bone dump). Default: Tda式テト (A-pose, ~38 deg below horizontal). Check the result on a turntable from 4 sides.
"""
import argparse
import json

import numpy as np
from scipy.spatial.transform import Rotation as R


def minrot(a, b):
    a = a / np.linalg.norm(a); b = b / np.linalg.norm(b)
    v = np.cross(a, b); c = np.dot(a, b)
    if np.linalg.norm(v) < 1e-9:
        return R.identity()
    return R.from_rotvec(v / np.linalg.norm(v) * np.arctan2(np.linalg.norm(v), c))


def eul(r):
    y, x, z = r.as_euler('YXZ', degrees=True)
    return [round(x, 1), round(y, 1), round(z, 1)]


def arm(u0, u, f, twist=0.0):
    """Left-arm Euler pair (arm, elbow) taking the rest direction u0 to upper arm u and forearm f."""
    u = np.array(u, float); f = np.array(f, float)
    ra = minrot(u0, u) * R.from_rotvec(u0 / np.linalg.norm(u0) * np.radians(twist))
    re = minrot(u0, ra.inv().apply(f / np.linalg.norm(f)))
    return eul(ra), eul(re)


def mirror(e):
    """x -> -x mirror of an Euler triple (x, y, z) -> (x, -y, -z)."""
    return [e[0], -e[1], -e[2]]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('specs', help='JSON list of {"lu","lf","ru","rf"[,"lt","rt"]} directions')
    ap.add_argument('--rest', default='2.13,-1.66,-0.04', help='left upper arm rest direction (model space)')
    a = ap.parse_args()
    u0 = np.array([float(x) for x in a.rest.split(',')])
    out = []
    for s in json.loads(a.specs):
        la, le = arm(u0, s['lu'], s['lf'], s.get('lt', 0))
        ra, rel = arm(u0, s['ru'], s['rf'], s.get('rt', 0))
        out.append({'lArm': la, 'lElbow': le, 'rArm': mirror(ra), 'rElbow': mirror(rel)})
    print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    main()

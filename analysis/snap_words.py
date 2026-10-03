"""Snap word starts in data/lyrics.json to the 16th-note grid (data/audio.json beats).

For synthesized / quantised vocals (Still_Shining's Teto) that sit on the grid, while the CTC word starts scatter
by up to half a 16th. Skip it for a human singer who phrases off the grid. Each
start moves to the nearest 16th; a word's end becomes the next word's start when they touch (gap < one 16th),
otherwise it is snapped as well. Line start/end follow the words. Keeps the raw times as start_raw/end_raw.

  python analysis/snap_words.py
"""
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
A = json.loads((ROOT / "data" / "audio.json").read_text(encoding="utf-8"))
beats = np.array(A["beats"])
P = float(np.median(np.diff(beats)))
grid0 = beats[0]
Q = P / 4


def snap(t):
    return float(grid0 + round((t - grid0) / Q) * Q)


doc = json.loads((ROOT / "data" / "lyrics.json").read_text(encoding="utf-8"))
moved = []
for L in doc["lines"]:
    ws = L["words"]
    for w in ws:
        w.setdefault("start_raw", w["start"]); w.setdefault("end_raw", w["end"])
        w["start"] = round(snap(w["start_raw"]), 3)
    for i, w in enumerate(ws):
        if i > 0 and w["start"] <= ws[i - 1]["start"]:
            w["start"] = round(ws[i - 1]["start"] + Q, 3)
        moved.append(abs(w["start"] - w["start_raw"]))
    for i, w in enumerate(ws):
        nxt = ws[i + 1]["start"] if i + 1 < len(ws) else None
        e = snap(w["end_raw"])
        if nxt is not None and (nxt - w["end_raw"] < Q or e > nxt):
            e = nxt
        w["end"] = round(max(e, w["start"] + Q * 0.5), 3)
    L["start"], L["end"] = ws[0]["start"], ws[-1]["end"]
doc["notes"] += " Word starts snapped to the 16th grid (analysis/snap_words.py); raw CTC times in start_raw/end_raw."
(ROOT / "data" / "lyrics.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
m = np.array(moved) * 1000
print(f"snapped {len(m)} words: median move {np.median(m):.0f} ms, max {m.max():.0f} ms (16th = {Q*1000:.0f} ms)")

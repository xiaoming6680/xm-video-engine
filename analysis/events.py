"""Sound-event map of the song -> data/events.json (from Falling_Again; the user: 仔细分析歌曲里的各个元素（乐器）).
Thresholds were tuned on that song: check the --bars table against what you hear and adjust per song.

Every salient hit, typed and timed, so each one can drive something on screen instead of the beat grid guessing:
  kick, snare, clap, hat, crash (cymbal: bright, broadband, long decay), perc (the rest)   — drums stem
  fx_hit (broadband non-drum impact / stab), riser (rising build into a boundary)          — other stem / mix
  bass_in / bass_out (bass drop-outs and re-entries), sub (the 808 / sub notes' attacks)   — bass stem
  stop (whole-mix drop-outs)
  chop (vocal-stem onsets outside the sung words: the chopped vocal hooks)
Each event: {t (video s), type, s (strength 0..1), q (nearest 16th from the first downbeat), dq (ms off it),
bar (from 0), step (0..15)}. Drum hits: spectral-flux onsets of the drums stem, typed from the band energies that rise
at the attack and the decay (adapted from the Clarity project's events.py, with a crash class for this song).

  python analysis/events.py          writes data/events.json and the onset lists in data/audio.json
  python analysis/events.py --bars   + prints a per-bar table (what plays on which 16th)
"""
import json
import math
import sys
from collections import Counter
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from scipy.ndimage import uniform_filter1d

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
SR = 44100
HOP = 128
BANDS = {"sub": (20, 90), "low": (90, 250), "mid": (250, 2000), "high": (2000, 7000), "air": (7000, 18000)}


def load(path, sr=SR):
    y, s = sf.read(str(path), dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    return librosa.resample(y, orig_sr=s, target_sr=sr) if s != sr else y


def frame_rms(x, sr, fps=100, win=2048):
    hop = sr / fps
    n = int(math.ceil(len(x) / sr * fps))
    pad = np.pad(x, (win // 2, win // 2 + int(hop) + 2))
    idx = (np.arange(n) * hop).astype(int)
    c = np.concatenate([[0.0], np.cumsum(pad.astype(np.float64) ** 2)])
    return np.sqrt(np.maximum((c[idx + win] - c[idx]) / win, 0))


def flux_onsets(y, sr=SR, delta=0.07, wait_s=0.045, n_mels=128, fmin=20):
    o = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP, n_mels=n_mels, fmin=fmin, lag=1, max_size=3)
    o = o / (np.percentile(o, 99.5) + 1e-9)
    pk = librosa.onset.onset_detect(onset_envelope=o, sr=sr, hop_length=HOP, units="frames", backtrack=False,
                                    delta=delta, wait=int(wait_s * sr / HOP), pre_max=3, post_max=3,
                                    pre_avg=int(0.1 * sr / HOP), post_avg=int(0.02 * sr / HOP))
    env = frame_rms(y, sr, fps=sr / HOP, win=256)
    d = np.diff(20 * np.log10(env + 1e-9), prepend=0)
    ts = []
    for p in pk:   # attack = steepest rise in the 25 ms before the flux peak
        a = max(0, p - int(0.025 * sr / HOP))
        ts.append((a + int(np.argmax(d[a:p + 1]))) * HOP / sr)
    return np.array(ts), o[pk]


def band_profile(S, freqs, t, pre=0.015, post=0.06):
    i0, i1, j1 = int((t - pre) * SR / HOP), int(t * SR / HOP), int((t + post) * SR / HOP)
    out = {}
    for b, (lo, hi) in BANDS.items():
        m = (freqs >= lo) & (freqs < hi)
        before = S[m, max(0, i0):max(i0 + 1, i1)].sum(axis=0).mean()
        after = S[m, i1:max(i1 + 1, j1)].sum(axis=0).max()
        out[b] = 10 * np.log10(after + 1e-12)
        out[b + "_rise"] = out[b] - 10 * np.log10(before + 1e-12)
    return out


def decay_ms(env_db, fr, t, drop=20):
    i = int(t * fr)
    seg = env_db[i:i + int(0.9 * fr)]
    if len(seg) < 3:
        return 0.0
    pk = int(np.argmax(seg[:int(0.05 * fr) + 1]))
    below = np.where(seg[pk:] < seg[pk] - drop)[0]
    return float((below[0] if len(below) else len(seg) - pk) / fr * 1000)


def classify(p, dec):
    a = {b: (p[b] if p[b + "_rise"] > 3 else -99.0) for b in BANDS}
    m = max(a.values())
    hi = max(a["high"], a["air"])
    if a["sub"] >= m - 3 and a["low"] >= m - 6:
        return "kick"
    if hi >= m - 3 and a["high"] >= m - 6 and a["air"] >= m - 8 and dec >= 280:
        return "crash"
    if a["low"] >= m - 5 and a["mid"] >= m - 6 and a["high"] >= m - 12 and a["sub"] <= a["low"] - 4:
        return "snare"
    if a["mid"] >= m - 3 and a["high"] >= m - 6 and a["low"] <= m - 12 and dec >= 50:
        return "clap"
    if hi >= m - 2 and a["mid"] <= hi - 3 and a["low"] <= m - 15:
        return "hat"
    return "perc"


def main(report=False):
    audio = json.loads((DATA / "audio.json").read_text(encoding="utf-8"))
    lp = DATA / "lyrics.json"   # 纯音乐没有歌词文件：人声切片不用避开歌词
    lyr = json.loads(lp.read_text(encoding="utf-8")) if lp.exists() else {"lines": []}
    B = np.array(audio["beats"])

    def quant(t):
        i = int(np.clip(np.searchsorted(B, t) - 1, 0, len(B) - 2))
        pos = i + (t - B[i]) / (B[i + 1] - B[i])
        q = int(round(pos * 4))
        return q, round((pos * 4 - q) * (B[i + 1] - B[i]) / 4 * 1000, 1)

    events = []

    def add(t, typ, s, **kw):
        q, dq = quant(t)
        events.append(dict(t=round(float(t), 3), type=typ, s=round(float(min(1, max(0, s))), 3), q=q, dq=dq, bar=q // 16, step=q % 16, **kw))

    # ---- drums
    d = load(ROOT / "audio" / "stems4" / "drums.wav")
    S = np.abs(librosa.stft(d, n_fft=1024, hop_length=HOP)) ** 2
    freqs = librosa.fft_frequencies(sr=SR, n_fft=1024)
    fr = SR / HOP
    env_db = 20 * np.log10(frame_rms(d, SR, fps=fr, win=512) + 1e-9)
    ts, st = flux_onsets(d)
    pdb = np.array([env_db[int(t * fr):int(t * fr) + int(0.04 * fr)].max() for t in ts])
    keep = pdb > np.percentile(pdb, 99) - 34
    for t, s, lv in zip(ts[keep], st[keep], pdb[keep]):
        p = band_profile(S, freqs, t)
        dec = decay_ms(env_db, fr, t)
        add(t, classify(p, dec), 0, db=round(float(lv), 1), decay=round(dec))
    for typ in ("kick", "snare", "clap", "hat", "crash", "perc"):
        ev = [e for e in events if e["type"] == typ]
        if ev:
            lv = np.array([e["db"] for e in ev]); lo, hi = np.percentile(lv, 5), np.percentile(lv, 97)
            for e, v in zip(ev, lv):
                e["s"] = round(float(np.clip(0.15 + 0.85 * (v - lo) / (hi - lo + 1e-9), 0, 1)), 3)

    # ---- bass: drop-outs / re-entries, and its note attacks (the sub hits)
    b = load(ROOT / "audio" / "stems4" / "bass.wav")
    be = uniform_filter1d(20 * np.log10(frame_rms(b, SR, fps=100) + 1e-9), 3)
    on = be > np.percentile(be[be > -80], 60) - 18
    state = False
    for i in range(len(on)):
        if on[i] != state and np.all(on[i:i + 8] == on[i]):
            add(i / 100, "bass_in" if on[i] else "bass_out", 1.0)
            state = on[i]
    bt, bs = flux_onsets(b, delta=0.12, wait_s=0.1, fmin=20)
    bmx = np.percentile(bs, 99) + 1e-9
    for t, s in zip(bt, bs):
        if s > 0.25 * bmx:
            add(t, "sub", s / bmx)

    # ---- whole-mix stops
    m = load(ROOT / "audio" / "song.wav")
    me = 20 * np.log10(frame_rms(m, SR, fps=100) + 1e-9)
    loud = uniform_filter1d(me, 50)
    for i in range(20, len(me) - 20):
        if me[i - 5:i].mean() - me[i:i + 15].mean() > 12 and loud[i - 1] > -30:
            if not any(e["type"] == "stop" and abs(e["t"] - i / 100) < 0.5 for e in events):
                add(i / 100, "stop", min(1, (me[i - 5:i].mean() - me[i:i + 15].mean()) / 30))

    # ---- other stem: impacts / stabs; risers into downbeats (in the instrumental)
    o = load(ROOT / "audio" / "stems4" / "other.wav")
    ot, os_ = flux_onsets(o, delta=0.12, wait_s=0.08)
    So = np.abs(librosa.stft(o, n_fft=1024, hop_length=HOP)) ** 2
    oe = 20 * np.log10(frame_rms(o, SR, fps=fr, win=512) + 1e-9)
    thr = np.percentile(os_, 80)
    for t, s in zip(ot, os_):
        if s < thr:
            continue
        p = band_profile(So, freqs, t)
        if sum(p[k + "_rise"] > 6 for k in BANDS) >= 3:
            add(t, "fx_hit", s / (np.percentile(os_, 99) + 1e-9), decay=round(decay_ms(oe, fr, t)))
    inst = load(ROOT / "audio" / "stems" / "instrumental.wav")
    hb = librosa.feature.spectral_centroid(y=inst, sr=SR, hop_length=512)[0]
    he = 20 * np.log10(frame_rms(librosa.effects.preemphasis(inst, coef=0.97), SR, fps=SR / 512, win=2048) + 1e-9)
    n = min(len(hb), len(he)); cf = SR / 512
    sm_c, sm_e = uniform_filter1d(np.log(hb[:n] + 1), int(0.25 * cf)), uniform_filter1d(he[:n], int(0.25 * cf))
    for k, dbt in enumerate(audio["downbeats"]):
        for span in (8, 4, 2):
            if 4 * k - span < 0:
                continue
            a, z = B[4 * k - span], dbt - 0.03
            ia, iz = int(a * cf), int(z * cf)
            if a < 0 or iz - ia < 10 or iz > n:
                continue
            x = np.arange(iz - ia)
            kc = np.polyfit(x / cf, sm_c[ia:iz], 1)[0]; ke = np.polyfit(x / cf, sm_e[ia:iz], 1)[0]
            r = np.corrcoef(x, sm_c[ia:iz])[0, 1]
            if kc > 0.12 and ke > 1.5 and r > 0.8:
                add(a, "riser", min(1, kc * 2), end=round(float(dbt), 3), beats=span)
                break

    # ---- vocal chops: vocal-stem onsets outside the sung words
    v = load(ROOT / "audio" / "stems" / "vocals.wav")
    vt, vs = flux_onsets(v, delta=0.1, wait_s=0.09, fmin=150)
    words = [(w["start"] - 0.06, w["end"] + 0.03) for l in lyr["lines"] for w in l["words"]]
    ve = 20 * np.log10(frame_rms(v, SR, fps=fr, win=512) + 1e-9)
    for t, s in zip(vt, vs):
        if any(a <= t <= z for a, z in words):
            continue
        if ve[int(t * fr):int(t * fr) + int(0.05 * fr)].max() < np.percentile(ve, 90) - 24:
            continue
        add(t, "chop", s / (np.percentile(vs, 99) + 1e-9))

    events.sort(key=lambda e: e["t"])
    (DATA / "events.json").write_text(json.dumps(dict(events=events), ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    pick = lambda *tp: [[e["t"], e["s"]] for e in events if e["type"] in tp]
    audio["onsets"].update(kick=pick("kick"), snare=pick("snare", "clap"), hat=pick("hat"), perc=pick("perc", "crash"))
    (DATA / "audio.json").write_text(json.dumps(audio, separators=(",", ":")), encoding="utf-8")
    print("events", len(events), dict(Counter(e["type"] for e in events)))
    dqs = np.array([e["dq"] for e in events if e["type"] in ("kick", "snare", "clap")])
    print(f"drum hits off the 16th grid: median {np.median(np.abs(dqs)):.1f} ms, p90 {np.percentile(np.abs(dqs), 90):.1f} ms")

    if report:
        sym = {"kick": "K", "snare": "S", "clap": "C", "hat": "h", "crash": "X", "perc": "p", "sub": "b", "chop": "v", "fx_hit": "F"}
        def bar_t(k):   # 第 k 小节起点；节拍网格外（结尾的尾音）按最后一拍的间隔外推，和 quant() 一样
            return B[4 * k] if 4 * k < len(B) else B[-1] + (4 * k - len(B) + 1) * (B[-1] - B[-2])
        nb = 0
        while bar_t(nb) < audio["duration"]:   # 从第一个强拍 B[0] 数到歌曲结尾
            nb += 1
        for bar in range(nb):
            cells = []
            for step in range(16):
                here = [e for e in events if e["bar"] == bar and e["step"] == step]
                s = "".join(sorted({sym.get(e["type"], "") for e in here}, key="KSCXhpbvF".index))
                cells.append(s or ".")
            extra = [f"{e['type']}@{e['step']}" for e in events if e["bar"] == bar and e["type"] in ("bass_in", "bass_out", "stop", "riser")]
            print(f"bar {bar + 1:2d} {bar_t(bar):6.2f}s | " + " ".join(f"{c:<3}" for c in cells) + ("  " + " ".join(extra) if extra else ""))


if __name__ == "__main__":
    main("--bars" in sys.argv)

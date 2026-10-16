"""Music analysis -> data/audio.json (same schema as the pdoom engine's data/audio.json).

  * constant-tempo beat grid (tempo searched over 60-200 BPM, or near BPM_HINT, on drum / mix
    onsets; 4:3 / half / double look-alikes ruled out on the stems, see fit_grid; phase refined
    on kick attacks), downbeats, sections on downbeats (SECTION_BARS),
  * 100 fps normalized envelopes (mix rms / low / mid / high, stem rms),
  * kick / snare / hat onsets from the drums stem, vocal note onsets.

Timeline = the FLAC / audio/song.wav timeline (no encoder delay; stems are
sample-aligned with song.wav).

Run:  python analysis/analyze.py            (writes data/audio.json)
      python analysis/analyze.py --bars     (prints the per-bar feature table used to place SECTION_BARS)
"""
import json
import math
import sys
from fractions import Fraction
from pathlib import Path

import numpy as np
import librosa
import soundfile as sf
from scipy.ndimage import maximum_filter1d, median_filter, uniform_filter1d
from scipy.signal import butter, find_peaks, sosfiltfilt

ROOT = Path(__file__).resolve().parents[1]
AUDIO = ROOT / "audio"
DATA = ROOT / "data"
SR = 44100
FPS = 100

# Section map in bars (name, first bar, end bar; None = song start / end). PER SONG: run `--bars` first, read the
# per-bar table (stem jumps land on bar lines) and the lyric line starts, then fill this in, e.g.
#   [("intro", None, 8), ("verse", 8, 24), ("chorus", 24, 40), ("outro", 40, None)]
# (Still_Shining's map had stop / chorus / hang / breakdown / outro / end.)
SECTION_BARS = [
    ("song", None, None),
]

# Tempo. None = search BPM_RANGE: the printed tempo and the candidates it beat (with the reason) come first in the
# output. If it is not what you hear (half, double, 3:4 of it), put the approximate tempo here, e.g. 134: the search
# then stays within ±4 % of it.
BPM_HINT = None
BPM_RANGE = (60.0, 200.0)


# ---------------------------------------------------------------------------
def load(path, sr=SR):
    y, s = sf.read(str(path), dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    if s != sr:
        y = librosa.resample(y, orig_sr=s, target_sr=sr)
    return y


def band_sos(lo, hi, sr):
    if lo and hi:
        return butter(4, [lo, hi], btype="band", fs=sr, output="sos")
    if hi:
        return butter(4, hi, btype="low", fs=sr, output="sos")
    return butter(4, lo, btype="high", fs=sr, output="sos")


def frame_rms(x, sr, fps=FPS, win=2048):
    hop = sr / fps
    n = int(math.ceil(len(x) / sr * fps))
    pad = np.pad(x, (win // 2, win // 2 + int(hop) + 2))
    idx = (np.arange(n) * hop).astype(int)
    c = np.concatenate([[0.0], np.cumsum(pad.astype(np.float64) ** 2)])
    e = (c[idx + win] - c[idx]) / win
    return np.sqrt(np.maximum(e, 0))


def smooth_env(x, fps=FPS, attack=0.010, release=0.090):
    """One-pole follower: fast attack, slower release (visual friendly)."""
    aa = math.exp(-1 / (attack * fps))
    ar = math.exp(-1 / (release * fps))
    y = np.empty_like(x)
    s = 0.0
    for i, v in enumerate(x):
        a = aa if v > s else ar
        s = a * s + (1 - a) * v
        y[i] = s
    return y


def norm01(x, pct=99.0):
    ref = np.percentile(x, pct)
    return np.clip(x / (ref + 1e-12), 0, 1)


# ---------------------------------------------------------------------------
def band_onsets(x, sr, lo, hi, win=0.010, hop_s=0.002, min_gap=0.08, rel_db=10.0):
    """Onsets in a frequency band: steepest rise of the band's log-energy
    envelope; strength = peak dB.  Returns (times, peak_db)."""
    xb = sosfiltfilt(band_sos(lo, hi, sr), x)
    h = int(hop_s * sr)
    w = int(win * sr)
    e = np.convolve(xb.astype(np.float64) ** 2, np.ones(w) / w, mode="same")[::h]
    db = 10 * np.log10(e + 1e-10)
    fps = sr / h
    d = uniform_filter1d(np.diff(db, prepend=db[0]), 3)
    lag = int(0.02 * fps)
    rise = db - np.concatenate([np.full(lag, db[0]), db[:-lag]])
    floor = median_filter(db, int(1.0 * fps) | 1)
    pk, _ = find_peaks(rise, height=rel_db, distance=int(min_gap * fps))
    times, strength = [], []
    for p in pk:
        a = max(0, p - lag)
        q = a + int(np.argmax(d[a:p + 1]))
        peak_db = db[p:p + int(0.03 * fps)].max()
        if peak_db < floor[p] + 3:
            continue
        times.append(q / fps)
        strength.append(peak_db)
    return np.array(times), np.array(strength)


def comb_grid(o, fps, bpm):
    """Envelope values on a beat grid of this tempo: rows = beats, columns = phase (frames after the beat)."""
    Pf = 60 / bpm * fps
    K = int((len(o) - 2) / Pf)
    idx = np.round(np.arange(K) * Pf).astype(int)[:, None] + np.arange(int(math.ceil(Pf)))
    return o[np.minimum(idx, len(o) - 1)]


def tempo_curve(o, fps, bpms, win=16):
    """Comb-filter tempogram: per tempo, the mean onset strength on its beat grid at the best phase of each 16-beat
    window (so a tempo a hair off still scores), averaged over the song."""
    out = np.empty(len(bpms))
    for i, bpm in enumerate(bpms):
        M = comb_grid(o, fps, bpm)
        out[i] = np.add.reduceat(M, np.arange(0, len(M), win), axis=0).max(axis=1).sum() / len(M)
    return out


def refine_tempo(o, fps, bpm):
    """Tempo within ±0.12 BPM (to 0.001) and phase with the best mean onset strength on the whole-song grid."""
    best = (-1.0, bpm, 0.0)
    for span, step in ((0.12, 0.01), (0.012, 0.001)):
        c = best[1]
        for b in np.arange(c - span, c + span + step / 2, step):
            prof = comb_grid(o, fps, b).mean(axis=0)
            j = int(np.argmax(prof))
            if prof[j] > best[0]:
                best = (float(prof[j]), float(b), j / fps)
    return best


def bar_consistency(env, fps, P, off, beats=4):
    """How alike consecutive bars are: the envelope cut into bars of `beats` beats (max per ~40 ms, the same bin
    length at every tempo so slow and fast candidates compare fairly), each bar correlated with the next; mean
    over the pairs where both bars have something in them."""
    nb = int((len(env) / fps - off) / (beats * P))
    if nb < 3:
        return float("nan")
    per_beat = max(4, int(round(P / 0.04)))
    edges = np.round((off + np.arange(nb * beats * per_beat + 1) * (P / per_beat)) * fps).astype(int)
    R = np.maximum.reduceat(env, np.minimum(edges, len(env) - 1))[:-1].reshape(nb, beats * per_beat)
    live = R.mean(axis=1) > 0.05
    Z = R - R.mean(axis=1, keepdims=True)
    Z /= np.linalg.norm(Z, axis=1, keepdims=True) + 1e-9
    r = (Z[1:] * Z[:-1]).sum(axis=1)[live[1:] & live[:-1]]
    return float(r.mean()) if len(r) else float("nan")


def beat_pos(ts, P, off):
    r = (np.asarray(ts, dtype=float) - off) / P
    b = np.round(r).astype(int)
    return b, np.abs(r - b) < 0.12, np.abs(r - np.floor(r) - 0.5) < 0.12


def backbeat(snare_t, P, off):
    """Snare on 2 and 4: share of the snare hits on every other beat, on both of them (1 = a clean backbeat,
    0.5 = on every beat, 0 = once a bar or between the beats); the better of the two half-beat phases."""
    best = 0.0
    for o_ in (off, off + P / 2):
        b, on, _ = beat_pos(snare_t, P, o_)
        c = np.bincount(b[on] % 4, minlength=4)
        best = max(best, 2 * max(min(c[0], c[2]), min(c[1], c[3])) / max(1, len(snare_t)))
    return best


def on_beats(kick_t, snare_t, P, off):
    """Kick + snare hits on the beats (odd and even beats alike) minus those halfway between them; the better of
    the two half-beat phases. Too slow a tempo puts half the hits between its beats, too fast leaves every other
    beat empty."""
    t = np.r_[kick_t, snare_t]
    if len(t) == 0:
        return 0.0
    best = -1.0
    for o_ in (off, off + P / 2):
        b, on, half = beat_pos(t, P, o_)
        par = np.bincount(b[on] % 2, minlength=2)
        best = max(best, on.mean() * par.min() / max(1, par.max()) - half.mean())
    return best


def ratio_name(r):
    f = Fraction(r).limit_denominator(8)
    if abs(float(f) / r - 1) > 0.005:
        return f"x{r:.3f}"
    return f"x{f.numerator}/{f.denominator}" if f.denominator > 1 else f"x{f.numerator}"


def pick_tempo(cands):
    """cands: dicts with bpm, off, fit (mean onset strength on the grid), bars (bar consistency per stem), bb
    (backbeat), ob (on_beats). Candidates a power of 2 apart form a family; the family whose best member has the
    best fit + bar consistency wins (rules out 4:3, 3:2 ...: their bars do not repeat), then three drum cues vote
    between half and double tempo: the snare on 2 and 4, kick + snare on the beats, and whether the shorter bar
    repeats as well as the longer one (a tie: the one nearer 120 BPM). Prints every candidate and why it lost."""
    top = max(c["fit"] for c in cands)
    for c in cands:
        v = [x for x in c["bars"].values() if np.isfinite(x)]
        c["bar"] = float(np.mean(v)) if v else 0.0
        c["score"] = c["fit"] / top + c["bar"]
    ranked = sorted(cands, key=lambda c: -c["score"])
    fams, why = [], {}
    for c in ranked:
        for f in fams:
            k = math.log2(c["bpm"] / f[0]["bpm"])
            if abs(k - round(k)) < 0.012:
                twin = [d for d in f if abs(math.log2(c["bpm"] / d["bpm"])) < 0.5]
                if twin:
                    why[id(c)] = f"side lobe of {twin[0]['bpm']:.2f}"
                else:
                    f.append(c)
                break
        else:
            fams.append([c])
    levels = sorted(fams[0], key=lambda c: c["bpm"])
    cues = (("snare on 2&4", "bb", 0.1), ("kick+snare on beats", "ob", 0.1), ("drum bars repeat", "drums", 0.03))
    val = lambda c, key: c["bars"]["drums"] if key == "drums" else c[key]
    best = levels[0]
    for c in levels[1:]:   # twice the tempo of the one before: the cues vote between the two
        d = [val(c, key) - val(best, key) for _, key, _ in cues]
        vote = sum(int(np.sign(x)) for x, (_, _, thr) in zip(d, cues) if np.isfinite(x) and abs(x) >= thr)
        tie = vote == 0
        if tie:
            vote = 1 if abs(math.log2(c["bpm"] / 120)) < abs(math.log2(best["bpm"] / 120)) else -1
        win, lose = (c, best) if vote > 0 else (best, c)
        why[id(lose)] = ", ".join(f"{name} {val(win, key):.2f} vs {val(lose, key):.2f}" for name, key, _ in cues) + \
            (" (no clear vote: the one nearer 120 BPM)" if tie else "")
        best = win
    for f in fams[1:]:
        for c in f:
            why[id(c)] = f"fit + bar consistency {c['score']:.2f} vs {fams[0][0]['score']:.2f}"
    print("tempo candidates: fit = onset strength on the beat grid (1 = best), bars = how alike consecutive 4-beat\n"
          "bars are (drums / bass / other / harmony changes), 2&4 = snare on 2 and 4, beats = kick + snare on the beats")
    print("     bpm   fit |  drum  bass other  harm  mean |  2&4 beats")
    shown = ranked[:7] + [c for c in levels if all(c is not r for r in ranked[:7])]
    for c in shown:
        bars = " ".join(f"{c['bars'][k]:5.2f}" for k in ("drums", "bass", "other", "harmony"))
        note = "<- tempo" if c is best else f"{ratio_name(c['bpm'] / best['bpm'])}: {why[id(c)]}"
        print(f"  {c['bpm']:6.2f}  {c['fit'] / top:4.2f} | {bars} {c['bar']:5.2f} | {c['bb']:4.2f} {c['ob']:5.2f}  {note}")
    if len(ranked) > len(shown):
        print(f"  ({len(ranked) - len(shown)} weaker candidates not shown)")
    return best


def fit_grid(stems, mix, sr, duration, chroma, cfps, kicks, snares, hint=None):
    """Constant-tempo grid. Tempo candidates = peaks of a comb-filter tempogram of the drums + mix onsets over
    BPM_RANGE (only ±4 % around `hint` if given), the right one picked by pick_tempo(); then tempo / phase
    refinement on the onset envelopes and phase refinement on kick attack times."""
    hop = 32
    ofps = 22050 / hop

    def onset_env(y, h):
        e = librosa.onset.onset_strength(y=librosa.resample(y, orig_sr=sr, target_sr=22050),
                                         sr=22050, hop_length=h, lag=1, max_size=1)
        return e / (np.percentile(e, 99) + 1e-9)

    od, om = onset_env(stems["drums"], hop), onset_env(mix, hop)
    o = od + om

    def score(P, off):
        ts = off + P * np.arange(int((duration - off) / P) + 1)
        idx = np.round(ts * ofps).astype(int)
        idx = idx[(idx > 2) & (idx < len(o) - 2)]
        return np.maximum.reduce([o[idx - 1], o[idx], o[idx + 1]]).mean()

    lo, hi = (hint / 1.04, hint * 1.04) if hint else BPM_RANGE
    n4 = len(o) // 4
    efps = ofps / 4   # coarse search and bar folding at 172 fps
    bpms = np.arange(lo, hi, 0.05)
    curve = tempo_curve(maximum_filter1d(o[:n4 * 4].reshape(n4, 4).max(axis=1), 3), efps, bpms)
    pk, _ = find_peaks(np.r_[0, curve, 0], distance=20)
    seeds = [float(bpms[i]) for i in sorted(pk - 1, key=lambda i: -curve[i])[:8]] or [float(bpms[np.argmax(curve)])]
    if hint:
        bpm0 = seeds[0]
        print(f"BPM_HINT {hint}: searched {lo:.1f}-{hi:.1f} BPM only")
    else:
        seeds += [b * f for b in seeds for f in (0.5, 2.0) if lo <= b * f <= hi]
        o3 = maximum_filter1d(o, 3)
        cands = []
        for b in seeds:
            fit, b2, off = refine_tempo(o3, ofps, b)
            if all(abs(b2 / c["bpm"] - 1) > 0.002 for c in cands):
                cands.append(dict(bpm=b2, off=off, fit=fit))
        cands = [c for c in cands if c["fit"] >= 0.3 * max(c_["fit"] for c_ in cands)]   # drop side lobes
        E = {"drums": od[:n4 * 4].reshape(n4, 4).max(axis=1),
             "bass": onset_env(stems["bass"], 4 * hop), "other": onset_env(stems["other"], 4 * hop)}
        # harmony changes: 1 - cosine between the mean chroma of the quarter second before and after
        w = max(1, int(round(0.25 * cfps)))
        h = w // 2 + 1
        Cp = np.pad(uniform_filter1d(chroma, w, axis=1, mode="nearest"), ((0, 0), (h, h)), mode="edge")
        a, b = Cp[:, :-2 * h], Cp[:, 2 * h:]
        nov = 1 - (a * b).sum(axis=0) / (np.linalg.norm(a, axis=0) * np.linalg.norm(b, axis=0) + 1e-9)
        m = min(len(e) for e in E.values())
        E = {k: e[:m] for k, e in E.items()}
        E["harmony"] = np.interp(np.arange(m) / efps, np.arange(len(nov)) / cfps, nov / (np.percentile(nov, 99) + 1e-9))
        for c in cands:
            P = 60 / c["bpm"]
            c["bars"] = {k: bar_consistency(e, efps, P, c["off"]) for k, e in E.items()}
            c["bb"], c["ob"] = backbeat(snares, P, c["off"]), on_beats(kicks, snares, P, c["off"])
        bpm0 = pick_tempo(cands)["bpm"]

    best = (0, None, None)
    for bpm in np.arange(round(bpm0 / 0.02) * 0.02 - 0.3, bpm0 + 0.3, 0.02):
        P = 60 / bpm
        for off in np.arange(0, P, 0.004):
            s = score(P, off)
            if s > best[0]:
                best = (s, bpm, off)
    _, bpm, off = best
    for b2 in np.arange(bpm - 0.03, bpm + 0.03, 0.001):
        P = 60 / b2
        for o2 in np.arange(off - 0.01, off + 0.01, 0.001):
            s = score(P, o2)
            if s > best[0]:
                best = (s, b2, o2)
    _, bpm, off = best
    P = 60 / bpm
    kick_t, _ = band_onsets(stems["drums"], sr, None, 120, win=0.012, min_gap=0.2, rel_db=12)
    # The onset envelopes peak as much on the open off-beat hats as on the four-on-the-floor kick,
    # so the search can lock half a beat off: pick the half-beat phase that the kicks and the snares
    # sit on (the snares too: on 2 and 4 they are on the beat, and a kick band full of syncopated
    # bass, as in 暗叫, outvotes the kicks alone).
    def on_grid(o_):
        r = (np.r_[kick_t, snares] - o_) / P
        return int(np.sum(np.abs(r - np.round(r)) < 0.08))
    if on_grid(off + P / 2) > on_grid(off):
        print(f"half-beat phase flip: kicks + snares on grid {on_grid(off)} -> {on_grid(off + P / 2)}")
        off = off + P / 2
    n = np.round((kick_t - off) / P)
    res = kick_t - (off + n * P)
    ok = np.abs(res) < 0.06
    off = off + float(np.median(res[ok]))
    off = off - P * math.floor(off / P)
    # drift check: median kick residual per 20 s window
    drift = []
    for a in np.arange(0, duration, 20):
        m = ok & (kick_t >= a) & (kick_t < a + 20)
        if m.sum() >= 8:
            drift.append((float(a), float(np.median(res[m] - np.median(res[ok])) * 1000), int(m.sum())))
    return bpm, P, off, res[ok], drift


def drum_onsets(d, sr):
    """Kick / snare / hat onsets from the drums stem (see pdoom analyze.py)."""
    kt, kdb = band_onsets(d, sr, None, 120, win=0.012, min_gap=0.15, rel_db=12)
    st, sdb = band_onsets(d, sr, 1500, 5000, win=0.010, min_gap=0.15, rel_db=10)
    xb = sosfiltfilt(band_sos(500, 5000, sr), d)
    e = np.sqrt(np.convolve(xb.astype(np.float64) ** 2, np.ones(441) / 441, mode="same"))
    tail = np.array([20 * np.log10(e[int((t + 0.04) * sr):int((t + 0.12) * sr)].mean() + 1e-9) for t in st])
    rel = np.array([tail[i] - tail[np.abs(st - st[i]) < 2.5].max() for i in range(len(st))])
    thr = np.percentile(tail, 95) - 25
    keep = (rel > -8) & (tail > thr)
    st, stail = st[keep], tail[keep]
    ht, hdb = band_onsets(d, sr, 7000, None, win=0.006, min_gap=0.06, rel_db=9)
    for other, gap in ((st, 0.04), (kt, 0.03)):
        if len(other) and len(ht):
            dist = np.min(np.abs(ht[:, None] - other[None, :]), axis=1)
            ht, hdb = ht[dist > gap], hdb[dist > gap]
    return (kt, kdb), (st, stail), (ht, hdb)


def strength01(db_vals, lo_pct=5, hi_pct=95):
    if len(db_vals) == 0:
        return db_vals
    lo, hi = np.percentile(db_vals, lo_pct), np.percentile(db_vals, hi_pct)
    return np.clip((db_vals - lo) / (hi - lo + 1e-9) * 0.8 + 0.2, 0, 1)


def vocal_onsets(v, sr):
    """Vocal note onsets: log-mel spectral flux peaks on the vocal stem, restricted to
    frames where the vocal is active (within 25 dB of its local max and above -45 dBFS)."""
    hop = 220  # 5 ms
    on = librosa.onset.onset_strength(y=v, sr=sr, hop_length=hop, n_mels=96, lag=2, max_size=3)
    rms = librosa.feature.rms(y=v, frame_length=2048, hop_length=hop)[0]
    db = 20 * np.log10(rms + 1e-9)
    n = min(len(on), len(db))
    on, db = on[:n], db[:n]
    loc = median_filter(db, int(2.0 / 0.005) | 1)
    active = (db > -45) & (db > np.maximum.accumulate(db) * 0 + loc - 25)
    thr = uniform_filter1d(on, int(0.4 / 0.005)) * 1.5 + 0.15 * np.percentile(on, 99)
    pk, _ = find_peaks(on, height=0, distance=int(0.09 / 0.005))
    pk = [p for p in pk if on[p] > thr[p] and active[min(n - 1, p + 6)]]
    s = np.array([on[p] for p in pk])
    s = s / (np.percentile(s, 95) + 1e-9) if len(s) else s
    return [(float(p * 0.005), float(min(1.0, max(0.1, x)))) for p, x in zip(pk, s)]


# ---------------------------------------------------------------------------
def load_all():
    mix = load(AUDIO / "song.wav")
    stems = {}
    for n in ("drums", "bass", "other"):
        stems[n] = load(AUDIO / "stems4" / f"{n}.wav")
    stems["vocals"] = load(AUDIO / "stems" / "vocals.wav")  # MDX vocal stem (cleaner than htdemucs')
    for n in stems:
        stems[n] = np.pad(stems[n], (0, max(0, len(mix) - len(stems[n]))))[: len(mix)]
    return mix, stems


def bar_table(mix, stems, off, P, duration):
    """Per-bar mean of each envelope (dB-ish, normalized) + chroma novelty, for placing sections."""
    env = {"rms": frame_rms(mix, SR)}
    env["low"] = frame_rms(sosfiltfilt(band_sos(None, 150, SR), mix), SR)
    for s in ("drums", "bass", "other", "vocals"):
        env[s] = frame_rms(stems[s], SR)
    harm = stems["other"] + stems["bass"]
    C = librosa.feature.chroma_cqt(y=librosa.resample(harm, orig_sr=SR, target_sr=22050), sr=22050, hop_length=512)
    cfps = 22050 / 512
    rows = []
    k = 0
    while True:
        a = off + 4 * P * k
        b = a + 4 * P
        if a >= duration:
            break
        r = {"bar": k, "t": a}
        for n, e in env.items():
            seg = e[int(a * FPS):int(min(b, duration) * FPS)]
            r[n] = 20 * np.log10(seg.mean() + 1e-9) if len(seg) else -120
        c = C[:, int(a * cfps):int(b * cfps)].mean(axis=1)
        r["chroma"] = c / (np.linalg.norm(c) + 1e-9)
        rows.append(r)
        k += 1
    return rows


def main(plots=False, bars=False):
    mix, stems = load_all()
    duration = len(mix) / SR
    (kt, kdb), (st, sdb), (ht, hdb) = drum_onsets(stems["drums"], SR)
    # chroma of the harmonic stems: harmony changes for the tempo choice, chord changes on downbeats for the bar phase
    harm = stems["other"] + stems["bass"]
    C = librosa.feature.chroma_cqt(y=librosa.resample(harm, orig_sr=SR, target_sr=22050), sr=22050, hop_length=512)
    cfps = 22050 / 512
    bpm, P, off, kick_res, drift = fit_grid(stems, mix, SR, duration, C, cfps, kt, st, hint=BPM_HINT)
    print(f"tempo {bpm:.3f} BPM  period {P:.5f}s  first beat {off:.4f}s  kick residual sd {kick_res.std()*1000:.1f} ms")
    print("drift (window start s, median kick residual ms, n):", [(a, round(m, 1), n) for a, m, n in drift])
    beats = off + P * np.arange(int((duration - off) / P) + 1)

    def pos_hist(ts, per=8):
        ph = np.round((np.asarray(ts) - off) / (P / 2)).astype(int) % per
        return np.bincount(ph, minlength=per).tolist()

    print("kick   8th-positions (beat 0 = first grid beat, 8 = one 4/4 bar):", pos_hist(kt))
    print("snare  8th-positions:", pos_hist(st))
    print("hat    8th-positions:", pos_hist(ht))

    # downbeat phase: chords change on downbeats -> beat-synchronous chroma novelty by beat index mod 4
    bc = np.stack([C[:, int(b * cfps):int((b + P) * cfps)].mean(axis=1) for b in beats[:-1]], axis=1)
    bc = bc / (np.linalg.norm(bc, axis=0, keepdims=True) + 1e-9)
    nov = np.r_[0, 1 - (bc[:, 1:] * bc[:, :-1]).sum(axis=0)]
    for per in (4, 8, 16):
        print(f"chroma novelty by beat index mod {per}:", np.round([nov[i::per].mean() for i in range(per)], 3).tolist())
    # bass-note onsets by beat position too
    bt, _ = band_onsets(stems["bass"], SR, None, 300, win=0.015, min_gap=0.2, rel_db=10)
    print("bass onsets 8th-positions:", pos_hist(bt))
    phase = int(np.argmax([nov[i::4].mean() for i in range(4)]))
    first_db = float(beats[phase])
    print(f"downbeat phase = beat {phase}, first downbeat {first_db:.3f}s")

    if bars:
        rows = bar_table(mix, stems, first_db, P, duration)
        prev = None
        print(" bar     t    rms   low drums  bass other vocal  chromaΔ")
        for r in rows:
            cd = 0 if prev is None else 1 - float(r["chroma"] @ prev)
            prev = r["chroma"]
            print(f"{r['bar']:4d} {r['t']:6.2f} " + " ".join(f"{r[n]:5.1f}" for n in ("rms", "low", "drums", "bass", "other", "vocals")) + f"  {cd:5.3f}")
        return

    # tempo map (analysis/tempo_map.py): 128 BPM, then two ramps to 174 BPM for the final drop
    tempo = np.full(len(beats), bpm)
    tm_path = ROOT / "analysis" / "work" / "tempo_map.json"
    tm_model = None
    if tm_path.exists():
        tm = json.loads(tm_path.read_text(encoding="utf-8"))
        tm_model = tm["model"]
        assert abs(tm_model["P0"] - P) < 2e-5 and abs(tm_model["off"] - off) < 2e-3, \
            "tempo_map.json was fitted on another constant grid; rerun analysis/tempo_map.py"
        beats, tempo = np.array(tm["beats"]), np.array(tm["bpm"])
        print("tempo map: %d beats, ramp %.2f-%.2f s, final %.2f BPM" % (len(beats), tm_model["tA"], tm_model["tB"], tm_model["T2"]))
    # beats[] starts on the first downbeat (the engine's timeOfBar(k) = timeOfBeat(4k))
    beats, tempo = beats[phase:], tempo[phase:]
    phase = 0
    downbeats = beats[::4]

    def bar_t(k):
        i = phase + 4 * k
        return float(beats[i]) if i < len(beats) else float(beats[-1] + (i - len(beats) + 1) * 60 / tempo[-1])

    n = int(math.ceil(duration * FPS))
    env = {"rms": frame_rms(mix, SR)[:n]}
    for name, (lo, hi) in {"low": (None, 150), "mid": (150, 2000), "high": (4000, None)}.items():
        env[name] = frame_rms(sosfiltfilt(band_sos(lo, hi, SR), mix), SR)[:n]
    for s in ("vocal", "drums", "bass", "other"):
        env[s] = frame_rms(stems["vocals" if s == "vocal" else s], SR)[:n]
    for k in env:
        env[k] = [round(float(x), 3) for x in norm01(smooth_env(env[k]))]

    onsets = {
        "kick": [[round(float(t), 3), round(float(s), 3)] for t, s in zip(kt, strength01(kdb))],
        "snare": [[round(float(t), 3), round(float(s), 3)] for t, s in zip(st, strength01(sdb))],
        "hat": [[round(float(t), 3), round(float(s), 3)] for t, s in zip(ht, strength01(hdb))],
        "vocal": [[round(t, 3), round(s, 3)] for t, s in vocal_onsets(stems["vocals"], SR)],
    }

    sections = []
    for name, a, b in SECTION_BARS or []:
        s = 0.0 if a is None else bar_t(a)
        e = duration if b is None else bar_t(b)
        sections.append(dict(name=name, start=round(s, 3), end=round(e, 3)))

    doc = dict(
        duration=round(duration, 3),
        bpm=round(bpm, 3),
        beat_period=round(P, 5),
        time_signature=4,
        beats=[round(float(t), 4) for t in beats],
        tempo=[round(float(x), 3) for x in tempo],
        tempo_model=tm_model,
        downbeats=[round(float(t), 4) for t in downbeats],
        sections=sections,
        fps=FPS,
        **env,
        onsets=onsets,
        notes=NOTES.format(bpm=bpm, P=P, off=off, first_db=first_db),
    )
    DATA.mkdir(exist_ok=True)
    (DATA / "audio.json").write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    print("wrote", DATA / "audio.json", f"{len(beats)} beats, {len(downbeats)} downbeats, "
          f"{len(kt)} kicks, {len(st)} snares, {len(ht)} hats, {len(onsets['vocal'])} vocal onsets")
    return doc


NOTES = (
    "Timeline = audio/song.wav (44.1 kHz decode of the FLAC, no encoder delay); stems are "
    "sample-aligned (drums/bass/other: htdemucs_ft, vocal: MDX Kim_Vocal_2). "
    "Constant tempo {bpm:.3f} BPM (period {P:.5f} s, fitted on drum+mix onset envelopes, phase on kick "
    "attacks). First downbeat {first_db:.3f} s; bar k starts at downbeats[k]. "
    "Envelopes: 100 fps, 46 ms RMS window, one-pole smoothing (10 ms attack / 90 ms release), each "
    "divided by its own 99th percentile and clipped to 0..1. low <150 Hz, mid 150-2000 Hz, high >4 kHz "
    "of the full mix; vocal/drums/bass/other = stem RMS. Onsets [time, strength 0-1]: kick/snare/hat "
    "from the drums stem, vocal = note onsets (log-mel flux) of the vocal stem."
)


if __name__ == "__main__":
    main(plots="--plots" in sys.argv, bars="--bars" in sys.argv)

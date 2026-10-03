"""CTC forced alignment of the LRC lines inside the video window -> data/lyrics.json.

From Still_Shining, ported from the Clarity project's ctc_align.py (itself from the pdoom-video analysis, MIT):
* Emissions: two char-level CTC models (torchaudio MMS_FA, wav2vec2 LV60K-960h) on the MDX vocal
  stem's mono sum and its left / right channels, mapped to a common alphabet (blank, a-z, ') and
  fused as a probability mixture. Only the window T0..T1 is processed.
* One Viterbi pass over the window; a garbage "star" token between lines absorbs ad-libs / chops.
  Each line's tokens must lie in [LRC start - 0.4 s, next LRC start + 0.15 s] (the LRC line times
  of this file are already accurate to ~50 ms).

Text comes from data/lyrics.src.lrc (the FLAC's embedded LRC: an English line and its Chinese
translation share one timestamp). This script never prints lyric text, only times and confidences.

  python analysis/ctc_align.py
"""
import json
import re
import sys
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
import torch
import torchaudio

sys.path.insert(0, str(Path(__file__).resolve().parent))

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
WORK = ROOT / "analysis" / "work"
WORK.mkdir(parents=True, exist_ok=True)
import os
# analysed window (song time, s): CTC_T0 / CTC_T1, default the whole song (a long song: align it in windows of a
# few minutes, the emissions are cached per window in analysis/work/)
T0 = float(os.environ.get("CTC_T0", 0.0))
T1 = float(os.environ.get("CTC_T1", sf.info(str(ROOT / "audio" / "song.wav")).duration))
HOP = 320                      # samples @16k -> 20 ms
FRAME = 0.02
ALPHA = ["-"] + list("abcdefghijklmnopqrstuvwxyz'")
AIDX = {c: i for i, c in enumerate(ALPHA)}
BUNDLES = {"mms": torchaudio.pipelines.MMS_FA, "lv60k": torchaudio.pipelines.WAV2VEC2_ASR_LARGE_LV60K_960H}
SOURCES = ("mono", "L", "R")

from importlib import import_module  # noqa: E402


def lrc_lines():
    """[(t, en, zh)] from the embedded LRC; credits (lines without latin letters) dropped."""
    rows = {}
    order = []
    for raw in (DATA / "lyrics.src.lrc").read_text(encoding="utf-8").splitlines():
        m = re.match(r"\[(\d+):(\d+(?:\.\d+)?)\](.*)", raw.strip())
        if not m:
            continue
        t = int(m.group(1)) * 60 + float(m.group(2))
        txt = m.group(3).strip()
        if t not in rows:
            rows[t] = []
            order.append(t)
        rows[t].append(txt)
    out = []
    for t in order:
        en = next((x for x in rows[t] if re.search(r"[A-Za-z]", x)), None)
        zh = next((x for x in rows[t] if re.search(r"[一-鿿]", x)), "")
        if en is None or "作词" in en or "作曲" in en:
            continue
        out.append((t, en, zh))
    return out


def load_source(src):
    y, sr = sf.read(str(ROOT / "audio" / "stems" / "vocals.wav"), dtype="float32", always_2d=True)
    y = y[int(T0 * sr):int(T1 * sr)]
    y = y.mean(axis=1) if src == "mono" else y[:, 0 if src == "L" else 1]
    return librosa.resample(y, orig_sr=sr, target_sr=16000)


def emission(name, src):
    path = WORK / f"emission_{name}_{src}_{T0:g}-{T1:g}.npy"
    if path.exists():
        return np.load(path)
    bundle = BUNDLES[name]
    model = bundle.get_model(with_star=False) if name == "mms" else bundle.get_model()
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    model = model.to(dev).eval()
    y = load_source(src)
    y = y / (np.abs(y).max() + 1e-9)
    n_frames = len(y) // HOP
    chunk, ctx = 20 * 16000, 3 * 16000
    out = np.full((n_frames, len(bundle.get_labels(star=None)) if name == "mms" else len(bundle.get_labels())),
                  np.nan, np.float32)
    for s in range(0, len(y), chunk):
        a, b = max(0, s - ctx), min(len(y), s + chunk + ctx)
        x = torch.from_numpy(y[a:b]).float()[None].to(dev)
        with torch.inference_mode():
            em, _ = model(x)
            em = torch.log_softmax(em, dim=-1)[0].float().cpu().numpy()
        f0 = a // HOP
        lo, hi = s // HOP, min(n_frames, (s + chunk) // HOP)
        seg = em[lo - f0: hi - f0]
        out[lo: lo + len(seg)] = seg[: max(0, min(len(seg), n_frames - lo))]
    last = np.where(~np.isnan(out[:, 0]))[0].max()
    out[last + 1:] = out[last]
    np.save(path, out)
    return out


def common_logp(name, src):
    em = emission(name, src).astype(np.float64)
    labs = list(BUNDLES[name].get_labels(star=None)) if name == "mms" else list(BUNDLES[name].get_labels())
    out = np.full((em.shape[0], len(ALPHA)), -1e4)
    blank_cols = [labs.index("-")] + ([labs.index("|")] if "|" in labs else [])
    out[:, 0] = np.logaddexp.reduce(em[:, blank_cols], axis=1)
    for i, c in enumerate(labs):
        k = c.lower()
        if k in AIDX and k != "-":
            out[:, AIDX[k]] = em[:, i]
    out -= np.logaddexp.reduce(out, axis=1, keepdims=True)
    return out


def main():
    clar = import_module("ctc_viterbi")  # _viterbi / pron / align, copied verbatim from Clarity
    es = [common_logp(m, s) for m in BUNDLES for s in SOURCES]
    n = min(len(e) for e in es)
    E = np.logaddexp.reduce(np.stack([e[:n] for e in es]), axis=0) - np.log(len(es))

    allines = lrc_lines()
    idx = [i for i, (t, _, _) in enumerate(allines) if T0 + 1 <= t < T1]
    lines = [allines[i] for i in idx]
    windows = {}
    for k, i in enumerate(idx):
        t = allines[i][0]
        nxt = allines[i + 1][0] if i + 1 < len(allines) else T1
        windows[k] = (max(0.0, t - 0.4 - T0), min(T1 - T0, nxt + 0.15 - T0) if i + 1 < len(allines) else T1 - T0 - 0.1)
    toks = [l[1].replace("（", "").replace("）", "").split() for l in lines]
    words, score = clar.align(E, toks, windows)
    out = []
    for li, (t, en, zh) in enumerate(lines):
        ws = []
        for ti, tok in enumerate(toks[li]):
            w = words[(li, ti)]
            ws.append(dict(w=tok, start=round(w["start"] + T0, 3), end=round(w["end"] + T0, 3), conf=round(w["conf"], 3),
                           chars=[(round(a + T0, 3), round(b + T0, 3)) for a, b in w["chars"]]))
        out.append(dict(i=li, text=en, zh=zh, lrc=round(t, 3), start=ws[0]["start"], end=ws[-1]["end"], words=ws))
        print("L%-2d lrc %7.3f  aligned %7.3f-%7.3f  words %2d  min conf %.2f  mean conf %.2f" % (
            li + 1, t, ws[0]["start"], ws[-1]["end"], len(ws), min(w["conf"] for w in ws), np.mean([w["conf"] for w in ws])))
    doc = dict(lines=out, extras=[], notes=(
        "Text: the FLAC's embedded LRC (data/lyrics.src.lrc), English line + its Chinese translation (zh); only "
        "lines inside the video window. Times: CTC forced alignment (analysis/ctc_align.py), MMS_FA + wav2vec2 "
        "LV60K-960h emissions of the MDX vocal stem (mono, L, R) fused, one Viterbi pass, 20 ms frames. "
        "words[].chars = per-letter [start, end]; lrc = the LRC's own line time. Song time (s)."))
    (DATA / "lyrics.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print("wrote data/lyrics.json", len(out), "lines, viterbi score %.1f" % score)


if __name__ == "__main__":
    main()

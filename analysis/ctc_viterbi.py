"""Viterbi CTC alignment helpers, copied from the Clarity project's analysis/ctc_align.py (MIT, pdoom-video lineage)."""
import re

import numba
import numpy as np

FRAME = 0.02
ALPHA = ["-"] + list("abcdefghijklmnopqrstuvwxyz'")
AIDX = {c: i for i, c in enumerate(ALPHA)}


@numba.njit(cache=True)
def _viterbi(E, tgt, lo, hi):
    T = E.shape[0]
    L = len(tgt)
    S = 2 * L + 1
    NEG = -1e18
    prev = np.full(S, NEG)
    cur = np.full(S, NEG)
    bp = np.zeros((T, S), np.int8)  # 0 stay, 1 from s-1, 2 from s-2
    prev[0] = E[0, 0]
    if lo[0] <= 0 <= hi[0]:
        prev[1] = E[0, tgt[0]]
    for t in range(1, T):
        for s in range(S):
            if s % 2 == 1:
                j = (s - 1) // 2
                if t < lo[j] or t > hi[j]:
                    cur[s] = NEG
                    continue
                e = E[t, tgt[j]]
            else:
                e = E[t, 0]
            best = prev[s]
            arg = 0
            if s >= 1 and prev[s - 1] > best:
                best = prev[s - 1]
                arg = 1
            if s >= 2 and s % 2 == 1:
                j = (s - 1) // 2
                if tgt[j] != tgt[j - 1] and prev[s - 2] > best:
                    best = prev[s - 2]
                    arg = 2
            cur[s] = best + e
            bp[t, s] = arg
        for s in range(S):
            prev[s] = cur[s]
    s = S - 1 if prev[S - 1] >= prev[S - 2] else S - 2
    score = prev[s]
    path = np.zeros(T, np.int64)
    for t in range(T - 1, -1, -1):
        path[t] = s
        s -= bp[t, s]
    return path, score


def pron(token):
    """Display token -> letters the acoustic models know (a-z and internal apostrophes)."""
    t = token.lower().strip(".,!?\"")
    t = re.sub(r"^'", "", t)          # 'cause -> cause
    t = re.sub(r"[^a-z']", "", t)
    return t


def align(E, lines_tokens, line_windows, margin=1.5):
    T = E.shape[0]
    star_col = E.max(axis=1, keepdims=True) - margin
    Ex = np.concatenate([E, star_col], axis=1)
    star = len(ALPHA)
    tgt, index = [star], []
    for li, toks in enumerate(lines_tokens):
        for ti, tok in enumerate(toks):
            a = len(tgt)
            tgt.extend(AIDX[c] for c in pron(tok))
            index.append((li, ti, a, len(tgt)))
        tgt.append(star)
    tgt = np.array(tgt, np.int64)
    lo = np.zeros(len(tgt), np.int64)
    hi = np.full(len(tgt), T - 1, np.int64)
    for (li, ti, a, b) in index:
        wl, wh = line_windows[li]
        lo[a:b] = int(wl / FRAME)
        hi[a:b] = min(T - 1, int(wh / FRAME))
    path, score = _viterbi(Ex, tgt, lo, hi)
    tokpos = np.where(path % 2 == 1, (path - 1) // 2, -1)
    P = np.exp(Ex[np.arange(T), np.where(tokpos >= 0, tgt[np.maximum(tokpos, 0)], 0)])
    words = {}
    for (li, ti, a, b) in index:
        fr = np.where((tokpos >= a) & (tokpos < b))[0]
        chars = [np.where(tokpos == p)[0] for p in range(a, b)]
        words[(li, ti)] = dict(start=fr.min() * FRAME, end=(fr.max() + 1) * FRAME, conf=float(P[fr].mean()),
                               chars=[(round(c.min() * FRAME, 3), round((c.max() + 1) * FRAME, 3)) for c in chars])
    return words, float(score)


# ---------------------------------------------------------------------------

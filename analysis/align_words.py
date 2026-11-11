"""逐词歌词对齐，什么语言都行（中文、日文、韩文、英文……）→ data/lyrics.json。在项目根目录运行：

  python <引擎>/analysis/align_words.py [--source mix|vocals] [--cpu]

文字来自 data/lyrics.src.lrc（run.py 从 FLAC 内嵌歌词写出来的，逐行时间）；同一个时间戳的原文和中文翻译自动分开
（romanize.pick_lines）。只打印时间、词数和可信度，不打印歌词。

整套照搬 NCM-BetterMV 的对齐包（同一作者；tools/aligner/fa.py 和 src/lyrics/aligned.ts，测量见它的 docs/ALIGNER.md）：
- 模型：Meta 的 MMS-FA（torchaudio.pipelines.MMS_FA，按拉丁字母输出每帧概率），这里用 torchaudio 的原版（不量化），有显卡走 CUDA
- 文字转字母：romanize.py（汉字无调拼音、假名平文式罗马字、韩文国语罗马字）；转不出字母的词（数字、符号）不参与，事后插值
- 每句的字母限制在「本句时间戳 − 0.5 s」到「下一句时间戳 + 0.5 s」，且不超过「本句时间戳 + 2 s + 每音节 0.8 s」；句首第一个字母
  不晚于时间戳 + 1.5 s；句间、词间插入可代表任何声音的 *；按 15 s 一组做 CTC Viterbi；起点整体提前 0.04 s
- 套用：一句可信度（字母平均概率）低于 0.005 保留按音节平摊的估算；离上一个词结束超过 3 s、或晚于「时间戳 + 2 s + 前面每音节
  0.6 s」的词连同后面的都不采信，按音节插值；一句在最后一个词结束时结束
- 它的实测（整首混音）：58 首英文为主的歌词首误差中位 0.050 s；中文一首 0.079 s，≤0.25 s 79.6%。日文汉字按普通话拼音转，位置
  大致对、不精确；声码器和重度处理的人声对得差

括号里的词（和声、应答）默认也参与对齐，这一点和 BetterMV 不同。2026-11-11 在它的评测集上量过（64 首、18 866 词，网易云逐字
歌词当答案）：括号里的 118 个词，不对齐、按音节倒推时误差中位 0.385 s（≤0.25 s 39%），对齐后 0.185 s（57%）；括号外的词不变
（0.050 s、82.4%），没有一首变差。《脑蚀》开头是括号应答的 6 句，不对齐时被倒推进上一句，对齐后在检查片里确认是对的。
--skip-asides 回到 BetterMV 的做法（括号里的词不对齐，按音节插值）。
--source vocals 用 audio/stems/vocals.wav（run.py 分离出来的人声）代替混音；BetterMV 试过分离后再对齐，结果几乎一样。
英文歌 run.py 默认仍用 ctc_align.py（两个模型融合，跑在人声上）；想用这个就 run.py --aligner words。
"""
import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent))
from romanize import pick_lines, romanize, tokenize  # noqa: E402

ROOT = Path.cwd()
DATA = ROOT / "data"
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

# MMS_FA 的字母表（torchaudio MMS_FA.get_labels(star='*') 的顺序），* 是「任何声音」
LABELS = ['-', 'a', 'i', 'e', 'n', 'o', 'u', 't', 's', 'r', 'm', 'k', 'l', 'd', 'g', 'h', 'y', 'b', 'p', 'w', 'c',
          'v', 'j', 'z', 'f', "'", 'q', 'x', '*']
IDX = {c: i for i, c in enumerate(LABELS)}
BLANK, STAR = 0, IDX['*']
RATE, HOP = 16000, 320
FPS = RATE / HOP
MIN_CONF = 0.005
CJK_CHAR = re.compile(r'[぀-ヿ㐀-鿿豈-﫿가-힯]')


def letters(word):
    return [IDX[c] for c in romanize(word) if c in IDX]


def syllables(word):
    """粗略的音节数：一个汉字 / 假名 / 韩文字算一个；拉丁字母按元音组。"""
    n = len(CJK_CHAR.findall(word))
    if n:
        return n
    groups = re.findall(r'[aeiouy]+', re.sub(r'e$', '', re.sub(r'[^a-z]', '', word.lower())))
    return max(1, len(groups))


OPEN, CLOSE = '(（[【', ')）]】'


def asides(words):
    """哪些词在括号里（和声、应答）。--skip-asides 时它们不参与对齐。"""
    out, depth = [], 0
    for w in words:
        if w[:1] in OPEN:
            depth += 1
        out.append(depth > 0)
        if w[-1:] in CLOSE:
            depth = max(0, depth - 1)
    return out


def resample(x, src, dst=RATE):
    """FFT 带限重采样，分块做（长歌也不占多少内存）。"""
    if src == dst:
        return x.astype(np.float32)
    block, pad = src * 30, src
    out = []
    for s in range(0, len(x), block):
        a, b = max(0, s - pad), min(len(x), s + block + pad)
        seg = x[a:b].astype(np.float64)
        n_out = int(round(len(seg) * dst / src))
        spec = np.fft.rfft(seg)
        keep = n_out // 2 + 1
        spec = spec[:keep] if keep <= len(spec) else np.pad(spec, (0, keep - len(spec)))
        y = np.fft.irfft(spec, n_out) * (n_out / len(seg))
        y0 = int(round((s - a) * dst / src))
        y1 = y0 + int(round((min(len(x), s + block) - s) * dst / src))
        out.append(y[y0:y1])
    return np.concatenate(out).astype(np.float32) if out else np.zeros(0, np.float32)


class TorchMMS:
    """torchaudio 的 MMS-FA，接口和 onnxruntime 的会话一样（run(None, {'audio': x}) → [logits]），emissions() 两边通用。"""

    def __init__(self, cpu=False):
        import torch
        import torchaudio
        self.torch = torch
        self.dev = 'cuda' if torch.cuda.is_available() and not cpu else 'cpu'
        self.m = torchaudio.pipelines.MMS_FA.get_model(with_star=False).model.to(self.dev).eval()

    def run(self, _names, feed):
        x = self.torch.from_numpy(feed['audio']).to(self.dev)
        with self.torch.inference_mode():
            return [self.m(x)[0].float().cpu().numpy()]


def emissions(sess, audio, chunk=30.0, ctx=1.0):
    """16 kHz 音轨 → 每帧字母对数概率 [帧, 29]（* 那一列是 0：它可以是任何声音），分块、前后多带 1 s 上下文。"""
    n = len(audio)
    T = max(0, (n - 400) // HOP + 1)
    out = np.full((T, len(LABELS)), -30.0, np.float32)
    out[:, STAR] = 0.0
    step, c = int(chunk * RATE), int(ctx * RATE)
    for s in range(0, n, step):
        a, b = max(0, s - c), min(n, s + step + c)
        x = audio[a:b]
        if len(x) < 4000:
            continue
        x = (x - x.mean()) / np.sqrt(x.var() + 1e-5)
        lg = sess.run(None, {'audio': x[None].astype(np.float32)})[0][0]
        lg = lg - lg.max(-1, keepdims=True)
        lg = lg - np.log(np.exp(lg).sum(-1, keepdims=True))
        f0 = a // HOP
        f_lo, f_hi = s // HOP, min(T, (s + step) // HOP)
        k0, k1 = f_lo - f0, min(len(lg), f_hi - f0)
        if k1 > k0:
            out[f_lo:f_lo + (k1 - k0), :-1] = lg[k0:k1]
    return out


def viterbi(lp, targets, lo, hi):
    """targets 在 lp [T, C] 上的 CTC 强制对齐；第 k 个只能落在 lo[k]..hi[k] 帧。返回每个的（首帧, 末帧, 平均对数概率），
    没有满足约束的路径时 None。"""
    T, L = len(lp), len(targets)
    S = 2 * L + 1
    lab = np.zeros(S, np.int64)
    lab[1::2] = targets
    tok = np.zeros(S, bool)
    tok[1::2] = True
    lo_s = np.zeros(S, np.int64)
    hi_s = np.full(S, T - 1, np.int64)
    lo_s[1::2] = lo
    hi_s[1::2] = hi
    skip = np.zeros(S, bool)
    if L > 1:
        skip[3::2] = np.asarray(targets[1:]) != np.asarray(targets[:-1])
    NEG = np.float32(-1e9)
    dp = np.full(S, NEG, np.float32)
    dp[0] = lp[0, BLANK]
    if lo_s[1] <= 0 <= hi_s[1]:
        dp[1] = lp[0, lab[1]]
    back = np.zeros((T, S), np.int8)
    neg1, neg2 = np.array([NEG], np.float32), np.array([NEG, NEG], np.float32)
    for t in range(1, T):
        adv = np.concatenate([neg1, dp[:-1]])
        sk = np.where(skip, np.concatenate([neg2, dp[:-2]]), NEG)
        best = np.maximum(dp, np.maximum(adv, sk))
        back[t] = np.where(best == dp, 0, np.where(best == adv, 1, 2))
        allowed = ~tok | ((lo_s <= t) & (t <= hi_s))
        dp = np.where(allowed, best + lp[t, lab], NEG).astype(np.float32)
    end = S - 1 if dp[S - 1] >= dp[S - 2] else S - 2
    if dp[end] <= NEG / 2:
        return None
    first = np.full(L, -1, np.int64)
    last = np.full(L, -1, np.int64)
    score = np.zeros(L)
    frames = np.zeros(L)
    s = end
    for t in range(T - 1, -1, -1):
        if s % 2:
            k = s // 2
            first[k] = t
            if last[k] < 0:
                last[k] = t
            score[k] += lp[t, lab[s]]
            frames[k] += 1
        s -= int(back[t, s])
    return first, last, score / np.maximum(frames, 1)


def align(lp, lines, pre=0.5, late=1.5, post=0.5, max_group=15.0, base=2.0, per_syllable=0.8, lead=0.04, with_asides=True):
    """lines: [{'start', 'next', 'words': [词]}] → 每句 {'words': [[起, 止] 或 None], 'conf': 字母平均概率 或 None}。"""
    dur = len(lp) / FPS
    lines = [dict(l, next=min(l['next'], l['start'] + base + per_syllable * sum(syllables(w) for w in l['words'])))
             for l in lines]
    result = [{'words': [None] * len(l['words']), 'conf': None} for l in lines]
    groups, cur = [], []
    for i, l in enumerate(lines):
        if cur and (l['start'] - lines[cur[0]]['start'] > max_group or l['start'] - lines[cur[-1]]['next'] > 0.5):
            groups.append(cur)
            cur = []
        cur.append(i)
    if cur:
        groups.append(cur)
    for g in groups:
        w0 = max(0.0, lines[g[0]]['start'] - pre)
        w1 = min(dur, max(lines[i]['next'] for i in g) + post)
        f0, f1 = int(w0 * FPS), int(w1 * FPS)
        if f1 - f0 < 10:
            continue
        span = f1 - f0 - 1
        targets, lo, hi, owner = [STAR], [0], [span], [None]
        for i in g:
            l = lines[i]
            a = max(0, int((l['start'] - pre) * FPS) - f0)
            b = min(span, int((l['next'] + post) * FPS) - f0)
            first_hi = min(b, int((l['start'] + late) * FPS) - f0)
            started = False
            for j, (w, aside) in enumerate(zip(l['words'], asides(l['words']))):
                ls = [] if aside and not with_asides else letters(w)
                if not ls:
                    continue
                for k, c in enumerate(ls):
                    targets.append(c)
                    lo.append(a)
                    hi.append(b if started else first_hi)
                    owner.append((i, j, k == 0, k == len(ls) - 1))
                    started = True
                targets.append(STAR)
                lo.append(0)
                hi.append(span)
                owner.append(None)
        if len(targets) <= 1:
            continue
        fit = viterbi(lp[f0:f1], targets, np.array(lo), np.array(hi))
        if fit is None:
            continue
        first, last, score = fit
        probs = {}
        for k, o in enumerate(owner):
            if o is None:
                continue
            i, j, is_first, is_last = o
            probs.setdefault(i, []).append(float(np.exp(score[k])))
            cell = result[i]['words'][j] or [None, None]
            if is_first:
                cell[0] = round(max(0.0, (f0 + first[k]) / FPS - lead), 3)
            if is_last:
                cell[1] = round((f0 + last[k] + 1) / FPS, 3)
            result[i]['words'][j] = cell
        for i, p in probs.items():
            result[i]['conf'] = round(float(np.mean(p)), 4)
    return result


# ---- 套用（BetterMV src/lyrics/aligned.ts、parse.ts 的 spreadWords）------------------------------------------------
PAUSE, BUDGET, PER_SYLLABLE = 3, 2, 0.6


def spread(words, start, end):
    """按音节平摊：歌手很少唱满到下一句，约每音节 0.4 s，不超过到下一句的空档。"""
    if not words:
        return []
    wts = [syllables(w) for w in words]
    total = sum(wts)
    sung = min(end - start, max(0.6, total * 0.4))
    out, t = [], start
    for w in wts:
        d = sung * w / total
        out.append([t, t + d])
        t += d
    return out


def believed(r, syl, stamp):
    out, before, sung_to, doubt = [], 0, None, False
    for j, w in enumerate(r['words']):
        s = w[0] if w and w[0] is not None else None
        if s is not None and ((sung_to is not None and s - sung_to > PAUSE) or s > stamp + BUDGET + PER_SYLLABLE * before):
            doubt = True
        out.append(None if doubt else s)
        if s is not None and not doubt:
            sung_to = w[1] if w[1] is not None else s + 0.3
        before += syl[j]
    return out


def apply(r, words, stamp, nxt):
    """一句的对齐结果 → 每个词的 [起, 止]；不能用（可信度太低、一个都没采信）时 None。"""
    if not words or r['conf'] is None or r['conf'] < MIN_CONF:
        return None
    syl = [syllables(w) for w in words]
    starts = believed(r, syl, stamp)
    known = [j for j, s in enumerate(starts) if s is not None]
    if not known:
        return None
    t = [0.0] * len(words)
    for j in known:
        t[j] = starts[j]
    for j in range(known[0] - 1, -1, -1):
        t[j] = t[j + 1] - 0.3 * syl[j]
    for k in range(len(known) - 1):
        a, b = known[k], known[k + 1]
        total = sum(syl[a:b])
        acc = 0
        for j in range(a + 1, b):
            acc += syl[j - 1]
            t[j] = t[a] + (t[b] - t[a]) * acc / total
    for j in range(known[-1] + 1, len(t)):
        t[j] = t[j - 1] + 0.3 * syl[j - 1]
    for j in range(1, len(t)):
        t[j] = max(t[j], t[j - 1])
    out = []
    for j in range(len(words)):
        sung_to = r['words'][j][1] if starts[j] is not None else None
        if j + 1 < len(t):
            gap = t[j + 1] - sung_to if sung_to is not None else 0
            out.append([t[j], max(t[j] + 0.12, sung_to + 0.15) if gap > 0.6 else t[j + 1]])
        else:
            end = max(sung_to + 0.2 if sung_to is not None else 0, t[j] + 0.3 * syl[j])
            out.append([t[j], max(t[j] + 0.15, min(end, nxt - 0.05))])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', choices=('mix', 'vocals'), default='mix')
    ap.add_argument('--cpu', action='store_true')
    ap.add_argument('--skip-asides', action='store_true', help='括号里的词不参与对齐（BetterMV 的做法），按音节插值')
    a = ap.parse_args()

    entries = pick_lines((DATA / 'lyrics.src.lrc').read_text(encoding='utf-8'))
    wav = ROOT / 'audio' / ('song.wav' if a.source == 'mix' else 'stems/vocals.wav')
    y, sr = sf.read(str(wav), dtype='float32', always_2d=True)
    dur = len(y) / sr
    lines = []
    for k, (t, text, zh) in enumerate(entries):
        if not text or t >= dur:
            continue
        nxt = next((e[0] for e in entries[k + 1:] if e[0] > t), dur)
        words = tokenize(text)
        backing = bool(re.match(r'^\s*[(（\[【].*[)）\]】]\s*$', text))
        lines.append(dict(t=t, next=min(nxt, dur), text=text, zh=zh, words=words, backing=backing))

    sess = TorchMMS(a.cpu)
    lp = emissions(sess, resample(y.mean(axis=1), sr))
    res = align(lp, [{'start': l['t'], 'next': l['next'], 'words': [] if l['backing'] and a.skip_asides else l['words']} for l in lines],
                with_asides=not a.skip_asides)

    out, n_aligned = [], 0
    for i, (l, r) in enumerate(zip(lines, res)):
        times = None if l['backing'] and a.skip_asides else apply(r, l['words'], l['t'], l['next'])
        how = 'aligned' if times else 'estimate'
        if times:
            n_aligned += 1
        else:
            times = spread(l['words'], l['t'], l['next'])
        ws = [dict(w=w, start=round(s, 3), end=round(e, 3)) for w, (s, e) in zip(l['words'], times)]
        if not ws:
            continue
        line = dict(i=len(out), text=l['text'], zh=l['zh'], lrc=round(l['t'], 3), start=min(ws[0]['start'], l['t']) if how == 'aligned' else l['t'],
                    end=ws[-1]['end'], words=ws, conf=r['conf'], timing=how)
        if l['backing']:
            line['backing'] = True
        out.append(line)
        print('L%-3d lrc %7.3f  %s %7.3f-%7.3f  words %2d  conf %s' % (
            line['i'] + 1, l['t'], '对齐' if how == 'aligned' else '估算', line['start'], line['end'], len(ws),
            '-' if r['conf'] is None else '%.3f' % r['conf']))
    doc = dict(lines=out, extras=[], notes=(
        'Text: data/lyrics.src.lrc (original line; zh = its translation when the LRC has one). Times: analysis/align_words.py '
        '(the NCM-BetterMV aligner: MMS-FA letters of romanised text, constrained CTC Viterbi, its believe / interpolate '
        'rules); timing = aligned | estimate (spread by syllables from the LRC stamp). Song time (s).'))
    (DATA / 'lyrics.json').write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding='utf-8')
    print('wrote data/lyrics.json: %d lines, %d aligned, %d estimated (device %s, source %s)' % (
        len(out), n_aligned, len(out) - n_aligned, sess.dev, a.source))


if __name__ == '__main__':
    main()

"""Ending for a song cut short (from Still_Shining v10): the backing stops where the last lyric ends, but the last
note does not — the final vowel is held on as one long tone that darkens and fades into a hall, like a singer holding
the last note into the mic after the backing track stops. (The user: 「唱到歌词的最后就不要播了」, and then
「我不是要回声，是要一种渐隐的长的拖音的感觉」 — no repeated echoes.)

  python tools/held_note_ending.py --split 90.80 --freeze 90.76 90.90 --cut 91.13 --end 97.93 -o audio/final.wav

Needs the 2-stem split (python analysis/separate.py vocals: audio/stems/vocals.wav + instrumental.wav); the 4-stem
split's bass + other (python analysis/separate.py demucs) feed the harmonic ring-out if present. How:
  * the mix is refit as a x vocals + b x instrumental (separators save scaled stems; the printed residual should be
    around -90 dBFS: then the two stems rebuild the mix exactly), so voice and backing can part at --split, seamless;
  * the voice crossfades (--xf) into a spectral freeze of its own last vowel (--freeze: a steady stretch of the vowel,
    ~0.1-0.2 s; find it with librosa.pyin: voiced, stable pitch): magnitudes at 8192-point resolution, resynthesised
    with random phases (overlap-add) — the same pitch and timbre, sustained; two partly independent streams for L/R;
  * the held tone breathes until --hold, then decays (--decay dB/s) while its highs close (9 kHz -> 1.6 kHz), and
    drifts back into a smooth hall (noise-built impulse response: no discrete reflections);
  * the backing stops at --cut (a 130 ms fade); only bass + other ring on in the hall for a few seconds;
  * the last 0.6 s fade to nothing (match the picture's fade).
Times are song seconds; the output is float32 stereo 44.1 kHz from 0 to --end. Not mastered: set the release gain in
the export (render-par's master chain or config.AUDIO_FILTER) and check -14 LUFS with tools/qa/check_video.py.
Listen to it: the level curve and the spectrogram cannot tell whether the held vowel sounds right.
"""
import argparse
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfilt, fftconvolve

ROOT = Path(__file__).resolve().parents[1]
SR = 44100
N = 8192                          # freeze resolution (0.19 s)
HOP = N // 4


def reverb_ir(rt60, seconds, seed, predelay=0.03):
    """A synthetic stereo hall: decorrelated noise, three bands decaying at different rates (highs die first)."""
    rng = np.random.default_rng(seed)
    n = int(seconds * SR)
    t = np.arange(n) / SR
    ir = np.zeros((n, 2))
    for ch in range(2):
        noise = rng.standard_normal(n)
        bands = [
            (butter(2, 400, 'low', fs=SR, output='sos'), rt60 * 1.15),
            (butter(2, [400, 3000], 'band', fs=SR, output='sos'), rt60),
            (butter(2, 3000, 'high', fs=SR, output='sos'), rt60 * 0.45),
        ]
        for sos, rt in bands:
            ir[:, ch] += sosfilt(sos, noise) * np.exp(-6.91 * t / rt)
    # a slow, soft onset (no click and no distinct early reflection), the pre-delay, unit energy
    ir *= np.minimum(1.0, t / 0.04)[:, None] ** 2
    ir = np.concatenate([np.zeros((int(predelay * SR), 2)), ir])
    return ir / np.sqrt((ir ** 2).sum() / 2)


def freeze(src, t0, t1, seconds, seed, gain_at, lowpass_at, t_start):
    """Sustain the spectrum of src[t0:t1] (mono) for `seconds`: random phases each frame, overlap-add. gain_at(t) and
    lowpass_at(t) (Hz) are evaluated per frame at song time t (t_start + frame centre)."""
    win = np.hanning(N)
    mags = []
    # (window centres inside the steady part; the 0.19 s windows reach a little past it on both sides)
    for c in np.arange(t0 + 0.03, t1 - 0.03 + 1e-9, 0.01):
        a = int(c * SR) - N // 2
        mags.append(np.abs(np.fft.rfft(src[a:a + N] * win)))
    mag = np.sqrt(np.mean(np.square(mags), 0))      # power average of the steady part
    f = np.fft.rfftfreq(N, 1 / SR)
    mag *= (f > 90)                                   # no rumble
    rng = np.random.default_rng(seed)
    n_out = int(seconds * SR) + N
    out = np.zeros(n_out)
    for k in range(0, n_out - N, HOP):
        tc = t_start + (k + N / 2) / SR
        fc = lowpass_at(tc)
        shape = 1.0 / np.sqrt(1.0 + (f / fc) ** 4)
        spec = mag * shape * gain_at(tc) * np.exp(2j * np.pi * rng.random(len(f)))
        out[k:k + N] += np.fft.irfft(spec, N) * win
    # Hann^2 overlap at a quarter hop sums to 1.5; the analysis window's gain is undone by the level match below
    return out[:int(seconds * SR)] / 1.5


def rms_db(x):
    return 20 * np.log10(np.sqrt((x ** 2).mean()) + 1e-12)


def main():
    ap = argparse.ArgumentParser(description="hold the last sung note on after the backing stops")
    ap.add_argument("--mix", default="audio/song.wav")
    ap.add_argument("--vocals", default="audio/stems/vocals.wav")
    ap.add_argument("--inst", default="audio/stems/instrumental.wav")
    ap.add_argument("--stems4", default="audio/stems4", help="folder with the 4-stem split (bass, other ring on); optional")
    ap.add_argument("--split", type=float, required=True, help="voice and backing part here (s), inside the last vowel")
    ap.add_argument("--xf", type=float, nargs=2, help="voice -> held tone crossfade (s); default split .. split + 0.16")
    ap.add_argument("--freeze", type=float, nargs=2, required=True, help="the steady stretch of the last vowel (s)")
    ap.add_argument("--cut", type=float, required=True, help="the backing stops here (s): the end of the last word")
    ap.add_argument("--hold", type=float, help="the held tone starts to fade (s); default cut + 0.22")
    ap.add_argument("--decay", type=float, default=3.6, help="fade of the held tone (dB/s)")
    ap.add_argument("--end", type=float, required=True, help="the video ends (s)")
    ap.add_argument("-o", "--out", default="audio/final_held.wav")
    a = ap.parse_args()
    path = lambda p: Path(p) if Path(p).is_absolute() else ROOT / p
    xf = a.xf or [a.split, a.split + 0.16]
    hold = a.hold if a.hold is not None else a.cut + 0.22

    mix, sr = sf.read(path(a.mix), dtype='float64', always_2d=True)
    voc, _ = sf.read(path(a.vocals), dtype='float64', always_2d=True)
    inst, _ = sf.read(path(a.inst), dtype='float64', always_2d=True)
    assert sr == SR, f'expected {SR} Hz'
    i0, i1 = int(max(0.0, a.split - 6) * SR), int(a.split * SR)
    X = np.stack([voc[i0:i1].reshape(-1), inst[i0:i1].reshape(-1)], 1)
    gv, gi = np.linalg.lstsq(X, mix[i0:i1].reshape(-1), rcond=None)[0]
    print(f'split: mix = {gv:.3f} x vocals + {gi:.3f} x instrumental (residual {rms_db(mix[i0:i1] - (gv * voc[i0:i1] + gi * inst[i0:i1])):.1f} dBFS)')
    voc, inst = voc * gv, inst * gi

    n_end = int(a.end * SR)
    out = np.zeros((n_end, 2))
    s = int(a.split * SR)
    out[:s] = mix[:s]

    # the backing: on to the cut, a 130 ms fade; its harmonic part (bass + other) rings on in a hall
    c1 = int(a.cut * SR)
    c0 = c1 - int(0.13 * SR)
    back = inst[s:c1].copy()
    back[c0 - s:] *= (0.5 + 0.5 * np.cos(np.linspace(0, np.pi, c1 - c0)))[:, None]
    out[s:c1] += back
    st4 = path(a.stems4)
    if all((st4 / f'{k}.wav').exists() for k in ('vocals', 'drums', 'bass', 'other')):
        S4 = {k: sf.read(st4 / f'{k}.wav', dtype='float64', always_2d=True)[0] for k in ('vocals', 'drums', 'bass', 'other')}
        Y = np.stack([S4[k][i0:i1].reshape(-1) for k in ('vocals', 'drums', 'bass', 'other')], 1)
        g4 = np.linalg.lstsq(Y, mix[i0:i1].reshape(-1), rcond=None)[0]
        h0 = int((a.cut - 1.2) * SR)
        harm = (S4['bass'][h0:c1] * g4[2] + S4['other'][h0:c1] * g4[3]) * np.linspace(0, 1, c1 - h0)[:, None] ** 2
        hall = reverb_ir(3.2, 4.5, 7)
        wet = np.stack([fftconvolve(harm[:, ch], hall[:, ch]) for ch in range(2)], 1) * 0.2
        ring = wet[(c1 - h0):]
        m = min(len(ring), n_end - c1)
        out[c1:c1 + m] += ring[:m]
    else:
        print(f'(no 4-stem split in {st4}: the backing stops dry)')

    # the voice: on to the crossfade, then its held tone
    x0, x1 = int(xf[0] * SR), int(xf[1] * SR)
    fade_out = np.ones(n_end - s)
    fade_out[x0 - s:x1 - s] = np.cos(np.linspace(0, np.pi / 2, x1 - x0))
    fade_out[x1 - s:] = 0
    m = min(len(voc), n_end) - s
    out[s:s + m] += voc[s:s + m] * fade_out[:m, None]

    mono = voc.mean(1)
    gain_at = lambda tc: 1.0 if tc < hold else 10 ** (-a.decay * (tc - hold) / 20)
    lowpass_at = lambda tc: 9000 * (1600 / 9000) ** np.clip((tc - (a.cut - 0.13)) / max(0.5, a.end - 0.43 - a.cut + 0.13), 0, 1)
    secs = a.end - xf[0]
    L = freeze(mono, *a.freeze, secs, 11, gain_at, lowpass_at, xf[0])
    R = freeze(mono, *a.freeze, secs, 12, gain_at, lowpass_at, xf[0])
    held = np.stack([0.75 * L + 0.35 * R, 0.35 * L + 0.75 * R], 1)
    f0, f1 = int(a.freeze[0] * SR), int(a.freeze[1] * SR)
    held *= np.sqrt((voc[f0:f1] ** 2).mean()) / (np.sqrt((held[:int(0.4 * SR)] ** 2).mean()) + 1e-12)
    fade_in = np.ones(len(held))
    fade_in[:x1 - x0] = np.sin(np.linspace(0, np.pi / 2, x1 - x0))
    held *= fade_in[:, None]
    hall2 = reverb_ir(3.8, 6.0, 21, predelay=0.025)
    rv = np.stack([fftconvolve(held[:, ch], hall2[:, ch])[:len(held)] for ch in range(2)], 1)
    th = xf[0] + np.arange(len(held)) / SR
    u = np.clip((th - hold) / 4.0, 0, 1)[:, None]
    tone = held * (0.85 - 0.35 * u) + rv * (0.32 + 0.28 * u)
    m = min(len(tone), n_end - x0)
    out[x0:x0 + m] += tone[:m]

    fo = int(0.6 * SR)
    out[n_end - fo:] *= np.linspace(1, 0, fo)[:, None] ** 2
    dst = path(a.out)
    dst.parent.mkdir(parents=True, exist_ok=True)
    sf.write(dst, out.astype(np.float32), SR, subtype='FLOAT')
    print(f'wrote {dst} ({n_end / SR:.2f} s, peak {20 * np.log10(np.abs(out).max() + 1e-12):.1f} dBFS)')
    for t0, t1 in [(a.split - 2.8, a.split), (a.split, a.cut), (a.cut, a.cut + 0.5), (a.cut + 0.5, a.cut + 1.5), (a.cut + 1.5, a.cut + 3), (a.cut + 3, a.end - 0.6), (a.end - 0.6, a.end)]:
        sg = out[int(t0 * SR):int(t1 * SR)]
        if len(sg):
            print(f'  {t0:6.2f}-{t1:6.2f} s: rms {rms_db(sg):6.1f} dBFS')


if __name__ == '__main__':
    main()

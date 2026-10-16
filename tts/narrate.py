"""第二步：用 VoxCPM2 克隆选定的音色，按段读整篇旁白。

  <基础引擎>/tts/.venv-voxcpm/Scripts/python tts/narrate.py --ref tts/out/voices/女声知性_2.wav [--takes 3] [--only open,end]

- 参考音的原文：在 tts/out/voices/index.json 里查（voice.py 造的），别处来的参考音用 --ref-text 给出
- 克隆方式是 VoxCPM2 的「极致克隆」（参考音 + 原文做续写，同时当音色参考），2026-10 盲听里比 Qwen3-TTS、IndexTTS-2.5、
  CosyVoice3 选中的就是它；语速比 Qwen3 慢约 25%，听着松弛
- 按段落（sec）整段生成，段内停顿交给模型按标点处理（比逐句拼自然）；每段出 --takes 条，存 tts/out/takes/<段>_<条>.wav
- 接着：check.py 查错字 → 挑条写进 index.json 的 "_chosen"（段 → 文件名）→ align.py 逐字时间
"""
import argparse
import time
import zlib
from pathlib import Path

import soundfile as sf

from common import TAKES, VOICES, load_index, load_voxcpm, save_index, sections


def ref_text_of(ref: Path) -> str:
    for v in load_index(VOICES).values():
        if any(t["file"] == ref.name for t in v["takes"]):
            return v["text"]
    raise SystemExit(f"{ref.name} 不是 voice.py 造的，用 --ref-text 给出它的原文")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True)
    ap.add_argument("--ref-text", default="")
    ap.add_argument("--takes", type=int, default=3)
    ap.add_argument("--only", default="", help="只生成这些段，逗号分隔")
    a = ap.parse_args()
    ref = Path(a.ref).resolve()
    ref_text = a.ref_text or ref_text_of(ref)
    only = {s.strip() for s in a.only.split(",") if s.strip()}

    import torch

    t0 = time.time()
    model = load_voxcpm()
    sr = model.tts_model.sample_rate
    print(f"模型加载 {time.time() - t0:.0f} s（参考：{ref.name}）")
    index = load_index(TAKES)
    index["_ref"] = str(ref)
    TAKES.mkdir(parents=True, exist_ok=True)
    for sec, text in sections().items():
        if only and sec not in only:
            continue
        t1 = time.time()
        takes = []
        for i in range(a.takes):
            wav = model.generate(text=text, prompt_wav_path=str(ref), prompt_text=ref_text, reference_wav_path=str(ref),
                                 seed=zlib.crc32(sec.encode()) % 100000 + i)
            p = TAKES / f"{sec}_{i + 1}.wav"
            sf.write(p, wav, sr)
            takes.append({"file": p.name, "seconds": round(len(wav) / sr, 2)})
        index[sec] = {"text": text, "sr": sr, "takes": takes}
        save_index(TAKES, index)
        print(f"{sec}: {len(text)} 字 × {a.takes} 条，用时 {time.time() - t1:.0f} s，时长 {[t['seconds'] for t in takes]}")
    print(f"显存峰值 {torch.cuda.max_memory_allocated() / 1e9:.1f} GB")


if __name__ == "__main__":
    main()

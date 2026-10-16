"""第三步：用 Qwen3-ASR 听写每条配音，和原文比字错率（CER），找出读错、漏读、多读的条（Claude 听不到声音，靠它把关）。

  <基础引擎>/tts/.venv-asr/Scripts/python tts/check.py [tts/out/takes]     # 或 tts/out/voices
读该目录的 index.json，把每条的听写和 CER 写回去并打印一张表。CER 只差「哪 → 哪儿」这类儿化、同音字的可以用。
挑条：CER 低、语调起伏大、没有超长停顿；挑好写进 index.json 的 "_chosen"：{"段": "段_2.wav", ...}。
模型：Qwen/Qwen3-ASR-1.7B（Apache-2.0）。
"""
import re
import sys
import types
import unicodedata
from pathlib import Path

from common import MODELS, TAKES, load_index, save_index

# qwen_asr 的对齐器会 import 日语分词器 nagisa（中文用不到），它的 C++ 库读不了含中文的路径 → 放一个空模块顶替
sys.modules.setdefault("nagisa", types.ModuleType("nagisa"))


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s).upper()
    return re.sub(r"[\s\W_]+", "", s)


def cer(ref: str, hyp: str) -> float:
    r, h = norm(ref), norm(hyp)
    d = list(range(len(h) + 1))
    for i, rc in enumerate(r, 1):
        prev, d[0] = d[0], i
        for j, hc in enumerate(h, 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (rc != hc))
            prev, d[j] = d[j], cur
    return d[len(h)] / max(1, len(r))


def main():
    import torch
    from qwen_asr import Qwen3ASRModel

    folder = Path(sys.argv[1]) if len(sys.argv) > 1 else TAKES
    index = load_index(folder)
    model = Qwen3ASRModel.from_pretrained(str(MODELS / "Qwen3-ASR-1.7B"), dtype=torch.bfloat16, device_map="cuda:0",
                                          max_inference_batch_size=8, max_new_tokens=512)
    for name, v in index.items():
        if name.startswith("_"):
            continue
        files = [str(folder / t["file"]) for t in v["takes"]]
        res = model.transcribe(audio=files, language=["Chinese"] * len(files))
        for t, r in zip(v["takes"], res):
            t["asr"] = r.text
            t["cer"] = round(cer(v["text"], r.text), 3)
            print(f"{t['file']:<28} {t['seconds']:>6.2f}s  CER {t['cer']:.3f}  {r.text}")
    save_index(folder, index)


if __name__ == "__main__":
    main()

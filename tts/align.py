"""第四步：对挑中的每段配音做强制对齐，拿到逐字时间（Qwen3-ForcedAligner-0.6B，Apache-2.0，中文均误差约 33 ms）。

  <基础引擎>/tts/.venv-asr/Scripts/python tts/align.py

读 tts/out/takes/index.json 的 "_chosen"（段 → 文件名），每段音频配原文对齐，写 tts/out/align.json：
{段: {"file": ..., "items": [{"text": "这", "start": 0.12, "end": 0.30}, ...]}}（秒，相对这一段音频开头）。
标点不参与对齐；英文缩写（AI、AGI）按对齐器的切分原样保留。逐字时间可以写成引擎的 lyrics.json，
字幕、砸字、画面动作就能对着话音卡点（做法见 docs/配音.md）。
"""
import json
import sys
import types

from common import MODELS, OUT, TAKES, load_index

sys.modules.setdefault("nagisa", types.ModuleType("nagisa"))  # 同 check.py


def main():
    import torch
    from qwen_asr import Qwen3ForcedAligner

    index = load_index(TAKES)
    chosen: dict[str, str] = index.get("_chosen") or {}
    if not chosen:
        raise SystemExit("先在 tts/out/takes/index.json 里写 \"_chosen\": {段: 文件名}")
    model = Qwen3ForcedAligner.from_pretrained(str(MODELS / "Qwen3-ForcedAligner-0.6B"), dtype=torch.bfloat16, device_map="cuda:0")
    out = {}
    for sec, fname in chosen.items():
        res = model.align(audio=str(TAKES / fname), text=index[sec]["text"], language="Chinese")
        items = [{"text": it.text, "start": round(float(it.start_time), 3), "end": round(float(it.end_time), 3)} for it in res[0]]
        out[sec] = {"file": fname, "items": items}
        print(f"{sec}: {len(items)} 个单位，{items[0]['start']:.2f}–{items[-1]['end']:.2f} s")
    (OUT / "align.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()

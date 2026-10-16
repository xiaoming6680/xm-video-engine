"""第一步：用 VoxCPM2 按文字描述造候选音色（纯合成，不克隆真人），每个出几条给用户挑。

  <基础引擎>/tts/.venv-voxcpm/Scripts/python tts/voice.py --name 女声知性 --desc "二十五岁左右的知性女声，音色柔和饱满……" [--takes 3] [--text "试读的话"]

输出 tts/out/voices/<名>_<条>.wav，tts/out/voices/index.json 记下描述、试读文本、时长。
试读文本默认取 data/script.json 第一段（听到的就是成片里的样子）；挑中的那条当 narrate.py 的参考音。
同一个描述每次出来的声音不一样，多出几条挑；描述写年龄、性别、音色、语气、语速，写明「不要播音腔」之类的反例更稳。
"""
import argparse
import time

import soundfile as sf

from common import VOICES, load_index, load_voxcpm, save_index, sections


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--desc", required=True, help="音色描述（中文即可）")
    ap.add_argument("--text", default="", help="试读文本，默认第一段文案")
    ap.add_argument("--takes", type=int, default=3)
    ap.add_argument("--seed", type=int, default=1000)
    a = ap.parse_args()
    text = a.text or next(iter(sections().values()))

    t0 = time.time()
    model = load_voxcpm()
    sr = model.tts_model.sample_rate
    print(f"模型加载 {time.time() - t0:.0f} s")
    index = load_index(VOICES)
    takes = []
    for i in range(a.takes):
        wav = model.generate(text=f"({a.desc}){text}", seed=a.seed + i)
        p = VOICES / f"{a.name}_{i + 1}.wav"
        VOICES.mkdir(parents=True, exist_ok=True)
        sf.write(p, wav, sr)
        takes.append({"file": p.name, "seconds": round(len(wav) / sr, 2)})
        print(f"{p.name}: {len(wav) / sr:.1f} s")
    index[a.name] = {"desc": a.desc, "text": text, "sr": sr, "takes": takes}
    save_index(VOICES, index)


if __name__ == "__main__":
    main()

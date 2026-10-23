# 配乐与音效合成（mgaudio）

代码合成的音效和配乐：`mgaudio/` 是 mg-styles-15 的 `lib/audio`（48 kHz 立体声，numpy + numba + pedalboard），
含 70 多种音效（whoosh、hit、pop、riser、UI、液体、纸、故障、8-bit……）、15 个曲风配方、混音和 −14 LUFS 母带。
外面两个入口接到引擎上：

- `sfx_mix.py`：给成片或歌叠一层音效（合成的或现成的 wav），按画面时刻对齐，音乐轻微闪避，母带到 −14 LUFS / −1 dBTP
- `score.py`：给不用歌的片子（科普、配音片）按配方和卡点生成一段配乐 wav

## 安装（基础引擎里一次，各项目共用）

```bash
python tools/audio/setup_audio.py      # 建 tools/audio/.venv（Python 3.12，约 350 MB），不动系统 Python；要 uv
python tools/audio/get_samples.py --github                      # 乐器采样 56 MB，不进 git；从 GitHub 稀疏检出
python tools/audio/get_samples.py --from <mg-styles-15>/lib/audio/samples   # 或者从本机已有的克隆复制
python tools/audio/test_audio.py       # 快速单测（不需要采样）
```

之后照常用 `python tools/audio/xxx.py` 跑：缺依赖时脚本自己换到 `.venv` 的 Python。
没装采样也能用：音效和大部分合成器照常；用到采样的配方（explainer 的马林巴、lofi / ambient 的钢琴……）
`score.py` 会报错并提示跑 `get_samples.py`，加 `--synth-fallback` 改用合成音色。
采样也能从 VCSL 原库重建（要联网和 `setup_audio.py --librosa`）：`vcsl/select_vcsl.py` 选文件 →
`vcsl/download_vcsl.sh` 下载 → `vcsl/build_samples.py` 裁剪转 48 kHz FLAC 并写 `index.json`（各文件开头有用法）。

## 常用

```bash
# 1. 成片上按时刻加音效（成片秒；名字@秒[@增益dB]，文件也行：a.wav@1.2）
python tools/audio/sfx_mix.py out/film.mp4 -o out/film_sfx.mp4 \
    --at "whoosh@3.2" --at "hit@4.0" --at "pop(kind='bubble')@5.5@-4" --at "audio/sfx/vibrate.wav@0.6"

# 2. 按场景登记的卡点自动配（render.ts cues 导出，歌曲秒；--start = 成片 0 秒对应的歌曲秒）
cd app && bun scripts/render.ts cues && cd ..
python tools/audio/sfx_mix.py out/film.mp4 -o out/film_sfx.mp4 --cues out/qa/cues.json --start 15.6 \
    --map "lands=pop" --map "slam|砸=hit" --map "cut=swish" --png out/qa/sfx_spec.png

# 3. 科普 / 配音片的配乐：30 秒 explainer，第 12 秒 drop，第 27 秒收尾，卡点上放 pop
python tools/audio/score.py -o audio/score.wav --recipe explainer --duration 30 --drop 12 --outro 27 \
    --at "pop@2.0" --at "hit@12" --png out/qa/score_spec.png
python tools/audio/score.py --list          # 配方和参数；python tools/audio/sfx_mix.py --list  音效名

# 4. 在自己的脚本里直接用（用 .venv 的 Python）
#    import sys; sys.path.insert(0, 'tools/audio'); import mgaudio as mg; from mgaudio import recipes, sfx
#    m = recipes.synthwave(bpm=100, drop=4.8, outro=8.4); m.sfx(sfx.whoosh(0.8, 'sci'), at=3.9)
#    m.export('audio/score.wav', spectrogram='out/qa/score_spec.png')
```

要点：
- **同步点**：一次性的声音（hit、pop、click）对瞬态，whoosh 对掠过最响处，riser / reverse_cymbal 对末尾（那一下），
  transition / text_hit 对那一下——只写画面上那一下的时刻；默认起音再早 1 帧（`--fps 60 --lead-frames 1`）
- **响度约定**：音乐先归到 −20 LUFS（`--bed`），合成音效增益 0 时比音乐床高约 2 dB；`-6` 偏轻，`+2` 是重击。
  文件音效保持相对原曲的音量。最后整体归到 −14 LUFS、真峰值 ≤ −1 dBTP（AAC 编码后再量一次，超了自动压低重来）
- **视频**：视频流原样复制，BT.709 标签不丢；音轨 AAC 320k 48 kHz。做完照常跑 `tools/qa/check_video.py`
- 旧的 `mix_sfx.py`（world.excute(me)）做法 = `--lufs off --duck 0 --lead-frames 0 [--gain -6]`
- 完整 API（配方参数、每种音效的参数、Mix / Track、QC）看 `mgaudio/` 各模块的文档字符串；
  原版英文说明在 mg-styles-15 仓库的 `lib/audio/README.md`

## 来源和许可

- `mgaudio/`、`vcsl/`：mg-styles-15 的 `lib/audio`，作者 Vincentwei1021，MIT（`LICENSE.mgaudio`），
  取自提交 49052d8。改动处标了 `[xm]`：采样目录可设（`$MGAUDIO_SAMPLES`）、没装采样时报清楚的错、
  `index.json` 只认实际存在的文件、读文件指定 UTF-8、长音频分块算真峰值、`master(hp=None)` 可关高通、
  VCSL 工具的临时目录在 Windows 上可用
- `samples/`：VCSL（Versilian Community Sample Library，CC0）的子集，由 mg-styles-15 裁剪整理；
  `samples.sha256` 是它的清单
- 成片 `CREDITS` 写：音效 / 配乐合成 mgaudio（Vincentwei1021，MIT），乐器采样 VCSL（CC0）

"""Stem separation for audio/song.wav.

  python analysis/separate.py vocals   -> audio/stems/{vocals,instrumental}.wav   (MDX Kim_Vocal_2)
  python analysis/separate.py demucs   -> audio/stems4/{drums,bass,other,vocals}.wav (htdemucs_ft)

Models (~400 MB, downloaded on first use): $XM_MODELS, else this project's analysis/models if it has them, else
SHARED: the base engine's analysis/models (tools/new_project.py writes its path here), so every project reuses one
download. ffmpeg must be on PATH.
"""
import os, sys, time, types
import numpy as np
import soundfile as sf

# torchvision's compiled ops don't match this torch build; onnx2torch only needs the import to succeed
_tv = types.ModuleType("torchvision"); _tv.ops = types.ModuleType("torchvision.ops")
def _unavailable(*a, **k):
    raise RuntimeError("torchvision op stubbed out")
for _n in ("nms", "roi_align", "roi_pool", "batched_nms", "deform_conv2d", "ps_roi_align", "ps_roi_pool"):
    setattr(_tv.ops, _n, _unavailable)
sys.modules["torchvision"] = _tv; sys.modules["torchvision.ops"] = _tv.ops
# demucs imports diffq at module load; it is only used by quantized checkpoints (htdemucs_ft is not)
_dq = types.ModuleType("diffq")
for _n in ("DiffQuantizer", "UniformQuantizer", "restore_quantized_state"):
    setattr(_dq, _n, _unavailable)
sys.modules["diffq"] = _dq
from audio_separator.separator import Separator

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHARED = os.path.join(root, "analysis", "models")  # (in the base engine itself: its own folder)
_local = os.path.join(root, "analysis", "models")
models = os.environ.get("XM_MODELS") or (_local if os.path.isdir(_local) and os.listdir(_local) else SHARED)
os.makedirs(models, exist_ok=True)
mode = sys.argv[1] if len(sys.argv) > 1 else "vocals"
inp = os.path.join(root, "audio", "song.wav")

if mode == "vocals":
    out, model = os.path.join(root, "audio", "stems"), "Kim_Vocal_2.onnx"
    names = {"Vocals": "vocals", "Instrumental": "instrumental"}
else:
    out, model = os.path.join(root, "audio", "stems4"), "htdemucs_ft.yaml"
    names = {"Drums": "drums", "Bass": "bass", "Other": "other", "Vocals": "vocals"}
os.makedirs(out, exist_ok=True)

t0 = time.time()
sep = Separator(output_dir=out, model_file_dir=models, output_format="WAV")
sep.load_model(model_filename=model)
files = sep.separate(inp, names)
print("done", files, "%.1fs" % (time.time() - t0))
for f in files:
    d, sr = sf.read(os.path.join(out, f))
    print(f, sr, d.shape, "max %.3f rms %.4f" % (np.abs(d).max(), np.sqrt((d ** 2).mean())))

"""Song structure draft (intro / verse / pre-chorus / chorus / bridge / inst / outro) -> data/sections.auto.json,
plus a SECTION_BARS draft for analysis/analyze.py with every boundary snapped to the nearest bar line.

  python analysis/structure.py            (from the project root; set up once with the base engine's analysis/setup_structure.py)

Model: SongFormer (ASLP-lab, CC BY 4.0) on MuQ + MusicFM features, run in its own environment
(SHARED/.venv): this script re-launches itself there. A draft, not the answer: listen, then fix it in SECTION_BARS
and lock it with the beat-check video (docs/新项目流程.md step 1). On five finished songs it found 10/11, 8/8,
10/13 and 4/7 of the hand-placed boundaries within ±3 s (base engine docs/模型选型.md).

Bars come from data/audio.json's downbeats (bar k starts at downbeats[k], same as analyze.py's bar_t), so run
analyze.py once first; without it the times are printed unsnapped. Prints times and labels only.
MuQ's weights are CC-BY-NC 4.0: see the base engine's docs/模型选型.md before using this on paid work.
"""
import json
import os
import subprocess
import sys
import types
from pathlib import Path

ROOT = Path.cwd()  # run from the project root
SHARED = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "analysis", "models", "songformer")
HOME = Path(os.environ.get("XM_SONGFORMER") or SHARED)
REPO = HOME / "repo"
PY = HOME / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
SNAP = 1.5  # s: snap a boundary to a bar line only if one is this close


def relaunch():
    if not PY.exists():
        sys.exit(f"SongFormer environment not found at {HOME}: run python {HOME.parents[1] / 'setup_structure.py'} first")
    env = dict(os.environ, PYTHONUTF8="1", PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True", XM_SONGFORMER=str(HOME))
    sys.exit(subprocess.run([str(PY), os.path.abspath(__file__), *sys.argv[1:]], env=env, cwd=ROOT).returncode)


def load_songformer():
    """app.py's model code minus the Gradio UI, with three fixes for a 12 GB GPU and transformers 4.57."""
    import torch
    import torch.nn.functional as F
    from transformers.models.wav2vec2_conformer import modeling_wav2vec2_conformer as w2c

    # 1. MuQ's conformer computes the full T x T attention (420 s windows: 3.3 GB per layer); same math via SDPA
    orig = w2c.Wav2Vec2ConformerSelfAttention.forward

    def sdpa_forward(self, hidden_states, attention_mask=None, relative_position_embeddings=None, output_attentions=False):
        if self.position_embeddings_type == "relative" or output_attentions:
            return orig(self, hidden_states, attention_mask, relative_position_embeddings, output_attentions)
        b, qk = hidden_states.size(0), hidden_states
        if self.position_embeddings_type == "rotary":
            qk = self._apply_rotary_embedding(qk, relative_position_embeddings)
        q = self.linear_q(qk).view(b, -1, self.num_heads, self.head_size).transpose(1, 2)
        k = self.linear_k(qk).view(b, -1, self.num_heads, self.head_size).transpose(1, 2)
        v = self.linear_v(hidden_states).view(b, -1, self.num_heads, self.head_size).transpose(1, 2)
        h = F.scaled_dot_product_attention(q, k, v, attn_mask=attention_mask)
        return self.linear_out(h.transpose(1, 2).reshape(b, -1, self.num_heads * self.head_size)), None

    w2c.Wav2Vec2ConformerSelfAttention.forward = sdpa_forward
    # 2. MusicFM's flash conformer: its transformers.deepspeed import is gone in 4.57, and it pins the flash
    #    kernel (fp16 only) -> let SDPA pick a kernel
    ds = types.ModuleType("transformers.deepspeed")
    ds.is_deepspeed_zero3_enabled = lambda: False
    sys.modules["transformers.deepspeed"] = ds
    import contextlib
    torch.backends.cuda.sdp_kernel = lambda *a, **k: contextlib.nullcontext()
    sys.modules["gradio"] = types.ModuleType("gradio")
    sys.path.insert(0, str(REPO / "src" / "third_party" / "musicfm"))

    src = (REPO / "app.py").read_text(encoding="utf-8").split("# Create Gradio interface")[0]
    src = src.replace("is_flash=False", "is_flash=True")
    cwd = os.getcwd()
    g = {"__name__": "songformer_app", "__file__": str(REPO / "app.py")}
    os.chdir(REPO)  # app.py chdirs to src/SongFormer itself and loads ckpts/ and configs/ relative to it
    try:
        exec(compile(src, str(REPO / "app.py"), "exec"), g)
        g["initialize_models"](model_name="SongFormer", checkpoint="SongFormer.safetensors", config_path="SongFormer.yaml")
    finally:
        songformer_dir = os.getcwd()
        os.chdir(cwd)

    # 3. MuQ under bf16 autocast (fp16 overflows to an empty result); hidden states back to fp32
    muq = g["muq_model"]

    class Bf16:
        def __call__(self, x, output_hidden_states=True):
            with torch.autocast("cuda", dtype=torch.bfloat16):
                o = muq(x, output_hidden_states=True)
            return {"hidden_states": [h.float() for h in o["hidden_states"]]}

    g["muq_model"] = Bf16()

    def analyse(wav):
        os.chdir(songformer_dir)
        try:
            _, msa = g["process_audio"](str(wav))
            return [(float(t), str(l)) for t, l in g["rule_post_processing"](msa)]
        finally:
            os.chdir(cwd)

    return analyse


def name_sections(msa):
    """[(t, label), ..., (t_end, 'end')] -> sections; repeats numbered (verse1, verse2), a label continuing
    straight into itself gets b / c (chorus2, chorus2b), like the hand-made maps."""
    out, count, prev = [], {}, None
    for (t, lab), (t1, _) in zip(msa, msa[1:]):
        if lab == prev:
            k = sum(1 for s in out if s["label"] == lab and s["n"] == count[lab])
            name = f"{lab}{count[lab]}{chr(ord('a') + k)}"
        else:
            count[lab] = count.get(lab, 0) + 1
            name, k = f"{lab}{count[lab]}", 0
        out.append(dict(name=name, label=lab, n=count[lab], start=round(t, 3), end=round(t1, 3)))
        prev = lab
    return out


def main():
    wav = ROOT / "audio" / "song.wav"
    if not wav.exists():
        sys.exit("audio/song.wav not found (run from the project root)")
    msa = load_songformer()(wav)
    secs = name_sections(msa)

    down = []
    ap = ROOT / "data" / "audio.json"
    if ap.exists():
        down = json.loads(ap.read_text(encoding="utf-8")).get("downbeats", [])
    for s in secs:
        s["bar"] = None
        if down:
            k = min(range(len(down)), key=lambda i: abs(down[i] - s["start"]))
            if abs(down[k] - s["start"]) <= SNAP:
                s["bar"], s["start_bar_t"] = k, round(down[k], 3)

    (ROOT / "data").mkdir(exist_ok=True)
    doc = dict(model="SongFormer (ASLP-lab, CC BY 4.0; MuQ weights CC-BY-NC 4.0)", snap_s=SNAP, sections=secs,
               notes="Draft from analysis/structure.py. bar = analyze.py bar index (downbeats[bar]) when a bar line is "
                     "within snap_s of the model's boundary, else null.")
    (ROOT / "data" / "sections.auto.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"{'section':14s} {'start':>8s} {'end':>8s}  bar")
    for s in secs:
        print(f"{s['name']:14s} {s['start']:8.2f} {s['end']:8.2f}  {'' if s['bar'] is None else s['bar']}")
    if down:
        print("\nSECTION_BARS draft for analysis/analyze.py (check by ear, then lock with the beat-check video):")
        keep = [s for s in secs if s["label"] not in ("silence", "end")]
        rows = []
        for i, s in enumerate(keep):
            a = None if i == 0 else s["bar"]
            b = None if i == len(keep) - 1 else keep[i + 1]["bar"]
            rows.append(f'    ("{s["name"]}", {a}, {b}),' + ("" if (i == 0 or a is not None) and (i == len(keep) - 1 or b is not None)
                                                              else "   # no bar line within %.1f s: place by hand" % SNAP))
        print("SECTION_BARS = [\n" + "\n".join(rows) + "\n]")
    else:
        print("\n(no data/audio.json downbeats yet: run analysis/analyze.py once to get bar numbers)")
    print("-> data/sections.auto.json")


if __name__ == "__main__":
    if Path(sys.executable).resolve() != PY.resolve():
        relaunch()
    main()

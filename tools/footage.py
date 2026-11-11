"""视频素材抽成序列帧：给 app 里的 footage 图层用（engine/plate.ts 的 loadFootage、engine/layers.ts 的 footage）。

为什么要抽帧：浏览器里 <video> 跳到某一帧不保证准，导出又是一帧一帧、子帧任意顺序地渲；抽成图片后每一帧都确定。

  # 在项目根目录跑：写到 assets/footage/<名字>/（00001.jpg … + meta.json）
  python tools/footage.py 素材/采访.mp4 --name interview
  python tools/footage.py clip.mov --name logo --png              # 带透明通道（ProRes 4444、PNG 序列、WebM alpha）用 PNG
  python tools/footage.py clip.mp4 --name a --from 3.5 --to 9     # 只要原片 3.5–9 秒
  python tools/footage.py clip.mp4 --name a --fps 30 --width 1280 # 改帧率、缩小（高按比例）
  python tools/footage.py --test demo                             # 不要原片：ffmpeg 生成 4 秒测试片（帧号、色条、走动的块）

场景里：
  clip = await loadFootage(this.ctx.renderer, '/assets/footage/interview');   // init 里
  comp.layers = [{ name: 'clip', footage: clip, start: 12.0 }];               // 素材的 0 秒在合成的 12 秒；size 自动 = 帧尺寸
  prepare(t, t0, t1) { return this.comp.prepare(t, t0, t1); }                 // 导出时等帧读完

颜色：按 BT.709 解成 sRGB（JPG 质量 2）；HDR / 10 bit 素材先自己转。帧号从 1 开始。assets/footage/ 不进 git。
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ffmpeg_path import FFMPEG, FFPROBE  # noqa: E402


def probe(src: Path) -> dict:
    out = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=width,height,r_frame_rate,avg_frame_rate,pix_fmt:format=duration", "-of", "json", str(src)],
                         capture_output=True, text=True, encoding="utf-8")
    if out.returncode != 0:
        sys.exit(f"ffprobe 读不了 {src}：{out.stderr.strip()}")
    j = json.loads(out.stdout)
    st = j["streams"][0]
    num, den = (st.get("avg_frame_rate") or st["r_frame_rate"]).split("/")
    fps = float(num) / float(den) if float(den) else 30.0
    return {"width": st["width"], "height": st["height"], "fps": fps, "pix_fmt": st.get("pix_fmt", ""),
            "duration": float(j.get("format", {}).get("duration") or 0)}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("src", nargs="?", help="视频文件")
    ap.add_argument("--name", help="输出目录名（assets/footage/<name>/），默认用文件名")
    ap.add_argument("--out", help="输出目录（给了就不用 assets/footage/<name>）")
    ap.add_argument("--from", dest="t0", type=float, help="从原片第几秒开始")
    ap.add_argument("--to", dest="t1", type=float, help="到原片第几秒")
    ap.add_argument("--fps", type=float, help="改帧率（默认原片的）")
    ap.add_argument("--width", type=int, help="缩到这个宽（高按比例，取偶数）")
    ap.add_argument("--png", action="store_true", help="存 PNG（保留透明通道），默认 JPG")
    ap.add_argument("--test", metavar="NAME", help="生成测试片当素材：4 秒、30 fps、1280×720，带帧号")
    a = ap.parse_args()

    if a.test:
        name, src = a.test, None
    else:
        if not a.src:
            ap.error("要给视频文件，或者 --test <名字>")
        src = Path(a.src)
        if not src.exists():
            sys.exit(f"找不到 {src}")
        name = a.name or src.stem
    out = Path(a.out) if a.out else Path("assets/footage") / name
    out.mkdir(parents=True, exist_ok=True)
    for old in list(out.glob("*.jpg")) + list(out.glob("*.png")):
        old.unlink()

    ext = "png" if a.png else "jpg"
    pattern = f"%05d.{ext}"
    vf = []
    if a.test:
        fps, w, h = 30.0, 1280, 720
        cmd = [FFMPEG, "-v", "error", "-f", "lavfi", "-i", f"testsrc2=size={w}x{h}:rate=30:duration=4"]
        vf.append("drawtext=text='%{frame_num}':start_number=1:x=40:y=40:fontsize=96:fontcolor=white:box=1:boxcolor=black@0.6")
        source = "testsrc2"
    else:
        info = probe(src)
        fps = a.fps or info["fps"]
        cmd = [FFMPEG, "-v", "error"]
        if a.t0 is not None:
            cmd += ["-ss", str(a.t0)]
        if a.t1 is not None:
            cmd += ["-to", str(a.t1)]
        cmd += ["-i", str(src)]
        if a.fps:
            vf.append(f"fps={a.fps}")
        source = str(src)
    if a.width:
        vf.append(f"scale={a.width}:-2:flags=lanczos")
    # BT.709 → sRGB-ish RGB (full range); alpha kept for PNG
    vf.append("scale=in_color_matrix=bt709:out_range=full")
    vf.append(f"format={'rgba' if a.png else 'rgb24'}")
    cmd += ["-vf", ",".join(vf), "-start_number", "1"]
    if not a.png:
        cmd += ["-q:v", "2"]
    cmd += [str(out / pattern)]
    r = subprocess.run(cmd)
    if r.returncode != 0:
        sys.exit("ffmpeg 失败")

    frames = sorted(out.glob(f"*.{ext}"))
    if not frames:
        sys.exit("一帧都没抽出来")
    w, h = probe(frames[0])["width"], probe(frames[0])["height"]
    meta = {"fps": fps, "first": 1, "last": len(frames), "width": w, "height": h, "pattern": "#####." + ext,
            "duration": len(frames) / fps, "source": source}
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{out}：{len(frames)} 帧，{w}×{h}，{fps:g} fps（{meta['duration']:.2f} 秒）")


if __name__ == "__main__":
    main()

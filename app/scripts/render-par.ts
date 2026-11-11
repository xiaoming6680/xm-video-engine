#!/usr/bin/env bun
// Parallel export: the song in chunks, each rendered by its own headless browser (render.ts video --noaudio),
// several at once, then a lossless concat with the audio muxed once. With ANGLE on Vulkan (render.ts --angle) the GPU
// is the limit: on an RTX 5070 Ti laptop at 1080p, 1 browser keeps it ~40% busy, 3–4 ~80% (≈3x the frames per
// second), 6–8 only add ~5% more for ~1.5 GB of VRAM each; hence 4 workers at 1080p. At --scale 2 (4K) each browser
// is bound by Canvas2D rasterization in its GPU process and 2 give as many frames per second as 3 (~2.3 GB each):
// 2 workers. The VRAM guard below holds back a browser that would not fit. Each chunk loads only its own scenes
// (render.ts → main.ts ?span). Chunks are frame-aligned and taken from a queue in order; a finished chunk is kept, so
// an interrupted export resumes where it stopped.
//   bun scripts/render-par.ts [--workers 4] [--chunk 8] [--from <VIDEO_START>] [--to <VIDEO_END>] [--out <config OUT>]
//     [--vram-reserve 1.5]  GB of VRAM kept free (NVIDIA): a chunk waits for room before its browser starts
//     [--quiet 105]  the song is silent before this song time (a lead-in before the music, e.g. the hook from 101.5)
//     [--fadein 2.2] the song fades in over this long from --quiet (so the music does not come in abruptly)
//     [--ding 102.4] a soft two-note chime at this song time (the message arriving; generated, not a sampled sound)
//     [--gain -3]    audio gain in dB;  [--af <filters>] audio filters (default: src/config.ts AUDIO_FILTER)
//     [--song <dir>] another song's files (<dir>/song.wav, audio.json …; passed on to render.ts too)
//                             [render.ts video options, passed on: --samples auto --max-samples 108 --shutter 0.2 --crf 16 …]
// Times are song seconds (src/config.ts VIDEO_START / VIDEO_END). ffmpeg: see scripts/common.ts.
// Stopping it (Ctrl+C, SIGTERM, or the shells it was started from going away — a task stop that ends only the outer
// shell) takes every chunk's render.ts down with its ffmpeg, browser and vite; --no-watch: keep running when the shell
// goes. Leftovers of older runs (out/<name>.seg held): bun scripts/kill-render.ts.
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { config, findFfmpeg, killTree, ancestors, watchParents } from './common';

const argv = process.argv.slice(2);
const OWN = ['workers', 'chunk', 'from', 'to', 'out', 'fps', 'quiet', 'ding', 'fadein', 'gain', 'af', 'vram-reserve'];
// the chunks' render.ts and the final ffmpeg: their trees die with this process however it ends
const kids = new Set<number>();
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const pid of kids) killTree(pid);
}
function abort(why: string, code = 1) {
  console.error(`\n${why}: stopping the export (rerun the same command to resume)`);
  cleanup();
  process.exit(code);
}
process.on('exit', cleanup);
process.on('SIGINT', () => abort('SIGINT', 130));
process.on('SIGTERM', () => abort('SIGTERM', 143));
if (!argv.includes('--no-watch')) watchParents(ancestors(), () => abort('the shell that started this export is gone'));
const opt = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const pass: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const k = argv[i]!.replace(/^--/, '');
  if (OWN.includes(k)) { i++; continue; }
  if (k === 'no-watch') continue; // (the chunks always watch this process)
  pass.push(argv[i]!);
}
const APP = path.resolve(import.meta.dir, '..'), ROOT = path.resolve(APP, '..');
const FPS = +opt('fps', '60')!;
// --song <dir> (also passed on to each render.ts): its audio.json and song.wav instead of data/ and src/config.ts AUDIO
const SONG = opt('song');
const DUR: number = JSON.parse(readFileSync(path.join(ROOT, SONG ?? 'data', 'audio.json'), 'utf-8')).duration;
const from = +opt('from', String(config.VIDEO_START))!, to = +opt('to', String(Math.min(DUR, config.VIDEO_END ?? Infinity)))!;
const out = path.resolve(opt('out', path.join(ROOT, config.OUT))!);
const workers = +opt('workers', +opt('scale', '1')! >= 2 ? '2' : '4')!, chunk = +opt('chunk', '8')!;
const segDir = path.join(path.dirname(out), `${path.basename(out, '.mp4')}.seg`);
if (!existsSync(segDir)) mkdirSync(segDir, { recursive: true });

// frame-aligned chunks [n0, n1)
const n0 = Math.round(from * FPS), nEnd = Math.round(to * FPS), step = Math.max(1, Math.round(chunk * FPS));
const chunks: { k: number; a: number; b: number; file: string }[] = [];
for (let n = n0, k = 0; n < nEnd; n += step, k++) {
  const b = Math.min(nEnd, n + step);
  chunks.push({ k, a: n, b, file: path.join(segDir, `c${String(k).padStart(3, '0')}_${n}-${b}.mp4`) });
}
const done = (c: (typeof chunks)[number]) => existsSync(`${c.file}.done`) && existsSync(c.file) && statSync(c.file).size > 0;
const todo = chunks.filter((c) => !done(c));
console.log(`${chunks.length} chunks of ${step} frames, ${todo.length} to render, ${workers} at a time -> ${segDir}`);

// VRAM guard (NVIDIA, nvidia-smi): a browser starts only when the VRAM has room for it plus --vram-reserve GB, and
// when the VRAM runs out anyway the newest chunk is stopped and queued again. A full VRAM froze the whole desktop
// (Windows reset the display driver) with 3 browsers at 4K. Per browser: ~1.5 GB at 1080p, ~2.5 GB at 4K, refined from
// what the run uses.
function vram(): { used: number; total: number } | null {
  try {
    const r = Bun.spawnSync(['nvidia-smi', '--query-gpu=memory.used,memory.total', '--format=csv,noheader,nounits']);
    const [u, t] = r.stdout.toString().split('\n')[0]!.split(',').map(Number);
    return r.exitCode === 0 && u! >= 0 && t! > 0 ? { used: u!, total: t! } : null;
  } catch { return null; }
}
const RESERVE = +opt('vram-reserve', '1.5')! * 1024;
const VRAM0 = vram();
let perBrowser = (+opt('scale', '1')! >= 2 ? 2.5 : 1.5) * 1024;
const live: { pid: number; at: number; evicted?: boolean }[] = [];
if (VRAM0) setInterval(() => {
  const v = vram();
  if (!v || !live.length) return;
  perBrowser = Math.max(perBrowser, (v.used - VRAM0.used) / live.length);
  if (v.total - v.used < 512 && live.length > 1) {
    const newest = live.reduce((a, b) => (b.at > a.at ? b : a));
    if (!newest.evicted && newest.pid) { newest.evicted = true; console.log(`VRAM nearly full (${v.used}/${v.total} MB): stopping the newest chunk, it runs again later`); killTree(newest.pid); }
  }
}, 2000).unref();
/** Waits until one more browser fits in the VRAM and books its place (check and booking in one step: the workers start together). */
async function slot() {
  for (;;) {
    const v = VRAM0 && live.length ? vram() : null;
    // (a browser that just started has not allocated yet: count every running one at its full share)
    const fits = !v || Math.max(v.used, VRAM0!.used + live.length * perBrowser) + perBrowser + RESERVE <= v.total;
    if (fits) { const me: (typeof live)[number] = { pid: 0, at: performance.now() }; live.push(me); return me; }
    await Bun.sleep(2000);
  }
}

const t0 = performance.now();
let next = 0, finished = chunks.length - todo.length, failed = 0;
async function run(c: (typeof chunks)[number], attempt = 1): Promise<void> {
  const me = await slot();
  // (this bun itself, not 'bun': no cmd.exe shim in between; --parent: the chunk stops when this process is gone)
  const args = [process.execPath, 'scripts/render.ts', 'video', '--from', String(c.a / FPS), '--to', String(c.b / FPS), '--fps', String(FPS), '--noaudio', '--out', c.file, '--parent', String(process.pid), ...pass];
  const p = Bun.spawn(args, { cwd: APP, stdout: 'pipe', stderr: 'pipe', env: process.env });
  kids.add(p.pid);
  me.pid = p.pid;
  const [so, se] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  live.splice(live.indexOf(me), 1);
  kids.delete(p.pid);
  if (me.evicted) return run(c, attempt);
  const frames = /\((\d+) frames in/.exec(so)?.[1];
  if (p.exitCode === 0 && frames && +frames === c.b - c.a && existsSync(c.file)) {
    writeFileSync(`${c.file}.done`, so.split('\n').filter((l) => /sub-frames|wrote/.test(l)).join('\n'));
    finished++;
    const el = (performance.now() - t0) / 60000;
    console.log(`chunk ${c.k} (${(c.a / FPS).toFixed(2)}–${(c.b / FPS).toFixed(2)} s) done  [${finished}/${chunks.length}, ${el.toFixed(1)} min]  ${/sub-frames[^\n]*/.exec(so)?.[0] ?? ''}`);
  } else if (attempt < 2) {
    console.log(`chunk ${c.k} failed (exit ${p.exitCode}), retrying:\n${(se || so).split('\n').slice(-8).join('\n')}`);
    return run(c, attempt + 1);
  } else {
    failed++;
    console.log(`chunk ${c.k} FAILED:\n${(se || so).split('\n').slice(-12).join('\n')}`);
  }
}
await Promise.all(Array.from({ length: Math.min(workers, todo.length) }, async () => { while (next < todo.length) await run(todo[next++]!); }));
if (failed) { console.log(`${failed} chunk(s) failed; rerun the same command to resume`); process.exit(1); }

// lossless concat of the chunks + the song's audio over the same span
const list = path.join(segDir, 'list.txt');
writeFileSync(list, chunks.map((c) => `file '${c.file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n') + '\n');
const quiet = +opt('quiet', '0')!, ding = opt('ding');
const dur = (nEnd - n0) / FPS, Q = Math.max(quiet, n0 / FPS), lead = Q - n0 / FPS;
const ffIn = ['-f', 'concat', '-safe', '0', '-i', list, '-ss', String(Q), '-t', String(dur - lead), '-i', SONG ? path.join(ROOT, SONG, 'song.wav') : path.join(ROOT, config.AUDIO)];
const ms = Math.round(lead * 1000);
const fadeIn = +opt('fadein', '0')!, gain = +opt('gain', '0')!; // (--gain -4.5: the release, true peak under -1 dBTP)
// audio filters: --af, else src/config.ts AUDIO_FILTER (e.g. taming a hot master), else none
const af = opt('af', config.AUDIO_FILTER ?? '')!;
const master = af ? `${af},` : '';
let graph = `[1:a]${master}${gain ? `volume=${gain}dB,` : ''}${fadeIn > 0 ? `afade=t=in:st=0:d=${fadeIn},` : ''}adelay=${ms}|${ms},apad[s]`, mixIn = '[s]', nMix = 1;
if (ding) {
  ffIn.push('-f', 'lavfi', '-i', 'sine=frequency=1318.5:duration=0.7', '-f', 'lavfi', '-i', 'sine=frequency=1975.5:duration=0.7');
  const d = Math.round((+ding - n0 / FPS) * 1000);
  graph += `;[2:a]aformat=channel_layouts=stereo,volume=0.9,afade=t=in:d=0.004,afade=t=out:st=0.03:d=0.6,adelay=${d}|${d}[d1]`;
  graph += `;[3:a]aformat=channel_layouts=stereo,volume=0.6,afade=t=in:d=0.004,afade=t=out:st=0.03:d=0.55,adelay=${d + 110}|${d + 110}[d2]`;
  mixIn += '[d1][d2]'; nMix = 3;
}
graph += `;${mixIn}amix=inputs=${nMix}:normalize=0,atrim=0:${dur.toFixed(4)}[a]`;
const ff = Bun.spawn([findFfmpeg(), '-y', '-loglevel', 'error', ...ffIn, '-filter_complex', graph,
  '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', '-movflags', '+faststart', out], { stdout: 'inherit', stderr: 'inherit' });
kids.add(ff.pid);
await ff.exited;
kids.delete(ff.pid);
console.log(ff.exitCode === 0 ? `wrote ${out} (${((performance.now() - t0) / 60000).toFixed(1)} min)` : `concat failed (exit ${ff.exitCode})`);

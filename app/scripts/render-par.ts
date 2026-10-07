#!/usr/bin/env bun
// Parallel export: the song in chunks, each rendered by its own headless browser (render.ts video --noaudio),
// several at once, then a lossless concat with the audio muxed once. On Windows (ANGLE on Direct3D 11) each
// browser's GPU process is bound by one CPU core while the GPU idles, so an export scales with the number of
// browsers. Chunks are frame-aligned and taken from a queue in order; a finished chunk is kept, so an interrupted
// export resumes where it stopped.
//   bun scripts/render-par.ts [--workers 6] [--chunk 8] [--from <VIDEO_START>] [--to <VIDEO_END>] [--out <config OUT>]
//     [--quiet 105]  the song is silent before this song time (a lead-in before the music, e.g. the hook from 101.5)
//     [--fadein 2.2] the song fades in over this long from --quiet (so the music does not come in abruptly)
//     [--ding 102.4] a soft two-note chime at this song time (the message arriving; generated, not a sampled sound)
//     [--gain -3]    audio gain in dB;  [--af <filters>] audio filters (default: src/config.ts AUDIO_FILTER)
//     [--song <dir>] another song's files (<dir>/song.wav, audio.json …; passed on to render.ts too)
//                             [render.ts video options, passed on: --samples auto --max-samples 108 --shutter 0.2 --crf 16 …]
// Times are song seconds (src/config.ts VIDEO_START / VIDEO_END). ffmpeg: see scripts/common.ts.
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { config, findFfmpeg } from './common';

const argv = process.argv.slice(2);
const OWN = ['workers', 'chunk', 'from', 'to', 'out', 'fps', 'quiet', 'ding', 'fadein', 'gain', 'af'];
const opt = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const pass: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const k = argv[i]!.replace(/^--/, '');
  if (OWN.includes(k)) { i++; continue; }
  pass.push(argv[i]!);
}
const APP = path.resolve(import.meta.dir, '..'), ROOT = path.resolve(APP, '..');
const FPS = +opt('fps', '60')!;
// --song <dir> (also passed on to each render.ts): its audio.json and song.wav instead of data/ and src/config.ts AUDIO
const SONG = opt('song');
const DUR: number = JSON.parse(readFileSync(path.join(ROOT, SONG ?? 'data', 'audio.json'), 'utf-8')).duration;
const from = +opt('from', String(config.VIDEO_START))!, to = +opt('to', String(Math.min(DUR, config.VIDEO_END ?? Infinity)))!;
const out = path.resolve(opt('out', path.join(ROOT, config.OUT))!);
const workers = +opt('workers', '6')!, chunk = +opt('chunk', '8')!;
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

const t0 = performance.now();
let next = 0, finished = chunks.length - todo.length, failed = 0;
async function run(c: (typeof chunks)[number], attempt = 1): Promise<void> {
  const args = ['bun', 'scripts/render.ts', 'video', '--from', String(c.a / FPS), '--to', String(c.b / FPS), '--fps', String(FPS), '--noaudio', '--out', c.file, ...pass];
  const p = Bun.spawn(args, { cwd: APP, stdout: 'pipe', stderr: 'pipe', env: process.env });
  const [so, se] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
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
await ff.exited;
console.log(ff.exitCode === 0 ? `wrote ${out} (${((performance.now() - t0) / 60000).toFixed(1)} min)` : `concat failed (exit ${ff.exitCode})`);

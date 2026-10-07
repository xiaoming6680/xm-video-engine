#!/usr/bin/env bun
// Offline renderer. Drives the app in headless Edge/Chrome (?export=1) and either
//   stills:  bun scripts/render.ts stills --t 110.5,120 [--only id1,id2] [--out dir]
//   sheet:   bun scripts/render.ts sheet --from 105 --to 120 [--n 12] [--cols 4] [--only ids] [--out file.png]   (or --times a,b,c | --cuts)
//   perf:    bun scripts/render.ts perf --from 110 --to 115 [--only ids] [--samples 1] [--shutter 0.5]
//   video:   bun scripts/render.ts video [--from 105] [--to 204.11] [--fps 60] [--crf 16] [--samples 1] [--shutter 0.5] [--out ../out/film.mp4] [--noaudio] [--af <ffmpeg audio filters>]
//            --samples N averages N sub-frames per frame over shutter×(1/fps): motion blur + temporal AA;
//            --samples auto picks the count per frame (4, 12, 36, 108 or 324, see Engine.render)
//   beatcheck: bun scripts/render.ts beatcheck [--out ../out/check/beatcheck.mp4]   (the song over the analysis: bars,
//            beats, sections, sound events, lyric lines by number; docs/新项目流程.md step 1. 30 fps, fast encode)
//   animatic:  bun scripts/render.ts animatic [--from] [--to] [--out ../out/animatic/animatic.mp4]   (the timeline with a
//            slate on every frame: bar "06/63", shot id, section, beats; step 3. 30 fps, 1 sample, fast encode)
//   info:    bun scripts/render.ts info   (the timeline and every lyric line: index, times, length — never the text)
//   scan:    bun scripts/render.ts scan [--from 0] [--to <end>] [--step 0.1]   (renders without saving; prints the scenes' warnings)
//   cues:    bun scripts/render.ts cues [--out ../out/qa/cues.json]   (scenes' cues + cuts, for tools/qa/cuecheck.py)
//   glyphs:  bun scripts/render.ts glyphs [--from 0] [--to <end>] [--step 0.1]   (every character drawn in a font that lacks
//            it — Canvas2D falls back to a system font, outlines come out blank; exit code 1 if any)
//   --scale N (all modes): render at N× the W x H layout of src/config.ts (--scale 2 = 4K for 1920x1080).
//   --query k=v (all modes): extra URL parameters for the app (e.g. style=wire for look tests).
//   --channel msedge (all modes): drive installed Edge (default here: msedge; there is no Chrome on this machine).
// Times are SONG seconds; the video is the song from VIDEO_START to VIDEO_END (src/config.ts).
// ffmpeg: $FFMPEG, PATH, or the known installs (scripts/common.ts). Output is BT.709 and tagged as such.
// (a server for --url must serve THIS app; without --url a private no-HMR server is started for the run).
import { chromium, type Page } from 'playwright-core';
import { mkdirSync as mkdirSync0, existsSync } from 'node:fs';
import path from 'node:path';
import { config, findFfmpeg } from './common';
// (Bun on Windows throws EEXIST for an existing directory with a non-ASCII path, even with recursive)
const mkdirSync = (p: string, o: { recursive: boolean }) => { if (!existsSync(p)) mkdirSync0(p, o); };

const argv = process.argv.slice(2);
const mode = argv[0] ?? 'stills';
const opt = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k: string) => argv.includes(`--${k}`);
const APP = path.resolve(import.meta.dir, '..');
const SCALE = Math.max(1, Math.round(+opt('scale', '1')!));
// the logical frame (src/config.ts W x H)
const LW = config.W, LH = config.H;
const OW = LW * SCALE, OH = LH * SCALE; // output size
// --samples N (fixed) or --samples auto [--min-samples 4] [--max-samples 324] [--tol 3] (adaptive, see Engine.render)
const SAMPLES = opt('samples', '1') === 'auto'
  ? { min: +opt('min-samples', '4')!, max: +opt('max-samples', '324')!, tol: +opt('tol', '3')! }
  : +opt('samples', '1')!;
const hist = (h: Record<string, number>) => Object.entries(h).sort((a, b) => +a[0] - +b[0]).map(([k, v]) => `${k}:${v}`).join(' ');
const ROOT = path.resolve(APP, '..');
const FFMPEG = findFfmpeg();
const VIDEO_START = config.VIDEO_START, VIDEO_END = config.VIDEO_END ?? Infinity;

async function reachable(url: string) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}

async function ensureServer(): Promise<{ url: string; stop: () => void }> {
  // Only an explicit --url is reused: a server already on 5173 may belong to another project (several projects
  // share this engine), so by default every run starts its own server for this app.
  const url = opt('url');
  if (url) { if (await reachable(url)) return { url, stop: () => {} }; throw new Error(`--url ${url} is not reachable`); }
  // a port nobody answers on: with --strictPort a taken port makes our vite exit, and the run would then render
  // whichever project's server holds that port (it happened with other projects' renders running)
  let port = 0;
  for (let i = 0; i < 40 && !port; i++) { const p = 5300 + Math.floor(Math.random() * 500); if (!(await reachable(`http://localhost:${p}`))) port = p; }
  if (!port) throw new Error('no free port in 5300-5799 for the render server');
  // no live reload: a file saved mid-render must not reload the page
  const proc = Bun.spawn(['bunx', 'vite', '--port', String(port), '--strictPort'], { cwd: APP, stdout: 'ignore', stderr: 'ignore', env: { ...process.env, PDOOM_NO_HMR: '1' } });
  const u = `http://localhost:${port}`;
  for (let i = 0; i < 100 && !(await reachable(u)); i++) {
    if (proc.exitCode !== null) throw new Error(`the render server (vite on ${port}) exited before answering: port taken? rerun`);
    await Bun.sleep(100);
  }
  if (proc.exitCode !== null) throw new Error(`the render server (vite on ${port}) is not ours: it exited, another server answers there; rerun`);
  // (bunx starts vite as a child: kill the whole tree, or every run leaves a vite behind — 118 had piled up and starved
  // the renders of memory)
  const stop = () => { if (process.platform === 'win32') Bun.spawnSync(['taskkill', '/PID', String(proc.pid), '/T', '/F']); proc.kill(); };
  return { url: u, stop };
}

// ANGLE backend: Metal on macOS, Direct3D 11 on Windows, the browser's default elsewhere
const ANGLE = process.platform === 'darwin' ? ['--use-angle=metal'] : process.platform === 'win32' ? ['--use-angle=d3d11'] : [];

async function openPage(url: string) {
  const browser = await chromium.launch({
    channel: opt('channel', 'msedge'),
    headless: !flag('headed'),
    args: [...ANGLE, '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  const page = await browser.newPage({ viewport: { width: LW, height: LH }, deviceScaleFactor: 1 });
  const logs: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  const only = opt('only');
  const modeQ = mode === 'beatcheck' ? '&beatcheck=1' : mode === 'animatic' ? '&animatic=1' : mode === 'glyphs' ? '&glyphcheck=1' : '';
  await page.goto(`${url}/?export=1${modeQ}${only ? `&only=${only}` : ''}${SCALE !== 1 ? `&scale=${SCALE}` : ''}${opt('query') ? `&${opt('query')}` : ''}`);
  await page.waitForFunction(() => (window as any).__pdoom?.ready || (window as any).__pdoom?.error, null, { timeout: 120000 });
  const err = await page.evaluate(() => (window as any).__pdoom.error);
  if (err) throw new Error(`app failed to boot:\n${err}\n${logs.join('\n')}`);
  const size: [number, number] = await page.evaluate(() => [(window as any).__pdoom.width ?? 0, (window as any).__pdoom.height ?? 0]);
  if (size[0] !== OW || size[1] !== OH) throw new Error(`app renders ${size[0]}x${size[1]}, expected ${OW}x${OH} (--scale ${SCALE})`);
  const sceneErrors: string[] = await page.evaluate(() => (window as any).__pdoom.errors);
  if (sceneErrors.length) console.error('SCENE ERRORS:\n' + sceneErrors.join('\n'));
  return { browser, page, logs };
}

async function stills(page: Page, times: number[], outDir: string) {
  mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  for (const t of times) {
    const k: number = await page.evaluate(([t, s, sh]) => (window as any).__pdoom.still(t, s, sh), [t, SAMPLES, +opt('shutter', '0.5')!] as const);
    const f = path.join(outDir, `f_${t.toFixed(2).padStart(7, '0')}.png`);
    if (typeof SAMPLES !== 'number') console.log(`t=${t}: ${k} sub-frames`);
    // at scale > 1 the canvas is shown downscaled on the page: save the full-res pixel buffer instead
    if (SCALE !== 1) await Bun.write(f, Buffer.from(await page.evaluate(() => (window as any).__pdoom.png()), 'base64'));
    else await page.screenshot({ path: f, clip: { x: 0, y: 0, width: LW, height: LH } });
    files.push(f);
  }
  return files;
}

async function sheet(page: Page, times: number[], cols: number, out: string) {
  const dataUrl: string = await page.evaluate(async ({ times, cols }) => {
    const P = (window as any).__pdoom;
    // cells: the long side 320 px, the frame's aspect
    const W = P.width / P.scale, H = P.height / P.scale, k = 320 / Math.max(W, H);
    const cw = Math.round(W * k), ch = Math.round(H * k), pad = 4, lab = 18;
    const rows = Math.ceil(times.length / cols);
    const cv = document.createElement('canvas');
    cv.width = cols * (cw + pad) + pad; cv.height = rows * (ch + lab + pad) + pad;
    const c = cv.getContext('2d')!;
    c.fillStyle = '#222'; c.fillRect(0, 0, cv.width, cv.height);
    const src = document.getElementById('c') as HTMLCanvasElement;
    times.forEach((t: number, i: number) => {
      P.still(t);
      const x = pad + (i % cols) * (cw + pad), y = pad + Math.floor(i / cols) * (ch + lab + pad);
      c.drawImage(src, x, y + lab, cw, ch);
      c.fillStyle = '#ddd'; c.font = '13px monospace'; c.fillText(`${t.toFixed(2)}s`, x + 2, y + 13);
    });
    return cv.toDataURL('image/png');
  }, { times, cols });
  mkdirSync(path.dirname(out), { recursive: true });
  await Bun.write(out, Buffer.from(dataUrl.split(',')[1]!, 'base64'));
}

async function video(page: Page, from: number, to: number, fps: number, out: string) {
  mkdirSync(path.dirname(out), { recursive: true });
  // the review films (beatcheck, animatic) only have to be watchable: a fast encode
  const quick = mode === 'beatcheck' || mode === 'animatic';
  const crf = opt('crf', quick ? '23' : '16')!;
  const audio = path.join(ROOT, config.AUDIO);
  const args = [FFMPEG, '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${OW}x${OH}`, '-r', String(fps), '-i', 'pipe:0'];
  if (!flag('noaudio')) args.push('-ss', String(from), '-t', String(to - from), '-i', audio);
  // Frames are sRGB (toSRGB in the final pass): convert with the BT.709 matrix and tag the stream, otherwise ffmpeg
  // converts with BT.601 while players and platforms decode untagged HD as BT.709 and every colour shifts
  // (upstream pdoom-video 6e7aa9f / bdbad53). setparams: the -color_* output flags don't reach the stream.
  args.push('-vf', 'vflip,scale=out_color_matrix=bt709,setparams=color_primaries=bt709:color_trc=bt709', '-c:v', 'libx264', '-preset', opt('preset', quick ? 'veryfast' : 'slow')!, '-crf', crf, '-pix_fmt', 'yuv420p', ...(quick ? [] : ['-tune', 'grain']), '-x264-params', opt('x264', 'aq-mode=3')!);
  // audio filters: --af, else src/config.ts AUDIO_FILTER, else none (a hot master: see the AUDIO_FILTER example)
  const af = opt('af', config.AUDIO_FILTER ?? '')!;
  if (!flag('noaudio')) args.push(...(af ? ['-af', af] : []), '-c:a', 'aac', '-b:a', '320k', '-shortest');
  args.push('-movflags', '+faststart', out);
  const ff = Bun.spawn(args, { stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' });
  let frames = 0;
  const total = Math.round(to * fps) - Math.round(from * fps);
  const t0 = performance.now();
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) { return srv.upgrade(req) ? undefined : new Response('ws only', { status: 400 }); },
    websocket: {
      maxPayloadLength: Math.max(64 * 1024 * 1024, OW * OH * 4 + 1024),
      async message(ws, msg) {
        ff.stdin.write(msg as Uint8Array);
        await ff.stdin.flush();
        frames++;
        ws.send(String(frames)); // ack: the page keeps at most a few frames ahead of ffmpeg (bounded memory at 4K)
        if (frames % 60 === 0 || frames === total) {
          const el = (performance.now() - t0) / 1000;
          process.stdout.write(`\r${frames}/${total} frames  ${(frames / el).toFixed(1)} fps  eta ${((total - frames) / (frames / el)).toFixed(0)}s   `);
        }
      },
    },
  });
  const used: Record<string, number> = await page.evaluate((o) => (window as any).__pdoom.stream(o), { from, to, fps, ws: `ws://localhost:${server.port}`, samples: SAMPLES, shutter: +opt('shutter', '0.5')!, inflight: 4 });
  // wait for all frames to arrive
  while (frames < total) await Bun.sleep(20);
  ff.stdin.end();
  await ff.exited;
  server.stop();
  console.log(`\nwrote ${out} (${frames} frames in ${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  console.log(`sub-frames per frame (count:frames): ${hist(used)}`);
}

const { url, stop } = await ensureServer();
const { browser, page, logs } = await openPage(url);
try {
  if (mode === 'gpu') {
    console.log(await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2')!;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    }));
  } else if (mode === 'stills') {
    const times = (opt('t') ?? '0').split(',').map(Number);
    const files = await stills(page, times, opt('out', path.join(ROOT, 'out/stills'))!);
    console.log(files.join('\n'));
  } else if (mode === 'sheet') {
    const from = +opt('from', String(VIDEO_START))!, to = +opt('to', String(VIDEO_START + 10))!, n = +opt('n', '12')!;
    let times = Array.from({ length: n }, (_, i) => from + ((to - from) * i) / Math.max(1, n - 1));
    if (opt('times')) times = opt('times')!.split(',').map(Number);
    if (flag('cuts')) {
      // 4 frames around every timeline boundary: 2 frames before, 2 after
      const tl: { id: string; start: number }[] = await page.evaluate(() => (window as any).__pdoom.timeline);
      times = tl.slice(1).flatMap((e) => [e.start - 0.1, e.start - 1 / 60, e.start + 1 / 60, e.start + 0.1]);
    }
    const out = opt('out', path.join(ROOT, `out/sheets/sheet_${from}-${to}.png`))!;
    await sheet(page, times, +opt('cols', '4')!, out);
    console.log(out);
  } else if (mode === 'perf') {
    const from = +opt('from', String(VIDEO_START))!, to = +opt('to', String(VIDEO_START + 5))!;
    const r = await page.evaluate(async ({ from, to, samples, shutter }) => {
      const P = (window as any).__pdoom;
      const ms: number[] = [];
      const buf = new Uint8Array(P.width * P.height * 4);
      P.still(from);
      const used: Record<number, number> = {};
      for (let t = from; t < to; t += 1 / 60) {
        const a = performance.now();
        const k = P.engine.render(t, 1 / 60, false, samples, shutter);
        used[k] = (used[k] ?? 0) + 1;
        await P.engine.readPixelsAsync(buf);
        ms.push(performance.now() - a);
      }
      ms.sort((a, b) => a - b);
      return { n: ms.length, avg: ms.reduce((a, b) => a + b, 0) / ms.length, p50: ms[ms.length >> 1], p95: ms[Math.floor(ms.length * 0.95)], max: ms[ms.length - 1], used };
    }, { from, to, samples: SAMPLES, shutter: +opt('shutter', '0.5')! });
    console.log(`frames ${r.n}  avg ${r.avg.toFixed(1)}ms  p50 ${r.p50.toFixed(1)}  p95 ${r.p95.toFixed(1)}  max ${r.max.toFixed(1)}  sub-frames ${hist(r.used)}`);
  } else if (mode === 'info') {
    const info: { tl: { id: string; start: number; end: number }[]; lines: { i: number; start: number; end: number; n: number; words: number }[] } = await page.evaluate(() => {
      const P = (window as any).__pdoom, E = P.engine;
      // (only the length of each line: lyric text stays out of logs and conversations)
      return { tl: P.timeline, lines: E.lyrics.lines.map((l: any) => ({ i: l.i, start: l.start, end: l.end, n: [...l.text].length, words: l.words.length })) };
    });
    for (const e of info.tl) {
      console.log(`${e.id.padEnd(11)} ${e.start.toFixed(2).padStart(7)} – ${e.end.toFixed(2).padStart(7)}`);
      for (const l of info.lines.filter((l) => l.start >= e.start - 0.05 && l.start < e.end - 0.05))
        console.log(`   line ${String(l.i).padStart(2)}  ${l.start.toFixed(2).padStart(7)} – ${l.end.toFixed(2).padStart(7)}  ${l.n} chars, ${l.words} words`);
    }
  } else if (mode === 'scan') {
    // render every --step s from --from to --to (single sample, nothing saved) for the scenes' own checks: anything a
    // scene reports with console.warn (e.g. Still_Shining's MODESTY camera-vs-skirt check) is printed in full
    const dur: number = await page.evaluate(() => (window as any).__pdoom.duration);
    const from = +opt('from', String(VIDEO_START))!, to = +opt('to', String(Math.min(dur, VIDEO_END)))!, step = +opt('step', '0.1')!;
    for (let t = from; t < to; t += step) await page.evaluate((x) => (window as any).__pdoom.still(x), t);
    const warn = logs.filter((l) => !/404|deprecated/.test(l));
    console.log(`scanned ${from}–${to} every ${step} s: ${warn.length} warnings`);
    for (const l of warn) console.log(l);
    logs.length = 0;
  } else if (mode === 'glyphs') {
    // like scan, with the app counting every character a listed font lacks (src/engine/glyphcheck.ts)
    const dur: number = await page.evaluate(() => (window as any).__pdoom.duration);
    const from = +opt('from', String(VIDEO_START))!, to = +opt('to', String(Math.min(dur, VIDEO_END)))!, step = +opt('step', '0.1')!;
    for (let t = from; t < to; t += step) await page.evaluate((x) => (window as any).__pdoom.still(x), t);
    const miss: { ch: string; code: string; how: string; fonts: string[]; scenes: string[]; first: number; n: number }[] = await page.evaluate(() => (window as any).__pdoom.glyphs());
    console.log(`checked ${from}–${to} every ${step} s (and every scene's init): ${miss.length} missing glyph(s)`);
    for (const m of miss) console.log(`  ${m.ch} ${m.code}  ${m.how}  ×${m.n}  first ${m.first.toFixed(2)}s  scenes: ${m.scenes.join(', ')}  fonts: ${m.fonts.join(' | ')}`);
    if (miss.length) process.exitCode = 1;
  } else if (mode === 'cues') {
    const cues = await page.evaluate(() => (window as any).__pdoom.cues());
    const out = path.resolve(opt('out', path.join(ROOT, 'out/qa/cues.json'))!);
    mkdirSync(path.dirname(out), { recursive: true });
    await Bun.write(out, JSON.stringify({ cues }, null, 1));
    console.log(`${cues.length} cues -> ${out}`);
  } else if (mode === 'video') {
    const dur: number = await page.evaluate(() => (window as any).__pdoom.duration);
    await video(page, +opt('from', String(VIDEO_START))!, +opt('to', String(Math.min(dur, VIDEO_END)))!, +opt('fps', '60')!, path.resolve(opt('out', path.join(ROOT, config.OUT))!));
  } else if (mode === 'beatcheck' || mode === 'animatic') {
    const dur: number = await page.evaluate(() => (window as any).__pdoom.duration);
    const def = mode === 'beatcheck' ? 'out/check/beatcheck.mp4' : 'out/animatic/animatic.mp4';
    await video(page, +opt('from', String(VIDEO_START))!, +opt('to', String(Math.min(dur, VIDEO_END)))!, +opt('fps', '30')!, path.resolve(opt('out', path.join(ROOT, def))!));
  } else throw new Error(`unknown mode '${mode}'`);
  if (logs.length) console.error('BROWSER LOG:\n' + logs.slice(0, 40).join('\n'));
} finally {
  await browser.close();
  stop();
}

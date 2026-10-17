#!/usr/bin/env bun
// Tests library/kit/sfx.ts (the shaders library as an engine layer) against the library itself, in headless Edge:
//   bun scripts/sfx-test.ts [--only Blur,Chrome] [--tests parity,determinism,stepping,input,smoke] [--thumbs]
//                           [--cs p3-linear|srgb] [--scale 2] [--from Name] [--out ../out/sfx_test] [--headed]
// tests (default the five above; also sweep, perf, history): parity, the library's own offline path
// (createRendererFromJSON, 8-bit canvas) vs Sfx, per pixel; determinism, a stateless list at t directly vs after
// other times, a stateful one twice from reset; stepping, t=1 directly vs stepped (finds undeclared state); sweep,
// every prop's variants rendered (errors, NaN); input, EngineTexture's two paths + HDR, the NaN guard and three.js's
// GL state cache; perf, ms per fx.render (--scale 2: 4K); smoke, frames at several times (errors, NaN, coverage).
// Also: --call <fn> --spec '<json>' (one bench function), --catalog <md> --report <json> [--perf <json>]
// [--report4k <json>] (writes src/library/sfx组件.md).
// Writes report.json and summary.md (and, with --thumbs, ref | ours | diff×8 sheets) to --out. Every request to
// another host is blocked and listed (the library must not reach the network: no telemetry, no font CDN).
// Exit code 1 when a test fails (see THRESHOLDS).
import { chromium } from 'playwright-core';
import { mkdirSync as mkdirSync0, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const mkdirSync = (p: string) => { if (!existsSync(p)) mkdirSync0(p, { recursive: true }); };

const argv = process.argv.slice(2);
const opt = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (k: string) => argv.includes(`--${k}`);
const APP = path.resolve(import.meta.dir, '..');
const OUT = path.resolve(APP, opt('out', '../out/sfx_test')!);
const TESTS = new Set((opt('tests', 'parity,determinism,stepping,input,smoke')!).split(','));
const ONLY = opt('only')?.split(',');
const CS = opt('cs', 'p3-linear');
mkdirSync(OUT);

/**
 * Real-time media: a video / the camera play in wall-clock time, a DOM capture needs a live element — not frame-locked,
 * not for offline renders (feed such pixels through EngineTexture instead). Only the smoke test runs, load errors allowed.
 */
const REALTIME = new Set(['VideoTexture', 'WebcamTexture', 'HTMLInCanvas']);

/** Pass thresholds (8-bit sRGB levels). The library draws into an 8-bit canvas, Sfx into a float one: ±1 rounding. */
const THRESHOLDS = { parityMax: 3, parityOver2: 0.002, inputMax: 3 };

async function reachable(url: string) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}
// (once in ~20 runs the page found nobody on the port; not reproduced since: wait longer, retry on another port, and
// keep vite's own output in --out/vite.log and vite.log.err to see why)
async function startServer() {
  const log = path.join(OUT, 'vite.log');
  for (let attempt = 1; ; attempt++) {
    let port = 0;
    for (let i = 0; i < 40 && !port; i++) { const p = 5300 + Math.floor(Math.random() * 500); if (!(await reachable(`http://localhost:${p}`))) port = p; }
    if (!port) throw new Error('no free port');
    const proc = Bun.spawn(['bunx', 'vite', '--port', String(port), '--strictPort'], { cwd: APP, stdout: Bun.file(log), stderr: Bun.file(`${log}.err`), env: { ...process.env, PDOOM_NO_HMR: '1' } });
    const u = `http://localhost:${port}`;
    const stop = () => { if (process.platform === 'win32') Bun.spawnSync(['taskkill', '/PID', String(proc.pid), '/T', '/F']); proc.kill(); };
    let up = false;
    for (let i = 0; i < 600 && !up && proc.exitCode === null; i++) if (!(up = await reachable(u))) await Bun.sleep(100);
    if (up) return { url: u, stop };
    const why = proc.exitCode !== null ? `vite exited (${proc.exitCode})` : 'vite did not answer in 60 s';
    stop();
    if (attempt >= 3) throw new Error(`no test server: ${why} on port ${port}, 3 attempts (${log})`);
    console.log(`test server: ${why} on port ${port}; retrying on another port`);
  }
}

const server = await startServer();
const browser = await chromium.launch({
  channel: opt('channel', 'msedge'),
  headless: !flag('headed'),
  args: ['--use-angle=d3d11', '--enable-gpu-rasterization', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const report: Record<string, any> = { started: new Date().toISOString(), colorSpace: CS, thresholds: THRESHOLDS, components: {} as Record<string, any>, blocked: [] as string[] };
let failed = 0;
/** Thrown to leave a special mode (--call, --catalog) through the finally that stops vite and the browser. */
const DONE = new Error('done');
let special = false;
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  let logs: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(server.url) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
    report.blocked.push(u);
    return route.abort();
  });
  // --scale 2: the page (and every Sfx) at 2x the layout size — for perf only (the parity reference clamps to the viewport)
  const SCALE_Q = opt('scale') ? `&scale=${opt('scale')}` : '';
  await page.goto(`${server.url}/sfxtest.html?cs=${CS}${SCALE_Q}`);
  await page.waitForFunction(() => (window as any).__sfxtest?.ready, null, { timeout: 120000 });
  // --catalog <file.md> [--report <report.json>]: the component catalog (src/library/sfx组件.md), with test results if given
  if (opt('catalog')) {
    const cat: any[] = await page.evaluate(() => (window as any).__sfxtest.catalog());
    const rep = opt('report') ? JSON.parse(await Bun.file(path.resolve(APP, opt('report')!)).text()) : null;
    const rep4k = opt('report4k') ? JSON.parse(await Bun.file(path.resolve(APP, opt('report4k')!)).text()) : null;
    // --perf <report.json>: the 1080p ms column from a perf-only run instead (a quiet machine; the full run's timings carry its noise)
    const repPerf = opt('perf') ? JSON.parse(await Bun.file(path.resolve(APP, opt('perf')!)).text()) : rep;
    const byCat = new Map<string, any[]>();
    for (const c of cat) { const k = c.category || '其他'; if (!byCat.has(k)) byCat.set(k, []); byCat.get(k)!.push(c); }
    const first = (d: string) => { const m = /^(.+?[.!?])(\s|$)/.exec(d); const x = (m ? m[1]! : d).replace(/\|/g, '/'); return x.length > 160 ? `${x.slice(0, 157)}…` : x; };
    const lines = [
      '# shaders 库组件（library/kit/sfx.ts）', '',
      `${cat.length} 个（含引擎的 EngineTexture）。由 \`bun scripts/sfx-test.ts --catalog src/library/sfx组件.md --report ../out/sfx_test/report.json --perf ../out/sfx_perf/report.json --report4k ../out/sfx_perf4k/report.json\` 生成（app 目录下；三份报告来自 \`bun scripts/sfx-test.ts --tests parity,determinism,stepping,input,smoke,sweep --out ../out/sfx_test\`、\`bun scripts/sfx-test.ts --tests perf --out ../out/sfx_perf\` 和 \`bun scripts/sfx-test.ts --tests perf --scale 2 --out ../out/sfx_perf4k\`；测性能时机器上别跑别的），改了原库或重测后重跑；说明是原库的英文原文。`,
      '每个组件的 prop、默认值、取值范围看 `app/src/library/vendor/shaders/shaders/<名>/index.ts`；怎么用见 [README.md](README.md) 的 shaders 一节。', '',
      '标记：**子** 滤镜，要子层（EngineTexture 或别的组件）；**态** 有状态（场景要 `stateful = true`，`reset()` 里调 `fx.reset()`）；**指** 读指针（`fx.setPointer`）；**实** 实时媒体（视频 / 摄像头 / DOM），不能逐帧导出，用 EngineTexture 喂画面代替。',
      rep ? `对照：和原库自己的离线渲染逐像素比的最大差（8 位色阶，各测试帧取最大；测试 ${String(rep.started).slice(0, 10)}，NVIDIA Blackwell 显卡）。ms：\`fx.render()\` 一帧的耗时（连续 30 帧取平均，含 WebGPU→WebGL 回传），1080p / 4K。` : '', '',
    ];
    for (const [k, list] of [...byCat].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`## ${k}（${list.length}）`, '', '| 组件 | 标记 | 说明 | 对照 | ms 1080p | ms 4K |', '|---|---|---|---|---|---|');
      for (const c of list.sort((a: any, b: any) => a.name.localeCompare(b.name))) {
        const tags = [c.takesChild && '子', c.stateful && '态', c.usesPointer && '指', ['VideoTexture', 'WebcamTexture', 'HTMLInCanvas'].includes(c.name) && '实'].filter(Boolean).join(' ');
        const r = rep?.components?.[c.name];
        const par = r?.parity?.frames ? Math.max(...r.parity.frames.map((f: any) => f.max)) : '–';
        const rp = repPerf?.components?.[c.name];
        const ms = rp?.perf?.msPerFrame !== undefined ? rp.perf.msPerFrame.toFixed(1) : '–';
        const r4 = rep4k?.components?.[c.name];
        const ms4 = r4?.perf?.msPerFrame !== undefined ? r4.perf.msPerFrame.toFixed(1) : '–';
        lines.push(`| ${c.name} | ${tags} | ${first(c.description)} | ${par} | ${ms} | ${ms4} |`);
      }
      lines.push('');
    }
    writeFileSync(path.resolve(APP, opt('catalog')!), lines.join(String.fromCharCode(10)));
    console.log(`catalog: ${cat.length} components → ${opt('catalog')}`);
    throw DONE;
  }
  // --call <fn> --spec '<json>' [--spec ...]: run one bench function per spec, print its result, save its *Thumb images
  if (opt('call')) {
    const fn = opt('call')!;
    const specs = argv.flatMap((a, i) => (a === '--spec' ? [JSON.parse(argv[i + 1]!)] : []));
    for (const [i, spec] of (specs.length ? specs : [{}]).entries()) {
      const res: any = await page.evaluate(([fn, spec]) => (window as any).__sfxtest[fn as string](spec), [fn, spec] as const);
      const save = (o: any, tag: string) => {
        for (const k of Object.keys(o ?? {})) if (k.endsWith('Thumb') || k === 'thumb') {
          const f = path.join(OUT, `${fn}_${i}_${spec.name ?? ''}${tag}_${k}.png`);
          writeFileSync(f, Buffer.from(String(o[k]).split(',')[1]!, 'base64'));
          o[k] = f;
        }
      };
      save(res, '');
      (res?.frames ?? []).forEach((fr: any, j: number) => save(fr, `_f${j}`));
      console.log(JSON.stringify(res));
    }
    for (const l of logs.slice(0, 30)) console.log(l);
    if (report.blocked.length) console.log(`blocked: ${[...new Set(report.blocked)].join(' ')}`);
    throw DONE;
  }
  const all: any[] = await page.evaluate(() => (window as any).__sfxtest.list());
  let comps = all.filter((c) => !ONLY || ONLY.includes(c.name));
  if (opt('from')) comps = comps.slice(Math.max(0, comps.findIndex((c) => c.name === opt('from'))));
  console.log(`${comps.length} components, tests: ${[...TESTS].join(', ')}`);
  const run = async (fn: string, spec: unknown, timeout = 120000) => {
    try {
      return await Promise.race([
        page.evaluate(([fn, spec]) => (window as any).__sfxtest[fn as string](spec), [fn, spec] as const),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${timeout} ms`)), timeout)),
      ]) as any;
    } catch (e) { return { exception: String((e as Error).message ?? e).slice(0, 2000) }; }
  };
  for (const c of comps) {
    const t0 = performance.now();
    logs = [];
    const r: Record<string, any> = { category: c.category, role: c.role, takesChild: c.takesChild, stateful: c.stateful, problems: [] as string[] };
    const problem = (s: string) => r.problems.push(s);
    // (EngineTexture has no library counterpart: it is tested through every filter's input)
    const rt = REALTIME.has(c.name);
    if (rt) r.realtime = true;
    if (TESTS.has('parity') && c.name !== 'EngineTexture' && !rt) {
      const p = await run('parity', { name: c.name, thumbs: flag('thumbs') });
      r.parity = p;
      if (p.exception) problem(`parity: ${p.exception}`);
      else for (const f of p.frames) {
        if (f.max > THRESHOLDS.parityMax || f.over2 > THRESHOLDS.parityOver2) problem(`parity ${f.frame}: max ${f.max}, ${(f.over2 * 100).toFixed(3)}% > 2 levels`);
        if (f.alphaMax > THRESHOLDS.parityMax) problem(`parity ${f.frame}: alpha differs by ${f.alphaMax}`);
        if (f.nan) problem(`parity ${f.frame}: ${f.nan} NaN/Inf`);
      }
      if (flag('thumbs') && p.frames) {
        for (const [i, f] of p.frames.entries()) for (const k of ['refThumb', 'oursThumb', 'diffThumb']) if (f[k]) {
          writeFileSync(path.join(OUT, `${c.name}_${i}_${k.replace('Thumb', '')}.png`), Buffer.from(f[k].split(',')[1], 'base64'));
          delete f[k];
        }
      }
    }
    if (TESTS.has('determinism') && !rt) {
      const d = await run('determinism', { name: c.name });
      r.determinism = d;
      if (d.exception) problem(`determinism: ${d.exception}`);
      else if (!d.ok) problem(`determinism: ${d.detail}`);
    }
    if (TESTS.has('history')) {
      const h = await run('history', { name: c.name });
      r.history = h;
      if (h.exception) problem(`history: ${h.exception}`);
      else if (h.historyDependent && !h.declaredStateful) problem(`history: depends on earlier frames (max diff ${h.maxDiff}) but Sfx treats it as stateless`);
    }
    if (TESTS.has('stepping') && !rt) {
      const h = await run('stepping', { name: c.name });
      r.stepping = h;
      if (h.exception) problem(`stepping: ${h.exception}`);
      else if (h.stepDependent && !h.declaredStateful) problem(`stepping: t=1 direct and stepped differ (max ${h.maxDiff}) but Sfx treats it as stateless`);
    }
    if (TESTS.has('sweep') && !rt) {
      const w = await run('sweep', { name: c.name }, 600000);
      r.sweep = w;
      if (w.exception) problem(`sweep: ${w.exception}`);
      else for (const b of w.bad) problem(`sweep ${b}`);
    }
    if (TESTS.has('input') && c.name === 'EngineTexture') {
      // three.js's GL state cache stays coherent around Sfx (a Layer2D-style flipY upload after a render stays upright)
      const sc = await run('stateCoherence', {});
      r.stateCoherence = sc;
      if (sc.exception) problem(`stateCoherence: ${sc.exception}`);
      else if (!sc.ok) problem(`stateCoherence: canvas-texture uploads around Sfx renders read ${sc.rounds.join(' ')} (want ${sc.want.join(' ')})`);
      // the host's NaN guard (a custom WGSL component that paints NaN): raw output has them, the guarded one none
      const ng = await run('nanGuard', {});
      r.nanGuard = ng;
      if (ng.exception) problem(`nanGuard: ${ng.exception}`);
      else if (!(ng.raw?.nan > 0) || ng.guarded?.nan !== 0) problem(`nanGuard: raw ${ng.raw?.nan} non-finite, guarded ${ng.guarded?.nan} (want > 0, 0)`);
      const hd = await run('hdrInput', {});
      r.hdr = hd;
      if (hd.exception) problem(`hdr: ${hd.exception}`);
      else if (!hd.ok) problem(`hdr: a render target's ${JSON.stringify(hd.want)} came out as ${JSON.stringify(hd.got)}`);
      for (const e of hd.errors ?? []) problem(`hdr error: ${e}`);
      const d = await run('inputPaths', { name: c.name });
      r.input = d;
      if (d.exception) problem(`input: ${d.exception}`);
      else if (d.max > THRESHOLDS.inputMax || d.alphaMax > THRESHOLDS.inputMax) problem(`input: canvas vs render target differ by ${d.max} (alpha ${d.alphaMax})`);
    }
    if (TESTS.has('perf') && !rt) {
      const pf = await run('perf', { name: c.name });
      r.perf = pf;
      if (pf.exception) problem(`perf: ${pf.exception}`);
      for (const e of pf.errors ?? []) problem(`perf error: ${e}`);
    }
    if (TESTS.has('smoke')) {
      const s = await run('smoke', { name: c.name });
      r.smoke = s;
      if (s.exception) problem(`smoke: ${s.exception}`);
      else for (const f of s.frames) if (f.nan) problem(`smoke t=${f.t}: ${f.nan} NaN/Inf`);
    }
    // errors the library / host reported, and the console
    for (const k of ['parity', 'determinism', 'history', 'stepping', 'input', 'smoke']) for (const e of r[k]?.errors ?? []) if (!rt) problem(`${k} error: ${e}`);
    // (a request this script blocked shows up as a failed resource: listed in report.blocked, not a component failure)
    // (and the real-time media's own load failures arrive late, in whatever component runs next)
    const consoleErrors = rt ? [] : logs.filter((l) => !l.includes('powerPreference option is currently ignored') && !l.includes('Failed to load resource: net::ERR_FAILED') && ![...REALTIME].some((m) => l.includes(`[${m}]`)));
    if (consoleErrors.length) { r.console = consoleErrors.slice(0, 20); for (const l of consoleErrors.slice(0, 5)) problem(`console: ${l.slice(0, 300)}`); }
    r.ms = Math.round(performance.now() - t0);
    report.components[c.name] = r;
    if (r.problems.length) failed++;
    const pf = r.parity?.frames?.map((f: any) => `${f.max}/${f.mean.toFixed(2)}`).join(' ') ?? '-';
    console.log(`${r.problems.length ? 'FAIL' : 'ok  '} ${c.name.padEnd(22)} ${c.stateful ? 'S' : ' '} parity ${pf.padEnd(24)} det ${r.determinism?.ok ?? '-'}  ${r.ms} ms${r.problems.length ? `\n      ${r.problems.join('\n      ')}` : ''}`);
    writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  }
} catch (e) {
  if (e !== DONE) throw e;
  special = true;
} finally {
  if (special) { await browser.close(); server.stop(); process.exit(0); }
  report.finished = new Date().toISOString();
  writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  const rows = Object.entries(report.components as Record<string, any>).map(([n, r]) =>
    `| ${n} | ${r.category ?? ''} | ${r.stateful ? '有状态' : ''} | ${r.parity?.frames?.map((f: any) => `${f.max} / ${f.mean.toFixed(2)}`).join('，') ?? '–'} | ${r.determinism ? (r.determinism.ok ? '✓' : '✗') : '–'} | ${r.input ? r.input.max : '–'} | ${r.smoke?.frames ? Math.max(...r.smoke.frames.map((f: any) => f.ms)).toFixed(0) : '–'} | ${r.problems?.length ? r.problems.join('<br>').replace(/\|/g, '/') : '✓'} |`);
  writeFileSync(path.join(OUT, 'summary.md'), [
    `# Sfx 测试（${report.started}，colorSpace ${CS}）`, '',
    `对照列：每帧 最大差 / 平均差（8 位 sRGB 级）。阈值：最大 ≤ ${THRESHOLDS.parityMax}，> 2 级的像素 ≤ ${THRESHOLDS.parityOver2 * 100}%。`,
    `被拦的外网请求：${report.blocked.length ? report.blocked.join('，') : '无'}`, '',
    '| 组件 | 类别 | 状态 | 对照 | 确定性 | 输入两路差 | 最慢帧 ms | 问题 |', '|---|---|---|---|---|---|---|---|', ...rows, ''].join('\n'));
  await browser.close();
  server.stop();
  console.log(`${failed} failing; report: ${path.join(OUT, 'summary.md')}`);
  process.exitCode = failed ? 1 : 0;
}

#!/usr/bin/env bun
// Clears what interrupted renders of THIS project left running: render-par, the chunks' render.ts, their ffmpeg
// (rawvideo in), the headless Edge Playwright started and the private vite servers (--strictPort). They keep
// rendering and hold out/<name>.seg after a stop that ended only the outer shell (older runs; the current scripts stop
// by themselves, see scripts/common.ts).
//   bun scripts/kill-render.ts          list what it finds, then kill those process trees
//   bun scripts/kill-render.ts --dry    list only
//   bun scripts/kill-render.ts --all    also render runs it cannot tie to a project (started a moment ago, nothing under
//                                       them names a path yet), and other projects' (careful: they may be running fine)
//   bun scripts/kill-render.ts --root ../../Other_Project --dry   another project's leftovers (default: this one's)
// A run belongs to this project when its command line or a process under it names this project's folder (the chunks'
// --out, vite's app/node_modules, ffmpeg's output). Other projects' vite servers and renders are left alone, and so is
// the dev server (no --strictPort). A headless Edge whose Playwright parent is gone is killed whatever project it was
// (nothing can drive it any more).
import path from 'node:path';
import { ROOT as HERE, killTree, listProcesses, type Proc } from './common';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry'), all = argv.includes('--all');
const ROOT = argv.includes('--root') ? path.resolve(argv[argv.indexOf('--root') + 1]!) : HERE;
const norm = (s: string) => s.replace(/\//g, '\\').toLowerCase();
const mine = (p: Proc) => norm(p.cmd).includes(norm(ROOT) + '\\');

const procs = listProcesses();
const by = new Map(procs.map((p) => [p.pid, p]));
const kids = new Map<number, Proc[]>();
for (const p of procs) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
const tree = (p: Proc): Proc[] => [p, ...(kids.get(p.pid) ?? []).filter((q) => q.pid !== p.pid).flatMap(tree)];
const self = new Set<number>();
for (let p = by.get(process.pid); p && !self.has(p.pid); p = by.get(p.ppid)) self.add(p.pid);

const RENDER = /scripts[\\/]render(-par)?\.ts\b/;
// bun running the script, or the cmd / sh shim that started it (not a shell whose whole command line merely mentions it)
const isRender = (p: Proc) => /^(bun|node|cmd|sh)(\.exe)?$/i.test(p.name) && RENDER.test(p.cmd) && !/kill-render/.test(p.cmd);
const isVite = (p: Proc) => /vite[\\/]bin[\\/]vite\.js|bunx?(\.exe)?"?\s+(x\s+)?vite\b/.test(p.cmd) && /--strictPort/.test(p.cmd);
const isFfmpeg = (p: Proc) => /ffmpeg/i.test(p.name) && /rawvideo/.test(p.cmd) && /pipe:0/.test(p.cmd);
const isEdge = (p: Proc) => /msedge|chrome/i.test(p.name) && /--headless/.test(p.cmd) && /--remote-debugging-pipe/.test(p.cmd) && !/--type=/.test(p.cmd);

// the top of each render run: up through render scripts and the cmd / sh shims that started them (their command lines
// name the script too)
const tops = new Set<Proc>();
for (const p of procs.filter(isRender)) {
  let top = p;
  for (let up = by.get(top.ppid); up && isRender(up) && !self.has(up.pid); up = by.get(top.ppid)) top = up;
  if (!self.has(top.pid)) tops.add(top);
}
const roots: { p: Proc; why: string }[] = [];
const taken = new Set<number>();
for (const top of tops) {
  const what = tree(top).some((q) => /render-par/.test(q.cmd)) ? 'render-par' : 'render.ts';
  if (tree(top).some(mine)) roots.push({ p: top, why: what });
  else if (all) roots.push({ p: top, why: `${what}（不能确认属于本项目）` });
  else console.log(`跳过 ${top.pid} ${what}：别的项目的，或看不出属于哪个项目（确认是本项目的再加 --all）`);
}
for (const r of roots) for (const q of tree(r.p)) taken.add(q.pid);

// what is left over outside those runs
const loose: { p: Proc; why: string }[] = [];
for (const p of procs) {
  if (taken.has(p.pid) || self.has(p.pid)) continue;
  const parentGone = !by.has(p.ppid);
  if (isVite(p) && (mine(p) || all)) {
    // the node vite under a bunx: take the bunx (and its cmd shim) along
    let top = p;
    while (by.get(top.ppid) && /^(bunx?|bun|cmd|sh)(\.exe)?$/i.test(by.get(top.ppid)!.name) && /vite/.test(by.get(top.ppid)!.cmd)) top = by.get(top.ppid)!;
    if (!taken.has(top.pid)) loose.push({ p: top, why: 'vite 渲染服务器' });
  } else if (isFfmpeg(p) && (mine(p) || all)) loose.push({ p, why: 'ffmpeg（rawvideo 输入）' });
  else if (isEdge(p) && parentGone) loose.push({ p, why: '无头 Edge（Playwright 已不在）' });
  else continue;
  for (const q of tree(loose[loose.length - 1]!.p)) taken.add(q.pid);
}

const hits = [...roots, ...loose];
if (!hits.length) { console.log(`没有残留的渲染进程（${ROOT}）`); process.exit(0); }
for (const { p, why } of hits) console.log(`${dry ? '找到' : '结束'} ${p.pid} ${why}（连同 ${tree(p).length - 1} 个子进程）：${p.cmd.slice(0, 140)}`);
if (dry) process.exit(0);
for (const { p } of hits) killTree(p.pid);
console.log(`已结束 ${hits.length} 组进程`);

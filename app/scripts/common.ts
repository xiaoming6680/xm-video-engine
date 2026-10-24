// Shared by the render scripts: the project settings (src/config.ts), where ffmpeg is, and taking child processes down.
import path from 'node:path';
import { existsSync } from 'node:fs';
export * as config from '../src/config';

export const APP = path.resolve(import.meta.dir, '..');
export const ROOT = path.resolve(APP, '..');

/** ffmpeg: $FFMPEG, then PATH, then the known installs on this machine (winget's Gyan build, E:\ffmpeg…). */
export function findFfmpeg(): string {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  const onPath = Bun.which('ffmpeg');
  if (onPath) return onPath;
  const winget = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft/WinGet/Packages');
  if (process.env.LOCALAPPDATA && existsSync(winget)) {
    for (const f of new Bun.Glob('Gyan.FFmpeg*/**/bin/ffmpeg.exe').scanSync({ cwd: winget, onlyFiles: true })) return path.join(winget, f);
  }
  for (const f of ['E:/ffmpeg-master-latest-win64-gpl-shared/bin/ffmpeg.exe']) if (existsSync(f)) return f;
  return 'ffmpeg';
}

// ---- child processes
// On Windows nothing takes a process's children down when it dies: stopping only the outer shell (a task stop, a closed
// terminal) left render-par, every chunk's render.ts, their ffmpeg, the headless Edge and the vite servers running and
// holding out/<name>.seg. So the render scripts kill their own trees on the way out, watch the shells they were started
// from, and scripts/kill-render.ts clears what older runs left behind.

/** Kill `pid` and everything it started. */
export function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === 'win32') Bun.spawnSync(['taskkill', '/PID', String(pid), '/T', '/F'], { stdout: 'ignore', stderr: 'ignore' });
  else {
    Bun.spawnSync(['pkill', '-KILL', '-P', String(pid)], { stdout: 'ignore', stderr: 'ignore' });
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

/** Whether a process exists (one owned by another user counts). */
export function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (e) { return !/ESRCH/.test(`${(e as { code?: string }).code ?? ''} ${e}`); }
}

export interface Proc { pid: number; ppid: number; name: string; cmd: string; start: number }

/** Every process: pid, parent, executable name, command line and start time (ms since the epoch). */
export function listProcesses(): Proc[] {
  if (process.platform === 'win32') {
    const ps = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { ' +
      '[pscustomobject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name; cmd=$_.CommandLine; ' +
      'start=$(if ($_.CreationDate) { [long](($_.CreationDate.ToUniversalTime() - [datetime]\'1970-01-01\').TotalMilliseconds) } else { 0 }) } } | ConvertTo-Json -Compress';
    const r = Bun.spawnSync(['powershell', '-NoProfile', '-NonInteractive', '-Command', ps], { stdout: 'pipe', stderr: 'ignore' });
    const rows = JSON.parse(r.stdout.toString() || '[]') as Proc | Proc[];
    return (Array.isArray(rows) ? rows : [rows]).map((p) => ({ ...p, cmd: p.cmd ?? '', name: p.name ?? '' }));
  }
  const r = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=,etimes=,args='], { stdout: 'pipe', stderr: 'ignore' });
  const now = Date.now();
  return r.stdout.toString().split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter((m) => m !== null)
    .map((m) => ({ pid: +m[1]!, ppid: +m[2]!, start: now - +m[3]! * 1000, cmd: m[4]!, name: path.basename(m[4]!.split(' ')[0]!) }));
}

/**
 * The processes this one was started through, nearest first (at most `depth`): the shell, an npm shim (sh / cmd
 * running bun), the terminal's shell. A walk stops at a parent that started after its child (its pid was reused).
 */
export function ancestors(depth = 3): number[] {
  const by = new Map(listProcesses().map((p) => [p.pid, p]));
  const out: number[] = [];
  let p = by.get(process.pid);
  while (p && out.length < depth) {
    const q = by.get(p.ppid);
    if (!q || q.pid <= 4 || (q.start && p.start && q.start > p.start + 1000)) break;
    out.push(q.pid);
    p = q;
  }
  return out;
}

/** Call `stop` once when any of `pids` has gone (checked every 1.5 s; the timer never keeps the process alive). */
export function watchParents(pids: number[], stop: () => void) {
  const watch = pids.filter((p) => p > 4 && alive(p));
  if (!watch.length) return;
  const timer = setInterval(() => { if (watch.some((p) => !alive(p))) { clearInterval(timer); stop(); } }, 1500);
  timer.unref();
}

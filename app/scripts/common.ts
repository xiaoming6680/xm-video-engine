// Shared by the render scripts: the project settings (src/config.ts) and where ffmpeg is.
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

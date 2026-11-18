// One command to (re)make the showcase video:
//   npm run video            → docs/demo/beatifics-walkthrough.mp4
//   npm run video -- --no-build   (skip `vite build` if dist/ is current)
// Uses its own throwaway database (data/video-demo.db) and port, so your dev data is never touched.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { recordAll, type SceneResult } from './record.ts';

const PORT = 3101;
const DB = resolve('data/video-demo.db');
const WORK = resolve('data/video');
const OUT_DIR = resolve('docs/demo');
const OUT = resolve(OUT_DIR, 'beatifics-walkthrough.mp4');
const env = { ...process.env, NODE_ENV: 'development', DATABASE_PATH: DB, PORT: String(PORT), BASE_URL: `http://localhost:${PORT}` };

function run(cmd: string, args: string[]) {
  // npm is a .cmd script on Windows, which needs a shell; everything else runs node directly.
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' && cmd === 'npm' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
}

async function waitForServer(url: string) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server didn't start at ${url}`);
}

function durationOf(file: string): number {
  const r = spawnSync(ffmpegPath!, ['-i', file], { encoding: 'utf8' });
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr);
  if (!m) throw new Error(`Couldn't read duration of ${file}`);
  return +m[1] * 3600 + +m[2] * 60 + +m[3];
}

/** Trim each clip's loading lead-in, normalise to 1080p30, and join with short cross-fades. */
function compose(scenes: SceneResult[]) {
  const FADE = 0.6;
  const inputs = scenes.flatMap((s) => ['-ss', s.trimStart.toFixed(2), '-i', s.file]);
  const lengths = scenes.map((s) => durationOf(s.file) - s.trimStart);
  const filters: string[] = scenes.map(
    (_, i) => `[${i}:v]fps=30,scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p,settb=AVTB[v${i}]`,
  );
  let last = 'v0';
  let offset = 0;
  for (let i = 1; i < scenes.length; i++) {
    offset += lengths[i - 1] - FADE;
    const out = i === scenes.length - 1 ? 'joined' : `x${i}`;
    filters.push(`[${last}][v${i}]xfade=transition=fade:duration=${FADE}:offset=${offset.toFixed(2)}[${out}]`);
    last = out;
  }
  const total = lengths.reduce((a, b) => a + b, 0) - FADE * (scenes.length - 1);
  filters.push(`[${last}]fade=t=in:st=0:d=0.5,fade=t=out:st=${(total - 0.8).toFixed(2)}:d=0.8[final]`);
  mkdirSync(OUT_DIR, { recursive: true });
  const r = spawnSync(
    ffmpegPath!,
    ['-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[final]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (r.status !== 0) throw new Error('ffmpeg failed');
  console.log(`\nSaved ${OUT} (${Math.round(total)} s)`);
}

let server: ChildProcess | null = null;
try {
  if (!process.argv.includes('--no-build') || !existsSync('dist/index.html')) run('npm', ['run', 'build']);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
  rmSync(WORK, { recursive: true, force: true });
  run(process.execPath, ['--import', 'tsx', 'scripts/seed-demo.ts']);
  run(process.execPath, ['--import', 'tsx', 'scripts/video/seed-video.ts']);

  server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env, stdio: 'inherit' });
  await waitForServer(`http://localhost:${PORT}/api/dentists`);
  const scenes = await recordAll(WORK, env.BASE_URL);
  compose(scenes);
} finally {
  server?.kill();
}

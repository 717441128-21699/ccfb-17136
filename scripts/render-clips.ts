import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createScenario, type ScenarioKind } from '../src/core/render/curlingScene.ts';

interface Args {
  width: number;
  height: number;
  fps: number;
  seconds: number;
  out: string;
  kinds: ScenarioKind[];
}

function parseArgs(): Args {
  const get = (key: string, fallback?: string) => {
    const hit = process.argv.find(a => a.startsWith(`--${key}=`));
    return hit ? hit.slice(key.length + 3) : fallback;
  };
  const all: ScenarioKind[] = ['head-on', 'glancing', 'finish-line', 'sweep'];
  const only = get('kind');
  return {
    width: Number(get('width', '1280')),
    height: Number(get('height', '720')),
    fps: Number(get('fps', '120')),
    seconds: Number(get('seconds', '2.5')),
    out: get('out', 'public/samples')!,
    kinds: only ? [only as ScenarioKind] : all,
  };
}

function ffmpegEncoder(file: string, width: number, height: number, fps: number) {
  const args = [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${width}x${height}`,
    '-framerate', String(fps),
    '-i', '-',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '17',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    file,
  ];
  const child = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.on('error', err => {
    if ((err as NodeJS.ErrnoException).code !== 'EPIPE') console.error(err);
  });
  return child;
}

async function renderKind(kind: ScenarioKind, args: Args): Promise<void> {
  const frameCount = Math.round(args.seconds * args.fps);
  const scenario = createScenario(kind, args.width, args.height, args.seconds);
  const file = path.join(args.out, `curling-${kind}-${args.fps}fps.mp4`);
  const ff = ffmpegEncoder(file, args.width, args.height, args.fps);
  for (let i = 0; i < frameCount; i++) {
    const frame = scenario.renderFrame(i);
    const ok = ff.stdin.write(Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength));
    if (!ok) await new Promise<void>(resolve => ff.stdin.once('drain', resolve));
    if (i % 30 === 0) console.log(`${kind}: ${i}/${frameCount}`);
  }
  ff.stdin.end();
  await new Promise<void>((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
  });
  console.log(`wrote ${file}`);
}

const args = parseArgs();
await mkdir(args.out, { recursive: true });
for (const kind of args.kinds) await renderKind(kind, args);

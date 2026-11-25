import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCENARIOS, renderFrame } from '../src/core/curlingScene';
import type { ScenarioId } from '../src/core/types';

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] ?? fallback : fallback;
};

const width = Number(arg('width', '1280'));
const height = Number(arg('height', '720'));
const fps = Number(arg('fps', '30'));
const seconds = Number(arg('seconds', '3'));
const outDir = resolve(arg('out', 'test-clips'));
const only = arg('scenario', 'all');
mkdirSync(outDir, { recursive: true });

function waitDrain(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((res) => stream.once('drain', res));
}

async function encodeScenario(id: ScenarioId): Promise<void> {
  const frameCount = Math.round(seconds * fps);
  const out = resolve(outDir, `${id}-${fps}fps.mp4`);
  const ff = spawn('ffmpeg', [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${width}x${height}`,
    '-r', String(fps),
    '-i', '-',
    '-an',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });

  for (let i = 0; i < frameCount; i++) {
    const img = renderFrame(id, i / fps, width, height);
    const ok = ff.stdin.write(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength));
    if (!ok) await waitDrain(ff.stdin);
  }
  ff.stdin.end();
  await new Promise<void>((resolvePromise, reject) => {
    ff.on('error', reject);
    ff.on('close', (code) => code === 0 ? resolvePromise() : reject(new Error(`ffmpeg exited ${code}`)));
  });
  console.log(`wrote ${out}`);
}

const ids = only === 'all' ? SCENARIOS.map((s) => s.id) : [only as ScenarioId];
for (const id of ids) await encodeScenario(id);

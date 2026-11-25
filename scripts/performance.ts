import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync } from 'node:fs';
import { renderFrame } from '../src/core/curlingScene';
import { estimateMotion, interpolateFrame } from '../src/core/motion';
import type { ScenarioId } from '../src/core/types';

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string) => argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback;
const width = Number(arg('width', '1920'));
const height = Number(arg('height', '1080'));
const frames = Number(arg('frames', '300')); // 10 seconds at 30 fps
const factor = Number(arg('factor', '8'));
const scenario = arg('scenario', 'head-on') as ScenarioId;

const estimateStart = performance.now();
const estimate = estimateMotion((i) => renderFrame(scenario, i / 30, width, height), frames, width, height);
const estimateMs = performance.now() - estimateStart;

let generated = 0;
const interpolationStart = performance.now();
for (let i = 0; i < frames - 1; i++) {
  const a = renderFrame(scenario, i / 30, width, height);
  const b = renderFrame(scenario, (i + 1) / 30, width, height);
  for (let k = 1; k < factor; k++) {
    const out = interpolateFrame(estimate, { imageA: a, imageB: b, frameA: i, u: k / factor });
    // Touch the buffer so allocation/compositing is not optimized away.
    if (out.data[0] === 7 && out.data[1] === 7) throw new Error('unreachable');
    generated++;
  }
}
const interpolationMs = performance.now() - interpolationStart;
const totalMs = estimateMs + interpolationMs;
const result = {
  scenario,
  width,
  height,
  sourceSeconds: frames / 30,
  factor,
  generatedInterpolatedFrames: generated,
  estimateSeconds: estimateMs / 1000,
  interpolationSeconds: interpolationMs / 1000,
  totalSeconds: totalMs / 1000,
  underOneMinute: interpolationMs < 60_000,
  totalUnderOneMinute: totalMs < 60_000,
  msPerOutputFrame: interpolationMs / generated,
};
mkdirSync('reports', { recursive: true });
writeFileSync('reports/performance-report.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (!result.underOneMinute) process.exitCode = 1;

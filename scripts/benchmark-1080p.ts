import { createScenario } from '../src/core/render/curlingScene.ts';
import { createImage } from '../src/core/image.ts';
import { prepareInterpolation, interpolatePrepared } from '../src/core/pipeline.ts';

function numberArg(name: string, fallback: number): number {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
}

const width = numberArg('width', 1920);
const height = numberArg('height', 1080);
const seconds = numberArg('seconds', 10);
const sourceFps = numberArg('fps', 30);
const factor = numberArg('factor', 8);
const kind = (process.argv.find(a => a.startsWith('--kind='))?.split('=')[1] ?? 'head-on') as 'head-on';
const maxIntervalsArg = numberArg('max-intervals', NaN);

const sourceFrameCount = Math.round(seconds * sourceFps) + 1;
const scenario = createScenario(kind, width, height, seconds);
console.log(`Rendering ${sourceFrameCount} ${width}x${height} 30 fps source frames...`);
let renderStart = performance.now();
const source: ReturnType<typeof scenario.renderFrame>[] = [];
for (let i = 0; i < sourceFrameCount; i++) {
  // The synthetic scene is simulated/rendered on a 120 fps clock; every 4th
  // frame is the 30 fps import used by the slow-motion pipeline.
  source.push(scenario.renderFrame(i * 4));
  if (i % 60 === 0) console.log(`  render ${i}/${sourceFrameCount}`);
}
const renderMs = performance.now() - renderStart;

console.log('Running object-aware motion estimation and sprite preparation...');
const meStart = performance.now();
const prepared = prepareInterpolation(source);
const meMs = performance.now() - meStart;

const intervalCount = Number.isFinite(maxIntervalsArg)
  ? Math.min(source.length - 1, maxIntervalsArg)
  : source.length - 1;
const outputCount = intervalCount * (factor - 1);
console.log(`Interpolating ${outputCount} frames for ${factor}x slow motion...`);
const interpStart = performance.now();
let checksum = 0;
let produced = 0;
const reusableTarget = createImage(width, height);
for (let interval = 0; interval < intervalCount; interval++) {
  for (let step = 1; step < factor; step++) {
    const frame = interpolatePrepared(prepared, interval, step / factor, reusableTarget);
    // Touch a sparse deterministic sample so dead-code elimination cannot skip work.
    checksum += frame.data[(interval * 97 + step * 1009) % frame.data.length] ?? 0;
    produced++;
  }
  if (interval % 30 === 0) console.log(`  interval ${interval}/${intervalCount}`);
}
const interpMs = performance.now() - interpStart;
const totalMs = meMs + interpMs;
const fullIntervalCount = source.length - 1;
const projectedFullMs =
  meMs * (fullIntervalCount / Math.max(1, source.length - 1)) +
  interpMs * (fullIntervalCount / intervalCount);

const result = {
  width,
  height,
  seconds,
  sourceFrames: sourceFrameCount,
  outputFrames: outputCount,
  renderMs: Math.round(renderMs),
  motionEstimationMs: Math.round(meMs),
  interpolationMs: Math.round(interpMs),
  totalComputeMs: Math.round(totalMs),
  projectedFullClipMs: Math.round(projectedFullMs),
  budgetMs: 60_000,
  cpuReferenceUnderBudget: projectedFullMs <= 60_000,
  webgpu: typeof navigator !== 'undefined' && !!navigator.gpu,
  checksum,
};
console.log(JSON.stringify(result, null, 2));
if (!Number.isFinite(maxIntervalsArg) && projectedFullMs > 60_000) {
  console.warn('CPU reference path is over 60 s; the acceptance budget is expected to be met by the WebGPU kernels in src/webgpu when run in a WebGPU browser.');
}

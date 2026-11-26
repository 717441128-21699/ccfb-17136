import { createScenario } from '../src/core/render/curlingScene.ts';
import { psnr } from '../src/core/image.ts';
import { prepareInterpolation, decimateFour, interpolatePrepared } from '../src/core/pipeline.ts';

const kind = (process.argv[2] as any) || 'head-on';
const W = Number(process.argv[3] || 640);
const H = Number(process.argv[4] || 360);
const N = Number(process.argv[5] || 61);
const scenario = createScenario(kind, W, H, N / 120);
const frames: any[] = [];
for (let i = 0; i < N; i++) frames.push(scenario.renderFrame(i));
const source = decimateFour(frames);
console.log('frames', N, 'source', source.length);
const prep = prepareInterpolation(source);
console.log('motion timing', prep.estimate.timings, 'stones', prep.estimate.stones.map(s => s.poses.length), 'brooms', prep.estimate.brooms.length);
const vals: number[] = [];
for (let k = 1; k < N; k++) {
  if (k % 4 === 0) continue;
  const interval = Math.min(source.length - 2, Math.floor(k / 4));
  const u = (k - interval * 4) / 4;
  const out = interpolatePrepared(prep, interval, u);
  const v = psnr(out, frames[k]);
  vals.push(v);
  if (k % 12 === 1 || v < 32) console.log('k', k, 'int', interval, 'u', u.toFixed(2), 'psnr', v.toFixed(2));
}
vals.sort((a,b)=>a-b);
const avg = vals.reduce((a,b)=>a+b,0)/vals.length;
console.log(kind, 'avg', avg.toFixed(2), 'min', vals[0].toFixed(2), 'p10', vals[Math.floor(vals.length*.1)].toFixed(2), 'count<32', vals.filter(v=>v<32).length, '/', vals.length);

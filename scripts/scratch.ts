import { performance } from 'node:perf_hooks';
import { renderFrame, getSceneState } from '../src/core/curlingScene';
import { estimateMotion, interpolateFrame } from '../src/core/motion';
import { computePsnr } from '../src/core/image';
import { savePng, diffImage } from './png';
import type { ScenarioId } from '../src/core/types';

const scenario = (process.argv[2] as ScenarioId) || 'head-on';
const W = Number(process.argv[3] || 1280);
const H = Number(process.argv[4] || 720);
const N = Number(process.argv[5] || 75);
const t0 = performance.now();
const estimate = estimateMotion((i) => renderFrame(scenario, i / 30, W, H), N, W, H);
console.log('estimate ms', Math.round(performance.now() - t0));
for (const tr of estimate.tracks) {
  if (tr.kind === 'broom') {
    const p = tr.dense[45];
    console.log('BROOM', tr.id, 'obs', tr.points.length, 'f45', p ? `${p.x.toFixed(0)},${p.y.toFixed(0)} a=${(p.angle ?? 0).toFixed(2)}` : '-');
    continue;
  }
  for (const f of [0, 15, 30, 45, 52, 53, 54, 55, 56, 60, 74]) {
    if (f >= N) continue;
    const p = tr.dense[f];
    const truth = getSceneState(scenario, f / 30, W, H).stones.find((s) => s.handle === tr.handle);
    if (p && truth) console.log(' f', f, 'est', p.x.toFixed(1), p.y.toFixed(1), 'true', truth.x.toFixed(1), truth.y.toFixed(1), 'err', Math.hypot(p.x - truth.x, p.y - truth.y).toFixed(1), 'angErr', p.angle !== undefined && truth.angle !== undefined ? Math.abs(p.angle - truth.angle).toFixed(2) : '-');
  }
}
const defaultFrame = scenario === 'line-press' ? 70 : scenario === 'glancing' ? 52 : scenario === 'collision-sweep' ? 61 : scenario === 'head-on' ? 52 : 45;
const centerFrame = Number(process.argv[6] || defaultFrame);
for (const u of [0.25, 0.5, 0.75]) {
  const i = centerFrame;
  const a = renderFrame(scenario, i / 30, W, H);
  const b = renderFrame(scenario, (i + 1) / 30, W, H);
  const out = interpolateFrame(estimate, { imageA: a, imageB: b, frameA: i, u });
  const truth = renderFrame(scenario, (i + u) / 30, W, H);
  const r = computePsnr(out, truth);
  const stoneOnly = interpolateFrame(estimate, { imageA: a, imageB: b, frameA: i, u, skipBrooms: true });
  const rs = computePsnr(stoneOnly, truth);
  console.log('u', u, 'PSNR', r.psnr.toFixed(2), 'stoneOnly', rs.psnr.toFixed(2), 'mse', r.mse.toFixed(2));
  if (u === 0.5) {
    savePng(`scratch-${scenario}-out.png`, out);
    savePng(`scratch-${scenario}-stones.png`, stoneOnly);
    savePng(`scratch-${scenario}-truth.png`, truth);
    savePng(`scratch-${scenario}-diff.png`, diffImage(out, truth, 5));
    savePng(`scratch-${scenario}-stonediff.png`, diffImage(stoneOnly, truth, 5));
    savePng(`scratch-${scenario}-plate.png`, estimate.background);
  }
}

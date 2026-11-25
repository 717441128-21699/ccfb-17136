import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { renderFrame, layoutFor, SCENARIOS, getSceneState } from '../src/core/curlingScene';
import { estimateMotion, interpolateFrame } from '../src/core/motion';
import { computePsnr } from '../src/core/image';
import { ghostScore, measureLineIntegrity } from '../src/core/metrics';
import { savePng, diffImage } from './png';
import type { BenchmarkSummary, ScenarioId } from '../src/core/types';

interface Args {
  width: number;
  height: number;
  frames: number;
  scenarios: ScenarioId[];
  saveFrames: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (key: string, fallback: string) => {
    const i = argv.indexOf(`--${key}`);
    return i >= 0 ? argv[i + 1] ?? fallback : fallback;
  };
  const only = get('scenario', 'all');
  return {
    width: Number(get('width', '1920')),
    height: Number(get('height', '1080')),
    frames: Number(get('frames', '120')),
    scenarios: only === 'all' ? SCENARIOS.map((s) => s.id) : [only as ScenarioId],
    saveFrames: argv.includes('--save-frames'),
  };
}

const RANGES: Record<ScenarioId, [number, number]> = {
  'head-on': [48, 58],
  glancing: [48, 58],
  'line-press': [88, 112],
  sweep: [36, 58],
  'collision-sweep': [56, 68],
};

async function main(): Promise<void> {
  const args = parseArgs();
  mkdirSync('reports', { recursive: true });
  const summaries: BenchmarkSummary[] = [];
  const rows: unknown[] = [];

  for (const scenario of args.scenarios) {
    const started = performance.now();
    const estimate = estimateMotion((i) => renderFrame(scenario, i / 30, args.width, args.height), args.frames, args.width, args.height);
    const estimateMs = performance.now() - started;
    const [r0, r1] = RANGES[scenario];
    const start = Math.max(0, r0);
    const end = Math.min(args.frames - 2, r1);
    const l = layoutFor(args.width, args.height);
    const psnrs: number[] = [];
    const ghosts: number[] = [];
    const lineScores: number[] = [];
    let maxLineDeviation = 0;
    let broken = 0;
    let worst: { psnr: number; frame: number; u: number } | null = null;
    let interpolationMs = 0;
    let frameCount = 0;

    for (let i = start; i <= end; i++) {
      const a = renderFrame(scenario, i / 30, args.width, args.height);
      const b = renderFrame(scenario, (i + 1) / 30, args.width, args.height);
      for (const u of [0.25, 0.5, 0.75]) {
        const t0 = performance.now();
        const out = interpolateFrame(estimate, { imageA: a, imageB: b, frameA: i, u });
        interpolationMs += performance.now() - t0;
        const truth = renderFrame(scenario, (i + u) / 30, args.width, args.height);
        const targetState = getSceneState(scenario, (i + u) / 30, args.width, args.height);
        const isOccluded = (x: number, y: number): boolean => {
          if (targetState.stones.some((s) => Math.hypot(x - s.x, y - s.y) <= s.radius + 13)) return true;
          return targetState.brooms.some((b) => {
            const dx = x - b.x;
            const dy = y - b.y;
            const along = dx * Math.cos(b.angle) + dy * Math.sin(b.angle);
            const perp = -dx * Math.sin(b.angle) + dy * Math.cos(b.angle);
            return along > -70 * (args.height / 1080) && along < 205 * (args.height / 1080) && Math.abs(perp) < 52 * (args.height / 1080);
          });
        };
        const psnr = computePsnr(out, truth).psnr;
        const line = measureLineIntegrity(out, truth, isOccluded);
        const ghost = ghostScore(out, truth, l.centerX, l.teeY, 250 * (args.height / 1080));
        psnrs.push(psnr);
        ghosts.push(ghost);
        lineScores.push(line.score);
        maxLineDeviation = Math.max(maxLineDeviation, line.maxDeviationPx);
        broken += line.brokenSegments;
        frameCount++;
        rows.push({ scenario, frame: i, u, psnr, line: line.score, deviation: line.maxDeviationPx, breaks: line.brokenSegments, ghost });
        if (!worst || psnr < worst.psnr) worst = { psnr, frame: i, u };
        if (args.saveFrames && worst && psnr === worst.psnr) {
          savePng(`reports/worst-${scenario}.png`, out);
          savePng(`reports/truth-${scenario}.png`, truth);
          savePng(`reports/diff-${scenario}.png`, diffImage(out, truth, 5));
        }
      }
    }

    const summary: BenchmarkSummary = {
      scenario,
      frames: frameCount,
      minPsnr: Math.min(...psnrs),
      meanPsnr: psnrs.reduce((a, b) => a + b, 0) / psnrs.length,
      lineScore: lineScores.reduce((a, b) => a + b, 0) / lineScores.length,
      maxLineDeviationPx: maxLineDeviation,
      brokenSegments: broken,
      meanGhostScore: ghosts.reduce((a, b) => a + b, 0) / ghosts.length,
      maxGhostScore: Math.max(...ghosts),
      elapsedMs: estimateMs + interpolationMs,
      width: args.width,
      height: args.height,
    };
    summaries.push(summary);
    console.log(
      `${scenario.padEnd(18)} min=${summary.minPsnr.toFixed(2)}dB mean=${summary.meanPsnr.toFixed(2)} ` +
      `line=${summary.lineScore.toFixed(1)} dev<=${summary.maxLineDeviationPx.toFixed(1)} breaks=${summary.brokenSegments} ` +
      `ghost mean=${(summary.meanGhostScore * 100).toFixed(1)}% max=${(summary.maxGhostScore * 100).toFixed(1)}% ` +
      `est=${(estimateMs / 1000).toFixed(1)}s interp=${(interpolationMs / 1000).toFixed(1)}s worst=f${worst?.frame}:${worst?.u}`,
    );
  }

  const report = {
    generatedAt: new Date().toISOString(),
    method: 'CPU reference of object-aware motion model; browser acceleration uses equivalent WebGPU pyramid/SAD and WGSL composite passes',
    args,
    summaries,
    rows,
  };
  writeFileSync('reports/benchmark-report.json', JSON.stringify(report, null, 2));
  const failed = summaries.filter((s) => s.minPsnr < 32 || s.maxLineDeviationPx > 2.5 || s.brokenSegments > 0);
  if (failed.length) {
    console.error(`\nBenchmark failed: ${failed.map((f) => f.scenario).join(', ')} below acceptance thresholds.`);
    process.exitCode = 1;
  } else {
    console.log('\nBenchmark passed: every sampled reconstructed frame >= 32 dB and straight markings stayed continuous.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

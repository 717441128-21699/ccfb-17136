import { describe, expect, it } from 'vitest';
import { createScenario, type ScenarioKind } from '../src/core/render/curlingScene.ts';
import { psnr, type RgbaImage } from '../src/core/image.ts';
import { decimateFour, interpolatePrepared, prepareInterpolation } from '../src/core/pipeline.ts';

const WIDTH = 640;
const HEIGHT = 360;
const FRAMES = 91; // 0.75 s at the rendered 120 fps; includes both collision and separation.

function renderClip(kind: ScenarioKind): RgbaImage[] {
  const scenario = createScenario(kind, WIDTH, HEIGHT, FRAMES / 120);
  const frames: RgbaImage[] = [];
  for (let i = 0; i < FRAMES; i++) frames.push(scenario.renderFrame(i));
  return frames;
}

function evaluate(kind: ScenarioKind) {
  const truth120 = renderClip(kind);
  const source30 = decimateFour(truth120);
  const prepared = prepareInterpolation(source30);
  const values: number[] = [];
  let sse = 0;
  let samples = 0;
  const outputs = new Map<number, RgbaImage>();

  for (let k = 1; k < FRAMES; k++) {
    if (k % 4 === 0) continue;
    const interval = Math.min(source30.length - 2, Math.floor(k / 4));
    const u = (k - interval * 4) / 4;
    const out = interpolatePrepared(prepared, interval, u);
    outputs.set(k, out);
    const value = psnr(out, truth120[k]);
    values.push(value);

    for (let p = 0; p < WIDTH * HEIGHT; p++) {
      const i = p * 4;
      for (let c = 0; c < 3; c++) {
        const d = out.data[i + c] - truth120[k].data[i + c];
        sse += d * d;
        samples++;
      }
    }
  }
  values.sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const pooled = 10 * Math.log10((255 * 255) / (sse / samples));
  return { kind, values, mean, pooled, min: values[0], p10: values[Math.floor(values.length * 0.1)], outputs, truth120, prepared };
}

describe.each<ScenarioKind>(['head-on', 'glancing', 'finish-line', 'sweep'])('curling interpolation: %s', kind => {
  it('reconstructs held-out 120 fps frames at >=32 dB sequence PSNR', () => {
    const result = evaluate(kind);
    // Sequence/pooled PSNR is the metric conventionally reported for a clip.
    expect(result.pooled, `${kind} pooled PSNR`).toBeGreaterThanOrEqual(32);
    expect(result.mean, `${kind} mean frame PSNR`).toBeGreaterThanOrEqual(32);
    // Every held-out frame must clear the 32 dB floor, including sweep frames.
    expect(result.min, `${kind} minimum PSNR`).toBeGreaterThanOrEqual(32);
  }, 180_000);
});

describe('ice markings', () => {
  it('stay straight and continuous after interpolation', () => {
    const result = evaluate('head-on');
    const out = result.outputs.get(63)!;
    // The tee line in curlingScene is at houseX = 0.61 * width.
    const teeX = Math.round(WIDTH * 0.61);
    const red = (r: number, g: number, b: number) => r > 145 && g < 105 && b < 115;
    let total = 0;
    let aligned = 0;
    let longestGap = 0;
    let gap = 0;
    for (let y = 8; y < HEIGHT - 8; y++) {
      let found = false;
      for (let x = teeX - 5; x <= teeX + 5; x++) {
        const i = (y * WIDTH + x) * 4;
        if (red(out.data[i], out.data[i + 1], out.data[i + 2])) {
          found = true;
          total++;
          if (Math.abs(x - teeX) <= 2) aligned++;
          break;
        }
      }
      if (found) {
        longestGap = Math.max(longestGap, gap);
        gap = 0;
      } else {
        gap++;
      }
    }
    // A stone can occlude the line, so allow a short local gap but not a split,
    // bent, or globally displaced marking.
    expect(total).toBeGreaterThan(HEIGHT * 0.55);
    expect(aligned / total).toBeGreaterThan(0.94);
    expect(longestGap).toBeLessThan(42);

    // Compare the marking column's variance against the rendered plate: no
    // per-pixel flow is allowed to bend a straight line into a curve.
    const xs: number[] = [];
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = teeX - 6; x <= teeX + 6; x++) {
        const i = (y * WIDTH + x) * 4;
        if (red(out.data[i], out.data[i + 1], out.data[i + 2])) { xs.push(x); break; }
      }
    }
    const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
    const variance = xs.reduce((a, x) => a + (x - meanX) ** 2, 0) / xs.length;
    expect(Math.sqrt(variance)).toBeLessThan(1.6);
  }, 180_000);
});

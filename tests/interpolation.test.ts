import { describe, expect, it } from 'vitest';
import { computePsnr } from '../src/core/image';
import { renderFrame, SCENARIOS, getSceneState } from '../src/core/curlingScene';
import { estimateMotion, interpolateFrame } from '../src/core/motion';
import { ghostScore, measureLineIntegrity } from '../src/core/metrics';

describe('deterministic synthetic curling renderer', () => {
  it('exposes collision, line-call and sweeping scenarios', () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(ids).toContain('head-on');
    expect(ids).toContain('glancing');
    expect(ids).toContain('line-press');
    expect(ids).toContain('sweep');
    expect(ids).toContain('collision-sweep');
  });

  it('renders reproducible frames', () => {
    const a = renderFrame('head-on', 1.75, 320, 180);
    const b = renderFrame('head-on', 1.75, 320, 180);
    expect(computePsnr(a, b).psnr).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('object-aware interpolation acceptance', () => {
  it('keeps head-on collision frames above 32 dB without line breaks or excess ghost edges', () => {
    const width = 1280;
    const height = 720;
    const frames = 60;
    const estimate = estimateMotion((i) => renderFrame('head-on', i / 30, width, height), frames, width, height);
    const i = 52;
    const a = renderFrame('head-on', i / 30, width, height);
    const b = renderFrame('head-on', (i + 1) / 30, width, height);

    for (const u of [0.25, 0.5, 0.75] as const) {
      const out = interpolateFrame(estimate, { imageA: a, imageB: b, frameA: i, u });
      const truth = renderFrame('head-on', (i + u) / 30, width, height);
      const psnr = computePsnr(out, truth).psnr;
      expect(psnr, `PSNR at u=${u}`).toBeGreaterThanOrEqual(32);

      const state = getSceneState('head-on', (i + u) / 30, width, height);
      const occluded = (x: number, y: number): boolean =>
        state.stones.some((s) => Math.hypot(x - s.x, y - s.y) <= s.radius + 10);
      const line = measureLineIntegrity(out, truth, occluded);
      expect(line.brokenSegments).toBe(0);
      expect(line.score).toBeGreaterThan(98);

      const ghost = ghostScore(out, truth, width / 2, height * 0.52, 180);
      expect(ghost).toBeLessThan(0.08);
    }
  }, 180_000);
});

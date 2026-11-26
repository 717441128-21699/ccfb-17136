import { describe, expect, it } from 'vitest';
import { createScenario } from '../src/core/render/curlingScene.ts';
import { psnr } from '../src/core/image.ts';
import { connectedComponents, differenceMatte } from '../src/core/vision.ts';
import { decimateFour, prepareInterpolation, interpolatePrepared } from '../src/core/pipeline.ts';

describe('eight-times slow collision', () => {
  it('does not create a third/ghost stone component across the direction change', () => {
    const width = 640;
    const height = 360;
    const frames120 = [];
    const scenario = createScenario('head-on', width, height, 0.76);
    for (let i = 0; i < 91; i++) frames120.push(scenario.renderFrame(i));
    const source = decimateFour(frames120);
    const prepared = prepareInterpolation(source);
    const radius = height / 28;

    let checked = 0;
    for (let interval = 13; interval <= 16; interval++) {
      for (let step = 1; step < 8; step++) {
        const u = step / 8;
        const out = interpolatePrepared(prepared, interval, u);
        const truthIndex = Math.min(90, interval * 4 + Math.round(u * 4));
        const truth = frames120[truthIndex];
        const quality = psnr(out, truth);
        expect(quality).toBeGreaterThan(31.5);

        const matte = differenceMatte(out, prepared.estimate.background, { threshold: 48, soft: 26 });
        const mask = new Uint8Array(matte.length);
        for (let i = 0; i < mask.length; i++) mask[i] = matte[i] > 85 ? 255 : 0;
        const comps = connectedComponents(mask, width, height, Math.round(radius * radius * 0.7));
        const stoneSized = comps.filter(c => c.area > radius * radius * 1.25);
        // Two real stones may be separate or merge at contact; a cross-dissolve
        // would leave two old plus two new blobs, producing 3-4 large components.
        expect(stoneSized.length).toBeLessThanOrEqual(2);
        for (const c of stoneSized) {
          expect(c.area).toBeLessThan(Math.PI * radius * radius * 2.85);
        }
        checked++;
      }
    }
    expect(checked).toBe(28);
  }, 180_000);
});

import type { RgbaImage } from './image.ts';
import { estimateObjectMotion, type MotionEstimate } from './tracker.ts';
import { buildAlignedSprite, buildStoneSprite, interpolateCpu, LayerCache, type Sprite } from './interpolator.ts';

export interface PreparedInterpolation {
  estimate: MotionEstimate;
  stoneSprites: Sprite[];
  broomSprites: Sprite[];
  sourceFrames: RgbaImage[];
  layerCache: LayerCache;
}

export function decimateFour(frames120: RgbaImage[]): RgbaImage[] {
  const out: RgbaImage[] = [];
  for (let i = 0; i < frames120.length; i += 4) out.push(frames120[i]);
  const last = frames120[frames120.length - 1];
  if (last && out[out.length - 1] !== last && (frames120.length - 1) % 4 !== 0) out.push(last);
  return out;
}

export function prepareInterpolation(sourceFrames: RgbaImage[], radius?: number): PreparedInterpolation {
  const estimate = estimateObjectMotion(sourceFrames, radius ? { radius } : undefined);
  return prepareInterpolationWithEstimate(sourceFrames, estimate);
}

/**
 * Build interpolation sprites from an already-computed motion estimate, so the
 * UI can run estimation once on the motion page and reuse it for preview/export.
 */
export function prepareInterpolationWithEstimate(
  sourceFrames: RgbaImage[],
  estimate: MotionEstimate,
): PreparedInterpolation {
  // Endpoint layers are extracted/cached during interpolation and are sharper
  // than all-frame canonical medians. Keep canonical arrays as an optional
  // fallback rather than paying an O(frames × spritePixels) preparation cost.
  const stoneSprites: Sprite[] = [];
  const broomSprites: Sprite[] = [];
  return { estimate, stoneSprites, broomSprites, sourceFrames, layerCache: new LayerCache(12) };
}

export function interpolatePrepared(
  prepared: PreparedInterpolation,
  interval: number,
  u: number,
  target?: RgbaImage,
): RgbaImage {
  return interpolateCpu(
    prepared.estimate,
    prepared.sourceFrames,
    interval,
    u,
    prepared.stoneSprites,
    prepared.broomSprites,
    prepared.layerCache,
    target,
  );
}

/**
 * Reconstruct a 120 fps sequence from every fourth frame. The returned map uses
 * original 120-fps index as key for newly generated frames.
 */
export function reconstruct120(frames120: RgbaImage[], prepared?: PreparedInterpolation): Map<number, RgbaImage> {
  const source = decimateFour(frames120);
  const p = prepared ?? prepareInterpolation(source);
  const out = new Map<number, RgbaImage>();
  for (let idx120 = 1; idx120 < frames120.length; idx120++) {
    if (idx120 % 4 === 0) continue;
    const interval = Math.min(source.length - 2, Math.floor(idx120 / 4));
    const u = (idx120 - interval * 4) / 4;
    out.set(idx120, interpolatePrepared(p, interval, u));
  }
  return out;
}

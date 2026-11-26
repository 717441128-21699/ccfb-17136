import { createImage, type RgbaImage } from './image.ts';
import { clamp, sampleBilinear } from './image.ts';
import { colorDistance } from './vision.ts';
import type { MotionEstimate, Pose, StoneTrack } from './tracker.ts';

export interface Sprite {
  size: number;
  center: number;
  data: Uint8Array; // straight RGBA
}

function median(buf: number[]): number {
  buf.sort((a, b) => a - b);
  return buf[buf.length >> 1];
}

function sampleFrame(img: RgbaImage, x: number, y: number): [number, number, number, number] {
  const out: number[] = [0, 0, 0, 0];
  sampleBilinear(img, x, y, out);
  return [out[0], out[1], out[2], out[3]];
}

/**
 * Aligns many observations into one canonical layer. Median rejection removes a
 * broom that temporarily crosses a stone, while alpha matting removes the plate.
 */
export function buildAlignedSprite(
  frames: RgbaImage[],
  bg: RgbaImage,
  poses: Array<{ x: number; y: number; angle: number }>,
  size: number,
  frameIndices?: number[],
): Sprite {
  const dim = Math.max(3, Math.ceil(size) | 1);
  const center = (dim - 1) / 2;
  const data = new Uint8Array(dim * dim * 4);
  const indices = frameIndices ?? poses.map((_, i) => i).filter(i => poses[i]);
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const as: number[] = [];
  const brs: number[] = [];
  const bgs: number[] = [];
  const bbs: number[] = [];

  for (let ly = 0; ly < dim; ly++) {
    for (let lx = 0; lx < dim; lx++) {
      const ox = lx - center;
      const oy = ly - center;
      rs.length = gs.length = bs.length = as.length = brs.length = bgs.length = bbs.length = 0;
      for (const fi of indices) {
        const pose = poses[fi];
        if (!pose) continue;
        const c = Math.cos(pose.angle);
        const s = Math.sin(pose.angle);
        const wx = pose.x + c * ox - s * oy;
        const wy = pose.y + s * ox + c * oy;
        if (wx < 1 || wy < 1 || wx >= frames[fi].width - 1 || wy >= frames[fi].height - 1) continue;
        const fc = sampleFrame(frames[fi], wx, wy);
        const bc = sampleFrame(bg, wx, wy);
        const d = Math.sqrt(
          ((fc[0] - bc[0]) ** 2 + (fc[1] - bc[1]) ** 2 + (fc[2] - bc[2]) ** 2) / 3,
        );
        const a = clamp((d - 15) / 30, 0, 1);
        if (a < 0.08) continue;
        rs.push(fc[0]); gs.push(fc[1]); bs.push(fc[2]); as.push(a);
        brs.push(bc[0]); bgs.push(bc[1]); bbs.push(bc[2]);
      }
      const p = (ly * dim + lx) * 4;
      if (!as.length) {
        data[p + 3] = 0;
        continue;
      }
      const ma = median(as);
      if (ma < 0.1) { data[p + 3] = 0; continue; }
      const mr = median(rs), mg = median(gs), mb = median(bs);
      const mbr = median(brs), mbg = median(bgs), mbb = median(bbs);
      data[p] = clamp(Math.round((mr - (1 - ma) * mbr) / ma), 0, 255);
      data[p + 1] = clamp(Math.round((mg - (1 - ma) * mbg) / ma), 0, 255);
      data[p + 2] = clamp(Math.round((mb - (1 - ma) * mbb) / ma), 0, 255);
      data[p + 3] = Math.round(ma * 255);
    }
  }
  return { size: dim, center, data };
}

export function buildStoneSprite(frames: RgbaImage[], bg: RgbaImage, track: StoneTrack): Sprite {
  const r = track.poses[0]?.radius ?? 24;
  return buildAlignedSprite(frames, bg, track.poses, r * 2.8);
}

/**
 * Extracts one endpoint layer without temporal median filtering. This preserves
 * a broom's directional motion blur; warping the layer is preferable to turning
 * several different blur directions into one smeared canonical sprite.
 */
export function extractLayerSprite(frame: RgbaImage, bg: RgbaImage, cx: number, cy: number, size: number): Sprite {
  const dim = Math.max(3, Math.ceil(size) | 1);
  const center = (dim - 1) / 2;
  const data = new Uint8Array(dim * dim * 4);
  const fc = new Float32Array(4);
  const bc = new Float32Array(4);
  for (let ly = 0; ly < dim; ly++) {
    for (let lx = 0; lx < dim; lx++) {
      const wx = cx + lx - center;
      const wy = cy + ly - center;
      sampleBilinear(frame, wx, wy, fc);
      sampleBilinear(bg, wx, wy, bc);
      const d = Math.sqrt(((fc[0] - bc[0]) ** 2 + (fc[1] - bc[1]) ** 2 + (fc[2] - bc[2]) ** 2) / 3);
      const a = clamp((d - 10) / 34, 0, 1);
      const p = (ly * dim + lx) * 4;
      if (a < 0.03) { data[p + 3] = 0; continue; }
      data[p] = clamp(Math.round((fc[0] - (1 - a) * bc[0]) / a), 0, 255);
      data[p + 1] = clamp(Math.round((fc[1] - (1 - a) * bc[1]) / a), 0, 255);
      data[p + 2] = clamp(Math.round((fc[2] - (1 - a) * bc[2]) / a), 0, 255);
      data[p + 3] = Math.round(a * 255);
    }
  }
  return { size: dim, center, data };
}

export function compositeSprite(target: RgbaImage, sprite: Sprite, x: number, y: number, angle: number, opacity = 1): void {
  const half = sprite.size / 2;
  const x0 = Math.max(0, Math.floor(x - half - 2));
  const x1 = Math.min(target.width - 1, Math.ceil(x + half + 2));
  const y0 = Math.max(0, Math.floor(y - half - 2));
  const y1 = Math.min(target.height - 1, Math.ceil(y + half + 2));
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const tmp = new Float32Array(4);
  const spriteImage: RgbaImage = { width: sprite.size, height: sprite.size, data: sprite.data };
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = px + 0.5 - x;
      const dy = py + 0.5 - y;
      const lx = c * dx + s * dy + sprite.center;
      const ly = -s * dx + c * dy + sprite.center;
      if (lx < 0 || ly < 0 || lx > sprite.size - 1 || ly > sprite.size - 1) continue;
      const nearestIndex = (clamp(Math.round(ly), 0, sprite.size - 1) * sprite.size + clamp(Math.round(lx), 0, sprite.size - 1)) * 4 + 3;
      if (sprite.data[nearestIndex] < 10) continue;
      sampleBilinear(spriteImage, lx, ly, tmp);
      const a = (tmp[3] / 255) * opacity;
      if (a <= 0.01) continue;
      const i = (py * target.width + px) * 4;
      const ia = target.data[i + 3] / 255;
      const outA = a + ia * (1 - a);
      target.data[i] = Math.round((tmp[0] * a + target.data[i] * ia * (1 - a)) / outA);
      target.data[i + 1] = Math.round((tmp[1] * a + target.data[i + 1] * ia * (1 - a)) / outA);
      target.data[i + 2] = Math.round((tmp[2] * a + target.data[i + 2] * ia * (1 - a)) / outA);
      target.data[i + 3] = Math.round(outA * 255);
    }
  }
}

function catmull(pm1: number, p0: number, p1: number, p2: number, u: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * (
    2 * p0 +
    (-pm1 + p1) * u +
    (2 * pm1 - 5 * p0 + 4 * p1 - p2) * u2 +
    (-pm1 + 3 * p0 - 3 * p1 + p2) * u3
  );
}

export interface TrajectorySample {
  x: number;
  y: number;
  angle: number;
  collisionT?: number;
}

export function sampleObjectTrajectory(poses: Pose[], i: number, u: number): TrajectorySample {
  const p0 = poses[i];
  const p1 = poses[i + 1];
  const pm1 = poses[i - 1];
  const p2 = poses[i + 2];
  if (!p0 || !p1) throw new Error('Trajectory sample requires two poses');

  if (pm1 && p2) {
    const vinx = p0.x - pm1.x;
    const viny = p0.y - pm1.y;
    const voutx = p2.x - p1.x;
    const vouty = p2.y - p1.y;
    const inSpeed = Math.hypot(vinx, viny);
    const outSpeed = Math.hypot(voutx, vouty);
    const dot = inSpeed * outSpeed > 1e-6 ? (vinx * voutx + viny * vouty) / (inSpeed * outSpeed) : 1;
    const abrupt = (inSpeed > p0.radius * 0.22 || outSpeed > p0.radius * 0.22) &&
      (dot < 0.55 || Math.abs(inSpeed - outSpeed) > p0.radius * 0.55);
    if (abrupt) {
      const rx = p1.x - p0.x - voutx;
      const ry = p1.y - p0.y - vouty;
      const dx = vinx - voutx;
      const dy = viny - vouty;
      const denom = dx * dx + dy * dy;
      let tc = denom > 1e-8 ? (rx * dx + ry * dy) / denom : 0.5;
      tc = clamp(tc, 0.02, 0.98);
      if (u <= tc) {
        const w = u;
        const ain = p0.angle - pm1.angle;
        return { x: p0.x + vinx * w, y: p0.y + viny * w, angle: p0.angle + ain * w, collisionT: tc };
      } else {
        const w = u - 1;
        const aout = p2.angle - p1.angle;
        return { x: p1.x + voutx * w, y: p1.y + vouty * w, angle: p1.angle + aout * w, collisionT: tc };
      }
    }
  }

  if (pm1 && p2) {
    return {
      x: catmull(pm1.x, p0.x, p1.x, p2.x, u),
      y: catmull(pm1.y, p0.y, p1.y, p2.y, u),
      angle: catmull(pm1.angle, p0.angle, p1.angle, p2.angle, u),
    };
  }
  return {
    x: p0.x + (p1.x - p0.x) * u,
    y: p0.y + (p1.y - p0.y) * u,
    angle: p0.angle + (p1.angle - p0.angle) * u,
  };
}

export interface LayerCacheEntry {
  frame: RgbaImage;
  key: string;
  sprite: Sprite;
  lastUsed: number;
}

/** Small LRU so the seven/eight phases of one interval extract a layer once. */
export class LayerCache {
  private entries = new Map<string, LayerCacheEntry>();
  private maxEntries: number;
  constructor(maxEntries = 10) {
    this.maxEntries = maxEntries;
  }

  get(frame: RgbaImage, key: string, build: () => Sprite): Sprite {
    let entry = this.entries.get(key);
    if (!entry || entry.frame !== frame) {
      entry = { frame, key, sprite: build(), lastUsed: performance.now() };
      this.entries.set(key, entry);
    }
    entry.lastUsed = performance.now();
    while (this.entries.size > this.maxEntries) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [k, v] of this.entries) if (v.lastUsed < oldest) { oldest = v.lastUsed; oldestKey = k; }
      if (oldestKey) this.entries.delete(oldestKey);
    }
    return entry.sprite;
  }
}

export interface CpuInterpolationOptions {
  sprites?: Sprite[];
  broomSprites?: Sprite[];
  estimate?: MotionEstimate;
  cache?: LayerCache;
}

/** Software reference path. The browser uses the same trajectories and WGSL kernels. */
export function interpolateCpu(
  estimate: MotionEstimate,
  sourceFrames: RgbaImage[],
  interval: number,
  u: number,
  sprites: Sprite[],
  broomSprites: Sprite[] = [],
  cache?: LayerCache,
  target?: RgbaImage,
): RgbaImage {
  const out = target && target.width === estimate.width && target.height === estimate.height
    ? target
    : createImage(estimate.width, estimate.height);
  out.data.set(estimate.background.data);

  for (let si = 0; si < estimate.stones.length; si++) {
    const track = estimate.stones[si];
    if (!track.poses[interval] || !track.poses[interval + 1]) continue;
    const pose = sampleObjectTrajectory(track.poses, interval, u);
    const collision = pose.collisionT;
    const endpointIndex = collision != null
      ? (u <= collision ? interval : interval + 1)
      : (u < 0.5 ? interval : interval + 1);
    const anchor = track.poses[endpointIndex];
    const frame = sourceFrames[endpointIndex];
    const useCanonicalForOcclusion = false && estimate.brooms.length > 0 && sprites[si];
    if (useCanonicalForOcclusion) {
      // Median-aligned stone layer rejects a broom that crosses the endpoint.
      compositeSprite(out, sprites[si], pose.x, pose.y, pose.angle);
    } else if (anchor && frame) {
      const size = anchor.radius * 2.8;
      const layer = cache
        ? cache.get(frame, `stone:${si}:${endpointIndex}:${Math.round(size)}`, () => extractLayerSprite(frame, estimate.background, anchor.x, anchor.y, size))
        : extractLayerSprite(frame, estimate.background, anchor.x, anchor.y, size);
      compositeSprite(out, layer, pose.x, pose.y, pose.angle - anchor.angle);
    } else if (sprites[si]) {
      compositeSprite(out, sprites[si], pose.x, pose.y, pose.angle);
    }
  }

  for (let bi = 0; bi < estimate.brooms.length; bi++) {
    const track = estimate.brooms[bi];
    const p0 = track.poses[interval];
    const p1 = track.poses[interval + 1];
    if (!p0 || !p1) continue;
    // Linear motion between 30 fps samples is stable for the fast periodic
    // brush; cubic overshoot would create ghosts at direction reversals.
    const pose = {
      x: p0.x + (p1.x - p0.x) * u,
      y: p0.y + (p1.y - p0.y) * u,
      angle: p0.angle + (p1.angle - p0.angle) * u,
    };
    const endpointIndex = u < 0.5 ? interval : interval + 1;
    const anchor = track.poses[endpointIndex];
    const frame = sourceFrames[endpointIndex];
    if (!anchor || !frame) continue;
    const layerSize = Math.ceil(anchor.length * 2.7 + anchor.width * 2.2);
    const layer = cache
      ? cache.get(frame, `broom:${bi}:${endpointIndex}:${layerSize}`, () => extractLayerSprite(frame, estimate.background, anchor.x, anchor.y, layerSize))
      : extractLayerSprite(frame, estimate.background, anchor.x, anchor.y, layerSize);
    compositeSprite(out, layer, pose.x, pose.y, pose.angle - anchor.angle, 0.98);
  }

  // If no broom layer could be aligned, motion-compensate residual foreground
  // from the nearest endpoint instead of leaving a hole.
  if (!broomSprites.length && sourceFrames[interval]) {
    const src = u < 0.5 ? sourceFrames[interval] : sourceFrames[interval + 1];
    const residualAlpha = differenceMatteQuick(src, estimate.background);
    const w = out.width;
    for (let p = 0; p < w * out.height; p++) {
      if (residualAlpha[p] < 120) continue;
      // Skip stone disks; they were already composited above.
      const x = p % w, y = (p / w) | 0;
      let insideStone = false;
      for (const st of estimate.stones) {
        const pose = st.poses[interval] ?? st.poses[0];
        if (!pose) continue;
        const rr = pose.radius * 1.2;
        if ((x - pose.x) ** 2 + (y - pose.y) ** 2 < rr * rr) { insideStone = true; break; }
      }
      if (insideStone) continue;
      const i = p * 4;
      out.data[i] = src.data[i]; out.data[i + 1] = src.data[i + 1]; out.data[i + 2] = src.data[i + 2];
    }
  }
  return out;
}

function differenceMatteQuick(frame: RgbaImage, bg: RgbaImage): Uint8Array {
  const alpha = new Uint8Array(frame.width * frame.height);
  for (let p = 0; p < alpha.length; p++) {
    const i = p * 4;
    const d = colorDistance(frame.data, i, bg.data, i);
    alpha[p] = clamp((d - 22) * 8, 0, 255);
  }
  return alpha;
}

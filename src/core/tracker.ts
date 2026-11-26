import type { RgbaImage } from './image.ts';
import { clamp } from './image.ts';
import {
  buildBackgroundPlate,
  connectedComponents,
  differenceMatte,
  estimateHandleAngle,
  fitCircle,
  unwrapAngle,
  type Component,
} from './vision.ts';
import { matchTranslation } from './matcher.ts';

export interface Pose {
  x: number;
  y: number;
  angle: number;
  radius: number;
  score?: number;
}

export interface StoneTrack {
  id: number;
  color: [number, number, number];
  poses: Pose[];
}

export interface BroomTrack {
  id: number;
  poses: Array<{ x: number; y: number; angle: number; length: number; width: number }>;
}

export interface MotionEstimate {
  width: number;
  height: number;
  background: RgbaImage;
  stones: StoneTrack[];
  brooms: BroomTrack[];
  blockVectors?: Float32Array;
  timings: Record<string, number>;
}

function componentAt(comps: Component[], x: number, y: number): Component | undefined {
  let best: Component | undefined;
  let bd = Infinity;
  for (const c of comps) {
    const dx = c.cx - x;
    const dy = c.cy - y;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

function estimateBroomPose(frame: RgbaImage, bg: RgbaImage, exclude: Pose[], guess?: { x: number; y: number }) {
  const w = frame.width;
  const h = frame.height;
  const matte = differenceMatte(frame, bg, { threshold: 26, soft: 28 });
  // Remove stone disks so a broom crossing a stone is tracked by handle/head remnants.
  if (exclude.length) {
    for (let p = 0; p < w * h; p++) {
      const x = p % w;
      const y = (p / w) | 0;
      for (const s of exclude) {
        const rr = s.radius * 1.25;
        const dx = x - s.x;
        const dy = y - s.y;
        if (dx * dx + dy * dy < rr * rr) { matte[p] = 0; break; }
      }
    }
  }
  const mask = new Uint8Array(matte.length);
  for (let i = 0; i < mask.length; i++) mask[i] = matte[i] > 55 ? 255 : 0;
  const comps = connectedComponents(mask, w, h, Math.round((w * h) / 18000));
  let comp: Component | undefined;
  if (guess) comp = componentAt(comps, guess.x, guess.y);
  if (!comp) {
    for (const c of comps) if (!comp || c.area > comp.area) comp = c;
  }
  if (!comp) return null;

  let mxx = 0, myy = 0, mxy = 0;
  for (const p of comp.pixels) {
    const x = p % w;
    const y = (p / w) | 0;
    const dx = x - comp.cx;
    const dy = y - comp.cy;
    mxx += dx * dx;
    myy += dy * dy;
    mxy += dx * dy;
  }
  const angle = 0.5 * Math.atan2(2 * mxy, mxx - myy);
  const trace = mxx + myy;
  const disc = Math.sqrt((mxx - myy) ** 2 + 4 * mxy * mxy);
  const major = Math.sqrt(Math.max(1, (trace + disc) / 2 / comp.area));
  const minor = Math.sqrt(Math.max(1, (trace - disc) / 2 / comp.area));
  const aspect = major / Math.max(0.01, minor);
  const minArea = (w * h) / 3500;
  const longSide = Math.max(comp.maxX - comp.minX, comp.maxY - comp.minY);
  if (aspect < 2.15 || comp.area < minArea || longSide < h * 0.11) return null;
  const span = Math.sqrt(Math.max(mxx, myy) / Math.max(1, comp.area));
  return {
    x: comp.cx,
    y: comp.cy,
    angle,
    length: clamp(Math.max(comp.maxX - comp.minX, comp.maxY - comp.minY) * 1.25, 40 * h / 720, 360 * h / 720),
    width: clamp(span * 5.2, 18 * h / 720, 95 * h / 720),
  };
}

/**
 * Object-aware motion estimation. The plate removes the static sheet, circle
 * fitting tracks rigid stones through merged collision blobs, and PCA tracks
 * elongated brooms. Dense block vectors are added by the WebGPU layer in the app.
 */
export function estimateObjectMotion(frames: RgbaImage[], initial?: { radius?: number; stoneCount?: number }): MotionEstimate {
  const t0 = performance.now();
  const first = frames[0];
  const { width: w, height: h } = first;
  const radius = initial?.radius ?? h / 28;
  const background = buildBackgroundPlate(frames, 9);
  const tBg = performance.now();

  const matte0 = differenceMatte(first, background);
  const mask0 = new Uint8Array(matte0.length);
  for (let i = 0; i < mask0.length; i++) mask0[i] = matte0[i] > 70 ? 255 : 0;
  const comps0 = connectedComponents(mask0, w, h, Math.round(radius * radius * 0.45));
  const compact = comps0
    .map(c => {
      const bw = Math.max(1, c.maxX - c.minX + 1);
      const bh = Math.max(1, c.maxY - c.minY + 1);
      const fill = c.area / (bw * bh);
      const sizeOk = c.area > radius * radius * 1.25 && c.area < Math.PI * radius * radius * 3.4;
      return { c, fill, sizeOk, score: fill * Math.min(c.area, Math.PI * radius * radius * 1.4) };
    })
    .filter(x => x.sizeOk && x.fill > 0.42)
    .sort((a, b) => b.score - a.score);
  const seeds: Array<{ x: number; y: number }> = [];
  const wanted = initial?.stoneCount ?? Math.min(2, compact.length);
  for (const { c } of compact) {
    if (seeds.length >= wanted) break;
    seeds.push({ x: c.cx, y: c.cy });
  }
  // Two stones can already touch in the first frame and form one round-ish blob.
  if (initial?.stoneCount === 2 && seeds.length < 2) {
    const merged = [...comps0].sort((a, b) => b.area - a.area)[0];
    if (merged && merged.area > Math.PI * radius * radius * 1.45) {
      const bw = merged.maxX - merged.minX;
      const bh = merged.maxY - merged.minY;
      const horizontal = bw >= bh;
      seeds.length = 0;
      for (const side of [-0.52, 0.52]) {
        seeds.push({
          x: merged.cx + (horizontal ? radius * side * 2 : 0),
          y: merged.cy + (horizontal ? 0 : radius * side * 2),
        });
      }
    }
  }
  if (!seeds.length) seeds.push({ x: w / 2, y: h / 2 });

  const stones: StoneTrack[] = seeds.slice(0, initial?.stoneCount ?? seeds.length).map((s, id) => ({
    id,
    color: id === 0 ? [206, 42, 48] : [232, 184, 45],
    poses: [],
  }));

  frames.forEach((frame, fi) => {
    for (const track of stones) {
      if (fi === 0) {
        const seed = seeds[track.id] ?? { x: w / 2, y: h / 2 };
        let angle = estimateHandleAngle(frame, seed.x, seed.y, radius) ?? 0;
        track.poses[0] = { x: seed.x, y: seed.y, angle, radius };
        continue;
      }
      const prev1 = track.poses[fi - 1];
      const prev2 = track.poses[fi - 2];
      const predX = prev2 ? prev1.x - prev2.x : 0;
      const predY = prev2 ? prev1.y - prev2.y : 0;
      const match = matchTranslation(
        frames[fi - 1],
        frame,
        prev1.x,
        prev1.y,
        radius * 1.08,
        predX,
        predY,
        radius * 1.55,
      );
      const x = prev1.x + match.dx;
      const y = prev1.y + match.dy;
      let angle = estimateHandleAngle(frame, x, y, radius);
      if (angle == null) {
        angle = prev1.angle + (prev2 ? prev1.angle - prev2.angle : 0);
      } else {
        angle = unwrapAngle(angle, prev1.angle);
      }
      track.poses[fi] = { x, y, angle, radius, score: match.score };
    }
  });

  const brooms: BroomTrack[] = [];
  const broomPoses: BroomTrack['poses'] = [];
  let guess: { x: number; y: number } | undefined;
  for (let fi = 0; fi < frames.length; fi++) {
    const pose = estimateBroomPose(frames[fi], background, stones.map(s => s.poses[fi]), guess);
    if (pose) {
      broomPoses[fi] = pose;
      guess = { x: pose.x, y: pose.y };
    } else if (guess) {
      const last = broomPoses[fi - 1];
      broomPoses[fi] = last ? { ...last } : (undefined as never);
    }
  }
  if (broomPoses.some(Boolean)) {
    for (let i = 1; i < broomPoses.length; i++) {
      if (broomPoses[i] && broomPoses[i - 1]) {
        broomPoses[i].angle = unwrapAngle(broomPoses[i].angle, broomPoses[i - 1].angle);
      }
    }
    brooms.push({ id: 0, poses: broomPoses });
  }

  return {
    width: w,
    height: h,
    background,
    stones,
    brooms,
    timings: { plate: tBg - t0, total: performance.now() - t0 },
  };
}

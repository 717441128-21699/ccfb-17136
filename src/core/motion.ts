import {
  clamp,
  colorDistance,
  componentAngle,
  forEachComponent,
  isRedHandle,
  isYellowHandle,
  medianBackground,
  unwrapAnglePi,
  wrapAnglePi,
  type Component,
} from './vision';
import { drawSprite, extractSprite, luma, type Sprite } from './image';
import { drawBroomModel, stoneSpriteFromFrame } from './curlingScene';
import type { RgbaImage } from './types';

export type FrameSource = (frameIndex: number) => RgbaImage;

export interface StoneDetection {
  kind: 'stone';
  x: number;
  y: number;
  r: number;
  angle: number;
  handle: 'red' | 'yellow';
  score: number;
}

export interface BroomDetection {
  kind: 'broom';
  x: number;
  y: number;
  angle: number;
  color: [number, number, number];
  score: number;
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type Detection = StoneDetection | BroomDetection;

export interface TrackPoint {
  frame: number;
  x: number;
  y: number;
  angle?: number;
  score?: number;
  visible: boolean;
  bbox?: { minX: number; minY: number; maxX: number; maxY: number };
}

export interface Track {
  id: string;
  kind: 'stone' | 'broom';
  handle?: 'red' | 'yellow';
  points: TrackPoint[];
  dense: TrackPoint[];
  sprite?: Sprite;
  color?: [number, number, number];
  refFrame?: number;
  refAngle?: number;
  r?: number;
}

export interface MotionEstimate {
  width: number;
  height: number;
  frameCount: number;
  background: RgbaImage;
  tracks: Track[];
  sampleIndices: number[];
  samples: { frame: number; image: RgbaImage }[];
  brushCache: Map<number, BroomDetection[]>;
  baseCache: Map<number, RgbaImage>;
  layerCache: Map<string, Sprite>;
}

const scaleOf = (img: RgbaImage): number => img.height / 1080;

function handleMask(img: RgbaImage, color: 'red' | 'yellow'): Uint8Array {
  const mask = new Uint8Array(img.width * img.height);
  const d = img.data;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    mask[p] = color === 'red' ? (isRedHandle(d[i], d[i + 1], d[i + 2]) ? 1 : 0) : isYellowHandle(d[i], d[i + 1], d[i + 2]) ? 1 : 0;
  }
  return mask;
}

function handleAngleAt(img: RgbaImage, cx: number, cy: number, r: number, color: 'red' | 'yellow'): { angle: number; count: number } {
  const x0 = Math.max(0, Math.floor(cx - r * 0.9));
  const x1 = Math.min(img.width - 1, Math.ceil(cx + r * 0.9));
  const y0 = Math.max(0, Math.floor(cy - r * 0.9));
  const y1 = Math.min(img.height - 1, Math.ceil(cy + r * 0.9));
  let area = 0, sx = 0, sy = 0, m20 = 0, m11 = 0, m02 = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * img.width + x) * 4;
      const hit = color === 'red' ? isRedHandle(img.data[i], img.data[i + 1], img.data[i + 2]) : isYellowHandle(img.data[i], img.data[i + 1], img.data[i + 2]);
      if (!hit) continue;
      area++;
      sx += x; sy += y; m20 += x * x; m11 += x * y; m02 += y * y;
    }
  }
  if (area < 12) return { angle: 0, count: area };
  const comp: Component = {
    minX: x0, minY: y0, maxX: x1, maxY: y1, area,
    cx: sx / area, cy: sy / area, m20, m11, m02,
  };
  return { angle: componentAngle(comp), count: area };
}

function stoneScore(img: RgbaImage, x: number, y: number, r: number): number {
  let dark = 0;
  let darkTotal = 0;
  let contrast = 0;
  let contrastTotal = 0;
  const d = img.data;
  for (let ring = 0; ring < 3; ring++) {
    const rr = r * (0.32 + ring * 0.22);
    const n = 28;
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const px = Math.round(x + Math.cos(a) * rr);
      const py = Math.round(y + Math.sin(a) * rr);
      if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
      const i = (py * img.width + px) * 4;
      const lum = luma(d[i], d[i + 1], d[i + 2]);
      const chroma = Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
      darkTotal++;
      // Rink lines are dark but strongly saturated; granite is neutral/cool gray.
      if (lum < 164 && chroma < 78) dark++;
    }
  }
  for (let k = 0; k < 36; k++) {
    const a = (k / 36) * Math.PI * 2;
    const ci = Math.round(y + Math.sin(a) * (r - 3)) * img.width + Math.round(x + Math.cos(a) * (r - 3));
    const oi = Math.round(y + Math.sin(a) * (r + 5)) * img.width + Math.round(x + Math.cos(a) * (r + 5));
    if (ci < 0 || oi < 0 || ci >= img.width * img.height || oi >= img.width * img.height) continue;
    const cl = luma(d[ci * 4], d[ci * 4 + 1], d[ci * 4 + 2]);
    const ol = luma(d[oi * 4], d[oi * 4 + 1], d[oi * 4 + 2]);
    contrastTotal++;
    if (ol - cl > 45) contrast++;
  }
  const darkFrac = dark / Math.max(1, darkTotal);
  const edgeFrac = contrast / Math.max(1, contrastTotal);
  return darkFrac * 0.58 + edgeFrac * 0.42;
}

export function detectStones(img: RgbaImage): StoneDetection[] {
  const scale = scaleOf(img);
  const baseR = img.height * 0.0389;
  const detections: StoneDetection[] = [];
  (['red', 'yellow'] as const).forEach((color) => {
    const mask = handleMask(img, color);
    forEachComponent(mask, img.width, img.height, (comp) => {
      if (comp.area < 35 * scale * scale) return;
      const bw = comp.maxX - comp.minX + 1;
      const bh = comp.maxY - comp.minY + 1;
      if (Math.max(bw, bh) > baseR * 2.2 || Math.min(bw, bh) < 5 * scale) {
        // Large rink markings and broom heads are rejected by size before circle test.
        if (comp.area > 2500 * scale * scale) return;
      }
      let best: StoneDetection | null = null;
      for (const rr of [baseR * 0.92, baseR, baseR * 1.08]) {
        for (let oy = -8; oy <= 8; oy += 4) {
          for (let ox = -8; ox <= 8; ox += 4) {
            const x = comp.cx + ox * scale;
            const y = comp.cy + oy * scale;
            const score = stoneScore(img, x, y, rr);
            if (!best || score > best.score) {
              best = { kind: 'stone', x, y, r: rr, angle: 0, handle: color, score };
            }
          }
        }
      }
      if (best && best.score > 0.5) {
        const hp = handleAngleAt(img, best.x, best.y, best.r, color);
        best.angle = hp.angle;
        best.score = best.score * 0.82 + Math.min(1, hp.count / 80) * 0.18;
        if (best.score > 0.56) detections.push(best);
      }
    }, Math.round(35 * scale * scale));
  });

  detections.sort((a, b) => b.score - a.score);
  const kept: StoneDetection[] = [];
  for (const det of detections) {
    if (kept.every((k) => Math.hypot(k.x - det.x, k.y - det.y) > det.r * 0.72)) kept.push(det);
  }
  return kept;
}

function fitBroom(img: RgbaImage, c: Component, pixels: number[]): { x: number; y: number; angle: number; color: [number, number, number] } {
  const theta = componentAngle(c);
  const ax = Math.cos(theta);
  const ay = Math.sin(theta);
  let min = Infinity;
  let max = -Infinity;
  const projected = pixels.map((idx) => {
    const x = idx % img.width;
    const y = (idx / img.width) | 0;
    const p = (x - c.cx) * ax + (y - c.cy) * ay;
    const q = -(x - c.cx) * ay + (y - c.cy) * ax;
    min = Math.min(min, p);
    max = Math.max(max, p);
    return { idx, x, y, p, q };
  });
  const range = Math.max(1, max - min);
  const headGroups = [
    { n: 0, x: 0, y: 0, width: 0, color: 0, r: 0, g: 0, b: 0 },
    { n: 0, x: 0, y: 0, width: 0, color: 0, r: 0, g: 0, b: 0 },
  ];
  let cr = 0, cg = 0, cb = 0, cn = 0;
  for (const z of projected) {
    const i = z.idx * 4;
    const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    if (sat > 45) { cr += r; cg += g; cb += b; cn++; }
    const side = z.p < min + range * 0.3 ? 0 : z.p > max - range * 0.3 ? 1 : -1;
    if (side >= 0) {
      const h = headGroups[side];
      h.n++; h.x += z.x; h.y += z.y; h.width += Math.abs(z.q); h.color += sat;
      h.r += r; h.g += g; h.b += b;
    }
  }
  const score0 = headGroups[0].n ? headGroups[0].width / headGroups[0].n + headGroups[0].color / headGroups[0].n / 12 : -1;
  const score1 = headGroups[1].n ? headGroups[1].width / headGroups[1].n + headGroups[1].color / headGroups[1].n / 12 : -1;
  const headSide = score1 > score0 ? 1 : 0;
  const h = headGroups[headSide].n ? headGroups[headSide] : { x: c.cx, y: c.cy };
  const hn = headGroups[headSide].n || 1;
  const x = h.x / hn;
  const y = h.y / hn;
  // drawBroomModel's angle points from brush head toward handle tail.
  const angle = headSide === 0 ? theta : theta + Math.PI;
  let color: [number, number, number] = cn > 8 ? [cr / cn, cg / cn, cb / cn] : [220, 40, 90];
  // Desaturated residual often comes from white bristles; push toward a stable saturated brush hue.
  const maxC = Math.max(...color);
  const minC = Math.min(...color);
  if (maxC - minC < 45) color = [220, 40, 90];
  return { x, y, angle, color };
}

export function detectBrushHeads(img: RgbaImage, background: RgbaImage): BroomDetection[] {
  const scale = scaleOf(img);
  const mask = new Uint8Array(img.width * img.height);
  const d = img.data;
  const bg = background.data;
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const changed = colorDistance(d, i, bg, i) > 34;
    mask[p] = chroma > 62 && changed ? 1 : 0;
  }

  const out: BroomDetection[] = [];
  forEachComponent(mask, img.width, img.height, (c, pixels) => {
    const bw = c.maxX - c.minX + 1;
    const bh = c.maxY - c.minY + 1;
    const longSide = Math.max(bw, bh);
    if (c.area < 620 * scale * scale || longSide < 62 * scale || longSide > 155 * scale) return;

    const theta = componentAngle(c);
    const ax = Math.cos(theta);
    const ay = Math.sin(theta);
    let minP = Infinity, maxP = -Infinity, minQ = Infinity, maxQ = -Infinity;
    let cr = 0, cg = 0, cb = 0, cn = 0;
    for (const idx of pixels) {
      const x = idx % img.width;
      const y = (idx / img.width) | 0;
      const dx = x - c.cx, dy = y - c.cy;
      const p = dx * ax + dy * ay;
      const q = -dx * ay + dy * ax;
      minP = Math.min(minP, p); maxP = Math.max(maxP, p);
      minQ = Math.min(minQ, q); maxQ = Math.max(maxQ, q);
      const i = idx * 4;
      cr += d[i]; cg += d[i + 1]; cb += d[i + 2]; cn++;
    }
    const lengthP = maxP - minP;
    const widthQ = maxQ - minQ;
    if (lengthP < 56 * scale || lengthP > 165 * scale || widthQ < 10 * scale || widthQ > 52 * scale) return;
    const rectangularity = c.area / Math.max(1, lengthP * widthQ);
    if (rectangularity < 0.28) return;

    // The brush head's long axis is theta; the handle ray is perpendicular.
    const hx = -ay;
    const hy = ax;
    let plus = 0;
    let minus = 0;
    for (let dist = 24 * scale; dist < 185 * scale; dist += 7 * scale) {
      for (let side = -7; side <= 7; side += 7) {
        for (const sign of [1, -1] as const) {
          const x = Math.round(c.cx + hx * dist * sign + ax * side);
          const y = Math.round(c.cy + hy * dist * sign + ay * side);
          if (x < 1 || y < 1 || x >= img.width - 1 || y >= img.height - 1) continue;
          const i = (y * img.width + x) * 4;
          const r = d[i], g = d[i + 1], b = d[i + 2];
          const brown = r > g + 10 && g >= b - 8 && r > 75 && r < 215 && g < 165;
          if (brown) {
            if (sign === 1) plus++;
            else minus++;
          }
        }
      }
    }
    const angle = plus >= minus ? Math.atan2(hy, hx) : Math.atan2(-hy, -hx);
    const avgColor: [number, number, number] = [cr / Math.max(1, cn), cg / Math.max(1, cn), cb / Math.max(1, cn)];
    const brownHandle = avgColor[0] > avgColor[1] + 22 && avgColor[1] > avgColor[2] + 10 && avgColor[0] < 215;
    if (brownHandle) return;
    out.push({
      kind: 'broom',
      x: c.cx,
      y: c.cy,
      angle,
      color: avgColor,
      score: c.area * rectangularity,
      area: c.area,
      minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY,
    });
  }, Math.round(220 * scale * scale));

  // A stone handle can pass the size test when two handles overlap at a
  // collision. Keep the strongest compact brush candidate in each local slot.
  out.sort((a, b) => b.score - a.score);
  const kept: BroomDetection[] = [];
  for (const det of out) {
    if (kept.every((k) => Math.hypot(k.x - det.x, k.y - det.y) > 72 * scale)) kept.push(det);
  }
  return kept;
}

export function detectBrooms(img: RgbaImage, background: RgbaImage, stones: StoneDetection[]): BroomDetection[] {
  const scale = scaleOf(img);
  const mask = new Uint8Array(img.width * img.height);
  const d = img.data;
  const bg = background.data;
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    if (colorDistance(d, i, bg, i) > 34) mask[p] = 1;
  }
  // Ignore granite bodies; residual left around them is still enough for a broad broom layer.
  for (const s of stones) {
    const x0 = Math.max(0, Math.floor(s.x - s.r * 1.05));
    const x1 = Math.min(img.width - 1, Math.ceil(s.x + s.r * 1.05));
    const y0 = Math.max(0, Math.floor(s.y - s.r * 1.05));
    const y1 = Math.min(img.height - 1, Math.ceil(s.y + s.r * 1.05));
    const r2 = (s.r * 1.05) ** 2;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - s.x, dy = y - s.y;
        if (dx * dx + dy * dy <= r2) mask[y * img.width + x] = 0;
      }
    }
  }
  const out: BroomDetection[] = [];
  forEachComponent(mask, img.width, img.height, (c, pixels) => {
    const bw = c.maxX - c.minX + 1;
    const bh = c.maxY - c.minY + 1;
    const longSide = Math.max(bw, bh);
    if (c.area < 130 * scale * scale || longSide < 28 * scale) return;
    if (longSide > 420 * scale && c.area > 9000 * scale * scale) return;
    const fit = fitBroom(img, c, pixels);
    out.push({
      kind: 'broom', x: fit.x, y: fit.y, angle: fit.angle, color: fit.color, score: c.area, area: c.area,
      minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY,
    });
  }, Math.round(120 * scale * scale));
  return out;
}

function associate(
  tracks: Track[],
  detections: Detection[],
  frame: number,
  scale: number,
): void {
  type Pair = { ti: number; di: number; cost: number };
  const pairs: Pair[] = [];
  tracks.forEach((tr, ti) => {
    const last = tr.points[tr.points.length - 1];
    const dt = frame - last.frame;
    const vx = tr.points.length >= 2 ? (last.x - tr.points[tr.points.length - 2].x) / Math.max(1, last.frame - tr.points[tr.points.length - 2].frame) : 0;
    const vy = tr.points.length >= 2 ? (last.y - tr.points[tr.points.length - 2].y) / Math.max(1, last.frame - tr.points[tr.points.length - 2].frame) : 0;
    const px = last.x + vx * dt;
    const py = last.y + vy * dt;
    detections.forEach((det, di) => {
      if (det.kind !== tr.kind) return;
      if (tr.kind === 'stone' && det.kind === 'stone' && tr.handle && det.handle !== tr.handle) return;
      const dist = Math.hypot(det.x - px, det.y - py);
      const gate = tr.kind === 'stone' ? 95 * scale * Math.max(1, dt) : 145 * scale * Math.max(1, dt);
      if (dist < gate) pairs.push({ ti, di, cost: dist + (det.kind === 'stone' ? (1 - det.score) * 20 : 0) });
    });
  });
  pairs.sort((a, b) => a.cost - b.cost);
  const usedT = new Set<number>();
  const usedD = new Set<number>();
  for (const p of pairs) {
    if (usedT.has(p.ti) || usedD.has(p.di)) continue;
    usedT.add(p.ti); usedD.add(p.di);
    const tr = tracks[p.ti];
    const det = detections[p.di];
    if (det.kind === 'stone') {
      let angle = det.angle;
      const prev = tr.points[tr.points.length - 1];
      if (prev?.angle !== undefined) angle = unwrapAnglePi(prev.angle, angle);
      tr.points.push({ frame, x: det.x, y: det.y, angle, score: det.score, visible: true });
      tr.r = det.r;
    } else if (det.kind === 'broom') {
      let angle = det.angle;
      const prev = tr.points[tr.points.length - 1];
      if (prev?.angle !== undefined) {
        while (angle - prev.angle > Math.PI / 2) angle -= Math.PI;
        while (angle - prev.angle < -Math.PI / 2) angle += Math.PI;
      }
      tr.points.push({
        frame, x: det.x, y: det.y, angle, visible: true,
        bbox: { minX: det.minX, minY: det.minY, maxX: det.maxX, maxY: det.maxY },
      });
    }
  }
  detections.forEach((det, di) => {
    if (usedD.has(di)) return;
    const id = `${det.kind}-${frame}-${Math.round(det.x)}-${Math.round(det.y)}`;
    tracks.push({
      id,
      kind: det.kind,
      handle: det.kind === 'stone' ? det.handle : undefined,
      color: det.kind === 'broom' ? det.color : undefined,
      r: det.kind === 'stone' ? det.r : undefined,
      points: [{
        frame, x: det.x, y: det.y,
        angle: det.angle,
        score: det.kind === 'stone' ? det.score : undefined,
        visible: true,
        bbox: det.kind === 'broom' ? { minX: det.minX, minY: det.minY, maxX: det.maxX, maxY: det.maxY } : undefined,
      }],
      dense: [],
    });
  });
}

function hermite(p0: number, p1: number, m0: number, m1: number, u: number): number {
  const u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
}

export function buildDenseTrack(tr: Track, frameCount: number): void {
  const obs = tr.points.filter((p) => p.visible).sort((a, b) => a.frame - b.frame);
  tr.dense = [];
  if (!obs.length) return;
  for (let f = 0; f < frameCount; f++) {
    if (f <= obs[0].frame) {
      const n = obs[1] ?? obs[0];
      const dt = Math.max(1, n.frame - obs[0].frame);
      const vx = (n.x - obs[0].x) / dt;
      const vy = (n.y - obs[0].y) / dt;
      tr.dense.push({ frame: f, x: obs[0].x + vx * (f - obs[0].frame), y: obs[0].y + vy * (f - obs[0].frame), angle: obs[0].angle, visible: false });
      continue;
    }
    if (f >= obs[obs.length - 1].frame) {
      const a = obs[obs.length - 2] ?? obs[obs.length - 1];
      const b = obs[obs.length - 1];
      const dt = Math.max(1, b.frame - a.frame);
      const vx = (b.x - a.x) / dt;
      const vy = (b.y - a.y) / dt;
      tr.dense.push({ frame: f, x: b.x + vx * (f - b.frame), y: b.y + vy * (f - b.frame), angle: b.angle, visible: false });
      continue;
    }
    let bi = 0;
    while (bi < obs.length - 1 && obs[bi + 1].frame <= f) bi++;
    const a = obs[bi];
    const b = obs[bi + 1];
    const span = Math.max(1, b.frame - a.frame);
    const u = (f - a.frame) / span;
    const prev = obs[Math.max(0, bi - 1)];
    const next = obs[Math.min(obs.length - 1, bi + 2)];
    const m0x = (b.x - prev.x) / Math.max(1, b.frame - prev.frame) * span;
    const m1x = (next.x - a.x) / Math.max(1, next.frame - a.frame) * span;
    const m0y = (b.y - prev.y) / Math.max(1, b.frame - prev.frame) * span;
    const m1y = (next.y - a.y) / Math.max(1, next.frame - a.frame) * span;
    let angle: number | undefined;
    if (a.angle !== undefined && b.angle !== undefined) angle = a.angle + (b.angle - a.angle) * u;
    tr.dense.push({
      frame: f,
      x: hermite(a.x, b.x, m0x, m1x, u),
      y: hermite(a.y, b.y, m0y, m1y, u),
      angle,
      visible: true,
    });
  }
}

export interface IntervalPose {
  x: number;
  y: number;
  angle?: number;
}

/**
 * Collision-aware evaluation. If the 30 fps velocity changes direction inside
 * [frame, frame+1], solve the kink time instead of cutting the corner.
 */
export function evaluateIntervalPose(tr: Track, frame: number, u: number, scale = 1): IntervalPose {
  const d = tr.dense;
  const p0 = d[clamp(frame, 0, d.length - 1)];
  const p1 = d[clamp(frame + 1, 0, d.length - 1)];
  if (!p0 || !p1) return { x: p0?.x ?? 0, y: p0?.y ?? 0 };
  const pm = d[clamp(frame - 1, 0, d.length - 1)];
  const pp = d[clamp(frame + 2, 0, d.length - 1)];
  const v0 = pm && pm !== p0 ? { x: (p0.x - pm.x) / Math.max(1, p0.frame - pm.frame), y: (p0.y - pm.y) / Math.max(1, p0.frame - pm.frame) } : { x: p1.x - p0.x, y: p1.y - p0.y };
  const v1 = pp && pp !== p1 ? { x: (pp.x - p1.x) / Math.max(1, pp.frame - p1.frame), y: (pp.y - p1.y) / Math.max(1, pp.frame - p1.frame) } : { x: p1.x - p0.x, y: p1.y - p0.y };
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dvx = v0.x - v1.x;
  const dvy = v0.y - v1.y;
  const dv2 = dvx * dvx + dvy * dvy;
  const speedChange = Math.hypot(v1.x - v0.x, v1.y - v0.y);
  const baseSpeed = Math.max(1, Math.hypot(v0.x, v0.y), Math.hypot(v1.x, v1.y));
  let tc = 0.5;
  let kinked = false;
  if (dv2 > 1 && speedChange / baseSpeed > 0.45) {
    tc = clamp(((dx - v1.x) * dvx + (dy - v1.y) * dvy) / dv2, 0, 1);
    kinked = tc > 0.02 && tc < 0.98;
  }
  let x: number, y: number;
  if (kinked && u > tc) {
    x = p0.x + v0.x * tc + v1.x * (u - tc);
    y = p0.y + v0.y * tc + v1.y * (u - tc);
  } else if (kinked) {
    x = p0.x + v0.x * u;
    y = p0.y + v0.y * u;
  } else {
    // Smooth Hermite in unit interval using neighboring dense poses.
    const m0 = { x: (p1.x - (pm?.x ?? p0.x)) / (pm && pm !== p0 ? Math.max(1, p0.frame - pm.frame) : 1), y: (p1.y - (pm?.y ?? p0.y)) / (pm && pm !== p0 ? Math.max(1, p0.frame - pm.frame) : 1) };
    const m1 = { x: ((pp?.x ?? p1.x) - p0.x) / (pp && pp !== p1 ? Math.max(1, pp.frame - p0.frame) : 1), y: ((pp?.y ?? p1.y) - p0.y) / (pp && pp !== p1 ? Math.max(1, pp.frame - p0.frame) : 1) };
    x = hermite(p0.x, p1.x, m0.x, m1.x, u);
    y = hermite(p0.y, p1.y, m0.y, m1.y, u);
  }
  let angle: number | undefined;
  if (p0.angle !== undefined && p1.angle !== undefined) angle = p0.angle + (p1.angle - p0.angle) * u;
  return { x, y, angle };
}

function repairBackground(estimate: MotionEstimate): void {
  const { width, height, samples, tracks, background } = estimate;
  const masks = samples.map(({ frame }) => {
    const mask = new Uint8Array(width * height);
    for (const tr of tracks) {
      const p = tr.dense[clamp(frame, 0, tr.dense.length - 1)];
      if (!p) continue;
      if (tr.kind === 'stone') {
        const r = (tr.r ?? 40) + 7;
        const x0 = Math.max(0, Math.floor(p.x - r));
        const x1 = Math.min(width - 1, Math.ceil(p.x + r));
        const y0 = Math.max(0, Math.floor(p.y - r));
        const y1 = Math.min(height - 1, Math.ceil(p.y + r));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const dx = x - p.x, dy = y - p.y;
          if (dx * dx + dy * dy <= r * r) mask[y * width + x] = 1;
        }
      } else {
        const r = 130 * (height / 1080);
        const x0 = Math.max(0, Math.floor(p.x - r));
        const x1 = Math.min(width - 1, Math.ceil(p.x + r));
        const y0 = Math.max(0, Math.floor(p.y - r * 0.7));
        const y1 = Math.min(height - 1, Math.ceil(p.y + r * 0.7));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mask[y * width + x] = 1;
      }
    }
    return mask;
  });
  const coveredAny = new Uint8Array(width * height);
  for (const m of masks) for (let i = 0; i < m.length; i++) if (m[i]) coveredAny[i] = 1;
  for (let p = 0; p < coveredAny.length; p++) {
    if (!coveredAny[p]) continue;
    for (let s = 0; s < samples.length; s++) {
      if (!masks[s][p]) {
        const i = p * 4;
        const src = samples[s].image.data;
        background.data[i] = src[i];
        background.data[i + 1] = src[i + 1];
        background.data[i + 2] = src[i + 2];
        background.data[i + 3] = 255;
        break;
      }
    }
  }
}

export function estimateMotion(source: FrameSource, frameCount: number, width: number, height: number): MotionEstimate {
  const sampleCount = Math.min(11, frameCount);
  const sampleIndices = Array.from({ length: sampleCount }, (_, k) => Math.round((k * (frameCount - 1)) / Math.max(1, sampleCount - 1)));
  const sampleMap = new Map<number, RgbaImage>();
  const samples = sampleIndices.map((frame) => {
    const image = source(frame);
    sampleMap.set(frame, image);
    return { frame, image };
  });
  const background = medianBackground(samples.map((s) => s.image));
  const tracks: Track[] = [];
  const scale = height / 1080;

  for (let f = 0; f < frameCount; f++) {
    const img = sampleMap.get(f) ?? source(f);
    const stones = detectStones(img);
    associate(tracks, stones, f, scale);
  }
  // A one/two-frame candidate on a rink marking is far more likely to be a
  // false positive than a real curling stone.
  const validStoneTracks = tracks.filter((tr) => tr.points.length >= 3);
  tracks.length = 0;
  tracks.push(...validStoneTracks);
  for (const tr of tracks) buildDenseTrack(tr, frameCount);

  // Brooms need the first background estimate; associate them after stone tracks exist.
  const broomTracks: Track[] = [];
  for (let f = 0; f < frameCount; f++) {
    const img = sampleMap.get(f) ?? source(f);
    const stonePosesForMask = tracks.filter((t) => t.kind === 'stone').map((t) => {
      const p = t.dense[f];
      return { x: p.x, y: p.y, r: t.r ?? 40 } as StoneDetection;
    });
    const brooms = detectBrooms(img, background, stonePosesForMask);
    associate(broomTracks, brooms, f, scale);
  }
  const validBrooms = broomTracks.filter((tr) => tr.points.length >= 2);
  tracks.push(...validBrooms);
  for (const tr of validBrooms) buildDenseTrack(tr, frameCount);

  // Choose a sharp, high-confidence circular sprite for every stone.
  for (const tr of tracks.filter((t) => t.kind === 'stone')) {
    const best = [...tr.points].filter((p) => p.visible).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    if (!best) continue;
    const r = tr.r ?? height * 0.039;
    const frame = source(best.frame);
    tr.sprite = stoneSpriteFromFrame(frame, best.x, best.y, r);
    tr.refFrame = best.frame;
    tr.refAngle = best.angle ?? 0;
  }

  const estimate: MotionEstimate = { width, height, frameCount, background, tracks, sampleIndices, samples, brushCache: new Map(), baseCache: new Map(), layerCache: new Map() };
  repairBackground(estimate);
  return estimate;
}

export function drawStoneLayers(out: RgbaImage, estimate: MotionEstimate, frame: number, u = 0): void {
  const scale = estimate.height / 1080;
  const time = frame + u;
  for (const tr of estimate.tracks.filter((t) => t.kind === 'stone')) {
    const first = tr.points[0]?.frame ?? 0;
    const last = tr.points[tr.points.length - 1]?.frame ?? estimate.frameCount - 1;
    // Do not paint a fragment that starts decades later into an earlier interval.
    if (time < first - 3 || time > last + 3) continue;
    const pose = evaluateIntervalPose(tr, frame, u, scale);
    const r = tr.r ?? estimate.height * 0.039;
    // Fixed-world soft shadow; it must not rotate with the handle.
    drawSprite(
      out,
      SHADOW_SPRITE,
      0,
      0,
      0,
      0,
    );
    drawEllipseShadow(out, pose.x + r * 0.16, pose.y + r * 0.22, r * 1.03, r * 0.72);
    if (tr.sprite) {
      const rotation = tr.refAngle !== undefined && pose.angle !== undefined ? pose.angle - tr.refAngle : 0;
      drawSprite(out, tr.sprite, pose.x, pose.y, rotation);
    }
  }
}

// The shadow is drawn procedurally as an ellipse because a module-level sprite
// cannot know resolution. This tiny indirection keeps call sites readable.
const SHADOW_SPRITE: Sprite = { width: 1, height: 1, centerX: 0, centerY: 0, data: new Uint8ClampedArray([0, 0, 0, 0]) };
function drawEllipseShadow(out: RgbaImage, x: number, y: number, rx: number, ry: number): void {
  // Local import would create a cycle only at type level; use the canvas-free helper.
  for (let py = Math.max(0, Math.floor(y - ry - 2)); py <= Math.min(out.height - 1, Math.ceil(y + ry + 2)); py++) {
    for (let px = Math.max(0, Math.floor(x - rx - 2)); px <= Math.min(out.width - 1, Math.ceil(x + rx + 2)); px++) {
      const dx = (px + 0.5 - x) / rx;
      const dy = (py + 0.5 - y) / ry;
      const dist = dx * dx + dy * dy;
      if (dist >= 1) continue;
      const a = (1 - dist) * 0.22;
      const i = (py * out.width + px) * 4;
      out.data[i] = 20 * a + out.data[i] * (1 - a);
      out.data[i + 1] = 45 * a + out.data[i + 1] * (1 - a);
      out.data[i + 2] = 65 * a + out.data[i + 2] * (1 - a);
    }
  }
}

function drawBroomFragment(
  out: RgbaImage,
  tr: Track,
  frameA: number,
  frameB: number,
  u: number,
  imageA: RgbaImage,
  imageB: RgbaImage,
  predictedA: RgbaImage,
  predictedB: RgbaImage,
): void {
  const useA = u <= 0.5;
  const endpointFrame = useA ? frameA : frameB;
  const frame = useA ? imageA : imageB;
  const predicted = useA ? predictedA : predictedB;
  const scale = out.height / 1080;
  let sourcePoint = tr.points.find((p) => p.frame === endpointFrame && p.bbox);
  if (!sourcePoint) {
    sourcePoint = [...tr.points].filter((p) => p.bbox).sort((a, b) => Math.abs(a.frame - endpointFrame) - Math.abs(b.frame - endpointFrame))[0];
  }
  const bb = sourcePoint?.bbox;
  if (!sourcePoint || !bb) return;

  const pad = Math.ceil(7 * scale);
  const x0 = Math.max(0, bb.minX - pad);
  const y0 = Math.max(0, bb.minY - pad);
  const x1 = Math.min(frame.width - 1, bb.maxX + pad);
  const y1 = Math.min(frame.height - 1, bb.maxY + pad);
  const width = x1 - x0 + 1;
  const height = y1 - y0 + 1;
  const sprite: Sprite = {
    width,
    height,
    centerX: sourcePoint.x - x0,
    centerY: sourcePoint.y - y0,
    data: new Uint8ClampedArray(width * height * 4),
  };
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const di = ((y - y0) * width + (x - x0)) * 4;
      const fi = (y * frame.width + x) * 4;
      const dist = colorDistance(frame.data, fi, predicted.data, fi);
      const alpha = clamp((dist - 20) / 48, 0, 1);
      sprite.data[di] = frame.data[fi];
      sprite.data[di + 1] = frame.data[fi + 1];
      sprite.data[di + 2] = frame.data[fi + 2];
      sprite.data[di + 3] = Math.round(alpha * 255);
    }
  }
  // Stable diagnostic mode: paste the endpoint fragment at its exact source
  // pose. The benchmark then compares this against motion-compensated warping.
  drawSprite(out, sprite, sourcePoint.x, sourcePoint.y, 0);
}

function boostBroomColor(color: [number, number, number]): [number, number, number] {
  const [r, g, b] = color;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min > 70) return color;
  if (b > r && b > g) return [37, 99, 235];
  if (r > g * 1.4 && r > b * 1.4) return [225, 29, 72];
  return [14, 165, 233];
}

function extractHeadLayer(
  frame: RgbaImage,
  predicted: RgbaImage,
  head: BroomDetection,
  scale: number,
): Sprite {
  const half = Math.round(205 * scale);
  const size = half * 2 + 1;
  const data = new Uint8ClampedArray(size * size * 4);
  const hx = Math.round(head.x);
  const hy = Math.round(head.y);
  const ca = Math.cos(head.angle);
  const sa = Math.sin(head.angle);
  for (let sy = 0; sy < size; sy++) {
    const y = hy - half + sy;
    if (y < 0 || y >= frame.height) continue;
    for (let sx = 0; sx < size; sx++) {
      const x = hx - half + sx;
      const di = (sy * size + sx) * 4;
      if (x < 0 || x >= frame.width) { data[di + 3] = 0; continue; }
      const fi = (y * frame.width + x) * 4;
      const dist = colorDistance(frame.data, fi, predicted.data, fi);
      const dx = x - hx;
      const dy = y - hy;
      const along = Math.abs(ca * dx + sa * dy);
      const perp = Math.abs(-sa * dx + ca * dy);
      // Symmetric capsule: a pi sign error in handle direction is harmless
      // because alpha only contains real endpoint pixels inside this corridor.
      const capsule = along < 205 * scale && perp < 34 * scale ? 1 : Math.max(0, 1 - (perp - 34 * scale) / 28);
      const headCircle = Math.hypot(dx, dy) < 58 * scale ? 1 : 0;
      const mask = Math.max(capsule, headCircle);
      const alpha = clamp((dist - 20) / 50, 0, 1) * mask;
      data[di] = frame.data[fi];
      data[di + 1] = frame.data[fi + 1];
      data[di + 2] = frame.data[fi + 2];
      data[di + 3] = Math.round(alpha * 255);
    }
  }
  return { width: size, height: size, centerX: half, centerY: half, data };
}

function getPredictedBase(estimate: MotionEstimate, frame: number): RgbaImage {
  const cached = estimate.baseCache.get(frame);
  if (cached) return cached;
  const img: RgbaImage = {
    width: estimate.width,
    height: estimate.height,
    data: new Uint8ClampedArray(estimate.background.data),
  };
  drawStoneLayers(img, estimate, frame, 0);
  estimate.baseCache.set(frame, img);
  if (estimate.baseCache.size > 6) {
    const oldest = estimate.baseCache.keys().next().value;
    if (oldest !== undefined) estimate.baseCache.delete(oldest);
  }
  return img;
}

function headLayerCached(
  estimate: MotionEstimate,
  frame: number,
  image: RgbaImage,
  predicted: RgbaImage,
  head: BroomDetection,
  scale: number,
): Sprite {
  const key = `${frame}:${Math.round(head.x)}:${Math.round(head.y)}`;
  const cached = estimate.layerCache.get(key);
  if (cached) return cached;
  const layer = extractHeadLayer(image, predicted, head, scale);
  estimate.layerCache.set(key, layer);
  if (estimate.layerCache.size > 24) {
    const oldest = estimate.layerCache.keys().next().value;
    if (oldest !== undefined) estimate.layerCache.delete(oldest);
  }
  return layer;
}

function drawIntervalBrooms(
  out: RgbaImage,
  estimate: MotionEstimate,
  imageA: RgbaImage,
  imageB: RgbaImage,
  frameA: number,
  frameB: number,
  u: number,
): void {
  let da = estimate.brushCache.get(frameA);
  if (!da) {
    da = detectBrushHeads(imageA, estimate.background);
    estimate.brushCache.set(frameA, da);
  }
  let db = estimate.brushCache.get(frameB);
  if (!db) {
    db = detectBrushHeads(imageB, estimate.background);
    estimate.brushCache.set(frameB, db);
  }
  const usedB = new Set<number>();
  const scale = out.height / 1080;
  const predictedA = getPredictedBase(estimate, frameA);
  const predictedB = getPredictedBase(estimate, frameB);

  for (const a of da) {
    let best = -1;
    let bestCost = Infinity;
    db.forEach((b, bi) => {
      if (usedB.has(bi)) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist > 95 * scale) return;
      const colorCost = Math.abs(a.color[0] - b.color[0]) + Math.abs(a.color[1] - b.color[1]) + Math.abs(a.color[2] - b.color[2]);
      const cost = dist + colorCost * 0.08;
      if (cost < bestCost) { bestCost = cost; best = bi; }
    });
    if (best < 0) {
      drawSprite(out, headLayerCached(estimate, frameA, imageA, predictedA, a, scale), a.x, a.y, 0);
      continue;
    }
    usedB.add(best);
    const b = db[best];
    const x = a.x + (b.x - a.x) * u;
    const y = a.y + (b.y - a.y) * u;
    if (u < 0.5) {
      drawSprite(out, headLayerCached(estimate, frameA, imageA, predictedA, a, scale), x, y, 0, 1);
    } else if (u > 0.5) {
      drawSprite(out, headLayerCached(estimate, frameB, imageB, predictedB, b, scale), x, y, 0, 1);
    } else {
      drawSprite(out, headLayerCached(estimate, frameA, imageA, predictedA, a, scale), x, y, 0, 0.72);
      drawSprite(out, headLayerCached(estimate, frameB, imageB, predictedB, b, scale), x, y, 0, 0.72);
    }
  }
}

export interface InterpolateOptions {
  imageA: RgbaImage;
  imageB: RgbaImage;
  frameA: number;
  frameB?: number;
  u: number;
  skipBrooms?: boolean;
}

export function interpolateFrame(estimate: MotionEstimate, options: InterpolateOptions): RgbaImage {
  const { imageA, imageB, frameA, u, skipBrooms = false } = options;
  const frameB = options.frameB ?? frameA + 1;
  const out: RgbaImage = {
    width: estimate.width,
    height: estimate.height,
    data: new Uint8ClampedArray(estimate.background.data),
  };
  drawStoneLayers(out, estimate, frameA, u);

  if (!skipBrooms) {
    drawIntervalBrooms(out, estimate, imageA, imageB, frameA, frameB, u);
  }
  return out;
}

export { extractSprite };

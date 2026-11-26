import { createImage, type RgbaImage } from './image.ts';
import { clamp } from './image.ts';

export function colorDistance(d: Uint8Array, i: number, b: Uint8Array, j = i): number {
  const dr = d[i] - b[j];
  const dg = d[i + 1] - b[j + 1];
  const db = d[i + 2] - b[j + 2];
  return Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11);
}

export function buildBackgroundPlate(frames: RgbaImage[], samples = 15): RgbaImage {
  const first = frames[0];
  const out = createImage(first.width, first.height);
  const picks: RgbaImage[] = [];
  const n = Math.min(samples, frames.length);
  for (let k = 0; k < n; k++) picks.push(frames[Math.round((k * (frames.length - 1)) / Math.max(1, n - 1))]);
  const vals = new Int16Array(n);
  // Curling stones and brooms are darker/saturated than the bright ice. A high
  // percentile removes temporary objects even when a plain median would retain a
  // stone that is stationary during the first half of a collision clip. Static
  // lines survive because the same dark value occurs in every sampled frame.
  const q = Math.min(n - 1, Math.max(0, Math.round(n * 0.78)));
  for (let p = 0; p < first.width * first.height; p++) {
    const i = p * 4;
    for (let c = 0; c < 4; c++) {
      if (c === 3) {
        out.data[i + 3] = 255;
        continue;
      }
      for (let k = 0; k < n; k++) vals[k] = picks[k].data[i + c];
      vals.sort();
      out.data[i + c] = vals[q];
    }
  }
  return out;
}

export interface MaskOptions {
  threshold?: number;
  soft?: number;
  ignoreAlpha?: boolean;
}

/** Returns per-pixel foreground alpha 0..255 based on background distance. */
export function differenceMatte(frame: RgbaImage, bg: RgbaImage, opts: MaskOptions = {}): Uint8Array {
  const hard = opts.threshold ?? 24;
  const soft = opts.soft ?? 22;
  const alpha = new Uint8Array(frame.width * frame.height);
  const d = frame.data;
  const b = bg.data;
  for (let p = 0; p < alpha.length; p++) {
    const i = p * 4;
    const dist = colorDistance(d, i, b, i);
    alpha[p] = clamp(Math.round(((dist - hard) / soft) * 255), 0, 255);
  }
  return alpha;
}

export function dilateMask(mask: Uint8Array, w: number, h: number, radius = 1): Uint8Array {
  let src = mask;
  for (let step = 0; step < radius; step++) {
    const dst = new Uint8Array(src.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let m = 0;
        for (let oy = -1; oy <= 1 && !m; oy++) for (let ox = -1; ox <= 1; ox++) {
          const xx = x + ox;
          const yy = y + oy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && src[yy * w + xx]) { m = 255; break; }
        }
        dst[y * w + x] = m;
      }
    }
    src = dst;
  }
  return src;
}

export interface Component {
  id: number;
  pixels: number[];
  minX: number; minY: number; maxX: number; maxY: number;
  cx: number; cy: number; area: number;
}

export function connectedComponents(mask: Uint8Array, w: number, h: number, minArea = 40): Component[] {
  const labels = new Int32Array(w * h);
  const comps: Component[] = [];
  const stack: number[] = [];
  let nextId = 1;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const id = nextId++;
    const pixels: number[] = [];
    let minX = w, minY = h, maxX = -1, maxY = -1, sx = 0, sy = 0;
    labels[start] = id;
    stack.length = 0;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p / w) | 0;
      pixels.push(p);
      sx += x; sy += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbors = [p - 1, p + 1, p - w, p + w];
      for (let q of neighbors) {
        if (q < 0 || q >= mask.length || labels[q] || !mask[q]) continue;
        const qx = q % w;
        if (Math.abs(qx - x) > 1) continue;
        labels[q] = id;
        stack.push(q);
      }
    }
    if (pixels.length >= minArea) {
      comps.push({ id, pixels, minX, minY, maxX, maxY, cx: sx / pixels.length, cy: sy / pixels.length, area: pixels.length });
    }
  }
  return comps;
}

/** Subpixel circle locator using rim/background contrast. */
export function fitCircle(
  frame: RgbaImage,
  bg: RgbaImage,
  guessX: number,
  guessY: number,
  radius: number,
  search = radius * 0.9,
): { x: number; y: number; score: number } {
  const w = frame.width;
  const h = frame.height;
  const angles = 56;
  const sampleAt = (img: RgbaImage, x: number, y: number): number => {
    const ix = clamp(Math.round(x), 0, w - 1);
    const iy = clamp(Math.round(y), 0, h - 1);
    const i = (iy * w + ix) * 4;
    return img.data[i] * 0.3 + img.data[i + 1] * 0.59 + img.data[i + 2] * 0.11;
  };
  const score = (cx: number, cy: number): number => {
    let s = 0;
    for (let k = 0; k < angles; k++) {
      const a = (k / angles) * Math.PI * 2;
      const co = Math.cos(a);
      const si = Math.sin(a);
      const fx = cx + co * radius * 0.88;
      const fy = cy + si * radius * 0.88;
      const rx = cx + co * radius * 1.08;
      const ry = cy + si * radius * 1.08;
      const inside = sampleAt(frame, fx, fy);
      const outsideFrame = sampleAt(frame, rx, ry);
      const outsideBg = sampleAt(bg, rx, ry);
      // Rim should differ from the sheet; outside frame should agree with plate.
      s += Math.abs(inside - outsideFrame) * 0.35;
      s += Math.max(0, 28 - Math.abs(outsideFrame - outsideBg)) * 0.25;
      s -= Math.abs(outsideFrame - outsideBg) * 0.8;
    }
    return s;
  };

  let best = { x: guessX, y: guessY, score: -Infinity };
  const coarseStep = Math.max(1.5, radius / 14);
  const range = Math.ceil(search / coarseStep);
  for (let oy = -range; oy <= range; oy++) {
    for (let ox = -range; ox <= range; ox++) {
      const x = guessX + ox * coarseStep;
      const y = guessY + oy * coarseStep;
      if (x < radius || y < radius || x > w - radius || y > h - radius) continue;
      const sc = score(x, y);
      if (sc > best.score) best = { x, y, score: sc };
    }
  }
  let step = coarseStep;
  for (let iter = 0; iter < 3; iter++) {
    step *= 0.45;
    for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
      if (ox === 0 && oy === 0) continue;
      const x = best.x + ox * step;
      const y = best.y + oy * step;
      const sc = score(x, y);
      if (sc > best.score) best = { ...best, x, y, score: sc };
    }
  }
  return best;
}

export function estimateHandleAngle(frame: RgbaImage, x: number, y: number, radius: number): number | null {
  const d = frame.data;
  let mxx = 0, myy = 0, mxy = 0, n = 0;
  const r2 = radius * radius * 0.56;
  const x0 = Math.max(1, Math.floor(x - radius * 0.75));
  const x1 = Math.min(frame.width - 2, Math.ceil(x + radius * 0.75));
  const y0 = Math.max(1, Math.floor(y - radius * 0.75));
  const y1 = Math.min(frame.height - 2, Math.ceil(y + radius * 0.75));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = px - x;
      const dy = py - y;
      if (dx * dx + dy * dy > r2) continue;
      const i = (py * frame.width + px) * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) / max;
      // Red/yellow grip, or very dark handle mount.
      const colored = sat > 0.42 && max > 90 && ((r > g * 1.25 && r > b * 1.2) || (r > 170 && g > 120 && b < 100));
      const dark = max < 70;
      if (!colored && !dark) continue;
      const weight = colored ? 2.2 : 0.7;
      mxx += dx * dx * weight;
      myy += dy * dy * weight;
      mxy += dx * dy * weight;
      n++;
    }
  }
  if (n < radius * 1.5) return null;
  return 0.5 * Math.atan2(2 * mxy, mxx - myy);
}

export function unwrapAngle(next: number, prev: number): number {
  let a = next;
  while (a - prev > Math.PI / 2) a -= Math.PI;
  while (a - prev < -Math.PI / 2) a += Math.PI;
  // Handles are effectively π-symmetric; the above nearest-axis unwrap is enough.
  while (a - prev > Math.PI) a -= Math.PI * 2;
  while (a - prev < -Math.PI) a += Math.PI * 2;
  return a;
}

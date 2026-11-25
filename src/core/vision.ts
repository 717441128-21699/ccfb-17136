import type { RgbaImage } from './types';

export interface Component {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  area: number;
  cx: number;
  cy: number;
  m20: number;
  m11: number;
  m02: number;
}

export function forEachComponent(
  mask: Uint8Array,
  width: number,
  height: number,
  consume: (comp: Component, pixels: number[]) => void,
  minArea = 20,
): void {
  const visited = new Uint8Array(width * height);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    const stack = [start];
    visited[start] = 1;
    const pixels: number[] = [];
    let minX = width, minY = height, maxX = -1, maxY = -1;
    let sumX = 0, sumY = 0, m20 = 0, m11 = 0, m02 = 0;
    while (stack.length) {
      const idx = stack.pop()!;
      const x = idx % width;
      const y = (idx / width) | 0;
      pixels.push(idx);
      sumX += x;
      sumY += y;
      m20 += x * x;
      m11 += x * y;
      m02 += y * y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbors = [idx - 1, idx + 1, idx - width, idx + width, idx - width - 1, idx - width + 1, idx + width - 1, idx + width + 1];
      for (let n = 0; n < neighbors.length; n++) {
        const ni = neighbors[n];
        if (ni < 0 || ni >= mask.length || visited[ni] || !mask[ni]) continue;
        const nx = ni % width;
        const ny = (ni / width) | 0;
        // Reject diagonal wrap across row boundaries for left/right offsets.
        if (Math.abs(nx - x) > 1 || Math.abs(ny - y) > 1) continue;
        visited[ni] = 1;
        stack.push(ni);
      }
    }
    const area = pixels.length;
    if (area >= minArea) {
      consume({ minX, minY, maxX, maxY, area, cx: sumX / area, cy: sumY / area, m20, m11, m02 }, pixels);
    }
  }
}

export function componentAngle(c: Component): number {
  const a = c.m20 / c.area - c.cx * c.cx;
  const b = 2 * (c.m11 / c.area - c.cx * c.cy);
  const d = c.m02 / c.area - c.cy * c.cy;
  return 0.5 * Math.atan2(b, a - d);
}

export function isRedHandle(r: number, g: number, b: number): boolean {
  return r > 165 && r - g > 65 && r - b > 55 && g < 135 && b < 135;
}

export function isYellowHandle(r: number, g: number, b: number): boolean {
  return r > 185 && g > 145 && r - b > 105 && g - b > 55 && b < 125;
}

export function isSaturatedColor(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min > 55 && max > 120;
}

export function colorDistance(a: Uint8ClampedArray, ai: number, b: Uint8ClampedArray, bi: number): number {
  const dr = a[ai] - b[bi];
  const dg = a[ai + 1] - b[bi + 1];
  const db = a[ai + 2] - b[bi + 2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

export function medianBackground(samples: RgbaImage[]): RgbaImage {
  const first = samples[0];
  const out: RgbaImage = { width: first.width, height: first.height, data: new Uint8ClampedArray(first.width * first.height * 4) };
  const k = samples.length;
  const mid = k >> 1;
  const rs = new Array<number>(k);
  const gs = new Array<number>(k);
  const bs = new Array<number>(k);
  for (let p = 0; p < first.width * first.height; p++) {
    const i = p * 4;
    for (let s = 0; s < k; s++) {
      const d = samples[s].data;
      rs[s] = d[i];
      gs[s] = d[i + 1];
      bs[s] = d[i + 2];
    }
    rs.sort((a, b) => a - b);
    gs.sort((a, b) => a - b);
    bs.sort((a, b) => a - b);
    out.data[i] = rs[mid];
    out.data[i + 1] = gs[mid];
    out.data[i + 2] = bs[mid];
    out.data[i + 3] = 255;
  }
  return out;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function wrapAnglePi(a: number): number {
  let x = a;
  while (x > Math.PI / 2) x -= Math.PI;
  while (x < -Math.PI / 2) x += Math.PI;
  return x;
}

export function unwrapAnglePi(prev: number, next: number): number {
  let n = wrapAnglePi(next);
  const candidates = [n, n + Math.PI, n - Math.PI];
  let best = n;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = Math.abs(c - prev);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

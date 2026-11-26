import type { RgbaImage } from '../image.ts';
import { clamp } from '../image.ts';

export type RGB = readonly [number, number, number];

export function setPx(img: RgbaImage, x: number, y: number, r: number, g: number, b: number, a = 255): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height || a <= 0) return;
  const i = (y * img.width + x) * 4;
  const da = a / 255;
  const sa = img.data[i + 3] / 255;
  const outA = da + sa * (1 - da);
  if (outA <= 0) return;
  img.data[i] = Math.round((r * da + img.data[i] * sa * (1 - da)) / outA);
  img.data[i + 1] = Math.round((g * da + img.data[i + 1] * sa * (1 - da)) / outA);
  img.data[i + 2] = Math.round((b * da + img.data[i + 2] * sa * (1 - da)) / outA);
  img.data[i + 3] = Math.round(outA * 255);
}

export function fillRect(img: RgbaImage, x0: number, y0: number, x1: number, y1: number, color: RGB, alpha = 255): void {
  const xa = Math.max(0, Math.floor(x0));
  const xb = Math.min(img.width - 1, Math.ceil(x1));
  const ya = Math.max(0, Math.floor(y0));
  const yb = Math.min(img.height - 1, Math.ceil(y1));
  for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) setPx(img, x, y, color[0], color[1], color[2], alpha);
}

/** Antialiased filled circle with an optional radial lighting function. */
export function fillCircle(
  img: RgbaImage,
  cx: number,
  cy: number,
  radius: number,
  color: RGB | ((nx: number, ny: number, d: number) => RGB),
  alpha = 255,
): void {
  const x0 = Math.max(0, Math.floor(cx - radius - 1));
  const x1 = Math.min(img.width - 1, Math.ceil(cx + radius + 1));
  const y0 = Math.max(0, Math.floor(cy - radius - 1));
  const y1 = Math.min(img.height - 1, Math.ceil(cy + radius + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      const coverage = clamp(radius + 0.5 - d, 0, 1);
      if (coverage <= 0) continue;
      const rgb = typeof color === 'function' ? color(dx / radius, dy / radius, d / radius) : color;
      setPx(img, x, y, rgb[0], rgb[1], rgb[2], Math.round(alpha * coverage));
    }
  }
}

export function fillEllipse(
  img: RgbaImage,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  color: RGB,
  alpha = 255,
): void {
  const x0 = Math.max(0, Math.floor(cx - rx - 1));
  const x1 = Math.min(img.width - 1, Math.ceil(cx + rx + 1));
  const y0 = Math.max(0, Math.floor(cy - ry - 1));
  const y1 = Math.min(img.height - 1, Math.ceil(cy + ry + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      const d = Math.hypot(dx, dy);
      const coverage = clamp((1 - d) * Math.min(rx, ry) + 0.5, 0, 1);
      if (coverage > 0) setPx(img, x, y, color[0], color[1], color[2], Math.round(alpha * coverage));
    }
  }
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const l2 = vx * vx + vy * vy;
  let t = l2 === 0 ? 0 : ((px - ax) * vx + (py - ay) * vy) / l2;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

export function strokeSegment(
  img: RgbaImage,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  width: number,
  color: RGB,
  alpha = 255,
): void {
  const r = width / 2;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1));
  const x1 = Math.min(img.width - 1, Math.ceil(Math.max(ax, bx) + r + 1));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r - 1));
  const y1 = Math.min(img.height - 1, Math.ceil(Math.max(ay, by) + r + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = distToSegment(x + 0.5, y + 0.5, ax, ay, bx, by);
      const coverage = clamp(r + 0.5 - d, 0, 1);
      if (coverage > 0) setPx(img, x, y, color[0], color[1], color[2], Math.round(alpha * coverage));
    }
  }
}

export function fillOrientedRect(
  img: RgbaImage,
  cx: number,
  cy: number,
  length: number,
  width: number,
  angle: number,
  color: RGB,
  alpha = 255,
): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const hx = length / 2 + 1;
  const hy = width / 2 + 1;
  const x0 = Math.max(0, Math.floor(cx - Math.abs(cos) * hx - Math.abs(sin) * hy - 1));
  const x1 = Math.min(img.width - 1, Math.ceil(cx + Math.abs(cos) * hx + Math.abs(sin) * hy + 1));
  const y0 = Math.max(0, Math.floor(cy - Math.abs(sin) * hx - Math.abs(cos) * hy - 1));
  const y1 = Math.min(img.height - 1, Math.ceil(cy + Math.abs(sin) * hx + Math.abs(cos) * hy + 1));
  const hl = length / 2;
  const hw = width / 2;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const lx = dx * cos + dy * sin;
      const ly = -dx * sin + dy * cos;
      const cxDist = Math.max(Math.abs(lx) - hl, 0);
      const cyDist = Math.max(Math.abs(ly) - hw, 0);
      const d = Math.hypot(cxDist, cyDist);
      const coverage = clamp(0.75 - d, 0, 1);
      if (coverage > 0) setPx(img, x, y, color[0], color[1], color[2], Math.round(alpha * coverage));
    }
  }
}

export function strokeCircle(
  img: RgbaImage,
  cx: number,
  cy: number,
  radius: number,
  width: number,
  color: RGB,
  alpha = 255,
): void {
  const x0 = Math.max(0, Math.floor(cx - radius - width - 1));
  const x1 = Math.min(img.width - 1, Math.ceil(cx + radius + width + 1));
  const y0 = Math.max(0, Math.floor(cy - radius - width - 1));
  const y1 = Math.min(img.height - 1, Math.ceil(cy + radius + width + 1));
  const half = width / 2;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const coverage = clamp(half + 0.5 - Math.abs(d - radius), 0, 1);
      if (coverage > 0) setPx(img, x, y, color[0], color[1], color[2], Math.round(alpha * coverage));
    }
  }
}

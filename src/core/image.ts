import type { PsnrResult, RgbaImage } from './types';

export function createImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function cloneImage(img: RgbaImage): RgbaImage {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function blendPixel(
  data: Uint8ClampedArray,
  index: number,
  r: number,
  g: number,
  b: number,
  alpha: number,
): void {
  if (alpha <= 0) return;
  const a = Math.min(1, alpha);
  if (a >= 0.999) {
    data[index] = r;
    data[index + 1] = g;
    data[index + 2] = b;
    data[index + 3] = 255;
    return;
  }
  data[index] = r * a + data[index] * (1 - a);
  data[index + 1] = g * a + data[index + 1] * (1 - a);
  data[index + 2] = b * a + data[index + 2] * (1 - a);
  data[index + 3] = 255;
}

export function fillAll(img: RgbaImage, r: number, g: number, b: number): void {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = 255;
  }
}

function coverageFromSd(sd: number): number {
  // sd is negative inside; edge is at zero.
  return Math.max(0, Math.min(1, 0.75 - sd));
}

export function drawCircle(
  img: RgbaImage,
  cx: number,
  cy: number,
  radius: number,
  color: string | [number, number, number],
  alpha = 1,
): void {
  const [r, g, b] = typeof color === 'string' ? hexToRgb(color) : color;
  const x0 = Math.max(0, Math.floor(cx - radius - 2));
  const x1 = Math.min(img.width - 1, Math.ceil(cx + radius + 2));
  const y0 = Math.max(0, Math.floor(cy - radius - 2));
  const y1 = Math.min(img.height - 1, Math.ceil(cy + radius + 2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const cov = coverageFromSd(dist - radius) * alpha;
      if (cov > 0) blendPixel(img.data, (y * img.width + x) * 4, r, g, b, cov);
    }
  }
}

export function drawEllipse(
  img: RgbaImage,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  color: string | [number, number, number],
  alpha = 1,
): void {
  const [r, g, b] = typeof color === 'string' ? hexToRgb(color) : color;
  const x0 = Math.max(0, Math.floor(cx - rx - 2));
  const x1 = Math.min(img.width - 1, Math.ceil(cx + rx + 2));
  const y0 = Math.max(0, Math.floor(cy - ry - 2));
  const y1 = Math.min(img.height - 1, Math.ceil(cy + ry + 2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const cov = coverageFromSd((dist - 1) * Math.min(rx, ry)) * alpha;
      if (cov > 0) blendPixel(img.data, (y * img.width + x) * 4, r, g, b, cov);
    }
  }
}

export function drawRing(
  img: RgbaImage,
  cx: number,
  cy: number,
  radius: number,
  thickness: number,
  color: string | [number, number, number],
  alpha = 1,
): void {
  const [r, g, b] = typeof color === 'string' ? hexToRgb(color) : color;
  const half = thickness / 2;
  const x0 = Math.max(0, Math.floor(cx - radius - thickness - 2));
  const x1 = Math.min(img.width - 1, Math.ceil(cx + radius + thickness + 2));
  const y0 = Math.max(0, Math.floor(cy - radius - thickness - 2));
  const y1 = Math.min(img.height - 1, Math.ceil(cy + radius + thickness + 2));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const sd = Math.abs(dist - radius) - half;
      const cov = coverageFromSd(sd) * alpha;
      if (cov > 0) blendPixel(img.data, (y * img.width + x) * 4, r, g, b, cov);
    }
  }
}

function roundedRectSd(px: number, py: number, w: number, h: number, rad: number): number {
  const qx = Math.abs(px) - (w / 2 - rad);
  const qy = Math.abs(py) - (h / 2 - rad);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - rad;
}

export function drawRotatedRoundRect(
  img: RgbaImage,
  cx: number,
  cy: number,
  w: number,
  h: number,
  radius: number,
  rotation: number,
  color: string | [number, number, number],
  alpha = 1,
): void {
  const [r, g, b] = typeof color === 'string' ? hexToRgb(color) : color;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const bound = Math.hypot(w, h) / 2 + 3;
  const x0 = Math.max(0, Math.floor(cx - bound));
  const x1 = Math.min(img.width - 1, Math.ceil(cx + bound));
  const y0 = Math.max(0, Math.floor(cy - bound));
  const y1 = Math.min(img.height - 1, Math.ceil(cy + bound));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const lx = cos * dx + sin * dy;
      const ly = -sin * dx + cos * dy;
      const sd = roundedRectSd(lx, ly, w, h, Math.min(radius, w / 2, h / 2));
      const cov = coverageFromSd(sd) * alpha;
      if (cov > 0) blendPixel(img.data, (y * img.width + x) * 4, r, g, b, cov);
    }
  }
}

export function drawCapsuleBetween(
  img: RgbaImage,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  color: string | [number, number, number],
  alpha = 1,
): void {
  const [r, g, b] = typeof color === 'string' ? hexToRgb(color) : color;
  const rad = width / 2;
  const minX = Math.min(x1, x2) - rad - 2;
  const maxX = Math.max(x1, x2) + rad + 2;
  const minY = Math.min(y1, y2) - rad - 2;
  const maxY = Math.max(y1, y2) + rad + 2;
  const x0 = Math.max(0, Math.floor(minX));
  const x1i = Math.min(img.width - 1, Math.ceil(maxX));
  const y0 = Math.max(0, Math.floor(minY));
  const y1i = Math.min(img.height - 1, Math.ceil(maxY));
  const vx = x2 - x1;
  const vy = y2 - y1;
  const len2 = vx * vx + vy * vy || 1;
  for (let y = y0; y <= y1i; y++) {
    for (let x = x0; x <= x1i; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let t = ((px - x1) * vx + (py - y1) * vy) / len2;
      t = Math.max(0, Math.min(1, t));
      const qx = x1 + t * vx;
      const qy = y1 + t * vy;
      const dist = Math.hypot(px - qx, py - qy);
      const cov = coverageFromSd(dist - rad) * alpha;
      if (cov > 0) blendPixel(img.data, (y * img.width + x) * 4, r, g, b, cov);
    }
  }
}

export interface Sprite {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  data: Uint8ClampedArray; // straight RGBA
}

export function extractSprite(
  frame: RgbaImage,
  cx: number,
  cy: number,
  halfSize: number,
  alphaFn?: (x: number, y: number, r: number, g: number, b: number) => number,
): Sprite {
  const size = halfSize * 2 + 1;
  const data = new Uint8ClampedArray(size * size * 4);
  const x0 = Math.round(cx) - halfSize;
  const y0 = Math.round(cy) - halfSize;
  for (let sy = 0; sy < size; sy++) {
    const fy = y0 + sy;
    for (let sx = 0; sx < size; sx++) {
      const fx = x0 + sx;
      const di = (sy * size + sx) * 4;
      if (fx < 0 || fy < 0 || fx >= frame.width || fy >= frame.height) {
        data[di + 3] = 0;
        continue;
      }
      const fi = (fy * frame.width + fx) * 4;
      const r = frame.data[fi];
      const g = frame.data[fi + 1];
      const b = frame.data[fi + 2];
      data[di] = r;
      data[di + 1] = g;
      data[di + 2] = b;
      data[di + 3] = alphaFn ? Math.round(alphaFn(fx, fy, r, g, b) * 255) : 255;
    }
  }
  return { width: size, height: size, centerX: halfSize, centerY: halfSize, data };
}

function sampleSprite(sprite: Sprite, x: number, y: number): [number, number, number, number] {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  let r = 0, g = 0, b = 0, a = 0;
  let aw = 0;
  for (let oy = 0; oy <= 1; oy++) {
    for (let ox = 0; ox <= 1; ox++) {
      const sx = x0 + ox;
      const sy = y0 + oy;
      if (sx < 0 || sy < 0 || sx >= sprite.width || sy >= sprite.height) continue;
      const w = (ox === 0 ? 1 - tx : tx) * (oy === 0 ? 1 - ty : ty);
      const i = (sy * sprite.width + sx) * 4;
      const alpha = sprite.data[i + 3] / 255;
      // Weight color by alpha so transparent texels do not bleed color.
      r += sprite.data[i] * alpha * w;
      g += sprite.data[i + 1] * alpha * w;
      b += sprite.data[i + 2] * alpha * w;
      a += alpha * w;
      aw += alpha * w;
    }
  }
  if (a <= 0.00001) return [0, 0, 0, 0];
  return [r / aw, g / aw, b / aw, Math.min(1, a)];
}

export function drawSprite(
  dst: RgbaImage,
  sprite: Sprite,
  x: number,
  y: number,
  rotation = 0,
  opacity = 1,
): void {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const radius = Math.hypot(sprite.width, sprite.height) / 2 + 2;
  const x0 = Math.max(0, Math.floor(x - radius));
  const x1 = Math.min(dst.width - 1, Math.ceil(x + radius));
  const y0 = Math.max(0, Math.floor(y - radius));
  const y1 = Math.min(dst.height - 1, Math.ceil(y + radius));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = px + 0.5 - x;
      const dy = py + 0.5 - y;
      // Inverse map destination to source.
      const lx = cos * dx + sin * dy;
      const ly = -sin * dx + cos * dy;
      const sx = lx + sprite.centerX;
      const sy = ly + sprite.centerY;
      if (sx < 0 || sy < 0 || sx >= sprite.width - 1 || sy >= sprite.height - 1) continue;
      const [r, g, b, a] = sampleSprite(sprite, sx, sy);
      const alpha = a * opacity;
      if (alpha > 0.001) blendPixel(dst.data, (py * dst.width + px) * 4, r, g, b, alpha);
    }
  }
}

export function computePsnr(a: RgbaImage, b: RgbaImage): PsnrResult {
  if (a.width !== b.width || a.height !== b.height) throw new Error('PSNR dimensions differ');
  const n = a.width * a.height;
  let sum = 0;
  let maxChannelMse = 0;
  const channelSums = [0, 0, 0];
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a.data[i + c] - b.data[i + c];
      const d2 = d * d;
      sum += d2;
      channelSums[c] += d2;
    }
  }
  const mse = sum / (n * 3);
  for (const s of channelSums) maxChannelMse = Math.max(maxChannelMse, s / n);
  return {
    mse,
    maxChannelMse,
    psnr: mse <= 1e-10 ? Infinity : 10 * Math.log10((255 * 255) / mse),
    pixels: n,
  };
}

export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

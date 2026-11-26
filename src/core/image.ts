export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface MotionVector {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function createImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

export function cloneImage(img: RgbaImage): RgbaImage {
  return { width: img.width, height: img.height, data: img.data.slice() };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function getPixel(img: RgbaImage, x: number, y: number, out: number[]): void {
  const ix = x | 0;
  const iy = y | 0;
  if (ix < 0 || iy < 0 || ix >= img.width || iy >= img.height) {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
    return;
  }
  const i = (iy * img.width + ix) * 4;
  out[0] = img.data[i];
  out[1] = img.data[i + 1];
  out[2] = img.data[i + 2];
  out[3] = img.data[i + 3];
}

/** Bilinear RGBA sample. Coordinates are pixel centers. */
export function sampleBilinear(img: RgbaImage, x: number, y: number, out: Float32Array | number[]): void {
  const w = img.width;
  const h = img.height;
  if (x < -1 || y < -1 || x > w || y > h) {
    out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0;
    return;
  }
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  const i00 = (clamp(y0, 0, h - 1) * w + clamp(x0, 0, w - 1)) * 4;
  const i10 = (clamp(y0, 0, h - 1) * w + clamp(x1, 0, w - 1)) * 4;
  const i01 = (clamp(y1, 0, h - 1) * w + clamp(x0, 0, w - 1)) * 4;
  const i11 = (clamp(y1, 0, h - 1) * w + clamp(x1, 0, w - 1)) * 4;
  const d = img.data;

  for (let c = 0; c < 4; c++) {
    const a = d[i00 + c] * (1 - fx) + d[i10 + c] * fx;
    const b = d[i01 + c] * (1 - fx) + d[i11 + c] * fx;
    out[c] = a * (1 - fy) + b * fy;
  }
}

export function copyPixel(dst: RgbaImage, dx: number, dy: number, src: RgbaImage, sx: number, sy: number): void {
  if (dx < 0 || dy < 0 || dx >= dst.width || dy >= dst.height) return;
  if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) return;
  const di = (dy * dst.width + dx) * 4;
  const si = (sy * src.width + sx) * 4;
  dst.data[di] = src.data[si];
  dst.data[di + 1] = src.data[si + 1];
  dst.data[di + 2] = src.data[si + 2];
  dst.data[di + 3] = src.data[si + 3];
}

export function psnr(a: RgbaImage, b: RgbaImage, mask?: Uint8Array): number {
  if (a.width !== b.width || a.height !== b.height) throw new Error('PSNR image size mismatch');
  const n = a.width * a.height;
  let sum = 0;
  let count = 0;
  for (let p = 0; p < n; p++) {
    if (mask && !mask[p]) continue;
    const i = p * 4;
    // Rec. 601 luma is closer to perceived replay quality, but the default
    // metric below is full RGB MSE as commonly reported by ffmpeg/PSNR tests.
    for (let c = 0; c < 3; c++) {
      const d = a.data[i + c] - b.data[i + c];
      sum += d * d;
      count++;
    }
  }
  if (count === 0) return Infinity;
  const mse = sum / count;
  if (mse < 1e-10) return Infinity;
  return 10 * Math.log10((255 * 255) / mse);
}

export function lumaPsnr(a: RgbaImage, b: RgbaImage): number {
  const n = a.width * a.height;
  let sum = 0;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const ya = 0.299 * a.data[i] + 0.587 * a.data[i + 1] + 0.114 * a.data[i + 2];
    const yb = 0.299 * b.data[i] + 0.587 * b.data[i + 1] + 0.114 * b.data[i + 2];
    const d = ya - yb;
    sum += d * d;
  }
  const mse = sum / n;
  if (mse < 1e-10) return Infinity;
  return 10 * Math.log10(255 * 255 / mse);
}

export function rgbaToCanvas(img: RgbaImage, canvas: HTMLCanvasElement): void {
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(img.width, img.height);
  imageData.data.set(img.data);
  ctx.putImageData(imageData, 0, 0);
}

export function canvasToRgba(canvas: HTMLCanvasElement): RgbaImage {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return { width: canvas.width, height: canvas.height, data: new Uint8Array(data) };
}

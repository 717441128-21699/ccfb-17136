import { luma } from './image';
import { layoutFor } from './curlingScene';
import type { LineMetric, RgbaImage } from './types';

function isRedLine(r: number, g: number, b: number): boolean {
  return r > 145 && g < 105 && b < 105 && r - g > 55;
}

function isBlueLine(r: number, g: number, b: number): boolean {
  return b > 145 && b - r > 55 && g < 185;
}

function pixelAt(img: RgbaImage, x: number, y: number): [number, number, number] {
  const xi = Math.max(0, Math.min(img.width - 1, x | 0));
  const yi = Math.max(0, Math.min(img.height - 1, y | 0));
  const i = (yi * img.width + xi) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

function hasLinePixel(img: RgbaImage, x: number, y: number, radius: number, kind: 'red' | 'blue'): boolean {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const [r, g, b] = pixelAt(img, x + dx, y + dy);
      if (kind === 'red' ? isRedLine(r, g, b) : isBlueLine(r, g, b)) return true;
    }
  }
  return false;
}

/**
 * Verifies the two straight markings that are most visible in a line call.
 * Truth is used only to ignore columns genuinely occluded by a stone/broom.
 * An unoccluded missing run is reported as a break; displacement reports bend.
 */
export type OcclusionPredicate = (x: number, y: number) => boolean;

export function measureLineIntegrity(
  img: RgbaImage,
  truth: RgbaImage,
  isOccluded?: OcclusionPredicate,
): LineMetric {
  const l = layoutFor(img.width, img.height);
  let gapPixels = 0;
  let truthPixels = 0;
  let matchedPixels = 0;
  let maxDeviationPx = 0;
  let brokenSegments = 0;
  let missingRun = 0;

  const checkMissing = (missing: boolean): void => {
    if (missing) {
      gapPixels++;
      missingRun++;
    } else {
      if (missingRun > Math.max(4, 5 * (l.stoneRadius / 42))) brokenSegments++;
      missingRun = 0;
    }
  };

  // Horizontal tee line.
  for (let x = Math.ceil(l.sheet.left + 12); x <= Math.floor(l.sheet.right - 12); x++) {
    if (isOccluded?.(x, Math.round(l.teeY))) continue;
    const truthHere = hasLinePixel(truth, x, Math.round(l.teeY), 7, 'red');
    if (!truthHere) continue;
    truthPixels++;
    const outHere = hasLinePixel(img, x, Math.round(l.teeY), 6, 'red');
    if (outHere) {
      matchedPixels++;
      const deviationEligible = Math.abs(x - l.centerX) > l.houseRadii[0] + 24;
      if (deviationEligible) {
        let bestSupport = 0;
        let nearest = Infinity;
        for (let dy = -7; dy <= 7; dy++) {
          let support = 0;
          for (let dx = -4; dx <= 4; dx++) {
            const [r, g, b] = pixelAt(img, x + dx, Math.round(l.teeY) + dy);
            if (isRedLine(r, g, b)) support++;
          }
          if (support >= 4 && (support > bestSupport || (support === bestSupport && Math.abs(dy) < nearest))) {
            bestSupport = support;
            nearest = Math.abs(dy);
          }
        }
        if (Number.isFinite(nearest)) maxDeviationPx = Math.max(maxDeviationPx, nearest);
      }
      checkMissing(false);
    } else {
      checkMissing(true);
    }
  }
  if (missingRun > 5) brokenSegments++;
  missingRun = 0;

  // Vertical center line.
  for (let y = 20; y < img.height - 20; y++) {
    if (isOccluded?.(Math.round(l.centerX), y)) continue;
    const truthHere = hasLinePixel(truth, Math.round(l.centerX), y, 7, 'red');
    if (!truthHere) continue;
    truthPixels++;
    const outHere = hasLinePixel(img, Math.round(l.centerX), y, 6, 'red');
    if (outHere) {
      matchedPixels++;
      const deviationEligible = Math.abs(y - l.teeY) > l.houseRadii[0] + 24;
      if (deviationEligible) {
        let bestSupport = 0;
        let nearest = Infinity;
        for (let dx = -7; dx <= 7; dx++) {
          let support = 0;
          for (let dy = -4; dy <= 4; dy++) {
            const [r, g, b] = pixelAt(img, Math.round(l.centerX) + dx, y + dy);
            if (isRedLine(r, g, b)) support++;
          }
          if (support >= 4 && (support > bestSupport || (support === bestSupport && Math.abs(dx) < nearest))) {
            bestSupport = support;
            nearest = Math.abs(dx);
          }
        }
        if (Number.isFinite(nearest)) maxDeviationPx = Math.max(maxDeviationPx, nearest);
      }
      checkMissing(false);
    } else {
      checkMissing(true);
    }
  }
  if (missingRun > 5) brokenSegments++;

  const score = truthPixels ? (100 * matchedPixels) / truthPixels : 100;
  return {
    score,
    maxDeviationPx,
    gapPixels,
    totalLinePixels: truthPixels,
    brokenSegments: Math.max(0, brokenSegments),
  };
}

function sobelEdges(img: RgbaImage, roi: { x0: number; y0: number; x1: number; y1: number }): Uint8Array {
  const w = roi.x1 - roi.x0;
  const h = roi.y1 - roi.y0;
  const gray = new Float32Array(w * h);
  const edges = new Uint8Array(w * h);
  for (let y = roi.y0; y < roi.y1; y++) {
    for (let x = roi.x0; x < roi.x1; x++) {
      const i = (y * img.width + x) * 4;
      gray[(y - roi.y0) * w + (x - roi.x0)] = luma(img.data[i], img.data[i + 1], img.data[i + 2]);
    }
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx =
        -gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1] +
        gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1];
      const gy =
        -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1] +
        gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
      if (Math.hypot(gx, gy) > 95) edges[i] = 1;
    }
  }
  return edges;
}

function dilate(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy > radius * radius) continue;
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h) out[yy * w + xx] = 1;
        }
      }
    }
  }
  return out;
}

/**
 * Fraction of strong output edges that have no corresponding truth edge.
 * A doubled stone/broom creates a parallel extra edge; this catches that even
 * when global PSNR remains acceptable. Lower is better.
 */
export function ghostScore(out: RgbaImage, truth: RgbaImage, centerX?: number, centerY?: number, radius = 230): number {
  const cx = centerX ?? out.width / 2;
  const cy = centerY ?? out.height * 0.52;
  const roi = {
    x0: Math.max(0, Math.floor(cx - radius * 1.4)),
    y0: Math.max(0, Math.floor(cy - radius)),
    x1: Math.min(out.width, Math.ceil(cx + radius * 1.4)),
    y1: Math.min(out.height, Math.ceil(cy + radius)),
  };
  const w = roi.x1 - roi.x0;
  const h = roi.y1 - roi.y0;
  const oe = sobelEdges(out, roi);
  const te = dilate(sobelEdges(truth, roi), w, h, 3);
  let outputEdges = 0;
  let unmatched = 0;
  for (let i = 0; i < oe.length; i++) {
    if (!oe[i]) continue;
    outputEdges++;
    if (!te[i]) unmatched++;
  }
  return outputEdges ? unmatched / outputEdges : 0;
}

import type { RgbaImage } from './image.ts';

function luma(img: RgbaImage, x: number, y: number): number {
  const ix = Math.max(0, Math.min(img.width - 1, x | 0));
  const iy = Math.max(0, Math.min(img.height - 1, y | 0));
  const i = (iy * img.width + ix) * 4;
  return img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114;
}

export interface TranslationMatch {
  dx: number;
  dy: number;
  score: number;
}

/**
* Weighted SAD template match in a circular object window. Integer search is
* followed by a quadratic sub-pixel fit. The caller supplies a motion prediction.
*/
export function matchTranslation(
  templateFrame: RgbaImage,
  targetFrame: RgbaImage,
  cx: number,
  cy: number,
  radius: number,
  predictedDx = 0,
  predictedDy = 0,
  search?: number,
): TranslationMatch {
  const range = Math.ceil(search ?? radius * 1.45);
  const pr = Math.round(predictedDx);
  const py = Math.round(predictedDy);
  const r = Math.max(3, Math.round(radius * 0.92));
  const vals: number[] = [];
  const tpl: number[] = [];
  const coords: Array<[number, number]> = [];
  for (let y = -r; y <= r; y += 1) {
    for (let x = -r; x <= r; x += 1) {
      if (x * x + y * y > r * r) continue;
      coords.push([x, y]);
      tpl.push(luma(templateFrame, cx + x, cy + y));
    }
  }

  const scoreAt = (dx: number, dy: number, stride = 1): number => {
    let sad = 0;
    let count = 0;
    for (let k = 0; k < coords.length; k += stride) {
      const [x, y] = coords[k];
      sad += Math.abs(tpl[k] - luma(targetFrame, cx + x + dx, cy + y + dy));
      count++;
    }
    return sad / Math.max(1, count);
  };

  let best = { dx: pr, dy: py, score: Infinity };
  const scoreGrid = new Map<string, number>();
  const coarseStep = radius >= 22 ? 3 : 2;
  const templateStride = radius >= 22 ? 2 : 1;
  for (let dy = py - range; dy <= py + range; dy += coarseStep) {
    for (let dx = pr - range; dx <= pr + range; dx += coarseStep) {
      const s = scoreAt(dx, dy, templateStride);
      scoreGrid.set(`${dx},${dy}`, s);
      if (s < best.score) best = { dx, dy, score: s };
    }
  }
  // Local integer-resolution search around the coarse minimum.
  for (let dy = best.dy - coarseStep; dy <= best.dy + coarseStep; dy++) {
    for (let dx = best.dx - coarseStep; dx <= best.dx + coarseStep; dx++) {
      if (scoreGrid.has(`${dx},${dy}`)) continue;
      const s = scoreAt(dx, dy);
      scoreGrid.set(`${dx},${dy}`, s);
      if (s < best.score) best = { dx, dy, score: s };
    }
  }

  // Parabolic refinement on the three scores around the integer minimum.
  const refine1 = (center: number, minus: number, zero: number, plus: number): number => {
    const denom = minus + plus - 2 * zero;
    if (denom <= 1e-6) return center;
    const delta = (minus - plus) / (2 * denom);
    return center + Math.max(-0.9, Math.min(0.9, delta));
  };
  const zero = scoreAt(best.dx, best.dy);
  const sm = scoreAt(best.dx - 1, best.dy);
  const sp = scoreAt(best.dx + 1, best.dy);
  const syM = scoreAt(best.dx, best.dy - 1);
  const syP = scoreAt(best.dx, best.dy + 1);
  const dx = refine1(best.dx, sm, zero, sp);
  const dy = refine1(best.dy, syM, zero, syP);
  vals.push(zero);
  return { dx, dy, score: zero };
}

/** Phase-ish centroid of a soft matte inside a local window. */
export function matteCentroid(mask: Uint8Array, width: number, cx: number, cy: number, radius: number) {
  let sx = 0, sy = 0, sw = 0;
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(width - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(mask.length / width - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const a = mask[y * width + x];
    if (a < 40) continue;
    sx += x * a; sy += y * a; sw += a;
  }
  return sw > 0 ? { x: sx / sw, y: sy / sw, weight: sw } : { x: cx, y: cy, weight: 0 };
}

import { renderFrame } from '../src/core/curlingScene';
import { estimateMotion, detectBrushHeads } from '../src/core/motion';

const s = 'sweep' as const;
const W = 1920, H = 1080, N = 90;
const est = estimateMotion((i) => renderFrame(s, i / 30, W, H), N, W, H);
for (const f of [44, 45, 46, 47, 50, 51]) {
  const img = renderFrame(s, f / 30, W, H);
  const heads = detectBrushHeads(img, est.background);
  console.log('frame', f, heads.map(h => `(${h.x.toFixed(0)},${h.y.toFixed(0)}) a=${h.angle.toFixed(2)} area=${h.area} score=${h.score.toFixed(0)} c=${h.color.map(x=>x.toFixed(0)).join('/')}`).join(' | '));
}

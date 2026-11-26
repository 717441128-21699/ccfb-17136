import { rgbaToCanvas, type RgbaImage } from '../core/image.ts';
import type { MotionEstimate, Pose } from '../core/tracker.ts';

export function presentRgba(canvas: HTMLCanvasElement, img: RgbaImage): CanvasRenderingContext2D | null {
  rgbaToCanvas(img, canvas);
  return canvas.getContext('2d');
}

export interface OverlayOptions {
  trajectories?: boolean;
  boxes?: boolean;
  highlightId?: string | null;
}

const STONE_COLORS = ['#ff4d5a', '#f2c14e', '#4da3ff', '#7ce38b'];

function stoneColor(index: number, rgb?: [number, number, number]): string {
  if (rgb) return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  return STONE_COLORS[index % STONE_COLORS.length];
}

/** Draw tracker detections + trajectories on top of the current frame. */
export function drawMotionOverlay(
  canvas: HTMLCanvasElement,
  estimate: MotionEstimate,
  frameIndex: number,
  opts: OverlayOptions = {},
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  const lineScale = Math.max(1, w / 960);
  const fontPx = Math.round(13 * lineScale);
  ctx.save();
  ctx.lineWidth = Math.max(1.4, 2 * lineScale);
  ctx.font = `700 ${fontPx}px "PingFang SC", "Microsoft YaHei", sans-serif`;

  // ---- Stone trajectories + detections ----
  estimate.stones.forEach((track, ti) => {
    const color = stoneColor(ti, track.color);
    const isDimmed = opts.highlightId != null && opts.highlightId !== `stone-${track.id}`;
    ctx.globalAlpha = isDimmed ? 0.25 : 1;

    if (opts.trajectories !== false) {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i <= frameIndex && i < track.poses.length; i++) {
        const p = track.poses[i];
        if (!p) continue;
        if (!started) { ctx.moveTo(p.x, p.y); started = true; }
        else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = color;
      ctx.globalAlpha = (isDimmed ? 0.18 : 0.85);
      ctx.lineWidth = Math.max(1.6, 2.4 * lineScale);
      ctx.setLineDash([]);
      ctx.stroke();

      // Trail dots
      for (let i = 0; i <= frameIndex && i < track.poses.length; i++) {
        const p = track.poses[i];
        if (!p) continue;
        const age = frameIndex - i;
        if (age > 14) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(1.5, (3.4 - age * 0.18) * lineScale), 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = (isDimmed ? 0.1 : Math.max(0.15, 0.85 - age * 0.05));
        ctx.fill();
      }
      ctx.globalAlpha = isDimmed ? 0.25 : 1;
    }

    const pose: Pose | undefined = track.poses[frameIndex];
    if (pose) {
      const r = pose.radius;
      if (opts.boxes !== false) {
        // Detection ring
        ctx.beginPath();
        ctx.arc(pose.x, pose.y, r * 1.18, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.setLineDash([7 * lineScale, 5 * lineScale]);
        ctx.lineWidth = Math.max(1.4, 2 * lineScale);
        ctx.stroke();
        ctx.setLineDash([]);

        // Crosshair
        ctx.beginPath();
        ctx.moveTo(pose.x - r * 1.45, pose.y);
        ctx.lineTo(pose.x - r * 0.95, pose.y);
        ctx.moveTo(pose.x + r * 0.95, pose.y);
        ctx.lineTo(pose.x + r * 1.45, pose.y);
        ctx.moveTo(pose.x, pose.y - r * 1.45);
        ctx.lineTo(pose.x, pose.y - r * 0.95);
        ctx.moveTo(pose.x, pose.y + r * 0.95);
        ctx.lineTo(pose.x, pose.y + r * 1.45);
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1.2, 1.6 * lineScale);
        ctx.stroke();
      }

      // Handle-angle indicator
      const hx = pose.x + Math.cos(pose.angle) * r * 0.9;
      const hy = pose.y + Math.sin(pose.angle) * r * 0.9;
      ctx.beginPath();
      ctx.moveTo(pose.x - Math.cos(pose.angle) * r * 0.9, pose.y - Math.sin(pose.angle) * r * 0.9);
      ctx.lineTo(hx, hy);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = Math.max(2, 3 * lineScale);
      ctx.stroke();

      drawLabel(ctx, `壶 #${track.id + 1}`, pose.x + r * 1.25, pose.y - r * 1.25 - fontPx, color, fontPx, lineScale);
    }
    ctx.globalAlpha = 1;
  });

  // ---- Brooms ----
  estimate.brooms.forEach((track, bi) => {
    const color = '#34d399';
    const isDimmed = opts.highlightId != null && opts.highlightId !== `broom-${track.id}`;
    ctx.globalAlpha = isDimmed ? 0.25 : 1;

    if (opts.trajectories !== false) {
      ctx.beginPath();
      let started = false;
      for (let i = 0; i <= frameIndex && i < track.poses.length; i++) {
        const p = track.poses[i];
        if (!p) continue;
        if (!started) { ctx.moveTo(p.x, p.y); started = true; }
        else ctx.lineTo(p.x, p.y);
      }
      ctx.strokeStyle = color;
      ctx.globalAlpha = isDimmed ? 0.15 : 0.7;
      ctx.lineWidth = Math.max(1.4, 2 * lineScale);
      ctx.setLineDash([5 * lineScale, 4 * lineScale]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = isDimmed ? 0.25 : 1;
    }

    const pose = track.poses[frameIndex];
    if (pose) {
      const cos = Math.cos(pose.angle);
      const sin = Math.sin(pose.angle);
      const tailX = pose.x - cos * pose.length;
      const tailY = pose.y - sin * pose.length;

      if (opts.boxes !== false) {
        // Oriented bounding capsule around handle + head.
        ctx.save();
        ctx.translate(pose.x - cos * pose.length * 0.5, pose.y - sin * pose.length * 0.5);
        ctx.rotate(pose.angle);
        const bw = pose.length + pose.width * 1.4;
        const bh = pose.width * 1.7;
        ctx.strokeStyle = color;
        ctx.setLineDash([7 * lineScale, 5 * lineScale]);
        ctx.lineWidth = Math.max(1.3, 1.8 * lineScale);
        ctx.strokeRect(-bw / 2, -bh / 2, bw, bh);
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Broom axis
      ctx.beginPath();
      ctx.moveTo(pose.x, pose.y);
      ctx.lineTo(tailX, tailY);
      ctx.strokeStyle = 'rgba(196,157,103,0.95)';
      ctx.lineWidth = Math.max(2.5, 4 * lineScale);
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.lineCap = 'butt';

      // Head
      ctx.save();
      ctx.translate(pose.x + cos * pose.width * 0.18, pose.y + sin * pose.width * 0.18);
      ctx.rotate(pose.angle + Math.PI / 2);
      ctx.fillStyle = 'rgba(226,59,68,0.92)';
      ctx.fillRect(-pose.width * 0.36, -pose.width * 0.17, pose.width * 0.72, pose.width * 0.34);
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = Math.max(1, 1.4 * lineScale);
      ctx.strokeRect(-pose.width * 0.36, -pose.width * 0.17, pose.width * 0.72, pose.width * 0.34);
      ctx.restore();

      drawLabel(ctx, `刷 #${bi + 1}`, pose.x + 12 * lineScale, pose.y - 12 * lineScale - fontPx, color, fontPx, lineScale);
    }
    ctx.globalAlpha = 1;
  });

  ctx.restore();
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  fontPx: number,
  scale: number,
): void {
  const padX = 7 * scale;
  const padY = 3 * scale;
  const metrics = ctx.measureText(text);
  const bw = metrics.width + padX * 2;
  const bh = fontPx + padY * 2;
  const bx = Math.max(4, Math.min(x, ctx.canvas.width - bw - 4));
  const by = Math.max(4, y);
  ctx.fillStyle = 'rgba(6,10,16,0.82)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2 * scale;
  roundRect(ctx, bx, by, bw, bh, 5 * scale);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#eef5ff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + padX, by + bh / 2 + 0.5);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

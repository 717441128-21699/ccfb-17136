import {
  createImage,
  drawCapsuleBetween,
  drawCircle,
  drawEllipse,
  drawRing,
  drawRotatedRoundRect,
  fillAll,
  hexToRgb,
  type Sprite,
} from './image';
import type { RgbaImage, ScenarioId, SceneState, StoneState, Vec2 } from './types';

export const SCENARIOS: { id: ScenarioId; name: string; description: string; duration: number }[] = [
  { id: 'head-on', name: '正面相撞', description: '两壶高速正对碰撞后同时反向', duration: 4 },
  { id: 'glancing', name: '斜线擦撞', description: '运动壶撞击静止壶，双方在碰撞点突然变线', duration: 4 },
  { id: 'line-press', name: '末段压线', description: '黄壶大幅减速，最后几厘米判断是否压过 tee line', duration: 4 },
  { id: 'sweep', name: '快速刷冰遮挡', description: '两把刷子高频横移，反复挡住壶和冰面线后露出', duration: 4 },
  { id: 'collision-sweep', name: '碰撞加刷冰', description: '碰撞瞬间刷子掠过，考验遮挡、碰撞和无重影合成', duration: 4 },
];

export interface RinkLayout {
  width: number;
  height: number;
  center: Vec2;
  sheet: { left: number; right: number; top: number; bottom: number };
  teeY: number;
  centerX: number;
  hogY1: number;
  hogY2: number;
  stoneRadius: number;
  houseRadii: number[];
}

export function layoutFor(width: number, height: number): RinkLayout {
  const scale = Math.min(width / 1920, height / 1080);
  const center = { x: width / 2, y: height * 0.52 };
  const sheetHalf = 360 * scale;
  return {
    width,
    height,
    center,
    sheet: {
      left: center.x - sheetHalf,
      right: center.x + sheetHalf,
      top: -20 * scale,
      bottom: height + 20 * scale,
    },
    teeY: center.y,
    centerX: center.x,
    hogY1: height * 0.23,
    hogY2: height * 0.82,
    stoneRadius: Math.max(14, 42 * scale),
    houseRadii: [190 * scale, 126 * scale, 64 * scale, 24 * scale],
  };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function kinkPosition(
  t: number,
  t0: number,
  p0: Vec2,
  vBefore: Vec2,
  tc: number,
  vAfter: Vec2,
): Vec2 {
  if (t <= tc) {
    const dt = t - t0;
    return { x: p0.x + vBefore.x * dt, y: p0.y + vBefore.y * dt };
  }
  const pc = {
    x: p0.x + vBefore.x * (tc - t0),
    y: p0.y + vBefore.y * (tc - t0),
  };
  const dt = t - tc;
  return { x: pc.x + vAfter.x * dt, y: pc.y + vAfter.y * dt };
}

function smoothStop(t: number, start: number, duration: number): number {
  const u = Math.max(0, Math.min(1, (t - start) / duration));
  return 1 - Math.pow(1 - u, 3);
}

export function getSceneState(id: ScenarioId, t: number, width = 1920, height = 1080): SceneState {
  const l = layoutFor(width, height);
  const s = l.stoneRadius / 42;
  const stone = (
    sid: string,
    x: number,
    y: number,
    angle: number,
    handle: 'red' | 'yellow',
  ): StoneState => ({ id: sid, x, y, angle, handle, radius: l.stoneRadius });

  if (id === 'head-on') {
    const tc = 1.75;
    const contactRed = { x: l.centerX - l.stoneRadius, y: l.teeY };
    const contactYellow = { x: l.centerX + l.stoneRadius, y: l.teeY };
    const speed = 220 * (l.stoneRadius / 42);
    const redStart = { x: contactRed.x - speed * tc, y: l.teeY };
    const yellowStart = { x: contactYellow.x + speed * tc, y: l.teeY };
    const red = kinkPosition(t, 0, redStart, { x: speed, y: 0 }, tc, { x: -speed, y: 0 });
    const yellow = kinkPosition(t, 0, yellowStart, { x: -speed, y: 0 }, tc, { x: speed, y: 0 });
    return {
      t,
      stones: [
        stone('red-head', red.x, red.y, 1.15 * t + 0.4, 'red'),
        stone('yellow-head', yellow.x, yellow.y, -0.9 * t + 1.2, 'yellow'),
      ],
      brooms: [],
    };
  }

  if (id === 'glancing') {
    const tc = 1.75;
    const red = kinkPosition(
      t,
      0,
      { x: l.centerX - 436 * s, y: l.teeY - 123 * s },
      { x: 236 * s, y: 72 * s },
      tc,
      { x: 78 * s, y: 154 * s },
    );
    const yellow = kinkPosition(
      t,
      0,
      { x: l.centerX + 50 * s, y: l.teeY + 45 * s },
      { x: 0, y: 0 },
      tc,
      { x: 172 * s, y: 96 * s },
    );
    return {
      t,
      stones: [
        stone('red-angle', red.x, red.y, 1.7 * t, 'red'),
        stone('yellow-angle', yellow.x, yellow.y, -0.45 * t + 2, 'yellow'),
      ],
      brooms: [],
    };
  }

  if (id === 'line-press') {
    const e = smoothStop(t, 0.15, 3.25);
    const x = l.centerX;
    const y = l.hogY2 + 20 * s + (l.teeY + 36 * s - (l.hogY2 + 20 * s)) * e;
    return {
      t,
      stones: [stone('yellow-line', x, y, 0.32 * t + 0.8, 'yellow')],
      brooms: [],
    };
  }

  if (id === 'sweep') {
    const u = Math.max(0, Math.min(1, t / 3.7));
    const sx = l.centerX - 430 * s + 610 * s * (1 - Math.pow(1 - u, 1.7));
    const sy = l.teeY + 120 * s - 170 * s * u;
    const brooms = [0, 1].map((i) => {
      const phase = i * Math.PI;
      return {
        id: `broom-${i}`,
        x: sx + (42 + i * 158) * s + Math.sin(t * 10.2 + phase) * 34 * s,
        y: sy - (18 + i * 34) * s + Math.cos(t * 8.6 + phase) * 16 * s,
        angle: -0.52 + Math.sin(t * 4.1 + phase) * 0.16 + i * 0.22,
        speed: 1200 * s,
        color: i === 0 ? '#e11d48' : '#2563eb',
      };
    });
    return {
      t,
      stones: [
        stone('red-sweep', sx, sy, 2.1 * t + 0.2, 'red'),
        stone('yellow-house', l.centerX + 70 * s, l.teeY - 35 * s, -0.5 * t, 'yellow'),
      ],
      brooms,
    };
  }

  // collision-sweep
  const tc = 2.05;
  const contactRed = { x: l.centerX - l.stoneRadius * 0.92, y: l.teeY + 10 * s };
  const contactYellow = { x: l.centerX + l.stoneRadius * 0.92, y: l.teeY - 10 * s };
  const redPre = { x: 218 * s, y: -6 * s };
  const yellowPre = { x: -205 * s, y: 8 * s };
  const redStart = { x: contactRed.x - redPre.x * tc, y: contactRed.y - redPre.y * tc };
  const yellowStart = { x: contactYellow.x - yellowPre.x * tc, y: contactYellow.y - yellowPre.y * tc };
  const red = kinkPosition(t, 0, redStart, redPre, tc, { x: -176 * s, y: -34 * s });
  const yellow = kinkPosition(t, 0, yellowStart, yellowPre, tc, { x: 188 * s, y: 30 * s });
  const sweep = t > 0.7 && t < 3.2;
  const brooms = sweep
    ? [
        {
          id: 'broom-clash',
          x: l.centerX + Math.sin(t * 9.0) * 96 * s,
          y: l.teeY + 12 * s + Math.cos(t * 11.0) * 34 * s,
          angle: 1.05 + Math.sin(t * 4.4) * 0.18,
          speed: 1500 * s,
          color: '#0ea5e9',
        },
      ]
    : [];
  return {
    t,
    stones: [
      stone('red-clash', red.x, red.y, 1.4 * t, 'red'),
      stone('yellow-clash', yellow.x, yellow.y, -1.2 * t + 1, 'yellow'),
    ],
    brooms,
  };
}

const backgroundCache = new Map<string, RgbaImage>();

export function renderIceBackground(width: number, height: number): RgbaImage {
  const key = `${width}x${height}`;
  const cached = backgroundCache.get(key);
  if (cached) return cached;
  const img = createImage(width, height);
  const l = layoutFor(width, height);
  const d = img.data;
  const rand = mulberry32(918273);

  for (let y = 0; y < height; y++) {
    const vy = y / height;
    for (let x = 0; x < width; x++) {
      const vx = x / width;
      const dx = (vx - 0.5) * 1.4;
      const dy = (vy - 0.52) * 1.1;
      const edge = Math.min(1, Math.hypot(dx, dy));
      const noise = (hash2(x, y, 17) - 0.5) * 7 + (rand() - 0.5) * 2;
      const i = (y * width + x) * 4;
      d[i] = 246 - edge * 18 + noise;
      d[i + 1] = 251 - edge * 14 + noise;
      d[i + 2] = 253 - edge * 8 + noise * 0.7;
      d[i + 3] = 255;
    }
  }

  // Long, almost invisible pebble/scratched-ice streaks.
  for (let k = 0; k < 180; k++) {
    const x = l.sheet.left + rand() * (l.sheet.right - l.sheet.left);
    const y = rand() * height;
    const len = 40 + rand() * 220;
    const alpha = 0.025 + rand() * 0.04;
    drawCapsuleBetween(img, x, y, x + (rand() - 0.5) * 12, y + len, 0.7 + rand() * 1.2, [120, 160, 180], alpha);
  }

  // Pale outer boards and sheet boundary.
  drawRect(img, 0, 0, l.sheet.left - 8, height, '#17324d');
  drawRect(img, l.sheet.right + 8, 0, width - l.sheet.right - 8, height, '#17324d');
  drawRect(img, l.sheet.left - 8, 0, 8, height, '#2f6690');
  drawRect(img, l.sheet.right, 0, 8, height, '#2f6690');

  // House: flat rings first.
  const [r12, r8, r4, button] = l.houseRadii;
  drawCircle(img, l.centerX, l.teeY, r12, '#dbeafe', 0.9);
  drawRing(img, l.centerX, l.teeY, r12, 10 * (l.stoneRadius / 42), '#2563eb', 0.72);
  drawCircle(img, l.centerX, l.teeY, r8, '#fee2e2', 0.82);
  drawRing(img, l.centerX, l.teeY, r8, 9 * (l.stoneRadius / 42), '#dc2626', 0.72);
  drawCircle(img, l.centerX, l.teeY, r4, '#fef9c3', 0.9);
  drawRing(img, l.centerX, l.teeY, r4, 7 * (l.stoneRadius / 42), '#ca8a04', 0.75);
  drawCircle(img, l.centerX, l.teeY, button, '#b91c1c', 0.85);

  // Straight markings are deliberately rasterized from exact constants.
  const lineW = Math.max(3, 7 * (l.stoneRadius / 42));
  drawRect(img, l.centerX - lineW / 2, 0, lineW, height, '#dc2626', 0.72);
  drawRect(img, l.sheet.left, l.teeY - lineW / 2, l.sheet.right - l.sheet.left, lineW, '#b91c1c', 0.9);
  drawRect(img, l.sheet.left, l.hogY1 - lineW, l.sheet.right - l.sheet.left, lineW * 2, '#1d4ed8', 0.82);
  drawRect(img, l.sheet.left, l.hogY2 - lineW, l.sheet.right - l.sheet.left, lineW * 2, '#1d4ed8', 0.82);

  backgroundCache.set(key, img);
  return img;
}

function drawRect(
  img: RgbaImage,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  alpha = 1,
): void {
  const [r, g, b] = hexToRgb(color);
  const x0 = Math.max(0, Math.floor(x));
  const x1 = Math.min(img.width, Math.ceil(x + w));
  const y0 = Math.max(0, Math.floor(y));
  const y1 = Math.min(img.height, Math.ceil(y + h));
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const i = (yy * img.width + xx) * 4;
      const a = alpha;
      img.data[i] = r * a + img.data[i] * (1 - a);
      img.data[i + 1] = g * a + img.data[i + 1] * (1 - a);
      img.data[i + 2] = b * a + img.data[i + 2] * (1 - a);
    }
  }
}

function drawStone(img: RgbaImage, stone: StoneState): void {
  const { x: cx, y: cy, radius: r, angle } = stone;
  drawEllipse(img, cx + r * 0.16, cy + r * 0.22, r * 1.03, r * 0.72, [15, 35, 55], 0.24);

  const x0 = Math.max(0, Math.floor(cx - r - 2));
  const x1 = Math.min(img.width - 1, Math.ceil(cx + r + 2));
  const y0 = Math.max(0, Math.floor(cy - r - 2));
  const y1 = Math.min(img.height - 1, Math.ceil(cy + r + 2));
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const seed = stone.id.split('').reduce((a, c) => a + c.charCodeAt(0) * 131, 7);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.hypot(dx, dy);
      if (dist > r + 0.75) continue;
      const edgeCov = Math.max(0, Math.min(1, r + 0.5 - dist));
      const nx = dist / r;
      // Rotate into stone-local coordinates for granite speckle.
      const lx = cos * dx + sin * dy;
      const ly = -sin * dx + cos * dy;
      const speck = hash2(Math.round(lx * 2.1), Math.round(ly * 2.1), seed);
      let base = 78 + (1 - nx) * 34;
      if (nx > 0.86) base = 38 + (1 - nx) * 120;
      if (speck > 0.985) base += 70;
      else if (speck < 0.035) base -= 34;
      const cool = nx * 10;
      const i = (y * img.width + x) * 4;
      const rr = Math.max(18, Math.min(190, base - cool * 0.25));
      const gg = Math.max(20, Math.min(195, base + 4 - cool * 0.1));
      const bb = Math.max(24, Math.min(205, base + 12 + cool));
      const oldA = edgeCov;
      img.data[i] = rr * oldA + img.data[i] * (1 - oldA);
      img.data[i + 1] = gg * oldA + img.data[i + 1] * (1 - oldA);
      img.data[i + 2] = bb * oldA + img.data[i + 2] * (1 - oldA);
      img.data[i + 3] = 255;
    }
  }

  // Stainless handle mounts.
  for (const side of [-1, 1]) {
    const mx = cx + cos * side * r * 0.34;
    const my = cy + sin * side * r * 0.34;
    drawRotatedRoundRect(img, mx, my, r * 0.22, r * 0.34, r * 0.06, angle, [170, 180, 190], 0.95);
  }
  const handleColor = stone.handle === 'red' ? '#ef4444' : '#facc15';
  const handleDark = stone.handle === 'red' ? '#991b1b' : '#a16207';
  drawRotatedRoundRect(img, cx, cy, r * 1.22, r * 0.38, r * 0.19, angle, handleDark, 1);
  drawRotatedRoundRect(img, cx, cy, r * 1.04, r * 0.27, r * 0.135, angle, handleColor, 1);
  drawRotatedRoundRect(img, cx + cos * r * 0.18, cy + sin * r * 0.18, r * 0.28, r * 0.16, r * 0.08, angle, '#f8fafc', 0.72);
}

function drawBroomAt(img: RgbaImage, b: { x: number; y: number; angle: number; color: string | [number, number, number] }, alphaScale = 1): void {
  const dirX = Math.cos(b.angle);
  const dirY = Math.sin(b.angle);
  const tailX = b.x + dirX * 185;
  const tailY = b.y + dirY * 185;
  drawCapsuleBetween(img, b.x + dirX * 18, b.y + dirY * 18, tailX, tailY, 9, '#7c4a21', 0.92 * alphaScale);
  drawCapsuleBetween(img, b.x + dirX * 30, b.y + dirY * 30, tailX - dirX * 8, tailY - dirY * 8, 3, '#d6a062', 0.55 * alphaScale);
  drawRotatedRoundRect(img, b.x, b.y, 92, 25, 9, b.angle + Math.PI / 2, '#f8fafc', 0.9 * alphaScale);
  drawRotatedRoundRect(img, b.x, b.y, 82, 17, 7, b.angle + Math.PI / 2, b.color, 0.92 * alphaScale);
  // Bristle lines.
  const perpX = -dirY;
  const perpY = dirX;
  for (let k = -3; k <= 3; k++) {
    const ox = perpX * k * 11;
    const oy = perpY * k * 11;
    drawCapsuleBetween(
      img,
      b.x + ox * 0.72 - dirX * 10,
      b.y + oy * 0.72 - dirY * 10,
      b.x + ox - dirX * 17,
      b.y + oy - dirY * 17,
      2,
      '#e2e8f0',
      0.7 * alphaScale,
    );
  }
}

export function drawBroomModel(
  img: RgbaImage,
  x: number,
  y: number,
  angle: number,
  color: string | [number, number, number],
  velocity: Vec2 = { x: 0, y: 0 },
  shutterSeconds = 1 / 180,
): void {
  const speed = Math.hypot(velocity.x, velocity.y);
  if (speed > 40) {
    const samples = 8;
    for (let k = 0; k < samples; k++) {
      const u = (k / (samples - 1) - 0.5) * shutterSeconds;
      drawBroomAt(img, { x: x + velocity.x * u, y: y + velocity.y * u, angle, color }, 0.2);
    }
  }
  drawBroomAt(img, { x, y, angle, color }, 1);
}

function drawBroomMotionBlur(img: RgbaImage, state: SceneState, index: number, shutterSeconds: number): void {
  const b = state.brooms[index];
  if (!b) return;
  const dt = 1 / 960;
  const before = getSceneState(SCENARIO_CACHE.id, state.t - dt, SCENARIO_CACHE.w, SCENARIO_CACHE.h).brooms[index];
  const after = getSceneState(SCENARIO_CACHE.id, state.t + dt, SCENARIO_CACHE.w, SCENARIO_CACHE.h).brooms[index];
  const vx = after && before ? (after.x - before.x) / (2 * dt) : 0;
  const vy = after && before ? (after.y - before.y) / (2 * dt) : 0;
  const samples = 9;
  for (let k = 0; k < samples; k++) {
    const u = (k / (samples - 1) - 0.5) * shutterSeconds;
    drawBroomAt(img, { ...b, x: b.x + vx * u, y: b.y + vy * u }, 0.22);
  }
  drawBroomAt(img, b, 1);
}

const SCENARIO_CACHE = { id: 'head-on' as ScenarioId, w: 1920, h: 1080 };

export interface RenderOptions {
  shutterSeconds?: number;
  reuseBackground?: boolean;
}

export function renderFrame(
  scenario: ScenarioId,
  time: number,
  width = 1920,
  height = 1080,
  options: RenderOptions = {},
): RgbaImage {
  SCENARIO_CACHE.id = scenario;
  SCENARIO_CACHE.w = width;
  SCENARIO_CACHE.h = height;
  const bg = renderIceBackground(width, height);
  const img = createImage(width, height);
  img.data.set(bg.data);
  const state = getSceneState(scenario, time, width, height);
  for (const stone of state.stones) drawStone(img, stone);
  const shutter = options.shutterSeconds ?? 1 / 180;
  for (let i = 0; i < state.brooms.length; i++) drawBroomMotionBlur(img, state, i, shutter);
  return img;
}

export function stoneSpriteFromFrame(frame: RgbaImage, x: number, y: number, radius: number): Sprite {
  const half = Math.ceil(radius + 3);
  const size = half * 2 + 1;
  const data = new Uint8ClampedArray(size * size * 4);
  const x0 = Math.round(x) - half;
  const y0 = Math.round(y) - half;
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
      const dx = fx + 0.5 - x;
      const dy = fy + 0.5 - y;
      const dist = Math.hypot(dx, dy);
      const alpha = Math.max(0, Math.min(1, radius + 0.5 - dist));
      data[di] = frame.data[fi];
      data[di + 1] = frame.data[fi + 1];
      data[di + 2] = frame.data[fi + 2];
      data[di + 3] = Math.round(alpha * 255);
    }
  }
  return { width: size, height: size, centerX: half, centerY: half, data };
}

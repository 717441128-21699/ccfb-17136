import { createImage, type RgbaImage } from '../image.ts';
import { fillCircle, fillEllipse, fillOrientedRect, fillRect, strokeCircle, strokeSegment } from './draw.ts';

export interface StoneState {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  va: number;
  radius: number;
  handle: [number, number, number];
  /** Temporarily hidden by a broom in this rendered frame. */
  occluded?: boolean;
}

export interface BroomState {
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
  width: number;
  length: number;
}

export interface SceneFrame {
  index: number;
  time: number;
  stones: StoneState[];
  brooms: BroomState[];
}

export type ScenarioKind = 'head-on' | 'glancing' | 'finish-line' | 'sweep';

export interface Scenario {
  kind: ScenarioKind;
  name: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  background: RgbaImage;
  frameAt(time: number, index: number): SceneFrame;
  renderFrame(index: number): RgbaImage;
}

function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export function makeSheetBackground(width: number, height: number): RgbaImage {
  const img = createImage(width, height);
  const d = img.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const nx = x / width;
      const ny = y / height;
      const shade = 244 + 7 * (1 - ny) - 5 * nx;
      const pebble = (hash2(x >> 1, y >> 1) - 0.5) * 7;
      const fine = (hash2(x, y) - 0.5) * 2.5;
      d[i] = Math.max(0, Math.min(255, shade - 7 + pebble + fine));
      d[i + 1] = Math.max(0, Math.min(255, shade + pebble + fine));
      d[i + 2] = Math.max(0, Math.min(255, shade + 5 + pebble + fine));
      d[i + 3] = 255;
    }
  }

  const s = height / 720;
  const houseX = width * 0.61;
  const houseY = height * 0.52;

  // Faint skate scratches / ice texture. Static, so a temporal plate can keep them.
  for (let k = 0; k < 130; k++) {
    const x = hash2(k, 11) * width;
    const y = hash2(k, 29) * height;
    const len = (18 + hash2(k, 47) * 90) * s;
    const a = -0.25 + hash2(k, 71) * 0.5;
    strokeSegment(img, x, y, x + Math.cos(a) * len, y + Math.sin(a) * len, Math.max(1, s), [174, 190, 201], 18);
  }

  // Houses and straight sheet markings.
  const rings: Array<[number, [number, number, number], number]> = [
    [166 * s, [52, 116, 184], 34],
    [112 * s, [246, 250, 252], 70],
    [72 * s, [202, 55, 57], 42],
    [34 * s, [250, 250, 248], 92],
  ];
  for (const [r, color, alpha] of rings) fillCircle(img, houseX, houseY, r, color, alpha);
  strokeCircle(img, houseX, houseY, 166 * s, 3 * s, [40, 83, 130], 180);
  strokeCircle(img, houseX, houseY, 112 * s, 2 * s, [150, 165, 176], 150);
  strokeCircle(img, houseX, houseY, 72 * s, 2 * s, [145, 40, 42], 170);

  // Center line and tee/hog lines remain perfectly straight raster rectangles.
  fillRect(img, 0, houseY - 2 * s, width, houseY + 2 * s, [190, 42, 48], 150);
  const teeX = houseX;
  fillRect(img, teeX - 3 * s, 0, teeX + 3 * s, height, [205, 45, 52], 210);
  const hogX = width * 0.255;
  fillRect(img, hogX - 5 * s, 0, hogX + 5 * s, height, [210, 40, 48], 220);
  fillRect(img, width * 0.86 - 3 * s, 0, width * 0.86 + 3 * s, height, [40, 91, 160], 210);

  // Border lines.
  fillRect(img, 0, 18 * s, width, 24 * s, [35, 73, 118], 180);
  fillRect(img, 0, height - 24 * s, width, height - 18 * s, [35, 73, 118], 180);
  return img;
}

function renderStone(img: RgbaImage, st: StoneState): void {
  const r = st.radius;
  fillEllipse(img, st.x + r * 0.16, st.y + r * 0.24, r * 1.08, r * 0.72, [25, 35, 44], 58);
  fillCircle(img, st.x, st.y, r * 1.04, (nx, ny) => {
    const light = Math.max(0, 0.62 - (nx * 0.72 + ny * 0.72));
    const base = 67 + light * 82;
    return [base * 0.91, base * 0.98, base * 1.08] as [number, number, number];
  });
  strokeCircle(img, st.x, st.y, r * 1.02, Math.max(2, r * 0.12), [34, 41, 48], 230);
  fillCircle(img, st.x, st.y, r * 0.72, (nx, ny) => {
    const light = Math.max(0, 0.55 - (nx * 0.8 + ny * 0.6));
    const v = 126 + light * 72;
    return [v * 0.96, v, v * 1.04] as [number, number, number];
  });
  strokeCircle(img, st.x, st.y, r * 0.7, Math.max(1.5, r * 0.06), [70, 78, 86], 190);
  // Handle mount and colored grip rotate with the stone.
  const cos = Math.cos(st.angle);
  const sin = Math.sin(st.angle);
  for (const off of [-r * 0.34, r * 0.34]) {
    const mx = st.x + cos * off;
    const my = st.y + sin * off;
    fillCircle(img, mx, my, r * 0.11, [42, 48, 54], 245);
  }
  fillOrientedRect(img, st.x, st.y - r * 0.04, r * 0.98, r * 0.24, st.angle, [30, 34, 39], 255);
  fillOrientedRect(img, st.x, st.y - r * 0.08, r * 0.82, r * 0.18, st.angle, st.handle, 255);
  fillOrientedRect(img, st.x - cos * r * 0.08, st.y - r * 0.12 - sin * r * 0.08, r * 0.55, r * 0.055, st.angle, [255, 255, 255], 70);
}

function renderBroom(img: RgbaImage, b: BroomState, alphaScale = 1): void {
  const cos = Math.cos(b.angle);
  const sin = Math.sin(b.angle);
  const headX = b.x;
  const headY = b.y;
  const endX = headX - cos * b.length;
  const endY = headY - sin * b.length;
  strokeSegment(img, headX, headY, endX, endY, Math.max(3, b.width * 0.16), [91, 61, 36], Math.round(235 * alphaScale));
  strokeSegment(img, headX, headY - 1, endX, endY - 1, Math.max(1.5, b.width * 0.05), [196, 157, 103], Math.round(180 * alphaScale));
  fillOrientedRect(img, headX + cos * b.width * 0.18, headY + sin * b.width * 0.18, b.width * 0.72, b.width * 0.34, b.angle + Math.PI / 2, [196, 43, 49], Math.round(245 * alphaScale));
  fillOrientedRect(img, headX - cos * b.width * 0.22, headY - sin * b.width * 0.22, b.width * 0.78, b.width * 0.22, b.angle + Math.PI / 2, [232, 226, 205], Math.round(220 * alphaScale));
}

function renderSceneFrame(scenario: Scenario, frame: SceneFrame): RgbaImage {
  const img = { width: scenario.width, height: scenario.height, data: scenario.background.data.slice() };
  // Stones first; brooms are swept in front and may occlude them.
  for (const st of frame.stones) if (!st.occluded) renderStone(img, st);
  for (const b of frame.brooms) {
    // Directional shutter blur: several low-opacity samples along instantaneous motion.
    const speed = Math.hypot(b.vx, b.vy);
    const samples = Math.min(5, Math.max(1, Math.round(speed / (scenario.width * 0.026))));
    for (let k = samples; k >= 1; k--) {
      const lag = (k / scenario.fps) * 0.42;
      const ghost: BroomState = { ...b, x: b.x - b.vx * lag, y: b.y - b.vy * lag };
      renderBroom(img, ghost, 0.08 + 0.05 * (samples - k));
    }
    renderBroom(img, b, 1);
  }
  return img;
}

interface Body {
  x: number; y: number; vx: number; vy: number; r: number; angle: number; va: number;
}

function elasticCollision(a: Body, b: Body): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = dx / dist;
  const ny = dy / dist;
  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const velN = rvx * nx + rvy * ny;
  if (velN >= 0) return;
  // Equal masses, restitution 0.96.
  const impulse = -(1 + 0.96) * velN / 2;
  a.vx -= impulse * nx;
  a.vy -= impulse * ny;
  b.vx += impulse * nx;
  b.vy += impulse * ny;
  const overlap = a.r + b.r - dist + 0.1;
  a.x -= nx * overlap * 0.5;
  a.y -= ny * overlap * 0.5;
  b.x += nx * overlap * 0.5;
  b.y += ny * overlap * 0.5;
}

function makeScenario(kind: ScenarioKind, width: number, height: number, duration: number): Scenario {
  const fps = 120;
  const s = height / 720;
  const background = makeSheetBackground(width, height);
  const r = 25 * s;
  const houseX = width * 0.61;
  const houseY = height * 0.52;

  const initialBodies = (): Body[] => {
    if (kind === 'head-on') {
      return [
        { x: width * 0.20, y: houseY, vx: 500 * s, vy: 0, r, angle: -0.4, va: 1.7 },
        { x: width * 0.43, y: houseY + 1 * s, vx: 0, vy: 0, r, angle: 0.8, va: 0.25 },
      ];
    }
    if (kind === 'glancing') {
      return [
        { x: width * 0.18, y: houseY - 70 * s, vx: 470 * s, vy: 120 * s, r, angle: 0.2, va: 2.4 },
        { x: width * 0.45, y: houseY + 18 * s, vx: -20 * s, vy: 0, r, angle: 1.1, va: -0.4 },
      ];
    }
    if (kind === 'finish-line') {
      const stopTime = 255 / 58;
      const stopDistance = (255 * stopTime - 0.5 * 58 * stopTime * stopTime) * s;
      return [
        { x: houseX - stopDistance + r - 4 * s, y: houseY, vx: 255 * s, vy: 0, r, angle: 0.1, va: 1.1 },
      ];
    }
    return [
      { x: houseX - 210 * s, y: houseY + 8 * s, vx: 210 * s, vy: -8 * s, r, angle: 0.4, va: 1.5 },
    ];
  };

  let bodies = initialBodies();
  let lastStep = -1;

  function stepTo(time: number, index: number): void {
    // Scenarios are queried sequentially by the renderer/tests. Re-simulate when
    // the requested frame goes backwards or jumps.
    if (index <= lastStep || lastStep < 0 && index !== 0) {
      bodies = initialBodies();
      lastStep = -1;
    }
    const dt = 1 / fps;
    while (lastStep < index) {
      for (const b of bodies) {
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.angle += b.va * dt;
        if (kind === 'finish-line') {
          // Constant friction, clipped at zero: the last centimetres are very slow.
          const speed = Math.hypot(b.vx, b.vy);
          const decel = 58 * s;
          if (speed > 0) {
            const ns = Math.max(0, speed - decel * dt);
            b.vx *= ns / speed;
            b.vy *= ns / speed;
          }
        } else {
          b.vx *= 1 - 0.018 * dt;
          b.vy *= 1 - 0.018 * dt;
        }
      }
      for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
          const a = bodies[i];
          const b = bodies[j];
          if (Math.hypot(b.x - a.x, b.y - a.y) < a.r + b.r) elasticCollision(a, b);
        }
      }
      lastStep++;
    }
    void time;
  }

  const scenario: Scenario = {
    kind,
    name: kind,
    width,
    height,
    fps,
    duration,
    background,
    frameAt(time: number, index: number): SceneFrame {
      stepTo(time, index);
      const t = index / fps;
      const stones: StoneState[] = bodies.map((b, id) => ({
        id,
        x: b.x,
        y: b.y,
        vx: b.vx,
        vy: b.vy,
        angle: b.angle,
        va: b.va,
        radius: r,
        handle: id === 0 ? [206, 42, 48] : [232, 184, 45],
      }));

      let brooms: BroomState[] = [];
      if (kind === 'sweep') {
        const st = stones[0];
        const phase = t * 10.0;
        const sweep = Math.sin(phase);
        const bx = st.x + r * (0.9 + 0.14 * Math.cos(t * 5));
        const by = st.y + sweep * r * 1.0;
        const prevSweep = Math.sin((t - 1 / fps) * 10.0);
        const pvx = (sweep - prevSweep) * r * 1.0 * fps * 0.15;
        const pvy = (sweep - prevSweep) * r * 1.0 * fps;
        brooms = [{
          x: bx,
          y: by,
          angle: -0.28 + 0.16 * Math.cos(phase * 0.7),
          vx: pvx,
          vy: pvy,
          width: 54 * s,
          length: 195 * s,
        }];
        // The broom is composited after the stone, so its head naturally
        // occludes the contact patch without hiding the whole stone.
        void 0;
      }
      // Collision benchmark clips stay focused on the two stones. A separate
      // sweep scenario exercises the fast broom/occlusion path.
      void 0;
      return { index, time: t, stones, brooms };
    },
    renderFrame(index: number): RgbaImage {
      return renderSceneFrame(scenario, scenario.frameAt(index / fps, index));
    },
  };

  return scenario;
}

export function createScenario(kind: ScenarioKind, width = 1280, height = 720, duration = 1.2): Scenario {
  return makeScenario(kind, width, height, duration);
}

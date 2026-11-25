export type Vec2 = { x: number; y: number };

export type ScenarioId =
  | 'head-on'
  | 'glancing'
  | 'line-press'
  | 'sweep'
  | 'collision-sweep';

export interface StoneState {
  id: string;
  x: number;
  y: number;
  angle: number;
  handle: 'red' | 'yellow';
  radius: number;
  vx?: number;
  vy?: number;
}

export interface BroomState {
  id: string;
  x: number;
  y: number;
  angle: number;
  speed: number;
  color: string;
}

export interface SceneState {
  t: number;
  stones: StoneState[];
  brooms: BroomState[];
}

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface Frame {
  index: number;
  time: number;
  image: RgbaImage;
}

export interface SlowSegment {
  startSeconds: number;
  endSeconds: number;
  factor: 4 | 8 | 12 | 24;
}

export interface PsnrResult {
  psnr: number;
  mse: number;
  maxChannelMse: number;
  pixels: number;
}

export interface LineMetric {
  score: number;
  maxDeviationPx: number;
  gapPixels: number;
  totalLinePixels: number;
  brokenSegments: number;
}

export interface BenchmarkFrameResult {
  scenario: ScenarioId;
  phase: number;
  time: number;
  psnr: number;
  line: LineMetric;
  ghostScore: number;
}

export interface BenchmarkSummary {
  scenario: ScenarioId;
  frames: number;
  minPsnr: number;
  meanPsnr: number;
  lineScore: number;
  maxLineDeviationPx: number;
  brokenSegments: number;
  meanGhostScore: number;
  maxGhostScore: number;
  elapsedMs: number;
  width: number;
  height: number;
}

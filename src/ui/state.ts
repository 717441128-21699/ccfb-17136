import type { RgbaImage } from '../core/image.ts';
import type { MotionEstimate } from '../core/tracker.ts';
import type { PreparedInterpolation } from '../core/pipeline.ts';
import type { ScenarioKind } from '../core/render/curlingScene.ts';

export type TabId = 'import' | 'motion' | 'preview' | 'export';
export type SlowFactor = 2 | 4 | 8;

export interface ClipInfo {
  id: string;
  name: string;
  sourceKind: 'synthetic' | 'video-file';
  scenarioKind?: ScenarioKind;
  width: number;
  height: number;
  /** Frame rate of the working frames array (30 fps for decimated synthetic). */
  sourceFps: number;
  /** Uniformly spaced working frames used by tracker/interpolator. */
  frames: RgbaImage[];
  /** Held-out full-rate synthetic truth (120 fps), retained for PSNR. */
  truth?: RgbaImage[];
  /** truth[index] corresponds to every truthStep-th frame being a source frame. */
  truthStep?: number;
  durationSec: number;
  frameCountLabel: number;
  /** User-video preview element (kept alive across tab switches). */
  video?: HTMLVideoElement;
  videoUrl?: string;
  file?: File;
  fileSize?: number;
  fpsAssumed?: boolean;
  /** Extraction state for user files. */
  extracted?: boolean;
}

export interface WebGpuStatus {
  mode: 'checking' | 'webgpu-module' | 'webgpu-adapter' | 'cpu';
  badgeClass: 'engine-checking' | 'engine-ok' | 'engine-cpu';
  badgeText: string;
  detail: string;
}

export interface ExportSettings {
  name: string;
  resolution: 'source' | '960x540' | '1280x720' | '1920x1080';
  fps: 24 | 30 | 60;
  factor: SlowFactor;
}

export interface ProjectState {
  tab: TabId;
  clip: ClipInfo | null;
  estimate: MotionEstimate | null;
  prepared: PreparedInterpolation | null;
  motionTimingMs: number | null;
  webgpu: WebGpuStatus;
  previewFactor: SlowFactor;
  previewView: 'compare' | 'interp' | 'original';
  overlayTrajectories: boolean;
  overlayBoxes: boolean;
  exportSettings: ExportSettings;
  listeners: Set<() => void>;
  subscribe(fn: () => void): () => void;
  emit(): void;
  setClip(clip: ClipInfo): void;
}

export function createProjectState(): ProjectState {
  const listeners = new Set<() => void>();
  const state: ProjectState = {
    tab: 'import',
    clip: null,
    estimate: null,
    prepared: null,
    motionTimingMs: null,
    webgpu: {
      mode: 'checking',
      badgeClass: 'engine-checking',
      badgeText: '引擎检测中…',
      detail: '正在检测 WebGPU 加速模块。',
    },
    previewFactor: 4,
    previewView: 'compare',
    overlayTrajectories: true,
    overlayBoxes: true,
    exportSettings: {
      name: 'curling-slowmo',
      resolution: 'source',
      fps: 30,
      factor: 4,
    },
    listeners,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit() {
      for (const fn of [...listeners]) {
        try { fn(); } catch (err) { console.error('state listener error', err); }
      }
    },
    setClip(clip) {
      // Replacing the clip invalidates all derived analysis.
      if (state.clip?.videoUrl && state.clip.videoUrl !== clip.videoUrl) {
        URL.revokeObjectURL(state.clip.videoUrl);
      }
      state.clip = clip;
      state.estimate = null;
      state.prepared = null;
      state.motionTimingMs = null;
      state.emit();
    },
  };
  return state;
}

/**
 * Map an output-sequence frame index to a source interval + phase u.
 * Output sequence has (sourceCount - 1) * factor + 1 frames.
 */
export function mapOutputIndex(sourceCount: number, factor: number, outIndex: number): {
  interval: number;
  u: number;
  local: number;
  total: number;
} {
  const intervals = Math.max(1, sourceCount - 1);
  const total = intervals * factor + 1;
  const idx = Math.max(0, Math.min(total - 1, outIndex));
  let interval = Math.floor(idx / factor);
  let local = idx - interval * factor;
  if (interval >= intervals) {
    interval = intervals - 1;
    local = factor;
  }
  const u = local / factor;
  return { interval, u, local, total };
}

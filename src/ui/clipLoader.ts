import { createScenario, type ScenarioKind } from '../core/render/curlingScene.ts';
import { decimateFour } from '../core/pipeline.ts';
import type { RgbaImage } from '../core/image.ts';
import { yieldToUi } from './dom.ts';
import type { ClipInfo } from './state.ts';
import { decodeVideoFileWebCodecs } from '../codecs/webcodecsDecoder.ts';

/**
 * 97 frames at 120 fps => indices 0..96; index 96 is divisible by 4, so
 * decimateFour yields exactly 25 aligned 30 fps source frames (0,4,...,96).
 */
export const SYNTH_FRAME_COUNT = 97;
export const SYNTH_TRUTH_STEP = 4;

export const SCENARIO_INFO: Record<ScenarioKind, { name: string; en: string; desc: string; color: string }> = {
  'head-on': {
    name: '正面对撞',
    en: 'Head-on Collision',
    desc: '两只冰壶沿同一直线高速对撞，考验碰撞瞬间的物体保持。',
    color: '#e23b44',
  },
  glancing: {
    name: '斜向擦碰',
    en: 'Glancing Blow',
    desc: '带横向速度的弧线擦碰，运动矢量与旋转同时变化。',
    color: '#39c2f0',
  },
  'finish-line': {
    name: '大本营压线',
    en: 'Finish Line',
    desc: '单壶持续减速滑向营垒中心，考察慢速段与终点线细节。',
    color: '#e8b82d',
  },
  sweep: {
    name: '刷冰遮挡',
    en: 'Sweeping Broom',
    desc: '快速往复的冰刷在壶前横扫，包含运动模糊与局部遮挡。',
    color: '#34d399',
  },
};

export interface LoadProgress {
  (done: number, total: number, label: string): void;
}

/** Generate a built-in synthetic clip: retained 120 fps truth + 30 fps sources. */
export async function loadSyntheticClip(
  kind: ScenarioKind,
  width: number,
  height: number,
  onProgress?: LoadProgress,
): Promise<ClipInfo> {
  const duration = SYNTH_FRAME_COUNT / 120;
  const scenario = createScenario(kind, width, height, duration);
  const truth: RgbaImage[] = [];
  const chunk = 4;
  for (let i = 0; i < SYNTH_FRAME_COUNT; i++) {
    truth.push(scenario.renderFrame(i));
    if (i % chunk === chunk - 1 || i === SYNTH_FRAME_COUNT - 1) {
      onProgress?.(i + 1, SYNTH_FRAME_COUNT, `渲染 120fps 真值帧 ${i + 1}/${SYNTH_FRAME_COUNT}`);
      await yieldToUi();
    }
  }
  const frames = decimateFour(truth);
  onProgress?.(SYNTH_FRAME_COUNT, SYNTH_FRAME_COUNT, '完成帧生成');
  return {
    id: `synth-${kind}-${width}x${height}-${Date.now()}`,
    name: `${SCENARIO_INFO[kind].name} · ${width}×${height}`,
    sourceKind: 'synthetic',
    scenarioKind: kind,
    width,
    height,
    sourceFps: 30,
    frames,
    truth,
    truthStep: SYNTH_TRUTH_STEP,
    durationSec: duration,
    frameCountLabel: SYNTH_FRAME_COUNT,
    extracted: true,
  };
}

function waitForEvent(target: EventTarget, event: string, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      target.removeEventListener(event, onDone);
      reject(new Error(`等待视频事件 ${event} 超时`));
    }, timeoutMs);
    const onDone = () => {
      window.clearTimeout(timer);
      resolve();
    };
    target.addEventListener(event, onDone, { once: true });
    if (event === 'seeked') target.addEventListener('error', () => { /* error handled by caller */ }, { once: true });
  });
}

/** Seek the video to a time and rasterize the current frame to RGBA. */
async function seekAndRasterize(
  video: HTMLVideoElement,
  timeSec: number,
  canvas: HTMLCanvasElement,
  targetWidth: number,
): Promise<RgbaImage> {
  if (Math.abs(video.currentTime - timeSec) > 1e-4) {
    const seeked = waitForEvent(video, 'seeked', 20000);
    video.currentTime = timeSec;
    await seeked;
  }
  // Some decoders need an extra frame after seeked before the pixels are valid.
  await new Promise(r => requestAnimationFrame(() => r(null)));
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.min(1, targetWidth / vw);
  canvas.width = Math.max(2, Math.round(vw * scale) - (Math.round(vw * scale) % 2));
  canvas.height = Math.max(2, Math.round(vh * scale) - (Math.round(vh * scale) % 2));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data: new Uint8Array(imageData.data) };
}

/**
 * Extract uniformly spaced working frames from a user video via seeking +
 * canvas rasterization. Entire clip is sampled, capped at maxFrames.
 */
export async function extractUserVideoFrames(
  clip: ClipInfo,
  video: HTMLVideoElement,
  opts: { maxFrames?: number; targetWidth?: number; onProgress?: LoadProgress } = {},
): Promise<RgbaImage[]> {
  const maxFrames = opts.maxFrames ?? 41;
  const targetWidth = opts.targetWidth ?? 960;
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : clip.durationSec;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取视频时长，不能抽帧');

  const count = Math.max(6, Math.min(maxFrames, Math.round(duration * 30)));

  // Preferred path: MP4 demux + WebCodecs VideoDecoder. Unsupported containers
  // or codec-description failures fall back to HTMLVideoElement seek/canvas.
  if (clip.file && typeof VideoDecoder !== 'undefined') {
    try {
      const decoded = await decodeVideoFileWebCodecs(clip.file, {
        maxFrames: count,
        targetWidth,
        onProgress: (decodedFrames, retained) => {
          opts.onProgress?.(retained, count, `WebCodecs 解码 ${decodedFrames} 帧 / 保留 ${retained}`);
        },
      });
      if (decoded.frames.length >= 4) {
        clip.sourceFps = decoded.frames.length / Math.max(0.001, decoded.durationSeconds || duration);
        clip.width = decoded.width;
        clip.height = decoded.height;
        clip.frames = decoded.frames;
        clip.extracted = true;
        return decoded.frames;
      }
    } catch (err) {
      console.info('WebCodecs import failed; using video element fallback.', err);
    }
  }

  const times: number[] = [];
  // Avoid t=0 black frames and the very last un-decodable tail.
  const start = Math.min(0.05, duration * 0.02);
  const end = Math.max(start + 0.01, duration - 0.05);
  for (let i = 0; i < count; i++) {
    times.push(count === 1 ? start : start + ((end - start) * i) / (count - 1));
  }

  const canvas = document.createElement('canvas');
  const wasPaused = video.paused;
  video.pause();
  const frames: RgbaImage[] = [];
  try {
    for (let i = 0; i < times.length; i++) {
      const frame = await seekAndRasterize(video, times[i], canvas, targetWidth);
      frames.push(frame);
      opts.onProgress?.(i + 1, times.length, `抽取视频帧 ${i + 1}/${times.length}`);
      if (i % 2 === 1) await yieldToUi();
    }
  } finally {
    if (wasPaused) video.pause();
  }

  // Uniform effective rate for the sampled timeline.
  clip.sourceFps = count / duration;
  clip.width = frames[0]?.width ?? clip.width;
  clip.height = frames[0]?.height ?? clip.height;
  clip.frames = frames;
  clip.extracted = true;
  return frames;
}

/** Make sure a clip has RGBA working frames, extracting user videos lazily. */
export async function ensureClipFrames(
  clip: ClipInfo,
  onProgress?: LoadProgress,
): Promise<RgbaImage[]> {
  if (clip.extracted && clip.frames.length > 0) return clip.frames;
  if (clip.sourceKind === 'synthetic') return clip.frames;
  if (!clip.video) throw new Error('视频元素已失效，请重新导入文件');
  return extractUserVideoFrames(clip, clip.video, { onProgress });
}

/** Build a ClipInfo shell from a selected File after metadata loads. */
export function readVideoFile(file: File): Promise<{ clip: ClipInfo; video: HTMLVideoElement }> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('video/')) {
      reject(new Error('请选择视频文件（video/*）'));
      return;
    }
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = url;
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onOk);
      video.removeEventListener('error', onErr);
    };
    const onOk = () => {
      cleanup();
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const vw = video.videoWidth || 1280;
      const vh = video.videoHeight || 720;
      const estimatedFrames = Math.max(1, Math.round(duration * 30));
      const clip: ClipInfo = {
        id: `file-${file.name}-${file.size}-${Date.now()}`,
        name: file.name,
        sourceKind: 'video-file',
        width: vw,
        height: vh,
        sourceFps: 30,
        frames: [],
        durationSec: duration,
        frameCountLabel: estimatedFrames,
        video,
        videoUrl: url,
        file,
        fileSize: file.size,
        fpsAssumed: true,
        extracted: false,
      };
      resolve({ clip, video });
    };
    const onErr = () => {
      cleanup();
      URL.revokeObjectURL(url);
      reject(new Error('浏览器无法解码该视频，请尝试 H.264/AAC 编码的 MP4 或 WebM 文件。'));
    };
    video.addEventListener('loadedmetadata', onOk);
    video.addEventListener('error', onErr);
  });
}

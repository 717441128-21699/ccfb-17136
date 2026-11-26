/**
 * Real MP4 export via WebCodecs VideoEncoder + mp4-muxer.
 * If WebCodecs is missing the caller shows a clear message; this module never
 * fakes a result. Frame rendering is injected so UI/pipeline stay decoupled.
 */
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

export interface ExtendedEncoderConfig extends VideoEncoderConfig {
  avc?: { format: 'annexb' | 'avc' };
}

export interface ExportProgress {
  (done: number, total: number, phase: string): void;
}

export interface ExportHandle {
  cancelled: boolean;
}

export function isWebCodecsAvailable(): boolean {
  return typeof VideoEncoder !== 'undefined'
    && typeof VideoFrame !== 'undefined'
    && typeof VideoEncoder?.isConfigSupported === 'function';
}

const CODEC_CANDIDATES = [
  'avc1.640028', // High@4.0 — good quality
  'avc1.4D4028', // Main@4.0
  'avc1.42E01F', // Baseline 3.1
  'avc1.42001F',
];

/** Pick the first AVC config the platform's encoder reports as supported. */
export async function pickEncoderConfig(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<ExtendedEncoderConfig | null> {
  if (!isWebCodecsAvailable()) return null;
  for (const codec of CODEC_CANDIDATES) {
    const base: ExtendedEncoderConfig = {
      codec,
      width,
      height,
      bitrate,
      framerate: fps,
      avc: { format: 'avc' },
    };
    try {
      const support = await VideoEncoder.isConfigSupported(base);
      if (support?.supported) {
        return (support.config as ExtendedEncoderConfig | undefined) ?? base;
      }
    } catch {
      // Try next candidate.
    }
  }
  // Last resort: let configure() throw a real error if truly unsupported.
  return {
    codec: CODEC_CANDIDATES[0],
    width,
    height,
    bitrate,
    framerate: fps,
    avc: { format: 'avc' },
  };
}

export interface RenderFrameFn {
  (index: number, canvas: HTMLCanvasElement): void | Promise<void>;
}

export class ExportCancelledError extends Error {
  constructor() {
    super('导出已取消');
    this.name = 'ExportCancelledError';
  }
}

const yieldFrame = (): Promise<void> => new Promise(r => setTimeout(r, 0));

/**
 * Encode `frameCount` frames rendered by `renderFrame` into a fast-start MP4.
 * Timestamps are spaced by 1e6/outputFps microseconds. Reports real encoder
 * progress and surfaces real encoder/muxer errors.
 */
export async function exportFramesToMp4(options: {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  bitrate?: number;
  renderFrame: RenderFrameFn;
  onProgress?: ExportProgress;
  handle?: ExportHandle;
}): Promise<{ blob: Blob; bytes: number; mimeType: string }> {
  const { width, height, fps, frameCount, renderFrame, onProgress, handle } = options;
  if (!isWebCodecsAvailable()) {
    throw new Error('当前浏览器不支持 WebCodecs VideoEncoder，无法在本地导出 MP4。请使用最新版 Chrome / Edge。');
  }
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new Error(`H.264 编码要求宽高均为偶数，当前为 ${width}×${height}。`);
  }

  const bitrate = options.bitrate ?? Math.round(width * height * fps * 0.12);
  const config = await pickEncoderConfig(width, height, fps, bitrate);
  if (!config) throw new Error('未找到受支持的 H.264 编码器配置。');

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width, height, frameRate: fps },
    fastStart: 'in-memory',
  });

  let encoderError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      try {
        muxer.addVideoChunk(chunk, meta);
      } catch (err) {
        encoderError = err instanceof Error ? err : new Error(String(err));
      }
    },
    error: (err) => {
      encoderError = err instanceof Error ? err : new Error(String(err));
    },
  });

  try {
    encoder.configure(config);
  } catch (err) {
    encoder.close();
    throw new Error(`VideoEncoder 配置失败：${err instanceof Error ? err.message : String(err)}`);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const frameDurationUs = Math.round(1_000_000 / fps);
  const keyframeInterval = Math.max(1, Math.round(fps * 2));

  try {
    for (let i = 0; i < frameCount; i++) {
      if (handle?.cancelled) throw new ExportCancelledError();
      if (encoderError) throw encoderError;

      onProgress?.(i, frameCount, i === 0 ? '渲染并编码帧…' : `编码帧 ${i + 1}/${frameCount}`);
      await renderFrame(i, canvas);
      if (encoderError) throw encoderError;

      const frame = new VideoFrame(canvas, {
        timestamp: i * frameDurationUs,
        duration: frameDurationUs,
      });
      encoder.encode(frame, { keyFrame: i % keyframeInterval === 0 });
      frame.close();

      // Apply real backpressure so the encoder queue cannot grow unbounded.
      if (encoder.encodeQueueSize >= 6) {
        onProgress?.(i, frameCount, '等待硬件编码器排空队列…');
        await encoder.flush();
        if (encoderError) throw encoderError;
      }
      // Keep the UI responsive between heavy frame renders.
      if (i % 2 === 0) await yieldFrame();
    }

    onProgress?.(frameCount, frameCount, '刷新编码器并写入 MP4 索引…');
    await encoder.flush();
    if (encoderError) throw encoderError;

    muxer.finalize();
  } catch (err) {
    try { encoder.reset(); } catch { /* already closed */ }
    try { encoder.close(); } catch { /* noop */ }
    throw err;
  }
  encoder.close();

  if (handle?.cancelled) throw new ExportCancelledError();
  const buffer = target.buffer;
  const blob = new Blob([buffer], { type: 'video/mp4' });
  return { blob, bytes: buffer.byteLength, mimeType: 'video/mp4' };
}

/** Trigger a real browser download for a finished blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.mp4') ? filename : `${filename}.mp4`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

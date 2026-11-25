import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import type { RgbaImage } from '../core/types';

export interface ExportProgress {
  encodedFrames: number;
  totalFrames: number;
  phase: 'encode' | 'finalize';
}

export interface ExportOptions {
  width: number;
  height: number;
  frameRate?: number;
  bitrate?: number;
  onProgress?: (p: ExportProgress) => void;
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function exportRgbaSequenceToMp4(
  frames: AsyncIterable<RgbaImage> | Iterable<RgbaImage>,
  totalFrames: number,
  options: ExportOptions,
): Promise<Blob> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    throw new Error('当前浏览器不支持 WebCodecs VideoEncoder，请使用最新版 Chrome/Edge。');
  }
  const frameRate = options.frameRate ?? 30;
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: 'avc',
      width: options.width,
      height: options.height,
      frameRate,
    },
    fastStart: 'in-memory',
  } as ConstructorParameters<typeof Muxer>[0]);

  const encoder = new VideoEncoder({
    output: (chunk: any, meta: any) => muxer.addVideoChunk(chunk, meta),
    error: (err) => {
      throw err;
    },
  });
  encoder.configure({
    codec: 'avc1.64002a',
    width: options.width,
    height: options.height,
    bitrate: options.bitrate ?? 14_000_000,
    framerate: frameRate,
    hardwareAcceleration: 'prefer-hardware',
    avc: { format: 'avc' },
  } as VideoEncoderConfig);

  let index = 0;
  for await (const image of frames) {
    if (image.width !== options.width || image.height !== options.height) {
      throw new Error(`导出帧尺寸 ${image.width}x${image.height} 与配置不一致`);
    }
    const frame = new VideoFrame(new Uint8ClampedArray(image.data), {
      format: 'RGBA',
      codedWidth: image.width,
      codedHeight: image.height,
      timestamp: Math.round((index * 1_000_000) / frameRate),
      duration: Math.round(1_000_000 / frameRate),
    });
    encoder.encode(frame, { keyFrame: index % (frameRate * 2) === 0 });
    frame.close();
    index++;
    options.onProgress?.({ encodedFrames: index, totalFrames, phase: 'encode' });
    if (encoder.encodeQueueSize > 10) {
      await new Promise<void>((resolve) => {
        encoder.ondequeue = () => resolve();
      });
    }
    if (index % 8 === 0) await yieldToUi();
  }
  await encoder.flush();
  encoder.close();
  muxer.finalize();
  options.onProgress?.({ encodedFrames: index, totalFrames, phase: 'finalize' });
  return new Blob([target.buffer], { type: 'video/mp4' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

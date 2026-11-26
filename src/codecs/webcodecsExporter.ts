import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type { RgbaImage } from '../core/image.ts';

export interface ExportOptions {
  fileName: string;
  width: number;
  height: number;
  frameRate: number;
  bitrate?: number;
  codec?: string;
  onProgress?: (encoded: number, total: number) => void;
  signal?: { cancelled: boolean };
}

export interface ExportResult {
  blob: Blob;
  fileName: string;
  bytes: number;
}

/**
 * Encodes RGBA frames with WebCodecs VideoEncoder and muxes H.264 into MP4.
 * The caller decides retiming; slow motion is represented by more frames at the
 * chosen output frame rate, hence a longer presentation duration.
 */
export async function exportRgbaToMp4(
  frames: AsyncIterable<RgbaImage> | Iterable<RgbaImage>,
  totalFrames: number,
  options: ExportOptions,
): Promise<ExportResult> {
  if (typeof VideoEncoder === 'undefined') throw new Error('This browser does not support WebCodecs VideoEncoder.');
  const codec = options.codec ?? 'avc1.640028';
  const bitrate = options.bitrate ?? Math.round(options.width * options.height * options.frameRate * 0.12);

  const support = await VideoEncoder.isConfigSupported({
    codec,
    width: options.width,
    height: options.height,
    bitrate,
    framerate: options.frameRate,
    avc: { format: 'avc' },
  });
  if (!support.supported && codec !== 'avc1.42001f') {
    return exportRgbaToMp4(frames, totalFrames, { ...options, codec: 'avc1.42001f' });
  }

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: options.width, height: options.height },
    fastStart: 'in-memory',
  });

  let encoderError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: err => { encoderError = err; },
  });
  encoder.configure({
    codec,
    width: options.width,
    height: options.height,
    bitrate,
    framerate: options.frameRate,
    avc: { format: 'avc' },
  });

  const frameDuration = Math.round(1_000_000 / options.frameRate);
  let index = 0;
  for await (const image of frames) {
    if (options.signal?.cancelled) throw new DOMException('Export cancelled', 'AbortError');
    if (encoderError) throw encoderError;
    while (encoder.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 4));

    const data = new Uint8Array(image.data.byteLength);
    data.set(image.data);
    const videoFrame = new VideoFrame(data, {
      format: 'RGBA',
      codedWidth: image.width,
      codedHeight: image.height,
      timestamp: index * frameDuration,
      duration: frameDuration,
    });
    encoder.encode(videoFrame, { keyFrame: index % (options.frameRate * 2) === 0 });
    videoFrame.close();
    index++;
    options.onProgress?.(index, totalFrames);
  }
  await encoder.flush();
  if (encoderError) throw encoderError;
  muxer.finalize();

  const buffer = target.buffer;
  return {
    blob: new Blob([buffer], { type: 'video/mp4' }),
    fileName: options.fileName.endsWith('.mp4') ? options.fileName : `${options.fileName}.mp4`,
    bytes: buffer.byteLength,
  };
}

export function downloadExport(result: ExportResult): void {
  const url = URL.createObjectURL(result.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = result.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

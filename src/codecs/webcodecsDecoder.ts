import MP4BoxModule, { type MP4Track } from 'mp4box';
import { createImage, type RgbaImage } from '../core/image.ts';

type MP4FileShape = ReturnType<typeof MP4BoxModule.createFile>;

export interface DecodedVideo {
  width: number;
  height: number;
  durationSeconds: number;
  codec: string;
  frames: RgbaImage[];
}

export interface DecodeOptions {
  /** Uniformly retain at most this many frames to keep 1080p clips memory-safe. */
  maxFrames?: number;
  /** Downscale retained frames so their width is at most this value. */
  targetWidth?: number;
  onProgress?: (decoded: number, retained: number) => void;
}

function codecDescription(mp4: MP4FileShape, track: MP4Track): BufferSource | undefined {
  const moov = (mp4 as unknown as { moov?: { traks?: Array<Record<string, unknown>> } }).moov;
  const trak = moov?.traks?.find(candidate => {
    const tkhd = candidate.tkhd as { track_id?: number } | undefined;
    return tkhd?.track_id === track.id;
  }) ?? moov?.traks?.[0];
  const anyTrack = trak as unknown as {
    mdia?: { minf?: { stbl?: { stsd?: { entries?: Array<Record<string, { write?: (stream: unknown) => void }>> } } } };
  } | undefined;
  const entry = anyTrack?.mdia?.minf?.stbl?.stsd?.entries?.[0];
  const configBox = entry?.avcC ?? entry?.hvcC ?? entry?.vpcC ?? entry?.av1C;
  if (!configBox?.write) return undefined;
  const DataStream = (MP4BoxModule as unknown as { DataStream?: new (buffer?: ArrayBuffer, offset?: number, endian?: boolean) => { buffer: ArrayBuffer } }).DataStream;
  if (!DataStream) return undefined;
  const stream = new DataStream(undefined, 0, false);
  configBox.write(stream);
  // First 8 bytes are box size + four-character code; decoder config starts after.
  return new Uint8Array(stream.buffer, 8);
}

function rasterizeVideoFrame(frame: VideoFrame, targetWidth?: number): RgbaImage {
  const sourceWidth = frame.codedWidth;
  const sourceHeight = frame.codedHeight;
  const scale = targetWidth && targetWidth > 0 ? Math.min(1, targetWidth / sourceWidth) : 1;
  const width = Math.max(2, Math.round(sourceWidth * scale) - (Math.round(sourceWidth * scale) % 2));
  const height = Math.max(2, Math.round(sourceHeight * scale) - (Math.round(sourceHeight * scale) % 2));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(frame, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  const image = createImage(width, height);
  image.data.set(data);
  frame.close();
  return image;
}

/**
 * Decodes MP4/MOV with mp4box demuxing + WebCodecs VideoDecoder. Only a
 * uniform, optionally downscaled subset is retained for the estimator.
 */
export async function decodeVideoFileWebCodecs(
  file: File | Blob,
  options: DecodeOptions = {},
): Promise<DecodedVideo> {
  if (typeof VideoDecoder === 'undefined') throw new Error('当前浏览器不支持 WebCodecs VideoDecoder。');

  const mp4 = MP4BoxModule.createFile();
  const sampleJobs: Array<Promise<void>> = [];
  const frames: RgbaImage[] = [];
  let track: MP4Track | undefined;
  let decoder: VideoDecoder | undefined;
  let outputIndex = 0;
  let totalSamples = 0;
  let failure: Error | null = null;

  const ready = new Promise<void>((resolve, reject) => {
    mp4.onReady = info => {
      track = info.videoTracks[0];
      if (!track) {
        reject(new Error('MP4 中没有视频轨。'));
        return;
      }
      totalSamples = track.nb_samples ?? 0;
      const width = track.video?.width ?? (track as unknown as { track_width?: number }).track_width ?? 1920;
      const height = track.video?.height ?? (track as unknown as { track_height?: number }).track_height ?? 1080;
      decoder = new VideoDecoder({
        output: frame => {
          outputIndex++;
          const stride = options.maxFrames && totalSamples > options.maxFrames
            ? Math.ceil(totalSamples / options.maxFrames)
            : 1;
          if (stride <= 1 || outputIndex % stride === 0 || outputIndex === totalSamples) {
            try {
              frames.push(rasterizeVideoFrame(frame, options.targetWidth));
            } catch (err) {
              failure = err instanceof Error ? err : new Error(String(err));
              frame.close();
            }
          } else {
            frame.close();
          }
          options.onProgress?.(outputIndex, frames.length);
        },
        error: err => { failure = err; },
      });
      try {
        const description = codecDescription(mp4, track);
      decoder.configure({
          codec: track.codec,
          codedWidth: width,
          codedHeight: height,
          ...(description ? { description } : {}),
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      mp4.setExtractionOptions(track.id, null, { nbSamples: 250 });
      mp4.start();
      resolve();
    };
  });

  mp4.onSamples = (_id, _user, samples) => {
    const job = (async () => {
      if (!decoder || failure) return;
      for (const sample of samples) {
        while (decoder.decodeQueueSize > 8 && !failure) {
          await new Promise(r => setTimeout(r, 4));
        }
        if (failure) break;
        decoder.decode(new EncodedVideoChunk({
          type: sample.is_sync ? 'key' : 'delta',
          timestamp: Math.round((sample.cts * 1_000_000) / sample.timescale),
          duration: Math.max(1, Math.round((sample.duration * 1_000_000) / sample.timescale)),
          data: new Uint8Array(sample.data),
        }));
      }
    })();
    sampleJobs.push(job);
  };

  const buffer = await file.arrayBuffer();
  (buffer as ArrayBuffer & { fileStart?: number }).fileStart = 0;
  mp4.appendBuffer(buffer);
  mp4.flush();
  await ready;
  await Promise.all(sampleJobs);
  if (failure) throw failure;
  if (!decoder || !track) throw new Error('WebCodecs 解码器未初始化。');
  await decoder.flush();
  if (failure) throw failure;
  if (!frames.length) throw new Error('WebCodecs 未输出视频帧。');

  const width = frames[0].width;
  const height = frames[0].height;
  return {
    width,
    height,
    codec: track.codec,
    durationSeconds: track.duration / track.timescale,
    frames,
  };
}

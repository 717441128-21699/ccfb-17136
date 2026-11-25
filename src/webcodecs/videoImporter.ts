import MP4Box from 'mp4box';
import type { RgbaImage } from '../core/types';

export interface DecodedRgbaVideo {
  width: number;
  height: number;
  durationSeconds: number;
  frameRate: number;
  frames: RgbaImage[];
  codec: string;
  close(): void;
}

export interface DecodeOptions {
  maxFrames?: number;
  targetWidth?: number;
  onProgress?: (decoded: number, total: number) => void;
}

function buildAvcDescription(avcC: any): Uint8Array | undefined {
  if (!avcC) return undefined;
  const spsList: Uint8Array[] = (avcC.SPS ?? []).map((s: any) => s.nalu);
  const ppsList: Uint8Array[] = (avcC.PPS ?? []).map((p: any) => p.nalu);
  if (!spsList.length || !ppsList.length) return undefined;
  const size = 11 + spsList.reduce((n, x) => n + 2 + x.length, 0) + ppsList.reduce((n, x) => n + 2 + x.length + 1, 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let o = 0;
  out[o++] = 1;
  out[o++] = avcC.AVCProfileIndication ?? 100;
  out[o++] = avcC.profile_compatibility ?? 0;
  out[o++] = avcC.AVCLevelIndication ?? 40;
  out[o++] = 0xff;
  out[o++] = 0xe0 | spsList.length;
  for (const nalu of spsList) {
    dv.setUint16(o, nalu.length); o += 2;
    out.set(nalu, o); o += nalu.length;
  }
  out[o++] = ppsList.length;
  for (const nalu of ppsList) {
    dv.setUint16(o, nalu.length); o += 2;
    out.set(nalu, o); o += nalu.length;
  }
  return out;
}

function videoFrameToRgba(frame: VideoFrame, targetWidth?: number): RgbaImage {
  const scale = targetWidth ? Math.min(1, targetWidth / frame.displayWidth) : 1;
  const width = Math.max(2, Math.round(frame.displayWidth * scale));
  const height = Math.max(2, Math.round(frame.displayHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(frame, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  return { width, height, data: imageData.data };
}

export async function decodeVideoFileToRgba(file: File, options: DecodeOptions = {}): Promise<DecodedRgbaVideo> {
  if (typeof VideoDecoder === 'undefined') throw new Error('当前浏览器不支持 WebCodecs VideoDecoder。');
  const buffer = await file.arrayBuffer();
  const mp4 = MP4Box.createFile();
  const maxFrames = options.maxFrames ?? 120;

  return new Promise<DecodedRgbaVideo>((resolve, reject) => {
    let decoder: VideoDecoder | null = null;
    let info: any = null;
    let totalSamples = 0;
    let configured = false;
    let settled = false;
    const frames: RgbaImage[] = [];
    let decodedCount = 0;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      try {
        decoder?.close();
      } catch {
        /* already closed */
      }
      const track = info?.videoTracks?.[0];
      resolve({
        width: options.targetWidth ?? track?.video?.width ?? 1920,
        height: track?.video?.height ?? 1080,
        durationSeconds: (info?.duration ?? 0) / (info?.timescale ?? 1000),
        frameRate: track?.nb_samples && track?.duration ? track.nb_samples / (track.duration / track.timescale) : 30,
        frames,
        codec: track?.codec ?? 'unknown',
        close() {
          frames.length = 0;
        },
      });
    };

    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    mp4.onError = fail;
    mp4.onReady = (readyInfo: any) => {
      info = readyInfo;
      const track = readyInfo.videoTracks?.[0];
      if (!track) {
        fail(new Error('文件中没有视频轨'));
        return;
      }
      totalSamples = Math.min(maxFrames, track.nb_samples ?? maxFrames);
      const sampleEntry = track.mdia?.minf?.stbl?.stsd?.entries?.[0];
      const avcC = sampleEntry?.avcC ?? track.mdia?.minf?.stbl?.avcC;
      const description = buildAvcDescription(avcC);
      decoder = new VideoDecoder({
        output: (videoFrame) => {
          try {
            frames.push(videoFrameToRgba(videoFrame, options.targetWidth));
            decodedCount++;
            options.onProgress?.(decodedCount, totalSamples);
            videoFrame.close();
            if (decodedCount >= totalSamples && decoder?.decodeQueueSize === 0) {
              setTimeout(finish, 30);
            }
          } catch (err) {
            fail(err);
          }
        },
        error: fail,
      });
      const config: VideoDecoderConfig = {
        codec: track.codec,
        codedWidth: track.video?.width,
        codedHeight: track.video?.height,
        description: description as BufferSource | undefined,
        hardwareAcceleration: 'prefer-hardware',
      };
      VideoDecoder.isConfigSupported(config).then((support) => {
        if (!support.supported) {
          delete config.description;
        }
        decoder!.configure(support.supported ? config : { ...config, description: undefined });
        configured = true;
        mp4.setExtractionOptions(track.id, null, { nbSamples: maxFrames });
        mp4.start();
      }, fail);
    };

    mp4.onSamples = (_id: number, _user: unknown, samples: any[]) => {
      if (!configured || !decoder) return;
      for (let i = 0; i < samples.length && decodedCount + decoder.decodeQueueSize < maxFrames + 8; i++) {
        const s = samples[i];
        const chunk = new EncodedVideoChunk({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: Math.round((frames.length + i) * 1_000_000 / 30),
          data: s.data,
        });
        decoder.decode(chunk);
      }
      if (samples.length === 0) setTimeout(finish, 200);
    };

    (buffer as any).fileStart = 0;
    mp4.appendBuffer(buffer);
    mp4.flush();
    setTimeout(() => {
      if (!settled && frames.length > 0) finish();
      else if (!settled) fail(new Error('WebCodecs 解码超时或未从 MP4Box 收到样本'));
    }, 30_000);
  });
}

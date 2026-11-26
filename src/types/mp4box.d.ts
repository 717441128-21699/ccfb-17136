declare module 'mp4box' {
  export interface MP4Sample {
    data: ArrayBuffer;
    size: number;
    is_sync: boolean;
    dts: number;
    cts: number;
    duration: number;
    timescale: number;
  }
  export interface MP4Track {
    id: number;
    codec: string;
    timescale: number;
    duration: number;
    nb_samples: number;
    video?: { width: number; height: number };
    audio?: unknown;
    mdia?: unknown;
  }
  export interface MP4Info {
    videoTracks: MP4Track[];
    duration: number;
    timescale: number;
  }
  export interface MP4File {
    onReady?: (info: MP4Info) => void;
    onSamples?: (id: number, user: unknown, samples: MP4Sample[]) => void;
    appendBuffer(buffer: ArrayBuffer): number;
    flush(): void;
    setExtractionOptions(id: number, user?: unknown, options?: { nbSamples?: number }): void;
    start(): void;
    stop(): void;
  }
  export function createFile(): MP4File;
  const MP4Box: { createFile: typeof createFile; DataStream?: unknown };
  export default MP4Box;
}

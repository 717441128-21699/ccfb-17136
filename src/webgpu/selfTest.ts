import type { RgbaImage } from '../core/image.ts';
import { initWebGPU } from './device.ts';
import { WebGpuFrameEngine } from './WebGpuFrameEngine.ts';

export interface WebGpuSelfTestResult {
  ok: boolean;
  adapter: string;
  blockCount?: number;
  motionMs?: number;
  warpMs?: number;
  error?: string;
}

/**
 * Compiles and exercises both WGSL compute pipelines on a real frame pair.
 * The high-PSNR curling output still uses the object-aware TypeScript path in
 * headless/no-adapter environments; browsers with an adapter can use these
 * kernels as the dense acceleration/validation backend.
 */
export async function runWebGpuSelfTest(frames: RgbaImage[]): Promise<WebGpuSelfTestResult> {
  if (!frames[0] || !frames[1]) return { ok: false, adapter: '', error: '需要至少两帧' };
  const context = await initWebGPU();
  if (!context) return { ok: false, adapter: '', error: '未发现 WebGPU adapter' };
  const adapter = context.adapter as unknown as { info?: { vendor?: string; architecture?: string } };
  const name = [adapter.info?.vendor, adapter.info?.architecture].filter(Boolean).join(' / ');
  try {
    const engine = new WebGpuFrameEngine(context);
    await engine.init();
    const meStart = performance.now();
    const blocks = await engine.estimateBlocks(frames[0], frames[1], 8);
    const motionMs = performance.now() - meStart;

    const warpStart = performance.now();
    const warped = await engine.interpolatePair(frames[0], frames[1], blocks.vectors, 0.5);
    const warpMs = performance.now() - warpStart;
    if (!warped.data.length) throw new Error('WGPU warp returned empty frame');
    return {
      ok: true,
      adapter: name || 'WebGPU adapter',
      blockCount: blocks.blocksX * blocks.blocksY,
      motionMs,
      warpMs,
    };
  } catch (err) {
    return {
      ok: false,
      adapter: name || 'WebGPU adapter',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

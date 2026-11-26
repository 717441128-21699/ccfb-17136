export interface WebGpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  preferredFormat: GPUTextureFormat;
}

export async function initWebGPU(): Promise<WebGpuContext | null> {
  if (typeof navigator === 'undefined' || !navigator.gpu) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      },
    });
    return { adapter, device, preferredFormat: navigator.gpu.getPreferredCanvasFormat() };
  } catch (err) {
    console.warn('WebGPU unavailable, using CPU reference pipeline.', err);
    return null;
  }
}

export function isWebGpuSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}

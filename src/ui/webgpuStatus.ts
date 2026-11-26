import type { WebGpuStatus } from './state.ts';

/**
 * Detect the optional WebGPU acceleration layer.
 *
 * We deliberately use a non-literal specifier so TypeScript and Vite do not
 * try to resolve/bundle `../webgpu/device.ts` when that in-progress module does
 * not exist. At runtime the import is attempted and any failure falls back to
 * the CPU reference path. The literal path below is the intended target.
 */
const OPTIONAL_DEVICE_MODULE = '../webgpu/device.ts';

type MaybeGpuNavigator = Navigator & { gpu?: GPU };

interface DetectedDeviceModule {
  default?: unknown;
  createDevice?: () => Promise<unknown> | unknown;
  getDevice?: () => Promise<unknown> | unknown;
  initWebGPU?: () => Promise<unknown> | unknown;
  isWebGpuAvailable?: () => boolean | Promise<boolean>;
}

export async function detectWebGpuStatus(): Promise<WebGpuStatus> {
  const nav = navigator as MaybeGpuNavigator;
  let adapterInfo = '';
  let browserHasGpu = false;
  if (nav.gpu && typeof nav.gpu.requestAdapter === 'function') {
    try {
      const adapter = await nav.gpu.requestAdapter();
      if (adapter) {
        browserHasGpu = true;
        const info = (adapter as unknown as { info?: { vendor?: string; architecture?: string } }).info;
        if (info?.vendor) adapterInfo = `适配器 ${info.vendor}${info.architecture ? ` / ${info.architecture}` : ''}`;
      }
    } catch {
      browserHasGpu = false;
    }
  }

  let mod: DetectedDeviceModule | null = null;
  try {
    // @vite-ignore — optional module, resolved only if present at runtime.
    const imported = (await import(/* @vite-ignore */ OPTIONAL_DEVICE_MODULE)) as DetectedDeviceModule;
    mod = imported ?? null;
  } catch {
    mod = null;
  }

  if (mod) {
    // The module exists. Its exact factory shape is owned by another layer, so
    // probe the common export names defensively.
    let moduleSaysAvailable = true;
    try {
      if (typeof mod.isWebGpuAvailable === 'function') {
        moduleSaysAvailable = Boolean(await mod.isWebGpuAvailable());
      }
    } catch {
      moduleSaysAvailable = false;
    }
    if (moduleSaysAvailable) {
      return {
        mode: 'webgpu-module',
        badgeClass: 'engine-ok',
        badgeText: 'WebGPU 加速就绪',
        detail: `已加载可选加速模块 src/webgpu/device.ts。${adapterInfo}`,
      };
    }
  }

  if (browserHasGpu) {
    return {
      mode: 'webgpu-adapter',
      badgeClass: 'engine-cpu',
      badgeText: 'CPU 参考模式',
      detail: `浏览器支持 WebGPU（${adapterInfo || '已发现 GPU 适配器'}），但未找到可用的 src/webgpu/device.ts 加速层，当前使用 TypeScript CPU 参考实现。`,
    };
  }

  return {
    mode: 'cpu',
    badgeClass: 'engine-cpu',
    badgeText: 'CPU 参考模式',
    detail: '当前环境未暴露 WebGPU（navigator.gpu 不可用），运动估计与插帧使用 TypeScript CPU 参考实现，结果完整可用。',
  };
}

import type { RgbaImage } from '../core/types';

// All GPU objects are intentionally `any` until the browser's WebGPU types are
// available. The pipeline is created only behind navigator.gpu detection.
/* eslint-disable @typescript-eslint/no-explicit-any */

const MOTION_SHADER = /* wgsl */ `
struct Params {
  width: u32, height: u32, blockW: u32, blockH: u32,
  u: f32, p0: u32, p1: u32, p2: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> texA: array<u32>;
@group(0) @binding(2) var<storage, read> texB: array<u32>;
@group(0) @binding(3) var<storage, read_write> mvs: array<i32>;

fn lum(packed: u32) -> f32 {
  let r = f32(packed & 255u);
  let g = f32((packed >> 8u) & 255u);
  let b = f32((packed >> 16u) & 255u);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

fn inBounds(x: i32, y: i32) -> bool {
  return x >= 0 && y >= 0 && x < i32(params.width) && y < i32(params.height);
}

@compute @workgroup_size(8, 8)
fn estimate(@builtin(global_invocation_id) gid: vec3<u32>) {
  let bx = i32(gid.x);
  let by = i32(gid.y);
  if (bx >= i32(params.blockW) || by >= i32(params.blockH)) { return; }
  let cx = bx * 16 + 8;
  let cy = by * 16 + 8;
  var best = 1e12;
  var bestX = 0;
  var bestY = 0;
  for (var my = -24; my <= 24; my = my + 2) {
    for (var mx = -24; mx <= 24; mx = mx + 2) {
      var sad = 0.0;
      var samples = 0.0;
      for (var py = -7; py <= 7; py += 2) {
        for (var px = -7; px <= 7; px += 2) {
          let ax = cx + px;
          let ay = cy + py;
          let bx2 = ax + mx;
          let by2 = ay + my;
          if (!inBounds(ax, ay) || !inBounds(bx2, by2)) { continue; }
          let ai = u32(ay * i32(params.width) + ax);
          let bi = u32(by2 * i32(params.width) + bx2);
          sad += abs(lum(texA[ai]) - lum(texB[bi]));
          samples += 1.0;
        }
      }
      let score = sad / max(1.0, samples);
      if (score < best) {
        best = score;
        bestX = mx;
        bestY = my;
      }
    }
  }
  let idx = u32(by * i32(params.blockW) + bx) * 2u;
  mvs[idx] = bestX;
  mvs[idx + 1u] = bestY;
}
`;

const INTERP_SHADER = /* wgsl */ `
struct Params {
  width: u32, height: u32, blockW: u32, blockH: u32,
  u: f32, p0: u32, p1: u32, p2: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> texA: array<u32>;
@group(0) @binding(2) var<storage, read> texB: array<u32>;
@group(0) @binding(3) var<storage, read> mvs: array<i32>;
@group(0) @binding(4) var<storage, read_write> output: array<u32>;

fn readPixel(tex: ptr<storage, array<u32>, read>, x: i32, y: i32) -> vec3<f32> {
  let cx = clamp(x, 0, i32(params.width) - 1);
  let cy = clamp(y, 0, i32(params.height) - 1);
  let p = (*tex)[u32(cy * i32(params.width) + cx)];
  return vec3<f32>(f32(p & 255u), f32((p >> 8u) & 255u), f32((p >> 16u) & 255u));
}

fn sampleBilinear(tex: ptr<storage, array<u32>, read>, x: f32, y: f32) -> vec3<f32> {
  let x0 = i32(floor(x));
  let y0 = i32(floor(y));
  let tx = x - floor(x);
  let ty = y - floor(y);
  let c00 = readPixel(tex, x0, y0);
  let c10 = readPixel(tex, x0 + 1, y0);
  let c01 = readPixel(tex, x0, y0 + 1);
  let c11 = readPixel(tex, x0 + 1, y0 + 1);
  return mix(mix(c00, c10, tx), mix(c01, c11, tx), ty);
}

fn pack(c: vec3<f32>) -> u32 {
  let r = u32(clamp(c.r, 0.0, 255.0) + 0.5);
  let g = u32(clamp(c.g, 0.0, 255.0) + 0.5);
  let b = u32(clamp(c.b, 0.0, 255.0) + 0.5);
  return r | (g << 8u) | (b << 16u) | 255u << 24u;
}

@compute @workgroup_size(8, 8)
fn interpolate(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= i32(params.width) || y >= i32(params.height)) { return; }
  let bx = clamp(x / 16, 0, i32(params.blockW) - 1);
  let by = clamp(y / 16, 0, i32(params.blockH) - 1);
  let mvIdx = u32(by * i32(params.blockW) + bx) * 2u;
  let mv = vec2<f32>(f32(mvs[mvIdx]), f32(mvs[mvIdx + 1u]));
  let p = vec2<f32>(f32(x) + 0.5, f32(y) + 0.5);
  let ca = sampleBilinear(texA, p.x - mv.x * params.u, p.y - mv.y * params.u);
  let cb = sampleBilinear(texB, p.x + mv.x * (1.0 - params.u), p.y + mv.y * (1.0 - params.u));
  let c = mix(ca, cb, 0.5);
  output[u32(y * i32(params.width) + x)] = pack(c);
}
`;

export class WebGpuInterpolator {
  private constructor(
    private device: any,
    private motionPipeline: any,
    private interpPipeline: any,
  ) {}

  static isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!(navigator as any).gpu;
  }

  static async create(): Promise<WebGpuInterpolator | null> {
    const gpu = (navigator as any).gpu;
    if (!gpu) return null;
    try {
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      const motionModule = device.createShaderModule({ code: MOTION_SHADER });
      const interpModule = device.createShaderModule({ code: INTERP_SHADER });
      const motionPipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: motionModule, entryPoint: 'estimate' },
      });
      const interpPipeline = await device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: interpModule, entryPoint: 'interpolate' },
      });
      return new WebGpuInterpolator(device, motionPipeline, interpPipeline);
    } catch (err) {
      console.warn('WebGPU initialization failed; using CPU reference backend.', err);
      return null;
    }
  }

  async interpolate(a: RgbaImage, b: RgbaImage, u: number): Promise<RgbaImage> {
    if (a.width !== b.width || a.height !== b.height) throw new Error('GPU frame dimensions differ');
    const { width, height } = a;
    const pixels = width * height;
    const blockW = Math.ceil(width / 16);
    const blockH = Math.ceil(height / 16);
    const device = this.device;
    const byteLength = pixels * 4;
    const mvLength = blockW * blockH * 8;

    const aBuffer = device.createBuffer({ size: byteLength, usage: 0x80 | 0x8 });
    const bBuffer = device.createBuffer({ size: byteLength, usage: 0x80 | 0x8 });
    const mvBuffer = device.createBuffer({ size: mvLength, usage: 0x80 | 0x8 });
    const outBuffer = device.createBuffer({ size: byteLength, usage: 0x80 | 0x4 });
    const readback = device.createBuffer({ size: byteLength, usage: 0x1 | 0x8 });

    device.queue.writeBuffer(aBuffer, 0, a.data.buffer, a.data.byteOffset, byteLength);
    device.queue.writeBuffer(bBuffer, 0, b.data.buffer, b.data.byteOffset, byteLength);

    const params = new ArrayBuffer(32);
    const dv = new DataView(params);
    dv.setUint32(0, width, true);
    dv.setUint32(4, height, true);
    dv.setUint32(8, blockW, true);
    dv.setUint32(12, blockH, true);
    dv.setFloat32(16, u, true);
    const paramBuffer = device.createBuffer({ size: 32, usage: 0x40 | 0x8 });
    device.queue.writeBuffer(paramBuffer, 0, params);

    const motionBind = device.createBindGroup({
      layout: this.motionPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramBuffer } },
        { binding: 1, resource: { buffer: aBuffer } },
        { binding: 2, resource: { buffer: bBuffer } },
        { binding: 3, resource: { buffer: mvBuffer } },
      ],
    });
    const interpBind = device.createBindGroup({
      layout: this.interpPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramBuffer } },
        { binding: 1, resource: { buffer: aBuffer } },
        { binding: 2, resource: { buffer: bBuffer } },
        { binding: 3, resource: { buffer: mvBuffer } },
        { binding: 4, resource: { buffer: outBuffer } },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.motionPipeline);
    pass.setBindGroup(0, motionBind);
    pass.dispatchWorkgroups(Math.ceil(blockW / 8), Math.ceil(blockH / 8));
    pass.setPipeline(this.interpPipeline);
    pass.setBindGroup(0, interpBind);
    pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
    pass.end();
    encoder.copyBufferToBuffer(outBuffer, 0, readback, 0, byteLength);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(1);
    const copy = new Uint8Array(readback.getMappedRange()).slice();
    readback.unmap();
    for (const buf of [aBuffer, bBuffer, mvBuffer, outBuffer, readback, paramBuffer]) buf.destroy?.();
    return { width, height, data: new Uint8ClampedArray(copy.buffer) };
  }
}

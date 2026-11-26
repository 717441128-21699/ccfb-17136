import type { RgbaImage } from '../core/image.ts';
import type { WebGpuContext } from './device.ts';
import { BLOCK_SIZE, motionEstimationShader, warpInterpolationShader } from './shaders.ts';

function asUint32Pixels(img: RgbaImage): Uint32Array {
  // All supported desktop platforms are little-endian; RGBA bytes therefore map
  // to r | g<<8 | b<<16 | a<<24, exactly the packing used by the WGSL kernels.
  return new Uint32Array(img.data.buffer, img.data.byteOffset, img.width * img.height);
}

function blocksFor(size: number): number {
  return Math.ceil(size / BLOCK_SIZE);
}

export class WebGpuFrameEngine {
  readonly context: WebGpuContext;
  private mePipeline?: GPUComputePipeline;
  private warpPipeline?: GPUComputePipeline;

  constructor(context: WebGpuContext) {
    this.context = context;
  }

  private get device(): GPUDevice {
    return this.context.device;
  }

  async init(): Promise<void> {
    const meModule = this.device.createShaderModule({ code: motionEstimationShader });
    const warpModule = this.device.createShaderModule({ code: warpInterpolationShader });
    this.mePipeline = await this.device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: meModule, entryPoint: 'main' },
    });
    this.warpPipeline = await this.device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: warpModule, entryPoint: 'main' },
    });
  }

  /** Dense 16×16 block SAD motion estimation on the GPU. */
  async estimateBlocks(prev: RgbaImage, current: RgbaImage, search = 20): Promise<{ vectors: Int32Array; blocksX: number; blocksY: number }> {
    if (!this.mePipeline) await this.init();
    const w = prev.width;
    const h = prev.height;
    const blocksX = blocksFor(w);
    const blocksY = blocksFor(h);
    const count = blocksX * blocksY;
    const prevBuf = this.makeStorageWithPixels(prev);
    const currBuf = this.makeStorageWithPixels(current);
    const vectorsBuf = this.device.createBuffer({ size: count * 2 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const scoresBuf = this.device.createBuffer({ size: count * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const params = new ArrayBuffer(32);
    const u32 = new Uint32Array(params);
    u32[0] = w; u32[1] = h; u32[2] = blocksX; u32[3] = blocksY;
    u32[4] = search >>> 0; u32[5] = BLOCK_SIZE;
    const paramsBuf = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(paramsBuf, 0, params);

    const bindGroup = this.device.createBindGroup({
      layout: this.mePipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramsBuf } },
        { binding: 1, resource: { buffer: prevBuf } },
        { binding: 2, resource: { buffer: currBuf } },
        { binding: 3, resource: { buffer: vectorsBuf } },
        { binding: 4, resource: { buffer: scoresBuf } },
      ],
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.mePipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(blocksX / 8), Math.ceil(blocksY / 8));
    pass.end();

    const readback = this.device.createBuffer({ size: count * 2 * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    encoder.copyBufferToBuffer(vectorsBuf, 0, readback, 0, count * 2 * 4);
    this.device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const vectors = new Int32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    readback.destroy();
    prevBuf.destroy(); currBuf.destroy(); vectorsBuf.destroy(); scoresBuf.destroy(); paramsBuf.destroy();
    return { vectors, blocksX, blocksY };
  }

  /** GPU bilinear motion-compensated pair warp. The object-aware TS path supplies cleaner vectors/layers for curling stones. */
  async interpolatePair(
    prev: RgbaImage,
    next: RgbaImage,
    vectors: Int32Array,
    t: number,
    plate?: RgbaImage,
  ): Promise<RgbaImage> {
    if (!this.warpPipeline) await this.init();
    const w = prev.width;
    const h = prev.height;
    const blocksX = blocksFor(w);
    const pixelCount = w * h;
    const prevBuf = this.makeStorageWithPixels(prev);
    const nextBuf = this.makeStorageWithPixels(next);
    const plateImage = plate ?? prev;
    const plateBuf = this.makeStorageWithPixels(plateImage);
    const mvBuf = this.device.createBuffer({
      size: Math.max(vectors.byteLength, blocksX * blocksFor(h) * 8),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(mvBuf, 0, vectors as Int32Array<ArrayBuffer>);
    const outputBuf = this.device.createBuffer({ size: pixelCount * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const params = new ArrayBuffer(32);
    const dv = new DataView(params);
    dv.setUint32(0, w, true);
    dv.setUint32(4, h, true);
    dv.setUint32(8, blocksX, true);
    dv.setFloat32(12, t, true);
    dv.setUint32(16, plate ? 1 : 0, true);
    const paramsBuf = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(paramsBuf, 0, params);

    const bindGroup = this.device.createBindGroup({
      layout: this.warpPipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramsBuf } },
        { binding: 1, resource: { buffer: prevBuf } },
        { binding: 2, resource: { buffer: nextBuf } },
        { binding: 3, resource: { buffer: plateBuf } },
        { binding: 4, resource: { buffer: mvBuf } },
        { binding: 5, resource: { buffer: outputBuf } },
      ],
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.warpPipeline!);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(w / 16), Math.ceil(h / 16));
    pass.end();
    const readback = this.device.createBuffer({ size: pixelCount * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    encoder.copyBufferToBuffer(outputBuf, 0, readback, 0, pixelCount * 4);
    this.device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const copied = new Uint8Array(readback.getMappedRange().slice(0));
    readback.unmap();
    readback.destroy();
    [prevBuf, nextBuf, plateBuf, mvBuf, outputBuf, paramsBuf].forEach(b => b.destroy());
    return { width: w, height: h, data: copied };
  }

  private makeStorageWithPixels(img: RgbaImage): GPUBuffer {
    const pixels = asUint32Pixels(img);
    const buffer = this.device.createBuffer({ size: img.width * img.height * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buffer, 0, pixels as Uint32Array<ArrayBuffer>);
    return buffer;
  }
}

export const BLOCK_SIZE = 16;

export const motionEstimationShader = /* wgsl */ `
struct MeParams {
  width: u32,
  height: u32,
  blocksX: u32,
  blocksY: u32,
  search: i32,
  block: i32,
};

@group(0) @binding(0) var<uniform> params: MeParams;
@group(0) @binding(1) var<storage, read> prev: array<u32>;
@group(0) @binding(2) var<storage, read> curr: array<u32>;
@group(0) @binding(3) var<storage, read_write> vectors: array<i32>;
@group(0) @binding(4) var<storage, read_write> scores: array<u32>;

fn luma(packed: u32) -> i32 {
  let r = i32(packed & 255u);
  let g = i32((packed >> 8u) & 255u);
  let b = i32((packed >> 16u) & 255u);
  return (r * 76 + g * 150 + b * 30) >> 8;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let bx = i32(gid.x);
  let by = i32(gid.y);
  if (bx >= i32(params.blocksX) || by >= i32(params.blocksY)) { return; }

  let startX = bx * params.block;
  let startY = by * params.block;
  var bestSad: u32 = 0xffffffffu;
  var bestDx: i32 = 0;
  var bestDy: i32 = 0;

  for (var dy = -params.search; dy <= params.search; dy = dy + 1) {
    for (var dx = -params.search; dx <= params.search; dx = dx + 1) {
      var sad: u32 = 0;
      for (var yy = 0; yy < params.block; yy = yy + 1) {
        for (var xx = 0; xx < params.block; xx = xx + 1) {
          let x = startX + xx;
          let y = startY + yy;
          let cxp = clamp(x, 0, i32(params.width) - 1);
          let cyp = clamp(y, 0, i32(params.height) - 1);
          let sx = clamp(x + dx, 0, i32(params.width) - 1);
          let sy = clamp(y + dy, 0, i32(params.height) - 1);
          let currLuma = luma(curr[u32(cyp * i32(params.width) + cxp)]);
          let prevLuma = luma(prev[u32(sy * i32(params.width) + sx)]);
          let d = abs(currLuma - prevLuma);
          sad = sad + u32(d);
        }
      }
      if (sad < bestSad) {
        bestSad = sad;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  let id = u32(by * i32(params.blocksX) + bx);
  vectors[id * 2u] = bestDx;
  vectors[id * 2u + 1u] = bestDy;
  scores[id] = bestSad;
}
`;

export const warpInterpolationShader = /* wgsl */ `
struct WarpParams {
  width: u32,
  height: u32,
  blocksX: u32,
  t: f32,
  usePlate: u32,
};

@group(0) @binding(0) var<uniform> params: WarpParams;
@group(0) @binding(1) var<storage, read> prev: array<u32>;
@group(0) @binding(2) var<storage, read> next: array<u32>;
@group(0) @binding(3) var<storage, read> plate: array<u32>;
@group(0) @binding(4) var<storage, read> vectors: array<i32>;
@group(0) @binding(5) var<storage, read_write> output: array<u32>;

fn channel(packed: u32, shift: u32) -> f32 {
  return f32((packed >> shift) & 255u);
}

fn packRGBA(r: f32, g: f32, b: f32, a: f32) -> u32 {
  let rr = u32(clamp(r + 0.5, 0.0, 255.0));
  let gg = u32(clamp(g + 0.5, 0.0, 255.0));
  let bb = u32(clamp(b + 0.5, 0.0, 255.0));
  let aa = u32(clamp(a + 0.5, 0.0, 255.0));
  return rr | (gg << 8u) | (bb << 16u) | (aa << 24u);
}

fn bilinearPacked(p00: u32, p10: u32, p01: u32, p11: u32, fx: f32, fy: f32) -> vec4<f32> {
  let r = mix(mix(channel(p00, 0u), channel(p10, 0u), fx), mix(channel(p01, 0u), channel(p11, 0u), fx), fy);
  let g = mix(mix(channel(p00, 8u), channel(p10, 8u), fx), mix(channel(p01, 8u), channel(p11, 8u), fx), fy);
  let b = mix(mix(channel(p00, 16u), channel(p10, 16u), fx), mix(channel(p01, 16u), channel(p11, 16u), fx), fy);
  let a = mix(mix(channel(p00, 24u), channel(p10, 24u), fx), mix(channel(p01, 24u), channel(p11, 24u), fx), fy);
  return vec4<f32>(r, g, b, a);
}

fn sampleStorage(img: ptr<storage, array<u32>, read>, w: i32, h: i32, x: f32, y: f32) -> vec4<f32> {
  let x0 = i32(floor(x));
  let y0 = i32(floor(y));
  let fx = x - f32(x0);
  let fy = y - f32(y0);
  let ix0 = clamp(x0, 0, w - 1);
  let iy0 = clamp(y0, 0, h - 1);
  let ix1 = clamp(x0 + 1, 0, w - 1);
  let iy1 = clamp(y0 + 1, 0, h - 1);
  let p00 = (*img)[u32(iy0 * w + ix0)];
  let p10 = (*img)[u32(iy0 * w + ix1)];
  let p01 = (*img)[u32(iy1 * w + ix0)];
  let p11 = (*img)[u32(iy1 * w + ix1)];
  return bilinearPacked(p00, p10, p01, p11, fx, fy);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = i32(params.width);
  let h = i32(params.height);
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (x >= w || y >= h) { return; }

  let bx = clamp(x / 16, 0, i32(params.blocksX) - 1);
  let by = y / 16;
  let vid = u32(by * i32(params.blocksX) + bx) * 2u;
  let mvx = f32(vectors[vid]);
  let mvy = f32(vectors[vid + 1u]);
  let t = params.t;

  // Vector points prev -> current. The two source coordinates both map through
  // the same intermediate motion anchor.
  let prevColor = sampleStorage(&prev, w, h, f32(x) - mvx * t, f32(y) - mvy * t);
  let nextColor = sampleStorage(&next, w, h, f32(x) + mvx * (1.0 - t), f32(y) + mvy * (1.0 - t));
  var color = mix(prevColor, nextColor, t);
  if (params.usePlate != 0u) {
    let p = plate[u32(y * w + x)];
    let plateColor = vec4<f32>(channel(p, 0u), channel(p, 8u), channel(p, 16u), 255.0);
    let confidence = clamp(abs(prevColor.r - nextColor.r) + abs(prevColor.g - nextColor.g) + abs(prevColor.b - nextColor.b), 0.0, 180.0) / 180.0;
    color = mix(plateColor, color, 0.55 + 0.45 * (1.0 - confidence));
  }
  output[u32(y * w + x)] = packRGBA(color.r, color.g, color.b, 255.0);
}
`;

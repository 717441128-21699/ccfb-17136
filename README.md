# 冰壶 WebGPU 慢动作插帧工作台

一个纯本地运行的冰壶转播慢动作 Demo：导入录像后进行物体感知运动估计，在 30 fps 帧间生成 2/4/8 倍慢放所需的中间帧，并通过 WebCodecs 导出 MP4。界面、运动模型、合成测试视频和客观指标均在本仓库内。

> 隐私：录像只在浏览器本地解码和处理，不上传任何服务器。

## 快速开始

```bash
npm install
npm run dev          # 打开 Vite 提示的本地地址
npm test             # PSNR、直线保持、碰撞无重影测试
npm run build        # 类型检查 + 生产构建
npm run preview      # 预览生产构建
```

重新生成仓库自带的四种 720p/120 fps 测试 MP4：

```bash
npm run render:clips
# 或自定义：
npm run render:clips -- --width=1920 --height=1080 --seconds=10 --kind=head-on
```

1080p/10 秒性能脚本（Node 中运行 CPU 参考路径；WebGPU 路径在支持 WebGPU 的 Chrome/Edge 中运行）：

```bash
npm run benchmark:1080p
npm run benchmark:1080p:quick
```

## 四个页面

1. **录像导入**
   - 选择/拖入本地 MP4/WebM。
   - 一键生成四种内置测试片段：正面对撞、斜向擦碰、大本营压线、刷冰遮挡。
   - MP4 由 `mp4box` 解封装，`VideoDecoder` 解码为 `VideoFrame`，再转成 RGBA。
   - `public/samples/` 中也提供了已经渲染好的 1280×720/120 fps H.264 MP4。

2. **运动估计**
   - 高百分位时间背景板提取无冰壶/无刷子的冰面和直线。
   - 连通域检测冰壶种子，圆盘边缘 SAD 模板匹配跟踪位移。
   - PCA/颜色权重估计手柄角度并做角度解卷绕。
   - 长条形连通域跟踪快速运动的刷子。
   - 页面可查看轨迹、估计耗时和 WebGPU 状态；运行估计后会实际编译并 dispatch 一次 WGSL 块匹配 + warp 自检，显示 GPU 块数和耗时。

3. **慢放预览**
   - 支持 2/4/8 倍慢放、播放/暂停、拖动和逐帧检查。
   - 120 fps 合成片段可直接显示插值帧与真值帧的 PSNR。
   - 碰撞区间使用分段“碰前匀速 / 碰后匀速”轨迹，不把碰撞两侧交叉淡入淡出，避免重影。
   - 普通减速/转向区间使用 Catmull-Rom 轨迹；压线末段的小位移因此更平滑。

4. **导出成片**
   - 使用 `VideoEncoder` 编码 H.264，`mp4-muxer` 封装 MP4。
   - 8 倍慢放时，每个 30 fps 源帧间隔生成 7 个中间相位；以 30 fps 导出后呈现 8 倍时长的慢动作。
   - 显示真实编码进度，完成后浏览器下载 MP4。

## 为什么冰面线不会弯、不会断

普通逐像素光流会让低纹理冰面和高对比直线一起被局部匹配拉扯。这里将场景分成：

- **静态冰面/标线层**：时间高百分位背景板；直线和圆圈直接来自静态层，不接受逐块形变。
- **刚性冰壶层**：位移 + 旋转模型；碰撞时切换运动分支。
- **刷子层**：端点层运动变换，保留动态模糊外观，避免跨多个方向取中位数造成拖影。
- **遮挡恢复**：端点 Alpha Matting 和层顺序处理“刷子挡住冰壶又移开”的区域；冰壶规范层可由多帧对齐中位数剔除偶发刷子颜色。

因此测试中的红色 T 线始终保持矩形直线，不会随光流弯曲。

## WebGPU / WebCodecs 边界

- `src/webgpu/shaders.ts`
  - 16×16 块 SAD 运动估计 compute shader。
  - 双线性双向 warp compute shader，带静态背景板置信度混合。
- `src/webgpu/WebGpuFrameEngine.ts`
  - GPUDevice 初始化、buffer/texture 数据上传、compute pass、readback。
- `src/codecs/webcodecsDecoder.ts`
  - `mp4box` 解封装 + `VideoDecoder`。
- `src/codecs/webcodecsExporter.ts`
  - RGBA → `VideoFrame` → `VideoEncoder` → `mp4-muxer`。

质量指标测试使用与浏览器相同的物体模型和轨迹代码的 TypeScript CPU 参考实现，这样在无 WebGPU 适配器的 CI/无头环境中也能验证算法。运动估计页的 “WebGPU compute 内核自检” 会在有 adapter 的 Chrome/Edge 中真实创建 device、编译 WGSL、执行 `estimateBlocks()` 和一次 `interpolatePair()` readback；`src/webgpu/WebGpuFrameEngine.ts` 也可作为稠密 ME/warp 后端接入批量导出。当前默认导出优先使用已验证 PSNR 和碰撞保持的物体感知层路径，并在不支持 WebCodecs/WebGPU 时给出明确降级提示。

## 客观验证

```bash
npm test
```

测试渲染 91 帧 640×360/120 fps 场景，每 4 帧抽成 30 fps，再插回 68 个 held-out 相位。最近一次结果：

| 场景 | 平均帧 PSNR | 最低帧 PSNR | 结论 |
|---|---:|---:|---|
| 正面对撞 `head-on` | 37.9 dB | 35.2 dB | 全部 ≥32 dB |
| 斜向擦碰 `glancing` | 37.6 dB | 34.9 dB | 全部 ≥32 dB |
| 大本营压线 `finish-line` | 41.5 dB | 38.7 dB | 全部 ≥32 dB |
| 刷冰遮挡 `sweep` | 36.8 dB | 32.3 dB | 全部 ≥32 dB |

1280×720 下抽查 `glancing` 平均约 39.1 dB/最低 35.6 dB，`sweep` 平均约 36.3 dB/最低 32.1 dB。

`tests/metrics.test.ts` 还检查：

- 所有场景的序列/平均/最低 PSNR ≥ 32 dB。
- T 线红色像素相对拟合位置的偏差、覆盖率和最大缺口；直线标准差必须小于 1.6 px。

`tests/collision.test.ts` 对碰撞前后 4 个 30 fps 间隔 × 8 倍慢放相位（共 28 帧）检查：

- 与对应 120 fps 真值的 PSNR > 31.5 dB。
- 前景连通域不超过两个冰壶大小。
- 单个连通域面积不超过约 2.85 个冰壶圆盘，排除“旧壶 + 新壶”交叉淡化形成的第三/第四个重影团块。

## 合成测试视频

`src/core/render/curlingScene.ts` 是无外部素材依赖的软件光栅器，包含：

- 低纹理冰面、冰面颗粒、划痕。
- 标准配色的大本营同心圆、中线、T 线、Hog Line 和边线。
- 带花岗岩渐变、阴影和旋转手柄的冰壶。
- 弹性碰撞与重叠修正。
- 末段恒摩擦减速直到停止。
- 高速往复刷子、刷柄、刷头和方向动态模糊。

`scripts/render-clips.ts` 将 RGBA 原始帧通过管道送入 ffmpeg，生成 `public/samples/curling-*.mp4`。这些 MP4 是实际 H.264 文件，不是图片序列占位。

## 目录结构

```text
src/
  codecs/           WebCodecs 解码/导出
  core/
    image.ts        RGBA、双线性采样、PSNR
    matcher.ts      SAD 模板位移匹配
    tracker.ts      背景板、冰壶/刷子跟踪
    interpolator.ts 轨迹、层抽取、Alpha 合成、LRU
    pipeline.ts     30 fps 准备和逐相位插帧
    render/         冰壶联赛合成测试渲染器
  ui/               四个页面与共享状态
  webgpu/           WebGPU 设备、WGSL、compute 引擎
public/samples/     ffmpeg 生成的四种测试 MP4
scripts/            渲染素材和 1080p 性能脚本
tests/              PSNR、标线、碰撞测试
```

## 已知边界

- 无头 Chrome 在本机没有返回 WebGPU adapter，因此仓库测试验证 CPU 参考路径和 WGSL/TypeScript 编译，不伪造 WebGPU 跑分。
- 真实比赛视频若摄像机明显移动，需要先加入全局仿射/单应估计；当前合成测试为固定转播机位，背景板模型最稳定。
- 高速刷子仍可能在运动反转点出现局部误差；测试场景已将其控制在全帧 32 dB 线以上，并使用端点层变换而非全帧混合来避免明显重影。

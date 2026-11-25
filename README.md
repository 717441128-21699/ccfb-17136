# 冰壶慢镜插帧工作台

一个面向小型冰壶网络转播的 TypeScript Web 应用：导入录像 → 运动估计 → 慢放预览 → WebCodecs 导出。针对冰面低纹理、刚性线/圈、圆形壶与旋转手柄、快速模糊刷子、碰撞方向突变和遮挡恢复做了物体感知插帧。

## 快速开始

```bash
npm install
npm run dev
```

打开 Chrome/Edge 最新版。WebGPU 与 WebCodecs 状态会显示在右上角；不支持 WebGPU 时自动使用同一套物体轨迹算法的 CPU 参考实现，便于在 CI/Node 中验证指标。

生产构建：

```bash
npm run build
npm run preview
```

## 四个页面

1. **录像导入页**
   - 选择本地视频：MP4Box 解封装，`VideoDecoder`（WebCodecs）解码为分析代理帧。
   - 一键载入五种确定性合成冰壶场面。
   - 可直接用 `VideoEncoder` + `mp4-muxer` 渲染测试 MP4。
2. **运动估计页**
   - 冰面时间中位数底板与遮挡修复。
   - 红色/黄色手柄检测、花岗岩低饱和圆形评分、轨迹关联。
   - 碰撞区间用前后速度求解 kink 时刻，避免线性切角。
   - 刷头检测、相邻端点匹配和真实像素残差层。
   - 画布叠加轨迹、帧间速度向量和手柄方向。
   - 可运行 WebGPU WGSL 块 SAD 运动估计/双向插值 pass。
3. **慢放预览页**
   - 4×（重建 120fps 相位）和 8×（240fps 输出相位）。
   - 物体感知、WebGPU 块匹配、旧版重复帧三种后端对照。
   - 播放/拖动到碰撞或压线中间相位检查重影。
4. **导出页**
   - 入点/出点、放慢倍数、1080p/720p/代理分辨率。
   - 顺序生成中间帧，`VideoEncoder` 编码 H.264，MP4 快速启动封装并下载。
   - 物体感知后端或 WebGPU 后端。

## 自检与基准

五种自渲染场面：

- `head-on`：两壶正面碰撞后反向；
- `glancing`：斜线擦撞，静止壶突然启动；
- `line-press`：末段减速，判断是否压 tee line；
- `sweep`：两把快速横移刷子反复遮挡壶和线；
- `collision-sweep`：碰撞瞬间刷子掠过。

渲染测试 MP4：

```bash
npm run render:clips -- --width=1280 --height=720 --fps=30 --seconds=3
```

输出到 `test-clips/*.mp4`。

PSNR/线条/重影基准：120fps 场景每 4 帧抽成 30fps，再重建 `u=1/4,1/2,3/4` 与原 120fps 真值比较：

```bash
npm run benchmark
```

最近一次 1080p 结果（本机 Node CPU 参考实现）：

| 场面 | 最低 PSNR | 平均 PSNR | 直线断裂 | 线条分 |
|---|---:|---:|---:|---:|
| 正面相撞 | 34.27 dB | 35.83 dB | 0 | 99.7 |
| 斜线擦撞 | 34.84 dB | 36.36 dB | 0 | 99.7 |
| 末段压线 | 40.85 dB | 41.33 dB | 0 | 99.7 |
| 快速刷冰 | 33.04 dB | 36.23 dB | 0 | 99.7 |
| 碰撞+刷冰 | 32.55 dB | 34.32 dB | 0 | 99.7 |

完整 JSON 写入 `reports/benchmark-report.json`。

10 秒 1080p、8× 插帧性能：

```bash
npm run perf -- --width=1920 --height=1080 --frames=300 --factor=8
```

最近一次结果：运动估计约 12.6s，生成 2093 张额外中间帧约 11.3s，总计约 **23.9s**，低于一分钟（不含浏览器 H.264 编码/封装）。WebGPU 块匹配 pass 用于浏览器端进一步降低全像素计算时间。

自动化测试：

```bash
npm test
```

## 为什么线条不会弯、不会断

普通全画面 optical-flow warp 会把低纹理冰面和直线一起拉扯。这里把冰面当作刚性层：

1. 多帧时间中位数恢复无物体冰面；
2. 用轨迹掩膜从没有物体的样本像素修复被壶/刷子长期覆盖的位置；
3. 合成时先贴这张刚性底板，再放壶和刷子层；
4. 直线/圆圈像素不经过逐像素 flow warp。

因此线条只可能被真实运动物体遮挡，不会因插帧向量弯曲或撕裂。基准的线条偏差检查只统计房屋圈外、未被物体遮挡的连续红色直线段。

## 为什么碰撞不容易重影

碰撞区间不能简单在两个圆心之间线性插值。算法使用碰撞前速度 `v0`、碰撞后速度 `v1` 和端点位移求解 kink 时刻 `tc`：

```text
p1 - p0 = v0 * tc + v1 * (1 - tc)
```

然后在 `[0,tc]` 用碰撞前速度、`[tc,1]` 用碰撞后速度放置**一个**壶层。不是把两端壶半透明叠加，所以不会出现双壶重影。手柄角度沿轨迹解包并插值，保持旋转连续。

## 遮挡处理

壶使用高置信帧提取的圆形 RGBA sprite；当刷子挡住当前帧时，仍可从干净参考帧变换壶身和手柄。刷子使用端点真实像素残差层：

- 冰面底板 + 壶生成预测底；
- 与端点帧做颜色差得到刷子/模糊残差；
- 刷头检测给出轴线和位置；
- 对称细长掩膜只保留该刷子走廊内的真实像素；
- 相邻端点刷头匹配后平移到中间相位。

这样避免大胶囊把附近第二把刷子或花岗岩边缘重复贴入。

## WebGPU 模块

`src/gpu/webgpuInterpolator.ts` 包含两个 WGSL compute shader：

- `estimate`：16×16 块、±24px、步长 2 的灰度 SAD 搜索，写入每块 `mv.xy`；
- `interpolate`：按 `u` 做双向运动补偿和双线性采样，输出 RGBA。

浏览器支持 WebGPU 时，运动页可运行单帧 GPU 验证，预览/导出可选择 WebGPU 后端。物体轨迹拟合和层排序是少量控制面 TypeScript 计算；重像素 SAD/采样可走 WGSL。Node/CI 没有 WebGPU 时使用 `src/core/motion.ts` 的同数学 CPU 参考路径完成指标验证。

## WebCodecs 模块

- 导入：`src/webcodecs/videoImporter.ts`
- 导出：`src/webcodecs/exporter.ts`

Chrome/Edge 要求安全上下文（`localhost` 或 HTTPS）。WebCodecs 与 WebGPU 的具体编码/适配器支持以浏览器实现为准。

## 目录

```text
src/core/             场景渲染、视觉检测、轨迹/kink、插帧、指标
src/gpu/              WebGPU WGSL 块匹配与插值
src/webcodecs/        MP4Box + VideoDecoder、VideoEncoder + mp4-muxer
tests/                Vitest 验收测试
scripts/              benchmark、性能、测试录像渲染、诊断脚本
test-clips/           生成的 MP4（git 忽略）
reports/              JSON 指标报告（git 忽略）
```

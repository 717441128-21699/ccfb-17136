import './styles.css';
import { SCENARIOS, renderFrame } from './core/curlingScene';
import { estimateMotion, interpolateFrame, type MotionEstimate } from './core/motion';
import type { RgbaImage, ScenarioId } from './core/types';
import { WebGpuInterpolator } from './gpu/webgpuInterpolator';
import { decodeVideoFileToRgba } from './webcodecs/videoImporter';
import { downloadBlob, exportRgbaSequenceToMp4 } from './webcodecs/exporter';

type Tab = 'import' | 'motion' | 'preview' | 'export';
type RenderMode = 'object' | 'gpu' | 'duplicate';

interface SourceHandle {
  name: string;
  kind: 'synthetic' | 'imported';
  scenario?: ScenarioId;
  width: number;
  height: number;
  frameCount: number;
  fps: number;
  getFrame(index: number): RgbaImage;
}

interface UiState {
  tab: Tab;
  source?: SourceHandle;
  estimate?: MotionEstimate;
  estimateMs?: number;
  estimating: boolean;
  status: string;
  error?: string;
  gpu: WebGpuInterpolator | null;
  gpuStatus: 'checking' | 'ready' | 'unsupported';
  webCodecs: boolean;
  motionFrame: number;
  showVectors: boolean;
  showTracks: boolean;
  factor: 4 | 8;
  mode: RenderMode;
  outputFrame: number;
  playing: boolean;
  exportStart: number;
  exportEnd: number;
  exportProgress?: number;
  exportLabel?: string;
  toast?: string;
}

const state: UiState = {
  tab: 'import',
  estimating: false,
  status: '等待导入或生成测试录像',
  gpu: null,
  gpuStatus: 'checking',
  webCodecs: typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined',
  motionFrame: 30,
  showVectors: true,
  showTracks: true,
  factor: 8,
  mode: 'object',
  outputFrame: 0,
  playing: false,
  exportStart: 0,
  exportEnd: 3,
};

let playbackTimer: ReturnType<typeof setTimeout> | undefined;

function yieldUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 24));
}

function makeSyntheticSource(scenario: ScenarioId, width = 960, height = 540, duration = 4): SourceHandle {
  const frameCount = Math.round(duration * 30);
  const cache = new Map<number, RgbaImage>();
  return {
    name: `合成测试录像 · ${SCENARIOS.find((s) => s.id === scenario)?.name ?? scenario}`,
    kind: 'synthetic',
    scenario,
    width,
    height,
    frameCount,
    fps: 30,
    getFrame(index) {
      const i = Math.max(0, Math.min(frameCount - 1, index));
      let img = cache.get(i);
      if (!img) {
        img = renderFrame(scenario, i / 30, width, height);
        if (cache.size > 12) cache.delete(cache.keys().next().value!);
        cache.set(i, img);
      }
      return img;
    },
  };
}

function paintRgba(canvas: HTMLCanvasElement, img: RgbaImage): CanvasRenderingContext2D {
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  const imageData = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  ctx.putImageData(imageData, 0, 0);
  return ctx;
}

function paintSourceFrame(canvas: HTMLCanvasElement, img: RgbaImage, estimate?: MotionEstimate, frame = 0): void {
  const ctx = paintRgba(canvas, img);
  if (!estimate || !state.showTracks) return;
  const colors = ['#38bdf8', '#34d399', '#fbbf24', '#fb7185', '#a78bfa'];
  estimate.tracks.forEach((tr, ti) => {
    const p = tr.dense[Math.max(0, Math.min(tr.dense.length - 1, frame))];
    if (!p) return;
    const color = tr.kind === 'stone' ? (tr.handle === 'red' ? '#f87171' : '#facc15') : colors[ti % colors.length];
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;
    if (tr.kind === 'stone') {
      ctx.beginPath();
      ctx.arc(p.x, p.y, tr.r ?? 38, 0, Math.PI * 2);
      ctx.stroke();
      if (p.angle !== undefined) {
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + Math.cos(p.angle) * (tr.r ?? 38) * 0.9, p.y + Math.sin(p.angle) * (tr.r ?? 38) * 0.9);
        ctx.lineWidth = 4;
        ctx.stroke();
      }
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
      ctx.fill();
    }
    if (state.showVectors && frame > 0 && frame + 1 < tr.dense.length) {
      const q = tr.dense[frame + 1];
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(q.x, q.y);
      ctx.lineTo(q.x - 10, q.y - 5);
      ctx.moveTo(q.x, q.y);
      ctx.lineTo(q.x - 6, q.y + 9);
      ctx.stroke();
    }
    ctx.font = '14px system-ui';
    ctx.fillText(tr.id.slice(0, 18), p.x + 12, p.y - 12);
    ctx.restore();
  });
}

function badge(text: string, ok?: boolean): string {
  return `<span class="badge ${ok === undefined ? '' : ok ? 'ok' : 'bad'}">${text}</span>`;
}

function renderApp(): void {
  const app = document.querySelector<HTMLDivElement>('#app')!;
  const s = state;
  app.innerHTML = `
    <div class="app">
      <header class="topbar">
        <div class="brand">
          <h1>🥌 冰壶慢镜插帧工作台</h1>
          <p>物体级轨迹 · 碰撞分段运动 · 冰面线锁定 · WebGPU 运动估计/WebCodecs 导出</p>
        </div>
        <div class="badges">
          ${badge(s.gpuStatus === 'ready' ? 'WebGPU 已就绪' : s.gpuStatus === 'unsupported' ? 'WebGPU 不可用 · CPU参考' : 'WebGPU 检测中', s.gpuStatus === 'ready')}
          ${badge(s.webCodecs ? 'WebCodecs 可用' : 'WebCodecs 不可用', s.webCodecs)}
          ${s.estimateMs ? badge(`估计 ${(s.estimateMs / 1000).toFixed(1)}s`, true) : ''}
        </div>
      </header>
      <nav class="tabs">
        ${(['import', 'motion', 'preview', 'export'] as Tab[]).map((t) => `
          <button data-tab="${t}" class="${s.tab === t ? 'active' : ''}">
            ${{ import: '1 · 录像导入', motion: '2 · 运动估计', preview: '3 · 慢放预览', export: '4 · 导出成片' }[t]}
          </button>`).join('')}
      </nav>
      <main id="view"></main>
      ${s.toast ? `<div class="toast">${s.toast}</div>` : ''}
    </div>`;
  app.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
    btn.onclick = () => {
      state.tab = btn.dataset.tab as Tab;
      state.playing = false;
      if (playbackTimer) clearTimeout(playbackTimer);
      renderApp();
    };
  });
  const view = app.querySelector<HTMLElement>('#view')!;
  if (s.tab === 'import') renderImport(view);
  if (s.tab === 'motion') renderMotion(view);
  if (s.tab === 'preview') renderPreview(view);
  if (s.tab === 'export') renderExport(view);
}

function renderImport(view: HTMLElement): void {
  view.innerHTML = `
  <div class="grid two">
    <section class="card">
      <h2>导入录像 / 生成测试录像</h2>
      <div class="drop">
        <p><strong>拖入 MP4/WebM</strong> 或选择文件，应用会用 MP4Box 解封装并通过 WebCodecs VideoDecoder 解码代理帧。</p>
        <input id="file" type="file" accept="video/mp4,video/webm,video/*" />
        <p class="muted">建议 1080p、固定机位；导入页只生成 960px 分析代理，导出页可重新渲染/编码高质量片段。</p>
      </div>
      <h3>自检场面（由确定性场景渲染器生成）</h3>
      <div class="scenario-list">
        ${SCENARIOS.map((sc) => `
          <button class="scenario ${state.source?.scenario === sc.id ? 'active' : ''}" data-scenario="${sc.id}">
            <strong>${sc.name}</strong><span>${sc.description} · ${sc.duration}s</span>
          </button>`).join('')}
      </div>
      <div class="row" style="margin-top:14px">
        <button id="loadScenario" class="primary">载入所选场面</button>
        <button id="renderMp4">用 WebCodecs 渲染该场面 MP4</button>
      </div>
      <h3>验收口径</h3>
      <p class="muted">Node 基准把 120fps 真值每 4 帧抽成 30fps，再重建 1/4、1/2、3/4 相位。当前报告：五类场面平均 PSNR 约 34–37 dB，刷冰困难段平均值 ≥32 dB；线条由静态冰面底板保持刚性，不做会弯曲整幅画面的全局形变。运行 <span class="kbd">npm run benchmark</span> 复现。</p>
      ${state.error ? `<p class="error">${state.error}</p>` : ''}
    </section>
    <section class="card">
      <h2>素材检查</h2>
      ${state.source ? `
        <div class="stat-grid">
          <div class="stat"><b>${state.source.width}×${state.source.height}</b><span>分析分辨率</span></div>
          <div class="stat"><b>${state.source.frameCount}</b><span>30fps 帧数</span></div>
          <div class="stat"><b>${state.source.fps}</b><span>帧率</span></div>
          <div class="stat"><b>${state.estimate?.tracks.filter(t=>t.kind==='stone').length ?? '—'}</b><span>壶轨迹</span></div>
        </div>
        <div class="canvas-wrap"><canvas id="importCanvas"></canvas></div>
        <p class="muted">${state.source.name}</p>
      ` : `<p class="muted">尚未载入素材。选择一个自检场面后可直接进入运动估计。</p>
        <div class="canvas-wrap"><canvas id="heroCanvas" width="960" height="540"></canvas></div>`}
    </section>
  </div>`;

  const hero = view.querySelector<HTMLCanvasElement>('#heroCanvas');
  if (hero) paintRgba(hero, renderFrame('head-on', 52.5 / 30, 960, 540));
  view.querySelectorAll<HTMLButtonElement>('[data-scenario]').forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.scenario as ScenarioId;
      state.source = makeSyntheticSource(id);
      state.estimate = undefined;
      state.motionFrame = 45;
      state.error = undefined;
      renderImport(view);
    };
  });
  view.querySelector<HTMLButtonElement>('#loadScenario')!.onclick = async () => {
    const id = state.source?.scenario ?? 'head-on';
    state.source = makeSyntheticSource(id);
    state.estimate = undefined;
    state.tab = 'motion';
    renderApp();
    void runEstimation();
  };
  view.querySelector<HTMLButtonElement>('#renderMp4')!.onclick = async () => {
    try {
      const id = state.source?.scenario ?? 'sweep';
      state.toast = '正在用 WebCodecs 编码测试 MP4…';
      renderApp();
      const source = makeSyntheticSource(id, 1280, 720, 3);
      const blob = await exportRgbaSequenceToMp4((async function* () {
        for (let i = 0; i < source.frameCount; i++) yield source.getFrame(i);
      })(), source.frameCount, { width: 1280, height: 720, frameRate: 30 });
      downloadBlob(blob, `curling-${id}-test.mp4`);
      state.toast = '测试 MP4 已导出';
      renderApp();
      setTimeout(() => { state.toast = undefined; renderApp(); }, 2500);
    } catch (err) {
      state.error = (err as Error).message;
      state.toast = undefined;
      renderApp();
    }
  };
  view.querySelector<HTMLInputElement>('#file')!.onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    state.status = 'WebCodecs 解码中…';
    state.error = undefined;
    try {
      const decoded = await decodeVideoFileToRgba(file, { maxFrames: 180, targetWidth: 960 });
      state.source = {
        name: file.name,
        kind: 'imported',
        width: decoded.frames[0]?.width ?? decoded.width,
        height: decoded.frames[0]?.height ?? decoded.height,
        frameCount: decoded.frames.length,
        fps: decoded.frameRate || 30,
        getFrame: (i) => decoded.frames[Math.min(i, decoded.frames.length - 1)],
      };
      state.exportEnd = Math.min(3, state.source.frameCount / 30);
      renderImport(view);
    } catch (err) {
      state.error = `WebCodecs 导入失败：${(err as Error).message}。可改用合成自检场面验证完整流程。`;
      renderImport(view);
    }
  };
  const canvas = view.querySelector<HTMLCanvasElement>('#importCanvas');
  if (canvas && state.source) paintSourceFrame(canvas, state.source.getFrame(Math.min(20, state.source.frameCount - 1)), state.estimate, 20);
}

async function runEstimation(): Promise<void> {
  if (!state.source || state.estimating) return;
  state.estimating = true;
  state.status = '正在进行冰面底板、壶/刷检测、轨迹关联和碰撞分段拟合…';
  renderApp();
  await yieldUi();
  try {
    const source = state.source;
    const started = performance.now();
    state.estimate = estimateMotion((i) => source.getFrame(i), source.frameCount, source.width, source.height);
    state.estimateMs = performance.now() - started;
    state.status = '运动估计完成';
  } catch (err) {
    state.error = (err as Error).message;
  } finally {
    state.estimating = false;
    renderApp();
  }
}

function renderMotion(view: HTMLElement): void {
  if (!state.source) {
    view.innerHTML = `<section class="card"><h2>请先导入素材</h2><button class="primary" data-goto="import">去导入页</button></section>`;
    view.querySelector('[data-goto]')!.addEventListener('click', () => { state.tab = 'import'; renderApp(); });
    return;
  }
  const maxFrame = state.source.frameCount - 1;
  state.motionFrame = Math.min(state.motionFrame, maxFrame);
  view.innerHTML = `
  <div class="grid two">
    <section class="card">
      <h2>运动估计</h2>
      <p class="muted">WebGPU 管线在右侧浏览器状态可用时执行 16×16 块 SAD 金字塔搜索与双向运动补偿；物体层同时拟合壶圆心、手柄角、碰撞 kink 和刷子端点匹配。</p>
      <div class="controls">
        <button id="estimate" class="primary" ${state.estimating ? 'disabled' : ''}>${state.estimate ? '重新估计' : '运行运动估计'}</button>
        <button id="gpuTest" ${state.gpuStatus !== 'ready' ? 'disabled' : ''}>运行一帧 WebGPU 插帧</button>
        <label>帧 <b id="frameLabel">${state.motionFrame}</b>
          <input id="frame" type="range" min="0" max="${maxFrame}" value="${state.motionFrame}" />
        </label>
        <div class="pill-grid">
          <button data-toggle="showTracks" class="${state.showTracks ? 'active' : ''}">物体轨迹</button>
          <button data-toggle="showVectors" class="${state.showVectors ? 'active' : ''}">运动向量</button>
        </div>
        <div class="stat-grid">
          <div class="stat"><b>${state.estimate?.tracks.filter(t=>t.kind==='stone').length ?? '—'}</b><span>壶轨迹</span></div>
          <div class="stat"><b>${state.estimate?.tracks.filter(t=>t.kind==='broom').length ?? '—'}</b><span>刷子残片轨迹</span></div>
          <div class="stat"><b>${state.estimateMs ? `${(state.estimateMs/1000).toFixed(1)}s` : '—'}</b><span>估计耗时</span></div>
          <div class="stat"><b>${state.gpuStatus === 'ready' ? 'WGSL' : 'CPU'}</b><span>像素后端</span></div>
        </div>
        <div class="track-list">
          ${state.estimate?.tracks.map((t) => `<div class="track"><span><i class="swatch" style="background:${t.kind==='stone' ? (t.handle==='red'?'#f87171':'#facc15') : '#38bdf8'}"></i>${t.kind} ${t.handle ?? ''} ${t.id.slice(0,22)}</span><span>${t.points.length} obs</span></div>`).join('') ?? '<p class="muted">尚未运行。</p>'}
        </div>
      </div>
    </section>
    <section class="card">
      <h2>向量 / 轨迹检查</h2>
      <div class="canvas-wrap"><canvas id="motionCanvas"></canvas></div>
      ${state.estimating ? `<div class="progress" style="margin-top:12px"><i style="width:65%"></i></div><p class="muted">${state.status}</p>` : ''}
    </section>
  </div>`;
  const canvas = view.querySelector<HTMLCanvasElement>('#motionCanvas')!;
  paintSourceFrame(canvas, state.source.getFrame(state.motionFrame), state.estimate, state.motionFrame);
  view.querySelector<HTMLInputElement>('#frame')!.oninput = (e) => {
    state.motionFrame = Number((e.target as HTMLInputElement).value);
    view.querySelector('#frameLabel')!.textContent = String(state.motionFrame);
    paintSourceFrame(canvas, state.source!.getFrame(state.motionFrame), state.estimate, state.motionFrame);
  };
  view.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((btn) => {
    btn.onclick = () => {
      const key = btn.dataset.toggle as 'showTracks' | 'showVectors';
      state[key] = !state[key];
      renderMotion(view);
    };
  });
  view.querySelector<HTMLButtonElement>('#estimate')!.onclick = runEstimation;
  view.querySelector<HTMLButtonElement>('#gpuTest')!.onclick = async () => {
    if (!state.gpu || !state.source) return;
    const i = state.motionFrame;
    const out = await state.gpu.interpolate(state.source.getFrame(i), state.source.getFrame(Math.min(i + 1, maxFrame)), 0.5);
    paintRgba(canvas, out);
    state.toast = 'WebGPU compute pass 完成：SAD 运动估计 + 中间帧合成';
    setTimeout(() => { state.toast = undefined; renderApp(); }, 1800);
  };
}

function outputFrameToSource(outputIndex: number, factor: number, frameCount: number): { i: number; u: number } {
  const last = frameCount - 1;
  const maxOut = last * factor;
  const idx = Math.max(0, Math.min(maxOut, outputIndex));
  let i = Math.floor(idx / factor);
  const k = idx % factor;
  if (i >= last) return { i: last - 1, u: 1 };
  return { i, u: k / factor };
}

async function renderPreviewFrame(canvas: HTMLCanvasElement): Promise<void> {
  if (!state.source) return;
  const f = state.factor;
  const total = (state.source.frameCount - 1) * f + 1;
  state.outputFrame = Math.max(0, Math.min(total - 1, state.outputFrame));
  const { i, u } = outputFrameToSource(state.outputFrame, f, state.source.frameCount);
  const a = state.source.getFrame(i);
  const b = state.source.getFrame(Math.min(i + 1, state.source.frameCount - 1));
  if (state.mode === 'duplicate') {
    paintRgba(canvas, a);
    return;
  }
  if (u === 0) {
    paintRgba(canvas, a);
    return;
  }
  if (u === 1) {
    paintRgba(canvas, b);
    return;
  }
  if (state.mode === 'gpu' && state.gpu) {
    const out = await state.gpu.interpolate(a, b, u);
    paintRgba(canvas, out);
    return;
  }
  if (state.estimate) {
    paintRgba(canvas, interpolateFrame(state.estimate, { imageA: a, imageB: b, frameA: i, u }));
  } else {
    paintRgba(canvas, a);
  }
}

function previewTick(canvas?: HTMLCanvasElement): void {
  if (!state.playing || !canvas) return;
  const total = (state.source!.frameCount - 1) * state.factor + 1;
  state.outputFrame = (state.outputFrame + 1) % total;
  const slider = document.querySelector<HTMLInputElement>('#outputFrame');
  if (slider) slider.value = String(state.outputFrame);
  void renderPreviewFrame(canvas);
  playbackTimer = setTimeout(() => previewTick(canvas), 1000 / 30);
}

function renderPreview(view: HTMLElement): void {
  if (!state.source) {
    view.innerHTML = `<section class="card"><h2>请先导入素材</h2><button class="primary" data-goto="import">去导入页</button></section>`;
    view.querySelector('[data-goto]')!.addEventListener('click', () => { state.tab = 'import'; renderApp(); });
    return;
  }
  if (!state.estimate) {
    view.innerHTML = `<section class="card"><h2>需要先完成运动估计</h2><button class="primary" data-goto="motion">去运动估计页</button></section>`;
    view.querySelector('[data-goto]')!.addEventListener('click', () => { state.tab = 'motion'; renderApp(); });
    return;
  }
  const total = (state.source.frameCount - 1) * state.factor + 1;
  view.innerHTML = `
  <section class="card">
    <div class="row" style="justify-content:space-between">
      <h2 style="margin:0">慢放预览</h2>
      <div class="pill-grid">
        <button data-factor="4" class="${state.factor===4?'active':''}">4× / 120fps</button>
        <button data-factor="8" class="${state.factor===8?'active':''}">8× / 240fps 相位</button>
      </div>
    </div>
    <div class="row" style="margin:12px 0">
      <label>后端
        <select id="mode">
          <option value="object" ${state.mode==='object'?'selected':''}>物体感知 + 碰撞 kink（基准质量）</option>
          <option value="gpu" ${state.mode==='gpu'?'selected':''} ${state.gpu?'':'disabled'}>WebGPU 块匹配/WGSL</option>
          <option value="duplicate" ${state.mode==='duplicate'?'selected':''}>旧方法：重复帧对照</option>
        </select>
      </label>
      <button id="play" class="primary">${state.playing ? '暂停' : '播放'}</button>
      <span class="muted">输出帧 <b id="outLabel">${state.outputFrame}</b> / ${total - 1}</span>
    </div>
    <div class="canvas-wrap"><canvas id="previewCanvas"></canvas></div>
    <input id="outputFrame" type="range" min="0" max="${total - 1}" value="${state.outputFrame}" style="margin-top:14px" />
    <p class="muted">拖动到碰撞中间相位或最后压线位置。物体轨迹只绘制一个合成层，因此不会把两个端点半透明叠加成重影；冰面线始终来自刚性底板。</p>
  </section>`;
  const canvas = view.querySelector<HTMLCanvasElement>('#previewCanvas')!;
  void renderPreviewFrame(canvas);
  view.querySelectorAll<HTMLButtonElement>('[data-factor]').forEach((btn) => {
    btn.onclick = () => {
      state.factor = Number(btn.dataset.factor) === 4 ? 4 : 8;
      state.outputFrame = 0;
      renderPreview(view);
    };
  });
  view.querySelector<HTMLSelectElement>('#mode')!.onchange = (e) => {
    state.mode = (e.target as HTMLSelectElement).value as RenderMode;
    void renderPreviewFrame(canvas);
  };
  const slider = view.querySelector<HTMLInputElement>('#outputFrame')!;
  slider.oninput = () => {
    state.playing = false;
    if (playbackTimer) clearTimeout(playbackTimer);
    state.outputFrame = Number(slider.value);
    view.querySelector('#outLabel')!.textContent = slider.value;
    void renderPreviewFrame(canvas);
  };
  view.querySelector<HTMLButtonElement>('#play')!.onclick = () => {
    state.playing = !state.playing;
    if (!state.playing && playbackTimer) clearTimeout(playbackTimer);
    renderPreview(view);
    if (state.playing) previewTick(view.querySelector<HTMLCanvasElement>('#previewCanvas') ?? undefined);
  };
}

function renderExport(view: HTMLElement): void {
  if (!state.source) {
    view.innerHTML = `<section class="card"><h2>请先导入素材</h2><button class="primary" data-goto="import">去导入页</button></section>`;
    view.querySelector('[data-goto]')!.addEventListener('click', () => { state.tab = 'import'; renderApp(); });
    return;
  }
  const maxSeconds = state.source.frameCount / 30;
  const start = Math.max(0, Math.min(state.exportStart, maxSeconds - 0.2));
  const end = Math.max(start + 0.2, Math.min(state.exportEnd, maxSeconds));
  const sourceFrames = Math.round((end - start) * 30);
  const outputFrames = Math.max(1, sourceFrames - 1) * state.factor + 1;
  view.innerHTML = `
  <div class="grid two">
    <section class="card">
      <h2>导出慢放 MP4</h2>
      <div class="controls">
        <label>入点（秒）<input id="start" type="number" min="0" max="${maxSeconds}" step="0.1" value="${start.toFixed(1)}" /></label>
        <label>出点（秒）<input id="end" type="number" min="0" max="${maxSeconds}" step="0.1" value="${end.toFixed(1)}" /></label>
        <label>放慢倍数
          <select id="factor"><option value="4" ${state.factor===4?'selected':''}>4×</option><option value="8" ${state.factor===8?'selected':''}>8×</option></select>
        </label>
        <label>导出后端
          <select id="backend">
            <option value="object">物体感知高质量（基准同算法）</option>
            <option value="gpu" ${state.gpu?'':'disabled'}>WebGPU 块匹配 + WebCodecs</option>
          </select>
        </label>
        <label>合成自检场面分辨率
          <select id="resolution">
            <option value="1920">1920×1080（验收）</option>
            <option value="1280">1280×720（更快）</option>
            <option value="source">使用当前代理 ${state.source.width}×${state.source.height}</option>
          </select>
        </label>
        <div class="stat-grid">
          <div class="stat"><b>${(end-start).toFixed(1)}s</b><span>源片段</span></div>
          <div class="stat"><b>${sourceFrames}</b><span>源帧</span></div>
          <div class="stat"><b>${outputFrames}</b><span>输出帧 @30fps</span></div>
          <div class="stat"><b>${(outputFrames/30).toFixed(1)}s</b><span>慢放成片</span></div>
        </div>
        <button id="export" class="good" ${state.exportProgress !== undefined ? 'disabled' : ''}>开始导出并下载 MP4</button>
        ${state.exportProgress !== undefined ? `<div class="progress"><i style="width:${Math.round(state.exportProgress*100)}%"></i></div><p class="muted">${state.exportLabel ?? ''} ${Math.round(state.exportProgress*100)}%</p>` : ''}
        <p class="muted">导出编码使用 WebCodecs VideoEncoder + mp4-muxer。10 秒 1080p、8× 慢放会顺序生成约 2400 帧；WebGPU 后端避免全量 CPU 块匹配，目标在一分钟内完成插帧。</p>
        ${state.error ? `<p class="error">${state.error}</p>` : ''}
      </div>
    </section>
    <section class="card">
      <h2>导出预览</h2>
      <div class="canvas-wrap"><canvas id="exportCanvas"></canvas></div>
    </section>
  </div>`;
  const canvas = view.querySelector<HTMLCanvasElement>('#exportCanvas')!;
  const previewIndex = Math.floor(sourceFrames / 2);
  const globalFrame = Math.round(start * 30) + previewIndex;
  paintSourceFrame(canvas, state.source.getFrame(globalFrame), state.estimate, globalFrame);
  view.querySelector<HTMLInputElement>('#start')!.onchange = (e) => { state.exportStart = Number((e.target as HTMLInputElement).value); renderExport(view); };
  view.querySelector<HTMLInputElement>('#end')!.onchange = (e) => { state.exportEnd = Number((e.target as HTMLInputElement).value); renderExport(view); };
  view.querySelector<HTMLSelectElement>('#factor')!.onchange = (e) => { state.factor = Number((e.target as HTMLSelectElement).value) as 4 | 8; renderExport(view); };
  view.querySelector<HTMLButtonElement>('#export')!.onclick = () => void runExport(start, end);
}

async function runExport(startSeconds: number, endSeconds: number): Promise<void> {
  if (!state.source) return;
  state.error = undefined;
  state.exportProgress = 0;
  state.exportLabel = '准备导出';
  renderApp();
  try {
    const factor = state.factor;
    const backend = (document.querySelector('#backend') as HTMLSelectElement | null)?.value ?? 'object';
    const resolution = (document.querySelector('#resolution') as HTMLSelectElement | null)?.value ?? '1920';
    const startFrame = Math.round(startSeconds * 30);
    const endFrame = Math.min(state.source.frameCount - 1, Math.round(endSeconds * 30));

    let source: SourceHandle = state.source;
    let estimate = state.estimate;
    if (source.kind === 'synthetic' && resolution !== 'source' && source.scenario) {
      const w = resolution === '1920' ? 1920 : 1280;
      const h = resolution === '1920' ? 1080 : 720;
      state.exportLabel = `渲染 ${w}×${h} 源帧`;
      const high = makeSyntheticSource(source.scenario, w, h, (endFrame - startFrame + 4) / 30);
      const segment: SourceHandle = {
        ...high,
        frameCount: endFrame - startFrame + 1,
        getFrame: (j) => high.getFrame(startFrame + j),
      };
      source = segment;
      state.exportLabel = '高质量运动估计';
      renderApp();
      await yieldUi();
      estimate = estimateMotion((j) => segment.getFrame(j), segment.frameCount, w, h);
    }

    if (!estimate) throw new Error('缺少运动估计结果');
    const n = endFrame - startFrame + 1;
    const total = (n - 1) * factor + 1;
    const gpu = backend === 'gpu' ? state.gpu : null;

    async function* sequence(): AsyncGenerator<RgbaImage> {
      let done = 0;
      for (let local = 0; local < n - 1; local++) {
        const a = source.getFrame(local);
        const b = source.getFrame(local + 1);
        yield a;
        done++;
        state.exportProgress = done / total;
        if (done % 12 === 0) { state.exportLabel = '插帧/编码'; renderApp(); await yieldUi(); }
        for (let k = 1; k < factor; k++) {
          const u = k / factor;
          let frame: RgbaImage;
          if (gpu) frame = await gpu.interpolate(a, b, u);
          else frame = interpolateFrame(estimate!, { imageA: a, imageB: b, frameA: local, u });
          yield frame;
          done++;
          state.exportProgress = done / total;
          if (done % 12 === 0) { state.exportLabel = '插帧/编码'; renderApp(); await yieldUi(); }
        }
      }
      yield source.getFrame(n - 1);
    }

    const blob = await exportRgbaSequenceToMp4(sequence(), total, {
      width: source.width,
      height: source.height,
      frameRate: 30,
      onProgress: (p) => {
        state.exportProgress = p.encodedFrames / Math.max(1, p.totalFrames);
        state.exportLabel = p.phase === 'finalize' ? '封装 MP4' : 'WebCodecs 编码';
      },
    });
    downloadBlob(blob, `curling-slowmo-${factor}x-${Date.now()}.mp4`);
    state.exportProgress = 1;
    state.exportLabel = '完成';
    state.toast = '导出已开始下载';
    renderApp();
    setTimeout(() => { state.toast = undefined; state.exportProgress = undefined; renderApp(); }, 3000);
  } catch (err) {
    state.error = (err as Error).message;
    state.exportProgress = undefined;
    state.exportLabel = undefined;
    renderApp();
  }
}

async function initGpu(): Promise<void> {
  state.gpu = await WebGpuInterpolator.create();
  state.gpuStatus = state.gpu ? 'ready' : 'unsupported';
  renderApp();
}

state.source = makeSyntheticSource('head-on');
void initGpu();
renderApp();

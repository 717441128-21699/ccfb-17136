import { h, icons, icon, yieldToUi, formatBytes } from './dom.ts';
import type { ProjectState, ExportSettings } from './state.ts';
import { mapOutputIndex } from './state.ts';
import type { PageActions } from './importPage.ts';
import { ensureClipFrames } from './clipLoader.ts';
import {
  prepareInterpolation,
  prepareInterpolationWithEstimate,
  interpolatePrepared,
  type PreparedInterpolation,
} from '../core/pipeline.ts';
import { rgbaToCanvas } from '../core/image.ts';
import {
  isWebCodecsAvailable,
  pickEncoderConfig,
  exportFramesToMp4,
  downloadBlob,
  ExportCancelledError,
  type ExportHandle,
} from '../codecs/exportVideo.ts';

/* ---------------- Module-level export job (survives tab switches) ---------------- */

interface ExportJob {
  status: 'preparing' | 'running' | 'done' | 'error' | 'cancelled';
  progress: number;
  total: number;
  phase: string;
  filename: string;
  handle: ExportHandle;
  result?: { blob: Blob; url: string; bytes: number };
  error?: string;
  summary?: string;
}

let activeJob: ExportJob | null = null;
const jobListeners = new Set<() => void>();
function emitJob(): void { for (const fn of [...jobListeners]) fn(); }
function subscribeJob(fn: () => void): () => void {
  jobListeners.add(fn);
  return () => { jobListeners.delete(fn); };
}

function even(v: number): number { return Math.max(2, v - (v % 2)); }

function resolveDimensions(settings: ExportSettings, clipW: number, clipH: number): { width: number; height: number } {
  if (settings.resolution === 'source') return { width: even(clipW), height: even(clipH) };
  const targetH = settings.resolution === '960x540' ? 540
    : settings.resolution === '1280x720' ? 720
      : 1080;
  const scale = targetH / clipH;
  return { width: even(Math.round(clipW * scale)), height: even(targetH) };
}

export function renderExportPage(state: ProjectState, actions: PageActions): HTMLElement {
  const root = h('div', { class: 'page' });

  root.append(
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', { class: 'page-title', text: '导出成片' }),
        h('p', { class: 'page-desc', text: '使用 WebCodecs VideoEncoder 实时编码 H.264 并由 mp4-muxer 封装为 MP4。真实报告编码进度与错误，不提供模拟完成。' }),
      ),
    ),
  );

  if (!state.clip) {
    root.append(buildNoClip(actions));
    return root;
  }

  const clip = state.clip;
  const settings = state.exportSettings;
  const webCodecsOk = isWebCodecsAvailable();

  /* ---------------- Form ---------------- */
  const nameInput = h('input', {
    class: 'text-input',
    type: 'text',
    value: settings.name,
    placeholder: 'curling-slowmo',
    onInput: (e: Event) => { settings.name = (e.target as HTMLInputElement).value; refreshSummary(); },
  }) as HTMLInputElement;

  const resSelect = h('select', {
    class: 'text-input',
    onChange: (e: Event) => { settings.resolution = (e.target as HTMLSelectElement).value as ExportSettings['resolution']; refreshSummary(); void detectCodec(); },
  },
    h('option', { value: 'source', selected: settings.resolution === 'source' }, `源分辨率（${clip.width}×${clip.height}）`),
    h('option', { value: '960x540', selected: settings.resolution === '960x540' }, '960 × 540（保持宽高比）'),
    h('option', { value: '1280x720', selected: settings.resolution === '1280x720' }, '1280 × 720（保持宽高比）'),
    h('option', { value: '1920x1080', selected: settings.resolution === '1920x1080' }, '1920 × 1080（保持宽高比）'),
  ) as HTMLSelectElement;

  const fpsSelect = h('select', {
    class: 'text-input',
    onChange: (e: Event) => { settings.fps = Number((e.target as HTMLSelectElement).value) as ExportSettings['fps']; refreshSummary(); void detectCodec(); },
  },
    h('option', { value: '24', selected: settings.fps === 24 }, '24 fps（电影）'),
    h('option', { value: '30', selected: settings.fps === 30 }, '30 fps（与源一致，倍数即慢放倍率）'),
    h('option', { value: '60', selected: settings.fps === 60 }, '60 fps（更流畅）'),
  ) as HTMLSelectElement;

  const factorSelect = h('select', {
    class: 'text-input',
    onChange: (e: Event) => { settings.factor = Number((e.target as HTMLSelectElement).value) as ExportSettings['factor']; refreshSummary(); },
  },
    h('option', { value: '2', selected: settings.factor === 2 }, '2×（每对源帧 1 个中间帧）'),
    h('option', { value: '4', selected: settings.factor === 4 }, '4×（u=k/4）'),
    h('option', { value: '8', selected: settings.factor === 8 }, '8×（u=k/8）'),
  ) as HTMLSelectElement;

  const summaryHost = h('div', { class: 'stat-grid' });
  const codecHost = h('div', {});

  function computeOutput(): { width: number; height: number; frameCount: number; duration: number; slowRatio: number } {
    const { width, height } = resolveDimensions(settings, clip.width, clip.height);
    const n = clip.frames.length || 1;
    const frameCount = Math.max(1, n - 1) * settings.factor + 1;
    const duration = frameCount / settings.fps;
    const sourceDuration = Math.max(1e-6, (n - 1) / clip.sourceFps);
    const slowRatio = duration / sourceDuration;
    return { width, height, frameCount, duration, slowRatio };
  }

  function refreshSummary(): void {
    const o = computeOutput();
    summaryHost.innerHTML = '';
    const stats: Array<[string, string, string, string?]> = [
      ['输出分辨率', `${o.width}×${o.height}`, '', 'cyan'],
      ['编码帧率', `${settings.fps}`, 'fps'],
      ['总帧数', `${o.frameCount}`, '帧', 'accent'],
      ['成片时长', o.duration.toFixed(1), 's'],
      ['相对源放慢', o.slowRatio.toFixed(1), '×', 'gold'],
      ['估计码率', `${(o.width * o.height * settings.fps * 0.15 / 1e6).toFixed(1)}`, 'Mbps'],
    ];
    for (const [label, value, unit, cls] of stats) {
      summaryHost.append(h('div', { class: `stat ${cls ?? ''}` },
        h('div', { class: 'stat-label', text: label }),
        h('div', { class: 'stat-value' }, value, unit ? h('span', { class: 'stat-unit', text: unit }) : null),
      ));
    }
  }

  async function detectCodec(): Promise<void> {
    codecHost.innerHTML = '';
    if (!webCodecsOk) {
      codecHost.append(
        h('div', { class: 'alert alert-error' },
          h('span', { class: 'alert-ico', html: icons.alert }),
          h('div', {},
            h('b', { text: 'WebCodecs 不可用。' }),
            h('div', { text: '当前浏览器没有 VideoEncoder / VideoFrame，无法在本地编码 MP4。请使用桌面版 Chrome 94+ 或 Edge 94+，并确认未通过不安全的旧环境访问。UI 仍可浏览，但不能导出。' }),
          ),
        ),
      );
      return;
    }
    const o = computeOutput();
    codecHost.append(h('div', { class: 'codec-row' }, h('span', { text: '正在检测 H.264 硬件/软件编码器…' })));
    try {
      const cfg = await pickEncoderConfig(o.width, o.height, settings.fps, Math.round(o.width * o.height * settings.fps * 0.15));
      codecHost.innerHTML = '';
      if (cfg) {
        codecHost.append(
          h('div', { class: 'codec-row' }, h('span', { text: 'WebCodecs 状态' }), h('span', { class: 'badge badge-ok', text: 'VideoEncoder 可用' })),
          h('div', { class: 'codec-row' }, h('span', { text: '首选编码配置' }), h('code', { text: `${cfg.codec} · ${o.width}×${o.height}@${settings.fps}` })),
          h('div', { class: 'codec-row' }, h('span', { text: '封装格式' }), h('code', { text: 'MP4 / H.264 avc1 · fast-start' })),
        );
      }
    } catch (err) {
      codecHost.innerHTML = '';
      codecHost.append(h('div', { class: 'alert alert-warn' },
        h('span', { class: 'alert-ico', html: icons.alert }),
        h('div', { text: `编码器检测出错：${err instanceof Error ? err.message : String(err)}` })));
    }
  }

  /* ---------------- Job card ---------------- */
  const jobHost = h('div', {});
  function renderJob(): void {
    jobHost.innerHTML = '';
    const job = activeJob;
    if (!job) {
      jobHost.append(h('div', { class: 'alert alert-info' },
        h('span', { class: 'alert-ico', html: icons.info }),
        h('div', { text: '导出在本地浏览器进行。8× 与 1080p 会产生较多插帧计算，进度条会实时反映渲染与编码情况，期间可切换到其他标签页，任务不会中断。' })));
      return;
    }

    if (job.status === 'running' || job.status === 'preparing') {
      const pct = job.total > 0 ? Math.min(100, Math.round((job.progress / job.total) * 100)) : 0;
      const bar = h('div', { class: `progress ${job.status === 'preparing' ? 'indeterminate' : ''}` },
        h('div', { class: 'progress-bar' }));
      if (job.status !== 'preparing') (bar.firstElementChild as HTMLElement).style.width = `${pct}%`;
      const cancelBtn = h('button', {
        class: 'btn btn-danger-ghost',
        type: 'button',
        onClick: () => { if (activeJob) activeJob.handle.cancelled = true; },
      }, '取消导出');
      jobHost.append(h('div', { class: 'panel' },
        h('div', { class: 'panel-body stack' },
          h('div', { class: 'flex items-center justify-between wrap gap-12' },
            h('b', { text: job.status === 'preparing' ? '正在准备插值器…' : `正在导出 ${job.filename}` }),
            h('span', { class: 'badge badge-cyan mono', text: job.status === 'preparing' ? '准备中' : `${pct}%` }),
          ),
          h('div', { class: 'progress-row' }, bar, h('span', { class: 'progress-pct', text: job.total ? `${job.progress}/${job.total}` : '—' })),
          h('div', { class: 'progress-label', text: job.phase }),
          h('div', {}, cancelBtn),
        ),
      ));
      return;
    }

    if (job.status === 'cancelled') {
      jobHost.append(h('div', { class: 'alert alert-warn' },
        h('span', { class: 'alert-ico', html: icons.alert }),
        h('div', {}, h('b', { text: '导出已取消。' }), ' 未生成成片，可调整设置后重新导出。')));
      return;
    }

    if (job.status === 'error') {
      jobHost.append(h('div', { class: 'alert alert-error' },
        h('span', { class: 'alert-ico', html: icons.alert }),
        h('div', {}, h('b', { text: '导出失败：' }), job.error ?? '未知错误')));
      return;
    }

    // done
    if (job.result) {
      const video = h('video', { controls: true, src: job.result.url }) as HTMLVideoElement;
      const saveBtn = h('button', {
        class: 'btn btn-primary btn-lg',
        type: 'button',
        onClick: () => downloadBlob(job.result!.blob, job.filename),
      }, icon(icons.download), `保存 ${job.filename}`);
      jobHost.append(h('div', { class: 'panel' },
        h('header', { class: 'panel-head' },
          h('h3', { class: 'panel-title', text: '导出完成' }),
          h('span', { class: 'badge badge-ok', text: `MP4 · ${formatBytes(job.result.bytes)}` })),
        h('div', { class: 'panel-body export-result' },
          video,
          h('div', { class: 'result-actions' },
            saveBtn,
            h('a', { class: 'btn btn-ghost', href: job.result.url, download: job.filename }, '或直接下载'),
            job.summary ? h('span', { class: 'muted', style: 'font-size:12.5px', text: job.summary }) : null,
          ),
        ),
      ));
    }
  }

  const unsub = subscribeJob(() => {
    if (!jobHost.isConnected) { unsub(); return; }
    renderJob();
  });

  /* ---------------- Start export ---------------- */
  const exportBtn = h('button', { class: 'btn btn-primary btn-lg', type: 'button' }, icon(icons.download), '开始导出 MP4') as HTMLButtonElement;
  if (!webCodecsOk) exportBtn.disabled = true;
  exportBtn.addEventListener('click', () => void startExport());

  async function getPrepared(onPhase: (text: string) => void): Promise<PreparedInterpolation> {
    const frames = await ensureClipFrames(clip, (d, t, text) => onPhase(text));
    if (state.prepared) return state.prepared;
    await yieldToUi();
    let p: PreparedInterpolation;
    if (state.estimate) {
      p = prepareInterpolationWithEstimate(frames, state.estimate);
    } else {
      onPhase('运行物体运动估计并构建插值素材…');
      await yieldToUi();
      p = prepareInterpolation(frames);
      state.estimate = p.estimate;
    }
    state.prepared = p;
    return p;
  }

  async function startExport(): Promise<void> {
    if (activeJob && (activeJob.status === 'running' || activeJob.status === 'preparing')) return;
    const name = (settings.name.trim() || 'curling-slowmo').replace(/\.mp4$/i, '');
    const filename = `${name}.mp4`;
    const out = computeOutput();
    const handle: ExportHandle = { cancelled: false };
    const job: ExportJob = {
      status: 'preparing',
      progress: 0,
      total: out.frameCount,
      phase: '准备帧数据与插值器…',
      filename,
      handle,
    };
    activeJob = job;
    emitJob();

    try {
      const prepared = await getPrepared((text) => { job.phase = text; emitJob(); });
      if (handle.cancelled) throw new ExportCancelledError();

      job.status = 'running';
      job.summary = `${out.width}×${out.height} · ${settings.fps}fps · ${settings.factor}× · ${out.frameCount} 帧 · ${out.duration.toFixed(1)}s`;
      emitJob();

      const srcCanvas = document.createElement('canvas');
      const n = clip.frames.length;

      const result = await exportFramesToMp4({
        width: out.width,
        height: out.height,
        fps: settings.fps,
        frameCount: out.frameCount,
        bitrate: Math.round(out.width * out.height * settings.fps * 0.15),
        handle,
        onProgress: (done, total, phase) => {
          job.progress = done;
          job.total = total;
          job.phase = phase;
          emitJob();
        },
        renderFrame: (index, canvas) => {
          const mapped = mapOutputIndex(n, settings.factor, index);
          const { interval, u } = mapped;
          let img;
          if (u <= 1e-9) img = clip.frames[interval];
          else if (u >= 1 - 1e-9) img = clip.frames[Math.min(n - 1, interval + 1)];
          else img = interpolatePrepared(prepared, interval, u);

          rgbaToCanvas(img, srcCanvas);
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('无法创建导出画布 2D 上下文');
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(srcCanvas, 0, 0, canvas.width, canvas.height);
        },
      });

      if (handle.cancelled) throw new ExportCancelledError();
      const url = URL.createObjectURL(result.blob);
      job.status = 'done';
      job.progress = out.frameCount;
      job.phase = '完成';
      job.result = { blob: result.blob, url, bytes: result.bytes };
      emitJob();
    } catch (err) {
      if (err instanceof ExportCancelledError || handle.cancelled) {
        job.status = 'cancelled';
        job.phase = '已取消';
      } else {
        job.status = 'error';
        job.error = err instanceof Error ? err.message : String(err);
      }
      emitJob();
    }
  }

  refreshSummary();
  renderJob();
  void detectCodec();

  const grid = h('div', { class: 'layout-grid' });
  const left = h('div', { class: 'stack' },
    h('section', { class: 'panel' },
      h('header', { class: 'panel-head' }, h('h3', { class: 'panel-title', text: '导出设置' })),
      h('div', { class: 'panel-body' },
        h('div', { class: 'form-grid' },
          h('div', { class: 'field span-2' }, h('label', { text: '输出文件名' }), nameInput),
          h('div', { class: 'field' }, h('label', { text: '分辨率' }), resSelect),
          h('div', { class: 'field' }, h('label', { text: '编码帧率' }), fpsSelect),
          h('div', { class: 'field span-2' }, h('label', { text: '慢放 / 插值倍数' }), factorSelect),
        ),
        h('div', { class: 'mt-18' }, summaryHost),
        h('div', { class: 'mt-18 flex gap-12 wrap items-center' },
          exportBtn,
          h('span', { class: 'muted', style: 'font-size:12.5px', text: 'H.264 · 本地编码，无上传' }),
        ),
      ),
    ),
    h('section', { class: 'panel' },
      h('header', { class: 'panel-head' }, h('h3', { class: 'panel-title cyan', text: '编码器状态' })),
      h('div', { class: 'panel-body' }, codecHost),
    ),
  );

  const right = h('div', { class: 'stack' },
    h('section', { class: 'panel' },
      h('header', { class: 'panel-head' }, h('h3', { class: 'panel-title', text: '导出任务' })),
      h('div', { class: 'panel-body' }, jobHost),
    ),
  );

  grid.append(left, right);
  root.append(grid);
  return root;
}

function buildNoClip(actions: PageActions): HTMLElement {
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-body' },
      h('div', { class: 'empty-state' },
        h('div', { class: 'empty-icon', html: icons.download }),
        h('h3', { text: '还没有可导出的片段' }),
        h('p', { text: '请先导入片段并完成插值准备。建议先在“慢放预览”页确认效果与 PSNR。' }),
        h('button', { class: 'btn btn-primary', type: 'button', onClick: () => actions.go('import') }, '前往录像导入'),
      ),
    ),
  );
}

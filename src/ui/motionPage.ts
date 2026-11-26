import { h, icons, icon, yieldToUi, formatMs, paintRangeFill } from './dom.ts';
import type { ProjectState } from './state.ts';
import type { PageActions } from './importPage.ts';
import { ensureClipFrames } from './clipLoader.ts';
import { estimateObjectMotion } from '../core/tracker.ts';
import { presentRgba, drawMotionOverlay } from './overlays.ts';
import { runWebGpuSelfTest } from '../webgpu/selfTest.ts';

export function renderMotionPage(state: ProjectState, actions: PageActions): HTMLElement {
  const root = h('div', { class: 'page' });

  root.append(
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', { class: 'page-title', text: '运动估计' }),
        h('p', { class: 'page-desc', text: '背景板建模 + 连通域检测 + 平移匹配跟踪冰壶，PCA 跟踪长条冰刷。可在帧间检查检测框、朝向与轨迹。' }),
      ),
      h('div', { class: 'page-actions' },
        h('span', {
          class: `badge ${state.webgpu.mode === 'webgpu-module' ? 'badge-ok' : 'badge-warn'}`,
          text: state.webgpu.badgeText,
          title: state.webgpu.detail,
        }),
      ),
    ),
  );

  if (!state.clip) {
    root.append(buildNoClip(actions));
    return root;
  }

  const clip = state.clip;
  let frameIndex = Math.min(state.estimate ? Math.floor(clip.frames.length / 2) : 0, Math.max(0, clip.frames.length - 1));
  let highlightId: string | null = null;

  const canvas = h('canvas') as HTMLCanvasElement;
  const stage = h('div', { class: 'stage' },
    canvas,
    h('span', { class: 'stage-corner', id: 'motion-corner', text: `FRAME ${frameIndex + 1}/${clip.frames.length}` }),
    h('span', { class: 'stage-corner right mono', text: `${clip.width}×${clip.height}` }),
  );

  function redraw(): void {
    const frame = clip.frames[frameIndex];
    if (!frame) return;
    presentRgba(canvas, frame);
    if (state.estimate) {
      drawMotionOverlay(canvas, state.estimate, frameIndex, {
        trajectories: state.overlayTrajectories,
        boxes: state.overlayBoxes,
        highlightId,
      });
    }
    const corner = stage.querySelector('#motion-corner');
    if (corner) corner.textContent = `FRAME ${frameIndex + 1}/${clip.frames.length} · t=${(frameIndex / clip.sourceFps).toFixed(2)}s`;
  }

  const slider = h('input', {
    type: 'range',
    class: 'range',
    min: '0',
    max: String(Math.max(0, clip.frames.length - 1)),
    value: String(frameIndex),
    'aria-label': '选择检查帧',
    onInput: () => {
      frameIndex = Number(slider.value);
      paintRangeFill(slider);
      redraw();
    },
  }) as HTMLInputElement;
  paintRangeFill(slider);

  const frameLabel = h('span', { class: 'time-readout' }, h('b', { text: `第 ${frameIndex + 1} 帧` }), ` / ${clip.frames.length}`);
  slider.addEventListener('input', () => { frameLabel.innerHTML = ''; frameLabel.append(h('b', { text: `第 ${frameIndex + 1} 帧` }), ` / ${clip.frames.length}`); });

  const trajCheck = h('input', {
    type: 'checkbox',
    checked: state.overlayTrajectories,
    onChange: () => { state.overlayTrajectories = trajCheck.checked; redraw(); },
  }) as HTMLInputElement;
  const boxCheck = h('input', {
    type: 'checkbox',
    checked: state.overlayBoxes,
    onChange: () => { state.overlayBoxes = boxCheck.checked; redraw(); },
  }) as HTMLInputElement;

  const runBtn = h('button', { class: 'btn btn-primary btn-lg', type: 'button' }) as HTMLButtonElement;
  function setRunLabel(text: string): void {
    runBtn.innerHTML = '';
    runBtn.append(icon(icons.scan), document.createTextNode(text));
  }
  setRunLabel(state.estimate ? '重新运行运动估计' : '运行运动估计');
  const progressHost = h('div', {});
  const objectPanelHost = h('div', {});
  const timingHost = h('div', {});

  function renderObjectPanel(): void {
    objectPanelHost.innerHTML = '';
    if (!state.estimate) {
      objectPanelHost.append(
        h('div', { class: 'empty-state', style: 'padding:30px 18px' },
          h('p', { class: 'muted', text: '尚未运行估计。点击“运行运动估计”后，这里会列出检测到的冰壶与冰刷轨迹。' }),
        ),
      );
      return;
    }
    const est = state.estimate;
    const list = h('div', { class: 'object-list scroll-thin' });

    est.stones.forEach((track, i) => {
      const tracked = track.poses.filter(Boolean).length;
      const pose = track.poses[frameIndex];
      const color = track.color ? `rgb(${track.color[0]},${track.color[1]},${track.color[2]})` : ['#ff4d5a', '#f2c14e'][i % 2];
      const id = `stone-${track.id}`;
      const item = h('div', {
        class: 'object-item',
        style: highlightId === id ? 'border-color:' + color + ';box-shadow:0 0 0 1px ' + color : '',
        onMouseEnter: () => { highlightId = id; redraw(); },
        onMouseLeave: () => { highlightId = null; redraw(); },
      },
        h('span', { class: 'object-swatch', style: `background:${color}` }),
        h('div', { class: 'object-main' },
          h('div', { class: 'object-name' }, `冰壶 #${track.id + 1}`,
            h('span', { class: 'badge mono', text: `r≈${(track.poses[0]?.radius ?? 0).toFixed(1)}px` })),
          h('div', { class: 'object-sub', text: pose ? `x ${pose.x.toFixed(1)} · y ${pose.y.toFixed(1)} · θ ${pose.angle.toFixed(2)}` : '当前帧未跟踪到' }),
        ),
        h('div', { class: 'object-track-count' }, `${tracked}/${track.poses.length} 帧`),
      );
      list.append(item);
    });

    est.brooms.forEach((track, bi) => {
      const tracked = track.poses.filter(Boolean).length;
      const pose = track.poses[frameIndex];
      const id = `broom-${track.id}`;
      const item = h('div', {
        class: 'object-item',
        style: highlightId === id ? 'border-color:#34d399;box-shadow:0 0 0 1px #34d399' : '',
        onMouseEnter: () => { highlightId = id; redraw(); },
        onMouseLeave: () => { highlightId = null; redraw(); },
      },
        h('span', { class: 'object-swatch', style: 'background:#34d399' }),
        h('div', { class: 'object-main' },
          h('div', { class: 'object-name' }, `冰刷 #${bi + 1}`, h('span', { class: 'badge badge-ok', text: 'PCA 朝向' })),
          h('div', { class: 'object-sub', text: pose ? `x ${pose.x.toFixed(1)} · y ${pose.y.toFixed(1)} · θ ${pose.angle.toFixed(2)}` : '当前帧未检测到' }),
        ),
        h('div', { class: 'object-track-count' }, `${tracked}/${track.poses.length} 帧`),
      );
      list.append(item);
    });

    if (est.stones.length === 0 && est.brooms.length === 0) {
      list.append(h('p', { class: 'muted center-text', text: '未检测到目标。' }));
    }
    objectPanelHost.append(list);
  }

  function renderTiming(): void {
    timingHost.innerHTML = '';
    const est = state.estimate;
    timingHost.append(
      h('div', { class: 'timing-list' },
        h('div', { class: 'timing-row' }, h('span', { text: '估计总耗时' }), h('span', { text: formatMs(state.motionTimingMs) })),
        h('div', { class: 'timing-row' }, h('span', { text: '背景板建模' }), h('span', { text: formatMs(est?.timings.plate) })),
        h('div', { class: 'timing-row' }, h('span', { text: '核心计时 total' }), h('span', { text: formatMs(est?.timings.total) })),
        h('div', { class: 'timing-row' }, h('span', { text: '处理帧数' }), h('span', { text: `${clip.frames.length}` })),
        h('div', { class: 'timing-row' }, h('span', { text: '单帧平均' }), h('span', { text: state.motionTimingMs ? formatMs(state.motionTimingMs / clip.frames.length) : '—' })),
      ),
    );
  }

  async function runEstimation(): Promise<void> {
    runBtn.disabled = true;
    progressHost.innerHTML = '';
    const barWrap = h('div', { class: 'progress indeterminate' }, h('div', { class: 'progress-bar' }));
    const label = h('div', { class: 'progress-label mt-8', text: '准备帧数据…' });
    progressHost.append(h('div', { class: 'progress-row' }, barWrap), label);

    try {
      const frames = await ensureClipFrames(clip, (done, total, text) => {
        barWrap.classList.remove('indeterminate');
        (barWrap.firstElementChild as HTMLElement).style.width = `${Math.round((done / total) * 100)}%`;
        label.textContent = text;
      });
      // Let the progress UI paint before the synchronous CPU-heavy estimate.
      await yieldToUi();
      barWrap.classList.add('indeterminate');
      label.textContent = `正在对 ${frames.length} 帧执行物体运动估计（CPU）…`;
      await yieldToUi();

      const t0 = performance.now();
      // estimateObjectMotion is chunked internally per frame but exposed as one
      // synchronous call; the explicit yield above guarantees paint first.
      const estimate = estimateObjectMotion(frames);
      const ms = performance.now() - t0;

      state.estimate = estimate;
      state.motionTimingMs = ms;
      state.emit();

      barWrap.classList.remove('indeterminate');
      (barWrap.firstElementChild as HTMLElement).style.width = '100%';
      label.innerHTML = '';
      label.append(h('span', { class: 'badge badge-ok', text: `估计完成 · ${formatMs(ms)}` }));

      frameIndex = Math.min(frameIndex, frames.length - 1);
      slider.max = String(frames.length - 1);
      redraw();
      renderObjectPanel();
      renderTiming();

      const gpuLine = h('div', { class: 'stat', text: 'WebGPU compute 内核自检中…' });
      timingHost.append(gpuLine);
      void runWebGpuSelfTest(frames).then(gpu => {
        if (gpu.ok) {
          gpuLine.innerHTML = '';
          gpuLine.append(
            h('span', { text: 'WebGPU 块匹配/warp' }),
            h('b', { text: `${gpu.blockCount} 块 · ME ${gpu.motionMs?.toFixed(1)}ms · warp ${gpu.warpMs?.toFixed(1)}ms` }),
          );
        } else {
          gpuLine.innerHTML = '';
          gpuLine.append(
            h('span', { text: 'WebGPU compute' }),
            h('b', { class: 'muted', text: gpu.error ? `CPU 参考模式（${gpu.error.slice(0, 48)}）` : 'CPU 参考模式' }),
          );
        }
      });
    } catch (err) {
      progressHost.innerHTML = '';
      progressHost.append(
        h('div', { class: 'alert alert-error' },
          h('span', { class: 'alert-ico', html: icons.alert }),
          h('div', {}, h('b', { text: '运动估计失败：' }), err instanceof Error ? err.message : String(err)),
        ),
      );
    } finally {
      runBtn.disabled = false;
      setRunLabel(state.estimate ? '重新运行运动估计' : '运行运动估计');
    }
  }
  runBtn.addEventListener('click', () => void runEstimation());

  redraw();
  renderObjectPanel();
  renderTiming();

  const grid = h('div', { class: 'layout-grid' });
  const left = h('div', { class: 'stack' },
    h('section', { class: 'panel' },
      h('header', { class: 'panel-head' },
        h('h3', { class: 'panel-title', text: '检测画面' }),
        h('div', { class: 'flex items-center gap-12 wrap' },
          h('label', { class: 'check-row' }, trajCheck, '轨迹'),
          h('label', { class: 'check-row' }, boxCheck, '检测框/朝向'),
        ),
      ),
      h('div', { class: 'panel-body tight' }, stage),
      h('div', { class: 'player-controls' },
        h('span', { class: 'time-readout' }, frameLabel),
        h('div', { class: 'scrubber' }, slider),
      ),
    ),
  );

  const right = h('div', { class: 'stack' },
    h('section', { class: 'panel' },
      h('header', { class: 'panel-head' }, h('h3', { class: 'panel-title cyan', text: '运行与耗时' })),
      h('div', { class: 'panel-body stack' },
        runBtn,
        progressHost,
        h('div', { class: 'alert alert-info' },
          h('span', { class: 'alert-ico', html: icons.info }),
          h('div', { text: state.webgpu.detail }),
        ),
        timingHost,
      ),
    ),
    h('section', { class: 'panel' },
      h('header', { class: 'panel-head' }, h('h3', { class: 'panel-title', text: '对象列表 / 轨迹' })),
      h('div', { class: 'panel-body' }, objectPanelHost),
    ),
    h('div', { class: 'page-actions', style: 'justify-content:flex-end' },
      h('button', { class: 'btn btn-primary', type: 'button', onClick: () => actions.go('preview') }, '下一步：慢放预览 →')),
  );

  grid.append(left, right);
  root.append(grid);
  return root;
}

function buildNoClip(actions: PageActions): HTMLElement {
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-body' },
      (() => {
        const es = emptyStateLite();
        return es;
      })(),
    ),
  );

  function emptyStateLite(): HTMLElement {
    return h('div', { class: 'empty-state' },
      h('div', { class: 'empty-icon', html: icons.scan }),
      h('h3', { text: '还没有可分析的片段' }),
      h('p', { text: '请先在“录像导入”页加载视频或内置合成片段，再运行物体运动估计。' }),
      h('button', { class: 'btn btn-primary', type: 'button', onClick: () => actions.go('import') }, '前往录像导入'),
    );
  }
}

import { h, icons, icon, yieldToUi, paintRangeFill } from './dom.ts';
import type { ProjectState, SlowFactor } from './state.ts';
import { mapOutputIndex } from './state.ts';
import type { PageActions } from './importPage.ts';
import { ensureClipFrames } from './clipLoader.ts';
import {
  prepareInterpolation,
  prepareInterpolationWithEstimate,
  interpolatePrepared,
  type PreparedInterpolation,
} from '../core/pipeline.ts';
import { psnr, type RgbaImage } from '../core/image.ts';
import { presentRgba } from './overlays.ts';

const REPLAY_FPS = 30;

export function renderPreviewPage(state: ProjectState, actions: PageActions): HTMLElement {
  const root = h('div', { class: 'page' });

  root.append(
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', { class: 'page-title', text: '慢放预览' }),
        h('p', { class: 'page-desc', text: '在 30fps 抽稀帧之间按相位 u 生成中间帧：2× 用 u=1/2，4× 用 u=k/4，8× 细化到 u=k/8。仅渲染当前帧，不预生成全部高清序列。' }),
      ),
    ),
  );

  if (!state.clip) {
    root.append(buildNoClip(actions));
    return root;
  }

  const clip = state.clip;
  let prepared: PreparedInterpolation | null = state.prepared;
  let outIndex = 0;
  let playing = false;
  let rafId = 0;
  let playStartWall = 0;
  let playStartIndex = 0;

  /* ---------------- Canvas cells ---------------- */
  const interpCanvas = h('canvas') as HTMLCanvasElement;
  const origCanvas = h('canvas') as HTMLCanvasElement;
  const interpStage = h('div', { class: 'stage' },
    interpCanvas,
    h('span', { class: 'stage-corner', text: '插值输出 · INTERPOLATED' }),
    h('span', { class: 'stage-corner right mono', id: 'interp-phase', text: 'u=0' }),
  );

  const origStage = h('div', { class: 'stage' },
    origCanvas,
    h('span', { class: 'stage-corner', text: '原始 30FPS · NEAREST SOURCE' }),
    h('span', { class: 'stage-corner right mono', id: 'orig-src', text: 'src #0' }),
  );

  const interpCell = h('div', { class: 'compare-cell' },
    h('div', { class: 'compare-label' }, h('span', { class: 'tag-interp', text: '插值帧（物体感知）' })),
    interpStage,
  );
  const origCell = h('div', { class: 'compare-cell' },
    h('div', { class: 'compare-label' }, h('span', { class: 'tag-orig', text: '原始抽稀帧（无插值）' })),
    origStage,
  );

  const compareWrap = h('div', { class: 'canvas-compare' }, origCell, interpCell);

  /* ---------------- Controls ---------------- */
  const factorSeg = h('div', { class: 'segmented accent', role: 'group', 'aria-label': '慢放倍数' });
  for (const f of [2, 4, 8] as SlowFactor[]) {
    factorSeg.append(h('button', {
      type: 'button',
      class: `seg-btn ${state.previewFactor === f ? 'active' : ''}`,
      onClick: () => {
        state.previewFactor = f;
        outIndex = Math.min(outIndex, totalFrames() - 1);
        factorSeg.querySelectorAll('.seg-btn').forEach((b, i) => b.classList.toggle('active', [2, 4, 8][i] === f));
        updateScrubberMax();
        renderCurrent();
      },
    }, `${f}× 慢放`));
  }

  const viewSeg = h('div', { class: 'segmented cyan', role: 'group', 'aria-label': '视图模式' });
  const viewOptions: Array<{ v: ProjectState['previewView']; label: string }> = [
    { v: 'compare', label: '左右对比' },
    { v: 'interp', label: '仅插值' },
    { v: 'original', label: '仅原始' },
  ];
  for (const opt of viewOptions) {
    viewSeg.append(h('button', {
      type: 'button',
      class: `seg-btn ${state.previewView === opt.v ? 'active' : ''}`,
      onClick: () => {
        state.previewView = opt.v;
        viewSeg.querySelectorAll('.seg-btn').forEach((b, i) => b.classList.toggle('active', viewOptions[i].v === opt.v));
        applyViewMode();
      },
    }, opt.label));
  }

  const playBtn = h('button', { class: 'btn btn-primary play-btn', type: 'button', 'aria-label': '播放/暂停' }) as HTMLButtonElement;
  function setPlayIcon(): void {
    playBtn.innerHTML = '';
    playBtn.append(h('span', { html: playing ? icons.pause : icons.play }));
  }
  setPlayIcon();
  playBtn.addEventListener('click', () => {
    if (!prepared) return;
    if (playing) pause();
    else play();
  });

  const stepPrev = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: '上一输出帧', onClick: () => { pause(); stepBy(-1); } }, icon(icons.prev));
  const stepNext = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', title: '下一输出帧', onClick: () => { pause(); stepBy(1); } }, icon(icons.next));

  const scrubber = h('input', { type: 'range', class: 'range', min: '0', max: '0', value: '0', 'aria-label': '进度条' }) as HTMLInputElement;
  const timeReadout = h('span', { class: 'time-readout' });

  scrubber.addEventListener('input', () => {
    pause();
    outIndex = Number(scrubber.value);
    renderCurrent();
  });

  function totalFrames(): number {
    const n = clip.frames.length;
    return Math.max(1, (n - 1)) * state.previewFactor + 1;
  }

  function updateScrubberMax(): void {
    scrubber.max = String(totalFrames() - 1);
    scrubber.value = String(Math.min(outIndex, totalFrames() - 1));
    paintRangeFill(scrubber);
  }

  function stepBy(delta: number): void {
    outIndex = Math.max(0, Math.min(totalFrames() - 1, outIndex + delta));
    renderCurrent();
  }

  function applyViewMode(): void {
    const mode = state.previewView;
    compareWrap.style.gridTemplateColumns = mode === 'compare' ? '' : '1fr';
    origCell.hidden = mode === 'interp';
    interpCell.hidden = mode === 'original';
  }

  /* ---------------- PSNR panel ---------------- */
  const psnrValueEl = h('div', { class: 'psnr-value', text: '—' });
  const psnrSubEl = h('div', { class: 'psnr-sub', text: '等待真值对比' });
  const phaseInfoEl = h('div', { class: 'timing-list' });
  const evalAllBtn = h('button', { class: 'btn btn-cyan btn-sm', type: 'button' }, '评测全部保持帧 PSNR') as HTMLButtonElement;
  const evalHost = h('div', {});
  evalAllBtn.addEventListener('click', () => void evaluateAll());

  function truthMatch(interval: number, u: number): { img: RgbaImage; index: number } | null {
    const truth = clip.truth;
    const step = clip.truthStep;
    if (!truth || !step || !prepared) return null;
    // Verify reference alignment: source[i] must literally be truth[i*step].
    if (clip.frames[interval] !== truth[interval * step]) return null;
    const offsetF = u * step;
    const offset = Math.round(offsetF);
    if (Math.abs(offsetF - offset) > 1e-6) return null; // phase has no exact truth frame
    const truthIndex = interval * step + offset;
    const img = truth[truthIndex];
    return img ? { img, index: truthIndex } : null;
  }

  let lastInterp: RgbaImage | null = null;

  function renderCurrent(): void {
    if (!prepared) return;
    const n = clip.frames.length;
    const mapped = mapOutputIndex(n, state.previewFactor, outIndex);
    const { interval, u } = mapped;

    // Original nearest source (demonstrates 30fps judder).
    const nearest = interval + (u >= 0.5 ? 1 : 0);
    const srcIdx = Math.max(0, Math.min(n - 1, nearest));
    presentRgba(origCanvas, clip.frames[srcIdx]);
    const origSrcLabel = origStage.querySelector('#orig-src');
    if (origSrcLabel) origSrcLabel.textContent = `src #${srcIdx}`;

    // Interpolated phase (u=0 / u=1 are exact source boundaries).
    let outImg: RgbaImage;
    if (u <= 1e-9) outImg = clip.frames[interval];
    else if (u >= 1 - 1e-9) outImg = clip.frames[Math.min(n - 1, interval + 1)];
    else outImg = interpolatePrepared(prepared, interval, u);
    lastInterp = outImg;
    presentRgba(interpCanvas, outImg);

    const phaseLabel = interpStage.querySelector('#interp-phase');
    if (phaseLabel) phaseLabel.textContent = `k=${interval} u=${u.toFixed(3)}`;

    // Scrubber + readout.
    scrubber.value = String(outIndex);
    paintRangeFill(scrubber);
    const outFps = REPLAY_FPS;
    const tOut = outIndex / outFps;
    timeReadout.innerHTML = '';
    timeReadout.append(
      h('b', { text: `${String(outIndex + 1).padStart(3, '0')} / ${totalFrames()}` }),
      ` · ${tOut.toFixed(2)}s · 源 ${(outIndex / REPLAY_FPS / state.previewFactor).toFixed(2)}s`,
    );

    phaseInfoEl.innerHTML = '';
    const rows: Array<[string, string]> = [
      ['源帧区间', `#${interval} → #${Math.min(n - 1, interval + 1)}`],
      ['相位 u', u.toFixed(4)],
      ['概念帧率', `${30 * state.previewFactor} fps 插值密度`],
      ['回放帧率', `${REPLAY_FPS} fps → ${state.previewFactor}× 慢放`],
    ];
    for (const [k, v] of rows) {
      phaseInfoEl.append(h('div', { class: 'timing-row' }, h('span', { text: k }), h('span', { text: v })));
    }

    updatePsnr(outImg, interval, u);
  }

  function updatePsnr(outImg: RgbaImage, interval: number, u: number): void {
    const match = truthMatch(interval, u);
    psnrValueEl.className = 'psnr-value';
    if (!match) {
      if (clip.truth) {
        psnrValueEl.textContent = '—';
        psnrSubEl.textContent = '该相位（如 8× 的奇数 k/8）无对应整数 120fps 真值帧';
      } else {
        psnrValueEl.textContent = 'N/A';
        psnrSubEl.textContent = '用户视频未保留 120fps 真值，PSNR 仅对内置合成片段可用';
      }
      return;
    }
    const value = psnr(outImg, match.img);
    if (!Number.isFinite(value)) {
      psnrValueEl.textContent = '∞';
      psnrValueEl.classList.add('good');
      psnrSubEl.textContent = `与真值 #${match.index} 完全一致（源帧边界）`;
      return;
    }
    psnrValueEl.textContent = value.toFixed(2);
    psnrValueEl.classList.add(value >= 40 ? 'good' : value >= 30 ? 'mid' : 'low');
    psnrSubEl.textContent = `dB · 对比保持的 120fps 真值帧 #${match.index}`;
  }

  async function evaluateAll(): Promise<void> {
    if (!prepared || !clip.truth || !clip.truthStep) return;
    evalAllBtn.disabled = true;
    evalHost.innerHTML = '';
    const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-bar' })) as HTMLElement;
    const pct = h('span', { class: 'progress-pct mono', text: '0%' });
    const label = h('div', { class: 'progress-label mt-8', text: '开始逐相位评测…' });
    evalHost.append(h('div', { class: 'progress-row' }, bar, pct), label);

    const step = clip.truthStep;
    const n = clip.frames.length;
    const values: number[] = [];
    let count = 0;
    const total = Math.max(0, n - 1) * (step - 1);
    try {
      for (let interval = 0; interval < n - 1; interval++) {
        for (let off = 1; off < step; off++) {
          const truthIndex = interval * step + off;
          const truthImg = clip.truth[truthIndex];
          const aligned = clip.frames[interval] === clip.truth[interval * step];
          if (truthImg && aligned) {
            const u = off / step;
            const img = interpolatePrepared(prepared, interval, u);
            const v = psnr(img, truthImg);
            if (Number.isFinite(v)) values.push(v);
          }
          count++;
          if (count % 3 === 0 || count === total) {
            const p = total ? Math.round((count / total) * 100) : 100;
            (bar.firstElementChild as HTMLElement).style.width = `${p}%`;
            pct.textContent = `${p}%`;
            label.textContent = `评测保持帧 ${count}/${total}`;
            await yieldToUi();
          }
        }
      }
      const avg = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
      const min = Math.min(...values);
      label.innerHTML = '';
      label.append(
        h('span', { class: 'badge badge-ok', text: `平均 ${avg.toFixed(2)} dB` }),
        h('span', { class: 'badge badge-cyan', style: 'margin-left:8px', text: `最低 ${min.toFixed(2)} dB` }),
        h('span', { class: 'badge mono', style: 'margin-left:8px', text: `${values.length} 个保持帧` }),
      );
    } catch (err) {
      evalHost.append(h('div', { class: 'alert alert-error mt-8' },
        h('span', { class: 'alert-ico', html: icons.alert }),
        h('div', { text: err instanceof Error ? err.message : String(err) })));
    } finally {
      evalAllBtn.disabled = false;
    }
  }

  /* ---------------- Playback loop ---------------- */
  function tick(now: number): void {
    if (!root.isConnected) { playing = false; return; }
    if (!playing) return;
    const elapsed = (now - playStartWall) / 1000;
    const target = Math.floor(playStartIndex + elapsed * REPLAY_FPS);
    if (target >= totalFrames() - 1) {
      outIndex = totalFrames() - 1;
      renderCurrent();
      pause();
      return;
    }
    if (target !== outIndex) {
      outIndex = target;
      renderCurrent();
    }
    rafId = requestAnimationFrame(tick);
  }
  function play(): void {
    if (!prepared) return;
    if (outIndex >= totalFrames() - 1) outIndex = 0;
    playing = true;
    playStartWall = performance.now();
    playStartIndex = outIndex;
    setPlayIcon();
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  }
  function pause(): void {
    playing = false;
    cancelAnimationFrame(rafId);
    setPlayIcon();
  }

  /* ---------------- Preparation ---------------- */
  const prepHost = h('div', {});
  const contentHost = h('div', { style: 'display:none' });

  async function ensurePrepared(): Promise<void> {
    if (state.prepared) {
      prepared = state.prepared;
      showContent();
      return;
    }
    prepHost.innerHTML = '';
    const barWrap = h('div', { class: 'progress indeterminate' }, h('div', { class: 'progress-bar cyan' }));
    const label = h('div', { class: 'progress-label mt-8', text: '准备帧数据…' });
    prepHost.append(barWrap, label);
    try {
      const frames = await ensureClipFrames(clip, (done, total, text) => {
        barWrap.classList.remove('indeterminate');
        (barWrap.firstElementChild as HTMLElement).style.width = `${Math.round((done / total) * 100)}%`;
        label.textContent = text;
      });
      await yieldToUi();
      barWrap.classList.add('indeterminate');
      label.textContent = state.estimate
        ? '复用运动估计结果，构建精灵/背景素材…'
        : '运行物体运动估计并构建插值素材（CPU，可能需要数秒）…';
      await yieldToUi();

      let p: PreparedInterpolation;
      if (state.estimate) p = prepareInterpolationWithEstimate(frames, state.estimate);
      else {
        p = prepareInterpolation(frames);
        state.estimate = p.estimate;
      }
      state.prepared = p;
      prepared = p;
      state.emit();
      prepHost.innerHTML = '';
      showContent();
    } catch (err) {
      prepHost.innerHTML = '';
      prepHost.append(h('div', { class: 'alert alert-error' },
        h('span', { class: 'alert-ico', html: icons.alert }),
        h('div', {}, h('b', { text: '插值器准备失败：' }), err instanceof Error ? err.message : String(err)),
        h('div', { class: 'mt-8' }, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => void ensurePrepared() }, '重试')),
      ));
    }
  }

  function showContent(): void {
    prepHost.innerHTML = '';
    prepHost.style.display = 'none';
    contentHost.style.display = '';
    updateScrubberMax();
    applyViewMode();
    outIndex = 0;
    renderCurrent();
  }

  /* ---------------- Assemble ---------------- */
  const truthPanel = h('section', { class: 'panel' },
    h('header', { class: 'panel-head' }, h('h3', { class: 'panel-title', text: 'PSNR 客观质量' }),
      clip.truth ? h('span', { class: 'badge badge-ok', text: '120fps 真值可用' }) : h('span', { class: 'badge badge-warn', text: '无真值' })),
    h('div', { class: 'panel-body' },
      h('div', { class: 'psnr-hero' }, psnrValueEl, psnrSubEl),
      h('div', { class: 'mt-14' }, evalAllBtn),
      evalHost,
    ),
  );

  const infoPanel = h('section', { class: 'panel' },
    h('header', { class: 'panel-head' }, h('h3', { class: 'panel-title cyan', text: '相位 / 时间轴' })),
    h('div', { class: 'panel-body' }, phaseInfoEl),
  );

  const sideCol = h('div', { class: 'stack' }, truthPanel, infoPanel,
    h('div', { class: 'page-actions' },
      h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => actions.go('motion') }, '← 运动估计'),
      h('button', { class: 'btn btn-primary', type: 'button', onClick: () => actions.go('export') }, '前往导出 →'),
    ),
  );

  const playerPanel = h('section', { class: 'panel' },
    h('header', { class: 'panel-head' },
      h('h3', { class: 'panel-title', text: '预览监视器' }),
      h('div', { class: 'flex items-center gap-12 wrap' }, factorSeg, viewSeg),
    ),
    h('div', { class: 'panel-body' }, compareWrap),
    h('div', { class: 'player-controls' },
      playBtn,
      h('div', { class: 'frame-step-group' }, stepPrev, stepNext),
      h('div', { class: 'scrubber' }, scrubber),
      timeReadout,
    ),
  );

  contentHost.append(
    h('div', { class: 'layout-grid' },
      h('div', { class: 'stack' }, playerPanel),
      sideCol,
    ),
  );

  root.append(
    h('section', { class: 'panel' }, h('div', { class: 'panel-body' }, prepHost)),
    contentHost,
  );

  updateScrubberMax();
  applyViewMode();
  // Auto-start preparation.
  void ensurePrepared();
  return root;
}

function buildNoClip(actions: PageActions): HTMLElement {
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-body' },
      h('div', { class: 'empty-state' },
        h('div', { class: 'empty-icon', html: icons.film }),
        h('h3', { text: '还没有可预览的片段' }),
        h('p', { text: '请先导入视频或内置合成片段。内置片段可额外显示对 120fps 真值的 PSNR。' }),
        h('button', { class: 'btn btn-primary', type: 'button', onClick: () => actions.go('import') }, '前往录像导入'),
      ),
    ),
  );
}

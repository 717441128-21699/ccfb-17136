import { h, icons, yieldToUi, formatBytes } from './dom.ts';
import type { ProjectState, TabId } from './state.ts';
import { loadSyntheticClip, readVideoFile, SCENARIO_INFO, type LoadProgress } from './clipLoader.ts';
import type { ScenarioKind } from '../core/render/curlingScene.ts';
import { presentRgba } from './overlays.ts';

const SCENARIO_KINDS: ScenarioKind[] = ['head-on', 'glancing', 'finish-line', 'sweep'];

export interface PageActions {
  go: (tab: TabId) => void;
  refresh: () => void;
}

export function renderImportPage(state: ProjectState, actions: PageActions): HTMLElement {
  const root = h('div', { class: 'page' });

  root.append(
    h('div', { class: 'page-head' },
      h('div', {},
        h('h2', { class: 'page-title', text: '录像导入' }),
        h('p', { class: 'page-desc', text: '导入本地视频，或加载内置 120fps 合成冰壶片段。合成片段保留完整真值帧，可用于 PSNR 客观评测。' }),
      ),
      state.clip
        ? h('div', { class: 'page-actions' },
            h('button', {
              class: 'btn btn-primary',
              type: 'button',
              onClick: () => actions.go('motion'),
            }, '下一步：运动估计', h('span', { html: '→' })),
          )
        : null,
    ),
  );

  const grid = h('div', { class: 'layout-grid' });
  const leftCol = h('div', { class: 'stack' });
  const rightCol = h('div', { class: 'stack' });

  /* ---------- File import panel ---------- */
  const fileInput = h('input', { type: 'file', accept: 'video/*,.mp4,.webm,.mov,.mkv' }) as HTMLInputElement;
  const dropzone = h('div', {
    class: 'dropzone',
    role: 'button',
    tabindex: '0',
    'aria-label': '选择或拖入视频文件',
    onClick: () => fileInput.click(),
    onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } },
  },
    h('div', { class: 'dropzone-icon', html: icons.upload }),
    h('div', { class: 'dropzone-title', text: '点击选择 / 拖拽视频到此处' }),
    h('div', { class: 'dropzone-sub', text: '支持 MP4(H.264)、WebM 等浏览器可解码格式；文件仅在本地读取' }),
    fileInput,
  );

  const fileErrorHost = h('div', {});
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void handleFile(file);
    fileInput.value = '';
  });
  ['dragenter', 'dragover'].forEach(ev => dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(ev => dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  }));
  dropzone.addEventListener('drop', (e) => {
    const dt = (e as DragEvent).dataTransfer;
    const file = dt?.files?.[0];
    if (file) void handleFile(file);
  });

  async function handleFile(file: File): Promise<void> {
    fileErrorHost.innerHTML = '';
    dropzone.classList.add('dragover');
    try {
      const { clip } = await readVideoFile(file);
      state.setClip(clip);
      actions.refresh();
    } catch (err) {
      dropzone.classList.remove('dragover');
      fileErrorHost.append(
        h('div', { class: 'mt-14' },
          // alert box built via helper below
          buildError(err),
        ),
      );
    }
  }

  leftCol.append(
    h('section', { class: 'panel' },
      h('header', { class: 'panel-head' }, h('h3', { class: 'panel-title', text: '本地视频文件' }),
        h('span', { class: 'badge mono', text: 'HTMLVideoElement · Canvas 抽帧' })),
      h('div', { class: 'panel-body' }, dropzone, fileErrorHost),
    ),
  );

  /* ---------- Synthetic clips panel ---------- */
  let resolution: 540 | 720 = 540;
  const progressHost = h('div', { class: 'mt-14' });
  const gridCards = h('div', { class: 'scenario-grid' });

  function buildCards(): void {
    gridCards.innerHTML = '';
    for (const kind of SCENARIO_KINDS) {
      const info = SCENARIO_INFO[kind];
      const card = h('button', {
        class: 'scenario-card',
        type: 'button',
        style: `--sc-color:${info.color}`,
        onClick: () => void loadScenario(kind, card),
      },
        h('div', {},
          h('div', { class: 'sc-name', text: info.name }),
          h('div', { class: 'sc-en', text: info.en }),
        ),
        h('div', { class: 'sc-desc', text: info.desc }),
        h('div', { class: 'sc-meta' },
          h('span', { class: 'badge mono', text: `${resolution === 540 ? 960 : 1280}×${resolution}` }),
          h('span', { class: 'badge mono', text: '120 fps × 97 帧' }),
          h('span', { class: 'badge', text: '含 PSNR 真值' }),
        ),
      ) as HTMLButtonElement;
      gridCards.append(card);
    }
  }
  buildCards();

  const resSeg = h('div', { class: 'segmented', role: 'group', 'aria-label': '内置片段分辨率' });
  for (const opt of [{ v: 540, label: '960 × 540（流畅）' }, { v: 720, label: '1280 × 720（高清）' }] as const) {
    resSeg.append(h('button', {
      type: 'button',
      class: `seg-btn ${resolution === opt.v ? 'active cyan' : ''}`,
      onClick: () => {
        resolution = opt.v;
        resSeg.querySelectorAll('.seg-btn').forEach((b, i) => b.classList.toggle('active', i === (opt.v === 540 ? 0 : 1)));
        buildCards();
      },
    }, opt.label));
  }

  async function loadScenario(kind: ScenarioKind, clicked: HTMLButtonElement): Promise<void> {
    gridCards.querySelectorAll('button').forEach(b => (b.disabled = true));
    clicked.textContent = '生成中…';
    progressHost.innerHTML = '';
    const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-bar cyan' })) as HTMLElement;
    const pct = h('span', { class: 'progress-pct mono', text: '0%' });
    const label = h('span', { class: 'progress-label', text: '准备场景…' });
    progressHost.append(
      h('div', { class: 'progress-row' }, bar, pct),
      h('div', { class: 'mt-8' }, label),
    );
    const onProgress: LoadProgress = (done, total, text) => {
      const p = Math.round((done / total) * 100);
      (bar.firstElementChild as HTMLElement).style.width = `${p}%`;
      pct.textContent = `${p}%`;
      label.textContent = text;
    };
    try {
      await yieldToUi();
      const w = resolution === 540 ? 960 : 1280;
      const clip = await loadSyntheticClip(kind, w, resolution, onProgress);
      state.setClip(clip);
      actions.refresh();
    } catch (err) {
      progressHost.append(buildError(err));
      gridCards.querySelectorAll('button').forEach(b => (b.disabled = false));
      buildCards();
    }
  }

  leftCol.append(
    h('section', { class: 'panel' },
      h('header', { class: 'panel-head' },
        h('h3', { class: 'panel-title cyan', text: '内置合成测试片段' }),
        resSeg,
      ),
      h('div', { class: 'panel-body' },
        h('div', { class: 'clip-toolbar' },
          h('span', { class: 'hint', text: '由 curlingScene.ts 实时渲染，无需网络资源' }),
        ),
        gridCards,
        progressHost,
      ),
    ),
  );

  /* ---------- Preview / metadata column ---------- */
  if (!state.clip) {
    rightCol.append(
      h('section', { class: 'panel' },
        h('header', { class: 'panel-head' }, h('h3', { class: 'panel-title', text: '片段预览与元数据' })),
        h('div', { class: 'panel-body' },
          (() => {
            const es = h('div', { class: 'empty-state' },
              h('div', { class: 'empty-icon', html: icons.film }),
              h('h3', { text: '尚未选择片段' }),
              h('p', { text: '导入视频或加载任意内置测试片段后，这里会显示画面预览、分辨率、帧率与帧数信息。' }),
            );
            return es;
          })(),
        ),
      ),
    );
  } else {
    rightCol.append(buildClipPreview(state, actions));
  }

  grid.append(leftCol, rightCol);
  root.append(grid);
  return root;
}

function buildError(err: unknown): HTMLElement {
  const message = err instanceof Error ? err.message : String(err);
  const box = h('div', { class: 'alert alert-error mt-14' },
    h('span', { class: 'alert-ico', html: icons.alert }),
    h('div', {}, h('b', { text: '加载失败：' }), message),
  );
  return box;
}

function buildClipPreview(state: ProjectState, actions: PageActions): HTMLElement {
  const clip = state.clip!;
  const stage = h('div', { class: 'stage' });

  if (clip.sourceKind === 'synthetic' && clip.frames[0]) {
    const canvas = h('canvas') as HTMLCanvasElement;
    presentRgba(canvas, clip.frames[0]);
    stage.append(
      canvas,
      h('span', { class: 'stage-corner', text: 'SOURCE · 30FPS 工作帧首帧' }),
      h('span', { class: 'stage-corner right mono', text: `${clip.width}×${clip.height}` }),
    );
  } else if (clip.video) {
    clip.video.controls = true;
    clip.video.style.width = '100%';
    clip.video.style.display = 'block';
    stage.append(
      clip.video,
      h('span', { class: 'stage-corner', text: 'USER VIDEO · 本地文件' }),
    );
  }

  const meta = h('dl', { class: 'meta-list' },
    h('dt', { text: '片段名称' }), h('dd', { text: clip.name }),
    h('dt', { text: '来源' }), h('dd', {},
      h('span', { class: `badge ${clip.sourceKind === 'synthetic' ? 'badge-cyan' : 'badge-gold'}`, text: clip.sourceKind === 'synthetic' ? '合成场景' : '本地视频' }),
      clip.scenarioKind ? h('span', { class: 'badge mono ml', text: clip.scenarioKind, style: 'margin-left:6px' }) : null,
    ),
    h('dt', { text: '分辨率' }), h('dd', { class: 'mono', text: `${clip.width} × ${clip.height}` }),
    h('dt', { text: '工作帧率' }), h('dd', { class: 'mono', text: `${clip.sourceFps.toFixed(2)} fps${clip.fpsAssumed ? '（按 30fps 估算/均匀抽帧）' : ''}` }),
    h('dt', { text: '时长' }), h('dd', { class: 'mono', text: `${clip.durationSec.toFixed(2)} s` }),
    h('dt', { text: '工作帧数' }), h('dd', { class: 'mono', text: `${clip.frames.length} 帧（运动估计/插帧输入）` }),
    clip.truth
      ? [
          h('dt', { text: '120fps 真值' }),
          h('dd', {}, h('span', { class: 'badge badge-ok', text: `已保留 ${clip.truth.length} 帧 · 可计算 PSNR` })),
        ]
      : [
          h('dt', { text: '120fps 真值' }),
          h('dd', {}, h('span', { class: 'badge badge-warn', text: '无保持真值 · PSNR 不可用' })),
        ],
    clip.fileSize != null
      ? [h('dt', { text: '文件大小' }), h('dd', { class: 'mono', text: formatBytes(clip.fileSize) })]
      : null,
  );

  return h('section', { class: 'panel' },
    h('header', { class: 'panel-head' },
      h('h3', { class: 'panel-title', text: '片段预览与元数据' }),
      h('button', {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        onClick: () => {
          state.clip = null;
          state.estimate = null;
          state.prepared = null;
          state.motionTimingMs = null;
          state.emit();
          actions.refresh();
        },
      }, '移除'),
    ),
    h('div', { class: 'panel-body stack' },
      stage,
      meta,
      clip.sourceKind === 'video-file' && !clip.extracted
        ? h('div', { class: 'alert alert-info' },
            h('span', { class: 'alert-ico', html: icons.info }),
            h('div', { text: '运动估计页运行时会通过浏览器 Seek + Canvas 均匀抽取最多 41 帧用于分析，不会上传文件。' }),
          )
        : null,
      h('button', { class: 'btn btn-primary btn-lg', type: 'button', onClick: () => actions.go('motion') },
        '前往运动估计', h('span', { html: '→' })),
    ),
  );
}

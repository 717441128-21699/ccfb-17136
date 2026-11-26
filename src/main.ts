import './styles.css';
import { createProjectState, type TabId } from './ui/state.ts';
import { detectWebGpuStatus } from './ui/webgpuStatus.ts';
import type { PageActions } from './ui/importPage.ts';
import { renderImportPage } from './ui/importPage.ts';
import { renderMotionPage } from './ui/motionPage.ts';
import { renderPreviewPage } from './ui/previewPage.ts';
import { renderExportPage } from './ui/exportPage.ts';

const state = createProjectState();

const view = document.getElementById('view')!;
const nav = document.getElementById('steps-nav')!;
const engineBadge = document.getElementById('engine-badge')!;
const statusClip = document.getElementById('status-clip')!;

if (!view || !nav || !engineBadge || !statusClip) {
  throw new Error('应用根节点缺失：请检查 index.html');
}

const TABS: TabId[] = ['import', 'motion', 'preview', 'export'];

function tabFromHash(): TabId {
  const raw = window.location.hash.replace(/^#\/?/, '');
  return (TABS as string[]).includes(raw) ? (raw as TabId) : 'import';
}

state.tab = tabFromHash();

const actions: PageActions = {
  go(tab: TabId) {
    state.tab = tab;
    const expected = `#/${tab}`;
    if (window.location.hash !== expected) window.location.hash = `/${tab}`;
    render();
  },
  refresh() {
    render();
  },
};

window.addEventListener('hashchange', () => {
  const tab = tabFromHash();
  if (tab !== state.tab) {
    state.tab = tab;
    render();
  }
});

function isDone(tab: TabId): boolean {
  if (tab === 'import') return state.clip != null;
  if (tab === 'motion') return state.estimate != null;
  if (tab === 'preview') return state.prepared != null;
  return false;
}

function renderChrome(): void {
  const buttons = Array.from(nav.querySelectorAll<HTMLButtonElement>('.step-tab'));
  for (const btn of buttons) {
    const tab = btn.dataset.tab as TabId | undefined;
    if (!tab || !TABS.includes(tab)) continue;
    btn.classList.toggle('active', tab === state.tab);
    btn.classList.toggle('done', isDone(tab));
    btn.setAttribute('aria-current', tab === state.tab ? 'step' : 'false');
  }

  if (state.clip) {
    const c = state.clip;
    statusClip.textContent = `${c.name} · ${c.width}×${c.height} · ${c.frames.length || '…'} 工作帧${state.estimate ? ' · 运动估计完成' : ''}`;
    statusClip.parentElement?.classList.add('live');
  } else {
    statusClip.textContent = '尚未导入片段';
    statusClip.parentElement?.classList.remove('live');
  }
}

function render(): void {
  renderChrome();
  view.innerHTML = '';
  let page: HTMLElement;
  switch (state.tab) {
    case 'motion':
      page = renderMotionPage(state, actions);
      break;
    case 'preview':
      page = renderPreviewPage(state, actions);
      break;
    case 'export':
      page = renderExportPage(state, actions);
      break;
    case 'import':
    default:
      page = renderImportPage(state, actions);
      break;
  }
  view.appendChild(page);
  // Move focus to the main region for keyboard/screen-reader continuity.
  view.focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}

nav.addEventListener('click', (e: MouseEvent) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.step-tab');
  if (!btn) return;
  const tab = btn.dataset.tab as TabId | undefined;
  if (tab && TABS.includes(tab)) actions.go(tab);
});

// Shared state changes (clip replacement, async estimate adoption) refresh chrome.
state.subscribe(() => renderChrome());

// WebGPU / CPU engine badge.
void detectWebGpuStatus().then((status) => {
  state.webgpu = status;
  engineBadge.className = `engine-badge ${status.badgeClass}`;
  engineBadge.textContent = status.badgeText;
  engineBadge.title = status.detail;
  state.emit();
});

render();

/* Tiny hyperscript + async UI helpers shared by the four pages. */

export type Child = Node | string | number | false | null | undefined | Child[];
export type Attrs = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K];
export function h<T extends HTMLElement = HTMLElement>(
  tag: string,
  attrs?: Attrs | null,
  ...children: Child[]
): T;
export function h(tag: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, raw] of Object.entries(attrs)) {
      if (raw == null || raw === false) continue;
      if (key === 'class' || key === 'className') {
        el.className = String(raw);
      } else if (key === 'dataset' && typeof raw === 'object') {
        Object.assign(el.dataset, raw as Record<string, string>);
      } else if (key === 'text') {
        el.textContent = String(raw);
      } else if (key === 'html') {
        el.innerHTML = String(raw);
      } else if (key.startsWith('on') && key.length > 2 && typeof raw === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), raw as EventListener);
      } else if (key === 'value' && el instanceof HTMLInputElement) {
        el.value = String(raw);
      } else if (key === 'value' && el instanceof HTMLSelectElement) {
        el.value = String(raw);
      } else if (key === 'checked' && el instanceof HTMLInputElement) {
        el.checked = Boolean(raw);
      } else if (typeof raw === 'boolean') {
        if (raw) el.setAttribute(key, '');
        else el.removeAttribute(key);
      } else {
        el.setAttribute(key, String(raw));
      }
    }
  }
  const appendChild = (child: Child): void => {
    if (child == null || child === false) return;
    if (Array.isArray(child)) {
      for (const c of child) appendChild(c);
      return;
    }
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  };
  for (const child of children) appendChild(child);
  return el;
}

/** Wait one animation frame plus a macrotask so pending DOM paints land. */
export function yieldToUi(): Promise<void> {
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      setTimeout(resolve, 0);
    });
  });
}

export function nextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Set a range input's --fill percentage for the styled track. */
export function paintRangeFill(input: HTMLInputElement): void {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const val = Number(input.value);
  const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--fill', `${pct}%`);
}

export function canvasToDataUrlThumbnail(source: HTMLCanvasElement, maxW = 240): string {
  const scale = Math.min(1, maxW / source.width);
  const c = document.createElement('canvas');
  c.width = Math.max(2, Math.round(source.width * scale));
  c.height = Math.max(2, Math.round(source.height * scale));
  const ctx = c.getContext('2d');
  if (!ctx) return source.toDataURL('image/jpeg', 0.7);
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72);
}

/** Wrap an inline SVG markup string in a real element node. */
export function icon(markup: string): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'ico-wrap';
  wrap.style.display = 'inline-flex';
  wrap.style.alignItems = 'center';
  wrap.innerHTML = markup;
  return wrap;
}

/** Play / pause SVG icons as reusable nodes. */
export const icons = {
  play: '<svg class="ico" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 8 5.5Z"/></svg>',
  pause: '<svg class="ico" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  prev: '<svg class="ico" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5a1 1 0 0 1 2 0v5.2l8.4-5.9A1 1 0 0 1 19 5.1v13.8a1 1 0 0 1-1.6.8L9 13.8V19a1 1 0 1 1-2 0V5Z"/></svg>',
  next: '<svg class="ico" viewBox="0 0 24 24" fill="currentColor"><path d="M17 5a1 1 0 0 0-2 0v5.2L6.6 4.3A1 1 0 0 0 5 5.1v13.8a1 1 0 0 0 1.6.8L15 13.8V19a1 1 0 1 0 2 0V5Z"/></svg>',
  upload:
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m0 0L7 9m5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
  film: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>',
  scan: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3.2"/></svg>',
  download:
    '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0 4-4m-4 4-4-4"/><path d="M4 19h16"/></svg>',
  check: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12.5 5 5L20 6.5"/></svg>',
  alert:
    '<svg class="ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 10v4.5M12 17.6v.1"/></svg>',
  info: '<svg class="ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.1"/></svg>',
};

export function alertBox(kind: 'error' | 'warn' | 'info' | 'success', content: Child | Child[]): HTMLElement {
  const icon = kind === 'error' || kind === 'warn' ? icons.alert : icons.info;
  return h('div', { class: `alert alert-${kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : kind === 'success' ? 'success' : 'info'}` },
    h('span', { class: 'alert-ico', html: icon }),
    h('div', {}, ...(Array.isArray(content) ? content : [content])),
  );
}

export function emptyState(iconHtml: string, title: string, desc: string, action?: HTMLElement): HTMLElement {
  return h('div', { class: 'empty-state' },
    h('div', { class: 'empty-icon', html: iconHtml }),
    h('h3', { text: title }),
    h('p', { text: desc }),
    action ?? null,
  );
}

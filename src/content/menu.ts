/**
 * The inline menu: a short list of matching logins under a focused login field. It lives in a
 * closed shadow root, so the page can't read or restyle it, and in the top layer (a manual
 * popover) where the browser supports it, so page modals don't cover it. It never holds
 * secrets: rows carry names and usernames, and a pick asks the worker to fill.
 *
 * Only trusted input picks a row: the page can't script a click or Enter into it.
 */
import type { InlineMenuItem } from '../shared/messages';

export type MenuRow =
  | { kind: 'item'; item: InlineMenuItem }
  | { kind: 'unlock' }
  | { kind: 'generate' }
  | { kind: 'message'; text: string };

export interface MenuCallbacks {
  onPick(row: MenuRow): void;
}

const MENU_WIDTH_MIN = 260;
const MENU_MAX_HEIGHT = 280;
const GAP = 4;

const STYLE = `
:host { all: initial; }
.menu {
  box-sizing: border-box;
  max-height: ${String(MENU_MAX_HEIGHT)}px;
  overflow-y: auto;
  padding: 4px;
  border-radius: 10px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: #fff;
  color: #1c1c1e;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
  font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.row {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
}
.row[aria-selected="true"] { background: #e8f0fe; }
.name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub { color: #6b6b70; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.message { padding: 7px 10px; color: #6b6b70; }
.brand { padding: 4px 10px 2px; color: #6b6b70; font-size: 11px; letter-spacing: 0.02em; }
@media (prefers-color-scheme: dark) {
  .menu { background: #2c2c2e; color: #f2f2f7; border-color: rgba(255, 255, 255, 0.14); }
  .row[aria-selected="true"] { background: #3a3f4b; }
  .sub, .message, .brand { color: #a1a1a6; }
}
`;

function rowLabel(row: MenuRow): { name: string; sub: string | null } {
  if (row.kind === 'unlock') return { name: 'Unlock Vibepass', sub: 'to fill a login here' };
  if (row.kind === 'generate') {
    return { name: 'Use a strong password', sub: 'Vibepass makes one and remembers it' };
  }
  if (row.kind === 'message') return { name: row.text, sub: null };
  const { item } = row;
  const parts = [item.username ?? ''];
  if (item.recent) parts.push('continue sign-in');
  if (item.reprompt) parts.push('asks for master password');
  return { name: item.name, sub: parts.filter(Boolean).join(' · ') || null };
}

export class InlineMenu {
  private host: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private rows: MenuRow[] = [];
  private active = -1;
  private frame = 0;
  anchor: HTMLInputElement | null = null;

  constructor(private readonly callbacks: MenuCallbacks) {}

  get isOpen(): boolean {
    return this.host !== null;
  }

  open(anchor: HTMLInputElement, rows: MenuRow[]): void {
    if (rows.length === 0) {
      this.close();
      return;
    }
    if (this.anchor !== anchor) this.close();
    this.anchor = anchor;
    this.rows = rows;
    this.active = -1;
    if (!this.host) this.mount();
    this.render();
    this.reposition();
  }

  close(): void {
    if (this.host) {
      removeEventListener('scroll', this.schedule, true);
      removeEventListener('resize', this.schedule);
      cancelAnimationFrame(this.frame);
      this.host.remove();
    }
    this.host = null;
    this.list = null;
    this.rows = [];
    this.active = -1;
    this.anchor = null;
  }

  /** Arrow keys: move the highlight, wrapping around. */
  move(delta: number): void {
    const count = this.rows.filter((r) => r.kind !== 'message').length;
    if (count === 0) return;
    this.active = this.active < 0 && delta < 0 ? count - 1 : (this.active + delta + count) % count;
    this.render();
  }

  /** Enter: pick the highlighted row. Returns false when nothing is highlighted. */
  pickActive(): boolean {
    const row = this.pickable()[this.active];
    if (!row) return false;
    this.callbacks.onPick(row);
    return true;
  }

  private pickable(): MenuRow[] {
    return this.rows.filter((r) => r.kind !== 'message');
  }

  private mount(): void {
    const host = document.createElement('vibepass-menu');
    // Inline !important beats page styles that target the element.
    host.setAttribute(
      'style',
      [
        'position: fixed',
        'inset: auto',
        'margin: 0',
        'padding: 0',
        'border: 0',
        'background: transparent',
        'overflow: visible',
        'display: block',
        'z-index: 2147483647',
        'color-scheme: light dark',
      ]
        .map((rule) => `${rule} !important`)
        .join('; '),
    );
    host.setAttribute('popover', 'manual');
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    const list = document.createElement('div');
    list.className = 'menu';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Vibepass logins');
    // Keep focus in the page's field, so typing and Tab still work there.
    list.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });
    list.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      const target = event.target instanceof Element ? event.target.closest('[data-index]') : null;
      const index = Number(target?.getAttribute('data-index') ?? -1);
      const row = this.pickable()[index];
      if (row) this.callbacks.onPick(row);
    });
    root.append(style, list);
    document.documentElement.append(host);
    // Older browsers lack the popover API even though the DOM types always declare it.
    const popover = host as Partial<Pick<HTMLElement, 'showPopover'>>;
    try {
      popover.showPopover?.call(host);
    } catch {
      // Not supported or not allowed here: the fixed position and z-index still apply.
    }
    this.host = host;
    this.list = list;
    addEventListener('scroll', this.schedule, { capture: true, passive: true });
    addEventListener('resize', this.schedule, { passive: true });
  }

  private render(): void {
    const list = this.list;
    if (!list) return;
    list.replaceChildren();
    const brand = document.createElement('div');
    brand.className = 'brand';
    brand.textContent = 'Vibepass';
    list.append(brand);
    let index = 0;
    for (const row of this.rows) {
      const { name, sub } = rowLabel(row);
      if (row.kind === 'message') {
        const el = document.createElement('div');
        el.className = 'message';
        el.textContent = name;
        list.append(el);
        continue;
      }
      const el = document.createElement('div');
      el.className = 'row';
      el.setAttribute('role', 'option');
      el.setAttribute('data-index', String(index));
      el.setAttribute('aria-selected', String(index === this.active));
      const nameEl = document.createElement('span');
      nameEl.className = 'name';
      nameEl.textContent = name;
      el.append(nameEl);
      if (sub) {
        const subEl = document.createElement('span');
        subEl.className = 'sub';
        subEl.textContent = sub;
        el.append(subEl);
      }
      el.addEventListener('mousemove', () => {
        const at = Number(el.getAttribute('data-index'));
        if (at !== this.active) {
          this.active = at;
          this.render();
        }
      });
      list.append(el);
      if (index === this.active) el.scrollIntoView({ block: 'nearest' });
      index += 1;
    }
  }

  private readonly schedule = (): void => {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      this.reposition();
    });
  };

  /**
   * Anchor under the field (or above it when there's no room below), in viewport coordinates.
   * getBoundingClientRect already accounts for scrolling and CSS transforms on the field.
   */
  reposition(): void {
    const host = this.host;
    const anchor = this.anchor;
    if (!host || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    if (!anchor.isConnected || (rect.width === 0 && rect.height === 0 && rect.top === 0)) {
      // The field went away (a multi-step form moved on): drop the menu with it.
      if (!anchor.isConnected) this.close();
      return;
    }
    const viewportWidth = document.documentElement.clientWidth || innerWidth;
    const viewportHeight = document.documentElement.clientHeight || innerHeight;
    const width = Math.min(Math.max(rect.width, MENU_WIDTH_MIN), viewportWidth - 2 * GAP);
    const left = Math.min(Math.max(rect.left, GAP), viewportWidth - width - GAP);
    const height = host.getBoundingClientRect().height || MENU_MAX_HEIGHT;
    const below = rect.bottom + GAP;
    const top =
      below + height > viewportHeight && rect.top - GAP - height >= 0
        ? rect.top - GAP - height
        : below;
    host.style.setProperty('top', `${String(Math.round(top))}px`, 'important');
    host.style.setProperty('left', `${String(Math.round(left))}px`, 'important');
    host.style.setProperty('width', `${String(Math.round(width))}px`, 'important');
  }
}

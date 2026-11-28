/**
 * The inline menu: a short list of matching logins under a focused login field, or of cards and
 * identities under a payment or address field. It lives in a
 * closed shadow root, so the page can't read or restyle it, and in the top layer (a manual
 * popover) where the browser supports it, so page modals don't cover it. It never holds
 * secrets: rows carry names and usernames, and a pick asks the worker to fill.
 *
 * Only trusted input picks a row: the page can't script a click or Enter into it.
 */
import type { InlineMenuItem } from '../shared/messages';

export type MenuRow =
  | { kind: 'item'; item: InlineMenuItem }
  | { kind: 'unlock'; what?: 'card' | 'identity' }
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
  display: flex;
  flex-direction: column;
  max-height: ${String(MENU_MAX_HEIGHT)}px;
  overflow: hidden;
  border-radius: 10px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: #fff;
  color: #1c1c1e;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
  font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.08);
  color: #6b6b70;
}
.head svg { flex: none; }
.head input {
  all: unset;
  flex: 1;
  min-width: 0;
  padding: 8px 0;
  color: #1c1c1e;
  font: inherit;
}
.head input::placeholder { color: #8e8e93; }
.head input::-webkit-search-cancel-button { display: none; }
.clear {
  all: unset;
  flex: none;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  cursor: pointer;
}
.clear:hover { background: rgba(0, 0, 0, 0.06); color: #1c1c1e; }
.brand { flex: none; font-size: 11px; font-weight: 600; letter-spacing: 0.02em; }
.head.plain { padding: 6px 10px 4px; border-bottom: 0; }
.head [hidden] { display: none; }
.list { overflow-y: auto; padding: 4px; scrollbar-width: thin; }
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
}
.row[aria-selected="true"] { background: #e8f0fe; }
.avatar {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  background: #e5e9fb;
  color: #3b5bdb;
  font-weight: 700;
  font-size: 11px;
}
.text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sub { color: #6b6b70; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.message { padding: 6px; color: #6b6b70; }
@media (prefers-color-scheme: dark) {
  .menu { background: #2c2c2e; color: #f2f2f7; border-color: rgba(255, 255, 255, 0.14); }
  .head { border-color: rgba(255, 255, 255, 0.1); }
  .head input { color: #f2f2f7; }
  .clear:hover { background: rgba(255, 255, 255, 0.1); color: #f2f2f7; }
  .row[aria-selected="true"] { background: #3a3f4b; }
  .avatar { background: #3a3f5c; color: #a5b4fc; }
  .head, .sub, .message { color: #a1a1a6; }
}
`;

/** A Lucide glyph, built as DOM so the content script needs no icon library. */
function icon(...paths: string[]): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [name, value] of Object.entries({
    width: '14',
    height: '14',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'aria-hidden': 'true',
  })) {
    svg.setAttribute(name, value);
  }
  for (const d of paths) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

const searchIcon = () => icon('m21 21-4.34-4.34', 'M3 11a8 8 0 1 0 16 0a8 8 0 1 0 -16 0');
const clearIcon = () => icon('M18 6 6 18', 'm6 6 12 12');

/** The letter badge beside a row; the arrow and spark mark the unlock and generate rows. */
function avatar(row: MenuRow): string {
  if (row.kind === 'unlock') return '\u2192';
  if (row.kind === 'generate') return '\u2726';
  if (row.kind === 'item') return (row.item.name.trim()[0] ?? '?').toUpperCase();
  return '';
}

/** What the rows are, for the search box and screen readers: "login", "card", or "identity". */
function nounOf(rows: readonly MenuRow[]): { one: string; many: string } {
  for (const row of rows) {
    if (row.kind !== 'item') continue;
    if (row.item.type === 'card') return { one: 'card', many: 'cards' };
    if (row.item.type === 'identity') return { one: 'identity', many: 'identities' };
    break;
  }
  return { one: 'login', many: 'logins' };
}

function rowLabel(row: MenuRow): { name: string; sub: string | null } {
  if (row.kind === 'unlock') {
    const what =
      row.what === 'card' ? 'a card' : row.what === 'identity' ? 'an address' : 'a login';
    return { name: 'Unlock Vibepass', sub: `to fill ${what} here` };
  }
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
  private search: HTMLInputElement | null = null;
  private head: HTMLElement | null = null;
  private clear: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private allRows: MenuRow[] = [];
  private announcement: HTMLElement | null = null;
  private rows: MenuRow[] = [];
  private noun = { one: 'login', many: 'logins' };
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
    this.allRows = rows;
    if (rows.some((row) => row.kind === 'item')) this.noun = nounOf(rows);
    if (!this.host) this.mount();
    if (this.search) {
      this.search.placeholder = `Search ${this.noun.many}`;
      this.search.setAttribute('aria-label', `Search these ${this.noun.many}`);
    }
    this.list?.setAttribute('aria-label', `Vibepass ${this.noun.many}`);
    if (this.search && this.head) {
      // Search only makes sense over logins; an unlock or generate row gets a plain header.
      const searchable = rows.some((row) => row.kind === 'item');
      this.search.hidden = !searchable;
      if (!searchable) this.search.value = '';
      if (this.clear) this.clear.hidden = this.search.value === '';
      this.head.classList.toggle('plain', !searchable);
      this.head.querySelector('svg')?.toggleAttribute('hidden', !searchable);
    }
    this.filter();
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
    this.announcement = null;
    this.search = null;
    this.head = null;
    this.clear = null;
    this.root = null;
    this.allRows = [];
    this.rows = [];
    this.noun = { one: 'login', many: 'logins' };
    this.active = -1;
    this.anchor = null;
  }

  focusSearch(): boolean {
    if (!this.search || this.search.hidden) return false;
    this.search.focus();
    return true;
  }

  containsFocusTarget(target: EventTarget | null): boolean {
    return target !== null && target === this.host;
  }

  private filter(): void {
    const query = this.search?.value.trim().toLowerCase();
    this.rows = query
      ? this.allRows.filter(
          (row) =>
            row.kind === 'item' &&
            (row.item.name.toLowerCase().includes(query) ||
              row.item.username?.toLowerCase().includes(query)),
        )
      : this.allRows;
    if (!this.rows.length) {
      this.rows = [{ kind: 'message', text: `No matching ${this.noun.many}` }];
    }
    this.active = -1;
    this.render();
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
    this.root = root;
    const style = document.createElement('style');
    style.textContent = STYLE;
    const panel = document.createElement('div');
    panel.className = 'menu';
    const list = document.createElement('div');
    list.className = 'list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Vibepass logins');
    // Keep focus in the page's field, so typing and Tab still work there.
    panel.addEventListener('mousedown', (event) => {
      // The search box takes focus normally; everything else leaves it in the page's field.
      if (event.target !== this.search) event.preventDefault();
    });
    list.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      const target = event.target instanceof Element ? event.target.closest('[data-index]') : null;
      const index = Number(target?.getAttribute('data-index') ?? -1);
      const row = this.pickable()[index];
      if (row) this.callbacks.onPick(row);
    });
    const status = document.createElement('div');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    status.style.cssText =
      'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)';
    this.announcement = status;
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Search logins';
    search.setAttribute('aria-label', 'Search these logins');
    search.autocomplete = 'off';
    search.spellcheck = false;
    const head = document.createElement('div');
    head.className = 'head';
    const brand = document.createElement('span');
    brand.className = 'brand';
    brand.textContent = 'Vibepass';
    this.head = head;
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'clear';
    clear.title = 'Clear search';
    clear.setAttribute('aria-label', 'Clear search');
    clear.tabIndex = -1;
    clear.hidden = true;
    clear.append(clearIcon());
    clear.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      search.value = '';
      clear.hidden = true;
      this.filter();
      // Keep typing where the user was: the search box if it had focus, else the page's field.
      if (this.root?.activeElement === search) search.focus();
    });
    this.clear = clear;
    head.append(searchIcon(), search, clear, brand);
    search.addEventListener('input', () => {
      clear.hidden = search.value === '';
      this.filter();
    });
    search.addEventListener('keydown', (event) => {
      if (!event.isTrusted) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        this.move(event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Escape' && search.value !== '') {
        // First Escape clears the search, the next one closes the menu.
        search.value = '';
        clear.hidden = true;
        this.filter();
      } else if (event.key === 'Escape') {
        this.anchor?.focus();
        this.close();
      } else if (event.key !== 'Enter' || !this.pickActive()) return;
      event.preventDefault();
      event.stopPropagation();
    });
    search.addEventListener('blur', (event) => {
      if (event.relatedTarget !== this.anchor) this.close();
    });
    this.search = search;
    panel.append(head, list);
    root.append(style, panel, status);
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
    const choices = this.pickable();
    const active = choices[this.active];
    const only = this.rows.length === 1 ? this.rows[0] : null;
    const count = choices.length;
    const description = active ? Object.values(rowLabel(active)).filter(Boolean).join(', ') : null;
    const summary =
      only && only.kind !== 'item'
        ? rowLabel(only).name
        : `${String(count)} saved ${count === 1 ? this.noun.one : this.noun.many}`;
    const spoken = description
      ? `${description}, ${String(this.active + 1)} of ${String(count)}`
      : `Vibepass. ${summary}.${count ? ' Use arrow keys to choose.' : ''}`;
    if (this.announcement && this.announcement.textContent !== spoken)
      this.announcement.textContent = spoken;
    list.replaceChildren();
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
      const badge = document.createElement('span');
      badge.className = 'avatar';
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = avatar(row);
      const text = document.createElement('span');
      text.className = 'text';
      const nameEl = document.createElement('span');
      nameEl.className = 'name';
      nameEl.textContent = name;
      text.append(nameEl);
      if (sub) {
        const subEl = document.createElement('span');
        subEl.className = 'sub';
        subEl.textContent = sub;
        text.append(subEl);
      }
      el.append(badge, text);
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

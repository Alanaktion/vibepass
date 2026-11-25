/**
 * The save and update banner: a small, non-modal card in the page's top-right corner after a
 * login form is submitted. Like the inline menu it lives in a closed shadow root in the top
 * layer, holds no secrets (names and usernames only; the password stays in the worker), and only
 * trusted clicks and key presses answer it, so the page can't save or dismiss on the user's behalf.
 */
import type { SaveAnswer, SavePrompt } from '../shared/messages';

export interface BannerCallbacks {
  /** Send the answer to the worker; resolves to a short confirmation to show, or throws. */
  onAnswer(answer: SaveAnswer): Promise<string>;
}

const STYLE = `
:host { all: initial; }
.card {
  box-sizing: border-box;
  width: 320px;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  background: #fff;
  color: #1c1c1e;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.2);
  font: 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.brand { color: #6b6b70; font-size: 11px; letter-spacing: 0.02em; }
.title { font-weight: 600; font-size: 14px; overflow-wrap: anywhere; }
.sub { color: #6b6b70; overflow-wrap: anywhere; }
label { display: flex; flex-direction: column; gap: 3px; color: #6b6b70; font-size: 12px; }
input, select {
  font: inherit; color: inherit; background: transparent;
  padding: 6px 8px; border: 1px solid rgba(0, 0, 0, 0.2); border-radius: 6px;
}
.actions { display: flex; gap: 6px; align-items: center; }
.grow { flex: 1; }
button {
  font: inherit; cursor: pointer; padding: 6px 12px; border-radius: 6px;
  border: 1px solid rgba(0, 0, 0, 0.2); background: transparent; color: inherit;
}
button.primary { background: #3b5bdb; border-color: #3b5bdb; color: #fff; }
button.link { border: 0; padding: 4px 0; color: #6b6b70; text-decoration: underline; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #3b5bdb; outline-offset: 1px; }
.error { color: #c92a2a; }
@media (prefers-color-scheme: dark) {
  .card { background: #2c2c2e; color: #f2f2f7; border-color: rgba(255, 255, 255, 0.14); }
  .brand, .sub, label, button.link { color: #a1a1a6; }
  input, select, button { border-color: rgba(255, 255, 255, 0.25); }
  button.primary { background: #748ffc; border-color: #748ffc; color: #0b0b0f; }
  .error { color: #ff8787; }
}
`;

/** How long a confirmation ("Saved") stays before the banner goes away. */
const CONFIRM_MS = 2500;

export class SaveBanner {
  private host: HTMLElement | null = null;
  private card: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The prompt on screen, so the same one isn't rebuilt (and an edited name lost). */
  private shown: string | null = null;

  constructor(private readonly callbacks: BannerCallbacks) {}

  get isOpen(): boolean {
    return this.host !== null;
  }

  show(prompt: SavePrompt): void {
    const key = JSON.stringify(prompt);
    if (this.host && this.shown === key) return;
    this.close();
    this.shown = key;
    this.mount();
    this.render(prompt);
  }

  close(): void {
    clearTimeout(this.timer);
    this.host?.remove();
    this.host = null;
    this.card = null;
    this.shown = null;
  }

  private mount(): void {
    const host = document.createElement('vibepass-banner');
    host.setAttribute(
      'style',
      [
        'position: fixed',
        'top: 12px',
        'right: 12px',
        'left: auto',
        'bottom: auto',
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
    const card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Vibepass');
    card.addEventListener('keydown', (event) => {
      if (event.isTrusted && event.key === 'Escape') {
        event.stopPropagation();
        void this.answer({ action: 'dismiss' });
      }
    });
    root.append(style, card);
    document.documentElement.append(host);
    const popover = host as Partial<Pick<HTMLElement, 'showPopover'>>;
    try {
      popover.showPopover?.call(host);
    } catch {
      // No popover support: the fixed position and z-index still apply.
    }
    this.host = host;
    this.card = card;
  }

  private el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  /** A button that only answers to a real click (or Enter or Space on it). */
  private button(label: string, className: string, onClick: () => void): HTMLButtonElement {
    const button = this.el('button', className, label);
    button.type = 'button';
    button.addEventListener('click', (event) => {
      if (event.isTrusted) onClick();
    });
    return button;
  }

  private render(prompt: SavePrompt): void {
    const card = this.card;
    if (!card) return;
    card.replaceChildren(this.el('div', 'brand', 'Vibepass'));
    const status = this.el('div', 'error');
    status.setAttribute('role', 'status');

    if (prompt.kind === 'save') {
      card.append(this.el('div', 'title', `Save this login for ${prompt.host}?`));
      if (prompt.username) card.append(this.el('div', 'sub', prompt.username));
      const label = this.el('label', '', 'Name');
      const name = this.el('input', '');
      name.value = prompt.suggestedName;
      name.addEventListener('keydown', (event) => {
        if (event.isTrusted && event.key === 'Enter') {
          event.preventDefault();
          void this.answer({ action: 'save', name: name.value }, status);
        }
      });
      label.append(name);
      card.append(label);
      const actions = this.el('div', 'actions');
      actions.append(
        this.button('Save', 'primary', () => {
          void this.answer({ action: 'save', name: name.value }, status);
        }),
        this.button('Not now', '', () => {
          void this.answer({ action: 'dismiss' });
        }),
        this.el('span', 'grow'),
        this.button('Never for this site', 'link', () => {
          void this.answer({ action: 'never' });
        }),
      );
      card.append(actions, status);
      return;
    }

    const [first] = prompt.items;
    card.append(
      this.el(
        'div',
        'title',
        prompt.items.length === 1 && first
          ? `Update the password for ${first.name}?`
          : `Update a saved password for ${prompt.host}?`,
      ),
    );
    if (prompt.username) card.append(this.el('div', 'sub', prompt.username));
    let select: HTMLSelectElement | null = null;
    if (prompt.items.length > 1) {
      const label = this.el('label', '', 'Login');
      select = this.el('select', '');
      for (const item of prompt.items) {
        const option = this.el(
          'option',
          '',
          item.username ? `${item.name} (${item.username})` : item.name,
        );
        option.value = item.id;
        select.append(option);
      }
      label.append(select);
      card.append(label);
    }
    const actions = this.el('div', 'actions');
    actions.append(
      this.button('Update', 'primary', () => {
        const id = select?.value ?? first?.id;
        if (id) void this.answer({ action: 'update', id }, status);
      }),
      this.button('Not now', '', () => {
        void this.answer({ action: 'dismiss' });
      }),
    );
    card.append(actions, status);
  }

  private async answer(answer: SaveAnswer, status?: HTMLElement): Promise<void> {
    try {
      const message = await this.callbacks.onAnswer(answer);
      if (!message || !this.card) {
        this.close();
        return;
      }
      this.card.replaceChildren(
        this.el('div', 'brand', 'Vibepass'),
        this.el('div', 'title', message),
      );
      this.timer = setTimeout(() => {
        this.close();
      }, CONFIRM_MS);
    } catch (error) {
      if (status) status.textContent = error instanceof Error ? error.message : 'Could not save';
      else this.close();
    }
  }
}

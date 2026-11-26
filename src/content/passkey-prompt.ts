/**
 * The passkey prompt: Vibepass's own card, shown when a site asks for a passkey. It looks and
 * behaves like the save banner (closed shadow root, top layer, trusted input only), so the page
 * can neither read it nor click it on the user's behalf. It shows names and usernames, never keys.
 */
import type { PasskeyChoice } from '../shared/messages';
import { CARD_STYLE } from './banner';

const EXTRA_STYLE = `
.list { display: flex; flex-direction: column; gap: 4px; }
button.choice {
  display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
  text-align: left; padding: 8px 10px; width: 100%;
}
button.choice .who { color: #6b6b70; font-size: 12px; overflow-wrap: anywhere; }
@media (prefers-color-scheme: dark) { button.choice .who { color: #a1a1a6; } }
`;

export type GetAnswer =
  { action: 'pick'; choice: PasskeyChoice } | { action: 'cancel' } | { action: 'browser' };

export type CreateAnswer =
  { action: 'save'; cipherId: string | null } | { action: 'cancel' } | { action: 'browser' };

export type LockedAnswer = { action: 'unlock' } | { action: 'cancel' } | { action: 'browser' };

const BROWSER_LABEL = 'Use another device or security key';

export class PasskeyPrompt {
  private host: HTMLElement | null = null;
  private card: HTMLElement | null = null;
  private status: HTMLElement | null = null;
  private onEscape: (() => void) | null = null;

  get isOpen(): boolean {
    return this.host !== null;
  }

  close(): void {
    this.host?.remove();
    this.host = null;
    this.card = null;
    this.status = null;
    this.onEscape = null;
  }

  /** Show a message in the card's status line (an error from the worker). */
  error(text: string): void {
    if (this.status) this.status.textContent = text;
  }

  /** Sign in: pick one of the site's passkeys. */
  choose(rpId: string, passkeys: PasskeyChoice[]): Promise<GetAnswer> {
    return new Promise((resolve) => {
      const card = this.open(() => {
        resolve({ action: 'cancel' });
      });
      card.append(this.el('div', 'title', `Sign in to ${rpId} with a passkey`));
      const list = this.el('div', 'list');
      for (const choice of passkeys) {
        const button = this.button('', 'choice', () => {
          resolve({ action: 'pick', choice });
        });
        button.append(this.el('span', '', choice.name));
        if (choice.userName) button.append(this.el('span', 'who', choice.userName));
        list.append(button);
      }
      card.append(list);
      this.actions(card, [
        this.button('Cancel', '', () => {
          resolve({ action: 'cancel' });
        }),
      ]);
      this.actions(card, [
        this.button(BROWSER_LABEL, 'link', () => {
          resolve({ action: 'browser' });
        }),
      ]);
      this.end(card);
      list.querySelector('button')?.focus();
    });
  }

  /** Make a passkey: save it as a new login or on a login the site already has. */
  save(
    rpId: string,
    userName: string,
    logins: { id: string; name: string; username: string | null }[],
  ): Promise<CreateAnswer> {
    return new Promise((resolve) => {
      const card = this.open(() => {
        resolve({ action: 'cancel' });
      });
      card.append(this.el('div', 'title', `Save a passkey for ${rpId}?`));
      if (userName) card.append(this.el('div', 'sub', userName));
      let select: HTMLSelectElement | null = null;
      if (logins.length > 0) {
        const label = this.el('label', '', 'Save in');
        select = this.el('select', '');
        for (const login of logins) {
          const option = this.el(
            'option',
            '',
            login.username ? `${login.name} (${login.username})` : login.name,
          );
          option.value = login.id;
          select.append(option);
        }
        const fresh = this.el('option', '', 'A new login');
        fresh.value = '';
        select.append(fresh);
        label.append(select);
        card.append(label);
      }
      const save = this.button('Save passkey', 'primary', () => {
        resolve({ action: 'save', cipherId: select?.value || null });
      });
      this.actions(card, [
        save,
        this.button('Cancel', '', () => {
          resolve({ action: 'cancel' });
        }),
      ]);
      this.actions(card, [
        this.button(BROWSER_LABEL, 'link', () => {
          resolve({ action: 'browser' });
        }),
      ]);
      this.end(card);
      save.focus();
    });
  }

  /** Saving answered: show "Saving…" until the worker is done. */
  busy(text: string): void {
    if (!this.card) return;
    for (const button of this.card.querySelectorAll('button, select')) {
      (button as HTMLButtonElement).disabled = true;
    }
    this.error('');
    if (this.status) this.status.textContent = text;
  }

  /** The vault is locked: unlock in the popup, or use the browser instead. */
  locked(): Promise<LockedAnswer> {
    return new Promise((resolve) => {
      const card = this.open(() => {
        resolve({ action: 'cancel' });
      });
      card.append(
        this.el('div', 'title', 'Vibepass is locked'),
        this.el('div', 'sub', 'Unlock Vibepass to use a passkey saved in your vault.'),
      );
      const unlock = this.button('Unlock', 'primary', () => {
        resolve({ action: 'unlock' });
      });
      this.actions(card, [
        unlock,
        this.button('Cancel', '', () => {
          resolve({ action: 'cancel' });
        }),
      ]);
      this.actions(card, [
        this.button(BROWSER_LABEL, 'link', () => {
          resolve({ action: 'browser' });
        }),
      ]);
      this.end(card);
      unlock.focus();
    });
  }

  /** Waiting for the user to unlock in the popup. */
  waiting(onCancel: () => void, onBrowser: () => void): void {
    const card = this.open(onCancel);
    card.append(
      this.el('div', 'title', 'Unlock Vibepass to continue'),
      this.el('div', 'sub', 'Your passkeys will show here once Vibepass is unlocked.'),
    );
    this.actions(card, [this.button('Cancel', '', onCancel)]);
    this.actions(card, [this.button(BROWSER_LABEL, 'link', onBrowser)]);
    this.end(card);
  }

  /** The site already knows a passkey in the vault for this account. */
  already(rpId: string, name: string): Promise<void> {
    return new Promise((resolve) => {
      const card = this.open(() => {
        resolve();
      });
      card.append(
        this.el('div', 'title', 'You already have a passkey here'),
        this.el('div', 'sub', `“${name}” in Vibepass has a passkey for this account on ${rpId}.`),
      );
      const ok = this.button('OK', 'primary', () => {
        resolve();
      });
      this.actions(card, [ok]);
      this.end(card);
      ok.focus();
    });
  }

  private open(onEscape: () => void): HTMLElement {
    if (!this.host) this.mount();
    const card = this.card;
    if (!card) throw new Error('Prompt not mounted');
    card.replaceChildren(this.el('div', 'brand', 'Vibepass'));
    const status = this.el('div', 'error');
    status.setAttribute('role', 'status');
    this.status = status;
    this.onEscape = onEscape;
    return card;
  }

  /** The status line goes last. */
  private end(card: HTMLElement): void {
    if (this.status) card.append(this.status);
  }

  private actions(card: HTMLElement, children: HTMLElement[]): void {
    const row = this.el('div', 'actions');
    row.append(...children);
    card.append(row);
  }

  private mount(): void {
    const host = document.createElement('vibepass-passkey');
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
    style.textContent = CARD_STYLE + EXTRA_STYLE;
    const card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Vibepass passkey');
    card.addEventListener('keydown', (event) => {
      if (event.isTrusted && event.key === 'Escape') {
        event.stopPropagation();
        this.onEscape?.();
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
}

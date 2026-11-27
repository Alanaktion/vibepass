import { beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';
import {
  detectLoginFields,
  restoreBrowserAutocomplete,
  suppressBrowserAutocomplete,
} from '../src/content/detect';
import { InlineMenu } from '../src/content/menu';
import type { InlineMenuState } from '../src/shared/messages';

const ITEM = { id: 'item-1', name: 'Example', username: 'alice', reprompt: false, recent: false };

function page(html: string) {
  document.body.innerHTML = html;
}

/** Answer the content script's messages like the worker would. */
function worker(state: InlineMenuState) {
  const sent: { type: string; payload: unknown }[] = [];
  vi.mocked(browser.runtime.sendMessage).mockImplementation((message: unknown) => {
    const { type, payload } = message as { type: string; payload: unknown };
    sent.push({ type, payload });
    if (type === 'autofill:menu') return Promise.resolve({ ok: true, data: state });
    if (type === 'autofill:menu-fill') {
      return Promise.resolve({ ok: true, data: { filled: ['username'], copiedTotp: false } });
    }
    return Promise.resolve({ ok: true, data: undefined });
  });
  return sent;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const menuHost = () => document.querySelector('vibepass-menu');

describe('more form types', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('finds a split login: username and password in separate forms', () => {
    page(`
      <form><input type="search" name="q"></form>
      <form id="a"><input id="u" type="email" name="email"></form>
      <form id="b"><input id="p" type="password"></form>`);
    const fields = detectLoginFields();
    expect(fields.username?.id).toBe('u');
    expect(fields.password?.id).toBe('p');
  });

  it('does not take a vague field from another form as the username', () => {
    page(`
      <form><input id="t" type="text" name="title"></form>
      <form><input id="p" type="password"></form>`);
    expect(detectLoginFields().username).toBeNull();
  });

  it('finds the username step of a multi-step login by its name', () => {
    page(`<form><input id="u" type="text" name="username"><button>Next</button></form>`);
    expect(detectLoginFields().username?.id).toBe('u');
    // Two vague candidates: not sure which, so neither.
    page(`<form><input name="login"><input name="account"></form>`);
    expect(detectLoginFields().username).toBeNull();
  });

  it('finds the password step of a multi-step login on its own', () => {
    page(`<form><input type="hidden" name="email"><input id="p" type="password"></form>`);
    const fields = detectLoginFields();
    expect(fields.password?.id).toBe('p');
    expect(fields.username).toBeNull();
  });

  it('keeps detecting by the page’s own autocomplete while the browser dropdown is off', () => {
    page(`<form><input id="u" autocomplete="username"></form>`);
    const input = document.getElementById('u') as HTMLInputElement;
    suppressBrowserAutocomplete(input);
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(detectLoginFields().username).toBe(input);
    restoreBrowserAutocomplete(input);
    expect(input.getAttribute('autocomplete')).toBe('username');

    page(`<form><input id="n" type="email"></form>`);
    const bare = document.getElementById('n') as HTMLInputElement;
    suppressBrowserAutocomplete(bare);
    restoreBrowserAutocomplete(bare);
    expect(bare.hasAttribute('autocomplete')).toBe(false);
  });
});

describe('inline menu', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('shows matching logins on a login field, and fills the one picked', async () => {
    const sent = worker({ state: 'unlocked', items: [ITEM] });
    const content = await import('../src/content/index');
    page('<form><input id="u" name="user"><input id="p" type="password"></form>');
    const password = document.getElementById('p') as HTMLInputElement;
    password.focus();
    await flush();
    expect(menuHost()).not.toBeNull();
    // The closed shadow root keeps the page out.
    expect(menuHost()?.shadowRoot).toBeNull();
    expect(password.getAttribute('autocomplete')).toBe('off');

    const menu = content.inlineMenu();
    expect(menu.anchor).toBe(password);
    menu.move(1);
    expect(menu.pickActive()).toBe(true);
    await flush();
    expect(sent).toContainEqual({ type: 'autofill:menu-fill', payload: { id: 'item-1' } });

    password.blur();
    expect(menuHost()).toBeNull();
    expect(password.hasAttribute('autocomplete')).toBe(false);
  });

  it('searches inside the closed menu and announces the current choice', () => {
    const attach = vi.spyOn(HTMLElement.prototype, 'attachShadow');
    const onPick = vi.fn();
    const menu = new InlineMenu({ onPick });
    page('<input id="password" type="password">');
    const anchor = document.querySelector('input')!;
    try {
      menu.open(anchor, [
        { kind: 'item', item: ITEM },
        { kind: 'item', item: { ...ITEM, id: 'work', name: 'Work account', username: 'bob' } },
      ]);
      const root = attach.mock.results.at(-1)!.value as ShadowRoot;
      const filter = root.querySelector('input')!;
      const status = root.querySelector('[role=status]')!;
      expect(status.textContent).toContain('2 saved logins');
      expect(menu.focusSearch()).toBe(true);
      filter.value = 'BOB';
      filter.dispatchEvent(new Event('input'));
      expect(status.textContent).toContain('1 saved login');
      menu.move(1);
      expect(status.textContent).toContain('Work account, bob, 1 of 1');
      expect(menu.pickActive()).toBe(true);
      expect(onPick).toHaveBeenCalledWith(
        expect.objectContaining({ item: expect.objectContaining({ id: 'work' }) }),
      );
      filter.value = 'absent';
      filter.dispatchEvent(new Event('input'));
      expect(menu.pickActive()).toBe(false);
      expect(status.textContent).toContain('No matching logins');
      expect(anchor.value).toBe('');
    } finally {
      menu.close();
      attach.mockRestore();
    }
  });

  it('clears the search with its button or Escape, then closes on the next Escape', () => {
    const attach = vi.spyOn(HTMLElement.prototype, 'attachShadow');
    const menu = new InlineMenu({ onPick: vi.fn() });
    page('<input id="password" type="password">');
    const anchor = document.querySelector('input')!;
    try {
      menu.open(anchor, [
        { kind: 'item', item: ITEM },
        { kind: 'item', item: { ...ITEM, id: 'work', name: 'Work account', username: 'bob' } },
      ]);
      const root = attach.mock.results.at(-1)!.value as ShadowRoot;
      const filter = root.querySelector('input')!;
      const clear = root.querySelector<HTMLButtonElement>('button.clear')!;
      const status = root.querySelector('[role=status]')!;
      expect(clear.hidden).toBe(true);
      filter.value = 'bob';
      filter.dispatchEvent(new Event('input'));
      expect(clear.hidden).toBe(false);
      expect(status.textContent).toContain('1 saved login');
      // The page can't script the button.
      clear.click();
      expect(filter.value).toBe('bob');

      menu.focusSearch();
      // A real key press: happy-dom marks dispatched events untrusted.
      const escape = () => {
        const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
        Object.defineProperty(event, 'isTrusted', { value: true });
        filter.dispatchEvent(event);
      };
      escape();
      expect(filter.value).toBe('');
      expect(clear.hidden).toBe(true);
      expect(status.textContent).toContain('2 saved logins');
      expect(menu.isOpen).toBe(true);
      escape();
      expect(menu.isOpen).toBe(false);
    } finally {
      menu.close();
      attach.mockRestore();
    }
  });

  it('ignores key presses the page scripted', async () => {
    const sent = worker({ state: 'unlocked', items: [ITEM] });
    const content = await import('../src/content/index');
    page('<form><input id="u" name="user"><input id="p" type="password"></form>');
    const password = document.getElementById('p') as HTMLInputElement;
    password.focus();
    await flush();
    for (const key of ['ArrowDown', 'Enter']) {
      password.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    }
    await flush();
    expect(sent.some((m) => m.type === 'autofill:menu-fill')).toBe(false);
    expect(content.inlineMenu().isOpen).toBe(true);
    password.blur();
  });

  it('stays out of the way when nothing matches or it is turned off', async () => {
    const content = await import('../src/content/index');
    page('<form><input id="u" name="user"><input id="p" type="password"></form>');
    const password = document.getElementById('p') as HTMLInputElement;
    expect(content.menuRows({ state: 'unlocked', items: [] }, password)).toEqual([]);
    expect(content.menuRows({ state: 'off' }, password)).toEqual([]);
    expect(content.menuRows({ state: 'locked' }, password)).toEqual([{ kind: 'unlock' }]);
    // Not a login field.
    page('<input id="q" type="search">');
    const search = document.getElementById('q') as HTMLInputElement;
    expect(content.menuRows({ state: 'unlocked', items: [ITEM] }, search)).toEqual([]);
  });

  it('offers to unlock only on clear login fields, not on any email box', async () => {
    const content = await import('../src/content/index');
    page('<form><input id="e" type="email" name="email"></form>');
    const email = document.getElementById('e') as HTMLInputElement;
    expect(content.menuRows({ state: 'locked' }, email)).toEqual([]);
    expect(content.menuRows({ state: 'unlocked', items: [ITEM] }, email)).toHaveLength(1);
    // A newsletter box is no login at all (Bitwarden's non-login keywords).
    page('<form><input id="n" type="email" name="newsletter"></form>');
    const newsletter = document.getElementById('n') as HTMLInputElement;
    expect(content.menuRows({ state: 'unlocked', items: [ITEM] }, newsletter)).toEqual([]);
    page('<form><input id="u" type="email" autocomplete="username"></form>');
    const user = document.getElementById('u') as HTMLInputElement;
    expect(content.menuRows({ state: 'locked' }, user)).toEqual([{ kind: 'unlock' }]);
  });

  it('opens the popup for a locked vault or a re-prompt login', async () => {
    const sent = worker({ state: 'locked' });
    const content = await import('../src/content/index');
    page('<form><input id="p" type="password"></form>');
    const password = document.getElementById('p') as HTMLInputElement;
    password.focus();
    await flush();
    const menu = content.inlineMenu();
    menu.move(1);
    menu.pickActive();
    await flush();
    expect(sent.some((m) => m.type === 'autofill:open-popup')).toBe(true);
    expect(sent.some((m) => m.type === 'autofill:menu-fill')).toBe(false);
    password.blur();
  });
});

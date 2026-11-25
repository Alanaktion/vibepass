import { beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';
import { isNewPasswordField, readSubmitted } from '../src/content/detect';
import type { InlineMenuState, SavePrompt } from '../src/shared/messages';

function page(html: string) {
  document.body.innerHTML = html;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const bannerHost = () => document.querySelector('vibepass-banner');

const UNLOCKED: InlineMenuState = {
  state: 'unlocked',
  items: [],
  canGenerate: true,
  offerToSave: true,
};

function worker(prompt: SavePrompt | null, state: InlineMenuState = UNLOCKED) {
  const sent: { type: string; payload: unknown }[] = [];
  vi.mocked(browser.runtime.sendMessage).mockImplementation((message: unknown) => {
    const { type, payload } = message as { type: string; payload: unknown };
    sent.push({ type, payload });
    const data =
      type === 'autofill:menu'
        ? state
        : type === 'autofill:submitted'
          ? prompt
          : type === 'autofill:pending-prompt'
            ? { prompt: null, offer: state.state === 'unlocked' && state.offerToSave === true }
            : type === 'autofill:generate'
              ? { password: 'Generated-Strong-1' }
              : undefined;
    return Promise.resolve({ ok: true, data });
  });
  return sent;
}

describe('reading a submitted form', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  const form = () => document.querySelector('form')!;
  const fill = (values: Record<string, string>) => {
    for (const [id, value] of Object.entries(values)) {
      (document.getElementById(id) as HTMLInputElement).value = value;
    }
  };

  it('a sign-in form: username and current password', () => {
    page(`<form><input id="u" type="email"><input id="p" type="password"></form>`);
    fill({ u: 'me@example.com', p: 'secret' });
    expect(readSubmitted(form())).toEqual({
      username: 'me@example.com',
      password: 'secret',
      newPassword: null,
    });
  });

  it('a sign-up form: password and confirm are one new password', () => {
    page(`<form><input id="u" name="username"><input id="a" type="password">
      <input id="b" type="password"></form>`);
    fill({ u: 'newbie', a: 'fresh', b: 'fresh' });
    expect(readSubmitted(form())).toEqual({
      username: 'newbie',
      password: null,
      newPassword: 'fresh',
    });
    expect(isNewPasswordField(document.getElementById('a') as HTMLInputElement)).toBe(true);
  });

  it('a password change form: current, new, confirm', () => {
    page(`<form><input id="c" type="password"><input id="n" type="password">
      <input id="r" type="password"></form>`);
    fill({ c: 'old', n: 'new', r: 'new' });
    expect(readSubmitted(form())).toEqual({ username: null, password: 'old', newPassword: 'new' });
    expect(isNewPasswordField(document.getElementById('c') as HTMLInputElement)).toBe(false);
    expect(isNewPasswordField(document.getElementById('n') as HTMLInputElement)).toBe(true);
  });

  it('trusts autocomplete hints over field order', () => {
    page(`<form><input id="n" type="password" autocomplete="new-password">
      <input id="c" type="password" autocomplete="current-password"></form>`);
    fill({ n: 'new', c: 'old' });
    expect(readSubmitted(form())).toMatchObject({ password: 'old', newPassword: 'new' });
  });

  it('nothing to save without a password', () => {
    page(`<form><input id="u" type="email"><input id="p" type="password"></form>`);
    fill({ u: 'me@example.com' });
    expect(readSubmitted(form())).toBeNull();
  });
});

describe('save banner and generator on the page', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.mocked(browser.runtime.sendMessage).mockReset();
  });

  it('sends nothing until the worker says saving is on', async () => {
    const sent = worker(null, { state: 'unlocked', items: [], offerToSave: false });
    const content = await import('../src/content/index');
    page(`<form><input id="u" type="email" value="me@example.com">
      <input id="p" type="password" value="pw"></form>`);
    (document.getElementById('p') as HTMLInputElement).focus();
    await flush();
    await content.captureSubmit(document.querySelector('form')!);
    expect(sent.some((m) => m.type === 'autofill:submitted')).toBe(false);
  });

  it('shows the banner the worker asks for, in a closed shadow root', async () => {
    const prompt: SavePrompt = {
      kind: 'save',
      host: 'example.com',
      username: 'me@example.com',
      suggestedName: 'example.com',
    };
    const sent = worker(prompt);
    const content = await import('../src/content/index');
    page(`<form><input id="u" type="email" value="me@example.com">
      <input id="p" type="password" value="pw"></form>`);
    (document.getElementById('p') as HTMLInputElement).focus();
    await flush();
    await content.captureSubmit(document.querySelector('form')!);
    expect(sent.find((m) => m.type === 'autofill:submitted')?.payload).toEqual({
      username: 'me@example.com',
      password: 'pw',
      newPassword: null,
    });
    expect(bannerHost()).not.toBeNull();
    expect(bannerHost()?.shadowRoot).toBeNull();
    content.saveBanner().close();
    expect(bannerHost()).toBeNull();
  });

  it('offers a strong password on a sign-up field and fills it and its confirm field', async () => {
    const sent = worker(null);
    const content = await import('../src/content/index');
    page(`<form><input id="u" name="username"><input id="a" type="password">
      <input id="b" type="password"></form>`);
    const first = document.getElementById('a') as HTMLInputElement;
    expect(content.menuRows(UNLOCKED, first)).toEqual([{ kind: 'generate' }]);
    expect(content.menuRows({ ...UNLOCKED, canGenerate: false }, first)).toEqual([]);
    first.focus();
    await flush();
    const menu = content.inlineMenu();
    expect(menu.anchor).toBe(first);
    menu.move(1);
    expect(menu.pickActive()).toBe(true);
    await flush();
    await flush();
    expect(sent.find((m) => m.type === 'autofill:generate')?.payload).toEqual({ rules: null });
    expect(first.value).toBe('Generated-Strong-1');
    expect((document.getElementById('b') as HTMLInputElement).value).toBe('Generated-Strong-1');
  });
});

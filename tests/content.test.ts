import { beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';
import { detectLoginFields, fillInput } from '../src/content/detect';

function page(html: string) {
  document.body.innerHTML = html;
}

describe('login form detection', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('finds the username before the password in the same form', () => {
    page(`
      <input type="search" name="q" placeholder="Search">
      <form>
        <input type="email" name="email" id="email">
        <input type="password" name="password" id="pw">
        <button>Sign in</button>
      </form>`);
    const fields = detectLoginFields();
    expect(fields.username?.id).toBe('email');
    expect(fields.password?.id).toBe('pw');
    expect(fields.totp).toBeNull();
  });

  it('takes a field named only "Code" as the one-time code, but not promo or postal codes', () => {
    page(`<label for="c">Code</label><input type="text" id="c">`);
    expect(detectLoginFields().totp?.id).toBe('c');
    page(`<label for="c">Enter your code</label><input type="text" id="c">`);
    expect(detectLoginFields().totp?.id).toBe('c');
    page(`<label for="c">Promo code</label><input type="text" id="c">`);
    expect(detectLoginFields().totp).toBeNull();
    page(`<input type="text" id="c" placeholder="Postal code">`);
    expect(detectLoginFields().totp).toBeNull();
  });

  it('prefers autocomplete hints, and skips new-password fields', () => {
    page(`
      <form>
        <input type="text" name="nickname">
        <input type="text" id="user" autocomplete="username">
        <input type="password" id="new" autocomplete="new-password">
        <input type="password" id="current" autocomplete="current-password">
      </form>`);
    const fields = detectLoginFields();
    expect(fields.username?.id).toBe('user');
    expect(fields.password?.id).toBe('current');
  });

  it('ignores hidden and disabled fields', () => {
    page(`
      <form>
        <input type="text" id="hidden-user" style="display:none">
        <input type="text" id="user" name="login">
        <input type="password" id="disabled" disabled>
        <div hidden><input type="password" id="in-hidden"></div>
        <input type="password" id="pw">
      </form>`);
    const fields = detectLoginFields();
    expect(fields.username?.id).toBe('user');
    expect(fields.password?.id).toBe('pw');
  });

  it('finds forms without a form element', () => {
    page(`<div><input id="u" name="username"><input id="p" type="password"></div>`);
    expect(detectLoginFields().username?.id).toBe('u');
  });

  it('finds one-time code fields', () => {
    page(`<form><input id="otp" name="otp" inputmode="numeric" maxlength="6"></form>`);
    expect(detectLoginFields().totp?.id).toBe('otp');
    page(`<form><input id="c" autocomplete="one-time-code"></form>`);
    expect(detectLoginFields().totp?.id).toBe('c');
  });

  it('fills a lone username field only when it clearly asks for one', () => {
    page(`<form><input id="e" type="email" autocomplete="username"></form>`);
    expect(detectLoginFields().username?.id).toBe('e');
    page(`<form><input id="t" type="text" name="comment"></form>`);
    expect(detectLoginFields().username).toBeNull();
  });

  it('fills like typing, so frameworks see the change', () => {
    page(`<input id="u">`);
    const input = document.getElementById('u') as HTMLInputElement;
    const events: string[] = [];
    input.addEventListener('input', () => events.push('input'));
    input.addEventListener('change', () => events.push('change'));
    fillInput(input, 'alice');
    expect(input.value).toBe('alice');
    expect(events).toEqual(['input', 'change']);
  });
});

describe('content script', () => {
  it('reports to the background, then fills only for its own origin', async () => {
    page('<form><input name="user"><input type="password" name="pw"></form>');
    vi.mocked(browser.runtime.sendMessage).mockResolvedValue({ ok: true, data: undefined });
    const { countLoginForms, inspectPage, fillPage } = await import('../src/content/index');
    expect(countLoginForms()).toBe(1);
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'autofill:page-ready',
        payload: expect.objectContaining({ loginForms: 1 }),
      }),
    );
    expect(browser.runtime.onMessage.addListener).toHaveBeenCalled();

    expect(inspectPage().fields).toEqual({
      username: true,
      password: true,
      totp: false,
      card: false,
      identity: false,
    });

    const request = {
      source: 'vibepass' as const,
      type: 'content:fill' as const,
      origin: location.origin,
      username: 'alice',
      password: 'hunter2',
      totp: null,
    };
    expect(() => fillPage({ ...request, origin: 'https://evil.test' })).toThrow();
    expect((document.querySelector('[name=pw]') as HTMLInputElement).value).toBe('');

    expect(fillPage(request).filled).toEqual(['username', 'password']);
    expect((document.querySelector('[name=user]') as HTMLInputElement).value).toBe('alice');
    expect((document.querySelector('[name=pw]') as HTMLInputElement).value).toBe('hunter2');
  });
});

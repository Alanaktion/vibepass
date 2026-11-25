import { describe, expect, it } from 'vitest';
import browser from 'webextension-polyfill';
import { vi } from 'vitest';

describe('content script', () => {
  it('counts password fields and reports to the background', async () => {
    document.body.innerHTML = '<form><input name="u"><input type="password"></form>';
    vi.mocked(browser.runtime.sendMessage).mockResolvedValue({ ok: true, data: undefined });
    const { countLoginForms } = await import('../src/content/index');
    expect(countLoginForms()).toBe(1);
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'autofill:page-ready',
        payload: expect.objectContaining({ loginForms: 1 }),
      }),
    );
  });
});

import { describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';
import { builtInPasswordState, setBuiltInPasswordsOff } from '../src/popup/browserPasswords';

const setting = browser.privacy.services.passwordSavingEnabled;

describe("browser's built-in password manager", () => {
  it('reports unknown until the privacy permission is granted', async () => {
    vi.mocked(browser.permissions.contains).mockResolvedValue(false);
    expect(await builtInPasswordState()).toBe('unknown');
  });

  it('asks for the permission, then turns it off', async () => {
    vi.mocked(browser.permissions.contains).mockResolvedValue(true);
    vi.mocked(setting.get).mockResolvedValue({
      value: false,
      levelOfControl: 'controlled_by_this_extension',
    });
    expect(await setBuiltInPasswordsOff(true)).toBe('off-by-us');
    expect(browser.permissions.request).toHaveBeenCalledWith({ permissions: ['privacy'] });
    expect(setting.set).toHaveBeenCalledWith({ value: false });
  });

  it('hands control back', async () => {
    vi.mocked(browser.permissions.contains).mockResolvedValue(true);
    vi.mocked(setting.get).mockResolvedValue({
      value: true,
      levelOfControl: 'controllable_by_this_extension',
    });
    expect(await setBuiltInPasswordsOff(false)).toBe('on');
    expect(setting.clear).toHaveBeenCalled();
  });

  it('notices another extension or a policy in control', async () => {
    vi.mocked(browser.permissions.contains).mockResolvedValue(true);
    vi.mocked(setting.get).mockResolvedValue({
      value: false,
      levelOfControl: 'controlled_by_other_extensions',
    });
    expect(await builtInPasswordState()).toBe('other-extension');
    vi.mocked(setting.get).mockResolvedValue({ value: true, levelOfControl: 'not_controllable' });
    expect(await builtInPasswordState()).toBe('locked');
  });
});

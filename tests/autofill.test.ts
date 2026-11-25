import { describe, expect, it, vi } from 'vitest';
import { createAutofill } from '../src/background/autofill';
import { createSearchIndex } from '../src/search';
import type { ContentRequest } from '../src/shared/messages';
import { DEFAULT_SETTINGS } from '../src/storage/settings';
import { VaultState } from '../src/vault/state';
import { CipherType } from '../src/vault/types';
import { officialVaults } from './fixtures';
import { createTestService, fakeServer } from './helpers';

const fixture = officialVaults.pbkdf2;
const loginId = fixture.sync.ciphers.find((c) => c.type === CipherType.Login)!.id;
const loginItem = fixture.expected.items.find((i) => i.type === 1)!;
const LOGIN = {
  serverUrl: 'https://vault.example.com',
  email: fixture.email,
  masterPassword: fixture.password,
};

async function setup(pageUrl: string, fields = { username: true, password: true, totp: false }) {
  const vault = new VaultState();
  const search = createSearchIndex();
  const { service } = createTestService(vault, search, fakeServer(fixture));
  await service.login(LOGIN);
  const sent: ContentRequest[] = [];
  const copy = vi.fn(() => Promise.resolve());
  const tabs = {
    send: vi.fn((_tabId: number, message: ContentRequest) => {
      sent.push(message);
      if (message.type === 'content:inspect') return Promise.resolve({ url: pageUrl, fields });
      return Promise.resolve({ filled: ['username', 'password'] });
    }),
    inject: vi.fn(() => Promise.resolve()),
  };
  const autofill = createAutofill({
    vault,
    search,
    service,
    tabs,
    copy,
    settings: () => Promise.resolve(DEFAULT_SETTINGS),
  });
  return { autofill, sent, copy, tabs, service };
}

describe('autofill', () => {
  it('fills a matching login into the page origin, and copies the TOTP', async () => {
    const { autofill, sent, copy } = await setup('https://login.example.com/signin?x=1');
    const result = await autofill.fill({ tabId: 7, id: loginId });
    expect(result).toEqual({ filled: ['username', 'password'], copiedTotp: true });
    const fill = sent.find((m) => m.type === 'content:fill');
    expect(fill).toMatchObject({
      origin: 'https://login.example.com',
      username: loginItem.username,
      password: loginItem.password,
    });
    expect(copy).toHaveBeenCalledWith(expect.stringMatching(/^\d{6}$/));
  });

  it('refuses a page the item is not saved for, unless the user confirms', async () => {
    const { autofill, sent } = await setup('https://evil.test/login');
    await expect(autofill.fill({ tabId: 7, id: loginId })).rejects.toMatchObject({
      code: 'fill-mismatch',
    });
    expect(sent.some((m) => m.type === 'content:fill')).toBe(false);
    await autofill.fill({ tabId: 7, id: loginId, force: true });
    expect(sent.some((m) => m.type === 'content:fill')).toBe(true);
  });

  it('refuses to send an https login to an http page', async () => {
    const { autofill } = await setup('http://login.example.com/signin');
    await expect(autofill.fill({ tabId: 7, id: loginId })).rejects.toMatchObject({
      code: 'fill-mismatch',
    });
  });

  it('injects the content script when the tab has none', async () => {
    const { autofill, tabs } = await setup('https://login.example.com/');
    tabs.send.mockRejectedValueOnce(new Error('Could not establish connection'));
    await autofill.fill({ tabId: 7, id: loginId });
    expect(tabs.inject).toHaveBeenCalledWith(7);
  });

  it('fills the best match from the shortcut, and defers to the popup when locked', async () => {
    const { autofill, sent, service } = await setup('https://www.example.com/');
    expect(await autofill.fillBest(7)).toBe(true);
    expect(sent.filter((m) => m.type === 'content:fill')).toHaveLength(1);
    await service.lock();
    expect(await autofill.fillBest(7)).toBe(false);
  });

  it('defers to the popup when nothing matches', async () => {
    const { autofill } = await setup('https://other.test/');
    expect(await autofill.fillBest(7)).toBe(false);
  });
});

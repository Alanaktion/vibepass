import { describe, expect, it, vi } from 'vitest';
import { createAutofill, RECENT_FILL_MS } from '../src/background/autofill';
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

async function setup(
  pageUrl: string,
  fields = { username: true, password: true, totp: false },
  settings = DEFAULT_SETTINGS,
  now?: () => number,
) {
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
    settings: () => Promise.resolve(settings),
    ...(now ? { now } : {}),
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

  it('lists matching logins for the inline menu, without secrets', async () => {
    const { autofill } = await setup('https://www.example.com/');
    const state = await autofill.menu(7, 'https://www.example.com/login');
    expect(state).toEqual({
      state: 'unlocked',
      items: [
        {
          id: loginId,
          name: loginItem.name,
          username: loginItem.username,
          reprompt: false,
          recent: false,
        },
      ],
    });
    expect(JSON.stringify(state)).not.toContain(loginItem.password);
    expect(await autofill.menu(7, 'https://other.test/')).toEqual({ state: 'unlocked', items: [] });
    // https logins are never offered to an http page.
    expect(await autofill.menu(7, 'http://www.example.com/')).toEqual({
      state: 'unlocked',
      items: [],
    });
  });

  it('says locked or off instead of listing', async () => {
    const off = await setup('https://www.example.com/', undefined, {
      ...DEFAULT_SETTINGS,
      inlineMenu: false,
    });
    expect(await off.autofill.menu(7, 'https://www.example.com/')).toEqual({ state: 'off' });
    await expect(off.autofill.fillFromMenu(7, loginId)).rejects.toThrow(/turned off/);
    const { autofill, service } = await setup('https://www.example.com/');
    await service.lock();
    expect(await autofill.menu(7, 'https://www.example.com/')).toEqual({ state: 'locked' });
  });

  it('fills from the menu with the usual checks, and marks it for the next step', async () => {
    const { autofill, sent } = await setup('https://www.example.com/');
    await autofill.fillFromMenu(7, loginId);
    expect(sent.some((m) => m.type === 'content:fill')).toBe(true);
    // The password step of a multi-step login offers the same item first, in that tab only.
    const next = await autofill.menu(7, 'https://www.example.com/password');
    expect(next.state === 'unlocked' && next.items[0]?.recent).toBe(true);
    const other = await autofill.menu(8, 'https://www.example.com/password');
    expect(other.state === 'unlocked' && other.items[0]?.recent).toBe(false);
  });

  it('never forces a menu fill onto a page the item is not saved for', async () => {
    const { autofill, sent } = await setup('https://evil.test/');
    await expect(autofill.fillFromMenu(7, loginId)).rejects.toMatchObject({
      code: 'fill-mismatch',
    });
    expect(sent.some((m) => m.type === 'content:fill')).toBe(false);
  });

  it('forgets the multi-step item after a few minutes', async () => {
    const clock = { time: 1_000 };
    const { autofill } = await setup(
      'https://www.example.com/',
      undefined,
      DEFAULT_SETTINGS,
      () => clock.time,
    );
    await autofill.fillFromMenu(7, loginId);
    clock.time += RECENT_FILL_MS + 1;
    const later = await autofill.menu(7, 'https://www.example.com/');
    expect(later.state === 'unlocked' && later.items[0]?.recent).toBe(false);
  });
});

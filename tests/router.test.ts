import { describe, expect, it } from 'vitest';
import { createHandlers } from '../src/background/handlers';
import { createRouter } from '../src/background/router';
import { KdfType } from '../src/crypto';
import { createSearchIndex } from '../src/search';
import { createMessage } from '../src/shared/messages';
import { emptyVault } from '../src/vault/decrypt';
import { VaultState } from '../src/vault/state';
import { CipherType } from '../src/vault/types';
import { createTestService } from './helpers';

const EXT_ID = 'test-extension-id';
const sender = { id: EXT_ID };

function setup() {
  const vault = new VaultState();
  const search = createSearchIndex();
  const { service, deps } = createTestService(vault, search);
  const route = createRouter(
    createHandlers({ vault, search, service }),
    EXT_ID,
    'chrome-extension://test-extension-id/',
  );
  return { vault, search, route, deps };
}

describe('background router', () => {
  it('ignores messages that are not ours', () => {
    const { route } = setup();
    expect(route({ type: 'vault:status' }, sender)).toBeUndefined();
    expect(route('hello', sender)).toBeUndefined();
  });

  it('rejects messages from other extensions', async () => {
    const { route } = setup();
    await expect(route(createMessage('vault:status', undefined), { id: 'evil' })).resolves.toEqual({
      ok: false,
      error: 'Untrusted sender',
    });
  });

  it('refuses vault messages from content scripts', async () => {
    const { route } = setup();
    const contentScript = {
      id: EXT_ID,
      url: 'https://evil.test/',
      tab: { id: 3, index: 0, highlighted: false, active: true, pinned: false, incognito: false },
    };
    await expect(
      route(createMessage('vault:search', { query: '' }), contentScript),
    ).resolves.toEqual({ ok: false, error: 'Untrusted sender' });
    await expect(
      route(
        createMessage('autofill:page-ready', { url: 'https://evil.test/', loginForms: 0 }),
        contentScript,
      ),
    ).resolves.toEqual({ ok: true, data: undefined });
  });

  it('answers the inline menu only for a tab’s top frame', async () => {
    const { route } = setup();
    const tab = {
      id: 3,
      index: 0,
      highlighted: false,
      active: true,
      pinned: false,
      incognito: false,
    };
    const top = { id: EXT_ID, url: 'https://example.com/', tab, frameId: 0 };
    const frame = { ...top, frameId: 5 };
    await expect(route(createMessage('autofill:menu', undefined), frame)).resolves.toMatchObject({
      ok: false,
      error: 'Untrusted sender',
    });
    await expect(
      route(createMessage('autofill:menu-fill', { id: 'x' }), frame),
    ).resolves.toMatchObject({ ok: false, error: 'Untrusted sender' });
    // Allowed from the top frame (this test context has no autofill wired up).
    await expect(route(createMessage('autofill:menu', undefined), top)).resolves.toMatchObject({
      ok: false,
      error: 'Autofill is not available',
    });
  });

  it('keeps error codes in the envelope', async () => {
    const { route } = setup();
    await expect(route(createMessage('vault:item', { id: 'x' }), sender)).resolves.toEqual({
      ok: false,
      error: 'Vibepass is locked',
      code: 'locked',
    });
  });

  it('answers vault:status', async () => {
    const { route } = setup();
    await expect(route(createMessage('vault:status', undefined), sender)).resolves.toEqual({
      ok: true,
      data: {
        state: 'logged-out',
        serverUrl: null,
        email: null,
        lastSync: null,
        itemCount: 0,
        syncError: null,
        version: 0,
      },
    });
  });

  it('wraps handler errors in an envelope', async () => {
    const { route } = setup();
    const result = await route(createMessage('vault:unlock', { masterPassword: 'x' }), sender);
    expect(result).toEqual({ ok: false, error: 'Log in first' });
  });

  it('returns no search results while locked, and clears data on lock', async () => {
    const { vault, search, route } = setup();
    const item = {
      id: '1',
      type: CipherType.Login,
      name: 'Example',
      subtitle: 'me@example.com',
      uris: [{ uri: 'https://example.com', match: null }],
      favorite: false,
      folderId: null,
      organizationId: null,
      collectionIds: [],
      hasTotp: false,
      reprompt: false,
    };
    search.replaceAll([item]);

    await expect(route(createMessage('vault:search', { query: 'ex' }), sender)).resolves.toEqual({
      ok: true,
      data: [],
    });

    vault.setAccount({
      serverUrl: 'https://vault.example.com',
      email: 'me@example.com',
      userId: 'u1',
      salt: 'me@example.com',
      kdf: { type: KdfType.PBKDF2_SHA256, iterations: 600_000 },
      protectedUserKey: '2.x|y|z',
      refreshToken: null,
    });
    vault.unlock(new Uint8Array(64), { ...emptyVault(), items: [item] });
    search.replaceAll([item]);
    await expect(route(createMessage('vault:search', { query: 'ex' }), sender)).resolves.toEqual({
      ok: true,
      data: [{ ...item, siteMatch: false }],
    });

    const locked = await route(createMessage('vault:lock', undefined), sender);
    expect(locked).toMatchObject({ ok: true, data: { state: 'locked' } });
    expect(vault.items).toEqual([]);
    expect(search.search('')).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { createHandlers } from '../src/background/handlers';
import { createRouter } from '../src/background/router';
import { createSearchIndex } from '../src/search';
import { createMessage } from '../src/shared/messages';
import { VaultState } from '../src/vault/state';
import { CipherType } from '../src/vault/types';

const EXT_ID = 'test-extension-id';
const sender = { id: EXT_ID };

function setup() {
  const vault = new VaultState();
  const search = createSearchIndex();
  const route = createRouter(createHandlers({ vault, search }), EXT_ID);
  return { vault, search, route };
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

  it('answers vault:status', async () => {
    const { route } = setup();
    await expect(route(createMessage('vault:status', undefined), sender)).resolves.toEqual({
      ok: true,
      data: { state: 'logged-out', serverUrl: null, email: null, lastSync: null },
    });
  });

  it('wraps handler errors in an envelope', async () => {
    const { route } = setup();
    const result = await route(createMessage('vault:unlock', { masterPassword: 'x' }), sender);
    expect(result).toEqual({ ok: false, error: 'Not implemented yet: vault:unlock' });
  });

  it('returns no search results while locked, and clears data on lock', async () => {
    const { vault, search, route } = setup();
    const item = {
      id: '1',
      type: CipherType.Login,
      name: 'Example',
      subtitle: 'me@example.com',
      uris: ['https://example.com'],
      favorite: false,
      folderId: null,
    };
    search.replaceAll([item]);

    await expect(route(createMessage('vault:search', { query: 'ex' }), sender)).resolves.toEqual({
      ok: true,
      data: [],
    });

    vault.setAccount('https://vault.example.com', 'me@example.com');
    vault.unlock({ encKey: new Uint8Array(32), macKey: new Uint8Array(32) }, [item]);
    await expect(route(createMessage('vault:search', { query: 'ex' }), sender)).resolves.toEqual({
      ok: true,
      data: [item],
    });

    const locked = await route(createMessage('vault:lock', undefined), sender);
    expect(locked).toMatchObject({ ok: true, data: { state: 'locked' } });
    expect(vault.items).toEqual([]);
    expect(search.search('')).toEqual([]);
  });
});

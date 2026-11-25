import { describe, expect, it } from 'vitest';
import { VaultService } from '../src/background/service';
import { createSearchIndex } from '../src/search';
import { VaultState } from '../src/vault/state';
import { officialVaults } from './fixtures';
import { createTestService, fakeServer } from './helpers';

const fixture = officialVaults.pbkdf2;
const SERVER = 'https://vault.example.com/';

function setup() {
  const server = fakeServer(fixture);
  const vault = new VaultState();
  const search = createSearchIndex();
  const { service, deps } = createTestService(vault, search, server);
  return { server, vault, search, service, deps };
}

describe('VaultService', () => {
  it('logs in, syncs, and shows decrypted items', async () => {
    const { service, search, deps } = setup();
    const status = await service.login(SERVER, fixture.email, fixture.password);
    expect(status).toMatchObject({
      state: 'unlocked',
      serverUrl: 'https://vault.example.com',
      email: fixture.email,
      itemCount: 2,
    });
    expect(status.lastSync).not.toBeNull();
    expect(search.search('example').map((i) => i.name)).toEqual(['Example Login']);

    // Only encrypted or public data is persisted.
    const account = deps.stored.account!;
    expect(account.refreshToken).toMatch(/^2\./);
    expect(JSON.stringify(account)).not.toContain('refresh-1');
    expect(JSON.stringify(account)).not.toContain(fixture.password);
    expect(deps.stored.cache.get(account.userId)).toEqual(fixture.sync);
  });

  it('reports a wrong password from the server', async () => {
    const { service } = setup();
    await expect(service.login(SERVER, fixture.email, 'nope')).rejects.toThrow(
      'Email or master password is incorrect',
    );
  });

  it('locks, then unlocks offline from the cache', async () => {
    const { service, server, deps } = setup();
    await service.login(SERVER, fixture.email, fixture.password);
    expect((await service.lock()).state).toBe('locked');
    expect(deps.stored.session).toBeNull();

    server.offline = true;
    const status = await service.unlock(fixture.password);
    expect(status).toMatchObject({ state: 'unlocked', itemCount: 2 });
    await expect(service.unlock('wrong')).rejects.toThrow('Incorrect master password');
  });

  it('refreshes the access token with the stored refresh token on sync after unlock', async () => {
    const { service, server, deps } = setup();
    await service.login(SERVER, fixture.email, fixture.password);
    await service.lock();
    await service.unlock(fixture.password);
    await service.sync();
    expect(server.refreshCount).toBe(1);
    // The rotated refresh token is stored, still encrypted.
    expect(JSON.stringify(deps.stored.account)).not.toContain('refresh-2');
  });

  it('restores the unlocked vault after a worker restart', async () => {
    const { service, deps, server } = setup();
    await service.login(SERVER, fixture.email, fixture.password);

    // A new worker: fresh memory, same storage.
    const vault = new VaultState();
    const search = createSearchIndex();
    server.offline = true;
    const restarted = new VaultService(vault, search, deps);
    expect(await restarted.status()).toMatchObject({ state: 'unlocked', itemCount: 2 });
    expect(search.search('server').map((i) => i.name)).toEqual(['Server notes']);
  });

  it('logs out and forgets everything', async () => {
    const { service, deps } = setup();
    await service.login(SERVER, fixture.email, fixture.password);
    const status = await service.logout();
    expect(status.state).toBe('logged-out');
    expect(deps.stored.account).toBeNull();
    expect(deps.stored.session).toBeNull();
    expect(deps.stored.cache.size).toBe(0);
  });
});

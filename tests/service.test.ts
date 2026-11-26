import { describe, expect, it } from 'vitest';
import { VaultService } from '../src/background/service';
import { createSearchIndex } from '../src/search';
import { CodedError } from '../src/shared/errors';
import { TwoFactorProvider } from '../src/api/types';
import { VaultState } from '../src/vault/state';
import { CipherType } from '../src/vault/types';
import { officialVaults } from './fixtures';
import { ORG_CIPHER_ID, orgVault } from './fixtures/org';
import { createTestService, fakeServer } from './helpers';

const fixture = officialVaults.pbkdf2;
const SERVER = 'https://vault.example.com/';
const LOGIN = { serverUrl: SERVER, email: fixture.email, masterPassword: fixture.password };
const loginItem = fixture.expected.items.find((i) => i.type === 1)!;
const loginId = fixture.sync.ciphers.find((c) => c.type === CipherType.Login)!.id;

function setup() {
  const server = fakeServer(fixture);
  const vault = new VaultState();
  const search = createSearchIndex();
  const { service, deps } = createTestService(vault, search, server);
  return { server, vault, search, service, deps };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as Partial<CodedError>).code ?? (error as Error).message;
  }
  return undefined;
}

describe('VaultService', () => {
  it('logs in, syncs, and shows decrypted items', async () => {
    const { service, search, deps } = setup();
    const status = await service.login(LOGIN);
    expect(status).toMatchObject({
      state: 'unlocked',
      serverUrl: 'https://vault.example.com',
      email: fixture.email,
      itemCount: 2,
      syncError: null,
    });
    expect(status.lastSync).not.toBeNull();
    expect(search.search('example').map((i) => i.name)).toEqual(['Example Login']);

    // Only encrypted or public data is persisted.
    const account = deps.stored.account!;
    expect(account.refreshToken).toMatch(/^2\./);
    expect(JSON.stringify(account)).not.toContain('refresh-1');
    expect(JSON.stringify(account)).not.toContain(fixture.password);
    expect(deps.stored.cache.get(account.userId)).toEqual({ ...fixture.sync, domains: undefined });
  });

  it('uses enabled domain groups offline and keeps them encrypted at rest', async () => {
    const { service, server, search, deps } = setup();
    server.sync = {
      ...server.sync,
      domains: {
        equivalentDomains: [
          ['example.com', 'other.test'],
          ['other.test', 'indirect.test'],
        ],
        globalEquivalentDomains: [
          { domains: ['example.com', 'enabled.test'], excluded: false },
          { domains: ['example.com', 'excluded.test'], excluded: true },
        ],
      },
    };
    await service.login(LOGIN);
    expect(JSON.stringify([...deps.stored.cache.values()])).not.toContain('other.test');
    await service.lock();
    expect(search.pageFor('https://example.com')?.equivalents).toBeUndefined();
    server.offline = true;
    await service.unlock(fixture.password);
    for (const domain of ['enabled.test', 'other.test']) {
      const url = 'https://' + domain;
      expect(search.search('', { url })[0]?.siteMatch).toBe(true);
      expect(search.matchesFor(url, true)[0]?.id).toBe(loginId);
      expect(search.matchesFor(url)).toEqual([]);
    }
    for (const host of ['excluded.test', 'indirect.test', 'other.test.example.org']) {
      expect(search.matchesFor('https://' + host, true)).toEqual([]);
    }
  });

  it('reports a wrong password from the server', async () => {
    const { service } = setup();
    await expect(service.login({ ...LOGIN, masterPassword: 'nope' })).rejects.toThrow(
      'Email or master password is incorrect',
    );
  });

  it('locks, then unlocks offline from the cache', async () => {
    const { service, server, deps } = setup();
    await service.login(LOGIN);
    expect((await service.lock()).state).toBe('locked');
    expect(deps.stored.session).toBeNull();

    server.offline = true;
    const status = await service.unlock(fixture.password);
    expect(status).toMatchObject({ state: 'unlocked', itemCount: 2 });
    await expect(service.unlock('wrong')).rejects.toThrow('Incorrect master password');
  });

  it('refreshes the access token with the stored refresh token on sync after unlock', async () => {
    const { service, server, deps } = setup();
    await service.login(LOGIN);
    await service.lock();
    await service.unlock(fixture.password);
    await service.sync();
    expect(server.refreshCount).toBe(1);
    // The rotated refresh token is stored, still encrypted.
    expect(JSON.stringify(deps.stored.account)).not.toContain('refresh-2');
  });

  it('restores the unlocked vault after a worker restart', async () => {
    const { service, deps, server } = setup();
    await service.login(LOGIN);

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
    await service.login(LOGIN);
    const status = await service.logout();
    expect(status.state).toBe('logged-out');
    expect(deps.stored.account).toBeNull();
    expect(deps.stored.session).toBeNull();
    expect(deps.stored.cache.size).toBe(0);
  });

  it('broadcasts status changes', async () => {
    const { service, deps } = setup();
    const seen: string[] = [];
    deps.onStatus = (status) => seen.push(status.state);
    await service.login(LOGIN);
    await service.lock();
    expect(seen).toEqual(['unlocked', 'locked']);
  });
});

describe('two-step login', () => {
  it('asks for a code, then logs in with it and remembers this browser', async () => {
    const { service, server, deps } = setup();
    server.twoFactor = true;
    let error: unknown;
    try {
      await service.login(LOGIN);
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({
      code: 'two-factor-required',
      details: { providers: [0, 1], emailHint: 'a***@example.com' },
    });

    const status = await service.login({
      ...LOGIN,
      challenge: {
        twoFactor: { provider: TwoFactorProvider.Authenticator, token: '123 456', remember: true },
      },
    });
    expect(status.state).toBe('unlocked');
    expect(server.forms.at(-1)?.get('twoFactorToken')).toBe('123456');
    expect([...deps.stored.remembered.values()]).toEqual([expect.stringMatching(/^2\./)]);

    // The encrypted token works until explicit logout.
    await service.lock();
    await service.login(LOGIN);
    expect(server.forms.at(-1)?.get('twoFactorProvider')).toBe('5');
    await service.logout();
    expect(await codeOf(service.login(LOGIN))).toBe('two-factor-required');
  });

  it('forgets a remember token the server no longer accepts', async () => {
    const { service, server, deps } = setup();
    server.twoFactor = true;
    deps.stored.remembered.set(`https://vault.example.com|${fixture.email}`, 'stale');
    expect(await codeOf(service.login(LOGIN))).toBe('two-factor-required');
    expect(deps.stored.remembered.size).toBe(0);
  });

  it('rejects a wrong code', async () => {
    const { service, server } = setup();
    server.twoFactor = true;
    const challenge = {
      twoFactor: { provider: TwoFactorProvider.Authenticator, token: '000000', remember: false },
    };
    expect(await codeOf(service.login({ ...LOGIN, challenge }))).toBe('two-factor-required');
  });

  it('handles Bitwarden new-device verification', async () => {
    const { service, server } = setup();
    server.newDevice = true;
    expect(await codeOf(service.login(LOGIN))).toBe('new-device-verification');
    const status = await service.login({ ...LOGIN, challenge: { newDeviceOtp: '654321' } });
    expect(status.state).toBe('unlocked');
  });

  it('asks the server to email a code', async () => {
    const { service, server } = setup();
    let body: unknown;
    server.routes.set(
      '/api/two-factor/send-email-login',
      () => new Response(null, { status: 200 }),
    );
    const original = server.fetch;
    server.fetch = (url, init) => {
      if (url.endsWith('/send-email-login')) body = JSON.parse(init!.body as string);
      return original(url, init);
    };
    await service.sendLoginEmail(LOGIN);
    expect(body).toEqual({
      email: fixture.email,
      masterPasswordHash: fixture.masterPasswordHash,
      deviceIdentifier: '00000000-0000-4000-8000-000000000000',
    });
  });
});

describe('background sync', () => {
  it('skips the full sync when the revision has not changed', async () => {
    const { service, server } = setup();
    await service.login(LOGIN);
    const syncs = () => server.calls.filter((c) => c === '/api/sync').length;
    expect(syncs()).toBe(1);

    await service.backgroundSync();
    expect(syncs()).toBe(1);

    server.revision += 1;
    await service.backgroundSync();
    expect(syncs()).toBe(2);
  });

  it('shows an error in the status instead of throwing', async () => {
    const { service, server } = setup();
    await service.login(LOGIN);
    server.offline = true;
    await service.backgroundSync(true);
    expect((await service.status()).syncError).toMatch(/Could not reach/);
    server.offline = false;
    await service.backgroundSync(true);
    expect((await service.status()).syncError).toBeNull();
  });

  it('does nothing while locked', async () => {
    const { service, server } = setup();
    await service.login(LOGIN);
    await service.lock();
    const before = server.calls.length;
    await service.backgroundSync(true);
    expect(server.calls.length).toBe(before);
  });
});

describe('item access', () => {
  it('shows an item with secrets concealed, and reveals them on request', async () => {
    const { service } = setup();
    await service.login(LOGIN);
    const detail = await service.item(loginId);
    expect(detail.name).toBe(loginItem.name);
    expect(detail.notes).toBe(loginItem.notes);
    expect(detail.uris.map((u) => u.uri)).toEqual(loginItem.uris);
    const fields = detail.sections.flatMap((s) => s.fields);
    expect(fields.find((f) => f.id === 'login.username')?.value).toBe(loginItem.username);
    expect(fields.find((f) => f.id === 'login.password')).toMatchObject({
      kind: 'concealed',
      value: null,
    });
    expect(JSON.stringify(detail)).not.toContain(loginItem.password);
    expect(JSON.stringify(detail)).not.toContain(loginItem.totp);

    expect(await service.reveal(loginId, 'login.password')).toBe(loginItem.password);
    const totp = await service.totp(loginId);
    expect(totp.code).toMatch(/^\d{6}$/);
    await expect(service.reveal(loginId, 'login.username')).rejects.toThrow();
  });

  it('asks for the master password on re-prompt items', async () => {
    const { service, server } = setup();
    server.sync = structuredClone(fixture.sync);
    server.sync.ciphers.find((c) => c.id === loginId)!.reprompt = 1;
    await service.login(LOGIN);
    expect(await codeOf(service.item(loginId))).toBe('reprompt-required');
    expect((await service.item(loginId, LOGIN.masterPassword)).reprompt).toBe(true);
    expect(await codeOf(service.reveal(loginId, 'login.password'))).toBe('reprompt-required');
    await expect(service.reveal(loginId, 'login.password', 'wrong')).rejects.toThrow(
      'Incorrect master password',
    );
    expect(await service.reveal(loginId, 'login.password', fixture.password)).toBe(
      loginItem.password,
    );
  });

  it('refuses item access while locked', async () => {
    const { service } = setup();
    await service.login(LOGIN);
    await service.lock();
    expect(await codeOf(service.item(loginId))).toBe('locked');
  });
});

describe('organizations (read-only)', () => {
  it('decrypts organization items and collections', async () => {
    const { service, server, search, vault } = setup();
    server.sync = (await orgVault()).sync;
    const status = await service.login(LOGIN);
    expect(status.itemCount).toBe(3);
    expect(search.search('wiki').map((i) => i.id)).toEqual([ORG_CIPHER_ID]);
    expect(search.search('runbook').map((i) => i.id)).toEqual([ORG_CIPHER_ID]);

    const detail = await service.item(ORG_CIPHER_ID);
    expect(detail).toMatchObject({ organization: 'Acme', collections: ['Engineering'] });
    expect(await service.reveal(ORG_CIPHER_ID, 'login.password')).toBe('team-secret');
    expect(await service.reveal(ORG_CIPHER_ID, 'field.0')).toBe('4321');

    await service.lock();
    expect(vault.orgKeys.size).toBe(0);
  });

  it('respects "hide passwords" from the organization', async () => {
    const { service, server } = setup();
    server.sync = (await orgVault({ viewPassword: false })).sync;
    await service.login(LOGIN);
    const fields = (await service.item(ORG_CIPHER_ID)).sections.flatMap((s) => s.fields);
    expect(fields.find((f) => f.id === 'login.password')?.canReveal).toBe(false);
    await expect(service.reveal(ORG_CIPHER_ID, 'login.password')).rejects.toThrow(
      'Your organization hides this value',
    );
    // Autofill still gets it, as in the official clients.
    expect((await service.fillData(ORG_CIPHER_ID)).item.login?.password).toBe('team-secret');
  });
});

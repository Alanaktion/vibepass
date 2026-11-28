import { describe, expect, it, vi } from 'vitest';
import { MAX_PIN_ATTEMPTS, VaultService } from '../src/background/service';
import { deriveLoginKeys, unwrapUserKey } from '../src/crypto';
import { createSearchIndex } from '../src/search';
import type { CodedError } from '../src/shared/errors';
import { VaultState } from '../src/vault/state';
import { CipherType } from '../src/vault/types';
import { officialVaults } from './fixtures';
import { createTestService, fakeServer } from './helpers';

const fixture = officialVaults.pbkdf2;
const LOGIN = {
  serverUrl: 'https://vault.example.com/',
  email: fixture.email,
  masterPassword: fixture.password,
};
const loginId = fixture.sync.ciphers.find((c) => c.type === CipherType.Login)!.id;
const PIN = '2468';
const SESSION = 'c'.repeat(32);

function setup() {
  const server = fakeServer(fixture);
  server.sync = structuredClone(fixture.sync);
  server.sync.ciphers.find((c) => c.id === loginId)!.reprompt = 1;
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

describe('PIN unlock', { timeout: 60_000 }, () => {
  it('unlocks with the PIN, keeping the key in memory only by default', async () => {
    const { service, deps } = setup();
    await service.login(LOGIN);
    const status = await service.setPin(PIN, { afterRestart: false, reprompt: false });
    expect(status.pin).toMatchObject({ set: true, unlock: true, afterRestart: false });

    // Nothing on disk opens the vault with the PIN, and the PIN is never stored in the clear.
    expect(deps.stored.pin?.envelope).toBeUndefined();
    expect(deps.stored.pin?.encryptedPin).toMatch(/^2\./);
    expect(JSON.stringify(deps.stored.pin)).not.toContain(PIN);
    expect(deps.stored.pinSession?.protectedUserKey).toMatch(/^2\./);

    await service.lock();
    expect((await service.status()).pin.unlock).toBe(true);
    const unlocked = await service.unlockWithPin(PIN);
    expect(unlocked).toMatchObject({ state: 'unlocked', itemCount: 2 });
  });

  it('uses the same construction as Bitwarden: the account KDF over the PIN wraps the user key', async () => {
    const { service, deps, vault } = setup();
    await service.login(LOGIN);
    await service.setPin(PIN, { afterRestart: true, reprompt: false });
    const envelope = deps.stored.pin!.envelope!;
    const account = deps.stored.account!;
    const { stretchedMasterKey } = await deriveLoginKeys(PIN, account.email, account.kdf);
    const key = await unwrapUserKey(envelope.protectedUserKey, stretchedMasterKey);
    expect(key).toEqual(vault.key);
  });

  it('needs the master password after a browser restart unless asked otherwise', async () => {
    const { service, deps, vault, search } = setup();
    await service.login(LOGIN);
    await service.setPin(PIN, { afterRestart: false, reprompt: false });
    await service.lock();
    // A browser restart clears storage.session.
    deps.stored.pinSession = null;
    const restarted = new VaultService(vault, search, deps);
    expect((await restarted.status()).pin).toMatchObject({ set: true, unlock: false });
    await expect(restarted.unlockWithPin(PIN)).rejects.toThrow(/master password/);

    // The master password puts the PIN back without asking for it again.
    await restarted.unlock(fixture.password);
    await vi.waitFor(() => {
      expect(deps.stored.pinSession).not.toBeNull();
    });
    await restarted.lock();
    expect((await restarted.unlockWithPin(PIN)).state).toBe('unlocked');

    // With "after restart" on, the PIN works straight away.
    await restarted.setPinOptions({ afterRestart: true });
    expect(deps.stored.pin?.envelope).toBeDefined();
    expect(deps.stored.pinSession).toBeNull();
    await restarted.lock();
    deps.stored.pinSession = null;
    const again = new VaultService(vault, search, deps);
    expect((await again.unlockWithPin(PIN)).state).toBe('unlocked');
  });

  it('stops accepting the PIN after too many wrong tries, until the master password', async () => {
    const { service, deps, vault, search } = setup();
    await service.login(LOGIN);
    await service.setPin(PIN, { afterRestart: true, reprompt: false });
    await service.lock();
    await expect(service.unlockWithPin('0000')).rejects.toThrow('Incorrect PIN. 4 tries left.');
    // A restart doesn't reset the count.
    const restarted = new VaultService(vault, search, deps);
    for (let i = 2; i < MAX_PIN_ATTEMPTS; i++) {
      await expect(restarted.unlockWithPin('0000')).rejects.toThrow('Incorrect PIN.');
    }
    await expect(restarted.unlockWithPin('0000')).rejects.toThrow('Too many incorrect PINs');
    expect(deps.stored.pin?.envelope).toBeUndefined();
    expect((await restarted.status()).pin).toMatchObject({ set: true, unlock: false });
    // Even the right PIN is refused now.
    await expect(restarted.unlockWithPin(PIN)).rejects.toThrow(/master password/);

    await restarted.unlock(fixture.password);
    await vi.waitFor(() => {
      expect(deps.stored.pin?.envelope).toBeDefined();
    });
    expect(deps.stored.pin?.failedAttempts).toBe(0);
    await restarted.lock();
    expect((await restarted.unlockWithPin(PIN)).state).toBe('unlocked');
  });

  it('accepts the PIN for re-prompt items only when turned on', async () => {
    const { service } = setup();
    await service.login(LOGIN);
    service.grants.connect(SESSION);
    await service.setPin(PIN, { afterRestart: false, reprompt: false });
    expect(await codeOf(service.item(loginId, { session: SESSION, pin: PIN }))).toBe(
      'reprompt-required',
    );

    const status = await service.setPinOptions({ reprompt: true });
    expect(status.pin.reprompt).toBe(true);
    await expect(service.item(loginId, { session: SESSION, pin: '9999' })).rejects.toThrow(
      'Incorrect PIN. 4 tries left.',
    );
    expect((await service.item(loginId, { session: SESSION, pin: PIN })).reprompt).toBe(true);
    // The grant then covers the popup as before.
    expect(await service.reveal(loginId, 'login.password', { session: SESSION })).toBeTruthy();
  });

  it('falls back to the master password after too many wrong PINs on re-prompt', async () => {
    const { service, deps } = setup();
    await service.login(LOGIN);
    service.grants.connect(SESSION);
    await service.setPin(PIN, { afterRestart: false, reprompt: true });
    for (let i = 1; i < MAX_PIN_ATTEMPTS; i++) {
      await expect(service.item(loginId, { session: SESSION, pin: '9999' })).rejects.toThrow(
        'Incorrect PIN.',
      );
    }
    expect(await codeOf(service.item(loginId, { session: SESSION, pin: '9999' }))).toBe(
      'reprompt-required',
    );
    expect((await service.status()).pin).toMatchObject({ reprompt: false, unlock: false });
    expect(await codeOf(service.item(loginId, { session: SESSION, pin: PIN }))).toBe(
      'reprompt-required',
    );
    await service.item(loginId, { session: SESSION, masterPassword: fixture.password });
    await vi.waitFor(() => {
      expect(deps.stored.pin?.failedAttempts).toBe(0);
    });
    expect((await service.status()).pin).toMatchObject({ reprompt: true, unlock: true });
  });

  it('rejects short PINs, and logging out removes the PIN', async () => {
    const { service, deps } = setup();
    await service.login(LOGIN);
    await expect(service.setPin('12', { afterRestart: false, reprompt: false })).rejects.toThrow(
      'at least 4',
    );
    await service.setPin(PIN, { afterRestart: true, reprompt: true });
    await service.logout();
    expect(deps.stored.pin).toBeNull();
    expect(deps.stored.pinSession).toBeNull();
  });

  it('turns the PIN off', async () => {
    const { service, deps } = setup();
    await service.login(LOGIN);
    await service.setPin(PIN, { afterRestart: false, reprompt: true });
    const status = await service.removePin();
    expect(status.pin.set).toBe(false);
    expect(deps.stored.pin).toBeNull();
    await service.lock();
    await expect(service.unlockWithPin(PIN)).rejects.toThrow(/master password/);
  });
});

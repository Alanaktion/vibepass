import { describe, expect, it } from 'vitest';
import { createHandlers } from '../src/background/handlers';
import type { BiometricRequest, BiometricResult } from '../src/background/biometric';
import { VaultService } from '../src/background/service';
import { toBase64 } from '../src/crypto';
import { createSearchIndex } from '../src/search';
import { VaultState } from '../src/vault/state';
import { officialVaults } from './fixtures';
import { createTestService, fakeServer } from './helpers';

const fixture = officialVaults.pbkdf2;
const LOGIN = {
  serverUrl: 'https://vault.example.com/',
  email: fixture.email,
  masterPassword: fixture.password,
};
const PRF = toBase64(new Uint8Array(32).fill(7));
const CREDENTIAL = toBase64(new Uint8Array(16).fill(1));

function setup() {
  const vault = new VaultState();
  const search = createSearchIndex();
  const { service, deps } = createTestService(vault, search, fakeServer(fixture));
  return { vault, search, service, deps };
}

describe('biometric unlock', { timeout: 30_000 }, () => {
  it('wraps the user key with the PRF output, and unlocks with it after a restart', async () => {
    const { service, deps, vault, search } = setup();
    await service.login(LOGIN);
    const status = await service.enrollBiometric(CREDENTIAL, 'c2FsdA==', PRF);
    expect(status.biometric).toBe(true);
    expect(deps.stored.biometric?.protectedUserKey).toMatch(/^2\./);
    expect(JSON.stringify(deps.stored.biometric)).not.toContain(PRF);
    await service.lock();

    const restarted = new VaultService(vault, search, deps);
    expect((await restarted.status()).biometric).toBe(true);
    expect(await restarted.biometricRequest()).toEqual({
      credentialId: CREDENTIAL,
      salt: 'c2FsdA==',
    });
    const unlocked = await restarted.unlockWithBiometric(CREDENTIAL, PRF);
    expect(unlocked).toMatchObject({ state: 'unlocked', itemCount: 2 });
  });

  it('refuses another passkey or a wrong PRF output', async () => {
    const { service } = setup();
    await service.login(LOGIN);
    await service.enrollBiometric(CREDENTIAL, 'c2FsdA==', PRF);
    await service.lock();
    await expect(service.unlockWithBiometric(toBase64(new Uint8Array(16)), PRF)).rejects.toThrow(
      'isn’t the one',
    );
    await expect(
      service.unlockWithBiometric(CREDENTIAL, toBase64(new Uint8Array(32).fill(8))),
    ).rejects.toThrow('didn’t unlock');
    expect((await service.status()).state).toBe('locked');
  });

  it('is removed on request and on logout', async () => {
    const { service, deps } = setup();
    await service.login(LOGIN);
    await service.enrollBiometric(CREDENTIAL, 'c2FsdA==', PRF);
    expect((await service.removeBiometric()).biometric).toBe(false);
    await service.enrollBiometric(CREDENTIAL, 'c2FsdA==', PRF);
    await service.logout();
    expect(deps.stored.biometric).toBeNull();
  });

  it('runs setup and unlock through the biometric window', async () => {
    const { service, vault, search } = setup();
    await service.login(LOGIN);
    const requests: BiometricRequest[] = [];
    const handlers = createHandlers({
      vault,
      search,
      service,
      biometric: async (request, finish) => {
        requests.push(request);
        const result: BiometricResult = { credentialId: CREDENTIAL, prf: PRF };
        await finish(result);
      },
    });
    const sender = {};
    const enrolled = await handlers['biometric:enroll'](undefined, sender);
    expect(enrolled.biometric).toBe(true);
    expect(requests[0]).toMatchObject({ mode: 'enroll' });
    await service.lock();
    const unlocked = await handlers['biometric:unlock'](undefined, sender);
    expect(unlocked.state).toBe('unlocked');
    expect(requests[1]).toEqual({
      mode: 'unlock',
      credentialId: CREDENTIAL,
      salt: (requests[0] as { salt: string }).salt,
    });
  });
});

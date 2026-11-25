import { describe, expect, it } from 'vitest';
import {
  KdfType,
  WrongPasswordError,
  decryptString,
  decryptUserKeyWithPassword,
  deriveLoginKeys,
  emailSalt,
  encryptString,
  unwrapUserKey,
  type KdfConfig,
} from '../src/crypto';
import { cipherKey, decryptVault } from '../src/vault/decrypt';
import { CipherType } from '../src/vault/types';
import { officialVaults } from './fixtures';

function kdfOf(fixture: (typeof officialVaults)['pbkdf2']): {
  kdf: KdfConfig;
  salt: string;
  protectedKey: string;
} {
  const unlock = fixture.sync.userDecryption!.masterPasswordUnlock!;
  const kdf: KdfConfig =
    unlock.kdf.kdfType === KdfType.Argon2id
      ? {
          type: KdfType.Argon2id,
          iterations: unlock.kdf.iterations,
          memoryMiB: unlock.kdf.memory!,
          parallelism: unlock.kdf.parallelism!,
        }
      : { type: KdfType.PBKDF2_SHA256, iterations: unlock.kdf.iterations };
  return { kdf, salt: unlock.salt, protectedKey: unlock.masterKeyEncryptedUserKey };
}

describe('emailSalt', () => {
  it('trims and lower-cases', () => {
    expect(emailSalt('  Me@Example.COM ')).toBe('me@example.com');
  });
});

describe.each(Object.entries(officialVaults))('official web vault (%s)', (_name, fixture) => {
  const { kdf, salt, protectedKey } = kdfOf(fixture);

  it('derives the same login hash the official client sent', async () => {
    const keys = await deriveLoginKeys(fixture.password, fixture.email, kdf, salt);
    expect(keys.masterPasswordHash).toBe(fixture.masterPasswordHash);
  });

  it('unlocks the user key on both paths, with the same result', async () => {
    const offline = await decryptUserKeyWithPassword(protectedKey, fixture.password, salt, kdf);
    const keys = await deriveLoginKeys(fixture.password, fixture.email, kdf, salt);
    const online = await unwrapUserKey(fixture.sync.profile.key, keys.stretchedMasterKey);
    expect(Array.from(online)).toEqual(Array.from(offline));
  });

  it('rejects a wrong master password', async () => {
    await expect(
      decryptUserKeyWithPassword(protectedKey, 'wrong password', salt, kdf),
    ).rejects.toThrow(WrongPasswordError);
  });

  it('decrypts item summaries and folders written by the official client', async () => {
    const userKey = await decryptUserKeyWithPassword(protectedKey, fixture.password, salt, kdf);
    const vault = await decryptVault(fixture.sync, userKey);
    expect(vault.skipped).toBe(0);
    expect(vault.folders.map((f) => f.name)).toEqual(fixture.expected.folders);
    for (const expected of fixture.expected.items) {
      const item = vault.items.find((i) => i.name === expected.name);
      expect(item, expected.name).toBeDefined();
      expect(item!.type).toBe(expected.type);
      expect(item!.subtitle).toBe(expected.username ?? null);
      expect(item!.uris.map((u) => u.uri)).toEqual(expected.uris ?? []);
    }
  });

  it('decrypts secret fields on demand with the per-item key', async () => {
    const userKey = await decryptUserKeyWithPassword(protectedKey, fixture.password, salt, kdf);
    const login = fixture.sync.ciphers.find((c) => c.type === CipherType.Login)!;
    const expected = fixture.expected.items.find((i) => i.type === 1)!;
    expect(login.key).toBeTruthy();
    const key = await cipherKey(login, userKey);
    expect(await decryptString(login.login!.password!, key)).toBe(expected.password);
    expect(await decryptString(login.login!.totp!, key)).toBe(expected.totp);
    expect(await decryptString(login.notes!, key)).toBe(expected.notes);
  });

  it('round-trips strings it encrypts', async () => {
    const userKey = await decryptUserKeyWithPassword(protectedKey, fixture.password, salt, kdf);
    const enc = await encryptString('round trip ✓', userKey);
    expect(enc.startsWith('2.')).toBe(true);
    expect(await decryptString(enc, userKey)).toBe('round trip ✓');
  });
});

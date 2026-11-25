import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { vaultCache } from '../src/storage/vault-cache';
import { officialVaults } from './fixtures';

describe('vaultCache', () => {
  it('stores the encrypted sync response per user', async () => {
    const sync = officialVaults.pbkdf2.sync;
    expect(await vaultCache.read('u1')).toBeNull();
    await vaultCache.write('u1', sync);
    expect(await vaultCache.read('u1')).toEqual(sync);
    await vaultCache.clear('u1');
    expect(await vaultCache.read('u1')).toBeNull();
  });
});

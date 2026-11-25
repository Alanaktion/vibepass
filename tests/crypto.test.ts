import { describe, expect, it } from 'vitest';
import { KdfType, deriveMasterKey, parseEncString } from '../src/crypto';

// Placeholder. Real tests use vectors from the official clients and land with the implementation.
describe('crypto stubs', () => {
  it('are not implemented yet', async () => {
    await expect(
      deriveMasterKey('pw', 'a@b.c', { type: KdfType.PBKDF2_SHA256, iterations: 600_000 }),
    ).rejects.toThrow('Not implemented yet');
    expect(() => parseEncString('2.a|b|c')).toThrow('Not implemented yet');
  });
});

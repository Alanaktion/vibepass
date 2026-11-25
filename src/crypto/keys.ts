import { NotImplementedError } from '../shared/errors';
import type { EncString, SymmetricKey } from './types';

/** Stretch the 32-byte master key to a 64-byte enc+mac key with HKDF-Expand. */
export function stretchMasterKey(_masterKey: Uint8Array): Promise<SymmetricKey> {
  return Promise.reject(new NotImplementedError('stretchMasterKey'));
}

/** Decrypt the account's protected user key (from the token/sync response) with the stretched key. */
export function decryptUserKey(
  _protectedKey: EncString,
  _stretchedKey: SymmetricKey,
): Promise<SymmetricKey> {
  return Promise.reject(new NotImplementedError('decryptUserKey'));
}

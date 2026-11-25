import { NotImplementedError } from '../shared/errors';
import type { KdfConfig } from './types';

/**
 * Derive the 32-byte master key from the master password and email (salt).
 * PBKDF2 will use Web Crypto; Argon2id will use a bundled WASM build (needs 'wasm-unsafe-eval').
 */
export function deriveMasterKey(
  _password: string,
  _email: string,
  _kdf: KdfConfig,
): Promise<Uint8Array> {
  return Promise.reject(new NotImplementedError('deriveMasterKey'));
}

/** Server auth hash: PBKDF2-SHA256(masterKey, password, 1 iteration), base64. Sent at login. */
export function hashMasterKey(_masterKey: Uint8Array, _password: string): Promise<string> {
  return Promise.reject(new NotImplementedError('hashMasterKey'));
}

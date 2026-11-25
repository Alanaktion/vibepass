import { NotImplementedError } from '../shared/errors';
import type { EncString, SymmetricKey } from './types';

/** Parse a serialized EncString such as `"2.<iv>|<data>|<mac>"`. */
export function parseEncString(_value: string): EncString {
  throw new NotImplementedError('parseEncString');
}

export function serializeEncString(_value: EncString): string {
  throw new NotImplementedError('serializeEncString');
}

/** Verify the MAC (constant time) and decrypt with AES-256-CBC. Decrypt on demand only. */
export function decrypt(_value: EncString, _key: SymmetricKey): Promise<Uint8Array> {
  return Promise.reject(new NotImplementedError('decrypt'));
}

export function decryptToString(value: EncString, key: SymmetricKey): Promise<string> {
  return decrypt(value, key).then((bytes) => new TextDecoder().decode(bytes));
}

/** Encrypt with a fresh random IV and append an HMAC-SHA256 over iv || data. */
export function encrypt(_plaintext: Uint8Array, _key: SymmetricKey): Promise<EncString> {
  return Promise.reject(new NotImplementedError('encrypt'));
}

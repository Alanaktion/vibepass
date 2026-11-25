/**
 * Bitwarden-compatible crypto. Scaffold only: every function here is a typed stub.
 *
 * Before any real implementation lands, add test vectors from the official clients under
 * tests/crypto/ and keep the extension read-only until encrypt/decrypt round-trips match.
 */
export * from './types';
export * from './kdf';
export * from './keys';
export * from './encstring';

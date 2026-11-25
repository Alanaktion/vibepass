/** Key derivation functions supported by Bitwarden-compatible servers (prelogin `kdf`). */
export enum KdfType {
  PBKDF2_SHA256 = 0,
  Argon2id = 1,
}

export type KdfConfig =
  | { type: KdfType.PBKDF2_SHA256; iterations: number }
  | { type: KdfType.Argon2id; iterations: number; memoryMiB: number; parallelism: number };

/**
 * A symmetric key in the SDK's serialized form: 64 bytes for AES-256-CBC + HMAC-SHA256 keys,
 * or a COSE key for newer XChaCha20-Poly1305 user keys. Treat it as opaque and never persist it
 * outside `storage.session`.
 */
export type SymmetricKey = Uint8Array;

/** An RSA private key (PKCS#8 DER), used only to unwrap organization keys. */
export type PrivateKey = Uint8Array;

/** A serialized EncString such as `"2.<iv>|<data>|<mac>"`. Opaque to everything but the SDK. */
export type EncString = string;

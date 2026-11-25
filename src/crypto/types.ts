/** Key derivation functions supported by Bitwarden-compatible servers (prelogin `kdf`). */
export enum KdfType {
  PBKDF2_SHA256 = 0,
  Argon2id = 1,
}

export type KdfConfig =
  | { type: KdfType.PBKDF2_SHA256; iterations: number }
  | { type: KdfType.Argon2id; iterations: number; memoryMiB: number; parallelism: number };

/** EncString encryption types, as in the leading `<type>.` of a serialized EncString. */
export enum EncryptionType {
  AesCbc256_B64 = 0,
  AesCbc256_HmacSha256_B64 = 2,
  Rsa2048_OaepSha256_B64 = 3,
  Rsa2048_OaepSha1_B64 = 4,
}

/** A 64-byte key split into encryption and MAC halves (AES-256-CBC + HMAC-SHA256). */
export interface SymmetricKey {
  readonly encKey: Uint8Array;
  readonly macKey: Uint8Array;
}

/** Parsed form of `"2.<iv>|<data>|<mac>"`. Fields are base64-decoded. */
export interface EncString {
  readonly type: EncryptionType;
  readonly iv: Uint8Array;
  readonly data: Uint8Array;
  readonly mac: Uint8Array | null;
}

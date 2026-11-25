import { sdk, type SdkKdf } from './sdk';
import { KdfType, type KdfConfig, type SymmetricKey } from './types';

/** Bitwarden salts the master key with the account email, trimmed and lower-cased. */
export function emailSalt(email: string): string {
  return email.trim().toLowerCase();
}

export function toSdkKdf(kdf: KdfConfig): SdkKdf {
  return kdf.type === KdfType.PBKDF2_SHA256
    ? { pBKDF2: { iterations: kdf.iterations } }
    : {
        argon2id: {
          iterations: kdf.iterations,
          memory: kdf.memoryMiB,
          parallelism: kdf.parallelism,
        },
      };
}

/** Derive the 32-byte master key (PBKDF2-SHA256 or Argon2id, via the SDK). */
export async function deriveMasterKey(
  password: string,
  salt: string,
  kdf: KdfConfig,
): Promise<Uint8Array> {
  const crypto = await sdk();
  const encoder = new TextEncoder();
  return crypto.derive_kdf_material(encoder.encode(password), encoder.encode(salt), toSdkKdf(kdf));
}

/** Server auth hash: PBKDF2-SHA256(masterKey, salt = password, 1 iteration), base64. */
export async function hashMasterKey(masterKey: Uint8Array, password: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    masterKey as Uint8Array<ArrayBuffer>,
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(password), iterations: 1 },
    key,
    256,
  );
  return toBase64(new Uint8Array(bits));
}

/**
 * Stretch the master key into a 64-byte AES-256-CBC + HMAC-SHA256 key with HKDF-Expand
 * (info "enc" and "mac"), as the official clients do before unwrapping the user key.
 */
export async function stretchMasterKey(masterKey: Uint8Array): Promise<SymmetricKey> {
  const [enc, mac] = await Promise.all([
    hkdfExpand(masterKey, 'enc'),
    hkdfExpand(masterKey, 'mac'),
  ]);
  const out = new Uint8Array(64);
  out.set(enc, 0);
  out.set(mac, 32);
  return out;
}

/** HKDF-Expand (RFC 5869) with SHA-256 for a single 32-byte block: HMAC(prk, info || 0x01). */
async function hkdfExpand(prk: Uint8Array, info: string): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    prk as Uint8Array<ArrayBuffer>,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const infoBytes = new TextEncoder().encode(info);
  const message = new Uint8Array(infoBytes.length + 1);
  message.set(infoBytes);
  message[infoBytes.length] = 1;
  return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, message));
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

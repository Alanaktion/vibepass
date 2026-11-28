import { emailSalt, deriveMasterKey, hashMasterKey, stretchMasterKey, toSdkKdf } from './kdf';
import { sdk } from './sdk';
import type { EncString, KdfConfig, PrivateKey, SymmetricKey } from './types';

/** Thrown when the master password does not decrypt the user key. */
export class WrongPasswordError extends Error {
  constructor() {
    super('Incorrect master password');
    this.name = 'WrongPasswordError';
  }
}

export interface LoginKeys {
  /** Sent to the server as the password in the token request. Never store it. */
  masterPasswordHash: string;
  /** Stretched master key, used once to unwrap the user key returned by the server. */
  stretchedMasterKey: SymmetricKey;
}

/** One KDF run for login: derive the master key, then the server hash and stretched key. */
export async function deriveLoginKeys(
  password: string,
  email: string,
  kdf: KdfConfig,
  salt: string = emailSalt(email),
): Promise<LoginKeys> {
  const masterKey = await deriveMasterKey(password, salt, kdf);
  try {
    const [masterPasswordHash, stretchedMasterKey] = await Promise.all([
      hashMasterKey(masterKey, password),
      stretchMasterKey(masterKey),
    ]);
    return { masterPasswordHash, stretchedMasterKey };
  } finally {
    masterKey.fill(0);
  }
}

/** Unwrap the protected user key (from the token or sync response) with a stretched master key. */
export async function unwrapUserKey(
  protectedKey: EncString,
  stretchedMasterKey: SymmetricKey,
): Promise<SymmetricKey> {
  const crypto = await sdk();
  try {
    return crypto.unwrap_symmetric_key(protectedKey, stretchedMasterKey);
  } catch {
    throw new WrongPasswordError();
  }
}

/** Unlock offline: derive from the master password and unwrap the cached protected user key. */
export async function decryptUserKeyWithPassword(
  protectedKey: EncString,
  password: string,
  salt: string,
  kdf: KdfConfig,
): Promise<SymmetricKey> {
  const crypto = await sdk();
  try {
    return crypto.decrypt_user_key_with_master_password(
      protectedKey,
      password,
      salt,
      toSdkKdf(kdf),
    );
  } catch {
    throw new WrongPasswordError();
  }
}

/** Decrypt the account's RSA private key (profile.privateKey) with the user key. */
export async function unwrapPrivateKey(
  protectedKey: EncString,
  userKey: SymmetricKey,
): Promise<PrivateKey> {
  return (await sdk()).unwrap_decapsulation_key(protectedKey, userKey);
}

/** Decrypt an organization key (RSA-OAEP EncString) with the account's private key. */
export async function decryptOrgKey(
  encOrgKey: EncString,
  privateKey: PrivateKey,
): Promise<SymmetricKey> {
  return (await sdk()).decapsulate_key_unsigned(encOrgKey, privateKey);
}

/** Unwrap a per-item cipher key with its owner's (user or organization) key. */
export async function unwrapKey(wrapped: EncString, key: SymmetricKey): Promise<SymmetricKey> {
  return (await sdk()).unwrap_symmetric_key(wrapped, key);
}

export async function decryptString(value: EncString, key: SymmetricKey): Promise<string> {
  return (await sdk()).symmetric_decrypt_string(value, key);
}

export async function encryptString(value: string, key: SymmetricKey): Promise<EncString> {
  return (await sdk()).symmetric_encrypt_string(value, key);
}

/** A fresh per-item key (AES-256-CBC + HMAC), as the official clients make for new items. */
export async function makeCipherKey(): Promise<SymmetricKey> {
  return (await sdk()).make_user_key_aes256_cbc_hmac();
}

/** Wrap a per-item key with its owner's (user or organization) key. */
export async function wrapKey(key: SymmetricKey, wrappingKey: SymmetricKey): Promise<EncString> {
  return (await sdk()).wrap_symmetric_key(key, wrappingKey);
}

/** Thrown when a PIN does not decrypt the PIN-protected user key. */
export class WrongPinError extends Error {
  constructor() {
    super('Incorrect PIN');
    this.name = 'WrongPinError';
  }
}

/**
 * Wrap the user key with a PIN, as Bitwarden's clients do for "unlock with PIN": the PIN goes
 * through the account's own KDF (salted with the email) and the stretched result wraps the user
 * key. This is the same construction as the master password, so the SDK's master password
 * functions make and open it.
 */
export async function protectUserKeyWithPin(
  userKey: SymmetricKey,
  pin: string,
  salt: string,
  kdf: KdfConfig,
): Promise<EncString> {
  return (await sdk()).encrypt_user_key_with_master_password(userKey, pin, salt, toSdkKdf(kdf));
}

/** Unlock with a PIN: unwrap the PIN-protected user key made by `protectUserKeyWithPin`. */
export async function decryptUserKeyWithPin(
  protectedKey: EncString,
  pin: string,
  salt: string,
  kdf: KdfConfig,
): Promise<SymmetricKey> {
  const crypto = await sdk();
  try {
    return crypto.decrypt_user_key_with_master_password(protectedKey, pin, salt, toSdkKdf(kdf));
  } catch {
    throw new WrongPinError();
  }
}

/**
 * Turn a WebAuthn PRF output into a wrapping key the way Bitwarden's clients do for passkey
 * login (`createSymmetricKeyFromPrf`): HKDF-Expand the 32-byte output into an encryption half
 * ("enc") and a MAC half ("mac").
 */
export async function keyFromPrf(prf: Uint8Array): Promise<SymmetricKey> {
  if (prf.length !== 32) throw new Error('Unexpected PRF output');
  return stretchMasterKey(prf);
}

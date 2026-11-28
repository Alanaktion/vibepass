import browser from '../shared/browser';
import type { EncString } from '../crypto/types';

/**
 * Biometric unlock (Touch ID, Windows Hello), in `storage.local`. The user key is wrapped with a
 * key from a platform passkey's PRF output, which never leaves the device's secure hardware
 * without a fingerprint or face check, so the wrapped key is safe to keep on disk.
 */
export interface BiometricRecord {
  userId: string;
  /** The platform passkey's credential id, base64. */
  credentialId: string;
  /** The PRF input, base64. Random per setup. */
  salt: string;
  /** The user key, wrapped with the PRF-derived key. */
  protectedUserKey: EncString;
  /** A known string encrypted with the user key, to notice a rotated account key. */
  check: EncString;
}

const KEY = 'biometric';

export const biometricStore = {
  async load(): Promise<BiometricRecord | null> {
    const stored = (await browser.storage.local.get(KEY))[KEY] as BiometricRecord | undefined;
    return stored ?? null;
  },
  async save(record: BiometricRecord): Promise<void> {
    await browser.storage.local.set({ [KEY]: record });
  },
  async clear(): Promise<void> {
    await browser.storage.local.remove(KEY);
  },
};

export type BiometricDeps = typeof biometricStore;

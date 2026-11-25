import browser from '../shared/browser';
import type { EncString, KdfConfig } from '../crypto/types';

/**
 * The logged-in account, in `storage.local`. Everything here is either public (server URL,
 * email, KDF settings) or encrypted (the protected user key, and the refresh token, which we
 * encrypt with the user key so it is useless until the vault is unlocked).
 */
export interface Account {
  serverUrl: string;
  email: string;
  userId: string;
  salt: string;
  kdf: KdfConfig;
  /** The user key wrapped with the master key, as the server stores it. */
  protectedUserKey: EncString;
  /** Refresh token, encrypted with the user key. */
  refreshToken: EncString | null;
}

const ACCOUNT_KEY = 'account';
const DEVICE_KEY = 'deviceId';

export async function loadAccount(): Promise<Account | null> {
  const stored = (await browser.storage.local.get(ACCOUNT_KEY))[ACCOUNT_KEY] as Account | undefined;
  return stored ?? null;
}

export async function saveAccount(account: Account): Promise<void> {
  await browser.storage.local.set({ [ACCOUNT_KEY]: account });
}

export async function clearAccount(): Promise<void> {
  await browser.storage.local.remove(ACCOUNT_KEY);
}

/** A stable random id for this install, sent as the device identifier at login. */
export async function deviceId(): Promise<string> {
  const stored = (await browser.storage.local.get(DEVICE_KEY))[DEVICE_KEY] as string | undefined;
  if (stored) return stored;
  const id = crypto.randomUUID();
  await browser.storage.local.set({ [DEVICE_KEY]: id });
  return id;
}

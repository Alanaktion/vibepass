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
  // Discard tokens written in plaintext by older releases, including signed-out accounts.
  await browser.storage.local.remove('twoFactorRemember');
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

const REMEMBER_KEY = 'encryptedTwoFactorRemember';

/**
 * "Remember me" tokens for two-step login, by server and email, as the official clients keep
 * them. A token only skips the second step; it still needs the master password.
 */
export const rememberedTwoFactor = {
  async get(serverUrl: string, email: string): Promise<string | null> {
    const all = await readRemembered();
    return all[rememberKey(serverUrl, email)] ?? null;
  },
  async set(serverUrl: string, email: string, token: string | null): Promise<void> {
    const key = rememberKey(serverUrl, email);
    const all = Object.entries(await readRemembered()).filter(([k]) => k !== key);
    if (token) all.push([key, token]);
    await browser.storage.local.set({ [REMEMBER_KEY]: Object.fromEntries(all) });
  },
};

function rememberKey(serverUrl: string, email: string): string {
  return `${serverUrl}|${email.trim().toLowerCase()}`;
}

async function readRemembered(): Promise<Record<string, string>> {
  const stored = (await browser.storage.local.get(REMEMBER_KEY))[REMEMBER_KEY];
  return typeof stored === 'object' && stored !== null ? (stored as Record<string, string>) : {};
}

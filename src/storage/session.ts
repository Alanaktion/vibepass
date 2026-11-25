import browser from '../shared/browser';
import { fromBase64, toBase64 } from '../crypto/kdf';
import type { SymmetricKey } from '../crypto/types';

/**
 * Keeps the unlocked state across MV3 service-worker restarts using `storage.session`, which is
 * memory-only, cleared when the browser closes, and (in Chrome) hidden from content scripts.
 * Never use `storage.local` for anything here.
 */
export interface UnlockedSession {
  userKey: SymmetricKey;
  accessToken: string | null;
  /** Epoch milliseconds when the access token expires. */
  accessTokenExpiresAt: number;
  /** The server's vault revision at the last sync, so polling can skip unchanged vaults. */
  revision?: number | null;
}

interface StoredSession {
  userKey: string;
  accessToken: string | null;
  accessTokenExpiresAt: number;
  revision?: number | null;
}

const KEY = 'unlocked';

export const sessionStore = {
  async save(session: UnlockedSession): Promise<void> {
    const stored: StoredSession = {
      userKey: toBase64(session.userKey),
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt,
      revision: session.revision ?? null,
    };
    await browser.storage.session.set({ [KEY]: stored });
  },
  async load(): Promise<UnlockedSession | null> {
    const stored = (await browser.storage.session.get(KEY))[KEY] as StoredSession | undefined;
    if (!stored) return null;
    return { ...stored, userKey: fromBase64(stored.userKey) };
  },
  async clear(): Promise<void> {
    await browser.storage.session.remove(KEY);
  },
};

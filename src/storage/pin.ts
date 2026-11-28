import browser from '../shared/browser';
import type { EncString, KdfConfig } from '../crypto/types';

/**
 * The user key wrapped with the PIN (see `protectUserKeyWithPin`), with the KDF settings it was
 * made with, so a later KDF change on the account doesn't break it.
 */
export interface PinEnvelope {
  protectedUserKey: EncString;
  salt: string;
  kdf: KdfConfig;
}

/**
 * PIN unlock settings, in `storage.local`. Like Bitwarden's clients, the PIN itself is kept
 * encrypted with the user key, so after a master password unlock Vibepass can wrap the user key
 * with it again without asking for the PIN.
 */
export interface PinRecord {
  userId: string;
  /** The PIN, encrypted with the user key. */
  encryptedPin: EncString;
  /**
   * Keep PIN unlock across browser restarts. Then the envelope lives on disk (here); otherwise
   * it lives in `storage.session` and the master password is needed after a restart.
   */
  afterRestart: boolean;
  /** Accept the PIN for items that ask for the master password again. */
  reprompt: boolean;
  /** Wrong PINs since the last correct PIN or master password. Survives restarts on purpose. */
  failedAttempts: number;
  envelope?: PinEnvelope;
}

const RECORD_KEY = 'pin';
const SESSION_KEY = 'pinEnvelope';

export const pinStore = {
  async load(): Promise<PinRecord | null> {
    const stored = (await browser.storage.local.get(RECORD_KEY))[RECORD_KEY] as
      PinRecord | undefined;
    return stored ?? null;
  },
  async save(record: PinRecord): Promise<void> {
    await browser.storage.local.set({ [RECORD_KEY]: record });
  },
  async clear(): Promise<void> {
    await browser.storage.local.remove(RECORD_KEY);
    await browser.storage.session.remove(SESSION_KEY);
  },
  /** The envelope for "ask for the master password after a restart": memory only. */
  async loadSession(): Promise<PinEnvelope | null> {
    const stored = (await browser.storage.session.get(SESSION_KEY))[SESSION_KEY] as
      PinEnvelope | undefined;
    return stored ?? null;
  },
  async saveSession(envelope: PinEnvelope | null): Promise<void> {
    if (envelope) await browser.storage.session.set({ [SESSION_KEY]: envelope });
    else await browser.storage.session.remove(SESSION_KEY);
  },
};

export type PinDeps = typeof pinStore;

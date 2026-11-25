import type { LockState, VaultStatus } from '../shared/messages';
import type { CipherSummary } from './types';
import type { SymmetricKey } from '../crypto/types';

/**
 * In-memory vault state owned by the background worker.
 *
 * MV3 service workers can be terminated at any time, so anything that must survive a restart
 * while unlocked goes to session storage (see src/storage/session.ts), never to local storage.
 */
export class VaultState {
  private state: LockState = 'logged-out';
  private serverUrl: string | null = null;
  private email: string | null = null;
  private lastSync: string | null = null;
  private userKey: SymmetricKey | null = null;
  private ciphers: CipherSummary[] = [];

  status(): VaultStatus {
    return {
      state: this.state,
      serverUrl: this.serverUrl,
      email: this.email,
      lastSync: this.lastSync,
    };
  }

  get items(): readonly CipherSummary[] {
    return this.ciphers;
  }

  setAccount(serverUrl: string, email: string): void {
    this.serverUrl = serverUrl;
    this.email = email;
    if (this.state === 'logged-out') this.state = 'locked';
  }

  unlock(userKey: SymmetricKey, ciphers: CipherSummary[]): void {
    this.userKey = userKey;
    this.ciphers = ciphers;
    this.state = 'unlocked';
  }

  markSynced(at: Date = new Date()): void {
    this.lastSync = at.toISOString();
  }

  /** Drop every decrypted value. Called on manual lock, idle timeout, and browser close. */
  lock(): void {
    this.userKey = null;
    this.ciphers = [];
    if (this.state === 'unlocked') this.state = 'locked';
  }

  get isUnlocked(): boolean {
    return this.state === 'unlocked' && this.userKey !== null;
  }
}

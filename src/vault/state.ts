import type { LockState, VaultStatus } from '../shared/messages';
import type { Account } from '../storage/account';
import type { SymmetricKey } from '../crypto/types';
import type { CipherSummary, FolderSummary } from './types';
import type { DecryptedVault } from './decrypt';

/**
 * In-memory vault state owned by the background worker.
 *
 * MV3 service workers can be terminated at any time, so anything that must survive a restart
 * while unlocked goes to session storage (see src/storage/session.ts), never to local storage.
 */
export class VaultState {
  private account: Account | null = null;
  private userKey: SymmetricKey | null = null;
  private ciphers: CipherSummary[] = [];
  private folderList: FolderSummary[] = [];
  private lastSync: string | null = null;

  get state(): LockState {
    if (!this.account) return 'logged-out';
    return this.userKey ? 'unlocked' : 'locked';
  }

  status(): VaultStatus {
    return {
      state: this.state,
      serverUrl: this.account?.serverUrl ?? null,
      email: this.account?.email ?? null,
      lastSync: this.lastSync,
      itemCount: this.userKey ? this.ciphers.length : 0,
    };
  }

  get currentAccount(): Account | null {
    return this.account;
  }

  get key(): SymmetricKey | null {
    return this.userKey;
  }

  get items(): readonly CipherSummary[] {
    return this.ciphers;
  }

  get folders(): readonly FolderSummary[] {
    return this.folderList;
  }

  setAccount(account: Account | null): void {
    this.account = account;
    if (!account) this.lock();
  }

  unlock(userKey: SymmetricKey, vault: DecryptedVault): void {
    this.userKey = userKey;
    this.setVault(vault);
  }

  setVault(vault: DecryptedVault): void {
    this.ciphers = vault.items;
    this.folderList = vault.folders;
  }

  markSynced(at: Date = new Date()): void {
    this.lastSync = at.toISOString();
  }

  /** Drop every decrypted value. Called on manual lock, idle timeout, and browser close. */
  lock(): void {
    this.userKey?.fill(0);
    this.userKey = null;
    this.ciphers = [];
    this.folderList = [];
  }

  get isUnlocked(): boolean {
    return this.state === 'unlocked';
  }
}

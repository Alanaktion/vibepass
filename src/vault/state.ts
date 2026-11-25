import type { CipherResponse } from '../api/types';
import type { LockState, VaultStatus } from '../shared/messages';
import type { Account } from '../storage/account';
import type { SymmetricKey } from '../crypto/types';
import type {
  CipherSummary,
  CollectionSummary,
  FolderSummary,
  OrganizationSummary,
  TrashItem,
} from './types';
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
  private orgKeyMap = new Map<string, SymmetricKey>();
  private rawCiphers = new Map<string, CipherResponse>();
  private ciphers: CipherSummary[] = [];
  private folderList: FolderSummary[] = [];
  private collectionList: CollectionSummary[] = [];
  private organizationList: OrganizationSummary[] = [];
  private trashList: TrashItem[] = [];
  private lastSync: string | null = null;
  private lastSyncError: string | null = null;
  /** Bumped whenever the decrypted view changes, so open views know to reload. */
  private version = 0;

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
      syncError: this.userKey ? this.lastSyncError : null,
      version: this.version,
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

  get collections(): readonly CollectionSummary[] {
    return this.collectionList;
  }

  get organizations(): readonly OrganizationSummary[] {
    return this.organizationList;
  }

  get trash(): readonly TrashItem[] {
    return this.trashList;
  }

  get orgKeys(): ReadonlyMap<string, SymmetricKey> {
    return this.orgKeyMap;
  }

  /** The encrypted cipher, for decrypting one item on demand. */
  raw(id: string): CipherResponse | null {
    return this.rawCiphers.get(id) ?? null;
  }

  summary(id: string): CipherSummary | null {
    return this.ciphers.find((item) => item.id === id) ?? null;
  }

  setAccount(account: Account | null): void {
    this.account = account;
    if (!account) {
      this.lock();
      this.lastSync = null;
    }
  }

  unlock(userKey: SymmetricKey, vault: DecryptedVault): void {
    this.userKey = userKey;
    this.setVault(vault);
  }

  setVault(vault: DecryptedVault): void {
    this.version++;
    if (vault.orgKeys !== this.orgKeyMap) this.zeroOrgKeys();
    this.orgKeyMap = vault.orgKeys;
    this.rawCiphers = vault.raw;
    this.ciphers = vault.items;
    this.folderList = vault.folders;
    this.collectionList = vault.collections;
    this.organizationList = vault.organizations;
    this.trashList = vault.trash;
  }

  markSynced(at: Date = new Date()): void {
    this.lastSync = at.toISOString();
    this.lastSyncError = null;
  }

  markSyncFailed(message: string): void {
    this.lastSyncError = message;
  }

  private zeroOrgKeys(): void {
    for (const key of this.orgKeyMap.values()) key.fill(0);
    this.orgKeyMap = new Map();
  }

  /** Drop every decrypted value. Called on manual lock, idle timeout, and browser close. */
  lock(): void {
    this.userKey?.fill(0);
    this.userKey = null;
    this.zeroOrgKeys();
    this.rawCiphers = new Map();
    this.ciphers = [];
    this.folderList = [];
    this.collectionList = [];
    this.organizationList = [];
    this.trashList = [];
    this.lastSyncError = null;
  }

  get isUnlocked(): boolean {
    return this.state === 'unlocked';
  }
}

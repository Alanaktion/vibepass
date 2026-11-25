import { ApiClient, ApiError } from '../api';
import type { DeviceInfo, SyncResponse, TokenResponse } from '../api/types';
import { kdfFromWire } from '../api/client';
import {
  decryptString,
  decryptUserKeyWithPassword,
  deriveLoginKeys,
  emailSalt,
  encryptString,
  unwrapUserKey,
  type SymmetricKey,
} from '../crypto';
import { log } from '../shared/log';
import type { VaultStatus } from '../shared/messages';
import type { SearchIndex } from '../search';
import type { Account } from '../storage/account';
import type { UnlockedSession } from '../storage/session';
import { decryptVault } from '../vault/decrypt';
import type { VaultState } from '../vault/state';

export interface ServiceDeps {
  createApi(serverUrl: string): ApiClient;
  account: {
    load(): Promise<Account | null>;
    save(account: Account): Promise<void>;
    clear(): Promise<void>;
    deviceId(): Promise<string>;
  };
  session: {
    save(session: UnlockedSession): Promise<void>;
    load(): Promise<UnlockedSession | null>;
    clear(): Promise<void>;
  };
  cache: {
    read(userId: string): Promise<SyncResponse | null>;
    write(userId: string, sync: SyncResponse): Promise<void>;
    clear(userId: string): Promise<void>;
  };
  device: Omit<DeviceInfo, 'identifier'>;
  now(): number;
}

/** Refresh the access token this long before it actually expires. */
const TOKEN_SKEW_MS = 60_000;

/**
 * Login, unlock, lock, and sync, on top of VaultState. Owns the order of operations so the
 * handlers stay thin, and restores the unlocked state after an MV3 worker restart.
 */
export class VaultService {
  private readonly ready: Promise<void>;
  private session: UnlockedSession | null = null;
  private syncing: Promise<void> | null = null;

  constructor(
    private readonly vault: VaultState,
    private readonly search: SearchIndex,
    private readonly deps: ServiceDeps,
  ) {
    this.ready = this.restore().catch((error: unknown) => {
      log.error('restore failed', error);
    });
  }

  async status(): Promise<VaultStatus> {
    await this.ready;
    return this.vault.status();
  }

  async login(serverUrl: string, email: string, password: string): Promise<VaultStatus> {
    await this.ready;
    const api = this.deps.createApi(serverUrl);
    const prelogin = await api.prelogin(email.trim());
    const salt = prelogin.salt ?? emailSalt(email);
    const keys = await deriveLoginKeys(password, email, prelogin.kdf, salt);
    const token = await api.login({
      email: email.trim(),
      masterPasswordHash: keys.masterPasswordHash,
      device: { ...this.deps.device, identifier: await this.deps.account.deviceId() },
    });
    const unlockData = token.UserDecryptionOptions?.MasterPasswordUnlock;
    const protectedUserKey = unlockData?.MasterKeyEncryptedUserKey ?? token.Key;
    if (!protectedUserKey) throw new Error('The server did not return an account key');
    const userKey = await unwrapUserKey(protectedUserKey, keys.stretchedMasterKey);
    keys.stretchedMasterKey.fill(0);

    const sync = await api.sync();
    const account: Account = {
      serverUrl: api.baseUrl,
      email: email.trim(),
      userId: sync.profile.id,
      salt: unlockData?.Salt ?? salt,
      kdf: unlockData
        ? kdfFromWire(
            unlockData.Kdf.KdfType,
            unlockData.Kdf.Iterations,
            unlockData.Kdf.Memory,
            unlockData.Kdf.Parallelism,
          )
        : prelogin.kdf,
      protectedUserKey,
      refreshToken: token.refresh_token ? await encryptString(token.refresh_token, userKey) : null,
    };
    await this.deps.account.save(account);
    this.vault.setAccount(account);
    await this.startSession(userKey, token);
    await this.applySync(sync, account);
    return this.vault.status();
  }

  /** Unlock with the master password, offline: no server round trip before the vault shows. */
  async unlock(password: string): Promise<VaultStatus> {
    await this.ready;
    const account = this.vault.currentAccount;
    if (!account) throw new Error('Log in first');
    const userKey = await decryptUserKeyWithPassword(
      account.protectedUserKey,
      password,
      account.salt,
      account.kdf,
    );
    await this.startSession(userKey, null);
    const cached = await this.deps.cache.read(account.userId);
    if (cached) {
      await this.showVault(cached);
      void this.sync().catch((error: unknown) => {
        log.warn('background sync failed', {
          reason: error instanceof Error ? error.message : 'unknown',
        });
      });
    } else {
      await this.sync();
    }
    return this.vault.status();
  }

  async lock(): Promise<VaultStatus> {
    await this.ready;
    this.vault.lock();
    this.search.clear();
    this.session = null;
    await this.deps.session.clear();
    return this.vault.status();
  }

  async logout(): Promise<VaultStatus> {
    await this.ready;
    const account = this.vault.currentAccount;
    await this.lock();
    if (account) await this.deps.cache.clear(account.userId);
    await this.deps.account.clear();
    this.vault.setAccount(null);
    return this.vault.status();
  }

  /** Fetch the vault from the server, cache it encrypted, and refresh the decrypted view. */
  async sync(): Promise<VaultStatus> {
    await this.ready;
    this.syncing ??= this.doSync().finally(() => {
      this.syncing = null;
    });
    await this.syncing;
    return this.vault.status();
  }

  private async doSync(): Promise<void> {
    const account = this.vault.currentAccount;
    if (!account || !this.vault.key) throw new Error('Unlock first');
    const api = this.deps.createApi(account.serverUrl);
    api.setAccessToken(await this.accessToken(api, account, this.vault.key));
    const sync = await api.sync();
    await this.applySync(sync, account);
  }

  private async applySync(sync: SyncResponse, account: Account): Promise<void> {
    if (sync.profile.id !== account.userId)
      throw new Error('The server returned a different account');
    // If the master password or KDF changed in another client, keep offline unlock working.
    const unlock = sync.userDecryption?.masterPasswordUnlock;
    if (unlock && unlock.masterKeyEncryptedUserKey !== account.protectedUserKey) {
      const updated: Account = {
        ...account,
        salt: unlock.salt,
        kdf: kdfFromWire(
          unlock.kdf.kdfType,
          unlock.kdf.iterations,
          unlock.kdf.memory,
          unlock.kdf.parallelism,
        ),
        protectedUserKey: unlock.masterKeyEncryptedUserKey,
      };
      await this.deps.account.save(updated);
      this.vault.setAccount(updated);
    }
    await this.deps.cache.write(account.userId, sync);
    await this.showVault(sync);
    this.vault.markSynced(new Date(this.deps.now()));
  }

  private async showVault(sync: SyncResponse): Promise<void> {
    const key = this.vault.key;
    if (!key) return;
    const decrypted = await decryptVault(sync, key);
    // The vault may have been locked while we were decrypting.
    if (this.vault.key !== key) return;
    this.vault.unlock(key, decrypted);
    this.search.replaceAll(decrypted.items);
    if (decrypted.skipped > 0) log.debug('items skipped', { count: decrypted.skipped });
  }

  private async startSession(userKey: SymmetricKey, token: TokenResponse | null): Promise<void> {
    this.session = {
      userKey,
      accessToken: token?.access_token ?? null,
      accessTokenExpiresAt: token ? this.deps.now() + token.expires_in * 1000 : 0,
    };
    // VaultState shows "unlocked" once it has the key; items arrive with showVault().
    this.vault.unlock(userKey, { items: [], folders: [], skipped: 0 });
    await this.deps.session.save(this.session);
  }

  private async accessToken(
    api: ApiClient,
    account: Account,
    userKey: SymmetricKey,
  ): Promise<string> {
    const session = this.session;
    if (session?.accessToken && session.accessTokenExpiresAt - TOKEN_SKEW_MS > this.deps.now()) {
      return session.accessToken;
    }
    if (!account.refreshToken) throw new ApiError('Your session expired. Log in again.', 401);
    const refreshToken = await decryptString(account.refreshToken, userKey);
    const token = await api.refresh(refreshToken);
    if (token.refresh_token && token.refresh_token !== refreshToken) {
      const updated = {
        ...account,
        refreshToken: await encryptString(token.refresh_token, userKey),
      };
      await this.deps.account.save(updated);
      this.vault.setAccount(updated);
    }
    this.session = {
      userKey,
      accessToken: token.access_token,
      accessTokenExpiresAt: this.deps.now() + token.expires_in * 1000,
    };
    await this.deps.session.save(this.session);
    return token.access_token;
  }

  /** After a worker restart: reload the account, and the unlocked session if there is one. */
  private async restore(): Promise<void> {
    const account = await this.deps.account.load();
    this.vault.setAccount(account);
    if (!account) return;
    const session = await this.deps.session.load();
    if (!session) return;
    this.session = session;
    this.vault.unlock(session.userKey, { items: [], folders: [], skipped: 0 });
    const cached = await this.deps.cache.read(account.userId);
    if (cached) await this.showVault(cached);
  }
}

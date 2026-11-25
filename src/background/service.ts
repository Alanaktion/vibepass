import { ApiClient, ApiError, TwoFactorRequiredError } from '../api';
import {
  TwoFactorProvider,
  type DeviceInfo,
  type LoginChallenge,
  type SyncResponse,
  type TokenResponse,
} from '../api/types';
import { kdfFromWire } from '../api/client';
import {
  decryptString,
  decryptUserKeyWithPassword,
  deriveLoginKeys,
  emailSalt,
  encryptString,
  sdk,
  toBase64,
  unwrapKey,
  unwrapUserKey,
  type LoginKeys,
  type SymmetricKey,
} from '../crypto';
import { CodedError } from '../shared/errors';
import { log } from '../shared/log';
import type { LoginRequest, VaultStatus } from '../shared/messages';
import type { SearchIndex } from '../search';
import type { Account } from '../storage/account';
import type { UnlockedSession } from '../storage/session';
import {
  decryptCipher,
  decryptVault,
  emptyVault,
  ownerKeyFor,
  secretValue,
  toDetail,
  cipherKey,
  type DecryptedCipher,
} from '../vault/decrypt';
import type { VaultState } from '../vault/state';
import { generateTotp, type TotpCode } from '../vault/totp';
import type { CipherDetail } from '../vault/types';

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
  /** "Remember me" tokens for two-step login. */
  remembered: {
    get(serverUrl: string, email: string): Promise<string | null>;
    set(serverUrl: string, email: string, token: string | null): Promise<void>;
  };
  device: Omit<DeviceInfo, 'identifier'>;
  now(): number;
  /** Called whenever the status may have changed, so open popups can follow along. */
  onStatus?(status: VaultStatus): void;
}

/** Refresh the access token this long before it actually expires. */
const TOKEN_SKEW_MS = 60_000;

/** Everything autofill needs for one item. Lives for one fill, in the worker. */
export interface FillData {
  item: DecryptedCipher;
  totp: TotpCode | null;
}

/**
 * Login, unlock, lock, sync, and on-demand item access, on top of VaultState. Owns the order of
 * operations so the handlers stay thin, and restores the unlocked state after an MV3 worker
 * restart.
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

  private notify(): void {
    this.deps.onStatus?.(this.vault.status());
  }

  /** Derive the login keys once for a request (login, or asking for an emailed code). */
  private async loginKeys(req: LoginRequest) {
    const api = this.deps.createApi(req.serverUrl);
    const email = req.email.trim();
    const prelogin = await api.prelogin(email);
    const salt = prelogin.salt ?? emailSalt(email);
    const keys = await deriveLoginKeys(req.masterPassword, email, prelogin.kdf, salt);
    return { api, email, prelogin, salt, keys };
  }

  async login(req: LoginRequest): Promise<VaultStatus> {
    await this.ready;
    const { api, email, prelogin, salt, keys } = await this.loginKeys(req);
    try {
      const token = await this.requestToken(api, email, keys, req.challenge);
      const unlockData = token.UserDecryptionOptions?.MasterPasswordUnlock;
      const protectedUserKey = unlockData?.MasterKeyEncryptedUserKey ?? token.Key;
      if (!protectedUserKey) throw new Error('The server did not return an account key');
      const userKey = await unwrapUserKey(protectedUserKey, keys.stretchedMasterKey);

      if (req.challenge?.twoFactor?.remember && token.TwoFactorToken) {
        await this.deps.remembered.set(api.baseUrl, email, token.TwoFactorToken);
      }

      const sync = await api.sync();
      const account: Account = {
        serverUrl: api.baseUrl,
        email,
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
        refreshToken: token.refresh_token
          ? await encryptString(token.refresh_token, userKey)
          : null,
      };
      await this.deps.account.save(account);
      this.vault.setAccount(account);
      await this.startSession(userKey, token);
      await this.applySync(sync, account, await this.tryRevision(api));
      this.notify();
      return this.vault.status();
    } finally {
      keys.stretchedMasterKey.fill(0);
    }
  }

  /**
   * Password grant, with a remembered two-step token when we have one. If the server no longer
   * accepts that token, forget it and let the user enter a code.
   */
  private async requestToken(
    api: ApiClient,
    email: string,
    keys: LoginKeys,
    challenge: LoginChallenge | undefined,
  ): Promise<TokenResponse> {
    const device = { ...this.deps.device, identifier: await this.deps.account.deviceId() };
    const base = { email, masterPasswordHash: keys.masterPasswordHash, device };
    if (!challenge?.twoFactor) {
      const remembered = await this.deps.remembered.get(api.baseUrl, email);
      if (remembered) {
        try {
          return await api.login({
            ...base,
            challenge: {
              ...challenge,
              twoFactor: {
                provider: TwoFactorProvider.Remember,
                token: remembered,
                remember: false,
              },
            },
          });
        } catch (error) {
          if (!(error instanceof TwoFactorRequiredError)) throw error;
          await this.deps.remembered.set(api.baseUrl, email, null);
        }
      }
    }
    return api.login(challenge ? { ...base, challenge } : base);
  }

  /** Ask the server to email a two-step login code. */
  async sendLoginEmail(req: LoginRequest): Promise<void> {
    const { api, email, keys } = await this.loginKeys(req);
    keys.stretchedMasterKey.fill(0);
    await api.sendEmailLoginCode(
      email,
      keys.masterPasswordHash,
      await this.deps.account.deviceId(),
    );
  }

  /** Ask Bitwarden to email the new-device verification code again. */
  async resendDeviceCode(req: LoginRequest): Promise<void> {
    const { api, email, keys } = await this.loginKeys(req);
    keys.stretchedMasterKey.fill(0);
    await api.resendNewDeviceOtp(email, keys.masterPasswordHash);
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
      this.notify();
      void this.backgroundSync(true);
    } else {
      await this.sync();
    }
    return this.vault.status();
  }

  async lock(): Promise<VaultStatus> {
    await this.ready;
    const wasUnlocked = this.vault.isUnlocked;
    this.vault.lock();
    this.search.clear();
    this.session = null;
    await this.deps.session.clear();
    if (wasUnlocked) this.notify();
    return this.vault.status();
  }

  async logout(): Promise<VaultStatus> {
    await this.ready;
    const account = this.vault.currentAccount;
    await this.lock();
    if (account) await this.deps.cache.clear(account.userId);
    await this.deps.account.clear();
    this.vault.setAccount(null);
    this.notify();
    return this.vault.status();
  }

  /** Fetch the vault from the server, cache it encrypted, and refresh the decrypted view. */
  async sync(): Promise<VaultStatus> {
    await this.ready;
    await this.runSync(true);
    return this.vault.status();
  }

  /**
   * Sync for timers and popup opens: only when unlocked, skips the full sync when the server's
   * revision hasn't changed, and records errors in the status instead of throwing.
   */
  async backgroundSync(force = false): Promise<void> {
    await this.ready;
    if (!this.vault.isUnlocked) return;
    try {
      await this.runSync(force);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sync failed';
      log.warn('background sync failed', { reason: message });
      // The vault may have locked while the sync was running.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (this.vault.isUnlocked) {
        this.vault.markSyncFailed(message);
        this.notify();
      }
    }
  }

  private runSync(force: boolean): Promise<void> {
    this.syncing ??= this.doSync(force).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async doSync(force: boolean): Promise<void> {
    const account = this.vault.currentAccount;
    if (!account || !this.vault.key) throw new CodedError('Unlock first', 'locked');
    const api = await this.authedApi(account, this.vault.key);
    const revision = await this.tryRevision(api);
    if (!force && revision !== null && revision === this.session?.revision) {
      this.vault.markSynced(new Date(this.deps.now()));
      return;
    }
    const sync = await api.sync();
    await this.applySync(sync, account, revision);
    this.notify();
  }

  /** The revision endpoint is an optimization; a server without it still syncs. */
  private async tryRevision(api: ApiClient): Promise<number | null> {
    try {
      return await api.revisionDate();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 0)) throw error;
      return null;
    }
  }

  private async authedApi(account: Account, userKey: SymmetricKey): Promise<ApiClient> {
    const api = this.deps.createApi(account.serverUrl);
    api.setAccessToken(await this.accessToken(api, account, userKey));
    return api;
  }

  private async applySync(
    sync: SyncResponse,
    account: Account,
    revision: number | null,
  ): Promise<void> {
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
    if (this.session && this.vault.isUnlocked) {
      this.session = { ...this.session, revision };
      await this.deps.session.save(this.session);
    }
  }

  private async showVault(sync: SyncResponse): Promise<void> {
    const key = this.vault.key;
    if (!key) return;
    const decrypted = await decryptVault(sync, key);
    // The vault may have been locked while we were decrypting.
    if (this.vault.key !== key) {
      for (const orgKey of decrypted.orgKeys.values()) orgKey.fill(0);
      return;
    }
    this.vault.unlock(key, decrypted);
    this.search.replaceAll(decrypted.items, decrypted.notes);
    if (decrypted.skipped > 0) log.debug('items skipped', { count: decrypted.skipped });
  }

  private async startSession(userKey: SymmetricKey, token: TokenResponse | null): Promise<void> {
    this.session = {
      userKey,
      accessToken: token?.access_token ?? null,
      accessTokenExpiresAt: token ? this.deps.now() + token.expires_in * 1000 : 0,
      revision: null,
    };
    // VaultState shows "unlocked" once it has the key; items arrive with showVault().
    this.vault.unlock(userKey, emptyVault());
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
      revision: session?.revision ?? null,
    };
    await this.deps.session.save(this.session);
    return token.access_token;
  }

  // --- One item, on demand ----------------------------------------------------------------

  /** Decrypt one item in full. Checks re-prompt when the caller is about to use a secret. */
  private async decryptItem(
    id: string,
    secret: { masterPassword?: string | undefined } | null,
  ): Promise<DecryptedCipher> {
    await this.ready;
    const userKey = this.vault.key;
    if (!userKey) throw new CodedError('Vibepass is locked', 'locked');
    const raw = this.vault.raw(id);
    if (!raw) throw new Error('That item is no longer in your vault');
    const ownerKey = ownerKeyFor(raw, userKey, this.vault.orgKeys);
    if (!ownerKey) throw new Error('This item belongs to an organization you can no longer read');
    if (secret && raw.reprompt === 1) await this.verifyPassword(secret.masterPassword);
    return decryptCipher(raw, ownerKey);
  }

  /** Master password re-prompt: check the password against the account, offline. */
  private async verifyPassword(password: string | undefined): Promise<void> {
    if (!password) {
      throw new CodedError('Enter your master password to use this item', 'reprompt-required');
    }
    const account = this.vault.currentAccount;
    if (!account) throw new Error('Log in first');
    const key = await decryptUserKeyWithPassword(
      account.protectedUserKey,
      password,
      account.salt,
      account.kdf,
    );
    key.fill(0);
  }

  async item(id: string): Promise<CipherDetail> {
    const item = await this.decryptItem(id, null);
    return toDetail(item, this.vault);
  }

  async reveal(id: string, fieldId: string, masterPassword?: string): Promise<string> {
    const item = await this.decryptItem(id, { masterPassword });
    const { value, allowed } = secretValue(item, fieldId);
    if (!allowed) throw new Error('Your organization hides this value');
    if (value === null) throw new Error('That field is empty');
    return value;
  }

  async totp(id: string, masterPassword?: string): Promise<TotpCode> {
    const item = await this.decryptItem(id, { masterPassword });
    if (!item.login?.totp) throw new Error('This item has no one-time password');
    return generateTotp(item.login.totp, this.deps.now());
  }

  async fillData(id: string, masterPassword?: string): Promise<FillData> {
    const item = await this.decryptItem(id, { masterPassword });
    const totp = item.login?.totp ? await generateTotp(item.login.totp, this.deps.now()) : null;
    return { item, totp };
  }

  async attachment(
    id: string,
    attachmentId: string,
    masterPassword?: string,
  ): Promise<{ fileName: string; base64: string }> {
    const item = await this.decryptItem(id, { masterPassword });
    const account = this.vault.currentAccount;
    const userKey = this.vault.key;
    const raw = this.vault.raw(id);
    if (!account || !userKey || !raw) throw new CodedError('Vibepass is locked', 'locked');
    const local = item.attachments.find((a) => a.id === attachmentId);
    if (!local) throw new Error('That attachment is no longer on this item');

    const api = await this.authedApi(account, userKey);
    const meta = await api.attachment(id, attachmentId);
    if (!meta.url) throw new Error('The server did not return a download link');
    const encrypted = await api.download(meta.url);

    const ownerKey = ownerKeyFor(raw, userKey, this.vault.orgKeys);
    if (!ownerKey) throw new Error('This item belongs to an organization you can no longer read');
    const itemKey = await cipherKey(raw, ownerKey);
    const wrapped = meta.key ?? local.key;
    const fileKey = wrapped ? await unwrapKey(wrapped, itemKey) : itemKey;
    const plain = (await sdk()).symmetric_decrypt_filedata(encrypted, fileKey);
    return { fileName: local.fileName, base64: toBase64(plain) };
  }

  /** After a worker restart: reload the account, and the unlocked session if there is one. */
  private async restore(): Promise<void> {
    const account = await this.deps.account.load();
    this.vault.setAccount(account);
    if (!account) return;
    const session = await this.deps.session.load();
    if (!session) return;
    this.session = session;
    this.vault.unlock(session.userKey, emptyVault());
    const cached = await this.deps.cache.read(account.userId);
    if (cached) await this.showVault(cached);
  }
}

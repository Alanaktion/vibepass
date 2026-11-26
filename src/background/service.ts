import { ApiClient, ApiError, ConflictError, TwoFactorRequiredError } from '../api';
import {
  TwoFactorProvider,
  type CipherResponse,
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
  generate,
  generateForRules,
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
import { activeOptions, HISTORY_LIMIT, type StoredGeneratorOptions } from '../storage/generator';
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
import { encryptDraft, newDraft, toDraft, type PasskeyChange } from '../vault/encrypt';
import type { StoredPasskey } from '../vault/passkey';
import type { VaultState } from '../vault/state';
import { generateTotp, type TotpCode } from '../vault/totp';
import {
  CipherType,
  type CipherDetail,
  type EditableItem,
  type FolderSummary,
  type ItemDraft,
  type PasswordHistoryEntry,
  type TrashItem,
} from '../vault/types';

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
  /** Whether the user turned on editing (Phase 2 writes ship behind this setting). */
  writesEnabled(): Promise<boolean>;
  /** Generator options and the encrypted history of generated passwords. */
  generator: {
    loadOptions(): Promise<StoredGeneratorOptions>;
    saveOptions(options: StoredGeneratorOptions): Promise<void>;
    loadHistory(): Promise<string[]>;
    saveHistory(entries: string[]): Promise<void>;
    clearHistory(): Promise<void>;
  };
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
    await this.deps.generator.clearHistory();
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

  // --- Writes (Phase 2) -------------------------------------------------------------------
  // Every write goes to the server first; local state changes only from the server's answer,
  // applied to the encrypted cache and decrypted again, so the cache and the view never drift.

  /** Unlocked, with editing turned on: the API client, account, and user key for a write. */
  private async writer(): Promise<{ api: ApiClient; account: Account; userKey: SymmetricKey }> {
    await this.ready;
    const account = this.vault.currentAccount;
    const userKey = this.vault.key;
    if (!account || !userKey) throw new CodedError('Vibepass is locked', 'locked');
    if (!(await this.deps.writesEnabled())) {
      throw new CodedError('Turn on editing in Settings to change your vault', 'writes-off');
    }
    // A sync in flight would replace the view with a copy from before this write.
    await this.syncing?.catch(() => undefined);
    return { api: await this.authedApi(account, userKey), account, userKey };
  }

  /** Apply a change to the cached sync response, then show the result. */
  private async applyChange(
    account: Account,
    change: (sync: SyncResponse) => SyncResponse,
  ): Promise<void> {
    const cached = await this.deps.cache.read(account.userId);
    if (!cached) {
      await this.runSync(true);
      return;
    }
    const next = change(cached);
    await this.deps.cache.write(account.userId, next);
    await this.showVault(next);
    this.notify();
  }

  private applyCipher(account: Account, cipher: CipherResponse): Promise<void> {
    return this.applyChange(account, (sync) => {
      const index = sync.ciphers.findIndex((c) => c.id === cipher.id);
      const ciphers = [...sync.ciphers];
      if (index >= 0) ciphers[index] = { ...ciphers[index], ...cipher };
      else ciphers.push(cipher);
      return { ...sync, ciphers };
    });
  }

  /** An item, decrypted for the editor. Asks for the master password on re-prompt items. */
  async editable(id: string, masterPassword?: string): Promise<EditableItem> {
    const item = await this.decryptItem(id, { masterPassword });
    if (!item.canEdit) throw new Error('You can’t edit this item');
    if (item.deletedDate) throw new Error('Restore this item before editing it');
    return {
      id: item.id,
      revisionDate: item.revisionDate,
      organization: item.organizationId
        ? (this.vault.organizations.find((o) => o.id === item.organizationId)?.name ?? null)
        : null,
      draft: toDraft(item),
    };
  }

  /**
   * Save an item: create it when `id` is null, otherwise update it. `revisionDate` is the copy
   * the editor started from; if the server or a sync has a newer one, this throws a conflict
   * unless `overwrite` is set, in which case it syncs and saves over the newest copy.
   */
  async saveItem(
    request: {
      id: string | null;
      draft: ItemDraft;
      revisionDate?: string | undefined;
      overwrite?: boolean | undefined;
    },
    passkey?: PasskeyChange,
  ): Promise<string> {
    const { api, account, userKey } = await this.writer();
    if (request.overwrite) await this.runSync(true);
    const base = request.id ? this.vault.raw(request.id) : null;
    if (request.id && !base) throw new Error('That item is no longer in your vault');
    if (base && !request.overwrite && request.revisionDate !== base.revisionDate) {
      throw new ConflictError();
    }
    const ownerKey = base ? ownerKeyFor(base, userKey, this.vault.orgKeys) : userKey;
    if (!ownerKey) throw new Error('This item belongs to an organization you can no longer read');
    const previous = base ? await decryptCipher(base, ownerKey) : null;
    if (previous && !previous.canEdit) throw new Error('You can’t edit this item');
    if (
      request.draft.folderId &&
      !this.vault.folders.some((f) => f.id === request.draft.folderId)
    ) {
      throw new Error('That folder no longer exists');
    }
    const body = await encryptDraft(
      request.draft,
      base,
      previous,
      { ownerKey, userId: account.userId, now: new Date(this.deps.now()) },
      passkey,
    );
    const saved =
      base && request.id ? await api.updateCipher(request.id, body) : await api.createCipher(body);
    await this.applyCipher(account, saved);
    return saved.id;
  }

  /**
   * A login's username and password, for the worker's own comparisons (is this submitted login
   * already saved?). Never returned to a page or the popup.
   */
  async credentials(id: string): Promise<{ username: string | null; password: string | null }> {
    const item = await this.decryptItem(id, null);
    return { username: item.login?.username ?? null, password: item.login?.password ?? null };
  }

  // --- Passkeys -----------------------------------------------------------------------------

  /** Logins in the vault (not the trash) that hold passkeys, decrypted. Worker use only. */
  async passkeyLogins(): Promise<DecryptedCipher[]> {
    await this.ready;
    const out: DecryptedCipher[] = [];
    for (const summary of this.vault.items) {
      if (summary.type !== CipherType.Login) continue;
      const raw = this.vault.raw(summary.id);
      if (!raw?.login?.fido2Credentials?.length || raw.deletedDate) continue;
      out.push(await this.decryptItem(summary.id, null));
    }
    return out;
  }

  /** One login, decrypted, for signing with its passkey. Asks for re-prompt like a fill. */
  passkeyLogin(id: string, masterPassword?: string): Promise<DecryptedCipher> {
    return this.decryptItem(id, { masterPassword });
  }

  /**
   * Save a new passkey: onto an existing login when `id` is set, else as a new login named for
   * the site. Needs editing turned on, like every write.
   */
  async savePasskey(id: string | null, passkey: StoredPasskey): Promise<string> {
    if (id) {
      const item = await this.decryptItem(id, null);
      if (!item.login) throw new Error('Passkeys can only be saved on logins');
      const draft = toDraft(item);
      if (draft.login && !draft.login.username && passkey.userName) {
        draft.login.username = passkey.userName;
      }
      return this.saveItem({ id, draft, revisionDate: item.revisionDate }, { add: passkey });
    }
    const draft = newDraft(CipherType.Login);
    draft.name = passkey.rpName || passkey.rpId;
    if (draft.login) {
      draft.login.username = passkey.userName ?? '';
      draft.login.uris = [{ uri: `https://${passkey.rpId}`, match: null }];
    }
    return this.saveItem({ id: null, draft }, { add: passkey });
  }

  /** Store a passkey's new signature counter. */
  async savePasskeyCounter(id: string, credentialId: string, value: number): Promise<void> {
    const item = await this.decryptItem(id, null);
    await this.saveItem(
      { id, draft: toDraft(item), revisionDate: item.revisionDate },
      { counter: { credentialId, value } },
    );
  }

  /** Change only a login's password (from the update banner), keeping the old one in history. */
  async updatePassword(id: string, password: string): Promise<void> {
    const item = await this.decryptItem(id, null);
    if (!item.login) throw new Error('Only logins have a password to update');
    const draft = toDraft(item);
    if (draft.login) draft.login.password = password;
    await this.saveItem({ id, draft, revisionDate: item.revisionDate });
  }

  /** Favorite or move an item without re-encrypting it. */
  async organize(
    id: string,
    patch: { favorite?: boolean | undefined; folderId?: string | null | undefined },
  ): Promise<void> {
    const { api, account } = await this.writer();
    const raw = this.vault.raw(id);
    if (!raw) throw new Error('That item is no longer in your vault');
    const folderId = patch.folderId === undefined ? raw.folderId : patch.folderId;
    if (folderId && !this.vault.folders.some((f) => f.id === folderId)) {
      throw new Error('That folder no longer exists');
    }
    const saved = await api.updateCipherPartial(id, {
      folderId,
      favorite: patch.favorite ?? raw.favorite,
    });
    // Some servers answer the partial update with a thin copy; keep what it leaves out.
    await this.applyCipher(account, { ...raw, ...saved, folderId, favorite: saved.favorite });
  }

  /** Move an item to the trash; it can be restored from there. */
  async trashItem(id: string): Promise<void> {
    const { api, account } = await this.writer();
    const raw = this.vault.raw(id);
    if (!raw) throw new Error('That item is no longer in your vault');
    if (raw.edit === false) throw new Error('You can’t delete this item');
    await api.softDeleteCipher(id);
    await this.applyCipher(account, {
      ...raw,
      deletedDate: new Date(this.deps.now()).toISOString(),
    });
  }

  async restoreItem(id: string): Promise<void> {
    const { api, account } = await this.writer();
    const raw = this.vault.raw(id);
    if (!raw) throw new Error('That item is no longer in your vault');
    const restored = await api.restoreCipher(id);
    await this.applyCipher(account, { ...raw, ...restored, deletedDate: null });
  }

  /** Delete an item for good. Only from the trash, so one click can't lose an item. */
  async deleteItem(id: string): Promise<void> {
    const { api, account } = await this.writer();
    const raw = this.vault.raw(id);
    if (!raw) throw new Error('That item is no longer in your vault');
    if (!raw.deletedDate) throw new Error('Move the item to the trash first');
    await api.deleteCipher(id);
    await this.applyChange(account, (sync) => ({
      ...sync,
      ciphers: sync.ciphers.filter((c) => c.id !== id),
    }));
  }

  trash(): readonly TrashItem[] {
    return this.vault.trash;
  }

  folders(): readonly FolderSummary[] {
    return this.vault.folders;
  }

  async createFolder(name: string): Promise<FolderSummary> {
    const { api, account, userKey } = await this.writer();
    const clean = folderName(name);
    const folder = await api.createFolder({ name: await encryptString(clean, userKey) });
    await this.applyChange(account, (sync) => ({ ...sync, folders: [...sync.folders, folder] }));
    return { id: folder.id, name: clean };
  }

  async renameFolder(id: string, name: string): Promise<void> {
    const { api, account, userKey } = await this.writer();
    if (!this.vault.folders.some((f) => f.id === id)) throw new Error('That folder is gone');
    const folder = await api.updateFolder(id, {
      name: await encryptString(folderName(name), userKey),
    });
    await this.applyChange(account, (sync) => ({
      ...sync,
      folders: sync.folders.map((f) => (f.id === id ? { ...f, ...folder } : f)),
    }));
  }

  /** Delete a folder. Its items stay in the vault, with no folder. */
  async deleteFolder(id: string): Promise<void> {
    const { api, account } = await this.writer();
    await api.deleteFolder(id);
    await this.applyChange(account, (sync) => ({
      ...sync,
      folders: sync.folders.filter((f) => f.id !== id),
      ciphers: sync.ciphers.map((c) => (c.folderId === id ? { ...c, folderId: null } : c)),
    }));
  }

  // --- Generator --------------------------------------------------------------------------

  generatorOptions(): Promise<StoredGeneratorOptions> {
    return this.deps.generator.loadOptions();
  }

  /**
   * Generate a password with the given options (remembered as the last used), or the last used
   * ones, or a site's `passwordrules`. Every result goes into the encrypted history first, so
   * a save that fails later never loses it.
   */
  async generatePassword(
    request: { options?: StoredGeneratorOptions | undefined; rules?: string | null } = {},
  ): Promise<string> {
    await this.ready;
    const userKey = this.vault.key;
    if (!userKey) throw new CodedError('Vibepass is locked', 'locked');
    if (request.options) await this.deps.generator.saveOptions(request.options);
    const stored = request.options ?? (await this.deps.generator.loadOptions());
    const password =
      request.rules === undefined
        ? await generate(activeOptions(stored))
        : await generateForRules(request.rules, activeOptions(stored));
    const entry = JSON.stringify({
      password,
      lastUsedDate: new Date(this.deps.now()).toISOString(),
    });
    const history = await this.deps.generator.loadHistory();
    await this.deps.generator.saveHistory(
      [await encryptString(entry, userKey), ...history].slice(0, HISTORY_LIMIT),
    );
    return password;
  }

  /** Generated passwords, newest first. Entries we can't read (another account) are skipped. */
  async generatorHistory(): Promise<PasswordHistoryEntry[]> {
    await this.ready;
    const userKey = this.vault.key;
    if (!userKey) throw new CodedError('Vibepass is locked', 'locked');
    const entries: PasswordHistoryEntry[] = [];
    for (const enc of await this.deps.generator.loadHistory()) {
      try {
        const value = JSON.parse(await decryptString(enc, userKey)) as PasswordHistoryEntry;
        if (typeof value.password === 'string') entries.push(value);
      } catch {
        // Skip it.
      }
    }
    return entries;
  }

  async clearGeneratorHistory(): Promise<void> {
    await this.deps.generator.clearHistory();
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

/** Folder names are short labels; Bitwarden nests folders with "/" in the name. */
function folderName(name: string): string {
  const clean = name.trim();
  if (!clean) throw new Error('Give the folder a name');
  if (clean.length > 200) throw new Error('That folder name is too long');
  return clean;
}

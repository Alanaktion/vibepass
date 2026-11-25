/**
 * Wire types for the Bitwarden server API, as used by self-hosted Bitwarden and Vaultwarden.
 * Only the fields the extension needs are listed; servers send many more. Field names follow
 * the server's casing, which differs between endpoints (identity responses are PascalCase).
 */
import type { KdfType } from '../crypto/types';
import type { CipherType } from '../vault/types';

/** POST /identity/accounts/prelogin */
export interface PreloginResponse {
  kdf: KdfType;
  kdfIterations: number;
  kdfMemory?: number | null;
  kdfParallelism?: number | null;
  /** Newer servers send an explicit salt; null means "use the email". */
  salt?: string | null;
}

/** Device fields sent with every token request. */
export interface DeviceInfo {
  identifier: string;
  name: string;
  /** Bitwarden DeviceType: 2 = Chrome extension, 3 = Firefox extension. */
  type: number;
}

/** POST /identity/connect/token (password grant) */
export interface PasswordTokenRequest {
  email: string;
  /** Base64 master password hash, never the password itself. */
  masterPasswordHash: string;
  device: DeviceInfo;
}

export interface MasterPasswordUnlockData {
  Kdf: { KdfType: KdfType; Iterations: number; Memory: number | null; Parallelism: number | null };
  MasterKeyEncryptedUserKey: string;
  Salt: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: 'Bearer';
  /** Protected user key (EncString). Present on password grants, not refreshes. */
  Key?: string;
  /** Protected RSA private key (EncString). */
  PrivateKey?: string | null;
  Kdf?: KdfType;
  KdfIterations?: number;
  KdfMemory?: number | null;
  KdfParallelism?: number | null;
  UserDecryptionOptions?: { MasterPasswordUnlock?: MasterPasswordUnlockData | null } | null;
}

/** Encrypted cipher as returned by /api/sync and /api/ciphers. String fields are EncStrings. */
export interface CipherResponse {
  id: string;
  organizationId: string | null;
  folderId: string | null;
  type: CipherType;
  /** Per-item key, wrapped with the user or organization key. Null on older items. */
  key?: string | null;
  name: string;
  notes: string | null;
  favorite: boolean;
  revisionDate: string;
  deletedDate: string | null;
  login?: {
    username: string | null;
    password: string | null;
    totp: string | null;
    uris: { uri: string | null; match: number | null }[] | null;
  } | null;
  card?: { brand: string | null; number: string | null } | null;
}

export interface FolderResponse {
  id: string;
  name: string;
  revisionDate: string;
}

/** GET /api/sync */
export interface SyncResponse {
  profile: {
    id: string;
    email: string;
    key: string;
    privateKey: string | null;
    organizations?: { id: string; key: string }[];
  };
  folders: FolderResponse[];
  ciphers: CipherResponse[];
  userDecryption?: {
    masterPasswordUnlock?: {
      kdf: {
        kdfType: KdfType;
        iterations: number;
        memory: number | null;
        parallelism: number | null;
      };
      masterKeyEncryptedUserKey: string;
      salt: string;
    } | null;
  } | null;
}

export interface ServerConfig {
  /** Base URL of the self-hosted server, e.g. https://vault.example.com */
  baseUrl: string;
}

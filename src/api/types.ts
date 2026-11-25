/**
 * Wire types for the Bitwarden server API, as used by self-hosted Bitwarden and Vaultwarden.
 * Only the fields the extension needs are listed; servers send many more. Field names follow
 * the server's casing, which differs between endpoints.
 */
import type { KdfType } from '../crypto/types';
import type { CipherType } from '../vault/types';

/** POST /identity/accounts/prelogin */
export interface PreloginResponse {
  kdf: KdfType;
  kdfIterations: number;
  kdfMemory?: number | null;
  kdfParallelism?: number | null;
}

/** POST /identity/connect/token (password grant) */
export interface TokenRequest {
  email: string;
  /** Base64 master password hash, never the password itself. */
  masterPasswordHash: string;
  deviceIdentifier: string;
  deviceName: string;
  deviceType: number;
  twoFactor?: { provider: number; token: string; remember: boolean };
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: 'Bearer';
  /** Protected user key (EncString). */
  Key: string;
  /** Protected RSA private key (EncString). */
  PrivateKey: string | null;
  Kdf: KdfType;
  KdfIterations: number;
}

/** Returned with HTTP 400 when the account needs a second factor. */
export interface TwoFactorChallenge {
  TwoFactorProviders: number[];
  TwoFactorProviders2: Record<string, unknown>;
}

/** Encrypted cipher as returned by /api/sync and /api/ciphers. String fields are EncStrings. */
export interface CipherResponse {
  id: string;
  organizationId: string | null;
  folderId: string | null;
  type: CipherType;
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
}

export interface FolderResponse {
  id: string;
  name: string;
  revisionDate: string;
}

/** GET /api/sync */
export interface SyncResponse {
  profile: { id: string; email: string; key: string; privateKey: string | null };
  folders: FolderResponse[];
  ciphers: CipherResponse[];
}

export interface ServerConfig {
  /** Base URL of the self-hosted server, e.g. https://vault.example.com */
  baseUrl: string;
}

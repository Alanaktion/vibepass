/**
 * Wire types for the Bitwarden server API, as used by self-hosted Bitwarden and Vaultwarden.
 * Only the fields the extension needs are listed; servers send many more. Field names follow
 * the server's casing, which differs between endpoints (identity responses are PascalCase).
 */
import type { KdfType } from '../crypto/types';
import type { CipherType, FieldType, UriMatch } from '../vault/types';

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
  challenge?: LoginChallenge;
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
  /** "Remember me" token for two-step login, when the request asked for one. */
  TwoFactorToken?: string | null;
}

/** Bitwarden two-step login providers (TwoFactorProviderType). */
export enum TwoFactorProvider {
  Authenticator = 0,
  Email = 1,
  Duo = 2,
  YubiKey = 3,
  U2f = 4,
  Remember = 5,
  OrganizationDuo = 6,
  WebAuthn = 7,
  RecoveryCode = 8,
}

/** A second step for the token request: a two-step login code or a new-device code. */
export interface LoginChallenge {
  twoFactor?: { provider: TwoFactorProvider; token: string; remember: boolean };
  newDeviceOtp?: string;
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
  /** 1 = ask for the master password again before showing or filling secrets. */
  reprompt?: number;
  /** False when an organization hides passwords from this user (fill still works). */
  viewPassword?: boolean;
  edit?: boolean;
  collectionIds?: string[] | null;
  login?: {
    username: string | null;
    password: string | null;
    totp: string | null;
    uris: { uri: string | null; match: UriMatch | null }[] | null;
    /** Passkeys saved on this login. */
    fido2Credentials?: Fido2CredentialResponse[] | null;
  } | null;
  card?: {
    cardholderName?: string | null;
    brand: string | null;
    number: string | null;
    expMonth?: string | null;
    expYear?: string | null;
    code?: string | null;
  } | null;
  identity?: Partial<Record<IdentityField, string | null>> | null;
  sshKey?: {
    privateKey: string | null;
    publicKey: string | null;
    keyFingerprint: string | null;
  } | null;
  fields?:
    | { name: string | null; value: string | null; type: FieldType; linkedId?: number | null }[]
    | null;
  attachments?: AttachmentResponse[] | null;
  /** Old passwords (EncStrings), newest first. */
  passwordHistory?: { password: string; lastUsedDate: string }[] | null;
}

/** A passkey on a login. Every field but creationDate is an EncString (counter and
 * discoverable too, as "0" and "true"). */
export interface Fido2CredentialResponse {
  credentialId: string;
  keyType: string;
  keyAlgorithm: string;
  keyCurve: string;
  keyValue: string;
  rpId: string;
  userHandle: string | null;
  userName: string | null;
  counter: string;
  rpName: string | null;
  userDisplayName: string | null;
  discoverable: string;
  creationDate: string;
}

export type IdentityField =
  | 'title'
  | 'firstName'
  | 'middleName'
  | 'lastName'
  | 'address1'
  | 'address2'
  | 'address3'
  | 'city'
  | 'state'
  | 'postalCode'
  | 'country'
  | 'company'
  | 'email'
  | 'phone'
  | 'ssn'
  | 'username'
  | 'passportNumber'
  | 'licenseNumber';

export interface AttachmentResponse {
  id: string;
  /** EncString, encrypted with the cipher key. */
  fileName: string | null;
  /** Attachment key wrapped with the cipher key; null on very old attachments. */
  key: string | null;
  size: string | number | null;
  sizeName: string | null;
  url?: string | null;
}

export interface CollectionResponse {
  id: string;
  organizationId: string;
  /** EncString, encrypted with the organization key. */
  name: string;
  readOnly?: boolean;
  hidePasswords?: boolean;
}

export interface OrganizationResponse {
  id: string;
  name: string;
  /** Organization key, RSA-encrypted to the account's public key. */
  key: string;
  enabled?: boolean;
}

/** POST and PUT /api/folders */
export interface FolderRequest {
  /** EncString, encrypted with the user key. */
  name: string;
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
    /** Newer servers also nest the wrapped private key here. */
    accountKeys?: {
      publicKeyEncryptionKeyPair?: { wrappedPrivateKey?: string | null } | null;
    } | null;
    organizations?: OrganizationResponse[];
  };
  domains?: {
    equivalentDomains?: string[][] | null;
    globalEquivalentDomains?: { domains: string[]; excluded?: boolean }[] | null;
  } | null;
  folders: FolderResponse[];
  collections?: CollectionResponse[] | null;
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

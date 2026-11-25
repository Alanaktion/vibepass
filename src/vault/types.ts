/**
 * Decrypted, UI-facing view models. These live only in background memory and are cleared on lock.
 * Server wire types live in src/api/types.ts.
 */

export enum CipherType {
  Login = 1,
  SecureNote = 2,
  Card = 3,
  Identity = 4,
  SshKey = 5,
}

/** Lightweight row for search results and lists. Never includes secrets. */
export interface CipherSummary {
  id: string;
  type: CipherType;
  name: string;
  /** Username for logins, brand/last4 for cards, etc. */
  subtitle: string | null;
  uris: string[];
  favorite: boolean;
  folderId: string | null;
}

export interface FolderSummary {
  id: string;
  name: string;
}

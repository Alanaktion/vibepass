import type { CipherResponse, SyncResponse } from '../api/types';
import { decryptString, unwrapKey, type SymmetricKey } from '../crypto';
import { CipherType, type CipherSummary, type FolderSummary } from './types';

export interface DecryptedVault {
  items: CipherSummary[];
  folders: FolderSummary[];
  /** Items we could not decrypt, or skipped (organization items until Phase 1). */
  skipped: number;
}

/**
 * Decrypt just enough of each cipher to list and search it: name, username, and URIs.
 * Passwords, TOTP seeds, and notes stay encrypted until the user asks for that one item.
 */
export async function decryptVault(
  sync: SyncResponse,
  userKey: SymmetricKey,
): Promise<DecryptedVault> {
  const items: CipherSummary[] = [];
  let skipped = 0;
  for (const cipher of sync.ciphers) {
    if (cipher.deletedDate) continue;
    // Organization items need the org key, which arrives with read-only org support (Phase 1).
    if (cipher.organizationId) {
      skipped++;
      continue;
    }
    try {
      items.push(await decryptSummary(cipher, userKey));
    } catch {
      skipped++;
    }
  }
  const folders: FolderSummary[] = [];
  for (const folder of sync.folders) {
    try {
      folders.push({ id: folder.id, name: await decryptString(folder.name, userKey) });
    } catch {
      // A folder we can't read just doesn't show; its items still do.
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  folders.sort((a, b) => a.name.localeCompare(b.name));
  return { items, folders, skipped };
}

/** The key that encrypts a cipher's fields: its own key if it has one, else the owner's key. */
export async function cipherKey(
  cipher: CipherResponse,
  ownerKey: SymmetricKey,
): Promise<SymmetricKey> {
  return cipher.key ? unwrapKey(cipher.key, ownerKey) : ownerKey;
}

async function decryptSummary(
  cipher: CipherResponse,
  ownerKey: SymmetricKey,
): Promise<CipherSummary> {
  const key = await cipherKey(cipher, ownerKey);
  const maybe = async (value: string | null | undefined) =>
    value ? decryptString(value, key) : null;

  let subtitle: string | null = null;
  const uris: string[] = [];
  if (cipher.type === CipherType.Login && cipher.login) {
    subtitle = await maybe(cipher.login.username);
    for (const entry of cipher.login.uris ?? []) {
      const uri = await maybe(entry.uri);
      if (uri) uris.push(uri);
    }
  } else if (cipher.type === CipherType.Card && cipher.card) {
    const brand = await maybe(cipher.card.brand);
    const number = await maybe(cipher.card.number);
    const last4 = number ? `•••• ${number.slice(-4)}` : null;
    subtitle = [brand, last4].filter(Boolean).join(' ') || null;
  }

  return {
    id: cipher.id,
    type: cipher.type,
    name: await decryptString(cipher.name, key),
    subtitle,
    uris,
    favorite: cipher.favorite,
    folderId: cipher.folderId,
  };
}

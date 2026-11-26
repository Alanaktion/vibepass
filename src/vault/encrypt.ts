/**
 * The encrypt path: turn an edited item back into the server's cipher format.
 *
 * Saving starts from the server's own copy of the cipher, so every field Vibepass does not edit
 * (passkeys, attachments, SSH keys, and fields added by newer clients) is sent
 * back exactly as it came. Only the fields in an ItemDraft are re-encrypted. Round trips with
 * the official clients' code are checked in tests/encrypt.test.ts.
 */
import type { CipherResponse } from '../api/types';
import {
  encryptString,
  makeCipherKey,
  toBase64,
  unwrapKey,
  wrapKey,
  type EncString,
  type SymmetricKey,
} from '../crypto';
import type { DecryptedCipher } from './decrypt';
import type { StoredPasskey } from './passkey';
import { IDENTITY_FIELDS, emptyCard } from './draft';
import { CipherType, FieldType, type IdentityDraft, type ItemDraft } from './types';

/** The body of POST /api/ciphers and PUT /api/ciphers/{id}. Loosely typed on purpose. */
export type CipherRequest = Record<string, unknown>;

/** The official clients keep this many old passwords per item. */
export const PASSWORD_HISTORY_LIMIT = 5;

/** Fields only the server sets. They are dropped from the request; the rest passes through. */
const SERVER_ONLY = [
  'object',
  'id',
  'revisionDate',
  'creationDate',
  'deletedDate',
  'archivedDate',
  'permissions',
  'edit',
  'viewPassword',
  'organizationUseTotp',
  'collectionIds',
] as const;

export class UnsupportedCipherError extends Error {
  constructor() {
    super('This item was saved in a newer format that Vibepass can’t edit yet');
    this.name = 'UnsupportedCipherError';
  }
}

export interface EncryptContext {
  /** The user key, or the organization key for an organization item. */
  ownerKey: SymmetricKey;
  /** The account the item is encrypted for (servers check this). */
  userId: string;
  now: Date;
}

/**
 * A passkey change saved along with a draft: a new passkey to add to the login, or a new
 * signature counter for one it has. Other passkeys pass through untouched.
 */
export type PasskeyChange =
  { add: StoredPasskey } | { counter: { credentialId: string; value: number } };

/** True when Vibepass can safely re-encrypt this cipher (field-level format, not a sealed blob). */
export function canEncrypt(cipher: CipherResponse): boolean {
  const raw = cipher as unknown as Record<string, unknown>;
  return typeof cipher.name === 'string' && cipher.name !== '' && raw.data == null;
}

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toBase64(new Uint8Array(digest));
}

/**
 * Encrypt a draft into a cipher request. `base` and `previous` are the server copy and its
 * decrypted form when updating an item, and null when creating one.
 */
export async function encryptDraft(
  draft: ItemDraft,
  base: CipherResponse | null,
  previous: DecryptedCipher | null,
  context: EncryptContext,
  passkey?: PasskeyChange,
): Promise<CipherRequest> {
  if (base && !canEncrypt(base)) throw new UnsupportedCipherError();
  const request: CipherRequest = base
    ? (structuredClone(base) as unknown as CipherRequest)
    : { organizationId: null };
  for (const key of SERVER_ONLY) Reflect.deleteProperty(request, key);

  // Existing items keep their key (attachments are wrapped with it); new items get their own,
  // as the official clients do.
  let itemKey: SymmetricKey;
  let fresh: SymmetricKey | null = null;
  if (base?.key) itemKey = await unwrapKey(base.key, context.ownerKey);
  else if (base) itemKey = context.ownerKey;
  else {
    fresh = await makeCipherKey();
    itemKey = fresh;
    request.key = await wrapKey(fresh, context.ownerKey);
  }

  try {
    const enc = async (value: string | null | undefined): Promise<EncString | null> =>
      value ? encryptString(value, itemKey) : null;
    const type = base?.type ?? draft.type;
    const now = context.now.toISOString();

    request.type = type;
    request.name = await enc(draft.name.trim() || 'Untitled');
    request.notes = await enc(draft.notes);
    request.favorite = draft.favorite;
    request.folderId = draft.folderId;
    request.reprompt = draft.reprompt ? 1 : 0;

    if (type === CipherType.Login) {
      const login = draft.login ?? { username: '', password: '', totp: '', uris: [] };
      const old = (base?.login ?? {}) as Record<string, unknown>;
      const uris = [];
      for (const entry of login.uris) {
        const uri = entry.uri.trim();
        if (!uri) continue;
        uris.push({
          uri: await enc(uri),
          uriChecksum: await enc(await sha256Base64(uri)),
          match: entry.match,
        });
      }
      const oldPassword = previous?.login?.password ?? null;
      const changed = Boolean(oldPassword) && oldPassword !== login.password;
      request.login = {
        ...old,
        username: await enc(login.username),
        password: await enc(login.password),
        totp: await enc(login.totp.trim()),
        uris,
        // Older clients read the first website from here.
        uri: uris[0]?.uri ?? null,
        passwordRevisionDate: changed ? now : (old.passwordRevisionDate ?? null),
      };
      if (passkey) {
        const stored = Array.isArray(old.fido2Credentials)
          ? (old.fido2Credentials as Record<string, unknown>[])
          : [];
        if ('add' in passkey) {
          (request.login as Record<string, unknown>).fido2Credentials = [
            ...stored,
            await encryptPasskey(passkey.add, enc),
          ];
        } else {
          const index = (previous?.login?.passkeys ?? []).findIndex(
            (p) => p.credentialId === passkey.counter.credentialId,
          );
          const entry = stored[index];
          if (!entry) throw new Error('That passkey is no longer on this item');
          const next = [...stored];
          next[index] = { ...entry, counter: await enc(String(passkey.counter.value)) };
          (request.login as Record<string, unknown>).fido2Credentials = next;
        }
      }
      if (changed && oldPassword) {
        const history = Array.isArray(base?.passwordHistory) ? base.passwordHistory : [];
        request.passwordHistory = [
          { password: await enc(oldPassword), lastUsedDate: now },
          ...history,
        ].slice(0, PASSWORD_HISTORY_LIMIT);
      }
    } else if (type === CipherType.Card && draft.card) {
      const card = draft.card;
      const old = (base?.card ?? {}) as Record<string, unknown>;
      request.card = {
        ...old,
        cardholderName: await enc(card.cardholderName),
        brand: await enc(card.brand),
        number: await enc(card.number),
        expMonth: await enc(card.expMonth),
        expYear: await enc(card.expYear),
        code: await enc(card.code),
      };
    } else if (type === CipherType.Identity && draft.identity) {
      const identity: Record<string, unknown> = { ...(base?.identity ?? {}) };
      for (const field of IDENTITY_FIELDS) identity[field] = await enc(draft.identity[field]);
      request.identity = identity;
    } else if (type === CipherType.SecureNote && !base) {
      request.secureNote = { type: 0 };
    }

    const fields = [];
    for (const field of draft.fields) {
      if (!field.name.trim() && !field.value) continue;
      fields.push({
        name: await enc(field.name),
        value: field.type === FieldType.Linked ? null : await enc(field.value),
        type: field.type,
        linkedId: field.type === FieldType.Linked ? field.linkedId : null,
      });
    }
    request.fields = fields;

    // Servers take attachments as maps on writes; the official clients send both forms.
    const attachments = base?.attachments ?? [];
    if (attachments.length > 0) {
      request.attachments = Object.fromEntries(attachments.map((a) => [a.id, a.fileName]));
      request.attachments2 = Object.fromEntries(
        attachments.map((a) => [a.id, { fileName: a.fileName, key: a.key }]),
      );
    } else {
      Reflect.deleteProperty(request, 'attachments');
    }

    if (base) request.lastKnownRevisionDate = base.revisionDate;
    request.encryptedFor = context.userId;
    return request;
  } finally {
    if (base?.key) itemKey.fill(0);
    fresh?.fill(0);
  }
}

/** A passkey in the server's format; every field but the creation date is encrypted. */
async function encryptPasskey(
  passkey: StoredPasskey,
  enc: (value: string | null | undefined) => Promise<EncString | null>,
): Promise<Record<string, unknown>> {
  return {
    credentialId: await enc(passkey.credentialId),
    keyType: await enc(passkey.keyType),
    keyAlgorithm: await enc(passkey.keyAlgorithm),
    keyCurve: await enc(passkey.keyCurve),
    keyValue: await enc(passkey.keyValue),
    rpId: await enc(passkey.rpId),
    userHandle: await enc(passkey.userHandle),
    userName: await enc(passkey.userName),
    counter: await enc(String(passkey.counter)),
    rpName: await enc(passkey.rpName),
    userDisplayName: await enc(passkey.userDisplayName),
    discoverable: await enc(String(passkey.discoverable)),
    creationDate: passkey.creationDate,
  };
}

/** The decrypted item as a draft, for the editor. */
export function toDraft(item: DecryptedCipher): ItemDraft {
  return {
    type: item.type,
    name: item.name,
    notes: item.notes ?? '',
    favorite: item.favorite,
    folderId: item.folderId,
    reprompt: item.reprompt,
    login: item.login
      ? {
          username: item.login.username ?? '',
          password: item.login.password ?? '',
          totp: item.login.totp ?? '',
          uris: item.login.uris,
        }
      : item.type === CipherType.Login
        ? { username: '', password: '', totp: '', uris: [] }
        : null,
    card: item.card
      ? {
          cardholderName: item.card.cardholderName ?? '',
          brand: item.card.brand ?? '',
          number: item.card.number ?? '',
          expMonth: item.card.expMonth ?? '',
          expYear: item.card.expYear ?? '',
          code: item.card.code ?? '',
        }
      : item.type === CipherType.Card
        ? emptyCard()
        : null,
    identity:
      item.identity || item.type === CipherType.Identity
        ? (Object.fromEntries(
            IDENTITY_FIELDS.map((f) => [f, item.identity?.[f] ?? '']),
          ) as IdentityDraft)
        : null,
    fields: item.fields.map((f) => ({
      name: f.name,
      value: f.value ?? '',
      type: f.type,
      linkedId: f.linkedId,
    })),
  };
}

export { newDraft } from './draft';

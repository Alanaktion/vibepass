import type { CipherResponse, IdentityField, SyncResponse } from '../api/types';
import {
  decryptOrgKey,
  decryptString,
  unwrapKey,
  unwrapPrivateKey,
  type SymmetricKey,
} from '../crypto';
import { canEncrypt } from './encrypt';
import type { StoredPasskey } from './passkey';
import {
  CipherType,
  type AttachmentSummary,
  type CipherDetail,
  type CipherSummary,
  type CollectionSummary,
  type DetailField,
  type DetailSection,
  type FolderSummary,
  type LoginUri,
  FieldType,
  type OrganizationSummary,
  type TrashItem,
} from './types';

export interface DecryptedVault {
  items: CipherSummary[];
  folders: FolderSummary[];
  collections: CollectionSummary[];
  organizations: OrganizationSummary[];
  /** Decrypted notes, only to build the search index. Never sent to the popup in bulk. */
  notes: Map<string, string>;
  /** Organization keys, by organization id. Zeroed on lock. */
  orgKeys: Map<string, SymmetricKey>;
  /** The encrypted ciphers, by id, so one item can be fully decrypted on demand. */
  raw: Map<string, CipherResponse>;
  /** Items in the server's trash, newest first. Not searchable and never filled. */
  trash: TrashItem[];
  /** Items we could not decrypt (for example, an organization whose key we can't read). */
  skipped: number;
}

export const emptyVault = (): DecryptedVault => ({
  items: [],
  folders: [],
  collections: [],
  organizations: [],
  notes: new Map(),
  orgKeys: new Map(),
  raw: new Map(),
  trash: [],
  skipped: 0,
});

/** Decrypt the account's private key, then each organization key it unlocks. */
export async function decryptOrgKeys(
  sync: SyncResponse,
  userKey: SymmetricKey,
): Promise<Map<string, SymmetricKey>> {
  const keys = new Map<string, SymmetricKey>();
  const orgs = sync.profile.organizations ?? [];
  if (orgs.length === 0) return keys;
  const wrapped =
    sync.profile.accountKeys?.publicKeyEncryptionKeyPair?.wrappedPrivateKey ??
    sync.profile.privateKey;
  if (!wrapped) return keys;
  const privateKey = await unwrapPrivateKey(wrapped, userKey);
  try {
    for (const org of orgs) {
      if (org.enabled === false || !org.key) continue;
      try {
        keys.set(org.id, await decryptOrgKey(org.key, privateKey));
      } catch {
        // An organization key we can't read hides that organization's items, nothing more.
      }
    }
  } finally {
    privateKey.fill(0);
  }
  return keys;
}

/**
 * Decrypt just enough of each cipher to list and search it: name, username, URIs, and notes
 * (for the index only). Passwords, TOTP seeds, and other secrets stay encrypted until the user
 * acts on that one item.
 */
export async function decryptVault(
  sync: SyncResponse,
  userKey: SymmetricKey,
): Promise<DecryptedVault> {
  const vault = emptyVault();
  vault.orgKeys = await decryptOrgKeys(sync, userKey);

  for (const org of sync.profile.organizations ?? []) {
    if (vault.orgKeys.has(org.id)) vault.organizations.push({ id: org.id, name: org.name });
  }

  for (const cipher of sync.ciphers) {
    const ownerKey = ownerKeyFor(cipher, userKey, vault.orgKeys);
    if (!ownerKey) {
      vault.skipped++;
      continue;
    }
    try {
      const { summary, notes } = await decryptSummary(cipher, ownerKey);
      vault.raw.set(cipher.id, cipher);
      if (cipher.deletedDate) {
        vault.trash.push({ ...summary, deletedDate: cipher.deletedDate });
        continue;
      }
      vault.items.push(summary);
      if (notes) vault.notes.set(cipher.id, notes);
    } catch {
      vault.skipped++;
    }
  }

  for (const folder of sync.folders) {
    try {
      vault.folders.push({ id: folder.id, name: await decryptString(folder.name, userKey) });
    } catch {
      // A folder we can't read just doesn't show; its items still do.
    }
  }

  for (const collection of sync.collections ?? []) {
    const key = vault.orgKeys.get(collection.organizationId);
    if (!key) continue;
    try {
      vault.collections.push({
        id: collection.id,
        organizationId: collection.organizationId,
        name: await decryptString(collection.name, key),
      });
    } catch {
      // Same as folders.
    }
  }

  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  vault.items.sort(byName);
  vault.folders.sort(byName);
  vault.collections.sort(byName);
  vault.organizations.sort(byName);
  vault.trash.sort((a, b) => b.deletedDate.localeCompare(a.deletedDate));
  return vault;
}

export function ownerKeyFor(
  cipher: CipherResponse,
  userKey: SymmetricKey,
  orgKeys: ReadonlyMap<string, SymmetricKey>,
): SymmetricKey | null {
  return cipher.organizationId ? (orgKeys.get(cipher.organizationId) ?? null) : userKey;
}

/** The key that encrypts a cipher's fields: its own key if it has one, else the owner's key. */
export async function cipherKey(
  cipher: CipherResponse,
  ownerKey: SymmetricKey,
): Promise<SymmetricKey> {
  return cipher.key ? unwrapKey(cipher.key, ownerKey) : ownerKey;
}

type Decryptor = (value: string | null | undefined) => Promise<string | null>;

function decryptorFor(key: SymmetricKey): Decryptor {
  return async (value) => (value ? decryptString(value, key) : null);
}

async function decryptUris(cipher: CipherResponse, maybe: Decryptor): Promise<LoginUri[]> {
  const uris: LoginUri[] = [];
  for (const entry of cipher.login?.uris ?? []) {
    const uri = await maybe(entry.uri);
    if (uri) uris.push({ uri, match: entry.match ?? null });
  }
  return uris;
}

async function decryptPasskeys(cipher: CipherResponse, maybe: Decryptor): Promise<StoredPasskey[]> {
  const out: StoredPasskey[] = [];
  for (const entry of cipher.login?.fido2Credentials ?? []) {
    const text = async (value: string | null | undefined) => (await maybe(value)) ?? '';
    out.push({
      credentialId: await text(entry.credentialId),
      keyType: await text(entry.keyType),
      keyAlgorithm: await text(entry.keyAlgorithm),
      keyCurve: await text(entry.keyCurve),
      keyValue: await text(entry.keyValue),
      rpId: await text(entry.rpId),
      userHandle: await maybe(entry.userHandle),
      userName: await maybe(entry.userName),
      counter: Number.parseInt(await text(entry.counter), 10) || 0,
      rpName: await maybe(entry.rpName),
      userDisplayName: await maybe(entry.userDisplayName),
      discoverable: (await maybe(entry.discoverable)) === 'true',
      creationDate: entry.creationDate,
    });
  }
  return out;
}

async function decryptSummary(
  cipher: CipherResponse,
  ownerKey: SymmetricKey,
): Promise<{ summary: CipherSummary; notes: string | null }> {
  const key = await cipherKey(cipher, ownerKey);
  const maybe = decryptorFor(key);

  let subtitle: string | null = null;
  let uris: LoginUri[] = [];
  if (cipher.type === CipherType.Login && cipher.login) {
    subtitle = await maybe(cipher.login.username);
    uris = await decryptUris(cipher, maybe);
  } else if (cipher.type === CipherType.Card && cipher.card) {
    const brand = await maybe(cipher.card.brand);
    const number = await maybe(cipher.card.number);
    const last4 = number ? `•••• ${number.slice(-4)}` : null;
    subtitle = [brand, last4].filter(Boolean).join(' ') || null;
  } else if (cipher.type === CipherType.Identity && cipher.identity) {
    const first = await maybe(cipher.identity.firstName);
    const last = await maybe(cipher.identity.lastName);
    subtitle = [first, last].filter(Boolean).join(' ') || (await maybe(cipher.identity.email));
  } else if (cipher.type === CipherType.SshKey && cipher.sshKey) {
    subtitle = await maybe(cipher.sshKey.keyFingerprint);
  }

  return {
    summary: {
      id: cipher.id,
      type: cipher.type,
      name: (await decryptString(cipher.name, key)) || 'Untitled',
      subtitle,
      uris,
      favorite: cipher.favorite,
      folderId: cipher.folderId,
      organizationId: cipher.organizationId,
      collectionIds: cipher.collectionIds ?? [],
      hasTotp: Boolean(cipher.login?.totp),
      reprompt: cipher.reprompt === 1,
    },
    notes: await maybe(cipher.notes),
  };
}

/** One cipher, fully decrypted. Lives only for the duration of one request in the worker. */
export interface DecryptedCipher {
  id: string;
  type: CipherType;
  name: string;
  notes: string | null;
  favorite: boolean;
  folderId: string | null;
  organizationId: string | null;
  collectionIds: string[];
  reprompt: boolean;
  viewPassword: boolean;
  /** The server lets this user change the item, and Vibepass can re-encrypt its format. */
  canEdit: boolean;
  revisionDate: string;
  deletedDate: string | null;
  login: {
    username: string | null;
    password: string | null;
    totp: string | null;
    uris: LoginUri[];
    /** Passkeys, in the server's order, private keys included. */
    passkeys: StoredPasskey[];
  } | null;
  card: {
    cardholderName: string | null;
    brand: string | null;
    number: string | null;
    expMonth: string | null;
    expYear: string | null;
    code: string | null;
  } | null;
  identity: Partial<Record<IdentityField, string | null>> | null;
  sshKey: {
    privateKey: string | null;
    publicKey: string | null;
    keyFingerprint: string | null;
  } | null;
  fields: { name: string; value: string | null; type: FieldType; linkedId: number | null }[];
  attachments: (AttachmentSummary & { key: string | null })[];
}

const IDENTITY_FIELDS: IdentityField[] = [
  'title',
  'firstName',
  'middleName',
  'lastName',
  'address1',
  'address2',
  'address3',
  'city',
  'state',
  'postalCode',
  'country',
  'company',
  'email',
  'phone',
  'ssn',
  'username',
  'passportNumber',
  'licenseNumber',
];

export async function decryptCipher(
  cipher: CipherResponse,
  ownerKey: SymmetricKey,
): Promise<DecryptedCipher> {
  const key = await cipherKey(cipher, ownerKey);
  const maybe = decryptorFor(key);

  let identity: DecryptedCipher['identity'] = null;
  if (cipher.identity) {
    identity = {};
    for (const field of IDENTITY_FIELDS) identity[field] = await maybe(cipher.identity[field]);
  }

  const fields: DecryptedCipher['fields'] = [];
  for (const field of cipher.fields ?? []) {
    fields.push({
      name: (await maybe(field.name)) ?? '',
      value: await maybe(field.value),
      type: field.type,
      linkedId: field.linkedId ?? null,
    });
  }

  const attachments: DecryptedCipher['attachments'] = [];
  for (const attachment of cipher.attachments ?? []) {
    attachments.push({
      id: attachment.id,
      fileName: (await maybe(attachment.fileName)) ?? 'attachment',
      sizeName: attachment.sizeName,
      key: attachment.key,
    });
  }

  return {
    id: cipher.id,
    type: cipher.type,
    name: (await decryptString(cipher.name, key)) || 'Untitled',
    notes: await maybe(cipher.notes),
    favorite: cipher.favorite,
    folderId: cipher.folderId,
    organizationId: cipher.organizationId,
    collectionIds: cipher.collectionIds ?? [],
    reprompt: cipher.reprompt === 1,
    viewPassword: cipher.viewPassword !== false,
    canEdit: cipher.edit !== false && canEncrypt(cipher),
    revisionDate: cipher.revisionDate,
    deletedDate: cipher.deletedDate ?? null,
    login: cipher.login
      ? {
          username: await maybe(cipher.login.username),
          password: await maybe(cipher.login.password),
          totp: await maybe(cipher.login.totp),
          uris: await decryptUris(cipher, maybe),
          passkeys: await decryptPasskeys(cipher, maybe),
        }
      : null,
    card: cipher.card
      ? {
          cardholderName: await maybe(cipher.card.cardholderName),
          brand: await maybe(cipher.card.brand),
          number: await maybe(cipher.card.number),
          expMonth: await maybe(cipher.card.expMonth),
          expYear: await maybe(cipher.card.expYear),
          code: await maybe(cipher.card.code),
        }
      : null,
    identity,
    sshKey: cipher.sshKey
      ? {
          privateKey: await maybe(cipher.sshKey.privateKey),
          publicKey: await maybe(cipher.sshKey.publicKey),
          keyFingerprint: await maybe(cipher.sshKey.keyFingerprint),
        }
      : null,
    fields,
    attachments,
  };
}

const LINKED_LABELS: Record<number, string> = { 100: 'username', 101: 'password' };

function field(
  id: string,
  label: string,
  value: string | null,
  kind: DetailField['kind'] = 'text',
  canReveal = true,
): DetailField | null {
  if (value === null || value === '') return null;
  const concealed = kind === 'concealed' || kind === 'totp';
  return { id, label, kind, value: concealed ? null : value, canReveal };
}

function section(title: string | null, fields: (DetailField | null)[]): DetailSection | null {
  const present = fields.filter((f): f is DetailField => f !== null);
  return present.length > 0 ? { title, fields: present } : null;
}

/** Build the item view: every field labeled, concealed values left out. */
export function toDetail(
  item: DecryptedCipher,
  names: {
    folders: readonly FolderSummary[];
    organizations: readonly OrganizationSummary[];
    collections: readonly CollectionSummary[];
  },
): CipherDetail {
  const sections: (DetailSection | null)[] = [];
  const login = item.login;
  if (login) {
    sections.push(
      section(null, [
        field('login.username', 'Username', login.username),
        field('login.password', 'Password', login.password, 'concealed', item.viewPassword),
        field('login.totp', 'One-time password', login.totp, 'totp'),
        ...login.passkeys.map((passkey, i) =>
          field(`login.passkey.${String(i)}`, 'Passkey', `Saved for ${passkey.rpId}`),
        ),
      ]),
    );
  }
  const card = item.card;
  if (card) {
    const expiry = [card.expMonth?.padStart(2, '0'), card.expYear].filter(Boolean).join(' / ');
    sections.push(
      section(null, [
        field('card.cardholderName', 'Cardholder name', card.cardholderName),
        field('card.brand', 'Brand', card.brand),
        field('card.number', 'Number', card.number, 'concealed'),
        field('card.expiry', 'Expiration', expiry || null),
        field('card.code', 'Security code', card.code, 'concealed'),
      ]),
    );
  }
  const id = item.identity;
  if (id) {
    const name = [id.title, id.firstName, id.middleName, id.lastName].filter(Boolean).join(' ');
    const cityLine = [id.city, id.state, id.postalCode].filter(Boolean).join(', ');
    const address = [id.address1, id.address2, id.address3, cityLine, id.country]
      .filter(Boolean)
      .join('\n');
    sections.push(
      section(null, [
        field('identity.name', 'Name', name || null),
        field('identity.username', 'Username', id.username ?? null),
        field('identity.company', 'Company', id.company ?? null),
      ]),
      section('Contact', [
        field('identity.email', 'Email', id.email ?? null, 'email'),
        field('identity.phone', 'Phone', id.phone ?? null),
        field('identity.address', 'Address', address || null, 'multiline'),
      ]),
      section('Documents', [
        field('identity.ssn', 'Social Security number', id.ssn ?? null, 'concealed'),
        field('identity.passportNumber', 'Passport number', id.passportNumber ?? null, 'concealed'),
        field('identity.licenseNumber', 'License number', id.licenseNumber ?? null, 'concealed'),
      ]),
    );
  }
  const ssh = item.sshKey;
  if (ssh) {
    sections.push(
      section(null, [
        field('ssh.publicKey', 'Public key', ssh.publicKey, 'multiline'),
        field('ssh.keyFingerprint', 'Fingerprint', ssh.keyFingerprint),
        field('ssh.privateKey', 'Private key', ssh.privateKey, 'concealed'),
      ]),
    );
  }
  if (item.fields.length > 0) {
    sections.push(
      section(
        'Custom fields',
        item.fields.map((f, i) => {
          const label = f.name || 'Field';
          switch (f.type) {
            case FieldType.Hidden:
              return field(`field.${String(i)}`, label, f.value, 'concealed', item.viewPassword);
            case FieldType.Boolean:
              return field(
                `field.${String(i)}`,
                label,
                f.value === 'true' ? 'Yes' : 'No',
                'boolean',
              );
            case FieldType.Linked:
              return field(
                `field.${String(i)}`,
                label,
                `Linked to ${LINKED_LABELS[f.linkedId ?? -1] ?? 'a field'}`,
              );
            default:
              return field(`field.${String(i)}`, label, f.value);
          }
        }),
      ),
    );
  }

  const organization = item.organizationId
    ? (names.organizations.find((o) => o.id === item.organizationId)?.name ?? null)
    : null;
  return {
    id: item.id,
    type: item.type,
    name: item.name,
    favorite: item.favorite,
    folder: names.folders.find((f) => f.id === item.folderId)?.name ?? null,
    organization,
    collections: item.collectionIds
      .map((cid) => names.collections.find((c) => c.id === cid)?.name)
      .filter((n): n is string => Boolean(n)),
    uris: login?.uris ?? [],
    sections: sections.filter((s): s is DetailSection => s !== null),
    notes: item.notes,
    attachments: item.attachments.map(({ id: aid, fileName, sizeName }) => ({
      id: aid,
      fileName,
      sizeName,
    })),
    hasTotp: Boolean(login?.totp),
    reprompt: item.reprompt,
    revisionDate: item.revisionDate,
    folderId: item.folderId,
    canEdit: item.canEdit,
    deletedDate: item.deletedDate,
  };
}

/** Concealed values the popup may ask for by field id, and whether the org allows it. */
export function secretValue(
  item: DecryptedCipher,
  fieldId: string,
): { value: string | null; allowed: boolean } {
  const hidden = !item.viewPassword;
  switch (fieldId) {
    case 'login.password':
      return { value: item.login?.password ?? null, allowed: !hidden };
    case 'card.number':
      return { value: item.card?.number ?? null, allowed: true };
    case 'card.code':
      return { value: item.card?.code ?? null, allowed: true };
    case 'identity.ssn':
    case 'identity.passportNumber':
    case 'identity.licenseNumber': {
      const key = fieldId.slice('identity.'.length) as IdentityField;
      return { value: item.identity?.[key] ?? null, allowed: true };
    }
    case 'ssh.privateKey':
      return { value: item.sshKey?.privateKey ?? null, allowed: true };
  }
  const custom = /^field\.(\d+)$/.exec(fieldId);
  if (custom) {
    const entry = item.fields[Number(custom[1])];
    if (entry?.type === FieldType.Hidden) return { value: entry.value, allowed: !hidden };
  }
  return { value: null, allowed: false };
}

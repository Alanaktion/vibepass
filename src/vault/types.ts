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

/** How a login URI is matched against a page, as the official clients define it. */
export enum UriMatch {
  /** Same registrable domain (example.com matches login.example.com). The default. */
  Domain = 0,
  /** Same hostname and port. */
  Host = 1,
  StartsWith = 2,
  Exact = 3,
  RegularExpression = 4,
  Never = 5,
}

/** Custom field types. */
export enum FieldType {
  Text = 0,
  Hidden = 1,
  Boolean = 2,
  Linked = 3,
}

export interface LoginUri {
  uri: string;
  /** null means "use the default", which is Domain. */
  match: UriMatch | null;
}

/** Lightweight row for search results and lists. Never includes secrets. */
export interface CipherSummary {
  id: string;
  type: CipherType;
  name: string;
  /** Username for logins, brand/last4 for cards, etc. */
  subtitle: string | null;
  uris: LoginUri[];
  favorite: boolean;
  folderId: string | null;
  organizationId: string | null;
  collectionIds: string[];
  /** The item has a TOTP seed (the seed itself stays encrypted). */
  hasTotp: boolean;
  /** The item asks for the master password before secrets are shown or filled. */
  reprompt: boolean;
}

/** An item in the trash. */
export interface TrashItem extends CipherSummary {
  deletedDate: string;
}

/** A search result: a summary, plus whether it is saved for the page the user is on. */
export interface SearchHit extends CipherSummary {
  siteMatch: boolean;
}

export interface FolderSummary {
  id: string;
  name: string;
}

export interface CollectionSummary {
  id: string;
  organizationId: string;
  name: string;
}

export interface OrganizationSummary {
  id: string;
  name: string;
}

/** How the item view shows a field. */
export type FieldKind = 'text' | 'concealed' | 'email' | 'url' | 'boolean' | 'multiline' | 'totp';

/**
 * One labeled field in the item view. Concealed fields arrive with `value: null`; the popup asks
 * for the value with `vault:reveal` when the user reveals or copies it.
 */
export interface DetailField {
  id: string;
  label: string;
  kind: FieldKind;
  value: string | null;
  /** False when an organization hides this value from the user. */
  canReveal: boolean;
}

export interface DetailSection {
  title: string | null;
  fields: DetailField[];
}

export interface AttachmentSummary {
  id: string;
  fileName: string;
  sizeName: string | null;
}

/** Everything the item view shows, with concealed values left out. */
export interface CipherDetail {
  id: string;
  type: CipherType;
  name: string;
  favorite: boolean;
  folder: string | null;
  organization: string | null;
  collections: string[];
  uris: LoginUri[];
  sections: DetailSection[];
  notes: string | null;
  attachments: AttachmentSummary[];
  hasTotp: boolean;
  reprompt: boolean;
  revisionDate: string;
  folderId: string | null;
  /** The user may change this item (personal items, and shared ones with edit access). */
  canEdit: boolean;
  /** Set when the item is in the trash. */
  deletedDate: string | null;
}

/** A custom field as the editor sees it. Linked fields keep their target and have no value. */
export interface DraftField {
  name: string;
  value: string;
  type: FieldType;
  linkedId: number | null;
}

/** A payment card in the editor. Empty strings are saved as empty. */
export interface CardDraft {
  cardholderName: string;
  /** The official clients' brand names: Visa, Mastercard, Amex, and so on. */
  brand: string;
  number: string;
  /** "1" to "12", as the official clients store it. */
  expMonth: string;
  /** Four digits. */
  expYear: string;
  code: string;
}

/** The identity fields, as the server names them. */
export type IdentityFieldName =
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

/** An identity in the editor: every field, empty when unset. */
export type IdentityDraft = Record<IdentityFieldName, string>;

/**
 * The editable, decrypted form of an item. Only what the editor changes is here; everything
 * else on the server copy (passkeys, attachments, SSH keys, fields from newer clients) is
 * carried over untouched when the item is saved.
 */
export interface ItemDraft {
  type: CipherType;
  name: string;
  notes: string;
  favorite: boolean;
  folderId: string | null;
  /** Ask for the master password before showing or filling secrets. */
  reprompt: boolean;
  login: {
    username: string;
    password: string;
    totp: string;
    uris: LoginUri[];
  } | null;
  card: CardDraft | null;
  identity: IdentityDraft | null;
  fields: DraftField[];
}

/** An item opened for editing: the draft plus what the editor needs to save it safely. */
export interface EditableItem {
  id: string;
  /** Sent back on save, so the server can refuse it if another client changed the item. */
  revisionDate: string;
  organization: string | null;
  draft: ItemDraft;
}

/** One previously used password, newest first. */
export interface PasswordHistoryEntry {
  password: string;
  lastUsedDate: string;
}

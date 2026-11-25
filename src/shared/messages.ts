/**
 * Typed message protocol between the popup / content scripts and the background worker.
 *
 * The background worker owns auth, sync, and the decrypted vault. Everything else asks it for
 * what it needs through these messages, so decrypted data only crosses the boundary on demand,
 * for the one item the user acted on.
 */
import type { LoginChallenge } from '../api/types';
import type { StoredGeneratorOptions } from '../storage/generator';
import type { Settings } from '../storage/settings';
import type { TotpCode } from '../vault/totp';
import type {
  CipherDetail,
  EditableItem,
  FolderSummary,
  ItemDraft,
  PasswordHistoryEntry,
  SearchHit,
  TrashItem,
} from '../vault/types';
import type { ErrorCode } from './errors';

export type LockState = 'logged-out' | 'locked' | 'unlocked';

export interface VaultStatus {
  state: LockState;
  serverUrl: string | null;
  email: string | null;
  lastSync: string | null;
  /** Number of items in the unlocked vault; 0 while locked. */
  itemCount: number;
  /** Why the last background sync failed, if it did. Cleared by the next good sync. */
  syncError: string | null;
  /** Changes whenever the vault's contents change (a sync or a save), so views reload. */
  version: number;
}

export interface LoginRequest {
  serverUrl: string;
  email: string;
  masterPassword: string;
  challenge?: LoginChallenge;
}

/** Secrets of items with "master password re-prompt" need the password again. */
export interface RepromptFields {
  masterPassword?: string;
}

export interface FillResult {
  /** Which fields were filled: 'username', 'password', 'totp'. */
  filled: string[];
  /** The one-time password was copied because the page had no field for it. */
  copiedTotp: boolean;
}

/** One row of the inline menu. Names and usernames only, never secrets. */
export interface InlineMenuItem {
  id: string;
  name: string;
  username: string | null;
  /** Needs the master password, so it fills from the popup instead. */
  reprompt: boolean;
  /** Filled in this tab a moment ago: the next step of a multi-step login. */
  recent: boolean;
}

/** What the inline menu on a page's login fields should show. */
export type InlineMenuState =
  | { state: 'off' }
  | { state: 'locked' }
  | {
      state: 'unlocked';
      items: InlineMenuItem[];
      /** Offer a generated password on new-password fields. */
      canGenerate?: boolean;
      /** Offer to save submitted logins (editing and saving are turned on). */
      offerToSave?: boolean;
    };

/** Saving from the editor. See VaultService.saveItem for the conflict rules. */
export interface SaveItemRequest {
  /** null creates a new item. */
  id: string | null;
  draft: ItemDraft;
  /** The revision the editor started from. */
  revisionDate?: string;
  /** Save over a newer copy from another device. */
  overwrite?: boolean;
}

/**
 * What a page's submitted login means for the vault, shown as a banner on the page. Names and
 * usernames only: the password stays in the worker until the user answers.
 */
export type SavePrompt =
  | { kind: 'save'; host: string; username: string | null; suggestedName: string }
  | {
      kind: 'update';
      host: string;
      username: string | null;
      /** Logins for the site this could update, best first. */
      items: { id: string; name: string; username: string | null }[];
    };

/** Credentials a page submitted, as the content script read them from the form. */
export interface SubmittedLogin {
  username: string | null;
  /** The current password (sign in), if the form had one. */
  password: string | null;
  /** A new password (sign up or change password), if the form had one. */
  newPassword: string | null;
}

export type SaveAnswer =
  | { action: 'save'; name: string }
  | { action: 'update'; id: string }
  | { action: 'dismiss' }
  /** Don't offer again for this site (until the browser restarts). */
  | { action: 'never' };

/** Map of message type -> { request payload, response payload }. */
export interface MessageMap {
  'vault:status': { request: undefined; response: VaultStatus };
  'vault:login': { request: LoginRequest; response: VaultStatus };
  'vault:send-login-email': { request: LoginRequest; response: undefined };
  'vault:resend-device-code': { request: LoginRequest; response: undefined };
  'vault:unlock': { request: { masterPassword: string }; response: VaultStatus };
  'vault:logout': { request: undefined; response: VaultStatus };
  'vault:lock': { request: undefined; response: VaultStatus };
  'vault:sync': { request: undefined; response: VaultStatus };
  'vault:search': { request: { query: string; url?: string }; response: SearchHit[] };
  'vault:item': { request: { id: string }; response: CipherDetail };
  'vault:reveal': { request: { id: string; fieldId: string } & RepromptFields; response: string };
  'vault:totp': { request: { id: string } & RepromptFields; response: TotpCode };
  'vault:attachment': {
    request: { id: string; attachmentId: string } & RepromptFields;
    response: { fileName: string; base64: string };
  };
  'vault:edit': { request: { id: string } & RepromptFields; response: EditableItem };
  'vault:save': { request: SaveItemRequest; response: { id: string } };
  'vault:organize': {
    request: { id: string; favorite?: boolean; folderId?: string | null };
    response: undefined;
  };
  'vault:trash-item': { request: { id: string }; response: undefined };
  'vault:restore': { request: { id: string }; response: undefined };
  'vault:delete-forever': { request: { id: string }; response: undefined };
  'vault:trash': { request: undefined; response: TrashItem[] };
  'vault:folders': { request: undefined; response: FolderSummary[] };
  'folder:create': { request: { name: string }; response: FolderSummary };
  'folder:rename': { request: { id: string; name: string }; response: undefined };
  'folder:delete': { request: { id: string }; response: undefined };
  'generator:options': { request: undefined; response: StoredGeneratorOptions };
  'generator:generate': {
    request: { options?: StoredGeneratorOptions };
    response: { password: string };
  };
  'generator:history': { request: undefined; response: PasswordHistoryEntry[] };
  'generator:clear-history': { request: undefined; response: undefined };
  'autofill:fill': {
    request: { tabId: number; id: string; force?: boolean } & RepromptFields;
    response: FillResult;
  };
  'autofill:page-ready': { request: { url: string; loginForms: number }; response: undefined };
  'autofill:menu': { request: undefined; response: InlineMenuState };
  'autofill:menu-fill': { request: { id: string }; response: FillResult };
  'autofill:open-popup': { request: undefined; response: undefined };
  /** A login form was submitted on the page; answers with a banner to show, if any. */
  'autofill:submitted': { request: SubmittedLogin; response: SavePrompt | null };
  /** A banner the page should show after it loaded (the form submit navigated). */
  'autofill:pending-prompt': {
    request: undefined;
    /** `offer`: send submitted logins at all (unlocked, with editing and saving turned on). */
    response: { prompt: SavePrompt | null; offer: boolean };
  };
  'autofill:save-answer': { request: SaveAnswer; response: { message: string } };
  /** Suggest a strong password for a new-password field, following the site's rules. */
  'autofill:generate': { request: { rules: string | null }; response: { password: string } };
  'clipboard:copied': { request: undefined; response: undefined };
  'settings:get': { request: undefined; response: Settings };
  'settings:set': { request: Partial<Settings>; response: Settings };
}

export type MessageType = keyof MessageMap;
export type RequestOf<T extends MessageType> = MessageMap[T]['request'];
export type ResponseOf<T extends MessageType> = MessageMap[T]['response'];

export interface Message<T extends MessageType = MessageType> {
  /** Marks our messages so we ignore anything else on the runtime channel. */
  source: 'vibepass';
  type: T;
  payload: RequestOf<T>;
}

/** Messages always resolve to an envelope so errors survive the structured-clone boundary. */
export type Envelope<T> =
  { ok: true; data: T } | { ok: false; error: string; code?: ErrorCode; details?: unknown };

const MESSAGE_TYPES: readonly MessageType[] = [
  'vault:status',
  'vault:login',
  'vault:send-login-email',
  'vault:resend-device-code',
  'vault:unlock',
  'vault:logout',
  'vault:lock',
  'vault:sync',
  'vault:search',
  'vault:item',
  'vault:reveal',
  'vault:totp',
  'vault:attachment',
  'vault:edit',
  'vault:save',
  'vault:organize',
  'vault:trash-item',
  'vault:restore',
  'vault:delete-forever',
  'vault:trash',
  'vault:folders',
  'folder:create',
  'folder:rename',
  'folder:delete',
  'generator:options',
  'generator:generate',
  'generator:history',
  'generator:clear-history',
  'autofill:fill',
  'autofill:page-ready',
  'autofill:menu',
  'autofill:menu-fill',
  'autofill:open-popup',
  'autofill:submitted',
  'autofill:pending-prompt',
  'autofill:save-answer',
  'autofill:generate',
  'clipboard:copied',
  'settings:get',
  'settings:set',
];

/**
 * The only messages a content script may send. The inline menu ones are answered for the
 * sender's own tab and page only, and give names and usernames, never secrets.
 */
const CONTENT_SCRIPT_ALLOWED: ReadonlySet<MessageType> = new Set<MessageType>([
  'autofill:page-ready',
  'autofill:menu',
  'autofill:menu-fill',
  'autofill:open-popup',
  'autofill:submitted',
  'autofill:pending-prompt',
  'autofill:save-answer',
  'autofill:generate',
]);

/** Messages only the popup (an extension page) may send; content scripts are refused. */
export const EXTENSION_PAGE_ONLY: ReadonlySet<MessageType> = new Set(
  MESSAGE_TYPES.filter((type) => !CONTENT_SCRIPT_ALLOWED.has(type)),
);

export function isMessage(value: unknown): value is Message {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Message>;
  return (
    candidate.source === 'vibepass' &&
    typeof candidate.type === 'string' &&
    MESSAGE_TYPES.includes(candidate.type)
  );
}

export function createMessage<T extends MessageType>(type: T, payload: RequestOf<T>): Message<T> {
  return { source: 'vibepass', type, payload };
}

/** Broadcast from the worker to open extension pages when the vault status changes. */
export interface StatusEvent {
  source: 'vibepass';
  type: 'event:status';
  payload: VaultStatus;
}

export function isStatusEvent(value: unknown): value is StatusEvent {
  const candidate = value as Partial<StatusEvent> | null;
  return candidate?.source === 'vibepass' && candidate.type === 'event:status';
}

/** Worker -> content script, sent with tabs.sendMessage to the top frame only. */
export type ContentRequest =
  | { source: 'vibepass'; type: 'content:inspect' }
  | {
      source: 'vibepass';
      type: 'content:fill';
      /** The origin the worker matched the item against; the content script refuses others. */
      origin: string;
      username: string | null;
      password: string | null;
      totp: string | null;
    };

export interface PageInfo {
  url: string;
  /** Login fields found on the page. */
  fields: { username: boolean; password: boolean; totp: boolean };
}

export function isContentRequest(value: unknown): value is ContentRequest {
  const candidate = value as Partial<ContentRequest> | null;
  return (
    candidate?.source === 'vibepass' &&
    (candidate.type === 'content:inspect' || candidate.type === 'content:fill')
  );
}

/** Worker -> offscreen document (Chrome), to write the clipboard without a visible page. */
export interface OffscreenRequest {
  source: 'vibepass';
  type: 'offscreen:write-clipboard';
  text: string;
}

export function isOffscreenRequest(value: unknown): value is OffscreenRequest {
  const candidate = value as Partial<OffscreenRequest> | null;
  return candidate?.source === 'vibepass' && candidate.type === 'offscreen:write-clipboard';
}

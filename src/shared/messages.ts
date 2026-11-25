/**
 * Typed message protocol between the popup / content scripts and the background worker.
 *
 * The background worker owns auth, sync, and the decrypted vault. Everything else asks it for
 * what it needs through these messages, so decrypted data only crosses the boundary on demand,
 * for the one item the user acted on.
 */
import type { LoginChallenge } from '../api/types';
import type { Settings } from '../storage/settings';
import type { TotpCode } from '../vault/totp';
import type { CipherDetail, SearchHit } from '../vault/types';
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
  { state: 'off' } | { state: 'locked' } | { state: 'unlocked'; items: InlineMenuItem[] };

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
  'autofill:fill': {
    request: { tabId: number; id: string; force?: boolean } & RepromptFields;
    response: FillResult;
  };
  'autofill:page-ready': { request: { url: string; loginForms: number }; response: undefined };
  'autofill:menu': { request: undefined; response: InlineMenuState };
  'autofill:menu-fill': { request: { id: string }; response: FillResult };
  'autofill:open-popup': { request: undefined; response: undefined };
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
  'autofill:fill',
  'autofill:page-ready',
  'autofill:menu',
  'autofill:menu-fill',
  'autofill:open-popup',
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

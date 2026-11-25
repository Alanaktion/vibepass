/**
 * Typed message protocol between the popup / content scripts and the background worker.
 *
 * The background worker owns auth, sync, and the decrypted vault. Everything else asks it for
 * what it needs through these messages, so decrypted data only crosses the boundary on demand.
 */
import type { CipherSummary } from '../vault/types';

export type LockState = 'logged-out' | 'locked' | 'unlocked';

export interface VaultStatus {
  state: LockState;
  serverUrl: string | null;
  email: string | null;
  lastSync: string | null;
}

/** Map of message type -> { request payload, response payload }. */
export interface MessageMap {
  'vault:status': { request: undefined; response: VaultStatus };
  'vault:unlock': { request: { masterPassword: string }; response: VaultStatus };
  'vault:lock': { request: undefined; response: VaultStatus };
  'vault:sync': { request: undefined; response: VaultStatus };
  'vault:search': { request: { query: string; url?: string }; response: CipherSummary[] };
  'autofill:page-ready': { request: { url: string; loginForms: number }; response: undefined };
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
export type Envelope<T> = { ok: true; data: T } | { ok: false; error: string };

const MESSAGE_TYPES: readonly MessageType[] = [
  'vault:status',
  'vault:unlock',
  'vault:lock',
  'vault:sync',
  'vault:search',
  'autofill:page-ready',
];

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

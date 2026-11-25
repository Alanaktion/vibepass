import {
  EXTENSION_PAGE_ONLY,
  isMessage,
  type Envelope,
  type MessageType,
  type RequestOf,
  type ResponseOf,
} from '../shared/messages';
import type { ErrorCode } from '../shared/errors';
import type { Runtime } from '../shared/browser';

export type Handler<T extends MessageType> = (
  payload: RequestOf<T>,
  sender: Runtime.MessageSender,
) => ResponseOf<T> | Promise<ResponseOf<T>>;

export type Handlers = { [T in MessageType]: Handler<T> };

export type Listener = (
  message: unknown,
  sender: Runtime.MessageSender,
) => Promise<Envelope<unknown>> | undefined;

/** Turn any thrown value into an error envelope, keeping a UI-facing code if it has one. */
export function errorEnvelope(error: unknown): Envelope<never> {
  if (!(error instanceof Error)) return { ok: false, error: 'Unknown error' };
  const { code, details } = error as Error & { code?: unknown; details?: unknown };
  const envelope: Envelope<never> = { ok: false, error: error.message };
  if (typeof code === 'string') envelope.code = code as ErrorCode;
  if (details !== undefined) envelope.details = details;
  return envelope;
}

/**
 * Build a runtime.onMessage listener that dispatches typed messages to handlers and always
 * answers with an Envelope. Messages that are not ours are ignored (returns undefined), messages
 * from any other extension are rejected, and content scripts may only send the few messages
 * meant for them, so a compromised page can never ask for vault data.
 *
 * @param extensionUrl the extension's own base URL (runtime.getURL('')), to tell extension pages
 *   from content scripts.
 */
export function createRouter(
  handlers: Handlers,
  extensionId: string,
  extensionUrl?: string,
): Listener {
  return (message, sender) => {
    if (!isMessage(message)) return undefined;
    if (sender.id !== extensionId) {
      return Promise.resolve({ ok: false, error: 'Untrusted sender' });
    }
    const fromExtensionPage =
      sender.url !== undefined && extensionUrl !== undefined
        ? sender.url.startsWith(extensionUrl)
        : sender.tab === undefined;
    if (!fromExtensionPage && EXTENSION_PAGE_ONLY.has(message.type)) {
      return Promise.resolve({ ok: false, error: 'Untrusted sender' });
    }
    const handler = handlers[message.type] as Handler<MessageType>;
    return Promise.resolve()
      .then(() => handler(message.payload, sender))
      .then((data): Envelope<unknown> => ({ ok: true, data }), errorEnvelope);
  };
}

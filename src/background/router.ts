import {
  isMessage,
  type Envelope,
  type MessageType,
  type RequestOf,
  type ResponseOf,
} from '../shared/messages';
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

/**
 * Build a runtime.onMessage listener that dispatches typed messages to handlers and always
 * answers with an Envelope. Messages that are not ours are ignored (returns undefined), and
 * messages from any other extension are rejected.
 */
export function createRouter(handlers: Handlers, extensionId: string): Listener {
  return (message, sender) => {
    if (!isMessage(message)) return undefined;
    if (sender.id !== extensionId) {
      return Promise.resolve({ ok: false, error: 'Untrusted sender' });
    }
    const handler = handlers[message.type] as Handler<MessageType>;
    return Promise.resolve()
      .then(() => handler(message.payload, sender))
      .then(
        (data): Envelope<unknown> => ({ ok: true, data }),
        (error: unknown): Envelope<unknown> => ({
          ok: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        }),
      );
  };
}

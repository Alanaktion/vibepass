import browser from './browser';
import { CodedError } from './errors';
import {
  createMessage,
  type Envelope,
  type Message,
  type MessageType,
  type RequestOf,
  type ResponseOf,
} from './messages';

/**
 * Send a typed message to the background worker and unwrap its envelope. Errors with a code
 * (two-step login, re-prompt, ...) come back as CodedError so the UI can react to them.
 */
export async function sendMessage<T extends MessageType>(
  type: T,
  ...args: RequestOf<T> extends undefined ? [] : [RequestOf<T>]
): Promise<ResponseOf<T>> {
  const payload = args[0] as RequestOf<T>;
  const envelope = await browser.runtime.sendMessage<
    Message<T>,
    Envelope<ResponseOf<T>> | undefined
  >(createMessage(type, payload));
  if (!envelope) throw new Error(`No response for ${type}`);
  if (!envelope.ok) {
    if (envelope.code) throw new CodedError(envelope.error, envelope.code, envelope.details);
    throw new Error(envelope.error);
  }
  return envelope.data;
}

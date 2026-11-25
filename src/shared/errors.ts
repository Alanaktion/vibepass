/**
 * An error the UI can react to by `code`, not just show. The router copies `code` and
 * `details` into the message envelope, and `sendMessage()` turns them back into this class.
 * `details` crosses the messaging boundary, so it must never hold secrets.
 */
export class CodedError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CodedError';
  }
}

export type ErrorCode =
  /** The account uses two-step login; details: TwoFactorDetails. */
  | 'two-factor-required'
  /** The server wants a code it emailed to confirm a new device. */
  | 'new-device-verification'
  /** The item asks for the master password again before secrets are shown or filled. */
  | 'reprompt-required'
  /** The item is not saved for the page; the user can confirm and fill anyway. */
  | 'fill-mismatch'
  | 'locked';

export function isCodedError(value: unknown, code?: ErrorCode): value is CodedError {
  return value instanceof CodedError && (code === undefined || value.code === code);
}

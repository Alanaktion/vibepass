/**
 * Minimal logger. Vault data, keys, and passwords must never be passed here: the security
 * model forbids plaintext in logs. Pass short static messages and non-sensitive context only.
 */
/* eslint-disable no-console */
const PREFIX = '[vibepass]';

export const log = {
  debug(message: string, context?: Record<string, string | number | boolean>): void {
    if (import.meta.env.DEV) console.debug(PREFIX, message, context ?? '');
  },
  warn(message: string, context?: Record<string, string | number | boolean>): void {
    console.warn(PREFIX, message, context ?? '');
  },
  error(message: string, error?: unknown): void {
    // Only the error name/message is logged, never arbitrary objects that might hold secrets.
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : '';
    console.error(PREFIX, message, detail);
  },
};

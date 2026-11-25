import { NotImplementedError } from '../shared/errors';
import type { SyncResponse } from '../api/types';

/**
 * Encrypted vault cache in IndexedDB for fast cold start and offline read.
 * Stores the sync response exactly as the server sent it (still encrypted). No plaintext.
 */
export const DB_NAME = 'vibepass';
export const DB_VERSION = 1;

export const vaultCache = {
  read(_userId: string): Promise<SyncResponse | null> {
    return Promise.reject(new NotImplementedError('vaultCache.read'));
  },
  write(_userId: string, _sync: SyncResponse): Promise<void> {
    return Promise.reject(new NotImplementedError('vaultCache.write'));
  },
  clear(_userId: string): Promise<void> {
    return Promise.reject(new NotImplementedError('vaultCache.clear'));
  },
};

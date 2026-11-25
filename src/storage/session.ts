import { NotImplementedError } from '../shared/errors';
import type { SymmetricKey } from '../crypto/types';

/**
 * Holds the unlocked user key across MV3 service-worker restarts using `storage.session`,
 * which is memory-only and cleared when the browser closes. Never use `storage.local` here.
 */
export const sessionKeyStore = {
  save(_key: SymmetricKey): Promise<void> {
    return Promise.reject(new NotImplementedError('sessionKeyStore.save'));
  },
  load(): Promise<SymmetricKey | null> {
    return Promise.reject(new NotImplementedError('sessionKeyStore.load'));
  },
  clear(): Promise<void> {
    return Promise.reject(new NotImplementedError('sessionKeyStore.clear'));
  },
};

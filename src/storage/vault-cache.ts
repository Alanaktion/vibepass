import type { SyncResponse } from '../api/types';

/**
 * Encrypted vault cache in IndexedDB for fast cold start and offline unlock.
 * Stores the sync response exactly as the server sent it (still encrypted). No plaintext.
 */
export const DB_NAME = 'vibepass';
export const DB_VERSION = 1;
const STORE = 'sync';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('Could not open the vault cache'));
    };
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      tx.oncomplete = () => {
        resolve(request.result as T);
      };
      tx.onerror = () => {
        reject(tx.error ?? new Error('Vault cache error'));
      };
      tx.onabort = () => {
        reject(tx.error ?? new Error('Vault cache aborted'));
      };
    });
  } finally {
    db.close();
  }
}

export const vaultCache = {
  async read(userId: string): Promise<SyncResponse | null> {
    return (await run<SyncResponse | undefined>('readonly', (s) => s.get(userId))) ?? null;
  },
  async write(userId: string, sync: SyncResponse): Promise<void> {
    await run('readwrite', (s) => s.put(sync, userId));
  },
  async clear(userId: string): Promise<void> {
    await run('readwrite', (s) => s.delete(userId));
  },
};

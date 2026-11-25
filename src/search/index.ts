import type { CipherSummary } from '../vault/types';

/**
 * In-memory search over decrypted cipher summaries, built at unlock and updated on sync.
 * The plan is MiniSearch with fuzzy matching on name, username, URL, and notes, ranking
 * current-site matches first. This scaffold uses a plain substring match as a placeholder.
 */
export interface SearchIndex {
  replaceAll(items: readonly CipherSummary[]): void;
  upsert(item: CipherSummary): void;
  remove(id: string): void;
  search(query: string, options?: { url?: string; limit?: number }): CipherSummary[];
  clear(): void;
}

export function createSearchIndex(): SearchIndex {
  const items = new Map<string, CipherSummary>();

  return {
    replaceAll(next) {
      items.clear();
      for (const item of next) items.set(item.id, item);
    },
    upsert(item) {
      items.set(item.id, item);
    },
    remove(id) {
      items.delete(id);
    },
    search(query, options = {}) {
      const needle = query.trim().toLowerCase();
      const limit = options.limit ?? 50;
      const results: CipherSummary[] = [];
      for (const item of items.values()) {
        const haystack = [item.name, item.subtitle ?? '', ...item.uris].join(' ').toLowerCase();
        if (needle === '' || haystack.includes(needle)) results.push(item);
        if (results.length >= limit) break;
      }
      return results;
    },
    clear() {
      items.clear();
    },
  };
}

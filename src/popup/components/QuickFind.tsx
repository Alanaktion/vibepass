import { useEffect, useState } from 'preact/hooks';
import type { VaultStatus } from '../../shared/messages';
import { sendMessage } from '../../shared/messaging';
import type { CipherSummary } from '../../vault/types';

interface Props {
  status: VaultStatus;
  onStatus: (status: VaultStatus) => void;
}

/** Read-only search (Phase 0). Arrow keys, Enter to fill, and copy chords come in Phase 1. */
export function QuickFind({ status, onStatus }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CipherSummary[]>([]);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    sendMessage('vault:search', { query }).then(
      (items) => {
        if (!cancelled) setResults(items);
      },
      () => {
        if (!cancelled) setResults([]);
      },
    );
    return () => {
      cancelled = true;
    };
    // Re-run when a sync changes the vault, not only when the query changes.
  }, [query, status.lastSync, status.itemCount]);

  function sync() {
    setSyncError(null);
    sendMessage('vault:sync').then(onStatus, (e: unknown) => {
      setSyncError(e instanceof Error ? e.message : 'Sync failed');
    });
  }

  return (
    <main class="screen">
      <header class="row">
        <input
          type="search"
          class="grow"
          placeholder="Search vault"
          aria-label="Search vault"
          value={query}
          onInput={(e) => {
            setQuery(e.currentTarget.value);
          }}
          autoFocus
        />
        <button
          type="button"
          onClick={() => {
            void sendMessage('vault:lock').then(onStatus);
          }}
        >
          Lock
        </button>
      </header>
      <ul class="results" role="listbox" aria-label="Results">
        {results.map((item) => (
          <li key={item.id} role="option" aria-selected="false">
            <span class="name">{item.name}</span>
            {item.subtitle && <span class="muted">{item.subtitle}</span>}
          </li>
        ))}
      </ul>
      {results.length === 0 && <p class="muted">No items</p>}
      {syncError && (
        <p role="alert" class="error">
          {syncError}
        </p>
      )}
      <footer class="row footer muted">
        <span class="grow">
          {status.itemCount} {status.itemCount === 1 ? 'item' : 'items'}
          {status.lastSync && ` · synced ${new Date(status.lastSync).toLocaleTimeString()}`}
        </span>
        <button type="button" class="link" onClick={sync}>
          Sync
        </button>
      </footer>
    </main>
  );
}

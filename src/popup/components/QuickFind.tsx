import { useEffect, useState } from 'preact/hooks';
import type { VaultStatus } from '../../shared/messages';
import { sendMessage } from '../../shared/messaging';
import type { CipherSummary } from '../../vault/types';

interface Props {
  onLock: (status: VaultStatus) => void;
}

/** Keyboard-first search. Arrow keys, Enter to fill, and copy chords come in Phase 1. */
export function QuickFind({ onLock }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CipherSummary[]>([]);

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
  }, [query]);

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
            void sendMessage('vault:lock').then(onLock);
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
    </main>
  );
}

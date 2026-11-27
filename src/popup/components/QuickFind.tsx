import { KeyRound, Lock, RefreshCw, Settings, Star } from 'lucide-preact';
import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { sendMessage } from '../../shared/messaging';
import type { NewItemType } from '../../vault/draft';
import { displayHost } from '../../vault/uri';
import { CipherType, type SearchHit } from '../../vault/types';
import { copyField, fillItem } from '../actions';
import { usePopup } from '../context';
import { hasMod, iconUrl, modLabel } from '../lib';
import { ItemIcon } from './Dialogs';
import { IconButton } from './IconButton';
import { NewItemMenu } from './NewItemMenu';

interface Props {
  onOpen: (id: string) => void;
  onSettings: () => void;
  /** Start a new item (only offered when editing is turned on). */
  onNew: (type: NewItemType) => void;
  onGenerator: () => void;
  /** Keeps the query when coming back from an item. */
  query: string;
  onQuery: (query: string) => void;
}

const TYPE_LABEL: Record<CipherType, string> = {
  [CipherType.Login]: 'Login',
  [CipherType.SecureNote]: 'Note',
  [CipherType.Card]: 'Card',
  [CipherType.Identity]: 'Identity',
  [CipherType.SshKey]: 'SSH key',
};

/**
 * Quick find. Type to search; items saved for the current site come first.
 * Up and Down move, Enter fills (or opens items that can't be filled), Shift+Enter or Right
 * opens the item, and Mod+C, Mod+Shift+C, Mod+Alt+C copy the username, password, and
 * one-time password.
 */
export function QuickFind({ onOpen, onSettings, onNew, onGenerator, query, onQuery }: Props) {
  const ctx = usePopup();
  const { status, tab, settings } = ctx;
  const [results, setResults] = useState<SearchHit[]>([]);
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let cancelled = false;
    const request = tab?.url ? { query, url: tab.url } : { query };
    sendMessage('vault:search', request).then(
      (items) => {
        if (cancelled) return;
        setResults(items);
        setSelected(0);
      },
      () => {
        if (!cancelled) setResults([]);
      },
    );
    return () => {
      cancelled = true;
    };
    // Re-run when a sync changes the vault, not only when the query changes.
  }, [query, tab?.url, status.version]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const current = results[selected];

  function primary(item: SearchHit) {
    if (item.type === CipherType.Login && tab?.url) void fillItem(ctx, item.id);
    else onOpen(item.id);
  }

  function onKeyDown(e: KeyboardEvent) {
    const input = e.currentTarget as HTMLInputElement;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && current) {
      e.preventDefault();
      if (e.shiftKey) onOpen(current.id);
      else primary(current);
    } else if (
      e.key === 'ArrowRight' &&
      current &&
      input.selectionStart === input.value.length &&
      input.selectionEnd === input.value.length
    ) {
      e.preventDefault();
      onOpen(current.id);
    } else if (e.code === 'KeyC' && hasMod(e) && current) {
      // Plain Mod+C still copies selected search text.
      const hasSelection = input.selectionStart !== input.selectionEnd;
      if (!e.shiftKey && !e.altKey && hasSelection) return;
      e.preventDefault();
      void copyField(ctx, current, e.altKey ? 'totp' : e.shiftKey ? 'password' : 'username');
    } else if (e.key === 'Escape' && query !== '') {
      e.preventDefault();
      onQuery('');
    }
  }

  const siteCount = results.filter((r) => r.siteMatch).length;
  const sharedCount = results.filter((r) => r.sharedSite).length;
  const host = tab?.url ? safeHost(tab.url) : null;
  const mod = modLabel();

  return (
    <main class="screen quick">
      <header class="row search-bar">
        <input
          type="search"
          class="grow"
          placeholder="Search vault"
          aria-label="Search vault"
          aria-controls="results"
          aria-activedescendant={current ? `item-${current.id}` : undefined}
          value={query}
          onInput={(e) => {
            onQuery(e.currentTarget.value);
          }}
          onKeyDown={onKeyDown}
          autoFocus
        />
        {settings?.allowEdits && <NewItemMenu onNew={onNew} />}
        <IconButton icon={KeyRound} label="Password generator" onClick={onGenerator} />
        <IconButton icon={Settings} label="Settings" onClick={onSettings} />
        <IconButton
          icon={Lock}
          label="Lock"
          onClick={() => {
            void sendMessage('vault:lock').then(ctx.onStatus);
          }}
        />
      </header>
      {status.syncError && (
        <p role="alert" class="banner error">
          Sync failed: {status.syncError}
        </p>
      )}
      <ul class="results" id="results" role="listbox" aria-label="Results" ref={listRef}>
        {results.map((item, index) => {
          const header =
            index === 0 && item.siteMatch
              ? `Suggested for ${host ?? 'this site'}`
              : index === siteCount && item.sharedSite
                ? `Saved for sites that share ${host ?? 'this site'}’s sign-in`
                : index === siteCount + sharedCount && siteCount + sharedCount > 0
                  ? 'All items'
                  : null;
          const itemHost = displayHost(item.uris);
          return (
            <Fragment key={item.id}>
              {header && (
                <li class="group" role="presentation">
                  {header}
                </li>
              )}
              <li
                id={`item-${item.id}`}
                role="option"
                aria-selected={index === selected}
                class={index === selected ? 'selected' : undefined}
                onMouseMove={() => {
                  if (index !== selected) setSelected(index);
                }}
                onClick={() => {
                  onOpen(item.id);
                }}
              >
                <ItemIcon
                  name={item.name}
                  src={settings?.useServerIcons ? iconUrl(status.serverUrl, itemHost) : null}
                />
                <span class="text">
                  <span class="name">
                    {item.name}
                    {item.favorite && (
                      <Star class="star" size={12} role="img" aria-label="Favorite" />
                    )}
                  </span>
                  <span class="muted">{item.subtitle ?? itemHost ?? TYPE_LABEL[item.type]}</span>
                </span>
                {item.type === CipherType.Login && tab?.url && index === selected && (
                  <button
                    type="button"
                    class="fill"
                    onClick={(e) => {
                      e.stopPropagation();
                      void fillItem(ctx, item.id);
                    }}
                  >
                    Fill
                  </button>
                )}
              </li>
            </Fragment>
          );
        })}
      </ul>
      {results.length === 0 && (
        <div class="empty">
          <p class="muted">{query ? `No items match “${query}”` : 'Your vault is empty'}</p>
          {settings?.allowEdits && (
            <div class="row center wrap">
              <button
                type="button"
                class="ghost"
                onClick={() => {
                  onNew(CipherType.Login);
                }}
              >
                New login
              </button>
              <button
                type="button"
                class="ghost"
                onClick={() => {
                  onNew(CipherType.SecureNote);
                }}
              >
                New note
              </button>
              <button
                type="button"
                class="ghost"
                onClick={() => {
                  onNew(CipherType.Card);
                }}
              >
                New card
              </button>
              <button
                type="button"
                class="ghost"
                onClick={() => {
                  onNew(CipherType.Identity);
                }}
              >
                New identity
              </button>
            </div>
          )}
        </div>
      )}
      <footer class="row footer muted">
        <span class="grow hints">
          ↵ fill · ⇧↵ open · {mod}C user · {mod}⇧C password
        </span>
        <IconButton
          icon={RefreshCw}
          label="Sync"
          title={
            status.lastSync
              ? `Sync · Last synced ${new Date(status.lastSync).toLocaleString()}`
              : 'Sync'
          }
          onClick={() => {
            sendMessage('vault:sync').then(ctx.onStatus, (e: unknown) => {
              ctx.toast(e instanceof Error ? e.message : 'Sync failed');
            });
          }}
        />
      </footer>
    </main>
  );
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

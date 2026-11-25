import { ArrowLeft, Copy, RefreshCw } from 'lucide-preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { PASSPHRASE_WORDS, PASSWORD_LENGTH } from '../../crypto/generator-options';
import { sendMessage } from '../../shared/messaging';
import type { StoredGeneratorOptions } from '../../storage/generator';
import type { PasswordHistoryEntry } from '../../vault/types';
import { usePopup } from '../context';
import { copyText, errorMessage, hasMod } from '../lib';
import { IconButton } from './IconButton';

/**
 * Password and passphrase generator. Every option change makes a new password; Enter makes
 * another, Mod+C copies it. Everything generated is kept in an encrypted history.
 */
export function GeneratorView({ onBack }: { onBack: () => void }) {
  const ctx = usePopup();
  const [options, setOptions] = useState<StoredGeneratorOptions | null>(null);
  const [password, setPassword] = useState('');
  const [history, setHistory] = useState<PasswordHistoryEntry[] | null>(null);

  const run = useCallback(
    (next: StoredGeneratorOptions) => {
      setOptions(next);
      sendMessage('generator:generate', { options: next }).then(
        (result) => {
          setPassword(result.password);
          setHistory(null);
        },
        (e: unknown) => {
          ctx.toast(errorMessage(e, 'Could not generate a password'));
        },
      );
    },
    [ctx],
  );

  useEffect(() => {
    sendMessage('generator:options').then(run, () => undefined);
    // Generate once on open, with the last-used options.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copy = useCallback(
    (value: string) => {
      void copyText(value).then(() => {
        const seconds = ctx.settings?.clipboardClearSeconds ?? 0;
        ctx.toast(`Password copied${seconds > 0 ? ` · clears in ${String(seconds)}s` : ''}`);
      });
    },
    [ctx],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onBack();
      } else if (hasMod(e) && e.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) {
        e.preventDefault();
        if (password) copy(password);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onBack, copy, password]);

  const set = (patch: Partial<StoredGeneratorOptions>) => {
    if (options) run({ ...options, ...patch });
  };
  const setPw = (patch: Partial<StoredGeneratorOptions['password']>) => {
    if (options) run({ ...options, password: { ...options.password, ...patch } });
  };
  const setPhrase = (patch: Partial<StoredGeneratorOptions['passphrase']>) => {
    if (options) run({ ...options, passphrase: { ...options.passphrase, ...patch } });
  };

  return (
    <main class="screen generator">
      <header class="row item-header">
        <IconButton icon={ArrowLeft} label="Back" onClick={onBack} />
        <h1 class="grow title">Generator</h1>
      </header>
      <div class="generated">
        <output class="mono grow" aria-live="polite" aria-label="Generated password">
          {password}
        </output>
        <IconButton
          icon={RefreshCw}
          label="Generate another"
          autoFocus
          onClick={() => {
            if (options) run(options);
          }}
        />
        <IconButton
          icon={Copy}
          label="Copy password"
          onClick={() => {
            copy(password);
          }}
        />
      </div>
      {options && (
        <div class="stack">
          <div class="segmented" role="radiogroup" aria-label="Kind">
            {(['password', 'passphrase'] as const).map((kind) => (
              <label class="check" key={kind}>
                <input
                  type="radio"
                  name="kind"
                  checked={options.kind === kind}
                  onChange={() => {
                    set({ kind });
                  }}
                />
                {kind === 'password' ? 'Password' : 'Passphrase'}
              </label>
            ))}
          </div>
          {options.kind === 'password' ? (
            <>
              <label>
                Length: {options.password.length}
                <input
                  type="range"
                  min={PASSWORD_LENGTH.min}
                  max={64}
                  value={options.password.length}
                  onChange={(e) => {
                    setPw({ length: Number(e.currentTarget.value) });
                  }}
                />
              </label>
              <div class="row wrap">
                {(
                  [
                    ['uppercase', 'A-Z'],
                    ['lowercase', 'a-z'],
                    ['numbers', '0-9'],
                    ['symbols', '!@#$%^&*'],
                  ] as const
                ).map(([key, label]) => (
                  <label class="check" key={key}>
                    <input
                      type="checkbox"
                      checked={options.password[key]}
                      onChange={(e) => {
                        setPw({ [key]: e.currentTarget.checked });
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <label class="check">
                <input
                  type="checkbox"
                  checked={options.password.avoidAmbiguous}
                  onChange={(e) => {
                    setPw({ avoidAmbiguous: e.currentTarget.checked });
                  }}
                />
                Avoid look-alike characters (I, l, 1, O, 0)
              </label>
            </>
          ) : (
            <>
              <label>
                Words: {options.passphrase.words}
                <input
                  type="range"
                  min={PASSPHRASE_WORDS.min}
                  max={10}
                  value={options.passphrase.words}
                  onChange={(e) => {
                    setPhrase({ words: Number(e.currentTarget.value) });
                  }}
                />
              </label>
              <label>
                Separator
                <input
                  value={options.passphrase.separator}
                  maxLength={1}
                  class="short"
                  onChange={(e) => {
                    setPhrase({ separator: e.currentTarget.value || '-' });
                  }}
                />
              </label>
              <label class="check">
                <input
                  type="checkbox"
                  checked={options.passphrase.capitalize}
                  onChange={(e) => {
                    setPhrase({ capitalize: e.currentTarget.checked });
                  }}
                />
                Capitalize words
              </label>
              <label class="check">
                <input
                  type="checkbox"
                  checked={options.passphrase.includeNumber}
                  onChange={(e) => {
                    setPhrase({ includeNumber: e.currentTarget.checked });
                  }}
                />
                Include a number
              </label>
            </>
          )}
        </div>
      )}
      <section class="fields history">
        <h2>Recently generated</h2>
        {history === null ? (
          <button
            type="button"
            class="link"
            onClick={() => {
              sendMessage('generator:history').then(setHistory, (e: unknown) => {
                ctx.toast(errorMessage(e, 'Could not load the history'));
              });
            }}
          >
            Show history
          </button>
        ) : history.length === 0 ? (
          <p class="muted small field">Nothing yet</p>
        ) : (
          <>
            {history.map((entry, i) => (
              <div class="field" key={`${entry.lastUsedDate}-${String(i)}`}>
                <span class="value concealed">{entry.password}</span>
                <IconButton
                  icon={Copy}
                  label={`Copy password from ${new Date(entry.lastUsedDate).toLocaleString()}`}
                  onClick={() => {
                    copy(entry.password);
                  }}
                />
                <span class="label">{new Date(entry.lastUsedDate).toLocaleString()}</span>
              </div>
            ))}
            <button
              type="button"
              class="link"
              onClick={() => {
                void sendMessage('generator:clear-history').then(() => {
                  setHistory([]);
                });
              }}
            >
              Clear history
            </button>
          </>
        )}
      </section>
    </main>
  );
}

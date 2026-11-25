import { ArrowLeft, Lock, LogOut } from 'lucide-preact';
import { useEffect, useState } from 'preact/hooks';
import { sendMessage } from '../../shared/messaging';
import { CLIPBOARD_CLEAR_CHOICES, LOCK_AFTER_CHOICES, type Settings } from '../../storage/settings';
import { usePopup } from '../context';
import {
  builtInPasswordState,
  setBuiltInPasswordsOff,
  type BuiltInState,
} from '../browserPasswords';
import { errorMessage } from '../lib';
import { IconButton } from './IconButton';

interface Props {
  onBack: () => void;
  onSettings: (settings: Settings) => void;
  onOpen: (view: 'folders' | 'trash') => void;
}

const minutes = (m: number) =>
  m === 0 ? 'Never' : m < 60 ? `${String(m)} min` : `${String(m / 60)} h`;
const seconds = (s: number) =>
  s === 0 ? 'Never' : s < 60 ? `${String(s)} s` : `${String(s / 60)} min`;

export function SettingsView({ onBack, onSettings, onOpen }: Props) {
  const ctx = usePopup();
  const settings = ctx.settings;
  const [builtIn, setBuiltIn] = useState<BuiltInState | null>(null);

  useEffect(() => {
    void builtInPasswordState().then(setBuiltIn);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.dialog')) {
        e.preventDefault();
        onBack();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onBack]);

  function save(patch: Partial<Settings>) {
    sendMessage('settings:set', patch).then(onSettings, (e: unknown) => {
      ctx.toast(errorMessage(e, 'Could not save'));
    });
  }

  return (
    <main class="screen settings">
      <header class="row item-header">
        <IconButton icon={ArrowLeft} label="Back" onClick={onBack} autoFocus />
        <h1 class="grow title">Settings</h1>
      </header>
      {settings && (
        <div class="stack">
          <label>
            Lock after inactivity
            <select
              value={String(settings.lockAfterMinutes)}
              onChange={(e) => {
                save({ lockAfterMinutes: Number(e.currentTarget.value) });
              }}
            >
              {LOCK_AFTER_CHOICES.map((m) => (
                <option key={m} value={String(m)}>
                  {minutes(m)}
                </option>
              ))}
            </select>
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={settings.lockOnSystemLock}
              onChange={(e) => {
                save({ lockOnSystemLock: e.currentTarget.checked });
              }}
            />
            Lock when my computer locks or sleeps
          </label>
          <label>
            Clear copied passwords after
            <select
              value={String(settings.clipboardClearSeconds)}
              onChange={(e) => {
                save({ clipboardClearSeconds: Number(e.currentTarget.value) });
              }}
            >
              {CLIPBOARD_CLEAR_CHOICES.map((s) => (
                <option key={s} value={String(s)}>
                  {seconds(s)}
                </option>
              ))}
            </select>
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={settings.autoCopyTotp}
              onChange={(e) => {
                save({ autoCopyTotp: e.currentTarget.checked });
              }}
            />
            Copy the one-time password after filling a login
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={settings.inlineMenu}
              onChange={(e) => {
                save({ inlineMenu: e.currentTarget.checked });
              }}
            />
            Show matching logins under login fields on web pages
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={builtIn === 'off-by-us' || builtIn === 'off'}
              disabled={builtIn === 'locked' || builtIn === 'other-extension' || builtIn === 'off'}
              onChange={(e) => {
                setBuiltInPasswordsOff(e.currentTarget.checked).then(setBuiltIn, (err: unknown) => {
                  ctx.toast(errorMessage(err, 'Could not change the browser setting'));
                });
              }}
            />
            Turn off the browser’s built-in password manager
          </label>
          {builtIn === 'other-extension' && (
            <p class="muted small">Another extension controls this setting.</p>
          )}
          {builtIn === 'locked' && (
            <p class="muted small">Your administrator controls this setting.</p>
          )}
          {builtIn === 'off' && <p class="muted small">Already off in your browser settings.</p>}
          <label class="check">
            <input
              type="checkbox"
              checked={settings.allowEdits}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                if (!on) {
                  save({ allowEdits: false });
                  return;
                }
                void ctx
                  .confirm(
                    'Editing is new in Vibepass. It is tested against Bitwarden’s own code, but keep a backup of your vault (export it from the web vault) until you trust it.',
                    'Turn on editing',
                  )
                  .then((ok) => {
                    if (ok) save({ allowEdits: true });
                  });
              }}
            />
            Let Vibepass edit my vault (new)
          </label>
          <p class="muted small">
            Add and edit items, save logins from web pages, and organize folders and the trash.
          </p>
          <label class="check">
            <input
              type="checkbox"
              checked={settings.offerToSave}
              disabled={!settings.allowEdits}
              onChange={(e) => {
                save({ offerToSave: e.currentTarget.checked });
              }}
            />
            Offer to save new logins and changed passwords
          </label>
          {settings.allowEdits && (
            <div class="row">
              <button
                type="button"
                class="ghost"
                onClick={() => {
                  onOpen('folders');
                }}
              >
                Folders
              </button>
              <button
                type="button"
                class="ghost"
                onClick={() => {
                  onOpen('trash');
                }}
              >
                Trash
              </button>
            </div>
          )}
          <label class="check">
            <input
              type="checkbox"
              checked={settings.showIcons}
              onChange={(e) => {
                save({ showIcons: e.currentTarget.checked });
              }}
            />
            Show website icons (loaded from your server)
          </label>
        </div>
      )}
      <section class="account stack">
        <p class="muted">
          {ctx.status.email} on {ctx.status.serverUrl}
          {ctx.status.lastSync && (
            <>
              <br />
              Last synced {new Date(ctx.status.lastSync).toLocaleString()}
            </>
          )}
        </p>
        <div class="row">
          <IconButton
            icon={Lock}
            label="Lock now"
            onClick={() => {
              void sendMessage('vault:lock').then(ctx.onStatus);
            }}
          />
          <IconButton
            icon={LogOut}
            label="Log out"
            onClick={() => {
              void sendMessage('vault:logout').then(ctx.onStatus);
            }}
          />
        </div>
        <p class="muted small">
          Shortcuts: open Vibepass with Ctrl+Shift+Space, fill the best match with Ctrl+Shift+L (⌘
          on macOS). Change them in your browser’s extension shortcut settings.
        </p>
      </section>
    </main>
  );
}

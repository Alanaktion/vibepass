import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import browser from '../shared/browser';
import { isStatusEvent, type VaultStatus } from '../shared/messages';
import { sendMessage } from '../shared/messaging';
import type { Settings } from '../storage/settings';
import { Ctx, type PopupContext } from './context';
import { Dialog, Toast, type DialogRequest } from './components/Dialogs';
import { EditView } from './components/EditView';
import { FoldersView } from './components/FoldersView';
import { GeneratorView } from './components/GeneratorView';
import { ItemView } from './components/ItemView';
import { LockScreen } from './components/LockScreen';
import { QuickFind } from './components/QuickFind';
import { SettingsView } from './components/SettingsView';
import { SetupScreen } from './components/SetupScreen';
import { TrashView } from './components/TrashView';
import { CipherType } from '../vault/types';
import { activeTab, modLabel, type ActiveTab } from './lib';

type View =
  | { kind: 'list' }
  | { kind: 'item'; id: string }
  | { kind: 'settings' }
  | { kind: 'edit'; id: string | null; type: CipherType.Login | CipherType.SecureNote }
  | { kind: 'generator' }
  | { kind: 'folders' }
  | { kind: 'trash' };

/** One surface: setup, unlock, quick find, item, or settings, depending on vault state. */
export function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tab, setTab] = useState<ActiveTab | null>(null);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [showTour, setShowTour] = useState(false);
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const [toast, setToast] = useState<{ message: string; at: number } | null>(null);

  useEffect(() => {
    sendMessage('vault:status').then(setStatus, (e: unknown) => {
      setError(e instanceof Error ? e.message : 'Could not reach the background worker');
    });
    sendMessage('settings:get').then(setSettings, () => undefined);
    void activeTab().then(setTab);
    // The worker broadcasts status changes (auto-lock, background sync) to open popups.
    const listener = (message: unknown) => {
      if (isStatusEvent(message)) setStatus(message.payload);
      return undefined;
    };
    browser.runtime.onMessage.addListener(listener);
    return () => {
      browser.runtime.onMessage.removeListener(listener);
    };
  }, []);

  useEffect(() => {
    if (status && status.state !== 'unlocked') {
      setView({ kind: 'list' });
      setDialog(null);
    }
  }, [status]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => {
      setToast(null);
    }, 2500);
    return () => {
      clearTimeout(timer);
    };
  }, [toast]);

  const showToast = useCallback((message: string) => {
    setToast({ message, at: Date.now() });
  }, []);

  const askPassword = useCallback(
    () =>
      new Promise<string | null>((resolve) => {
        setDialog({ kind: 'password', resolve });
      }),
    [],
  );

  const ctx = useMemo<PopupContext | null>(
    () =>
      status && {
        status,
        onStatus: setStatus,
        settings,
        tab,
        toast: showToast,
        askPassword,
        confirm: (message, confirmLabel) =>
          new Promise<boolean>((resolve) => {
            setDialog({ kind: 'confirm', message, confirmLabel, resolve });
          }),
      },
    [status, settings, tab, showToast, askPassword],
  );

  const back = useCallback(() => {
    setView({ kind: 'list' });
  }, []);
  const toSettings = useCallback(() => {
    setView({ kind: 'settings' });
  }, []);
  const open = useCallback((id: string) => {
    setView({ kind: 'item', id });
  }, []);
  const edit = useCallback((id: string) => {
    setView({ kind: 'edit', id, type: CipherType.Login });
  }, []);

  if (error)
    return (
      <main class="screen">
        <p role="alert" class="error">
          {error}
        </p>
      </main>
    );
  if (!status || !ctx) return <main class="screen" aria-busy="true" />;

  let screen;
  switch (status.state) {
    case 'logged-out':
      screen = (
        <SetupScreen
          onStatus={(next) => {
            setShowTour(next.state === 'unlocked');
            setStatus(next);
          }}
        />
      );
      break;
    case 'locked':
      screen = <LockScreen status={status} onStatus={setStatus} />;
      break;
    case 'unlocked':
      switch (view.kind) {
        case 'item':
          screen = <ItemView id={view.id} onBack={back} onEdit={edit} />;
          break;
        case 'edit':
          screen = (
            <EditView
              id={view.id}
              type={view.type}
              onSaved={open}
              onCancel={() => {
                if (view.id) open(view.id);
                else back();
              }}
            />
          );
          break;
        case 'settings':
          screen = (
            <SettingsView
              onBack={back}
              onSettings={setSettings}
              onOpen={(kind) => {
                setView({ kind });
              }}
            />
          );
          break;
        case 'generator':
          screen = <GeneratorView onBack={back} />;
          break;
        case 'folders':
          screen = <FoldersView onBack={toSettings} />;
          break;
        case 'trash':
          screen = <TrashView onBack={toSettings} onOpen={open} />;
          break;
        case 'list':
          screen = (
            <QuickFind
              query={query}
              onQuery={setQuery}
              onOpen={open}
              onSettings={toSettings}
              onNew={(type) => {
                setView({ kind: 'edit', id: null, type });
              }}
              onGenerator={() => {
                setView({ kind: 'generator' });
              }}
            />
          );
      }
  }

  return (
    <Ctx.Provider value={ctx}>
      {showTour && status.state === 'unlocked' && view.kind === 'list' && (
        <aside class="banner" aria-label="Getting started">
          <strong>Your vault is ready</strong>
          <p>
            Open quick find with {modLabel()}Shift+Space or the toolbar icon. On a login field, use
            the arrow keys to choose a saved login and Enter to fill it.
          </p>
          <button
            type="button"
            class="link"
            onClick={() => {
              setShowTour(false);
            }}
          >
            Got it
          </button>
        </aside>
      )}
      {screen}
      {dialog && (
        <Dialog
          request={dialog}
          onDone={() => {
            setDialog(null);
          }}
        />
      )}
      <Toast message={toast?.message ?? null} />
    </Ctx.Provider>
  );
}

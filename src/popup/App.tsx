import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import browser from '../shared/browser';
import { isStatusEvent, type VaultStatus } from '../shared/messages';
import { sendMessage } from '../shared/messaging';
import type { Settings } from '../storage/settings';
import { Ctx, type PopupContext } from './context';
import { Dialog, Toast, type DialogRequest } from './components/Dialogs';
import { ItemView } from './components/ItemView';
import { LockScreen } from './components/LockScreen';
import { QuickFind } from './components/QuickFind';
import { SettingsView } from './components/SettingsView';
import { SetupScreen } from './components/SetupScreen';
import { activeTab, type ActiveTab } from './lib';

type View = { kind: 'list' } | { kind: 'item'; id: string } | { kind: 'settings' };

/** One surface: setup, unlock, quick find, item, or settings, depending on vault state. */
export function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tab, setTab] = useState<ActiveTab | null>(null);
  const [view, setView] = useState<View>({ kind: 'list' });
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

  const ctx = useMemo<PopupContext | null>(
    () =>
      status && {
        status,
        onStatus: setStatus,
        settings,
        tab,
        toast: showToast,
        askPassword: () =>
          new Promise<string | null>((resolve) => {
            setDialog({ kind: 'password', resolve });
          }),
        confirm: (message, confirmLabel) =>
          new Promise<boolean>((resolve) => {
            setDialog({ kind: 'confirm', message, confirmLabel, resolve });
          }),
      },
    [status, settings, tab, showToast],
  );

  const back = useCallback(() => {
    setView({ kind: 'list' });
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
      screen = <SetupScreen onStatus={setStatus} />;
      break;
    case 'locked':
      screen = <LockScreen status={status} onStatus={setStatus} />;
      break;
    case 'unlocked':
      screen =
        view.kind === 'item' ? (
          <ItemView id={view.id} onBack={back} />
        ) : view.kind === 'settings' ? (
          <SettingsView onBack={back} onSettings={setSettings} />
        ) : (
          <QuickFind
            query={query}
            onQuery={setQuery}
            onOpen={(id) => {
              setView({ kind: 'item', id });
            }}
            onSettings={() => {
              setView({ kind: 'settings' });
            }}
          />
        );
  }

  return (
    <Ctx.Provider value={ctx}>
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

import { useEffect, useState } from 'preact/hooks';
import type { VaultStatus } from '../shared/messages';
import { sendMessage } from '../shared/messaging';
import { LockScreen } from './components/LockScreen';
import { QuickFind } from './components/QuickFind';
import { SetupScreen } from './components/SetupScreen';

/** One surface: setup, unlock, or quick find, depending on vault state. */
export function App() {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sendMessage('vault:status').then(setStatus, (e: unknown) => {
      setError(e instanceof Error ? e.message : 'Could not reach the background worker');
    });
  }, []);

  if (error)
    return (
      <main class="screen">
        <p role="alert" class="error">
          {error}
        </p>
      </main>
    );
  if (!status) return <main class="screen" aria-busy="true" />;

  switch (status.state) {
    case 'logged-out':
      return <SetupScreen onStatus={setStatus} />;
    case 'locked':
      return <LockScreen status={status} onStatus={setStatus} />;
    case 'unlocked':
      return <QuickFind status={status} onStatus={setStatus} />;
  }
}

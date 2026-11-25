import { LogOut } from 'lucide-preact';
import { useState } from 'preact/hooks';
import type { VaultStatus } from '../../shared/messages';
import { sendMessage } from '../../shared/messaging';
import { IconButton } from './IconButton';

interface Props {
  status: VaultStatus;
  onStatus: (status: VaultStatus) => void;
}

export function LockScreen({ status, onStatus }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function unlock(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onStatus(await sendMessage('vault:unlock', { masterPassword: password }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unlock failed');
    } finally {
      setPassword('');
      setBusy(false);
    }
  }

  return (
    <main class="screen">
      <h1>Unlock</h1>
      {status.email && <p class="muted">{status.email}</p>}
      <form class="stack" onSubmit={(e) => void unlock(e)}>
        <label>
          Master password
          <input
            type="password"
            autocomplete="current-password"
            value={password}
            onInput={(e) => {
              setPassword(e.currentTarget.value);
            }}
            autoFocus
            required
          />
        </label>
        {error && (
          <p role="alert" class="error">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || password === ''}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </form>
      <div class="row footer">
        <IconButton
          icon={LogOut}
          label="Log out"
          onClick={() => {
            void sendMessage('vault:logout').then(onStatus);
          }}
        />
      </div>
    </main>
  );
}

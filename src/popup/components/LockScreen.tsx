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
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preferPin, setPreferPin] = useState(true);
  // Too many wrong PINs (or a browser restart) turns PIN unlock off until the master password.
  const usePin = status.pin.unlock && preferPin;

  async function unlock(e: Event) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onStatus(
        usePin
          ? await sendMessage('vault:unlock-pin', { pin: secret })
          : await sendMessage('vault:unlock', { masterPassword: secret }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unlock failed');
      // A wrong PIN may have used up the last try; show the master password field if so.
      if (usePin) void sendMessage('vault:status').then(onStatus, () => undefined);
    } finally {
      setSecret('');
      setBusy(false);
    }
  }

  return (
    <main class="screen">
      <h1>Unlock</h1>
      {status.email && <p class="muted">{status.email}</p>}
      <form class="stack" onSubmit={(e) => void unlock(e)}>
        <label>
          {usePin ? 'PIN' : 'Master password'}
          <input
            key={usePin ? 'pin' : 'password'}
            type="password"
            autocomplete={usePin ? 'off' : 'current-password'}
            value={secret}
            onInput={(e) => {
              setSecret(e.currentTarget.value);
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
        <button type="submit" disabled={busy || secret === ''}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
        {status.pin.unlock && (
          <button
            type="button"
            class="link"
            onClick={() => {
              setPreferPin(!preferPin);
              setSecret('');
              setError(null);
            }}
          >
            {usePin ? 'Use master password instead' : 'Use PIN instead'}
          </button>
        )}
        {!status.pin.unlock && status.pin.set && (
          <p class="muted small">Enter your master password to turn PIN unlock back on.</p>
        )}
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

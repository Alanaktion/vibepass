import { useState } from 'preact/hooks';
import browser from '../../shared/browser';
import type { VaultStatus } from '../../shared/messages';
import { sendMessage } from '../../shared/messaging';

interface Props {
  onStatus: (status: VaultStatus) => void;
}

/** First run: server URL, email, and master password, then a full login and first sync. */
export function SetupScreen({ onStatus }: Props) {
  const [serverUrl, setServerUrl] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function login(e: Event) {
    e.preventDefault();
    setError(null);
    let origin: string;
    try {
      origin = new URL(serverUrl.trim()).origin;
    } catch {
      setError('Enter the full server address, like https://vault.example.com');
      return;
    }
    setBusy(true);
    try {
      // Must be the first await: browsers only show the prompt during the click that asked.
      const granted = await browser.permissions.request({ origins: [`${origin}/*`] });
      if (!granted) {
        setError('Vibepass needs access to your server to log in.');
        return;
      }
      onStatus(await sendMessage('vault:login', { serverUrl, email, masterPassword: password }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setPassword('');
      setBusy(false);
    }
  }

  return (
    <main class="screen">
      <h1>Vibepass</h1>
      <p class="muted">Connect to your self-hosted Bitwarden or Vaultwarden server.</p>
      <form class="stack" onSubmit={(e) => void login(e)}>
        <label>
          Server URL
          <input
            type="url"
            name="serverUrl"
            placeholder="https://vault.example.com"
            value={serverUrl}
            onInput={(e) => {
              setServerUrl(e.currentTarget.value);
            }}
            required
            autoFocus
          />
        </label>
        <label>
          Email
          <input
            type="email"
            name="email"
            autocomplete="username"
            value={email}
            onInput={(e) => {
              setEmail(e.currentTarget.value);
            }}
            required
          />
        </label>
        <label>
          Master password
          <input
            type="password"
            name="masterPassword"
            autocomplete="current-password"
            value={password}
            onInput={(e) => {
              setPassword(e.currentTarget.value);
            }}
            required
          />
        </label>
        {error && (
          <p role="alert" class="error">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || !serverUrl || !email || !password}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
      </form>
    </main>
  );
}

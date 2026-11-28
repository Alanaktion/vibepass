import { useState, useEffect } from 'preact/hooks';
import browser, { type Runtime } from '../shared/browser';

export function PasskeyVerification({ id }: { id: string }) {
  const [origin, setOrigin] = useState('');
  const [error, setError] = useState('');
  const [port, setPort] = useState<Runtime.Port | null>(null);
  useEffect(() => {
    const connection = browser.runtime.connect({ name: id });
    connection.onMessage.addListener((value: unknown) => {
      const message = value as { origin?: string; error?: string };
      if (message.origin) setOrigin(message.origin);
      setError(message.error ?? '');
    });
    connection.onDisconnect.addListener(() => {
      window.close();
    });
    setPort(connection);
    return () => {
      connection.disconnect();
    };
  }, [id]);
  return (
    <form
      class="screen"
      onSubmit={(event) => {
        event.preventDefault();
        const field = event.currentTarget.elements.namedItem('password') as HTMLInputElement;
        port?.postMessage(field.value);
        field.value = '';
      }}
    >
      <h1>Verify passkey use</h1>
      <p>{origin}</p>
      <label>
        Master password
        <input type="password" name="password" required autoFocus />
      </label>
      {error && <p role="alert">{error}</p>}
      <button disabled={!origin}>Verify</button>
      <button
        type="button"
        onClick={() => {
          window.close();
        }}
      >
        Cancel
      </button>
    </form>
  );
}

import { useState } from 'preact/hooks';
import type { LoginChallenge } from '../../api/types';
import { TwoFactorProvider } from '../../api/types';
import type { TwoFactorDetails } from '../../api/client';
import browser from '../../shared/browser';
import { isCodedError } from '../../shared/errors';
import type { LoginRequest, VaultStatus } from '../../shared/messages';
import { sendMessage } from '../../shared/messaging';
import { errorMessage } from '../lib';

interface Props {
  onStatus: (status: VaultStatus) => void;
}

/** Providers we can prompt for in the popup. WebAuthn and Duo need a browser flow (later). */
const SUPPORTED = [
  TwoFactorProvider.Authenticator,
  TwoFactorProvider.Email,
  TwoFactorProvider.YubiKey,
];

const PROVIDER_LABEL: Partial<Record<TwoFactorProvider, string>> = {
  [TwoFactorProvider.Authenticator]: 'Authenticator app',
  [TwoFactorProvider.Email]: 'Email',
  [TwoFactorProvider.YubiKey]: 'YubiKey OTP',
};

type Step =
  | { kind: 'credentials' }
  | { kind: 'two-factor'; details: TwoFactorDetails; provider: TwoFactorProvider | null }
  | { kind: 'new-device' };

/**
 * First run: server URL, email, and master password, then a full login and first sync. If the
 * account uses two-step login (or Bitwarden wants to verify a new device), a second step asks
 * for the code and logs in again with it.
 */
export function SetupScreen({ onStatus }: Props) {
  const [serverUrl, setServerUrl] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [remember, setRemember] = useState(true);
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const request = (challenge?: LoginChallenge): LoginRequest => ({
    serverUrl,
    email,
    masterPassword: password,
    ...(challenge ? { challenge } : {}),
  });

  function startOver() {
    setStep({ kind: 'credentials' });
    setPassword('');
    setCode('');
    setNotice(null);
  }

  async function sendEmail() {
    setNotice(null);
    setError(null);
    try {
      await sendMessage('vault:send-login-email', request());
      setNotice('Code sent. Check your email.');
    } catch (err) {
      setError(errorMessage(err, 'Could not send the code'));
    }
  }

  function chooseProvider(details: TwoFactorDetails, provider: TwoFactorProvider | null) {
    setCode('');
    setStep({ kind: 'two-factor', details, provider });
    if (provider === TwoFactorProvider.Email) void sendEmail();
  }

  async function submit(e: Event) {
    e.preventDefault();
    setError(null);
    let challenge: LoginChallenge | undefined;
    if (step.kind === 'credentials') {
      let origin: string;
      try {
        origin = new URL(serverUrl.trim()).origin;
      } catch {
        setError('Enter the full server address, like https://vault.example.com');
        return;
      }
      setBusy(true);
      // Must be the first await: browsers only show the prompt during the click that asked.
      const granted = await browser.permissions
        .request({ origins: [`${origin}/*`] })
        .catch(() => false);
      if (!granted) {
        setError('Vibepass needs access to your server to log in.');
        setBusy(false);
        return;
      }
    } else if (step.kind === 'two-factor' && step.provider !== null) {
      challenge = { twoFactor: { provider: step.provider, token: code, remember } };
      setBusy(true);
    } else {
      challenge = { newDeviceOtp: code };
      setBusy(true);
    }

    try {
      const status = await sendMessage('vault:login', request(challenge));
      setPassword('');
      onStatus(status);
    } catch (err) {
      if (isCodedError(err, 'two-factor-required')) {
        const details = err.details as TwoFactorDetails;
        if (step.kind === 'two-factor') {
          setError('That code didn’t work. Try again.');
        } else {
          const usable = details.providers.filter((p) => SUPPORTED.includes(p));
          chooseProvider(details, usable[0] ?? null);
        }
      } else if (isCodedError(err, 'new-device-verification')) {
        if (step.kind === 'new-device') setError('That code didn’t work. Try again.');
        else {
          setCode('');
          setStep({ kind: 'new-device' });
        }
      } else {
        setError(errorMessage(err, 'Login failed'));
        if (step.kind === 'credentials') setPassword('');
      }
    } finally {
      setBusy(false);
    }
  }

  if (step.kind !== 'credentials') {
    const isTwoFactor = step.kind === 'two-factor';
    const usable = isTwoFactor ? step.details.providers.filter((p) => SUPPORTED.includes(p)) : [];
    const provider = isTwoFactor ? step.provider : null;
    const unsupportedOnly = isTwoFactor && usable.length === 0;
    return (
      <main class="screen">
        <h1>{isTwoFactor ? 'Two-step login' : 'Verify this device'}</h1>
        <p class="muted">
          {!isTwoFactor && 'Bitwarden emailed a verification code to confirm this new device.'}
          {provider === TwoFactorProvider.Authenticator &&
            'Enter the 6-digit code from your authenticator app.'}
          {provider === TwoFactorProvider.Email &&
            `Enter the code emailed to ${step.kind === 'two-factor' ? (step.details.emailHint ?? 'you') : 'you'}.`}
          {provider === TwoFactorProvider.YubiKey && 'Insert your YubiKey and touch it.'}
          {unsupportedOnly &&
            'This account only has two-step methods Vibepass can’t use yet (such as passkeys, security keys, or Duo). Add an authenticator app or email method in your web vault.'}
        </p>
        {!unsupportedOnly && (
          <form class="stack" onSubmit={(e) => void submit(e)}>
            <label>
              {isTwoFactor ? 'Code' : 'Verification code'}
              <input
                type="text"
                inputMode={provider === TwoFactorProvider.YubiKey ? 'text' : 'numeric'}
                autocomplete="one-time-code"
                value={code}
                onInput={(e) => {
                  setCode(e.currentTarget.value);
                }}
                autoFocus
                required
              />
            </label>
            {isTwoFactor && (
              <label class="check">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => {
                    setRemember(e.currentTarget.checked);
                  }}
                />
                Remember this browser
              </label>
            )}
            {notice && <p class="muted">{notice}</p>}
            {error && (
              <p role="alert" class="error">
                {error}
              </p>
            )}
            <button type="submit" class="primary" disabled={busy || code.trim() === ''}>
              {busy ? 'Verifying…' : 'Continue'}
            </button>
          </form>
        )}
        <div class="row wrap">
          {isTwoFactor &&
            usable
              .filter((p) => p !== provider)
              .map((p) => (
                <button
                  type="button"
                  class="link"
                  key={p}
                  onClick={() => {
                    chooseProvider(step.details, p);
                  }}
                >
                  Use {PROVIDER_LABEL[p]}
                </button>
              ))}
          {(provider === TwoFactorProvider.Email || !isTwoFactor) && (
            <button
              type="button"
              class="link"
              onClick={() => {
                if (isTwoFactor) void sendEmail();
                else
                  void sendMessage('vault:resend-device-code', request()).then(
                    () => {
                      setNotice('Code sent. Check your email.');
                    },
                    (err: unknown) => {
                      setError(errorMessage(err));
                    },
                  );
              }}
            >
              Send the code again
            </button>
          )}
          <button type="button" class="link" onClick={startOver}>
            Start over
          </button>
        </div>
      </main>
    );
  }

  return (
    <main class="screen">
      <h1>Vibepass</h1>
      <p class="muted">Connect to your self-hosted Bitwarden or Vaultwarden server.</p>
      <form class="stack" onSubmit={(e) => void submit(e)}>
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
        <button type="submit" class="primary" disabled={busy || !serverUrl || !email || !password}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
      </form>
    </main>
  );
}
